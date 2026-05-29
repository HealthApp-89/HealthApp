// scripts/regen-dashboard.mjs
//
// Regenerate today's Peter dashboard at version = max+1 using the new block-
// focus-aware Performance composer + tightened performance-goal cluster rule.

import { createClient } from "@supabase/supabase-js";
import { generatePeterDashboard } from "@/lib/coach/peter-dashboard";
import { renderInjectionBlock } from "@/lib/coach/peter-dashboard/render-injection";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

const { data: profile, error: pErr } = await supabase
  .from("profiles")
  .select("user_id")
  .order("created_at", { ascending: true })
  .limit(1)
  .single();
if (pErr || !profile) {
  console.error("Failed to resolve user:", pErr?.message);
  process.exit(1);
}
const userId = profile.user_id;
const today = new Date().toISOString().slice(0, 10);
console.log(`User: ${userId}`);
console.log(`Today: ${today}\n`);

const { data: existingRows } = await supabase
  .from("coach_dashboards")
  .select("version, status, payload")
  .eq("user_id", userId)
  .eq("generated_on", today)
  .order("version", { ascending: false });

const currentMaxVersion = existingRows?.[0]?.version ?? 0;
const nextVersion = currentMaxVersion + 1;
console.log(`Existing rows: ${existingRows?.length ?? 0}`);
const prevHeadline = existingRows?.[0]?.payload?.facts?.themes?.performance?.one_line ?? "(none)";
console.log(`Prior Performance headline: "${prevHeadline}"`);

console.log(`Generating dashboard at version ${nextVersion}…`);
const t0 = Date.now();
const payload = await generatePeterDashboard({ supabase, userId, today });
const narrative_md = renderInjectionBlock(payload, today);
console.log(`Generated in ${Date.now() - t0}ms.\n`);

const perfTheme = payload.facts.themes.performance;
console.log(`New Performance headline:   "${perfTheme.one_line}"`);
console.log(`  focus_lift: ${perfTheme.facts.focus_lift ?? "null"}`);
console.log(`  focus_lift_plateau_active: ${perfTheme.facts.focus_lift_plateau_active}`);
console.log(`  focus_lift_plateau_weeks:  ${perfTheme.facts.focus_lift_plateau_weeks ?? "null"}`);
console.log(`  goal_lift: ${perfTheme.facts.goal_lift ?? "null"}`);
console.log(`  goal_lift_plateau_active:  ${perfTheme.facts.goal_lift_plateau_active}`);
console.log(`  longest_plateau_lift: ${perfTheme.facts.longest_plateau_lift ?? "null"}`);
const perfGoalCluster = payload.facts.clusters.find((c) => c.id === "performance-goal");
console.log(`performance-goal cluster fired: ${perfGoalCluster != null}`);
console.log(`narrative_failed: ${payload.narrative_failed}${payload.narrative_failed ? ` (${payload.narrative_failure_reason})` : ""}`);

const { data: inserted, error: insErr } = await supabase
  .from("coach_dashboards")
  .insert({
    user_id: userId,
    generated_on: today,
    version: nextVersion,
    status: payload.narrative_failed ? "failed" : "ready",
    payload,
    narrative_md,
  })
  .select("id, version")
  .single();
if (insErr) {
  console.error(`Insert failed:`, insErr.message);
  process.exit(1);
}
console.log(`\n✓ coach_dashboards row inserted: id=${inserted.id} version=${inserted.version}`);
