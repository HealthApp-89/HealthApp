# Coach Responsiveness Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coaches a durable, block-aware memory of interventions (deloads, swaps, nutrition changes) and their measured outcomes, so they prioritize the athlete's high-ROI levers and acknowledge wins instead of repeating themselves.

**Architecture:** A new `coach_interventions` table records interventions (explicit at commit-time + inferred from data). A daily cron sweep runs a pure block-aware detector (inserts inferred rows) and pure outcome evaluators (stamp `outcome` once each window closes). The Phase 1 `composeCoachHistory` stub is filled to read the table and map rows to the existing `HistoryPayload` sub-schemas (auto-surfacing the snapshot's `### Coach History` block). Two new prompt adapters consume it. All detection/evaluation is deterministic and fixture-tested; no new AI calls.

**Tech Stack:** TypeScript (strict), Zod, Supabase (Postgres + RLS, service-role for cron), vitest (node env), Vercel cron.

## Global Constraints

- Pure functions for all detection/evaluation logic (no Supabase calls inside them); the cron route and capture hooks do the I/O and pass data in. Mirrors Phase 1's `lib/coach/intelligence/` composers.
- Timezone: never `new Date().toISOString().slice(0,10)` or `.getHours()`; use `getUserTimezone`/`todayInUserTz`/`nowInUserTz` from [lib/time](../../../lib/time). `node scripts/audit-timezone-usage.mjs` is a gate.
- Block-awareness is mandatory: a `deload_week`-phase deload is the program, NOT an intervention — it must never be recorded as one. The classifier is the guard.
- Inconclusive outcomes are `success: null` — never fabricated. Inconclusive rows never surface to prompts.
- Existing `HistoryPayload` sub-schemas in [lib/coach/intelligence/types.ts](../../../lib/coach/intelligence/types.ts) are the composer's OUTPUT contract (DeloadRecord/ExerciseSwapRecord/NutritionIntervention) — `success` is a required boolean there, so inconclusive rows are filtered out before mapping.
- Phase 1's 142 intelligence tests must stay green after every task.
- Migrations apply via `supabase db push`; next number is `0043`. Row shapes mirrored in [lib/data/types.ts](../../../lib/data/types.ts).
- Commits per task: `feat: interventions: <thing>` / `test: interventions: <thing>`.

---

## File Structure

**New:**
- `supabase/migrations/0043_coach_interventions.sql` — table + RLS + indexes
- `lib/coach/interventions/types.ts` — `CoachInterventionRow` + Zod schemas for `context`/`outcome` jsonb per kind
- `lib/coach/interventions/classify-strength.ts` — pure block-aware planned-vs-reactive classifier (deloads + swaps)
- `lib/coach/interventions/detect-inferred.ts` — pure detector: scans workouts+blocks, emits inferred intervention candidates
- `lib/coach/interventions/evaluate-outcome.ts` — pure outcome evaluators (3 kinds) + window constants
- `lib/coach/interventions/map-to-history.ts` — pure: `CoachInterventionRow[]` → `HistoryPayload`
- `lib/coach/interventions/__tests__/classify-strength.test.ts`
- `lib/coach/interventions/__tests__/detect-inferred.test.ts`
- `lib/coach/interventions/__tests__/evaluate-outcome.test.ts`
- `lib/coach/interventions/__tests__/map-to-history.test.ts`
- `lib/coach/interventions/__tests__/fixtures.ts`
- `app/api/coach/interventions/sweep/route.ts` — daily cron (detect + evaluate)
- `scripts/audit-interventions.mjs` — read-only audit

**Modified:**
- `lib/data/types.ts` — add `CoachInterventionRow`
- `lib/coach/tools.ts` — explicit-capture inserts in `executeCommitSessionToday`, `executeCommitSessionTemplate`, `executeCommitNutritionTargets`
- `lib/coach/intelligence/coach-history.ts` — fill the stub (consume rows, map to HistoryPayload)
- `lib/coach/intelligence/index.ts` — orchestrator fetches intervention rows, passes to composer
- `lib/coach/system-prompts.ts` — two prompt adapters (responsiveness memory + success acknowledgment)
- `vercel.json` — register the sweep cron

---

## Task 1: Migration + Row Type

**Files:**
- Create: `supabase/migrations/0043_coach_interventions.sql`
- Modify: `lib/data/types.ts`
- Create: `lib/coach/interventions/types.ts`
- Test: `lib/coach/interventions/__tests__/context-outcome-schema.test.ts`

**Interfaces:**
- Produces: `CoachInterventionRow` (TS, in lib/data/types.ts); `InterventionContextSchema`, `InterventionOutcomeSchema`, `InterventionKind`, `InterventionSource` (Zod, in lib/coach/interventions/types.ts).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0043_coach_interventions.sql`:

```sql
-- 0043_coach_interventions.sql
-- Durable record of coaching interventions + their measured outcomes.
-- Powers Coach Responsiveness Memory (Phase 3 #1).

create table if not exists public.coach_interventions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('reactive_deload','exercise_swap','nutrition_change')),
  source text not null check (source in ('explicit','inferred')),
  started_on date not null,
  context jsonb not null default '{}'::jsonb,
  outcome jsonb,
  outcome_evaluated_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.coach_interventions enable row level security;

create policy coach_interventions_self on public.coach_interventions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Sweep query: unevaluated rows past their window, per user.
create index if not exists coach_interventions_pending_idx
  on public.coach_interventions (user_id, started_on)
  where outcome_evaluated_at is null;

-- Composer + dedup lookups by (user, kind, date).
create index if not exists coach_interventions_lookup_idx
  on public.coach_interventions (user_id, kind, started_on desc);
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: migration `0043_coach_interventions` applies; if history conflict, `supabase migration repair --status applied <id>` then re-push.

- [ ] **Step 3: Add the row type to lib/data/types.ts**

Append (near other coach row types):

```typescript
/** A recorded coaching intervention + its later-stamped outcome.
 *  See docs/superpowers/specs/2026-06-26-coach-responsiveness-memory-design.md */
export type CoachInterventionKind = "reactive_deload" | "exercise_swap" | "nutrition_change";
export type CoachInterventionSource = "explicit" | "inferred";

export type CoachInterventionRow = {
  id: string;
  user_id: string;
  kind: CoachInterventionKind;
  source: CoachInterventionSource;
  started_on: string;          // YYYY-MM-DD
  context: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  outcome_evaluated_at: string | null;
  created_at: string;
};
```

- [ ] **Step 4: Write the context/outcome Zod schemas**

Create `lib/coach/interventions/types.ts`:

```typescript
// lib/coach/interventions/types.ts
import { z } from "zod";
import type { BlockPhase } from "@/lib/coach/prescription/types";

export const InterventionKindSchema = z.enum(["reactive_deload", "exercise_swap", "nutrition_change"]);
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

export const InterventionSourceSchema = z.enum(["explicit", "inferred"]);
export type InterventionSource = z.infer<typeof InterventionSourceSchema>;

/** Block context captured at intervention time (block_* null when no active block). */
export const BlockContextSchema = z.object({
  block_id: z.string().nullable(),
  block_phase: z.custom<BlockPhase>().nullable(),
  block_week: z.number().int().nullable(),
});

export const DeloadContextSchema = BlockContextSchema.extend({
  deload_depth_pct: z.number().nullable(),
  trigger: z.enum(["low_hrv", "athlete_request", "inferred"]),
});
export const SwapContextSchema = BlockContextSchema.extend({
  from_exercise: z.string(),
  to_exercise: z.string(),
  reason: z.enum(["pain", "stall", "equipment", "boredom"]),
});
export const NutritionContextSchema = BlockContextSchema.extend({
  field: z.string(),
  from: z.union([z.number(), z.string(), z.null()]),
  to: z.union([z.number(), z.string(), z.null()]),
});

export const DeloadOutcomeSchema = z.object({
  success: z.boolean().nullable(),
  hrv_recovery_days: z.number().nullable(),
  performance_resumed: z.boolean(),
});
export const SwapOutcomeSchema = z.object({
  success: z.boolean().nullable(),
  pain_resolved: z.boolean(),
  swap_stuck: z.boolean(),
});
export const NutritionOutcomeSchema = z.object({
  success: z.boolean().nullable(),
  signal: z.string(),
  improved: z.boolean(),
});
```

- [ ] **Step 5: Write the schema test**

Create `lib/coach/interventions/__tests__/context-outcome-schema.test.ts` with vitest cases: a valid `DeloadContextSchema` (block_* populated and block_* null), an invalid `trigger`, a valid `DeloadOutcomeSchema` with `success: null`, and an invalid `SwapOutcomeSchema` missing `swap_stuck`. Use `safeParse(...).success` assertions (mirror `lib/coach/intelligence/__tests__/types.test.ts`).

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck` (clean) and `npx vitest run lib/coach/interventions/` (schema tests pass).

```bash
git add supabase/migrations/0043_coach_interventions.sql lib/data/types.ts lib/coach/interventions/types.ts lib/coach/interventions/__tests__/context-outcome-schema.test.ts
git commit -m "feat: interventions: coach_interventions table + context/outcome schemas"
```

---

## Task 2: Block-Aware Strength Classifier (the core guard)

**Files:**
- Create: `lib/coach/interventions/classify-strength.ts`
- Create: `lib/coach/interventions/__tests__/fixtures.ts`
- Test: `lib/coach/interventions/__tests__/classify-strength.test.ts`

**Interfaces:**
- Consumes: `TrainingBlock` ([lib/data/types.ts]), `evaluateBlockPhase` ([lib/coach/prescription/block-phase-rule.ts]).
- Produces:
  - `classifyDeload(opts): "planned" | "reactive" | "not_a_deload"`
  - `classifySwap(opts): "planned_rotation" | "reactive" | "not_a_swap"`

- [ ] **Step 1: Write fixtures**

Create `lib/coach/interventions/__tests__/fixtures.ts` with: a `makeBlock(overrides)` builder returning a `TrainingBlock` (active, with start/end dates, target_value, target_metric, target_hit_at_week), and `makeWeekVolume(...)` helpers producing per-week primary-lift load/volume series. Include one scenario where a load drop lands in the block's final (deload) week and one where it lands mid-block.

- [ ] **Step 2: Write failing tests for classifyDeload**

Create `lib/coach/interventions/__tests__/classify-strength.test.ts`:

```typescript
import { expect, test } from "vitest";
import { classifyDeload, classifySwap } from "../classify-strength";
import { makeBlock } from "./fixtures";

test("a load drop in the block's deload week is PLANNED, never reactive", () => {
  const block = makeBlock({ /* 5-week block, today in week 5 */ });
  const r = classifyDeload({
    block,
    weekPhase: "deload_week",
    loadDropPct: 0.2,
    todayIso: "2026-06-26",
  });
  expect(r).toBe("planned");
});

test("a mid-block load drop outside deload_week is REACTIVE", () => {
  const block = makeBlock({ /* today in week 3 */ });
  const r = classifyDeload({
    block,
    weekPhase: "pre_target",
    loadDropPct: 0.18,
    todayIso: "2026-06-12",
  });
  expect(r).toBe("reactive");
});

test("a trivial load change is not a deload at all", () => {
  const block = makeBlock({});
  const r = classifyDeload({ block, weekPhase: "pre_target", loadDropPct: 0.03, todayIso: "2026-06-12" });
  expect(r).toBe("not_a_deload");
});
```
Add equivalent `classifySwap` tests: a swap at a block boundary (first week of a new block) → `planned_rotation`; a mid-block swap → `reactive`; identical exercise set → `not_a_swap`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/coach/interventions/__tests__/classify-strength.test.ts`
Expected: FAIL ("classifyDeload is not defined").

- [ ] **Step 4: Implement the classifier**

Create `lib/coach/interventions/classify-strength.ts`:

```typescript
// lib/coach/interventions/classify-strength.ts
//
// Block-aware classification: distinguishes PLANNED program structure
// (end-of-block deloads, block-boundary rotations) from REACTIVE interventions
// (mid-block deloads, mid-block swaps). Only reactive events feed responsiveness
// memory — crediting a scheduled deload would measure the program, not the athlete.
import type { TrainingBlock } from "@/lib/data/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";

/** Minimum primary-lift load drop (fraction) to count as a deload at all. */
export const DELOAD_MIN_DROP_PCT = 0.1;

export function classifyDeload(opts: {
  block: TrainingBlock | null;
  weekPhase: BlockPhase | null;
  loadDropPct: number;          // positive = drop, e.g. 0.2 = 20% down
  todayIso: string;
}): "planned" | "reactive" | "not_a_deload" {
  if (opts.loadDropPct < DELOAD_MIN_DROP_PCT) return "not_a_deload";
  // A drop during the scheduled deload week is the program, not an intervention.
  if (opts.weekPhase === "deload_week") return "planned";
  return "reactive";
}

export function classifySwap(opts: {
  isBoundaryWeek: boolean;      // first training week of a new block = planned rotation
  sameExercise: boolean;
}): "planned_rotation" | "reactive" | "not_a_swap" {
  if (opts.sameExercise) return "not_a_swap";
  if (opts.isBoundaryWeek) return "planned_rotation";
  return "reactive";
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/coach/interventions/__tests__/classify-strength.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/interventions/classify-strength.ts lib/coach/interventions/__tests__/
git commit -m "feat: interventions: block-aware planned-vs-reactive classifier"
```

---

## Task 3: Explicit Capture Hooks

**Files:**
- Modify: `lib/coach/tools.ts` (`executeCommitSessionToday` ~L2819, `executeCommitSessionTemplate` ~L2985, `executeCommitNutritionTargets` ~L3092)
- Create: `lib/coach/interventions/record.ts` (shared insert helper)
- Test: `lib/coach/interventions/__tests__/record.test.ts` (pure builder portion)

**Interfaces:**
- Produces: `buildExplicitIntervention(args): { kind, source: "explicit", started_on, context }` (pure) and `recordIntervention(supabase, userId, built)` (I/O: inserts a row).

**Scoping note (read first):** There is no dedicated "reactive deload" commit tool, so explicit capture attaches only to the tools that exist: session-today swap, session-template swap (→ `exercise_swap`) and nutrition targets / GLP-1 milestone (→ `nutrition_change`). Reactive deloads are captured by inference (Task 4). Do NOT invent a deload tool.

- [ ] **Step 1: Write the pure builder + a test**

Create `lib/coach/interventions/record.ts` with `buildExplicitIntervention` (pure — assembles kind/source/started_on/context from the commit args + block context passed in) and `recordIntervention` (calls `supabase.from("coach_interventions").insert(...)`, returns `{ ok }`, swallows+logs errors so a capture failure never breaks the commit). Test the pure `buildExplicitIntervention` in `record.test.ts`: a session-today swap produces `{ kind: "exercise_swap", source: "explicit", context: { from_exercise, to_exercise, reason } }`.

- [ ] **Step 2: Hook the three commit paths**

In each of the three `executeCommit*` functions, AFTER the existing write succeeds, call `recordIntervention(...)` with the block context (read the active block + `evaluateBlockPhase` where available; pass block_* null if none). Wrap in try/catch — capture is best-effort and must never fail the commit. For swaps, derive `reason` from the commit args (pain/stall/equipment/boredom); for nutrition, record the changed field + from/to.

- [ ] **Step 3: Verify capture doesn't break commits**

Run: `npm run typecheck`. Run: `npx vitest run lib/coach/interventions/` (record test passes). Manually reason in the report: a thrown insert is caught and logged, the commit still returns success.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/tools.ts lib/coach/interventions/record.ts lib/coach/interventions/__tests__/record.test.ts
git commit -m "feat: interventions: explicit capture on swap + nutrition commits"
```

---

## Task 4: Inferred Detector (pure)

**Files:**
- Create: `lib/coach/interventions/detect-inferred.ts`
- Test: `lib/coach/interventions/__tests__/detect-inferred.test.ts`

**Interfaces:**
- Consumes: workouts, training blocks, `classifyDeload`/`classifySwap` (Task 2), `bestComparisonValue`/`brzycki` ([lib/coach/e1rm.ts]) for per-week primary-lift load.
- Produces: `detectInferredInterventions(opts): InferredCandidate[]` where `InferredCandidate = { kind, started_on, context }` (source set to "inferred" by the caller).

- [ ] **Step 1: Write failing tests**

Create `detect-inferred.test.ts`: given a workout series where primary-lift load drops 20% in a mid-block week (phase ≠ deload_week), `detectInferredInterventions` returns one `reactive_deload` candidate with that week's `started_on` and block context. Given the same drop in the deload week, it returns NO candidate (planned). Given an exercise leaving a slot and a new one entering mid-block, it returns one `exercise_swap` candidate. Empty input → `[]`, no throw.

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/coach/interventions/__tests__/detect-inferred.test.ts` → FAIL.

- [ ] **Step 3: Implement the detector**

Implement `detectInferredInterventions` as a pure function: bucket workouts per ISO week, compute each week's primary-lift comparison value, compute week-over-week `loadDropPct`, resolve that week's `BlockPhase` via `evaluateBlockPhase` (block + currentWorkingKg + rate passed in or computed), and emit a `reactive_deload` candidate only when `classifyDeload(...) === "reactive"`. For swaps, diff each session-type's exercise set week-over-week and emit `exercise_swap` only when `classifySwap(...) === "reactive"`. Sort inputs internally by date (no caller-order assumption — the Phase 1 ordering-bug lesson). Nutrition: not inferred in v1 (return none).

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `npx vitest run lib/coach/interventions/__tests__/detect-inferred.test.ts` (PASS), `npm run typecheck` (clean).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/interventions/detect-inferred.ts lib/coach/interventions/__tests__/detect-inferred.test.ts
git commit -m "feat: interventions: inferred reactive-deload + swap detector (block-aware)"
```

---

## Task 5: Outcome Evaluators (pure)

**Files:**
- Create: `lib/coach/interventions/evaluate-outcome.ts`
- Test: `lib/coach/interventions/__tests__/evaluate-outcome.test.ts`

**Interfaces:**
- Consumes: daily logs (HRV/recovery/strain), rolling-30d baseline (`readRolling30d`/`isMeaningfulDeviation` from [lib/whoop/baselines.ts]), workouts (lift progression via `brzycki`), soreness checkins, food log / daily_logs macros.
- Produces:
  - `evaluateDeloadOutcome(row, ctx): DeloadOutcome`
  - `evaluateSwapOutcome(row, ctx): SwapOutcome`
  - `evaluateNutritionOutcome(row, ctx): NutritionOutcome`
  - Window constants `OUTCOME_WINDOWS = { reactive_deload: 10, exercise_swap: 14, nutrition_change: 14 }` (days).
  - `windowClosed(row, todayIso): boolean`

- [ ] **Step 1: Write failing tests** for each evaluator covering: a clear success (deload → HRV back to baseline in 5d + lift resumed), a clear failure (HRV never recovered), and an inconclusive case (sparse HRV → `success: null`). Mirror the deload/swap/nutrition criteria in the spec's outcome table.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** the three evaluators + `windowClosed` + `OUTCOME_WINDOWS`. Each returns the spec's outcome shape; insufficient data → `success: null` (never fabricated). Reuse `isMeaningfulDeviation` for "back to baseline" and `brzycki`/`bestComparisonValue` for lift progression. Sort inputs internally.

- [ ] **Step 4: Run to verify pass + typecheck.**

- [ ] **Step 5: Commit**

```bash
git add lib/coach/interventions/evaluate-outcome.ts lib/coach/interventions/__tests__/evaluate-outcome.test.ts
git commit -m "feat: interventions: deterministic outcome evaluators with inconclusive state"
```

---

## Task 6: Cron Sweep (detect + evaluate + dedup)

**Files:**
- Create: `app/api/coach/interventions/sweep/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: Tasks 4 + 5 pure functions; `createSupabaseServiceRoleClient`, `getUserTimezone`/`todayInUserTz`.
- Produces: a `CRON_SECRET`-gated GET route that, per user: runs `detectInferredInterventions`, dedups against existing rows (same kind + overlapping `started_on` window — explicit wins, skip insert if an explicit row already covers it), inserts new inferred rows, then evaluates every pending row whose `windowClosed` and stamps `outcome` + `outcome_evaluated_at`.

- [ ] **Step 1: Write the route** mirroring `app/api/coach/block-outcomes/sweep/route.ts` (auth via `authorization` header vs `CRON_SECRET`, service-role client, GET handler, JSON summary). Dedup rule: before inserting an inferred candidate, query existing `coach_interventions` for the same `(user_id, kind)` within ±7 days of the candidate's `started_on`; if an `explicit` row exists there, skip (explicit wins); if an `inferred` row exists, skip (idempotent re-run).

- [ ] **Step 2: Register the cron** in `vercel.json` (mirror existing entries): `{ "path": "/api/coach/interventions/sweep", "schedule": "0 2 * * *" }` (02:00 UTC, alongside block-outcomes).

- [ ] **Step 3: Verify** `npm run typecheck` (clean), `node scripts/audit-timezone-usage.mjs` (ok). Smoke the route locally if feasible (`curl` with the CRON_SECRET bearer) and confirm it returns a JSON summary without throwing; otherwise confirm the route compiles via `npm run build` not regressing.

- [ ] **Step 4: Commit**

```bash
git add app/api/coach/interventions/sweep/route.ts vercel.json
git commit -m "feat: interventions: daily cron sweep — detect, dedup, evaluate outcomes"
```

---

## Task 7: Fill composeCoachHistory + Orchestrator Wiring

**Files:**
- Modify: `lib/coach/intelligence/coach-history.ts`
- Modify: `lib/coach/intelligence/index.ts`
- Create: `lib/coach/interventions/map-to-history.ts`
- Test: `lib/coach/interventions/__tests__/map-to-history.test.ts`

**Interfaces:**
- Produces: `mapToHistory(rows: CoachInterventionRow[]): HistoryPayload` (pure) producing the exact existing `HistoryPayloadSchema` shape.
- `composeCoachHistory` signature changes to accept the rows; orchestrator fetches + passes them.

- [ ] **Step 1: Write `map-to-history` + failing test.** Map evaluated rows (`outcome.success ∈ {true,false}` only — drop inconclusive) into the existing sub-schemas:
  - `reactive_deload` → `DeloadRecord` `{ date: started_on, type: "reactive", hrv_recovery_days: outcome.hrv_recovery_days ?? 0, success, reason_if_failed? }`
  - `exercise_swap` → `ExerciseSwapRecord` `{ from, to, reason, result: swap_stuck ? "kept" : "reverted", date }`
  - `nutrition_change` → `NutritionIntervention` (the existing Phase 1 schema) `{ intervention: field-change summary, duration_weeks: window/7, effect_measured: signal, effect_value: improved ? 1 : 0, adopted: success }`
  - Respect the array caps (max 5/10/6), most-recent first. Validate output against `HistoryPayloadSchema`.

- [ ] **Step 2: Run to verify fail, implement, verify pass.**

- [ ] **Step 3: Rewire the composer + orchestrator.** Change `composeCoachHistory(workouts, dailyLogs, interventionRows)` to delegate to `mapToHistory(interventionRows)` (workouts/dailyLogs may stay in the signature for future inference but are unused now — keep them or drop them, but update the single caller). In `lib/coach/intelligence/index.ts`, fetch `coach_interventions` for the user (last ~90d, evaluated) inside the existing `buildAthleteIntelligence` data fetch and pass to the composer. Keep the composer pure.

- [ ] **Step 4: Verify no Phase 1 regression.**

Run: `npm run typecheck`, `npx vitest run lib/coach/intelligence/` (142 still green), `npx vitest run lib/coach/interventions/` (all green).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/intelligence/coach-history.ts lib/coach/intelligence/index.ts lib/coach/interventions/map-to-history.ts lib/coach/interventions/__tests__/map-to-history.test.ts
git commit -m "feat: interventions: fill composeCoachHistory from coach_interventions"
```

---

## Task 8: Prompt Adapters (responsiveness memory + success acknowledgment)

**Files:**
- Modify: `lib/coach/system-prompts.ts`
- Modify: `lib/coach/intelligence/index.ts` (synthesize the responsiveness rollup string) OR a small `lib/coach/interventions/responsiveness.ts` pure helper + test.

**Interfaces:**
- Produces: a pure `summarizeResponsiveness(rows): { high_roi: string[]; low_signal: string[]; recent_wins: string[] }` rendered into the snapshot, + additive prompt sections teaching each coach to use it.

- [ ] **Step 1: Write `summarizeResponsiveness` + test** (pure): from evaluated rows, group by kind, compute success rate, emit `high_roi` (kinds with ≥2 successes), `low_signal` (kinds with ≥2 attempts, 0 successes), and `recent_wins` (success rows in last ~10 days, as short phrases like "reactive deload 2026-06-20 → HRV recovered in 5d").

- [ ] **Step 2: Render it** into the ATHLETE INTELLIGENCE block (extend the existing `### Coach History` rendering in `lib/coach/snapshot.ts` OR the intelligence index, wherever the block is assembled) — compact, observed-only, omitted when empty.

- [ ] **Step 3: Add the two prompt adapters** to `system-prompts.ts` (additive, preserve all existing content, match the Phase 1 Layer 3 style):
  - **Responsiveness memory:** teach Peter (cross-domain rollup), Remi (deload responsiveness), Carter (swap outcomes), Nora (nutrition outcomes) to prioritize `high_roi`, de-emphasize `low_signal`. Gate on the data being present.
  - **Success acknowledgment:** when `recent_wins` is non-empty, the coach states the win instead of re-prescribing. Anti-fabrication rule (cite only present data; if Coach History absent, say nothing).

- [ ] **Step 4: Verify.**

Run: `npm run typecheck`, `npx vitest run lib/coach/` (all green), `grep -c "Confidentiality" lib/coach/system-prompts.ts` unchanged, all four coach bases still exported. `npm run dev` → /coach compiles.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/system-prompts.ts lib/coach/intelligence/index.ts lib/coach/snapshot.ts lib/coach/interventions/responsiveness.ts lib/coach/interventions/__tests__/responsiveness.test.ts
git commit -m "feat: interventions: responsiveness-memory + success-acknowledgment prompt adapters"
```

---

## Task 9: Audit Script + Final Verification

**Files:**
- Create: `scripts/audit-interventions.mjs`

- [ ] **Step 1: Write the audit** (read-only, `AUDIT_USER_ID` env, alias-loader pattern like other audits): for the user, assert (a) NO `reactive_deload` row has `context.block_phase === "deload_week"` (the core invariant — planned deloads must never be recorded as interventions), (b) every row with `outcome_evaluated_at` set has a schema-valid `outcome`, (c) no duplicate explicit+inferred rows survive dedup for the same (kind, ±7d). Print a per-kind summary + would-surface count.

- [ ] **Step 2: Run the full gates.**

Run: `npm run typecheck`, `npx vitest run lib/` (report count — Phase 1's 142 + all new tests), `node scripts/audit-timezone-usage.mjs` (ok), `npm run build` (compiles). Run the audit against the dev user if env is available.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-interventions.mjs
git commit -m "test: interventions: audit script — block-phase invariant + outcome consistency"
```

---

## Specification Coverage Checklist

- [x] `coach_interventions` table (kind/source/started_on/context/outcome) → Task 1
- [x] Block-phase-aware classifier (planned vs reactive; deload_week never an intervention) → Task 2, asserted in Task 9
- [x] Explicit capture on swap + nutrition commits → Task 3
- [x] Inferred reactive-deload + swap detection → Task 4
- [x] Deterministic outcome evaluation + inconclusive (`success:null`) → Task 5
- [x] Cron sweep + dedup (explicit wins) → Task 6
- [x] Fill composeCoachHistory → existing HistoryPayload shapes; auto-surfaces snapshot block → Task 7
- [x] Responsiveness-memory + success-acknowledgment adapters (anti-fabrication) → Task 8
- [x] Audit + Phase 1 142 tests stay green → Tasks 7, 9
- [x] No new AI calls; pure + fixture-tested; timezone-safe → all tasks

## Notes for Execution

- Tasks are mostly sequential (2→4, 1→3, 5→6, 7→8). Each ends testable.
- Reuse Phase 1 anchors: `evaluateBlockPhase`, `isMeaningfulDeviation`/`readRolling30d`, `brzycki`/`bestComparisonValue`. Don't reinvent.
- The composer's output MUST match the existing `HistoryPayloadSchema` exactly — the snapshot renderer already consumes it.
- Watch the worktree-stranding gotcha seen earlier this session: confirm each task's commit lands on `main` (or the working branch), not a stray `worktree-agent-*` branch.
