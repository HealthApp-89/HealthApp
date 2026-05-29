// lib/coach/trends/compose-block-history.ts
//
// Trends-page wrapper around generateBlockTrajectory. Keeps the trends
// architecture's "composer per section" shape.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BlockTrajectoryPayload } from "@/lib/data/types";
import { generateBlockTrajectory } from "@/lib/coach/block-outcomes/trajectory";

export async function composeBlockHistoryForTrends(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<BlockTrajectoryPayload> {
  return generateBlockTrajectory(opts);
}
