import { describe, expect, it } from "vitest";
import { daysBetweenIso, isoDaysAgo } from "@/lib/time/dates";

describe("isoDaysAgo", () => {
  it("subtracts days from a YYYY-MM-DD anchor", () => {
    expect(isoDaysAgo("2026-07-02", 7)).toBe("2026-06-25");
  });
  it("crosses month boundaries", () => {
    expect(isoDaysAgo("2026-03-01", 1)).toBe("2026-02-28");
  });
  it("day 0 is identity", () => {
    expect(isoDaysAgo("2026-07-02", 0)).toBe("2026-07-02");
  });
});

describe("daysBetweenIso", () => {
  it("counts forward days", () => {
    expect(daysBetweenIso("2026-07-01", "2026-07-02")).toBe(1);
  });
  it("is negative when to < from", () => {
    expect(daysBetweenIso("2026-07-02", "2026-07-01")).toBe(-1);
  });
  it("returns null on unparseable input", () => {
    expect(daysBetweenIso("garbage", "2026-07-02")).toBeNull();
  });
});
