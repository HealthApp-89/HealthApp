// lib/chat/__tests__/load-older.test.ts
//
// Regression suite for the runaway load-older loop (2026-08-11).
//
// Measured symptom: with the coach lane render-scoped to today+yesterday, the
// logger sheet open, and the athlete touching nothing, the app fired
// `/api/chat/messages?limit=50&before=<same cursor every time>` ~1.2×/second,
// 113.8 KB a response. In 200 seconds it pulled 26 MB and grew the in-memory
// message array from 694 to 11,744 entries; the worst animation-frame gap
// climbed monotonically 0 → 237 ms. See the module header of ../load-older.

import { describe, it, expect } from "vitest";
import { planOlderPage, mergeOlder } from "@/lib/chat/load-older";

const msg = (id: string, createdAt: string) => ({ id, created_at: createdAt });

describe("planOlderPage", () => {
  it("pages from the OLDEST LOADED message, not the oldest rendered one", () => {
    // The loop's engine: the sentinel handed over the oldest *rendered*
    // message, but the fetched page lands outside the render scope, so that
    // cursor never moved and the same 50 rows came back forever.
    const decision = planOlderPage({
      oldestLoadedIso: "2026-06-01T10:00:00Z",
      hasMoreOlder: true,
      scopeHidesMessages: false,
    });
    expect(decision).toEqual({ run: true, before: "2026-06-01T10:00:00Z" });
  });

  it("does not auto-page while a render scope is collapsing the thread", () => {
    // While the "Show N earlier messages" pill is up, prepending cannot change
    // what is on screen — so the top sentinel is not a paging signal, and the
    // pill is the athlete's way back. Firing here is the loop.
    expect(
      planOlderPage({
        oldestLoadedIso: "2026-06-01T10:00:00Z",
        hasMoreOlder: true,
        scopeHidesMessages: true,
      }),
    ).toEqual({ run: false, reason: "scope_collapsed" });
  });

  it("stops once the server has said there is nothing older", () => {
    expect(
      planOlderPage({
        oldestLoadedIso: "2026-06-01T10:00:00Z",
        hasMoreOlder: false,
        scopeHidesMessages: false,
      }),
    ).toEqual({ run: false, reason: "no_more" });
  });

  it("stops when there is no cursor to page from", () => {
    expect(
      planOlderPage({
        oldestLoadedIso: null,
        hasMoreOlder: true,
        scopeHidesMessages: false,
      }),
    ).toEqual({ run: false, reason: "empty" });
  });
});

describe("mergeOlder", () => {
  it("drops ids already held, so a repeated page cannot grow the thread", () => {
    const existing = [msg("a", "2026-06-01T10:00:00Z"), msg("b", "2026-06-01T11:00:00Z")];
    const { messages, added } = mergeOlder(existing, [
      msg("z", "2026-06-01T09:00:00Z"),
      msg("a", "2026-06-01T10:00:00Z"), // already held
    ]);
    expect(added).toBe(1);
    expect(messages.map((m) => m.id)).toEqual(["z", "a", "b"]);
  });

  it("is a no-op — same array identity — when the page is entirely duplicates", () => {
    // Identity matters: a fresh array would re-run every downstream useMemo and
    // re-render the whole thread for no new content.
    const existing = [msg("a", "2026-06-01T10:00:00Z")];
    const { messages, added } = mergeOlder(existing, [msg("a", "2026-06-01T10:00:00Z")]);
    expect(added).toBe(0);
    expect(messages).toBe(existing);
  });

  it("reports added:0 for an empty page", () => {
    const existing = [msg("a", "2026-06-01T10:00:00Z")];
    const { messages, added } = mergeOlder(existing, []);
    expect(added).toBe(0);
    expect(messages).toBe(existing);
  });

  it("terminates: a repeated page adds nothing however many times it arrives", () => {
    // The measured failure was 50 new rows per second forever. Re-running the
    // identical page must converge instead.
    const page = [msg("z", "2026-06-01T09:00:00Z"), msg("y", "2026-06-01T09:30:00Z")];
    let cur: { id: string; created_at: string }[] = [msg("a", "2026-06-01T10:00:00Z")];
    for (let i = 0; i < 20; i++) cur = mergeOlder(cur, page).messages;
    expect(cur).toHaveLength(3);
  });
});
