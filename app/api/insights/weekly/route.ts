import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { loadWorkouts } from "@/lib/data/workouts";
import { lastCompleteWeek, nextWeekStart } from "@/lib/coach/week";

export const dynamic = "force-dynamic";

type WeeklyRecommendation = {
  category: "training" | "sleep" | "nutrition" | "recovery" | "habits" | string;
  priority: "high" | "medium" | "low" | string;
  text: string;
};

type WeeklyReviewPayload = {
  summary: string;
  wins: { label: string; detail: string }[];
  misses: { label: string; detail: string }[];
  patterns: { label: string; detail: string }[];
  recommendations: WeeklyRecommendation[];
};

const SYSTEM = `You are an elite health and strength coach reviewing the athlete's most recent complete week. \
Speak in concrete numbers from the data. Be honest about misses. \
Return ONLY a single valid JSON object — no markdown, no prose, no commentary.`;

/** GET: most recently cached weekly review. */
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
    .eq("kind", "weekly_review")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ ok: true, cached: data ?? null });
}

/** POST: generate a fresh weekly review for the most recent complete week,
 *  cache it (keyed on week-end Sunday), and seed recommendations into
 *  coach_recommendations for the next week (replacing prior seeds). */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { start, end } = lastCompleteWeek();
  const targetWeekStart = nextWeekStart();

  const [{ data: profile }, { data: logs }, allWorkouts] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines, training_plan")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select(
        "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, strain, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, weight_kg, body_fat_pct",
      )
      .eq("user_id", user.id)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true }),
    loadWorkouts(user.id),
  ]);

  const weekWorkouts = allWorkouts
    .filter((w) => w.date >= start && w.date <= end)
    .map((w) => ({
      date: w.date,
      type: w.type,
      vol_kg: Math.round(w.vol),
      sets: w.sets,
      top: w.exercises.slice(0, 4).map((e) => ({
        name: e.name,
        best: e.sets
          .filter((s) => !s.warmup && s.kg && s.reps)
          .sort((a, b) => (b.kg ?? 0) - (a.kg ?? 0))[0],
      })),
    }));

  const userPrompt = `Athlete: ${profile?.name ?? "Athlete"}. Goal: "${profile?.goal ?? "general health"}".
Baselines: ${JSON.stringify(profile?.whoop_baselines ?? {})}.
Training plan: ${JSON.stringify(profile?.training_plan ?? {})}.

Week reviewed: ${start} → ${end} (Mon-Sun).
Daily logs (${(logs ?? []).length} days): ${JSON.stringify(logs ?? [])}.
Workouts this week: ${JSON.stringify(weekWorkouts)}.

Return JSON shaped exactly:
{
  "summary": "1 paragraph (3-5 sentences) overall assessment grounded in the numbers",
  "wins":    [{"label":"short","detail":"one sentence with numbers"}],
  "misses":  [{"label":"short","detail":"one sentence with numbers"}],
  "patterns":[{"label":"short","detail":"one sentence — repeated behaviours, correlations"}],
  "recommendations": [{"category":"training|sleep|nutrition|recovery|habits","priority":"high|medium|low","text":"one specific actionable item for the coming week"}]
}
2-4 wins. 2-4 misses. 2-4 patterns. 4-6 recommendations.
Recommendations must be concrete and measurable (e.g. "hit 8h sleep on at least 5 nights" not "sleep more").`;

  let payload: WeeklyReviewPayload;
  try {
    const raw = await callClaude([{ role: "user", content: userPrompt }], {
      system: SYSTEM,
      maxTokens: 2000,
      cacheSystem: true,
    });
    payload = parseClaudeJson<WeeklyReviewPayload>(raw);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  const sr = createSupabaseServiceRoleClient();

  const { error: insErr } = await sr.from("ai_insights").upsert(
    {
      user_id: user.id,
      generated_for_date: end,
      kind: "weekly_review",
      payload,
    },
    { onConflict: "user_id,generated_for_date,kind" },
  );
  if (insErr) return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });

  // Replace prior seeds for the target week. Existing rows the user has marked done
  // are kept — only auto-seeded rows that are still untouched (done=false) get cleared.
  await sr
    .from("coach_recommendations")
    .delete()
    .eq("user_id", user.id)
    .eq("week_start", targetWeekStart)
    .eq("done", false);

  if (payload.recommendations?.length) {
    const rows = payload.recommendations.map((r, i) => ({
      user_id: user.id,
      week_start: targetWeekStart,
      text: r.text,
      category: r.category ?? null,
      priority: r.priority ?? null,
      position: i,
    }));
    const { error: recErr } = await sr.from("coach_recommendations").insert(rows);
    if (recErr) return NextResponse.json({ ok: false, error: recErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    payload,
    week: { start, end },
    recommendationsWeek: targetWeekStart,
  });
}
