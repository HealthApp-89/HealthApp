// scripts/audit-live-session-rules.mjs
//
// Fixture-based audit for lib/coach/live-session/. Exercises evaluateSet with
// concrete inputs and asserts expected outputs. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-live-session-rules.mjs
//
// No DB access — pure functions only. Mirrors scripts/audit-prescription-rules.mjs.

import { evaluateSet } from "@/lib/coach/live-session";
import { nextUpKg, nextDownKg } from "@/lib/coach/prescription/double-progression-rule";
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();

// ── fixture builders ────────────────────────────────────────────────────────
//
// mkInput mirrors the shape LiveSetInput requires (lib/coach/live-session/types.ts):
// a committed ExerciseSetDraft, its ExerciseDraft (carrying `prescribed`), the
// full sessionSets list (this rule reads across the whole session for the
// failure-budget count), and the LiveSessionContext assembled once at logger
// open by lib/query/fetchers/liveSessionContext.ts.
//
// Default exercise is named after a real SESSION_PLANS entry, "Decline Bench
// Press (Barbell)" (fatigue tier 1 — lib/coach/session-structure/tiers.ts),
// but the numbers below are fixture-only and do NOT mirror the production
// entry (which prescribes baseReps: 8): baseKg 60, baseReps 10, sets 3, plain
// 2.5kg grid, chosen so the on-plan defaults below line up round. Default set
// is exactly on-plan (10 reps @ RIR 2, matching rirTarget 2) so any fixture
// that overrides only `set` starts from silence unless the override pushes it
// off-plan.

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
  const sets = over.sets ?? [set];
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
      sets,
    },
    sessionSets: sets.map((s) => ({ exerciseName: name, set: s })),
    context: {
      historyByExercise: {},
      bestByExercise: over.bestByExercise ?? {},
      blockPhase: over.blockPhase ?? "pre_target",
      rirTarget: 2,
    },
  };
}

console.log("\n## evaluateSet — silence is the default\n");

{
  assert(
    "on-plan set (reps hit, RIR at target) is silent",
    evaluateSet(mkInput({ set: { reps: 10, rir: 2 } })) === null,
  );
}

console.log("\n## evaluateSet — load calls land on the equipment grid\n");

{
  const upLine = evaluateSet(mkInput({ set: { reps: 10, rir: 4 } }));
  assert(
    "too-easy set (RIR 4, reps hit) steps up — apply_kg matches nextUpKg",
    upLine?.apply_kg === nextUpKg(60, { step: 2.5 }),
    `got ${JSON.stringify(upLine)}`,
  );
  assert("step-up line is tagged rule=load_call", upLine?.rule === "load_call");

  const downLine = evaluateSet(mkInput({ set: { reps: 6, rir: 0 } }));
  assert(
    "strained short set (RIR 0, reps short) steps down — apply_kg matches nextDownKg",
    downLine?.apply_kg === nextDownKg(60, { step: 2.5 }),
    `got ${JSON.stringify(downLine)}`,
  );
  assert("step-down line is tagged rule=load_call", downLine?.rule === "load_call");

  // Micro-pin grid (step + intermediate offset): nextUpKg/nextDownKg alternate
  // the offset and (step - offset) rather than a flat step. baseReps raised to
  // 15 so a 15-rep set at RIR 4 counts as both reps-hit and "easy".
  const microUp = evaluateSet(
    mkInput({
      set: { kg: 22, reps: 15, rir: 4 },
      prescribed: { baseReps: 15, increment: { step: 5, intermediate: 2.3 } },
    }),
  );
  assert(
    "micro-pin grid step up matches nextUpKg (22 -> 22.3, not a flat +5)",
    microUp?.apply_kg === nextUpKg(22, { step: 5, intermediate: 2.3 }),
    `got ${JSON.stringify(microUp)}`,
  );

  const microDown = evaluateSet(
    mkInput({
      set: { kg: 22.3, reps: 10, rir: 0 },
      prescribed: { baseReps: 15, increment: { step: 5, intermediate: 2.3 } },
    }),
  );
  assert(
    "micro-pin grid step down matches nextDownKg (22.3 -> 20)",
    microDown?.apply_kg === nextDownKg(22.3, { step: 5, intermediate: 2.3 }),
    `got ${JSON.stringify(microDown)}`,
  );
}

console.log("\n## evaluateSet — frozen block phases never name a load\n");

{
  // consolidation / off_pace freeze by block-phase rule; deload_week holds
  // load via the accessory rule's deload branch. ruleLoadCall must never
  // contradict any of the three by naming a number.
  for (const blockPhase of ["consolidation", "off_pace", "deload_week"]) {
    const line = evaluateSet(mkInput({ set: { reps: 10, rir: 4 }, blockPhase }));
    assert(
      `no load named during ${blockPhase} (still advises, but apply_kg is absent)`,
      line != null && line.apply_kg === undefined,
      `got ${JSON.stringify(line)}`,
    );
  }
}

console.log("\n## evaluateSet — PR priority and guards\n");

{
  // 100kg x 5 = 112.5 Brzycki e1RM, past a best of 105 and within the 1.15x
  // plausible-jump ceiling (120.75) -> PR fires and outranks the load call
  // this same set would otherwise trigger (RIR 4, reps short of baseReps 10).
  const prLine = evaluateSet(
    mkInput({
      set: { kg: 100, reps: 5, rir: 4 },
      bestByExercise: { "Decline Bench Press (Barbell)": 105 },
    }),
  );
  assert("PR beats the load call", prLine?.rule === "pr", `got ${JSON.stringify(prLine)}`);
  assert("PR line carries the audio cue", prLine?.cue === true);

  // Same shape but kg=300: e1RM 337.5 clears the best of 105 yet blows past
  // the 1.15x plausible-jump ceiling (120.75) -> suppressed as a mistyped
  // weight; falls through to the load call instead of firing a false PR.
  const suppressed = evaluateSet(
    mkInput({
      set: { kg: 300, reps: 5, rir: 4 },
      bestByExercise: { "Decline Bench Press (Barbell)": 105 },
    }),
  );
  assert(
    "implausible jump (>1.15x best) is suppressed, falls through to load_call",
    suppressed?.rule === "load_call",
    `got ${JSON.stringify(suppressed)}`,
  );

  // Same kg/reps/rir as the on-plan silence case, but with bestByExercise
  // empty (no PR window history at all). Reps hit exactly at RIR target ->
  // every other rule stays silent too, isolating "no history -> no PR" as a
  // true end-to-end null rather than merely rule !== "pr".
  const noHistory = evaluateSet(
    mkInput({ set: { kg: 100, reps: 10, rir: 2 }, bestByExercise: {} }),
  );
  assert(
    "no history in bestByExercise means no PR (and the rest of the set is on-plan, so total silence)",
    noHistory === null,
    `got ${JSON.stringify(noHistory)}`,
  );
}

console.log("\n## evaluateSet — never throws\n");

{
  let threw = false;
  let result;
  try {
    const broken = mkInput();
    broken.context = null;
    result = evaluateSet(broken);
  } catch {
    threw = true;
  }
  assert("evaluateSet never throws even with a corrupted context", threw === false);
  assert("a corrupted context degrades to silence, not a crash", result === null);
}

summary("audit-live-session-rules");
