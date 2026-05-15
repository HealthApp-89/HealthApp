#!/usr/bin/env node
// scripts/audit-weekly-review-composers.mjs
//
// Read-only diagnostic that prints the inputs the weekly-review composers
// will consume for a given Monday-anchored week: workouts (with nested
// exercises + exercise_sets) and daily_logs. Use after Slice 2 to verify
// the data the composers will see is present and shaped correctly before
// the orchestrator (Slice 3) wires them together.
//
// Defaults to the previous-Monday week_start; accepts an override via argv[2].
//
// Usage:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
//     scripts/audit-weekly-review-composers.mjs [YYYY-MM-DD]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// .env.local has values like postgres://... with special chars; the supabase
// CLI parser chokes on it, so read it directly.
const envPath = resolve(repoRoot, ".env.local");
const env = {};
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function endOfWeek(mondayYmd) {
  const d = new Date(mondayYmd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// Default = previous Monday (Mon=1 … Sun=7).
const today = new Date();
const dow = today.getUTCDay() || 7;
const lastMon = new Date(today);
lastMon.setUTCDate(today.getUTCDate() - (dow - 1) - 7);
const defaultWeekStart = lastMon.toISOString().slice(0, 10);
const weekStart = process.argv[2] ?? defaultWeekStart;
const weekEnd = endOfWeek(weekStart);

console.log(`\nAuditing composers for week_start=${weekStart} (through ${weekEnd})\n`);

const { data: profile, error: profileErr } = await sb
  .from("profiles")
  .select("user_id")
  .order("created_at", { ascending: true })
  .limit(1)
  .single();
if (profileErr || !profile) {
  console.error("No profile found.", profileErr);
  process.exit(1);
}
const userId = profile.user_id;

// ── workouts ────────────────────────────────────────────────────────────────
// workouts is normalized: workouts → exercises → exercise_sets.
// Composer consumers flatten nested sets via:
//   w.exercises?.flatMap((e) => e.sets ?? []).length ?? 0
const { data: workouts, error: workoutsErr } = await sb
  .from("workouts")
  .select("id, date, type, notes, exercises (name, sets:exercise_sets (kg, reps, warmup))")
  .eq("user_id", userId)
  .gte("date", weekStart)
  .lte("date", weekEnd)
  .order("date", { ascending: true });
if (workoutsErr) {
  console.error("workouts query failed:", workoutsErr);
  process.exit(1);
}
console.log(`Workouts in window: ${workouts?.length ?? 0}`);
for (const w of workouts ?? []) {
  const setCount = w.exercises?.flatMap((e) => e.sets ?? []).length ?? 0;
  const exCount = w.exercises?.length ?? 0;
  console.log(
    `  ${w.date} ${w.type ?? "(no type)"}  exercises=${exCount}  sets=${setCount}  note?=${!!w.notes}`,
  );
}

// ── daily_logs ──────────────────────────────────────────────────────────────
// Column is `date`, not `day`. There's no `sleep_efficiency` column on this
// table — `sleep_score` is the closest proxy used by composers.
const { data: logs, error: logsErr } = await sb
  .from("daily_logs")
  .select("date, sleep_hours, sleep_score, calories_eaten, protein_g, weight_kg")
  .eq("user_id", userId)
  .gte("date", weekStart)
  .lte("date", weekEnd)
  .order("date", { ascending: true });
if (logsErr) {
  console.error("daily_logs query failed:", logsErr);
  process.exit(1);
}
console.log(`\nDaily logs: ${logs?.length ?? 0}`);
for (const l of logs ?? []) {
  console.log(
    `  ${l.date}  sleep=${l.sleep_hours ?? "—"}h  score=${l.sleep_score ?? "—"}  kcal=${l.calories_eaten ?? "—"}  P=${l.protein_g ?? "—"}g  wt=${l.weight_kg ?? "—"}kg`,
  );
}

console.log();
