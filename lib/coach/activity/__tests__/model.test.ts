import { describe, it, expect } from "vitest";
import { activityRegions, recoveryWindowHours, regionOverlap } from "../model";

describe("activityRegions", () => {
  it("returns legs + lower_back + shoulders for padel", () => {
    expect(activityRegions("padel")).toEqual(["legs", "lower_back", "shoulders"]);
  });

  it("returns legs for cycling", () => {
    expect(activityRegions("cycling")).toEqual(["legs"]);
  });

  it("returns empty array for other", () => {
    expect(activityRegions("other")).toEqual([]);
  });
});

describe("recoveryWindowHours", () => {
  it("padel light is ≤24h", () => {
    expect(recoveryWindowHours("padel", "light")).toBeLessThanOrEqual(24);
  });

  it("padel hard is ≥36h", () => {
    expect(recoveryWindowHours("padel", "hard")).toBeGreaterThanOrEqual(36);
  });

  it("hard > light for every activity type", () => {
    const types = ["padel", "running", "cycling", "swimming", "other"] as const;
    for (const type of types) {
      expect(recoveryWindowHours(type, "hard")).toBeGreaterThan(
        recoveryWindowHours(type, "light")
      );
    }
  });

  it("cycling hard recovers faster than running hard", () => {
    expect(recoveryWindowHours("cycling", "hard")).toBeLessThan(
      recoveryWindowHours("running", "hard")
    );
  });
});

describe("regionOverlap", () => {
  it("returns intersection of two overlapping arrays", () => {
    expect(regionOverlap(["legs", "lower_back"], ["legs"])).toEqual(["legs"]);
  });

  it("returns empty array when no overlap", () => {
    expect(regionOverlap(["chest", "arms"], ["legs", "lower_back"])).toEqual([]);
  });
});
