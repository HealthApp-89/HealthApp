// app/api/chat/morning/recommendation/route.ts
//
// POST: deliver today's coach recommendation as the next assistant message
// in the morning_intake thread. Idempotent on (user, date) — if state is
// already 'delivered', returns 409.
//
// Body: {} | {skip_whoop: true}  -- skip_whoop generates a feel-only plan.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import { buildDailyPlan, type FeelInput } from "@/lib/coach/readiness";
import type { CheckinRow, DailyLog } from "@/lib/data/types";
import { formatSseEvent } from "@/lib/chat/sse";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-5";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { skip_whoop?: boolean };
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();
  if (!row) return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  if (row.intake_state === "delivered") {
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  const { data: log } = await sr
    .from("daily_logs")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<DailyLog>();

  // ── sick path: templated REST, no LLM ───────────────────────────────────────
  if (row.sick) {
    return await deliverTemplated(sr, user.id,
      "REST mode locked in. Hydrate, eat clean, get extra sleep tonight. " +
      "I'll check on you in the morning.");
  }

  // For awaiting_whoop with no log/recovery and no skip flag, return 425
  // (Too Early) so the client knows to park and retry.
  if (!body.skip_whoop && (!log || log.recovery == null)) {
    // Mark intake_state='awaiting_whoop' if not already.
    if (row.intake_state !== "awaiting_whoop") {
      await sr.from("checkins").upsert(
        { user_id: user.id, date: today, intake_state: "awaiting_whoop" },
        { onConflict: "user_id,date" },
      );
    }
    return NextResponse.json({ ok: false, reason: "awaiting_whoop" }, { status: 425 });
  }

  // ── healthy path: Claude renders the plan ───────────────────────────────────
  // At this point either skip_whoop is true OR log+recovery are present (the 425 guard above ruled out the missing-WHOOP-without-skip case).
  const useSkipPath = !!body.skip_whoop;
  const feel: FeelInput = {
    readiness: row.readiness,
    energyLabel: row.energy_label,
    mood: row.mood,
    soreness: row.soreness,
    notes: row.feel_notes,
    sick: row.sick,
    fatigue: row.fatigue,
    sorenessAreas: row.soreness_areas,
    sorenessSeverity: row.soreness_severity,
  };
  const plan = buildDailyPlan(log, feel);

  return await deliverWithClaude(sr, user.id, {
    plan,
    feel,
    log,
    skipWhoop: useSkipPath,
  });
}

async function deliverTemplated(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  content: string,
) {
  const today = todayInUserTz();
  const { data: msg, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: userId,
      role: "assistant",
      content,
      status: "done",
      kind: "morning_intake",
      ui: null,
    })
    .select("id")
    .single();
  if (insertErr || !msg) {
    return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 });
  }
  const { error: upsertErr } = await sr.from("checkins").upsert(
    { user_id: userId, date: today, intake_state: "delivered" },
    { onConflict: "user_id,date" },
  );
  if (upsertErr) {
    return NextResponse.json({ ok: false, reason: "state_upsert_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, message_id: msg.id });
}

async function deliverWithClaude(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  args: {
    plan: ReturnType<typeof buildDailyPlan>;
    feel: FeelInput;
    log: DailyLog | null;
    skipWhoop: boolean;
  },
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, reason: "no_api_key" }, { status: 500 });

  const client = new Anthropic({ apiKey });
  const today = todayInUserTz();
  const encoder = new TextEncoder();

  const { data: stub } = await sr
    .from("chat_messages")
    .insert({
      user_id: userId,
      role: "assistant",
      content: "",
      status: "streaming",
      kind: "morning_intake",
      ui: null,
      model: MODEL,
    })
    .select("id")
    .single();
  if (!stub) return NextResponse.json({ ok: false, reason: "stub_failed" }, { status: 500 });

  const planJson = JSON.stringify({
    readiness_score: args.plan.readiness.score,
    mode: args.plan.mode.label,
    mode_desc: args.plan.mode.desc,
    multiplier: args.plan.mode.multiplier,
    session_type: args.plan.sessionType,
    exercises: args.plan.exercises.map((e) => ({
      name: e.name,
      target: e.target,
      adjusted: e.adjusted,
      isPRAttempt: e.isPRAttempt,
    })),
  });

  const feelForPrompt = {
    readiness: args.feel.readiness,
    energyLabel: args.feel.energyLabel,
    mood: args.feel.mood,
    notes: args.feel.notes,
    sick: args.feel.sick,
    fatigue: args.feel.fatigue,
    sorenessAreas: args.feel.sorenessAreas,
    sorenessSeverity: args.feel.sorenessSeverity,
  };

  const sys = `You are the athlete's coach delivering today's morning recommendation. Plan was computed from WHOOP + their morning check-in:

${planJson}

Their feel: ${JSON.stringify(feelForPrompt)}
Today's WHOOP: ${args.log ? `recovery=${args.log.recovery}, hrv=${args.log.hrv}, sleep_score=${args.log.sleep_score}, strain=${args.log.strain}` : "not synced"}
${args.skipWhoop ? "NOTE: WHOOP data unavailable — use feel + last 7 days for the plan. Mention this caveat once." : ""}

Render the plan conversationally as 3-5 short lines:
1. Open with a 1-line readiness summary tied to a specific number (HRV, recovery, or feel score).
2. State the intensity mode in plain words.
3. Call out 1-2 specific exercise adjustments from the plan (use exact numbers from "exercises").
4. End with one actionable cue.

Speak in concrete numbers — kg, reps, %, ms. No "around"/"roughly". Don't repeat the JSON; reference fields naturally.`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const apiStream = client.messages.stream({
          model: MODEL,
          max_tokens: 600,
          system: sys,
          messages: [{ role: "user", content: "Give me today's plan." }],
        });

        let assembled = "";
        for await (const ev of apiStream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            assembled += ev.delta.text;
            controller.enqueue(encoder.encode(formatSseEvent({
              event: "delta", data: { text: ev.delta.text },
            })));
          }
        }

        const { error: updateErr } = await sr
          .from("chat_messages")
          .update({ content: assembled, status: "done" })
          .eq("id", stub.id);
        if (updateErr) throw new Error(`finalize_failed: ${updateErr.message}`);

        const { error: stateErr } = await sr.from("checkins").upsert(
          { user_id: userId, date: today, intake_state: "delivered" },
          { onConflict: "user_id,date" },
        );
        if (stateErr) throw new Error(`state_upsert_failed: ${stateErr.message}`);

        controller.enqueue(encoder.encode(formatSseEvent({
          event: "done", data: { message_id: stub.id },
        })));
        controller.close();
      } catch (e) {
        await sr.from("chat_messages").update({
          status: "error", error: String(e),
        }).eq("id", stub.id);
        controller.enqueue(encoder.encode(formatSseEvent({
          event: "error", data: { message: String(e) },
        })));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
