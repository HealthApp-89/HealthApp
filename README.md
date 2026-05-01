# Apex Health OS

Personal health & sport performance tracker. Originally a localStorage prototype (`apex-live.jsx`); ported to Next.js + Supabase + Vercel with WHOOP, Withings, Apple Health, Strong, and Yazio sync.

## Stack

- Next.js 15 (App Router) on Vercel
- Supabase Postgres + Auth + RLS
- WHOOP OAuth 2.0 — recovery / sleep / strain
- Withings OAuth 2.0 — body composition (weight, body fat, lean / muscle / bone) + activity
- Apple Health → iOS Shortcut → `/api/ingest/health` (covers steps/calories that aren't from Withings, plus a bridge for Strong & Yazio via HealthKit)
- Strong → CSV upload at `/profile`, or HealthKit bridge
- Yazio → HealthKit bridge (writes Active Energy + macros)
- Anthropic API (server-side) for coaching insights

## Local development

```bash
cp .env.example .env.local   # then fill in real values
npm install
npm run dev
```

App runs at <http://localhost:3000>.

## Database migrations

Apply in order via Supabase Dashboard → SQL Editor:

1. `supabase/schema.sql`
2. `supabase/migrations/0002_extras.sql`
3. `supabase/migrations/0003_integrations.sql`

## Connecting integrations

All connection management lives at **/profile**.

### WHOOP

1. Click **Connect WHOOP** → authorize on whoop.com → returns to `/profile?whoop=connected`
2. Click **Backfill** to pull up to 2 years of recovery / sleep / cycle history.
3. Click **Sync** for the last 14 days. A Vercel cron also runs nightly using `CRON_SECRET`.

### Withings

1. Register an app at <https://developer.withings.com>. Set the callback URL to `${NEXT_PUBLIC_APP_URL}/api/withings/callback`.
2. Add `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET`, `WITHINGS_REDIRECT_URI` to `.env.local`.
3. On `/profile` click **Connect Withings**. Backfill + Sync work the same as WHOOP.
4. Withings populates `weight_kg`, `body_fat_pct`, `fat_mass_kg`, `fat_free_mass_kg`, `muscle_mass_kg`, `bone_mass_kg`, `hydration_kg`, plus `steps`, `active_calories`, `calories`, `distance_km`, `exercise_min` per day.

### Apple Health (iOS Shortcut)

1. On `/profile` click **Generate ingest token**. Copy the token immediately — it's hashed in DB and won't be shown again.
2. On iPhone, create a Shortcut with the steps:
   - **Get Health Sample** for each metric you want (Steps, Active Energy, Distance Walking + Running, Exercise Minutes, Body Mass, Body Fat Percentage, Sleep Analysis, Dietary Energy / Protein / Carbohydrates / Fat).
   - **Set variables** for each, scoped to "Today" (or yesterday).
   - **Get Contents of URL**:
     - URL: `${NEXT_PUBLIC_APP_URL}/api/ingest/health`
     - Method: `POST`
     - Headers: `Authorization: Bearer <your-token>`, `Content-Type: application/json`
     - Request Body: JSON, e.g.
       ```json
       {
         "days": [
           {
             "date": "2026-04-30",
             "steps": 8421,
             "active_calories": 612,
             "calories": 2480,
             "distance_km": 6.2,
             "exercise_min": 38,
             "calories_eaten": 2310,
             "protein_g": 165,
             "carbs_g": 230,
             "fat_g": 78
           }
         ]
       }
       ```
3. Schedule via **Personal Automation → Time of Day** (e.g. 11:55 PM) so it runs every night.

### Strong

Two options:

- **CSV upload** (one-shot, full history): Strong → Settings → Export Data → Export to CSV → upload at `/profile`. Re-importing overwrites prior workouts via `external_id` (`strong-<date>-<slug>`), so it's idempotent.
- **Live via HealthKit**: Strong writes workouts to Apple Health. Add a Strong block to your iOS Shortcut that posts new workouts to `/api/ingest/health?source=strong` with a `workouts: [{ external_id, date, type, duration_min, notes }]` array. Set tracking only — sets/reps still need CSV import.

### Yazio

Yazio writes calories + macros to Apple Health. Include those metrics in the same iOS Shortcut as Apple Health above (`calories_eaten`, `protein_g`, `carbs_g`, `fat_g`). Use `?source=yazio` when posting if you want the source tag to reflect Yazio.

## Privacy policy

Hosted at `/privacy` on the running app. Static copy in [PRIVACY.md](PRIVACY.md) — used as the WHOOP developer-portal privacy URL until the app is deployed on Vercel.
