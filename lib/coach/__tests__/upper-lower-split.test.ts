import { describe, it, expect } from "vitest";
import { WEEKLY_SESSIONS, SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { resolveExercise } from "@/lib/coach/exercise-library";
import { getExerciseMuscles, MUSCLE_NAMES } from "@/lib/coach/exercise-muscles";
import { SESSION_REGION_MAP } from "@/lib/coach/activity/sequence-week";

const DAYS = ["Lower A", "Upper A", "Lower B", "Upper B"] as const;

const PUSH = new Set(["Chest", "Triceps", "Front delts"]);
const PULL = new Set(["Lats", "Biceps", "Traps", "Rear delts", "Brachialis"]);

/** Direct working sets per primary muscle across a set of session types. */
function volume(sessionTypes: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of sessionTypes) {
    for (const ex of SESSION_PLANS[t] ?? []) {
      if (ex.warmup) continue;
      const m = getExerciseMuscles(ex.name);
      if (!m) continue;
      for (const p of m.primary) {
        const k = MUSCLE_NAMES[p];
        out[k] = (out[k] ?? 0) + (ex.sets ?? 0);
      }
    }
  }
  return out;
}

function ratio(v: Record<string, number>): number {
  const sum = (s: Set<string>) =>
    Object.entries(v).filter(([k]) => s.has(k)).reduce((a, [, n]) => a + n, 0);
  return sum(PUSH) / sum(PULL);
}

describe("the Upper/Lower split", () => {
  it("schedules four lifting days with a rest day between each pair", () => {
    expect(WEEKLY_SESSIONS).toEqual({
      Monday: "Lower A",
      Tuesday: "Upper A",
      Wednesday: "REST",
      Thursday: "Lower B",
      Friday: "Upper B",
      Saturday: "REST",
      Sunday: "REST",
    });
  });

  it("defines a SESSION_PLANS entry for every scheduled non-REST day", () => {
    for (const type of Object.values(WEEKLY_SESSIONS)) {
      if (type === "REST") continue;
      expect(SESSION_PLANS[type], `no plan for ${type}`).toBeDefined();
      expect(SESSION_PLANS[type]!.length).toBeGreaterThan(0);
    }
  });

  it("retains the legacy plans so historical workouts still resolve", () => {
    // 73 workouts carry these `type` strings; adherence, discovery and the
    // debrief all resolve against them.
    for (const t of ["Chest", "Legs", "Back", "Arms", "Mobility"]) {
      expect(SESSION_PLANS[t], `legacy plan ${t} was removed`).toBeDefined();
    }
  });

  it("maps every new session type in SESSION_REGION_MAP", () => {
    // A missing entry silently yields [] regions, so the activity-aware
    // lighten would never fire for that day.
    for (const t of DAYS) {
      expect(SESSION_REGION_MAP[t], `${t} unmapped`).toBeDefined();
      expect(SESSION_REGION_MAP[t]!.length).toBeGreaterThan(0);
    }
  });

  it("resolves every planned exercise in the exercise library", () => {
    // An unresolved name means loadability silently defaults and bottomReps
    // falls back to discovery's own self-derived value.
    const unresolved: string[] = [];
    for (const t of DAYS) {
      for (const ex of SESSION_PLANS[t]!) {
        // Bodyweight core work carries no load, so it needs no loadability.
        if (/dead bug|reverse crunch|back extension/i.test(ex.name)) continue;
        if (resolveExercise(ex.name) == null) unresolved.push(`${t}: ${ex.name}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("maps every planned exercise to muscles, so volume accounting is complete", () => {
    const unmapped: string[] = [];
    for (const t of DAYS) {
      for (const ex of SESSION_PLANS[t]!) {
        if (ex.warmup) continue;
        if (getExerciseMuscles(ex.name) == null) unmapped.push(`${t}: ${ex.name}`);
      }
    }
    // Core work (Dead Bug, Reverse Crunch) is deliberately unmapped.
    expect(unmapped.filter((n) => !/dead bug|reverse crunch/i.test(n))).toEqual([]);
  });
});

describe("volume properties the split was designed to fix", () => {
  const full = volume(DAYS);
  const withoutUpperB = volume(["Lower A", "Upper A", "Lower B"]);

  it("is pull-biased over the full week", () => {
    // Was 2.02 push:pull on the old split. Deliberately under 1.0 to repay
    // months of accumulated anterior bias, not merely balanced.
    expect(ratio(full)).toBeLessThan(1.0);
  });

  it("STAYS pull-biased when Upper B is dropped", () => {
    // Upper B is the agreed drop-day. The first draft parked most of the pull
    // volume there, so dropping it would have returned the week to ~1.7 and
    // silently undone the correction. This is the test that guards that.
    expect(ratio(withoutUpperB)).toBeLessThan(1.0);
  });

  it("clears the minimum effective volume for lats", () => {
    // 6.5 sets/wk on the old split, below any reasonable MEV.
    expect(full["Lats"] ?? 0).toBeGreaterThanOrEqual(10);
  });

  it("no longer makes front delts the most-trained muscle", () => {
    // 15.0 sets/wk previously — more than chest, and 2.3x lats.
    const front = full["Front delts"] ?? 0;
    expect(front).toBeLessThan(full["Chest"] ?? 0);
    expect(front).toBeLessThan(full["Lats"] ?? 0);
  });

  it("gives hamstrings a hip hinge on a Lower day, not just leg curls", () => {
    const lowerA = SESSION_PLANS["Lower A"]!.map((e) => e.name);
    expect(lowerA).toContain("Romanian Deadlift (Barbell)");
    const lowerB = SESSION_PLANS["Lower B"]!.map((e) => e.name);
    expect(lowerB).toContain("Deadlift (Barbell)");
    expect(lowerB).toContain("Hip Thrust (Machine)");
  });

  it("carries two distinct horizontal rows", () => {
    const rows = DAYS.flatMap((t) => SESSION_PLANS[t]!)
      .filter((e) => /row/i.test(e.name))
      .map((e) => e.name);
    expect(new Set(rows).size).toBeGreaterThanOrEqual(2);
  });

  it("gives triceps a second movement, matching biceps' exercise count", () => {
    const count = (re: RegExp) =>
      DAYS.flatMap((t) => SESSION_PLANS[t]!).filter((e) => re.test(e.name)).length;
    expect(count(/triceps/i)).toBeGreaterThanOrEqual(2);
    expect(count(/triceps/i)).toBeGreaterThanOrEqual(count(/curl \(dumbbell\)/i) - 1);
  });

  it("does not sandwich the overhead press between the two chest presses", () => {
    // The old Chest day ran Decline -> OHP -> Incline, pre-fatiguing front
    // delts and triceps for the incline press.
    const upperA = SESSION_PLANS["Upper A"]!.map((e) => e.name);
    expect(upperA.some((n) => /overhead press/i.test(n))).toBe(false);
    expect(SESSION_PLANS["Upper B"]!.some((e) => /overhead press/i.test(e.name))).toBe(true);
  });

  it("anchors every accessory at 10 reps and no compound above 8", () => {
    // Barbell compounds only. Incline DB is a secondary and belongs at 10.
    const isCompound = (e: PlannedExercise) =>
      /\(barbell\)/i.test(e.name) && /squat|deadlift|bench press|overhead press/i.test(e.name);
    for (const t of DAYS) {
      for (const ex of SESSION_PLANS[t]!) {
        if (ex.baseReps == null || ex.warmup) continue;
        if (ex.unilateral) continue;            // per-side, its own scale
        if (/face pull/i.test(ex.name)) continue; // deliberately higher-rep
        if (isCompound(ex)) expect(ex.baseReps, ex.name).toBeLessThanOrEqual(8);
        else expect(ex.baseReps, ex.name).toBe(10);
      }
    }
  });
});

describe("the heavy top set", () => {
  it("is declared only on the block's focus lift", () => {
    const withTop = DAYS.flatMap((t) => SESSION_PLANS[t]!).filter((e) => e.topSet);
    expect(withTop.map((e) => e.name)).toEqual(["Bench Press (Barbell)"]);
  });

  it("has reps and pctOfE1rm that agree under Brzycki", () => {
    // If they disagree, the top set re-estimates e1RM wrongly EVERY week and
    // the block target drifts. Brzycki: kg = e1RM x (37 - reps)/36.
    for (const ex of DAYS.flatMap((t) => SESSION_PLANS[t]!)) {
      if (!ex.topSet) continue;
      const implied = (37 - ex.topSet.reps) / 36;
      expect(Math.abs(implied - ex.topSet.pctOfE1rm), `${ex.name}: ${ex.topSet.reps} reps implies ${implied.toFixed(3)}, declared ${ex.topSet.pctOfE1rm}`).toBeLessThan(0.02);
    }
  });

  it("carries no resolved kg in the static template", () => {
    // kg is prescribeWeek's job — a hardcoded one would go stale silently.
    for (const ex of DAYS.flatMap((t) => SESSION_PLANS[t]!)) {
      if (ex.topSet) expect(ex.topSet.kg).toBeUndefined();
    }
  });
});
