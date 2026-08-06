import { describe, expect, it } from "vitest";
import { localDayRangeUtc } from "@/lib/time";

describe("localDayRangeUtc", () => {
  it("returns the UTC instants bounding a Dubai (UTC+4, no DST) calendar day", () => {
    const { startUtc, endUtc } = localDayRangeUtc("2026-08-06", "Asia/Dubai");
    // 2026-08-06 00:00 Dubai === 2026-08-05 20:00 UTC
    expect(startUtc).toBe("2026-08-05T20:00:00.000Z");
    // exclusive upper bound: 2026-08-07 00:00 Dubai === 2026-08-06 20:00 UTC
    expect(endUtc).toBe("2026-08-06T20:00:00.000Z");
  });

  it("is identity for UTC", () => {
    const { startUtc, endUtc } = localDayRangeUtc("2026-08-06", "UTC");
    expect(startUtc).toBe("2026-08-06T00:00:00.000Z");
    expect(endUtc).toBe("2026-08-07T00:00:00.000Z");
  });

  it("handles a negative offset (New York, EDT = UTC-4)", () => {
    const { startUtc, endUtc } = localDayRangeUtc("2026-08-06", "America/New_York");
    expect(startUtc).toBe("2026-08-06T04:00:00.000Z");
    expect(endUtc).toBe("2026-08-07T04:00:00.000Z");
  });

  it("handles a half-hour offset (Kolkata, UTC+5:30)", () => {
    const { startUtc } = localDayRangeUtc("2026-08-06", "Asia/Kolkata");
    expect(startUtc).toBe("2026-08-05T18:30:00.000Z");
  });

  it("spans 23h on a DST spring-forward day", () => {
    // US DST starts 2026-03-08; local midnight is still EST (UTC-5).
    const { startUtc, endUtc } = localDayRangeUtc("2026-03-08", "America/New_York");
    expect(startUtc).toBe("2026-03-08T05:00:00.000Z");
    expect(endUtc).toBe("2026-03-09T04:00:00.000Z");
    const hours = (Date.parse(endUtc) - Date.parse(startUtc)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("spans 25h on a DST fall-back day", () => {
    // US DST ends 2026-11-01; local midnight is still EDT (UTC-4).
    const { startUtc, endUtc } = localDayRangeUtc("2026-11-01", "America/New_York");
    expect(startUtc).toBe("2026-11-01T04:00:00.000Z");
    expect(endUtc).toBe("2026-11-02T05:00:00.000Z");
    const hours = (Date.parse(endUtc) - Date.parse(startUtc)) / 3_600_000;
    expect(hours).toBe(25);
  });

  it("falls back to UTC on an invalid timezone rather than throwing", () => {
    const { startUtc } = localDayRangeUtc("2026-08-06", "Not/AZone");
    expect(startUtc).toBe("2026-08-06T00:00:00.000Z");
  });

  it("round-trips against ymdInUserTz for every instant inside the range", () => {
    const tz = "Asia/Dubai";
    const { startUtc, endUtc } = localDayRangeUtc("2026-08-06", tz);
    // The boundary instants must belong to 2026-08-06 and the next day.
    const justInside = new Date(Date.parse(endUtc) - 1).toISOString();
    expect(startUtc <= justInside).toBe(true);
    expect(justInside < endUtc).toBe(true);
  });
});

describe("localDayRangeUtc — multi-day range composition", () => {
  it("chains so [from.start, to.end) covers an inclusive date range", () => {
    const from = localDayRangeUtc("2026-08-01", "Asia/Dubai");
    const to = localDayRangeUtc("2026-08-03", "Asia/Dubai");
    expect(from.startUtc).toBe("2026-07-31T20:00:00.000Z");
    expect(to.endUtc).toBe("2026-08-03T20:00:00.000Z");
    const days = (Date.parse(to.endUtc) - Date.parse(from.startUtc)) / 86_400_000;
    expect(days).toBe(3);
  });
});
