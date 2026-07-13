import { describe, expect, test } from "vitest";
import { validateInjuryInput } from "@/lib/coach/injuries";

const TODAY = "2026-07-13";

describe("validateInjuryInput", () => {
  test("happy path — minimal required fields", () => {
    const r = validateInjuryInput({ area: "Left knee" }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.area).toBe("Left knee");
      expect(r.data.severity).toBe("moderate");
      expect(r.data.onset_date).toBe(TODAY);
    }
  });

  test("happy path — all fields supplied", () => {
    const r = validateInjuryInput(
      {
        area: "Shoulder",
        side: "right",
        cause: "Overuse",
        severity: "mild",
        onset_date: "2026-07-10",
        affected_lifts: ["bench", "ohp"],
        affected_session_types: ["Chest", "Arms"],
        notes: "Popped during warm-up",
      },
      TODAY,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.severity).toBe("mild");
      expect(r.data.affected_lifts).toEqual(["bench", "ohp"]);
    }
  });

  test("area trimmed non-empty — blank area rejected", () => {
    const r = validateInjuryInput({ area: "   " }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("area max 40 chars", () => {
    const r = validateInjuryInput({ area: "A".repeat(41) }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("bad severity rejected", () => {
    const r = validateInjuryInput({ area: "Back", severity: "critical" as "mild" }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("future onset_date rejected", () => {
    const r = validateInjuryInput({ area: "Knee", onset_date: "2026-07-14" }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("onset_date bad format rejected", () => {
    const r = validateInjuryInput({ area: "Knee", onset_date: "13-07-2026" }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("bad lift rejected", () => {
    const r = validateInjuryInput(
      { area: "Hip", affected_lifts: ["legpress"] as unknown as ("squat" | "bench" | "deadlift" | "ohp")[] },
      TODAY,
    );
    expect(r.ok).toBe(false);
  });

  test("affected_session_types string too long rejected", () => {
    const r = validateInjuryInput(
      { area: "Hip", affected_session_types: ["A".repeat(21)] },
      TODAY,
    );
    expect(r.ok).toBe(false);
  });

  test("invalid side rejected", () => {
    const r = validateInjuryInput({ area: "Shoulder", side: "both" as "left" }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("notes over 500 chars rejected", () => {
    const r = validateInjuryInput({ area: "Ankle", notes: "x".repeat(501) }, TODAY);
    expect(r.ok).toBe(false);
  });
});
