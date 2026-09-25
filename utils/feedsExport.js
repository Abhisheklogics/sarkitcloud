const supabase = require('../supabaseClient');

const PAGE_SIZE = 1000;
const MAX_EXPORT_ROWS = 50000;
const FIELD_COUNT = 20;

function parseDateBoundary(value, endOfDay) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = new Date(dateOnly ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseFeedFilters(query) {
  const start = parseDateBoundary(query.start, false);
  const end = parseDateBoundary(query.end, true);
  if (start === undefined || end === undefined) return { error: 'start and end must be valid dates' };
  if (start && end && start > end) return { error: 'start must be before end' };
  const deviceId = query.device_id ? String(query.device_id).trim().slice(0, 60) : null;
  return { start, end, deviceId: deviceId || null };
}

function clampRows(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function buildFeedQuery(channelId, filters = {}, fieldKey = null) {
  const { start, end, deviceId } = filters;
  let query = supabase.from('feeds').select('*').eq('channel_id', channelId);
  if (deviceId) query = query.eq('device_id', deviceId);
  if (start) query = query.gte('created_at', start);
  if (end) query = query.lte('created_at', end);
  if (fieldKey) query = query.not(fieldKey, 'is', null);
  return query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
}

async function fetchAllFeeds(channelId, filters, limit) {
  const rows = [];
  let from = 0;
  while (rows.length < limit) {
    const to = Math.min(from + PAGE_SIZE, limit) - 1;
    const { data, error } = await buildFeedQuery(channelId, filters).range(from, to);
    if (error) throw error;
    rows.push(...data);
    if (data.length < to - from + 1) break;
    from = to + 1;
  }
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.id) && seen.add(row.id)).reverse();
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  const looksNumeric = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text);
  if (typeof value === 'string' && !looksNumeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function buildCsv(channel, rows, meta = {}) {
  const fields = [];
  for (let i = 1; i <= FIELD_COUNT; i++) {
    if (channel[`field${i}`]) fields.push({ key: `field${i}`, label: channel[`field${i}`] });
  }
  const header = ['entry_id', 'created_at', 'device_id', ...fields.map((f) => f.label)];

  const actualStart = rows.length ? rows[0].created_at : null;
  const actualEnd = rows.length ? rows[rows.length - 1].created_at : null;

  const infoLines = [
    ['Channel', channel.name],
    ['Channel ID', String(channel.id)],
    ['Device filter', meta.deviceId || 'all devices'],
    ['Requested range', `${meta.requestedStart || 'earliest available'} to ${meta.requestedEnd || 'latest available'}`],
    ['Actual data range', rows.length ? `${actualStart} to ${actualEnd}` : 'no matching rows'],
    ['Row count', String(rows.length)],
    ['Generated at', new Date().toISOString()],
    [],
  ].map((line) => line.map(csvCell).join(','));

  const lines = [
    ...infoLines,
    header.map(csvCell).join(','),
  ];
  for (const row of rows) {
    const cells = [row.id, row.created_at, row.device_id || 'default', ...fields.map((f) => row[f.key])];
    lines.push(cells.map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

async function handleCsvExport(req, res, channel) {
  const filters = parseFeedFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const limit = clampRows(req.query.results, MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
  const rows = await fetchAllFeeds(channel.id, filters, limit);
  const stamp = new Date().toISOString().slice(0, 10);

  const rangeTag = filters.start || filters.end
    ? `${(filters.start || 'start').slice(0, 10)}_to_${(filters.end || 'end').slice(0, 10)}`
    : 'all-time';

  const csv = buildCsv(channel, rows, {
    deviceId: filters.deviceId,
    requestedStart: filters.start,
    requestedEnd: filters.end,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="channel-${channel.id}-${rangeTag}-generated-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(csv);
}

module.exports = {
  parseFeedFilters,
  clampRows,
  buildFeedQuery,
  fetchAllFeeds,
  buildCsv,
  handleCsvExport,
  MAX_EXPORT_ROWS,
};