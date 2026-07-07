// ============================================================
// GET /api/config  →  returns a tiny JS file that sets public
// config on `window` from Vercel env vars:
//   SUPABASE_URL        (your project URL)
//   SUPABASE_ANON_KEY   (the public anon / publishable key)
//   GOOGLE_CLIENT_ID    (OAuth client ID for Calendar integration)
//
// Loaded via <script src="/api/config"></script> in the <head>
// BEFORE sync.js / topbar.js / tasks.js. If the env vars aren't set
// (or the site is opened locally), it sets empty strings and the
// pages fall back to whatever default is hardcoded in the JS.
//
// These are PUBLIC values (they ship to the browser anyway), so
// it's fine to expose them — this just lets people configure the
// app with env vars instead of editing files.
// ============================================================
export default function handler(req, res) {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(
    'window.DASH_SUPABASE_URL=' + JSON.stringify(url) + ';' +
    'window.DASH_SUPABASE_KEY=' + JSON.stringify(key) + ';' +
    'window.DASH_GOOGLE_CLIENT_ID=' + JSON.stringify(googleClientId) + ';'
  );
}
