// scripts/migrate-unilateral-reps.mjs
//
// One-shot data migration, two independent parts:
//
//  1. UNILATERAL REPS — Cable External/Internal Rotation rows were logged with
//     both sides summed into one number (30 = 15 left + 15 right). The engine
//     read that as a single 30-rep set, which pushed the double-progression
//     rep ceiling to ~34 (17/side) and made the sets ineligible for e1RM.
//     `exercise_sets.reps` now means PER SIDE for any exercise the library
//     marks `unilateral`, so these rows are halved.
//
//     Odd counts round UP (27 -> 14): the athlete logged one side one rep
//     heavier, and rounding down would silently discard it.
//
//     TONNAGE IS PRESERVED. lib/coach/strain/mechanical-load.ts doubles the
//     tonnage of a unilateral set, so 18x30 and 18x15(x2) are the same work.
//     Running this migration WITHOUT that code change would halve those
//     sessions' mechanical term and invalidate STRAIN_CALIBRATION.
//
//  2. LEG PRESS RENAME — "Leg Press Single Leg" is a stale title. The athlete
//     switched to a bilateral leg press long ago and never renamed it; 140 kg
//     is the total load moved by both legs. The stale string resolves to
//     nothing in the exercise library (loadability defaults, `bottomReps`
//     falls back to discovery's self-derived value) and misses the
//     SESSION_PLANS.Legs entry by name. Renaming to "Leg Press" fixes all
//     three. Reps are NOT touched — they were always bilateral reps.
//
// Idempotent: part 1 skips rows already at or below the per-side ceiling for
// their exercise, part 2 is a no-op once no rows carry the stale name.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local scripts/migrate-unilateral-reps.mjs [--yes]

import { createClient } from "@supabase/supabase-js";

const { resolveExercise } = await import("@/lib/coach/exercise-library");

const COMMIT = process.argv.includes("--yes");
const STALE_LEG_PRESS = "Leg Press Single Leg";
const RENAMED_LEG_PRESS = "Leg Press";

/** Above this, a rotation row is unambiguously a both-sides total. The
 *  athlete's per-side working range is 15; a stored 20+ can only be combined.
 *  Rows at or below it are treated as already-migrated so re-runs are safe. */
const COMBINED_REPS_FLOOR = 19;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Part 1: halve unilateral rotation reps ───────────────────────────────────

const UNILATERAL_NAMES = ["Cable External Rotation", "Cable Internal Rotation"];

for (const n of UNILATERAL_NAMES) {
  if (!resolveExercise(n)?.unilateral) {
    fail(`"${n}" is not marked unilateral in the exercise library. Apply the code change before running this migration — halving reps without the tonnage doubling in mechanical-load.ts would corrupt strain history.`);
  }
}

const { data: uniEx, error: uniErr } = await sb
  .from("exercises")
  .select("id, name, exercise_sets(id, reps, warmup)")
  .in("name", UNILATERAL_NAMES);
if (uniErr) fail(`fetch rotations: ${uniErr.message}`);

const repUpdates = [];
for (const ex of uniEx ?? []) {
  for (const s of ex.exercise_sets ?? []) {
    if (s.reps == null) continue;
    if (s.reps <= COMBINED_REPS_FLOOR) continue; // already per-side
    repUpdates.push({ id: s.id, name: ex.name, from: s.reps, to: Math.ceil(s.reps / 2) });
  }
}

console.log(`\n── Part 1: unilateral reps (combined → per side) ──`);
console.log(`   ${uniEx?.length ?? 0} rotation exercise rows scanned`);
console.log(`   ${repUpdates.length} sets to halve`);
for (const u of repUpdates.slice(0, 8)) {
  console.log(`     ${u.name}: ${u.from} → ${u.to}`);
}
if (repUpdates.length > 8) console.log(`     … and ${repUpdates.length - 8} more`);

// ── Part 2: rename the stale leg press title ─────────────────────────────────

const { data: legEx, error: legErr } = await sb
  .from("exercises")
  .select("id, workout_id")
  .eq("name", STALE_LEG_PRESS);
if (legErr) fail(`fetch leg press: ${legErr.message}`);

console.log(`\n── Part 2: leg press rename ──`);
console.log(`   ${legEx?.length ?? 0} rows "${STALE_LEG_PRESS}" → "${RENAMED_LEG_PRESS}"`);
if (!resolveExercise(RENAMED_LEG_PRESS)) {
  fail(`"${RENAMED_LEG_PRESS}" does not resolve in the exercise library — the rename would not fix the lookup.`);
}

// ── Commit ───────────────────────────────────────────────────────────────────

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Re-run with --yes to commit.\n`);
  process.exit(0);
}

let repDone = 0;
for (const u of repUpdates) {
  const { error } = await sb.from("exercise_sets").update({ reps: u.to }).eq("id", u.id);
  if (error) fail(`update set ${u.id}: ${error.message}`);
  repDone++;
}

let legDone = 0;
if ((legEx?.length ?? 0) > 0) {
  const { error } = await sb
    .from("exercises")
    .update({ name: RENAMED_LEG_PRESS })
    .eq("name", STALE_LEG_PRESS);
  if (error) fail(`rename leg press: ${error.message}`);
  legDone = legEx.length;
}

console.log(`\n✓ ${repDone} sets halved, ${legDone} exercise rows renamed.`);
console.log(`  Next: re-run scripts/audit-strain-calibration.mjs — RMSE must be UNCHANGED.`);
console.log(`  Then repatch the current week's prescriptions for the new rep anchors.\n`);
