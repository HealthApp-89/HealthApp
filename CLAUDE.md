# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About

**Apex Health OS** — a personal health and sport-performance tracker for a single user. Aggregates data from WHOOP (recovery/sleep/strain), Withings (body composition), Apple Health (steps/calories/distance via Garmin), Strong (lifts), and Yazio (nutrition) into a unified daily readiness view, with server-side Anthropic-powered coaching insights. Ported from a localStorage prototype to Next.js + Supabase + Vercel.

## Commands

- `npm run dev` — Next dev server on http://localhost:3000
- `npm run build` — production build (Next 15)
- `npm run start` — serve the production build
- `npm run typecheck` — `tsc --noEmit` (strict)

There is no test suite and no working linter (`npm run lint` invokes `next lint`, which is unconfigured and hangs on first-run interactive setup — treat it as a no-op). Verify changes with `typecheck` and exercise affected pages locally.

Path alias: `@/*` → repo root (see [tsconfig.json](tsconfig.json)). Use it instead of relative climbs.

## Database migrations

Apply in order via Supabase Dashboard → SQL Editor:
1. [supabase/schema.sql](supabase/schema.sql)
2. [supabase/migrations/0002_extras.sql](supabase/migrations/0002_extras.sql)
3. [supabase/migrations/0003_integrations.sql](supabase/migrations/0003_integrations.sql)
4. [supabase/migrations/0004_coach_v2.sql](supabase/migrations/0004_coach_v2.sql)
5. [supabase/migrations/0005_chat.sql](supabase/migrations/0005_chat.sql) — also requires the `chat-images` private Storage bucket created beforehand (Storage RLS policies attach to it)
6. [supabase/migrations/0006_chat_settings.sql](supabase/migrations/0006_chat_settings.sql) — adds `profiles.system_prompt` (user-editable coach prompt; NULL = use code default) and `chat_messages.tool_calls` (jsonb of tool invocations per assistant turn for observability)

`supabase` CLI is now linked (`supabase link --project-ref eopfwwergisvskxqvsqe`); future migrations apply via `supabase db push` after `repair --status applied <history>` if needed.

Row shapes mirrored in [lib/data/types.ts](lib/data/types.ts). Schema is snake_case; keep DB columns and TS types in sync.

## Architecture

**Single-user Next.js 15 (App Router) + Supabase + Vercel.** Originally a localStorage prototype (`_prototype.jsx`, retained for reference only — do not import). Every row is scoped to `auth.users.user_id` and protected by RLS.

### Supabase clients — three flavors, pick the right one

- [lib/supabase/client.ts](lib/supabase/client.ts) — `createSupabaseBrowserClient()` for Client Components.
- [lib/supabase/server.ts](lib/supabase/server.ts) — `createSupabaseServerClient()` for Server Components / Route Handlers (cookie-bound, RLS-respecting).
- Same file — `createSupabaseServiceRoleClient()` bypasses RLS. Only use in: cron endpoints, ingest webhooks, OAuth callbacks, scripts. Never expose to a Client Component.

[middleware.ts](middleware.ts) calls `supabase.auth.getUser()` on every request to refresh the session cookie. Auth gating happens in pages via `redirect("/login")`, not middleware.

### Data sources & precedence (read this before changing any sync code)

Multiple integrations write to the same `daily_logs` columns. Source-of-truth is enforced in code, not DB:

- **WHOOP** ([lib/whoop.ts](lib/whoop.ts)) — owns `hrv`, `resting_hr`, `recovery`, `sleep_*`, `strain`, `spo2`, `skin_temp_c`. Vercel cron `/api/whoop/sync` runs daily at 08:00 UTC ([vercel.json](vercel.json)) authenticated via `CRON_SECRET`.
- **Withings** ([lib/withings.ts](lib/withings.ts), merge logic in [lib/withings-merge.ts](lib/withings-merge.ts)) — owns body comp (`weight_kg`, `body_fat_pct`, `fat_mass_kg`, `fat_free_mass_kg`, `muscle_mass_kg`, `bone_mass_kg`, `hydration_kg`) + `exercise_min`. **MUST NOT overwrite** `steps`, `calories`, `active_calories`, `distance_km` — those are Apple Health's (Garmin-sourced, more accurate). The merge function comments this constraint; preserve it.
- **Apple Health / Yazio / Strong** → single ingest webhook [app/api/ingest/health/route.ts](app/api/ingest/health/route.ts) with `?source=apple_health|yazio|strong`. Auth is per-user bearer tokens generated from `/profile` (hashed in DB, shown once). Strong CSV has its own endpoint [app/api/ingest/strong/route.ts](app/api/ingest/strong/route.ts), idempotent on `(user_id, external_id)`; CSV upload evicts the matching `strong-hk-<date>` HealthKit summary stub.

When adding a new metric, decide the owner first, then ensure no other sync path writes that column.

### Routes

App Router pages under [app/](app/): `/` (dashboard), `/log`, `/strength`, `/trends`, `/coach`, `/profile`, `/login`, `/privacy`. Server-side data fetching with `Promise.all` and `Suspense` for streaming heavier queries (see [app/page.tsx](app/page.tsx) for the pattern — fast queries gate first paint, weekly rollups stream).

API routes under [app/api/](app/api/): `whoop/{auth,callback,sync,backfill}`, `withings/{auth,callback,sync,backfill,disconnect}`, `ingest/{health,strong,token}`, `insights`, `recommendations`, `auth/signout`. Sync routes call `revalidatePath()` so 60s ISR on `/` invalidates immediately.

### Coach / AI

- [lib/anthropic/client.ts](lib/anthropic/client.ts) — server-side Anthropic SDK. The key is `ANTHROPIC_API_KEY` (never `NEXT_PUBLIC_*`); the prototype exposed it to the browser, the port intentionally moves it server-side.
- [lib/coach/](lib/coach/) — `readiness.ts` (daily plan), `impact.ts` (per-metric +/− contributions to readiness), `week.ts`, `sessionPlans.ts`, `prompts.ts`. Pure functions; UI consumes the outputs.

### UI conventions

- Tailwind v4 (PostCSS plugin), no `tailwind.config` file. Self-hosted DM Sans / DM Mono via `next/font`.
- Dark theme, `min-h-[100dvh]`, safe-area insets in [app/layout.tsx](app/layout.tsx) — PWA-installable, runs full-bleed under iOS notch.
- **Number display: max 2 decimals, trailing zeros trimmed.** Always use `fmtNum()` from [lib/ui/score.ts](lib/ui/score.ts), never raw `.toFixed()` or `String(n)` for user-visible numbers.
- Shared color/field config in [lib/ui/colors.ts](lib/ui/colors.ts); readiness math in `calcScore()` ([lib/ui/score.ts](lib/ui/score.ts)).

## Environment

Copy [.env.example](.env.example) → `.env.local`. Required for any backend work: Supabase URL + anon key + service role; for OAuth: WHOOP/Withings client id/secret/redirect; for coach: `ANTHROPIC_API_KEY`; for cron: `CRON_SECRET`; `NEXT_PUBLIC_APP_URL` controls callback URLs.

## Scripts

- [scripts/backfill-whoop.mjs](scripts/backfill-whoop.mjs) — pull full WHOOP history into `daily_logs` (manual fields preserved). Uses service role; needs the env vars above.
- [scripts/import-seed.mjs](scripts/import-seed.mjs) — seed from `seed-data.json`.
