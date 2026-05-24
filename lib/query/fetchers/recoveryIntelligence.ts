import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateRecoveryIntelligence,
} from "@/lib/coach/recovery-intelligence";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";

export async function fetchRecoveryIntelligenceServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<RecoveryIntelligencePayload> {
  return generateRecoveryIntelligence({ supabase, userId, today });
}

export async function fetchRecoveryIntelligenceBrowser(): Promise<RecoveryIntelligencePayload> {
  throw new Error(
    "recoveryIntelligence browser fetcher: not implemented — use SSR hydrate only.",
  );
}
