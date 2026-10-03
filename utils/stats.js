const supabase = require('../supabaseClient');

const MAX_PENDING_KEYS = 10000;
const pending = new Map();
let flushing = false;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function record(channelId, count, day) {
  const n = count === undefined ? 1 : count;
  if (n < 1) return;
  const key = `${channelId}|${day || today()}`;
  if (!pending.has(key) && pending.size >= MAX_PENDING_KEYS) return;
  pending.set(key, (pending.get(key) || 0) + n);
}

async function flush() {
  if (flushing || pending.size === 0) return;
  flushing = true;
  const batch = [...pending.entries()];
  pending.clear();
  const payload = batch.map(([key, n]) => {
    const index = key.indexOf('|');
    return { channel_id: Number(key.slice(0, index)), day: key.slice(index + 1), n };
  });
  try {
    const { error } = await supabase.rpc('bump_daily_stats', { p: payload });
    if (error) throw error;
  } catch (err) {
    console.error('stats flush failed:', err.message || err);
    for (const [key, n] of batch) {
      if (pending.has(key) || pending.size < MAX_PENDING_KEYS) pending.set(key, (pending.get(key) || 0) + n);
    }
  } finally {
    flushing = false;
  }
}

module.exports = { record, flush };