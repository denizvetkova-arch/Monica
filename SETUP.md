# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. Apple Health and Google Calendar are optional add-ons.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
```sql
insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', true)
on conflict (id) do nothing;

create policy "anon manage progress-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. Apple Health (optional) — also how nutrition (Cal AI) gets in

Feeds sleep, steps, heart rate, calories, body measurements, and nutrition into Today's
State, which the Decision Engine uses to pick lighter work on a rough night, deep work when
you're rested, and to factor protein pacing into task choice. There's no OAuth here — Apple
doesn't let any web app read HealthKit data directly, so a small iOS app called **Health
Auto Export** (~$5, one-time, App Store) acts as the bridge: it posts a JSON export to a
webhook on a schedule. "Continuous" in practice means Health Auto Export's own
background-delivery automation, which iOS batches — expect updates every so often through
the day, not truly instant.

**Nutrition specifically needs no separate integration.** Cal AI (and most photo-based
calorie trackers) write every logged meal's calories/protein/carbs/fat straight to Apple
Health on their own — confirmed via their App Store listing. As long as Health Auto Export
is set up per this section and includes the nutrition metrics below, Cal AI's data rides
along automatically.

1. Pick a secret string yourself (anything — a password generator output is fine). This is
   **your token**, not something Apple or Health Auto Export gives you.
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `HEALTH_IMPORT_TOKEN` | the secret string you picked |

   Redeploy after adding it.
3. Install **Health Auto Export** on your iPhone → grant it Health access for whichever of
   these you want tracked (nothing breaks if you skip some — untracked metrics just show
   "Unknown" instead of being estimated or guessed):
   Sleep Analysis, Step Count, Walking + Running Distance, Apple Exercise Time, Heart Rate,
   Resting Heart Rate, Heart Rate Variability, Active Energy, Basal Energy Burned, Weight &
   Body Mass, Body Fat Percentage, Body Mass Index, Flights Climbed, Apple Stand Hour, Blood
   Oxygen Saturation, Respiratory Rate, VO2 Max, Mindful Session, Workouts — and for the
   nutrition strip: Dietary Energy, Protein, Carbohydrates, Total Fat, Fiber (these populate
   automatically once Cal AI or any food-logging app is writing to Apple Health).
4. In the app: **Automations → New Automation → REST API**.
   - URL: `https://monica-zeta-blue.vercel.app/api/health-import?token=YOUR_TOKEN`
     (use the secret from step 1).
   - Method: **POST**, format **JSON**.
   - Metrics: select the ones you granted access to in step 3 (more is fine — anything not
     recognized is safely ignored, never guessed at).
   - **Date range: "Default" (previous day + today), not "Today."** This matters
     specifically for sleep — "Today" only syncs the current calendar day up to now, and a
     sleep session that ended this morning is frequently still mid-sync from Watch → iPhone
     → Health when the automation's trigger fires. "Default" always includes at least one
     full completed night, which is what the pipeline actually needs (it picks the most
     recently *completed* sleep session on its own — see `computeSleep()` in
     `api/health-import.js` — so a wider window never causes stale-looking sleep numbers,
     it only prevents missing ones).
   - **Batch Requests: ON.** This is required, not optional, if you select more than a
     handful of metrics or ever run a manual export over more than a day or two — Vercel
     rejects any single request over 4.5MB with `413 FUNCTION_PAYLOAD_TOO_LARGE`, and that's
     a hard limit on Vercel's side with no server-side workaround (confirmed against
     Vercel's own docs — not a Monica bug to patch around). Batch Requests makes Health Auto
     Export split one export into several smaller HTTP requests to the same URL instead of
     one giant one. The receiving endpoint (`api/health-import.js`) is built to merge these
     safely regardless of order or overlap — sleep in one request and steps in another both
     land correctly, an older request arriving late never overwrites newer data with stale
     data, and the same workout appearing in two overlapping requests is only counted once.
     There's no "batch size" to tune here; Health Auto Export decides how to split it.
   - Trigger: **Automatic** (background delivery) for the closest thing to continuous sync;
     a fixed interval (e.g. hourly) also works and is more predictable.
5. Run the automation once manually to confirm it works, then open the site → **Main** tile →
   **gear icon** → **Settings** → **Apple Health** box should flip to "Syncing" with a few
   stats filled in.
6. Open **health-diagnostics.html** (linked from that same Settings box) to see exactly what
   landed: a **Recent Requests** list of every request the server actually received (by
   size, and what each one merged/preserved/rejected), plus a per-metric matrix with a
   **Last Updated** column per metric — sleep and steps can genuinely come from different
   requests now, so there's no single blob-level "last synced" timestamp anymore. This is
   the tool to use if a metric isn't showing up — it tells you directly rather than
   requiring a guess.

> **A request that still 413s never reaches Monica at all** — Vercel rejects it before this
> server's code ever runs, so it will not appear in Recent Requests or anywhere else on the
> Diagnostics page. If a sync seems to have vanished entirely (nothing new in Recent
> Requests after running the automation), check Health Auto Export's own **Activity Log**
> for a 413/error status, and confirm Batch Requests is actually ON.
>
> The webhook **discards the raw payload** after extracting aggregate numbers — it never
> stores minute-by-minute samples or workout GPS routes, only daily totals/averages (plus,
> for diagnostics, a capped trace of the last 20 requests' computed values and warnings — no
> higher-resolution than what's already in `health_metrics_v1`). If a metric still isn't
> landing after checking the Diagnostics page, check
> [`api/health-import.js`](api/health-import.js)'s `normalizeHealthPayload()` — Health Auto
> Export's exact field names have shifted across versions, and the relevant `extract(...)`
> call may need another candidate name added (use the app's "Preview Data" screen on your
> automation to see the real payload shape).

**"Calories remaining"** needs a daily target, which HealthKit has no concept of (only
consumption samples). The app estimates one from your height/weight/age/sex/activity
(Mifflin-St Jeor) automatically — no setup needed. To override it with your own number
instead, set **Daily calorie target** in Settings (gear icon → scroll down, below Active
hours/week). **"Stale after (hours)"** in that same box controls when the Apple Health card
switches to a "⚠ Health data may be outdated" warning instead of presenting old numbers as
current — defaults to 6 hours.

---

## 4. Google Calendar (optional)

Lets the decision screen (`today.html`) see your free/busy time and favor tasks that fit
the gap you're currently in. Needs a Google Cloud OAuth client — about 5 minutes.

1. Go to **console.cloud.google.com** → create a new project (or pick an existing one).
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (unless you have a Workspace account, then Internal is fine).
   - App name / support email: anything — this is only ever shown to you.
   - Scopes: skip (not required for testing mode).
   - Test users: add your own Google account's email.
   - Save. (Testing-mode apps work fine forever for a single user — no Google review needed.)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs → **Add URI** → exactly:
     `https://monica-zeta-blue.vercel.app/api/google-callback`
   - Create. Copy the **Client ID** and **Client secret**.
5. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | your OAuth client's Client ID |
| `GOOGLE_CLIENT_SECRET` | your OAuth client's Client secret (**secret**) |

6. Redeploy. Open the site → **Main** tile → tap the **gear icon** → **Connect Google Calendar**.

> The redirect URI here is a **fixed constant** in the code
> (`https://monica-zeta-blue.vercel.app/api/google-callback`), not auto-detected from the
> domain — Google requires an exact match against the one URI registered above, so opening
> the site via a Vercel preview URL will not work for this feature. If you ever fork this to
> a different domain, update the hardcoded URL in both `today.html` and
> `api/google-callback.js` to match, and add the new URI in Google Cloud Console too.
> Calendar access is **read-only** (`calendar.readonly` scope) — this app never creates,
> edits, or deletes events.

---

## 5. Automatic task classification (optional, but the point of Manage Tasks)

Lets **Manage Tasks** (the list icon on the Main screen) infer category, ROI, urgency,
difficulty, and estimated time from just a task title — "Email professor" or "Costco"
gets classified without you touching a dropdown. Runs **server-side** (unlike Nova below),
so it works from every device without re-entering a key on each one.

1. Get a key at **console.anthropic.com** (pay-as-you-go; classification calls are small —
   a few hundred tokens each).
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key |

3. **Write your Life Context once** — gear icon → Settings → **Life Context** (the first
   field). A few sentences on your actual goals/projects/priorities right now: current
   classes and which ones matter most, your career target, what your debate team is working
   toward, your research project's deadline, financial goals. This is what the classifier
   reads before scoring anything — without it, every task looks equally important to the
   model and scores cluster around the middle of the 1–10 range. Update it whenever your
   priorities actually change; you never edit it per task.
4. Redeploy. Open **Manage Tasks** → paste a task list into the bulk-add box → tasks show a
   brief "Classifying…" tag, then fill in with inferred fields. New tasks are classified
   **together, in one batch**, alongside a sample of your other open tasks — this is what
   makes scores relative to a real workload instead of each task being guessed in isolation.

> Without this key configured, task creation still works exactly the same — new tasks just
> keep their defaults (category "personal", medium energy, ROI/urgency/difficulty 5) until
> you edit them by hand. `api/classify-task.js` never blocks or fails task creation either
> way.

---

## 6. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com. (This is a separate, browser-side key from the server-side one in
§5 — Nova and task classification don't share credentials.)

---

## 7. Voice/Chat Assistant API (`/api/ask`, `/api/todos`, `/api/briefing`) — optional

Three server routes turn Monica into something a voice app or chat client can talk to:

- **`POST /api/ask`** *(Phase 1)* — body `{ "message": "...", "voice": false }`, replies
  `{ "ok": true, "reply": "..." }`. The system prompt is built from your **current open
  to-dos** and your **Life Context** profile (the same text field from §5, Settings → Life
  Context) — Claude can add, complete, or reschedule to-dos via tool use. Set `"voice": true`
  when the reply will be spoken aloud (text-to-speech) rather than read as text — Claude
  replies in short, conversational plain text with no markdown, 2-4 sentences unless the
  answer genuinely needs more (e.g. listing several to-dos by name). Omit it, or leave it
  `false`, for a normal chat-window reply.
- **`GET`/`POST /api/todos`** *(Phase 1)* — read the list (`GET`) or mutate it (`POST` with
  `{"action": "add"|"complete"|"reschedule"|"delete", ...}`).
- **`GET /api/briefing`** *(Phase 2, pre-generated and cached)* — no body. Replies
  `{ "ok": true, "reply": "...", "newsSource": "web_search"|"rss_llm"|"rss_raw"|"unavailable", "generatedAt": <ms>, "cached": true|false }`.
  A **Vercel Cron job** (see below) generates the briefing once a day and caches it in
  Supabase; a normal request returns that cached copy **instantly** (`"cached": true`) and
  only falls back to a slower live generation (`"cached": false`) if today's cache is missing
  — e.g. the cron hasn't fired yet, or its run failed.

  The reply always follows this exact structure — the greeting and the transition line are
  literal fixed strings the server concatenates, not something Claude is asked to reproduce
  word-for-word, and the weather section is plain arithmetic on real Open-Meteo data, not
  model output, so none of it can be paraphrased, dropped, or hallucinated:
  1. *"Good morning Deni, I see that you have slept well."*
  2. Weather: condition (a simple word — rain, clouds, sun, etc.), high/low, the UV index, the
     sunscreen time window (first–last hour today the UV index is ≥3, the WHO/EPA "moderate"
     threshold), and a plain yes/no on an umbrella (precipitation probability ≥40%). No
     hydration or other health tips — deliberately excluded.
  3. *"Now it's time to direct your attention to what matters most."*
  4. Claude's top 3 news picks relevant to your Life Context.

  **Location is hardcoded to Evanston, Illinois** in `api/briefing.js` (`LAT`/`LON`/`TIMEZONE`
  constants near the top of the file) since there's no per-user location setting yet — edit
  those three constants and redeploy if you move.

  **News always has something to say — 4 fallback tiers, never empty:** tries Claude's
  `web_search` tool first (`newsSource: "web_search"`); if that's unavailable *or* hits a
  rate/usage limit mid-request (Anthropic returns those as a normal 200 with the error
  embedded in the response, not a failure — `api/briefing.js` specifically checks for this,
  it doesn't just catch exceptions), falls back to Google News' free RSS feed summarized by
  Claude (`"rss_llm"`); if Claude itself is unreachable, falls back further to the raw RSS
  headlines with no LLM involved at all (`"rss_raw"`); only if literally everything fails does
  it say so honestly (`"unavailable"`) instead of inventing a story.

### Setting up the daily cron job

`vercel.json` (repo root) already defines the schedule — **Vercel auto-detects it on deploy,
no dashboard step needed** beyond setting the `CRON_SECRET` env var below. It calls
`/api/briefing` once a day, which is what actually generates and caches that day's briefing.

> **Why two cron entries, and why they're approximate:** Vercel Cron schedules run in **UTC
> only** — there's no timezone field. 6:58 AM in Evanston is 11:58 UTC during Daylight Saving
> (CDT, roughly mid-March–early November) but 12:58 UTC the rest of the year (CST). The two
> entries in `vercel.json` approximate this by switching at calendar-month boundaries instead
> of the exact DST transition date, so the very first few days of March and the transition day
> in November may fire about an hour off from 6:58 local — harmless, since a missing/stale
> cache just means the next real request generates it live instead. **If you're on Vercel's
> free Hobby plan**, there's a second, larger imprecision: Hobby cron jobs are only guaranteed
> to fire *sometime within the scheduled hour*, not at the exact minute — Pro/Enterprise fire
> within the scheduled minute. Either way this only affects *when the cache gets pre-warmed*,
> never correctness.

**Important:** `/api/ask` and `/api/todos` read and write the exact same to-do list the
dashboard already shows (`tasks.js`'s list, synced via the `tasks` row in Supabase) — not a
separate store. A to-do added by voice appears in **Manage Tasks** within about a second,
same as editing it on another device; nothing you do here is invisible to the rest of the app.

All three routes require a bearer token on every request — there's no login flow, just a
shared secret you choose.

### Setting the environment variables in Vercel

1. **Pick two secret tokens** — e.g. generate each with `openssl rand -hex 32` in a terminal,
   or a password manager:
   - `ASSISTANT_API_TOKEN` — for you (or whatever voice app you build) to call `/api/ask`,
     `/api/todos`, `/api/briefing` manually.
   - `CRON_SECRET` — a **separate** secret, used only by Vercel's own cron job to call
     `/api/briefing` automatically once a day. Vercel sends this one for you as an
     `Authorization: Bearer` header on every cron-triggered request — you never send it
     yourself. Don't reuse `ASSISTANT_API_TOKEN` for it; they're deliberately different
     credentials for two different callers.
2. **Confirm you have an Anthropic API key.** If you already set up §5 (automatic task
   classification), `ANTHROPIC_API_KEY` is already configured and these new routes reuse it
   — skip to step 4. Otherwise get one at **console.anthropic.com** (pay-as-you-go).
3. In the Vercel dashboard, open this project → **Settings → Environment Variables**, and
   add:

| Variable | Value | Environments |
|---|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key | Production, Preview, Development |
| `ASSISTANT_API_TOKEN` | the random secret you generated in step 1 | Production, Preview, Development |
| `CRON_SECRET` | the second, separate random secret from step 1 | Production, Preview, Development |

   For each one: type the **Key**, paste the **Value**, leave all three environment
   checkboxes ticked (unless you specifically want different tokens per environment), then
   click **Save**. Once `CRON_SECRET` is set, Vercel starts sending it automatically on cron
   requests — there's no separate toggle to flip.
4. **Redeploy** — Vercel → **Deployments** tab → "..." menu on the latest deployment →
   **Redeploy** (env var changes don't apply to already-running deployments; this is also
   what makes Vercel notice the `crons` block in `vercel.json` for the first time).
5. **Test it** from a terminal, replacing `YOUR_TOKEN` and the URL:

```bash
curl -s https://monica-zeta-blue.vercel.app/api/ask \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "What'"'"'s on my to-do list?"}'

curl -s https://monica-zeta-blue.vercel.app/api/briefing \
  -H "Authorization: Bearer YOUR_TOKEN"
```

   A working response looks like `{"ok":true,"reply":"..."}`. `{"ok":false,"error":"invalid
   or missing bearer token"}` means the header didn't match `ASSISTANT_API_TOKEN` (or
   `CRON_SECRET`) exactly — double-check the redeploy happened and the token has no extra
   whitespace.

   The first `/api/briefing` call each day returns `"cached": false` (nothing generated yet —
   it ran live, which takes a few seconds) and every call after that returns `"cached": true`
   instantly, until the next calendar day in Evanston. To manually pre-warm the cache instead
   of waiting for the cron job — or to confirm the cron path itself works — replace
   `YOUR_TOKEN` with your `CRON_SECRET` instead of `ASSISTANT_API_TOKEN` and repeat the
   `/api/briefing` call; it's accepted the same way. Check `newsSource` in the response:
   `"web_search"` is the normal path; `"rss_llm"` or `"rss_raw"` means web search was
   unavailable (likely disabled in the Anthropic Console, or you hit its rate/usage limit) and
   the free RSS fallback ran instead — not a bug, just Monica falling back as designed.

> Never put `ASSISTANT_API_TOKEN`, `CRON_SECRET`, or `ANTHROPIC_API_KEY` in client-side code,
> a public repo, or a URL — unlike `HEALTH_IMPORT_TOKEN` (which Health Auto Export sends as a
> `?token=` query param because it has no way to set headers), these are always sent as an
> `Authorization: Bearer` header, so they never end up logged in a URL.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) Apple Health: pick a secret token, set `HEALTH_IMPORT_TOKEN` in Vercel, point
   Health Auto Export's automation at `/api/health-import?token=...`.
4. (Optional) Google Calendar: OAuth client in Google Cloud Console + the two env vars in Vercel.
5. (Optional) Automatic task classification: `ANTHROPIC_API_KEY` in Vercel.
6. (Optional) Voice/chat assistant API (`/api/ask`, `/api/todos`, `/api/briefing`):
   `ANTHROPIC_API_KEY` + `ASSISTANT_API_TOKEN` + `CRON_SECRET` in Vercel — the daily briefing
   cron job in `vercel.json` is picked up automatically on deploy, no extra step.
7. Change the password in `lock.js`. Done.
