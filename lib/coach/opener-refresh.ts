// lib/coach/opener-refresh.ts
//
// A coach opener is written once per thread per rolling 18h window, on the
// athlete's first chat open — typically ~04:30, hours before training. It
// never rewrites itself, so a morning opener cannot mention the session
// that follows it.
//
// On session commit we clear the day's opener so the next visit regenerates
// one that knows about the session. Only when it is still the newest row in
// its thread: once the athlete has replied, the greeting is load-bearing
// history, and deleting it would orphan the reply. It is also unnecessary —
// live chat turns read the snapshot, which already carries today's workouts.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ThreadRow = {
  id: string;
  thread: string;
  kind: string;
  role: string;
  created_at: string;
};

/** Ids of openers that are safe to clear: newest row in their thread, kind
 *  'coach', assistant-authored, and created on or after the local day start. */
export function selectStaleOpenerIds(
  rows: readonly ThreadRow[],
  dayStartUtc: string,
): string[] {
  const newestByThread = new Map<string, ThreadRow>();
  for (const r of rows) {
    const cur = newestByThread.get(r.thread);
    if (!cur || r.created_at > cur.created_at) newestByThread.set(r.thread, r);
  }
  const ids: string[] = [];
  for (const r of newestByThread.values()) {
    if (r.kind === "coach" && r.role === "assistant" && r.created_at >= dayStartUtc) {
      ids.push(r.id);
    }
  }
  return ids;
}

/** Fetches today's rows across all coach threads, decides which openers are
 *  stale, and deletes them. Returns the number deleted. */
export async function clearStaleOpeners(opts: {
  supabase: SupabaseClient;
  userId: string;
  dayStartUtc: string;
}): Promise<number> {
  const { supabase, userId, dayStartUtc } = opts;

  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, thread, kind, role, created_at")
    .eq("user_id", userId)
    .gte("created_at", dayStartUtc)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const ids = selectStaleOpenerIds((data ?? []) as ThreadRow[], dayStartUtc);
  if (ids.length === 0) return 0;

  const { error: delErr } = await supabase
    .from("chat_messages")
    .delete()
    .eq("user_id", userId)
    .in("id", ids);
  if (delErr) throw delErr;
  return ids.length;
}
