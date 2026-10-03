const supabase = require('../supabaseClient');
const TtlCache = require('../utils/ttlCache');
const { sha } = require('../utils/keys');
const { HttpError, asyncHandler, parseId } = require('../utils/http');

const userCache = new TtlCache(60000, 5000);

async function verifyToken(token) {
  const cacheKey = sha(token);
  const cached = userCache.get(cacheKey);
  if (cached) return cached;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) {
    if (error && (error.status >= 500 || /fetch/i.test(error.name || ''))) {
      throw new HttpError(503, 'auth service unavailable');
    }
    return null;
  }
  const user = { id: data.user.id, email: data.user.email };
  userCache.set(cacheKey, user);
  return user;
}

async function resolveUser(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!match) return null;
  return verifyToken(match[1]);
}

const optionalUser = asyncHandler(async (req, res, next) => {
  req.user = await resolveUser(req);
  next();
});

const requireUser = asyncHandler(async (req, res, next) => {
  const user = await resolveUser(req);
  if (!user) throw new HttpError(401, 'login required');
  req.user = user;
  next();
});

async function fetchChannel(id) {
  const { data, error } = await supabase.from('channels').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

const loadOwnedChannel = asyncHandler(async (req, res, next) => {
  const id = parseId(req.params.id, 'channel id');
  const channel = await fetchChannel(id);
  if (!channel || channel.owner_id !== req.user.id) throw new HttpError(404, 'channel not found');
  req.channel = channel;
  req.isOwner = true;
  next();
});

const loadViewableChannel = [
  optionalUser,
  asyncHandler(async (req, res, next) => {
    const id = parseId(req.params.id, 'channel id');
    const channel = await fetchChannel(id);
    if (!channel) throw new HttpError(404, 'channel not found');
    const owner = Boolean(req.user) && channel.owner_id === req.user.id;
    if (!channel.is_public && !owner) {
      if (!req.user) throw new HttpError(401, 'login required');
      throw new HttpError(404, 'channel not found');
    }
    req.channel = channel;
    req.isOwner = owner;
    next();
  }),
];

module.exports = { verifyToken, optionalUser, requireUser, loadOwnedChannel, loadViewableChannel };