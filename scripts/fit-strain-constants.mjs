// scripts/fit-strain-constants.mjs
//
// Grid-search A, k, w and mechanicalNorm against the frozen fixture, under the
// THREE-term form (baseline inside the load, not a constant). Prints the best
// fit and a per-day table; writing constants.ts is a manual step so the numbers
// are reviewed before they are frozen.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/fit-strain-constants.mjs

import { readFileSync } from "node:fs";
import { banisterOverIntervals } from "@/lib/coach/strain/trimp";
import { toHrSamples, activityWindow } from "@/lib/coach/strain/activity-load";
import { dedupeActivities } from "@/lib/coach/strain/match-sessions";
import { rawTonnage, combinedFactor } from "@/lib/coach/strain/mechanical-load";
import { brzycki } from "@/lib/coach/e1rm";

const fixture = JSON.parse(readFileSync("scripts/fixtures/strain-calibration-2026.json", "utf8"));
const HR_MAX = 183;

/** Per-day terms, computed once. mechanicalNorm is applied later so the search
 *  does not have to recompute the weighted sum for every candidate. */
const rows = fixture.map((f) => {
  const { kept } = dedupeActivities(f.activities);
  const excluded = [];
  let activity = 0;
  for (const a of kept) {
    const s = toHrSamples(a.hr_samples);
    if (s.length < 2) continue;
    activity += banisterOverIntervals(s, f.resting_hr, HR_MAX);
    excluded.push(activityWindow(a));
  }
  const baseline = banisterOverIntervals(
    toHrSamples(f.all_day_samples),
    f.resting_hr,
    HR_MAX,
    excluded,
  );
  const exercises = f.exercises.map((e) => ({ ...e, e1rm: bestE1rm(e.sets) }));
  let weighted = 0;
  for (const e of exercises) {
    for (const s of e.sets) {
      if (s.warmup) continue;
      const t = (s.kg ?? 0) * (s.reps ?? 0);
      if (!t) continue;
      // combinedFactor, NOT the three factors multiplied by hand: the runtime
      // clamps the PRODUCT, so re-deriving it here would fit mechanicalNorm
      // against a quantity mechanicalLoad never produces.
      weighted += t * combinedFactor(e.name, s.kg ?? 0, e.e1rm, s.rir, null);
    }
  }
  return { date: f.date, whoop: f.whoop_strain, baseline, activity, raw: rawTonnage(exercises), weighted };
});

// Canonical brzycki, same reason as the audit: the fit must resolve intensity
// exactly as production does, or mechanicalNorm is fitted against a quantity
// the runtime never produces.
function bestE1rm(sets) {
  let best = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps) continue;
    const v = brzycki(s.kg, s.reps);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

// mechanicalNorm restores the raw-tonnage scale the model is fitted against.
const rawSum = rows.reduce((s, r) => s + r.raw, 0);
const weightedSum = rows.reduce((s, r) => s + r.weighted, 0);
const mechanicalNorm = weightedSum > 0 ? rawSum / weightedSum : 1;
console.log(`mechanicalNorm = ${mechanicalNorm.toFixed(6)} (raw ${Math.round(rawSum)} / weighted ${Math.round(weightedSum)})`);

const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const geo = (a, b, n) => Array.from({ length: n }, (_, i) => a * (b / a) ** (i / (n - 1)));

let best = null;
for (const A of lin(1, 14, 53))
  for (const k of geo(0.001, 0.5, 40))
    for (const w of geo(0.0005, 0.05, 40)) {
      let se = 0;
      for (const r of rows) {
        const load = r.baseline + r.activity + w * r.weighted * mechanicalNorm;
        const pred = Math.min(21, A * Math.log(1 + k * load));
        se += (pred - r.whoop) ** 2;
      }
      const rmse = Math.sqrt(se / rows.length);
      if (!best || rmse < best.rmse) best = { A: +A.toFixed(3), k: +k.toFixed(5), w: +w.toFixed(6), rmse: +rmse.toFixed(3) };
    }

console.log("\nbest three-term fit:", best, `mechanicalNorm: ${mechanicalNorm.toFixed(6)}`);
console.log("\ndate       whoop  pred   baseline activity  tonnage");
for (const r of rows) {
  const load = r.baseline + r.activity + best.w * r.weighted * mechanicalNorm;
  const pred = Math.min(21, best.A * Math.log(1 + best.k * load));
  console.log(
    r.date,
    String(r.whoop.toFixed(2)).padStart(6),
    String(pred.toFixed(2)).padStart(6),
    String(r.baseline.toFixed(1)).padStart(8),
    String(r.activity.toFixed(1)).padStart(8),
    String(Math.round(r.raw)).padStart(8),
  );
}
