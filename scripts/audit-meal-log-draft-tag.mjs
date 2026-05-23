// scripts/audit-meal-log-draft-tag.mjs
// Read-only audit: count meal_log rows with NULL draft_entry_id. After the
// route + client patches land, this should be 0 for new rows. Pre-patch
// rows may still be NULL — that's expected (one-shot cleanup deleted the
// committed ones; the rest stay).
//
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//        --experimental-strip-types --env-file=.env.local \
//        scripts/audit-meal-log-draft-tag.mjs

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var.");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const { data, error } = await supabase
  .from("chat_messages")
  .select("id, role, speaker, ui, draft_entry_id, created_at")
  .eq("user_id", userId)
  .eq("kind", "meal_log")
  .gte("created_at", since)
  .order("created_at", { ascending: false });

if (error) {
  console.error("query failed:", error);
  process.exit(1);
}

const total = data.length;
const untagged = data.filter((r) => r.draft_entry_id === null);

console.log(`meal_log rows in last 24h: ${total}`);
console.log(`untagged (draft_entry_id IS NULL): ${untagged.length}`);

if (untagged.length > 0) {
  console.log("\nUntagged rows (first 10):");
  for (const r of untagged.slice(0, 10)) {
    console.log(`  ${r.created_at}  ${r.role}/${r.speaker}  ui=${JSON.stringify(r.ui)}`);
  }
}
