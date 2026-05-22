// Verify every in-app logger workout has a corresponding workout_debrief
// chat row. Run:
//   AUDIT_USER_ID=<uuid> AUDIT_DAYS=14 \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local scripts/audit-workout-debrief.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.AUDIT_USER_ID;
const days = Number(process.env.AUDIT_DAYS ?? "14");

if (!url || !key) { console.error("Missing SUPABASE env"); process.exit(1); }
if (!userId) { console.error("Set AUDIT_USER_ID"); process.exit(1); }

const supabase = createClient(url, key, { auth: { persistSession: false } });

const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const { data: workouts, error: wErr } = await supabase
  .from("workouts")
  .select("id, date, type, external_id")
  .eq("user_id", userId)
  .gte("date", since)
  .order("date", { ascending: false });
if (wErr) { console.error(wErr); process.exit(1); }

const loggerWorkouts = (workouts ?? []).filter(
  (w) => typeof w.external_id === "string" && w.external_id.startsWith("logger-"),
);
console.log(`Found ${loggerWorkouts.length} in-app logger workouts since ${since}.`);

let missing = 0;
let present = 0;
for (const w of loggerWorkouts) {
  const { data: chat } = await supabase
    .from("chat_messages")
    .select("id, created_at")
    .eq("user_id", userId)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", w.id)
    .maybeSingle();
  if (chat) {
    present++;
    console.log(`  ✓ ${w.date} ${w.type}  → chat_message ${chat.id}`);
  } else {
    missing++;
    console.log(`  ✗ ${w.date} ${w.type}  → MISSING (workout_id=${w.id})`);
  }
}
console.log(`\n${present} present · ${missing} missing.`);
process.exit(missing > 0 ? 2 : 0);
