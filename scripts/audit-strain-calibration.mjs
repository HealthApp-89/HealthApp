// scripts/audit-strain-calibration.mjs
//
// Replays the frozen calibration fixture through the live composer and asserts
// the model still reproduces WHOOP's labelled days. THE regression gate for the
// strain model: touching constants.ts, compose.ts, or the mechanical weighting
// without re-running the fit will fail here.
//
// No DB access — fixture only.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-strain-calibration.mjs

import { readFileSync } from "node:fs";
import { assembleDay } from "@/lib/coach/strain";
import { rawTonnage, mechanicalLoad } from "@/lib/coach/strain/mechanical-load";
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();
const fixture = JSON.parse(readFileSync("scripts/fixtures/strain-calibration-2026.json", "utf8"));
const HR_MAX = 183;
const RMSE_CEILING = 1.8;

assert("fixture has the full labelled set", fixture.length >= 55);

function bestE1rm(sets) {
  let best = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps || s.reps < 1 || s.reps > 12) continue;
    const v = s.kg / (1.0278 - 0.0278 * s.reps);
    if (best === null || v > best) best = v;
  }
  return best;
}

let se = 0;
let worst = { date: null, err: 0 };
const predictions = [];
for (const f of fixture) {
  const exercises = f.exercises.map((e) => ({ ...e, e1rm: bestE1rm(e.sets) }));
  const startMs = Date.parse(`${f.date}T00:00:00Z`);
  const r = assembleDay({
    allDaySamples: (f.all_day_samples ?? []).map(([ts, bpm]) => ({ ts, bpm })),
    activities: f.activities,
    workouts: exercises.length ? [{ workout_id: f.date, startMs, endMs: startMs + 86_400_000, exercises }] : [],
    hrRest: f.resting_hr,
    hrMax: HR_MAX,
    rirTarget: null,
  });
  const err = r.strain - f.whoop_strain;
  se += err ** 2;
  if (Math.abs(err) > Math.abs(worst.err)) worst = { date: f.date, err };
  predictions.push({ date: f.date, whoop: f.whoop_strain, pred: r.strain, load: r.load });
}
const rmse = Math.sqrt(se / fixture.length);

console.log(`RMSE ${rmse.toFixed(3)} over ${fixture.length} labelled days`);
console.log(`worst residual: ${worst.date} ${worst.err > 0 ? "+" : ""}${worst.err.toFixed(2)}`);
assert(`RMSE ${rmse.toFixed(3)} within ceiling ${RMSE_CEILING}`, rmse <= RMSE_CEILING);

// Scale preservation: the mechanical refinements must redistribute, not rescale.
let rawSum = 0;
let loadSum = 0;
for (const f of fixture) {
  const exercises = f.exercises.map((e) => ({ ...e, e1rm: bestE1rm(e.sets) }));
  rawSum += rawTonnage(exercises);
  loadSum += mechanicalLoad(exercises, null);
}
const ratio = rawSum > 0 ? loadSum / rawSum : 1;
console.log(`mechanical scale ratio: ${ratio.toFixed(4)}`);
assert("mechanical weighting preserves the aggregate tonnage scale", Math.abs(ratio - 1) < 0.02);

// The two regressions that motivated the work.
const heavy = predictions.filter((p) => p.load.mechanical > 14_000);
assert("heavy sessions score above 13", heavy.length > 0 && heavy.every((p) => p.pred > 13));
const rest = predictions.filter((p) => p.load.mechanical === 0 && p.load.activity === 0);
assert("living days score above zero", rest.length > 0 && rest.every((p) => p.pred > 0));

summary();
