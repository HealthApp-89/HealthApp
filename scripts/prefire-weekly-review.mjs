#!/usr/bin/env node
// scripts/prefire-weekly-review.mjs
//
// Manually fire a weekly review for a given week_start, bypassing the
// scheduled cron's date math. Mirrors app/api/coach/weekly-review/sync/route.ts
// exactly: same generateWeeklyReview call, same insert sequence, same
// idempotency guard, same compensating-delete on chat insert failure.
//
// Use cases:
//   - Pre-fire a review before the natural cron runs (e.g. dev fixture seeding)
//   - Manually retry a week the scheduled cron missed
//   - Test the compute path against a specific week_start without waiting for
//     the calendar
//
// Idempotent: re-running with the same --week-start short-circuits via the
// "row exists" guard, same as the cron route.
//
// Usage:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local \
//     scripts/prefire-weekly-review.mjs --week-start=YYYY-MM-DD [--late]
//
// Required env (read from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const envPath = resolve(repoRoot, ".env.local");
const env = {};
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let weekStart = null;
let late = false;
for (const arg of args) {
  if (arg.startsWith("--week-start=")) weekStart = arg.slice("--week-start=".length);
  else if (arg === "--late") late = true;
  else {
    console.error(`Unknown arg: ${arg}`);
    process.exit(1);
  }
}
if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
  console.error("Required: --week-start=YYYY-MM-DD");
  process.exit(1);
}

// Validate it's a Monday — the system always anchors weeks on Monday.
const wsDate = new Date(weekStart + "T12:00:00Z");
if (wsDate.getUTCDay() !== 1) {
  console.error(`--week-start must be a Monday. ${weekStart} is ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][wsDate.getUTCDay()]}.`);
  process.exit(1);
}

// ── Setup ───────────────────────────────────────────────────────────────────

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: profile, error: pErr } = await sb
  .from("profiles")
  .select("user_id")
  .order("created_at", { ascending: true })
  .limit(1)
  .single();
if (pErr || !profile) {
  console.error("No profile found:", pErr?.message);
  process.exit(1);
}
const userId = profile.user_id;
console.log(`user_id: ${userId}`);
console.log(`week_start: ${weekStart} (late=${late})`);

// ── Mirror route guards ─────────────────────────────────────────────────────

const { data: existing } = await sb
  .from("weekly_reviews")
  .select("id, status")
  .eq("user_id", userId)
  .eq("week_start", weekStart)
  .limit(1)
  .maybeSingle();
if (existing) {
  console.log(`✓ skipped: weekly_reviews row already exists (id=${existing.id}, status=${existing.status})`);
  process.exit(0);
}

const PLAN_WEEK_GRACE_MS = 30 * 60 * 1000;
const thirtyMinAgo = new Date(Date.now() - PLAN_WEEK_GRACE_MS).toISOString();
const { data: activePlanWeek } = await sb
  .from("chat_messages")
  .select("id")
  .eq("user_id", userId)
  .eq("mode", "plan_week")
  .gte("created_at", thirtyMinAgo)
  .limit(1);
if (activePlanWeek && activePlanWeek.length > 0) {
  console.log("✓ skipped: plan_week chat session active within 30min");
  process.exit(0);
}

// ── Compute ────────────────────────────────────────────────────────────────

const { generateWeeklyReview } = await import("../lib/coach/weekly-review/index.ts");

// Narrative validator (lib/coach/weekly-review/narrative-prompt.ts) throws when
// Sonnet fabricates a number not in the payload. AI generation is stochastic,
// so a fabrication on one call doesn't mean the path is broken — retry until
// the narrator emits clean prose. 5 attempts is generous; the validator's
// retry-friendly design (idempotency at the cron level + this single-process
// retry) is the belt-and-suspenders the cron route lacks today.
const MAX_RETRIES = 5;
let result = null;
let lastErr = null;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    result = await generateWeeklyReview({ supabase: sb, userId, weekStart, late });
    console.log(`generateWeeklyReview ok on attempt ${attempt}/${MAX_RETRIES}`);
    break;
  } catch (e) {
    lastErr = e;
    const msg = e instanceof Error ? e.message : String(e);
    // Only retry the narrative-validator class of failures. Anything else
    // (compute error, supabase error) is deterministic — no point retrying.
    if (!msg.startsWith("Narrative referenced numbers not in payload")) {
      console.error(`generateWeeklyReview failed (non-retryable):`, msg);
      if (e instanceof Error && e.stack) console.error(e.stack);
      process.exit(2);
    }
    console.warn(`attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
    if (attempt === MAX_RETRIES) {
      console.error(`exhausted ${MAX_RETRIES} retries on narrative validator. Inspect prompt or relax validator.`);
      process.exit(2);
    }
  }
}
if (!result) {
  console.error("unreachable: no result after retry loop", lastErr);
  process.exit(2);
}

console.log(`compute ok: block_id=${result.blockId}, narrative_md=${result.narrative_md.length} chars`);

// ── Insert weekly_reviews row ──────────────────────────────────────────────

function shiftDays(d, days) {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
const nextMonday = shiftDays(weekStart, 7);

const { data: inserted, error: insErr } = await sb
  .from("weekly_reviews")
  .insert({
    user_id: userId,
    week_start: weekStart,
    next_week_start: nextMonday,
    version: 1,
    status: "draft",
    block_id: result.blockId,
    payload: result.payload,
    narrative_md: result.narrative_md,
    reconfirm_responses: {},
  })
  .select("id")
  .single();
if (insErr || !inserted) {
  console.error("weekly_reviews insert failed:", insErr?.message);
  process.exit(3);
}
console.log(`✓ weekly_reviews inserted: id=${inserted.id}`);

// ── Insert chat card ──────────────────────────────────────────────────────

function shortLift(name) {
  return name.replace(/\s*\([^)]+\)/, "");
}
function lookupLastWeekKg(payload, lift) {
  const row = payload.recap.per_lift.find((p) => p.lift === lift);
  return row ? `${row.top_set.weight_kg}kg` : "—";
}
function buildOneLine(p) {
  return `Wk ${p.header.week_n} → Wk ${p.header.week_n + 1} · ${p.header.block_phase_next.toUpperCase()} next · ${p.recap.sessions_done}/${p.recap.sessions_planned} sessions`;
}

const cardUi = {
  schema_version: 1,
  week_start: weekStart,
  next_week_start: nextMonday,
  block_phase_now: result.payload.header.block_phase_now,
  block_phase_next: result.payload.header.block_phase_next,
  one_line_summary: buildOneLine(result.payload),
  per_lift_preview: result.payload.prescription.per_lift.slice(0, 4).map((p) => ({
    lift: shortLift(p.lift),
    from: lookupLastWeekKg(result.payload, p.lift),
    to: `${p.weight_kg}kg`,
  })),
  link_path: `/coach/weeks/${weekStart}`,
  review_id: inserted.id,
};

const { error: chatErr } = await sb.from("chat_messages").insert({
  user_id: userId,
  kind: "weekly_review",
  role: "assistant",
  content: cardUi.one_line_summary,
  ui: cardUi,
});
if (chatErr) {
  console.error("chat_messages insert failed:", chatErr.message);
  // Compensating delete — mirror route behavior so the cron can retry cleanly.
  await sb.from("weekly_reviews").delete().eq("id", inserted.id);
  console.error("compensating delete: weekly_reviews row removed");
  process.exit(4);
}

console.log(`✓ chat_messages weekly_review card inserted`);
console.log(`\n=== SUMMARY ===`);
console.log(`Review id: ${inserted.id}`);
console.log(`Headline: ${cardUi.one_line_summary}`);
console.log(`Open at: /coach/weeks/${weekStart}`);
