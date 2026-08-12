import { describe, it, expect } from "vitest";
import { banisterOverIntervals, medianGapSeconds } from "@/lib/coach/strain/trimp";
import type { HrSample } from "@/lib/coach/strain/types";

/** n samples at `bpm`, spaced `gapS` seconds apart, starting at t0. */
function stream(n: number, bpm: number, gapS: number, t0 = 0): HrSample[] {
  return Array.from({ length: n }, (_, i) => ({ ts: t0 + i * gapS * 1000, bpm }));
}

describe("banisterOverIntervals", () => {
  it("returns 0 for fewer than two samples", () => {
    expect(banisterOverIntervals([], 50, 183)).toBe(0);
    expect(banisterOverIntervals([{ ts: 0, bpm: 150 }], 50, 183)).toBe(0);
  });

  it("returns 0 when the reserve is degenerate", () => {
    expect(banisterOverIntervals(stream(10, 150, 60), 183, 183)).toBe(0);
  });

  it("scores a resting stream at zero — HRr clamps at 0", () => {
    expect(banisterOverIntervals(stream(31, 45, 120), 50, 183)).toBe(0);
  });

  it("matches the Banister formula on a single interval", () => {
    const hrr = (150 - 50) / (183 - 50);
    const expected = 2 * hrr * (0.64 * Math.exp(1.92 * hrr));
    const samples: HrSample[] = [
      { ts: 0, bpm: 150 },
      { ts: 120_000, bpm: 150 },
    ];
    expect(banisterOverIntervals(samples, 50, 183)).toBeCloseTo(expected, 9);
  });

  it("clamps a long off-wrist gap to MAX_INTERVAL_MIN", () => {
    const short: HrSample[] = [
      { ts: 0, bpm: 150 },
      { ts: 10 * 60_000, bpm: 150 },
    ];
    const long: HrSample[] = [
      { ts: 0, bpm: 150 },
      { ts: 6 * 60 * 60_000, bpm: 150 },
    ];
    expect(banisterOverIntervals(long, 50, 183)).toBeCloseTo(
      banisterOverIntervals(short, 50, 183),
      9,
    );
  });

  it("uses the leading sample's HR for each interval", () => {
    const rising: HrSample[] = [
      { ts: 0, bpm: 100 },
      { ts: 60_000, bpm: 180 },
    ];
    const hrr = (100 - 50) / (183 - 50);
    expect(banisterOverIntervals(rising, 50, 183)).toBeCloseTo(
      1 * hrr * (0.64 * Math.exp(1.92 * hrr)),
      9,
    );
  });

  it("skips intervals inside an excluded window entirely", () => {
    // 60 samples 1 min apart, all at 150. Exclude minutes 20-40.
    const s = stream(61, 150, 60);
    const all = banisterOverIntervals(s, 50, 183);
    const excluded = banisterOverIntervals(s, 50, 183, [
      { startMs: 20 * 60_000, endMs: 40 * 60_000 },
    ]);
    expect(excluded).toBeLessThan(all);
    expect(excluded).toBeCloseTo(all * (40 / 60), 6);
  });

  it("does NOT credit the excluded span as one long interval", () => {
    // The bug this function exists to prevent: filtering samples first would
    // leave a 20-minute gap scored at the pre-window heart rate.
    const s = stream(61, 150, 60);
    const excluded = banisterOverIntervals(s, 50, 183, [
      { startMs: 20 * 60_000, endMs: 40 * 60_000 },
    ]);
    const naive = banisterOverIntervals(
      s.filter((x) => x.ts < 20 * 60_000 || x.ts >= 40 * 60_000),
      50,
      183,
    );
    expect(excluded).toBeLessThan(naive);
  });

  it("reduces to a plain walk when no windows are given", () => {
    const s = stream(20, 140, 120);
    expect(banisterOverIntervals(s, 50, 183, [])).toBeCloseTo(
      banisterOverIntervals(s, 50, 183),
      9,
    );
  });
});

describe("medianGapSeconds", () => {
  it("returns null for fewer than two samples", () => {
    expect(medianGapSeconds([])).toBeNull();
    expect(medianGapSeconds([{ ts: 0, bpm: 60 }])).toBeNull();
  });

  it("reports 120 for the Fenix all-day wellness stream", () => {
    expect(medianGapSeconds(stream(720, 65, 120))).toBe(120);
  });

  it("reports 1 for a 1-second activity stream", () => {
    expect(medianGapSeconds(stream(600, 130, 1))).toBe(1);
  });

  it("is unmoved by a single huge outlier gap", () => {
    const s = [...stream(50, 65, 120), { ts: 50 * 120_000 + 8 * 3600_000, bpm: 65 }];
    expect(medianGapSeconds(s)).toBe(120);
  });
});
