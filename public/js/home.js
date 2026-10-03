const fieldsWrap = document.getElementById('fieldsWrap');
const addFieldBtn = document.getElementById('addFieldBtn');
const channelForm = document.getElementById('channelForm');
const channelsList = document.getElementById('channelsList');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const heroCreate = document.getElementById('heroCreate');
const heroLogin = document.getElementById('heroLogin');
const loginLink = document.getElementById('loginLink');
const logoutBtn = document.getElementById('logoutBtn');
const userEmail = document.getElementById('userEmail');
const appSection = document.getElementById('appSection');
const statusNode = document.getElementById('status');
const createMsg = document.getElementById('createMsg');
const createBtn = document.getElementById('createBtn');

const MAX_FIELDS = 20;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showStatus(text) {
  statusNode.textContent = text || '';
  statusNode.hidden = !text;
}

function openModal() {
  modalBackdrop.classList.add('open');
  document.getElementById('name').focus();
}

function closeModal() {
  modalBackdrop.classList.remove('open');
}

heroCreate.addEventListener('click', openModal);
modalCloseBtn.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
logoutBtn.addEventListener('click', logout);

addFieldBtn.addEventListener('click', () => {
  const count = fieldsWrap.querySelectorAll('.fieldInput').length;
  if (count >= MAX_FIELDS) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fieldInput';
  input.maxLength = 60;
  input.placeholder = `Field ${count + 1} name`;
  fieldsWrap.appendChild(input);
  if (count + 1 >= MAX_FIELDS) addFieldBtn.disabled = true;
});

channelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('name').value.trim();
  const description = document.getElementById('description').value.trim();
  const fields = Array.from(document.querySelectorAll('.fieldInput'))
    .map((input) => input.value.trim())
    .filter((value) => value.length > 0);
  if (!name || fields.length === 0) {
    createMsg.textContent = 'Add a name and at least one field.';
    createMsg.classList.add('is-error');
    return;
  }
  createBtn.disabled = true;
  createMsg.textContent = '';
  try {
    const channel = await api('/api/channels', { method: 'POST', body: { name, description, fields } });
    window.location.href = `channel.html?id=${encodeURIComponent(channel.id)}`;
  } catch (err) {
    createMsg.textContent = err.message;
    createMsg.classList.add('is-error');
    createBtn.disabled = false;
  }
});

function channelCard(ch) {
  const item = el('div', 'channel-item');
  item.appendChild(el('span', 'badge', `ID ${ch.id}`));
  item.appendChild(el('h3', null, ch.name));
  item.appendChild(el('p', null, ch.description || ''));
  const meta = el('div', 'channel-meta');
  meta.appendChild(el('span', null, `${ch.device_count} device${ch.device_count === 1 ? '' : 's'}`));
  meta.appendChild(el('span', null, `${ch.entries_count} entries`));
  meta.appendChild(el('span', null, ch.is_public ? 'public' : 'private'));
  item.appendChild(meta);
  const link = el('a', null, 'Open channel');
  link.href = `channel.html?id=${encodeURIComponent(ch.id)}`;
  item.appendChild(link);
  return item;
}

async function loadChannels() {
  let channels;
  try {
    channels = await api('/api/channels');
  } catch (err) {
    if (err.status === 401) {
      window.location.href = 'login.html';
      return;
    }
    channelsList.replaceChildren(el('p', 'empty-state', 'Could not load channels'));
    return;
  }
  if (channels.length === 0) {
    const block = el('div', 'empty-state-block');
    block.appendChild(el('p', null, 'No channels yet.'));
    const button = el('button', 'btn btn-accent', 'Create your first channel');
    button.type = 'button';
    button.addEventListener('click', openModal);
    block.appendChild(button);
    channelsList.replaceChildren(block);
    return;
  }
  channelsList.replaceChildren(...channels.map(channelCard));
}

async function boot() {
  showStatus('Connecting...');
  try {
    await initAuth((n) => showStatus(`Server is waking up, retrying (${n})...`));
  } catch {
    showStatus('Server is not reachable. Refresh in a minute.');
    return;
  }
  showStatus('');
  const session = await getSession();
  if (!session) return;
  userEmail.textContent = session.user.email;
  userEmail.hidden = false;
  logoutBtn.hidden = false;
  loginLink.hidden = true;
  heroLogin.hidden = true;
  heroCreate.hidden = false;
  appSection.hidden = false;
  loadChannels();
}

boot();