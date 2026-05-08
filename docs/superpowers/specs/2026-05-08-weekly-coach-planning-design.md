# Weekly Coach Planning — Design

**Date:** 2026-05-08
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed

## Problem

`TodayPlanCard` on the strength tab reads from a hardcoded `WEEKLY_SESSIONS` map ([lib/coach/sessionPlans.ts:56-64](../../../lib/coach/sessionPlans.ts#L56-L64)) that prescribes the same training type for every Friday forever. The current map prescribes Legs on Friday, but the user's actual training pattern is mostly Back / Arms / mixed on Fridays — never plain Legs as the dominant pattern. The bug surfaces every Friday.

The deeper problem is that a single-user coaching app has no business hardcoding a static weekly schedule. The user has goals, history, recovery data, and a chatbot already wired to all of it via [lib/coach/tools.ts](../../../lib/coach/tools.ts). What's missing is the *conversational ritual* that produces a structured weekly training plan — the way a real strength coach would do it: review what happened, ask how you feel, propose next week with rationale, commit on approval.

This spec covers the v1 cut: a Sunday weekly-planning conversation that produces a committed plan, anchored in 5-week mesocycle blocks with research-backed periodization, with strength-only progress tracking. Body composition, diet prescription, and recomp-aware metrics are explicitly deferred to v2.

## Goals

1. **Kill the static `WEEKLY_SESSIONS` bug.** `TodayPlanCard` reads a real per-week plan; static map becomes pure fallback.
2. **Introduce mesocycle structure.** 5-week blocks with a single strength goal, automatic phase progression (accumulate weeks 1-4, deload week 5), automatic RIR step-down (4→3→2→1 across weeks 1-4).
3. **Sunday planning ritual via chat.** The user opens `/coach` on Sunday, sees a "Plan week N" CTA, taps it, and runs a structured 4-beat conversation with the coach (recap → check-in → propose → commit) that ends with a committed plan in the database.
4. **First-time block setup ritual.** A separate `setup_block` chat mode walks the user through goal-setting once before they can plan their first week.
5. **Adherence visibility.** Sunday's recap pulls planned-vs-actual session types and per-muscle volume deltas vs the prior 4-week average — computed on the fly from existing `workouts`, no new schema.
6. **Autoregulation triggers.** When ≥2 of {HRV outside SWC band ×3 days, e1RM drop ≥5%, RPE +2 vs baseline, sleep <6h ×3 nights} fire concurrently, the coach surfaces a deload alert in the next planning conversation. The user decides — never auto-applied.
7. **Research-backed defaults, not user-arbitrary choices.** Block length is fixed at 5 weeks (consensus modal). Within-block RIR progression is fixed. Block-end is always a deload in v1 (real 1RM tests deferred).

## Non-Goals

- **Body composition integration.** Strength-per-LBM, allometric scaling, IPF GL, fat loss velocity, protein floor — all deferred to v2. v1 is strength-only.
- **Diet prescription.** No calorie/macro targets. v2 territory.
- **Per-exercise prescription override.** The session's exercise list continues to come from the existing static `SESSION_PLANS[type]` constants. The Sunday conversation outputs *session type per day + intensity multiplier per primary lift*, not arbitrary exercise lists. v2 can layer custom prescription.
- **Mid-week plan-edit UI.** Once a week is committed, the only path to change it is re-running the planning conversation (which updates the existing row, not creating a new one). No tap-to-swap-Friday button. v2.
- **Push notifications.** No native push in this PWA environment. The Sunday CTA appears on `/coach` page load; the user must open the app.
- **Real 1RM testing.** v1 always ends a block with a deload. Test weeks (every 2-3 mesocycles, conditional on recovery) are v2.
- **Mid-block auto-edits.** Autoregulation surfaces alerts only; never silently moves a committed plan.
- **Multi-user generalization.** Single-user app. Schema and RLS are scoped per-user but no design effort goes into multi-tenancy.

## Research basis

Periodization defaults are anchored in 2024-2025 evidence. Full research report available in conversation history; key citations:

- **Block length: 5 weeks load + 1 week deload** is modal practitioner consensus. Rogerson et al. 2024 reported deloads "every 5.6 ± 2.3 weeks" across n=246 strength/physique athletes ([PMC10948666](https://pmc.ncbi.nlm.nih.gov/articles/PMC10948666/)). Bell et al. 2023 Delphi consensus confirms 4-6w as the practitioner range ([PMC10511399](https://pmc.ncbi.nlm.nih.gov/articles/PMC10511399/)).
- **Deload protocol: volume −50% at intensity hold ~80-85%, frequency maintained, ~7 days.** "Week off" is no longer best practice — Rogerson 2024 found 78.9% of practitioners reduce sets, 83.7% reduce loads on multi-joint, but 63% maintain frequency.
- **Within-block progression: weekly undulating with RIR step-down.** Williams et al. 2017 meta showed undulating periodization yields 24.8-27.4% strength gains vs 20.3-21.7% linear (effect size 0.21-0.37 favoring undulating). Israetel/RP recommends RIR 4→3→2→1 across the block.
- **Autoregulation triangulation rule.** No single signal (HRV, RPE, e1RM drop, sleep) is research-validated as a standalone trigger. Bell et al. 2023 explicit: "single-metric triggers produce false alarms." Recommend ≥2 concurrent signals before suggesting a deload.
- **Block-end choice: default deload, test only every 2-3 mesocycles + conditional on recovery, never test in a deficit.** Functional overreaching documented (Travis et al. 2022 [PMC9108365](https://pmc.ncbi.nlm.nih.gov/articles/PMC9108365/)) but recovery-resource-intensive — out of scope for v1.

The full reasoning behind these defaults is preserved in the conversation thread that produced this spec; future contributors should read those findings before changing any of the v1 defaults.

## Architecture overview

Three concentric loops, two new tables, zero changes to existing tables.

```
┌─ Loop 1: BLOCK (4-6w mesocycle, the strength goal) ───────┐
│                                                            │
│   ┌─ Loop 2: WEEK (committed Sunday plan) ──────────────┐ │
│   │                                                      │ │
│   │   ┌─ Loop 3: ADHERENCE (derived, not stored) ──┐   │ │
│   │   │                                              │   │ │
│   │   │   planned[Mon..Sun] vs workouts[Mon..Sun]    │   │ │
│   │   │   computed on demand by query, no schema     │   │ │
│   │   │                                              │   │ │
│   │   └──────────────────────────────────────────────┘   │ │
│   │                                                      │ │
│   │   training_weeks row: session_plan + focus + RIR     │ │
│   │   committed via chat tool propose_week_plan +        │ │
│   │   commit_week_plan (signed token gate)               │ │
│   │                                                      │ │
│   └──────────────────────────────────────────────────────┘ │
│                                                            │
│   training_blocks row: goal + primary_lift + 5w window     │
│   committed via chat tool propose_block + commit_block     │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

The coach Pearl is structured around three chat modes:

- **`default`** — everyday Q&A (the existing chat surface, unchanged)
- **`plan_week`** — Sunday weekly planning (4-beat: recap → check-in → propose → commit)
- **`setup_block`** — first-time or post-completion block creation (4-beat: explain → elicit → propose → commit)

Mode is decided server-side at chat creation, persisted on `chat_messages`, and used by the route handler to assemble the system prompt and tool list.

## Schema

### `training_blocks` (new)

```sql
create table public.training_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'completed', 'abandoned')),
  start_date date not null,                  -- always a Monday
  end_date date not null,                    -- always start + 34 days (5w end-of-Sun)
  goal_text text not null,                   -- "Build deadlift to 125kg"
  primary_lift text                          -- 'squat' | 'bench' | 'deadlift' | 'ohp' | NULL
    check (primary_lift in ('squat','bench','deadlift','ohp') or primary_lift is null),
  target_metric text                         -- 'e1rm' | 'working_weight' | NULL (free-form goal only)
    check (target_metric in ('e1rm','working_weight') or target_metric is null),
  target_value numeric,                      -- 125
  target_unit text default 'kg',
  diet_goal jsonb,                           -- reserved-null for v2; NULL in v1
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  check ((target_metric is null) = (target_value is null))
);

-- Only one active block per user
create unique index training_blocks_one_active_per_user
  on public.training_blocks (user_id) where status = 'active';

create index training_blocks_user_status_idx
  on public.training_blocks (user_id, status);

alter table public.training_blocks enable row level security;

create policy "training_blocks self" on public.training_blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

### `training_weeks` (new)

```sql
create table public.training_weeks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  block_id uuid references public.training_blocks on delete set null,
  week_start date not null,                  -- always a Monday (UTC)
  session_plan jsonb not null,               -- {Mon:"Chest", Tue:"Legs", ...}
  weekly_focus text,                         -- "Bench PR Mon. Hold squat."
  intensity_modifier jsonb default '{}'::jsonb,  -- {squat: 0.95, bench: 1.0}
  rir_target int                             -- 1|2|3|4 (NULL for deload week or off-block)
    check (rir_target between 1 and 4 or rir_target is null),
  research_phase text                        -- 'accumulate' | 'deload'
    check (research_phase in ('accumulate','deload') or research_phase is null),
  proposed_by text not null default 'coach'
    check (proposed_by in ('coach', 'user')),
  chat_message_id uuid references public.chat_messages on delete set null,
  committed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One plan per user per week (re-running planning UPDATEs, doesn't INSERT)
create unique index training_weeks_user_week_idx
  on public.training_weeks (user_id, week_start);

alter table public.training_weeks enable row level security;

create policy "training_weeks self" on public.training_weeks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

### `chat_messages` extension

```sql
alter table public.chat_messages
  add column if not exists mode text not null default 'default'
  check (mode in ('default','plan_week','setup_block'));
```

Existing rows backfill to `'default'`. The column lets us query "show me all my Sunday planning conversations" later and lets the route handler reconstruct mode from any message in the thread.

**How a turn determines its mode**: the chat API route resolves mode for a new turn as follows:
1. If the request includes an explicit `mode` parameter (sent from the URL `?mode=...` flow on first message), use that.
2. Else, look up the most recent `chat_messages` row for this user. If it exists and has `mode != 'default'`, inherit that mode.
3. Else, `'default'`.

The user message and the assistant's reply are both stamped with the same mode. The mode persists across turns of the same logical conversation; a new conversation (no recent prior message OR a `[exit-mode]` sentinel from the banner `[✕]`) resets to `'default'`.

**Block status auto-flip to `'completed'`**: handled at read time in the `/api/coach/block-progress` endpoint and in `query_training_blocks` tool — when fetching an `'active'` block, if `today > end_date`, the route updates `status='completed', completed_at=now()` before returning. No cron, no trigger; lazy migration on access. This avoids the user ever seeing a stale "active" block past its end_date and naturally surfaces the "set up a new block" CTA on the next `/coach` load.

### Migration file

`supabase/migrations/0007_weekly_planning.sql` containing both tables, the column add, the indexes, the RLS policies, and the constraints. Apply via `supabase db push` per the existing CLAUDE.md convention.

## Conversation flow

### Mode triggering

`/coach` page load runs three queries to decide what CTA to show:

1. `select * from training_blocks where user_id = ? and status = 'active' limit 1`
2. `select * from training_weeks where user_id = ? and week_start = planning_target_monday(today)`
3. `today_weekday()` (in user TZ via [lib/time.ts:weekdayInUserTz](../../../lib/time.ts#L88))

`planning_target_monday(today)` is defined as: **the most recent Monday on or before today if `weekday(today) ∈ {Mon..Sat}`; the next Monday if Sunday.** This is a TS helper added to `lib/coach/week.ts` (the file already owns `recommendationWeekStart` with similar semantics).

Decision table:

| Active block? | Plan for current/next week? | Today | CTA shown on `/coach` next-week view |
|---|---|---|---|
| No | — | any | "Set up your first training block" → `?mode=setup_block` |
| Yes | No | Sunday | "Plan week N of your block" → `?mode=plan_week` |
| Yes | No | Mon-Tue | "Plan this week — late but still useful" → `?mode=plan_week` |
| Yes | No | Wed-Sat | (no CTA — week mostly over; coach reacts to actuals) |
| Yes | Yes | any | (no CTA; show committed `WeekPlanCard` instead) |

Tapping a CTA navigates to `/coach?mode=plan_week`. The `CoachClient` component reads `mode` from the URL and dispatches a global `open-chat` event with `{ mode }` as payload. `FabGate` listens, opens `ChatPanel`, and the first composer message is sent with `mode` as a metadata field. The chat API route stamps `chat_messages.mode = 'plan_week'` on both user and assistant turns of that conversation.

### `plan_week` 4-beat script

The system prompt prepended in `plan_week` mode reads roughly:

> You are running a weekly planning session with this athlete. The active block runs `{block.start} → {block.end}` with goal "`{block.goal_text}`". This is week `{n}` of 5, target RIR `{rir}`, intensity multiplier `{mult}`. Follow this 4-beat:
>
> 1. **RECAP** last week using `compute_adherence` and `query_workouts`. Tell the story of the past week in 1-2 sentences anchored in concrete numbers.
> 2. **CHECK-IN** with one question about how the user is feeling and any constraints (travel, soreness, schedule changes). Wait for the response.
> 3. **PROPOSE** by deriving RIR target from week-of-block (1→4 = accumulate with RIR step-down, 5 = deload), consulting `get_autoregulation_signals`. If ≥2 signals firing, surface the alert and recommend (don't impose) a deload. Then call `propose_week_plan` with the proposed schedule and rationale.
> 4. **COMMIT** by waiting for user approval; on yes call `commit_week_plan`; on tweaks re-call `propose_week_plan` with the requested changes.
>
> Be concise (2-4 sentences per beat). Never commit without explicit user approval.

When `get_autoregulation_signals().count >= 2`, an additional block is appended to the system prompt:

> ⚠ Deload alert: `{signal_summary}`. Recommend a deload week to the athlete; explain which signals fired and what they mean. The athlete decides — if they want to push through, propose week `{n}` as planned but flag the risk.

### `setup_block` 4-beat script

Mode prompt:

> You are running a training block setup with this athlete. We run 5-week blocks ending in a deload week — research consensus for an intermediate lifter ([Rogerson 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC10948666/)). Each block has a single primary-lift target. Follow this 4-beat:
>
> 1. **EXPLAIN** the block structure (5w, ends in deload, single primary-lift goal).
> 2. **ELICIT** the user's primary lift focus, target e1RM (or working weight), and any other intent (free-form goal_text).
> 3. **PROPOSE** by calling `propose_block` with start_date = next Monday, end_date = +34 days, the parsed target.
> 4. **COMMIT** by calling `commit_block` only after explicit user approval.
>
> On commit, send a follow-up message: "Block set. Come back Sunday to plan week 1." Mode auto-flips to `default` for the next message.

### Mode banner & exit

`ChatPanel` renders a small banner above the message list when in a non-default mode:

```
┌──────────────────────────────────────────────┐
│ 📅 Planning week 3 · Block 1 · DL→125kg [✕]  │
└──────────────────────────────────────────────┘
```

The `[✕]` button exits the planning session without committing — sets the next message's mode to `'default'` so subsequent turns are regular Q&A. Useful for "ask the coach a side question without losing planning context" — but for v1, exiting just resets to default; we don't preserve the partial planning state.

## Coach tools

Eight new tools in [lib/coach/tools.ts](../../../lib/coach/tools.ts), following the existing security invariants (no `user_id` in input schemas; injected by route from `auth.getUser()`; explicit `.eq("user_id", userId)` in every query; closed enum validation; range caps).

### `query_training_blocks`

```ts
{
  name: "query_training_blocks",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active","completed","abandoned","all"], default: "active" }
    }
  }
}
// Returns: array of training_blocks rows; default 'active' returns 0 or 1.
```

### `query_training_weeks`

```ts
{
  name: "query_training_weeks",
  input_schema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date:   { type: "string", format: "date" }
    }
  }
}
// Returns: training_weeks rows in the inclusive range. Range cap: 90 days.
```

### `get_autoregulation_signals`

Computed on demand. No new schema.

```ts
{
  name: "get_autoregulation_signals",
  input_schema: {
    type: "object",
    properties: {
      as_of: { type: "string", format: "date", description: "Defaults to today." }
    }
  }
}
// Returns:
// {
//   hrv:   { breached: bool, days_outside_swc: int, swc_lower, swc_upper, today: number },
//   e1rm:  { breached: bool, lift: string, drop_pct: number, sessions_compared: int },
//   rpe:   { breached: bool, lift: string, drift: number, sessions_compared: int }, // may be null in v1 if RPE data sparse
//   sleep: { breached: bool, short_nights: int, threshold_hours: 6 },
//   count: int (0-4),
//   should_deload: boolean (count >= 2)
// }
```

Computation specifics:
- **HRV**: rolling 7-day mean baseline, ±0.5 SD = SWC band. `breached = today's HRV outside band for ≥3 of last 4 days`.
- **e1rm**: reuse [lib/coach/derived.ts:topSet](../../../lib/coach/derived.ts) and `epley` for the top working set per session of `block.primary_lift`; compare last 2 sessions' max e1RM to the rolling 4-week mean for that lift. `breached = drop ≥5%`. If `block.primary_lift` is null, this signal is reported as `null` (not counted toward `count`).
- **rpe**: requires per-set RPE; v1 may not have enough data. If `<3 sessions in last 14d have RPE annotation`, return `null` for this signal (not counted toward `count`).
- **sleep**: count nights in last 4 with `sleep_hours < 6`. `breached = ≥3`.

### `compute_adherence`

```ts
{
  name: "compute_adherence",
  input_schema: {
    type: "object",
    required: ["week_start"],
    properties: {
      week_start: { type: "string", format: "date" }
    }
  }
}
// Returns:
// {
//   week_start: "2026-05-04",
//   planned: { Mon: "Chest", Tue: "Legs", Wed: "Mobility", Thu: "Back", Fri: "Arms", Sat: null, Sun: null },
//   actual:  { Mon: "Chest", Tue: "Legs", Wed: null,       Thu: "Back", Fri: null,    Sat: null, Sun: null },
//   sessions_planned: 5,
//   sessions_done: 3,
//   adherence_pct: 60,
//   muscle_volume_vs_4w_avg: { Chest: 0.05, Legs: -0.12, Back: 0.10, ... }  // proportional deltas
// }
```

`muscle_volume_vs_4w_avg` reuses [lib/coach/exercise-categories.ts](../../../lib/coach/exercise-categories.ts) for muscle-group classification and `workingVolume` from [lib/coach/derived.ts](../../../lib/coach/derived.ts) for volume math. Computed against the prior 28 days, excluding the queried week itself.

**Planned-vs-actual matching** is lenient string-overlap, not strict equality, because the user's `workouts.type` values are free-form (real history shows "Lower Body", "Legs And Arms", "Chest Triceps", etc., not always matching plan strings exactly). Match rules:

- Lowercase both, strip punctuation, split on whitespace
- A workout matches the planned type if any word in the planned type appears as a word/substring in the workout type (e.g., planned "Legs" matches "Lower Body"? No — "Legs" word missing. But planned "Legs" matches "Legs And Arms" because "Legs" is present)
- Exact: `"Chest"` planned matches `"Chest"` ✓, `"Chest Triceps"` ✓, but not `"Back"` ✗
- Mobility / REST: literal string match required (no fuzzy)
- When no match but a workout exists that day: report as "off-plan" rather than "missed"; counts in `sessions_done` but not in `sessions_on_plan` (a separate counter)

`adherence_pct` is reported as `sessions_on_plan / sessions_planned`. `sessions_done / sessions_planned` is also exposed as `sessions_done_pct` for the "did you train at all?" framing.

### `propose_block` / `commit_block`

```ts
// propose_block
{
  input_schema: {
    type: "object",
    required: ["goal_text", "start_date", "end_date"],
    properties: {
      goal_text:     { type: "string", minLength: 4, maxLength: 200 },
      primary_lift:  { type: "string", enum: ["squat","bench","deadlift","ohp"] },
      target_metric: { type: "string", enum: ["e1rm","working_weight"] },
      target_value:  { type: "number", minimum: 0 },
      target_unit:   { type: "string", default: "kg" },
      start_date:    { type: "string", format: "date" }, // must be a Monday
      end_date:      { type: "string", format: "date" }  // must be exactly start + 34 days
    }
  }
}
// Returns: { preview: <full block payload>, approval_token: <signed token> }
// DOES NOT WRITE.

// commit_block
{
  input_schema: {
    type: "object",
    required: ["approval_token"],
    properties: { approval_token: { type: "string" } }
  }
}
// Verifies the token (HMAC of user_id + action + payload_hash + 10-min timestamp).
// Inserts the training_blocks row with status='active'.
// Fails if user already has an active block (handled by the partial unique index).
// Returns: { id, ...committed_row }
```

### `propose_week_plan` / `commit_week_plan`

Same propose-then-commit pattern with signed token.

```ts
// propose_week_plan
{
  input_schema: {
    type: "object",
    required: ["week_start", "session_plan"],
    properties: {
      week_start:         { type: "string", format: "date" }, // must be a Monday
      session_plan:       { type: "object" },                  // {Mon:..., Tue:..., ...}
      weekly_focus:       { type: "string", maxLength: 200 },
      intensity_modifier: { type: "object" },                  // {squat: 0.95, ...}
      rir_target:         { type: "integer", minimum: 1, maximum: 4 },
      research_phase:     { type: "string", enum: ["accumulate","deload"] },
      rationale:          { type: "string", maxLength: 500 }   // for the chat preview UI
    }
  }
}
// Returns: { preview, approval_token }

// commit_week_plan
{
  input_schema: {
    type: "object",
    required: ["approval_token"],
    properties: { approval_token: { type: "string" } }
  }
}
// On success: UPSERT into training_weeks on (user_id, week_start) with the proposal payload.
// chat_message_id is set to the assistant message that produced the proposal.
// proposed_by = 'coach'.
```

### Approval token

HMAC of `(user_id, action, sha256(payload), unix_timestamp)` using a server-side secret in `process.env.COACH_TOOL_SECRET`. 10-minute validity window. Verified server-side in the `commit_*` route handler before any write.

This gate prevents:
- Hallucinated commits (model can't fabricate a token)
- Stale approvals (10-min expiry)
- Replay attacks (token bound to specific payload hash)

The chat client surfaces the token only via the inline `<WeekPlanProposalCard>` Approve button — never visible to the user, never copyable. On Approve, the client sends a hidden user message `[approve:tok_xy7z]` that the coach interprets as "call commit_week_plan with this token".

## UI surface

### Strength tab — `TodayPlanCard`

Read priority changes in [components/strength/StrengthClient.tsx](../../../components/strength/StrengthClient.tsx):

```ts
// Replace the existing buildDailyPlan call with a two-source resolver.
// currentWeekMonday is the most recent Monday on or before today in user TZ —
// note: this is NOT planning_target_monday() (no Sunday flip), because the
// strength tab cares about *this* week's plan, not next week's.
const committedWeek = useTrainingWeek(userId, currentWeekMonday);  // new hook
const sessionType = committedWeek?.session_plan?.[weekday]
                  ?? WEEKLY_SESSIONS[weekday]
                  ?? "REST";
const intensityMult = committedWeek?.intensity_modifier?.[primaryLift]
                    ?? readinessMode.multiplier;
const rirTarget = committedWeek?.rir_target ?? null;
const researchPhase = committedWeek?.research_phase ?? null;
```

`useTrainingWeek` follows the dual-fetcher hybrid SSR-hydrate pattern documented in [CLAUDE.md](../../../CLAUDE.md): server fetcher in `lib/query/fetchers/trainingWeek.ts`, browser fetcher same file, hook in `lib/query/hooks/useTrainingWeek.ts`, query key `queryKeys.trainingWeeks.one(userId, weekStart)` (added to [lib/query/keys.ts](../../../lib/query/keys.ts)). The strength page Server Component prefetches the current-week row alongside its existing prefetches.

`TodayPlanCard` props gain `committedFromPlan: boolean`, `weekN: number | null`, `rirTarget: number | null`, `researchPhase: 'accumulate' | 'deload' | null`. The pill at top-right replaces the readiness-mode pill text:

- Committed plan: `WEEK 3 · ACCUMULATE · RIR 2`
- Fallback: `DEFAULT — PLAN ON COACH ↗` (tap → `/coach?mode=plan_week`)

Exercise list and target weight rendering are unchanged — `SESSION_PLANS[type]` is still the source. `intensityMult` continues to scale `baseKg` exactly as today's [buildDailyPlan](../../../lib/coach/readiness.ts#L117-L147) does.

### `/coach` next-week view restructure

[components/coach/CoachClient.tsx:NextWeekView](../../../components/coach/CoachClient.tsx#L345) gains three new components above the existing `RecommendationsList`:

```tsx
<NextWeekView>
  <BlockProgressCard userId={userId} />            {/* new */}
  <WeekPlanCard userId={userId} weekStart={...} /> {/* new */}
  <RecommendationsList ... />                      {/* existing */}
</NextWeekView>
```

**`<BlockProgressCard>`** (new): renders the active block progress card described in Section 3 above. Shows goal, week N of 5, e1RM trajectory, adherence %, on-pace boolean. If no active block: shows "Set up your first training block" CTA card instead. Data via new `useBlockProgress(userId)` hook + new `/api/coach/block-progress` endpoint that runs the three queries described in Section 3.

**`<WeekPlanCard>`** (new): renders the committed plan for the current/upcoming week (read-only summary view). Mon-Sun grid with session types, intensity multipliers, weekly focus, RIR target. Links to "Re-open planning chat" → `?mode=plan_week`. If no plan committed: hidden (the BlockProgressCard's CTA replaces it).

**`<RecommendationsList>`** stays largely unchanged. New `category` values added: `'deload_alert'` (auto-written by autoregulation engine on coach load) and `'cut_velocity_warning'` / `'protein_floor'` (deferred to v2). The existing component doesn't need to change to render the new categories — the `category` field is already a free string.

### Chat preview cards

`ChatMessage` rendering gains tool-call recognition. When an assistant message's `tool_calls` array contains a `propose_block` or `propose_week_plan` invocation, the message renders a structured preview component inline (in addition to the assistant's text):

**`<WeekPlanProposalCard>`** — shown inside the assistant bubble:

```
┌───────────────────────────────────────┐
│ Proposed plan · Week 3 · Sep 22-28    │
│ Mon  Chest          0.95× · RIR 2     │
│ Tue  Legs           0.95× · RIR 2     │
│ Wed  Mobility                          │
│ Thu  Back           0.95× · RIR 2     │
│ Fri  Arms           0.95× · RIR 2     │
│ Sat  REST                              │
│ Sun  REST                              │
│                                       │
│ Focus: Bench PR Mon. Hold squat.      │
│ Why: week 3, accumulate, intensity ↑  │
│                                       │
│  [ Approve ]   [ Tweak in chat ]      │
└───────────────────────────────────────┘
```

**Approve** sends a hidden user turn `[approve:<token>]` → coach calls `commit_week_plan` with the token → server commits → success state replaces the card with `✓ Plan committed for Sep 22-28`.

**Tweak** focuses the chat composer with placeholder text ("e.g., 'make Friday Arms instead'") — user types, coach re-proposes via `propose_week_plan`, new card replaces the old one.

**`<BlockProposalCard>`** follows the identical pattern with block-shape data.

## Adherence & block progress (computed)

### Adherence (per week)

Pure SELECT, no schema. Implementation in `lib/coach/adherence.ts` (new):

```ts
export async function computeAdherence(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string
): Promise<AdherenceResult> {
  // 1. Fetch the week plan (or null if not committed)
  // 2. Fetch workouts for [weekStart, weekStart + 6]
  // 3. Bucket workouts by weekday using user-tz
  // 4. Build planned/actual map by weekday
  // 5. Compute adherence_pct = sessions_done / sessions_planned
  // 6. For volume: fetch the prior 28 days of workouts, classify by muscle group,
  //    sum working volume per group, divide by 4 to get weekly avg, compare to
  //    current week's per-group volume → proportional delta.
}
```

Used by `compute_adherence` tool, `<BlockProgressCard>`, and the `/api/coach/block-progress` endpoint.

### Block progress

`/api/coach/block-progress` (new GET endpoint):

```ts
// Returns: {
//   block: { ...active block row },
//   current_week: 3,
//   total_weeks: 5,
//   research_phase: 'accumulate',  // weeks 1-4
//   rir_target: 2,                 // 5 - current_week
//   e1rm_at_block_start: 117,
//   e1rm_now: 119,                 // rolling 4w mean of top working set on primary_lift
//   e1rm_delta: 2,
//   e1rm_remaining_to_goal: 6,
//   on_pace: true,                 // (e1rm_delta / weeks_elapsed) >= ((target_value - e1rm_at_start) / total_weeks)
//   sessions_planned_to_date: 9,
//   sessions_done: 8,
//   adherence_pct: 89
// }
```

`on_pace` thresholds:
- ≥100% of linear pace → green
- 80-99% → amber
- <80% → red
- No primary_lift on the block → omit pace fields entirely

### Sunday recap

The recap is the coach's RECAP beat (text in chat), not a separate UI card. The chat tool calls `compute_adherence(last_week_start)` and the coach narrates the result. No standalone UI surface beyond `<BlockProgressCard>` and `<WeekPlanCard>` already showing the same numbers in different framing.

Exception: a small "Last week" mini-card on `/coach` next-week view, shown Mon-Wed only, summarizing last week's adherence pct + on-pace status numerically. Lets the user glance the recap without re-opening chat. Reuses the same `compute_adherence` query.

## Migration & rollout

### Single migration: `supabase/migrations/0007_weekly_planning.sql`

Contents:
1. `create table public.training_blocks ...`
2. Partial unique index for one active block per user
3. `create table public.training_weeks ...`
4. Unique index `(user_id, week_start)`
5. `alter table public.chat_messages add column mode text ...`
6. RLS policies for both new tables
7. Comments on each new column documenting purpose and v1/v2 status

Apply via Supabase Dashboard SQL Editor (per CLAUDE.md convention) and immediately follow with `supabase migration repair --status applied 0007` to align CLI state.

### Rollout sequence

1. **Migration first** — schema + RLS in DB.
2. **Backend tools** — implement the 8 new tools in `lib/coach/tools.ts`, the autoregulation computation in `lib/coach/autoregulation.ts` (new), the adherence computation in `lib/coach/adherence.ts` (new), the approval-token util in `lib/coach/approval-token.ts` (new). Wire into the chat route handler. Type-check passes.
3. **Strength tab fix** — `TodayPlanCard` reads from `training_weeks` first, falls back to `WEEKLY_SESSIONS`. The pill UI updates. **At this point the user can manually INSERT a `training_weeks` row via SQL and verify the strength tab respects it** — kills the original Friday=Legs bug independently of the chat flow.
4. **`/coach` UI** — `<BlockProgressCard>`, `<WeekPlanCard>`, the CTA card, the mode banner in `ChatPanel`, the `<WeekPlanProposalCard>` / `<BlockProposalCard>` rendering in `<ChatMessage>`.
5. **Conversation flow** — system prompts for `plan_week` / `setup_block`, mode persistence, the Approve/Tweak interaction.
6. **End-to-end test** — set up first block via chat, plan week 1 via chat, verify strength tab shows the committed plan, run autoregulation queries against historical data to validate signals fire correctly.

## Open questions / future work

Explicitly out of v1, captured here so v2 has somewhere to start:

- **Body composition integration.** Strength-per-LBM, allometric, IPF GL, fat loss velocity. Reads `daily_logs.fat_free_mass_kg`, `weight_kg`, `body_fat_pct`. New `progress_metrics` table materialized daily.
- **Diet prescription.** Calorie/macro targets from the coach. Wires into `daily_logs.calories_eaten / protein_g / carbs_g / fat_g`. Populates `training_blocks.diet_goal` jsonb.
- **Mid-week swap UI.** Tap-to-swap on `<WeekPlanCard>`. Updates `training_weeks.session_plan` directly without going through chat.
- **Real 1RM testing.** When `final_phase='test'`, the deload week is replaced by a test-week protocol (3-day taper, PR attempt). Conditional on prior block completion + recovery state.
- **Functional overreaching.** Optional final-block week of 20-30% volume bump pre-test. Strict gates (not in deficit, recovery green for prior 2 weeks).
- **Push notifications / Sunday reminder.** Native PWA push when this PWA gets push capability. For now, app-open-on-Sunday is the trigger.
- **Per-exercise prescription.** The coach can override the exercise list within a session, not just the type. Stored in `training_weeks.session_plan[day]` as a richer object (currently just a string).
- **Multi-block macrocycle.** Sequence of blocks toward a longer goal (e.g., "12-week meet prep"). Schema gains a `macrocycles` table; blocks reference parent.
- **Deload ALERT auto-promotion.** When ≥2 signals fire, auto-create a `coach_recommendations` row with category `'deload_alert'` so it shows on `/coach` outside of the planning chat. Currently lives only in the planning conversation system prompt.
- **Block abandonment UX.** What happens when the user clearly stops following a block (no adherence for 2 weeks)? Currently nothing; v2 should prompt the user "want to abandon this block and start fresh?"
- **RPE auto-fill.** v1 autoregulation has a degraded `rpe` signal because RPE data is sparse. v2 may add a quick RPE-after-set tap UI to the strength tab to make this signal first-class.

## References

- Rogerson D et al. 2024. *Deloading Practices in Strength and Physique Sports: A Cross-Sectional Survey.* PMC10948666. https://pmc.ncbi.nlm.nih.gov/articles/PMC10948666/
- Bell L et al. 2023. *Integrating Deloading into Strength and Physique Sports Training Programmes: An International Delphi Consensus Approach.* PMC10511399. https://pmc.ncbi.nlm.nih.gov/articles/PMC10511399/
- Williams TD et al. 2017. *Comparison of Periodized and Non-Periodized Resistance Training on Maximal Strength: A Meta-Analysis.* https://pubmed.ncbi.nlm.nih.gov/28349281/
- Grgic J et al. 2017. *Effects of linear and daily undulating periodized resistance training programs on measures of muscle hypertrophy: a systematic review and meta-analysis.* PeerJ. https://peerj.com/articles/3695/
- Addleman J et al. 2024. *Heart Rate Variability in Strength and Conditioning: A Narrative Review.* PMC11204851. https://pmc.ncbi.nlm.nih.gov/articles/PMC11204851/
- Travis SK et al. 2022. *High-Performance Coaches' Perceptions of Planned Overreaching.* PMC9108365. https://pmc.ncbi.nlm.nih.gov/articles/PMC9108365/
- Helms ER et al. (3DMJ). *The Muscle and Strength Pyramid: Training.* Reference for intermediate program design.
- Israetel M (Renaissance Periodization). *Mesocycle Progression for Hypertrophy.* https://rpstrength.com/blogs/articles/in-defense-of-set-increases-within-the-hypertrophy-mesocycle
- Tuchscherer M (Reactive Training Systems). *Deloading Effectively.* https://store.reactivetrainingsystems.com/blogs/advanced-concepts/deloading-effectively
- Nuckols G (Stronger By Science). *Periodization: What the Data Say.* https://www.strongerbyscience.com/periodization-data/
