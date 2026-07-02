// scripts/audit-readiness-score.mjs
//
// Fixture-based audit for deriveReadiness (lib/ui/score.ts). No DB access.
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs

import { deriveReadiness, calcReadinessScore } from "@/lib/ui/score";
import { readinessLog } from "@/lib/morning/brief/assembler";

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const HRV_BASE = 33;

// 1. Today's real case: HRV 20.46 (62% of baseline), RHR 73, no sleep score,
//    perfect-ish feel 7. Recovery signals are red → floor forces ACTION (low).
{
  const r = deriveReadiness({
    log: { hrv: 20.46, resting_hr: 73, sleep_score: null, deep_sleep_hours: null,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("today red-recovery → band low", r.band === "low", `band=${r.band}`);
  assert("today recovery sub-score < 25", r.recoverySubScore !== null && r.recoverySubScore < 25, `sub=${r.recoverySubScore}`);
  assert("today feel preserved as 7", r.feel === 7, `feel=${r.feel}`);
}

// 2. Feel cannot rescue a red body: perfect 10 feel + red recovery still low.
{
  const r = deriveReadiness({
    log: { hrv: 20, resting_hr: 74, sleep_score: null, deep_sleep_hours: null,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 10 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("perfect feel + red recovery → band low", r.band === "low", `band=${r.band}`);
  assert("perfect feel + red recovery → composite < 50", r.score !== null && r.score < 50, `score=${r.score}`);
}

// 3. Lifestyle absent renormalizes over recovery+feel (score still computed).
{
  const r = deriveReadiness({
    log: { hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("lifestyle absent → score not null", r.score !== null, `score=${r.score}`);
  assert("good recovery + good feel → band high", r.band === "high", `band=${r.band}`);
}

// 4. Recovery required: no HRV/RHR/sleep → score null, neutral band, feel kept.
{
  const r = deriveReadiness({
    log: { hrv: null, resting_hr: null, sleep_score: null, deep_sleep_hours: null,
           protein_g: 150, calories_eaten: 1800, carbs_g: 120, steps: 6000, weight_kg: 103 },
    checkin: { readiness: 8 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("no recovery signal → score null", r.score === null, `score=${r.score}`);
  assert("no recovery signal → recoverySubScore null", r.recoverySubScore === null, `sub=${r.recoverySubScore}`);
  assert("no recovery signal → band moderate (neutral)", r.band === "moderate", `band=${r.band}`);
  assert("no recovery signal → feel still 8", r.feel === 8, `feel=${r.feel}`);
}

// 5. Moderate recovery caps a would-be-high day at moderate.
//    recovery sub in [25,40): HRV ratio ~0.75 (→25), RHR 60 (→50), sleep 60 (→50), deep 0.8 (→25)
{
  const r = deriveReadiness({
    log: { hrv: 24.75, resting_hr: 60, sleep_score: 60, deep_sleep_hours: 0.8,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 10 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("recovery sub in [25,40)", r.recoverySubScore !== null && r.recoverySubScore >= 25 && r.recoverySubScore < 40, `sub=${r.recoverySubScore}`);
  assert("moderate recovery caps high → moderate", r.band !== "high", `band=${r.band}`);
}

// 6. Back-compat: calcReadinessScore returns deriveReadiness(...).score
{
  const inputs = {
    log: { hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  };
  assert("calcReadinessScore == deriveReadiness().score",
    calcReadinessScore(inputs) === deriveReadiness(inputs).score);
}

// 7. Brief blend: readinessLog must keep TODAY's recovery and YESTERDAY's lifestyle.
//    todayLog has distinct recovery values AND large lifestyle values that must be ignored.
//    yesterdayLog has the lifestyle values that must win, but its recovery must be ignored.
{
  /** @type {any} */
  const todayLog = {
    hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
    steps: 99999, calories_eaten: 9999, protein_g: 999, carbs_g: 999,
    stress_avg: 90, weight_kg: 103,
  };
  /** @type {any} */
  const yesterdayLog = {
    hrv: 10, resting_hr: 90, sleep_score: 20, deep_sleep_hours: 0.2,
    steps: 6000, calories_eaten: 1900, protein_g: 150, carbs_g: 120,
    stress_avg: 20, weight_kg: 103,
  };
  const blended = readinessLog(/** @type {any} */({ todayLog, yesterdayLog }));

  // Recovery comes from today — NOT yesterday's degraded values.
  assert("blend: today's hrv kept (not yesterday's 10)",
    blended !== null && blended.hrv === 33, `hrv=${blended?.hrv}`);
  assert("blend: today's resting_hr kept (not yesterday's 90)",
    blended !== null && blended.resting_hr === 52, `resting_hr=${blended?.resting_hr}`);
  assert("blend: today's sleep_score kept (not yesterday's 20)",
    blended !== null && blended.sleep_score === 75, `sleep_score=${blended?.sleep_score}`);

  // Lifestyle comes from yesterday — NOT today's inflated sentinel values.
  assert("blend: yesterday's steps win (not today's 99999)",
    blended !== null && blended.steps === 6000, `steps=${blended?.steps}`);
  assert("blend: yesterday's calories_eaten win (not today's 9999)",
    blended !== null && blended.calories_eaten === 1900, `calories_eaten=${blended?.calories_eaten}`);
  assert("blend: yesterday's protein_g win (not today's 999)",
    blended !== null && blended.protein_g === 150, `protein_g=${blended?.protein_g}`);
  assert("blend: yesterday's carbs_g win (not today's 999)",
    blended !== null && blended.carbs_g === 120, `carbs_g=${blended?.carbs_g}`);
  assert("blend: yesterday's stress_avg wins (calm 20, not today's stressed 90)",
    blended !== null && blended.stress_avg === 20, `stress_avg=${blended?.stress_avg}`);

  // Null todayLog → null blend (no recovery anchor).
  const nullBlend = readinessLog(/** @type {any} */({ todayLog: null, yesterdayLog }));
  assert("blend: null todayLog → null", nullBlend === null, `nullBlend=${nullBlend}`);
}

// ── Stress term fixtures (Task 1) ────────────────────────────────────────────
// Baseline: good recovery day without stress_avg.
// Case #3 log reused: hrv=33, resting_hr=52, sleep_score=75, deep=1.6, feel=7.
const STRESS_BASE_INPUTS = {
  log: { hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
         protein_g: null, calories_eaten: null, carbs_g: null, steps: null,
         stress_avg: null, weight_kg: 103 },
  checkin: { readiness: 7 },
  hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
};
const baselineResult = deriveReadiness(STRESS_BASE_INPUTS);

// S1. calm stress lifts the score.
{
  const r = deriveReadiness({ ...STRESS_BASE_INPUTS,
    log: { ...STRESS_BASE_INPUTS.log, stress_avg: 25 } });
  assert("stress S1: calm (25) raises score above stress-absent baseline",
    r.score !== null && baselineResult.score !== null && r.score > baselineResult.score,
    `score=${r.score} vs baseline=${baselineResult.score}`);
}

// S2. high stress drags the score.
{
  const r = deriveReadiness({ ...STRESS_BASE_INPUTS,
    log: { ...STRESS_BASE_INPUTS.log, stress_avg: 75 } });
  assert("stress S2: high (75) lowers score below stress-absent baseline",
    r.score !== null && baselineResult.score !== null && r.score < baselineResult.score,
    `score=${r.score} vs baseline=${baselineResult.score}`);
}

// S4. red-recovery floor is untouched by calm stress.
//    Same log as case #1: hrv=20.46, resting_hr=73, no sleep, feel=7.
{
  const withoutStress = deriveReadiness({
    log: { hrv: 20.46, resting_hr: 73, sleep_score: null, deep_sleep_hours: null,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null,
           stress_avg: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  const withCalmStress = deriveReadiness({
    log: { hrv: 20.46, resting_hr: 73, sleep_score: null, deep_sleep_hours: null,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null,
           stress_avg: 20, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("stress S4a: red-recovery day with calm stress stays band low",
    withCalmStress.band === "low", `band=${withCalmStress.band}`);
  assert("stress S4b: recoverySubScore byte-identical with vs without stress_avg",
    withCalmStress.recoverySubScore === withoutStress.recoverySubScore,
    `withStress.recoverySubScore=${withCalmStress.recoverySubScore} vs without=${withoutStress.recoverySubScore}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
