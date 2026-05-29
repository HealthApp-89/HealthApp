// scripts/regen-after-block-focus-fix.mjs
//
// One-off script. After the block-focus / bilateral-DB-grid fixes shipped
// 2026-05-29, regenerates this week's training_weeks.session_prescriptions
// so the autoreg-rule blockPhase gate + corrected bilateral-DB step are
// actually reflected in what the logger sees today.
//
// Peter dashboard regen is handled separately (delete today's v1 + hit cron
// endpoint) because generatePeterDashboard pulls in compose-fatigue which
// transitively imports server-only modules incompatible with --experimental-
// strip-types.
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local scripts/regen-after-block-focus-fix.mjs

import { createClient } from "@supabase/supabase-js";
import { prescribeWeek } from "../lib/coach/prescription/prescribe-week.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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

// Current week's Monday (week_start convention is Monday per TrainingWeek type).
const todayDate = new Date(`${today}T00:00:00Z`);
const dayOfWeek = todayDate.getUTCDay();
const daysSinceMonday = (dayOfWeek + 6) % 7;
const monday = new Date(todayDate);
monday.setUTCDate(todayDate.getUTCDate() - daysSinceMonday);
const weekStart = monday.toISOString().slice(0, 10);
console.log(`Current week_start (Monday): ${weekStart}`);

const { data: week, error: wErr } = await supabase
  .from("training_weeks")
  .select("*")
  .eq("user_id", userId)
  .eq("week_start", weekStart)
  .maybeSingle();
if (wErr) {
  console.error(`training_weeks lookup failed:`, wErr.message);
  process.exit(1);
}
if (!week) {
  console.log(`No training_weeks row for ${weekStart} — nothing to regen.`);
  process.exit(0);
}
console.log(`Found row: id=${week.id} block_id=${week.block_id ?? "null"} rir_target=${week.rir_target}\n`);

const { data: block } = await supabase
  .from("training_blocks")
  .select("*")
  .eq("user_id", userId)
  .eq("status", "active")
  .maybeSingle();
console.log(`Active block: ${block ? `${block.primary_lift} target=${block.target_value}kg target_hit_at_week=${block.target_hit_at_week ?? "null"}` : "(none)"}\n`);

// ── Diff preview ───────────────────────────────────────────────────────────
function findEx(arr, name) { return arr?.find((e) => e.name === name); }
function fmtEx(e) {
  if (!e) return "(not prescribed)";
  return `${e.baseKg ?? "?"}kg × ${e.baseReps ?? "?"} × ${e.sets ?? "?"}sets (step=${e.increment?.step ?? "?"})`;
}

const priorByDay = {
  Mon_Squat:    findEx(week.session_prescriptions?.Monday,    "Squat (Barbell)"),
  Tue_DeclineBP: findEx(week.session_prescriptions?.Tuesday,   "Decline Bench Press (Barbell)"),
  Thu_Deadlift: findEx(week.session_prescriptions?.Thursday,  "Deadlift (Barbell)"),
  Fri_FrontRaise: findEx(week.session_prescriptions?.Friday,   "Front Raise (Dumbbell)"),
  Fri_LatRaise:   findEx(week.session_prescriptions?.Friday,   "Lateral Raise (Dumbbell)"),
  Fri_BicepCurl:  findEx(week.session_prescriptions?.Friday,   "Bicep Curl (Dumbbell)"),
  Fri_Arnold:     findEx(week.session_prescriptions?.Friday,   "Arnold Press (Dumbbell)"),
};

console.log(`Running prescribeWeek…`);
const t1 = Date.now();
const newPrescriptions = await prescribeWeek({
  supabase,
  userId,
  block,
  week,
  todayIso: today,
});
console.log(`Done in ${Date.now() - t1}ms.\n`);

const newByDay = {
  Mon_Squat:    findEx(newPrescriptions.Monday,    "Squat (Barbell)"),
  Tue_DeclineBP: findEx(newPrescriptions.Tuesday,   "Decline Bench Press (Barbell)"),
  Thu_Deadlift: findEx(newPrescriptions.Thursday,  "Deadlift (Barbell)"),
  Fri_FrontRaise: findEx(newPrescriptions.Friday,   "Front Raise (Dumbbell)"),
  Fri_LatRaise:   findEx(newPrescriptions.Friday,   "Lateral Raise (Dumbbell)"),
  Fri_BicepCurl:  findEx(newPrescriptions.Friday,   "Bicep Curl (Dumbbell)"),
  Fri_Arnold:     findEx(newPrescriptions.Friday,   "Arnold Press (Dumbbell)"),
};

console.log("## Diff (prior → new) for key lifts\n");
for (const k of Object.keys(priorByDay)) {
  console.log(`  ${k.padEnd(18)} ${fmtEx(priorByDay[k])}  →  ${fmtEx(newByDay[k])}`);
}

// Full per-day breakdown so we can eyeball the warmup augmentation.
console.log("\n## Full new prescriptions by day\n");
for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
  const dayEx = newPrescriptions[day];
  if (!dayEx || dayEx.length === 0) {
    console.log(`  ${day}: (no exercises)`);
    continue;
  }
  console.log(`  ${day}:`);
  for (const e of dayEx) {
    const tag = e.warmup ? "WARMUP" : "      ";
    const load = e.baseKg != null ? `${e.baseKg}kg` : (e.reps ?? "—");
    console.log(`    ${tag}  ${e.name.padEnd(34)}  ${load.padStart(8)} × ${e.baseReps ?? "?"} × ${e.sets ?? 1}set${(e.sets ?? 1) > 1 ? "s" : ""}`);
  }
}

const { error: updErr } = await supabase
  .from("training_weeks")
  .update({
    session_prescriptions: newPrescriptions,
    updated_at: new Date().toISOString(),
  })
  .eq("id", week.id);
if (updErr) {
  console.error(`\ntraining_weeks update failed:`, updErr.message);
  process.exit(1);
}
console.log(`\n✓ session_prescriptions updated for week_start=${weekStart}.`);
