// One-shot import: takes scripts/seed-data.json (extracted from the prototype)
// and writes profile + daily_logs + workouts/exercises/exercise_sets into Supabase.
// Run with: node scripts/import-seed.mjs
//
// Idempotent: uses upsert on (user_id, date) for daily_logs; deletes any existing
// workouts on the same dates before re-inserting (so re-runs don't duplicate).

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userEmail = process.env.SEED_USER_EMAIL || "abdelouahed.elbied@icloud.com";

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// ── Find user ────────────────────────────────────────────────────────────────
const { data: usersList, error: listErr } = await supabase.auth.admin.listUsers({
  page: 1,
  perPage: 200,
});
if (listErr) throw listErr;
const user = usersList.users.find((u) => u.email?.toLowerCase() === userEmail.toLowerCase());
if (!user) {
  console.error(`No auth user found with email ${userEmail}. Sign up first.`);
  process.exit(1);
}
const userId = user.id;
console.log(`Importing for user ${userEmail} (${userId})`);

// ── Load seed ────────────────────────────────────────────────────────────────
const seedRaw = await readFile(new URL("./seed-data.json", import.meta.url), "utf8");
const seed = JSON.parse(seedRaw);

// ── Helpers ──────────────────────────────────────────────────────────────────
function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

// Parse macros + recovery + calories_eaten out of free-form notes (Yazio + WHOOP screenshots)
function parseNotes(notes) {
  if (!notes) return {};
  const out = {};
  const m = (re) => notes.match(re)?.[1];
  // "Recovery 76%" → 76
  const rec = m(/Recovery\s+(\d+(?:\.\d+)?)\s*%/i);
  if (rec) out.recovery = parseFloat(rec);
  // "Eaten 2050 kcal"
  const eaten = m(/Eaten\s+(\d+(?:\.\d+)?)\s*kcal/i);
  if (eaten) out.calories_eaten = Math.round(parseFloat(eaten));
  // "Protein 159g/162g"
  const prot = m(/Protein\s+(\d+(?:\.\d+)?)g/i);
  if (prot) out.protein_g = parseFloat(prot);
  // "Carbs 194g/178g"
  const carb = m(/Carbs?\s+(\d+(?:\.\d+)?)g/i);
  if (carb) out.carbs_g = parseFloat(carb);
  // "Fat 70g/74g"
  const fat = m(/Fat\s+(\d+(?:\.\d+)?)g/i);
  if (fat) out.fat_g = parseFloat(fat);
  // "Resp Rate 17.3"
  const resp = m(/Resp(?:iratory)? Rate\s+(\d+(?:\.\d+)?)/i);
  if (resp) out.respiratory_rate = parseFloat(resp);
  return out;
}

// ── Profile ──────────────────────────────────────────────────────────────────
const p = seed.profile || {};
{
  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: userId,
      name: p.name ?? null,
      age: intOrNull(p.age),
      height_cm: num(p.height),
      goal: p.goal ?? null,
      whoop_baselines: p.whoop_baselines ?? null,
      training_plan: p.training_plan ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  console.log("✓ profile upserted");
}

// ── Daily logs ───────────────────────────────────────────────────────────────
const logs = seed.logs || [];
const dlRows = logs.map((l) => {
  const extras = parseNotes(l.notes);
  return {
    user_id: userId,
    date: l.date,
    hrv: num(l.hrv),
    resting_hr: num(l.restingHR),
    sleep_hours: num(l.sleepHours),
    sleep_score: num(l.sleepScore),
    deep_sleep_hours: num(l.deepSleep),
    rem_sleep_hours: num(l.remSleep),
    strain: num(l.strain),
    recovery: extras.recovery ?? null,
    steps: intOrNull(l.steps),
    calories: extras.calories_eaten ?? intOrNull(l.calories),
    calories_eaten: extras.calories_eaten ?? null,
    protein_g: extras.protein_g ?? null,
    carbs_g: extras.carbs_g ?? null,
    fat_g: extras.fat_g ?? null,
    respiratory_rate: extras.respiratory_rate ?? null,
    weight_kg: num(l.weight),
    body_fat_pct: num(l.bodyFat),
    spo2: num(l.spO2),
    skin_temp_c: num(l.skinTemp),
    notes: l.notes ?? null,
    source: l._source ?? "seed",
    updated_at: new Date().toISOString(),
  };
});
{
  const { error } = await supabase
    .from("daily_logs")
    .upsert(dlRows, { onConflict: "user_id,date" });
  if (error) throw error;
  console.log(`✓ daily_logs upserted: ${dlRows.length}`);
}

// ── Workouts (delete existing then insert) ───────────────────────────────────
const dates = logs.filter((l) => l._workout).map((l) => l.date);
if (dates.length) {
  const { error: delErr } = await supabase
    .from("workouts")
    .delete()
    .eq("user_id", userId)
    .in("date", dates);
  if (delErr) throw delErr;
  console.log(`✓ deleted prior workouts on ${dates.length} dates`);
}

let totalEx = 0;
let totalSets = 0;
for (const l of logs) {
  if (!l._workout) continue;
  const w = l._workout;
  const { data: workout, error: werr } = await supabase
    .from("workouts")
    .insert({
      user_id: userId,
      date: l.date,
      type: w.type ?? null,
      duration_min: w.duration ?? null,
      notes: l.notes ?? null,
      source: l._source ?? "seed",
    })
    .select("id")
    .single();
  if (werr) throw werr;
  const exercises = w.exercises || [];
  for (let i = 0; i < exercises.length; i++) {
    const e = exercises[i];
    const { data: exRow, error: eerr } = await supabase
      .from("exercises")
      .insert({ workout_id: workout.id, name: e.name, position: i })
      .select("id")
      .single();
    if (eerr) throw eerr;
    totalEx += 1;
    const sets = (e.sets || []).map((s, idx) => ({
      exercise_id: exRow.id,
      set_index: idx,
      kg: s.kg ?? null,
      reps: s.reps ?? null,
      duration_seconds: s.duration ?? null,
      warmup: !!s.warmup,
      failure: !!s.failure,
    }));
    if (sets.length) {
      const { error: serr } = await supabase.from("exercise_sets").insert(sets);
      if (serr) throw serr;
      totalSets += sets.length;
    }
  }
}
console.log(`✓ workouts: ${dates.length}, exercises: ${totalEx}, sets: ${totalSets}`);
console.log("Done.");
