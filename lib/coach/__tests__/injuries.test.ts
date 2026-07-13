import { describe, expect, test } from "vitest";
import { injuryActiveOn, liftInjuryFor } from "@/lib/coach/injuries";
import type { Injury } from "@/lib/data/types";

const hip: Injury = {
  id: "i1", user_id: "u1", area: "hip", side: null, cause: "padel",
  severity: "moderate", onset_date: "2026-06-29", status: "active",
  resolved_at: null, affected_session_types: ["Legs", "Back"],
  affected_lifts: ["deadlift", "squat"], notes: null,
  created_at: "2026-06-29T10:00:00Z", updated_at: "2026-06-29T10:00:00Z",
};

describe("injuryActiveOn", () => {
  test("active from onset onward while unresolved", () => {
    expect(injuryActiveOn(hip, "2026-06-28")).toBe(false);
    expect(injuryActiveOn(hip, "2026-06-29")).toBe(true);
    expect(injuryActiveOn(hip, "2026-07-13")).toBe(true);
  });
  test("resolved injuries stop at resolved_at's date (inclusive)", () => {
    const resolved = { ...hip, status: "resolved" as const, resolved_at: "2026-07-10T08:00:00Z" };
    expect(injuryActiveOn(resolved, "2026-07-10")).toBe(true);
    expect(injuryActiveOn(resolved, "2026-07-11")).toBe(false);
  });
});

describe("liftInjuryFor", () => {
  test("returns the injury when overlap ≥ half the window", () => {
    expect(liftInjuryFor([hip], "deadlift", "2026-06-22", "2026-07-13")?.area).toBe("hip");
  });
  test("null when overlap < half the window or lift unaffected", () => {
    expect(liftInjuryFor([hip], "deadlift", "2026-04-01", "2026-07-01")).toBeNull();
    expect(liftInjuryFor([hip], "bench", "2026-06-22", "2026-07-13")).toBeNull();
  });
});
