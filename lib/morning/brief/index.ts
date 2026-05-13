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
import type { MorningBriefCard } from "@/lib/data/types";
import { fetchBriefInputs } from "@/lib/morning/brief/data-sources";
import { assembleBriefExceptAdvice } from "@/lib/morning/brief/assembler";
import { computeAdviceFlags } from "@/lib/morning/brief/flags";
import { generateAdvice } from "@/lib/morning/brief/advice-prompt";

export async function buildMorningBrief(
  supabase: SupabaseClient,
  userId: string,
): Promise<MorningBriefCard> {
  const today = todayInUserTz();
  const inputs = await fetchBriefInputs(supabase, userId, today);
  const partial = assembleBriefExceptAdvice(inputs);
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
  });
  return { ...partial, advice_md };
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
