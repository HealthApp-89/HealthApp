// scripts/audit-endurance-pure.mjs — fixture-based audit for pure compute modules
// Run via: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
// No DB access. Asserts behavior of hr-zones / tss / training-load / compose-z2-base / interference.

import { derivedHrZones, bucketZones, defaultZ2Cap } from "@/lib/coach/endurance/hr-zones";
import { computeHrTss, computeTssForActivity } from "@/lib/coach/endurance/tss";
import { computeTrainingLoad, computeRampRate } from "@/lib/coach/endurance/training-load";
import { composeZ2Base } from "@/lib/coach/endurance/compose-z2-base";
import { strengthVolumeAdjustment } from "@/lib/coach/interference/check-interference";

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ok  ${label}`); }
  else    { fail += 1; console.error(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
}

console.log("── hr-zones ──");
// Threshold HR 160 → Coggan boundaries
check("derivedHrZones(160).z2", derivedHrZones(160).z2, [130, 142]);
check("derivedHrZones(160).z4", derivedHrZones(160).z4, [150, 168]);
check("defaultZ2Cap(160)", defaultZ2Cap(160), 142);

// Sample HR stream: 60 samples at 135 (Z2), 60 at 100 (Z1), 60 at 155 (Z4)
const stream = [
  ...Array(60).fill(135),
  ...Array(60).fill(100),
  ...Array(60).fill(155),
];
check("bucketZones split", bucketZones(stream, 160), { z1_s: 60, z2_s: 60, z3_s: 0, z4_s: 60, z5_s: 0 });

// Edge: 0 and negative samples dropped (only 120 → Z1 and 135 → Z2 should count)
check("bucketZones drops invalid", bucketZones([0, -1, 120, 135], 160), { z1_s: 1, z2_s: 1, z3_s: 0, z4_s: 0, z5_s: 0 });

// Boundary coverage: defaultZ2Cap returns 142 at LTHR=160 AND 142 must NOT land in Z2.
check("bucketZones boundary 142 lands in Z3", bucketZones([142], 160), { z1_s: 0, z2_s: 0, z3_s: 1, z4_s: 0, z5_s: 0 });

console.log("\n── tss ──");
// 1h @ threshold = 100
check("1h @ LTHR = 100 TSS", computeHrTss(3600, 160, 160), 100);
// 1h @ 80% = 64
check("1h @ 80% LTHR = 64 TSS", computeHrTss(3600, 128, 160), 64);
// 60min @ 132 vs LTHR 162 (user's Phase 1 numbers from snapshot example)
check("60min @ 132 vs LTHR 162", computeHrTss(3600, 132, 162), 66.4);
// 0-duration safety
check("zero duration → 0", computeHrTss(0, 130, 160), 0);

// Resolution chain — HR branch
check("chain: hr branch",
  computeTssForActivity({ durationS: 3600, avgHr: 132, thresholdHr: 162 }),
  66.4);
// Resolution chain — null when neither available
check("chain: null when uncalibrated",
  computeTssForActivity({ durationS: 3600, avgHr: null, thresholdHr: null }),
  null);
// Resolution chain — power preferred when present
check("chain: power preferred",
  computeTssForActivity({ durationS: 3600, avgHr: 132, thresholdHr: 162, avgPowerW: 200, ftpWatts: 250 }),
  64);

console.log("\n── training-load ──");
// Empty series → all zero
check("empty → zero", computeTrainingLoad([]), { ctl: 0, atl: 0, tsb: 0 });

// 60 days of 50 TSS/day → steady state, CTL ≈ ATL ≈ 50, TSB ≈ 0
const steady = Array(60).fill(50);
const sl = computeTrainingLoad(steady);
check("steady-state CTL near 50", Math.abs(sl.ctl - 50) < 1, true);
check("steady-state ATL near 50", Math.abs(sl.atl - 50) < 1, true);
check("steady-state TSB near 0",  Math.abs(sl.tsb) < 1, true);

// Spike: 60d at 30 then 7d at 100 — ATL > CTL, TSB negative
const spike = [...Array(60).fill(30), ...Array(7).fill(100)];
const sp = computeTrainingLoad(spike);
check("spike: atl > ctl", sp.atl > sp.ctl, true);
check("spike: tsb negative", sp.tsb < 0, true);

console.log("\n── compose-z2-base ──");
const profile1h = {
  discipline: "cycling",
  phase: "aerobic_base",
  threshold_hr: 162,
  hr_max: null, hr_zones: null, ftp_watts: null, threshold_pace_s_per_km: null,
  weekly_volume_target_hours: 1,
  current_race: null,
  set_at: "2026-05-30T00:00:00Z",
};
const r1 = composeZ2Base({ profile: profile1h });
check("1h target → ok",         r1.ok, true);
check("1h target → 1 session",  r1.ok && Object.keys(r1.plan).length, 1);
check("1h target → 60min",      r1.ok && r1.plan[3]?.duration_min, 60);
check("1h target → hr_cap 144", r1.ok && r1.plan[3]?.hr_cap, 144);

const profile4h = { ...profile1h, weekly_volume_target_hours: 4 };
const r4 = composeZ2Base({ profile: profile4h });
check("4h target → 4 sessions", r4.ok && Object.keys(r4.plan).length, 4);

// Discipline guard
const profileRun = { ...profile1h, discipline: "running" };
const rr = composeZ2Base({ profile: profileRun });
check("running → not implemented", rr.ok, false);

// Phase guard
const profileBuild = { ...profile1h, phase: "build" };
const rb = composeZ2Base({ profile: profileBuild });
check("build → not implemented", rb.ok, false);

console.log("\n── interference ──");
check("null profile → none",
  strengthVolumeAdjustment(null, 5).adjustment, "none");
check("aerobic_base + 1h → none",
  strengthVolumeAdjustment(profile1h, 1).adjustment, "none");
check("build + 10h → reduce_15pct",
  strengthVolumeAdjustment(profileBuild, 10).adjustment, "reduce_15pct");

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
