// lib/morning/brief/index.ts
//
// Orchestrator for the morning brief pipeline:
//   1. Fetch inputs in parallel (data-sources)
//   2. Assemble the structured card except advice_md (pure)
//   3. Compute advice flags (pure)
//   4. Single Haiku call for advice_md
//   5. Return the complete MorningBriefCard
//
// Single entry point called by the route handler.

import type { SupabaseClient } from "@supabase/supabase-js";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import type { MorningBriefCard, MuscleVolumeFlag, StrengthMuscleVolume } from "@/lib/data/types";
import {
  fetchBriefInputs,
  getThisWeekPrescription,
  getThisWeekEndurancePlan,
  getYesterdayWorkoutFlat,
  getPreviousCommittedReview,
} from "@/lib/morning/brief/data-sources";
import { assembleBriefExceptAdvice } from "@/lib/morning/brief/assembler";
import { computeAdviceFlags, evaluateMuscleVolumeGapsForBrief } from "@/lib/morning/brief/flags";
import { generateAdvice, generateAdviceStream } from "@/lib/morning/brief/advice-prompt";
import type { AdviceContext } from "@/lib/morning/brief/advice-prompt";
import { fetchMuscleVolumeServer } from "@/lib/query/fetchers/muscleVolume";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";

/** Deterministic prep: assembles every block except advice_md and computes
 *  the AdviceContext the AI needs to write the prose. Pure-ish — only reads.
 *  No DB writes, no Anthropic calls. Used by both the blocking and the
 *  streaming brief pipelines. */
export async function prepareBriefExceptAdvice(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ partial: Omit<MorningBriefCard, "advice_md">; adviceCtx: AdviceContext }> {
  const tz = await getUserTimezone(userId);
  const today = todayInUserTz(new Date(), tz);
  const yesterday = yesterdayOf(today);
  const weekStart = mondayOf(today);

  // Fan out the base inputs in parallel with the three sub-project #2
  // data sources (this-week prescription, yesterday flat workout for
  // the analytical comparator, previous-week committed review for the
  // phase-transition flag). Also fetch yesterday's committed
  // food_log_entries — the AI advice prompt gets the top items as
  // optional context (card UI unchanged).
  const [
    inputs,
    thisWeekPrescription,
    thisWeekEndurancePlan,
    yesterdayWorkoutForBlock,
    previousCommittedReview,
    yesterdayFoodEntriesRes,
  ] = await Promise.all([
    fetchBriefInputs(supabase, userId, today, tz),
    getThisWeekPrescription(supabase, userId, today),
    getThisWeekEndurancePlan(supabase, userId, today),
    getYesterdayWorkoutFlat(supabase, userId, yesterday),
    getPreviousCommittedReview(supabase, userId, weekStart),
    supabase
      .from("food_log_entries")
      .select("items, totals")
      .eq("user_id", userId)
      .eq("status", "committed")
      .gte("eaten_at", `${yesterday}T00:00:00Z`)
      .lte("eaten_at", `${yesterday}T23:59:59Z`),
  ]);

  // Top items yesterday — computed from food_log_entries. Degrade gracefully
  // on read error (the rest of the brief is still valuable). Source = 'none'
  // when no entries or fetch failed; the prompt builder treats both the same.
  const topItemsYesterday = computeTopItemsYesterday(
    yesterdayFoodEntriesRes.error ? null : (yesterdayFoodEntriesRes.data as Array<{
      items: Array<{ name: string; kcal: number | null }>;
    }> | null),
  );

  // Did yesterday's session type get swapped from the original prescription?
  // training_weeks.original_session_plan is nullable (migration 0012) — null
  // when the week's plan was never edited, so fall back to session_plan.
  const swapAppliedYesterday = (() => {
    if (!thisWeekPrescription) return false;
    const tw = thisWeekPrescription.trainingWeek;
    const original = (tw.original_session_plan ?? tw.session_plan) as Record<string, string>;
    const current = tw.session_plan as Record<string, string>;
    const yesterdayLong = [
      "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ][new Date(`${yesterday}T12:00:00Z`).getUTCDay()];
    return original[yesterdayLong] !== current[yesterdayLong];
  })();

  // Muscle-volume context — only when the active plan carries muscle_volume.
  let muscleVolumeFlags: MuscleVolumeFlag[] = [];
  const muscleVolume: StrengthMuscleVolume | null =
    (inputs.activeProfile?.plan_payload as { strength?: { muscle_volume?: StrengthMuscleVolume } } | null)
      ?.strength?.muscle_volume ?? null;

  if (muscleVolume) {
    try {
      const mvSnapshot = await fetchMuscleVolumeServer(supabase, userId, today);
      // Sessions that aren't actual training: REST (planned), Mobility
      // (recovery), Sick (schedule-flexibility swap). The recommendation
      // route's sick-guard runs against checkin.sick, not session_plan;
      // a per-day "Sick" entry in session_plan still reaches this composer.
      const isTrainingDay =
        inputs.sessionType !== "REST" &&
        inputs.sessionType !== "Mobility" &&
        inputs.sessionType !== "Sick";
      const daysLeftInWeek = computeDaysLeftInWeek(today);
      const todayWeekday = weekdayLabelFor(today);
      muscleVolumeFlags = evaluateMuscleVolumeGapsForBrief({
        snapshot: mvSnapshot,
        muscleVolume,
        currentBlockWeek: null, // future PR threads active-block context
        isTrainingDay,
        todayWeekday,
        daysLeftInWeek,
      });
    } catch (err) {
      // Degrade gracefully: a snapshot fetch failure shouldn't kill the
      // entire brief. Log and proceed without volume flags — the rest of
      // the brief is still valuable, and the volume layer will reappear
      // tomorrow when the snapshot works again.
      console.error(
        "[brief] fetchMuscleVolumeServer failed — proceeding without volume flags",
        err,
      );
      muscleVolumeFlags = [];
    }
  }

  // Compute flags first — phase_transition_this_week is then plumbed into
  // BriefInputs so the assembler can flag it on the kickoff plan block.
  // The flag is computed deterministically from the committed-review pair;
  // the assembler is the renderer side, not the truth side.
  // Build a partial card just for the readiness band — band drives the
  // coach_suggestion which is read by flags.coach_swap_suggested. We need
  // the band before we have the full card, so compute flags against the
  // same partial we'll feed the AI. The cleanest path is one assembler
  // call that fills `card.coach_suggestion` and `card.readiness.band`,
  // then a single flags computation.
  const enrichedInputs = {
    ...inputs,
    muscleVolumeFlags,
    thisWeekPrescription,
    thisWeekEndurancePlan,
    yesterdayWorkoutForBlock,
    swapAppliedYesterday,
    // Set provisionally to false; flags.ts is the authoritative computation,
    // and we re-build the assembler call with the real value below.
    phaseTransitionThisWeek: false,
  };
  const provisionalPartial = assembleBriefExceptAdvice(enrichedInputs);
  const flags = computeAdviceFlags({
    activeProfile: inputs.activeProfile,
    card: provisionalPartial,
    targets: inputs.todayTargets,
    thisWeekCommittedReview: thisWeekPrescription?.review ?? null,
    previousCommittedReview,
  });

  // Re-run the assembler with the authoritative phase-transition flag so
  // ThisWeekPlanBlock.phase_changed_this_week matches the flag the AI sees.
  const partial = assembleBriefExceptAdvice({
    ...enrichedInputs,
    phaseTransitionThisWeek: flags.phase_transition_this_week,
  });

  const adviceCtx: AdviceContext = {
    activeProfile: inputs.activeProfile,
    card: partial,
    flags,
    targets: inputs.todayTargets,
    muscleVolumeFlags,
    muscleVolume,
    topItemsYesterday,
  };
  return { partial, adviceCtx };
}

/** Top-3 items by calories from yesterday's committed food_log_entries.
 *  Returns source='none' when no entries exist (or fetch failed) — the
 *  prompt builder skips the section entirely in that case. Items are
 *  deduplicated by name (case-insensitive) and ranked by total kcal. */
function computeTopItemsYesterday(
  entries: Array<{ items: Array<{ name: string; kcal: number | null }> }> | null,
): { source: "food_log"; items: Array<{ name: string; kcal: number; share_of_day_pct: number }> }
  | { source: "none"; items: [] } {
  if (!entries || entries.length === 0) return { source: "none", items: [] };
  const flatItems = entries.flatMap((e) => e.items ?? []);
  const cleanItems = flatItems
    .filter((it): it is { name: string; kcal: number } =>
      typeof it.name === "string" && typeof it.kcal === "number" && Number.isFinite(it.kcal))
    .map((it) => ({ name: it.name, kcal: it.kcal }));
  const dayKcal = cleanItems.reduce((s, it) => s + it.kcal, 0);
  if (dayKcal <= 0 || cleanItems.length === 0) return { source: "none", items: [] };

  // Dedupe by lowercased name (preserve first-seen casing).
  const tally = new Map<string, { name: string; kcal: number }>();
  for (const it of cleanItems) {
    const key = it.name.toLowerCase();
    const cur = tally.get(key);
    if (cur) {
      cur.kcal += it.kcal;
    } else {
      tally.set(key, { name: it.name, kcal: it.kcal });
    }
  }

  const items = [...tally.values()]
    .sort((a, b) => b.kcal - a.kcal)
    .slice(0, 3)
    .map((it) => ({
      name: it.name,
      kcal: it.kcal,
      share_of_day_pct: Math.round((it.kcal / dayKcal) * 100),
    }));
  return { source: "food_log", items };
}

/** Full pipeline (blocking advice). Kept for callers that don't need
 *  streaming — e.g. cron, regenerate_morning_brief tool. */
export async function buildMorningBrief(
  supabase: SupabaseClient,
  userId: string,
): Promise<MorningBriefCard> {
  const { partial, adviceCtx } = await prepareBriefExceptAdvice(supabase, userId);
  const advice_md = await generateAdvice(adviceCtx);
  return { ...partial, advice_md };
}

/** Streaming variant. First yields 'card_ready' with the deterministic card
 *  (advice_md=''), then advice text deltas, then 'done' with the assembled
 *  full advice. Caller writes the chat_messages row after 'done' lands. */
export async function* buildMorningBriefStreaming(
  supabase: SupabaseClient,
  userId: string,
  signal?: AbortSignal,
): AsyncGenerator<
  | { type: "card_ready"; card: MorningBriefCard }
  | { type: "advice_delta"; text: string }
  | { type: "done"; card: MorningBriefCard }
  | { type: "error"; message: string }
> {
  const { partial, adviceCtx } = await prepareBriefExceptAdvice(supabase, userId);
  // Emit the card immediately so the client can render the deterministic
  // blocks while the AI prose is still streaming.
  yield { type: "card_ready", card: { ...partial, advice_md: "" } };

  let advice = "";
  for await (const ev of generateAdviceStream(adviceCtx, signal)) {
    if (ev.type === "delta") {
      advice += ev.text;
      yield { type: "advice_delta", text: ev.text };
    } else if (ev.type === "done") {
      advice = ev.full;
    } else if (ev.type === "error") {
      yield { type: "error", message: ev.message };
      return;
    }
  }
  yield { type: "done", card: { ...partial, advice_md: advice } };
}

function yesterdayOf(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function weekdayLabelFor(iso: string): "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const d = new Date(iso + "T00:00:00Z");
  return labels[d.getUTCDay()] as "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
}

function computeDaysLeftInWeek(iso: string): number {
  // Week is Sun-Sat. If today is Wed (day 3), 6 - 3 = 3 days left (Thu, Fri, Sat).
  const d = new Date(iso + "T00:00:00Z");
  return 6 - d.getUTCDay();
}

/** Plain-text fallback for `chat_messages.content`. Renders in chat history
 *  lists / clients that don't know how to consume `kind='morning_brief'`.
 *  Shared between the morning recommendation route and the
 *  regenerate_morning_brief chat tool. */
export function composeBriefContentFallback(card: MorningBriefCard): string {
  const sessionLine = card.variant !== "rest"
    ? `Today: ${card.session.type} at ${card.session.start_time ?? "TBD"}`
    : "Today: REST";
  return `Morning brief — ${sessionLine}. Readiness ${card.readiness.band}. Tap to view the full card.`;
}
