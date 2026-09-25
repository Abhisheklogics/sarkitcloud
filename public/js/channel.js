const params = new URLSearchParams(window.location.search);
const channelId = params.get('id');

const MAX_CHART_POINTS = 60;
const MAX_TABLE_ROWS = 50;
const FEED_LOAD_LIMIT = 200;
const SEEN_IDS_LIMIT = 1000;
const FIELD_COUNT = 20;
const DEVICE_COLOR_PALETTE = ['#0ea5a4', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#65a30d', '#e11d48', '#0891b2'];
const MONO_FONT = { family: 'IBM Plex Mono', size: 11 };

let channelFields = [];
let charts = {};
let chartLatest = {};
let analyticsChart = null;
let socket = null;
let staleAfterMs = 60000;

const deviceColorMap = new Map();
const deviceNames = new Map();
const liveCards = new Map();
const seenFeedIds = new Set();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function flash(node) {
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getDeviceColor(deviceId) {
  if (!deviceColorMap.has(deviceId)) {
    const hex = DEVICE_COLOR_PALETTE[deviceColorMap.size % DEVICE_COLOR_PALETTE.length];
    deviceColorMap.set(deviceId, { line: hex, fill: hexToRgba(hex, 0.12) });
  }
  return deviceColorMap.get(deviceId);
}

function displayName(deviceId) {
  return deviceNames.get(deviceId) || deviceId;
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

function formatAge(diffMs) {
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function themeColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return dark
    ? { tick: '#9fb8ab', grid: '#23362d' }
    : { tick: '#55645c', grid: '#dde4e0' };
}

function applyChartTheme(chart) {
  const colors = themeColors();
  Object.values(chart.options.scales || {}).forEach((scale) => {
    if (scale.ticks) scale.ticks.color = colors.tick;
    if (scale.grid && scale.grid.display !== false) scale.grid.color = colors.grid;
  });
  const legend = chart.options.plugins && chart.options.plugins.legend;
  if (legend && legend.labels) legend.labels.color = colors.tick;
  chart.update('none');
}

function createLineChart(canvas) {
  const colors = themeColors();
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      animation: { duration: 200 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: {
          display: false,
          position: 'bottom',
          labels: { color: colors.tick, font: MONO_FONT, usePointStyle: true, boxWidth: 8 }
        },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? new Date(items[0].parsed.x).toLocaleString() : '')
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          bounds: 'data',
          ticks: { maxTicksLimit: 6, color: colors.tick, font: MONO_FONT, callback: (value) => formatTime(value) },
          grid: { color: colors.grid }
        },
        y: {
          ticks: { color: colors.tick, font: MONO_FONT },
          grid: { color: colors.grid }
        }
      }
    }
  });
}

function pointRadius(context) {
  const data = context.dataset.data;
  let last = data.length - 1;
  while (last >= 0 && data[last] === null) last--;
  return context.dataIndex === last ? 5 : 2;
}

function ensureDataset(chart, deviceId) {
  let dataset = chart.data.datasets.find((d) => d.deviceId === deviceId);
  if (!dataset) {
    const color = getDeviceColor(deviceId);
    dataset = {
      deviceId,
      label: displayName(deviceId),
      data: [],
      borderColor: color.line,
      backgroundColor: color.fill,
      borderWidth: 2,
      tension: 0.25,
      pointRadius,
      pointHoverRadius: 5,
      spanGaps: true,
      fill: false
    };
    chart.data.datasets.push(dataset);
  }
  return dataset;
}

function pointFromFeed(feed, key) {
  const raw = feed[key];
  if (raw === null || raw === undefined || raw === '') return null;
  const y = Number(raw);
  const x = new Date(feed.created_at).getTime();
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
  return { x, y };
}

function refreshLatest(key) {
  const chart = charts[key];
  const node = chartLatest[key];
  if (!chart || !node) return;
  let best = null;
  let bestDevice = null;
  chart.data.datasets.forEach((dataset) => {
    const last = dataset.data[dataset.data.length - 1];
    if (last && (!best || last.x > best.x)) {
      best = last;
      bestDevice = dataset.deviceId;
    }
  });
  if (!best) {
    node.textContent = 'waiting for data';
    return;
  }
  node.textContent = `${best.y} \u00b7 ${formatTime(best.x)} \u00b7 ${displayName(bestDevice)}`;
}

function fillApiUsage(ch) {
  const origin = window.location.origin;
  const sample = channelFields.map((f) => `${f.key}=0`).join('&');
  const writeKey = ch.write_api_key;
  const readKey = ch.read_api_key;
  const set = (id, text) => { document.getElementById(id).textContent = text; };
  set('apiWriteUrl', `${origin}/update`);
  set('apiWriteBody', `api_key=${writeKey}&device_id=device-1&${sample}`);
  set('apiWriteGet', `${origin}/update?api_key=${writeKey}&device_id=device-1&${sample}`);
  set('apiReadLast', `${origin}/channels/${ch.id}/fields/1/last.txt?api_key=${readKey}`);
  set('apiRead', `${origin}/read?api_key=${readKey}&field=1`);
  set('apiCsv', `${origin}/channels/${ch.id}/feeds.csv?api_key=${readKey}`);
  set('apiCommandJson', `${origin}/command?api_key=${writeKey}&device_id=device-1`);
  set('apiCommandText', `${origin}/command?api_key=${writeKey}&device_id=device-1&format=text`);
}

async function loadChannel() {
  if (!channelId) {
    alert('No channel selected');
    window.location.href = 'index.html';
    throw new Error('missing channel id');
  }

  const res = await fetch(`${API_BASE}/api/channels/${channelId}`, { headers: adminHeaders(channelId) });
  if (!res.ok) {
    alert('Channel not found');
    window.location.href = 'index.html';
    throw new Error('channel not found');
  }
  const ch = await res.json();
  document.getElementById('channelName').textContent = ch.name;
  document.getElementById('channelId').textContent = ch.id;
  document.getElementById('writeKey').textContent = ch.write_api_key || 'Hidden \u2014 open from the browser you created this channel in';
  document.getElementById('readKey').textContent = ch.read_api_key || 'Hidden \u2014 open from the browser you created this channel in';
  document.getElementById('minInterval').value = ch.min_interval_seconds;
  document.getElementById('isPublic').checked = ch.is_public !== false;
  staleAfterMs = Math.max(60, Number(ch.min_interval_seconds) * 3) * 1000;

  channelFields = [];
  for (let i = 1; i <= FIELD_COUNT; i++) {
    if (ch[`field${i}`]) channelFields.push({ key: `field${i}`, label: ch[`field${i}`] });
  }

  if (ch.write_api_key && ch.read_api_key) fillApiUsage(ch);

  const chartsWrap = document.getElementById('chartsWrap');
  chartsWrap.innerHTML = '';
  charts = {};
  chartLatest = {};
  channelFields.forEach((f) => {
    const box = el('div', 'chart-box');
    const head = el('div', 'chart-head');
    head.appendChild(el('h3', null, f.label));
    const latest = el('span', 'chart-latest', 'waiting for data');
    head.appendChild(latest);
    const canvas = document.createElement('canvas');
    box.append(head, canvas);
    chartsWrap.appendChild(box);
    chartLatest[f.key] = latest;
    charts[f.key] = createLineChart(canvas);
  });

  const header = document.getElementById('feedsHeader');
  header.innerHTML = '<th>Time</th><th>Device</th>' + channelFields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('');
}

function ensureLiveCard(deviceId) {
  let card = liveCards.get(deviceId);
  if (card) return card;

  const root = el('div', 'device-live-card');
  const header = el('div', 'device-live-header');
  const title = el('strong');
  const dot = el('span', 'live-dot');
  const name = el('span', 'live-name', displayName(deviceId));
  title.append(dot, name);
  const age = el('span', 'live-age', '');
  header.append(title, age);

  const grid = el('div', 'fields-grid');
  const values = {};
  channelFields.forEach((f) => {
    const box = el('div', 'field-box');
    box.appendChild(el('span', 'field-label', f.label));
    const value = el('span', 'field-value', '--');
    box.appendChild(value);
    grid.appendChild(box);
    values[f.key] = { box, value };
  });

  root.append(header, grid);
  card = { root, dot, name, age, values, updatedAt: Date.now() };
  liveCards.set(deviceId, card);
  document.getElementById('liveValues').appendChild(root);
  return card;
}

function refreshAge(card) {
  const diff = Date.now() - card.updatedAt;
  card.age.textContent = formatAge(diff);
  card.root.classList.toggle('is-stale', diff > staleAfterMs);
}

function renderDeviceLive(deviceId, fields, updatedAt) {
  const liveDiv = document.getElementById('liveValues');
  const placeholder = liveDiv.querySelector('.empty-state');
  if (placeholder) placeholder.remove();

  const card = ensureLiveCard(deviceId);
  channelFields.forEach((f) => {
    const entry = card.values[f.key];
    const raw = fields ? fields[f.key] : undefined;
    const text = raw === undefined || raw === null ? '--' : String(raw);
    if (entry.value.textContent !== text) {
      entry.value.textContent = text;
      flash(entry.box);
    }
  });
  card.updatedAt = updatedAt ? Number(updatedAt) : Date.now();
  flash(card.dot);
  refreshAge(card);
}

async function loadLive() {
  const liveDiv = document.getElementById('liveValues');
  try {
    const live = await getJson(`${API_BASE}/api/channels/${channelId}/live`);
    liveDiv.innerHTML = '';
    liveCards.clear();
    const devices = live.devices || {};
    const deviceIds = Object.keys(devices);
    if (deviceIds.length === 0) {
      liveDiv.appendChild(el('p', 'empty-state', 'No live data yet'));
      return;
    }
    deviceIds.forEach((deviceId) => {
      renderDeviceLive(deviceId, devices[deviceId].fields, devices[deviceId].updatedAt);
    });
  } catch (err) {
    console.error('loadLive failed:', err);
  }
}

function buildFeedRow(feed) {
  const row = document.createElement('tr');
  row.appendChild(el('td', null, new Date(feed.created_at).toLocaleString()));
  const deviceKey = feed.device_id || 'default';
  const deviceCell = el('td', null, displayName(deviceKey));
  deviceCell.dataset.device = deviceKey;
  row.appendChild(deviceCell);
  channelFields.forEach((cf) => {
    const value = feed[cf.key];
    row.appendChild(el('td', null, value === null || value === undefined ? '' : String(value)));
  });
  return row;
}

function rememberFeedId(id) {
  if (id === undefined || id === null) return true;
  if (seenFeedIds.has(id)) return false;
  seenFeedIds.add(id);
  if (seenFeedIds.size > SEEN_IDS_LIMIT) seenFeedIds.delete(seenFeedIds.values().next().value);
  return true;
}

function appendChartPoints(feed) {
  const deviceId = feed.device_id || 'default';
  channelFields.forEach((cf) => {
    const chart = charts[cf.key];
    const point = pointFromFeed(feed, cf.key);
    if (!chart || !point) return;
    const dataset = ensureDataset(chart, deviceId);
    dataset.data.push(point);
    if (dataset.data.length > MAX_CHART_POINTS) dataset.data.shift();
    chart.options.plugins.legend.display = chart.data.datasets.length > 0;
    chart.update();
    refreshLatest(cf.key);
    flash(chartLatest[cf.key]);
  });
}

function handleFeed(feed) {
  if (!rememberFeedId(feed.id)) return;
  const body = document.getElementById('feedsBody');
  const row = buildFeedRow(feed);
  row.classList.add('flash-row');
  body.insertBefore(row, body.firstChild);
  while (body.children.length > MAX_TABLE_ROWS) body.removeChild(body.lastChild);
  appendChartPoints(feed);
}

async function loadFeeds() {
  try {
    const feeds = await getJson(`${API_BASE}/api/channels/${channelId}/feeds?limit=${FEED_LOAD_LIMIT}`);
    const body = document.getElementById('feedsBody');
    body.innerHTML = '';
    seenFeedIds.clear();
    feeds.slice(0, MAX_TABLE_ROWS).forEach((f) => body.appendChild(buildFeedRow(f)));
    feeds.forEach((f) => rememberFeedId(f.id));

    const chronological = [...feeds].reverse();
    channelFields.forEach((cf) => {
      const chart = charts[cf.key];
      if (!chart) return;
      chart.data.datasets = [];
      chronological.forEach((f) => {
        const point = pointFromFeed(f, cf.key);
        if (point) ensureDataset(chart, f.device_id || 'default').data.push(point);
      });
      chart.data.datasets.forEach((dataset) => {
        if (dataset.data.length > MAX_CHART_POINTS) dataset.data.splice(0, dataset.data.length - MAX_CHART_POINTS);
      });
      chart.options.plugins.legend.display = chart.data.datasets.length > 0;
      chart.update();
      refreshLatest(cf.key);
    });
  } catch (err) {
    console.error('loadFeeds failed:', err);
  }
}

function refreshDeviceLabels() {
  Object.keys(charts).forEach((key) => {
    const chart = charts[key];
    chart.data.datasets.forEach((dataset) => { dataset.label = displayName(dataset.deviceId); });
    chart.update('none');
    refreshLatest(key);
  });
  liveCards.forEach((card, deviceId) => { card.name.textContent = displayName(deviceId); });
  document.querySelectorAll('#feedsBody [data-device]').forEach((cell) => {
    cell.textContent = displayName(cell.dataset.device);
  });
}

function setConnection(online) {
  const indicator = document.querySelector('.live-indicator');
  if (!indicator) return;
  indicator.textContent = online ? 'real-time' : 'reconnecting\u2026';
  indicator.classList.toggle('is-offline', !online);
}

function connectWebSocket() {
  const adminKey = getAdminKey(channelId);
  const wsUrl = `${WS_BASE}/ws?channel=${channelId}${adminKey ? `&admin_key=${encodeURIComponent(adminKey)}` : ''}`;
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    setConnection(true);
    loadLive();
    loadFeeds();
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'live') renderDeviceLive(msg.deviceId, msg.fields, msg.updatedAt);
    if (msg.type === 'feed') handleFeed(msg.feed);
    if (msg.type === 'bulk') {
      loadFeeds();
      loadAnalytics();
    }
  };

  socket.onclose = () => {
    setConnection(false);
    setTimeout(connectWebSocket, 3000);
  };

  socket.onerror = () => {
    socket.close();
  };
}

function populateExportDevices(devices) {
  const select = document.getElementById('exportDevice');
  const current = select.value;
  select.innerHTML = '<option value="">All devices</option>';
  devices.forEach((d) => {
    const option = document.createElement('option');
    option.value = d.device_id;
    option.textContent = d.name || d.device_id;
    select.appendChild(option);
  });
  select.value = current;
}

function populateCommandDevices(devices) {
  const select = document.getElementById('commandDevice');
  const current = select.value;
  select.innerHTML = '<option value="all">All devices</option>';
  devices.forEach((d) => {
    const option = document.createElement('option');
    option.value = d.device_id;
    option.textContent = d.name || d.device_id;
    select.appendChild(option);
  });
  select.value = current;
}

async function loadDevices() {
  const list = document.getElementById('devicesList');
  let devices;
  try {
    devices = await getJson(`${API_BASE}/api/channels/${channelId}/devices`);
  } catch (err) {
    console.error('loadDevices failed:', err);
    return;
  }

  if (!Array.isArray(devices) || devices.length === 0) {
    list.innerHTML = '<p class="empty-state">No devices detected yet</p>';
    return;
  }

  deviceNames.clear();
  devices.forEach((d) => deviceNames.set(d.device_id, d.name || d.device_id));
  refreshDeviceLabels();
  populateExportDevices(devices);
  populateCommandDevices(devices);

  list.innerHTML = devices.map((d) => `
    <div class="device-item">
      <span class="status-dot ${d.online ? 'online' : 'offline'}"></span>
      <span class="device-name">${escapeHtml(d.name || d.device_id)}</span>
      <span class="device-id-label">${escapeHtml(d.device_id)}</span>
      <span class="device-last-seen">${escapeHtml(d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never')}</span>
      <button class="rename-device-btn" data-id="${escapeHtml(d.id)}" data-current="${escapeHtml(d.name || d.device_id)}">Rename</button>
      <button class="delete-device-btn" data-id="${escapeHtml(d.id)}">Remove</button>
    </div>
  `).join('');

  list.querySelectorAll('.rename-device-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newName = prompt('Device name', btn.dataset.current);
      if (!newName || !newName.trim()) return;
      const res = await fetch(`${API_BASE}/api/devices/${btn.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...adminHeaders(channelId) },
        body: JSON.stringify({ name: newName.trim() })
      });
      if (!res.ok) alert('Rename failed');
      loadDevices();
    });
  });

  list.querySelectorAll('.delete-device-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this device record?')) return;
      const res = await fetch(`${API_BASE}/api/devices/${btn.dataset.id}`, {
        method: 'DELETE',
        headers: adminHeaders(channelId)
      });
      if (!res.ok) alert('Remove failed');
      loadDevices();
    });
  });
}

async function loadAnalytics() {
  let analytics;
  try {
    analytics = await getJson(`${API_BASE}/api/channels/${channelId}/analytics`);
  } catch (err) {
    console.error('loadAnalytics failed:', err);
    return;
  }

  document.getElementById('statTotalEntries').textContent = analytics.total_entries;
  document.getElementById('statDeviceCount').textContent = analytics.device_count;
  document.getElementById('statEntriesToday').textContent = analytics.entries_today;

  const labels = analytics.daily.map((d) => d.date.slice(5));
  const values = analytics.daily.map((d) => d.count);

  if (analyticsChart) {
    analyticsChart.data.labels = labels;
    analyticsChart.data.datasets[0].data = values;
    analyticsChart.update('none');
    return;
  }

  const colors = themeColors();
  analyticsChart = new Chart(document.getElementById('analyticsChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Entries per day', data: values, backgroundColor: '#cb8a46', borderRadius: 3 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.tick, font: MONO_FONT }, grid: { display: false } },
        y: { ticks: { color: colors.tick, font: MONO_FONT }, grid: { color: colors.grid } }
      }
    }
  });
}

function statusBadge(status) {
  return `<span class="cmd-status cmd-${status}">${status}</span>`;
}

async function loadCommands() {
  const body = document.getElementById('commandsBody');
  try {
    const commands = await getJson(`${API_BASE}/api/channels/${channelId}/commands`, { headers: adminHeaders(channelId) });
    if (!Array.isArray(commands) || commands.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="empty-state">No commands sent yet</td></tr>';
      return;
    }
    body.innerHTML = commands.map((c) => `
      <tr>
        <td>${new Date(c.created_at).toLocaleString()}</td>
        <td>${escapeHtml(c.device_id)}</td>
        <td>${escapeHtml(c.command)}</td>
        <td>${statusBadge(c.status)}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('loadCommands failed:', err);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.copyTarget);
    await copyText(target.textContent);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const min_interval_seconds = document.getElementById('minInterval').value;
  const is_public = document.getElementById('isPublic').checked;
  const res = await fetch(`${API_BASE}/api/channels/${channelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...adminHeaders(channelId) },
    body: JSON.stringify({ min_interval_seconds, is_public })
  });
  if (!res.ok) {
    let message = 'Could not save settings';
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {}
    alert(message);
    return;
  }
  staleAfterMs = Math.max(60, Number(min_interval_seconds) * 3) * 1000;
  alert('Settings saved');
});

document.getElementById('commandForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const device_id = document.getElementById('commandDevice').value;
  const command = document.getElementById('commandName').value.trim();
  const payloadText = document.getElementById('commandPayload').value.trim();

  let payload;
  if (payloadText) {
    try {
      payload = JSON.parse(payloadText);
    } catch {
      alert('Payload must be valid JSON');
      return;
    }
  }

  const res = await fetch(`${API_BASE}/api/channels/${channelId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminHeaders(channelId) },
    body: JSON.stringify({ device_id, command, payload })
  });

  if (!res.ok) {
    alert('Failed to send command');
    return;
  }
  document.getElementById('commandName').value = '';
  document.getElementById('commandPayload').value = '';
  loadCommands();
});

document.getElementById('exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const startValue = document.getElementById('exportStart').value;
  const endValue = document.getElementById('exportEnd').value;
  const device = document.getElementById('exportDevice').value;
  if (startValue && endValue && startValue > endValue) {
    alert('"From" date must be before "To" date');
    return;
  }

  const query = new URLSearchParams();
  if (startValue) query.set('start', new Date(`${startValue}T00:00:00`).toISOString());
  if (endValue) query.set('end', new Date(`${endValue}T23:59:59.999`).toISOString());
  if (device) query.set('device_id', device);

  const button = document.getElementById('exportBtn');
  button.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/channels/${channelId}/export.csv?${query.toString()}`);
    if (!res.ok) {
      let message = `Export failed (${res.status})`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch {}
      alert(message);
      return;
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `channel-${channelId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('Clear all stored data for this channel?')) return;
  const res = await fetch(`${API_BASE}/api/channels/${channelId}/clear`, {
    method: 'POST',
    headers: adminHeaders(channelId)
  });
  if (!res.ok) {
    alert('Clear failed');
    return;
  }
  loadFeeds();
  loadAnalytics();
});

document.getElementById('deleteBtn').addEventListener('click', async () => {
  if (!confirm('Delete this channel permanently?')) return;
  const res = await fetch(`${API_BASE}/api/channels/${channelId}`, {
    method: 'DELETE',
    headers: adminHeaders(channelId)
  });
  if (!res.ok) {
    alert('Delete failed');
    return;
  }
  window.location.href = 'index.html';
});

new MutationObserver(() => {
  Object.values(charts).forEach(applyChartTheme);
  if (analyticsChart) applyChartTheme(analyticsChart);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

setInterval(() => liveCards.forEach(refreshAge), 1000);
setInterval(loadCommands, 5000);

loadChannel()
  .then(() => {
    loadLive();
    loadFeeds();
    loadDevices();
    loadAnalytics();
    loadCommands();
    connectWebSocket();
    setInterval(loadDevices, 10000);
    setInterval(loadAnalytics, 30000);
  })
  .catch(() => {});