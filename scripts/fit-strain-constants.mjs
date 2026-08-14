// scripts/fit-strain-constants.mjs
//
// Fit A, k, baselineWeight, w and mechanicalNorm against the frozen fixture.
// Prints the best fit, the leave-one-out score, the per-band residuals and a
// per-day table. Writing constants.ts stays a manual step so the numbers are
// reviewed before they are frozen.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/fit-strain-constants.mjs
//
// Two things about the method, both learned the hard way on 2026-08-14:
//
// 1. SELECT ON LEAVE-ONE-OUT, NOT IN-SAMPLE RMSE. Only 5 of the 61 labelled
//    days are HR-only days above WHOOP 6. In-sample error barely notices them,
//    so it happily buys a richer form that fits those 5 and generalises worse:
//    adding a superlinear HR exponent scored 1.280 in-sample against this
//    form's 1.313, and 1.509 under LOO against this form's 1.406.
//
// 2. FIT THE THREE COEFFICIENTS DIRECTLY. The published form
//    A·ln(1 + k·(bw·baseline + activity + w·mechanical)) expands to
//    A·ln(1 + (k·bw)·baseline + k·activity + (k·w)·mechanical) — three free
//    coefficients, not four. Searching (k, bw, w) as written wastes a whole
//    grid dimension on a redundancy and pins optima against axis ends. Search
//    (kb, ka, km); convert at the end.
//
// A enters linearly (strain = A·g), so for any candidate the optimal A has a
// closed form. That is what makes 61 LOO folds O(1) each instead of 61 refits.

import { readFileSync } from "node:fs";
import { banisterOverIntervals } from "@/lib/coach/strain/trimp";
import { toHrSamples, activityWindow } from "@/lib/coach/strain/activity-load";
import { dedupeActivities } from "@/lib/coach/strain/match-sessions";
import { rawTonnage, combinedFactor } from "@/lib/coach/strain/mechanical-load";
import { brzycki } from "@/lib/coach/e1rm";

const fixture = JSON.parse(readFileSync("scripts/fixtures/strain-calibration-2026.json", "utf8"));
const HR_MAX = 183;

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

/** Per-day terms, computed once. mechanicalNorm is applied later so the search
 *  does not have to recompute the weighted sum for every candidate. */
const rows = fixture.map((f) => {
  const { kept } = dedupeActivities(f.activities);
  const excluded = [];
  let activity = 0;
  for (const a of kept) {
    const s = toHrSamples(a.hr_samples);
    if (s.length < 2) continue;
    activity += banisterOverIntervals(s, f.resting_hr_baseline ?? f.resting_hr, HR_MAX);
    excluded.push(activityWindow(a));
  }
  const baseline = banisterOverIntervals(
    toHrSamples(f.all_day_samples),
    f.resting_hr_baseline ?? f.resting_hr,
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

// mechanicalNorm restores the raw-tonnage scale the model is fitted against.
// A property of the fixture's tonnage, independent of the curve.
const rawSum = rows.reduce((s, r) => s + r.raw, 0);
const weightedSum = rows.reduce((s, r) => s + r.weighted, 0);
const mechanicalNorm = weightedSum > 0 ? rawSum / weightedSum : 1;
console.log(`mechanicalNorm = ${mechanicalNorm.toFixed(6)} (raw ${Math.round(rawSum)} / weighted ${Math.round(weightedSum)})`);
for (const r of rows) r.mech = r.weighted * mechanicalNorm;

const n = rows.length;
const S3 = rows.reduce((s, r) => s + r.whoop * r.whoop, 0);
const geo = (a, b, count) => Array.from({ length: count }, (_, i) => a * (b / a) ** (i / (count - 1)));

/** Sum of squared error at (kb, ka, km), with A eliminated in closed form.
 *  Returns the loss and the implied A. */
function fitAt(kb, ka, km) {
  let S1 = 0;
  let S2 = 0;
  for (const r of rows) {
    const g = Math.log(1 + kb * r.baseline + ka * r.activity + km * r.mech);
    S1 += r.whoop * g;
    S2 += g * g;
  }
  if (!(S2 > 0)) return { loss: Infinity, A: 0 };
  const A = S1 / S2;
  return { loss: A * A * S2 - 2 * A * S1 + S3, A };
}

// Coarse grid to bracket the optimum, then Nelder-Mead in log-space to refine.
// The grid alone lands on whichever gridpoint is nearest; the constants get
// frozen into the app, so they are worth converging properly.
const KB = geo(1e-5, 0.5, 60);
const KA = geo(1e-4, 1.0, 60);
const KM = geo(1e-5, 0.1, 50);
let seed = null;
for (const kb of KB)
  for (const ka of KA)
    for (const km of KM) {
      const { loss } = fitAt(kb, ka, km);
      if (!seed || loss < seed.loss) seed = { loss, kb, ka, km };
    }
console.log(`grid seed: kb=${seed.kb.toPrecision(4)} ka=${seed.ka.toPrecision(4)} km=${seed.km.toPrecision(4)} rmse=${Math.sqrt(seed.loss / n).toFixed(4)}`);

const lossOf = ([lb, la, lm]) => fitAt(Math.exp(lb), Math.exp(la), Math.exp(lm)).loss;
let simplex = [[Math.log(seed.kb), Math.log(seed.ka), Math.log(seed.km)]];
for (let i = 0; i < 3; i++) {
  const p = [...simplex[0]];
  p[i] += 0.25;
  simplex.push(p);
}
let fs = simplex.map(lossOf);
for (let it = 0; it < 8000; it++) {
  const ord = [0, 1, 2, 3].sort((a, b) => fs[a] - fs[b]);
  simplex = ord.map((i) => simplex[i]);
  fs = ord.map((i) => fs[i]);
  const c = [0, 1, 2].map((d) => (simplex[0][d] + simplex[1][d] + simplex[2][d]) / 3);
  const refl = c.map((v, d) => v + (v - simplex[3][d]));
  const fr = lossOf(refl);
  if (fr < fs[0]) {
    const ext = c.map((v, d) => v + 2 * (v - simplex[3][d]));
    const fe = lossOf(ext);
    if (fe < fr) { simplex[3] = ext; fs[3] = fe; } else { simplex[3] = refl; fs[3] = fr; }
  } else if (fr < fs[2]) {
    simplex[3] = refl; fs[3] = fr;
  } else {
    const con = c.map((v, d) => v + 0.5 * (simplex[3][d] - v));
    const fc = lossOf(con);
    if (fc < fs[3]) { simplex[3] = con; fs[3] = fc; }
    else for (let i = 1; i < 4; i++) {
      simplex[i] = simplex[i].map((v, d) => simplex[0][d] + 0.5 * (v - simplex[0][d]));
      fs[i] = lossOf(simplex[i]);
    }
  }
}
const bestIdx = [0, 1, 2, 3].sort((a, b) => fs[a] - fs[b])[0];
const [kb, ka, km] = simplex[bestIdx].map(Math.exp);
const { A, loss } = fitAt(kb, ka, km);
const rmse = Math.sqrt(loss / n);

// Leave-one-out over the coarse grid. Refitting the simplex 61 times would be
// the purer thing; the grid is enough to compare FORMS, which is all LOO is
// for here, and it keeps this script a few seconds rather than a few minutes.
const bestFold = rows.map(() => ({ loss: Infinity, pred: 0 }));
for (const gkb of KB)
  for (const gka of KA)
    for (const gkm of KM) {
      let S1 = 0;
      let S2 = 0;
      const g = [];
      for (const r of rows) {
        const gi = Math.log(1 + gkb * r.baseline + gka * r.activity + gkm * r.mech);
        g.push(gi);
        S1 += r.whoop * gi;
        S2 += gi * gi;
      }
      for (let i = 0; i < n; i++) {
        const s2 = S2 - g[i] * g[i];
        if (!(s2 > 0)) continue;
        const s1 = S1 - rows[i].whoop * g[i];
        const a = s1 / s2;
        const l = a * a * s2 - 2 * a * s1 + (S3 - rows[i].whoop * rows[i].whoop);
        if (l < bestFold[i].loss) bestFold[i] = { loss: l, pred: a * g[i] };
      }
    }
const loo = Math.sqrt(rows.reduce((s, r, i) => s + (bestFold[i].pred - r.whoop) ** 2, 0) / n);

console.log(`\nbest fit  RMSE ${rmse.toFixed(4)}   LOO ${loo.toFixed(4)}`);
console.log("constants.ts shape:");
console.log(`  A: ${A.toFixed(4)},`);
console.log(`  k: ${ka.toPrecision(6)},`);
console.log(`  baselineWeight: ${(kb / ka).toPrecision(6)},`);
console.log(`  w: ${(km / ka).toPrecision(6)},`);
console.log(`  mechanicalNorm: ${mechanicalNorm.toFixed(6)},`);

const pred = (r) => Math.min(21, A * Math.log(1 + kb * r.baseline + ka * r.activity + km * r.mech));

console.log("\nresidual by band (the check that motivated the 2026-08-14 refit):");
const bands = [
  ["HR-only, whoop <6 ", (r) => r.raw === 0 && r.whoop < 6],
  ["HR-only, whoop 6-9", (r) => r.raw === 0 && r.whoop >= 6 && r.whoop < 9],
  ["HR-only, whoop 9+ ", (r) => r.raw === 0 && r.whoop >= 9],
  ["lifting days      ", (r) => r.raw > 0],
];
for (const [label, f] of bands) {
  const g = rows.filter(f);
  if (!g.length) continue;
  const bias = g.reduce((s, r) => s + (pred(r) - r.whoop), 0) / g.length;
  console.log(`  ${label}  n=${String(g.length).padStart(2)}  bias ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}`);
}

console.log("\ndate       whoop  pred    err  baseline activity  tonnage");
for (const r of rows) {
  console.log(
    r.date,
    String(r.whoop.toFixed(2)).padStart(6),
    String(pred(r).toFixed(2)).padStart(6),
    String((pred(r) - r.whoop).toFixed(2)).padStart(6),
    String(r.baseline.toFixed(1)).padStart(8),
    String(r.activity.toFixed(1)).padStart(8),
    String(Math.round(r.raw)).padStart(8),
  );
}
