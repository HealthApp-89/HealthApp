# Morning-Ladder Prescription Patches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Morning intake soreness/fatigue answers write real, revertible changes to today's `session_prescriptions` entry (auto-apply + revert chip), replacing the cue-only reactive ladder for the graded rungs.

**Architecture:** A pure rung→transform module (`patch-today.ts`) maps `load_down` → RIR+1 on affected exercises and `volume_down` → the existing `lightenExercise` tiering, load always held. An apply primitive fires in the morning recommendation route before brief assembly, diffs old vs new via the repatch diff machinery, and appends a `reason: "morning_checkin"` entry to `training_weeks.repatch_log` (idempotency + revert source). Groundwork first: the three remaining full-week prescription writers learn `preserveDaysThrough` so later engine runs can't clobber the patch.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Supabase/Postgres, TanStack Query (client cache), fixture-based audit scripts (no test runner for lib/coach).

**Spec:** [docs/superpowers/specs/2026-07-09-morning-ladder-prescription-patches-design.md](../specs/2026-07-09-morning-ladder-prescription-patches-design.md)

## Global Constraints

- `baseKg` is NEVER modified by any path in this arc — volume + RIR only.
- Weekdays ≤ today keep stored state verbatim in every full-week writer, EXCEPT when a swap/layout change touches today's session type (then boundary = yesterday).
- Patch and revert are non-fatal to their callers (route-level try/catch; patch failure ⇒ cue-only brief, today's behavior).
- One `morning_checkin` `repatch_log` entry per day (idempotency guard); revert appends `morning_checkin_revert`, never deletes entries.
- Brief `ui` jsonb is never rewritten after delivery; chip state derives live from the training-week row.
- No raw `new Date().toISOString().slice(0,10)`/`.getHours()` — `node scripts/audit-timezone-usage.mjs` is the gate.
- User-visible numbers via `fmtNum()` from `lib/ui/score.ts`.
- Audit script command: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs` (currently 125 assertions — all must stay green).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Work on branch `feat/morning-ladder-patches` (already exists; commits auto-push — never commit on main).

---

### Task 1: I1 groundwork — three writers preserve past days

**Files:**
- Modify: `lib/coach/tools.ts:2262-2267` (get_week_prescription persist path)
- Modify: `app/api/training-weeks/[week_start]/swap/route.ts:262-277` (prescription recompute)
- Modify: `lib/training-weeks/apply-activity-layout.ts:92-96` (prescription recompute)
- Test: `scripts/audit-prescription-rules.mjs` (one new assertion)

**Interfaces:**
- Consumes: `mergePreservedDays` + `WEEKDAY_LONG_ORDER` from `@/lib/coach/prescription/upsert-week-prescription`; `mondayOfIso` from `@/lib/coach/prescription/repatch-week`; `daysBetweenIso`, `isoDaysAgo` from `@/lib/time/dates`; `upsertWeekPrescription`'s existing `preserveDaysThrough?: string` option (shipped in PR #143).
- Produces: no new exports — behavior change only. Later tasks rely on the guarantee: "a `session_prescriptions` write from these three paths never overwrites today's stored entry unless today's session type changed".

- [ ] **Step 1: Failing fixture — yesterday-boundary recomputes today**

Append to `scripts/audit-prescription-rules.mjs`, inside a new block after the existing `mergePreservedDays` fixtures (reuse the same `stored`/`computed` shapes):

```js
console.log("\n## mergePreservedDays — yesterday boundary (morning-patch protection)\n");

{
  const stored = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3 }],
    Tuesday: [{ name: "Decline Bench Press (Barbell)", baseKg: 80, baseReps: 8, sets: 2 }],
  };
  const computed = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 135, baseReps: 6, sets: 3 }],
    Tuesday: [{ name: "Decline Bench Press (Barbell)", baseKg: 80, baseReps: 8, sets: 3 }],
  };
  // today = Tuesday 2026-07-07; boundary = yesterday (Monday 2026-07-06)
  const merged = mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-06" });
  assert("yesterday boundary: past day (Monday) preserved", merged.Monday[0].baseKg === 130);
  assert("yesterday boundary: today (Tuesday) takes computed", merged.Tuesday[0].sets === 3);
}
```

- [ ] **Step 2: Run to verify the new assertions pass immediately**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS, 127 total. (This fixture documents behavior that already exists in `mergePreservedDays` — it is the contract Task 4's trigger relies on. No production change needed to make it pass; the production changes below are what CONSUME it.)

- [ ] **Step 3: get_week_prescription persist path**

In `lib/coach/tools.ts`, the `upsertWeekPrescription` call at ~line 2262 becomes:

```ts
      const out = await upsertWeekPrescription({
        supabase: opts.supabase,
        userId: opts.userId,
        weekStart,
        todayIso,
        // Days ≤ today keep stored state (incl. morning patches + mid-week
        // repatches). For week:'next' the boundary predates the week and the
        // merge no-ops — safe unconditionally.
        preserveDaysThrough: todayIso,
      });
```

- [ ] **Step 4: swap route — conditional boundary merge**

In `app/api/training-weeks/[week_start]/swap/route.ts`, add imports:

```ts
import { mergePreservedDays, WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import { mondayOfIso } from "@/lib/coach/prescription/repatch-week";
import { daysBetweenIso, isoDaysAgo } from "@/lib/time/dates";
```

Replace the recompute assignment (~lines 262-270, inside the existing `try`):

```ts
      const tz = await getUserTimezone(user.id);
      const todayIso = todayInUserTz(new Date(), tz);
      const computed = await prescribeWeek({
        supabase,
        userId: user.id,
        block,
        week: workingRow,
        todayIso,
      });
      // Preserve days ≤ today verbatim (they may carry a morning patch or a
      // mid-week repatch) — UNLESS this swap changed today's session type, in
      // which case today must be recomputed for the new type (boundary =
      // yesterday). Only applies when editing the current week; for other
      // weeks the boundary math in mergePreservedDays no-ops or preserves
      // everything, matching "past days are the historical record".
      const todayIdx = daysBetweenIso(mondayOfIso(todayIso), todayIso);
      const todayWeekday = todayIdx != null ? WEEKDAY_LONG_ORDER[todayIdx] : null;
      const todayChanged = todayWeekday != null && changedFull.includes(todayWeekday);
      nextPrescriptions = mergePreservedDays({
        computed,
        stored: currentPrescriptions,
        weekStart: row.week_start,
        preserveDaysThrough: todayChanged ? isoDaysAgo(todayIso, 1) : todayIso,
      });
```

(The `catch` fallback that clears changed days stays exactly as-is.)

- [ ] **Step 5: apply-activity-layout — same merge**

In `lib/training-weeks/apply-activity-layout.ts`, add the same three imports as Step 4, and replace the recompute line (~line 95, inside the existing `try`):

```ts
    const tz = await getUserTimezone(userId);
    const todayIso = todayInUserTz(new Date(), tz);
    const computed = await prescribeWeek({ supabase, userId, block, week: workingRow, todayIso });
    // Same preservation rule as the swap route: protect days ≤ today unless
    // the layout change moved today's session type.
    const todayIdx = daysBetweenIso(mondayOfIso(todayIso), todayIso);
    const todayWeekday = todayIdx != null ? WEEKDAY_LONG_ORDER[todayIdx] : null;
    const todayChanged = todayWeekday != null && changedFull.includes(todayWeekday);
    nextPrescriptions = mergePreservedDays({
      computed,
      stored: currentPrescriptions,
      weekStart: row.week_start,
      preserveDaysThrough: todayChanged ? isoDaysAgo(todayIso, 1) : todayIso,
    });
```

Note: verify `changedFull` is in scope at that point in this file (it is used by the catch fallback a few lines below); if its declaration sits after the try block, hoist it above the try.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: typecheck clean; 127 passed, 0 failed.

```bash
git add lib/coach/tools.ts "app/api/training-weeks/[week_start]/swap/route.ts" lib/training-weeks/apply-activity-layout.ts scripts/audit-prescription-rules.mjs
git commit -m "fix(engine): full-week writers preserve days ≤ today (I1 fast-follow)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `diffDay` extraction + `exerciseRegion` export

**Files:**
- Modify: `lib/coach/prescription/repatch-week.ts` (extract per-day diff)
- Modify: `lib/coach/prescription/prescribe-week.ts:79` (export `exerciseRegion`)
- Test: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: existing `diffFutureDays`, `workingByName`, `NUMERIC_FIELDS` internals of repatch-week.ts.
- Produces: `export function diffDay(stored: PlannedExercise[], next: PlannedExercise[], weekday: WeekdayLong): RepatchChange[]` from `@/lib/coach/prescription/repatch-week`; `export function exerciseRegion(name: string): MuscleRegion | null` from `@/lib/coach/prescription/prescribe-week`. Task 3/4/5 import both.

- [ ] **Step 1: Failing fixture**

Append to `scripts/audit-prescription-rules.mjs` (add `diffDay` to the repatch-week import):

```js
console.log("\n## repatch-week.ts — diffDay (single-day diff)\n");

{
  const stored = [
    { name: "Squat (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
    { name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 },
  ];
  const next = [
    { name: "Squat (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
    { name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 2, rir: 3 },
  ];
  const changes = diffDay(stored, next, "Monday");
  assert("diffDay: two field changes detected", changes.length === 2);
  assert("diffDay: sets change recorded", changes.some((c) => c.field === "sets" && c.from === 3 && c.to === 2));
  assert("diffDay: rir change recorded", changes.some((c) => c.field === "rir" && c.from === 2 && c.to === 3));
  assert("diffDay: weekday stamped", changes.every((c) => c.weekday === "Monday"));
  assert("diffDay: identical inputs → empty", diffDay(next, next, "Monday").length === 0);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — `diffDay` is not exported.

- [ ] **Step 3: Extract `diffDay` in repatch-week.ts**

Add the exported function below `workingByName` and rewrite `diffFutureDays`'s inner loop to delegate:

```ts
/** Field-level diff between two versions of ONE day's exercise list.
 *  Warmup rows excluded; exercises matched by name (first non-warmup row).
 *  Pure; exported for the audit script and the morning-patch module. */
export function diffDay(
  stored: PlannedExercise[],
  next: PlannedExercise[],
  weekday: WeekdayLong,
): RepatchChange[] {
  const storedDay = workingByName(stored);
  const nextDay = workingByName(next);
  const changes: RepatchChange[] = [];

  for (const [name, s] of storedDay) {
    const n = nextDay.get(name);
    if (!n) {
      changes.push({ weekday, exercise: name, field: "removed", from: name, to: null });
      continue;
    }
    for (const field of NUMERIC_FIELDS) {
      const from = s[field] ?? null;
      const to = n[field] ?? null;
      if (from !== to) changes.push({ weekday, exercise: name, field, from, to });
    }
  }
  for (const name of nextDay.keys()) {
    if (!storedDay.has(name)) {
      changes.push({ weekday, exercise: name, field: "added", from: null, to: name });
    }
  }
  return changes;
}
```

`diffFutureDays`'s per-weekday body becomes:

```ts
  for (let i = todayIdx + 1; i < WEEKDAY_LONG_ORDER.length; i++) {
    const weekday: WeekdayLong = WEEKDAY_LONG_ORDER[i];
    changes.push(...diffDay(opts.stored[weekday] ?? [], opts.next[weekday] ?? [], weekday));
  }
```

- [ ] **Step 4: Export `exerciseRegion` in prescribe-week.ts**

At ~line 79, change `function exerciseRegion(` to `export function exerciseRegion(` (JSDoc already present; no other change).

- [ ] **Step 5: Move `mondayOfIso` to the client-safe date lib**

`repatch-week.ts`'s import graph reaches server-only code (via `upsert-week-prescription` → `prescribe-week` → `fetchMuscleVolumeServer`), so client components must NOT import from it. `mondayOfIso` is pure date math and belongs in `lib/time/dates.ts` (client-safe):

Move the function body verbatim from `repatch-week.ts` into `lib/time/dates.ts` (keep the JSDoc), then in `repatch-week.ts` replace the definition with a re-export so all existing importers (logger route, debrief loader, Task 1's swap/layout edits) keep working unchanged:

```ts
export { mondayOfIso } from "@/lib/time/dates";
```

Note: `lib/time/dates.ts` has a vitest suite at `lib/time/__tests__/` — run `npx vitest run` and confirm nothing broke (the file gains a function, changes nothing existing).

- [ ] **Step 6: Verify + commit**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && npm run typecheck && npx vitest run`
Expected: 132 passed (127 + 5), typecheck clean, vitest green. All pre-existing diffFutureDays and mondayOfIso assertions must still pass (both refactors are behavior-preserving).

```bash
git add lib/coach/prescription/repatch-week.ts lib/coach/prescription/prescribe-week.ts lib/time/dates.ts scripts/audit-prescription-rules.mjs
git commit -m "refactor(engine): extract diffDay, export exerciseRegion, move mondayOfIso to lib/time

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `patch-today.ts` + `patch-log.ts` — pure rung→transform + revert helpers

**Files:**
- Create: `lib/coach/prescription/patch-log.ts` (client-safe log guards — imports TYPES ONLY, so client components can use them without dragging the server import graph)
- Create: `lib/coach/prescription/patch-today.ts` (transform + revert; server-graph imports are fine here — only routes and the audit script consume it)
- Modify: `lib/morning/brief/assembler.ts:237` (export `sorenessAreasToRegions`)
- Test: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: `lightenExercise`, `exerciseRegion` from `@/lib/coach/prescription/prescribe-week`; `SESSION_REGION_MAP` from `@/lib/coach/activity/sequence-week`; `ReactiveRung` from `@/lib/coach/activity/reactive-ladder`; `RepatchChange`, `RepatchLogEntry` from `@/lib/data/types`; `PlannedExercise` from `@/lib/coach/sessionPlans`; `MuscleRegion` from `@/lib/coach/activity/types`.
- Produces (all pure, all exported):
  - From `@/lib/coach/prescription/patch-log` (client-safe; Task 6's chip imports from HERE):
    - `hasMorningPatchEntry(log: RepatchLogEntry[] | null, todayIso: string): boolean`
    - `hasMorningRevertEntry(log: RepatchLogEntry[] | null, todayIso: string): boolean`
  - From `@/lib/coach/prescription/patch-today` (server-side; Tasks 4/5 import them; it re-exports the two guards for convenience):
    - `patchExercisesForRung(exercises: PlannedExercise[], rung: ReactiveRung, sessionType: string, regions: MuscleRegion[]): PlannedExercise[]`
    - `revertDayExercises(exercises: PlannedExercise[], changes: RepatchChange[]): PlannedExercise[]`
  - Also: `export function sorenessAreasToRegions(...)` from `@/lib/morning/brief/assembler` (add `export` keyword only).

- [ ] **Step 1: Failing fixtures**

Append to `scripts/audit-prescription-rules.mjs` (new import from `"@/lib/coach/prescription/patch-today"`):

```js
console.log("\n## patch-today.ts — rung transforms + revert\n");

{
  const legs = [
    { name: "Squat (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
    { name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 },
    { name: "Leg Extension (Machine)", baseKg: 50, baseReps: 12, sets: 3, rir: 2 },
  ];

  // load_down: RIR +1 on affected, weight/sets/reps held, warmup untouched
  const eased = patchExercisesForRung(legs, "load_down", "Legs", ["legs"]);
  assert("load_down: working squat rir 2→3", eased[1].rir === 3);
  assert("load_down: kg held", eased[1].baseKg === 130 && eased[2].baseKg === 50);
  assert("load_down: sets/reps held", eased[1].sets === 3 && eased[2].baseReps === 12);
  assert("load_down: warmup untouched", eased[0].rir === undefined && eased[0].sets === 2);
  assert("load_down: rir caps at 5", patchExercisesForRung(
    [{ name: "Squat (Barbell)", baseKg: 100, baseReps: 6, sets: 3, rir: 5 }],
    "load_down", "Legs", ["legs"])[0].rir === 5);

  // region gating: chest exercise on Legs day with sore legs → untouched
  const mixed = patchExercisesForRung(
    [{ name: "Chest Fly (Machine)", baseKg: 90, baseReps: 12, sets: 3, rir: 2 }],
    "load_down", "Legs", ["legs"]);
  assert("load_down: non-affected region untouched", mixed[0].rir === 2);

  // volume_down delegates to lightenExercise tiering (primary compound: sets−1 floor 2, reps−1, rir+1)
  const trimmed = patchExercisesForRung(legs, "volume_down", "Legs", ["legs"]);
  assert("volume_down: compound sets 3→2", trimmed[1].sets === 2);
  assert("volume_down: compound rir 2→3", trimmed[1].rir === 3);
  assert("volume_down: kg held", trimmed[1].baseKg === 130);
  // high-rep accessory (baseReps ≥ 10): eccentric tier → sets−2 floor 1, rir+2
  assert("volume_down: accessory sets 3→1", trimmed[2].sets === 1);
  assert("volume_down: accessory rir 2→4", trimmed[2].rir === 4);

  // escalation + none rungs are identity
  assert("swap_day: identity", patchExercisesForRung(legs, "swap_day", "Legs", ["legs"]) === legs);
  assert("none: identity", patchExercisesForRung(legs, "none", "Legs", ["legs"]) === legs);

  // apply → revert identity via diffDay changes
  const changes = diffDay(legs, trimmed, "Monday");
  const restored = revertDayExercises(trimmed, changes);
  assert("revert: squat sets restored", restored[1].sets === 3);
  assert("revert: squat rir restored", restored[1].rir === 2);
  assert("revert: accessory restored", restored[2].sets === 3 && restored[2].rir === 2);
  assert("revert: full identity vs diff", diffDay(legs, restored, "Monday").length === 0);

  // repatch_log entry guards
  const log = [
    { at: "2026-07-07T05:00:00Z", reason: "workout_commit", workout_date: "2026-07-06", changes: [] },
    { at: "2026-07-07T06:00:00Z", reason: "morning_checkin", workout_date: "2026-07-07", changes },
  ];
  assert("hasMorningPatchEntry: true for today", hasMorningPatchEntry(log, "2026-07-07") === true);
  assert("hasMorningPatchEntry: false other day", hasMorningPatchEntry(log, "2026-07-08") === false);
  assert("hasMorningPatchEntry: null log", hasMorningPatchEntry(null, "2026-07-07") === false);
  assert("hasMorningRevertEntry: false before revert", hasMorningRevertEntry(log, "2026-07-07") === false);
  assert("hasMorningRevertEntry: true after revert", hasMorningRevertEntry(
    [...log, { at: "2026-07-07T07:00:00Z", reason: "morning_checkin_revert", workout_date: "2026-07-07", changes: [] }],
    "2026-07-07") === true);
}
```

Fixture caveat (eccentric tier): the `volume_down` accessory assertions (`sets 3→1`, `rir 2→4`) assume "Leg Extension (Machine)" resolves to the `legs` region via `getExerciseMuscles` → eccentric_accessory tier. Verify before trusting the expected values:
`node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "import {classifyLightenTier} from '@/lib/coach/prescription/prescribe-week'; console.log(classifyLightenTier({name:'Leg Extension (Machine)', baseReps:12, sets:3}, ['legs']))"`
If it prints `other_accessory` (name unmapped in exercise-muscles), swap the fixture exercise to one that IS mapped to legs (try `"Leg Curl (Machine)"`, verify the same way) so the eccentric-tier expectations hold. Do not weaken the assertions to match the wrong tier.

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client-safe log guards**

Create `lib/coach/prescription/patch-log.ts`:

```ts
// lib/coach/prescription/patch-log.ts
//
// Client-safe repatch_log guards for the morning-ladder patch. This module
// imports TYPES ONLY — client components (MorningPatchChip) import from here;
// pulling these from patch-today.ts would drag the server-only import graph
// (prescribe-week → fetchMuscleVolumeServer) into the client bundle.

import type { RepatchLogEntry } from "@/lib/data/types";

/** True when today already has an (applied) morning patch entry. */
export function hasMorningPatchEntry(log: RepatchLogEntry[] | null, todayIso: string): boolean {
  if (!Array.isArray(log)) return false;
  return log.some((e) => e.reason === "morning_checkin" && e.workout_date === todayIso);
}

/** True when today's morning patch has been reverted. */
export function hasMorningRevertEntry(log: RepatchLogEntry[] | null, todayIso: string): boolean {
  if (!Array.isArray(log)) return false;
  return log.some((e) => e.reason === "morning_checkin_revert" && e.workout_date === todayIso);
}
```

- [ ] **Step 4: Implement the transform module**

Create `lib/coach/prescription/patch-today.ts`:

```ts
// lib/coach/prescription/patch-today.ts
//
// Morning-ladder prescription patches: converts the reactive ladder's graded
// rungs (load_down / volume_down) into real, revertible changes on TODAY's
// session_prescriptions entry. Escalation rungs (swap_exercise / swap_day)
// stay with the BriefCoachSuggestion chip — numbers are not the remedy there.
// Load (baseKg) is NEVER touched — volume + RIR are the levers, matching
// lightenExercise's evidence-based design.
//
// Pure helpers live at the top (fixture-audited); the async apply primitive
// applyMorningPatch and revert plumbing are below (route-consumed).
//
// Spec: docs/superpowers/specs/2026-07-09-morning-ladder-prescription-patches-design.md

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { RepatchChange, RepatchLogEntry } from "@/lib/data/types";
import type { ReactiveRung } from "@/lib/coach/activity/reactive-ladder";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import { SESSION_REGION_MAP } from "@/lib/coach/activity/sequence-week";
import { lightenExercise, exerciseRegion } from "@/lib/coach/prescription/prescribe-week";

/** True when the exercise is region-gated INTO the patch: its own region is
 *  affected, or (unknown region) its session's regions overlap the affected
 *  set. Mirrors lightenExercise's gating exactly. */
function isAffected(ex: PlannedExercise, sessionType: string, regions: MuscleRegion[]): boolean {
  const exReg = exerciseRegion(ex.name);
  if (exReg !== null) return regions.includes(exReg);
  const sessionRegs = SESSION_REGION_MAP[sessionType] ?? [];
  return sessionRegs.some((r) => regions.includes(r));
}

/** Map a reactive-ladder rung to a transform of today's exercise list.
 *   load_down   → RIR +1 (cap 5) on affected working exercises; all else held.
 *   volume_down → lightenExercise tiering (sets/reps cuts + RIR bumps).
 *   none / swap_exercise / swap_day → identity (returns the input array). */
export function patchExercisesForRung(
  exercises: PlannedExercise[],
  rung: ReactiveRung,
  sessionType: string,
  regions: MuscleRegion[],
): PlannedExercise[] {
  if (rung === "volume_down") {
    return exercises.map((ex) => lightenExercise(ex, sessionType, regions));
  }
  if (rung !== "load_down") return exercises;
  return exercises.map((ex) => {
    if (ex.warmup) return ex;
    if (ex.sets == null && ex.baseReps == null) return ex;
    if (!isAffected(ex, sessionType, regions)) return ex;
    return { ...ex, rir: Math.min(5, (ex.rir ?? 2) + 1) };
  });
}

// Client-safe log guards live in patch-log.ts (types-only imports);
// re-exported here so server-side consumers can import everything from one place.
export { hasMorningPatchEntry, hasMorningRevertEntry } from "@/lib/coach/prescription/patch-log";

const REVERTIBLE_FIELDS = new Set(["baseKg", "baseReps", "sets", "rir"]);

/** Restore the `from` values of a morning patch onto today's exercise list.
 *  Only numeric fields are revertible — the morning patch never adds or
 *  removes exercises, so `added`/`removed` changes are skipped defensively.
 *  Exercises matched by name on non-warmup rows (diffDay's convention). */
export function revertDayExercises(
  exercises: PlannedExercise[],
  changes: RepatchChange[],
): PlannedExercise[] {
  return exercises.map((ex) => {
    if (ex.warmup) return ex;
    const mine = changes.filter(
      (c) => c.exercise === ex.name && REVERTIBLE_FIELDS.has(c.field),
    );
    if (mine.length === 0) return ex;
    const out = { ...ex };
    for (const c of mine) {
      const field = c.field as "baseKg" | "baseReps" | "sets" | "rir";
      if (c.from == null) delete out[field];
      else out[field] = c.from as number;
    }
    return out;
  });
}

```

(The fixture block imports `patchExercisesForRung`, `revertDayExercises`, `hasMorningPatchEntry`, `hasMorningRevertEntry` all from `"@/lib/coach/prescription/patch-today"` — the re-export makes that work.)

- [ ] **Step 5: Export `sorenessAreasToRegions`**

In `lib/morning/brief/assembler.ts` ~line 237, change `function sorenessAreasToRegions(` to `export function sorenessAreasToRegions(`.

- [ ] **Step 6: Verify + commit**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && npm run typecheck`
Expected: 154 passed (132 + 22), typecheck clean.

```bash
git add lib/coach/prescription/patch-log.ts lib/coach/prescription/patch-today.ts lib/morning/brief/assembler.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(engine): morning-patch rung transforms + revert helpers (pure)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `applyMorningPatch` + trigger in the recommendation route

**Files:**
- Modify: `lib/coach/prescription/patch-today.ts` (append the async primitive)
- Modify: `app/api/chat/morning/recommendation/route.ts:92-97` (trigger)

**Interfaces:**
- Consumes: `selectReactiveRung` from `@/lib/coach/activity/reactive-ladder`; `sorenessAreasToRegions` from `@/lib/morning/brief/assembler` (Task 3); `loadRecentActivityForBrief(supabase, userId, today)` from `@/lib/morning/brief/data-sources`; `readSessionForDay` from `@/lib/coach/session-plan-reader`; `mondayOfIso`, `diffDay` from `@/lib/coach/prescription/repatch-week`; `daysBetweenIso` from `@/lib/time/dates`; `WEEKDAY_LONG_ORDER` from `@/lib/coach/prescription/upsert-week-prescription`; `CheckinRow`, `SessionPrescriptions`, `TrainingWeek`, `WeekdayLong` types.
- Produces: `applyMorningPatch(opts: { supabase: SupabaseClient; userId: string; todayIso: string }): Promise<{ applied: boolean; changes: RepatchChange[] } | null>` — Task 5's revert endpoint and Task 6's chip rely on the `repatch_log` entries it writes.

- [ ] **Step 1: Append the primitive to patch-today.ts**

```ts
// ── apply primitive (route-consumed) ────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CheckinRow, SessionPrescriptions, TrainingWeek, WeekdayLong } from "@/lib/data/types";
import { selectReactiveRung } from "@/lib/coach/activity/reactive-ladder";
import { sorenessAreasToRegions } from "@/lib/morning/brief/assembler";
import { loadRecentActivityForBrief } from "@/lib/morning/brief/data-sources";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { mondayOfIso, diffDay } from "@/lib/coach/prescription/repatch-week";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import { daysBetweenIso } from "@/lib/time/dates";

const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Auto-apply the morning-ladder patch to TODAY's session_prescriptions.
 *  Returns null on every no-op path (no check-in, rung not graded, no stored
 *  prescriptions, REST/Mobility, already patched today, empty diff).
 *  Throws only on Supabase write errors — callers wrap in try/catch. */
export async function applyMorningPatch(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<{ applied: boolean; changes: RepatchChange[] } | null> {
  const { supabase, userId, todayIso } = opts;

  // 1. Today's check-in → rung inputs. No soreness reported → nothing to do
  //    from the soreness path; recent activity alone can still grade a rung.
  const { data: checkinData } = await supabase
    .from("checkins")
    .select("soreness_areas, soreness_severity, fatigue")
    .eq("user_id", userId)
    .eq("date", todayIso)
    .maybeSingle();
  const checkin = checkinData as Pick<CheckinRow, "soreness_areas" | "soreness_severity" | "fatigue"> | null;
  if (!checkin) return null;

  // 2. Current week row + today's stored prescription entry.
  const weekStart = mondayOfIso(todayIso);
  const { data: weekData } = await supabase
    .from("training_weeks")
    .select("session_plan, session_prescriptions, repatch_log")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  const week = weekData as Pick<TrainingWeek, "session_plan" | "session_prescriptions" | "repatch_log"> | null;
  if (!week?.session_prescriptions) return null;

  const todayIdx = daysBetweenIso(weekStart, todayIso);
  if (todayIdx == null || todayIdx < 0 || todayIdx > 6) return null;
  const weekdayLong: WeekdayLong = WEEKDAY_LONG_ORDER[todayIdx];
  const stored = (week.session_prescriptions as SessionPrescriptions)[weekdayLong];
  if (!stored || stored.length === 0) return null;

  const sessionType = readSessionForDay(week.session_plan ?? {}, SHORT_WEEKDAYS[todayIdx]);
  if (!sessionType || sessionType === "REST" || sessionType === "Mobility") return null;

  // 3. Idempotency: one morning patch per day (covers brief_failed retries).
  const log = Array.isArray(week.repatch_log) ? (week.repatch_log as RepatchLogEntry[]) : [];
  if (hasMorningPatchEntry(log, todayIso)) return null;

  // 4. Grade the rung exactly as the brief does.
  const sessionRegions = SESSION_REGION_MAP[sessionType] ?? [];
  const soreRegions = sorenessAreasToRegions(checkin.soreness_areas ?? null);
  const recentActivity = await loadRecentActivityForBrief(supabase, userId, todayIso);
  const ladder = selectReactiveRung({
    sessionRegions,
    soreRegions,
    soreSeverity: checkin.soreness_severity ?? null,
    fatigue: checkin.fatigue ?? null,
    recentActivity,
  });
  if (ladder.rung !== "load_down" && ladder.rung !== "volume_down") return null;

  // 5. Transform, diff, write.
  const patched = patchExercisesForRung(stored, ladder.rung, sessionType, ladder.regions);
  const changes = diffDay(stored, patched, weekdayLong);
  if (changes.length === 0) return null;

  const entry: RepatchLogEntry = {
    at: new Date().toISOString(),
    reason: "morning_checkin",
    workout_date: todayIso,
    changes,
  };
  const nextPrescriptions: SessionPrescriptions = {
    ...(week.session_prescriptions as SessionPrescriptions),
    [weekdayLong]: patched,
  };
  const { error } = await supabase
    .from("training_weeks")
    .update({ session_prescriptions: nextPrescriptions, repatch_log: [...log, entry] })
    .eq("user_id", userId)
    .eq("week_start", weekStart);
  if (error) throw error;

  return { applied: true, changes };
}
```

Note: the file gains imports mid-file per this step's block; move them to the top import section with the others (house style — one import block).

- [ ] **Step 2: Trigger in the recommendation route**

In `app/api/chat/morning/recommendation/route.ts`, add import `import { applyMorningPatch } from "@/lib/coach/prescription/patch-today";` and insert BETWEEN the `assembling_brief` upsert (~line 93-96) and `const encoder = new TextEncoder();`:

```ts
  // Morning-ladder patch: graded soreness/fatigue rungs write real changes to
  // today's session_prescriptions BEFORE the brief assembles, so the brief,
  // Carter, and the logger all read the same adjusted numbers. Non-fatal —
  // on failure the brief degrades to cue-only (previous behavior).
  try {
    await applyMorningPatch({ supabase: sr, userId: user.id, todayIso: today });
  } catch (err) {
    console.error("[morning/recommendation] applyMorningPatch failed:", err);
  }
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && node scripts/audit-timezone-usage.mjs`
Expected: all clean (152 assertions; the route passes `today` which is already user-tz).

```bash
git add lib/coach/prescription/patch-today.ts app/api/chat/morning/recommendation/route.ts
git commit -m "feat(morning): auto-apply ladder patch to today's prescriptions before brief

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Revert endpoint

**Files:**
- Create: `app/api/chat/morning/revert-patch/route.ts`

**Interfaces:**
- Consumes: `revertDayExercises`, `hasMorningPatchEntry`, `hasMorningRevertEntry` from `@/lib/coach/prescription/patch-today`; `mondayOfIso` from `@/lib/coach/prescription/repatch-week`; `WEEKDAY_LONG_ORDER` from `@/lib/coach/prescription/upsert-week-prescription`; `daysBetweenIso` from `@/lib/time/dates`; `getUserTimezone` + `todayInUserTz`.
- Produces: `POST /api/chat/morning/revert-patch` → `{ ok: true }` | 404 `{ error: "no_patch" | "already_reverted" | "no_week" }` | 401. Task 6's chip calls it.

- [ ] **Step 1: Implement the route**

Create `app/api/chat/morning/revert-patch/route.ts`:

```ts
// POST /api/chat/morning/revert-patch
//
// Undo today's auto-applied morning-ladder patch: restore the exact `from`
// values recorded in the repatch_log entry and append a morning_checkin_revert
// entry (append-only log — nothing is deleted). Idempotent: a second call
// 404s with "already_reverted".

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { daysBetweenIso, mondayOfIso } from "@/lib/time/dates";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import {
  revertDayExercises,
  hasMorningPatchEntry,
  hasMorningRevertEntry,
} from "@/lib/coach/prescription/patch-today";
import type { RepatchLogEntry, SessionPrescriptions, TrainingWeek, WeekdayLong } from "@/lib/data/types";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);
  const weekStart = mondayOfIso(todayIso);

  const { data: weekData, error: readErr } = await supabase
    .from("training_weeks")
    .select("session_prescriptions, repatch_log")
    .eq("user_id", user.id)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const week = weekData as Pick<TrainingWeek, "session_prescriptions" | "repatch_log"> | null;
  if (!week?.session_prescriptions) return NextResponse.json({ error: "no_week" }, { status: 404 });

  const log = Array.isArray(week.repatch_log) ? (week.repatch_log as RepatchLogEntry[]) : [];
  if (!hasMorningPatchEntry(log, todayIso)) return NextResponse.json({ error: "no_patch" }, { status: 404 });
  if (hasMorningRevertEntry(log, todayIso)) return NextResponse.json({ error: "already_reverted" }, { status: 404 });

  const patchEntry = [...log].reverse().find(
    (e) => e.reason === "morning_checkin" && e.workout_date === todayIso,
  )!;

  const todayIdx = daysBetweenIso(weekStart, todayIso);
  if (todayIdx == null || todayIdx < 0 || todayIdx > 6) {
    return NextResponse.json({ error: "no_week" }, { status: 404 });
  }
  const weekdayLong: WeekdayLong = WEEKDAY_LONG_ORDER[todayIdx];
  const prescriptions = week.session_prescriptions as SessionPrescriptions;
  const current = prescriptions[weekdayLong] ?? [];

  const restored = revertDayExercises(current, patchEntry.changes);
  const revertEntry: RepatchLogEntry = {
    at: new Date().toISOString(),
    reason: "morning_checkin_revert",
    workout_date: todayIso,
    // Inverse diff for the audit trail.
    changes: patchEntry.changes.map((c) => ({ ...c, from: c.to, to: c.from })),
  };

  const { error: writeErr } = await supabase
    .from("training_weeks")
    .update({
      session_prescriptions: { ...prescriptions, [weekdayLong]: restored },
      repatch_log: [...log, revertEntry],
    })
    .eq("user_id", user.id)
    .eq("week_start", weekStart);
  if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && node scripts/audit-timezone-usage.mjs`
Expected: clean.

```bash
git add app/api/chat/morning/revert-patch/route.ts
git commit -m "feat(morning): revert endpoint for the morning-ladder patch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Revert chip on the brief session block

**Files:**
- Create: `components/morning/MorningPatchChip.tsx`
- Modify: `components/morning/BriefSessionList.tsx` (render the chip)

**Interfaces:**
- Consumes: `useUserToday` from `@/lib/query/hooks/useUserToday`; `useTrainingWeek(userId, weekStart)` from `@/lib/query/hooks/useTrainingWeek`; `queryKeys.trainingWeeks.one` from `@/lib/query/keys`; `mondayOfIso` from `@/lib/time/dates` (Task 2 moved it there — CLIENT-SAFE; do NOT import from repatch-week in a client component, its graph reaches server-only code); `hasMorningPatchEntry`, `hasMorningRevertEntry` from `@/lib/coach/prescription/patch-log` (types-only module, client-safe — NOT from patch-today); `POST /api/chat/morning/revert-patch` (Task 5).
- Produces: `<MorningPatchChip userId={...} />` rendered inside `BriefSessionList` above the exercise list.

- [ ] **Step 0: Ensure the training-week fetcher selects `repatch_log`**

The chip reads `week.repatch_log` via `useTrainingWeek` → `fetchTrainingWeekBrowser`. Check the select string:
Run: `grep -n "select" lib/query/fetchers/trainingWeek.ts`
If the fetcher selects `"*"`, nothing to do. If it selects an explicit column list without `repatch_log`, add `repatch_log` to BOTH the server and browser variants (project rule: the two variants share the same select string and return shape) and confirm the row type used by the fetcher includes the field (it does — `TrainingWeek.repatch_log` shipped in PR #143).

- [ ] **Step 1: Locate BriefSessionList's props and userId availability**

Run: `grep -n "userId\|type Props\|function BriefSessionList" components/morning/BriefSessionList.tsx | head -15`
Two outcomes: (a) the component already receives `userId` (it renders `LoggerSheet`, which requires it) — use it directly; (b) if it genuinely lacks `userId`, run `grep -rn "BriefSessionList" components/ --include="*.tsx" | grep -v "BriefSessionList.tsx"` to find the parent, and thread a `userId: string` prop down from it (the parent renders the morning brief card and has the authed user id in scope).

- [ ] **Step 2: Implement the chip**

Create `components/morning/MorningPatchChip.tsx`:

```tsx
"use client";
// Revert affordance for the auto-applied morning-ladder patch.
// State derives LIVE from the training_weeks row (repatch_log) — the brief's
// ui jsonb is never rewritten. Hidden when: no patch today, already reverted,
// or the patched exercise names no longer appear in today's plan (a later
// day-type swap made the patch moot).

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import { useUserToday } from "@/lib/query/hooks/useUserToday";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { mondayOfIso } from "@/lib/time/dates";
import { hasMorningPatchEntry, hasMorningRevertEntry } from "@/lib/coach/prescription/patch-log";
import type { RepatchLogEntry, SessionPrescriptions, WeekdayLong } from "@/lib/data/types";

const WEEKDAY_LONG: WeekdayLong[] = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

export function MorningPatchChip({ userId }: { userId: string }) {
  const today = useUserToday();
  const weekStart = today ? mondayOfIso(today) : "";
  const { data: week } = useTrainingWeek(userId, weekStart);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (!today || !week) return null;
  const log = Array.isArray(week.repatch_log) ? (week.repatch_log as RepatchLogEntry[]) : [];
  if (!hasMorningPatchEntry(log, today) || hasMorningRevertEntry(log, today)) return null;

  const patchEntry = [...log].reverse().find(
    (e) => e.reason === "morning_checkin" && e.workout_date === today,
  );
  if (!patchEntry || patchEntry.changes.length === 0) return null;

  // Hide when a later day-swap replaced today's exercises (names no longer match).
  const d = new Date(today + "T00:00:00Z");
  const weekdayLong = WEEKDAY_LONG[(d.getUTCDay() + 6) % 7];
  const todayNames = new Set(
    ((week.session_prescriptions as SessionPrescriptions | null)?.[weekdayLong] ?? [])
      .filter((ex) => !ex.warmup)
      .map((ex) => ex.name),
  );
  if (!patchEntry.changes.some((c) => todayNames.has(c.exercise))) return null;

  const onRevert = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/chat/morning/revert-patch", { method: "POST" });
      if (res.ok) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.trainingWeeks.one(userId, weekStart),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs"
      style={{ background: COLOR.surfaceAlt ?? "rgba(255,255,255,0.05)" }}
    >
      <span style={{ color: COLOR.textDim ?? undefined }}>
        Adjusted for how you feel this morning — volume/effort eased, weight unchanged.
      </span>
      <button
        onClick={onRevert}
        disabled={busy}
        className="shrink-0 rounded-md border px-2 py-1 font-medium"
        style={{ borderColor: COLOR.border ?? "rgba(255,255,255,0.15)" }}
      >
        {busy ? "…" : "Revert"}
      </button>
    </div>
  );
}
```

Style note: match `BriefSessionList`'s existing COLOR usage — check which `COLOR` keys it uses (e.g. `COLOR.dim`, `COLOR.card`) and use the same ones instead of the `??` fallbacks above if they differ; the structure (row + small button) is the contract, exact token names follow the file's conventions.

- [ ] **Step 3: Render inside BriefSessionList**

In `components/morning/BriefSessionList.tsx`, import the chip and render it once, directly above the exercise list (after the `SessionStructureBanner` if present):

```tsx
import { MorningPatchChip } from "@/components/morning/MorningPatchChip";
// … inside the JSX, above the exercises list:
<MorningPatchChip userId={userId} />
```

(Using the `userId` established in Step 1.)

- [ ] **Step 4: Verify (typecheck + build — hooks rule) + commit**

Run: `npm run typecheck && npm run build`
Expected: both clean. The build is mandatory here — this task adds hooks to a client component (React #310 class of bugs passes typecheck but crashes prod; keep all hooks above the early returns, as written).

```bash
git add components/morning/MorningPatchChip.tsx components/morning/BriefSessionList.tsx
git commit -m "feat(morning): revert chip for auto-applied soreness patch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Cue text alignment + Carter bullet + full verification

**Files:**
- Modify: `lib/coach/session-structure/annotate.ts:125-139` (`sorenessAwareCue`)
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE repatch bullet, ~line 133)

**Interfaces:**
- Consumes: nothing new — prose only.

- [ ] **Step 1: Rewrite the two graded-rung cue strings**

In `lib/coach/session-structure/annotate.ts`, `sorenessAwareCue` — the `load_down` and `volume_down` cases become statements of fact (the patch already applied); `swap_exercise`/`swap_day` unchanged:

```ts
    case "load_down":
      return `Effort eased on ${regionStr} today — weight unchanged.`;
    case "volume_down":
      return `Volume trimmed on ${regionStr} today — soreness + fatigue.`;
```

- [ ] **Step 2: Extend Carter's repatch bullet**

In `lib/coach/system-prompts.ts`, find the CARTER_BASE bullet added in PR #143 (starts "- The engine re-runs for the REMAINING days of the current week after each committed session"). Append one sentence to that same bullet, before its closing period structure:

```
 Morning check-in answers (soreness/fatigue) may also auto-adjust TODAY's volume/RIR before the brief — the stored prescription remains canonical and the change is logged in the week's repatch history.
```

- [ ] **Step 3: Full verification suite**

```bash
npm run typecheck
npx vitest run
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
node scripts/audit-timezone-usage.mjs
npm run build
```

Expected: all PASS (audit at 154). Optionally with live creds: `AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs` → 28/28 (Sunday semantics untouched by this arc).

- [ ] **Step 4: Commit**

```bash
git add lib/coach/session-structure/annotate.ts lib/coach/system-prompts.ts
git commit -m "feat(coach): cue text states applied patch; teach Carter morning patches

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
