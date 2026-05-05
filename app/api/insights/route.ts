import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { buildSnapshotText } from "@/lib/coach/snapshot";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

type Insight = { priority: "high" | "medium" | "low"; category: string; title: string; body: string };
type Pattern = { label: string; detail: string };
type Plan = { week: string; today: string; tomorrow: string; note: string };
type CoachPayload = { insights: Insight[]; patterns: Pattern[]; plan: Plan };

const SYSTEM = `You are an elite health and strength coach. You speak in concrete numbers. \
Return ONLY a single valid JSON object — no markdown, no prose, no commentary.`;

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
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

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const today = todayInUserTz();
  const snapshot = await buildSnapshotText({ userId: user.id });

  const userPrompt = `${snapshot}

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

  const sr = createSupabaseServiceRoleClient();
  const { error } = await sr.from("ai_insights").upsert(
    { user_id: user.id, generated_for_date: today, kind: "coach", payload },
    { onConflict: "user_id,generated_for_date,kind" },
  );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, payload });
}
