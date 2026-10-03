require('dotenv').config();

function int(name, fallback, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function list(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const fieldCount = 20;
const maxRetentionDays = int('MAX_RETENTION_DAYS', 60, 1, 365);

module.exports = {
  port: int('PORT', 4000, 1, 65535),
  trustProxy: int('TRUST_PROXY', 1, 0, 5),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  allowedOrigins: list('ALLOWED_ORIGINS'),
  maxChannelsPerUser: int('MAX_CHANNELS_PER_USER', 10, 1, 1000),
  maxDevicesPerChannel: int('MAX_DEVICES_PER_CHANNEL', 50, 1, 1000),
  maxRetentionDays,
  defaultRetentionDays: Math.min(int('DEFAULT_RETENTION_DAYS', 30, 1, 365), maxRetentionDays),
  maxExportRows: int('MAX_EXPORT_ROWS', 50000, 100, 500000),
  wsMaxPerChannel: int('WS_MAX_PER_CHANNEL', 100, 1, 10000),
  ingestKeyLimitPerMin: int('INGEST_KEY_LIMIT_PER_MIN', 300, 10, 100000),
  deviceIpLimitPerMin: int('DEVICE_IP_LIMIT_PER_MIN', 3000, 60, 1000000),
  publicUrl: String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  fieldCount,
  fieldKeys: Array.from({ length: fieldCount }, (_, i) => `field${i + 1}`),
};