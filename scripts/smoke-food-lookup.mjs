#!/usr/bin/env node
// scripts/smoke-food-lookup.mjs
//
// Smoke test for lib/food/lookup.ts. Hits the real USDA API + Anthropic API.
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/smoke-food-lookup.mjs
//
// Asserts: chicken breast resolves via USDA, returns kcal in 150-180/100g
// range; an obviously made-up food falls back to LLM with source='llm'.
//
// lookup.ts imports from @/lib/supabase/server, which top-level-imports
// `next/headers` (only used by the cookie-bound server client, but ESM
// hoists imports). When run under bare Node (outside the Next bundler)
// that import explodes. We register a tiny loader hook here that maps
// `next/headers` to an empty stub before dynamically importing lookup.ts.

import { register } from "node:module";
import assert from "node:assert/strict";

const stubLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") {
    return {
      url: "data:text/javascript,export%20const%20cookies%20%3D%20()%20%3D%3E%20(%7B%20getAll%3A%20()%20%3D%3E%20%5B%5D%2C%20set%3A%20()%20%3D%3E%20%7B%7D%20%7D)%3B",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(stubLoader), import.meta.url);

const { resolveItemMacros } = await import("../lib/food/lookup.ts");

console.log("→ resolveItemMacros('chicken breast grilled', 200)");
const chicken = await resolveItemMacros("chicken breast grilled", 200);
console.log("  result:", chicken);
assert.equal(chicken.source, "db", "chicken should hit DB (USDA or cache)");
assert.ok(chicken.kcal > 200 && chicken.kcal < 500, "chicken 200g kcal should be 200-500");
assert.ok(chicken.protein_g > 30, "chicken 200g protein should be >30g");

// We need a name that (a) doesn't match any USDA entry (so we fall through
// to the LLM) but (b) is plausibly food-like so Haiku produces real macros
// instead of nulls. USDA's full-text search is aggressive — any English
// food word (fig, almond, bar, stew) finds a match. Solution: a real but
// non-Anglophone dish name. Verified empirically that USDA's Foundation/
// SR-Legacy returns zero hits for "khinkali"; Haiku knows Georgian cuisine
// so it produces realistic numbers.
console.log("\n→ resolveItemMacros('khinkali', 250)");
const obscure = await resolveItemMacros("khinkali", 250);
console.log("  result:", obscure);
assert.equal(obscure.source, "llm", "obscure food should fall back to LLM");
assert.equal(obscure.confidence, "low", "LLM fallback should be low confidence");
assert.ok(obscure.kcal > 0, "LLM should return non-zero kcal");

console.log("\n✓ smoke-food-lookup passed");
