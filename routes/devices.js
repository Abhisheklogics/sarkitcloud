const express = require('express');
const crypto = require('crypto');
const supabase = require('../supabaseClient');

const router = express.Router();
const MAX_NAME_LENGTH = 60;
const NOT_FOUND_CODE = 'PGRST116';

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

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function requireDeviceAdmin(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid device id' });
    return null;
  }
  const { data: device, error } = await supabase.from('devices').select('*').eq('id', id).single();
  if (error && error.code !== NOT_FOUND_CODE) throw error;
  if (!device) {
    res.status(404).json({ error: 'device not found' });
    return null;
  }
  const { data: channel, error: chErr } = await supabase
    .from('channels')
    .select('admin_key')
    .eq('id', device.channel_id)
    .single();
  if (chErr) throw chErr;
  const key = req.get('x-admin-key');
  if (!key || !channel || !safeEqual(channel.admin_key, key)) {
    res.status(403).json({ error: 'invalid admin key' });
    return null;
  }
  return device;
}

router.patch('/:id', guard(async (req, res) => {
  const device = await requireDeviceAdmin(req, res);
  if (!device) return;
  const name = String((req.body || {}).name || '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase.from('devices').update({ name }).eq('id', device.id).select().single();
  if (error) throw error;
  res.json(data);
}));

router.delete('/:id', guard(async (req, res) => {
  const device = await requireDeviceAdmin(req, res);
  if (!device) return;
  const { error } = await supabase.from('devices').delete().eq('id', device.id);
  if (error) throw error;
  res.json({ ok: true });
}));

module.exports = router;