const rateLimit = require('express-rate-limit');
const config = require('../config');
const { sha } = require('../utils/keys');
const {
  WRITE_KEY_NAMES,
  READ_KEY_NAMES,
  bodyParams,
  extractKey,
  sanitizeDeviceId,
} = require('../utils/parse');

function ipOf(req) {
  return typeof rateLimit.ipKeyGenerator === 'function' ? rateLimit.ipKeyGenerator(req.ip) : req.ip;
}

function userOrIp(req) {
  const header = req.get('authorization');
  return header ? `u:${sha(header).slice(0, 24)}` : `ip:${ipOf(req)}`;
}

function keyOrIp(names) {
  return (req) => {
    const key = extractKey(req, { ...req.query, ...bodyParams(req) }, names);
    return key ? `k:${sha(key).slice(0, 24)}` : `ip:${ipOf(req)}`;
  };
}

function keyAndDevice(req) {
  const key = extractKey(req, { ...req.query, ...bodyParams(req) }, WRITE_KEY_NAMES);
  const device = sanitizeDeviceId(req.query.device_id);
  return key ? `kd:${sha(key).slice(0, 24)}:${device}` : `ip:${ipOf(req)}`;
}

function build(windowMs, max, keyGenerator, plain) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      if (plain) return res.status(429).type('text/plain').send('0');
      return res.status(429).json({ error: 'too many requests' });
    },
  });
}

module.exports = {
  api: build(60 * 1000, 300, userOrIp, false),
  createChannel: build(60 * 60 * 1000, 20, userOrIp, false),
  exportCsv: build(60 * 1000, 10, userOrIp, false),
  ingest: build(60 * 1000, config.ingestKeyLimitPerMin, keyOrIp(WRITE_KEY_NAMES), true),
  ingestJson: build(60 * 1000, config.ingestKeyLimitPerMin, keyOrIp(WRITE_KEY_NAMES), false),
  bulk: build(60 * 1000, 30, keyOrIp(WRITE_KEY_NAMES), false),
  read: build(60 * 1000, 120, keyOrIp(READ_KEY_NAMES), false),
  command: build(60 * 1000, 120, keyAndDevice, false),
  deviceIp: build(60 * 1000, config.deviceIpLimitPerMin, (req) => `ip:${ipOf(req)}`, false),
};