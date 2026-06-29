import { effortAdjustedE1rm, topSet, epley } from "@/lib/coach/derived.ts";

let pass = 0, fail = 0;
const eq = (a, b, msg) => {
  const ok = a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-6);
  if (ok) pass++; else { fail++; console.error(`FAIL: ${msg} — got ${a}, want ${b}`); };
};

// null rir collapses to raw epley
eq(effortAdjustedE1rm(100, 8, null), epley(100, 8), "rir=null === raw epley");
// 0 rir (to failure) also equals raw epley (reps + 0)
eq(effortAdjustedE1rm(100, 8, 0), epley(100, 8), "rir=0 === raw epley");
// 2 RIR at 10 reps => effective 12 reps
eq(effortAdjustedE1rm(67.5, 10, 2), epley(67.5, 12), "10 reps @2RIR === epley(67.5,12)");
// effective reps cap at 12 (beyond Brzycki/Epley valid window)
eq(effortAdjustedE1rm(67.5, 12, 3), epley(67.5, 12), "cap effective reps at 12");
// out-of-range base reps still null
eq(effortAdjustedE1rm(60, 13, 0), null, "reps>12 base => null");

// topSet exposes raw e1RM unchanged + effort + rir for the chosen top set
const ts = topSet([
  { kg: 67.5, reps: 10, duration_seconds: null, warmup: false, failure: false, rir: 2 },
]);
eq(ts.e1RM, epley(67.5, 10), "topSet.e1RM stays raw");
eq(ts.e1RM_effort, epley(67.5, 12), "topSet.e1RM_effort is rir-adjusted");
eq(ts.rir, 2, "topSet.rir carried");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
