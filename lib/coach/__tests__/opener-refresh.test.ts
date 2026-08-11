// lib/coach/__tests__/opener-refresh.test.ts
//
// The opener is a dawn artifact — written on first chat open, hours before
// training, and never rewritten. After a session commit we clear it so the
// next greeting knows about the session. It is only clearable when the
// thread has had no `kind='coach'` `role='user'` turn since local day
// start — once the athlete has actually engaged the thread, the opener is
// history and deleting it would orphan the reply. Morning-intake user rows
// (`kind='morning_intake'`) are deliberately excluded from that engagement
// test: they're the intake bot echoing the athlete's check-in answers, not
// a reply to the opener, and every athlete produces one daily.

import { describe, it, expect } from "vitest";
import { selectStaleOpenerIds, type ThreadRow } from "@/lib/coach/opener-refresh";

const DAY_START = "2026-08-11T20:00:00Z"; // 00:00 Dubai on 2026-08-12

function opener(thread: string, id: string, created_at: string): ThreadRow {
  return { id, thread, kind: "coach", role: "assistant", created_at };
}

describe("selectStaleOpenerIds", () => {
  it("clears an opener nobody replied to", () => {
    const rows = [opener("carter", "o1", "2026-08-12T00:17:00Z")];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual(["o1"]);
  });

  it("preserves an opener the athlete replied to", () => {
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      { id: "u1", thread: "carter", kind: "coach", role: "user", created_at: "2026-08-12T09:00:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("preserves an opener followed by any other card", () => {
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      { id: "d1", thread: "carter", kind: "workout_debrief", role: "assistant", created_at: "2026-08-12T09:42:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("ignores an opener from before today", () => {
    const rows = [opener("carter", "o1", "2026-08-11T00:17:00Z")];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("decides each thread independently", () => {
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      opener("remi", "o2", "2026-08-12T00:29:00Z"),
      { id: "u1", thread: "remi", kind: "coach", role: "user", created_at: "2026-08-12T09:00:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual(["o1"]);
  });

  it("returns nothing for an empty thread set", () => {
    expect(selectStaleOpenerIds([], DAY_START)).toEqual([]);
  });

  it("preserves an opener answered by an ordinary assistant reply", () => {
    // The turn-creating RPC never stamps `kind` on the assistant row it
    // inserts, and the column defaults to 'coach' — so an ordinary chat
    // reply is byte-identical to an opener on (kind, role). The distinguishing
    // signal is the user turn that precedes it.
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      { id: "u1", thread: "carter", kind: "coach", role: "user", created_at: "2026-08-12T08:00:00Z" },
      { id: "r1", thread: "carter", kind: "coach", role: "assistant", created_at: "2026-08-12T08:05:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("still clears the opener when a morning_intake user row shares the thread", () => {
    // Real production shape: the morning-intake bot echoes the athlete's
    // own check-in answers as a role='user' row in the 'remi' thread, kind
    // 'morning_intake'. Every athlete who does the check-in produces one of
    // these daily — treating it as engagement would permanently disable
    // Remi's opener refresh. It must not count.
    const rows: ThreadRow[] = [
      opener("remi", "o1", "2026-08-12T00:29:00Z"),
      {
        id: "mi1",
        thread: "remi",
        kind: "morning_intake",
        role: "user",
        created_at: "2026-08-12T04:31:00Z",
      },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual(["o1"]);
  });
});
