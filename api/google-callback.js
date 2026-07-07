// ============================================================
// GET /api/google-callback?code=...&state=...
// Receives the OAuth code from Google, exchanges it for tokens,
// and bounces back to /index.html (the Settings modal there owns the
// Connect flow) with the tokens in the URL hash. The hash never
// reaches the server — only the browser reads it, then stores the
// tokens in localStorage.
// Env vars required on Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
// ============================================================
export default async function handler(req, res) {
  const code = req.query && req.query.code;
  const errorParam = req.query && req.query.error;
  if (errorParam) return res.status(400).send('Google auth error: ' + errorParam);
  if (!code) return res.status(400).send('Missing code parameter.');

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // ALWAYS derive the redirect from the live host — Google sends the
  // browser back to whatever redirect_uri was used at login (i.e. this
  // exact origin), so deriving it here guarantees the token-exchange
  // redirect_uri matches the authorize redirect_uri.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = proto + '://' + host + '/api/google-callback';
  if (!clientId || !clientSecret) {
    return res.status(500).send('Server not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      return res.status(500).send('Google token exchange failed: ' + text);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return res.status(500).send('Google returned non-JSON: ' + text);
    }
    const access = json.access_token || '';
    const refresh = json.refresh_token || '';
    const expiresIn = json.expires_in || 3600;
    const hash = new URLSearchParams({
      google_access:  access,
      google_refresh: refresh,
      google_expires: String(Date.now() + expiresIn * 1000),
    }).toString();
    res.writeHead(302, { Location: '/index.html#' + hash });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected error: ' + (e && e.message ? e.message : String(e)));
  }
}
