// app/api/chat/morning/intake/route.ts
//
// Morning intake state-machine endpoint. POST one of:
//   {kind: 'start'}                               — begin or resume the day
//   {kind: 'declare_sick'}                        — flip sick=true, ask for notes
//   {kind: 'free_text', value: string}            — LLM tail OR sickness_notes (dispatch on intake_state)
//   {slot: SlotKey, value: string|number|string[]} — chip answer
//
// Server is the single source of truth for "what's the next question".
// Each call upserts the matching checkin column, advances intake_state via
// nextIntakeState(), inserts the next assistant chat_messages row (with
// ui.chips when scripted, streamed with Claude when free-text tail), and
// returns SSE for the streaming case or JSON for the scripted case.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import {
  SLOT_BY_KEY,
  STILL_SICK_PROMPT,
  STILL_SICK_CHIPS,
  SICKNESS_NOTES_PROMPT,
  REST_DAY_MESSAGE_HEALTHY_TO_SICK,
  REST_DAY_MESSAGE_STILL_SICK,
  FREE_TEXT_TAIL_PROMPT,
  SYNC_WHOOP_PROMPT,
  type SlotKey,
} from "@/lib/morning/script";
import { nextSlot, nextIntakeState } from "@/lib/morning/state";
import { UPDATE_INTAKE_SLOTS_TOOL } from "@/lib/morning/tools";
import type { CheckinRow, MorningUI } from "@/lib/data/types";
import { formatSseEvent } from "@/lib/chat/sse";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-5";

type Body =
  | { kind: "start" }
  | { kind: "declare_sick" }
  | { kind: "free_text"; value: string }
  | { slot: SlotKey | "soreness_gate" | "still_sick"; value: string | number | string[] };

type SR = SupabaseClient;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as Body;
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  // Always read today's row first; many handlers need it.
  const { data: todayRow } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();

  // ── start: bootstrap the day ────────────────────────────────────────────────
  if ("kind" in body && body.kind === "start") {
    return handleStart({ sr, userId: user.id, today, todayRow });
  }

  // ── declare_sick: user tapped "I'm coming down with something" ──────────────
  if ("kind" in body && body.kind === "declare_sick") {
    return handleDeclareSick({ sr, userId: user.id, today, todayRow });
  }

  // ── free_text: dispatch on current state ────────────────────────────────────
  if ("kind" in body && body.kind === "free_text") {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    if (todayRow.intake_state === "awaiting_sickness_notes") {
      return handleSicknessNotes({ sr, userId: user.id, today, value: body.value });
    }
    return handleFeelTail({ sr, userId: user.id, today, todayRow, value: body.value });
  }

  // ── slot answer ─────────────────────────────────────────────────────────────
  if ("slot" in body) {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    return handleSlotAnswer({ sr, userId: user.id, today, body });
  }

  return NextResponse.json({ ok: false, reason: "bad_body" }, { status: 400 });
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleStart(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today, todayRow } = args;

  // Already delivered → return 409 so client closes panel.
  if (todayRow?.intake_state === "delivered") {
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Mid-flow resume: today's row already exists in awaiting_feel /
  // awaiting_sickness_notes / awaiting_whoop. The latest assistant message
  // is already in chat_messages and the client re-renders the existing
  // thread on its own — no new turn to insert.
  if (todayRow && todayRow.intake_state !== "pending") {
    return NextResponse.json({ ok: true, resumed: true });
  }

  // Fresh: was yesterday sick?
  const yesterday = isoMinusDays(today, 1);
  const { data: yRow } = await sr
    .from("checkins")
    .select("sick, sickness_notes")
    .eq("user_id", userId)
    .eq("date", yesterday)
    .maybeSingle<Pick<CheckinRow, "sick" | "sickness_notes">>();

  if (yRow?.sick) {
    // Still-sick check-in path.
    await upsertCheckin(sr, userId, today, {
      intake_state: "awaiting_feel",
      sick: false, // will be flipped back to true if user answers Yes
      sickness_notes: yRow.sickness_notes ?? null, // carry forward as default
    });
    await insertAssistantTurn(sr, userId, {
      content: STILL_SICK_PROMPT,
      ui: { chips: STILL_SICK_CHIPS.map((c) => ({ ...c, slot: "still_sick" })) },
    });
    return NextResponse.json({ ok: true, resumed: false, mode: "still_sick_check" });
  }

  // Healthy fresh start — first slot is readiness.
  await upsertCheckin(sr, userId, today, { intake_state: "awaiting_feel" });
  const firstSlot = SLOT_BY_KEY.readiness;
  await insertAssistantTurn(sr, userId, {
    content: firstSlot.prompt,
    ui: chipsForSlot(firstSlot.key),
  });
  return NextResponse.json({ ok: true, resumed: false, mode: "fresh" });
}

async function handleDeclareSick(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today } = args;
  await upsertCheckin(sr, userId, today, {
    sick: true,
    intake_state: "awaiting_sickness_notes",
  });
  await insertAssistantTurn(sr, userId, {
    content: SICKNESS_NOTES_PROMPT,
    ui: { allow_text: true },
  });
  return NextResponse.json({ ok: true });
}

async function handleSicknessNotes(args: {
  sr: SR; userId: string; today: string; value: string;
}) {
  const { sr, userId, today, value } = args;
  await upsertCheckin(sr, userId, today, {
    sickness_notes: value.trim() || null,
    sick: true,
    intake_state: "delivered",
  });
  await insertAssistantTurn(sr, userId, {
    content: REST_DAY_MESSAGE_HEALTHY_TO_SICK,
    ui: null,
  });
  return NextResponse.json({ ok: true, delivered: true });
}

async function handleSlotAnswer(args: {
  sr: SR; userId: string; today: string; body: Extract<Body, { slot: string }>;
}) {
  const { sr, userId, today, body } = args;
  const slot = body.slot;
  const value = body.value;

  // Special: still_sick chip (yes/no). Only valid when the latest assistant
  // turn was the still-sick prompt. We detect by checking sickness_notes
  // existence and intake_state.
  if (slot === "still_sick") {
    if (value === "yes") {
      await upsertCheckin(sr, userId, today, {
        sick: true,
        intake_state: "delivered",
      });
      await insertAssistantTurn(sr, userId, {
        content: REST_DAY_MESSAGE_STILL_SICK,
        ui: null,
      });
      return NextResponse.json({ ok: true, delivered: true });
    }
    // No — flip sick=false (already done in handleStart) and proceed with
    // first scripted slot.
    await upsertCheckin(sr, userId, today, {
      sick: false,
      sickness_notes: null,
      intake_state: "awaiting_feel",
    });
    const firstSlot = SLOT_BY_KEY.readiness;
    await insertAssistantTurn(sr, userId, {
      content: "Good — let's run through the morning check-in. " + firstSlot.prompt,
      ui: chipsForSlot(firstSlot.key),
    });
    return NextResponse.json({ ok: true });
  }

  // Soreness gate (virtual slot)
  if (slot === "soreness_gate") {
    if (value === "no") {
      await upsertCheckin(sr, userId, today, {
        soreness_areas: [],
        soreness_severity: null,
      });
    }
    // 'yes' falls through; soreness_areas stays null so nextSlot returns
    // soreness_areas next.
  } else {
    // Map chip slot → DB column
    const update = mapSlotToColumn(slot as SlotKey, value);
    if (!update) {
      return NextResponse.json({ ok: false, reason: "bad_slot" }, { status: 400 });
    }
    await upsertCheckin(sr, userId, today, update);
  }

  // Re-read row, decide next.
  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", userId)
    .eq("date", today)
    .single<CheckinRow>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "row_lost" }, { status: 500 });
  }

  const next = nextSlot(row);
  const nextState = nextIntakeState(row.intake_state, row);

  if (nextState !== row.intake_state) {
    await upsertCheckin(sr, userId, today, { intake_state: nextState });
  }

  if (next.kind === "slot") {
    const def = SLOT_BY_KEY[next.key];
    await insertAssistantTurn(sr, userId, {
      content: def.prompt,
      ui: chipsForSlot(next.key),
    });
    return NextResponse.json({ ok: true, next: next.key });
  }

  if (next.kind === "tail") {
    await insertAssistantTurn(sr, userId, {
      content: FREE_TEXT_TAIL_PROMPT,
      ui: { allow_text: true },
    });
    return NextResponse.json({ ok: true, next: "tail" });
  }

  // Already 'done' (shouldn't happen mid-slot-answer; defensive).
  return NextResponse.json({ ok: true, next: "done" });
}

async function handleFeelTail(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow; value: string;
}) {
  const { sr, userId, today, todayRow, value } = args;
  const trimmed = value.trim();

  // Save the user text first.
  await upsertCheckin(sr, userId, today, {
    feel_notes: trimmed || null,
  });

  // Insert user message into chat_messages so the thread shows it.
  await sr.from("chat_messages").insert({
    user_id: userId,
    role: "user",
    content: trimmed || "(no extra notes)",
    status: "done",
    kind: "morning_intake",
    ui: null,
  });

  // Stream Claude reply with the update_intake_slots tool available.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, reason: "no_api_key" }, { status: 500 });
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  // Pre-create assistant stub so we have an id to stream into.
  const { data: stub, error: stubErr } = await sr
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
  if (stubErr || !stub) {
    return NextResponse.json({ ok: false, reason: "stub_failed" }, { status: 500 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const sys = `You are an athlete's coach reviewing their morning notes. The user has just answered a free-text "anything else?" prompt during a structured morning check-in. Their structured slot answers are already saved.

Your job:
1. If the user's text mentions a symptom that maps to one of {sick, soreness_areas, fatigue, bloating} and is clearly stated, call update_intake_slots ONCE to record it. Do not guess. Do not call the tool if nothing maps cleanly.
2. Reply briefly (1-2 short sentences) acknowledging what they said. Don't ask more questions. Don't moralize.

Today's structured answers so far: ${JSON.stringify({
          readiness: todayRow.readiness,
          energy_label: todayRow.energy_label,
          mood: todayRow.mood,
          fatigue: todayRow.fatigue,
          bloating: todayRow.bloating,
          soreness_areas: todayRow.soreness_areas,
          soreness_severity: todayRow.soreness_severity,
        })}`;

        const apiStream = client.messages.stream({
          model: MODEL,
          max_tokens: 400,
          system: sys,
          tools: [UPDATE_INTAKE_SLOTS_TOOL],
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
          messages: [{ role: "user", content: trimmed || "(no notes)" }],
        });

        let assembled = "";
        for await (const ev of apiStream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            assembled += ev.delta.text;
            controller.enqueue(encoder.encode(formatSseEvent({
              event: "delta",
              data: { text: ev.delta.text },
            })));
          }
        }

        // Tool call?
        const final = await apiStream.finalMessage();
        for (const block of final.content) {
          if (block.type === "tool_use" && block.name === "update_intake_slots") {
            await applyToolUpdate(sr, userId, today, block.input as Record<string, unknown>);
          }
        }

        // Finalize stub
        await sr.from("chat_messages").update({
          content: assembled,
          status: "done",
        }).eq("id", stub.id);

        // Auto-advance to recommendation phase
        await upsertCheckin(sr, userId, today, { intake_state: "awaiting_whoop" });

        // Check if WHOOP is ready. If recovery is non-null, the client's auto-fire
        // effect will pick this up via useDailyLogs and POST to /api/chat/morning/recommendation.
        // If recovery is null, insert a parked assistant turn with action chips so the
        // user has a path forward (manual sync or skip).
        const { data: log } = await sr
          .from("daily_logs")
          .select("recovery")
          .eq("user_id", userId)
          .eq("date", today)
          .maybeSingle<{ recovery: number | null }>();

        if (!log || log.recovery == null) {
          await insertAssistantTurn(sr, userId, {
            content: SYNC_WHOOP_PROMPT,
            ui: {
              chips: [
                { label: "Sync WHOOP now", action: "whoop_sync" },
                { label: "Skip — feel-only plan", action: "skip_whoop" },
              ],
            },
          });
        }

        controller.enqueue(encoder.encode(formatSseEvent({
          event: "done",
          data: { message_id: stub.id },
        })));
        controller.close();
      } catch (e) {
        await sr.from("chat_messages").update({
          status: "error",
          error: String(e),
        }).eq("id", stub.id);
        controller.enqueue(encoder.encode(formatSseEvent({
          event: "error",
          data: { message: String(e) },
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

// ── helpers ──────────────────────────────────────────────────────────────────

async function upsertCheckin(
  sr: SR,
  userId: string,
  date: string,
  patch: Partial<CheckinRow>,
): Promise<void> {
  const { error } = await sr
    .from("checkins")
    .upsert({ user_id: userId, date, ...patch }, { onConflict: "user_id,date" });
  if (error) throw error;
}

async function insertAssistantTurn(
  sr: SR,
  userId: string,
  args: { content: string; ui: MorningUI | null },
): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "assistant",
    content: args.content,
    status: "done",
    kind: "morning_intake",
    ui: args.ui,
  });
  if (error) throw error;
}

function chipsForSlot(key: SlotKey): MorningUI {
  const def = SLOT_BY_KEY[key];
  return {
    chips: def.chips.map((c) => ({ ...c, slot: key })),
    multi_select: def.multi_select ?? false,
  };
}

function mapSlotToColumn(
  slot: SlotKey,
  value: string | number | string[],
): Partial<CheckinRow> | null {
  switch (slot) {
    case "readiness":
      return typeof value === "number" ? { readiness: value } : null;
    case "energy_label":
      return typeof value === "string" ? { energy_label: value } : null;
    case "mood":
      return typeof value === "string" ? { mood: value } : null;
    case "soreness_areas":
      return Array.isArray(value) ? { soreness_areas: value } : null;
    case "soreness_severity":
      return typeof value === "string" && (value === "mild" || value === "sharp")
        ? { soreness_severity: value }
        : null;
    case "fatigue":
      return typeof value === "string" && (value === "none" || value === "some" || value === "heavy")
        ? { fatigue: value }
        : null;
    case "bloating":
      return typeof value === "string"
        ? { bloating: value === "yes" }
        : null;
    default:
      return null;
  }
}

async function applyToolUpdate(
  sr: SR, userId: string, today: string,
  input: Record<string, unknown>,
): Promise<void> {
  const update: Partial<CheckinRow> = {};
  if (typeof input.sick === "boolean") update.sick = input.sick;
  if (typeof input.sickness_notes === "string") update.sickness_notes = input.sickness_notes;
  if (input.fatigue === "none" || input.fatigue === "some" || input.fatigue === "heavy") {
    update.fatigue = input.fatigue;
  }
  if (Array.isArray(input.soreness_areas)) {
    update.soreness_areas = input.soreness_areas.filter(
      (a): a is string => typeof a === "string",
    );
  }
  if (input.soreness_severity === "mild" || input.soreness_severity === "sharp") {
    update.soreness_severity = input.soreness_severity;
  }
  if (typeof input.bloating === "boolean") update.bloating = input.bloating;
  if (Object.keys(update).length === 0) return;
  await upsertCheckin(sr, userId, today, update);
}

/** Subtract `days` from an ISO date string (YYYY-MM-DD), returning the new
 *  date string. Date-string arithmetic — both endpoints are anchored at UTC
 *  midnight, so the math is always exactly N×86400000 ms regardless of DST.
 *  Use this for "what was the date N days before <today-in-user-tz>" lookups. */
function isoMinusDays(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}
