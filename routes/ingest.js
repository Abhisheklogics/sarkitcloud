const express = require('express');
const config = require('../config');
const supabase = require('../supabaseClient');
const live = require('../utils/live');
const devices = require('../utils/devices');
const stats = require('../utils/stats');
const ws = require('../ws');
const channelStore = require('../utils/channelStore');
const { asyncHandler } = require('../utils/http');
const {
  WRITE_KEY_NAMES,
  READ_KEY_NAMES,
  extractFields,
  sanitizeDeviceId,
  parseCreatedAt,
  parseFilters,
  clampInt,
  parseFieldNumber,
  bodyParams,
  extractKey,
} = require('../utils/parse');
const { buildFeedQuery, shapeFeed, channelMeta } = require('../utils/feeds');
const { streamCsv } = require('../utils/csv');
const limits = require('../middleware/limits');

const router = express.Router();

const MAX_BULK_ENTRIES = 100;
const MAX_RESULTS = 200;
const COMMANDS_PER_POLL = 5;
const REDELIVER_SECONDS = 30;
const MAX_ATTEMPTS = 5;
const LIVE_FRESH_MS = 120000;

function respond(res, status, text, obj, asJson) {
  if (asJson) return res.status(status).json(obj === undefined ? { error: text } : obj);
  return res.status(status).type('text/plain').send(text);
}

async function handleUpdate(req, res, asJson) {
  const params = { ...req.query, ...bodyParams(req) };
  const key = extractKey(req, params, WRITE_KEY_NAMES);
  if (!key) return respond(res, 400, '0', { error: 'api_key is required' }, asJson);

  const channel = await channelStore.byWriteKey(key);
  if (!channel) return respond(res, 401, '0', { error: 'invalid write api key' }, asJson);

  const fields = extractFields(params);
  if (Object.keys(fields).length === 0) {
    return respond(res, 400, '0', { error: 'no valid numeric field values' }, asJson);
  }
  const createdAt = parseCreatedAt(params.created_at);
  if (createdAt === undefined) return respond(res, 400, '0', { error: 'invalid created_at' }, asJson);

  const deviceId = sanitizeDeviceId(params.device_id !== undefined ? params.device_id : params.device);
  if (!(await devices.ensure(channel.id, deviceId))) {
    return respond(res, 403, '0', { error: 'device limit reached for this channel' }, asJson);
  }

  const state = live.update(channel.id, deviceId, fields);
  ws.broadcast(channel.id, { type: 'live', deviceId, fields: state.fields, updatedAt: state.updatedAt });

  const reserved = !createdAt;
  if (reserved && !live.reserve(channel.id, deviceId, channel.min_interval_seconds)) {
    const retry = live.retryAfter(channel.id, deviceId, channel.min_interval_seconds);
    res.set('Retry-After', String(retry));
    return respond(res, 429, '0', { error: 'min interval not elapsed', retry_after: retry }, asJson);
  }

  const row = { channel_id: channel.id, device_id: deviceId, ...fields };
  if (createdAt) row.created_at = createdAt;

  const { data, error } = await supabase.from('feeds').insert(row).select('id,created_at').single();
  if (error) {
    if (reserved) live.release(channel.id, deviceId);
    if (error.code === '23505') {
      res.set('X-Duplicate', '1');
      return respond(res, 200, '0', { duplicate: true }, asJson);
    }
    throw error;
  }

  stats.record(channel.id, 1, data.created_at.slice(0, 10));
  ws.broadcast(channel.id, { type: 'feed', feed: { id: data.id, created_at: data.created_at, device_id: deviceId, ...fields } });

  return respond(
    res,
    200,
    String(data.id),
    { entry_id: data.id, channel_id: channel.id, device_id: deviceId, created_at: data.created_at },
    asJson
  );
}

function updateRoute(asJson) {
  return async (req, res) => {
    try {
      await handleUpdate(req, res, asJson);
    } catch (err) {
      console.error('update failed:', err.message || err);
      if (!res.headersSent) {
        res.set('Retry-After', '5');
        respond(res, 503, '0', { error: 'temporarily unavailable' }, asJson);
      }
    }
  };
}

router.get('/update', limits.ingest, updateRoute(false));
router.post('/update', limits.ingest, updateRoute(false));
router.get('/update.json', limits.ingestJson, updateRoute(true));
router.post('/update.json', limits.ingestJson, updateRoute(true));

router.post('/update/bulk', limits.bulk, asyncHandler(async (req, res) => {
  const body = bodyParams(req);
  const key = extractKey(req, body, WRITE_KEY_NAMES);
  if (!key) return res.status(400).json({ error: 'api_key is required' });
  const channel = await channelStore.byWriteKey(key);
  if (!channel) return res.status(401).json({ error: 'invalid write api key' });

  const entries = Array.isArray(body.updates) ? body.updates.slice(0, MAX_BULK_ENTRIES) : [];
  if (entries.length === 0) return res.status(400).json({ error: 'updates array is required' });

  const baseNow = Date.now();
  const deviceOk = new Map();
  const results = [];
  const rows = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') {
      results.push({ ok: false, error: 'invalid entry' });
      continue;
    }
    const fields = extractFields(entry);
    if (Object.keys(fields).length === 0) {
      results.push({ ok: false, error: 'no valid numeric field values' });
      continue;
    }
    const createdAt = entry.created_at === undefined || entry.created_at === null || entry.created_at === ''
      ? new Date(baseNow - (entries.length - i)).toISOString()
      : parseCreatedAt(entry.created_at);
    if (createdAt === undefined) {
      results.push({ ok: false, error: 'invalid created_at' });
      continue;
    }
    const deviceId = sanitizeDeviceId(entry.device_id !== undefined ? entry.device_id : body.device_id);
    if (!deviceOk.has(deviceId)) deviceOk.set(deviceId, await devices.ensure(channel.id, deviceId));
    if (!deviceOk.get(deviceId)) {
      results.push({ ok: false, error: 'device limit reached' });
      continue;
    }
    rows.push({ channel_id: channel.id, device_id: deviceId, created_at: createdAt, ...fields });
    results.push({ ok: true });
  }

  if (rows.length === 0) return res.status(400).json({ error: 'no valid entries', results });
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const { data, error } = await supabase
    .from('feeds')
    .upsert(rows, { onConflict: 'channel_id,device_id,created_at', ignoreDuplicates: true })
    .select('id,created_at,device_id');
  if (error) throw error;

  const perDay = new Map();
  data.forEach((row) => {
    const day = row.created_at.slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  });
  perDay.forEach((count, day) => stats.record(channel.id, count, day));

  const lastByDevice = new Map();
  rows.forEach((row) => lastByDevice.set(row.device_id, row));
  lastByDevice.forEach((row, deviceId) => {
    if (Date.parse(row.created_at) < Date.now() - LIVE_FRESH_MS) return;
    const fields = extractFields(row);
    const state = live.update(channel.id, deviceId, fields);
    ws.broadcast(channel.id, { type: 'live', deviceId, fields: state.fields, updatedAt: state.updatedAt });
  });
  ws.broadcast(channel.id, { type: 'bulk', count: data.length });

  return res.json({
    inserted: data.length,
    duplicates: rows.length - data.length,
    rejected: results.filter((r) => !r.ok).length,
    results,
  });
}));

async function authorizeWrite(req, res, params) {
  const key = extractKey(req, params, WRITE_KEY_NAMES);
  if (!key) {
    res.status(400).json({ error: 'api_key is required' });
    return null;
  }
  const channel = await channelStore.byWriteKey(key);
  if (!channel) {
    res.status(401).json({ error: 'invalid write api key' });
    return null;
  }
  return channel;
}

router.get('/command', limits.command, asyncHandler(async (req, res) => {
  const asText = req.query.format === 'text';
  const channel = await authorizeWrite(req, res, req.query);
  if (!channel) return undefined;

  const deviceId = sanitizeDeviceId(req.query.device_id);
  if (!(await devices.ensure(channel.id, deviceId))) {
    return res.status(403).json({ error: 'device limit reached for this channel' });
  }

  const { data, error } = await supabase.rpc('claim_commands', {
    p_channel: channel.id,
    p_device: deviceId,
    p_limit: COMMANDS_PER_POLL,
    p_redeliver_seconds: REDELIVER_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw error;

  const commands = (data || []).sort((a, b) => a.id - b.id);
  if (commands.length > 0) ws.broadcast(channel.id, { type: 'commands' }, true);

  if (asText) {
    const lines = commands.map((c) => `${c.id}|${c.command}|${c.payload === null ? '' : JSON.stringify(c.payload)}`);
    return res.type('text/plain').send(lines.join('\n'));
  }
  return res.json({
    commands: commands.map((c) => ({
      command_id: c.id,
      command: c.command,
      payload: c.payload,
      attempt: c.attempts,
    })),
  });
}));

const ackHandler = asyncHandler(async (req, res) => {
  const params = { ...req.query, ...bodyParams(req) };
  const channel = await authorizeWrite(req, res, params);
  if (!channel) return undefined;

  const commandId = Number(params.command_id !== undefined ? params.command_id : params.id);
  if (!Number.isSafeInteger(commandId) || commandId < 1) {
    return res.status(400).json({ error: 'invalid command_id' });
  }

  const { data, error } = await supabase
    .from('commands')
    .update({ status: 'acked', acked_at: new Date().toISOString() })
    .eq('id', commandId)
    .eq('channel_id', channel.id)
    .in('status', ['pending', 'delivered'])
    .select('id');
  if (error) throw error;

  if (data.length === 0) {
    const existing = await supabase
      .from('commands')
      .select('id')
      .eq('id', commandId)
      .eq('channel_id', channel.id)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ error: 'command not found' });
    return res.json({ ok: true, already: true });
  }

  ws.broadcast(channel.id, { type: 'commands' }, true);
  return res.json({ ok: true });
});

router.get('/command/ack', limits.command, ackHandler);
router.post('/command/ack', limits.command, ackHandler);

router.get('/time', (req, res) => {
  res.set('Cache-Control', 'no-store').type('text/plain').send(String(Math.floor(Date.now() / 1000)));
});

router.get('/time.json', (req, res) => {
  const now = Date.now();
  res.set('Cache-Control', 'no-store').json({ unix: Math.floor(now / 1000), iso: new Date(now).toISOString() });
});

async function authorizeRead(req, res) {
  const key = extractKey(req, req.query, READ_KEY_NAMES);
  const channel = key ? await channelStore.byReadKey(key) : null;
  const idMismatch = req.params.id !== undefined && channel && String(channel.id) !== String(req.params.id);
  if (!channel || idMismatch) {
    res.status(401).json({ error: 'invalid read api key' });
    return null;
  }
  return channel;
}

function readRoute(handler) {
  return asyncHandler(async (req, res) => {
    const channel = await authorizeRead(req, res);
    if (!channel) return undefined;
    return handler(req, res, channel);
  });
}

async function serveLastField(req, res, channel, fieldNumber) {
  const fieldKey = `field${fieldNumber}`;
  if (!channel[fieldKey]) return res.status(400).json({ error: `${fieldKey} is not configured on this channel` });
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });

  const wantsJson = req.query.format === 'json' || req.path.endsWith('.json');
  const { data, error } = await buildFeedQuery(channel.id, filters, fieldKey).limit(1);
  if (error) throw error;
  const feed = data && data[0];

  if (!feed) {
    if (wantsJson) return res.status(404).json({ error: 'no data' });
    return res.status(404).type('text/plain').send('-1');
  }
  if (wantsJson) return res.json(shapeFeed(feed, channel, fieldNumber));
  return res.type('text/plain').send(String(feed[fieldKey]));
}

router.get('/read', limits.read, readRoute(async (req, res, channel) => {
  const fieldNumber = parseFieldNumber(req.query.field);
  if (Number.isNaN(fieldNumber)) {
    return res.status(400).json({ error: `field must be an integer from 1 to ${config.fieldCount}` });
  }
  if (fieldNumber && !channel[`field${fieldNumber}`]) {
    return res.status(400).json({ error: `field${fieldNumber} is not configured on this channel` });
  }

  const listMode = req.query.results !== undefined;
  if (fieldNumber && !listMode) return serveLastField(req, res, channel, fieldNumber);

  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });

  const limit = listMode ? clampInt(req.query.results, 1, 1, MAX_RESULTS) : 1;
  const fieldKey = fieldNumber ? `field${fieldNumber}` : null;
  const { data, error } = await buildFeedQuery(channel.id, filters, fieldKey).limit(limit);
  if (error) throw error;

  const shaped = data.map((feed) => shapeFeed(feed, channel, fieldNumber));
  if (listMode) return res.json(shaped);
  if (shaped.length === 0) return res.status(404).json({ error: 'no data' });
  return res.json(shaped[0]);
}));

router.get('/channels/:id/feeds.json', limits.read, readRoute(async (req, res, channel) => {
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const limit = clampInt(req.query.results, 20, 1, MAX_RESULTS);
  const { data, error } = await buildFeedQuery(channel.id, filters).limit(limit);
  if (error) throw error;
  return res.json({ channel: channelMeta(channel), feeds: data.map((feed) => shapeFeed(feed, channel)) });
}));

router.get('/channels/:id/feeds/last.json', limits.read, readRoute(async (req, res, channel) => {
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const { data, error } = await buildFeedQuery(channel.id, filters).limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return res.status(404).json({ error: 'no data' });
  return res.json(shapeFeed(data[0], channel));
}));

router.get('/channels/:id/feeds.csv', limits.exportCsv, readRoute(async (req, res, channel) => {
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const maxRows = clampInt(req.query.results, config.maxExportRows, 1, config.maxExportRows);
  return streamCsv(res, channel, filters, maxRows);
}));

router.get('/channels/:id/fields/:field.json', limits.read, readRoute(async (req, res, channel) => {
  const fieldNumber = parseFieldNumber(req.params.field);
  if (!fieldNumber) return res.status(400).json({ error: `field must be an integer from 1 to ${config.fieldCount}` });
  if (!channel[`field${fieldNumber}`]) {
    return res.status(400).json({ error: `field${fieldNumber} is not configured on this channel` });
  }
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const limit = clampInt(req.query.results, 20, 1, MAX_RESULTS);
  const { data, error } = await buildFeedQuery(channel.id, filters, `field${fieldNumber}`).limit(limit);
  if (error) throw error;
  return res.json({ channel: channelMeta(channel), feeds: data.map((feed) => shapeFeed(feed, channel, fieldNumber)) });
}));

router.get(
  ['/channels/:id/fields/:field/last', '/channels/:id/fields/:field/last.txt', '/channels/:id/fields/:field/last.json'],
  limits.read,
  readRoute(async (req, res, channel) => {
    const fieldNumber = parseFieldNumber(req.params.field);
    if (!fieldNumber) return res.status(400).json({ error: `field must be an integer from 1 to ${config.fieldCount}` });
    return serveLastField(req, res, channel, fieldNumber);
  })
);

module.exports = router;