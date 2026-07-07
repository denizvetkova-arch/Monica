# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. WHOOP, Apple Health, and Google Calendar are optional add-ons.

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

## 3. WHOOP (optional)

1. **developer.whoop.com** → create an app.
2. Set its **Redirect URI** to exactly: `https://your-app.vercel.app/api/whoop-callback`
   (use your real Vercel domain — add every domain you'll open the site from).
3. Put your app's **Client ID** in [`health.html`](health.html) (`const CLIENT_ID = '...'`),
   and add these in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `WHOOP_CLIENT_ID` | your WHOOP app's Client ID |
| `WHOOP_CLIENT_SECRET` | your WHOOP app's Client Secret (**secret**) |

4. Open the site at that exact domain → Health page → **Connect WHOOP**.

> The callback auto-detects the domain, so you do **not** need a `WHOOP_REDIRECT_URI` env var.

---

## 4. Apple Health (optional) — also how nutrition (Cal AI) gets in

Feeds sleep, steps, resting heart rate, workouts, and nutrition (calories/protein/carbs/
fat/fiber) into Today's State, which the Decision Engine uses to pick lighter work on a
rough night, deep work when you're rested, and to factor protein pacing into task choice.
There's no OAuth here — Apple doesn't let any web app read HealthKit data directly, so a
small iOS app called **Health Auto Export** (~$5, one-time, App Store) acts as the bridge:
it posts a JSON export to a webhook on a schedule. "Continuous" in practice means Health
Auto Export's own background-delivery automation, which iOS batches — expect updates every
so often through the day, not truly instant.

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
3. Install **Health Auto Export** on your iPhone → grant it Health access for at least:
   Sleep Analysis, Steps, Resting Heart Rate, Active Energy, and — for the nutrition strip —
   Dietary Energy, Protein, Carbohydrates, Total Fat, Fiber (these populate automatically
   once Cal AI or any food-logging app is writing to Apple Health).
4. In the app: **Automations → New Automation → REST API**.
   - URL: `https://monica-zeta-blue.vercel.app/api/health-import?token=YOUR_TOKEN`
     (use the secret from step 1).
   - Method: **POST**, format **JSON**.
   - Metrics: select the ones listed in step 3 (more is fine — anything not recognized is
     safely ignored).
   - Trigger: **Automatic** (background delivery) for the closest thing to continuous sync;
     a fixed interval (e.g. hourly) also works and is more predictable.
5. Run the automation once manually to confirm it works, then open the site → gear icon →
   **Settings** → **Apple Health** box should flip to "Syncing" with a few stats filled in.

> The webhook **discards the raw payload** after extracting aggregate numbers — it never
> stores minute-by-minute samples or workout GPS routes, only daily totals/averages.
> If a metric isn't showing up, check [`api/health-import.js`](api/health-import.js)'s
> `normalizeHealthPayload()` — Health Auto Export's exact field names have shifted across
> versions, and that function may need a field-name tweak to match your export (use the
> app's "Preview Data" screen on your automation to see the real payload shape).

**"Calories remaining"** needs a daily target, which HealthKit has no concept of (only
consumption samples). The app estimates one from your height/weight/age/sex/activity
(Mifflin-St Jeor) automatically — no setup needed. To override it with your own number
instead, set **Daily calorie target** in Settings (gear icon → scroll down, below Active
hours/week).

---

## 5. Google Calendar (optional)

Lets the decision screen (`index.html`) see your free/busy time and favor tasks that fit
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

6. Redeploy. Open the site → tap the **gear icon** on the home screen → **Connect Google Calendar**.

> Unlike WHOOP, the redirect URI here is a **fixed constant** in the code
> (`https://monica-zeta-blue.vercel.app/api/google-callback`), not auto-detected from the
> domain — Google requires an exact match against the one URI registered above, so opening
> the site via a Vercel preview URL will not work for this feature. If you ever fork this to
> a different domain, update the hardcoded URL in both `index.html` and
> `api/google-callback.js` to match, and add the new URI in Google Cloud Console too.
> Calendar access is **read-only** (`calendar.readonly` scope) — this app never creates,
> edits, or deletes events.

---

## 6. Automatic task classification (optional, but the point of Manage Tasks)

Lets **Manage Tasks** (the list icon on the home screen) infer category, ROI, urgency,
difficulty, and estimated time from just a task title — "Email professor" or "Costco"
gets classified without you touching a dropdown. Runs **server-side** (unlike Nova below),
so it works from every device without re-entering a key on each one.

1. Get a key at **console.anthropic.com** (pay-as-you-go; classification calls are small —
   a few hundred tokens each).
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key |

3. Redeploy. Open **Manage Tasks** → paste a task list into the bulk-add box → each line
   should show a brief "Classifying…" tag, then fill in with inferred fields.

> Without this key configured, task creation still works exactly the same — new tasks just
> keep their defaults (category "personal", medium energy, ROI/urgency/difficulty 5) until
> you edit them by hand. `api/classify-task.js` never blocks or fails task creation either
> way.

---

## 7. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com. (This is a separate, browser-side key from the server-side one in
§6 — Nova and task classification don't share credentials.)

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) WHOOP: Client ID in `health.html` + the two env vars in Vercel.
4. (Optional) Apple Health: pick a secret token, set `HEALTH_IMPORT_TOKEN` in Vercel, point
   Health Auto Export's automation at `/api/health-import?token=...`.
5. (Optional) Google Calendar: OAuth client in Google Cloud Console + the two env vars in Vercel.
6. (Optional) Automatic task classification: `ANTHROPIC_API_KEY` in Vercel.
7. Change the password in `lock.js`. Done.
