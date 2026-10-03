const supabase = require('../supabaseClient');
const config = require('../config');

function buildFeedQuery(channelId, filters, fieldKey) {
  const { start, end, deviceId } = filters || {};
  let query = supabase.from('feeds').select('*').eq('channel_id', channelId);
  if (deviceId) query = query.eq('device_id', deviceId);
  if (start) query = query.gte('created_at', start);
  if (end) query = query.lte('created_at', end);
  if (fieldKey) query = query.not(fieldKey, 'is', null);
  return query.order('created_at', { ascending: false }).order('id', { ascending: false });
}

function configuredFields(channel) {
  const out = [];
  config.fieldKeys.forEach((key, index) => {
    if (channel[key]) out.push({ key, number: index + 1, label: channel[key] });
  });
  return out;
}

function shapeFeed(feed, channel, onlyFieldNumber) {
  const out = {
    entry_id: feed.id,
    created_at: feed.created_at,
    device_id: feed.device_id || 'default',
  };
  configuredFields(channel).forEach((field) => {
    if (onlyFieldNumber && field.number !== onlyFieldNumber) return;
    out[field.key] = feed[field.key] ?? null;
  });
  return out;
}

function channelMeta(channel) {
  const out = {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    created_at: channel.created_at,
  };
  config.fieldKeys.forEach((key) => {
    if (channel[key]) out[key] = channel[key];
  });
  return out;
}

module.exports = { buildFeedQuery, configuredFields, shapeFeed, channelMeta };