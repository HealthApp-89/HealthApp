// scripts/check-canonicalize.mjs
import { canonicalizeItemName } from "../lib/coach/nora-suggestions/canonicalize.ts";

const cases = [
  ["grilled chicken breast", "chicken breast"],
  ["Chicken Breast, Cooked", "chicken breast"],
  ["raw jasmine rice", "jasmine rice"],
  ["sliced cucumber", "cucumber"],
  ["smoked salmon fillet", "salmon fillet"],
  ["overnight oats", "overnight oats"],
];
let pass = 0, fail = 0;
for (const [input, expected] of cases) {
  const got = canonicalizeItemName(input);
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${input} → ${got} (expected ${expected})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
