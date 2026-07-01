// scripts/audit-readiness-score.mjs
//
// Fixture-based audit for deriveReadiness (lib/ui/score.ts). No DB access.
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs

import { deriveReadiness, calcReadinessScore } from "@/lib/ui/score";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
