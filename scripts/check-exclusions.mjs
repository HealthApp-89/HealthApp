// scripts/check-exclusions.mjs
// Quick sanity check that exclusion predicates fire on obvious cases.

import { passesExclusions, violatedTags } from "../lib/coach/nora-suggestions/exclusions.ts";

const cases = [
  { name: "pork", input: [{ name: "pork shoulder" }], tags: ["pork"], expect: false },
  { name: "bacon→pork", input: [{ name: "bacon strips" }], tags: ["pork"], expect: false },
  { name: "chicken passes pork", input: [{ name: "chicken breast" }], tags: ["pork"], expect: true },
  { name: "shrimp→shellfish", input: [{ name: "garlic shrimp" }], tags: ["shellfish"], expect: false },
  { name: "salmon→fish", input: [{ name: "smoked salmon" }], tags: ["fish"], expect: false },
  { name: "tofu→soy", input: [{ name: "tofu cubes" }], tags: ["soy"], expect: false },
  { name: "rice passes all", input: [{ name: "jasmine rice" }], tags: ["pork", "shellfish", "fish", "soy"], expect: true },
  { name: "no tags = pass", input: [{ name: "anything" }], tags: [], expect: true },
  { name: "multi-item one violation", input: [{ name: "chicken" }, { name: "wine"}], tags: ["alcohol"], expect: false },
  // New cases for Fix 1 + Fix 2 + USDA path coverage.
  { name: "pepperoni→pork", input: [{ name: "pepperoni pizza" }], tags: ["pork"], expect: false },
  { name: "carnitas→pork", input: [{ name: "carnitas tacos" }], tags: ["pork"], expect: false },
  { name: "coconut milk passes dairy", input: [{ name: "coconut milk latte" }], tags: ["dairy"], expect: true },
  { name: "oat milk passes dairy", input: [{ name: "oat milk yogurt" }], tags: ["dairy"], expect: true },
  { name: "USDA pork category catches non-obvious name", input: [{ name: "fresh loin roast", usda_category: "Pork, Products" }], tags: ["pork"], expect: false },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = passesExclusions(c.input, c.tags);
  const ok = got === c.expect;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name} — got ${got}, expected ${c.expect}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`   violations:`, c.input.map((i) => ({ name: i.name, tags: violatedTags(i, c.tags) })));
  }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
