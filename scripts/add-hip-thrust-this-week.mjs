/**
 * One-off: insert Hip Thrust (Machine) into THIS week's training_weeks
 * session_prescriptions.Monday for the single app user.
 *
 * Why this exists: the Sunday cron at 03:30 UTC stamped this week's
 * prescriptions BEFORE we added Hip Thrust (Machine) to Legs day in
 * SESSION_PLANS. The resolver prefers session_prescriptions over
 * SESSION_PLANS, so without patching the row directly the change won't
 * surface until next Monday.
 *
 * Idempotent: if hip_thrust_machine is already in Monday's array,
 * the script no-ops. Inserts AFTER the rdl key (Romanian Deadlift)
 * when present, else at the end.
 *
 * Run:
 *   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
 *     --env-file=.env.local scripts/add-hip-thrust-this-week.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const HIP_THRUST = {
  name: "Hip Thrust (Machine)",
  baseKg: 60,
  baseReps: 10,
  sets: 3,
  key: "hip_thrust_machine",
  note: "baseKg is a starting estimate — confirm on first session",
  increment: { step: 2.5 },
};

function mondayOnOrBefore(dateIso) {
  const d = new Date(dateIso + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0 = Sunday, 1 = Monday
  const delta = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

async function main() {
  // Find the single user.
  const { data: profiles, error: profErr } = await supabase
    .from("profiles")
    .select("user_id")
    .limit(2);
  if (profErr) throw profErr;
  if (!profiles?.length) {
    console.error("No profiles row found");
    process.exit(1);
  }
  if (profiles.length > 1) {
    console.error(`Expected single-user instance, found ${profiles.length} profiles`);
    process.exit(1);
  }
  const userId = profiles[0].user_id;

  const today = new Date().toISOString().slice(0, 10);
  const weekStart = mondayOnOrBefore(today);
  console.log(`User ${userId}; today ${today}; week_start ${weekStart}`);

  const { data: tw, error: twErr } = await supabase
    .from("training_weeks")
    .select("id, week_start, session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (twErr) throw twErr;
  if (!tw) {
    console.error(`No training_weeks row for week_start=${weekStart}; nothing to patch.`);
    process.exit(1);
  }

  const presc = tw.session_prescriptions ?? {};
  const monday = Array.isArray(presc.Monday) ? [...presc.Monday] : null;
  if (!monday || monday.length === 0) {
    console.error(`session_prescriptions.Monday is empty/absent; the deterministic engine didn't write Legs for this week. Aborting — re-running the engine is the right fix, not a manual insert.`);
    process.exit(1);
  }

  const already = monday.some((ex) => ex?.key === "hip_thrust_machine" || ex?.name === "Hip Thrust (Machine)");
  if (already) {
    console.log("Hip Thrust (Machine) is already in Monday's prescription. No-op.");
    return;
  }

  const rdlIdx = monday.findIndex((ex) => ex?.key === "rdl");
  const insertAt = rdlIdx >= 0 ? rdlIdx + 1 : monday.length;
  monday.splice(insertAt, 0, HIP_THRUST);

  const nextPresc = { ...presc, Monday: monday };

  console.log("Before:", JSON.stringify(presc.Monday.map((e) => e?.name)));
  console.log("After :", JSON.stringify(nextPresc.Monday.map((e) => e?.name)));

  const { error: updErr } = await supabase
    .from("training_weeks")
    .update({ session_prescriptions: nextPresc, updated_at: new Date().toISOString() })
    .eq("id", tw.id);
  if (updErr) throw updErr;

  console.log(`Inserted at position ${insertAt + 1}/${monday.length} in training_weeks ${tw.id} (week_start ${weekStart}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
