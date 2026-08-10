# Live Session Coaching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each committed set in the workout logger, show at most one deterministic coaching line — PR, guardrail, or load call — with an optional one-tap load application.

**Architecture:** A pure rule module (`lib/coach/live-session/`) of five independent rules behind a priority orchestrator. Context (28d/180d lift history, block phase, RIR target) is fetched once at logger open via the standard two-variant fetcher pattern, so rules run synchronously on every ✓ tap with no network in the hot path. The rules are **new callers** of the prescription engine's existing predicates and grid functions, never new authors of them.

**Tech Stack:** TypeScript (strict), Next.js 15 App Router, TanStack Query, Supabase (RLS), vitest (node environment).

**Spec:** [docs/superpowers/specs/2026-08-10-live-session-coaching-design.md](../specs/2026-08-10-live-session-coaching-design.md)

## Global Constraints

- **Never restate an engine rule.** Clean/strained → `isCleanSet` / `isStrainedSet` (`lib/coach/prescription/session-grouping.ts`). Load steps → `nextUpKg` / `nextDownKg` (`lib/coach/prescription/double-progression-rule.ts`). PR math → `brzycki` / `bestComparisonValue` (`lib/coach/e1rm.ts`). Tier/rest/reps → `tierOf` / `restPrescription` / `repsForExercise` (`lib/coach/session-structure/`). No rule module may define its own version of any of these.
- **Every rule is total.** Missing input yields `null`, never a throw. The coaching line is strictly additive and must never block a set commit.
- **Silence is the default.** An on-plan set at the prescribed RIR returns `null`.
- **Only PRs make sound.** `cue: true` on the PR rule alone.
- **Numbers use `fmtNum()`** from `lib/ui/score.ts` — max 2 decimals, trailing zeros trimmed. Never `.toFixed()` or `String(n)` for user-visible numbers.
- **Path alias `@/*`** → repo root. Never relative climbs.
- **Verify with** `npm run typecheck` + `npx vitest run` + `npm run build`. There is no working linter. Components are not render-tested, so React hook-order errors surface only in the production build — `npm run build` is mandatory before claiming done.
- **No new DB columns, tables, or migrations.** Nothing about this feature is persisted.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `lib/coach/live-session/types.ts` | `CoachLine`, `LiveSetInput`, `LiveSessionContext`, `SessionSetRef` |
| `lib/coach/live-session/helpers.ts` | Shared predicates: `isFinalWorkingSet`, `effortBand`, `ordinal` |
| `lib/coach/live-session/rule-load-call.ts` | The six-cell reps × effort table |
| `lib/coach/live-session/rule-pr.ts` | e1RM PR detection + guards |
| `lib/coach/live-session/rule-failure-budget.ts` | Session-wide failure count guardrail |
| `lib/coach/live-session/rule-drop-off.ts` | Within-exercise rep collapse |
| `lib/coach/live-session/rule-rest-discipline.ts` | Under-resting on T1/T2 |
| `lib/coach/live-session/index.ts` | `evaluateSet` orchestrator + barrel |
| `lib/query/fetchers/liveSessionContext.ts` | Context assembly (server + browser variants) |
| `lib/query/hooks/useLiveSessionContext.ts` | Hook wrapper |
| `components/logger/CoachLine.tsx` | The rendered line |
| `scripts/audit-live-session-rules.mjs` | Fixture-based audit, DB-free |

**Modify:**

| File | Change |
|---|---|
| `lib/query/keys.ts` | Add `liveSessionContext.one` |
| `components/logger/ExerciseCard.tsx` | Target column, evaluate on commit, render `CoachLine`, apply-tap |
| `components/logger/LoggerSheet.tsx` | Fetch context, pass to `ExerciseCard` |
| `CLAUDE.md` | Document the module + audit script |

---

### Task 1: Types and shared helpers

**Files:**
- Create: `lib/coach/live-session/types.ts`
- Create: `lib/coach/live-session/helpers.ts`
- Test: `lib/coach/live-session/__tests__/helpers.test.ts`

**Interfaces:**
- Consumes: `ExerciseSetDraft`, `ExerciseDraft` from `@/lib/logger/types`; `WorkoutSetSample`, `BlockPhase` from `@/lib/coach/prescription/types`.
- Produces: `CoachLine`, `CoachLineKind`, `LiveSetInput`, `LiveSessionContext`, `SessionSetRef`; `isFinalWorkingSet(exercise, set)`, `effortBand(set, effortTarget)`, `ordinal(n)`.

- [ ] **Step 1: Write `lib/coach/live-session/types.ts`**

```ts
// lib/coach/live-session/types.ts
//
// Shapes for the between-sets coaching line. Pure data — no behaviour here.
// Spec: docs/superpowers/specs/2026-08-10-live-session-coaching-design.md

import type { ExerciseSetDraft, ExerciseDraft } from "@/lib/logger/types";
import type { WorkoutSetSample, BlockPhase } from "@/lib/coach/prescription/types";

export type CoachLineKind = "pr" | "guardrail" | "load_call";

export type CoachLine = {
  kind: CoachLineKind;
  /** Single sentence, no markdown. Target <= 90 chars. */
  text: string;
  /** Present only on load calls that name a new number. Tapping writes this
   *  into the next pending set's kg field. Absent when the call is "same
   *  weight" or when the exercise has no equipment grid. */
  apply_kg?: number;
  /** True only for PRs — the one line that also fires the audio cue. */
  cue: boolean;
  /** Which rule produced this line. For tests and future observability. */
  rule: string;
};

/** A committed set anywhere in today's session, with its exercise name.
 *  The failure budget is a session-level count, not a per-exercise one. */
export type SessionSetRef = {
  exerciseName: string;
  set: ExerciseSetDraft;
};

export type LiveSessionContext = {
  /** Per exercise name (verbatim draft name): 28 days of prior sets, in the
   *  exact shape the weekly prescription engine consumes. */
  historyByExercise: Record<string, WorkoutSetSample[]>;
  /** Per exercise name: best Brzycki e1RM over a 180-day window. Null when
   *  there is no usable history — a first-ever entry is not a PR. */
  bestByExercise: Record<string, number | null>;
  blockPhase: BlockPhase;
  /** training_weeks.rir_target for the current week, `?? 2` applied by the
   *  fetcher — the same fallback expression prescribeWeek uses. */
  rirTarget: number;
};

export type LiveSetInput = {
  /** The set just committed. `committed_at` is already populated. */
  set: ExerciseSetDraft;
  /** Its exercise, including `prescribed: PlannedExercise`. */
  exercise: ExerciseDraft;
  /** ALL committed non-warmup sets this session INCLUDING the one above. */
  sessionSets: SessionSetRef[];
  context: LiveSessionContext;
};
```

- [ ] **Step 2: Write the failing test**

Create `lib/coach/live-session/__tests__/helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isFinalWorkingSet, effortBand, ordinal } from "@/lib/coach/live-session/helpers";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 60,
    reps: 10,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

function mkExercise(sets: ExerciseSetDraft[]): ExerciseDraft {
  return {
    name: "Decline Bench Press (Barbell)",
    position: 0,
    prescribed: { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 10, sets: 3 },
    sets,
  };
}

describe("effortBand", () => {
  it("classifies two or more reps in reserve above target as easy", () => {
    expect(effortBand(mkSet({ rir: 4 }), 2)).toBe("easy");
    expect(effortBand(mkSet({ rir: 5 }), 3)).toBe("easy");
  });

  it("treats one rep above target as on-target, not easy", () => {
    // One rep is inside normal RIR-estimation error; it must not move a load.
    expect(effortBand(mkSet({ rir: 3 }), 2)).toBe("on");
    expect(effortBand(mkSet({ rir: 2 }), 2)).toBe("on");
  });

  it("classifies below-target RIR as strained", () => {
    expect(effortBand(mkSet({ rir: 1 }), 2)).toBe("strained");
    expect(effortBand(mkSet({ rir: 0 }), 2)).toBe("strained");
  });

  it("treats a failure-flagged set as strained regardless of RIR", () => {
    expect(effortBand(mkSet({ rir: 4, failure: true }), 2)).toBe("strained");
  });

  it("returns null when RIR was not recorded", () => {
    expect(effortBand(mkSet({ rir: null }), 2)).toBeNull();
  });
});

describe("isFinalWorkingSet", () => {
  it("is true for the highest-indexed non-warmup set", () => {
    const sets = [
      mkSet({ set_index: 0, warmup: true }),
      mkSet({ set_index: 1 }),
      mkSet({ set_index: 2 }),
    ];
    expect(isFinalWorkingSet(mkExercise(sets), sets[2])).toBe(true);
    expect(isFinalWorkingSet(mkExercise(sets), sets[1])).toBe(false);
  });

  it("ignores warmups when they sit after working sets", () => {
    const sets = [mkSet({ set_index: 0 }), mkSet({ set_index: 1, warmup: true })];
    expect(isFinalWorkingSet(mkExercise(sets), sets[0])).toBe(true);
  });

  it("is false for a warmup set", () => {
    const sets = [mkSet({ set_index: 0, warmup: true }), mkSet({ set_index: 1 })];
    expect(isFinalWorkingSet(mkExercise(sets), sets[0])).toBe(false);
  });
});

describe("ordinal", () => {
  it("renders English ordinals for the counts the guardrails use", () => {
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(21)).toBe("21st");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/coach/live-session/__tests__/helpers.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/live-session/helpers`.

- [ ] **Step 4: Write `lib/coach/live-session/helpers.ts`**

```ts
// lib/coach/live-session/helpers.ts
//
// Predicates shared by more than one live-session rule. Anything used by a
// single rule stays in that rule's module.

import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

/** Three-way effort classification against the prescribed RIR target.
 *
 *  easy     = r >= t + 2. Deliberately NOT r > t: one rep easier than
 *             intended is inside normal RIR-estimation error, and a single
 *             set is weaker evidence than the week of sessions the
 *             prescription engine reasons over. It takes a clear signal to
 *             move a number mid-workout.
 *  on       = t <= r < t + 2
 *  strained = r < t, or the set is flagged as taken to failure
 *
 *  Returns null when RIR was not recorded — the load call stays silent
 *  rather than guessing. */
export function effortBand(
  set: ExerciseSetDraft,
  effortTarget: number,
): "easy" | "on" | "strained" | null {
  if (set.failure) return "strained";
  if (set.rir == null) return null;
  if (set.rir < effortTarget) return "strained";
  if (set.rir >= effortTarget + 2) return "easy";
  return "on";
}

/** True when `set` is the highest-indexed non-warmup set of the exercise.
 *  Compared by set_index rather than object identity: the draft is rebuilt
 *  immutably on every patch, so identity does not survive a commit. */
export function isFinalWorkingSet(
  exercise: ExerciseDraft,
  set: ExerciseSetDraft,
): boolean {
  if (set.warmup) return false;
  const working = exercise.sets.filter((s) => !s.warmup);
  if (working.length === 0) return false;
  const maxIndex = Math.max(...working.map((s) => s.set_index));
  return set.set_index === maxIndex;
}

/** English ordinal for small positive integers ("2nd", "3rd", "11th"). */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/coach/live-session/__tests__/helpers.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/live-session/types.ts lib/coach/live-session/helpers.ts lib/coach/live-session/__tests__/helpers.test.ts
git commit -m "feat(live-session): types and shared rule helpers"
```

---

### Task 2: Load-call rule

**Files:**
- Create: `lib/coach/live-session/rule-load-call.ts`
- Test: `lib/coach/live-session/__tests__/rule-load-call.test.ts`

**Interfaces:**
- Consumes: `LiveSetInput`, `CoachLine` (Task 1); `effortBand`, `isFinalWorkingSet` (Task 1); `repsForExercise` from `@/lib/coach/session-structure/rules`; `nextUpKg`, `nextDownKg` from `@/lib/coach/prescription/double-progression-rule`; `fmtNum` from `@/lib/ui/score`.
- Produces: `ruleLoadCall(input: LiveSetInput): CoachLine | null`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/live-session/__tests__/rule-load-call.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ruleLoadCall } from "@/lib/coach/live-session/rule-load-call";
import { nextUpKg, nextDownKg } from "@/lib/coach/prescription/double-progression-rule";
import type { LiveSetInput, LiveSessionContext } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";

const CONTEXT: LiveSessionContext = {
  historyByExercise: {},
  bestByExercise: {},
  blockPhase: "pre_target",
  rirTarget: 2,
};

/** Three-set decline bench at 60kg x 10, RIR target 2, 2.5kg grid. */
function mkInput(over: {
  reps?: number | null;
  kg?: number | null;
  rir?: number | null;
  failure?: boolean;
  setIndex?: number;
  blockPhase?: BlockPhase;
  increment?: { step: number; intermediate?: number };
  durationSeconds?: number;
  warmup?: boolean;
} = {}): LiveSetInput {
  const setIndex = over.setIndex ?? 0;
  const set: ExerciseSetDraft = {
    set_index: setIndex,
    kg: over.kg === undefined ? 60 : over.kg,
    reps: over.reps === undefined ? 10 : over.reps,
    duration_seconds: null,
    warmup: over.warmup ?? false,
    failure: over.failure ?? false,
    rir: over.rir === undefined ? 2 : over.rir,
    committed_at: "2026-08-10T09:00:00.000Z",
  };
  const sets: ExerciseSetDraft[] = [0, 1, 2].map((i) =>
    i === setIndex ? set : { ...set, set_index: i, committed_at: null },
  );
  return {
    set,
    exercise: {
      name: "Decline Bench Press (Barbell)",
      position: 0,
      prescribed: {
        name: "Decline Bench Press (Barbell)",
        baseKg: 60,
        baseReps: 10,
        sets: 3,
        increment: over.increment ?? { step: 2.5 },
        ...(over.durationSeconds != null ? { duration_seconds: over.durationSeconds } : {}),
      },
      sets,
    },
    sessionSets: [{ exerciseName: "Decline Bench Press (Barbell)", set }],
    context: { ...CONTEXT, blockPhase: over.blockPhase ?? "pre_target" },
  };
}

describe("ruleLoadCall — the six-cell table", () => {
  it("reps hit + easy: steps the load up and offers it for one tap", () => {
    const line = ruleLoadCall(mkInput({ reps: 10, rir: 4 }));
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("load_call");
    expect(line!.apply_kg).toBe(nextUpKg(60, { step: 2.5 }));
    expect(line!.text).toContain("62.5");
    expect(line!.cue).toBe(false);
  });

  it("reps hit + on target: SILENT — this is the whole point of the feature", () => {
    expect(ruleLoadCall(mkInput({ reps: 10, rir: 2 }))).toBeNull();
    expect(ruleLoadCall(mkInput({ reps: 12, rir: 3 }))).toBeNull();
  });

  it("reps hit + strained: holds the weight, no tap target", () => {
    const line = ruleLoadCall(mkInput({ reps: 10, rir: 0 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
    expect(line!.text).toContain("Same weight");
  });

  it("reps short + easy: holds and tells the athlete to push", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 4 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
    expect(line!.text).toContain("push");
  });

  it("reps short + on target: holds so reps can climb", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 2 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
    expect(line!.text).toContain("hold");
  });

  it("reps short + strained: steps the load down", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 0 }));
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBe(nextDownKg(60, { step: 2.5 }));
    expect(line!.text).toContain("57.5");
  });
});

describe("ruleLoadCall — grid agreement (anti-drift)", () => {
  it("a step up equals nextUpKg on a micro-pin grid", () => {
    const inc = { step: 5, intermediate: 2.3 };
    const line = ruleLoadCall(mkInput({ kg: 22, reps: 15, rir: 4, increment: inc }));
    expect(line!.apply_kg).toBe(nextUpKg(22, inc));
  });

  it("a step down equals nextDownKg on a micro-pin grid", () => {
    const inc = { step: 5, intermediate: 2.3 };
    const line = ruleLoadCall(mkInput({ kg: 22, reps: 9, rir: 0, increment: inc }));
    expect(line!.apply_kg).toBe(nextDownKg(22, inc));
  });
});

describe("ruleLoadCall — block phase freeze", () => {
  it.each<BlockPhase>(["consolidation", "off_pace", "deload_week"])(
    "does not offer a load change during %s",
    (blockPhase) => {
      const line = ruleLoadCall(mkInput({ reps: 10, rir: 4, blockPhase }));
      expect(line).not.toBeNull();
      expect(line!.apply_kg).toBeUndefined();
      expect(line!.text).toContain("held");
    },
  );

  it("holds in both directions during a freeze — no step down either", () => {
    const line = ruleLoadCall(mkInput({ reps: 7, rir: 0, blockPhase: "consolidation" }));
    expect(line!.apply_kg).toBeUndefined();
  });
});

describe("ruleLoadCall — guards", () => {
  it("stays silent on warmup sets", () => {
    expect(ruleLoadCall(mkInput({ warmup: true, reps: 5, rir: 6 }))).toBeNull();
  });

  it("stays silent when RIR was not recorded", () => {
    expect(ruleLoadCall(mkInput({ rir: null, reps: 15 }))).toBeNull();
  });

  it("stays silent on time-based exercises", () => {
    expect(ruleLoadCall(mkInput({ durationSeconds: 60, reps: 1, rir: 5 }))).toBeNull();
  });

  it("offers no tap target when the exercise has no equipment grid", () => {
    const input = mkInput({ reps: 10, rir: 4 });
    delete input.exercise.prescribed.increment;
    const line = ruleLoadCall(input);
    expect(line).not.toBeNull();
    expect(line!.apply_kg).toBeUndefined();
  });

  it("reframes to next-time wording on the final working set", () => {
    const line = ruleLoadCall(mkInput({ setIndex: 2, reps: 10, rir: 4 }));
    expect(line!.text).toContain("next time");
    expect(line!.text).not.toContain("next set");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-load-call.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/live-session/rule-load-call`.

- [ ] **Step 3: Write `lib/coach/live-session/rule-load-call.ts`**

```ts
// lib/coach/live-session/rule-load-call.ts
//
// The core verdict: given one committed set, what should the next one weigh?
//
// This is intra-session double progression. It answers a DIFFERENT question
// from prescribeAccessoryDoubleProgression, which reasons over 28 days of
// sessions — but it must land on the SAME equipment grid, so the load
// arithmetic goes through nextUpKg / nextDownKg and nowhere else.

import { repsForExercise } from "@/lib/coach/session-structure/rules";
import {
  nextUpKg,
  nextDownKg,
} from "@/lib/coach/prescription/double-progression-rule";
import { fmtNum } from "@/lib/ui/score";
import { effortBand, isFinalWorkingSet } from "./helpers";
import type { CoachLine, LiveSetInput } from "./types";

/** Phases in which the weekly engine freezes load. The live rule must never
 *  contradict it: consolidation and off_pace freeze by block-phase rule, and
 *  deload holds load by the accessory rule's deload branch. */
function isLoadFrozen(input: LiveSetInput): boolean {
  const p = input.context.blockPhase;
  return p === "consolidation" || p === "off_pace" || p === "deload_week";
}

export function ruleLoadCall(input: LiveSetInput): CoachLine | null {
  const { set, exercise, context } = input;

  if (set.warmup) return null;
  // Time-based work (planks, hangs, foam rolls) has no kg/reps semantics.
  if (exercise.prescribed.duration_seconds != null) return null;
  if (set.reps == null || set.kg == null) return null;

  const repTarget = repsForExercise(exercise.prescribed);
  if (repTarget == null) return null;

  const effortTarget = exercise.prescribed.rir ?? context.rirTarget;
  const band = effortBand(set, effortTarget);
  if (band == null) return null;

  const hitReps = set.reps >= repTarget;

  // No grid means no loadable number to suggest (bodyweight work). Treat it
  // the same as a freeze: advise, but never name a weight.
  const grid = exercise.prescribed.increment;
  const frozen = isLoadFrozen(input) || grid == null;
  const finalSet = isFinalWorkingSet(exercise, set);
  const horizon = finalSet ? "next time" : "next set";

  const line = (text: string, apply_kg?: number): CoachLine => ({
    kind: "load_call",
    text,
    ...(apply_kg != null ? { apply_kg } : {}),
    cue: false,
    rule: "load_call",
  });

  if (hitReps) {
    if (band === "on") return null; // exactly to plan — say nothing
    if (band === "strained") {
      return line(`Hit ${set.reps}, but that cost more than it should. Same weight.`);
    }
    // band === "easy"
    if (frozen) {
      return line(
        `Too easy at RIR ${set.rir}. Add a rep ${horizon} — load's held this block.`,
      );
    }
    const up = nextUpKg(set.kg, grid);
    return line(`Too easy at RIR ${set.rir}. → ${fmtNum(up)} ${horizon}.`, up);
  }

  const short = repTarget - set.reps;
  if (band === "easy") {
    return line(
      `Stopped ${short} short with ${set.rir} in reserve. Same weight — push it.`,
    );
  }
  if (band === "on") {
    return line(
      `${short} short at the right effort. Load's heavy for this range — hold and let reps climb.`,
    );
  }
  // band === "strained"
  if (frozen) {
    return line(`Short by ${short} with nothing left. Load's held this block — same weight.`);
  }
  const down = nextDownKg(set.kg, grid);
  return line(`Short by ${short} with nothing left. → ${fmtNum(down)}.`, down);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-load-call.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/live-session/rule-load-call.ts lib/coach/live-session/__tests__/rule-load-call.test.ts
git commit -m "feat(live-session): load-call rule with exhaustive reps x effort table"
```

---

### Task 3: PR rule

**Files:**
- Create: `lib/coach/live-session/rule-pr.ts`
- Test: `lib/coach/live-session/__tests__/rule-pr.test.ts`

**Interfaces:**
- Consumes: `LiveSetInput`, `CoachLine` (Task 1); `brzycki` from `@/lib/coach/e1rm`; `fmtNum`.
- Produces: `rulePr(input: LiveSetInput): CoachLine | null`. This is the only rule that returns `cue: true`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/live-session/__tests__/rule-pr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rulePr } from "@/lib/coach/live-session/rule-pr";
import { brzycki } from "@/lib/coach/e1rm";
import type { LiveSetInput } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft } from "@/lib/logger/types";

const NAME = "Deadlift (Barbell)";

function mkInput(over: {
  kg?: number | null;
  reps?: number | null;
  best?: number | null;
  warmup?: boolean;
} = {}): LiveSetInput {
  const set: ExerciseSetDraft = {
    set_index: 0,
    kg: over.kg === undefined ? 100 : over.kg,
    reps: over.reps === undefined ? 5 : over.reps,
    duration_seconds: null,
    warmup: over.warmup ?? false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
  };
  return {
    set,
    exercise: {
      name: NAME,
      position: 0,
      prescribed: { name: NAME, baseKg: 100, baseReps: 5, sets: 3, increment: { step: 5 } },
      sets: [set],
    },
    sessionSets: [{ exerciseName: NAME, set }],
    context: {
      historyByExercise: {},
      bestByExercise: { [NAME]: over.best === undefined ? 110 : over.best },
      blockPhase: "pre_target",
      rirTarget: 2,
    },
  };
}

describe("rulePr", () => {
  it("fires when this set's e1RM beats the stored best", () => {
    // 100 x 5 -> Brzycki 112.5
    const line = rulePr(mkInput({ kg: 100, reps: 5, best: 110 }));
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("pr");
    expect(line!.cue).toBe(true);
    expect(line!.text).toContain("PR");
    expect(line!.text).toContain("112.5");
  });

  it("reports the margin over the previous best", () => {
    const line = rulePr(mkInput({ kg: 100, reps: 5, best: 110 }));
    const e1rm = brzycki(100, 5)!;
    expect(line!.text).toContain(`${Math.round((e1rm - 110) * 10) / 10}`);
  });

  it("stays silent when the set does not beat the best", () => {
    expect(rulePr(mkInput({ kg: 100, reps: 5, best: 120 }))).toBeNull();
  });

  it("stays silent when there is no prior history — first entry is not a PR", () => {
    expect(rulePr(mkInput({ best: null }))).toBeNull();
  });

  it("suppresses implausible jumps over 15 percent — a mistyped weight", () => {
    // 200 x 5 -> 225 e1RM against a 110 best is +104%: a typo, not a PR.
    expect(rulePr(mkInput({ kg: 200, reps: 5, best: 110 }))).toBeNull();
  });

  it("still fires just inside the 15 percent guard", () => {
    // best 100, set 100x3 -> 105.9 e1RM = +5.9%
    expect(rulePr(mkInput({ kg: 100, reps: 3, best: 100 }))).not.toBeNull();
  });

  it("stays silent on warmup sets", () => {
    expect(rulePr(mkInput({ warmup: true, kg: 100, reps: 5, best: 50 }))).toBeNull();
  });

  it("stays silent above 12 reps where Brzycki is unreliable", () => {
    expect(rulePr(mkInput({ kg: 100, reps: 15, best: 110 }))).toBeNull();
  });

  it("stays silent when kg or reps are missing", () => {
    expect(rulePr(mkInput({ kg: null }))).toBeNull();
    expect(rulePr(mkInput({ reps: null }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-pr.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/live-session/rule-pr`.

- [ ] **Step 3: Write `lib/coach/live-session/rule-pr.ts`**

```ts
// lib/coach/live-session/rule-pr.ts
//
// Celebrate at the moment it happens, not three hours later in the debrief.
// Celebration has a half-life.
//
// This is the only rule that returns cue: true. The audio cue is reserved for
// PRs so that a sound always means something genuinely happened.

import { brzycki } from "@/lib/coach/e1rm";
import { fmtNum } from "@/lib/ui/score";
import type { CoachLine, LiveSetInput } from "./types";

/** A single-session e1RM jump beyond this ratio is a mistyped weight far more
 *  often than a real PR, and a false celebration is worse than a missed one. */
const MAX_PLAUSIBLE_JUMP = 1.15;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function rulePr(input: LiveSetInput): CoachLine | null {
  const { set, exercise, context } = input;

  if (set.warmup) return null;
  if (set.kg == null || set.reps == null) return null;

  // brzycki returns null outside 1..12 reps — above that the linear
  // extrapolation stops being a strength proxy.
  const e1rm = brzycki(set.kg, set.reps);
  if (e1rm == null) return null;

  const best = context.bestByExercise[exercise.name] ?? null;
  if (best == null) return null;
  if (e1rm <= best) return null;
  if (e1rm > best * MAX_PLAUSIBLE_JUMP) return null;

  const margin = round1(e1rm - best);
  return {
    kind: "pr",
    text: `PR — ${fmtNum(set.kg)} × ${set.reps} = ${fmtNum(round1(e1rm))} e1RM, past your best by ${fmtNum(margin)}.`,
    cue: true,
    rule: "pr",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-pr.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/live-session/rule-pr.ts lib/coach/live-session/__tests__/rule-pr.test.ts
git commit -m "feat(live-session): live PR rule with implausible-jump guard"
```

---

### Task 4: Failure-budget and drop-off guardrails

**Files:**
- Create: `lib/coach/live-session/rule-failure-budget.ts`
- Create: `lib/coach/live-session/rule-drop-off.ts`
- Test: `lib/coach/live-session/__tests__/rule-guardrails.test.ts`

**Interfaces:**
- Consumes: `LiveSetInput`, `CoachLine` (Task 1); `isFinalWorkingSet`, `ordinal` (Task 1); `tierOf` from `@/lib/coach/session-structure/tiers`.
- Produces: `ruleFailureBudget(input): CoachLine | null`, `ruleDropOff(input): CoachLine | null`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/live-session/__tests__/rule-guardrails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ruleFailureBudget } from "@/lib/coach/live-session/rule-failure-budget";
import { ruleDropOff } from "@/lib/coach/live-session/rule-drop-off";
import type { LiveSetInput, SessionSetRef } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft, ExerciseDraft } from "@/lib/logger/types";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 60,
    reps: 10,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

/** Squat is tier 1 (compound); Lateral Raise is tier 3 (isolation). */
function mkInput(args: {
  name: string;
  sets: ExerciseSetDraft[];
  current: ExerciseSetDraft;
  sessionSets?: SessionSetRef[];
}): LiveSetInput {
  const exercise: ExerciseDraft = {
    name: args.name,
    position: 0,
    prescribed: { name: args.name, baseKg: 60, baseReps: 10, sets: 3, increment: { step: 2.5 } },
    sets: args.sets,
  };
  return {
    set: args.current,
    exercise,
    sessionSets:
      args.sessionSets ?? args.sets.map((s) => ({ exerciseName: args.name, set: s })),
    context: {
      historyByExercise: {},
      bestByExercise: {},
      blockPhase: "pre_target",
      rirTarget: 2,
    },
  };
}

describe("ruleFailureBudget", () => {
  it("stays silent on the first set taken to failure", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Squat (Barbell)", sets: [s0], current: s0 }),
    );
    expect(line).toBeNull();
  });

  it("fires on the second failure set of the session", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 }),
    );
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("2nd");
    expect(line!.cue).toBe(false);
  });

  it("counts failures across DIFFERENT exercises — the budget is session-wide", () => {
    const squat = mkSet({ set_index: 0, failure: true, rir: 0 });
    const press = mkSet({ set_index: 0, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({
        name: "Overhead Press (Barbell)",
        sets: [press],
        current: press,
        sessionSets: [
          { exerciseName: "Squat (Barbell)", set: squat },
          { exerciseName: "Overhead Press (Barbell)", set: press },
        ],
      }),
    );
    expect(line).not.toBeNull();
  });

  it("treats RIR 0 as failure even without the failure flag", () => {
    const s0 = mkSet({ set_index: 0, rir: 0 });
    const s1 = mkSet({ set_index: 1, rir: 0 });
    expect(
      ruleFailureBudget(mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 })),
    ).not.toBeNull();
  });

  it("allows failure on the last set of isolation work — that is the point of it", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, failure: true, rir: 0 });
    const line = ruleFailureBudget(
      mkInput({ name: "Lateral Raise (Dumbbell)", sets: [s0, s1], current: s1 }),
    );
    expect(line).toBeNull();
  });

  it("stays silent on a set that was not taken to failure", () => {
    const s0 = mkSet({ set_index: 0, failure: true, rir: 0 });
    const s1 = mkSet({ set_index: 1, rir: 3 });
    expect(
      ruleFailureBudget(mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 })),
    ).toBeNull();
  });
});

describe("ruleDropOff", () => {
  it("stays silent with fewer than three working sets", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 6 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1], current: s1 })),
    ).toBeNull();
  });

  it("fires when reps collapse below 75 percent of the best set at the same load", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 9 });
    const s2 = mkSet({ set_index: 2, reps: 7 });
    const line = ruleDropOff(
      mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 }),
    );
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("12");
    expect(line!.text).toContain("7");
  });

  it("stays silent when reps hold up", () => {
    const s0 = mkSet({ set_index: 0, reps: 12 });
    const s1 = mkSet({ set_index: 1, reps: 11 });
    const s2 = mkSet({ set_index: 2, reps: 10 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 })),
    ).toBeNull();
  });

  it("ignores earlier sets performed at a LIGHTER load", () => {
    // A 12-rep set at 40kg must not make a 7-rep set at 80kg look like a
    // collapse — they are different efforts.
    const s0 = mkSet({ set_index: 0, kg: 40, reps: 12 });
    const s1 = mkSet({ set_index: 1, kg: 80, reps: 8 });
    const s2 = mkSet({ set_index: 2, kg: 80, reps: 7 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [s0, s1, s2], current: s2 })),
    ).toBeNull();
  });

  it("excludes warmups from the comparison", () => {
    const w = mkSet({ set_index: 0, kg: 60, reps: 20, warmup: true });
    const s1 = mkSet({ set_index: 1, reps: 10 });
    const s2 = mkSet({ set_index: 2, reps: 9 });
    const s3 = mkSet({ set_index: 3, reps: 8 });
    expect(
      ruleDropOff(mkInput({ name: "Squat (Barbell)", sets: [w, s1, s2, s3], current: s3 })),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-guardrails.test.ts`
Expected: FAIL — cannot resolve the two rule modules.

- [ ] **Step 3: Write `lib/coach/live-session/rule-failure-budget.ts`**

```ts
// lib/coach/live-session/rule-failure-budget.ts
//
// Junk fatigue is the most common self-coaching error: taking working sets to
// failure repeatedly because it feels like effort. Failure on the LAST set of
// isolation work is appropriate and stays unflagged; everything else past the
// first is a debt paid later in the week.

import { tierOf } from "@/lib/coach/session-structure/tiers";
import { isFinalWorkingSet, ordinal } from "./helpers";
import type { CoachLine, LiveSetInput, SessionSetRef } from "./types";

function wasToFailure(s: SessionSetRef["set"]): boolean {
  return !s.warmup && (s.failure || s.rir === 0);
}

export function ruleFailureBudget(input: LiveSetInput): CoachLine | null {
  const { set, exercise, sessionSets } = input;

  if (!wasToFailure(set)) return null;

  // Tier 3 (isolation) and tier 4 (finisher) earn a failure set at the end.
  const tier = tierOf(exercise.prescribed);
  if ((tier === 3 || tier === 4) && isFinalWorkingSet(exercise, set)) return null;

  const count = sessionSets.filter((r) => wasToFailure(r.set)).length;
  if (count < 2) return null;

  return {
    kind: "guardrail",
    text: `${ordinal(count)} set to failure today. That's fatigue you'll pay for later in the week — leave 2 in the tank.`,
    cue: false,
    rule: "failure_budget",
  };
}
```

- [ ] **Step 4: Write `lib/coach/live-session/rule-drop-off.ts`**

```ts
// lib/coach/live-session/rule-drop-off.ts
//
// Rep drop-off at a fixed load is the practical proxy for velocity loss, the
// standard in-session stopping criterion. Once reps fall far enough below the
// best set at the same-or-heavier load, further sets buy fatigue, not
// adaptation.

import type { CoachLine, LiveSetInput } from "./types";
import type { ExerciseSetDraft } from "@/lib/logger/types";

/** Below this fraction of the best comparable set, the exercise is done. */
const DROP_OFF_RATIO = 0.75;

function isUsable(s: ExerciseSetDraft): boolean {
  return !s.warmup && s.committed_at != null && s.reps != null && s.kg != null;
}

export function ruleDropOff(input: LiveSetInput): CoachLine | null {
  const { set, exercise } = input;

  if (set.warmup) return null;
  if (set.reps == null || set.kg == null) return null;

  const committed = exercise.sets.filter(isUsable);
  if (committed.length < 3) return null;

  // Compare only against sets at the same or a heavier load — a light early
  // set is a different effort and must not define the ceiling.
  const comparable = committed.filter((s) => (s.kg as number) >= (set.kg as number));
  if (comparable.length === 0) return null;

  const bestReps = Math.max(...comparable.map((s) => s.reps as number));
  if (bestReps <= 0) return null;
  if (set.reps >= bestReps * DROP_OFF_RATIO) return null;

  const trail = committed
    .slice(-3)
    .map((s) => s.reps)
    .join(" → ");

  return {
    kind: "guardrail",
    text: `${trail}. Past the useful range — last set or move on.`,
    cue: false,
    rule: "drop_off",
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-guardrails.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/live-session/rule-failure-budget.ts lib/coach/live-session/rule-drop-off.ts lib/coach/live-session/__tests__/rule-guardrails.test.ts
git commit -m "feat(live-session): failure-budget and rep drop-off guardrails"
```

---

### Task 5: Rest-discipline rule and the orchestrator

**Files:**
- Create: `lib/coach/live-session/rule-rest-discipline.ts`
- Create: `lib/coach/live-session/index.ts`
- Test: `lib/coach/live-session/__tests__/evaluate-set.test.ts`

**Interfaces:**
- Consumes: all five rules; `tierOf`, `restPrescription`, `repsForExercise`.
- Produces: `ruleRestDiscipline(input): CoachLine | null`; `evaluateSet(input: LiveSetInput): CoachLine | null`; the barrel re-exports `CoachLine`, `LiveSetInput`, `LiveSessionContext`, `SessionSetRef`.

**Note on rest measurement:** `ExerciseSetDraft.rest_seconds_actual` is **undefined during a live session** — it is derived from `committed_at` deltas at commit time. This rule therefore derives it the same way, from the previous committed set's `committed_at`. That keeps the live number consistent with the one eventually persisted.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/live-session/__tests__/evaluate-set.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateSet } from "@/lib/coach/live-session";
import { ruleRestDiscipline } from "@/lib/coach/live-session/rule-rest-discipline";
import type { LiveSetInput } from "@/lib/coach/live-session/types";
import type { ExerciseSetDraft } from "@/lib/logger/types";

const SQUAT = "Squat (Barbell)";

function at(iso: string): string {
  return iso;
}

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 100,
    reps: 5,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: at("2026-08-10T09:00:00.000Z"),
    ...over,
  };
}

function mkInput(args: {
  sets: ExerciseSetDraft[];
  current: ExerciseSetDraft;
  best?: number | null;
  baseReps?: number;
}): LiveSetInput {
  return {
    set: args.current,
    exercise: {
      name: SQUAT,
      position: 0,
      prescribed: {
        name: SQUAT,
        baseKg: 100,
        baseReps: args.baseReps ?? 5,
        sets: 3,
        increment: { step: 5 },
      },
      sets: args.sets,
    },
    sessionSets: args.sets.map((s) => ({ exerciseName: SQUAT, set: s })),
    context: {
      historyByExercise: {},
      bestByExercise: { [SQUAT]: args.best === undefined ? null : args.best },
      blockPhase: "pre_target",
      rirTarget: 2,
    },
  };
}

describe("ruleRestDiscipline", () => {
  it("fires when rest before a tier-1 set was under 60 percent of prescribed", () => {
    // Squat at 5 reps -> restPrescription(tier 1, 5) = { min: 180 }. 60% = 108s.
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:00:55.000Z") });
    const line = ruleRestDiscipline(mkInput({ sets: [s0, s1], current: s1 }));
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("guardrail");
    expect(line!.text).toContain("55s");
  });

  it("stays silent when rest was adequate", () => {
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:03:30.000Z") });
    expect(ruleRestDiscipline(mkInput({ sets: [s0, s1], current: s1 }))).toBeNull();
  });

  it("stays silent on the first set — there is no prior rest to judge", () => {
    const s0 = mkSet({ set_index: 0 });
    expect(ruleRestDiscipline(mkInput({ sets: [s0], current: s0 }))).toBeNull();
  });

  it("fires at most once per exercise", () => {
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:00:50.000Z") });
    const s2 = mkSet({ set_index: 2, committed_at: at("2026-08-10T09:01:40.000Z") });
    expect(ruleRestDiscipline(mkInput({ sets: [s0, s1, s2], current: s1 }))).not.toBeNull();
    expect(ruleRestDiscipline(mkInput({ sets: [s0, s1, s2], current: s2 }))).toBeNull();
  });

  it("does not police rest on isolation work", () => {
    const s0 = mkSet({ set_index: 0, committed_at: at("2026-08-10T09:00:00.000Z") });
    const s1 = mkSet({ set_index: 1, committed_at: at("2026-08-10T09:00:20.000Z") });
    const input = mkInput({ sets: [s0, s1], current: s1 });
    input.exercise.name = "Lateral Raise (Dumbbell)";
    input.exercise.prescribed.name = "Lateral Raise (Dumbbell)";
    expect(ruleRestDiscipline(input)).toBeNull();
  });
});

describe("evaluateSet — priority", () => {
  it("returns the PR line even when the load call would also fire", () => {
    // 100x5 with RIR 4 is both a PR (best 105) and a too-easy load call.
    const s0 = mkSet({ set_index: 0, rir: 4, committed_at: at("2026-08-10T09:00:00.000Z") });
    const line = evaluateSet(mkInput({ sets: [s0], current: s0, best: 105 }));
    expect(line).not.toBeNull();
    expect(line!.rule).toBe("pr");
    expect(line!.cue).toBe(true);
  });

  it("prefers the failure guardrail over the load call", () => {
    const s0 = mkSet({ set_index: 0, rir: 0, failure: true });
    const s1 = mkSet({ set_index: 1, rir: 0, failure: true, reps: 3 });
    const line = evaluateSet(mkInput({ sets: [s0, s1], current: s1 }));
    expect(line!.rule).toBe("failure_budget");
  });

  it("falls through to the load call when no guardrail fires", () => {
    const s0 = mkSet({ set_index: 0, rir: 4 });
    const line = evaluateSet(mkInput({ sets: [s0], current: s0 }));
    expect(line!.rule).toBe("load_call");
  });

  it("returns null for a set that went exactly to plan", () => {
    const s0 = mkSet({ set_index: 0, reps: 5, rir: 2 });
    expect(evaluateSet(mkInput({ sets: [s0], current: s0 }))).toBeNull();
  });

  it("never throws — a rule bug must not block a set commit", () => {
    const s0 = mkSet({ set_index: 0 });
    const broken = mkInput({ sets: [s0], current: s0 });
    // @ts-expect-error deliberately corrupting the context to simulate a bug
    broken.context = null;
    expect(() => evaluateSet(broken)).not.toThrow();
    expect(evaluateSet(broken)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/live-session/__tests__/evaluate-set.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/live-session`.

- [ ] **Step 3: Write `lib/coach/live-session/rule-rest-discipline.ts`**

```ts
// lib/coach/live-session/rule-rest-discipline.ts
//
// Under-resting a heavy compound guarantees the next set underperforms, and
// the athlete then reads that as a strength problem rather than a pacing one.
//
// ExerciseSetDraft.rest_seconds_actual is undefined mid-session — it is
// derived from committed_at deltas at commit time. This rule derives it the
// same way so the live number matches the one eventually persisted. Note that
// both measure commit-to-commit (rest plus set execution), not pure rest.

import { tierOf } from "@/lib/coach/session-structure/tiers";
import { restPrescription, repsForExercise } from "@/lib/coach/session-structure/rules";
import type { CoachLine, LiveSetInput } from "./types";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

/** Below this fraction of the prescribed minimum, the next set will suffer. */
const UNDER_REST_RATIO = 0.6;

/** Seconds between the previous committed set and this one, or null when
 *  there is no prior committed set to measure from. */
function restBefore(
  exercise: ExerciseDraft,
  set: ExerciseSetDraft,
): number | null {
  if (set.committed_at == null) return null;
  const prior = exercise.sets
    .filter((s) => s.committed_at != null && s.set_index < set.set_index)
    .sort((a, b) => b.set_index - a.set_index)[0];
  if (!prior?.committed_at) return null;
  const delta = Date.parse(set.committed_at) - Date.parse(prior.committed_at);
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.round(delta / 1000);
}

export function ruleRestDiscipline(input: LiveSetInput): CoachLine | null {
  const { set, exercise } = input;

  if (set.warmup) return null;

  // Only heavy compounds. Isolation pacing is the athlete's business.
  const tier = tierOf(exercise.prescribed);
  if (tier !== 1 && tier !== 2) return null;

  const reps = repsForExercise(exercise.prescribed);
  const threshold = restPrescription(tier, reps).min * UNDER_REST_RATIO;

  const actual = restBefore(exercise, set);
  if (actual == null) return null;
  if (actual >= threshold) return null;

  // Once per exercise: inform, do not nag.
  const alreadyFlagged = exercise.sets.some((s) => {
    if (s.set_index >= set.set_index) return false;
    const r = restBefore(exercise, s);
    return r != null && r < threshold;
  });
  if (alreadyFlagged) return null;

  const prescribedMin = restPrescription(tier, reps).min;
  const label = prescribedMin % 60 === 0
    ? `${prescribedMin / 60}-minute`
    : `${prescribedMin}s`;

  return {
    kind: "guardrail",
    text: `${actual}s rest on a ${label} lift. Expect the next set to come up short.`,
    cue: false,
    rule: "rest_discipline",
  };
}
```

- [ ] **Step 4: Write `lib/coach/live-session/index.ts`**

```ts
// lib/coach/live-session/index.ts
//
// Between-sets coaching. Given the set just committed, return AT MOST ONE
// line — or null, which is the common case by design: a set that went to plan
// gets silence. Scarcity is what keeps the line credible.
//
// Priority is fixed and deliberate:
//   1. PR              — celebrate at the moment it happens
//   2. failure budget  — safety before progression
//   3. drop-off        — stop the exercise before it buys pure fatigue
//   4. load call       — the core verdict
//   5. rest discipline — pacing, lowest stakes
//
// Spec: docs/superpowers/specs/2026-08-10-live-session-coaching-design.md

import { rulePr } from "./rule-pr";
import { ruleFailureBudget } from "./rule-failure-budget";
import { ruleDropOff } from "./rule-drop-off";
import { ruleLoadCall } from "./rule-load-call";
import { ruleRestDiscipline } from "./rule-rest-discipline";
import type { CoachLine, LiveSetInput } from "./types";

export type {
  CoachLine,
  CoachLineKind,
  LiveSetInput,
  LiveSessionContext,
  SessionSetRef,
} from "./types";

const RULES: ReadonlyArray<(input: LiveSetInput) => CoachLine | null> = [
  rulePr,
  ruleFailureBudget,
  ruleDropOff,
  ruleLoadCall,
  ruleRestDiscipline,
];

export function evaluateSet(input: LiveSetInput): CoachLine | null {
  for (const rule of RULES) {
    try {
      const line = rule(input);
      if (line) return line;
    } catch {
      // A rule bug must never prevent a set from being logged. The coaching
      // line is strictly additive; silence is always an acceptable output.
    }
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/coach/live-session/`
Expected: PASS — all four test files, 47 tests total.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/live-session/rule-rest-discipline.ts lib/coach/live-session/index.ts lib/coach/live-session/__tests__/evaluate-set.test.ts
git commit -m "feat(live-session): rest-discipline rule and priority orchestrator"
```

---

### Task 6: Context fetcher and hook

**Files:**
- Create: `lib/query/fetchers/liveSessionContext.ts`
- Create: `lib/query/hooks/useLiveSessionContext.ts`
- Modify: `lib/query/keys.ts`

**Interfaces:**
- Consumes: `createFetcher` from `@/lib/query/fetchers/create-fetcher`; `normalizeExerciseName` from `@/lib/coach/exercise-muscles`; `bestComparisonValue` from `@/lib/coach/e1rm`; `evaluateBlockPhase` from `@/lib/coach/prescription/block-phase-rule`; `computeOlsSlope` from `@/lib/coach/prescription/calibrate-target`; `mondayOfIso` from `@/lib/time/dates`; `LiveSessionContext` (Task 1).
- Produces: `fetchLiveSessionContextServer`, `fetchLiveSessionContextBrowser`, `useLiveSessionContext(userId, date, exerciseNames)`, `queryKeys.liveSessionContext.one`.

**Design note:** no API route. `createFetcher`'s browser variant goes straight to Supabase under RLS, which is the dominant read pattern in this codebase. There are no server-only secrets in this payload.

**Window note:** history is 180 days, sliced two ways. `bestByExercise` uses the full 180d (a PR against only 28 days is not a PR). `historyByExercise` keeps the last 28d for parity with the weekly engine's window. A long window is deliberate here — recency-anchored windows silently empty out after a training gap.

- [ ] **Step 1: Add the query key**

In `lib/query/keys.ts`, add alongside the existing `previousSet` entry:

```ts
  liveSessionContext: {
    one: (userId: string, date: string, exerciseNames: readonly string[]) =>
      [
        "live-session-context",
        userId,
        date,
        [...exerciseNames].map((n) => n.trim().toLowerCase()).sort().join("|"),
      ] as const,
  },
```

- [ ] **Step 2: Write `lib/query/fetchers/liveSessionContext.ts`**

```ts
// lib/query/fetchers/liveSessionContext.ts
//
// Everything the between-sets coaching rules need, assembled in ONE round
// trip at logger open. Rules then run synchronously on each set commit, so
// nothing touches the network in the hot path — the feature keeps working
// when gym wifi drops.
//
// Consumed by lib/coach/live-session. See
// docs/superpowers/specs/2026-08-10-live-session-coaching-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";
import { normalizeExerciseName } from "@/lib/coach/exercise-muscles";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import { computeOlsSlope } from "@/lib/coach/prescription/calibrate-target";
import { mondayOfIso } from "@/lib/time/dates";
import type { LiveSessionContext } from "@/lib/coach/live-session/types";
import type { WorkoutSetSample, BlockPhase } from "@/lib/coach/prescription/types";
import type { TrainingBlock } from "@/lib/data/types";

/** PR comparison window. Long on purpose: a "best" computed over a short
 *  recency window silently resets after any training gap. */
const PR_WINDOW_DAYS = 180;
/** Rule-history window — matches the weekly prescription engine's. */
const HISTORY_WINDOW_DAYS = 28;

type Args = {
  userId: string;
  /** Today in the user's timezone, YYYY-MM-DD. */
  today: string;
  /** Exercise names as they appear in the logger draft. */
  exerciseNames: string[];
};

function daysBefore(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

type SetRowShape = {
  kg: number | null;
  reps: number | null;
  warmup: boolean | null;
  failure: boolean | null;
  rir: number | null;
};

/** A history set carrying the date it was performed — the week index for the
 *  OLS slope is derived from it. bestComparisonValue ignores the extra field. */
type DatedSet = SetRowShape & { performed_on: string };

const liveSessionContextFetcher = createFetcher(
  async (supabase: SupabaseClient, args: Args): Promise<LiveSessionContext> => {
    const names = args.exerciseNames.filter((n) => n.trim().length > 0);
    const empty: LiveSessionContext = {
      historyByExercise: {},
      bestByExercise: {},
      blockPhase: "pre_target",
      rirTarget: 2,
    };
    if (names.length === 0) return empty;

    const prFrom = daysBefore(args.today, PR_WINDOW_DAYS);
    const historyFrom = daysBefore(args.today, HISTORY_WINDOW_DAYS);

    const { data: workouts, error } = await supabase
      .from("workouts")
      .select(
        "date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir))",
      )
      .eq("user_id", args.userId)
      .gte("date", prFrom)
      .lt("date", args.today)
      .order("date", { ascending: false });
    if (error) throw error;

    // Map normalized name -> draft name, so "Bench Press" in history resolves
    // to "Bench Press (Barbell)" in today's plan.
    const byNormalized = new Map<string, string>();
    for (const n of names) {
      const key = normalizeExerciseName(n);
      if (key) byNormalized.set(key, n);
    }

    const historyByExercise: Record<string, WorkoutSetSample[]> = {};
    const prSetsByExercise: Record<string, DatedSet[]> = {};
    for (const n of names) {
      historyByExercise[n] = [];
      prSetsByExercise[n] = [];
    }

    for (const w of workouts ?? []) {
      const date = w.date as string;
      const exercises = (w.exercises ?? []) as Array<{
        name: string;
        exercise_sets: SetRowShape[] | null;
      }>;
      for (const ex of exercises) {
        const draftName = byNormalized.get(normalizeExerciseName(ex.name));
        if (!draftName) continue;
        for (const s of ex.exercise_sets ?? []) {
          if (s.warmup) continue;
          if (s.kg == null || s.reps == null) continue;
          prSetsByExercise[draftName].push({ ...s, performed_on: date });
          if (date >= historyFrom) {
            historyByExercise[draftName].push({
              exercise_name: ex.name,
              exercise_key: null,
              kg: s.kg,
              reps: s.reps,
              warmup: false,
              failure: s.failure === true,
              performed_on: date,
              rir: s.rir,
            });
          }
        }
      }
    }

    const bestByExercise: Record<string, number | null> = {};
    for (const n of names) {
      bestByExercise[n] = bestComparisonValue(prSetsByExercise[n], "e1rm");
    }

    // Block phase. recentProgressionRatePerWeek is derived from the same
    // 180d set stream via the engine's own OLS helper, so the off_pace branch
    // is live rather than silently skipped.
    const { data: block, error: blockErr } = await supabase
      .from("training_blocks")
      .select("*")
      .eq("user_id", args.userId)
      .eq("status", "active")
      .maybeSingle();
    if (blockErr) throw blockErr;

    let blockPhase: BlockPhase = "pre_target";
    if (block) {
      const b = block as TrainingBlock;
      const liftName = names.find(
        (n) => b.primary_lift != null && normalizeExerciseName(n).includes(b.primary_lift),
      );
      const liftSets = liftName ? prSetsByExercise[liftName] : [];
      const metric = b.target_metric ?? "working_weight";
      const currentWorkingKg = bestComparisonValue(liftSets, metric);

      // Per-week max comparison value, week index measured from the window
      // start so it increases with time (computeOlsSlope requires 0-indexed,
      // monotonically increasing indices and >= 3 samples).
      const windowStartMs = Date.parse(`${prFrom}T00:00:00Z`);
      const perWeek = new Map<number, number>();
      for (const s of liftSets) {
        if (s.kg == null || s.reps == null) continue;
        const v = bestComparisonValue([s], metric);
        if (v == null) continue;
        const idx = Math.floor(
          (Date.parse(`${s.performed_on}T00:00:00Z`) - windowStartMs) / (7 * 86_400_000),
        );
        if (!Number.isFinite(idx)) continue;
        const prior = perWeek.get(idx);
        if (prior == null || v > prior) perWeek.set(idx, v);
      }
      const samples = [...perWeek.entries()]
        .map(([weekIndex, e1rm]) => ({ weekIndex, e1rm }))
        .sort((a, z) => a.weekIndex - z.weekIndex);

      blockPhase = evaluateBlockPhase({
        block: b,
        currentWorkingKg,
        recentProgressionRatePerWeek: computeOlsSlope(samples),
        todayIso: args.today,
      });
    }

    // rir_target for the current week. `?? 2` is the SAME fallback expression
    // prescribeWeek uses — that is what keeps the two from disagreeing.
    const { data: week, error: weekErr } = await supabase
      .from("training_weeks")
      .select("rir_target")
      .eq("user_id", args.userId)
      .eq("week_start", mondayOfIso(args.today))
      .maybeSingle();
    if (weekErr) throw weekErr;

    return {
      historyByExercise,
      bestByExercise,
      blockPhase,
      rirTarget: (week?.rir_target as number | null) ?? 2,
    };
  },
);

export const fetchLiveSessionContextServer = liveSessionContextFetcher.server;
export const fetchLiveSessionContextBrowser = liveSessionContextFetcher.browser;
```

- [ ] **Step 3: Write `lib/query/hooks/useLiveSessionContext.ts`**

```ts
// lib/query/hooks/useLiveSessionContext.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchLiveSessionContextBrowser } from "@/lib/query/fetchers/liveSessionContext";

/**
 * Fetched ONCE when the logger opens and then held. staleTime is Infinity on
 * purpose: the only thing that changes during a session is the athlete's own
 * sets, which the rules read from the draft rather than from this snapshot.
 */
export function useLiveSessionContext(
  userId: string,
  date: string,
  exerciseNames: string[],
) {
  return useQuery({
    queryKey: queryKeys.liveSessionContext.one(userId, date, exerciseNames),
    queryFn: () =>
      fetchLiveSessionContextBrowser({ userId, today: date, exerciseNames }),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    enabled: exerciseNames.length > 0,
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `mondayOfIso` is not exported from `@/lib/time/dates`, run `grep -rn "export function mondayOf" lib/time/` and use the exported name.

- [ ] **Step 5: Run the full suite and commit**

```bash
npx vitest run
git add lib/query/fetchers/liveSessionContext.ts lib/query/hooks/useLiveSessionContext.ts lib/query/keys.ts
git commit -m "feat(live-session): context fetcher and hook"
```

---

### Task 7: The UI — Target column, CoachLine, apply-tap

**Files:**
- Create: `components/logger/CoachLine.tsx`
- Modify: `components/logger/ExerciseCard.tsx`
- Modify: `components/logger/LoggerSheet.tsx`

**Interfaces:**
- Consumes: `evaluateSet`, `CoachLine` type, `LiveSessionContext` (Tasks 1–5); `useLiveSessionContext` (Task 6); `fireCue` from `@/lib/logger/audio-cue`.
- Produces: `<CoachLineRow line={...} onApply={...} />`; a `liveContext` prop on `ExerciseCard`.

- [ ] **Step 1: Write `components/logger/CoachLine.tsx`**

```tsx
"use client";

import type { CoachLine } from "@/lib/coach/live-session";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  line: CoachLine;
  /** Called with the suggested load when the athlete taps the number.
   *  Absent when the line carries no apply_kg. */
  onApply?: (kg: number) => void;
};

const TONE: Record<CoachLine["kind"], string> = {
  pr: "text-green-400 bg-green-500/10 border-green-500/30",
  guardrail: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  load_call: "text-blue-400 bg-blue-500/10 border-blue-500/30",
};

export function CoachLineRow({ line, onApply }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 my-1 text-[11px] leading-snug ${TONE[line.kind]}`}
    >
      <span className="flex-1">{line.text}</span>
      {line.apply_kg != null && onApply && (
        <button
          type="button"
          onClick={() => onApply(line.apply_kg as number)}
          className="shrink-0 font-mono tabular-nums font-semibold px-2 py-1 rounded-md bg-blue-500/20 hover:bg-blue-500/30"
          aria-label={`Set next set to ${fmtNum(line.apply_kg)} kilograms`}
        >
          {fmtNum(line.apply_kg)}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the `liveContext` prop and coaching state to `ExerciseCard`**

In `components/logger/ExerciseCard.tsx`, extend `Props`:

```ts
  /** Snapshot fetched at logger open. Undefined while loading or on fetch
   *  failure — the coaching line then degrades to silence. */
  liveContext?: LiveSessionContext;
```

Add imports at the top:

```ts
import { evaluateSet, type CoachLine, type LiveSessionContext, type SessionSetRef } from "@/lib/coach/live-session";
import { CoachLineRow } from "@/components/logger/CoachLine";
import { fireCue } from "@/lib/logger/audio-cue";
```

Add state next to the existing `useState` declarations:

```ts
  const [coachLine, setCoachLine] = useState<CoachLine | null>(null);
```

- [ ] **Step 3: Evaluate on commit**

Replace the body of `commitSet` in `ExerciseCard.tsx` with:

```ts
  const commitSet = useCallback((setIndex: number) => {
    const nowIso = new Date().toISOString();
    const now = Date.now();
    const nextSets = exercise.sets.map((s, i) => {
      if (i !== setIndex) return s;
      return { ...s, committed_at: nowIso };
    });
    const nextExercise = { ...exercise, sets: nextSets };

    onExerciseChange(exerciseIndex, nextExercise);
    setRestAfterSetIndex(setIndex);
    setActiveRestSeconds(effectiveRest);
    setActiveRestStartedAt(now);

    // Between-sets coaching. Silent by design on an on-plan set, and silent
    // whenever the context snapshot is unavailable.
    if (liveContext) {
      const committedSet = nextSets[setIndex];
      const sessionSets: SessionSetRef[] = allExercises.flatMap((ex, i) =>
        (i === exerciseIndex ? nextSets : ex.sets)
          .filter((s) => !s.warmup && s.committed_at != null)
          .map((s) => ({ exerciseName: ex.name, set: s })),
      );
      const line = evaluateSet({
        set: committedSet,
        exercise: nextExercise,
        sessionSets,
        context: liveContext,
      });
      setCoachLine(line);
      if (line?.cue) fireCue();
    }
  }, [exercise, exerciseIndex, onExerciseChange, effectiveRest, liveContext, allExercises]);
```

- [ ] **Step 4: Render the line and wire the apply-tap**

In the `exercise.sets.map(...)` body of `ExerciseCard.tsx`, insert directly above the existing `{restAfterSetIndex === i && (...)}` block:

```tsx
              {restAfterSetIndex === i && coachLine && (
                <tr><td colSpan={7}>
                  <CoachLineRow
                    line={coachLine}
                    onApply={(kg) => {
                      // Only write into an EMPTY, uncommitted field — never
                      // clobber a number the athlete is already typing.
                      const target = exercise.sets.findIndex(
                        (s, j) => j > i && !s.committed_at && s.kg == null,
                      );
                      if (target >= 0) patchSet(target, { kg });
                      setCoachLine(null);
                    }}
                  />
                </td></tr>
              )}
```

- [ ] **Step 5: Add the Target row to the Previous cell**

In `ExerciseCard.tsx`, change the `Previous` header cell to:

```tsx
            <th className="text-left font-normal py-1">Target / prev</th>
```

In `components/logger/SetRow.tsx`, replace the `Previous` `<td>` (the one rendering `prev.data`) with a stacked cell. Add to `SetRow`'s `Props`:

```ts
  /** Prescribed load x reps @RIR for this exercise. Null for time-based work. */
  target: { kg: number | null; reps: number | null; rir: number | null } | null;
```

and render:

```tsx
      <td className="py-1 text-[10.5px] leading-tight">
        {target && (target.kg != null || target.reps != null) && (
          <div className="text-zinc-300 font-mono tabular-nums">
            {target.kg != null ? fmtNum(target.kg) : "BW"}
            {target.reps != null ? ` × ${target.reps}` : ""}
            {target.rir != null ? ` @${target.rir}` : ""}
          </div>
        )}
        <div className="text-zinc-600">
          {prev.data ? (
            <span title={prev.data.fallback ? `Last available set on ${prev.data.workout_date}` : prev.data.workout_date}>
              {prev.data.kg === null ? "BW" : fmtNum(prev.data.kg)} × {prev.data.reps ?? "—"}
              {prev.data.fallback && <span className="text-zinc-700">·</span>}
            </span>
          ) : "—"}
        </div>
      </td>
```

Pass it from `ExerciseCard.tsx` inside the `<SetRow ... />` call:

```tsx
                target={
                  exercise.prescribed.duration_seconds != null
                    ? null
                    : {
                        kg: exercise.prescribed.baseKg ?? null,
                        reps: exercise.prescribed.baseReps ?? null,
                        rir: exercise.prescribed.rir ?? null,
                      }
                }
```

Note: the time-based branch of `SetRow` returns early and renders its own cells — leave that branch untouched.

- [ ] **Step 6: Fetch the context in `LoggerSheet` and pass it down**

In `components/logger/LoggerSheet.tsx`, add the import:

```ts
import { useLiveSessionContext } from "@/lib/query/hooks/useLiveSessionContext";
```

Add next to the other hooks — **above any early return**, since this codebase has no render-test harness and hook-order bugs surface only in a production build:

```ts
  const exerciseNames = useMemo(
    () => (draft ? draft.exercises.map((e) => e.name) : []),
    [draft],
  );
  const liveContext = useLiveSessionContext(props.userId, props.date, exerciseNames);
```

Then pass it on the `<ExerciseCard ... />` call:

```tsx
            liveContext={liveContext.data}
```

- [ ] **Step 7: Verify**

```bash
npm run typecheck
npx vitest run
npm run build
```

Expected: all clean. The build step is not optional — it is the only gate that catches React hook-order errors in this repo.

- [ ] **Step 8: Commit**

```bash
git add components/logger/CoachLine.tsx components/logger/ExerciseCard.tsx components/logger/SetRow.tsx components/logger/LoggerSheet.tsx
git commit -m "feat(logger): render the between-sets coaching line and target column"
```

---

### Task 8: Audit script and documentation

**Files:**
- Create: `scripts/audit-live-session-rules.mjs`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `evaluateSet` and the individual rules (Tasks 1–5).
- Produces: a DB-free fixture audit runnable via the repo's alias-loader.

- [ ] **Step 1: Write `scripts/audit-live-session-rules.mjs`**

```js
// scripts/audit-live-session-rules.mjs
//
// Fixture-based audit for lib/coach/live-session. No DB access. Mirrors
// scripts/audit-prescription-rules.mjs.
//
// Run:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local scripts/audit-live-session-rules.mjs

import { evaluateSet } from "../lib/coach/live-session/index.ts";
import { nextUpKg, nextDownKg } from "../lib/coach/prescription/double-progression-rule.ts";

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

function mkSet(over = {}) {
  return {
    set_index: 0,
    kg: 60,
    reps: 10,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

function mkInput(over = {}) {
  const set = mkSet(over.set);
  const name = over.name ?? "Decline Bench Press (Barbell)";
  return {
    set,
    exercise: {
      name,
      position: 0,
      prescribed: {
        name,
        baseKg: 60,
        baseReps: 10,
        sets: 3,
        increment: { step: 2.5 },
        ...(over.prescribed ?? {}),
      },
      sets: over.sets ?? [set],
    },
    sessionSets: (over.sets ?? [set]).map((s) => ({ exerciseName: name, set: s })),
    context: {
      historyByExercise: {},
      bestByExercise: over.bestByExercise ?? {},
      blockPhase: over.blockPhase ?? "pre_target",
      rirTarget: 2,
    },
  };
}

// --- Silence is the default -------------------------------------------------
check(
  "on-plan set is silent",
  evaluateSet(mkInput({ set: { reps: 10, rir: 2 } })),
  null,
);

// --- Load calls land on the grid -------------------------------------------
check(
  "step up matches nextUpKg",
  evaluateSet(mkInput({ set: { reps: 10, rir: 4 } }))?.apply_kg,
  nextUpKg(60, { step: 2.5 }),
);
check(
  "step down matches nextDownKg",
  evaluateSet(mkInput({ set: { reps: 6, rir: 0 } }))?.apply_kg,
  nextDownKg(60, { step: 2.5 }),
);
check(
  "micro-pin grid step up matches nextUpKg",
  evaluateSet(
    mkInput({
      set: { kg: 22, reps: 15, rir: 4 },
      prescribed: { baseReps: 15, increment: { step: 5, intermediate: 2.3 } },
    }),
  )?.apply_kg,
  nextUpKg(22, { step: 5, intermediate: 2.3 }),
);

// --- Frozen phases never name a load ---------------------------------------
for (const blockPhase of ["consolidation", "off_pace", "deload_week"]) {
  check(
    `no load change during ${blockPhase}`,
    evaluateSet(mkInput({ set: { reps: 10, rir: 4 }, blockPhase }))?.apply_kg,
    undefined,
  );
}

// --- PR priority and guards ------------------------------------------------
check(
  "PR beats the load call",
  evaluateSet(
    mkInput({ set: { kg: 100, reps: 5, rir: 4 }, bestByExercise: { "Decline Bench Press (Barbell)": 105 } }),
  )?.rule,
  "pr",
);
check(
  "implausible jump is suppressed",
  evaluateSet(
    mkInput({ set: { kg: 300, reps: 5, rir: 4 }, bestByExercise: { "Decline Bench Press (Barbell)": 105 } }),
  )?.rule,
  "load_call",
);
check(
  "no history means no PR",
  evaluateSet(mkInput({ set: { kg: 100, reps: 5, rir: 2 }, bestByExercise: {} })),
  null,
);

// --- Never throws ----------------------------------------------------------
let threw = false;
try {
  const broken = mkInput();
  broken.context = null;
  evaluateSet(broken);
} catch {
  threw = true;
}
check("evaluateSet never throws", threw, false);

console.log(`\n${passed} assertion(s) passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:\n  ${failures.join("\n  ")}\n`);
  process.exit(1);
}
console.log("live-session rules audit: OK\n");
```

- [ ] **Step 2: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-live-session-rules.mjs
```
Expected: `live-session rules audit: OK` with 11 assertions passed, exit 0.

- [ ] **Step 3: Document in `CLAUDE.md`**

Add to the **Coach / AI** section, after the "Session-structure coaching" bullet:

```markdown
- **Live session coaching** ([lib/coach/live-session/](lib/coach/live-session/)) — between-sets coaching in the workout logger. On each committed set, `evaluateSet(LiveSetInput)` returns AT MOST ONE `CoachLine` (or null — an on-plan set is silent by design). Five rules in fixed priority: PR → failure budget → drop-off → load call → rest discipline. Deterministic, no AI, no persistence. The rules are new CALLERS of existing engine predicates, never new authors: `isCleanSet`/`isStrainedSet` ([session-grouping.ts](lib/coach/prescription/session-grouping.ts)), `nextUpKg`/`nextDownKg` ([double-progression-rule.ts](lib/coach/prescription/double-progression-rule.ts)), `brzycki`/`bestComparisonValue` ([e1rm.ts](lib/coach/e1rm.ts)), `tierOf`/`restPrescription`/`repsForExercise` ([session-structure/](lib/coach/session-structure/)). Context (180d PR window, 28d rule history, block phase, rir_target) is fetched once at logger open via [useLiveSessionContext](lib/query/hooks/useLiveSessionContext.ts) — no network in the hot path, so it survives a wifi drop. Only PRs fire the audio cue. Load calls are advisory with one-tap apply; nothing is written unless the athlete taps. Audit: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-live-session-rules.mjs`. Spec: [docs/superpowers/specs/2026-08-10-live-session-coaching-design.md](docs/superpowers/specs/2026-08-10-live-session-coaching-design.md).
```

Add to the **Scripts** section:

```markdown
- [scripts/audit-live-session-rules.mjs](scripts/audit-live-session-rules.mjs) — fixture-based pure-function audit for `lib/coach/live-session/` (silence default, grid agreement with nextUpKg/nextDownKg, frozen-phase behaviour, PR guards, never-throws). No DB access. 11 assertions.
```

- [ ] **Step 4: Final verification**

```bash
npm run typecheck
npx vitest run
npm run build
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-live-session-rules.mjs
```
Expected: all four clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit-live-session-rules.mjs CLAUDE.md
git commit -m "chore(live-session): fixture audit script and CLAUDE.md entry"
```

---

## Manual verification

Automated tests cannot cover the thing that matters most here: whether the line
is useful or merely annoying in a real gym session. After Task 8:

1. Open the logger on a training day.
2. Commit a set exactly on plan → **no line should appear.** If one does, the
   silence rule is broken and that is the highest-priority bug.
3. Commit a set with RIR 4 → a blue line with a tap target one grid step up.
4. Tap the number → it lands in the next set's kg field, and nowhere else.
5. Commit a set that beats your best → green line, plus buzz and beep.
6. Kill wifi mid-session → sets still commit; lines go quiet. Nothing breaks.
