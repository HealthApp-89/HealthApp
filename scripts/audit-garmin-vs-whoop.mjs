// Phase-1 parallel-run audit: day-by-day Garmin vs WHOOP comparison + a strain
// calibration fit (A, k for trimpToStrain so Garmin strain tracks WHOOP's).
// Set AUDIT_USER_ID. Read-only.
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-vs-whoop.mjs
import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID"); process.exit(1); }

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: gRows } = await sb
  .from("garmin_daily")
  .select("date, hrv, resting_hr, training_readiness, sleep_hours, strain, trimp_edwards, trimp_banister")
  .eq("user_id", userId)
  .order("date");

const { data: wRows } = await sb
  .from("daily_logs")
  .select("date, hrv, resting_hr, recovery, sleep_hours, strain")
  .eq("user_id", userId);

const wByDate = new Map((wRows ?? []).map((r) => [r.date, r]));

console.log("date        | HRV g/w     | RHR g/w   | rec g/w   | strain g/w  | edwTRIMP");
const pairs = []; // {whoopStrain, edwTrimp} for calibration
for (const g of gRows ?? []) {
  const w = wByDate.get(g.date);
  if (!w) continue;
  const f = (x) => (x == null ? "—" : (Math.round(x * 10) / 10).toString());
  console.log(
    `${g.date} | ${f(g.hrv)}/${f(w.hrv)}  | ${f(g.resting_hr)}/${f(w.resting_hr)} | ` +
    `${f(g.training_readiness)}/${f(w.recovery)} | ${f(g.strain)}/${f(w.strain)} | ${f(g.trimp_edwards)}`,
  );
  if (w.strain != null && g.trimp_edwards != null && g.trimp_edwards > 0) {
    pairs.push({ y: w.strain, trimp: g.trimp_edwards });
  }
}

// Calibrate A,k for strain = A·ln(1 + k·TRIMP) by a small grid search
// minimizing squared error vs WHOOP strain. Prints the best fit to paste into
// DEFAULT_STRAIN_CALIBRATION.
if (pairs.length >= 5) {
  let best = { A: 4.2, k: 0.05, err: Infinity };
  for (let A = 2; A <= 8; A += 0.2) {
    for (let k = 0.01; k <= 0.2; k += 0.005) {
      let err = 0;
      for (const p of pairs) {
        const pred = Math.min(21, A * Math.log(1 + k * p.trimp));
        err += (pred - p.y) ** 2;
      }
      if (err < best.err) best = { A: Math.round(A * 100) / 100, k: Math.round(k * 1000) / 1000, err };
    }
  }
  console.log(`\nStrain calibration best fit over ${pairs.length} days: A=${best.A}, k=${best.k} (RMSE ${Math.sqrt(best.err / pairs.length).toFixed(2)})`);
  console.log("→ paste into DEFAULT_STRAIN_CALIBRATION in lib/coach/garmin/derive-strain.ts");
} else {
  console.log(`\nNeed ≥5 overlapping days with WHOOP strain to calibrate (have ${pairs.length}).`);
}
