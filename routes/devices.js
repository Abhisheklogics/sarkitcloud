const express = require('express');
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

router.patch('/:id', guard(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid device id' });
  const name = String((req.body || {}).name || '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase.from('devices').update({ name }).eq('id', id).select().single();
  if (error && error.code !== NOT_FOUND_CODE) throw error;
  if (!data) return res.status(404).json({ error: 'device not found' });
  res.json(data);
}));

router.delete('/:id', guard(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid device id' });
  const { error } = await supabase.from('devices').delete().eq('id', id);
  if (error) throw error;
  res.json({ ok: true });
}));

module.exports = router;
