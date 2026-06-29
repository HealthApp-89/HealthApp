# Activity-Aware Session Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the athlete logs a conflicting activity (e.g. padel) mid-week, Carter proactively offers to move-or-lighten the affected training session, the deterministic engine rewrites the *whole* session per evidence-based tiers, and a preview→confirm flow commits it — with the engine remaining the single source of truth for loads.

**Architecture:** Three layers. (1) A tiered, RIR-aware `lightenExercise()` in the prescription engine replaces the blunt uniform trim. (2) A reusable `applyActivityLayout()` helper (extracted from the existing apply-activity-layout route) recomputes + persists `session_prescriptions`. (3) A Carter `propose_activity_adjustment` / `commit_activity_adjustment` HMAC tool pair, surfaced proactively when `add_planned_activity` detects a conflict, mirrors the existing `propose_week_plan` / `commit_week_plan` pattern exactly. The existing `computeActivityLayoutProposal()` (move/lighten/flag ladder) is reused unchanged.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), Supabase, Anthropic SDK. No test runner — pure logic is verified via fixture-based `node` audit scripts (`scripts/audit-prescription-rules.mjs`); wiring is verified via `npm run typecheck` + `npm run build`.

## Global Constraints

- **Engine owns loads.** Carter never authors per-exercise loads. `propose_*` ignores any caller-supplied prescriptions; `commit_*` rehydrates via `prescribeWeek` at write time. (Verbatim invariant from CLAUDE.md / `executeProposeWeekPlan`.)
- **No new DB migration.** Reuse `chat_messages.kind = "coach"` and `mode = "default"`. No new `kind`/`mode` value, so neither `chat_messages` CHECK constraint changes.
- **Every new `propose_*`/`commit_*` tool MUST be added to ALL of:** the speaker partition arrays (`CARTER_TOOLS`, `PETER_TOOLS`), `PERSIST_RESULT_TOOLS` (chat-stream.ts), the `modeAllowsTool` default-mode explicit allow-list (chat-stream.ts), the chat-stream dispatch `if/else` chain, and `renderToolReceiptChip` (ChatMessage.tsx). Omitting any one silently breaks the tool (see CLAUDE.md memory notes `reference_persist_result_tools`, `reference_chat_default_mode_tool_gating`).
- **New `ApprovalAction` value** must be added to the union in `lib/coach/approval-token.ts`.
- **Number display:** any user-visible number uses `fmtNum()` from `lib/ui/score.ts` (≤2 dp, trailing zeros trimmed) — relevant to the RIR display task.
- **Path alias:** `@/*` → repo root. Use it, not relative climbs.
- **Verify** every task with `npm run typecheck`. Pure-logic tasks additionally run `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`. The final task runs `npm run build`.

---

### Task 1: Per-exercise RIR field + RIR-aware annotation

Add an optional `rir` field to `PlannedExercise` and have `annotateSession` prefer it when computing the displayed RPE/RIR target. This is the carrier for the per-tier RIR bump that Task 2 stamps.

**Files:**
- Modify: `lib/coach/sessionPlans.ts:6-33` (the `PlannedExercise` type)
- Modify: `lib/coach/session-structure/annotate.ts:71-80` (`annotateOne`)
- Test: `scripts/audit-prescription-rules.mjs` (add a fixture block)

**Interfaces:**
- Produces: `PlannedExercise.rir?: number` (reps-in-reserve target for this exercise, overrides tier-derived RPE when present). `annotateOne` output `rpe_target` reflects `ex.rir` when set.

- [ ] **Step 1: Write the failing test** — append to `scripts/audit-prescription-rules.mjs` (near the other `import` lines at the top, add the import; near the end before the summary, add the assertions):

```js
// at top with the other imports
import { annotateSession } from "@/lib/coach/session-structure/annotate";

// in the assertions section
{
  const [a] = annotateSession([
    { name: "Squat (Barbell)", baseKg: 100, baseReps: 5, sets: 3, key: "squat", rir: 3 },
  ]).exercises;
  assert(
    a.rpe_target.includes("3 RIR"),
    `rir override should surface in rpe_target, got "${a.rpe_target}"`,
  );
}
{
  const [b] = annotateSession([
    { name: "Leg Press", baseKg: 100, baseReps: 12, sets: 3, key: "leg_press" },
  ]).exercises;
  assert(
    !b.rpe_target.includes("RIR ("),
    `no rir → unchanged tier-derived rpe_target, got "${b.rpe_target}"`,
  );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — the first assertion throws because `rir` is not yet a field / not yet read by `annotateOne` (and likely a TS strip error on the unknown property).

- [ ] **Step 3: Add the `rir` field to `PlannedExercise`** — in `lib/coach/sessionPlans.ts`, inside the `PlannedExercise` type (after the `note?: string;` line):

```ts
  /** Per-exercise reps-in-reserve target. When set (e.g. by the activity-aware
   *  lighten), it overrides the tier-derived RPE string in annotateSession and
   *  is displayed on the brief + strength card. Absent = use the session-level
   *  rir_target / tier default. */
  rir?: number;
```

- [ ] **Step 4: Make `annotateOne` prefer `ex.rir`** — in `lib/coach/session-structure/annotate.ts`, replace the body of `annotateOne` (lines 71-80):

```ts
function annotateOne(ex: PlannedExercise): AnnotatedExercise {
  const tier = tierOf(ex);
  const reps = repsForExercise(ex);
  // Per-exercise rir override (e.g. from the activity-aware lighten) wins over
  // the tier-derived RPE band. RPE ≈ 10 − RIR; floor at 1 so a large RIR bump
  // never produces a nonsensical "RPE 0".
  const rpe_target =
    ex.rir != null
      ? `${ex.rir} RIR (RPE ${Math.max(1, 10 - ex.rir)})`
      : rpePrescription(tier);
  return {
    ...ex,
    fatigue_tier: tier,
    rest_seconds: restPrescription(tier, reps),
    rpe_target,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS (all assertions, including the two new ones).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/sessionPlans.ts lib/coach/session-structure/annotate.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(coach): per-exercise rir on PlannedExercise; annotate prefers it"
```

---

### Task 2: Tiered, RIR-aware `lightenExercise()`

Replace the uniform `−1 set / −1 rep` lighten with three evidence-based tiers. Export the classifier and the function so the audit script can test them as pure functions.

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts:91-128` (the `lightenExercise` function; also add `classifyLightenTier` + an import)
- Test: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: `PlannedExercise.rir` (Task 1), `exerciseRegion()` and `inferPrimaryLiftFromName()` (already in this file), `BIG_FOUR_SET` (from `lib/coach/session-structure/tiers`).
- Produces (exported):
  - `type LightenTier = "primary_compound" | "eccentric_accessory" | "other_accessory"`
  - `function classifyLightenTier(ex: PlannedExercise, affectedRegions: MuscleRegion[]): LightenTier`
  - `function lightenExercise(ex: PlannedExercise, sessionType: string, affectedRegions: MuscleRegion[]): PlannedExercise`

- [ ] **Step 1: Write the failing test** — append to `scripts/audit-prescription-rules.mjs` (add the import at top, assertions near the end):

```js
// at top with the other imports
import { classifyLightenTier, lightenExercise } from "@/lib/coach/prescription/prescribe-week";

// assertions
const LEGS = ["legs"];
{
  // Primary compound: hold load, drop 1 set (floor 2), +1 RIR, hold reps.
  const sq = { name: "Squat (Barbell)", baseKg: 100, baseReps: 6, sets: 3, key: "squat" };
  assert(classifyLightenTier(sq, LEGS) === "primary_compound", "squat is primary_compound");
  const out = lightenExercise(sq, "Legs", LEGS);
  assert(out.baseKg === 100, "primary holds load");
  assert(out.sets === 2, `primary drops 1 set to 2, got ${out.sets}`);
  assert(out.baseReps === 5, `primary reps 6→5, got ${out.baseReps}`);
  assert(out.rir === 3, `primary rir default(2)+1=3, got ${out.rir}`);
}
{
  // Eccentric accessory in affected region: hold load, drop 2 sets (floor 1), +2 RIR.
  const lp = { name: "Leg Press", baseKg: 85, baseReps: 12, sets: 3, key: "leg_press" };
  assert(classifyLightenTier(lp, LEGS) === "eccentric_accessory", "leg press is eccentric_accessory");
  const out = lightenExercise(lp, "Legs", LEGS);
  assert(out.baseKg === 85, "accessory holds load");
  assert(out.sets === 1, `accessory drops 2 sets to floor 1, got ${out.sets}`);
  assert(out.rir === 4, `accessory rir default(2)+2=4, got ${out.rir}`);
}
{
  // Non-affected region exercise is untouched (region gating preserved).
  const bench = { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench" };
  const out = lightenExercise(bench, "Chest", LEGS);
  assert(out.sets === 3 && out.baseReps === 8 && out.rir === undefined, "off-region exercise unchanged");
}
{
  // Warmup never lightened.
  const wu = { name: "Squat (Barbell)", warmup: true, baseKg: 60, baseReps: 5, sets: 1 };
  const out = lightenExercise(wu, "Legs", LEGS);
  assert(out === wu, "warmup returned unchanged");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — `classifyLightenTier` / `lightenExercise` are not exported (import is undefined), and the tiered behavior doesn't exist yet.

- [ ] **Step 3: Add the `BIG_FOUR_SET` import** — in `lib/coach/prescription/prescribe-week.ts`, near the other `lib/coach/session-structure` imports (there are none yet; add after the `import { readSessionForDay } ...` line ~40):

```ts
import { BIG_FOUR_SET } from "@/lib/coach/session-structure/tiers";
```

- [ ] **Step 4: Replace `lightenExercise` and add `classifyLightenTier`** — replace the whole function at lines 91-128 with:

```ts
export type LightenTier =
  | "primary_compound"
  | "eccentric_accessory"
  | "other_accessory";

/**
 * Classify an exercise for activity-aware lightening. Drives the magnitude of
 * the volume cut and the RIR bump (evidence-based: hold the compound as a
 * low-volume primer, gut the eccentric accessory volume that drives DOMS).
 *   - primary_compound:     a known primary lift OR a BIG_FOUR member.
 *   - eccentric_accessory:  not primary, region overlaps the affected set, and
 *                           it's high-rep/isolation (baseReps ≥ 10).
 *   - other_accessory:      everything else that reaches the lighten path.
 */
export function classifyLightenTier(
  ex: PlannedExercise,
  affectedRegions: MuscleRegion[],
): LightenTier {
  const isPrimary = inferPrimaryLiftFromName(ex.name) != null || BIG_FOUR_SET.has(ex.name);
  if (isPrimary) return "primary_compound";
  const region = exerciseRegion(ex.name);
  const inAffected = region != null && affectedRegions.includes(region);
  const highRepOrIsolation = (ex.baseReps ?? 0) >= 10;
  if (inAffected && highRepOrIsolation) return "eccentric_accessory";
  return "other_accessory";
}

/**
 * Apply a tiered, RIR-aware volume lighten to one exercise. Load (baseKg) is
 * always held — the research lever is volume + RIR, never intensity on the
 * main lift. Warmups and target-less exercises are untouched. Region gating is
 * preserved: an exercise whose region doesn't overlap the affected set (and
 * whose session has no fallback overlap) is returned unchanged.
 */
export function lightenExercise(
  ex: PlannedExercise,
  sessionType: string,
  affectedRegions: MuscleRegion[],
): PlannedExercise {
  if (ex.warmup) return ex;
  if (ex.sets == null && ex.baseReps == null) return ex;

  const exRegion = exerciseRegion(ex.name);
  if (exRegion !== null) {
    if (!affectedRegions.includes(exRegion)) return ex;
  } else {
    const sessionRegs = SESSION_REGION_MAP[sessionType] ?? [];
    if (!sessionRegs.some((r) => affectedRegions.includes(r))) return ex;
  }

  const baseRir = ex.rir ?? 2; // week default rir_target is 2
  const trim = (n: number | undefined, by: number, floor: number) =>
    n != null ? Math.max(floor, n - by) : n;

  const tier = classifyLightenTier(ex, affectedRegions);
  if (tier === "primary_compound") {
    return { ...ex, sets: trim(ex.sets, 1, 2), baseReps: trim(ex.baseReps, 1, 1), rir: Math.min(5, baseRir + 1) };
  }
  if (tier === "eccentric_accessory") {
    return { ...ex, sets: trim(ex.sets, 2, 1), baseReps: trim(ex.baseReps, 2, 1), rir: Math.min(5, baseRir + 2) };
  }
  return { ...ex, sets: trim(ex.sets, 1, 1), baseReps: trim(ex.baseReps, 1, 1), rir: Math.min(5, baseRir + 1) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS (all assertions).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the in-file call site at line ~318 still type-checks — signature unchanged).

- [ ] **Step 7: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(coach): tiered RIR-aware lightenExercise (hold load, cut eccentric volume)"
```

---

### Task 3: Extract reusable `applyActivityLayout()` helper

The commit tool can't call the apply-activity-layout HTTP route. Extract the route's POST body into a pure-ish helper both the route and the tool call. Critically, the helper ALWAYS recomputes prescriptions (no identity early-return) so the lighten-only case (plan unchanged, only `planned_activities` changed) still persists.

**Files:**
- Create: `lib/training-weeks/apply-activity-layout.ts`
- Modify: `app/api/training-weeks/[week_start]/apply-activity-layout/route.ts:108-275` (POST → thin wrapper)

**Interfaces:**
- Produces:
  ```ts
  export type ApplyActivityLayoutResult =
    | { ok: true; week: TrainingWeek; changedDays: Array<{ day: Weekday; before: string | null; after: string | null }> }
    | { ok: false; error: string; code: string };
  export async function applyActivityLayout(opts: {
    supabase: SupabaseClient;
    userId: string;
    weekStart: string;
    proposedPlan: SessionPlan;
  }): Promise<ApplyActivityLayoutResult>;
  ```

- [ ] **Step 1: Create the helper** — `lib/training-weeks/apply-activity-layout.ts`:

```ts
// lib/training-weeks/apply-activity-layout.ts
//
// Shared persistence for the activity-aware layout: clear overrides on changed
// days, recompute session_prescriptions via prescribeWeek (which applies the
// tiered lighten), and upsert. Used by the apply-activity-layout route AND the
// commit_activity_adjustment chat tool. ALWAYS recomputes prescriptions — the
// lighten-only case (plan unchanged, planned_activities changed) must persist.

import type { SupabaseClient } from "@supabase/supabase-js";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { plansEqual } from "@/lib/training-weeks/apply-swap";
import { readSessionForDay, SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import type {
  ExerciseOverrides,
  SessionPlan,
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  Weekday,
} from "@/lib/data/types";

const WEEKDAYS: ReadonlyArray<Weekday> = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TRAINING_WEEK_SELECT =
  "id, user_id, block_id, week_start, session_plan, original_session_plan, exercise_overrides, session_prescriptions, endurance_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

export type ApplyActivityLayoutResult =
  | { ok: true; week: TrainingWeek; changedDays: Array<{ day: Weekday; before: string | null; after: string | null }> }
  | { ok: false; error: string; code: string };

export async function applyActivityLayout(opts: {
  supabase: SupabaseClient;
  userId: string;
  weekStart: string;
  proposedPlan: SessionPlan;
}): Promise<ApplyActivityLayoutResult> {
  const { supabase, userId, weekStart, proposedPlan } = opts;

  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select(TRAINING_WEEK_SELECT)
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message, code: "load_failed" };
  if (!row) return { ok: false, error: `no training_weeks row for ${weekStart}`, code: "no_week" };

  const current = row.session_plan as SessionPlan;
  const original = row.original_session_plan as SessionPlan | null;

  const changedShort: Weekday[] = [];
  const changedFull: string[] = [];
  for (const shortKey of WEEKDAYS) {
    const before = readSessionForDay(current as Record<string, string>, shortKey);
    const after = readSessionForDay(proposedPlan as Record<string, string>, shortKey);
    if (before !== after) {
      changedShort.push(shortKey);
      changedFull.push(SHORT_TO_FULL[shortKey]);
    }
  }

  // Clear exercise_overrides for any day whose session type changed.
  const currentOverrides = (row.exercise_overrides as ExerciseOverrides | null) ?? null;
  let nextOverrides: ExerciseOverrides | null = currentOverrides;
  if (currentOverrides && changedFull.length > 0) {
    const drop = changedFull.filter((k) => currentOverrides[k]);
    if (drop.length > 0) {
      const cleaned: ExerciseOverrides = { ...currentOverrides };
      for (const k of drop) delete cleaned[k];
      nextOverrides = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
  }

  const { data: blockRow } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blockRow as TrainingBlock | null) ?? null;

  const currentPrescriptions = (row.session_prescriptions as SessionPrescriptions | null) ?? null;
  let nextPrescriptions: SessionPrescriptions | null = currentPrescriptions;
  const workingRow: TrainingWeek = {
    ...(row as TrainingWeek),
    session_plan: proposedPlan,
    exercise_overrides: nextOverrides,
    session_prescriptions: currentPrescriptions,
  };
  try {
    const tz = await getUserTimezone(userId);
    const todayIso = todayInUserTz(new Date(), tz);
    nextPrescriptions = await prescribeWeek({ supabase, userId, block, week: workingRow, todayIso });
  } catch {
    // On recompute failure, clear changed days' stale entries (matches route).
    if (currentPrescriptions && changedFull.length > 0) {
      const cleared: SessionPrescriptions = { ...currentPrescriptions };
      for (const k of changedFull) delete cleared[k as keyof SessionPrescriptions];
      nextPrescriptions = Object.keys(cleared).length > 0 ? cleared : null;
    }
  }

  const isIdentityRestore = original !== null && plansEqual(proposedPlan, original);
  const update: Record<string, unknown> = {
    session_plan: proposedPlan,
    exercise_overrides: nextOverrides,
    session_prescriptions: nextPrescriptions,
    updated_at: new Date().toISOString(),
  };
  if (isIdentityRestore) update.original_session_plan = null;
  else if (original === null && changedFull.length > 0) update.original_session_plan = current;

  const { data: updated, error: updateErr } = await supabase
    .from("training_weeks")
    .update(update)
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .select(TRAINING_WEEK_SELECT)
    .single();
  if (updateErr || !updated) {
    return { ok: false, error: updateErr?.message ?? "no row returned", code: "update_failed" };
  }

  const changedDays = changedShort.map((shortKey) => ({
    day: shortKey,
    before: readSessionForDay(current as Record<string, string>, shortKey) ?? null,
    after: readSessionForDay(proposedPlan as Record<string, string>, shortKey) ?? null,
  }));
  return { ok: true, week: updated as TrainingWeek, changedDays };
}
```

- [ ] **Step 2: Refactor the route POST to use the helper** — in `app/api/training-weeks/[week_start]/apply-activity-layout/route.ts`, replace the body of `POST` from the `const current = row.session_plan ...` line (163) through the end of the function (275) with a call to the helper. Keep the auth + body-parse + identity early-return above it. Concretely, after the existing identity check block (lines 163-169 keep returning `{ ok: true, week: row, changed_days: [] }` when `plansEqual(proposedPlan, current)`), replace everything after it with:

```ts
  const result = await applyActivityLayout({
    supabase,
    userId: user.id,
    weekStart: week_start,
    proposedPlan,
  });
  if (!result.ok) {
    const status = result.code === "no_week" ? 404 : 500;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }
  return NextResponse.json(
    { ok: true, week: result.week, changed_days: result.changedDays },
    { status: 200 },
  );
```

Add the import at the top of the route file:

```ts
import { applyActivityLayout } from "@/lib/training-weeks/apply-activity-layout";
```

Then delete the now-unused locals in the route (`current`/`original` are still used by the identity check; remove only the moved diff/override/prescription blocks). Remove now-unused imports from the route that moved into the helper (`prescribeWeek`, `getUserTimezone`, `todayInUserTz`, `SHORT_TO_FULL`, `ExerciseOverrides`, `SessionPrescriptions`, `TrainingBlock`, `Weekday` if no longer referenced) — let typecheck guide you.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. Fix any unused-import errors in the route by removing them.

- [ ] **Step 4: Build (route behavior is load-bearing)**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add lib/training-weeks/apply-activity-layout.ts app/api/training-weeks/[week_start]/apply-activity-layout/route.ts
git commit -m "refactor(coach): extract applyActivityLayout helper; route POST delegates to it"
```

---

### Task 4: `add_planned_activity` returns conflict info

After writing the activity, run the layout proposal so Carter learns whether a conflict exists and whether the resolution is a move or a lighten. This is what makes the surfacing proactive.

**Files:**
- Modify: `lib/coach/tools.ts:6149-6267` (`executeAddPlannedActivity` — return type + tail) and `lib/coach/tools.ts:6116-6147` (`ADD_PLANNED_ACTIVITY_TOOL` description)

**Interfaces:**
- Consumes: `computeActivityLayoutProposal()` from `lib/coach/prescription/prescribe-week.ts` (already exported), returns `{ proposedPlan, lightenDays, flags, hasMoves, hasFlags }`.
- Produces: `executeAddPlannedActivity` data shape gains a `conflict` field:
  ```ts
  conflict: {
    has_conflict: boolean;
    resolution: "move" | "lighten" | "flag" | "none";
    week_start: string;
  }
  ```

- [ ] **Step 1: Widen the result type** — change the return type annotation of `executeAddPlannedActivity` (line 6153):

```ts
}): Promise<ToolResult<{
  ok: true;
  added: { type: ActivityType; date: string; intensity: ActivityIntensity };
  conflict: { has_conflict: boolean; resolution: "move" | "lighten" | "flag" | "none"; week_start: string };
}>> {
```

- [ ] **Step 2: Compute the proposal and return it** — replace the final `return { ok: true, ... }` block (lines 6259-6266) with:

```ts
  // Re-load the row (now with the merged activity) and run the layout proposal
  // so Carter knows whether to offer a move/lighten. Graceful: any failure →
  // has_conflict:false so the add still succeeds.
  let conflict: { has_conflict: boolean; resolution: "move" | "lighten" | "flag" | "none"; week_start: string } = {
    has_conflict: false,
    resolution: "none",
    week_start: weekStartIso,
  };
  try {
    const { data: freshRow } = await opts.supabase
      .from("training_weeks")
      .select("id, user_id, block_id, week_start, session_plan, planned_activities, session_prescriptions, exercise_overrides, rir_target")
      .eq("user_id", opts.userId)
      .eq("week_start", weekStartIso)
      .maybeSingle();
    if (freshRow) {
      const { data: blockRow } = await opts.supabase
        .from("training_blocks")
        .select("*")
        .eq("user_id", opts.userId)
        .eq("status", "active")
        .maybeSingle();
      const proposal = await computeActivityLayoutProposal({
        supabase: opts.supabase,
        userId: opts.userId,
        block: (blockRow as TrainingBlock | null) ?? null,
        week: freshRow as unknown as TrainingWeek,
        todayIso,
      });
      const hasLighten = Object.values(proposal.lightenDays).some((r) => r.length > 0);
      const resolution: "move" | "lighten" | "flag" | "none" =
        proposal.hasMoves ? "move" : hasLighten ? "lighten" : proposal.hasFlags ? "flag" : "none";
      conflict = { has_conflict: resolution !== "none", resolution, week_start: weekStartIso };
    }
  } catch {
    // keep conflict = none
  }

  return {
    ok: true,
    data: { ok: true, added: { type: activityType, date: activityDate, intensity }, conflict },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
```

- [ ] **Step 3: Add the import** — confirm `computeActivityLayoutProposal` is imported in `lib/coach/tools.ts`. If not, add to the existing `@/lib/coach/prescription/prescribe-week` import (search for `prescribeWeek` import near the top):

```ts
import { prescribeWeek, computeActivityLayoutProposal } from "@/lib/coach/prescription/prescribe-week";
```

(If only `prescribeWeek` was imported, add `computeActivityLayoutProposal` to the same statement.)

- [ ] **Step 4: Update the tool description** — in `ADD_PLANNED_ACTIVITY_TOOL.description`, replace the last sentence ("The actual training-load rearrangement … only registers the declared activity.") with:

```ts
    "Returns a `conflict` summary: when has_conflict is true, immediately offer to adjust the affected session via propose_activity_adjustment (resolution='move' relocates the session; 'lighten' trims it in place; 'flag' means a priority session is blocked — ask the athlete).",
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirm `TrainingBlock` is already imported in tools.ts — it is used widely; if not, add it.)

- [ ] **Step 6: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(coach): add_planned_activity returns conflict summary for proactive adjustment"
```

---

### Task 5: `propose_activity_adjustment` / `commit_activity_adjustment` tools

The HMAC propose/commit pair. Propose builds a move/lighten preview; commit applies via the Task 3 helper. Mirrors `propose_week_plan` / `commit_week_plan`.

**Files:**
- Modify: `lib/coach/approval-token.ts:17` (`ApprovalAction` union)
- Modify: `lib/coach/tools.ts` (add tool schemas near the other `*_TOOL` consts ~line 1712; add executors near the other `execute*` functions ~after line 2652)

**Interfaces:**
- Consumes: `signApprovalToken` / `verifyApprovalToken` / `ApprovalTokenError` / `approvalTokenUserMessage` (approval-token.ts), `computeActivityLayoutProposal` + `prescribeWeek` (prescribe-week.ts), `applyActivityLayout` (Task 3).
- Produces:
  - tool consts `PROPOSE_ACTIVITY_ADJUSTMENT_TOOL`, `COMMIT_ACTIVITY_ADJUSTMENT_TOOL`
  - `executeProposeActivityAdjustment(opts: { supabase; userId; input }): Promise<ToolResult<{ preview: ActivityAdjustmentPreview; approval_token: string }>>`
  - `executeCommitActivityAdjustment(opts: { supabase; userId; input; chatMessageId? }): Promise<ToolResult<{ week: TrainingWeek; changed_days; lightened_count: number }>>`
  - preview type:
    ```ts
    type ActivityAdjustmentPreview = {
      week_start: string;
      moves: Array<{ day: string; before: string | null; after: string | null }>;
      lightened: Array<{ day: string; exercise: string; before: { sets?: number; baseReps?: number }; after: { sets?: number; baseReps?: number; rir?: number } }>;
      flags: Array<{ session_type: string; day: string; reason: string }>;
    };
    ```

- [ ] **Step 1: Add the ApprovalAction value** — in `lib/coach/approval-token.ts` line 17, append `| "activity_adjustment"`:

```ts
export type ApprovalAction = "block" | "close_block" | "week" | "plan" | "weekly_review" | "nutrition_targets" | "session_today" | "session_template" | "meal_log" | "endurance_week" | "activity_adjustment";
```

- [ ] **Step 2: Add the tool schemas** — in `lib/coach/tools.ts` after `COMMIT_WEEK_PLAN_TOOL` (line 1712):

```ts
export const PROPOSE_ACTIVITY_ADJUSTMENT_TOOL = {
  name: "propose_activity_adjustment",
  description:
    "Preview an adjustment to THIS week's training to accommodate a logged activity (padel, run, ride). Does NOT write. The server runs the move→lighten ladder: it relocates the conflicting session to a free day when possible, otherwise applies a tiered volume lighten (hold load on the main lift, cut eccentric accessory volume, raise RIR). Returns a preview (moves + per-exercise lightened deltas + flags) and an approval_token. Quote the preview verbatim, then call commit_activity_adjustment after the athlete approves. Do NOT author loads yourself — the engine owns them.",
  input_schema: {
    type: "object" as const,
    required: ["week_start"],
    properties: {
      week_start: { type: "string", format: "date", description: "Monday of THIS week (user timezone)." },
    },
  },
};

export const COMMIT_ACTIVITY_ADJUSTMENT_TOOL = {
  name: "commit_activity_adjustment",
  description:
    "Apply a previously proposed activity adjustment. Requires the approval_token from propose_activity_adjustment. Recomputes prescriptions at write time so the stored plan reflects any workout committed since the proposal. Idempotent.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};
```

- [ ] **Step 3: Add the executors** — in `lib/coach/tools.ts` after `executeCommitWeekPlan` (line 2652), add. (Confirm imports `signApprovalToken`, `verifyApprovalToken`, `ApprovalTokenError`, `approvalTokenUserMessage` exist — they're used by the week-plan executors above, so they're already imported. Add `applyActivityLayout` import at the top: `import { applyActivityLayout } from "@/lib/training-weeks/apply-activity-layout";`)

```ts
type ActivityAdjustmentPreview = {
  week_start: string;
  moves: Array<{ day: string; before: string | null; after: string | null }>;
  lightened: Array<{ day: string; exercise: string; before: { sets?: number; baseReps?: number }; after: { sets?: number; baseReps?: number; rir?: number } }>;
  flags: Array<{ session_type: string; day: string; reason: string }>;
};

export async function executeProposeActivityAdjustment(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: ActivityAdjustmentPreview; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  if (!isYmd(i.week_start)) {
    return { ok: false, error: { error: "week_start must be YYYY-MM-DD" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const weekStart = i.week_start as string;

  const { data: row } = await opts.supabase
    .from("training_weeks")
    .select("id, user_id, block_id, week_start, session_plan, planned_activities, session_prescriptions, exercise_overrides, rir_target")
    .eq("user_id", opts.userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (!row) {
    return { ok: false, error: { error: "no_training_week", code: "no_week" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { data: blockRow } = await opts.supabase
    .from("training_blocks").select("*").eq("user_id", opts.userId).eq("status", "active").maybeSingle();
  const block = (blockRow as TrainingBlock | null) ?? null;

  const today = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
  const proposal = await computeActivityLayoutProposal({
    supabase: opts.supabase, userId: opts.userId, block, week: row as unknown as TrainingWeek, todayIso: today,
  });

  // Compute new prescriptions under the proposed plan (engine applies the
  // tiered lighten + moves). Diff against the row's current prescriptions.
  let newPrescriptions: SessionPrescriptions = {};
  try {
    newPrescriptions = await prescribeWeek({
      supabase: opts.supabase, userId: opts.userId, block,
      week: { ...(row as unknown as TrainingWeek), session_plan: proposal.proposedPlan },
      todayIso: today,
    });
  } catch (e) {
    return { ok: false, error: { error: `prescribe_failed: ${String(e)}`, code: "prescribe_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const currentPrescriptions = (row.session_prescriptions as SessionPrescriptions | null) ?? {};
  const lightened: ActivityAdjustmentPreview["lightened"] = [];
  for (const [day, exs] of Object.entries(newPrescriptions)) {
    const before = (currentPrescriptions as Record<string, PlannedExercise[]>)[day] ?? [];
    const beforeByName = new Map(before.map((e) => [e.name, e]));
    for (const ex of exs as PlannedExercise[]) {
      const b = beforeByName.get(ex.name);
      if (!b) continue;
      if (b.sets !== ex.sets || b.baseReps !== ex.baseReps || ex.rir != null) {
        lightened.push({
          day, exercise: ex.name,
          before: { sets: b.sets, baseReps: b.baseReps },
          after: { sets: ex.sets, baseReps: ex.baseReps, rir: ex.rir },
        });
      }
    }
  }

  const moves: ActivityAdjustmentPreview["moves"] = [];
  if (proposal.hasMoves) {
    const cur = row.session_plan as Record<string, string>;
    const prop = proposal.proposedPlan as Record<string, string>;
    for (const k of Object.keys({ ...cur, ...prop })) {
      if ((cur[k] ?? null) !== (prop[k] ?? null)) moves.push({ day: k, before: cur[k] ?? null, after: prop[k] ?? null });
    }
  }

  const preview: ActivityAdjustmentPreview = {
    week_start: weekStart,
    moves,
    lightened,
    flags: proposal.flags.map((f) => ({ session_type: f.sessionType, day: f.sessionDay, reason: f.reason })),
  };

  if (moves.length === 0 && lightened.length === 0 && preview.flags.length === 0) {
    return { ok: false, error: { error: "no_adjustment_needed", code: "no_conflict" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const token = signApprovalToken({
    userId: opts.userId,
    action: "activity_adjustment",
    payload: { week_start: weekStart, proposed_plan: proposal.proposedPlan },
  });
  return { ok: true, data: { preview, approval_token: token }, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false } };
}

export async function executeCommitActivityAdjustment(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
  chatMessageId?: string | null;
}): Promise<ToolResult<{ week: TrainingWeek; changed_days: Array<{ day: string; before: string | null; after: string | null }>; lightened_count: number }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;
  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "activity_adjustment" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = (envelope.payload ?? {}) as { week_start?: string; proposed_plan?: SessionPlan };
  if (!p.week_start || !p.proposed_plan) {
    return { ok: false, error: { error: "That approval is missing the adjustment. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const result = await applyActivityLayout({
    supabase: opts.supabase, userId: opts.userId, weekStart: p.week_start, proposedPlan: p.proposed_plan,
  });
  if (!result.ok) {
    return { ok: false, error: { error: "Couldn't apply the adjustment. Please try again.", code: result.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  // Count lightened exercises (rir stamped) in the persisted prescriptions.
  let lightenedCount = 0;
  for (const exs of Object.values((result.week.session_prescriptions as SessionPrescriptions | null) ?? {})) {
    for (const ex of (exs as PlannedExercise[]) ?? []) if (ex.rir != null) lightenedCount++;
  }
  return {
    ok: true,
    data: { week: result.week, changed_days: result.changedDays, lightened_count: lightenedCount },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 7, truncated: false },
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirm `PlannedExercise`, `SessionPlan`, `SessionPrescriptions`, `TrainingWeek`, `TrainingBlock`, `isYmd`, `getUserTimezone`, `todayInUserTz` are imported in tools.ts — all are used by existing code in the file.)

- [ ] **Step 5: Commit**

```bash
git add lib/coach/approval-token.ts lib/coach/tools.ts
git commit -m "feat(coach): propose/commit_activity_adjustment tool pair (move-or-lighten)"
```

---

### Task 6: Wire the new tools into chat-stream + partitions

Register the executors in the dispatch chain, add them to the persist set, the default-mode allow-list, and the Carter + Peter partitions.

**Files:**
- Modify: `lib/coach/tools.ts:6336-6363` (`CARTER_TOOLS`) and `:6287-6331` (`PETER_TOOLS`)
- Modify: `lib/coach/chat-stream.ts` (imports ~41-85; `PERSIST_RESULT_TOOLS` ~97-132; `modeAllowsTool` ~377-397; dispatch chain ~662-680)

**Interfaces:**
- Consumes: `executeProposeActivityAdjustment`, `executeCommitActivityAdjustment`, `PROPOSE_ACTIVITY_ADJUSTMENT_TOOL`, `COMMIT_ACTIVITY_ADJUSTMENT_TOOL` (Task 5).

- [ ] **Step 1: Add to partitions** — in `lib/coach/tools.ts`, add both consts to `CARTER_TOOLS` (after `ADD_PLANNED_ACTIVITY_TOOL`, line 6362) and to `PETER_TOOLS` (after `ADD_PLANNED_ACTIVITY_TOOL`, line 6330):

```ts
  PROPOSE_ACTIVITY_ADJUSTMENT_TOOL,
  COMMIT_ACTIVITY_ADJUSTMENT_TOOL,
```

- [ ] **Step 2: Import the executors in chat-stream** — in `lib/coach/chat-stream.ts`, add to the `@/lib/coach/tools` import block (near line 41-85):

```ts
  executeProposeActivityAdjustment,
  executeCommitActivityAdjustment,
```

- [ ] **Step 3: Add to `PERSIST_RESULT_TOOLS`** — in the Set (line ~131, after `"add_planned_activity"`):

```ts
  // Activity adjustment: preview chip + commit confirmation must survive reload.
  "propose_activity_adjustment",
  "commit_activity_adjustment",
```

- [ ] **Step 4: Add default-mode allows** — in `modeAllowsTool`, alongside the endurance allows (after line 396 `if (name === "commit_endurance_week") return true;`):

```ts
    if (name === "propose_activity_adjustment") return true;
    if (name === "commit_activity_adjustment") return true;
```

- [ ] **Step 5: Add dispatch branches** — in the dispatch `if/else` chain, after the `commit_week_plan` branch (line ~674):

```ts
        } else if (block.name === "propose_activity_adjustment") {
          result = await executeProposeActivityAdjustment({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "commit_activity_adjustment") {
          result = await executeCommitActivityAdjustment({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
            chatMessageId: opts.assistantMessageId ?? null,
          });
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/tools.ts lib/coach/chat-stream.ts
git commit -m "feat(coach): wire activity-adjustment tools (partitions, persist, mode, dispatch)"
```

---

### Task 7: UI — receipt chips + per-exercise RIR display

Render preview/confirmation chips for the new tools, and surface the per-exercise `rir` on the brief session list and the strength card.

**Files:**
- Modify: `components/chat/ChatMessage.tsx:498-605` (`renderToolReceiptChip`)
- Modify: `components/morning/BriefSessionList.tsx` (exercise row render)
- Modify: `components/strength/TodayPlanCard.tsx` (exercise row render)

**Interfaces:**
- Consumes: `propose_activity_adjustment` result `{ preview: { moves, lightened, flags } }`; `commit_activity_adjustment` result `{ changed_days, lightened_count }`; `AnnotatedExercise.rpe_target` (already includes RIR from Task 1) / `PlannedExercise.rir`.

- [ ] **Step 1: Add chips to `renderToolReceiptChip`** — in `components/chat/ChatMessage.tsx`, add both names to `RECEIPT_TOOLS` (line 504):

```ts
    "propose_activity_adjustment",
    "commit_activity_adjustment",
```

Then add two branches before the final `return null;` (line 604):

```tsx
  if (call.name === "propose_activity_adjustment") {
    const r = (call.result ?? {}) as { preview?: { moves?: unknown[]; lightened?: unknown[]; flags?: unknown[] } };
    const moves = r.preview?.moves?.length ?? 0;
    const lightened = r.preview?.lightened?.length ?? 0;
    const flags = r.preview?.flags?.length ?? 0;
    const parts = [
      moves ? `${moves} move${moves === 1 ? "" : "s"}` : "",
      lightened ? `${lightened} exercise${lightened === 1 ? "" : "s"} lightened` : "",
      flags ? `${flags} flag${flags === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(", ");
    return (
      <span style={styleBase}>
        <span aria-hidden="true">📋</span>
        <span>Proposed adjustment: {parts || "no change"}</span>
      </span>
    );
  }

  if (call.name === "commit_activity_adjustment") {
    const r = (call.result ?? {}) as { changed_days?: unknown[]; lightened_count?: number };
    const moved = r.changed_days?.length ?? 0;
    const lightened = r.lightened_count ?? 0;
    const parts = [
      moved ? `${moved} day${moved === 1 ? "" : "s"} moved` : "",
      lightened ? `${lightened} exercise${lightened === 1 ? "" : "s"} lightened` : "",
    ].filter(Boolean).join(", ");
    return (
      <span style={styleBase}>
        <span aria-hidden="true">✓</span>
        <span>Adjusted session: {parts || "applied"}</span>
      </span>
    );
  }
```

- [ ] **Step 2: Show RIR on the brief session list** — in `components/morning/BriefSessionList.tsx`, find where each exercise's sets×reps / RPE is rendered (the row already consumes `annotateSession` output — look for `rpe_target` or `fatigue_tier`). Since `rpe_target` now embeds the RIR (Task 1), confirm it's displayed; if the component renders `rpe_target` already, no change is needed beyond verifying. If it renders sets/reps but not `rpe_target`, add a small muted span next to the reps:

```tsx
{ex.rpe_target ? <span style={{ opacity: 0.7, fontSize: 12 }}> · {ex.rpe_target}</span> : null}
```

(Use the file's existing style conventions; this is the only addition.)

- [ ] **Step 3: Show RIR on the strength card** — apply the same one-span addition in `components/strength/TodayPlanCard.tsx` at the exercise-row render, using that file's existing style tokens.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed. (Build is the only gate that catches the React hooks/render issues per memory `reference_no_render_test_harness` — keep any new hooks above early returns.)

- [ ] **Step 5: Commit**

```bash
git add components/chat/ChatMessage.tsx components/morning/BriefSessionList.tsx components/strength/TodayPlanCard.tsx
git commit -m "feat(coach): activity-adjustment chips + per-exercise RIR display"
```

---

### Task 8: Teach Carter the flow (prompts)

Update CARTER_BASE (and PETER_BASE, since Peter holds the same tools) so the coach offers the adjustment proactively, prefers moving before lightening, and narrates the engine's numbers without authoring them.

**Files:**
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE and PETER_BASE)

**Interfaces:** none (prose only).

- [ ] **Step 1: Add a section to CARTER_BASE** — locate the `CARTER_BASE` template string in `lib/coach/system-prompts.ts` and add, near the existing week-planning / session guidance:

```
## Activity-aware session adjustment
When the athlete logs a sport/activity (padel, run, ride) via add_planned_activity, read the returned `conflict` summary. If has_conflict is true, proactively offer to adjust the affected session — do NOT wait to be asked:
- Call propose_activity_adjustment with this week's Monday. Quote the preview verbatim (the moves and the per-exercise lightened deltas), then commit with commit_activity_adjustment after the athlete approves.
- The engine follows a move-first ladder: it relocates the session to a free day when one exists (best for freshness); only if no free day is available does it lighten in place.
- The lighten is evidence-based: it HOLDS the load on the main compound (a low-volume primer protects strength and may potentiate), cuts volume hardest on the high-eccentric accessories that drive next-day soreness, and raises RIR. Explain it in those terms.
- You never author loads, sets, reps, or RIR yourself. The prescription engine owns every number — you trigger, preview, and explain it. If a `flag` is returned (a priority session can't move), surface it and ask the athlete how to proceed rather than silently compromising the priority day.
```

- [ ] **Step 2: Add the same section to PETER_BASE** — Peter holds these tools too; add an equivalent paragraph (Peter can delegate to Carter, but if he handles it directly the same discipline applies).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "docs(coach): teach Carter/Peter the activity-aware adjustment flow"
```

---

### Task 9: End-to-end audit script + final verification

Add a read-only dry-run audit and run the full verification suite.

**Files:**
- Create: `scripts/audit-activity-adjustment.mjs`

**Interfaces:** none (script).

- [ ] **Step 1: Create the audit script** — `scripts/audit-activity-adjustment.mjs`:

```js
// Read-only dry-run of the activity-adjustment preview for the current week.
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//   --experimental-strip-types --env-file=.env.local scripts/audit-activity-adjustment.mjs
import { createClient } from "@supabase/supabase-js";
import { computeActivityLayoutProposal } from "@/lib/coach/prescription/prescribe-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz, mondayOf } from "@/lib/time";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("set AUDIT_USER_ID");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
const weekStart = mondayOf(today);

const { data: row } = await sb
  .from("training_weeks")
  .select("id, user_id, block_id, week_start, session_plan, planned_activities, session_prescriptions, exercise_overrides, rir_target")
  .eq("user_id", userId).eq("week_start", weekStart).maybeSingle();
if (!row) { console.log("no training_weeks row for", weekStart); process.exit(0); }

const { data: block } = await sb.from("training_blocks").select("*").eq("user_id", userId).eq("status", "active").maybeSingle();
const proposal = await computeActivityLayoutProposal({ supabase: sb, userId, block: block ?? null, week: row, todayIso: today });

console.log("planned_activities:", JSON.stringify(row.planned_activities ?? []));
console.log("hasMoves:", proposal.hasMoves, "| hasFlags:", proposal.hasFlags);
console.log("lightenDays:", JSON.stringify(proposal.lightenDays));
console.log("flags:", JSON.stringify(proposal.flags.map((f) => ({ day: f.sessionDay, type: f.sessionType, reason: f.reason }))));
```

(If `mondayOf` is not exported from `@/lib/time`, use the helper the codebase uses for Monday-keying — check `lib/time` exports; `executeAddPlannedActivity` uses `mondayOf` so it exists.)

- [ ] **Step 2: Run the audit**

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-activity-adjustment.mjs`
Expected: prints the current week's activities + proposal without error.

- [ ] **Step 3: Run the pure-logic audit (regression)**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS (all assertions including Tasks 1 & 2).

- [ ] **Step 4: Final typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit-activity-adjustment.mjs
git commit -m "test(coach): read-only audit for activity-adjustment preview"
```

---

## Manual verification (after all tasks)

1. Ensure a `training_weeks` row exists for this week with a Legs day and an active block.
2. In `/coach` chat (Carter/Strength thread), say: "I'm playing padel tomorrow, hard."
3. Confirm Carter calls `add_planned_activity`, then proactively calls `propose_activity_adjustment` and quotes a preview where the squat holds load (fewer sets, +1 RIR) and leg press / leg curl / hip thrust / abductor are cut harder (−2 sets, +2 RIR) — **not just the squat**.
4. Approve; confirm the confirmation chip renders and the brief/strength card show the lightened whole session with per-exercise RIR.
5. Reload the chat; confirm both chips survive (PERSIST_RESULT_TOOLS wiring).
