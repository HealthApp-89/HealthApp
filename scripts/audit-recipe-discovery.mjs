// scripts/audit-recipe-discovery.mjs
//
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-recipe-discovery.mjs
//
// Dry-runs the Task 16/17 recipe-discovery pipeline against the target
// user's eating_identity_cache. Reports:
//   - Each frequent_combo with qualify markers (count ≥4, last_seen ≥14d).
//   - Rate-limit consumption (save_recipe:* rows in proactive_nudge_dedup
//     within the 30-day window).
//   - The pending winner (top-scored qualifying combo not already deduped),
//     or "Nothing qualifies right now" if filters exhaust the candidate set.

import { createClient } from "@supabase/supabase-js";
import {
  pickDiscoveryCandidate,
  comboSignature,
} from "../lib/coach/nora-suggestions/recipe-discovery.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID required");
  process.exit(1);
}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: prof } = await supabase
  .from("profiles")
  .select("eating_identity_cache")
  .eq("user_id", userId)
  .single();
if (!prof?.eating_identity_cache) {
  console.error("No eating_identity_cache. Run /api/coach/eating-identity/sync first.");
  process.exit(1);
}

const identity = prof.eating_identity_cache;
const today = new Date().toISOString().slice(0, 10);

console.log("\n=== Qualifying combos (raw, before dedup) ===");
const recencyCutoff = new Date(Date.now() - 14 * 86400_000)
  .toISOString()
  .slice(0, 10);
const combos = identity.frequent_combos ?? [];
if (combos.length === 0) {
  console.log("  (no frequent_combos in identity cache)");
}
for (const c of combos) {
  const qualifies = c.co_occurrence_count >= 4 && c.last_seen >= recencyCutoff;
  const sig = comboSignature(c.items);
  console.log(
    `  ${qualifies ? "✓" : "·"}  ${c.co_occurrence_count}×  sig=${sig}  ${c.items.join(" + ")}  (avg_slot=${c.avg_slot}, last=${c.last_seen})`,
  );
}

console.log("\n=== Rate-limit consumption (last 30d) ===");
const rateCutoff = new Date(Date.now() - 30 * 86400_000)
  .toISOString()
  .slice(0, 10);
const { data: rows } = await supabase
  .from("proactive_nudge_dedup")
  .select("trigger_key, fired_on")
  .eq("user_id", userId)
  .like("trigger_key", "save_recipe:%")
  .gte("fired_on", rateCutoff);
console.log(`Used ${rows?.length ?? 0} / 3 nudges in window`);
for (const r of rows ?? []) console.log(`  ${r.fired_on}  ${r.trigger_key}`);

console.log("\n=== Pending winner ===");
const cand = await pickDiscoveryCandidate({ supabase, userId, identity, today });
if (cand) {
  console.log(`Would fire: sig=${cand.combo_signature}`);
  console.log(`  name: ${cand.suggested_name}`);
  console.log(
    `  items: ${cand.items.map((i) => `${i.name} ${Math.round(i.qty_g)}g`).join(" + ")}`,
  );
  console.log(
    `  per_100g: ${Math.round(cand.per_100g.kcal)}kcal ${Math.round(cand.per_100g.protein_g)}P`,
  );
} else {
  console.log("Nothing qualifies right now.");
}
