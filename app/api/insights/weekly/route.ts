import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { buildSnapshot, withDayReferenceInstruction } from "@/lib/coach/snapshot";
import { reviewWindow, recommendationWeekStart, type ReviewMode } from "@/lib/coach/week";
import { REVIEW_SYSTEM_PROMPT, REVIEW_RESPONSE_SHAPE, frameFor } from "@/lib/coach/prompts";
import { todayInUserTz } from "@/lib/time";

function userTzNoon(): Date {
  return new Date(`${todayInUserTz()}T12:00:00Z`);
}

export const dynamic = "force-dynamic";

type WeeklyRecommendation = {
  category: "training" | "sleep" | "nutrition" | "recovery" | "habits" | string;
  priority: "high" | "medium" | "low" | string;
  text: string;
};

export type WeeklyReviewPayload = {
  summary: string;
  patterns: { label: string; detail: string }[];
  recommendationsHeadline?: string;
  recommendations: WeeklyRecommendation[];
  mode?: ReviewMode;
  /** Legacy fields — older cached payloads may still have these. */
  wins?: { label: string; detail: string }[];
  misses?: { label: string; detail: string }[];
};

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

/** POST: generate a fresh review for the day-appropriate window
 *  (see lib/coach/week.ts:reviewWindow), cache it, and seed
 *  recommendations into coach_recommendations. */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const anchor = userTzNoon();
  const { start, end, mode, daysRemaining } = reviewWindow(anchor);
  const targetWeekStart = recommendationWeekStart(anchor);

  const { nowLine, body: snapshotBody } = await buildSnapshot({
    supabase,
    userId: user.id,
    since: start,
    until: end,
  });

  const frame = frameFor(mode, { start, end, daysRemaining, targetWeekStart });

  const userPrompt = `${nowLine}

${snapshotBody}

${frame.windowLine}
Tone: ${frame.toneHint}

${frame.recsFraming}

${REVIEW_RESPONSE_SHAPE}`;

  const systemWithDayRef = withDayReferenceInstruction(REVIEW_SYSTEM_PROMPT);

  let payload: WeeklyReviewPayload;
  try {
    const raw = await callClaude([{ role: "user", content: userPrompt }], {
      system: systemWithDayRef,
      maxTokens: 2000,
      cacheSystem: true,
    });
    payload = parseClaudeJson<WeeklyReviewPayload>(raw);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  payload.mode = mode;

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
    window: { start, end, mode, daysRemaining },
    recommendationsWeek: targetWeekStart,
  });
}
