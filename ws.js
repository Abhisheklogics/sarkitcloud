const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const supabase = require('./supabaseClient');

const rooms = new Map();
const HEARTBEAT_INTERVAL = 30000;

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function channelAllowsConnection(channelIdRaw, adminKey) {
  const id = Number(channelIdRaw);
  if (!Number.isInteger(id)) return false;
  const { data: channel, error } = await supabase
    .from('channels')
    .select('is_public, admin_key')
    .eq('id', id)
    .single();
  if (error || !channel) return false;
  if (channel.is_public !== false) return true;
  return Boolean(adminKey) && safeEqual(channel.admin_key, adminKey);
}

function setup(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (socket, req) => {
    if (!originAllowed(req)) {
      socket.close(1008, 'bad origin');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const channelId = url.searchParams.get('channel');
    const adminKey = url.searchParams.get('admin_key');
    if (!channelId) {
      socket.close();
      return;
    }

    let allowed = false;
    try {
      allowed = await channelAllowsConnection(channelId, adminKey);
    } catch (err) {
      console.error('ws channel check crashed:', err);
    }
    if (!allowed) {
      socket.close(1008, 'unauthorized');
      return;
    }

    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    if (!rooms.has(channelId)) rooms.set(channelId, new Set());
    rooms.get(channelId).add(socket);

    socket.on('close', () => {
      const set = rooms.get(channelId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) rooms.delete(channelId);
      }
    });
  });

  return wss;
}

function broadcast(channelId, payload) {
  const set = rooms.get(String(channelId));
  if (!set || set.size === 0) return;
  const message = JSON.stringify(payload);
  set.forEach((socket) => {
    if (socket.readyState === 1) socket.send(message);
  });
}

module.exports = { setup, broadcast };