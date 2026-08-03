# Debrief Reads the Stored Prescription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every weight the post-workout debrief displays come from the stored plan instead of a second, divergent implementation of load progression.

**Architecture:** A new `readNextSessionPrescription` walks forward from the workout date to find the next session of the same type, reads `training_weeks.session_prescriptions` for that weekday, and falls back to `prescribeWeek` inline when the row has no prescription yet — the same two-tier read the weekly review already uses. `composePrescription` then stops computing loads entirely: it looks up each of today's lifts in that prescription and reports the stored number, keeping its block-phase rationale prose.

**Tech Stack:** TypeScript (strict), Supabase/PostgREST, vitest (node env).

## Global Constraints

- Path alias `@/*` → repo root. Use it; never relative climbs.
- Verification is `npm run typecheck` + `npx vitest run`. `npm run lint` is a no-op (unconfigured `next lint` that hangs) — do not run it.
- Unit tests live under `lib/**/__tests__/**/*.test.ts` — that glob is the only thing vitest scans. Tests elsewhere silently do not run.
- **`SessionPlan` keys may be short (`"Mon"`) OR long (`"Monday"`).** Never index a session plan directly — always use `readSessionForDay(plan, weekday)` from [lib/coach/session-plan-reader.ts](../../../lib/coach/session-plan-reader.ts). Direct indexing silently returns `undefined` on production data.
- **`baseKg == null` must skip the lift, never coerce to `0`.** Bodyweight entries (Push Up, Back Extension, Reverse Crunch) carry no load, and a `?? 0` fallback reintroduces the `→ 0kg — Hold 0 kg` rows removed in PR #161.
- Warmup entries must be filtered out when matching by name — warmup ramps are separate entries sharing the working entry's name.
- This path is **read-only**. Never write to `training_weeks`.
- Do NOT change `prescribeWeek`, the volume rules, or `compose-lifts`'s `tag` computation.
- Spec: [docs/superpowers/specs/2026-08-03-debrief-reads-stored-prescription-design.md](../specs/2026-08-03-debrief-reads-stored-prescription-design.md)

---

### Task 1: `readNextSessionPrescription`

**Files:**
- Create: `lib/coach/session-debrief/next-session-prescription.ts`
- Test: `lib/coach/session-debrief/__tests__/next-session-prescription.test.ts`

**Interfaces:**
- Consumes: `prescribeWeek` from `@/lib/coach/prescription/prescribe-week`, `readSessionForDay` from `@/lib/coach/session-plan-reader`, `mondayOfIso` from `@/lib/time/dates`, `WEEKDAY_LONG_ORDER` from `@/lib/coach/prescription/upsert-week-prescription`.
- Produces:
  - `export type NextSessionPrescription = { date: string; weekday: WeekdayLong; exercises: PlannedExercise[]; source: "row" | "inline" }`
  - `export async function readNextSessionPrescription(opts: { supabase: SupabaseClient; userId: string; sessionType: string; afterIso: string; block: TrainingBlock | null; todayIso: string }): Promise<NextSessionPrescription | null>`

- [ ] **Step 1: Write the failing test**

Create `lib/coach/session-debrief/__tests__/next-session-prescription.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readNextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";

/** Stubs the single query the reader makes per week:
 *  from("training_weeks").select(...).eq(...).eq("week_start", X).maybeSingle() */
function fakeSupabase(rowsByWeekStart: Record<string, unknown>): SupabaseClient {
  return {
    from: () => {
      let weekStart = "";
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "week_start") weekStart = val;
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: rowsByWeekStart[weekStart] ?? null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const LEGS = [
  { name: "Squat (Barbell)", baseKg: 47.5, baseReps: 5, sets: 1, warmup: true },
  { name: "Squat (Barbell)", baseKg: 80, baseReps: 7, sets: 3 },
  { name: "Leg Extension (Machine)", baseKg: 40, baseReps: 12, sets: 3 },
];

describe("readNextSessionPrescription", () => {
  it("finds the next matching weekday later in the same week", async () => {
    // Workout Monday 2026-08-03; Legs also on Thursday 2026-08-06.
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": {
          session_plan: { Monday: "Legs", Thursday: "Legs" },
          session_prescriptions: { Thursday: LEGS },
        },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-06");
    expect(out?.weekday).toBe("Thursday");
    expect(out?.source).toBe("row");
  });

  it("crosses into next week when the current week has no later match", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Legs" }, session_prescriptions: { Monday: LEGS } },
        "2026-08-10": { session_plan: { Monday: "Legs" }, session_prescriptions: { Monday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-10");
    expect(out?.source).toBe("row");
  });

  it("filters warmup entries out of exercises", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Legs", Thursday: "Legs" }, session_prescriptions: { Thursday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.exercises.every((e) => !e.warmup)).toBe(true);
    expect(out?.exercises).toHaveLength(2);
  });

  it("reads short-form session_plan keys via readSessionForDay", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Mon: "Legs", Thu: "Legs" }, session_prescriptions: { Thursday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-06");
  });

  it("returns null when no matching weekday appears within 14 days", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Chest" }, session_prescriptions: {} },
        "2026-08-10": { session_plan: { Monday: "Chest" }, session_prescriptions: {} },
        "2026-08-17": { session_plan: { Monday: "Chest" }, session_prescriptions: {} },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out).toBeNull();
  });

  it("returns null when no week rows exist at all", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({}),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out).toBeNull();
  });

  it("skips the matched day's own workout date (searches strictly after)", async () => {
    // Monday is a Legs day and the workout WAS Monday — must not return Monday.
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Legs", Friday: "Legs" }, session_prescriptions: { Friday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-07");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/session-debrief/__tests__/next-session-prescription.test.ts`
Expected: FAIL — cannot resolve module `@/lib/coach/session-debrief/next-session-prescription`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/session-debrief/next-session-prescription.ts`:

```ts
// lib/coach/session-debrief/next-session-prescription.ts
//
// Finds the next session of a given type and returns the prescription the
// ENGINE wrote for it. The debrief must never compute its own loads — that
// second implementation is what let the card display a weight the plan did
// not contain (see the spec dated 2026-08-03).
//
// Two-tier read, mirroring lib/coach/weekly-review/read-prescription.ts:
//   1. training_weeks.session_prescriptions[weekday]  → source "row"
//   2. prescribeWeek() inline when that is missing    → source "inline"
// Read-only: never writes training_weeks.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PlannedExercise,
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  WeekdayLong,
} from "@/lib/data/types";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { mondayOfIso } from "@/lib/time/dates";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";

/** How far forward to look for the next session of this type. Two weeks
 *  covers any weekly split; beyond that the session type has been dropped. */
const SEARCH_DAYS = 14;

export type NextSessionPrescription = {
  /** ISO date of the next session of this type. */
  date: string;
  weekday: WeekdayLong;
  /** Non-warmup prescribed entries for that day. */
  exercises: PlannedExercise[];
  /** "row" when read from training_weeks.session_prescriptions, "inline"
   *  when prescribeWeek was called as the fallback. */
  source: "row" | "inline";
};

export async function readNextSessionPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
  /** Workout date — the search starts the day AFTER this. */
  afterIso: string;
  block: TrainingBlock | null;
  todayIso: string;
}): Promise<NextSessionPrescription | null> {
  const { supabase, userId, sessionType, afterIso, block, todayIso } = opts;

  // At most two week rows are ever touched; cache so a 14-day walk does not
  // re-query the same week seven times.
  const weekCache = new Map<string, TrainingWeek | null>();
  async function weekRow(weekStart: string): Promise<TrainingWeek | null> {
    if (weekCache.has(weekStart)) return weekCache.get(weekStart)!;
    const { data } = await supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();
    const row = (data as TrainingWeek | null) ?? null;
    weekCache.set(weekStart, row);
    return row;
  }

  for (let offset = 1; offset <= SEARCH_DAYS; offset++) {
    const date = addDaysIso(afterIso, offset);
    const weekStart = mondayOfIso(date);
    const row = await weekRow(weekStart);
    if (!row) continue;

    const weekday = weekdayLongForIso(date, weekStart);
    if (weekday == null) continue;
    // SessionPlan keys may be short or long — never index directly.
    if (readSessionForDay(row.session_plan as Record<string, string>, weekday) !== sessionType) {
      continue;
    }

    const stored = (row.session_prescriptions as SessionPrescriptions | null) ?? null;
    const storedDay = stored?.[weekday];
    if (storedDay && storedDay.length > 0) {
      return { date, weekday, exercises: storedDay.filter((e) => !e.warmup), source: "row" };
    }

    // Fall-through: compute inline with the SAME engine, read-only.
    const computed = await prescribeWeek({
      supabase,
      userId,
      block,
      week: row,
      todayIso,
    });
    const computedDay = computed[weekday];
    if (computedDay && computedDay.length > 0) {
      return { date, weekday, exercises: computedDay.filter((e) => !e.warmup), source: "inline" };
    }
    // Matched the weekday but neither source produced exercises — keep looking.
  }

  return null;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** WEEKDAY_LONG_ORDER is Monday-first, matching mondayOfIso. */
function weekdayLongForIso(iso: string, weekStart: string): WeekdayLong | null {
  const a = new Date(weekStart + "T00:00:00Z").getTime();
  const b = new Date(iso + "T00:00:00Z").getTime();
  const idx = Math.round((b - a) / 86_400_000);
  return WEEKDAY_LONG_ORDER[idx] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/session-debrief/__tests__/next-session-prescription.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/session-debrief/next-session-prescription.ts lib/coach/session-debrief/__tests__/next-session-prescription.test.ts
git commit -m "feat(debrief): add readNextSessionPrescription

Finds the next session of a given type and returns the prescription the
engine wrote for it. Two-tier read mirroring the weekly review's
read-prescription.ts: stored row, else prescribeWeek inline. Read-only."
```

---

### Task 2: `composePrescription` reads stored loads instead of deriving them

**Files:**
- Modify: `lib/coach/session-debrief/compose-prescription.ts`
- Modify: `lib/coach/session-debrief/index.ts`
- Test: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: `NextSessionPrescription` / `readNextSessionPrescription` from Task 1.
- Produces: `ComposePrescriptionInput` gains `nextSession: NextSessionPrescription | null`; `prescription.next_session_date` is populated.

- [ ] **Step 1: Write the failing audit assertions**

Append to `scripts/audit-prescription-rules.mjs`, immediately before its final `summary(...)` call:

```js
console.log("\n## session-debrief — prescription comes from the stored plan\n");
{
  const lifts = [
    { name: "Squat (Barbell)", top_set_today: { kg: 80, reps: 7, e1rm: 96 }, top_set_last: { kg: 80, reps: 8, e1rm: 99 }, delta_e1rm: -3, rir_today: 2, tag: "regression" },
    // tag "PR" is the exact defect: the old code took this as "clean" and
    // proposed today + step. It must now report the STORED load.
    { name: "Leg Extension (Machine)", top_set_today: { kg: 38, reps: 15, e1rm: 57 }, top_set_last: { kg: 36, reps: 15, e1rm: 54 }, delta_e1rm: 3, rir_today: 0, tag: "PR" },
    // Present today, absent from the prescription — must be skipped.
    { name: "Calf Raise (Off-script)", top_set_today: { kg: 50, reps: 15, e1rm: 75 }, top_set_last: { kg: 50, reps: 15, e1rm: 75 }, delta_e1rm: 0, rir_today: 2, tag: "stall" },
    // Bodyweight in the prescription — must be skipped, never emitted as 0.
    { name: "Back Extension", top_set_today: { kg: null, reps: 10, e1rm: null }, top_set_last: { kg: null, reps: 10, e1rm: null }, delta_e1rm: null, rir_today: 2, tag: null },
  ];
  const nextSession = {
    date: "2026-08-10",
    weekday: "Monday",
    source: "row",
    exercises: [
      { name: "Squat (Barbell)", baseKg: 80, baseReps: 7, sets: 3 },
      { name: "Leg Extension (Machine)", baseKg: 40, baseReps: 12, sets: 3 },
      { name: "Back Extension", baseKg: null, baseReps: 10, sets: 3 },
    ],
  };
  const out = composePrescription({
    sessionType: "Legs", lifts, volume: [], todayExercises: [], block: null,
    todayIso: "2026-08-03", volumeSignals: [], nextSession,
  });
  const byName = new Map(out.weight_changes.map((c) => [c.exercise, c.new_kg]));

  assert("squat reports the stored 80, not a derived number", byName.get("Squat (Barbell)") === 80);
  assert("a PR-tagged lift reports the stored 40, not today+step", byName.get("Leg Extension (Machine)") === 40);
  assert("a lift absent from the prescription is skipped", !byName.has("Calf Raise (Off-script)"));
  assert("a bodyweight prescribed entry is skipped", !byName.has("Back Extension"));
  assert("no weight_change is ever emitted with new_kg 0", out.weight_changes.every((c) => c.new_kg > 0));
  assert("next_session_date is populated from the resolved session", out.next_session_date === "2026-08-10");

  const none = composePrescription({
    sessionType: "Legs", lifts, volume: [], todayExercises: [], block: null,
    todayIso: "2026-08-03", volumeSignals: [], nextSession: null,
  });
  assert("null nextSession yields no weight changes", none.weight_changes.length === 0);
  assert("null nextSession explains why", none.notes.some((n) => /isn't planned yet/i.test(n)));
  assert("null nextSession leaves next_session_date null", none.next_session_date === null);
}
```

- [ ] **Step 2: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — `composePrescription` does not accept `nextSession`, and the PR-tagged lift still reports a derived value.

- [ ] **Step 3: Rewrite the weight_changes derivation**

In `lib/coach/session-debrief/compose-prescription.ts`:

1. Add the import:

```ts
import type { NextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";
```

2. Extend the input type with:

```ts
  /** The engine's prescription for the next session of this type. The debrief
   *  reports these numbers verbatim — it never computes a load itself. */
  nextSession: NextSessionPrescription | null;
```

3. Destructure it: `const { sessionType, lifts, volume, volumeSignals = [], nextSession } = input;`

4. Replace the **entire** `for (const lift of lifts) { ... }` loop — from `for (const lift of lifts) {` through its closing brace, including the `isBlockFocusLift` branch and the `lift.tag`-keyed `PR`/`regression`/`stall` branches — with:

```ts
  // Every load comes from the engine's stored prescription. The debrief used
  // to re-derive these with `lift.tag === "PR"` standing in for the engine's
  // cleanliness check; those disagree whenever a PR is set while grinding, so
  // the card could display a weight the plan did not contain.
  const prescribedByName = new Map(
    (nextSession?.exercises ?? []).map((e) => [e.name.trim().toLowerCase(), e]),
  );

  const blockPhase =
    input.block != null
      ? evaluateBlockPhase({
          block: input.block,
          currentWorkingKg: null,
          recentProgressionRatePerWeek: null,
          todayIso: input.todayIso,
        })
      : null;

  for (const lift of lifts) {
    const prescribed = prescribedByName.get(lift.name.trim().toLowerCase());
    if (!prescribed) continue;              // not in next session — nothing to report
    if (prescribed.baseKg == null) continue; // bodyweight — never emit 0

    const liftKey = liftFromExerciseName(lift.name);
    const isBlockFocusLift =
      input.block != null && input.block.primary_lift != null && liftKey === input.block.primary_lift;
    const todayKg = lift.top_set_today.kg;

    let rationale: string;
    if (isBlockFocusLift && input.block != null && blockPhase != null) {
      switch (blockPhase) {
        case "consolidation":
          rationale = `Block target ${input.block.target_value} kg was hit at week ${input.block.target_hit_at_week}. Consolidation phase: hold ${prescribed.baseKg} kg, progress reps to ${prescribed.baseReps}. We do NOT push load further this block.`;
          break;
        case "off_pace": {
          const wLeft = weeksLeft(input.block, input.todayIso);
          const requiredRate = ((input.block.target_value ?? 0) - (todayKg ?? 0)) / Math.max(1, wLeft);
          rationale = `Block target ${input.block.target_value} kg is out of reach in remaining accumulation weeks (would require +${requiredRate.toFixed(1)} kg/wk vs normal progression). HOLD ${prescribed.baseKg} kg and accept — we renegotiate the target next block, not in mid-block.`;
          break;
        }
        case "deload_week":
          rationale = `Deload week — drop to ${prescribed.baseKg} kg (~0.80×) with halved sets.`;
          break;
        default:
          rationale =
            todayKg != null && prescribed.baseKg > todayKg
              ? `On pace for the block target. Take the step next session: ${prescribed.baseKg} kg.`
              : `Hold ${prescribed.baseKg} kg — last session didn't meet the prescribed RIR cleanly.`;
      }
    } else if (todayKg == null) {
      rationale = `Prescribed at ${prescribed.baseKg} kg × ${prescribed.baseReps} next session.`;
    } else if (prescribed.baseKg > todayKg) {
      rationale = `Stepping to ${prescribed.baseKg} kg next session — you owned ${todayKg} kg today.`;
    } else if (prescribed.baseKg < todayKg) {
      rationale = `Dropping to ${prescribed.baseKg} kg next session — the engine autoregulated after today's effort.`;
    } else {
      rationale = `Holding ${prescribed.baseKg} kg — hit the prescribed reps at target RIR before it steps.`;
    }

    weight_changes.push({ exercise: lift.name, new_kg: prescribed.baseKg, rationale });
  }
```

5. Delete the now-unused import of `prescribePrimaryFromPhase` (keep `evaluateBlockPhase`), and delete the `const planEntries` / `planEntry` / `step` lookups **only if** the compiler reports them unused. Run `npm run typecheck` and let it tell you; do not delete on assumption.

6. Add the "not planned yet" note. Immediately after the existing `const notes: string[] = [];`:

```ts
  if (nextSession == null) {
    notes.push(`Next ${sessionType} session isn't planned yet — no load changes to report.`);
  }
```

7. Populate the date in the returned object:

```ts
    next_session_date: nextSession?.date ?? null,
```

- [ ] **Step 4: Wire the reader into the orchestrator**

In `lib/coach/session-debrief/index.ts`, add the import:

```ts
import { readNextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";
```

Immediately before the `composePrescription({ ... })` call, add:

```ts
  // The engine's prescription for the next session of this type. Graceful:
  // null when the session type has been dropped from the plan.
  const nextSession = await readNextSessionPrescription({
    supabase,
    userId,
    sessionType: workout.type as string,
    afterIso: workout.date as string,
    block: activeBlock,
    todayIso: workout.date as string,
  });
```

Then pass `nextSession` into the `composePrescription({ ... })` call.

- [ ] **Step 5: Run the audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: `0 failed`.

- [ ] **Step 6: Typecheck and full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/session-debrief/compose-prescription.ts lib/coach/session-debrief/index.ts scripts/audit-prescription-rules.mjs
git commit -m "fix(debrief): report the stored prescription, never a derived load

composePrescription passed lift.tag === 'PR' as the engine's
lastWeekHitRirTargetCleanly. 'PR' means today's top set beat the last
session; 'clean' means every working set met prescribed reps at target RIR
without failing. They disagree whenever a PR is set while grinding — seven
such sessions exist in this athlete's history — so the card could display a
weight the plan did not contain. PR #160 widened the gap.

Every weight now comes from the stored prescription. Block-phase rationale
prose is preserved; it narrates the engine's number instead of its own."
```

---

### Task 3: Narrative grounding and end-to-end confirmation

**Files:**
- Modify: `lib/coach/session-debrief/narrative-prompt.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: no new interfaces.

- [ ] **Step 1: Tell the narrator the numbers are canonical**

In `lib/coach/session-debrief/narrative-prompt.ts`, add this bullet to the end of the
`Effort, block calendar, and volume — non-negotiable:` list added in the previous arc:

```
- Every weight in prescription.weight_changes is read verbatim from the athlete's committed plan. It is not a suggestion and not a derived estimate. Quote those numbers exactly; never round them, never propose an alternative load, and never describe one as something the athlete "could" lift instead.
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the prompt is a template string).

- [ ] **Step 3: End-to-end confirmation against live data**

`generateWorkoutDebrief` cannot run from a plain node script (`getUserTimezone` →
`lib/supabase/server` → `next/headers`). Run it through vitest, which resolves that import.

Create `lib/coach/session-debrief/__tests__/_tmp-e2e.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { generateWorkoutDebrief } from "@/lib/coach/session-debrief/index";
import { readNextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";

const U = "94fee5c6-7d9a-4b05-be3a-8407505b5429";

describe("debrief prescription matches the stored plan (live)", () => {
  it("every displayed weight equals the engine's prescription", async () => {
    const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { data: w } = await s.from("workouts").select("id,date,type")
      .eq("user_id", U).order("date", { ascending: false }).limit(1).single();
    const { data: block } = await s.from("training_blocks").select("*")
      .eq("user_id", U).eq("status", "active").maybeSingle();

    const res = await generateWorkoutDebrief({ supabase: s, userId: U, workoutId: w!.id });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.payload;

    const next = await readNextSessionPrescription({
      supabase: s, userId: U, sessionType: w!.type as string,
      afterIso: w!.date as string, block: block as never, todayIso: w!.date as string,
    });

    console.log("\nworkout:", w!.date, w!.type);
    console.log("next session:", next?.date, next?.weekday, `(${next?.source})`);
    console.log("next_session_date:", p.prescription.next_session_date);
    console.log("weight_changes:", p.prescription.weight_changes.map((c) => `${c.exercise} -> ${c.new_kg}kg`));
    console.log("\n--- narrative ---\n" + p.narrative_md + "\n");

    expect(p.prescription.next_session_date).toBe(next?.date ?? null);
    expect(p.prescription.weight_changes.every((c) => c.new_kg > 0)).toBe(true);

    const byName = new Map((next?.exercises ?? []).map((e) => [e.name.trim().toLowerCase(), e.baseKg]));
    for (const c of p.prescription.weight_changes) {
      expect(byName.get(c.exercise.trim().toLowerCase())).toBe(c.new_kg);
    }
  }, 120_000);
});
```

Run:
```bash
set -a && . ./.env.local && set +a && npx vitest run lib/coach/session-debrief/__tests__/_tmp-e2e.test.ts
```

Expected: PASS. Every displayed weight equals the stored prescription, `next_session_date` is
non-null, and no weight is `0`. Read the printed narrative and confirm it quotes those weights
rather than proposing its own.

If the assertion comparing against `next.exercises` fails, do **not** relax it — a mismatch
means `composePrescription` is still deriving something.

Then delete the file: `rm -f lib/coach/session-debrief/__tests__/_tmp-e2e.test.ts`

- [ ] **Step 4: Full verification**

Run:
```bash
npm run typecheck && npx vitest run \
  && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs \
  && AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-workout-debrief.mjs \
  && npm run build
```

Expected: no type errors, all vitest tests pass, `audit-prescription-rules` reports `0 failed`,
`audit-workout-debrief` reports no new failures, and the production build succeeds. The build
matters because vitest is node-env and does not scan components.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/session-debrief/narrative-prompt.ts
git commit -m "feat(debrief): tell the narrator the prescribed weights are canonical

Every weight in prescription.weight_changes is now read verbatim from the
committed plan, so the narrator must quote it exactly rather than rounding
it or proposing an alternative."
```

---

## Self-Review

**Spec coverage:**
- New `readNextSessionPrescription` module with 14-day search, two-tier read, warmup filtering, `source` discriminator → Task 1
- `composePrescription` stops computing loads; rationale prose preserved; `baseKg == null` skipped → Task 2
- `next_session_date` populated → Task 2 Step 3.7, asserted in Task 2 Step 1 and Task 3 Step 3
- Deleting the `tag === "PR"` proxy and `prescribePrimaryFromPhase` → Task 2 Steps 3.4 and 3.5
- Null-`nextSession` behaviour (empty changes + note) → Task 2 Steps 1 and 3.6
- Testing: reader unit suite → Task 1; audit assertions incl. the PR-tagged regression fixture and the no-zero rule → Task 2 Step 1; end-to-end equality against the stored plan → Task 3 Step 3; verification gate incl. `npm run build` → Task 3 Step 4
- Risks: extra queries are bounded by the week cache (Task 1 Step 3); changed displayed weights are surfaced by the end-to-end print in Task 3 Step 3

**Type consistency:** `NextSessionPrescription` / `readNextSessionPrescription` / `nextSession` / `exercises` / `source` are named identically across all three tasks. The reader returns `PlannedExercise[]`, and Task 2 reads `.baseKg` / `.baseReps` / `.name` off those entries — all fields of `PlannedExercise`.

**Out of scope, deliberately:** showing prescribed exercises the athlete did not perform today; `compose-lifts`'s `tag` computation; the three pre-existing off-grid machine weights.
