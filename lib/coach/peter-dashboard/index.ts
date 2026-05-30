// lib/coach/peter-dashboard/index.ts
//
// Orchestrator. Parallel-runs the 6 composers, detects clusters, runs the
// narrative wrap, returns the typed PeterDashboardPayload. Also exposes
// loadLatestPeterDashboard() for readers (chat-stream, dashboard UI).

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Narrative,
  PeterDashboardFacts,
  PeterDashboardPayload,
  ThemeKey,
  ThemePayload,
} from './types';
import { composeRecomp } from './compose-recomp';
import { composeEnergy } from './compose-energy';
import { composeFatigue } from './compose-fatigue';
import { composePerformance } from './compose-performance';
import { composePlanAdherence } from './compose-plan-adherence';
import { composeGoalDistance } from './compose-goal-distance';
import { composeEndurance } from './compose-endurance';
import { linkThemes } from './link-themes';
import { narrate, fallbackNarrative } from './narrate';
import { generateCoachTrends } from '@/lib/coach/trends';

export async function generatePeterDashboard(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<PeterDashboardPayload> {
  const { supabase, userId, today } = args;

  // Trends + block/goal context are parent deps for the composers below.
  // We fetch block_context + goal_summary up-front (cheap point reads) so
  // composePerformance can branch on focus_lift / goal_metric — previously
  // these were fetched only for the narrative wrapper, leaving the
  // Performance composer block-agnostic and conflating off-focus plateaus
  // with block-critical stalls.
  const [trends, blockContext, goalSummary] = await Promise.all([
    generateCoachTrends({ supabase, userId, today }),
    fetchBlockContext(supabase, userId, today),
    fetchGoalSummary(supabase, userId),
  ]);

  const [recomp, energy, fatigue, performance, planAdherence, endurance, goalDistance] =
    await Promise.all([
      composeRecomp({ supabase, userId, today, trends }),
      composeEnergy({ supabase, userId, today }),
      composeFatigue({ supabase, userId, today }),
      composePerformance({
        supabase,
        userId,
        today,
        trends,
        focusLift: blockContext.primary_lift,
        goalLiftMetric: goalSummary.metric,
      }),
      composePlanAdherence({ supabase, userId, today }),
      composeEndurance({ supabase, userId, today }),
      composeGoalDistance({ supabase, userId, today, trends }),
    ]);

  const themes: Record<ThemeKey, ThemePayload> = {
    recomp, energy, fatigue, performance,
    plan_adherence: planAdherence,
    endurance,
    goal_distance: goalDistance,
  };

  const clusters = linkThemes(themes);

  const facts: PeterDashboardFacts = {
    themes,
    clusters,
    block_context: blockContext,
    goal_summary: goalSummary,
  };

  const narrateResult = await narrate(facts);
  const narrative: Narrative = narrateResult.failed
    ? fallbackNarrative(themes)
    : narrateResult.narrative!;

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    facts,
    narrative,  // always populated; fallback when AI failed
    narrative_failed: narrateResult.failed,
    narrative_failure_reason: narrateResult.failed ? (narrateResult.failure_reason ?? null) : null,
  };
}

async function fetchBlockContext(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<PeterDashboardFacts['block_context']> {
  // Schema note: training_blocks has no canonical block_number column.
  // We derive total_weeks from (end_date - start_date)/7 and leave
  // block_number null. See migration 0008_weekly_planning.sql.
  const { data, error } = await supabase
    .from('training_blocks')
    .select('start_date, end_date, primary_lift')
    .eq('user_id', userId)
    .lte('start_date', today)
    .gte('end_date', today)
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return { block_number: null, week_of_block: null, block_total_weeks: null, primary_lift: null };
  }
  const startMs = new Date(`${data.start_date as string}T00:00:00Z`).getTime();
  const endMs = new Date(`${data.end_date as string}T00:00:00Z`).getTime();
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const weekOf = Math.floor((todayMs - startMs) / (7 * 24 * 3600 * 1000)) + 1;
  const totalWeeks = Math.round((endMs - startMs) / (7 * 24 * 3600 * 1000));
  return {
    block_number: null,  // no canonical "block_number" column; left null
    week_of_block: weekOf,
    block_total_weeks: totalWeeks,
    primary_lift: (data.primary_lift as string | null) ?? null,
  };
}

async function fetchGoalSummary(
  supabase: SupabaseClient,
  userId: string,
): Promise<PeterDashboardFacts['goal_summary']> {
  const { data, error } = await supabase
    .from('athlete_profile_documents')
    .select('goal_kind, goal_metric, goal_target, goal_target_date')
    .eq('user_id', userId)
    .not('acknowledged_at', 'is', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return { kind: null, metric: null, target: null, target_date: null };
  }
  return {
    kind: (data.goal_kind as PeterDashboardFacts['goal_summary']['kind']) ?? null,
    metric: (data.goal_metric as string | null) ?? null,
    target: (data.goal_target as number | null) ?? null,
    target_date: (data.goal_target_date as string | null) ?? null,
  };
}

/** Reader used by the SSR-hydrate fetcher and chat-stream injection.
 *  Returns the latest version row for the given date — null when none exists. */
export async function loadLatestPeterDashboard(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<{ payload: PeterDashboardPayload; narrative_md: string; generated_on: string; version: number } | null> {
  const { data, error } = await supabase
    .from('coach_dashboards')
    .select('payload, narrative_md, generated_on, version')
    .eq('user_id', userId)
    .eq('generated_on', date)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    payload: data.payload as PeterDashboardPayload,
    narrative_md: data.narrative_md as string,
    generated_on: data.generated_on as string,
    version: data.version as number,
  };
}
