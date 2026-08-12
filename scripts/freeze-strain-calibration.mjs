// scripts/freeze-strain-calibration.mjs
//
// Writes the labelled calibration set to scripts/fixtures/strain-calibration-2026.json.
//
// April-May 2026 daily_logs.strain rows still carry WHOOP's own
// strength-adjusted values — the ONLY labelled data that will ever exist for
// this athlete, since WHOOP is disconnected. June was already overwritten by
// the Garmin cutover. Freezing them into the repo is what makes it safe to
// recompute the column.
//
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local scripts/freeze-strain-calibration.mjs

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const FROM = "2026-04-01";
const TO = "2026-05-31";
const OUT = "scripts/fixtures/strain-calibration-2026.json";

// ── ONE-SHOT. ALREADY FIRED. DO NOT RE-RUN. ─────────────────────────────────
//
// This script reads `daily_logs.strain` and writes it out as `whoop_strain`,
// the label the strain model is calibrated against. That was correct exactly
// once, on 2026-08-12, while those rows still held values from the WHOOP strap.
//
// They do not any more. The backfill that followed (scripts/backfill-fused-strain.mjs)
// overwrote that column with the model's OWN OUTPUT. So a re-run today would not
// merely lose the labels — it would relabel the model's predictions as its own
// ground truth, and scripts/audit-strain-calibration.mjs would then compare the
// model against itself, passing at ~0 RMSE forever while real validation was
// silently gone. A green gate proving nothing is worse than no gate.
//
// WHOOP is disconnected permanently, so those labels cannot be re-derived from
// anywhere. The committed fixture is the only copy that will ever exist.
//
// The script is kept for provenance — it documents how the fixture was built.
// If you are calibrating a NEW window against a NEW label source, write a new
// script with a new output path; do not repoint this one.
if (existsSync(OUT)) {
  let labelled = 0;
  try {
    labelled = JSON.parse(readFileSync(OUT, "utf8")).filter(
      (d) => typeof d.whoop_strain === "number",
    ).length;
  } catch {
    // Unparseable: still refuse. A corrupt fixture is recoverable from git;
    // an overwritten one is not.
  }
  console.error(
    `REFUSING TO RUN.\n\n` +
      `${OUT} already exists and holds ${labelled} labelled days.\n` +
      `Those labels came from a WHOOP strap that is permanently disconnected, and\n` +
      `daily_logs.strain — this script's input — has since been overwritten with the\n` +
      `model's own output. Running would overwrite irreplaceable ground truth with\n` +
      `the predictions it is supposed to validate.\n\n` +
      `Read the block above ${OUT.split("/").pop()} in this file before doing anything else.`,
  );
  process.exit(1);
}

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: logs, error: e1 } = await sb
  .from("daily_logs")
  .select("date, strain, resting_hr")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO)
  .not("strain", "is", null)
  .order("date");
if (e1) throw e1;

const { data: acts, error: e2 } = await sb
  .from("garmin_activities")
  .select("external_id, local_date, started_at, duration_s, device_id, activity_type, hr_samples")
  .eq("user_id", userId)
  .gte("local_date", FROM)
  .lte("local_date", TO);
if (e2) throw e2;

const { data: gd, error: e3 } = await sb
  .from("garmin_daily")
  .select("date, raw")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO);
if (e3) throw e3;

const { data: workouts, error: e4 } = await sb
  .from("workouts")
  .select("date, exercises(name, exercise_sets(kg, reps, warmup, rir))")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO);
if (e4) throw e4;

const actsBy = new Map();
for (const a of acts ?? []) {
  if (!actsBy.has(a.local_date)) actsBy.set(a.local_date, []);
  actsBy.get(a.local_date).push(a);
}
const allDayBy = new Map((gd ?? []).map((r) => [r.date, r.raw?.hr_samples ?? null]));

// One workout per date: the richest, matching how the exploratory fit chose.
const woBy = new Map();
for (const w of workouts ?? []) {
  const sets = (w.exercises ?? []).reduce((n, e) => n + (e.exercise_sets ?? []).length, 0);
  const prev = woBy.get(w.date);
  if (!prev || sets > prev.sets) woBy.set(w.date, { sets, exercises: w.exercises ?? [] });
}

const fixture = (logs ?? []).map((l) => ({
  date: l.date,
  whoop_strain: l.strain,
  resting_hr: l.resting_hr ?? 50,
  all_day_samples: allDayBy.get(l.date) ?? null,
  activities: (actsBy.get(l.date) ?? []).map((a) => ({
    external_id: a.external_id,
    started_at: a.started_at,
    duration_s: a.duration_s,
    device_id: a.device_id,
    activity_type: a.activity_type,
    hr_samples: a.hr_samples,
  })),
  exercises: (woBy.get(l.date)?.exercises ?? []).map((e) => ({
    name: e.name,
    sets: (e.exercise_sets ?? []).map((s) => ({
      kg: s.kg,
      reps: s.reps,
      warmup: s.warmup,
      rir: s.rir,
    })),
  })),
}));

mkdirSync("scripts/fixtures", { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture));

const withActivity = fixture.filter((f) => f.activities.length > 0).length;
const withTonnage = fixture.filter((f) => f.exercises.length > 0).length;
const withAllDay = fixture.filter((f) => (f.all_day_samples ?? []).length > 0).length;
console.log(`wrote ${fixture.length} labelled days → ${OUT}`);
console.log(`  with activity: ${withActivity}`);
console.log(`  with tonnage:  ${withTonnage}`);
console.log(`  with all-day HR: ${withAllDay}`);
if (fixture.length < 55) throw new Error(`expected ~61 labelled days, got ${fixture.length} — investigate before proceeding`);
