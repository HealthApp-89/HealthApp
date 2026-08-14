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
import { STRAIN_CALIBRATION } from "@/lib/coach/strain/constants";
import { rawTonnage, mechanicalLoad } from "@/lib/coach/strain/mechanical-load";
import { brzycki } from "@/lib/coach/e1rm";
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();
const fixture = JSON.parse(readFileSync("scripts/fixtures/strain-calibration-2026.json", "utf8"));
const HR_MAX = 183;
const RMSE_CEILING = 1.45;

/** Per-band residual ceiling. An aggregate RMSE cannot see a model that is
 *  right on average and sloped across the range, which is exactly the defect
 *  the 2026-08-14 refit fixed: the old constants passed the 1.8 ceiling at
 *  1.508 while under-scoring every hard cardio day by 2.7. Bands are asserted
 *  separately so that failure mode is loud rather than averaged away.
 *
 *  The 6-9 and 9+ bands hold 2 and 3 days. That is thin, and it is all the
 *  labelled data that will ever exist — WHOOP is gone. The ceilings are set to
 *  catch a REGRESSION toward the old behaviour, not to certify those bands. */
const BAND_BIAS_CEILING = 2.0;

assert("fixture has the full labelled set", fixture.length >= 55);

// brzycki from lib/coach/e1rm.ts, NOT a local reimplementation. This is the
// regression gate for the strain model, and production resolves intensity
// through that same helper (recompute.ts -> bestSessionE1rm -> brzycki). A
// hand-rolled copy here would keep passing on stale math if brzycki ever
// changed — the gate would be blind to exactly the kind of drift it exists
// to catch.
function bestE1rm(sets) {
  let best = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps) continue;
    const v = brzycki(s.kg, s.reps);
    if (v !== null && (best === null || v > best)) best = v;
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
    hrRest: f.resting_hr_baseline ?? f.resting_hr,
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

// The two regressions that motivated the original fused-strain work.
const heavy = predictions.filter((p) => p.load.mechanical > 14_000);
assert("heavy sessions score above 13", heavy.length > 0 && heavy.every((p) => p.pred > 13));
const rest = predictions.filter((p) => p.load.mechanical === 0 && p.load.activity === 0);
assert("living days score above zero", rest.length > 0 && rest.every((p) => p.pred > 0));

// The regression that motivated the 2026-08-14 refit: the model must not be
// flat across the HR-only range. Lifting days are banded separately because
// their load arrives through a different term.
const band = (label, filter) => {
  const g = predictions.filter(filter);
  if (g.length === 0) return;
  const bias = g.reduce((s, p) => s + (p.pred - p.whoop), 0) / g.length;
  console.log(`  ${label.padEnd(26)} n=${String(g.length).padStart(2)}  bias ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}`);
  assert(
    `${label} bias ${bias.toFixed(2)} within ±${BAND_BIAS_CEILING}`,
    Math.abs(bias) <= BAND_BIAS_CEILING,
  );
};
const hrOnly = (p) => p.load.mechanical === 0;
console.log("\nper-band residual (pred − whoop):");
band("HR-only, whoop <6", (p) => hrOnly(p) && p.whoop < 6);
band("HR-only, whoop 6-9", (p) => hrOnly(p) && p.whoop >= 6 && p.whoop < 9);
band("HR-only, whoop 9+", (p) => hrOnly(p) && p.whoop >= 9);
band("lifting days", (p) => p.load.mechanical > 0);

// Ambient living must stay discounted relative to deliberate activity. This is
// the structural claim the refit rests on; without it the bands above can be
// satisfied by a curve that has quietly reverted to weighting them equally.
assert(
  "baseline load is weighted below activity load",
  STRAIN_CALIBRATION.baselineWeight > 0 && STRAIN_CALIBRATION.baselineWeight < 1,
);

summary();
