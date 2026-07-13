// lib/query/fetchers/blocksRepo.ts
//
// Raw training_blocks + block_outcomes rows for the Blocks-tab history list.
// Returns newest-first. Browser fetcher is live-data (RLS client); server
// fetcher uses the server-side Supabase client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { TrainingBlock, BlockOutcome } from "@/lib/data/types";

export type BlockRepoRow = {
  block: TrainingBlock;
  outcome: BlockOutcome | null;
};

const BLOCK_SELECT =
  "id, user_id, status, start_date, end_date, goal_text, primary_lift, target_metric, target_value, target_hit_at_week, target_unit, diet_goal, endurance_focus, session_structure_overrides, created_at, completed_at, updated_at";

const OUTCOME_SELECT =
  "id, block_id, user_id, primary_lift, target_value_kg, target_metric, end_working_kg, target_hit, target_hit_at_week, block_phase_at_end, lessons, recommended_next_focus, recommended_target_value_kg, athlete_acknowledged_at, narrative_md, created_at, updated_at";

async function fetchBlocksRepo(supabase: SupabaseClient, userId: string): Promise<BlockRepoRow[]> {
  const { data: blocks, error: bErr } = await supabase
    .from("training_blocks")
    .select(BLOCK_SELECT)
    .eq("user_id", userId)
    .order("start_date", { ascending: false });
  if (bErr) throw bErr;
  if (!blocks || blocks.length === 0) return [];

  const blockIds = (blocks as TrainingBlock[]).map((b) => b.id);
  const { data: outcomes, error: oErr } = await supabase
    .from("block_outcomes")
    .select(OUTCOME_SELECT)
    .in("block_id", blockIds);
  if (oErr) throw oErr;

  const outcomeByBlockId = new Map<string, BlockOutcome>();
  for (const o of (outcomes ?? []) as BlockOutcome[]) {
    outcomeByBlockId.set(o.block_id, o);
  }

  return (blocks as TrainingBlock[]).map((block) => ({
    block,
    outcome: outcomeByBlockId.get(block.id) ?? null,
  }));
}

export async function fetchBlocksRepoServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<BlockRepoRow[]> {
  return fetchBlocksRepo(supabase, userId);
}

export async function fetchBlocksRepoBrowser(userId: string): Promise<BlockRepoRow[]> {
  const supabase = createSupabaseBrowserClient();
  return fetchBlocksRepo(supabase as unknown as SupabaseClient, userId);
}
