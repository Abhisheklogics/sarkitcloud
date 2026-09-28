const fieldsWrap = document.getElementById('fieldsWrap');
const addFieldBtn = document.getElementById('addFieldBtn');
const channelForm = document.getElementById('channelForm');
const channelsList = document.getElementById('channelsList');
const summaryBar = document.getElementById('summaryBar');
const modalBackdrop = document.getElementById('modalBackdrop');
const navCreateBtn = document.getElementById('navCreateBtn');
const heroCreateBtn = document.getElementById('heroCreateBtn');
const modalCloseBtn = document.getElementById('modalCloseBtn');

const adminKeyBackdrop = document.getElementById('adminKeyBackdrop');
const adminKeyValue = document.getElementById('adminKeyValue');
const adminKeyCopyBtn = document.getElementById('adminKeyCopyBtn');
const adminKeyDownloadBtn = document.getElementById('adminKeyDownloadBtn');
const adminKeyConfirm = document.getElementById('adminKeyConfirm');
const adminKeyContinueBtn = document.getElementById('adminKeyContinueBtn');

const MAX_FIELDS = 20;
let pendingChannelId = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function openModal() {
  modalBackdrop.classList.add('open');
  document.getElementById('name').focus();
}

function closeModal() {
  modalBackdrop.classList.remove('open');
}

navCreateBtn.addEventListener('click', openModal);
heroCreateBtn.addEventListener('click', openModal);
modalCloseBtn.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalBackdrop.classList.contains('open')) closeModal();
});

addFieldBtn.addEventListener('click', () => {
  const count = fieldsWrap.querySelectorAll('.fieldInput').length;
  if (count >= MAX_FIELDS) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fieldInput';
  input.placeholder = `Field ${count + 1} name`;
  fieldsWrap.appendChild(input);
  if (count + 1 >= MAX_FIELDS) addFieldBtn.disabled = true;
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    return true;
  }
}

function openAdminKeyModal(channel) {
  pendingChannelId = channel.id;
  adminKeyValue.textContent = channel.admin_key;
  adminKeyConfirm.checked = false;
  adminKeyContinueBtn.disabled = true;
  adminKeyBackdrop.classList.add('open');
}

function goToPendingChannel() {
  const id = pendingChannelId;
  pendingChannelId = null;
  adminKeyBackdrop.classList.remove('open');
  window.location.href = `channel.html?id=${encodeURIComponent(id)}`;
}

adminKeyCopyBtn.addEventListener('click', async () => {
  await copyText(adminKeyValue.textContent);
  adminKeyCopyBtn.textContent = 'Copied';
  setTimeout(() => { adminKeyCopyBtn.textContent = 'Copy'; }, 1200);
});

adminKeyDownloadBtn.addEventListener('click', () => {
  const key = adminKeyValue.textContent;
  const contents = `SarkitCloud admin key\nChannel ID: ${pendingChannelId}\nAdmin key: ${key}\n\nKeep this file safe. Anyone with this key can manage this channel.`;
  const blob = new Blob([contents], { type: 'text/plain' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `sarkited-channel-${pendingChannelId}-admin-key.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});

adminKeyConfirm.addEventListener('change', () => {
  adminKeyContinueBtn.disabled = !adminKeyConfirm.checked;
});

adminKeyContinueBtn.addEventListener('click', () => {
  if (!adminKeyConfirm.checked) return;
  goToPendingChannel();
});

channelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('name').value.trim();
  const description = document.getElementById('description').value.trim();
  const fields = Array.from(document.querySelectorAll('.fieldInput'))
    .map((i) => i.value.trim())
    .filter((v) => v.length > 0)
    .slice(0, MAX_FIELDS);

  if (fields.length === 0) {
    alert('Add at least one field');
    return;
  }

  const res = await fetch(`${API_BASE}/api/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, fields })
  });

  if (!res.ok) {
    alert('Failed to create channel');
    return;
  }

  const channel = await res.json();
  setAdminKey(channel.id, channel.admin_key);
  closeModal();
  channelForm.reset();
  fieldsWrap.innerHTML = '<input type="text" class="fieldInput" placeholder="Field 1 name, e.g. temperature" required>';
  addFieldBtn.disabled = false;
  openAdminKeyModal(channel);
});

function statBox(value, label) {
  const box = el('div', 'stat-box');
  box.appendChild(el('span', 'stat-value', String(Number(value) || 0)));
  box.appendChild(el('span', 'stat-label', label));
  return box;
}

async function loadSummary() {
  try {
    const res = await fetch(`${API_BASE}/api/channels/summary`);
    if (!res.ok) throw new Error(String(res.status));
    const summary = await res.json();
    summaryBar.replaceChildren(
      statBox(summary.channels, 'Channels'),
      statBox(summary.devices, 'Devices'),
      statBox(summary.entries, 'Data points')
    );
  } catch {
    summaryBar.replaceChildren();
  }
}

function channelCard(ch) {
  const item = el('div', 'channel-item');
  item.appendChild(el('span', 'badge', `ID ${ch.id}`));
  item.appendChild(el('h3', null, ch.name));
  item.appendChild(el('p', null, ch.description || ''));
  const meta = el('div', 'channel-meta');
  meta.appendChild(el('span', null, `${ch.device_count} device${ch.device_count === 1 ? '' : 's'}`));
  meta.appendChild(el('span', null, `${ch.entries_count} entries`));
  item.appendChild(meta);
  const link = el('a', null, 'Open channel');
  link.href = `channel.html?id=${encodeURIComponent(ch.id)}`;
  item.appendChild(link);
  return item;
}

async function loadChannels() {
  let channels;
  try {
    const res = await fetch(`${API_BASE}/api/channels`);
    if (!res.ok) throw new Error(String(res.status));
    channels = await res.json();
  } catch (err) {
    console.error('loadChannels failed:', err);
    channelsList.replaceChildren(el('p', 'empty-state', 'Could not load channels'));
    return;
  }

  if (!Array.isArray(channels) || channels.length === 0) {
    const block = el('div', 'empty-state-block');
    block.appendChild(el('p', null, 'No channels yet.'));
    const button = el('button', 'btn btn-accent', 'Create your first channel');
    button.addEventListener('click', openModal);
    block.appendChild(button);
    channelsList.replaceChildren(block);
    return;
  }

  channelsList.replaceChildren(...channels.map(channelCard));
}

loadSummary();
loadChannels();