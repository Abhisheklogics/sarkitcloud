const supabase = require('../supabaseClient');
const config = require('../config');

const known = new Map();
const loading = new Map();
const seen = new Map();
let flushing = false;

function seenKey(channelId, deviceId) {
  return `${channelId}|${deviceId}`;
}

async function loadKnown(channelId) {
  const existing = known.get(channelId);
  if (existing) return existing;
  let pending = loading.get(channelId);
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabase
        .from('devices')
        .select('device_id')
        .eq('channel_id', channelId)
        .limit(1000);
      if (error) throw error;
      const set = new Set(data.map((row) => row.device_id));
      known.set(channelId, set);
      return set;
    })().finally(() => loading.delete(channelId));
    loading.set(channelId, pending);
  }
  return pending;
}

async function ensure(channelId, deviceId) {
  const set = await loadKnown(channelId);
  if (set.has(deviceId)) {
    seen.set(seenKey(channelId, deviceId), Date.now());
    return true;
  }
  if (set.size >= config.maxDevicesPerChannel) return false;
  const { error } = await supabase
    .from('devices')
    .upsert(
      { channel_id: channelId, device_id: deviceId, last_seen_at: new Date().toISOString() },
      { onConflict: 'channel_id,device_id' }
    );
  if (error) throw error;
  set.add(deviceId);
  return true;
}

async function flushEach(rows) {
  for (const row of rows) {
    const { error } = await supabase.from('devices').upsert(row, { onConflict: 'channel_id,device_id' });
    if (error && error.code !== '23503') throw error;
  }
}

async function flush() {
  if (flushing || seen.size === 0) return;
  flushing = true;
  const batch = [...seen.entries()];
  seen.clear();
  const rows = batch.map(([key, time]) => {
    const index = key.indexOf('|');
    return {
      channel_id: Number(key.slice(0, index)),
      device_id: key.slice(index + 1),
      last_seen_at: new Date(time).toISOString(),
    };
  });
  try {
    const { error } = await supabase.from('devices').upsert(rows, { onConflict: 'channel_id,device_id' });
    if (error) {
      if (error.code === '23503') await flushEach(rows);
      else throw error;
    }
  } catch (err) {
    console.error('device flush failed:', err.message || err);
    for (const [key, time] of batch) {
      if (!seen.has(key)) seen.set(key, time);
    }
  } finally {
    flushing = false;
  }
}

function forget(channelId, deviceId) {
  const set = known.get(channelId);
  if (set) set.delete(deviceId);
  seen.delete(seenKey(channelId, deviceId));
}

function forgetChannel(channelId) {
  known.delete(channelId);
  const prefix = `${channelId}|`;
  for (const key of seen.keys()) {
    if (key.startsWith(prefix)) seen.delete(key);
  }
}

module.exports = { ensure, flush, forget, forgetChannel };