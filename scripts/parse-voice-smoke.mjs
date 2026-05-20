// Run: node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/parse-voice-smoke.mjs
//
// No test framework — just assertion smoke. Prints PASS/FAIL per case.

import { parseVoiceSet } from "@/lib/logger/parse-voice";

const cases = [
  ["60 kg 8 reps", { kg: 60, reps: 8 }],
  ["60 8", { kg: 60, reps: 8 }],
  ["sixty 8", null], // word-form: regex skips, LLM handles
  ["bodyweight 12 reps", { kg: null, reps: 12 }],
  ["8 reps at 60", { kg: 60, reps: 8 }],
  ["135 lbs 5 reps", { kg: 61.5, reps: 5 }],
  ["100 kilos 6", { kg: 100, reps: 6 }],
  ["nothing here", null],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const got = parseVoiceSet(input);
  const eq = JSON.stringify(got) === JSON.stringify(expected);
  if (eq) {
    pass++;
    console.log(`PASS: "${input}" → ${JSON.stringify(got)}`);
  } else {
    fail++;
    console.log(`FAIL: "${input}" → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail === 0 ? 0 : 1);
