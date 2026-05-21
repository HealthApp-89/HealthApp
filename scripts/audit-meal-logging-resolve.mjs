// scripts/audit-meal-logging-resolve.mjs
//
// Regression audit for resolveItemMacros. Runs a fixed vocabulary covering
// known traps and prints per-item: source, name returned, per-100g macros,
// confidence. Set AUDIT_USER_ID env var (a real user id).
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-meal-logging-resolve.mjs

import { resolveItemMacros } from "@/lib/food/lookup";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var (a real user uuid).");
  process.exit(1);
}

const VOCAB = [
  // British spellings — should hit USDA via spelling fallback
  "omelette", "yoghurt", "courgette", "aubergine", "prawn",
  // Single-token foods — should hit USDA cleanly
  "chicken", "rice", "banana", "egg", "broccoli",
  // Brand-vs-generic — should ideally hit user library if saved
  "halloumi", "greek yogurt", "peanut butter",
  // Foods we expect LLM fallback for
  "m'semen", "tagine chicken", "harira",
];

for (const q of VOCAB) {
  try {
    const r = await resolveItemMacros(q, 100, userId);
    console.log(
      [
        q.padEnd(20),
        (r.db_ref?.source ?? "llm").padEnd(14),
        r.confidence?.padEnd(7) ?? "n/a    ",
        r.name.padEnd(45).slice(0, 45),
        `${Math.round(r.kcal)}kcal`,
        `${r.protein_g.toFixed(1)}P`,
        `${r.carbs_g.toFixed(1)}C`,
        `${r.fat_g.toFixed(1)}F`,
      ].join("  "),
    );
  } catch (e) {
    console.error(`${q}: FAIL — ${e.message}`);
  }
}
