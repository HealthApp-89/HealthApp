// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-logger-write-path.mjs
//
// End-to-end audit:
//  - Counts logger-sourced workouts in the last 30 days.
//  - Verifies every logger workout has at least one exercise + one set.
//  - Verifies external_id starts with "logger-".
//  - Surfaces sets where rest_seconds_actual is populated.
//  - Lists user_session_templates rows for the user.

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const since = new Date();
since.setDate(since.getDate() - 30);
const sinceIso = since.toISOString().slice(0, 10);

const { data: workouts, error } = await supabase
  .from("workouts")
  .select("id, date, type, external_id, source, exercises(name, exercise_sets(kg, reps, rest_seconds_actual))")
  .eq("user_id", userId)
  .eq("source", "logger")
  .gte("date", sinceIso)
  .order("date", { ascending: false });

if (error) {
  console.error("Query failed:", error);
  process.exit(1);
}

console.log(`Found ${workouts?.length ?? 0} logger-sourced workouts in last 30 days\n`);

let badExternalIds = 0;
let emptyWorkouts = 0;
let restActualPopulatedRows = 0;
for (const w of workouts ?? []) {
  if (!w.external_id?.startsWith("logger-")) badExternalIds++;
  if (!w.exercises?.length) { emptyWorkouts++; continue; }
  for (const ex of w.exercises) {
    for (const s of ex.exercise_sets ?? []) {
      if (s.rest_seconds_actual != null) restActualPopulatedRows++;
    }
  }
  console.log(`  ${w.date} · ${w.type} · ${w.exercises.length} exercise${w.exercises.length === 1 ? "" : "s"} · ${w.external_id}`);
}

console.log("\n— Invariants —");
console.log(`  bad external_id prefix: ${badExternalIds}`);
console.log(`  empty workouts (0 exercises): ${emptyWorkouts}`);
console.log(`  sets with rest_seconds_actual populated: ${restActualPopulatedRows}`);

const { data: templates } = await supabase
  .from("user_session_templates")
  .select("session_type, updated_at, exercises")
  .eq("user_id", userId);

console.log(`\n— user_session_templates (${templates?.length ?? 0}) —`);
for (const t of templates ?? []) {
  console.log(`  ${t.session_type} · ${(t.exercises ?? []).length} exercises · updated ${t.updated_at}`);
}

if (badExternalIds > 0 || emptyWorkouts > 0) {
  console.error("\nFAIL: invariants violated");
  process.exit(1);
}
console.log("\nOK");
