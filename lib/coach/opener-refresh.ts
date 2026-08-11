// lib/coach/opener-refresh.ts
//
// A coach opener is written once per thread per rolling 18h window, on the
// athlete's first chat open — typically ~04:30, hours before training. It
// never rewrites itself, so a morning opener cannot mention the session
// that follows it.
//
// On session commit we clear the day's opener so the next visit regenerates
// one that knows about the session. Only when the athlete has not engaged
// the thread: once the athlete has replied, the greeting is load-bearing
// history, and deleting it would orphan the reply. It is also unnecessary —
// live chat turns read the snapshot, which already carries today's workouts.
//
// "Engagement" cannot be read off `role === "user"` alone: the turn-creating
// RPC never stamps `kind` on the assistant row it inserts (the column
// defaults to 'coach'), so an ordinary assistant reply is byte-identical to
// an opener on (kind, role) — a naive "newest coach/assistant row" check
// deletes the athlete's actual answer, not a stale greeting. The correct
// signal is a preceding USER turn: an opener is only clearable when the
// thread contains no `role === "user"` row of `kind === "coach"` since
// `dayStartUtc`. The kind scoping matters just as much as the role scoping —
// the morning-intake bot echoes the athlete's check-in answers as
// `role: "user", kind: "morning_intake"` rows in the 'remi' thread, and
// every athlete who checks in produces one of these daily. Treating that as
// engagement would permanently suppress Remi's opener refresh.
//
// Non-coach ASSISTANT rows (e.g. a workout_debrief card) are left out of the
// engagement test but still block clearing via the "newest relevant row"
// check below — once any card has landed in the thread, the greeting is
// history and there's nothing left to regenerate for.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ThreadRow = {
  id: string;
  thread: string;
  kind: string;
  role: string;
  created_at: string;
};

/** Ids of openers that are safe to clear.
 *
 *  Per thread: rows before `dayStartUtc` are ignored, then rows with
 *  `role === "user"` and `kind !== "coach"` (off-flow user turns like
 *  morning-intake echoes) are dropped entirely — they are not part of the
 *  coach conversation and must not affect either the engagement test or
 *  "what's newest". If any remaining row is a `role === "user"` turn, the
 *  thread is engaged and nothing is cleared. Otherwise, if the newest
 *  remaining row is the coach's own `kind: "coach", role: "assistant"`
 *  opener, it is stale and safe to delete. */
export function selectStaleOpenerIds(
  rows: readonly ThreadRow[],
  dayStartUtc: string,
): string[] {
  const relevantByThread = new Map<string, ThreadRow[]>();
  for (const r of rows) {
    if (r.created_at < dayStartUtc) continue;
    if (r.role === "user" && r.kind !== "coach") continue; // off-flow, e.g. morning_intake
    const list = relevantByThread.get(r.thread);
    if (list) list.push(r);
    else relevantByThread.set(r.thread, [r]);
  }

  const ids: string[] = [];
  for (const thread of relevantByThread.values()) {
    const engaged = thread.some((r) => r.role === "user");
    if (engaged) continue;

    let newest: ThreadRow | null = null;
    for (const r of thread) {
      if (!newest || r.created_at > newest.created_at) newest = r;
    }
    if (newest && newest.kind === "coach" && newest.role === "assistant") {
      ids.push(newest.id);
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
