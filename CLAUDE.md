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
7. [supabase/migrations/0007_morning_intake.sql](supabase/migrations/0007_morning_intake.sql) — adds structured morning-feel slots (`sick`, `sickness_notes`, `fatigue`, `bloating`, `soreness_areas`, `soreness_severity`), per-day state machine on `checkins.intake_state`, and `chat_messages.kind` + `ui` for the morning intake bot

7. [supabase/migrations/0008_weekly_planning.sql](supabase/migrations/0008_weekly_planning.sql) — adds `training_blocks` (5-week mesocycle goals), `training_weeks` (committed Sunday plans), and `chat_messages.mode` (`default`|`plan_week`|`setup_block`) for the weekly planning ritual

8. [supabase/migrations/0009_body_measurements.sql](supabase/migrations/0009_body_measurements.sql) — adds `body_measurements` (monthly circumference rows, 14 numeric fields + `photo_path` + `notes`, unique on `(user_id, measured_on)`); also requires the `health-photos` private Storage bucket created beforehand (Storage RLS policies attach to it)

9. [supabase/migrations/0010_athlete_profile.sql](supabase/migrations/0010_athlete_profile.sql) — adds `athlete_profile_documents` (versioned, user-acknowledged athlete profile capturing medical/training/lifestyle/nutrition/sleep baselines + goal-with-why) for the Phase 1 onboarding wizard. `plan_payload` and `rendered_md` columns are nullable in Phase 1; Phase 2 populates them when AI plan generation lands.

10. [supabase/migrations/0011_morning_brief.sql](supabase/migrations/0011_morning_brief.sql) — extends morning-intake state machine with `assembling_brief` / `brief_delivered` / `brief_failed`; adds `'morning_brief'` to `chat_messages.kind` for the post-intake daily plan card.

11. [supabase/migrations/0012_schedule_flexibility.sql](supabase/migrations/0012_schedule_flexibility.sql) — adds nullable `training_weeks.original_session_plan jsonb` for mid-week swap audit; populated on first edit via `coalesce(original_session_plan, session_plan)`; reset to NULL on identity-restore. Adherence reads `coalesce(...)` so the Sunday recap stays anchored to the Sunday commitment.

12. [supabase/migrations/0013_lab_acknowledgments.sql](supabase/migrations/0013_lab_acknowledgments.sql) — adds `profiles.lab_acknowledgments jsonb NOT NULL DEFAULT '{}'` storing acknowledgment timestamps for the GLP-1 lab-prompt card slots (B12, vit D, magnesium, ferritin, grip strength, bone density). Free-form jsonb so Phase 3 can add new check slots without schema changes.

13. [supabase/migrations/0014_weekly_reviews.sql](supabase/migrations/0014_weekly_reviews.sql) — adds `weekly_reviews` (versioned Sunday recap-and-prescribe document keyed `(user_id, week_start, version)` with `status`/`payload`/`narrative_md`/`reconfirm_responses`/`committed_training_week_id`); extends `chat_messages.kind` union to include `'weekly_review'` for the chat card delivery.

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
- **Body measurements** ([components/health/MeasurementForm.tsx](components/health/MeasurementForm.tsx), API at [app/api/health/measurements/route.ts](app/api/health/measurements/route.ts)) — owns the 14 circumference fields on the `body_measurements` table. Distinct from Withings body composition (which writes to `daily_logs`); circumferences live in their own table because cadence is monthly and rows own a photo. Photos sit in the `health-photos` private Storage bucket under `${user_id}/measurements/...`.

When adding a new metric, decide the owner first, then ensure no other sync path writes that column.

### Routes

App Router pages under [app/](app/): `/` (dashboard), `/log`, `/strength`, `/trends`, `/coach`, `/profile`, `/login`, `/privacy`. Server-side data fetching with `Promise.all` and `Suspense` for streaming heavier queries (see [app/page.tsx](app/page.tsx) for the pattern — fast queries gate first paint, weekly rollups stream).

API routes under [app/api/](app/api/): `whoop/{auth,callback,sync,backfill}`, `withings/{auth,callback,sync,backfill,disconnect}`, `ingest/{health,strong,token}`, `insights`, `recommendations`, `auth/signout`. Sync routes call `revalidatePath()` so 60s ISR on `/` invalidates immediately.

### Client cache (TanStack Query) — read this before adding interactive queries

Every page that fetches per-user data follows the **hybrid SSR-hydrate** pattern:

1. **Server Component** (`app/<route>/page.tsx`) — gates auth, mints a per-request `makeServerQueryClient()` from [lib/query/queryClient.ts](lib/query/queryClient.ts), prefetches initial data using a `Server` fetcher from [lib/query/fetchers/](lib/query/fetchers/), wraps children in `<HydrationBoundary state={dehydrate(queryClient)}>`.
2. **Client Component** (`components/<route>/<Page>Client.tsx`) — reads via hooks from [lib/query/hooks/](lib/query/hooks/) like `useDailyLogs(userId, from, to)`. Hooks call the matching `Browser` fetcher which goes directly to Supabase via [lib/supabase/client.ts](lib/supabase/client.ts). RLS enforces per-user scoping.

**Rules:**
- Every fetcher comes in two variants (server + browser) sharing the same select string and return shape — see [lib/query/fetchers/dailyLogs.ts](lib/query/fetchers/dailyLogs.ts) as the canonical example.
- Both fetcher variants must throw on Supabase errors (`if (error) throw error`) so TanStack Query lights up `isError`.
- Query keys come from [lib/query/keys.ts](lib/query/keys.ts) — never inline.
- Mutations (writes / Anthropic calls / cron-triggered work) stay on existing route handlers under [app/api/](app/api/). Only reads use the client cache.
- After a mutation, invalidate by key prefix: `queryClient.invalidateQueries({ queryKey: queryKeys.dailyLogs.all(userId) })`.
- Pages that prefetch a wide window for client-side filtering (like `/trends`) must compute the prefetch bounds as the union of all interactive ranges — see `app/trends/page.tsx` for the `min(ly.from, ytd.from) → today` pattern.
- See [docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md](docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md) for the full rationale.

### Coach / AI

- [lib/anthropic/client.ts](lib/anthropic/client.ts) — server-side Anthropic SDK. The key is `ANTHROPIC_API_KEY` (never `NEXT_PUBLIC_*`); the prototype exposed it to the browser, the port intentionally moves it server-side.
- [lib/coach/](lib/coach/) — `readiness.ts` (daily plan), `impact.ts` (per-metric +/− contributions to readiness), `week.ts`, `sessionPlans.ts`, `prompts.ts`. Pure functions; UI consumes the outputs.
- **Weekly planning v1**: `training_blocks` (5-week mesocycles) + `training_weeks` (committed Sunday plans) drive the strength tab via [lib/coach/planning-prompts.ts](lib/coach/planning-prompts.ts) and the chat `mode` discriminator (`default|plan_week|setup_block`). Conversation produces structured plans via propose_*/commit_* tools gated by HMAC approval tokens (`COACH_TOOL_SECRET` env). Body-comp-aware progress metrics (strength-per-LBM, allometric, IPF GL) computed on demand in [lib/coach/progress-metrics.ts](lib/coach/progress-metrics.ts) — no `progress_metrics` table in v1.
- **Athlete profile (Phase 1)**: `athlete_profile_documents` is the durable client file — medical history, equipment, lifestyle, goal narrative, nutrition + sleep baselines, all captured via the 6-step `/onboarding` wizard. Acknowledged versions are immutable; revisions create v2/v3/etc. with the prior version superseded. The active version's summary is injected into the coach AI's snapshot prefix via `renderProfileSummary` in [lib/coach/profile-renderer.ts](lib/coach/profile-renderer.ts).
- **Athlete profile Phase 2 (AI plan generation)** lives in [lib/coach/plan-builder/](lib/coach/plan-builder/). A 5-beat chat intake (`mode='intake'` on `chat_messages`; URL `/coach?mode=intake&doc=<id>`) deepens Phase 1's form-captured intake via deterministic sanity checks and conversational elicitation. [lib/coach/plan-builder/sanity-check.ts](lib/coach/plan-builder/sanity-check.ts) runs four checks (goal contradiction, sleep efficiency, macros gap, protein floor at 1.6 g/kg BW) before narrative deepening — Beat 1 surfaces findings with chip-driven Accept/Override flow. Seven pure composers (snapshot, goal, periodization, strength template, nutrition, sleep, recovery, coaching agreement) produce the typed `plan_payload jsonb`; [lib/coach/plan-builder/narrative-prompt.ts](lib/coach/plan-builder/narrative-prompt.ts) is the single Sonnet 4.6 call that wraps the prescriptions in coach voice. The plan-builder is deterministic — the AI never fabricates prescriptions, only narrates them. HMAC `propose_plan` / `commit_plan` tools mirror weekly-planning v1's approval flow (`COACH_TOOL_SECRET`). [lib/morning/brief/get-today-targets.ts](lib/morning/brief/get-today-targets.ts) prefers `plan_payload.nutrition` + `plan_payload.sleep` when an active plan exists; falls back to `intake_payload` for Phase 1 users (transparent to brief consumers via `source: 'plan' | 'intake'` discriminator). CTA on `/profile` ("Generate plan") creates the draft via the [app/onboarding/start-plan-intake.ts](app/onboarding/start-plan-intake.ts) server action.
- **Morning brief (post-intake daily card)**: at the end of the morning intake state machine, a single structured chat card (`chat_messages.kind = 'morning_brief'`, structured `ui` jsonb of shape `MorningBriefCard`) is written by [app/api/chat/morning/recommendation/route.ts](app/api/chat/morning/recommendation/route.ts). The card has 5-7 blocks: yesterday recap, today's readiness band, today's session details (training variant) or recovery focus (rest variant), macros target, AI-generated coach advice, tonight's sleep target. The Advice block is the only AI-generated content — single Anthropic Haiku 4.5 call via [lib/morning/brief/index.ts](lib/morning/brief/index.ts). Pre-computed flags in [lib/morning/brief/flags.ts](lib/morning/brief/flags.ts) carry adaptive coaching context (GLP-1, alcohol, injuries, sleep efficiency, missed protein) into the prompt. State machine extends 0007 with `assembling_brief` → `brief_delivered` (or `brief_failed` on retry). Idempotent: one brief per user per day; retry via [app/api/chat/morning/retry-brief/route.ts](app/api/chat/morning/retry-brief/route.ts) when `intake_state = 'brief_failed'`. Targets sourced via the [lib/morning/brief/get-today-targets.ts](lib/morning/brief/get-today-targets.ts) abstraction — Phase 2 swap to `plan_payload` is transparent to consumers.
- **GLP-1-aware nutrition** (dual-mode nutrition module) lives across [lib/coach/plan-builder/compose-nutrition.ts](lib/coach/plan-builder/compose-nutrition.ts) (branches on `intake.health.glp1_status`), [lib/morning/brief/get-today-targets.ts](lib/morning/brief/get-today-targets.ts) (`resolveMode` returns `glp1_active | glp1_tapering | classical | steady_state`), and 3 new tools in [lib/coach/tools.ts](lib/coach/tools.ts) (`set_glp1_status` during intake; `set_glp1_taper_started` and `mark_glp1_discontinued` for in-place active-plan milestones). GLP-1 mode raises protein floor to 1.8 g/kg BW (2.0 for tirzepatide) with FFM cross-check, drops scheduled diet breaks (research-driven; refeeds fight the medication's appetite suppression — see [docs/superpowers/specs/2026-05-12-glp1-aware-nutrition-design.md](docs/superpowers/specs/2026-05-12-glp1-aware-nutrition-design.md) for the literature synthesis), adds a deficit-magnitude alarm (>25% of TDEE or >700 kcal/day) and training-day hydration prompts (3.5L water + 1g sodium). Post-discontinuation, the composer produces a classical phase-of-phases plan (8-week cut blocks separated by 2-week diet breaks, 4-week reverse, then maintain) — the playbook the bodybuilding RDs designed for non-pharmacological cuts. `/profile` surfaces a lab-prompt card ([components/profile/LabPromptCard.tsx](components/profile/LabPromptCard.tsx)) when active plan is GLP-1-mode, listing checks the doctor likely isn't running (B12, vit D, Mg, ferritin baseline + 6mo; grip strength quarterly; bone density at 12mo+). [INTAKE_PROMPT Beat 3](lib/coach/planning-prompts.ts) detects GLP-1 mentions in `intake.health.medications` and triggers a 3-question follow-up; the composer reads the captured status. Mode transitions (`set_glp1_taper_started`, `mark_glp1_discontinued`) mutate the active plan in place — milestones, not new versions. Phase 1 immutability invariant applies to acknowledged intake + plan, not these milestone fields.
- **Schedule flexibility**: mid-week training plan swaps via `POST /api/training-weeks/[week_start]/swap` ([app/api/training-weeks/[week_start]/swap/route.ts](app/api/training-weeks/[week_start]/swap/route.ts)). Two primitives: A↔B exchange (`action: 'swap'`) and single-day replacement (`action: 'replace'`). Two UI surfaces sharing one endpoint: strength tab inline edit via [components/strength/DaySwapSheet.tsx](components/strength/DaySwapSheet.tsx) (preview-then-confirm with soft "identical type within 48h" warning) and morning-brief chip via [components/morning/BriefCoachSuggestion.tsx](components/morning/BriefCoachSuggestion.tsx) (deterministic trigger when band='low' AND session not REST/Mobility AND a training_weeks row exists; `?confirm=true` unconditional). Migration 0012 adds nullable `original_session_plan jsonb` populated COALESCE-style on first edit; identity-restore (A→B→A) resets it to NULL. Adherence reads `coalesce(original_session_plan, session_plan)` and grows a per-day `status` field (`as_planned | swapped | missed | rest`) so `compute_adherence` produces prose distinguishing swapped from missed. Brief's `ui` jsonb is never rewritten on swap — the chip's "acknowledged" state and the session list's strikethrough are derived client-side from `useTrainingWeek` vs `brief.session.type`.
- **Weekly Review Document**: Sunday recap-and-prescribe document writes a versioned `weekly_reviews` row per `(user_id, week_start)` via the `/api/coach/weekly-review/sync` cron (CRON_SECRET-gated, idempotent — repeat calls return the existing row; explicit regenerate increments `version` and supersedes the prior draft). Six deterministic composers under [lib/coach/weekly-review/](lib/coach/weekly-review/) (recap, reconfirm, trends, prescription, targets, volume) assemble the typed `payload jsonb` from `training_weeks` + `workouts` + `daily_logs` + `body_measurements`; a single Anthropic Sonnet narrative call wraps the prescriptions in coach voice into `narrative_md`. Commit writes a `training_weeks` row for `next_week_start` and stamps `committed_training_week_id` — mirrors weekly-planning v1's HMAC propose/commit pattern (`COACH_TOOL_SECRET`). Three surfaces share one data shape: chat card (`chat_messages.kind='weekly_review'`) on Sunday, full review page at [/coach/weeks/[week_start]](app/coach/weeks/[week_start]/page.tsx), and the Tue-Sat mid-week discoverability banner ([components/coach/WeekReviewBanner.tsx](components/coach/WeekReviewBanner.tsx)) on `/coach` that surfaces draft+unanswered or committed+unanswered states. Spec: [docs/superpowers/specs/2026-05-15-weekly-review-document-design.md](docs/superpowers/specs/2026-05-15-weekly-review-document-design.md); execution plan: [docs/superpowers/plans/2026-05-15-weekly-review-document.md](docs/superpowers/plans/2026-05-15-weekly-review-document.md).
- **Trend Layer**: [/coach/trends](app/coach/trends/page.tsx) is the deep coaching-analysis surface — distinct from `/trends` (raw metric exploration). Three sections (Performance / Composition / Cross) rendered from a pure compute module at [lib/coach/trends/](lib/coach/trends/). Five composers (strength / body / nutrition / recovery / cross) consume `daily_logs`, `workouts`, `training_weeks`, `training_blocks`, `profiles.whoop_baselines`, and `athlete_profile_documents` (for nutrition targets via `getTodayTargets`). Per-lift e1RM slopes use OLS via [lib/coach/trends/linear-regression.ts](lib/coach/trends/linear-regression.ts); cross-metric insight prose is deterministic templating, no AI calls. Orchestrator at [lib/coach/trends/index.ts](lib/coach/trends/index.ts) parallel-fetches and picks a headline (plateau → off-pace weight → HRV-below-baseline → ok). Page is SSR-hydrated (`fetchCoachTrendsBrowser` throws by design); section state in URL `?section=performance|composition|cross`. Per-lift slope, plateau spans, and cross insights also feed the weekly review's §4 via three optional fields on `WeeklyReviewPayload.trends` ([lib/coach/weekly-review/compose-trends.ts](lib/coach/weekly-review/compose-trends.ts) calls `composeStrength` + `composeCross`); §4 cells deep-link to the relevant section. Audit script: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-coach-trends.mjs`. Spec: [docs/superpowers/specs/2026-05-16-trend-layer-design.md](docs/superpowers/specs/2026-05-16-trend-layer-design.md).

### UI conventions

- Tailwind v4 (PostCSS plugin), no `tailwind.config` file. Self-hosted DM Sans / DM Mono via `next/font`.
- Dark theme, `min-h-[100dvh]`, safe-area insets in [app/layout.tsx](app/layout.tsx) — PWA-installable, runs full-bleed under iOS notch.
- **Number display: max 2 decimals, trailing zeros trimmed.** Always use `fmtNum()` from [lib/ui/score.ts](lib/ui/score.ts), never raw `.toFixed()` or `String(n)` for user-visible numbers.
- Shared color/field config in [lib/ui/colors.ts](lib/ui/colors.ts); readiness math in `calcScore()` ([lib/ui/score.ts](lib/ui/score.ts)).

## Environment

Copy [.env.example](.env.example) → `.env.local`. Required for any backend work: Supabase URL + anon key + service role; for OAuth: WHOOP/Withings client id/secret/redirect; for coach: `ANTHROPIC_API_KEY`; for cron: `CRON_SECRET`; `NEXT_PUBLIC_APP_URL` controls callback URLs.

Coach planning tools require `COACH_TOOL_SECRET` (32+ char random; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). The same value must be set in Vercel env (Production + Preview).

## Scripts

- [scripts/rekey-whoop.mts](scripts/rekey-whoop.mts) — re-fetch WHOOP records and re-key `daily_logs` rows via the canonical `buildWhoopDayRows` builder. Use for full-history backfill (`--since 2024-01-01 --yes`) or a focused window (default last 30 days). Prints a date-level diff and prompts before clearing. Uses service role; same env vars as the sync route. Run via the alias-loader: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts [--since YYYY-MM-DD] [--yes]`.
- [scripts/audit-strain-2026.mjs](scripts/audit-strain-2026.mjs) — read-only audit of `daily_logs.strain` for 2026-04 → 2026-05 against the WHOOP-app's "Day Strain" view. Kept as the regression check for the day-keying fix (PR #50); template for future column audits when WHOOP-app screenshots are available.
- [scripts/import-seed.mjs](scripts/import-seed.mjs) — seed from `seed-data.json`.
