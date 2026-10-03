const config = require('../config');

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE_RE = /^(true|on)$/i;
const FALSE_RE = /^(false|off)$/i;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_PAST_MS = 365 * 24 * 60 * 60 * 1000;

const WRITE_KEY_NAMES = ['api_key', 'write_api_key', 'key', 'apikey'];
const READ_KEY_NAMES = ['api_key', 'read_api_key', 'key', 'apikey'];

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseValue(raw) {
  const value = first(raw);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) < 1e300 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (TRUE_RE.test(text)) return 1;
  if (FALSE_RE.test(text)) return 0;
  if (!NUMBER_RE.test(text)) return undefined;
  const num = Number(text);
  return Number.isFinite(num) && Math.abs(num) < 1e300 ? num : undefined;
}

function extractFields(source) {
  const fields = {};
  if (!source || typeof source !== 'object') return fields;
  for (const key of config.fieldKeys) {
    const value = parseValue(source[key]);
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

function sanitizeDeviceId(raw) {
  const value = first(raw);
  if (value === undefined || value === null) return 'default';
  const id = String(value).trim().replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 60);
  return id || 'default';
}

function parseCreatedAt(raw) {
  const value = first(raw);
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  let date;
  if (/^\d{9,10}$/.test(text)) date = new Date(Number(text) * 1000);
  else if (/^\d{12,13}$/.test(text)) date = new Date(Number(text));
  else date = new Date(text);
  const time = date.getTime();
  if (Number.isNaN(time)) return undefined;
  if (time > Date.now() + MAX_FUTURE_SKEW_MS) return undefined;
  if (time < Date.now() - MAX_PAST_MS) return undefined;
  return date.toISOString();
}

function parseDateBoundary(raw, endOfDay) {
  const value = first(raw);
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseFilters(query) {
  const start = parseDateBoundary(query.start, false);
  const end = parseDateBoundary(query.end, true);
  if (start === undefined || end === undefined) return { error: 'start and end must be valid dates' };
  if (start && end && start > end) return { error: 'start must be before end' };
  const rawDevice = first(query.device_id);
  const deviceId = rawDevice ? sanitizeDeviceId(rawDevice) : null;
  return { start, end, deviceId };
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(first(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseFieldNumber(raw) {
  const value = first(raw);
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= config.fieldCount ? n : NaN;
}

function bodyParams(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  if (typeof body === 'string' && body.length > 0) {
    const text = body.trim();
    if (text[0] === '{') {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return Object.fromEntries(new URLSearchParams(text));
  }
  return {};
}

function extractKey(req, params, names) {
  let raw;
  for (const name of names) {
    if (params && params[name] !== undefined) {
      raw = params[name];
      break;
    }
  }
  if (raw === undefined) raw = req.get('x-api-key') || req.get('x-thingspeakapikey');
  raw = first(raw);
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key && key.length <= 128 ? key : null;
}

module.exports = {
  WRITE_KEY_NAMES,
  READ_KEY_NAMES,
  parseValue,
  extractFields,
  sanitizeDeviceId,
  parseCreatedAt,
  parseFilters,
  clampInt,
  parseFieldNumber,
  bodyParams,
  extractKey,
};