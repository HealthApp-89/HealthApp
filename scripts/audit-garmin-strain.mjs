// Fixture-based audit for lib/coach/garmin/derive-strain.ts and
// lib/coach/garmin/map-metrics.ts. No DB access.
// Run: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs
import {
  hrZone,
  edwardsTrimp,
  banisterTrimp,
  trimpToStrain,
  DEFAULT_STRAIN_CALIBRATION,
} from "@/lib/coach/garmin/derive-strain";
import { mapToDailyLogs, mapMovementEnergy, mapGarminWellness } from "@/lib/coach/garmin/map-metrics";

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error("FAIL:", name); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// hrZone: half-open bands on %HRmax. hrMax=200 → Z1 100-119, Z2 120-139,
// Z3 140-159, Z4 160-179, Z5 180+. Below 100 (50%) = zone 0.
assert("zone below Z1", hrZone(90, 200) === 0);
assert("zone Z1 lower edge", hrZone(100, 200) === 1);
assert("zone Z2", hrZone(130, 200) === 2);
assert("zone Z3", hrZone(150, 200) === 3);
assert("zone Z4", hrZone(170, 200) === 4);
assert("zone Z5 lower edge", hrZone(180, 200) === 5);
assert("zone Z5 above max", hrZone(210, 200) === 5);

// Edwards TRIMP: each sample = 2 min (inferred from 2-min spacing) × zone weight.
// Three samples 2 min apart, all in Z3 (weight 3) → 3 samples, but the last
// sample has no following delta so it uses the median spacing (2 min).
const z3samples = [
  { ts: 0, bpm: 150 },
  { ts: 120_000, bpm: 150 },
  { ts: 240_000, bpm: 150 },
];
// 3 samples × 2 min × weight 3 = 18
assert("edwards all-Z3", approx(edwardsTrimp(z3samples, 200), 18));

// Zone-0 samples contribute nothing.
const restSamples = [
  { ts: 0, bpm: 60 },
  { ts: 120_000, bpm: 60 },
];
assert("edwards rest = 0", approx(edwardsTrimp(restSamples, 200), 0));

// Banister (men's): per sample duration(min) × HRr × 0.64·e^(1.92·HRr),
// HRr=(bpm-rest)/(max-rest). One 2-min sample at bpm=150, rest=50, max=200:
// HRr=0.6667; y=0.64·e^(1.28)=0.64·3.5966=2.3018; TRIMP=2·0.6667·2.3018=3.069
assert(
  "banister single sample",
  approx(banisterTrimp([{ ts: 0, bpm: 150 }, { ts: 120_000, bpm: 150 }], 50, 200), 2 * (100 / 150) * (0.64 * Math.exp(1.92 * (100 / 150))), 1e-3),
);

// trimpToStrain: saturating log, bounded at 21, monotonic, 0→0.
assert("strain at 0 trimp", approx(trimpToStrain(0), 0));
assert("strain bounded at 21", trimpToStrain(1e9) <= 21);
assert("strain monotonic", trimpToStrain(50) < trimpToStrain(150));
assert(
  "strain uses default cal",
  approx(trimpToStrain(100), Math.min(21, DEFAULT_STRAIN_CALIBRATION.A * Math.log(1 + DEFAULT_STRAIN_CALIBRATION.k * 100))),
);

// ── map-metrics: mapToDailyLogs ───────────────────────────────────────────────
const mapped = mapToDailyLogs(
  {
    date: "2026-07-01",
    hrv: 68,
    resting_hr: 52,
    training_readiness: 74,
    sleep_hours: 7.4,
    sleep_score: 81,
    steps: 8421.6,        // sidecar may send float; column is int
    distance_km: 6.2,
    calories: 2480.9,
    active_calories: 612.4,
    respiratory_rate: 14.2,
  },
  12.5,
);
assert("map recovery = readiness", mapped.recovery === 74);
assert("map strain passthrough", mapped.strain === 12.5);
assert("map steps rounded int", mapped.steps === 8422);
assert("map calories rounded int", mapped.calories === 2481);
assert("map active_calories rounded int", mapped.active_calories === 612);
assert("map source tag", mapped.source === "garmin");
assert("map keeps user/date keys", mapped.date === "2026-07-01");
// Absent fields must not appear as null keys that would clobber other sources.
assert("map omits absent spo2", !("spo2" in mapped));

// ── map-metrics: mapMovementEnergy (partial movement/energy cluster) ──────────
const me = mapMovementEnergy(
  { date: "2026-07-01", steps: 8421.6, distance_km: 6.2, calories: 2480.9, active_calories: 612.4,
    hrv: 68, recovery: 74, sleep_hours: 7.4 },
  12.5,
);
assert("me strain passthrough", me.strain === 12.5);
assert("me steps rounded int", me.steps === 8422);
assert("me calories rounded int", me.calories === 2481);
assert("me active_calories rounded int", me.active_calories === 612);
assert("me distance passthrough", me.distance_km === 6.2);
assert("me keeps date", me.date === "2026-07-01");
// Single-owner cluster: NO source key (preserve co-owner's tag).
assert("me omits source", !("source" in me));
// Must NOT carry recovery/hrv/sleep columns.
assert("me omits recovery", !("recovery" in me));
assert("me omits hrv", !("hrv" in me));
assert("me omits sleep_hours", !("sleep_hours" in me));
// Absent metric → null (present key, homogeneous payload), not omitted.
const meEmpty = mapMovementEnergy({ date: "2026-07-02" }, null);
assert("me absent steps = null", meEmpty.steps === null);
assert("me absent strain = null", meEmpty.strain === null);
assert("me absent key present", "calories" in meEmpty);

// ── map-metrics: mapGarminWellness (Body Battery + Stress cluster) ────────────
const gw = mapGarminWellness({
  date: "2026-07-01", body_battery_low: 24.4, body_battery_peak: 82,
  stress_avg: 24, stress_max: 98, stress_qualifier: "BALANCED",
  hrv: 68, steps: 8000,
});
assert("gw bb_low int", gw.body_battery_low === 24);
assert("gw bb_peak", gw.body_battery_peak === 82);
assert("gw stress_avg", gw.stress_avg === 24);
assert("gw stress_max", gw.stress_max === 98);
assert("gw qualifier passthrough", gw.stress_qualifier === "BALANCED");
assert("gw keeps date", gw.date === "2026-07-01");
assert("gw omits source", !("source" in gw));
assert("gw omits non-wellness (hrv)", !("hrv" in gw));
const gwEmpty = mapGarminWellness({ date: "2026-07-02" });
assert("gw absent bb = null", gwEmpty.body_battery_peak === null);
assert("gw absent stress = null", gwEmpty.stress_avg === null);
assert("gw absent qualifier = null", gwEmpty.stress_qualifier === null);
assert("gw absent key present", "stress_max" in gwEmpty);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
