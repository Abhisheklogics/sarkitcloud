const { WebSocketServer } = require('ws');

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

function setup(server, isAuthorized) {
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

  wss.on('connection', (socket, req) => {
    if (!originAllowed(req)) {
      socket.close(1008, 'bad origin');
      return;
    }
    if (typeof isAuthorized === 'function' && !isAuthorized(req)) {
      socket.close(1008, 'unauthorized');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const channelId = url.searchParams.get('channel');
    if (!channelId) {
      socket.close();
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
