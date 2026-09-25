const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');
const generateApiKey = require('../utils/generateApiKey');
const liveCache = require('../liveCache');
const {
  parseFeedFilters,
  clampRows,
  buildFeedQuery,
  handleCsvExport,
} = require('../utils/feedsExport');

const router = express.Router();

const FIELD_COUNT = 20;
const MAX_NAME_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_FIELD_LABEL_LENGTH = 60;
const DEFAULT_MIN_INTERVAL = 1;
const MAX_MIN_INTERVAL = 3600;
const NOT_FOUND_CODE = 'PGRST116';
const DEVICE_STALE_MULTIPLIER = 3;
const DEFAULT_STALE_SECONDS = 60;
const MAX_COMMAND_LENGTH = 60;
const MAX_COMMANDS_LIST = 50;
const MAX_PAYLOAD_JSON_LENGTH = 2000;

const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
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

function parseChannelId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid channel id' });
    return null;
  }
  return id;
}

async function fetchChannel(id) {
  const { data, error } = await supabase.from('channels').select('*').eq('id', id).single();
  if (error && error.code !== NOT_FOUND_CODE) throw error;
  return data || null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAdmin(req, channel) {
  const key = req.get('x-admin-key');
  return Boolean(key) && safeEqual(channel.admin_key, key);
}

function canView(req, channel) {
  return channel.is_public !== false || isAdmin(req, channel);
}

function stripSecrets(channel, admin) {
  const { admin_key, write_api_key, read_api_key, ...publicFields } = channel;
  if (!admin) return publicFields;
  return { ...publicFields, write_api_key, read_api_key };
}

async function requireAdmin(req, res, next) {
  const id = parseChannelId(req, res);
  if (id === null) return;
  const channel = await fetchChannel(id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  if (!isAdmin(req, channel)) return res.status(403).json({ error: 'invalid admin key' });
  req.channel = channel;
  next();
}

async function loadViewableChannel(req, res) {
  const id = parseChannelId(req, res);
  if (id === null) return null;
  const channel = await fetchChannel(id);
  if (!channel) {
    res.status(404).json({ error: 'channel not found' });
    return null;
  }
  if (!canView(req, channel)) {
    res.status(403).json({ error: 'this channel is private' });
    return null;
  }
  return channel;
}

router.get('/summary', guard(async (req, res) => {
  const [channels, devices, entries] = await Promise.all([
    supabase.from('channels').select('id', { count: 'exact', head: true }),
    supabase.from('devices').select('id', { count: 'exact', head: true }),
    supabase.from('feeds').select('id', { count: 'exact', head: true }),
  ]);
  const failed = [channels, devices, entries].find((r) => r.error);
  if (failed) throw failed.error;
  res.json({
    channels: channels.count || 0,
    devices: devices.count || 0,
    entries: entries.count || 0,
  });
}));

router.get('/', guard(async (req, res) => {
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('is_public', true)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const withCounts = await Promise.all(
    channels.map(async (ch) => {
      const [devices, entries] = await Promise.all([
        supabase.from('devices').select('id', { count: 'exact', head: true }).eq('channel_id', ch.id),
        supabase.from('feeds').select('id', { count: 'exact', head: true }).eq('channel_id', ch.id),
      ]);
      return {
        id: ch.id,
        name: ch.name,
        description: ch.description,
        device_count: devices.count || 0,
        entries_count: entries.count || 0,
      };
    })
  );
  res.json(withCounts);
}));

router.post('/', guard(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, MAX_NAME_LENGTH);
  const description = String(body.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const fields = Array.isArray(body.fields) ? body.fields : [];
  const cleanFields = fields
    .map((f) => String(f || '').trim().slice(0, MAX_FIELD_LABEL_LENGTH))
    .filter((f) => f.length > 0)
    .slice(0, FIELD_COUNT);

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (cleanFields.length === 0) return res.status(400).json({ error: 'at least one field is required' });

  const insertPayload = {
    name,
    description,
    write_api_key: generateApiKey(),
    read_api_key: generateApiKey(),
    admin_key: generateApiKey(),
    min_interval_seconds: DEFAULT_MIN_INTERVAL,
    is_public: true,
  };
  cleanFields.forEach((label, i) => {
    insertPayload[`field${i + 1}`] = label;
  });

  const { data, error } = await supabase.from('channels').insert(insertPayload).select().single();
  if (error) throw error;
  res.status(201).json(data);
}));

router.get('/:id', guard(async (req, res) => {
  const channel = await loadViewableChannel(req, res);
  if (!channel) return;
  res.json(stripSecrets(channel, isAdmin(req, channel)));
}));

router.patch('/:id', requireAdmin, guard(async (req, res) => {
  const id = req.channel.id;
  const body = req.body || {};
  const updates = {};

  if (body.min_interval_seconds !== undefined) {
    const interval = Number(body.min_interval_seconds);
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_MIN_INTERVAL) {
      return res.status(400).json({ error: 'min_interval_seconds must be an integer from 1 to 3600' });
    }
    updates.min_interval_seconds = interval;
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, MAX_NAME_LENGTH);
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    updates.name = name;
  }
  if (body.description !== undefined) {
    updates.description = String(body.description).trim().slice(0, MAX_DESCRIPTION_LENGTH);
  }
  if (body.is_public !== undefined) {
    updates.is_public = Boolean(body.is_public);
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no valid fields to update' });

  const { data, error } = await supabase.from('channels').update(updates).eq('id', id).select().single();
  if (error && error.code !== NOT_FOUND_CODE) throw error;
  if (!data) return res.status(404).json({ error: 'channel not found' });
  res.json(stripSecrets(data, true));
}));

router.delete('/:id', requireAdmin, guard(async (req, res) => {
  const { error } = await supabase.from('channels').delete().eq('id', req.channel.id);
  if (error) throw error;
  res.json({ ok: true });
}));

router.get('/:id/live', guard(async (req, res) => {
  const channel = await loadViewableChannel(req, res);
  if (!channel) return;
  res.json({ devices: liveCache.getLive(channel.id) });
}));

router.get('/:id/feeds', guard(async (req, res) => {
  const channel = await loadViewableChannel(req, res);
  if (!channel) return;
  const filters = parseFeedFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const limit = clampRows(req.query.limit, 100, 500);
  const { data, error } = await buildFeedQuery(channel.id, filters).limit(limit);
  if (error) throw error;
  res.json(data);
}));

router.get('/:id/devices', guard(async (req, res) => {
  const channel = await loadViewableChannel(req, res);
  if (!channel) return;
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('channel_id', channel.id)
    .order('last_seen_at', { ascending: false });
  if (error) throw error;

  const staleAfterMs = Math.max(
    DEFAULT_STALE_SECONDS,
    (channel.min_interval_seconds || DEFAULT_MIN_INTERVAL) * DEVICE_STALE_MULTIPLIER
  ) * 1000;
  const now = Date.now();
  const shaped = data.map((d) => ({
    ...d,
    online: d.last_seen_at ? now - new Date(d.last_seen_at).getTime() < staleAfterMs : false,
  }));
  res.json(shaped);
}));

router.post('/:id/clear', requireAdmin, guard(async (req, res) => {
  const { error } = await supabase.from('feeds').delete().eq('channel_id', req.channel.id);
  if (error) throw error;
  res.json({ ok: true });
}));

router.get('/:id/analytics', guard(async (req, res) => {
  const channel = await loadViewableChannel(req, res);
  if (!channel) return;
  const id = channel.id;

  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    days.push({ date: start.toISOString().slice(0, 10), start: start.toISOString(), end: end.toISOString() });
  }

  const countFeeds = () => supabase.from('feeds').select('id', { count: 'exact', head: true }).eq('channel_id', id);

  const [total, devices, ...perDay] = await Promise.all([
    countFeeds(),
    supabase.from('devices').select('id', { count: 'exact', head: true }).eq('channel_id', id),
    ...days.map((d) => countFeeds().gte('created_at', d.start).lt('created_at', d.end)),
  ]);

  const failed = [total, devices, ...perDay].find((r) => r.error);
  if (failed) throw failed.error;

  const daily = days.map((d, i) => ({ date: d.date, count: perDay[i].count || 0 }));

  res.json({
    total_entries: total.count || 0,
    device_count: devices.count || 0,
    entries_today: daily[daily.length - 1].count,
    daily,
  });
}));

router.get('/:id/export.csv', exportLimiter, guard(async (req, res) => {
  const channel = await loadViewableChannel(req, res);
  if (!channel) return;
  await handleCsvExport(req, res, channel);
}));

router.post('/:id/commands', requireAdmin, guard(async (req, res) => {
  const body = req.body || {};
  const command = String(body.command || '').trim().slice(0, MAX_COMMAND_LENGTH);
  if (!command) return res.status(400).json({ error: 'command is required' });

  const deviceId = String(body.device_id || 'all').trim().slice(0, 60) || 'all';

  let payload = null;
  if (body.payload !== undefined && body.payload !== null) {
    const serialized = JSON.stringify(body.payload);
    if (serialized.length > MAX_PAYLOAD_JSON_LENGTH) {
      return res.status(400).json({ error: 'payload too large' });
    }
    payload = body.payload;
  }

  const { data, error } = await supabase
    .from('commands')
    .insert({ channel_id: req.channel.id, device_id: deviceId, command, payload })
    .select()
    .single();
  if (error) throw error;
  res.status(201).json(data);
}));

router.get('/:id/commands', requireAdmin, guard(async (req, res) => {
  const { data, error } = await supabase
    .from('commands')
    .select('*')
    .eq('channel_id', req.channel.id)
    .order('created_at', { ascending: false })
    .limit(MAX_COMMANDS_LIST);
  if (error) throw error;
  res.json(data);
}));

router.delete('/:id/commands/:commandId', requireAdmin, guard(async (req, res) => {
  const commandId = Number(req.params.commandId);
  if (!Number.isInteger(commandId)) return res.status(400).json({ error: 'invalid command id' });

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