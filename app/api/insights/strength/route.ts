import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { loadWorkouts } from "@/lib/data/workouts";

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

  // Build a compact per-exercise history
  const byEx = new Map<string, { date: string; sets: { kg: number | null; reps: number | null; failure: boolean }[] }[]>();
  for (const w of workouts) {
    for (const e of w.exercises) {
      const prev = byEx.get(e.name) ?? [];
      prev.push({
        date: w.date,
        sets: e.sets
          .filter((s) => !s.warmup && (s.kg || s.reps))
          .map((s) => ({ kg: s.kg, reps: s.reps, failure: s.failure })),
      });
      byEx.set(e.name, prev);
    }
  }
  const compact = [...byEx.entries()].map(([name, sessions]) => ({
    name,
    sessions: sessions.sort((a, b) => a.date.localeCompare(b.date)),
  }));

  const userPrompt = `Per-exercise history for an intermediate lifter (BW ~105kg, age 36, 2 weeks of data).
${JSON.stringify(compact, null, 2)}

For EACH exercise produce a recommendation. Output JSON:
{
  "summary": {"total_sessions": <int>, "total_exercises_tracked": <int>, "weeks": <int>},
  "exercises": {
    "<name>": {
      "category": "Chest|Back|Legs|Shoulders|Arms|Core|Cardio",
      "priority": "high|medium|low",
      "sessions": <int>,
      "next_target": "<kg> × <reps>×<sets> or 'Skip' / specific cue",
      "recommendation": "2-3 sentences with numbers, comparing W1 vs W2 where possible. Reference est 1RM if useful."
    }
  }
}
Categorise compound barbell lifts as priority high. Isolation accessories medium. Bodyweight warm-ups low.`;

  let payload: StrengthPayload;
  try {
    const raw = await callClaude([{ role: "user", content: userPrompt }], {
      system: SYSTEM,
      maxTokens: 4000,
      cacheSystem: true,
    });
    payload = parseClaudeJson<StrengthPayload>(raw);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
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
