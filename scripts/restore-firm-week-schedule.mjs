// scripts/restore-firm-week-schedule.mjs
//
// One-shot repair for weeks whose session_plan drifted away from the firm
// schedule (WEEKLY_SESSIONS) because the Sunday cron used to seed each new
// week from the PREVIOUS week's stored plan — so every mid-week swap became
// permanent and compounded. The seeding bug is fixed in
// lib/coach/prescription/upsert-week-prescription.ts:seedSessionPlanForNewWeek;
// this repairs the rows already written.
//
// Rewrites session_plan to WEEKLY_SESSIONS, then re-runs the prescription
// engine for the week so session_prescriptions match the restored labels
// (otherwise Tuesday would read "Chest" while carrying a Mobility
// prescription). `preserveDaysThrough` keeps already-elapsed days verbatim, so
// a session already trained this week is left exactly as it was recorded.
//
// Dry-run by default. Pass --yes to write.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local scripts/restore-firm-week-schedule.mjs \
//     --week 2026-08-10 [--through 2026-08-10] [--yes]

import { createClient } from "@supabase/supabase-js";
import { WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import { upsertWeekPrescription } from "@/lib/coach/prescription/upsert-week-prescription";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--yes");
const WEEK = flag("week");
const THROUGH = flag("through");
if (!WEEK) {
  console.error("usage: --week YYYY-MM-DD [--through YYYY-MM-DD] [--yes]");
  process.exit(1);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const fmt = (plan) => DAYS.map((d) => `${d.slice(0, 3)}=${plan?.[d] ?? "-"}`).join(" ");

const { data: profiles, error: pErr } = await admin.from("profiles").select("user_id");
if (pErr) throw pErr;

for (const { user_id: userId } of profiles) {
  const { data: row, error } = await admin
    .from("training_weeks")
    .select("id, week_start, session_plan, original_session_plan")
    .eq("user_id", userId)
    .eq("week_start", WEEK)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.log(`user ${userId}: no training_weeks row for ${WEEK} — nothing to repair`);
    continue;
  }

  console.log(`\nuser ${userId}  week ${WEEK}`);
  console.log("  before :", fmt(row.session_plan));
  console.log("  firm   :", fmt(WEEKLY_SESSIONS));
  const changed = DAYS.filter((d) => (row.session_plan?.[d] ?? null) !== (WEEKLY_SESSIONS[d] ?? null));
  if (!changed.length) {
    console.log("  already matches the firm schedule — skipping");
    continue;
  }
  console.log("  differs on:", changed.join(", "));

  if (!APPLY) {
    console.log("  DRY RUN — pass --yes to write");
    continue;
  }

  const { error: uErr } = await admin
    .from("training_weeks")
    .update({
      session_plan: { ...WEEKLY_SESSIONS },
      // The pre-edit snapshot described the drifted plan; it would otherwise
      // let an identity-restore "revert" back to the drift.
      original_session_plan: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (uErr) throw uErr;
  console.log("  session_plan restored");

  // Re-run the engine so prescriptions match the restored labels.
  const res = await upsertWeekPrescription({
    supabase: admin,
    userId,
    weekStart: WEEK,
    todayIso: THROUGH ?? WEEK,
    ...(THROUGH ? { preserveDaysThrough: THROUGH } : {}),
  });
  console.log(
    "  prescriptions regenerated for:",
    Object.keys(res.session_prescriptions ?? {}).join(", ") || "(none)",
  );
}

console.log(APPLY ? "\ndone" : "\ndry run complete");
