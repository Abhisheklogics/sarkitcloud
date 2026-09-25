const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const API_BASE = isLocal ? 'http://localhost:4000' : 'https://sarkitcloud.onrender.com';
const WS_BASE = isLocal ? 'ws://localhost:4000' : 'wss://sarkitcloud.onrender.com';

function getAdminKey(channelId) {
  return localStorage.getItem(`sarkited_admin_${channelId}`);
}

function setAdminKey(channelId, adminKey) {
  localStorage.setItem(`sarkited_admin_${channelId}`, adminKey);
}

function adminHeaders(channelId) {
  const key = getAdminKey(channelId);
  return key ? { 'x-admin-key': key } : {};
}