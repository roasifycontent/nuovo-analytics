// Server-side Google OAuth token service for the dashboards.
// Exchanges an authorization code for tokens, stores the REFRESH token in a
// first-party httpOnly cookie, and mints fresh access tokens from it on demand —
// so the dashboards stay signed in without the ~hourly re-auth. The refresh happens
// server-side, so it is immune to the JS-origin config and third-party-cookie rules
// that break the client-side GIS token client.
//
// Required env var: GOOGLE_CLIENT_SECRET  (the client id is public, below)
// POST /api/google-token?action=exchange   body { code, redirect_uri }
// POST /api/google-token?action=refresh    (reads the httpOnly cookie)
// POST /api/google-token?action=logout     (clears the cookie)

const CLIENT_ID = '697769040212-ne0khk2hhqn2v6cfvvssccju3eurq7i1.apps.googleusercontent.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const COOKIE = 'nuovo_rt';
const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const action = url.searchParams.get('action');

  if (action === 'logout') {
    res.setHeader('Set-Cookie', clearCookie);
    res.status(200).json({ ok: true });
    return;
  }

  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) { res.status(500).json({ error: 'missing_GOOGLE_CLIENT_SECRET' }); return; }

  let params;
  if (action === 'exchange') {
    const { code, redirect_uri } = readBody(req);
    if (!code || !redirect_uri) { res.status(400).json({ error: 'missing_code_or_redirect_uri' }); return; }
    params = new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: secret, redirect_uri, grant_type: 'authorization_code' });
  } else if (action === 'refresh') {
    const rt = getCookie(req, COOKIE);
    if (!rt) { res.status(401).json({ error: 'no_refresh_token' }); return; }
    params = new URLSearchParams({ client_id: CLIENT_ID, client_secret: secret, refresh_token: rt, grant_type: 'refresh_token' });
  } else {
    res.status(400).json({ error: 'unknown_action' });
    return;
  }

  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await r.json();
    if (!r.ok) {
      // Refresh token revoked/expired → clear the cookie so the client falls back to sign-in.
      if (action === 'refresh') res.setHeader('Set-Cookie', clearCookie);
      res.status(r.status).json({ error: data.error_description || data.error || 'token_error' });
      return;
    }
    // Google returns refresh_token only on the first consent / with prompt=consent.
    if (action === 'exchange' && data.refresh_token) {
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(data.refresh_token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}`);
    }
    res.status(200).json({ access_token: data.access_token, expires_in: data.expires_in || 3600 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
