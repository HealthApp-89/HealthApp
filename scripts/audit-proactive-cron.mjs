#!/usr/bin/env node
// scripts/audit-proactive-cron.mjs
//
// Read-only exercise of the proactive cron pipeline against the live
// dev fixture. Runs the full compute (Sub-project #5's generateCoachTrends)
// and the orchestrator in dry-run mode — prints which triggers WOULD fire
// and the rendered card text. Does NOT insert into chat_messages.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const env = {};
for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const { data: profile } = await sb
  .from("profiles")
  .select("user_id")
  .order("created_at", { ascending: true })
  .limit(1)
  .single();
const userId = profile.user_id;
const today = new Date().toISOString().slice(0, 10);

const { generateCoachTrends } = await import("../lib/coach/trends/index.ts");
const { runProactiveChecks } = await import("../lib/coach/proactive/index.ts");

const trends = await generateCoachTrends({ supabase: sb, userId, today });
const result = await runProactiveChecks({ supabase: sb, userId, trends, dry_run: true });

console.log("=== TRENDS HEADLINE (for context) ===");
console.log(`  [${trends.headline.severity}] ${trends.headline.title}`);

console.log(`\n=== WOULD FIRE (${result.fired.length}) ===`);
for (const { event, card } of result.fired) {
  console.log(`  • [${event.trigger_type}] key=${event.trigger_key}`);
  console.log(`    "${card.headline}"`);
  console.log(`    ${card.body_md}`);
  console.log(`    → ${card.deep_link.label} ${card.deep_link.href}`);
}

console.log(`\n=== WOULD BE SUPPRESSED (${result.suppressed.length}) ===`);
for (const { event, reason } of result.suppressed) {
  console.log(`  • ${event.trigger_key}: ${reason}`);
}

console.log("\nNote: dry-run mode skips dedup lookup. Live cron suppresses by 7d window.");
