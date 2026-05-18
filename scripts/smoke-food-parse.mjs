#!/usr/bin/env node
// scripts/smoke-food-parse.mjs
//
// Hits the real Anthropic API. Asserts extraction shape + reasonable gram
// conversions for household units.
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/smoke-food-parse.mjs

import assert from "node:assert/strict";
import { extractItems } from "../lib/food/parse.ts";

const cases = [
  {
    input: "200g grilled chicken breast and 1 cup cooked white rice",
    expectCount: 2,
    checks: (items) => {
      const chicken = items.find((i) => /chicken/i.test(i.name));
      const rice = items.find((i) => /rice/i.test(i.name));
      assert.ok(chicken, "should extract chicken");
      assert.ok(rice, "should extract rice");
      assert.equal(chicken.qty_g, 200, "chicken should be 200g exactly");
      assert.ok(rice.qty_g >= 140 && rice.qty_g <= 180, `rice 1 cup should be ~158g, got ${rice.qty_g}`);
    },
  },
  {
    input: "oats with banana and peanut butter",
    expectCount: 3,
    checks: (items) => {
      // Just check 3 items came back, no quantity assertions.
      assert.equal(items.length, 3, `should extract 3 items, got ${items.length}`);
    },
  },
];

for (const c of cases) {
  console.log(`→ extractItems(${JSON.stringify(c.input)})`);
  const items = await extractItems(c.input);
  console.log("  items:", items);
  if (typeof c.expectCount === "number") {
    assert.ok(items.length >= 1, `should return at least 1 item`);
  }
  c.checks(items);
}

console.log("\n✓ smoke-food-parse passed");
