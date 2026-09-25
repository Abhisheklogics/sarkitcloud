const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY must be set');
}

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

if (keyRole(key) === 'anon') {
  console.warn(
    'SUPABASE_KEY is a public/anon key. Use the service_role (secret) key on the server, ' +
    'then enable RLS with no public policies (see sql/schema.sql).'
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws }
});

module.exports = supabase;
