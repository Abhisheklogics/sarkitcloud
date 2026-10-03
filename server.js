const config = require('./config');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const supabase = require('./supabaseClient');
const ws = require('./ws');
const stats = require('./utils/stats');
const devices = require('./utils/devices');
const live = require('./utils/live');
const limits = require('./middleware/limits');
const { requireUser } = require('./middleware/auth');
const channelsRouter = require('./routes/channels');
const ingestRouter = require('./routes/ingest');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const supabaseOrigin = new URL(config.supabaseUrl).origin;

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://ik.imagekit.io'],
      connectSrc: ["'self'", supabaseOrigin, 'wss:', 'ws:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

app.get('/health', (req, res) => res.json({ ok: true }));

let readyState = { ok: true, at: 0 };
app.get('/ready', async (req, res) => {
  if (Date.now() - readyState.at > 5000) {
    try {
      const { error } = await supabase.from('channels').select('id').limit(1);
      readyState = { ok: !error, at: Date.now() };
    } catch {
      readyState = { ok: false, at: Date.now() };
    }
  }
  res.status(readyState.ok ? 200 : 503).json({ ok: readyState.ok });
});

const apiCors = cors({
  origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});
const deviceCors = cors({
  origin: true,
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-thingspeakapikey'],
  maxAge: 600,
});

app.use(express.json({ limit: '100kb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.text({ type: () => true, limit: '100kb' }));

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

app.get('/api/public-config', apiCors, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    limits: {
      maxChannelsPerUser: config.maxChannelsPerUser,
      maxDevicesPerChannel: config.maxDevicesPerChannel,
      maxRetentionDays: config.maxRetentionDays,
      fieldCount: config.fieldCount,
    },
  });
});

app.get('/api/ip', apiCors, noStore, (req, res) => {
  res.json({ ip: req.ip, forwarded: req.get('x-forwarded-for') || null });
});

app.get('/api/me', apiCors, noStore, limits.api, requireUser, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

app.use('/api/channels', apiCors, noStore, limits.api, channelsRouter);
const publicDir = path.join(__dirname, 'public');

function siteUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const host = String(req.get('host') || '');
  return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? `${req.protocol}://${host}` : '';
}

function page(file, noindex) {
  return async (req, res, next) => {
    try {
      const raw = await fs.promises.readFile(path.join(publicDir, file), 'utf8');
      res.set('Cache-Control', 'no-cache');
      if (noindex) res.set('X-Robots-Tag', 'noindex, nofollow');
      res.type('html').send(raw.replace(/%SITE_URL%/g, siteUrl(req)));
    } catch (err) {
      next(err);
    }
  };
}

app.get('/', page('index.html', false));
app.get('/login', page('login.html', true));
app.get('/channel-create', page('index.html', true));
app.get('/channel/:id(\\d+)', page('channel.html', true));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl(req)}/</loc></url></urlset>\n`
  );
});

app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/channel.html', (req, res) => {
  const id = String(req.query.id || '');
  res.redirect(301, /^\d+$/.test(id) ? `/channel/${id}` : '/');
});

app.use('/', deviceCors, noStore, limits.deviceIp, ingestRouter);

app.use(express.static(publicDir, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=300');
  },
}));

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html') {
    res.status(404).type('html').send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not found</title></head><body><h1>Page not found</h1><p><a href="/">Go to home</a></p></body></html>');
    return;
  }
  res.status(404).json({ error: 'not found' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : 'internal server error';
  if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'invalid request body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'request body too large';
  }
  if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err.message || err);
  if (req.path === '/update') {
    res.status(status).type('text/plain').send('0');
    return;
  }
  res.status(status).json({ error: message });
});

const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
ws.setup(server);

setInterval(() => stats.flush(), 10000).unref();
setInterval(() => devices.flush(), 20000).unref();
setInterval(() => live.prune(), 10 * 60 * 1000).unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10000).unref();
  server.close();
  ws.shutdown();
  try {
    await Promise.all([stats.flush(), devices.flush()]);
  } catch (err) {
    console.error('final flush failed:', err.message || err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

server.listen(config.port, () => console.log(`SarkitCloud listening on port ${config.port}`));