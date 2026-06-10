// lib/coach/opener.ts
//
// Generates the "opening message" that lands in /coach when the user opens
// the chat for the first time on a given day. The default empty state used
// to be a generic "Message your coach…" placeholder with four mostly-disabled
// suggestion chips. A real coach opens with what they noticed — yesterday's
// session adherence, today's readiness band, the current block phase — and
// invites the athlete to pick up the thread.
//
// Single Haiku call, ~80-120 input tokens of context, capped at 90 output
// tokens. Idempotent at the route layer: only generated when no coach-kind
// message exists for the user today.

import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import type { DailyLog } from "@/lib/data/types";

const MODEL = SHORT_FORM_MODEL;
const MAX_TOKENS = 90;
const TEMPERATURE = 0.6; // a touch warmer than advice/narrative — this is greeting register

const SYSTEM_PROMPT = `You are this athlete's coach opening the day's chat. Write a single short opening — 1-2 sentences, max 30 words total.

Tone:
- Second person. "You" not "the athlete".
- Direct, warm, concrete. No "Hello," no "Hope you're doing well." Coaches don't greet with filler.
- Reference ONE specific signal from the context. Either yesterday's session, today's readiness, or this week's progress — never all three.
- End with an open question or an explicit invitation ("Want to talk through X?", "Anything on your mind?"). The opener exists to invite a response.

Forbidden:
- Filler salutations.
- Listing multiple metrics. Pick one.
- Hypothetical numbers — if a value isn't in the context, don't mention that domain.
- Markdown. Plain text only.

Output ONLY the opener text. No preamble, no quotes.`;

export type OpenerContext = {
  todayLog: Pick<DailyLog, "recovery" | "hrv" | "sleep_hours" | "strain"> | null;
  yesterdayLog: Pick<DailyLog, "recovery" | "sleep_hours" | "calories_eaten" | "protein_g"> | null;
  yesterdayPlanned: string | null;
  yesterdayTrained: string | null;
  activeBlockGoal: string | null;
  activeBlockPhaseWeek: number | null;
};

export async function fetchOpenerContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<OpenerContext> {
  const tz = await getUserTimezone(userId);
  const today = todayInUserTz(new Date(), tz);
  const yesterday = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const weekStart = mondayOf(today);

  const [todayLogRes, yesterdayLogRes, blockRes, weekRes, yesterdayWorkoutRes] = await Promise.all([
    supabase
      .from("daily_logs")
      .select("recovery, hrv, sleep_hours, strain")
      .eq("user_id", userId)
      .eq("date", today)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("recovery, sleep_hours, calories_eaten, protein_g")
      .eq("user_id", userId)
      .eq("date", yesterday)
      .maybeSingle(),
    supabase
      .from("training_blocks")
      .select("goal_text, start_date")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("training_weeks")
      .select("session_plan")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle(),
    supabase
      .from("workouts")
      .select("session_type")
      .eq("user_id", userId)
      .eq("date", yesterday)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let blockPhaseWeek: number | null = null;
  let blockGoal: string | null = null;
  if (blockRes.data) {
    blockGoal = (blockRes.data as { goal_text: string | null }).goal_text ?? null;
    const start = (blockRes.data as { start_date: string }).start_date;
    if (start) {
      const days = Math.floor(
        (new Date(today + "T00:00:00Z").getTime() - new Date(start + "T00:00:00Z").getTime()) /
          86400000,
      );
      blockPhaseWeek = Math.floor(days / 7) + 1;
    }
  }

  let yesterdayPlanned: string | null = null;
  if (weekRes.data) {
    const plan = (weekRes.data as { session_plan: Record<string, string> }).session_plan ?? {};
    const dow = new Date(yesterday + "T12:00:00Z").getUTCDay();
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    yesterdayPlanned = plan[names[dow]] ?? null;
  }

  return {
    todayLog: todayLogRes.data ?? null,
    yesterdayLog: yesterdayLogRes.data ?? null,
    yesterdayPlanned,
    yesterdayTrained: yesterdayWorkoutRes.data
      ? (yesterdayWorkoutRes.data as { session_type: string }).session_type
      : null,
    activeBlockGoal: blockGoal,
    activeBlockPhaseWeek: blockPhaseWeek,
  };
}

function renderContextBlock(ctx: OpenerContext): string {
  const lines: string[] = [];
  if (ctx.activeBlockGoal && ctx.activeBlockPhaseWeek != null) {
    lines.push(
      `BLOCK: week ${ctx.activeBlockPhaseWeek} of "${ctx.activeBlockGoal}"`,
    );
  }
  if (ctx.todayLog) {
    const parts: string[] = [];
    if (ctx.todayLog.recovery != null) parts.push(`recovery ${ctx.todayLog.recovery}%`);
    if (ctx.todayLog.hrv != null) parts.push(`HRV ${ctx.todayLog.hrv}ms`);
    if (ctx.todayLog.sleep_hours != null) parts.push(`slept ${ctx.todayLog.sleep_hours}h`);
    if (parts.length > 0) lines.push(`TODAY: ${parts.join(", ")}`);
  }
  if (ctx.yesterdayLog || ctx.yesterdayTrained || ctx.yesterdayPlanned) {
    const parts: string[] = [];
    if (ctx.yesterdayPlanned && ctx.yesterdayTrained) {
      const match = ctx.yesterdayPlanned === ctx.yesterdayTrained;
      parts.push(
        match
          ? `trained ${ctx.yesterdayTrained} as planned`
          : `planned ${ctx.yesterdayPlanned}, trained ${ctx.yesterdayTrained}`,
      );
    } else if (ctx.yesterdayPlanned && !ctx.yesterdayTrained) {
      parts.push(`planned ${ctx.yesterdayPlanned}, no session logged`);
    } else if (ctx.yesterdayTrained) {
      parts.push(`trained ${ctx.yesterdayTrained}`);
    }
    if (ctx.yesterdayLog?.protein_g != null) parts.push(`${ctx.yesterdayLog.protein_g}g protein`);
    if (ctx.yesterdayLog?.calories_eaten != null) parts.push(`${ctx.yesterdayLog.calories_eaten} kcal`);
    if (parts.length > 0) lines.push(`YESTERDAY: ${parts.join(", ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no recent data)";
}

export async function generateOpener(ctx: OpenerContext): Promise<string> {
  const userMessage = `Context:\n${renderContextBlock(ctx)}\n\nWrite the opener.`;
  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    { model: MODEL, system: SYSTEM_PROMPT, maxTokens: MAX_TOKENS, temperature: TEMPERATURE },
  );
  return result.trim();
}
