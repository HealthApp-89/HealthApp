#!/usr/bin/env node
// scripts/audit-deficit-alarm.mjs
//
// Read-only audit: traces the GLP-1 deficit-alarm calculation end-to-end.
// Prints what nutrition_overrides / plan_payload / recent intake the
// resolver is reading, then walks the deficit math so we can see WHY
// Peter's snapshot is showing "7-day deficit ~XXXX kcal/day".
//
// Specifically distinguishes:
//   - kcal TARGET (what the user is supposed to eat — override → plan → intake)
//   - TDEE estimate (what plan_payload.nutrition.glp1.tdee_estimate_kcal says)
//   - actual 7-day avg intake (from daily_logs.calories_eaten)
//   - reported deficit (TDEE − avg_intake)  ← current logic
//   - planned deficit (TDEE − target)        ← what the user might expect
//   - adherence gap (target − avg_intake)    ← are they undereating their target?
//
// Run via:
//   AUDIT_USER_ID=<uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-deficit-alarm.mjs

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
const supabase = createClient(url, key, { auth: { persistSession: false } });

function todayIso() {
  // Dubai (UTC+4) — single-user app; matches todayInUserTz() default.
  const now = new Date();
  const dubai = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  return dubai.toISOString().slice(0, 10);
}

function isoDaysAgo(today, n) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const today = todayIso();
const sevenAgo = isoDaysAgo(today, 7);
const fourteenAgo = isoDaysAgo(today, 14);

console.log("═══════════════════════════════════════════════════════════════");
console.log(`DEFICIT-ALARM AUDIT — user ${userId.slice(0, 8)}…`);
console.log(`Today (Dubai): ${today}`);
console.log("═══════════════════════════════════════════════════════════════\n");

// ── 1. profiles.nutrition_overrides ──────────────────────────────────────
const { data: profile } = await supabase
  .from("profiles")
  .select("nutrition_overrides")
  .eq("user_id", userId)
  .maybeSingle();

console.log("┌─ 1. profiles.nutrition_overrides ─────────────────────────────");
console.log(JSON.stringify(profile?.nutrition_overrides ?? null, null, 2));
console.log("");

// ── 2. athlete_profile_documents (active) ────────────────────────────────
const { data: apd } = await supabase
  .from("athlete_profile_documents")
  .select("version, status, acknowledged_at, intake_payload, plan_payload")
  .eq("user_id", userId)
  .eq("status", "active")
  .maybeSingle();

console.log("┌─ 2. athlete_profile_documents (active) ───────────────────────");
console.log(`version: ${apd?.version}`);
console.log(`acknowledged_at: ${apd?.acknowledged_at}`);
console.log(`has plan_payload: ${!!apd?.plan_payload}`);
console.log(`has intake_payload: ${!!apd?.intake_payload}`);
console.log("");

const intake = apd?.intake_payload;
const plan = apd?.plan_payload;

if (intake?.nutrition) {
  console.log("intake_payload.nutrition:");
  console.log(`  current_kcal: ${intake.nutrition.current_kcal}`);
  console.log(`  current_macros: P${intake.nutrition.current_macros.protein_g}/C${intake.nutrition.current_macros.carb_g}/F${intake.nutrition.current_macros.fat_g}`);
  console.log(`  current_phase: ${intake.nutrition.current_phase}`);
  console.log("");
}

if (plan?.nutrition) {
  console.log("plan_payload.nutrition:");
  console.log(`  phase: ${plan.nutrition.phase}`);
  console.log(`  kcal_target: ${plan.nutrition.kcal_target}`);
  console.log(`  protein_g: ${plan.nutrition.protein_g} (${plan.nutrition.protein_g_per_kg_bw} g/kg BW)`);
  console.log(`  carb_g: ${plan.nutrition.carb_g}`);
  console.log(`  fat_g: ${plan.nutrition.fat_g}`);
  if (plan.nutrition.glp1) {
    const g = plan.nutrition.glp1;
    console.log("");
    console.log("plan_payload.nutrition.glp1:");
    console.log(`  medication: ${g.medication}`);
    console.log(`  dose_mg: ${g.dose_mg}`);
    console.log(`  started_on: ${g.started_on}`);
    console.log(`  taper_started_on: ${g.taper_started_on ?? "(not started)"}`);
    console.log(`  tdee_estimate_kcal: ${g.tdee_estimate_kcal}   ← deficit math uses THIS as "TDEE"`);
    console.log(`  deficit_alarm_kcal: ${g.deficit_alarm_kcal}   ← absolute floor`);
    console.log(`  deficit_alarm_pct: ${g.deficit_alarm_pct}   ← TDEE-relative floor`);
    const threshold = Math.max(g.deficit_alarm_kcal, Math.round(g.tdee_estimate_kcal * g.deficit_alarm_pct));
    console.log(`  → resolved threshold: max(${g.deficit_alarm_kcal}, round(${g.tdee_estimate_kcal} * ${g.deficit_alarm_pct})) = ${threshold} kcal/day`);
  }
  if (plan.nutrition.classical_phases?.length) {
    console.log("");
    console.log("plan_payload.nutrition.classical_phases:");
    for (const p of plan.nutrition.classical_phases) {
      console.log(`  W${p.start_week}-${p.end_week} ${p.mode}: ${p.kcal} kcal, P${p.protein_g}/C${p.carb_g}/F${p.fat_g}`);
    }
  }
  console.log("");
}

// ── 3. Last 14 days of daily_logs.calories_eaten ─────────────────────────
const { data: logs } = await supabase
  .from("daily_logs")
  .select("date, calories_eaten, protein_g, carbs_g, fat_g")
  .eq("user_id", userId)
  .gte("date", fourteenAgo)
  .lte("date", today)
  .order("date", { ascending: true });

console.log("┌─ 3. daily_logs.calories_eaten — last 14 days ─────────────────");
for (const row of logs ?? []) {
  const flag = row.date >= sevenAgo && row.date < today ? " ← in 7d window" : "";
  console.log(`  ${row.date}: kcal=${row.calories_eaten ?? "null"}  P=${row.protein_g ?? "null"}${flag}`);
}
console.log("");

// ── 4. Replicate rolling7dDeficit (mirrors lib/morning/brief/get-today-targets.ts) ──
const samples = (logs ?? [])
  .filter((r) => r.date >= sevenAgo && r.date < today)
  .map((r) => r.calories_eaten)
  .filter((v) => typeof v === "number" && v > 0);

console.log("┌─ 4. Rolling 7-day intake (mirroring rolling7dDeficit) ────────");
console.log(`Window: [${sevenAgo}, ${today})`);
console.log(`Samples (>0 kcal): ${samples.length}`);
if (samples.length > 0) {
  const sum = samples.reduce((a, b) => a + b, 0);
  const avg = sum / samples.length;
  console.log(`Sum: ${sum}`);
  console.log(`Avg intake: ${Math.round(avg)} kcal/day`);
  if (plan?.nutrition?.glp1) {
    const tdee = plan.nutrition.glp1.tdee_estimate_kcal;
    const avgDeficit = Math.round(tdee - avg);
    console.log(`TDEE estimate: ${tdee}`);
    console.log(`→ rolling_7d_avg_deficit = TDEE − avg_intake = ${tdee} − ${Math.round(avg)} = ${avgDeficit} kcal/day`);
    const threshold = Math.max(
      plan.nutrition.glp1.deficit_alarm_kcal,
      Math.round(tdee * plan.nutrition.glp1.deficit_alarm_pct),
    );
    console.log(`Threshold: ${threshold} kcal/day`);
    console.log(`Triggered? ${avgDeficit > threshold ? "YES ⚠" : "no"}`);
  }
}
console.log("");

// ── 5. Resolution chain — what does getTodayTargets actually return? ─────
console.log("┌─ 5. Resolution chain — what gets shown to Peter ──────────────");
const ovr = profile?.nutrition_overrides ?? null;
let resolvedKcal, resolvedKcalSource;
if (ovr?.kcal !== undefined) {
  resolvedKcal = ovr.kcal;
  resolvedKcalSource = "override";
} else if (plan?.nutrition?.kcal_target !== undefined) {
  resolvedKcal = plan.nutrition.kcal_target;
  resolvedKcalSource = "plan";
} else {
  resolvedKcal = intake?.nutrition?.current_kcal;
  resolvedKcalSource = "intake";
}
console.log(`CURRENT kcal TARGET: ${resolvedKcal} (source: ${resolvedKcalSource})`);

if (plan?.nutrition?.glp1 && samples.length > 0) {
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const tdee = plan.nutrition.glp1.tdee_estimate_kcal;
  const ADHERENCE_GRACE_KCAL = 300;
  const under = Math.round(resolvedKcal - avg);
  console.log("");
  console.log("┌─ Deficit framings (legacy TDEE-based + new adherence) ────────");
  console.log(`(A) TDEE − avg_intake   = ${tdee} − ${Math.round(avg)} = ${Math.round(tdee - avg)}   ← LEGACY (pre-2026-05-27, no longer used)`);
  console.log(`(B) TDEE − target       = ${tdee} − ${resolvedKcal} = ${tdee - resolvedKcal}   ← PLANNED deficit (the cut you set up)`);
  console.log(`(C) target − avg_intake = ${resolvedKcal} − ${Math.round(avg)} = ${under}   ← ADHERENCE gap (positive = undereating, NEW alarm uses this)`);
  console.log("");
  console.log("┌─ Adherence alarm (NEW logic) ─────────────────────────────────");
  console.log(`Grace: ±${ADHERENCE_GRACE_KCAL} kcal/day`);
  console.log(`Triggered? ${under > ADHERENCE_GRACE_KCAL ? `YES ⚠ (under by ${under} > ${ADHERENCE_GRACE_KCAL} grace)` : `no (under by ${under} ≤ ${ADHERENCE_GRACE_KCAL} grace — within tolerance)`}`);
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("Done.");
