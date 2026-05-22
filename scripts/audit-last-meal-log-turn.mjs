// scripts/audit-last-meal-log-turn.mjs
//
// Dump the last few chat_messages rows on Nora's thread so we can see what
// fired in the propose → approve → commit_meal_log sequence and where it
// stalled. Set AUDIT_USER_ID env var.

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var (a real user uuid).");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await sb
  .from("chat_messages")
  .select("id, role, speaker, thread, mode, kind, status, error, content, tool_calls, created_at")
  .eq("user_id", userId)
  .eq("thread", "nora")
  .order("created_at", { ascending: false })
  .limit(8);

if (error) {
  console.error("query failed:", error);
  process.exit(1);
}

for (const r of (rows ?? []).slice().reverse()) {
  console.log("─".repeat(80));
  console.log(`${r.created_at}  ${r.role.padEnd(9)} ${(r.speaker ?? "-").padEnd(6)} thread=${r.thread} mode=${r.mode} kind=${r.kind} status=${r.status}`);
  if (r.error) console.log(`  ERROR: ${r.error}`);
  const content = (r.content ?? "").slice(0, 200).replace(/\n/g, " ");
  console.log(`  content: ${content}${(r.content ?? "").length > 200 ? "…" : ""}`);
  if (Array.isArray(r.tool_calls) && r.tool_calls.length > 0) {
    console.log(`  tool_calls (${r.tool_calls.length}):`);
    for (const c of r.tool_calls) {
      const err = c.error ? ` ERROR=${c.error}` : "";
      const trunc = c.truncated ? " TRUNCATED" : "";
      console.log(`    - ${c.name}  ${c.ms}ms${err}${trunc}`);
      if (c.name === "propose_meal_log") {
        const items = c.result?.preview?.items?.length;
        console.log(`        preview.items=${items}, has approval_token=${Boolean(c.result?.approval_token)}`);
      }
      if (c.name === "commit_meal_log") {
        console.log(`        input.approval_token first 24: ${(c.input?.approval_token ?? "").slice(0, 24)}…`);
        if (c.result) {
          console.log(`        result entry_id=${c.result.entry_id}, item_count=${c.result.item_count}, day_totals=${JSON.stringify(c.result.day_totals)}`);
        }
      }
    }
  } else {
    console.log("  tool_calls: <none>");
  }
}

console.log("─".repeat(80));
