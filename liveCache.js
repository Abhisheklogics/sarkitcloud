const liveState = new Map();
const lastStored = new Map();

function keyFor(channelId, deviceId) {
  return `${channelId}::${deviceId}`;
}

function updateLive(channelId, deviceId, fields) {
  const key = keyFor(channelId, deviceId);
  const existing = liveState.get(key) || { fields: {}, updatedAt: 0 };
  const merged = { ...existing.fields, ...fields };
  const state = { fields: merged, updatedAt: Date.now() };
  liveState.set(key, state);
  return state;
}

function getLive(channelId) {
  const result = {};
  for (const [key, state] of liveState.entries()) {
    const [id, deviceId] = key.split('::');
    if (id !== String(channelId)) continue;
    result[deviceId] = state;
  }
  return result;
}

function canStore(channelId, deviceId, minIntervalSeconds) {
  const key = keyFor(channelId, deviceId);
  const last = lastStored.get(key);
  if (!last) return true;
  const intervalMs = Math.max(1, Number(minIntervalSeconds) || 1) * 1000;
  return Date.now() - last >= intervalMs;
}

function markStored(channelId, deviceId) {
  lastStored.set(keyFor(channelId, deviceId), Date.now());
}

module.exports = { updateLive, getLive, canStore, markStored };
