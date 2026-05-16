// app/api/chat/morning/recommendation/route.ts
//
// POST: deliver today's structured morning brief as the next assistant
// message in the morning_intake thread. Streams over SSE — emits a
// `brief_card` event with the deterministic blocks as soon as data
// assembly finishes (~1-2s), then streams the AI-generated `advice_md`
// as `delta` events while it's being written. Final `done` event carries
// the persisted chat_messages id.
//
// Pre-flight checks that fail before any streaming starts return a plain
// JSON response so the client can branch (425 awaiting_whoop, 409
// already_delivered with the existing message, etc.). Once the stream
// opens the response is always 200 SSE.
//
// Body: {} | {skip_whoop: true}

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz, ymdInUserTz } from "@/lib/time";
import type { CheckinRow, DailyLog, MorningBriefCard } from "@/lib/data/types";
import {
  buildMorningBriefStreaming,
  composeBriefContentFallback,
} from "@/lib/morning/brief";
import { formatSseEvent } from "@/lib/chat/sse";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { skip_whoop?: boolean };
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  // Fetch today's checkin row
  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  }

  // Sick guard: never produce a training-variant brief for a declared-sick user.
  if (row.sick === true) {
    return NextResponse.json({ ok: false, reason: "sick_path" }, { status: 409 });
  }

  // Idempotency: brief already delivered for today
  if (row.intake_state === "brief_delivered") {
    const existing = await loadExistingBriefMessage(sr, user.id, today);
    if (existing) {
      return NextResponse.json({ ok: false, reason: "already_delivered", message: existing }, { status: 409 });
    }
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Concurrency: another request is in flight
  if (row.intake_state === "assembling_brief") {
    return NextResponse.json({ ok: false, reason: "assembling" }, { status: 409 });
  }

  // WHOOP gating: same as legacy behaviour
  const { data: log } = await sr
    .from("daily_logs")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<DailyLog>();
  if (!body.skip_whoop && (!log || log.recovery == null)) {
    if (row.intake_state !== "awaiting_whoop") {
      await sr.from("checkins").upsert(
        { user_id: user.id, date: today, intake_state: "awaiting_whoop" },
        { onConflict: "user_id,date" },
      );
    }
    return NextResponse.json({ ok: false, reason: "awaiting_whoop" }, { status: 425 });
  }

  // Pipeline: transition to assembling, then SSE stream
  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "assembling_brief" },
    { onConflict: "user_id,date" },
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const yieldEvent = (e: Parameters<typeof formatSseEvent>[0]) =>
        controller.enqueue(encoder.encode(formatSseEvent(e)));

      // Compute the WHOOP-missing flag once: the user got here either with
      // recovery!=null in daily_logs, or with body.skip_whoop=true. The latter
      // is the "feel-only" path and needs to surface a banner on the card.
      const whoopMissing = body.skip_whoop === true && (!log || log.recovery == null);

      let finalCard: MorningBriefCard | null = null;
      let errored: string | null = null;
      try {
        for await (const ev of buildMorningBriefStreaming(sr, user.id, req.signal)) {
          if (ev.type === "card_ready") {
            const card = whoopMissing ? { ...ev.card, whoop_missing: true } : ev.card;
            yieldEvent({ event: "brief_card", data: { card } });
          } else if (ev.type === "advice_delta") {
            yieldEvent({ event: "delta", data: { text: ev.text } });
          } else if (ev.type === "done") {
            finalCard = ev.card;
          } else if (ev.type === "error") {
            errored = ev.message;
            break;
          }
        }
      } catch (err) {
        errored = (err as Error).message ?? "unknown_error";
      }

      if (errored || !finalCard) {
        console.error("[morning brief] generation failed", errored);
        await sr.from("checkins").upsert(
          { user_id: user.id, date: today, intake_state: "brief_failed" },
          { onConflict: "user_id,date" },
        );
        // Insert a retry chip so the user can tap to retry from the morning panel.
        await sr.from("chat_messages").insert({
          user_id: user.id,
          role: "assistant",
          kind: "morning_intake",
          content: "I had trouble generating today's brief. Tap to retry.",
          ui: {
            chips: [{ label: "Try again", action: "retry_brief" }],
          },
        });
        yieldEvent({ event: "error", data: { message: errored ?? "brief_failed" } });
        controller.close();
        return;
      }

      // Persist the assistant message + finalize state. Wrapped in try/catch
      // so any failure after the stream completed still flips intake_state to
      // brief_failed — otherwise a client disconnect or DB error between
      // `done` and the final upsert leaves the row stranded at assembling_brief
      // and a 409 awaits the user on next retry.
      const persistedCard = whoopMissing ? { ...finalCard, whoop_missing: true } : finalCard;
      const contentSummary = composeBriefContentFallback(persistedCard);
      try {
        const { data: inserted, error: insertErr } = await sr
          .from("chat_messages")
          .insert({
            user_id: user.id,
            role: "assistant",
            kind: "morning_brief",
            content: contentSummary,
            ui: persistedCard,
          })
          .select("id")
          .single();
        if (insertErr || !inserted) {
          throw new Error(`insert_failed: ${insertErr?.message ?? "no row"}`);
        }

        const { error: stateErr } = await sr.from("checkins").upsert(
          { user_id: user.id, date: today, intake_state: "brief_delivered" },
          { onConflict: "user_id,date" },
        );
        if (stateErr) {
          // Brief is in DB; only the state row is mis-tagged. Log and ship —
          // the recommendation route's idempotency lookup verifies via the
          // existing-message check, not the state column alone.
          console.error(
            "[morning brief] brief_delivered upsert failed (brief inserted, state stale)",
            stateErr,
          );
        }

        yieldEvent({ event: "done", data: { message_id: inserted.id as string } });
      } catch (err) {
        console.error("[morning brief] post-stream finalize failed", err);
        // Best-effort cleanup: flip to brief_failed so the next retry can run
        // and surface a retry chip in the morning intake panel.
        try {
          await sr.from("checkins").upsert(
            { user_id: user.id, date: today, intake_state: "brief_failed" },
            { onConflict: "user_id,date" },
          );
          await sr.from("chat_messages").insert({
            user_id: user.id,
            role: "assistant",
            kind: "morning_intake",
            content: "I had trouble saving today's brief. Tap to retry.",
            ui: { chips: [{ label: "Try again", action: "retry_brief" }] },
          });
        } catch (cleanupErr) {
          console.error("[morning brief] cleanup after post-stream failure also failed", cleanupErr);
        }
        // Only emit error to the client if the connection is still open.
        if (!req.signal.aborted) {
          yieldEvent({ event: "error", data: { message: (err as Error).message ?? "finalize_failed" } });
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}

async function loadExistingBriefMessage(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  today: string,
) {
  // Pull the most recent morning_brief; verify its date matches today in user-tz.
  const { data } = await sr
    .from("chat_messages")
    .select("id, role, kind, content, ui, created_at")
    .eq("user_id", userId)
    .eq("kind", "morning_brief")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const rowDate = ymdInUserTz(new Date(data.created_at as string));
  if (rowDate !== today) return null;
  return data;
}
