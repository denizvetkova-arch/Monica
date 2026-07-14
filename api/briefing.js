// ============================================================
// GET /api/briefing
// Reply: { ok: true, reply: string, newsSource: 'web_search'|'rss_fallback' }
//      | { ok: false, error }
//
// Phase 2 of the voice-assistant work: a daily spoken briefing —
// weather + UV index for Evanston, IL (hardcoded below; there is no
// per-user location setting yet), what to wear, umbrella advice, and
// the top 3 news stories relevant to the interests in the "Life
// Context" profile (same Supabase row api/ask.js reads — see
// SETUP.md §5/§7).
//
// News sourcing: tries Claude's web_search tool first. Per Anthropic's
// docs, if web search is disabled for the account/org, the API rejects
// the request with a clean 400 before any search runs (not an error
// buried in a result block) — that failure, or any other error on this
// path, triggers a fallback: fetch headlines from Google News' free,
// keyless RSS feed (parsed with a small regex — no XML library
// dependency, consistent with this repo's zero-dependency style) and
// ask Claude to pick the 3 most relevant from that fixed list instead
// of searching live. `newsSource` in the response says which path ran.
//
// Auth: Authorization: Bearer <ASSISTANT_API_TOKEN> (same token as
// api/ask.js and api/todos.js).
//
// Env vars required on Vercel:
//   ANTHROPIC_API_KEY
//   ASSISTANT_API_TOKEN
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

// Evanston, Illinois — geocoded via Open-Meteo's free geocoding API
// (geocoding-api.open-meteo.com/v1/search?name=Evanston), not guessed.
const LAT = 42.04114;
const LON = -87.69006;
const TIMEZONE = 'America/Chicago';
const LOCATION_LABEL = 'Evanston, Illinois';

const WEATHER_CODES = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow fall', 73: 'moderate snow fall', 75: 'heavy snow fall',
  77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

function checkAuth(req) {
  const expected = process.env.ASSISTANT_API_TOKEN;
  if (!expected) return false;
  const header = (req.headers && req.headers.authorization) || '';
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  return token === expected;
}

async function readAppState(supabaseUrl, supabaseKey, key) {
  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.' + key + '&select=data', {
      headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].data) || null;
  } catch (e) { return null; }
}

// ---------- Weather (Open-Meteo, free, no API key) ----------
export async function fetchWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + LAT + '&longitude=' + LON +
    '&timezone=' + encodeURIComponent(TIMEZONE) +
    '&current=temperature_2m,weather_code,precipitation,uv_index' +
    '&daily=uv_index_max,precipitation_probability_max,temperature_2m_max,temperature_2m_min' +
    '&temperature_unit=fahrenheit&precipitation_unit=inch';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo request failed: ' + r.status);
  const data = await r.json();
  const current = data.current || {};
  const daily = data.daily || {};
  return {
    tempF: current.temperature_2m,
    weatherCode: current.weather_code,
    weatherDesc: WEATHER_CODES[current.weather_code] || ('weather code ' + current.weather_code),
    uvIndexNow: current.uv_index,
    uvIndexMaxToday: Array.isArray(daily.uv_index_max) ? daily.uv_index_max[0] : null,
    precipProbMaxPct: Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : null,
    highF: Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null,
    lowF: Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null,
  };
}

export function weatherSummaryText(w) {
  const parts = [];
  if (w.tempF != null) parts.push('Current temperature: ' + Math.round(w.tempF) + '°F, ' + w.weatherDesc + '.');
  if (w.highF != null && w.lowF != null) parts.push('Today\'s high/low: ' + Math.round(w.highF) + '°F / ' + Math.round(w.lowF) + '°F.');
  if (w.uvIndexNow != null) parts.push('Current UV index: ' + w.uvIndexNow + '.');
  if (w.uvIndexMaxToday != null) parts.push('Today\'s peak UV index: ' + w.uvIndexMaxToday + '.');
  if (w.precipProbMaxPct != null) parts.push('Chance of precipitation today: ' + w.precipProbMaxPct + '%.');
  return parts.join(' ');
}

// ---------- News fallback (Google News RSS, free, keyless) ----------
export function parseRSSTitles(xml, limit) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < limit) {
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(m[1]);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
    if (title) items.push(title);
  }
  return items;
}

async function fetchNewsHeadlines(query) {
  const url = query
    ? 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en'
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  const r = await fetch(url);
  if (!r.ok) throw new Error('news RSS request failed: ' + r.status);
  const xml = await r.text();
  return parseRSSTitles(xml, 12);
}

// ---------- Prompt ----------
export function buildBriefingPrompt(weatherText, lifeContext, newsHeadlines) {
  const lines = [
    'Compose a short spoken-word morning briefing for Deni. It will be converted to speech (text-to-speech), so use plain, natural conversational language only — no markdown, no headers, no bullet points, no numbered lists, no asterisks.',
    '',
    'Structure, in order: (1) a brief greeting, (2) a one-sentence weather summary, (3) the UV index and what that means practically, (4) a quick suggestion for what to wear, (5) whether to bring an umbrella today, (6) the top 3 news stories relevant to Deni\'s interests below, each as one or two spoken sentences.',
    '',
    'Weather data for today (' + LOCATION_LABEL + '):',
    weatherText,
    '',
    'Deni\'s stated interests and priorities (Life Context):',
    lifeContext ? lifeContext : '(not set — pick broadly interesting, non-partisan headlines instead)',
  ];
  if (newsHeadlines && newsHeadlines.length) {
    lines.push(
      '',
      'Live web search was not available for this request. Choose the 3 most relevant headlines from this fixed list instead of searching — do not invent stories not on this list:',
      newsHeadlines.map((h) => '- ' + h).join('\n'),
    );
  } else {
    lines.push('', 'Use web search to find today\'s top 3 news stories relevant to those interests.');
  }
  return lines.join('\n');
}

// Server tool (web_search) can pause a long search turn — resend the
// paused assistant content unchanged to continue, per Anthropic's docs.
async function composeWithWebSearch(client, weatherText, lifeContext) {
  const messages = [{ role: 'user', content: buildBriefingPrompt(weatherText, lifeContext, null) }];
  for (let i = 0; i < 4; i++) {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1536,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      messages,
    });
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  }
  throw new Error('web search turn did not complete after multiple pauses');
}

async function composeWithRSS(client, weatherText, lifeContext) {
  const query = lifeContext ? lifeContext.slice(0, 200) : '';
  const headlines = await fetchNewsHeadlines(query);
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1536,
    messages: [{ role: 'user', content: buildBriefingPrompt(weatherText, lifeContext, headlines) }],
  });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!checkAuth(req)) return res.status(401).json({ ok: false, error: 'invalid or missing bearer token' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ ok: false, error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  let weather;
  try {
    weather = await fetchWeather();
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'weather fetch failed: ' + (e && e.message ? e.message : String(e)) });
  }
  const weatherText = weatherSummaryText(weather);

  const lifeContextState = await readAppState(supabaseUrl, supabaseKey, 'life_context');
  const lifeContext = (lifeContextState && typeof lifeContextState.life_context_v1 === 'string') ? lifeContextState.life_context_v1 : '';

  const client = new Anthropic({ apiKey });

  let reply, newsSource;
  try {
    reply = await composeWithWebSearch(client, weatherText, lifeContext);
    newsSource = 'web_search';
  } catch (e) {
    try {
      reply = await composeWithRSS(client, weatherText, lifeContext);
      newsSource = 'rss_fallback';
    } catch (e2) {
      return res.status(200).json({
        ok: false,
        error: 'briefing generation failed (web search: ' + (e && e.message ? e.message : String(e)) +
          '; rss fallback: ' + (e2 && e2.message ? e2.message : String(e2)) + ')',
      });
    }
  }

  return res.status(200).json({ ok: true, reply: reply || '(no reply text)', newsSource });
}
