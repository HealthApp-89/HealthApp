# Per-Set RIR + Effort-Aware Debrief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture reps-in-reserve (RIR) per logged set, and make the workout debrief's regression detection effort-aware so a deliberately held-back session (e.g. 2 RIR before padel) is no longer mis-read as a strength regression and prescribed a "drop weight and rebuild."

**Architecture:** Add a nullable `exercise_sets.rir` column and thread it through the logger write path (RPC → payload → draft → UI input), pre-seeding new working sets from the week's `training_weeks.rir_target` so capture happens by default. Then make `lib/coach/derived.ts` expose an *effort-adjusted* e1RM (`epley(kg, min(12, reps + rir))`) alongside the existing raw e1RM, and have the per-lift debrief comparator ([compose-lifts.ts](../../../lib/coach/session-debrief/compose-lifts.ts)) compare effort-adjusted e1RM **only when both the current and prior top set carry RIR** (symmetric guard — falls back to today's raw-vs-raw otherwise). Populate the already-stubbed `rir_today` payload field so the narrative can frame the held-back session correctly.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), Supabase/Postgres (jsonb RPC), React client components, Tailwind v4. No test runner — verification is fixture-based audit scripts (`scripts/audit-*.mjs` via the alias-loader) + `npm run typecheck` + `npm run build`.

## Global Constraints

- **No raw `new Date().toISOString().slice(0,10)` / `getHours()`** — timezone audit gate ([scripts/audit-timezone-usage.mjs](../../../scripts/audit-timezone-usage.mjs)). This feature adds no new "today" computation, but keep the rule in mind if touching date logic.
- **User-visible numbers use `fmtNum()`** from [lib/ui/score.ts](../../../lib/ui/score.ts) — never raw `.toFixed()`. RIR is a small integer; if displayed, still route through `fmtNum`.
- **e1RM math has two existing helpers:** `epley` (in [lib/coach/derived.ts](../../../lib/coach/derived.ts), used by the debrief) and `brzycki`/`bestComparisonValue` (in [lib/coach/e1rm.ts](../../../lib/coach/e1rm.ts), used by block targets/framework). **This plan only touches the `derived.ts`/debrief path.** Do NOT change `e1rm.ts` or `bestComparisonValue` — block-target semantics must stay byte-identical (audited by [scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs) and [scripts/audit-weekly-review-vs-engine.mjs](../../../scripts/audit-weekly-review-vs-engine.mjs)).
- **`rir` is nullable everywhere.** `rir = null` MUST collapse to exactly today's behavior so legacy rows and every other consumer of `topSet`/`epley` are unaffected.
- **Migration applies via `supabase db push`** (CLI is linked). Next free migration number is **0045**.
- **No new test runner.** Pure-function verification goes in an audit script following the `scripts/audit-prescription-rules.mjs` fixture pattern (plain `node --import ./scripts/alias-loader.mjs --experimental-strip-types`).

---

### Task 1: Migration — add `exercise_sets.rir` and extend the commit RPC

**Files:**
- Create: `supabase/migrations/0045_per_set_rir.sql`
- Modify: `supabase/schema.sql:65-74` (add column to the canonical table def)

**Interfaces:**
- Produces: `exercise_sets.rir smallint` (nullable, CHECK 0..10); `commit_logger_session(payload jsonb)` now reads `st->>'rir'` per set.

- [ ] **Step 1: Confirm the current `commit_logger_session` body to copy**

Run: `grep -n "commit_logger_session" supabase/migrations/0026_workout_logger.sql`
Read the full `create or replace function commit_logger_session` body (≈ lines 30–140) — the migration below must re-declare the entire function with the one added line, because Postgres has no partial-function patch.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0045_per_set_rir.sql`:

```sql
-- 0045_per_set_rir.sql
-- Adds reps-in-reserve capture per set. Nullable: null = not recorded (legacy
-- rows + any set the athlete skips). Lights up the effort-aware debrief
-- comparison and the previously-phantom RIR autoregulation signal.

alter table public.exercise_sets
  add column if not exists rir smallint
  check (rir is null or (rir >= 0 and rir <= 10));

comment on column public.exercise_sets.rir is
  'Reps in reserve for this set (0 = to failure). Nullable: null = not recorded. Effort signal for effort-adjusted e1RM in the workout debrief.';

-- Re-declare commit_logger_session to persist rir. Body is identical to
-- 0026 except the exercise_sets INSERT now reads st->>''rir''.
create or replace function public.commit_logger_session(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- ⬇️ PASTE THE FULL 0026 BODY HERE, then change ONLY the exercise_sets INSERT:
--    add `rir` to the column list and `nullif(st->>'rir','')::smallint` to values.
$$;
```

In the pasted body, the `insert into exercise_sets` becomes:

```sql
      insert into exercise_sets (
        exercise_id, set_index, kg, reps, duration_seconds, warmup, failure,
        rest_seconds_actual, rir
      ) values (
        new_exercise_id,
        (st->>'set_index')::int,
        nullif(st->>'kg', '')::numeric,
        nullif(st->>'reps', '')::int,
        nullif(st->>'duration_seconds', '')::int,
        coalesce((st->>'warmup')::boolean, false),
        coalesce((st->>'failure')::boolean, false),
        nullif(st->>'rest_seconds_actual', '')::int,
        nullif(st->>'rir', '')::smallint
      );
```

- [ ] **Step 3: Add the column to the canonical schema file**

Modify `supabase/schema.sql` `exercise_sets` table (after the `failure` line):

```sql
  failure boolean not null default false,
  rir smallint check (rir is null or (rir >= 0 and rir <= 10))
```

(Keep the existing `rest_seconds_actual` column from migration 0026 — confirm whether schema.sql already lists it; match the file's current ordering.)

- [ ] **Step 4: Apply and verify**

Run: `supabase db push`
Then verify: `supabase db execute "select column_name from information_schema.columns where table_name='exercise_sets' and column_name='rir'"` (or check via Dashboard).
Expected: one row, `rir`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0045_per_set_rir.sql supabase/schema.sql
git commit -m "feat(logger): add exercise_sets.rir column + commit_logger_session persists it"
```

---

### Task 2: Type + payload wiring (capture path, no UI yet)

**Files:**
- Modify: `lib/logger/types.ts:7-22` (ExerciseSetDraft), `lib/logger/types.ts:59-78` (CommitSessionPayload)
- Modify: `components/logger/LoggerSheet.tsx` (Props, `makeDraftFromPlan` set seeding, payload map in `commitNow`)
- Modify: `components/logger/ExerciseCard.tsx:82-90` (addSet new-row seeding)
- Modify the 4 LoggerSheet call sites to pass `weekRirTarget` where available: `components/strength/TodayPlanCard.tsx:220`, `components/strength/ScheduleDayRow.tsx:316`, `components/morning/BriefSessionList.tsx:304`, `components/logger/EditSessionButton.tsx:79`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExerciseSetDraft.rir: number | null`; `CommitSessionPayload.exercises[].sets[].rir: number | null`; `LoggerSheet` accepts optional `weekRirTarget?: number | null` (default 2) and seeds non-warmup, non-duration working sets with it.

- [ ] **Step 1: Extend the types**

In `lib/logger/types.ts`, add to `ExerciseSetDraft` (after `failure`):

```ts
  /** Reps in reserve the athlete left on this set (0 = to failure). null =
   *  not recorded. Effort signal for the effort-adjusted e1RM debrief. */
  rir: number | null;
```

And to `CommitSessionPayload.exercises[].sets[]` (after `failure`):

```ts
      rir: number | null;
```

- [ ] **Step 2: Seed new sets with the prescribed RIR**

In `components/logger/LoggerSheet.tsx`, add to `Props`:

```ts
  /** Week-level prescribed RIR (training_weeks.rir_target). Seeds new working
   *  sets so effort is captured by default; athlete edits per set on deviation.
   *  Defaults to 2 (the engine's RP/Helms hypertrophy default) when absent. */
  weekRirTarget?: number | null;
```

Thread it into `makeDraftFromPlan` (add `weekRirTarget: number | null` to its args) and into the set-construction `Array.from` (around line 89). A set's seed RIR:

```ts
        // warmups and duration-based exercises carry no RIR
        rir: (!!p.warmup && j === 0) || p.duration_seconds != null
          ? null
          : (args.weekRirTarget ?? 2),
```

Pass `weekRirTarget: props.weekRirTarget ?? 2` at both `makeDraftFromPlan(...)` call sites in the effect (the fresh-draft branch near lines 210 and 295). Edit mode (`initialDraft`) is untouched — hydrated drafts already carry their stored `rir`.

- [ ] **Step 3: Seed addSet new rows**

In `components/logger/ExerciseCard.tsx` `addSet` (the `next: ExerciseSetDraft` object, ~line 82), add:

```ts
    rir: isTimeBased ? null : (last?.rir ?? exercise.prescribed.duration_seconds != null ? null : 2),
```

Simpler and matching the carry-forward intent — copy the previous set's rir, else fall back to 2 for weighted exercises:

```ts
    rir: isTimeBased ? null : (last?.rir ?? null),
```

Use the carry-forward form (`last?.rir ?? null`): the first N sets were already seeded from `weekRirTarget` in Task 2 Step 2, so a manually-added extra set inherits the previous set's RIR.

- [ ] **Step 4: Map rir into the commit payload**

In `components/logger/LoggerSheet.tsx` `commitNow`, the per-set map (~lines 397-405) gains `rir`:

```ts
      return {
        set_index: s.set_index,
        kg: s.kg,
        reps: s.reps,
        duration_seconds: s.duration_seconds,
        warmup: s.warmup,
        failure: s.failure,
        rest_seconds_actual: restActual,
        rir: s.rir,
      };
```

- [ ] **Step 5: Pass weekRirTarget from call sites that have it**

For each of `TodayPlanCard.tsx`, `ScheduleDayRow.tsx`, `BriefSessionList.tsx`: these already fetch/receive the `training_weeks` row for `weekPrescriptions`/`weekOverrides`. Add `rir_target` to that selection and pass `weekRirTarget={trainingWeek?.rir_target ?? null}` to `<LoggerSheet>`. `EditSessionButton.tsx` may omit it (edit mode ignores seeding). Where a call site does not currently load the training_weeks row, omit the prop — the `?? 2` default applies.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). If a call site errors on a missing `rir` field, add `rir: null` to that literal.

- [ ] **Step 7: Commit**

```bash
git add lib/logger/types.ts components/logger/LoggerSheet.tsx components/logger/ExerciseCard.tsx components/strength/TodayPlanCard.tsx components/strength/ScheduleDayRow.tsx components/morning/BriefSessionList.tsx
git commit -m "feat(logger): thread per-set rir through draft + commit payload, seed from week rir_target"
```

---

### Task 3: RIR input in the set row UI

**Files:**
- Modify: `components/logger/SetRow.tsx` (add a compact RIR input after the reps column)

**Interfaces:**
- Consumes: `ExerciseSetDraft.rir`, the existing `onChange(patch: Partial<ExerciseSetDraft>)` prop.
- Produces: a per-set editable RIR field; hidden for duration-based sets.

- [ ] **Step 1: Add draft state for RIR**

In `components/logger/SetRow.tsx`, alongside `draftKg`/`draftReps` (~line 46):

```ts
  const [draftRir, setDraftRir] = useState<string>(set.rir !== null && set.rir !== undefined ? String(set.rir) : "");
```

Keep it in sync if `set.rir` changes externally (mirror whatever effect syncs `draftKg`/`draftReps`; if none exists, none is needed).

- [ ] **Step 2: Render the RIR input after the reps input**

After the reps `<input>` block (~line 289), add a parallel input. Only render for non-duration sets (reps-based). Match the existing input className for visual consistency:

```tsx
      {!isDurationBased && (
        <input
          inputMode="numeric"
          value={draftRir}
          onChange={(e) => { setDraftRir(e.target.value); }}
          onFocus={selectOnFocus}
          onBlur={() => {
            const n = draftRir === "" ? null : parseInt(draftRir, 10);
            const clamped = n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(10, n));
            onChange({ rir: clamped });
          }}
          disabled={committed}
          aria-label="Reps in reserve"
          placeholder="RIR"
          className={/* same class string as the reps input */ ""}
        />
      )}
```

Use the component's existing `isDurationBased`/time-based discriminant (the same condition that hides kg/reps for planks/hangs). If the column header row labels kg/reps, add a matching "RIR" header cell.

- [ ] **Step 3: Manual verification in dev**

Run: `npm run dev`, open a strength session via "Start session" on `/strength`.
Expected: each working set shows a pre-filled RIR (2, or the week's target); warmup/time-based rows show none; editing + committing persists. Confirm in DB: `select rir from exercise_sets order by id desc limit 5`.

- [ ] **Step 4: Build (catches hooks-order / React #310 that typecheck misses)**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add components/logger/SetRow.tsx
git commit -m "feat(logger): per-set RIR input in SetRow"
```

---

### Task 4: Effort-adjusted e1RM in `derived.ts` (pure function, audit-tested)

**Files:**
- Modify: `lib/coach/derived.ts` (`SetRow` type, new `effortAdjustedE1rm`, `topSet` return shape)
- Create: `scripts/audit-effort-e1rm.mjs` (fixture assertions)

**Interfaces:**
- Consumes: `epley(kg, reps)` (unchanged).
- Produces: `SetRow.rir?: number | null`; `effortAdjustedE1rm(kg, reps, rir): number | null`; `topSet(...)` return gains `e1RM_effort: number | null` and `rir: number | null`. **`e1RM` stays the raw value** (selection still by raw e1RM) so all other `topSet` consumers are unchanged.

- [ ] **Step 1: Write the failing audit assertions**

Create `scripts/audit-effort-e1rm.mjs`:

```js
import { effortAdjustedE1rm, topSet, epley } from "@/lib/coach/derived.ts";

let pass = 0, fail = 0;
const eq = (a, b, msg) => {
  const ok = a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-6);
  if (ok) pass++; else { fail++; console.error(`FAIL: ${msg} — got ${a}, want ${b}`); };
};

// null rir collapses to raw epley
eq(effortAdjustedE1rm(100, 8, null), epley(100, 8), "rir=null === raw epley");
// 0 rir (to failure) also equals raw epley (reps + 0)
eq(effortAdjustedE1rm(100, 8, 0), epley(100, 8), "rir=0 === raw epley");
// 2 RIR at 10 reps => effective 12 reps
eq(effortAdjustedE1rm(67.5, 10, 2), epley(67.5, 12), "10 reps @2RIR === epley(67.5,12)");
// effective reps cap at 12 (beyond Brzycki/Epley valid window)
eq(effortAdjustedE1rm(67.5, 12, 3), epley(67.5, 12), "cap effective reps at 12");
// out-of-range base reps still null
eq(effortAdjustedE1rm(60, 13, 0), null, "reps>12 base => null");

// topSet exposes raw e1RM unchanged + effort + rir for the chosen top set
const ts = topSet([
  { kg: 67.5, reps: 10, duration_seconds: null, warmup: false, failure: false, rir: 2 },
]);
eq(ts.e1RM, epley(67.5, 10), "topSet.e1RM stays raw");
eq(ts.e1RM_effort, epley(67.5, 12), "topSet.e1RM_effort is rir-adjusted");
eq(ts.rir, 2, "topSet.rir carried");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/audit-effort-e1rm.mjs`
Expected: FAIL — `effortAdjustedE1rm is not a function` / `topSet(...).e1RM_effort is undefined`.

- [ ] **Step 3: Implement**

In `lib/coach/derived.ts`:

Add `rir` to `SetRow`:

```ts
export type SetRow = {
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
  /** Reps in reserve (0 = to failure). Optional/undefined for legacy callers
   *  and rows logged before RIR capture; treated as "not recorded". */
  rir?: number | null;
};
```

Add the helper:

```ts
/** Effort-adjusted Epley e1RM: treats a sub-maximal set as if taken to failure
 *  by adding the reps left in reserve. `min(12, reps + rir)` keeps the input in
 *  the reliable Epley window. rir null/undefined → raw epley (no adjustment),
 *  so the legacy/no-RIR path is byte-identical to before. */
export function effortAdjustedE1rm(
  kg: number | null,
  reps: number | null,
  rir: number | null | undefined,
): number | null {
  if (rir === null || rir === undefined) return epley(kg, reps);
  if (kg === null || reps === null) return null;
  if (reps <= 0 || reps > 12) return null; // base reps must be in valid window
  const eff = Math.min(12, reps + rir);
  return epley(kg, eff);
}
```

In `topSet`, after selecting `best` in Path 1 (the e1RM path), extend the returned object (and the return type annotation) with the two new fields:

```ts
    return {
      kg: best.s.kg,
      reps: best.s.reps,
      duration_seconds: best.s.duration_seconds,
      e1RM: best.e,
      e1RM_effort: effortAdjustedE1rm(best.s.kg, best.s.reps, best.s.rir),
      rir: best.s.rir ?? null,
    };
```

For Path 2 and Path 3 (e1RM null branches) set `e1RM_effort: null, rir: <best>.rir ?? null`. Update the function's return type union to include `e1RM_effort: number | null; rir: number | null`.

- [ ] **Step 4: Run audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/audit-effort-e1rm.mjs`
Expected: `7 passed, 0 failed`.

- [ ] **Step 5: Typecheck (catch other topSet consumers needing the new fields)**

Run: `npm run typecheck`
Expected: PASS. Other consumers read `.e1RM`/`.kg`/`.reps` which are unchanged; the added fields are additive.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/derived.ts scripts/audit-effort-e1rm.mjs
git commit -m "feat(coach): effort-adjusted e1RM (reps+RIR) in derived.ts, raw e1RM unchanged"
```

---

### Task 5: Effort-aware comparison + `rir_today` in the debrief

**Files:**
- Modify: `lib/coach/session-debrief/compose-lifts.ts` (select `rir`, build SetRow with rir, symmetric comparison, populate `rir_today`)

**Interfaces:**
- Consumes: `topSet(...)` now returning `{ e1RM, e1RM_effort, rir, ... }`; `SetRow.rir`.
- Produces: `lifts[].rir_today` populated; `tag` computed from effort-adjusted e1RM when both today and prior top sets carry RIR, else raw (current behavior).

- [ ] **Step 1: Select `rir` in the prior-sets query**

In `compose-lifts.ts`, the prior sets select (~line 72) and the `priorSets` type (~line 59) add `rir`:

```ts
      .select("exercise_id, kg, reps, duration_seconds, warmup, failure, rir")
```

and add `rir: number | null` to the inline `priorSets` type and to the `arr.push({...})` SetRow construction (~line 93). Confirm the today-exercises sets fed in via `input.todayExercises` also carry `rir` — trace the caller in `lib/coach/session-debrief/index.ts`; add `rir` to that select too so today's `SetRow`s include it.

- [ ] **Step 2: Compare on effort-adjusted e1RM when both sides have RIR**

Replace the raw `todayE1rm`/`lastE1rm` comparison (~lines 137-151). Add a pairwise helper near the top of the function:

```ts
  // Pairwise comparable e1RM: use effort-adjusted values only when BOTH tops
  // carry RIR (symmetric — avoids a transition artifact where a held-back
  // session today would falsely outrank a pre-RIR to-failure session).
  const comparablePair = (
    a: { e1RM: number | null; e1RM_effort: number | null; rir: number | null } | null,
    b: { e1RM: number | null; e1RM_effort: number | null; rir: number | null } | null,
  ): [number | null, number | null] => {
    if (a?.rir != null && b?.rir != null) return [a.e1RM_effort, b.e1RM_effort];
    return [a?.e1RM ?? null, b?.e1RM ?? null];
  };
```

Tagging becomes:

```ts
    // Regression / stall: today vs most recent prior, on the same footing.
    const [todayCmp, lastCmp] = comparablePair(todayTop, lastTop);
    // PR: today vs best prior — recompute the best prior under pairwise footing.
    let tag: "PR" | "stall" | "regression" | null = null;
    // (PR loop below now compares comparablePair(todayTop, priorTop) per session)
    ...
    if (todayCmp != null && lastCmp != null) {
      const ratio = todayCmp / lastCmp;
      if (ratio < 1 - REGRESSION_THRESHOLD_PCT) tag = "regression";
      else if (Math.abs(ratio - 1) <= STALL_THRESHOLD_PCT) tag = "stall";
    }
```

For PR detection, change the `bestPriorE1rm` loop to evaluate each prior top set via `comparablePair(todayTop, priorTop)` and tag `"PR"` when `todayCmp > priorCmp` for the best such prior. Keep `delta_e1rm` reported in **raw** terms (`todayTop.e1RM - lastTop.e1RM`) so the displayed kg delta stays physically meaningful; the tag is what becomes effort-aware.

- [ ] **Step 3: Populate `rir_today`**

Replace the stub (`rir_today: null, // ... populate when added`) with the chosen top set's RIR:

```ts
      rir_today: todayTop?.rir ?? null,
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual end-to-end verification**

In dev, log a Legs session where the top squat set is, say, `67.5 × 10 @ 2 RIR` after a prior session of `72.5 × 8 @ 2 RIR`. Fire the debrief (`/api/coach/workout-debrief` runs on commit). Confirm the squat lift is **not** tagged `regression` (effort-adjusted: `epley(67.5,12)=94.5` vs `epley(72.5,10)=96.7` → within stall band, not a >2% regression — verify the actual numbers for your data), and `rir_today` is `2`. Before this change the same data tagged `regression` and produced a "drop 2.5kg and rebuild" card.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/session-debrief/compose-lifts.ts lib/coach/session-debrief/index.ts
git commit -m "fix(debrief): compare effort-adjusted e1RM when both sessions log RIR; populate rir_today"
```

---

### Task 6: Narrative framing + final verification

**Files:**
- Modify: the debrief narrative prompt assembler (find via `grep -rn "rir_today\|REGRESSION\|Regressed" lib/coach/session-debrief/`) — likely the Sonnet narrator that turns `WorkoutDebriefPayload` into the "Coach Carter" prose, and/or `compose-prescription.ts`.

**Interfaces:**
- Consumes: `payload.lifts[].rir_today`, `payload.block.rir_target`.
- Produces: narrative that names a held-back session as deliberate when `rir_today > block.rir_target`, instead of attributing the lighter load to fatigue.

- [ ] **Step 1: Locate the narrative prompt**

Run: `grep -rn "rir_today\|rir_target\|narrat\|prompt" lib/coach/session-debrief/`
Identify the function that builds the prompt string from the payload.

- [ ] **Step 2: Add an RIR-awareness instruction**

In that prompt, where lift verdicts are described, add guidance such as: *"When a lift's `rir_today` exceeds the block `rir_target`, the athlete deliberately held reps in reserve — do NOT describe a lower load as fatigue, under-recovery, or a regression to rebuild from. Acknowledge the held-back effort and judge progress on effort-adjusted terms."* Mirror the existing prompt's voice/format (do not invent a new section style).

- [ ] **Step 3: Build + verify the narrative**

Run: `npm run build`
Then re-fire the debrief from Step 5 of Task 5 and read the prose. Expected: the squat is framed as a deliberate hold (padel-aware), not "drop and rebuild."

- [ ] **Step 4: Run the existing debrief-adjacent audits to confirm no regression elsewhere**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: all assertions pass (this plan does not touch `e1rm.ts`/prescription rules, so the count is unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/session-debrief/
git commit -m "feat(debrief): narrative frames held-back (high-RIR) sessions as deliberate, not regression"
```

---

## Out of scope (explicit follow-ups)

- **Revive the dormant RIR autoregulation layer.** `lastWeekClean` ([prescribe-week.ts:591](../../../lib/coach/prescription/prescribe-week.ts#L591)) currently proxies "hit RIR cleanly" from the `failure` flag + prescribed-rep shortfall because `exercise_sets` had no `rir`. With this column live, `lastWeekClean` / `consecutiveMisses` / `maintenance-baseline` filtering ([maintenance-baseline.ts:22-31](../../../lib/coach/prescription/maintenance-baseline.ts#L22)) can read real RIR. Separate PR — it changes prescription loads, so it needs its own audit pass against `scripts/audit-prescription-rules.mjs` and `scripts/audit-sunday-prescription-e2e.mjs`.
- **Voice RIR capture.** `parse-voice-llm.ts` could extract "2 in reserve"/"2 RIR" into `ParsedSet.rir`. Deferred — the seeded default + manual edit covers the common path.
- **Block-target effort-awareness.** `bestComparisonValue`/`brzycki` in `e1rm.ts` remain raw on purpose; making block-target crossing effort-aware is a deliberate, separately-audited decision (it would change when `target_hit_at_week` stamps).

## Self-Review

- **Spec coverage:** capture (Tasks 1-3) ✓; effort-adjusted math (Task 4) ✓; debrief no longer mis-flags regression (Task 5) ✓; narrative framing (Task 6) ✓; `rir_today` populated (Task 5 Step 3) ✓.
- **Type consistency:** `rir`/`rir: number | null` consistent across `ExerciseSetDraft`, `CommitSessionPayload`, `SetRow`, `topSet` return, `comparablePair`. `effortAdjustedE1rm` signature used identically in audit + `topSet`.
- **Backward-compat invariant:** every `rir = null/undefined` path verified to equal current behavior (Task 4 Step 1 first two assertions; symmetric guard in Task 5 Step 2).
- **Blast-radius guard:** `e1rm.ts`/`bestComparisonValue` untouched (Global Constraints); `topSet.e1RM` stays raw so non-debrief consumers unaffected.
