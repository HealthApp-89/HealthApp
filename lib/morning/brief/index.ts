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
import type { MorningBriefCard, MuscleVolumeFlag, StrengthMuscleVolume } from "@/lib/data/types";
import { fetchBriefInputs } from "@/lib/morning/brief/data-sources";
import { assembleBriefExceptAdvice } from "@/lib/morning/brief/assembler";
import { computeAdviceFlags, evaluateMuscleVolumeGapsForBrief } from "@/lib/morning/brief/flags";
import { generateAdvice } from "@/lib/morning/brief/advice-prompt";
import { fetchMuscleVolumeServer } from "@/lib/query/fetchers/muscleVolume";

export async function buildMorningBrief(
  supabase: SupabaseClient,
  userId: string,
): Promise<MorningBriefCard> {
  const today = todayInUserTz();
  const inputs = await fetchBriefInputs(supabase, userId, today);

  // Muscle-volume context — only when the active plan carries muscle_volume.
  let muscleVolumeFlags: MuscleVolumeFlag[] = [];
  const muscleVolume: StrengthMuscleVolume | null =
    (inputs.activeProfile?.plan_payload as { strength?: { muscle_volume?: StrengthMuscleVolume } } | null)
      ?.strength?.muscle_volume ?? null;

  if (muscleVolume) {
    const mvSnapshot = await fetchMuscleVolumeServer(supabase, userId, today);
    const isTrainingDay =
      inputs.sessionType !== "REST" && inputs.sessionType !== "Mobility";
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
  }

  const enrichedInputs = { ...inputs, muscleVolumeFlags };
  const partial = assembleBriefExceptAdvice(enrichedInputs);
  const flags = computeAdviceFlags({
    activeProfile: inputs.activeProfile,
    card: partial,
    targets: inputs.todayTargets,
  });
  const advice_md = await generateAdvice({
    activeProfile: inputs.activeProfile,
    card: partial,
    flags,
    targets: inputs.todayTargets,
    muscleVolumeFlags,
    muscleVolume,
  });
  return { ...partial, advice_md };
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
  const sessionLine = card.variant === "training"
    ? `Today: ${card.session.type} at ${card.session.start_time}`
    : "Today: REST";
  return `Morning brief — ${sessionLine}. Readiness ${card.readiness.band}. Tap to view the full card.`;
}
