const express = require('express');
const config = require('../config');
const supabase = require('../supabaseClient');
const live = require('../utils/live');
const devices = require('../utils/devices');
const ws = require('../ws');
const channelStore = require('../utils/channelStore');
const { generateKey } = require('../utils/keys');
const { asyncHandler, HttpError, parseId } = require('../utils/http');
const { parseFilters, clampInt, sanitizeDeviceId } = require('../utils/parse');
const { buildFeedQuery } = require('../utils/feeds');
const { streamCsv } = require('../utils/csv');
const { requireUser, loadOwnedChannel, loadViewableChannel } = require('../middleware/auth');
const limits = require('../middleware/limits');

const router = express.Router();
const owned = [requireUser, loadOwnedChannel];

const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_LABEL = 60;
const COMMAND_NAME_RE = /^[A-Za-z0-9_.:-]{1,60}$/;
const MAX_PAYLOAD_JSON = 2000;
const MAX_PENDING_COMMANDS = 200;
const DEFAULT_STALE_SECONDS = 60;
const STALE_MULTIPLIER = 3;

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function cleanLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, MAX_LABEL);
  return text || null;
}

function toPublic(channel, owner) {
  const out = {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    is_public: channel.is_public,
    min_interval_seconds: channel.min_interval_seconds,
    retention_days: channel.retention_days,
    created_at: channel.created_at,
    is_owner: owner,
  };
  config.fieldKeys.forEach((key) => {
    out[key] = channel[key] ?? null;
  });
  if (owner) {
    out.write_api_key = channel.write_api_key;
    out.read_api_key = channel.read_api_key;
  }
  return out;
}

function activeFieldCount(channel) {
  return config.fieldKeys.filter((key) => channel[key]).length;
}

router.get('/', requireUser, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('owner_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;

  const overview = new Map();
  if (data.length > 0) {
    const { data: rows, error: overviewError } = await supabase.rpc('channel_overview', {
      p_ids: data.map((c) => c.id),
    });
    if (overviewError) throw overviewError;
    rows.forEach((row) => overview.set(Number(row.channel_id), row));
  }

  res.json(data.map((channel) => {
    const info = overview.get(channel.id) || {};
    return {
      ...toPublic(channel, true),
      entries_count: Number(info.total_entries) || 0,
      device_count: Number(info.device_count) || 0,
    };
  }));
}));

router.post('/', requireUser, limits.createChannel, asyncHandler(async (req, res) => {
  const body = bodyOf(req);
  const name = String(body.name || '').trim().slice(0, MAX_NAME);
  const description = String(body.description || '').trim().slice(0, MAX_DESCRIPTION);
  const labels = (Array.isArray(body.fields) ? body.fields : [])
    .map(cleanLabel)
    .filter(Boolean)
    .slice(0, config.fieldCount);

  if (!name) throw new HttpError(400, 'name is required');
  if (labels.length === 0) throw new HttpError(400, 'at least one field is required');

  const { count, error: countError } = await supabase
    .from('channels')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', req.user.id);
  if (countError) throw countError;
  if ((count || 0) >= config.maxChannelsPerUser) {
    throw new HttpError(403, `channel limit reached (${config.maxChannelsPerUser})`);
  }

  const payload = {
    owner_id: req.user.id,
    name,
    description,
    write_api_key: generateKey(),
    read_api_key: generateKey(),
    min_interval_seconds: 1,
    retention_days: config.defaultRetentionDays,
    is_public: false,
  };
  labels.forEach((label, index) => {
    payload[`field${index + 1}`] = label;
  });

  const { data, error } = await supabase.from('channels').insert(payload).select('*').single();
  if (error) throw error;
  res.status(201).json(toPublic(data, true));
}));

router.get('/:id', loadViewableChannel, (req, res) => {
  res.json(toPublic(req.channel, req.isOwner));
});

router.patch('/:id', ...owned, asyncHandler(async (req, res) => {
  const body = bodyOf(req);
  const updates = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, MAX_NAME);
    if (!name) throw new HttpError(400, 'name cannot be empty');
    updates.name = name;
  }
  if (body.description !== undefined) {
    updates.description = String(body.description).trim().slice(0, MAX_DESCRIPTION);
  }
  if (body.is_public !== undefined) updates.is_public = Boolean(body.is_public);
  if (body.min_interval_seconds !== undefined) {
    const value = Number(body.min_interval_seconds);
    if (!Number.isInteger(value) || value < 1 || value > 3600) {
      throw new HttpError(400, 'min_interval_seconds must be an integer from 1 to 3600');
    }
    updates.min_interval_seconds = value;
  }
  if (body.retention_days !== undefined) {
    const value = Number(body.retention_days);
    if (!Number.isInteger(value) || value < 1 || value > config.maxRetentionDays) {
      throw new HttpError(400, `retention_days must be an integer from 1 to ${config.maxRetentionDays}`);
    }
    updates.retention_days = value;
  }
  if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
    const merged = { ...req.channel };
    config.fieldKeys.forEach((key) => {
      if (body.fields[key] === undefined) return;
      updates[key] = cleanLabel(body.fields[key]);
      merged[key] = updates[key];
    });
    if (activeFieldCount(merged) === 0) throw new HttpError(400, 'at least one field is required');
  }
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'no valid fields to update');

  const { data, error } = await supabase
    .from('channels')
    .update(updates)
    .eq('id', req.channel.id)
    .eq('owner_id', req.user.id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'channel not found');

  channelStore.invalidate();
  if (updates.is_public === false) ws.dropNonOwners(data.id);
  res.json(toPublic(data, true));
}));

router.post('/:id/rotate-keys', ...owned, asyncHandler(async (req, res) => {
  const which = String(bodyOf(req).which || 'both');
  if (!['write', 'read', 'both'].includes(which)) throw new HttpError(400, 'which must be write, read or both');
  const updates = {};
  if (which === 'write' || which === 'both') updates.write_api_key = generateKey();
  if (which === 'read' || which === 'both') updates.read_api_key = generateKey();

  const { data, error } = await supabase
    .from('channels')
    .update(updates)
    .eq('id', req.channel.id)
    .eq('owner_id', req.user.id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'channel not found');
  channelStore.invalidate();
  res.json(toPublic(data, true));
}));

router.delete('/:id', ...owned, asyncHandler(async (req, res) => {
  const id = req.channel.id;
  const { error } = await supabase.from('channels').delete().eq('id', id).eq('owner_id', req.user.id);
  if (error) throw error;
  live.clearChannel(id);
  devices.forgetChannel(id);
  channelStore.invalidate();
  ws.disconnectChannel(id, 1000, 'channel deleted');
  res.json({ ok: true });
}));

router.post('/:id/clear', ...owned, asyncHandler(async (req, res) => {
  const id = req.channel.id;
  const feeds = await supabase.from('feeds').delete().eq('channel_id', id);
  if (feeds.error) throw feeds.error;
  const stats = await supabase.from('channel_daily_stats').delete().eq('channel_id', id);
  if (stats.error) throw stats.error;
  live.clearChannel(id);
  ws.broadcast(id, { type: 'cleared' });
  res.json({ ok: true });
}));

router.get('/:id/live', loadViewableChannel, (req, res) => {
  res.json({ devices: live.get(req.channel.id) });
});

router.get('/:id/feeds', loadViewableChannel, asyncHandler(async (req, res) => {
  const channel = req.channel;
  const filters = parseFilters(req.query);
  if (filters.error) throw new HttpError(400, filters.error);

  if (req.query.per_device !== undefined) {
    const { count, error: countError } = await supabase
      .from('devices')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channel.id);
    if (countError) throw countError;
    const requested = clampInt(req.query.per_device, 30, 1, 200);
    const perDevice = Math.max(1, Math.min(requested, Math.floor(1000 / Math.max(1, count || 1))));
    const { data, error } = await supabase.rpc('recent_feeds_per_device', {
      p_channel: channel.id,
      p_per: perDevice,
    });
    if (error) throw error;
    data.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
    return res.json(data);
  }

  const limit = clampInt(req.query.limit, 100, 1, 500);
  const { data, error } = await buildFeedQuery(channel.id, filters).limit(limit);
  if (error) throw error;
  return res.json(data);
}));

router.get('/:id/devices', loadViewableChannel, asyncHandler(async (req, res) => {
  const channel = req.channel;
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('channel_id', channel.id)
    .order('last_seen_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  const now = Date.now();
  res.json(data.map((device) => {
    const seenDb = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
    const seen = Math.max(seenDb, live.lastSeen(channel.id, device.device_id));
    const expected = device.expected_interval_seconds || channel.min_interval_seconds || 1;
    const staleMs = Math.max(DEFAULT_STALE_SECONDS, expected * STALE_MULTIPLIER) * 1000;
    return {
      ...device,
      last_seen_at: seen ? new Date(seen).toISOString() : null,
      online: seen > 0 && now - seen < staleMs,
    };
  }));
}));

router.patch('/:id/devices/:deviceRowId', ...owned, asyncHandler(async (req, res) => {
  const rowId = parseId(req.params.deviceRowId, 'device id');
  const body = bodyOf(req);
  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, MAX_NAME);
    if (!name) throw new HttpError(400, 'name cannot be empty');
    updates.name = name;
  }
  if (body.expected_interval_seconds !== undefined) {
    if (body.expected_interval_seconds === null || body.expected_interval_seconds === '') {
      updates.expected_interval_seconds = null;
    } else {
      const value = Number(body.expected_interval_seconds);
      if (!Number.isInteger(value) || value < 1 || value > 86400) {
        throw new HttpError(400, 'expected_interval_seconds must be an integer from 1 to 86400');
      }
      updates.expected_interval_seconds = value;
    }
  }
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'no valid fields to update');

  const { data, error } = await supabase
    .from('devices')
    .update(updates)
    .eq('id', rowId)
    .eq('channel_id', req.channel.id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'device not found');
  res.json(data);
}));

router.delete('/:id/devices/:deviceRowId', ...owned, asyncHandler(async (req, res) => {
  const rowId = parseId(req.params.deviceRowId, 'device id');
  const { data, error } = await supabase
    .from('devices')
    .delete()
    .eq('id', rowId)
    .eq('channel_id', req.channel.id)
    .select('device_id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'device not found');
  devices.forget(req.channel.id, data.device_id);
  live.clearDevice(req.channel.id, data.device_id);
  res.json({ ok: true });
}));

router.get('/:id/analytics', loadViewableChannel, asyncHandler(async (req, res) => {
  const id = req.channel.id;
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    days.push(date.toISOString().slice(0, 10));
  }

  const [statsResult, overviewResult] = await Promise.all([
    supabase.from('channel_daily_stats').select('day,entries').eq('channel_id', id).gte('day', days[0]),
    supabase.rpc('channel_overview', { p_ids: [id] }),
  ]);
  if (statsResult.error) throw statsResult.error;
  if (overviewResult.error) throw overviewResult.error;

  const byDay = new Map(statsResult.data.map((row) => [row.day, Number(row.entries) || 0]));
  const daily = days.map((date) => ({ date, count: byDay.get(date) || 0 }));
  const info = overviewResult.data[0] || {};

  res.json({
    total_entries: Number(info.total_entries) || 0,
    device_count: Number(info.device_count) || 0,
    entries_today: daily[daily.length - 1].count,
    timezone: 'UTC',
    daily,
  });
}));

router.get('/:id/export.csv', limits.exportCsv, loadViewableChannel, asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  if (filters.error) throw new HttpError(400, filters.error);
  const maxRows = clampInt(req.query.results, config.maxExportRows, 1, config.maxExportRows);
  await streamCsv(res, req.channel, filters, maxRows);
}));

router.post('/:id/commands', ...owned, asyncHandler(async (req, res) => {
  const body = bodyOf(req);
  const command = String(body.command || '').trim();
  if (!COMMAND_NAME_RE.test(command)) {
    throw new HttpError(400, 'command must be 1-60 characters: letters, digits, _ . : -');
  }

  let payload = null;
  if (body.payload !== undefined && body.payload !== null) {
    if (JSON.stringify(body.payload).length > MAX_PAYLOAD_JSON) throw new HttpError(400, 'payload too large');
    payload = body.payload;
  }
  const ttl = clampInt(body.ttl_seconds, 3600, 10, 86400);

  const { count, error: pendingError } = await supabase
    .from('commands')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', req.channel.id)
    .in('status', ['pending', 'delivered']);
  if (pendingError) throw pendingError;
  if ((count || 0) >= MAX_PENDING_COMMANDS) throw new HttpError(429, 'too many pending commands');

  let targets;
  if (!body.device_id || body.device_id === 'all') {
    const { data, error } = await supabase
      .from('devices')
      .select('device_id')
      .eq('channel_id', req.channel.id)
      .limit(1000);
    if (error) throw error;
    targets = data.map((row) => row.device_id);
    if (targets.length === 0) throw new HttpError(400, 'no devices registered yet');
  } else {
    targets = [sanitizeDeviceId(body.device_id)];
  }

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const rows = targets.map((deviceId) => ({
    channel_id: req.channel.id,
    device_id: deviceId,
    command,
    payload,
    expires_at: expiresAt,
  }));
  const { data, error } = await supabase.from('commands').insert(rows).select('*');
  if (error) throw error;
  res.status(201).json({ commands: data });
}));

router.get('/:id/commands', ...owned, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('commands')
    .select('*')
    .eq('channel_id', req.channel.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  res.json(data);
}));

router.delete('/:id/commands/:commandId', ...owned, asyncHandler(async (req, res) => {
  const commandId = parseId(req.params.commandId, 'command id');
  const { error } = await supabase
    .from('commands')
    .delete()
    .eq('id', commandId)
    .eq('channel_id', req.channel.id)
    .eq('status', 'pending');
  if (error) throw error;
  res.json({ ok: true });
}));

module.exports = router;