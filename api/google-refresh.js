// ============================================================
// POST /api/google-refresh
// Body: { refresh_token: "..." }
// Reply: { access_token, expires_in } from Google
// Keeps the user's refresh_token alive past the ~1-hour access
// token expiry by hitting Google's token endpoint.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured' });

  try {
    const form = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refresh,
      client_id:     clientId,
      client_secret: clientSecret,
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    form,
    });
    const text = await r.text();
    if (!r.ok) return res.status(500).json({ error: 'refresh failed: ' + text });
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON response from Google' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
  }
}
