// scripts/audit-endurance-pure.mjs — fixture-based audit for pure compute modules
// Run via: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
// No DB access. Asserts behavior of hr-zones / tss / training-load / compose-z2-base / interference.

import { derivedHrZones, bucketZones, defaultZ2Cap } from "@/lib/coach/endurance/hr-zones";
import { computeHrTss, computeTssForActivity } from "@/lib/coach/endurance/tss";

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

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
