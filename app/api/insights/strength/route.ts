import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { loadWorkouts } from "@/lib/data/workouts";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

type ExerciseAdvice = {
  category: string; // Chest/Back/Legs/Shoulders/Arms
  priority: "high" | "medium" | "low";
  sessions: number;
  next_target: string;
  recommendation: string;
};
type StrengthPayload = {
  summary: { total_sessions: number; total_exercises_tracked: number; weeks: number };
  exercises: Record<string, ExerciseAdvice>;
};

const SYSTEM = `You are an elite strength coach. Return ONLY one valid JSON object, no markdown.`;

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const { data } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", user.id)
    .eq("kind", "strength")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({ ok: true, cached: data ?? null });
}

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const workouts = await loadWorkouts(user.id);
  if (!workouts.length) {
    return NextResponse.json({ ok: false, error: "No workouts to analyse" }, { status: 400 });
  }

  // Build a compact per-exercise history. Bodyweight sets are tagged with
  // `bw: true` so the model knows to track reps rather than kg.
  const byEx = new Map<
    string,
    { date: string; sets: { kg: number | null; reps: number | null; bw: boolean; failure: boolean }[] }[]
  >();
  for (const w of workouts) {
    for (const e of w.exercises) {
      const prev = byEx.get(e.name) ?? [];
      prev.push({
        date: w.date,
        sets: e.sets
          .filter((s) => !s.warmup && (s.kg || s.reps))
          .map((s) => ({ kg: s.kg, reps: s.reps, bw: !s.kg, failure: s.failure })),
      });
      byEx.set(e.name, prev);
    }
  }
  const compact = [...byEx.entries()].map(([name, sessions]) => ({
    name,
    sessions: sessions.sort((a, b) => a.date.localeCompare(b.date)),
  }));

  const userPrompt = `Per-exercise history for an intermediate lifter (BW ~105kg, age 36, 2 weeks of data).
Sets with \`bw: true\` are bodyweight; track progress in reps, not kg.
${JSON.stringify(compact, null, 2)}

For EACH exercise produce a recommendation. Output JSON:
{
  "summary": {"total_sessions": <int>, "total_exercises_tracked": <int>, "weeks": <int>},
  "exercises": {
    "<name>": {
      "category": "Chest|Back|Legs|Shoulders|Arms|Core|Cardio",
      "priority": "high|medium|low",
      "sessions": <int>,
      "next_target": "<kg> × <reps>×<sets>, or '<reps>×<sets>' for bodyweight, or 'Skip' / specific cue",
      "recommendation": "2-3 sentences with numbers, comparing W1 vs W2 where possible. Reference est 1RM for weighted lifts; reference total reps for bodyweight."
    }
  }
}
Categorise compound barbell lifts as priority high. Isolation accessories medium. Bodyweight warm-ups low.`;

  let payload: StrengthPayload;
  let rawResponse = "";
  try {
    rawResponse = await callClaude([{ role: "user", content: userPrompt }], {
      system: SYSTEM,
      maxTokens: 4000,
      cacheSystem: true,
    });
    const parsed = parseClaudeJson<unknown>(rawResponse);
    payload = normaliseStrengthPayload(parsed);
  } catch (e) {
    // Log the raw Claude response so we can see what shape came back when this
    // fails again — Vercel function logs only.
    console.error("strength-coach parse failed", { error: String(e), raw: rawResponse.slice(0, 2000) });
    return NextResponse.json(
      { ok: false, error: `Coach response was unparseable. Try again in a moment. (${String(e)})` },
      { status: 502 },
    );
  }

  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();
  const { error } = await sr.from("ai_insights").upsert(
    {
      user_id: user.id,
      generated_for_date: today,
      kind: "strength",
      payload,
    },
    { onConflict: "user_id,generated_for_date,kind" },
  );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, payload });
}

const ALLOWED_PRIORITIES = new Set(["high", "medium", "low"]);
const ALLOWED_CATEGORIES = new Set([
  "Chest", "Back", "Legs", "Shoulders", "Arms", "Core", "Cardio", "Other",
]);

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return ""; }
}

function asInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Coerce an arbitrary parsed-JSON value into a valid `StrengthPayload`. We
 *  accept whatever shape Claude returns (object fields, missing fields, wrong
 *  types) and normalise it to plain strings/numbers so the renderer never
 *  hits an "Objects are not valid as a React child" exception. Throws if the
 *  payload has no usable exercises at all — caller will retry/error. */
function normaliseStrengthPayload(input: unknown): StrengthPayload {
  if (!input || typeof input !== "object") {
    throw new Error("payload is not an object");
  }
  const obj = input as Record<string, unknown>;
  const summarySrc = (obj.summary && typeof obj.summary === "object" ? obj.summary : {}) as Record<string, unknown>;
  const exercisesSrc =
    obj.exercises && typeof obj.exercises === "object" && !Array.isArray(obj.exercises)
      ? (obj.exercises as Record<string, unknown>)
      : {};

  const exercises: Record<string, ExerciseAdvice> = {};
  for (const [name, raw] of Object.entries(exercisesSrc)) {
    if (!name) continue;
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const category = asString(e.category) || "Other";
    const priority = asString(e.priority).toLowerCase();
    exercises[name] = {
      category: ALLOWED_CATEGORIES.has(category) ? category : "Other",
      priority: (ALLOWED_PRIORITIES.has(priority) ? priority : "medium") as ExerciseAdvice["priority"],
      sessions: asInt(e.sessions),
      next_target: asString(e.next_target),
      recommendation: asString(e.recommendation),
    };
  }

  if (Object.keys(exercises).length === 0) {
    throw new Error("payload has no exercises");
  }

  return {
    summary: {
      total_sessions: asInt(summarySrc.total_sessions),
      total_exercises_tracked: asInt(summarySrc.total_exercises_tracked),
      weeks: asInt(summarySrc.weeks),
    },
    exercises,
  };
}
