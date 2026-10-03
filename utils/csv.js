const supabase = require('../supabaseClient');
const { configuredFields } = require('./feeds');

const PAGE_SIZE = 1000;
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && !NUMERIC_RE.test(text) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function line(cells) {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

async function streamCsv(res, channel, filters, maxRows) {
  const fields = configuredFields(channel);
  const stamp = new Date().toISOString().slice(0, 10);
  const range = filters.start || filters.end
    ? `${(filters.start || 'start').slice(0, 10)}_to_${(filters.end || 'end').slice(0, 10)}`
    : 'all-time';

  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });

  async function write(chunk) {
    if (aborted) return;
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        res.once('drain', resolve);
        res.once('close', resolve);
      });
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="channel-${channel.id}-${range}-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');

  await write(`\uFEFF${line(['entry_id', 'created_at', 'device_id', ...fields.map((f) => f.label)])}`);

  let cursor = null;
  let sent = 0;
  while (sent < maxRows && !aborted) {
    const size = Math.min(PAGE_SIZE, maxRows - sent);
    let query = supabase.from('feeds').select('*').eq('channel_id', channel.id);
    if (filters.deviceId) query = query.eq('device_id', filters.deviceId);
    if (filters.start) query = query.gte('created_at', filters.start);
    if (filters.end) query = query.lte('created_at', filters.end);
    if (cursor) {
      query = query.or(
        `created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`
      );
    }
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(size);
    if (error) {
      console.error('csv export failed:', error.message || error);
      res.destroy();
      return;
    }
    if (!data || data.length === 0) break;
    let chunk = '';
    for (const row of data) {
      chunk += line([row.id, row.created_at, row.device_id || 'default', ...fields.map((f) => row[f.key])]);
    }
    await write(chunk);
    sent += data.length;
    cursor = data[data.length - 1];
    if (data.length < size) break;
  }
  if (!aborted) res.end();
}

module.exports = { streamCsv };