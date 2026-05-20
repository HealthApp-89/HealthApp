// lib/chat/mark-thread-seen.ts
//
// Client-side helper called by specialist pages (Strength/Diet/Health)
// and Metrics (Peter) when the user lands on them. Fire-and-forget POST
// to /api/chat/mark-thread-seen. Failures are silently swallowed — the
// dot will stay until the next successful seen-write, which is fine.

import type { Speaker } from "@/lib/data/types";

export async function markThreadSeen(thread: Speaker): Promise<void> {
  try {
    await fetch("/api/chat/mark-thread-seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread }),
    });
  } catch {
    // Silent failure — UX-critical paths don't depend on this.
  }
}
