import { describe, it, expect } from "vitest";
import {
  BatchBodySchema,
  columnsFromBatch,
  formatBatchReply,
  type BatchValues,
} from "@/lib/morning/batch";

const base: BatchValues = {
  readiness: 7,
  fatigue: "some",
  soreness_areas: [],
  soreness_severity: null,
  bloating: false,
  sick: false,
};

describe("BatchBodySchema", () => {
  it("accepts a valid clean-day body", () => {
    const r = BatchBodySchema.safeParse({ kind: "batch", values: base });
    expect(r.success).toBe(true);
  });

  it("accepts soreness with severity", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: { ...base, soreness_areas: ["legs", "back"], soreness_severity: "mild" },
      notes: "tight from Tuesday",
    });
    expect(r.success).toBe(true);
  });

  it("rejects soreness areas without severity", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: { ...base, soreness_areas: ["legs"], soreness_severity: null },
    });
    expect(r.success).toBe(false);
  });

  it("rejects severity without areas", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: { ...base, soreness_severity: "sharp" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range readiness and unknown areas", () => {
    expect(
      BatchBodySchema.safeParse({ kind: "batch", values: { ...base, readiness: 11 } }).success,
    ).toBe(false);
    expect(
      BatchBodySchema.safeParse({
        kind: "batch",
        values: { ...base, soreness_areas: ["neck"], soreness_severity: "mild" },
      }).success,
    ).toBe(false);
  });

  it("rejects notes over 2000 chars", () => {
    const r = BatchBodySchema.safeParse({
      kind: "batch",
      values: base,
      notes: "x".repeat(2001),
    });
    expect(r.success).toBe(false);
  });
});

describe("columnsFromBatch", () => {
  it("maps and dedupes", () => {
    const cols = columnsFromBatch({
      ...base,
      readiness: 5,
      fatigue: "heavy",
      soreness_areas: ["legs", "legs", "back"],
      soreness_severity: "sharp",
      bloating: true,
    });
    expect(cols).toEqual({
      readiness: 5,
      fatigue: "heavy",
      soreness_areas: ["legs", "back"],
      soreness_severity: "sharp",
      bloating: true,
    });
    expect("sick" in cols).toBe(false);
    expect("intake_state" in cols).toBe(false);
  });
});

describe("formatBatchReply", () => {
  it("renders a clean day", () => {
    expect(formatBatchReply(base, null)).toBe("Feel 7 · some fatigue");
  });

  it("renders deviations and notes", () => {
    const s = formatBatchReply(
      {
        ...base,
        readiness: 5,
        fatigue: "heavy",
        soreness_areas: ["legs", "back"],
        soreness_severity: "sharp",
        bloating: true,
        sick: true,
      },
      "rough night",
    );
    expect(s).toBe(
      "Feel 5 · heavy fatigue · sore: legs, back (sharp) · bloated · feeling sick — rough night",
    );
  });
});
