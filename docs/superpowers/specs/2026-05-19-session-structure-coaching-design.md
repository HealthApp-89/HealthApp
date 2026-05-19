# Session-structure coaching — design

**Date:** 2026-05-19
**Status:** Spec
**Branch:** TBD (likely `feat/session-structure`)
**Triggered by:** Today's chest/shoulder session ending with push-ups after chest/shoulder/triceps were already fatigued — bad ordering, no rest prescription, no fatigue cue. Coach Carter today has no encoded knowledge of intra-session structure.

## Problem

The app prescribes session content (`SESSION_PLANS` static map, plus AI-committed `training_weeks.session_plan` for session-type-per-day) but says nothing about **how** to execute a session:

- No rest prescription between sets or between exercises.
- No exercise-order rationale — bodyweight-to-failure movements can end up as a finisher on already-fatigued primary muscles (today's push-ups-after-pushdowns).
- No RPE / RIR target per set or per exercise.
- No fatigue management cues — the user gets the same prescription whether they're CNS-fresh or coming off a heavy back day.

Coach Carter's system prompt has zero bodybuilding-specific session-structure knowledge. He cites concrete numbers when asked, but he has nothing to cite for "how much rest between sets" or "should push-ups be at the end".

This spec encodes that expertise as **deterministic rules** that annotate any prescribed session with rest, RPE, fatigue tier, and ordering warnings — surfacing in the morning brief and the strength tab.

## Scope

**In scope (v1):**
1. New rule-engine module `lib/coach/session-structure/` producing annotated session output from any `PlannedExercise[]`.
2. New `training_weeks.exercise_overrides jsonb` column persisting per-weekday reorders.
3. Morning brief integration — every prescribed exercise carries rest/RPE chip; ordering warnings surface as a banner with inline diff + "Apply reorder" button.
4. Strength tab integration — same annotations + same banner via shared component.
5. Reorder endpoint `POST /api/training-weeks/[week_start]/exercise-overrides`.
6. `DEFAULT_SYSTEM_PROMPT` augmentation so Carter cites brief-computed rest/RPE values in chat.
7. **One-shot fix to the static `SESSION_PLANS.Chest`**: move OHP from slot 5 to slot 2 (right after Decline Bench, the canonical `BIG_FOUR`-leads-pattern order), and drop the now-redundant `note: "Do BEFORE Incline DB"` on OHP. The current static order already documents this intent manually; the rule engine codifies it, so the static plan should land in the corrected order. The rule engine still earns its keep on AI-committed `session_plan` orderings + future user reorderings.

**Out of scope (deferred):**
- Readiness-based rest scaling (low-recovery day → +30s rest).
- Per-set adaptive RPE based on last week's e1RM.
- Rest-timer countdown UI in the strength tab.
- Pre-exhaust auto-detection beyond a tag on `PlannedExercise.note`.
- Weekly review surfacing of ordering-violation history.
- AI-generated session-structure narrative (the rule engine is the single source of truth; Carter reads it, doesn't fabricate).

## Bodybuilding-expert rule framework

### Fatigue tier (orthogonal to existing `EXERCISE_CATEGORY`)

| Tier | Definition | Examples (user's gym) |
|---|---|---|
| 0 | Mobility / warm-up ramp-up | Mobility plan items; any `PlannedExercise.warmup=true` row |
| 1 | Heavy compound, CNS-taxing | Squat, Deadlift, Decline Bench, OHP (the `BIG_FOUR`) |
| 2 | Secondary compound | Incline DB Press, Leg Press, RDL, Lat Pulldown, Seated Row, Pullover |
| 3 | Isolation | Chest Fly, Lateral Raise, Triceps Pushdown, Leg Extension, Leg Curl, Calf Raise, Shrug, Hip Abductor |
| 4 | Bodyweight to-failure / finisher | Push-up (non-warmup), bodyweight Dip, Back Extension (bodyweight), abs work |

Lookup is static, keyed on normalized exercise name (lowercase, parens stripped — same `normalize()` from [lib/coach/exercise-categories.ts](../../../lib/coach/exercise-categories.ts)). Unknown names fall back to a heuristic: `accessory` category → tier 3, `core` → tier 3, otherwise tier 2.

### Ordering rules

Violations produce a `OrderingWarning` and contribute to the suggested reorder.

1. **Tier ascending** — within a session, tiers go 0 → 1 → 2 → 3 → 4. Any tier-4 movement appearing before tier-1/2/3 (other than a `warmup=true` row) is a violation.
2. **No bodyweight finisher on a pre-fatigued primary muscle** — a tier-4 movement whose primary muscle (via `EXERCISE_MUSCLES.primary`) overlaps with any earlier tier-2/3 exercise's primary muscle is a violation. *Today's push-ups-after-pushdowns case.*
3. **`BIG_FOUR` first within a movement pattern** — a `BIG_FOUR` member must appear before any non-`BIG_FOUR` exercise sharing the same `EXERCISE_CATEGORY` bucket.
4. **Pre-exhaust exception** — `PlannedExercise.note` containing the substring `"pre-exhaust"` (case-insensitive) opts that exercise out of rule 1. Allows intentional fly-before-bench prescriptions.

### Rest periods (per exercise)

| Tier | Reps prescribed | Rest range |
|---|---|---|
| 1 | ≤ 5 (strength) | 3–5 min |
| 1 / 2 | 6–12 (hypertrophy) | 2–3 min |
| 3 | 8–15 (isolation) | 60–120 s |
| 4 / metabolic | AMRAP | 30–60 s |
| 0 | warm-up ramp | 30–60 s |

Tier 1 with reps > 12 falls into the tier-2/hypertrophy row. Tier 2 with reps ≤ 5 borrows the tier-1 strength range.

### RPE / RIR targets

When `PlannedExercise` doesn't already carry an RPE prescription:

- Tier 1: `"7–8 across sets, top set 8–9"` (1–2 RIR by the top set).
- Tier 2: `"7–9 (1–3 RIR)"`.
- Tier 3: `"8–10, last set near failure (0–1 RIR)"`.
- Tier 4: `"AMRAP / RPE 10"`.

### Cue text per warning

Generated from a template per rule:

- Rule 1: `"{exercise} is a tier-{n} finisher placed before tier-{m} work. Move to the end or earlier as warm-up."`
- Rule 2: `"Pre-fatigue from {related_exercise} — expect ~15% strength drop on {exercise}. Move to warm-up or substitute a non-overlapping movement."`
- Rule 3: `"{exercise} ({BIG_FOUR_member}) is heavier and CNS-taxing — sequence before {related_exercise}."`

## Architecture

### New module: `lib/coach/session-structure/`

```
lib/coach/session-structure/
  tiers.ts          // getFatigueTier(name, isWarmup) → 0|1|2|3|4
  rules.ts          // pure: findOrderingWarnings(), restPrescription(), rpePrescription()
  reorder.ts        // suggestReorder() — stable sort by tier + BIG_FOUR-first + warmup-anchor
  annotate.ts       // orchestrator: annotateSession(PlannedExercise[]) → SessionStructure
  index.ts          // barrel
```

All pure functions; no I/O, no Supabase, no Anthropic. Inputs are `PlannedExercise[]`; outputs are typed records.

### Output shape

```ts
export type FatigueTier = 0 | 1 | 2 | 3 | 4;

export type AnnotatedExercise = PlannedExercise & {
  fatigue_tier: FatigueTier;
  rest_seconds: { min: number; max: number };
  rpe_target: string;
  cue?: string;
};

export type OrderingWarning = {
  rule:
    | "tier_ascending"
    | "bodyweight_finisher_on_fatigued_muscle"
    | "big_four_first";
  exercise: string;
  related_exercise?: string;
  message: string;
  suggested_action:
    | "move_to_warmup"
    | "swap_with"
    | "substitute"
    | "move_to_end";
};

export type SessionStructure = {
  exercises: AnnotatedExercise[];
  warnings: OrderingWarning[];
  /** Populated iff warnings.length > 0; the proposed reordered list. */
  suggested_order: AnnotatedExercise[] | null;
};
```

### Resolver helper

Extend [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts) (or co-locate in `lib/coach/session-structure/`):

```ts
export type ExerciseOverrides = Record<string /* weekday full name */, PlannedExercise[]>;

export function getEffectiveSessionPlan(
  sessionType: string,
  weekday: string,
  overrides: ExerciseOverrides | null | undefined,
): PlannedExercise[] {
  if (overrides?.[weekday]?.length) return overrides[weekday];
  return SESSION_PLANS[sessionType] ?? [];
}
```

## Data model

Migration `supabase/migrations/0022_exercise_overrides.sql`:

```sql
alter table training_weeks
  add column exercise_overrides jsonb;

comment on column training_weeks.exercise_overrides is
  'Per-day reorder/customization of the static SESSION_PLANS exercise list. Shape: {"Monday": [PlannedExercise...], ...}. NULL means no overrides set; resolver falls through to SESSION_PLANS[session_plan[weekday]]. Written by /api/training-weeks/[week_start]/exercise-overrides.';
```

Notes on shape:
- Key by **full weekday name** (`"Monday"`, not `"Mon"`) — matches what `weekdayInUserTz()` already returns and what the AI planning bot writes per [lib/coach/session-plan-reader.ts](../../../lib/coach/session-plan-reader.ts).
- Value is the **complete** reordered `PlannedExercise[]` for that day. We store the full list (not a permutation index) so the resolver doesn't need to re-merge with the static plan — simpler, less clever, robust to static-plan edits.
- Reorder is **permutation-only** in v1: every exercise name in the override must exist in the static `SESSION_PLANS[type]` for that day. No add/remove.
- TypeScript shape mirrors in [lib/data/types.ts](../../../lib/data/types.ts) on the `training_weeks` row type.

## Brief integration

[lib/morning/brief/index.ts](../../../lib/morning/brief/index.ts) — current path picks the session type and rolls a session block. New path:

1. After resolving session type for today, fetch the active `training_weeks` row for the current week (`week_start = previous Sunday`).
2. Pull `exercise_overrides` from that row.
3. Resolve effective plan: `getEffectiveSessionPlan(sessionType, weekdayInUserTz(), overrides)`.
4. Annotate: `annotateSession(effectiveExercises)` → `SessionStructure`.
5. Embed in the existing `MorningBriefCard.session` block: `session.structure: SessionStructure`.

`MorningBriefCard` TypeScript type grows a `session.structure?: SessionStructure` optional field. Existing renderers without the field still work — the chip + banner just don't render.

Idempotency: the brief is already idempotent per-day. Recompute on retry uses fresh `exercise_overrides`.

## Brief card UI

[components/morning/MorningBriefCard.tsx](../../../components/morning/MorningBriefCard.tsx) — session block:

- **Exercise row trailing chip** — `"3–5 min · RPE 7–8"` shown muted to the right of each exercise's `sets×reps` line. Source: `AnnotatedExercise.rest_seconds` + `rpe_target`.
- **Cue line** — when `AnnotatedExercise.cue` is present, render under the exercise row as a small italic note ("Pre-fatigued from Triceps Pushdown — expect ~15% drop").
- **Reorder banner** — when `warnings.length > 0`, a top-of-section banner in the existing warning color:
  - Headline: `"{warnings.length} issue{s} with order"`.
  - Subhead: per-warning `message` (max 3 shown; "+N more" if exceeded).
  - Expandable inline diff: original order with strike-through, suggested order in green, both rendered as compact lists.
  - **Apply reorder** button → POST to the reorder endpoint, optimistic UI hides the banner, falls back on error.

## Strength tab UI

`/strength` today's-session view — same affordances via a shared component `components/strength/SessionStructureBanner.tsx` that both the brief and the strength page mount. The strength page also renders the per-exercise chip + cue inline with its existing exercise list.

When the user is currently in the middle of logging the workout in Strong (the app), this tab is the reference surface — the rest values are a passive reminder, not an interactive timer (timer is deferred).

## Reorder endpoint

`POST /api/training-weeks/[week_start]/exercise-overrides`:

- Auth: cookie-bound user via `createSupabaseServerClient()`. RLS enforces per-user scoping.
- Path param: `week_start` (YYYY-MM-DD, Sunday).
- Body: `{ weekday: string, exercises: PlannedExercise[] }`.
- Validation:
  - `weekday` must match `^(Monday|Tuesday|...|Sunday)$`.
  - For each item in `exercises`, the `name` must exist in `SESSION_PLANS[sessionTypeForDay]` (resolved via `training_weeks.session_plan[weekday]`). Rejected with 400 on add/remove.
  - `exercises.length` must equal `SESSION_PLANS[sessionType].length` (no drops).
- Upsert: read the existing `training_weeks.exercise_overrides`, merge `{ [weekday]: exercises }`, write back. Other weekdays untouched.
- After write: `revalidatePath("/")` + `revalidatePath("/strength")`.
- Response: `{ ok: true, exercise_overrides: ExerciseOverrides }`.

Errors:
- 404 if no `training_weeks` row for `week_start` (planning not committed yet).
- 400 on validation failure (with field-level message).
- 401 on no-auth.

## Carter chat integration

[lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) — `DEFAULT_SYSTEM_PROMPT` gains a section after the morning-brief-refresh block:

```text
## Session structure

When the user asks about rest periods, exercise ordering, or fatigue
management for today's session, reference the values in the morning
brief's session block — each exercise carries fatigue_tier, rest_seconds,
rpe_target, and possibly a cue. Cite those values verbatim; do not
estimate.

Ordering rules in effect:
  1. Heavy compound (tier 1) → secondary compound (tier 2) → isolation
     (tier 3) → bodyweight finisher (tier 4). Warm-up bodyweight ramps
     (tier 0) at the start.
  2. Bodyweight to-failure movements (push-ups, dips) never end a session
     for a pre-fatigued primary muscle. Today's push-ups are warm-up,
     not finisher.
  3. The BIG_FOUR lifts (Squat, Deadlift, Decline Bench, OHP) lead their
     movement-pattern bucket.

If the user notes an ordering issue and the brief shows a reorder
warning, point them to the "Apply reorder" button — don't suggest
running the swap tool. The reorder chip is the action surface.
```

Note: the user's saved system prompt (`profiles.system_prompt`) overrides the default; this change only takes effect for users on the default prompt. Acceptable — the user has the option to opt in by resetting their prompt or copying the new section in.

## Edge cases

- **No `training_weeks` row for the current week** — happens early Sunday before commit. Resolver returns static `SESSION_PLANS[type]` (no override); brief and strength tab render plain prescription with annotations but no override-related affordances. The reorder endpoint returns 404 in this state.
- **REST day** — `session_plan[weekday] === "REST"`. `SESSION_PLANS["REST"]` does not exist; resolver returns `[]`. Brief's session block already handles rest days; no structure rendered.
- **Mobility day** — `SESSION_PLANS["Mobility"]` exists. Every item is tier 0. No ordering warnings; rest chips show `"30–60 s"`. Acceptable.
- **Reordered plan still has warnings** — `suggestReorder()` is iterative: it reorders, re-runs `findOrderingWarnings()`, asserts zero warnings on the suggested order. If for some reason the suggestion still violates (e.g., a tier-4 movement primary-overlaps every tier-3 in the session — unlikely but possible), it falls back to "no suggestion" and the banner shows warnings without a chip.
- **User edits the static `SESSION_PLANS` post-override** — overrides store full `PlannedExercise[]` (not name lists), so a static-plan edit doesn't break the override. But the override becomes stale: if the static plan bumps `baseKg` on Decline Bench, the override still carries the old value. Acceptable for v1; reorder chip writes carry forward the *current* static fields at write time. If staleness becomes a problem, a future migration regenerates overrides off the latest static plan.
- **Mid-week schedule swap** (existing `swap` endpoint at [app/api/training-weeks/[week_start]/swap/route.ts](../../../app/api/training-weeks/[week_start]/swap/route.ts)) — if the user swaps Monday's session type from Chest to Back, the existing override for Monday (which holds chest exercises) becomes stale. Resolution: the swap endpoint clears `exercise_overrides[weekday]` for swapped days, then re-resolves to the new session type's static plan. Document this in the swap route comments.

## Testing / verification

No test suite. Manual verification:

1. **Migration applies cleanly** — `supabase db push` (or dashboard SQL editor). Verify column exists with default NULL on existing rows.
2. **Static plan is clean** — load `/` on a Chest day; expect rest/RPE chips on every exercise and **no** warnings. With the v1 in-scope OHP reorder applied, `SESSION_PLANS.Chest` is: Push Up [tier 0, warmup] → Decline Bench [tier 1] → OHP [tier 1, `BIG_FOUR`] → Incline DB [tier 2] → Chest Fly [tier 3] → Lateral Raise [tier 3] → Triceps Pushdown [tier 3]. Tier sequence: 0 → 1 → 1 → 2 → 3 → 3 → 3 — strictly non-decreasing. No rule fires. This is the integration-confidence test for the happy path.
3. **Synthetic bad order via SQL** — manually write `exercise_overrides` for today putting Push Up after Triceps Pushdown:
   ```sql
   update training_weeks
   set exercise_overrides = '{"Monday": [...Push Up at end...]}'::jsonb
   where week_start = '...' and user_id = '...';
   ```
   Reload brief — expect rule 2 warning + Apply reorder chip + cue under Push Up.
4. **Apply reorder** — tap the chip; expect override map cleared back to canonical order; banner disappears; chip persists across reloads.
5. **Carter chat** — ask "how much rest on bench today?" — expect "3–5 min" cited verbatim from the brief's annotation, not estimated.
6. **Mobility day** — load brief on Wednesday; expect rest chips of 30–60s, no warnings.
7. **REST day** — load brief on Saturday/Sunday; expect rest-day rendering unchanged.

## Files to create / modify

**New:**
- `supabase/migrations/0022_exercise_overrides.sql`
- `lib/coach/session-structure/tiers.ts`
- `lib/coach/session-structure/rules.ts`
- `lib/coach/session-structure/reorder.ts`
- `lib/coach/session-structure/annotate.ts`
- `lib/coach/session-structure/index.ts`
- `app/api/training-weeks/[week_start]/exercise-overrides/route.ts`
- `components/strength/SessionStructureBanner.tsx`

**Modify:**
- `lib/coach/sessionPlans.ts` — add `getEffectiveSessionPlan()` resolver helper + `ExerciseOverrides` type. Also: reorder `SESSION_PLANS.Chest` to put OHP in slot 2 (after Decline Bench, before Incline DB) and drop the redundant `note` on OHP. Rationale per scope item #7.
- `lib/morning/brief/index.ts` — call resolver + annotate, embed `session.structure`.
- `lib/morning/brief/types.ts` (or wherever `MorningBriefCard` is defined) — `session.structure?: SessionStructure`.
- `components/morning/MorningBriefCard.tsx` — render chip, cue, banner.
- `app/strength/page.tsx` (and its client) — render the chip + banner via shared component.
- `app/api/training-weeks/[week_start]/swap/route.ts` — clear `exercise_overrides[weekday]` for swapped days; document the invariant.
- `lib/coach/system-prompts.ts` — `DEFAULT_SYSTEM_PROMPT` gains the "## Session structure" section.
- `lib/data/types.ts` — `training_weeks` row type adds `exercise_overrides: ExerciseOverrides | null`.
- `CLAUDE.md` — add migration `0022` to the list; add a one-paragraph architecture note under the **Coach / AI** bullet list explaining session-structure.

## Rollout

Single PR. Migration applied via Supabase Dashboard SQL Editor before merging the code (so the column exists when the new resolver tries to read it). Acceptable to ship without UI behind a flag because:
- The override column defaults to NULL → resolver falls through to static plan → existing behavior preserved.
- The chip/banner only render when `session.structure` is present in the brief card payload → older cards render as before.
- The reorder endpoint is opt-in (only triggered by tapping the chip).

No feature flag needed.
