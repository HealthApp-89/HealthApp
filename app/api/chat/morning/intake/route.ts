// app/api/chat/morning/intake/route.ts
//
// Morning intake endpoint — one-tap check-in card (spec 2026-07-10). POST:
//   {kind: 'start'}                    — begin or resume the day; inserts the card turn
//   {kind: 'all_good'}                 — write personal-baseline defaults, advance to awaiting_whoop
//   {kind: 'batch', values, notes?}    — one-shot form write (zod-validated)
//   {kind: 'declare_sick'}             — flip sick=true, ask for notes
//   {kind: 'free_text', value}         — sickness notes ONLY (409 otherwise)
//   {slot: 'still_sick', value}        — yesterday-was-sick morning gate
//
// The card's defaults are computed server-side at card creation and embedded
// in ui.morning_form; all_good re-reads them from the displayed card so the
// write matches exactly what the athlete saw.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import {
  MORNING_FORM_PROMPT,
  STILL_SICK_RECOVERED_PREFIX,
  STILL_SICK_PROMPT,
  STILL_SICK_CHIPS,
  SICKNESS_NOTES_PROMPT,
  REST_DAY_MESSAGE_HEALTHY_TO_SICK,
  REST_DAY_MESSAGE_STILL_SICK,
  SYNC_RECOVERY_PROMPT,
} from "@/lib/morning/script";
import {
  computeMorningDefaults,
  type DefaultsInputRow,
  type MorningDefaults,
} from "@/lib/morning/defaults";
import {
  BatchBodySchema,
  columnsFromBatch,
  formatBatchReply,
  type BatchValues,
} from "@/lib/morning/batch";
import { UPDATE_INTAKE_SLOTS_TOOL } from "@/lib/morning/tools";
import type { CheckinRow, MorningUI } from "@/lib/data/types";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHAT_MODEL as MODEL } from "@/lib/anthropic/models";

export const dynamic = "force-dynamic";

type Body =
  | { kind: "start" }
  | { kind: "all_good" }
  | { kind: "batch"; values: unknown; notes?: unknown }
  | { kind: "declare_sick" }
  | { kind: "free_text"; value: string }
  | { slot: string; value: string | number | string[] };

type SR = SupabaseClient;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as Body;
  const tz = await getUserTimezone(user.id);
  const today = todayInUserTz(new Date(), tz);
  const sr = createSupabaseServiceRoleClient();

  const { data: todayRow } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();

  if ("kind" in body && body.kind === "start") {
    return handleStart({ sr, userId: user.id, today, todayRow });
  }
  if ("kind" in body && body.kind === "all_good") {
    return handleAllGood({ sr, userId: user.id, today, todayRow });
  }
  if ("kind" in body && body.kind === "batch") {
    return handleBatch({ sr, userId: user.id, today, todayRow, body });
  }
  if ("kind" in body && body.kind === "declare_sick") {
    return handleDeclareSick({ sr, userId: user.id, today, todayRow });
  }
  if ("kind" in body && body.kind === "free_text") {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    if (todayRow.intake_state === "awaiting_sickness_notes") {
      return handleSicknessNotes({ sr, userId: user.id, today, value: body.value });
    }
    return NextResponse.json({ ok: false, reason: "unexpected_free_text" }, { status: 409 });
  }
  if ("slot" in body) {
    if (!todayRow) {
      return NextResponse.json({ ok: false, reason: "no_today_row" }, { status: 409 });
    }
    if (body.slot !== "still_sick") {
      return NextResponse.json({ ok: false, reason: "bad_slot" }, { status: 400 });
    }
    return handleStillSick({ sr, userId: user.id, today, value: body.value });
  }

  return NextResponse.json({ ok: false, reason: "bad_body" }, { status: 400 });
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleStart(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today, todayRow } = args;

  if (todayRow?.intake_state === "delivered") {
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Mid-flow resume: the card (or a later turn) is already the latest
  // assistant message in the thread; the client re-renders it on its own.
  if (todayRow && todayRow.intake_state !== "pending") {
    return NextResponse.json({ ok: true, resumed: true });
  }

  const yesterday = isoMinusDays(today, 1);
  const { data: yRow } = await sr
    .from("checkins")
    .select("sick, sickness_notes")
    .eq("user_id", userId)
    .eq("date", yesterday)
    .maybeSingle<Pick<CheckinRow, "sick" | "sickness_notes">>();

  if (yRow?.sick) {
    await upsertCheckin(sr, userId, today, {
      intake_state: "awaiting_feel",
      sick: false, // flipped back to true if the user answers Yes
      sickness_notes: yRow.sickness_notes ?? null,
    });
    await insertAssistantTurn(sr, userId, {
      content: STILL_SICK_PROMPT,
      ui: { chips: STILL_SICK_CHIPS.map((c) => ({ ...c, slot: "still_sick" })) },
    });
    return NextResponse.json({ ok: true, resumed: false, mode: "still_sick_check" });
  }

  await upsertCheckin(sr, userId, today, { intake_state: "awaiting_feel" });
  const defaults = await fetchMorningDefaults(sr, userId, today);
  await insertMorningFormTurn(sr, userId, MORNING_FORM_PROMPT, defaults);
  return NextResponse.json({ ok: true, resumed: false, mode: "fresh" });
}

async function handleAllGood(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today, todayRow } = args;
  if (!todayRow || (todayRow.intake_state !== "pending" && todayRow.intake_state !== "awaiting_feel")) {
    return NextResponse.json({ ok: false, reason: "not_awaiting" }, { status: 409 });
  }

  // Prefer the defaults embedded in the displayed card — the write must match
  // what the athlete saw, not a recomputation on possibly-newer data.
  const defaults =
    (await readCardDefaults(sr, userId)) ??
    (await fetchMorningDefaults(sr, userId, today));

  await insertUserReply(sr, userId, "Same as usual");
  await upsertCheckin(sr, userId, today, {
    readiness: defaults.readiness,
    fatigue: defaults.fatigue,
    soreness_areas: [],
    soreness_severity: null,
    bloating: false,
    sick: false,
    intake_source: "all_good",
    intake_state: "awaiting_whoop",
  });
  await parkWhoopSyncIfNeeded(sr, userId, today);
  return NextResponse.json({ ok: true });
}

async function handleBatch(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null; body: unknown;
}) {
  const { sr, userId, today, todayRow, body } = args;
  const parsed = BatchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad_batch", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (!todayRow || (todayRow.intake_state !== "pending" && todayRow.intake_state !== "awaiting_feel")) {
    return NextResponse.json({ ok: false, reason: "not_awaiting" }, { status: 409 });
  }

  const { values } = parsed.data;
  const notes = (parsed.data.notes ?? "").trim();

  await insertUserReply(sr, userId, formatBatchReply(values, notes || null));

  if (values.sick) {
    // Sick short-circuit — mirrors declare_sick semantics. Form notes are
    // sickness notes here (spec: not feel_notes).
    if (notes) {
      await upsertCheckin(sr, userId, today, {
        ...columnsFromBatch(values),
        intake_source: "form",
        sick: true,
        sickness_notes: notes,
        intake_state: "delivered",
      });
      await insertAssistantTurn(sr, userId, {
        content: REST_DAY_MESSAGE_HEALTHY_TO_SICK,
        ui: null,
      });
      return NextResponse.json({ ok: true, delivered: true });
    }
    await upsertCheckin(sr, userId, today, {
      ...columnsFromBatch(values),
      intake_source: "form",
      sick: true,
      intake_state: "awaiting_sickness_notes",
    });
    await insertAssistantTurn(sr, userId, {
      content: SICKNESS_NOTES_PROMPT,
      ui: { allow_text: true },
    });
    return NextResponse.json({ ok: true });
  }

  await upsertCheckin(sr, userId, today, {
    ...columnsFromBatch(values),
    intake_source: "form",
    sick: false,
    feel_notes: notes || null,
    intake_state: "awaiting_whoop",
  });
  if (notes) {
    await runNotesAck(sr, userId, today, values, notes);
  }
  await parkWhoopSyncIfNeeded(sr, userId, today);
  return NextResponse.json({ ok: true });
}

async function handleStillSick(args: {
  sr: SR; userId: string; today: string; value: string | number | string[];
}) {
  const { sr, userId, today, value } = args;
  await insertUserReply(sr, userId, String(value));

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

  // Recovered — proceed to the check-in card.
  await upsertCheckin(sr, userId, today, {
    sick: false,
    sickness_notes: null,
    intake_state: "awaiting_feel",
  });
  const defaults = await fetchMorningDefaults(sr, userId, today);
  await insertMorningFormTurn(
    sr, userId, STILL_SICK_RECOVERED_PREFIX + MORNING_FORM_PROMPT, defaults,
  );
  return NextResponse.json({ ok: true });
}

async function handleDeclareSick(args: {
  sr: SR; userId: string; today: string; todayRow: CheckinRow | null;
}) {
  const { sr, userId, today } = args;
  await insertUserReply(sr, userId, "I'm coming down with something");
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
  const trimmed = value.trim();
  if (trimmed) {
    await insertUserReply(sr, userId, trimmed);
  }
  await upsertCheckin(sr, userId, today, {
    sickness_notes: trimmed || null,
    sick: true,
    intake_state: "delivered",
  });
  await insertAssistantTurn(sr, userId, {
    content: REST_DAY_MESSAGE_HEALTHY_TO_SICK,
    ui: null,
  });
  return NextResponse.json({ ok: true, delivered: true });
}

// ── card + defaults helpers ──────────────────────────────────────────────────

async function fetchMorningDefaults(
  sr: SR, userId: string, today: string,
): Promise<MorningDefaults> {
  const { data } = await sr
    .from("checkins")
    .select("readiness, fatigue, intake_source")
    .eq("user_id", userId)
    .gte("date", isoMinusDays(today, 28))
    .lt("date", today);
  return computeMorningDefaults((data ?? []) as DefaultsInputRow[]);
}

/** Defaults embedded in the most recent displayed card, if any. */
async function readCardDefaults(sr: SR, userId: string): Promise<MorningDefaults | null> {
  const { data } = await sr
    .from("chat_messages")
    .select("ui")
    .eq("user_id", userId)
    .eq("kind", "morning_intake")
    .eq("role", "assistant")
    .not("ui->morning_form", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ ui: MorningUI }>();
  return data?.ui?.morning_form?.defaults ?? null;
}

async function insertMorningFormTurn(
  sr: SR, userId: string, content: string, defaults: MorningDefaults,
): Promise<void> {
  await insertAssistantTurn(sr, userId, {
    content,
    ui: { morning_form: { defaults } },
  });
}

/** If last night's recovery hasn't landed, insert the parked sync turn with
 *  Recheck / Skip chips (same copy + chips as the pre-card flow). */
async function parkWhoopSyncIfNeeded(sr: SR, userId: string, today: string): Promise<void> {
  const { data: log } = await sr
    .from("daily_logs")
    .select("recovery")
    .eq("user_id", userId)
    .eq("date", today)
    .maybeSingle<{ recovery: number | null }>();

  if (!log || log.recovery == null) {
    await insertAssistantTurn(sr, userId, {
      content: SYNC_RECOVERY_PROMPT,
      ui: {
        chips: [
          { label: "Recheck", action: "recheck" },
          { label: "Skip — feel-only plan", action: "skip_whoop" },
        ],
      },
    });
  }
}

/** Non-streaming Remi ack for form notes. Best-effort: the check-in row is
 *  already committed before this runs; an API failure must never block the
 *  morning flow, so errors are swallowed and the thread simply has no ack. */
async function runNotesAck(
  sr: SR, userId: string, today: string, values: BatchValues, notes: string,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  try {
    const client = new Anthropic({ apiKey });
    const sys = `You are Remi — the user's recovery and morning-health coach. The user has just submitted their morning check-in form, including a free-text note. Their structured answers are already saved.

Your job:
1. If the note mentions a symptom that maps to {sick, soreness_areas, fatigue, bloating} and is clearly stated, call update_intake_slots ONCE to record it. Do not guess. Do not call the tool if nothing maps cleanly.
2. Reply briefly (1-2 short sentences) acknowledging what they shared. Voice: warm, focused on body signals and recovery — not training tactics, not nutrition. Do not ask follow-up questions. Do not moralize.

Today's structured answers: ${JSON.stringify(values)}`;

    const final = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: sys,
      tools: [UPDATE_INTAKE_SLOTS_TOOL],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: notes }],
    });

    let text = "";
    for (const block of final.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use" && block.name === "update_intake_slots") {
        await applyToolUpdate(sr, userId, today, block.input as Record<string, unknown>);
      }
    }
    if (text.trim()) {
      await insertAssistantTurn(sr, userId, { content: text.trim(), ui: null });
    }
  } catch {
    // Best-effort ack — never block the morning flow.
  }
}

// ── low-level helpers (unchanged from the pre-card route) ────────────────────

async function upsertCheckin(
  sr: SR, userId: string, date: string, patch: Partial<CheckinRow>,
): Promise<void> {
  const { error } = await sr
    .from("checkins")
    .upsert({ user_id: userId, date, ...patch }, { onConflict: "user_id,date" });
  if (error) throw error;
}

async function insertUserReply(sr: SR, userId: string, content: string): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "user",
    thread: "remi",
    content,
    status: "done",
    kind: "morning_intake",
    ui: null,
  });
  if (error) throw error;
}

async function insertAssistantTurn(
  sr: SR, userId: string, args: { content: string; ui: MorningUI | null },
): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "assistant",
    speaker: "remi",
    thread: "remi",
    content: args.content,
    status: "done",
    kind: "morning_intake",
    ui: args.ui,
  });
  if (error) throw error;
}

async function applyToolUpdate(
  sr: SR, userId: string, today: string, input: Record<string, unknown>,
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

function isoMinusDays(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}
