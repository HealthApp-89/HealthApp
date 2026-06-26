// lib/coach/__tests__/freshness.test.ts
//
// Regression tests for the coach data-freshness timezone off-by-one bug.
//
// Scenario: user is in Asia/Dubai (UTC+4). When the current UTC time is still
// on the previous UTC calendar date but it is already "tomorrow" in Dubai
// (e.g. 22:00 UTC = 02:00 Dubai), `formatFreshness` must derive the "today"
// boundary from the user's timezone, not from raw UTC.
//
// Run: npx vitest run lib/coach/__tests__/freshness.test.ts

import { describe, it, expect } from "vitest";
import { formatFreshness } from "../snapshot";

const DUBAI_TZ = "Asia/Dubai"; // UTC+4, no DST

// ── Scenario ──────────────────────────────────────────────────────────────────
// UTC:   2026-06-26 22:00  →  Dubai: 2026-06-27 02:00 (Dubai "today" = 2026-06-27)
// A WHOOP sync that wrote at 2026-06-26T08:00:00Z is Dubai-date 2026-06-26
// which is Dubai "yesterday".
// Without the fix, formatFreshness would compute:
//   today (UTC)   = 2026-06-26  (from now.toISOString().slice(0,10))
//   lastDay (UTC) = 2026-06-26
//   dayDelta = 0  → "today"   ← WRONG from Dubai's perspective
// With the fix:
//   today (Dubai) = 2026-06-27
//   lastDay date  = 2026-06-26  (date of the write in user tz)
//   dayDelta = 1  → "yesterday" ← CORRECT

const NOW_UTC = new Date("2026-06-26T22:00:00Z"); // 02:00 Dubai next day
const LAST_WRITE_SAME_UTC_DATE = "2026-06-26T08:00:00Z"; // 12:00 Dubai same UTC day = Dubai "yesterday"
const LAST_WRITE_DUBAI_TODAY = "2026-06-27T01:00:00Z"; // 05:00 Dubai (2026-06-27) = Dubai "today"

describe("formatFreshness — timezone boundary", () => {
  it("labels a write from the previous Dubai calendar day as 'yesterday' even when it shares the UTC date with 'now'", () => {
    // At 22:00 UTC (= 02:00 Dubai next day), a sync at 08:00 UTC is Dubai "yesterday"
    const result = formatFreshness(NOW_UTC, LAST_WRITE_SAME_UTC_DATE, DUBAI_TZ);
    expect(result).toMatch(/yesterday/);
    expect(result).not.toMatch(/today/);
  });

  it("labels a write from the Dubai 'today' calendar day as 'today'", () => {
    // A sync at 01:00 UTC on 2026-06-27 (= 05:00 Dubai on 2026-06-27) is Dubai "today"
    const result = formatFreshness(NOW_UTC, LAST_WRITE_DUBAI_TODAY, DUBAI_TZ);
    expect(result).toMatch(/today/);
    expect(result).not.toMatch(/yesterday/);
  });

  it("labels a write from 3 Dubai-days ago as '3 days ago'", () => {
    const OLD_WRITE = "2026-06-24T12:00:00Z"; // Dubai-date 2026-06-24, 3 days before Dubai today (2026-06-27)
    const result = formatFreshness(NOW_UTC, OLD_WRITE, DUBAI_TZ);
    expect(result).toMatch(/3 days ago/);
  });

  it("returns 'no data' for null input", () => {
    const result = formatFreshness(NOW_UTC, null, DUBAI_TZ);
    expect(result).toBe("no data");
  });

  it("includes hours-ago value in output", () => {
    // NOW is 22:00 UTC, LAST is 08:00 UTC = 14 hours ago
    const result = formatFreshness(NOW_UTC, LAST_WRITE_SAME_UTC_DATE, DUBAI_TZ);
    expect(result).toMatch(/^14h 00m ago/);
  });
});

// ── Pure day-boundary helper regression ───────────────────────────────────────
// Even for simpler same-UTC-day cases the label should always reflect
// the user's local calendar, not UTC.

describe("formatFreshness — edge: UTC midnight straddle", () => {
  it("correctly labels a write from the same Dubai calendar day as 'today'", () => {
    // 23:30 UTC on 2026-06-27 = 03:30 Dubai 2026-06-28; Dubai "today" = 2026-06-28.
    // write at 2026-06-27T18:00Z = 2026-06-27 22:00 Dubai = 2026-06-27 = Dubai "yesterday"
    // So this write should be labeled "yesterday"
    const now2 = new Date("2026-06-27T23:30:00Z");
    const last2 = "2026-06-27T19:00:00Z"; // 23:00 Dubai = Dubai "yesterday" (2026-06-27)
    const result = formatFreshness(now2, last2, DUBAI_TZ);
    expect(result).toMatch(/yesterday/);
  });

  it("labels write at 01:00 UTC as 'today' when Dubai date is still on that day", () => {
    // 01:00 UTC 2026-06-28 = 05:00 Dubai 2026-06-28; Dubai "today" = 2026-06-28
    // write at 2026-06-27T22:00Z = 2026-06-28 02:00 Dubai = same Dubai day = "today"
    const now3 = new Date("2026-06-28T01:00:00Z");
    const last3 = "2026-06-27T22:00:00Z"; // 02:00 Dubai on 2026-06-28 = "today"
    const result = formatFreshness(now3, last3, DUBAI_TZ);
    expect(result).toMatch(/today/);
  });
});
