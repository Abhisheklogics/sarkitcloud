const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');
const { updateLive, canStore, markStored } = require('../liveCache');
const ws = require('../ws');
const {
  parseFeedFilters,
  clampRows,
  buildFeedQuery,
  handleCsvExport,
} = require('../utils/feedsExport');

const router = express.Router();

const FIELD_COUNT = 20;
const MAX_KEY_LENGTH = 128;
const MAX_RESULTS = 200;
const NON_NUMERIC_TOKENS = /^(nan|inf|-inf|\+inf|ovf|null|undefined)$/i;
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NOT_FOUND_CODE = 'PGRST116';

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`${req.method} ${req.path} crashed:`, err);
      if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
    }
  };
}

function extractApiKey(req, params) {
  const raw = params.api_key || req.get('x-api-key') || req.get('x-thingspeakapikey');
  if (!raw) return null;
  const key = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  return key;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sanitizeDeviceId(raw) {
  if (raw === undefined || raw === null) return 'default';
  const id = String(Array.isArray(raw) ? raw[0] : raw).trim().slice(0, 60);
  return id || 'default';
}

function parseFieldValue(raw) {
  if (raw === undefined || raw === null || typeof raw === 'object') return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const text = String(raw).trim();
  if (text === '' || NON_NUMERIC_TOKENS.test(text)) return undefined;
  if (NUMBER_PATTERN.test(text)) {
    const num = Number(text);
    return Number.isFinite(num) ? num : undefined;
  }
  return text.slice(0, 100);
}

function parseFieldNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= FIELD_COUNT ? n : NaN;
}

function shapeFeed(feed, channel, onlyField) {
  const out = {
    entry_id: feed.id,
    created_at: feed.created_at,
    device_id: feed.device_id || 'default'
  };
  for (let i = 1; i <= FIELD_COUNT; i++) {
    if (!channel[`field${i}`]) continue;
    if (onlyField && i !== onlyField) continue;
    out[`field${i}`] = feed[`field${i}`] ?? null;
  }
  return out;
}

async function handleUpdate(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const params = { ...req.query, ...body };
    const apiKey = extractApiKey(req, params);
    if (!apiKey) return res.status(400).send('0');

    const deviceId = sanitizeDeviceId(params.device_id);

    const fields = {};
    for (let i = 1; i <= FIELD_COUNT; i++) {
      const key = `field${i}`;
      const value = parseFieldValue(params[key]);
      if (value !== undefined) fields[key] = value;
    }
    if (Object.keys(fields).length === 0) return res.status(400).send('0');

    const { data: channel, error } = await supabase
      .from('channels')
      .select('id,min_interval_seconds')
      .eq('write_api_key', apiKey)
      .single();

    if (error && error.code !== NOT_FOUND_CODE) {
      console.error('update channel lookup error:', error);
      return res.status(500).send('0');
    }
    if (!channel) return res.status(401).send('0');

    const liveState = updateLive(channel.id, deviceId, fields);

    supabase
      .from('devices')
      .upsert(
        { channel_id: channel.id, device_id: deviceId, last_seen_at: new Date().toISOString() },
        { onConflict: 'channel_id,device_id' }
      )
      .then(({ error: upsertError }) => {
        if (upsertError) console.error('device upsert failed:', upsertError);
      })
      .catch((err) => console.error('device upsert crashed:', err));

    ws.broadcast(channel.id, {
      type: 'live',
      deviceId,
      fields: liveState.fields,
      updatedAt: liveState.updatedAt
    });

    if (!canStore(channel.id, deviceId, channel.min_interval_seconds)) {
      return res.status(200).send('0');
    }

    const { data: feed, error: insertError } = await supabase
      .from('feeds')
      .insert({ channel_id: channel.id, device_id: deviceId, ...fields })
      .select()
      .single();

    if (insertError) {
      console.error('update insert error:', insertError);
      return res.status(500).send('0');
    }

    markStored(channel.id, deviceId);
    ws.broadcast(channel.id, { type: 'feed', feed });
    return res.status(200).send(String(feed.id));
  } catch (err) {
    console.error('update crashed:', err);
    return res.status(500).send('0');
  }
}

async function authorizeChannelRead(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid channel id' });
    return null;
  }
  const key = extractApiKey(req, req.query);
  const { data: channel, error } = await supabase
    .from('channels')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code !== NOT_FOUND_CODE) throw error;
  if (!channel || !key || !safeEqual(channel.read_api_key, key)) {
    res.status(401).json({ error: 'invalid read api key' });
    return null;
  }
  return channel;
}

async function serveLastField(req, res, channel, fieldNum) {
  const fieldKey = `field${fieldNum}`;
  if (!channel[fieldKey]) {
    return res.status(400).json({ error: `${fieldKey} is not configured on this channel` });
  }
  const filters = parseFeedFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });

  const wantsJson = req.query.format === 'json' || req.path.endsWith('.json');
  const { data, error } = await buildFeedQuery(channel.id, filters, fieldKey).limit(1);
  if (error) throw error;
  const feed = data && data[0];

  if (!feed) {
    if (wantsJson) return res.status(404).json({ error: 'no data' });
    return res.status(404).type('text/plain').send('-1');
  }
  if (wantsJson) return res.json(shapeFeed(feed, channel, fieldNum));
  return res.type('text/plain').send(String(feed[fieldKey]));
}

async function serveRead(req, res, channel) {
  const fieldNum = parseFieldNumber(req.query.field);
  if (Number.isNaN(fieldNum)) {
    return res.status(400).json({ error: `field must be an integer from 1 to ${FIELD_COUNT}` });
  }
  if (fieldNum && !channel[`field${fieldNum}`]) {
    return res.status(400).json({ error: `field${fieldNum} is not configured on this channel` });
  }

  const listMode = req.query.results !== undefined;
  if (fieldNum && !listMode) return serveLastField(req, res, channel, fieldNum);

  const filters = parseFeedFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });

  const limit = listMode ? clampRows(req.query.results, 1, MAX_RESULTS) : 1;
  const fieldKey = fieldNum ? `field${fieldNum}` : null;
  const { data, error } = await buildFeedQuery(channel.id, filters, fieldKey).limit(limit);
  if (error) throw error;

  const shaped = data.map((feed) => shapeFeed(feed, channel, fieldNum));
  if (listMode) return res.json(shaped);
  if (shaped.length === 0) return res.status(404).json({ error: 'no data' });
  return res.json(shaped[0]);
}

router.get('/update', handleUpdate);
router.post('/update', handleUpdate);

router.get('/read', readLimiter, guard(async (req, res) => {
  const key = extractApiKey(req, req.query);
  if (!key) return res.status(401).json({ error: 'api_key is required' });
  const { data: channel, error } = await supabase
    .from('channels')
    .select('*')
    .eq('read_api_key', key)
    .single();
  if (error && error.code !== NOT_FOUND_CODE) throw error;
  if (!channel) return res.status(401).json({ error: 'invalid read api key' });
  return serveRead(req, res, channel);
}));

router.get('/channels/:id/feeds.json', readLimiter, guard(async (req, res) => {
  const channel = await authorizeChannelRead(req, res);
  if (!channel) return undefined;
  const filters = parseFeedFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const limit = clampRows(req.query.results, 20, MAX_RESULTS);
  const { data, error } = await buildFeedQuery(channel.id, filters).limit(limit);
  if (error) throw error;
  return res.json(data);
}));

router.get('/channels/:id/feeds/last.json', readLimiter, guard(async (req, res) => {
  const channel = await authorizeChannelRead(req, res);
  if (!channel) return undefined;
  const filters = parseFeedFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const { data, error } = await buildFeedQuery(channel.id, filters).limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return res.status(404).json({ error: 'no data' });
  return res.json(data[0]);
}));

router.get('/channels/:id/feeds.csv', exportLimiter, guard(async (req, res) => {
  const channel = await authorizeChannelRead(req, res);
  if (!channel) return undefined;
  return handleCsvExport(req, res, channel);
}));

router.get(
  [
    '/channels/:id/fields/:field/last',
    '/channels/:id/fields/:field/last.txt',
    '/channels/:id/fields/:field/last.json'
  ],
  readLimiter,
  guard(async (req, res) => {
    const channel = await authorizeChannelRead(req, res);
    if (!channel) return undefined;
    const fieldNum = parseFieldNumber(req.params.field);
    if (!fieldNum) return res.status(400).json({ error: `field must be an integer from 1 to ${FIELD_COUNT}` });
    return serveLastField(req, res, channel, fieldNum);
  })
);

module.exports = router;
