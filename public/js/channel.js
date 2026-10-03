const channelId = (window.location.pathname.match(/^\/channel\/(\d+)\/?$/) || [])[1] || null;
const MAX_CHART_POINTS = 60;
const MAX_TABLE_ROWS = 50;
const SEEN_LIMIT = 1000;
const PALETTE = ['#0ea5a4', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#65a30d', '#e11d48', '#0891b2'];
const MONO = { family: 'IBM Plex Mono', size: 11 };
const PUBLIC_SECTIONS = ['detailsCard', 'analyticsCard', 'liveCard', 'devicesCard', 'chartsCard', 'exportCard', 'feedsCard'];
const OWNER_SECTIONS = ['apiCard', 'controlCard', 'settingsCard', 'dangerCard', 'keyRows'];

const $ = (id) => document.getElementById(id);

let channel = null;
let owner = false;
let fields = [];
let charts = {};
let latestNodes = {};
let analyticsChart = null;
let socket = null;
let retries = 0;
let staleAfterMs = 60000;

const colorMap = new Map();
const deviceNames = new Map();
const liveCards = new Map();
const seenIds = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(ids, visible) {
  ids.forEach((id) => {
    $(id).hidden = !visible;
  });
}

function setStatus(text) {
  $('status').textContent = text || '';
  $('status').hidden = !text;
}

function flash(node) {
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

function fmtAge(diffMs) {
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function deviceColor(deviceId) {
  if (!colorMap.has(deviceId)) {
    const hex = PALETTE[colorMap.size % PALETTE.length];
    colorMap.set(deviceId, { line: hex, fill: hexToRgba(hex, 0.12) });
  }
  return colorMap.get(deviceId);
}

function displayName(deviceId) {
  return deviceNames.get(deviceId) || deviceId;
}

function themeColors() {
  return document.documentElement.getAttribute('data-theme') === 'dark'
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
        legend: { display: false, position: 'bottom', labels: { color: colors.tick, font: MONO, usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { title: (items) => (items.length ? new Date(items[0].parsed.x).toLocaleString() : '') } },
      },
      scales: {
        x: { type: 'linear', bounds: 'data', ticks: { maxTicksLimit: 6, color: colors.tick, font: MONO, callback: (v) => fmtTime(v) }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.tick, font: MONO }, grid: { color: colors.grid } },
      },
    },
  });
}

function pointRadius(context) {
  const data = context.dataset.data;
  let last = data.length - 1;
  while (last >= 0 && data[last] === null) last -= 1;
  return context.dataIndex === last ? 5 : 2;
}

function ensureDataset(chart, deviceId) {
  let dataset = chart.data.datasets.find((d) => d.deviceId === deviceId);
  if (!dataset) {
    const color = deviceColor(deviceId);
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
      fill: false,
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
  return Number.isFinite(y) && Number.isFinite(x) ? { x, y } : null;
}

function refreshLatest(key) {
  const chart = charts[key];
  const node = latestNodes[key];
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
  node.textContent = best ? `${best.y} \u00b7 ${fmtTime(best.x)} \u00b7 ${displayName(bestDevice)}` : 'waiting for data';
}

function fillKeys() {
  const origin = window.location.origin;
  const w = channel.write_api_key;
  const r = channel.read_api_key;
  const sample = fields.map((f) => `${f.key}=0`).join('&');
  const set = (id, text) => {
    $(id).textContent = text;
  };
  set('writeKey', w);
  set('readKey', r);
  set('apiWriteUrl', `${origin}/update`);
  set('apiWriteBody', `api_key=${w}&device_id=device-1&${sample}`);
  set('apiWriteGet', `${origin}/update?api_key=${w}&device_id=device-1&${sample}`);
  set('apiBulk', `${origin}/update/bulk`);
  set('apiReadLast', `${origin}/channels/${channel.id}/fields/1/last.txt?api_key=${r}`);
  set('apiRead', `${origin}/read?api_key=${r}&field=1`);
  set('apiCsv', `${origin}/channels/${channel.id}/feeds.csv?api_key=${r}`);
  set('apiCommandText', `${origin}/command?api_key=${w}&device_id=device-1&format=text`);
  set('apiAck', `${origin}/command/ack?api_key=${w}&command_id=ID`);
}

function applyChannel() {
  owner = Boolean(channel.is_owner);
  $('channelName').textContent = channel.name;
  $('channelId').textContent = channel.id;
  document.title = `${channel.name} \u2014 SarkitCloud`;
  fields = [];
  for (let i = 1; i <= 20; i += 1) {
    if (channel[`field${i}`]) fields.push({ key: `field${i}`, label: channel[`field${i}`] });
  }
  staleAfterMs = Math.max(60, Number(channel.min_interval_seconds) * 3) * 1000;
  $('minInterval').value = channel.min_interval_seconds;
  $('retentionDays').value = channel.retention_days;
  if (publicConfig && publicConfig.limits) $('retentionDays').max = publicConfig.limits.maxRetentionDays;
  $('isPublic').checked = Boolean(channel.is_public);
  if (owner) fillKeys();
}

function buildCharts() {
  const wrap = $('chartsWrap');
  wrap.innerHTML = '';
  charts = {};
  latestNodes = {};
  fields.forEach((f) => {
    const box = el('div', 'chart-box');
    const head = el('div', 'chart-head');
    head.appendChild(el('h3', null, f.label));
    const latest = el('span', 'chart-latest', 'waiting for data');
    head.appendChild(latest);
    const canvas = document.createElement('canvas');
    box.append(head, canvas);
    wrap.appendChild(box);
    latestNodes[f.key] = latest;
    charts[f.key] = createLineChart(canvas);
  });
  const header = $('feedsHeader');
  header.replaceChildren(el('th', null, 'Time'), el('th', null, 'Device'), ...fields.map((f) => el('th', null, f.label)));
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
  fields.forEach((f) => {
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
  $('liveValues').appendChild(root);
  return card;
}

function refreshAge(card) {
  const diff = Date.now() - card.updatedAt;
  card.age.textContent = fmtAge(diff);
  card.root.classList.toggle('is-stale', diff > staleAfterMs);
}

function renderLive(deviceId, values, updatedAt) {
  const placeholder = $('liveValues').querySelector('.empty-state');
  if (placeholder) placeholder.remove();
  const card = ensureLiveCard(deviceId);
  fields.forEach((f) => {
    const raw = values ? values[f.key] : undefined;
    const text = raw === undefined || raw === null ? '--' : String(raw);
    const entry = card.values[f.key];
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
  try {
    const live = await api(`/api/channels/${channelId}/live`);
    $('liveValues').innerHTML = '';
    liveCards.clear();
    const ids = Object.keys(live.devices || {});
    if (ids.length === 0) {
      $('liveValues').appendChild(el('p', 'empty-state', 'No live data yet'));
      return;
    }
    ids.forEach((id) => renderLive(id, live.devices[id].fields, live.devices[id].updatedAt));
  } catch (err) {
    console.error('loadLive failed:', err);
  }
}

function buildFeedRow(feed) {
  const row = document.createElement('tr');
  row.appendChild(el('td', null, new Date(feed.created_at).toLocaleString()));
  const key = feed.device_id || 'default';
  const cell = el('td', null, displayName(key));
  cell.dataset.device = key;
  row.appendChild(cell);
  fields.forEach((f) => {
    const value = feed[f.key];
    row.appendChild(el('td', null, value === null || value === undefined ? '' : String(value)));
  });
  return row;
}

function rememberId(id) {
  if (id === undefined || id === null) return true;
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > SEEN_LIMIT) seenIds.delete(seenIds.values().next().value);
  return true;
}

function handleFeed(feed) {
  if (!rememberId(feed.id)) return;
  const body = $('feedsBody');
  const row = buildFeedRow(feed);
  row.classList.add('flash-row');
  body.insertBefore(row, body.firstChild);
  while (body.children.length > MAX_TABLE_ROWS) body.removeChild(body.lastChild);
  const deviceId = feed.device_id || 'default';
  fields.forEach((f) => {
    const chart = charts[f.key];
    const point = pointFromFeed(feed, f.key);
    if (!chart || !point) return;
    const dataset = ensureDataset(chart, deviceId);
    dataset.data.push(point);
    if (dataset.data.length > MAX_CHART_POINTS) dataset.data.shift();
    chart.options.plugins.legend.display = chart.data.datasets.length > 1;
    chart.update();
    refreshLatest(f.key);
    flash(latestNodes[f.key]);
  });
}

async function loadFeeds() {
  try {
    const feeds = await api(`/api/channels/${channelId}/feeds?per_device=${MAX_CHART_POINTS}`);
    const body = $('feedsBody');
    body.innerHTML = '';
    seenIds.clear();
    feeds.slice(0, MAX_TABLE_ROWS).forEach((f) => body.appendChild(buildFeedRow(f)));
    feeds.forEach((f) => rememberId(f.id));
    const chronological = [...feeds].reverse();
    fields.forEach((f) => {
      const chart = charts[f.key];
      chart.data.datasets = [];
      chronological.forEach((feed) => {
        const point = pointFromFeed(feed, f.key);
        if (point) ensureDataset(chart, feed.device_id || 'default').data.push(point);
      });
      chart.data.datasets.forEach((dataset) => {
        if (dataset.data.length > MAX_CHART_POINTS) dataset.data.splice(0, dataset.data.length - MAX_CHART_POINTS);
      });
      chart.options.plugins.legend.display = chart.data.datasets.length > 1;
      chart.update();
      refreshLatest(f.key);
    });
  } catch (err) {
    console.error('loadFeeds failed:', err);
  }
}

function fillSelect(id, firstValue, firstLabel, devices) {
  const select = $(id);
  const current = select.value;
  select.replaceChildren(new Option(firstLabel, firstValue));
  devices.forEach((d) => select.appendChild(new Option(d.name || d.device_id, d.device_id)));
  select.value = current;
}

function actionButton(label, className, handler) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

async function patchDevice(device, body) {
  try {
    await api(`/api/channels/${channelId}/devices/${device.id}`, { method: 'PATCH', body });
  } catch (err) {
    alert(err.message);
  }
  loadDevices();
}

function deviceItem(d) {
  const row = el('div', 'device-item');
  row.appendChild(el('span', `status-dot ${d.online ? 'online' : 'offline'}`));
  row.appendChild(el('span', 'device-name', d.name || d.device_id));
  row.appendChild(el('span', 'device-id-label', d.device_id));
  row.appendChild(el('span', 'device-last-seen', d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never'));
  if (owner) {
    row.appendChild(actionButton('Rename', 'rename-device-btn', () => {
      const name = prompt('Device name', d.name || d.device_id);
      if (name && name.trim()) patchDevice(d, { name: name.trim() });
    }));
    row.appendChild(actionButton('Interval', 'rename-device-btn', () => {
      const value = prompt('Expected seconds between posts (empty = default)', d.expected_interval_seconds || '');
      if (value === null) return;
      patchDevice(d, { expected_interval_seconds: value.trim() === '' ? null : Number(value) });
    }));
    row.appendChild(actionButton('Remove', 'delete-device-btn', async () => {
      if (!confirm('Remove this device record? It reappears if it posts again.')) return;
      try {
        await api(`/api/channels/${channelId}/devices/${d.id}`, { method: 'DELETE' });
      } catch (err) {
        alert(err.message);
      }
      loadDevices();
    }));
  }
  return row;
}

function refreshDeviceLabels() {
  Object.keys(charts).forEach((key) => {
    charts[key].data.datasets.forEach((dataset) => {
      dataset.label = displayName(dataset.deviceId);
    });
    charts[key].update('none');
    refreshLatest(key);
  });
  liveCards.forEach((card, id) => {
    card.name.textContent = displayName(id);
  });
  document.querySelectorAll('#feedsBody [data-device]').forEach((cell) => {
    cell.textContent = displayName(cell.dataset.device);
  });
}

async function loadDevices() {
  let devices;
  try {
    devices = await api(`/api/channels/${channelId}/devices`);
  } catch (err) {
    console.error('loadDevices failed:', err);
    return;
  }
  deviceNames.clear();
  devices.forEach((d) => deviceNames.set(d.device_id, d.name || d.device_id));
  refreshDeviceLabels();
  fillSelect('exportDevice', '', 'All devices', devices);
  fillSelect('commandDevice', 'all', 'All devices', devices);
  if (devices.length === 0) {
    $('devicesList').replaceChildren(el('p', 'empty-state', 'No devices detected yet'));
    return;
  }
  $('devicesList').replaceChildren(...devices.map(deviceItem));
}

async function loadAnalytics() {
  let analytics;
  try {
    analytics = await api(`/api/channels/${channelId}/analytics`);
  } catch (err) {
    console.error('loadAnalytics failed:', err);
    return;
  }
  $('statTotalEntries').textContent = analytics.total_entries;
  $('statDeviceCount').textContent = analytics.device_count;
  $('statEntriesToday').textContent = analytics.entries_today;
  const labels = analytics.daily.map((d) => d.date.slice(5));
  const values = analytics.daily.map((d) => d.count);
  if (analyticsChart) {
    analyticsChart.data.labels = labels;
    analyticsChart.data.datasets[0].data = values;
    analyticsChart.update('none');
    return;
  }
  const colors = themeColors();
  analyticsChart = new Chart($('analyticsChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Entries per day', data: values, backgroundColor: '#cb8a46', borderRadius: 3 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.tick, font: MONO }, grid: { display: false } },
        y: { ticks: { color: colors.tick, font: MONO }, grid: { color: colors.grid } },
      },
    },
  });
}

async function loadCommands() {
  if (!owner) return;
  const body = $('commandsBody');
  try {
    const commands = await api(`/api/channels/${channelId}/commands`);
    if (commands.length === 0) {
      const row = document.createElement('tr');
      const cell = el('td', 'empty-state', 'No commands sent yet');
      cell.colSpan = 4;
      row.appendChild(cell);
      body.replaceChildren(row);
      return;
    }
    body.replaceChildren(...commands.map((c) => {
      const row = document.createElement('tr');
      row.appendChild(el('td', null, new Date(c.created_at).toLocaleString()));
      row.appendChild(el('td', null, c.device_id));
      row.appendChild(el('td', null, c.command));
      const cell = document.createElement('td');
      cell.appendChild(el('span', `cmd-status cmd-${c.status}`, c.status));
      row.appendChild(cell);
      return row;
    }));
  } catch (err) {
    console.error('loadCommands failed:', err);
  }
}

function setConnection(online) {
  const node = $('liveIndicator');
  node.textContent = online ? 'real-time' : 'reconnecting...';
  node.classList.toggle('is-offline', !online);
}

async function connectSocket() {
  const token = await getToken();
  socket = new WebSocket(`${WS_BASE}/ws?channel=${encodeURIComponent(channelId)}`);
  socket.onopen = () => {
    retries = 0;
    setConnection(true);
    if (token) socket.send(JSON.stringify({ type: 'auth', token }));
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
    if (msg.type === 'live') renderLive(msg.deviceId, msg.fields, msg.updatedAt);
    if (msg.type === 'feed') handleFeed(msg.feed);
    if (msg.type === 'bulk' || msg.type === 'cleared') {
      loadFeeds();
      loadAnalytics();
      if (msg.type === 'cleared') loadLive();
    }
    if (msg.type === 'commands') loadCommands();
  };
  socket.onclose = (event) => {
    setConnection(false);
    if (event.code === 1008 || event.code === 1000) return;
    retries += 1;
    setTimeout(connectSocket, Math.min(30000, 3000 * 2 ** Math.min(retries, 4)));
  };
  socket.onerror = () => socket.close();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
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
    await copyText($(btn.dataset.copyTarget).textContent);
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 1200);
  });
});

$('logoutBtn').addEventListener('click', logout);

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    channel = await api(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: {
        min_interval_seconds: Number($('minInterval').value),
        retention_days: Number($('retentionDays').value),
        is_public: $('isPublic').checked,
      },
    });
    staleAfterMs = Math.max(60, Number(channel.min_interval_seconds) * 3) * 1000;
    alert('Settings saved');
  } catch (err) {
    alert(err.message);
  }
});

$('commandForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('commandPayload').value.trim();
  let payload;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      alert('Payload must be valid JSON');
      return;
    }
  }
  try {
    await api(`/api/channels/${channelId}/commands`, {
      method: 'POST',
      body: { device_id: $('commandDevice').value, command: $('commandName').value.trim(), payload },
    });
    $('commandName').value = '';
    $('commandPayload').value = '';
    loadCommands();
  } catch (err) {
    alert(err.message);
  }
});

$('exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = $('exportStart').value;
  const end = $('exportEnd').value;
  if (start && end && start > end) {
    alert('"From" date must be before "To" date');
    return;
  }
  const query = new URLSearchParams();
  if (start) query.set('start', start);
  if (end) query.set('end', end);
  if ($('exportDevice').value) query.set('device_id', $('exportDevice').value);
  const button = $('exportBtn');
  button.disabled = true;
  try {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/api/channels/${channelId}/export.csv?${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let message = `Export failed (${res.status})`;
      try {
        message = (await res.json()).error || message;
      } catch {}
      alert(message);
      return;
    }
    const href = URL.createObjectURL(await res.blob());
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

$('rotateBtn').addEventListener('click', async () => {
  if (!confirm('Generate new write and read keys? Devices using the old keys stop working until updated.')) return;
  try {
    channel = await api(`/api/channels/${channelId}/rotate-keys`, { method: 'POST', body: { which: 'both' } });
    fillKeys();
  } catch (err) {
    alert(err.message);
  }
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Clear all stored data for this channel?')) return;
  try {
    await api(`/api/channels/${channelId}/clear`, { method: 'POST' });
    loadFeeds();
    loadAnalytics();
    loadLive();
  } catch (err) {
    alert(err.message);
  }
});

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm('Delete this channel permanently?')) return;
  try {
    await api(`/api/channels/${channelId}`, { method: 'DELETE' });
    window.location.href = '/';
  } catch (err) {
    alert(err.message);
  }
});

new MutationObserver(() => {
  Object.values(charts).forEach(applyChartTheme);
  if (analyticsChart) applyChartTheme(analyticsChart);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

async function loadChannel() {
  try {
    channel = await api(`/api/channels/${channelId}`);
    return true;
  } catch (err) {
    setStatus('');
    if (err.status === 401) {
      $('loginLink').href = `/login?next=${encodeURIComponent(`/channel/${channelId}`)}`;
      $('loginCard').hidden = false;
    } else {
      $('errorText').textContent = err.message;
      $('errorCard').hidden = false;
    }
    return false;
  }
}

async function boot() {
  if (!/^\d+$/.test(channelId || '')) {
    window.location.href = '/';
    return;
  }
  try {
    await initAuth((n) => setStatus(`Server is waking up, retrying (${n})...`));
  } catch {
    setStatus('Server is not reachable. Refresh in a minute.');
    return;
  }
  const session = await getSession();
  $('logoutBtn').hidden = !session;
  if (!(await loadChannel())) return;
  setStatus('');
  applyChannel();
  show(PUBLIC_SECTIONS, true);
  show(OWNER_SECTIONS, owner);
  buildCharts();
  await loadDevices();
  loadAnalytics();
  loadCommands();
  connectSocket();
  setInterval(() => liveCards.forEach(refreshAge), 1000);
  setInterval(loadDevices, 15000);
  setInterval(loadAnalytics, 60000);
  if (owner) setInterval(loadCommands, 15000);
}

boot();