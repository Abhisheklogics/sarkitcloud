const { WebSocketServer } = require('ws');
const config = require('./config');
const supabase = require('./supabaseClient');
const { verifyToken } = require('./middleware/auth');

const rooms = new Map();
const HEARTBEAT_MS = 30000;
const AUTH_TIMEOUT_MS = 5000;
let wss = null;

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.length > 0) return config.allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

async function loadChannel(id) {
  const { data, error } = await supabase
    .from('channels')
    .select('id,is_public,owner_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function join(socket, channelId) {
  let room = rooms.get(channelId);
  if (!room) {
    room = new Set();
    rooms.set(channelId, room);
  }
  if (room.size >= config.wsMaxPerChannel) {
    socket.close(1013, 'channel is full');
    return false;
  }
  room.add(socket);
  socket.joined = true;
  send(socket, { type: 'ready', owner: socket.owner });
  return true;
}

function leave(socket) {
  if (!socket.joined) return;
  const room = rooms.get(socket.channelId);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) rooms.delete(socket.channelId);
}

function setup(server) {
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.joined = false;
    socket.owner = false;
    socket.channelId = 0;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('error', () => {});

    if (!originAllowed(req)) {
      socket.close(1008, 'bad origin');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const channelId = Number(url.searchParams.get('channel'));
    if (!Number.isSafeInteger(channelId) || channelId < 1) {
      socket.close(1008, 'invalid channel');
      return;
    }
    socket.channelId = channelId;

    const channelPromise = loadChannel(channelId).catch((err) => {
      console.error('ws channel lookup failed:', err.message || err);
      return null;
    });

    const authTimer = setTimeout(() => {
      if (!socket.joined) socket.close(1008, 'auth required');
    }, AUTH_TIMEOUT_MS);

    socket.on('message', async (raw) => {
      if (socket.owner) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || message.type !== 'auth' || typeof message.token !== 'string') return;
      const channel = await channelPromise;
      if (!channel) return;
      let user = null;
      try {
        user = await verifyToken(message.token);
      } catch {
        user = null;
      }
      if (!user || user.id !== channel.owner_id) {
        if (!socket.joined) socket.close(1008, 'unauthorized');
        return;
      }
      socket.owner = true;
      if (socket.joined) send(socket, { type: 'ready', owner: true });
      else join(socket, channelId);
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      leave(socket);
    });

    channelPromise.then((channel) => {
      if (socket.readyState !== 1) return;
      if (!channel) {
        socket.close(1008, 'channel not found');
        return;
      }
      if (channel.is_public && !socket.joined) join(socket, channelId);
    });
  });

  return wss;
}

function broadcast(channelId, payload, ownerOnly) {
  const room = rooms.get(Number(channelId));
  if (!room || room.size === 0) return;
  const message = JSON.stringify(payload);
  room.forEach((socket) => {
    if (socket.readyState !== 1) return;
    if (ownerOnly && !socket.owner) return;
    socket.send(message);
  });
}

function disconnectChannel(channelId, code, reason) {
  const room = rooms.get(Number(channelId));
  if (!room) return;
  [...room].forEach((socket) => socket.close(code || 1000, reason || 'closed'));
}

function dropNonOwners(channelId) {
  const room = rooms.get(Number(channelId));
  if (!room) return;
  [...room].forEach((socket) => {
    if (!socket.owner) socket.close(1008, 'channel is private');
  });
}

function shutdown() {
  if (!wss) return;
  wss.clients.forEach((socket) => socket.close(1001, 'server restarting'));
}

module.exports = { setup, broadcast, disconnectChannel, dropNonOwners, shutdown };