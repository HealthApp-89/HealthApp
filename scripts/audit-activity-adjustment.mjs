// Read-only dry-run of the activity-adjustment preview for the current week.
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//   --experimental-strip-types --env-file=.env.local scripts/audit-activity-adjustment.mjs
import { createClient } from "@supabase/supabase-js";
import { computeActivityLayoutProposal } from "@/lib/coach/prescription/prescribe-week";
import { todayInUserTz } from "@/lib/time";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("set AUDIT_USER_ID");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Fetch timezone directly to avoid next/headers via lib/time/get-user-tz.ts
const { data: profile } = await sb.from("profiles").select("timezone").eq("user_id", userId).maybeSingle();
const tz = profile?.timezone ?? (process.env.USER_TIMEZONE || "Asia/Dubai");

const today = todayInUserTz(new Date(), tz);
const weekStart = mondayOf(today);

const { data: row } = await sb
  .from("training_weeks")
  .select("id, user_id, block_id, week_start, session_plan, planned_activities, session_prescriptions, exercise_overrides, rir_target")
  .eq("user_id", userId).eq("week_start", weekStart).maybeSingle();
if (!row) { console.log("no training_weeks row for", weekStart); process.exit(0); }

const { data: block } = await sb.from("training_blocks").select("*").eq("user_id", userId).eq("status", "active").maybeSingle();
const proposal = await computeActivityLayoutProposal({ supabase: sb, userId, block: block ?? null, week: row, todayIso: today });

console.log("planned_activities:", JSON.stringify(row.planned_activities ?? []));
console.log("hasMoves:", proposal.hasMoves, "| hasFlags:", proposal.hasFlags);
console.log("lightenDays:", JSON.stringify(proposal.lightenDays));
console.log("flags:", JSON.stringify(proposal.flags.map((f) => ({ day: f.sessionDay, type: f.sessionType, reason: f.reason }))));
