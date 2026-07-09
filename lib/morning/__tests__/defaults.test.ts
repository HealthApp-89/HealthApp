import { describe, it, expect } from "vitest";
import {
  computeMorningDefaults,
  DEFAULTS_FALLBACK,
  type DefaultsInputRow,
} from "@/lib/morning/defaults";

function row(
  readiness: number | null,
  fatigue: DefaultsInputRow["fatigue"] = "some",
  intake_source: string | null = null,
): DefaultsInputRow {
  return { readiness, fatigue, intake_source };
}

describe("computeMorningDefaults", () => {
  it("falls back below 7 explicit rows", () => {
    expect(computeMorningDefaults([])).toEqual(DEFAULTS_FALLBACK);
    expect(
      computeMorningDefaults([row(3), row(3), row(3), row(3), row(3), row(3)]),
    ).toEqual(DEFAULTS_FALLBACK);
  });

  it("returns median readiness (odd count)", () => {
    const rows = [row(4), row(5), row(6), row(7), row(8), row(9), row(10)];
    expect(computeMorningDefaults(rows).readiness).toBe(7);
  });

  it("returns rounded mid-average readiness (even count)", () => {
    const rows = [row(4), row(5), row(6), row(7), row(8), row(9), row(9), row(10)];
    // middles are 7 and 8 → round(7.5) = 8
    expect(computeMorningDefaults(rows).readiness).toBe(8);
  });

  it("returns modal fatigue", () => {
    const rows = [
      row(7, "none"), row(7, "none"), row(7, "heavy"),
      row(7, "some"), row(7, "some"), row(7, "some"), row(7, "some"),
    ];
    expect(computeMorningDefaults(rows).fatigue).toBe("some");
  });

  it("tie-breaks fatigue toward some, then none, then heavy", () => {
    const tied = [
      row(7, "none"), row(7, "none"), row(7, "none"),
      row(7, "some"), row(7, "some"), row(7, "some"),
      row(7, "heavy"),
    ];
    expect(computeMorningDefaults(tied).fatigue).toBe("some");
    const noneVsHeavy = [
      row(7, "none"), row(7, "none"), row(7, "none"),
      row(7, "heavy"), row(7, "heavy"), row(7, "heavy"),
      row(7, "some"),
    ];
    // none: 3, heavy: 3, some: 1 → tie between none/heavy → 'none'
    expect(computeMorningDefaults(noneVsHeavy).fatigue).toBe("none");
  });

  it("excludes all_good rows (feedback-loop guard)", () => {
    const rows = [
      // 7 explicit rows around 5
      row(5), row(5), row(5), row(5), row(5), row(5), row(5),
      // 20 one-tap rows at 9 — must not drag the median
      ...Array.from({ length: 20 }, () => row(9, "none", "all_good")),
    ];
    const d = computeMorningDefaults(rows);
    expect(d.readiness).toBe(5);
    expect(d.fatigue).toBe("some");
  });

  it("excludes rows with null readiness from the explicit count", () => {
    const rows = [
      row(null), row(null), row(null), row(null),
      row(6), row(6), row(6), row(6), row(6), row(6),
    ];
    // only 6 rows with readiness → fallback
    expect(computeMorningDefaults(rows)).toEqual(DEFAULTS_FALLBACK);
  });

  it("treats null intake_source (historical) and 'form' as explicit", () => {
    const rows = [
      row(6, "heavy", null), row(6, "heavy", "form"), row(6, "heavy", null),
      row(6, "heavy", "form"), row(6, "heavy", null), row(6, "heavy", "form"),
      row(6, "heavy", "legacy_chips"),
    ];
    expect(computeMorningDefaults(rows)).toEqual({ readiness: 6, fatigue: "heavy" });
  });
});
