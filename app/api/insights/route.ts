import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { loadWorkouts } from "@/lib/data/workouts";

export const dynamic = "force-dynamic";

type Insight = { priority: "high" | "medium" | "low"; category: string; title: string; body: string };
type Pattern = { label: string; detail: string };
type Plan = { week: string; today: string; tomorrow: string; note: string };
type CoachPayload = { insights: Insight[]; patterns: Pattern[]; plan: Plan };

const SYSTEM = `You are an elite health and strength coach. You speak in concrete numbers. \
Return ONLY a single valid JSON object — no markdown, no prose, no commentary.`;

/** GET: return the most recently cached coach payload (or null). */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date, created_at")
    .eq("user_id", user.id)
    .eq("kind", "coach")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ ok: true, cached: data ?? null });
}

/** POST: generate fresh coach insights from the last 14 days, cache by today's date. */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  // Pull data
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [{ data: profile }, { data: logs }, workouts] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines, training_plan")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories, weight_kg, protein_g, carbs_g, fat_g")
      .eq("user_id", user.id)
      .gte("date", since)
      .order("date", { ascending: true }),
    loadWorkouts(user.id),
  ]);

  const recentWorkouts = workouts.slice(0, 5).map((w) => ({
    date: w.date,
    type: w.type,
    vol_kg: Math.round(w.vol),
    sets: w.sets,
    top: w.exercises.slice(0, 4).map((e) => ({
      name: e.name,
      best: e.sets
        .filter((s) => !s.warmup && s.kg && s.reps)
        .sort((a, b) => (b.kg! - a.kg!))[0],
    })),
  }));

  const userPrompt = `Athlete: ${profile?.name ?? "Athlete"}. Goal: "${profile?.goal ?? "general health"}".
Baselines: ${JSON.stringify(profile?.whoop_baselines ?? {})}.
Training plan: ${JSON.stringify(profile?.training_plan ?? {})}.

Last 14 days (daily_logs): ${JSON.stringify(logs ?? [])}.
Recent 5 workouts: ${JSON.stringify(recentWorkouts)}.

Return JSON shaped exactly:
{
  "insights": [{"priority":"high|medium|low","category":"string","title":"max 8 words","body":"2-3 sentences with numbers"}],
  "patterns": [{"label":"short","detail":"one sentence"}],
  "plan": {"week":"label","today":"specific action","tomorrow":"specific action","note":"1 line"}
}
3-6 insights. 2-4 patterns. The plan must reference specific kg/reps/sleep/macro numbers from the data.`;

  let payload: CoachPayload;
  try {
    const raw = await callClaude([{ role: "user", content: userPrompt }], {
      system: SYSTEM,
      maxTokens: 1500,
      cacheSystem: true,
    });
    payload = parseClaudeJson<CoachPayload>(raw);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  // Cache via service-role
  const sr = createSupabaseServiceRoleClient();
  const { error } = await sr.from("ai_insights").upsert(
    {
      user_id: user.id,
      generated_for_date: today,
      kind: "coach",
      payload,
    },
    { onConflict: "user_id,generated_for_date,kind" },
  );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, payload });
}
