#!/usr/bin/env node
// scripts/audit-direct-meal-log.mjs
//
// Read-only audit of Nora's confirm-gated meal-log flow.
//
// Walks the last 50 chat_messages bearing a propose_meal_log or
// commit_meal_log tool_call, pairs them by approval_token, and verifies that
// each successful commit produced a food_log_entries row + a measurable
// amount of library-buildup side effect.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        scripts/audit-direct-meal-log.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var to your user id");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const env = {};
for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await supabase
  .from("chat_messages")
  .select("id, created_at, tool_calls")
  .eq("user_id", userId)
  .not("tool_calls", "is", null)
  .order("created_at", { ascending: false })
  .limit(50);

if (error) {
  console.error("query failed:", error.message);
  process.exit(2);
}

const proposes = [];
const commits = [];
for (const r of rows ?? []) {
  for (const call of r.tool_calls ?? []) {
    if (call.name === "propose_meal_log" && call.result?.approval_token) {
      proposes.push({
        msgId: r.id,
        ts: r.created_at,
        token: call.result.approval_token,
        preview: call.result.preview,
      });
    } else if (
      call.name === "commit_meal_log" &&
      !call.error &&
      call.result?.entry_id
    ) {
      commits.push({
        msgId: r.id,
        ts: r.created_at,
        token: call.input?.approval_token,
        result: call.result,
      });
    }
  }
}

console.log(
  `Found ${proposes.length} propose_meal_log calls, ${commits.length} commit_meal_log successes`,
);
console.log();

const tokenToCommit = new Map(commits.map((c) => [c.token, c]));
let pairedCount = 0;
let totalLibraryBuildup = 0;

for (const p of proposes) {
  const c = tokenToCommit.get(p.token);
  if (!c) {
    const items = p.preview?.items?.length ?? 0;
    console.log(
      `✗ propose @ ${p.ts}: never committed (token=${p.token.slice(0, 12)}…, ${items} items)`,
    );
    continue;
  }
  pairedCount++;
  const newlySaved = c.result.saved_library_ids?.length ?? 0;
  totalLibraryBuildup += newlySaved;
  const items = p.preview?.items?.length ?? 0;
  const kcal = c.result.day_totals?.kcal ?? "?";
  console.log(
    `✓ ${p.ts} → ${c.ts} · ${items} items · ${newlySaved} new lib rows · day kcal=${kcal}`,
  );

  const { data: entry, error: entryErr } = await supabase
    .from("food_log_entries")
    .select("id, items, meal_slot")
    .eq("id", c.result.entry_id)
    .maybeSingle();
  if (entryErr || !entry) {
    console.log(
      `  ⚠ food_log_entries row ${c.result.entry_id} not found — possible delete or RLS issue`,
    );
  } else if ((entry.items?.length ?? 0) !== items) {
    console.log(
      `  ⚠ item-count mismatch: preview=${items}, row=${entry.items?.length}`,
    );
  }
}

console.log();
console.log(
  `Summary: ${pairedCount}/${proposes.length} proposes committed · ${totalLibraryBuildup} new user_food_items rows across the window`,
);
