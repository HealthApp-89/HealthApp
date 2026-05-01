import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { extractBearer, resolveIngestToken } from "@/lib/ingest/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Strong CSV import.
 *
 *  Strong's export format (one row per set):
 *    Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,
 *    Distance,Seconds,Notes,Workout Notes,RPE
 *
 *  Date format is "2024-04-15 09:23:11" (local). One workout = unique
 *  (Date-day, Workout Name) tuple; sets are grouped under exercises within.
 *
 *  Auth: same ingest bearer token as Apple Health.
 *  Idempotency: workout external_id = `strong-${YYYY-MM-DD}-${slug(workoutName)}`.
 *  Re-importing replaces the workout (cascade deletes old exercises/sets).
 */

type StrongRow = {
  date: string;
  workoutName: string;
  durationMin: number | null;
  exerciseName: string;
  setOrder: number;
  weightKg: number | null;
  reps: number | null;
  distanceKm: number | null;
  durationSec: number | null;
  notes: string | null;
  workoutNotes: string | null;
};

function parseCsv(text: string): string[][] {
  // RFC 4180-ish: handles "quoted, fields with, commas" and "" escaped quotes.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].length > 0));
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function int(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** Strong durations are like "45m" or "1h 5m" — best-effort parse to minutes. */
function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  let total = 0;
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h) total += parseInt(h[1], 10) * 60;
  if (m) total += parseInt(m[1], 10);
  if (total === 0) {
    const raw = parseInt(s, 10);
    if (Number.isFinite(raw)) total = raw;
  }
  return total > 0 ? total : null;
}

export async function POST(request: Request) {
  // Accept either a bearer ingest token (Shortcut / curl) or a signed-in
  // browser session (CSV upload from the profile page).
  let userId: string | null = null;
  const raw = extractBearer(request);
  if (raw) {
    userId = await resolveIngestToken(raw, "strong");
  } else {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) userId = user.id;
  }
  if (!userId) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const ct = request.headers.get("content-type") ?? "";
  let csv: string;
  if (ct.includes("text/csv") || ct.includes("text/plain")) {
    csv = await request.text();
  } else if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "missing_file" }, { status: 400 });
    }
    csv = await file.text();
  } else {
    csv = await request.text();
  }

  const grid = parseCsv(csv);
  if (grid.length < 2) return NextResponse.json({ ok: false, error: "empty_csv" }, { status: 400 });

  const header = grid[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("date");
  const iWorkout = idx("workout name");
  const iDuration = idx("duration");
  const iExercise = idx("exercise name");
  const iSetOrder = idx("set order");
  const iWeight = idx("weight");
  const iReps = idx("reps");
  const iDistance = idx("distance");
  const iSeconds = idx("seconds");
  const iNotes = idx("notes");
  const iWorkoutNotes = idx("workout notes");
  if (iDate < 0 || iExercise < 0 || iWorkout < 0) {
    return NextResponse.json(
      { ok: false, error: "missing_required_columns" },
      { status: 400 },
    );
  }

  const parsed: StrongRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row[iDate] || !row[iExercise]) continue;
    parsed.push({
      date: row[iDate].slice(0, 10),
      workoutName: row[iWorkout]?.trim() ?? "Workout",
      durationMin: iDuration >= 0 ? parseDuration(row[iDuration]) : null,
      exerciseName: row[iExercise].trim(),
      setOrder: int(row[iSetOrder]) ?? 1,
      weightKg: iWeight >= 0 ? num(row[iWeight]) : null,
      reps: iReps >= 0 ? int(row[iReps]) : null,
      distanceKm: iDistance >= 0 ? num(row[iDistance]) : null,
      durationSec: iSeconds >= 0 ? int(row[iSeconds]) : null,
      notes: iNotes >= 0 ? row[iNotes]?.trim() || null : null,
      workoutNotes: iWorkoutNotes >= 0 ? row[iWorkoutNotes]?.trim() || null : null,
    });
  }

  if (parsed.length === 0) return NextResponse.json({ ok: true, workouts: 0, sets: 0 });

  // Group rows into workouts (date + workoutName), then exercises within each.
  const byWorkout = new Map<string, { rows: StrongRow[]; date: string; name: string }>();
  for (const r of parsed) {
    const key = `${r.date}|${r.workoutName}`;
    let w = byWorkout.get(key);
    if (!w) { w = { rows: [], date: r.date, name: r.workoutName }; byWorkout.set(key, w); }
    w.rows.push(r);
  }

  const sr = createSupabaseServiceRoleClient();
  let workoutCount = 0;
  let setCount = 0;

  // Dates touched by this import — used to evict HealthKit summary stubs that
  // the nightly Shortcut may have created (`strong-hk-<date>`). The CSV's full
  // set detail wins.
  const touchedDates = [...new Set([...byWorkout.values()].map((w) => w.date))];
  for (const d of touchedDates) {
    await sr
      .from("workouts")
      .delete()
      .eq("user_id", userId)
      .like("external_id", `strong-hk-${d}%`);
  }

  for (const [, w] of byWorkout) {
    const externalId = `strong-${w.date}-${slug(w.name)}`;

    // Replace any prior import of this workout. Cascade deletes exercises/sets.
    await sr.from("workouts").delete().eq("user_id", userId).eq("external_id", externalId);

    const durationMin =
      w.rows.find((r) => r.durationMin != null)?.durationMin ?? null;
    const notes = w.rows.find((r) => r.workoutNotes)?.workoutNotes ?? null;

    const { data: workoutInsert, error: wErr } = await sr
      .from("workouts")
      .insert({
        user_id: userId,
        external_id: externalId,
        date: w.date,
        type: w.name,
        duration_min: durationMin,
        notes,
        source: "strong",
      })
      .select("id")
      .single();
    if (wErr || !workoutInsert) {
      return NextResponse.json({ ok: false, error: wErr?.message ?? "workout_insert_failed" }, { status: 500 });
    }
    workoutCount++;

    // Group sets by exercise, preserving first-seen order.
    const exerciseOrder: string[] = [];
    const byExercise = new Map<string, StrongRow[]>();
    for (const r of w.rows) {
      if (!byExercise.has(r.exerciseName)) {
        exerciseOrder.push(r.exerciseName);
        byExercise.set(r.exerciseName, []);
      }
      byExercise.get(r.exerciseName)!.push(r);
    }

    for (let pos = 0; pos < exerciseOrder.length; pos++) {
      const name = exerciseOrder[pos];
      const sets = byExercise.get(name)!;
      const { data: exIns, error: eErr } = await sr
        .from("exercises")
        .insert({ workout_id: workoutInsert.id, name, position: pos })
        .select("id")
        .single();
      if (eErr || !exIns) {
        return NextResponse.json({ ok: false, error: eErr?.message ?? "exercise_insert_failed" }, { status: 500 });
      }

      const setRows = sets.map((s, i) => ({
        exercise_id: exIns.id,
        set_index: s.setOrder ?? i + 1,
        kg: s.weightKg,
        reps: s.reps,
        duration_seconds: s.durationSec,
        warmup: false,
        failure: false,
      }));
      if (setRows.length > 0) {
        const { error: sErr } = await sr.from("exercise_sets").insert(setRows);
        if (sErr) return NextResponse.json({ ok: false, error: sErr.message }, { status: 500 });
        setCount += setRows.length;
      }
    }
  }

  return NextResponse.json({ ok: true, workouts: workoutCount, sets: setCount });
}
