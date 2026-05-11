# Schedule Flexibility — Design

**Date:** 2026-05-11
**Status:** Drafted (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Layered on top of Weekly Planning v1 ([migration 0008](../../../supabase/migrations/0008_weekly_planning.sql)) and Morning Brief ([2026-05-11-morning-brief-design.md](2026-05-11-morning-brief-design.md), PR #41 + hotfix #42). Both shipped; this spec mutates `training_weeks.session_plan` after the Sunday commit and surfaces the result in the brief.

## Problem

Today's [`training_weeks.session_plan`](../../../supabase/migrations/0008_weekly_planning.sql) is a Sunday-committed jsonb plan (`{ "Monday": "Legs", "Tuesday": "Chest", ... }`) with no way to adjust mid-week. Two real cases break that:

1. **Life conflicts.** "I have lunch with a friend tomorrow, can't make Chest — swap with mobility?"
2. **Low-readiness mornings.** "Your readiness is low — I'd swap today's session with mobility."

Both need single-day edits without re-running the full `plan_week` chat ritual. And Sunday's recap needs to still know what was *originally committed* so [adherence](../../../lib/coach/adherence.ts) math stays honest — otherwise the recap retroactively re-writes history every time you swap, and the planned-vs-actual signal collapses.

## Goals

1. **Two primitives, both single-day.** `swap` (A↔B exchange between two days) and `replace` (one day's session type changes). Chain shifts are out.
2. **Two surfaces, one mutation.** Strength tab inline edit (durable home for week management) + morning brief chip (fast path for today-only swaps). Both POST to the same endpoint with the same body shape.
3. **Deterministic conflict warning.** "Identical session type within 48h" check. Soft warning, override allowed. No muscle-group overlap matrix in v1.
4. **Coach-initiated swap is code-driven, not AI-driven.** When the brief's `band === 'low'` and today's session isn't already REST/Mobility, the assembler emits a `coach_suggestion` field that renders as a chip below the brief. Deterministic trigger; no extra AI call.
5. **Honest audit.** First mid-week edit snapshots the original `session_plan` into a new `original_session_plan` jsonb column. Adherence reads `coalesce(original, current)`. Sunday recap can distinguish "swapped" from "missed" from "as planned".
6. **No new AI tools, no new propose/commit pair.** Swap is a direct mutation. The existing `propose_week_plan` / `commit_week_plan` flow stays scoped to full-week planning.

## Non-Goals

- **Chain shifts** (push Tue→Wed→Thu→…). Almost always better expressed as two replaces or a re-plan-the-week.
- **Muscle-group conflict matrix** (push/pull overlap). v1 conflict check is exclusively "identical session type within 48h". Push-push (Chest then Shoulders) is allowed without warning.
- **Coach chat command for swaps** (`propose_day_swap` / `commit_day_swap`). Both surfaces hit one direct mutation endpoint; the chat tool is over-engineering for an operation expressible as two taps.
- **Future-week swap UI from the brief.** Brief chip is today-only. Future-week swaps go through the strength tab.
- **Coach-suggested swaps for non-low readiness.** v1 trigger is strictly `band === 'low' && session.type !== 'REST' && session.type !== 'Mobility'`. "Moderate but slept poorly" cases defer to v1.1.
- **Intermediate swap history.** Original commitment + final state are preserved. Mid-week ping-pongs (Chest → Mobility → Back) lose the Mobility step.
- **Swap-undo button.** Swap back manually via the same UI. Identity-restore (A→B→A) cleans up `original_session_plan` automatically (see Edge Cases).
- **Multi-user generalization.** Single-user app.

## Architecture overview

Single mutation endpoint, two UI surfaces, one deterministic trigger feeding the morning brief.

```
                         ┌───────────────────────────────────────────┐
                         │ POST /api/training-weeks/[week_start]/swap │
                         │                                            │
                         │  body: { action: 'swap'|'replace',         │
                         │          source_day, target_day_or_type }  │
                         │  query: ?confirm=true|false                │
                         │                                            │
                         │  pure compute → conflict check →           │
                         │  COALESCE-on-first-edit UPDATE             │
                         └───────────────────────────────────────────┘
                                      ▲                ▲
                                      │                │
                         ┌────────────┘                └─────────────┐
                         │                                            │
              ┌──────────┴──────────┐                       ┌────────┴────────┐
              │ Strength tab        │                       │ Morning brief   │
              │ DaySwapSheet        │                       │ BriefCoachSugg. │
              │                     │                       │                 │
              │ tap day row         │                       │ chip when       │
              │ → action picker     │                       │ band==='low'    │
              │ → target picker     │                       │ && session not  │
              │ → confirm (or warn) │                       │   REST/Mobility │
              │                     │                       │                 │
              │ ?confirm=false then │                       │ ?confirm=true   │
              │   true on override  │                       │   unconditional │
              └─────────────────────┘                       └─────────────────┘
```

Three principles:

1. **Server owns the conflict rule.** Both surfaces ask the server "would this conflict?" rather than computing it client-side. Avoids drift; lets the rule evolve in one place.
2. **Audit lives in one nullable column.** `original_session_plan` is NULL on never-edited rows and set on first edit. Adherence reads `coalesce(original, current)`. Cheaper than a swap_log table; honest enough for the use case.
3. **Brief snapshot stays frozen; chip state is derived.** Brief's `ui` jsonb in DB is written once at intake time and never rewritten on swap. The chip's acknowledged state is derived client-side from `training_weeks.session_plan[today] !== brief.session.type`. Scrolling back to past briefs shows the original prescription with a strikethrough.

## Schema

### Migration `0012_schedule_flexibility.sql` (new)

```sql
-- 0012_schedule_flexibility.sql — schedule flexibility
--
-- One nullable column on training_weeks to capture the originally committed
-- session_plan on first mutation. Adherence math reads
-- coalesce(original_session_plan, session_plan) so swaps don't retroactively
-- flatter recap numbers.

alter table public.training_weeks
  add column if not exists original_session_plan jsonb;

comment on column public.training_weeks.original_session_plan is
  'Snapshot of session_plan at the moment of the first mid-week edit. NULL on rows that have never been edited. Set by the /swap endpoint on first mutation; never updated thereafter. Reset to NULL when an identity-restore swap returns session_plan to the original state. Adherence reads coalesce(original_session_plan, session_plan).';
```

No new tables, no new RLS policies (existing `training_weeks self` policy covers the new column).

### TypeScript types (added to [lib/data/types.ts](../../../lib/data/types.ts))

```ts
// On TrainingWeek:
//   + original_session_plan: SessionPlanMap | null;

export type SwapAction = 'swap' | 'replace';

export type SwapConflict = {
  day: Weekday;             // the day with the new placement
  neighbor_day: Weekday;    // the adjacent day causing it
  session_type: string;     // the type that would be duplicated
};

export type SwapBody =
  | { action: 'swap';    source_day: Weekday; target_day: Weekday }
  | { action: 'replace'; source_day: Weekday; session_type: string };

export type SwapResult = {
  week: TrainingWeek;
  swap: { source_day: Weekday; action: SwapAction; before: string; after: string };
};

// On MorningBriefCard:
//   + coach_suggestion: MorningBriefCoachSuggestion;

export type MorningBriefCoachSuggestion =
  | { kind: 'swap_to_mobility'; rationale: 'low_readiness' }
  | null;

// On AdviceFlags:
//   + coach_swap_suggested: boolean;
```

The "acknowledged" state (chip shows "✓ Swapped to Mobility at 8:42") is *not* a stored variant of `MorningBriefCoachSuggestion`. It's derived client-side from `training_weeks.session_plan[today] !== brief.session.type` plus the `updated_at` timestamp on the training_weeks row.

## Mutation endpoint

### `POST /api/training-weeks/[week_start]/swap` (new)

**Body** (see `SwapBody` above):

```ts
// Action 'swap':    exchange source_day and target_day
// Action 'replace': set source_day to session_type
```

**Query string:** `?confirm=true|false` (default `false`). Controls the conflict gate.

**Server flow:**

1. **Auth.** `requireUser()`.
2. **Load.** `select * from training_weeks where user_id = ? and week_start = ?`. 404 if missing.
3. **Validate.**
   - `week_start` matches the path param (parse from path, not body).
   - `source_day` (and `target_day` if action='swap') are valid `Weekday` strings.
   - For `replace`: `session_type` is in the closed set `Object.keys(SESSION_PLANS) ∪ {'REST', 'Mobility'}`.
   - Reject otherwise with 400 + reason.
4. **Compute new plan** via `applySwap(current_plan, body)` (pure function in [lib/training-weeks/apply-swap.ts](../../../lib/training-weeks/apply-swap.ts)).
5. **Identity check.** If `new_plan` deep-equals `current_plan` → 200 no-op (no write, no conflict check). Includes "swap a day with itself" and "replace with the same type."
6. **Conflict check** via `detectConflicts(new_plan, body)`:
   - For `action: 'swap'`, check both endpoints. For `action: 'replace'`, check only `source_day`.
   - At each checked day `D`: compare `new_plan[D]` against `new_plan[D-1]` and `new_plan[D+1]` using `readSessionForDay`. Equal session types → conflict, unless the type is `'REST'` or `'Mobility'` (always exempt).
7. **Conflict gate:**
   - `?confirm=false` AND conflicts non-empty → return `409 { conflicts: SwapConflict[], preview_plan: SessionPlanMap }`. No write.
   - Otherwise → proceed to write.
8. **Identity-restore detection.** If `current_row.original_session_plan IS NOT NULL` AND `new_plan` deep-equals `current_row.original_session_plan` → set `original_session_plan = NULL` in the update (the row is back to its committed state; audit can clear).
9. **Write.** Single UPDATE:

   ```sql
   update training_weeks
     set session_plan = $new_plan,
         original_session_plan = case
           when $is_identity_restore then NULL
           else coalesce(original_session_plan, session_plan)
         end,
         updated_at = now()
     where user_id = $user_id and week_start = $week_start
     returning *;
   ```

   Two guarantees from this shape: `original_session_plan` is set on the first edit and never re-written on subsequent edits (COALESCE no-op), and it's cleared on identity-restore.

10. **Response.** `200 { week: TrainingWeek, swap: { source_day, action, before, after } }`. The `before`/`after` strings are the session-type names at `source_day` pre/post. For `action: 'swap'`, `after` is what's now at `source_day` (i.e., the previous `target_day` value).

### Pure helper: [lib/training-weeks/apply-swap.ts](../../../lib/training-weeks/apply-swap.ts) (new)

Exports two pure functions:

```ts
export function applySwap(plan: SessionPlanMap, body: SwapBody): SessionPlanMap;
export function detectConflicts(plan: SessionPlanMap, body: SwapBody): SwapConflict[];
```

Both must handle the dual-key convention from [session-plan-reader.ts](../../../lib/coach/session-plan-reader.ts) — `session_plan` may use 3-letter or full-name weekday keys depending on whether the AI planner wrote it or a future normalization migration runs. Conflict checks use `readSessionForDay`; writes preserve whichever key form is already present in the plan.

### Adherence change

[lib/coach/adherence.ts](../../../lib/coach/adherence.ts) — two small changes:

**1. Read path:**

```ts
// Before
const plannedByDay = week.session_plan;

// After
const plannedByDay = (week.original_session_plan ?? week.session_plan);
```

**2. Per-day output grows a `swapped` field** so the `compute_adherence` chat tool's return struct lets the AI distinguish swapped from missed:

```ts
// Per-day adherence result shape
{
  day: Weekday,
  planned: string,                        // from original_session_plan (or session_plan if never edited)
  swapped_to: string | null,              // session_plan[day] when it differs from planned; else null
  actual: WorkoutSummary | null,          // from workouts (existing)
  status: 'as_planned' | 'swapped' | 'missed' | 'rest',
}
```

`status` is derived: `'rest'` if planned ∈ {REST}; `'as_planned'` if actual workout matches planned type; `'swapped'` if swapped_to non-null AND actual matches swapped_to (or is null on rest-swap); `'missed'` otherwise.

`compute_adherence` chat tool inherits this. The AI can now say "you planned Chest, swapped to Mobility, did the walk" rather than just "Tuesday: planned Chest, did nothing." Sunday recap math (planned-vs-actual count, per-muscle volume deltas) anchors to the original commitment regardless of mid-week swaps. Volume math comes from `workouts`, not `session_plan`, so it's untouched.

## Surfaces

### Surface 1 — Strength tab inline edit ([WeekPlanCard.tsx](../../../components/coach/WeekPlanCard.tsx))

Day rows become tappable. Tap "Tuesday · Chest" → bottom sheet (`<DaySwapSheet />`, new component).

**Sheet states:**

```
Step 1: action
─────────────────────────────
Tuesday · Chest
─────────────────────────────
[ Swap with another day → ]
[ Replace this day → ]
─────────────────────────────
[ Cancel ]
```

```
Step 2a (action='swap'): target day picker
─────────────────────────────
Tuesday · Chest → which day?
─────────────────────────────
[ Mon · Legs ]
[ Wed · Mobility ]
[ Thu · Back ]
[ Fri · Shoulders ]
[ Sat · REST ]
[ Sun · REST ]
─────────────────────────────
[ ← Back ]
```

```
Step 2b (action='replace'): session-type picker
─────────────────────────────
Tuesday · what should it be?
─────────────────────────────
[ Legs ]
[ Back ]
[ Shoulders ]
[ Arms ]
[ Mobility ]
[ REST ]
─────────────────────────────
[ ← Back ]
```

(The current `session_plan[day]` value is filtered from the replace list — e.g., if Tuesday is currently Mobility because of an earlier swap, "Mobility" is hidden; the original "Chest" is shown so the user can swap back via identity-restore.)

```
Step 3: confirm
─────────────────────────────
Confirm
─────────────────────────────
Tuesday · Chest → Mobility
─────────────────────────────
[ Confirm ]
[ ← Back ]
```

**Conflict path:** confirm sheet POSTs with `?confirm=false`. On `409 { conflicts, preview_plan }`, the sheet swaps to a warning state:

```
─────────────────────────────
⚠ Heads up
─────────────────────────────
Wednesday is already Legs.
Tuesday + Wednesday would be back-to-back Legs.
─────────────────────────────
[ Swap anyway ]   ← re-POST with ?confirm=true
[ Pick a different target ]  ← back to step 2
```

**Optimistic update:** the TanStack mutation hook `useSwapTrainingDay` flips `session_plan` in the cache immediately on POST start; rollback on error. WeekPlanCard re-renders instantly.

**Scope:** the sheet operates on the **current week's** WeekPlanCard. Next-week planning still flows through the existing `plan_week` chat ritual.

### Surface 2 — Morning brief chip

**Trigger (deterministic, in [lib/morning/brief/assembler.ts](../../../lib/morning/brief/assembler.ts)):**

```ts
function pickCoachSuggestion(
  band: ReadinessBand,
  sessionType: string,
  hasTrainingWeek: boolean,
): MorningBriefCoachSuggestion {
  if (!hasTrainingWeek) return null; // no row to mutate; chip would 404 on POST
  if (band === 'low' && sessionType !== 'REST' && sessionType !== 'Mobility') {
    return { kind: 'swap_to_mobility', rationale: 'low_readiness' };
  }
  return null;
}
```

The `hasTrainingWeek` gate is critical: if the user hasn't committed a week (the brief falls back to `WEEKLY_SESSIONS`), there's no `training_weeks` row to mutate, so the chip's POST would 404. Pass `inputs.trainingWeek != null` from `data-sources.ts` through the assembler.

**Rendering** (new sub-component `<BriefCoachSuggestion />`, sits below `<BriefTonight />` in [MorningBriefCard.tsx](../../../components/morning/MorningBriefCard.tsx)):

```
┌──────────────────────────────────────────────────┐
│ Coach suggestion                                  │  ← warningSoft background
│ Your readiness is low — swap to Mobility today?   │
│                                                   │
│ [ Swap to Mobility ]   [ Keep Chest ]             │
└──────────────────────────────────────────────────┘
```

Tap [Swap to Mobility] → POST `?confirm=true` (brief chip skips the conflict gate; at 7am the explicit low-readiness signal trumps a 48h neighbor warning).

On success, the chip transitions to the **acknowledged** state (derived client-side, not stored):

```
┌──────────────────────────────────────────────────┐
│ ✓ Swapped to Mobility at 8:42 — see /strength    │
└──────────────────────────────────────────────────┘
```

The brief's `ui.coach_suggestion` jsonb in the DB is NOT rewritten. The acknowledged banner appears whenever `training_weeks.session_plan[today] !== brief.session.type` AND `brief.coach_suggestion?.kind === 'swap_to_mobility'`. Time shown is `training_weeks.updated_at` (formatted HH:mm in user TZ).

Tap [Keep Chest] → chip dismisses locally for the session. No DB write.

### Frozen-snapshot treatment for swapped sessions

When the brief's frozen `session.type` differs from the live `training_weeks.session_plan[today]`:

- The "Today · Chest · 13:00" header in `<BriefSessionList />` renders with strikethrough on the session type.
- The exercise list stays visible but muted (`textFaint` color, reduced opacity).
- A small "Swapped to Mobility — open /strength for details" footer appears at the bottom of the session block.

Scrolling back tomorrow shows: the original prescription (struck through, muted), the swap acknowledgment (with timestamp), and the rationale prose in the Advice block. The brief is a *journal* of what you were told and what you did with it — not a live read of current state.

## AdviceFlags integration

The brief generates Advice prose via one Anthropic Haiku call. To prevent prose-vs-chip contradictions (chip says "swap"; prose says "push through"), the advice prompt is told the chip is visible.

**[lib/morning/brief/flags.ts](../../../lib/morning/brief/flags.ts) — add `coach_swap_suggested`:**

```ts
// On AdviceFlags:
//   + coach_swap_suggested: boolean;

// In computeAdviceFlags:
//   coach_swap_suggested: card.coach_suggestion?.kind === 'swap_to_mobility',
```

**[lib/morning/brief/advice-prompt.ts](../../../lib/morning/brief/advice-prompt.ts) — add prompt clause** (alongside existing flag rules):

```
- If coach_swap_suggested is true: a "Swap to Mobility" chip is already visible
  to the athlete. Your Advice should explain WHY mobility makes sense today —
  which readiness signals fired (HRV vs baseline, recovery, score). DO NOT
  re-decide whether to swap. DO NOT prescribe weights for the currently-named
  session. DO NOT mention the eating windows pegged to the original session
  start time — if they swap, the workout-anchored timing no longer applies;
  fall back to a 4-meal protein distribution.
```

With this clause, prose becomes the rationale layer for the chip. If the athlete taps [Keep Chest], the prose still reads sensibly because it's explaining the band — not insisting on a decision.

## Sunday recap signal

There is no dedicated Sunday recap UI component in v1; adherence is surfaced **conversationally** via the `compute_adherence` chat tool during the RECAP beat of `plan_week` mode (see [CLAUDE.md](../../../CLAUDE.md) and [lib/coach/planning-prompts.ts](../../../lib/coach/planning-prompts.ts)).

The signal lives in the tool's enriched per-day output (see the Adherence change section above). The AI naturally produces prose like:

> "You committed to Chest on Tuesday but swapped to Mobility — looked like a smart call given Monday's HRV dip. Otherwise you hit 3/4 planned strength sessions, missed Thursday's Back."

No new UI; the planned-vs-swapped-vs-actual distinction comes through in the coach's voice. If a v1.1 dedicated recap card is ever built, it consumes the same `status` field — the data shape is the durable surface.

## Concurrency & edge cases

- **Workout already logged for the swapped day.** Swap is a planning operation; it never touches the `workouts` table. If you trained Chest at 7am and swap to Mobility at 8am, `workouts[today]` still holds the chest session. Adherence reads `original_session_plan ?? session_plan` = "planned Chest" + `workouts` = "did Chest" → 100% to original. The swap is essentially a no-op in retrospect, which is correct.

- **Swap-then-unswap (identity restore).** Tue Chest → Mobility → Chest. First swap sets `original = Chest`, `session_plan = Mobility`. Second swap detects `new_plan` deep-equals `original_session_plan` → resets `original_session_plan` to NULL. Audit returns to clean state. The user does not appear in Sunday recap as "swapped Tuesday this week".

- **Two swaps on the same day (intermediate lost).** Tue Chest → Mobility → Back. First sets `original = Chest, session_plan = Mobility`. Second leaves `original = Chest` (COALESCE no-op) and sets `session_plan = Back`. Mobility step is lost. Acceptable per Non-Goals.

- **Concurrent brief chip + strength tab tap.** Two POSTs hit the endpoint. Both write; second wins. Idempotent in shape (same column, same row). TanStack invalidation (`queryKeys.trainingWeek.detail(week_start)`, `queryKeys.morningBrief.detail(today)`) on response ensures both surfaces converge to the second write's state.

- **Stale brief chip.** Brief was generated when today's session was Chest. You navigate to /strength, swap Chest → Mobility manually, return to chat. The brief's coach_suggestion derives client-side: `training_weeks.session_plan[today] !== brief.session.type` → true → chip transitions to acknowledged. No DB write needed; the derivation is reactive.

- **Brief chip on a REST day.** `pickCoachSuggestion` returns null; chip doesn't render. Acknowledged state never appears because there's nothing to swap.

- **Missing `training_weeks` row** for the week. POST would 404. The chip's trigger explicitly gates on `hasTrainingWeek` (passed from `data-sources.ts` `trainingWeek != null`), so the chip never renders in this state. The user's only path to a swap is to first commit a week via the `plan_week` chat ritual. WeekPlanCard tappable rows also gate on having a week — they only render when `useTrainingWeek` returns a row.

## Files

### New (6)

```
supabase/migrations/0012_schedule_flexibility.sql

app/api/training-weeks/[week_start]/swap/route.ts

lib/training-weeks/apply-swap.ts          # pure: applySwap() + detectConflicts()
lib/query/hooks/useSwapTrainingDay.ts     # TanStack mutation hook, both surfaces share it

components/strength/DaySwapSheet.tsx
components/morning/BriefCoachSuggestion.tsx
```

### Modified (8)

```
lib/data/types.ts                          # + original_session_plan, SwapAction, SwapBody, SwapConflict, SwapResult, MorningBriefCoachSuggestion, coach_suggestion field, coach_swap_suggested flag
lib/coach/adherence.ts                     # one-line: coalesce(original_session_plan, session_plan)
components/coach/WeekPlanCard.tsx          # tappable day rows mount DaySwapSheet
components/morning/MorningBriefCard.tsx    # mount BriefCoachSuggestion below BriefTonight; strikethrough BriefSessionList when training_weeks.session_plan[today] !== card.session.type
lib/morning/brief/assembler.ts             # + pickCoachSuggestion(band, sessionType)
lib/morning/brief/flags.ts                 # + coach_swap_suggested derived from coach_suggestion
lib/morning/brief/advice-prompt.ts         # + prompt clause for coach_swap_suggested
CLAUDE.md                                  # + 0012 migration entry; one bullet on schedule flexibility under Coach/AI
```

### Untouched

- [lib/coach/tools.ts](../../../lib/coach/tools.ts) — no new propose/commit pair; swap doesn't go through chat tools in v1.
- [lib/morning/brief/data-sources.ts](../../../lib/morning/brief/data-sources.ts) — brief inputs unchanged; `coach_suggestion` derives from already-fetched band + session.
- [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts), `SESSION_PLANS` — read for the replace-target list; not modified.
- Strong / Withings / WHOOP sync paths — unrelated.
- Weekly planning chat (`plan_week` mode) — unchanged; still commits the Sunday plan, swap operates on it post-commit.

## Verification

Per [CLAUDE.md](../../../CLAUDE.md): no test runner. Verification is `npm run typecheck` + targeted probe scripts (created → run → deleted, not committed) + manual smoke.

### Probe scripts

1. **`scripts/probe-apply-swap.mjs`** — exercises `applySwap()` and `detectConflicts()` against fixtures:
   - `swap(Tue, Fri)` → keys exchanged, other days untouched
   - `replace(Tue, 'Mobility')` → only Tuesday changed
   - `swap(Tue, Tue)` → identity (returns input unchanged)
   - `replace(Tue, current_type)` → identity
   - `detectConflicts` for `replace(Tue, 'Legs')` when Wed is Legs → returns one conflict
   - REST/Mobility exempt: `replace(Tue, 'Mobility')` next to Mon=Mobility → no conflict

2. **`scripts/probe-swap-endpoint.mjs`** — exercises the route handler against a fresh `training_weeks` row:
   - First swap: `original_session_plan` populated from pre-swap state; `session_plan` updated.
   - Second swap on same row: `original_session_plan` unchanged; `session_plan` updated.
   - Identity-restore (A→B→A): `original_session_plan` reset to NULL.
   - Conflict + `?confirm=false`: 409 with `{ conflicts, preview_plan }`, no DB write (verify via SELECT).
   - Conflict + `?confirm=true`: writes despite conflict.
   - 404 for missing `(user_id, week_start)`.
   - Invalid `session_type` in replace body → 400.

3. **`scripts/probe-coach-suggestion.mjs`** — exercises `pickCoachSuggestion()`:
   - `band: 'low', session: 'Chest'` → swap_to_mobility
   - `band: 'low', session: 'REST'` → null
   - `band: 'low', session: 'Mobility'` → null
   - `band: 'moderate', session: 'Chest'` → null
   - `band: 'high', session: 'Chest'` → null

4. **`scripts/probe-adherence-coalesce.mjs`** — synthetic week to verify the COALESCE is in place:
   - Commit week plan with strength sessions Mon/Tue/Thu
   - Insert workouts on Mon and Thu (Tue missed)
   - Compute adherence → 2/3 strength sessions hit
   - Swap Tue Chest → Mobility via the endpoint
   - Re-compute adherence → SAME 2/3 (Tue still counts as missed against original)
   - If COALESCE were absent, post-swap adherence would jump to 2/2 (Mobility done = no strength session expected). Stability at 2/3 proves the read.

### Type & build checks

- `npm run typecheck` clean
- `npm run build` succeeds

### Manual smoke

**Path 1 — User-initiated swap (Surface 1, strength tab):**

1. Navigate to `/strength`. WeekPlanCard renders current week.
2. Tap "Tuesday · Chest". DaySwapSheet opens.
3. **Swap path:** [Swap with another day] → "Wednesday · Mobility" → [Confirm]. WeekPlanCard re-renders: Tue=Mobility, Wed=Chest. Optimistic flip is instant.
4. **Replace path:** Tap Thursday → [Replace this day] → "Mobility" → [Confirm]. Thu=Mobility.
5. DB check: `select original_session_plan, session_plan from training_weeks where week_start = '<this week>'` — both populated, original = pre-swap state, session_plan = post-swap.

**Path 2 — Conflict warning:**

1. Set up: synthetic conflict by ensuring two adjacent days share a session type after the operation.
2. Pick a target that creates an identical-type neighbor.
3. Confirm sheet POSTs `?confirm=false` → 409 → sheet swaps to warning state.
4. [Swap anyway] → POST `?confirm=true` → succeeds.
5. Verify [Pick a different target] returns to step 2.

**Path 3 — Coach-initiated swap (Surface 2, brief chip):**

1. Manually set today's `daily_logs.hrv` low (below `whoop_baselines.hrv_swc_low`) and `checkins.readiness` to 4 so `band === 'low'` derives.
2. Trigger morning intake to completion → brief generates with `coach_suggestion: { kind: 'swap_to_mobility', ... }`.
3. Brief renders with the yellow chip below BriefTonight: "Coach suggestion: swap to Mobility today?"
4. Advice prose explains *why* (references band-low signals), does NOT re-decide; eating section falls back to 4-meal distribution (no workout-anchored timing).
5. Tap [Swap to Mobility]. POST `?confirm=true`. Chip transitions to "✓ Swapped to Mobility at HH:mm — see /strength".
6. BriefSessionList still renders original Chest exercises with strikethrough/muted treatment.
7. Navigate to `/strength`. TodayPlanCard shows Mobility prescription. WeekPlanCard's Tuesday row shows "Mobility" with swap indicator.
8. Close and reopen chat → scroll to today's brief. Chip still shows acknowledged state (derived client-side). Strikethrough persists.

**Path 4 — Swap-then-unswap (audit reset):**

1. From Path 3 state (today swapped to Mobility, `original_session_plan` populated).
2. Open /strength, tap today's row, [Replace] → "Chest" (back to original).
3. DB check: `original_session_plan IS NULL`, `session_plan[today] = 'Chest'`. Audit clean.

**Path 5 — Adherence sanity (run on Sunday after a real swap week):**

1. Open `/coach`, ask "how did this week go?". Coach calls `compute_adherence`.
2. Tool result: per-day list shows swapped days as `planned: Chest, swapped: Mobility, actual: <whatever>`. Adherence count anchors to original commitments.
3. Volume deltas vs prior-4w-avg unaffected by swaps (volumes from `workouts`, not `session_plan`).

### Cost verification

Zero new AI calls in v1. The brief's existing single Haiku call covers the rationale prose for the chip via the prompt addition (no second pass). The user-initiated path is purely deterministic.

## Implementation handoff

Estimated scope: ~14 tasks, single PR. Build order (each step independently typecheckable):

1. Migration `0012` + CLAUDE.md entry (apply via `supabase db push` per the linked-CLI workflow)
2. Type additions in `lib/data/types.ts`
3. `lib/training-weeks/apply-swap.ts` (pure compute + conflict detection) + probe script
4. `POST /api/training-weeks/[week_start]/swap` route handler + probe script
5. Adherence one-line change + probe script
6. `useSwapTrainingDay` TanStack mutation hook
7. `DaySwapSheet` component (step 1 → step 2 → confirm/warn states)
8. Wire `WeekPlanCard` tappable rows to `DaySwapSheet`
9. `pickCoachSuggestion()` in `assembler.ts` + type additions + probe script
10. `coach_swap_suggested` flag in `flags.ts` + prompt clause in `advice-prompt.ts`
11. `BriefCoachSuggestion` component (chip → acknowledged states, derived client-side)
12. Mount in `MorningBriefCard`; add strikethrough to `BriefSessionList` when swapped
13. Sunday recap UI signal (`Chest → Mobility` arrow form)
14. End-to-end manual smoke (Paths 1–5) + CLAUDE.md polish

No external dependencies, no env vars added, no cron changes, no new RLS policies.

After implementation, the v1.1 backlog candidates (not in scope for this spec):
- Muscle-group overlap matrix (push/pull/squat/hinge) for the conflict check
- Coach chat command (`propose_day_swap` / `commit_day_swap`)
- Coach-suggested swaps for non-low readiness (poor sleep, missed protein streaks)
- Swap-undo button
- Multi-day "skip today, push everything one day" chain operation
- Intermediate swap history (per-edit log table)

Once this spec is approved, run `/writing-plans` with it as input to produce the task-by-task implementation plan.
