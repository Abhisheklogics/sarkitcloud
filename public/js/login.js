const googleBtn = document.getElementById('googleBtn');
const msg = document.getElementById('msg');

function setMessage(text, kind) {
  msg.textContent = text || '';
  msg.classList.toggle('is-error', kind === 'error');
  msg.classList.toggle('is-ok', kind === 'ok');
}

function pickNext(next) {
  return /^\/channel\/\d+$/.test(next) || next === '/channel-create' ? next : '/';
}

function safeNext() {
  return pickNext(new URLSearchParams(window.location.search).get('next') || '');
}

function showUrlError() {
  const fromQuery = new URLSearchParams(window.location.search).get('error_description');
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('error_description');
  const text = fromQuery || fromHash;
  if (text) setMessage(text, 'error');
}

googleBtn.addEventListener('click', async () => {
  googleBtn.disabled = true;
  setMessage('Redirecting to Google...');
  try {
    await initAuth((n) => setMessage(`Server is waking up, retrying (${n})...`));
    sessionStorage.setItem('sarkit_next', safeNext());
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/login`,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) throw error;
  } catch (err) {
    setMessage(err.message || 'Google sign-in failed', 'error');
    googleBtn.disabled = false;
  }
});

async function boot() {
  try {
    await initAuth((n) => setMessage(`Server is waking up, retrying (${n})...`));
  } catch {
    setMessage('Server is not reachable. Try again in a minute.', 'error');
    return;
  }
  const session = await getSession();
  if (session) {
    const stored = sessionStorage.getItem('sarkit_next');
    sessionStorage.removeItem('sarkit_next');
    window.location.replace(stored ? pickNext(stored) : safeNext());
    return;
  }
  setMessage('');
  showUrlError();
}

boot();