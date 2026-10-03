const API_BASE = window.location.origin;
const WS_BASE = API_BASE.replace(/^http/, 'ws');

let supabaseClient = null;
let publicConfig = null;

async function fetchRetry(url, tries, onWait) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
    if (onWait) onWait(i + 1);
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error('server unreachable');
}

async function initAuth(onWait) {
  if (supabaseClient) return supabaseClient;
  const res = await fetchRetry(`${API_BASE}/api/public-config`, 8, onWait);
  publicConfig = await res.json();
  supabaseClient = window.supabase.createClient(publicConfig.supabaseUrl, publicConfig.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return supabaseClient;
}

async function getSession() {
  const { data } = await supabaseClient.auth.getSession();
  return data.session || null;
}

async function getToken() {
  const session = await getSession();
  return session ? session.access_token : null;
}

async function api(path, options) {
  const opts = options || {};
  const headers = { ...(opts.headers || {}) };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = '/';
}