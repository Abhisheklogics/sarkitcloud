const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const config = require('./config');

function keyRole(value) {
  if (value.startsWith('sb_secret_')) return 'service_role';
  if (value.startsWith('sb_publishable_')) return 'anon';
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    return payload.role || 'unknown';
  } catch {
    return 'unknown';
  }
}

if (keyRole(config.supabaseServiceKey) === 'anon') {
  throw new Error('SUPABASE_SERVICE_KEY must be the service_role / sb_secret key, not the anon or publishable key');
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { transport: ws },
});

module.exports = supabase;