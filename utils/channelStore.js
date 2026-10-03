const supabase = require('../supabaseClient');
const TtlCache = require('./ttlCache');
const { sha } = require('./keys');

const KEY_RE = /^[A-F0-9]{32}$/;
const HIT_TTL_MS = 30000;
const MISS_TTL_MS = 10000;
const cache = new TtlCache(HIT_TTL_MS, 10000);
const inflight = new Map();

async function byKey(column, rawKey) {
  const key = String(rawKey || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) return null;
  const cacheKey = `${column}:${sha(key)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  let pending = inflight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabase.from('channels').select('*').eq(column, key).maybeSingle();
      if (error) throw error;
      cache.set(cacheKey, data || null, data ? HIT_TTL_MS : MISS_TTL_MS);
      return data || null;
    })().finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, pending);
  }
  return pending;
}

function byWriteKey(key) {
  return byKey('write_api_key', key);
}

function byReadKey(key) {
  return byKey('read_api_key', key);
}

function invalidate() {
  cache.clear();
}

module.exports = { byWriteKey, byReadKey, invalidate };