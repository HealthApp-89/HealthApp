# Peter Dashboard — Design

**Date:** 2026-05-24
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Builds on the "coach-as-real-coach" arc. The four shipped sub-projects (Weekly Review #1, Daily Coach Loop #2, Coach Tab UX shell #3, Proactive reach-out #4, Trend Layer #5) gave each specialist a deep surface. This spec adds the head-coach surface: a synthesis layer above the specialists, both visualized as a dashboard and injected into Peter's chat prompt.

## Problem

Peter is the Head Coach in the multi-coach team ([lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts)). His mandate is cross-domain synthesis — when Carter sees a bench plateau, Nora sees rest-day under-eating, and Remi sees HRV depression, Peter is the one who says "these are the same problem." Today he can't.

Three concrete gaps:

1. **No dedicated surface.** Carter owns `/strength`, Nora owns `/meal`, Remi owns `/health?tab=trends` with 17 cards (shipped 2026-05-23). Peter shows up only inside chat at `/health?tab=coach`, plus he narrates the morning brief, weekly review, and plan-builder. There is no place to glance at "what does the head coach see today."
2. **Thin intelligence in his prompt.** [lib/coach/peter-context.ts](../../../lib/coach/peter-context.ts) injects the last 5 specialist chat messages into his system prompt. That is conversational continuity, not data synthesis. He has no structured cross-domain context to ground on when a user asks a multi-domain question Tue–Sat.
3. **Rich synthesis exists but is disconnected.** [lib/coach/trends/index.ts](../../../lib/coach/trends/index.ts) has `generateCoachTrends()` with composers for strength / body / nutrition / recovery / food_quality / cross_insights and a `pickHeadline()` synthesis. It feeds only the Sunday weekly review. The morning brief covers today. **Tuesday–Saturday, the cross-domain story has no surface.**

A real head coach reviewing an athlete on a Wednesday does this:

- Glances at 4–6 cross-domain "themes" (energy availability, fatigue debt, recomp trajectory, performance, plan adherence, goal distance) and reads each at a severity.
- Names cluster relationships: "your bench plateau, body-fat drift, and HRV depression are likely one problem."
- Picks the most pressing theme and gives a one-line read.
- Drills into specialists only when a theme demands it.

This spec covers the Peter Dashboard: a new top-level `/coach` route with a 6-theme synthesis dashboard, a cached payload that doubles as Peter's prompt-injection context, and small prompt updates teaching Peter to use it.

## Goals

1. **Top-level `/coach` route with two sub-tabs.** `Dashboard` (default) and `Chat`. The existing chat surface at `/health?tab=coach` relocates here. `/health` loses its Coach tab and becomes `Trends | Log`.
2. **Six cross-domain theme cards on the dashboard.** Recomp trajectory / Energy availability / Fatigue debt / Performance trajectory / Plan adherence / Goal distance. Layout is a hero headline + 2×3 grid; cards expand inline (accordion) revealing prose + a mini sparkline + two navigation chips.
3. **Same payload feeds dashboard and Peter's prompt.** What the athlete sees is exactly what Peter reads. Tight coupling.
4. **Deterministic composers + one Sonnet narrative call per regen.** Six composers produce typed facts; one wrapping call renders hero + per-card narrative in Peter's voice. Same pattern as morning brief and weekly review.
5. **Versioned, time-keyed cache.** New `coach_dashboards` table keyed `(user_id, generated_on, version)`. Daily cron at 04:00 UTC writes v1; manual regen bumps version. Schema supports time-travel; v1 UI shows latest only.
6. **Read-only + navigation chips.** Expanded cards offer `Ask Peter →` and `Open <specialist surface> →`. No HMAC write chips in v1.
7. **Graceful goal-distance degradation.** Goal distance requires structured goal fields on `athlete_profile_documents`. New migration adds them; until populated, the card shows "Set a structured goal to enable projections."
8. **Zero new tools for Peter.** Existing query_daily_logs / query_workouts / query_food_log cover any verification. The injected "Today's read" block is sufficient.

## Non-Goals

- **HMAC Approve chips on cards.** Read-only + nav only for v1.
- **History UI / time-travel `/coach?date=...`.** Schema versioned; UI is latest-only.
- **`query_coach_dashboard_history` tool for Peter.** Trivial to add later; not in v1.
- **Push notifications on severity flips.** Top-nav dot indicator carries v1.
- **Per-theme dedicated routes (`/coach/themes/energy`).** Inline accordion expansion carries v1.
- **ML-driven cross-correlation discovery.** v1 detects clusters via deterministic pairwise rules only.
- **Replacing `peter-context.ts` (last 5 specialist messages).** Both stay; specialist activity is conversational continuity, the dashboard is analytical synthesis.
- **Block-level "this block so far" dashboard variant.** v2.

## Architecture

```
                ┌──────────────────────────────────┐
                │ Daily cron 04:00 UTC             │
                │ /api/coach/dashboard/sync        │
                │                                  │
                │ Manual regen                     │
                │ /api/coach/dashboard/regenerate  │
                └─────────────────┬────────────────┘
                                  │
                                  ▼
                ┌──────────────────────────────────┐
                │ generatePeterDashboard()         │
                │ lib/coach/peter-dashboard/index  │
                │                                  │
                │  Parallel composers:             │
                │   ├─ compose-recomp              │
                │   ├─ compose-energy              │
                │   ├─ compose-fatigue             │
                │   ├─ compose-performance         │
                │   ├─ compose-plan-adherence      │
                │   └─ compose-goal-distance       │
                │                                  │
                │  linkThemes() → clusters         │
                │                                  │
                │  Single Sonnet 4.6 narrative     │
                │  wrap (hero + per-card prose)    │
                │                                  │
                │  fabricationCheck() validates    │
                └─────────────────┬────────────────┘
                                  │
                                  ▼
                ┌──────────────────────────────────┐
                │ coach_dashboards table           │
                │ (user_id, generated_on, version) │
                │ payload jsonb + narrative_md     │
                └──────┬──────────────────┬────────┘
                       │                  │
                       ▼                  ▼
            ┌──────────────────┐  ┌──────────────────┐
            │ /coach Dashboard │  │ Peter's system   │
            │ tab — UI cards   │  │ prompt injection │
            └──────────────────┘  └──────────────────┘
```

Composers are **synthesis** on top of existing intelligence. They reuse `generateCoachTrends`, recovery-intelligence, nutrition-intelligence, weekly-review composers. They do not re-query primary tables when an existing composer already returns what's needed — they cross-correlate.

## Schema

### Migration `0034_peter_dashboard.sql`

(Spec originally proposed `0031`; slots 0031–0033 were taken by parallel arcs before this work landed, so the actual numbers used at apply-time are **0034** and **0035**. The references below keep the spec's original naming for design clarity — see `docs/superpowers/plans/2026-05-24-peter-dashboard.md` for the actual filenames.)

**Failure-row semantics (important for Task 12 / Task 11 implementers):** a row with `status = 'failed'` is NOT a tombstone. `payload` still carries the full deterministic composer output (six themes' facts, clusters, block context, goal summary) and `narrative_md` still carries a rendered block — built from the deterministic `body_md` fallback via `fallbackNarrative()` in [lib/coach/peter-dashboard/narrate.ts](../../lib/coach/peter-dashboard/narrate.ts). The status discriminator only tells the UI / prompt assembly that the Sonnet wrap failed so the "Narrative generation failed — retry" affordance can show. Writers MUST NOT insert `payload = '{}'::jsonb` or empty `narrative_md` — the orchestrator's fallback path guarantees both fields are populated.

```sql
create table coach_dashboards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  generated_on  date not null,
  version       int  not null default 1,
  status        text not null default 'ready'
                check (status in ('ready', 'failed')),
  payload       jsonb not null,
  narrative_md  text  not null,
  generated_at  timestamptz not null default now(),
  unique (user_id, generated_on, version)
);

create index coach_dashboards_user_recent_idx
  on coach_dashboards (user_id, generated_on desc, version desc);

alter table coach_dashboards enable row level security;

create policy coach_dashboards_select_own
  on coach_dashboards for select
  using (auth.uid() = user_id);
-- Writes via service-role only (cron + regenerate endpoint).
```

### Migration `0032_athlete_goal_structured.sql`

```sql
alter table athlete_profile_documents
  add column goal_kind        text
    check (goal_kind in ('lift_e1rm', 'bodyweight_kg', 'bodyfat_pct')),
  add column goal_metric      text,
  add column goal_target      numeric,
  add column goal_target_date date;
```

- `goal_metric` is the lift name when `goal_kind = 'lift_e1rm'` (e.g. `'bench'`, `'deadlift'`, `'squat'`, `'ohp'`); null otherwise.
- Existing free-form goal narrative stays in its current field as the "why".
- Backfill: Phase 1 wizard prompts on next `/profile` visit if `goal_kind IS NULL`; until populated, Goal-distance card degrades.

## Composers

All composers live under `lib/coach/peter-dashboard/`. Each is a pure function returning a typed `ThemePayload`:

```ts
type ThemeKey = 'recomp' | 'energy' | 'fatigue' | 'performance'
              | 'plan_adherence' | 'goal_distance';

type Severity = 'ok' | 'warn' | 'urgent';

type ThemePayload = {
  key: ThemeKey;
  severity: Severity;
  one_line: string;          // grid-state summary, e.g. "BF +0.4/wk, LBM flat"
  body_md: string;           // deterministic prose for fallback
  facts: Record<string, number | string | null>;
  drilldown: string;         // route, e.g. "/metrics?sub=body"
  sparkline: {
    label: string;
    series: Array<{ x: string; y: number; ref?: number }>;
  } | null;
  inputs_used: string[];     // audit: which tables/cols read
};
```

### compose-recomp

- Reads: `body.lbm.delta_4w_kg`, `body.body_fat_pct.delta_4w_pct`, `body.weight.rate_kg_per_wk_4w` (from existing `composeBody`); top-3 lift e1RM 4w slope (from existing `composeStrength`); 4w protein adherence % (from existing `getTodayTargets` + `query_food_log` aggregation).
- Severity:
  - `ok` if LBM holding (≥ −0.2 kg/4w) AND BF % down ≥ 0.3pts/4w AND top-3 lifts holding (no slope ≤ −2.5%/4w).
  - `warn` on BF drift up OR LBM down 0.2–0.5 kg/4w.
  - `urgent` if LBM down >0.5 kg/4w AND a top-3 lift slope ≤ −5%/4w.
- Sparkline: weekly BF % over 12w.

### compose-energy

- Reads: `query_food_log` aggregated by date, split by training-day vs rest-day (cross-join with `workouts` for the same date); `getTodayTargets` for the kcal target; weekly strain rolling avg.
- Severity:
  - `warn` if under target ≥ 150 kcal/d × 7+ days.
  - `urgent` if GLP-1 mode active AND deficit > 25% TDEE (reuses existing GLP-1 alarm thresholds from [lib/coach/plan-builder/compose-nutrition.ts](../../../lib/coach/plan-builder/compose-nutrition.ts)).
- Cross-tags: which Nora `proactive_nudge` triggers fired in last 14d (`training_day_undereat`, `protein_under`).
- Sparkline: 14d kcal vs target line.

### compose-fatigue

- Reads: HRV 14d slope vs personal baseline; RHR 14d drift; sleep score 7d avg + sleep debt cumulative; strain pile-up 4d rolling; subjective soreness from `checkins`. All via existing recovery-intelligence composers.
- Severity:
  - `warn` if 1–2 Remi triggers fired in 14d OR HRV 5% below baseline 7d sustained.
  - `urgent` if ≥3 Remi triggers fired in 14d OR `hrv_chronic_depression` trigger.
- Cross-tags: list of fired Remi trigger keys + dates.
- Sparkline: HRV vs personal baseline, 28d.

### compose-performance

- Reads: per-lift e1RM 4w OLS slope (existing `composeStrength` + `linear-regression`); active plateau spans; weekly volume per muscle group vs prior-block avg.
- Severity:
  - `warn` on any single lift plateau ≥ 3wk.
  - `urgent` if ≥2 big-four lifts simultaneously plateaued OR top lift slope ≤ −5%/4w.
- Cross-tags: Carter `plateau:*` trigger keys.
- Sparkline: top-plateaued lift's e1RM, 12w.

### compose-plan-adherence

- Reads: sessions completed vs prescribed (last 4 training_weeks via existing `compute_adherence`); food log coverage % (days with committed entries / total days, 14d); mobility marks (`mark_mobility_done` events); bedtime SD over 14d.
- Severity:
  - `warn` if adherence <70% across two consecutive weeks.
  - `urgent` if <50% across two consecutive weeks.
- Cross-tags: list of swap events fired in 14d.
- Sparkline: weekly adherence % over 8w.

### compose-goal-distance

- Reads: `athlete_profile_documents.goal_*` structured fields; current trajectory of the relevant metric (e1RM for `lift_e1rm`, weight rate for `bodyweight_kg`, BF% trend for `bodyfat_pct`); days remaining to `goal_target_date`.
- Computes `pace_ratio = (current_progress_so_far / required_progress_so_far)`.
- Severity:
  - `ok` if `pace_ratio ≥ 0.9`.
  - `warn` if `0.7 ≤ pace_ratio < 0.9`.
  - `urgent` if `pace_ratio < 0.7` OR projected ETA misses `goal_target_date` by >14d.
- Degraded card when `goal_kind IS NULL`: severity `ok`, one_line "Set a structured goal", body_md links to `/profile`.
- Sparkline: target metric trajectory vs ideal-pace line.

### linkThemes() — cluster detection

After composers run, the orchestrator runs a deterministic pairwise rules pass:

```ts
type ThemeCluster = {
  id: string;                   // 'energy-fatigue-perf', etc.
  themes: ThemeKey[];
  root_hypothesis: string;      // template-filled string
};
```

Rules (applied in order; first match wins per pair):

1. `energy.severity in [warn, urgent]` + `fatigue.severity in [warn, urgent]` + `performance` has plateau → cluster `energy-fatigue-perf`, root: "deficit too aggressive given training load".
2. `recomp` BF drift + `energy` under-target → cluster `recomp-energy`, root: "rest-day deficit drift".
3. `fatigue` urgent + `plan_adherence` warn → cluster `fatigue-adherence`, root: "missing sessions when fatigued — symptom or cause unclear".
4. `performance` plateau + `goal_distance` warn — root: "off pace because lifts have stalled".

Clusters are passed to the narrative wrapper; non-matching themes render independently.

## Narrative wrapping

One Sonnet 4.6 call per regen (cron daily + manual).

**Input:** `PeterDashboardFacts` JSON containing the 6 `ThemePayload` outputs + cluster array + active block context (block N, week M of 5) + athlete-profile goal summary.

**System prompt** ([lib/coach/peter-dashboard/narrative-prompt.ts](../../../lib/coach/peter-dashboard/narrative-prompt.ts)): reuses PETER_BASE voice rules verbatim (concrete numbers, dates, no approximations), adds dashboard-specific output spec.

**Output schema** (validated; on schema fail, retry once then fall back):

```ts
type Narrative = {
  hero: {
    headline: string;     // 1 sentence, ≤ 20 words
    body_md: string;      // 2-3 sentences, ≤ 60 words; calls out clusters when present
  };
  cards: Record<ThemeKey, {
    narrative_md: string; // 1-3 sentences, ≤ 50 words per card; cites theme facts
  }>;
};
```

**Constraints enforced by `fabricationCheck()`:**

- Every numeric token in `narrative_md` (hero + cards) must appear in `facts` or `clusters`. Rejection retries once with the offending text quoted.
- When `clusters.length > 0`, at least one cluster relationship must be named in `hero.body_md` OR in the narrative_md of every clustered card.

**On final failure** (after one retry): `status = 'failed'`, narrative falls back to `pickHeadline()` (existing) for hero + each card's deterministic `body_md`. Dashboard still renders; Peter's prompt receives the deterministic narrative. UI shows a small "Narrative generation failed — retry" affordance that hits regenerate.

**Cost:** ~$0.03–0.05 per call. Daily cron × single user = ~$1–2 / month.

## UI surfaces

### Routing

- **New top-level route** `/coach` with two sub-tabs (`SubPillNav` pattern matching `/health`):
  - `/coach?tab=dashboard` (default)
  - `/coach?tab=chat`
- **Top nav** gains `/coach`. Likely ordering: `Today / Coach / Health / Strength / Meal / Profile`.
- **`/health` loses its Coach tab** — becomes `Trends | Log`. The chat thread that lived under `/health?tab=coach` relocates to `/coach?tab=chat`. All `chat_messages` rows are user-keyed, not URL-keyed, so the move is purely UI.
- **The chat thread component itself is unchanged.** Lift-and-shift.

### Dashboard tab layout

Layout matches mockup A (hero + 2×3 grid + inline accordion expand):

```
┌──────────────────────────────────────────────┐
│ Peter's read · Mon 2026-05-25      [Regen]  │
│ ──────────────────────────────────────────── │
│ HEADLINE — 1 sentence (Peter voice)         │
│ Body paragraph — 2-3 sentences,             │
│ calls out cross-theme clusters explicitly.  │
└──────────────────────────────────────────────┘

┌─────────────────┬─────────────────┐
│ ● Recomp        │ ● Energy        │
│ BF +0.4/wk      │ −180 kcal × 9d  │
├─────────────────┼─────────────────┤
│ ● Fatigue       │ ● Performance   │
│ HRV −7%         │ Bench flat 3wk  │
├─────────────────┼─────────────────┤
│ ● Plan adh.     │ ● Goal          │
│ 4/4 sessions    │ On pace         │
└─────────────────┴─────────────────┘
```

- Severity dot color: green (ok), amber (warn), red (urgent).
- Collapsed state: severity dot + theme label + one-line summary.
- Tapped card expands to span both columns, pushing siblings down; reveals:
  - Peter's `narrative_md` (or deterministic `body_md` on narrative failure).
  - 3–5 `facts` rendered as labeled chips (e.g. `BF Δ4w +1.6pts`, `LBM Δ4w −0.2kg`).
  - One Recharts mini sparkline (per-theme series defined in composer output).
  - Two nav chips:
    - `Ask Peter →` deep-links `/coach?tab=chat&context=<theme_key>` (Chat reads the `context` param and pre-pends `[user is asking about: <theme>]` to the user's first message; param clears after send).
    - `Open <specialist surface> →` from `drilldown` field (Recomp → `/metrics?sub=body`; Energy → `/meal`; Fatigue → `/health?tab=trends`; Performance → `/strength`; Plan adherence → most recent weekly review; Goal distance → `/profile`).

### Header controls

- "Last refreshed `<HH:MM>` `<TZ>`" timestamp (derived from `generated_at`, displayed in user TZ).
- `[Regenerate]` button. Clicked → POST `/api/coach/dashboard/regenerate` → 3–5s spinner → invalidates `queryKeys.peterDashboard.latest(userId)` → fresh render.
- Rate-limited 6/day per user (enforced server-side via row count for today). Button shows "Limit reached — next regen tomorrow" when exhausted.

### Discoverability

- When `hero.severity = 'urgent'`, top-nav `/coach` link gets a small dot indicator (reuses the existing weekly-review-banner dot primitive). Cleared once the user lands on `/coach?tab=dashboard`.

### SSR-hydrate pattern

Standard pattern (matches `/health` for recovery intelligence):

- Server prefetches latest `coach_dashboards` row via `fetchPeterDashboardServer`.
- Hydrates into TanStack Query with key `queryKeys.peterDashboard.latest(userId)`.
- Client reads via `usePeterDashboard()` hook with `staleTime: Infinity` (cron is the source of truth; regen invalidates explicitly).

## Prompt integration

Peter's system prompt receives a new **"Today's read"** block built from `coach_dashboards.narrative_md`.

### Placement in the prompt assembly chain

```
[1] PETER_BASE                          (static, ~600 tokens, cached)
[2] SCHEMA_EXPLAINER                    (static, cached)
[3] Snapshot prefix                     (cached up to 14d)
[4] Athlete profile renderer            (cached, in snapshot)
[5] NEW: Today's read (narrative_md)    (cache breakpoint here)
[6] Recent specialist activity          (peter-context.ts, last 5 turns each)
[7] Per-turn header                     (NOT cached)
```

The dashboard block sits between snapshot (long-cached) and specialist activity (short-cached). It gets its own Anthropic prompt-cache breakpoint so the morning regen invalidates only [5]+[6]+[7].

### The injected block

```markdown
# Today's read (Peter — generated Mon 04:00 UTC)

> <hero.headline>
>
> <hero.body_md>

## Recomp — <severity>
<cards.recomp.narrative_md>

## Energy — <severity>
<cards.energy.narrative_md>

## Fatigue — <severity>
<cards.fatigue.narrative_md>

## Performance — <severity>
<cards.performance.narrative_md>

## Plan adherence — <severity>
<cards.plan_adherence.narrative_md>

## Goal — <severity>
<cards.goal_distance.narrative_md>

---
Cluster (same root): <cluster.themes.join(' + ')>. Root hypothesis: <cluster.root_hypothesis>.
Use these takes when answering today's questions. If the user asks about a theme,
ground in the card's specifics rather than re-deriving.
```

Cluster line is omitted when `clusters` is empty.

### PETER_BASE prose updates

Two additions to [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) PETER_BASE:

**After the opening paragraph:**

> "You have a 'Today's read' block in your context with cross-domain synthesis already done — six themes with severity + narrative + cluster relationships. When a user asks a cross-domain question, ground in that block instead of re-running the synthesis. When a user asks about a specific theme, cite the card's facts directly."

**Appended as a new bullet:**

> "When 'Today's read' flags a cluster (multiple themes sharing a root cause), surface the cluster relationship explicitly. Don't answer about one card while ignoring the cluster — the cluster IS the head-coach insight."

### Relationship to existing peter-context.ts

**Kept.** Both serve different jobs:

- **Today's read** = "what I see in the data" (analytical synthesis).
- **Specialist activity** = "what they said in conversation" (conversational continuity).

Both blocks coexist in Peter's prompt. Specialist activity stays at section [6].

### Failure mode

If no `coach_dashboards` row exists for today (first-run user, cron hasn't fired): the block is replaced by a single line — *"Today's read not yet generated — synthesize from the snapshot directly."* Peter falls back to the existing snapshot-only context.

### No new tools

Peter's existing `query_daily_logs / query_workouts / query_food_log` cover any verification beyond the cards. Adding `query_coach_dashboard_history` is deferred (date-keyed schema makes it trivial when needed).

## Cron + endpoints

### Daily cron — `POST /api/coach/dashboard/sync`

- Vercel cron entry: `0 4 * * *` (matches morning-brief / proactive checks window).
- Auth: `CRON_SECRET` bearer.
- Body: `{ user_id: string }` (single-user app; cron iterates the one user).
- Idempotent: if `(user_id, today, version=1)` already exists, returns existing row.
- Writes a row with `status='ready'` + populated `narrative_md`, or `status='failed'` + deterministic-fallback `narrative_md`.

### Manual regen — `POST /api/coach/dashboard/regenerate`

- Auth: cookie-bound `createSupabaseServerClient`.
- Looks up `max(version)` for `(user_id, today)`, inserts new row at `version + 1`.
- Rate limit: 6/day per user, enforced via `count(*)` of today's rows. Returns 429 with `{ retry_after: '<UTC of next midnight>' }` when exceeded.
- Returns the new payload + invalidates `queryKeys.peterDashboard.latest(userId)`.

### Fetchers

[lib/query/fetchers/peterDashboard.ts](../../../lib/query/fetchers/peterDashboard.ts) ships server + browser pair per the [client-cache refactor pattern](2026-05-07-client-cache-refactor-design.md):

```ts
fetchPeterDashboardServer(supabase, userId, today)
fetchPeterDashboardBrowser(supabase, userId, today)
```

Both throw on error so TanStack lights up `isError`. Both select the latest row for the date (highest version).

### Hook

[lib/query/hooks/usePeterDashboard.ts](../../../lib/query/hooks/usePeterDashboard.ts):

```ts
useQuery({
  queryKey: queryKeys.peterDashboard.latest(userId),
  queryFn: () => fetchPeterDashboardBrowser(supabase, userId, today),
  staleTime: Infinity,
});
```

`staleTime: Infinity` matches the `useRecoveryIntelligence` pattern — the cron is authoritative; regen invalidates explicitly.

### Audit script

[scripts/audit-peter-dashboard.mjs](../../../scripts/audit-peter-dashboard.mjs):

```bash
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-peter-dashboard.mjs
```

Dry-runs `generatePeterDashboard` against current data. Outputs:

- Per-theme severity + one_line.
- Cluster detections.
- Fabrication-check: every numeric token in `narrative_md` is verified against `payload.facts`; any orphans printed as errors.
- Roundtrip: re-renders the prompt-injection block and prints it (so we can eyeball what Peter actually sees).

Same alias-loader pattern as the other audit scripts.

### Telemetry

- Cron and regenerate log via `console.info` with `{ userId, generated_on, version, status, narrative_failed, took_ms, cost_usd_estimate }`. Vercel function logs are the audit trail.
- Narrative fabrication-check rejections logged with offending text + retry-success boolean.

## Out of scope (v1 cuts)

Explicitly deferred:

- **HMAC Approve chips on cards.** Read-only + nav chips only. Existing propose_/commit_ tools are wirable in v2.
- **`query_coach_dashboard_history` tool for Peter.** Schema versioned; future-add is one function.
- **History UI / `/coach?date=...` time-travel.** Schema supports it; v1 shows latest only.
- **Per-theme detail routes (`/coach/themes/<key>`).** Inline accordion is v1.
- **Modal/bottom-sheet expand for cards needing 2+ charts.** Single sparkline per expanded card is v1.
- **Push notifications on severity flips to urgent.** Top-nav dot is v1.
- **Block-window dashboard variant ("this block so far").** v2.
- **Multi-lift / time-bounded body-recomp goal kinds.** Three goal_kinds shipped; expansion is additive.
- **Cross-correlation beyond pairwise rules.** Deterministic pairwise only. ML discovery — never.
- **Replacing `peter-context.ts`.** Both kept until dashboard prose proves to subsume conversational continuity.

## File-level inventory

New:

- `supabase/migrations/0031_peter_dashboard.sql`
- `supabase/migrations/0032_athlete_goal_structured.sql`
- `lib/coach/peter-dashboard/index.ts` — orchestrator + `generatePeterDashboard()`
- `lib/coach/peter-dashboard/types.ts` — `ThemeKey`, `ThemePayload`, `PeterDashboardPayload`, `ThemeCluster`
- `lib/coach/peter-dashboard/compose-recomp.ts`
- `lib/coach/peter-dashboard/compose-energy.ts`
- `lib/coach/peter-dashboard/compose-fatigue.ts`
- `lib/coach/peter-dashboard/compose-performance.ts`
- `lib/coach/peter-dashboard/compose-plan-adherence.ts`
- `lib/coach/peter-dashboard/compose-goal-distance.ts`
- `lib/coach/peter-dashboard/link-themes.ts` — cluster detection
- `lib/coach/peter-dashboard/narrative-prompt.ts` — Sonnet system prompt
- `lib/coach/peter-dashboard/narrate.ts` — single-call wrapper + fabrication check + retry
- `lib/coach/peter-dashboard/render-injection.ts` — builds the "Today's read" prompt block
- `lib/data/types.ts` additions — exported types from above
- `lib/query/keys.ts` additions — `queryKeys.peterDashboard.*`
- `lib/query/fetchers/peterDashboard.ts`
- `lib/query/hooks/usePeterDashboard.ts`
- `app/coach/page.tsx` — Server Component, sub-tab dispatcher, SSR-hydrate
- `app/coach/layout.tsx` (if needed for nav)
- `app/api/coach/dashboard/sync/route.ts` — cron handler
- `app/api/coach/dashboard/regenerate/route.ts` — manual regen
- `components/coach/PeterDashboardClient.tsx`
- `components/coach/PeterDashboardHero.tsx`
- `components/coach/PeterDashboardGrid.tsx`
- `components/coach/PeterThemeCard.tsx` — collapsed + expanded states
- `components/coach/PeterDashboardRegenButton.tsx`
- `scripts/audit-peter-dashboard.mjs`

Modified:

- `lib/coach/system-prompts.ts` — PETER_BASE prose additions
- `lib/coach/chat-stream.ts` — inject "Today's read" block at section [5]
- `lib/coach/peter-context.ts` — no change to logic; verify it composes cleanly after the new block
- `app/health/page.tsx` — drop Coach sub-tab; relocate chat dispatch
- `components/health/HealthNav.tsx` — sub-tab list shrinks to `Trends | Log`
- `components/layout/TopNav.tsx` (or equivalent) — add `/coach` entry
- `components/layout/Fab.tsx` — verify route list still matches (memory note: Fab + TopNav both hold app-entry lists)
- `vercel.json` — add cron `0 4 * * *` for `/api/coach/dashboard/sync`
- `CLAUDE.md` — add section under "Architecture → Coach / AI" describing Peter Dashboard + the two new migrations

## Open verification points

To resolve during implementation:

1. **Exact placement of `/coach` in top nav.** "Today / Coach / Health / Strength / Meal / Profile" is the proposed order; confirm visually against the existing nav design.
2. **Cluster rule tuning.** The 4 pairwise rules are starting points; first week of real payloads may surface false positives or missed clusters. The audit script's cluster output is the feedback loop.
3. **Goal-distance projection math edge cases.** Negative-trend goals (cutting body fat) and lift e1RM are conceptually similar but signed differently; the composer must handle both directions of `pace_ratio` correctly. Unit-testable.
4. **`narrative_md` regeneration cost at the per-day grain.** First week of cron runs should be monitored; if Sonnet narrative consistently costs >$0.10, drop to Haiku 4.5 + tighter constraints.
