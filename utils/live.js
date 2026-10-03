const channels = new Map();
const marks = new Map();
const IDLE_MS = 24 * 60 * 60 * 1000;

function markKey(channelId, deviceId) {
  return `${channelId}|${deviceId}`;
}

function update(channelId, deviceId, fields) {
  let devices = channels.get(channelId);
  if (!devices) {
    devices = new Map();
    channels.set(channelId, devices);
  }
  const previous = devices.get(deviceId);
  const state = { fields: { ...(previous ? previous.fields : {}), ...fields }, updatedAt: Date.now() };
  devices.set(deviceId, state);
  return state;
}

function get(channelId) {
  const out = {};
  const devices = channels.get(channelId);
  if (devices) {
    for (const [deviceId, state] of devices) out[deviceId] = state;
  }
  return out;
}

function lastSeen(channelId, deviceId) {
  const devices = channels.get(channelId);
  const state = devices && devices.get(deviceId);
  return state ? state.updatedAt : 0;
}

function intervalMs(minSeconds) {
  return Math.max(1, Number(minSeconds) || 1) * 1000;
}

function reserve(channelId, deviceId, minSeconds) {
  const key = markKey(channelId, deviceId);
  const now = Date.now();
  const last = marks.get(key);
  if (last && now - last < intervalMs(minSeconds)) return false;
  marks.set(key, now);
  return true;
}

function retryAfter(channelId, deviceId, minSeconds) {
  const last = marks.get(markKey(channelId, deviceId)) || 0;
  return Math.max(1, Math.ceil((last + intervalMs(minSeconds) - Date.now()) / 1000));
}

function release(channelId, deviceId) {
  marks.delete(markKey(channelId, deviceId));
}

function clearChannel(channelId) {
  channels.delete(channelId);
  const prefix = `${channelId}|`;
  for (const key of marks.keys()) {
    if (key.startsWith(prefix)) marks.delete(key);
  }
}

function clearDevice(channelId, deviceId) {
  const devices = channels.get(channelId);
  if (devices) devices.delete(deviceId);
  marks.delete(markKey(channelId, deviceId));
}

function prune() {
  const cutoff = Date.now() - IDLE_MS;
  for (const [channelId, devices] of channels) {
    for (const [deviceId, state] of devices) {
      if (state.updatedAt < cutoff) devices.delete(deviceId);
    }
    if (devices.size === 0) channels.delete(channelId);
  }
  for (const [key, time] of marks) {
    if (time < cutoff) marks.delete(key);
  }
}

module.exports = { update, get, lastSeen, reserve, retryAfter, release, clearChannel, clearDevice, prune };