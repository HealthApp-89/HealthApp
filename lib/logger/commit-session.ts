import { createSupabaseServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { CommitSessionPayload } from "@/lib/logger/types";

/**
 * Server action: calls commit_logger_session(payload) RPC, then revalidates
 * the surfaces that show today's lifts.
 */
export async function commitSession(payload: CommitSessionPayload): Promise<{
  workout_id: string;
}> {
  const supabase = await createSupabaseServerClient();

  // Auth check — the RPC also enforces, but failing fast here gives a better error.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Not authenticated");
  if (user.id !== payload.user_id) throw new Error("user_id mismatch");

  // Defensive: at most 30 exercises, at most 30 sets per exercise (also enforced in RPC).
  if (payload.exercises.length > 30) {
    throw new Error("Too many exercises in one session (max 30)");
  }
  for (const ex of payload.exercises) {
    if (ex.sets.length > 30) {
      throw new Error(`Too many sets for ${ex.name} (max 30)`);
    }
  }

  const { data, error } = await supabase.rpc("commit_logger_session", {
    payload: payload as unknown as Record<string, unknown>,
  });

  if (error) throw error;
  if (typeof data !== "string") throw new Error("commit_logger_session returned unexpected shape");

  revalidatePath("/strength");
  revalidatePath("/");
  revalidatePath("/metrics");

  return { workout_id: data };
}
