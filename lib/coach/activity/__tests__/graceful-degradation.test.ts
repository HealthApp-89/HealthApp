/**
 * Graceful-degradation regression test for the activity-aware planning layer.
 *
 * Load-bearing rule: when ALL activity inputs are absent (no planned activities,
 * no soreness, no recent activity), the planner and reactive ladder must produce
 * identical outputs to what they would produce without the activity module at all
 * — i.e., today's behaviour is preserved.
 *
 * Each assertion below is the regression anchor against that contract:
 *   proposeActivityAwareLayout   → proposedPlan === sessionPlan (reference-equal),
 *                                   lightenDays: {}, flags: []
 *   selectReactiveRung           → rung: "none", regions: []
 *   mergePlannedActivities       → [] (empty array)
 */

import { describe, it, expect } from "vitest";
import { proposeActivityAwareLayout, type DaysAvailable } from "../sequence-week";
import { selectReactiveRung } from "../reactive-ladder";
import { mergePlannedActivities } from "../read-planned";
import type { SessionPlan } from "@/lib/data/types";

// ─── Minimal fixtures ────────────────────────────────────────────────────────

/** A representative 5-day lifting week (the actual production week shape). */
const SESSION_PLAN: SessionPlan = {
  Mon: "Legs",
  Tue: "Chest",
  Wed: "REST",
  Thu: "Back",
  Fri: "Arms",
  Sat: "REST",
  Sun: "Mobility",
};

const ALL_DAYS_AVAILABLE: DaysAvailable = {
  mon: true,
  tue: true,
  wed: true,
  thu: true,
  fri: true,
  sat: true,
  sun: true,
};

const WEEK_START = "2026-06-23"; // Monday

// ─── proposeActivityAwareLayout ──────────────────────────────────────────────

describe("graceful degradation — proposeActivityAwareLayout", () => {
  it("returns reference-equal proposedPlan when plannedActivities is []", () => {
    const result = proposeActivityAwareLayout({
      sessionPlan: SESSION_PLAN,
      plannedActivities: [],
      daysAvailable: ALL_DAYS_AVAILABLE,
    });

    // Reference-equality: no copy was made — same object.
    expect(result.proposedPlan).toBe(SESSION_PLAN);
  });

  it("returns empty lightenDays when plannedActivities is []", () => {
    const result = proposeActivityAwareLayout({
      sessionPlan: SESSION_PLAN,
      plannedActivities: [],
      daysAvailable: ALL_DAYS_AVAILABLE,
    });

    expect(result.lightenDays).toEqual({});
  });

  it("returns empty flags when plannedActivities is []", () => {
    const result = proposeActivityAwareLayout({
      sessionPlan: SESSION_PLAN,
      plannedActivities: [],
      daysAvailable: ALL_DAYS_AVAILABLE,
    });

    expect(result.flags).toEqual([]);
  });

  it("produces the same no-op result regardless of daysAvailable shape when activities are absent", () => {
    const noAvailability: DaysAvailable = {
      mon: false,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
      sat: false,
      sun: false,
    };

    const result = proposeActivityAwareLayout({
      sessionPlan: SESSION_PLAN,
      plannedActivities: [],
      daysAvailable: noAvailability,
    });

    // Still reference-equal — the early-return path fires before daysAvailable matters.
    expect(result.proposedPlan).toBe(SESSION_PLAN);
    expect(result.lightenDays).toEqual({});
    expect(result.flags).toEqual([]);
  });

  it("produces the same no-op result with a null block when activities are absent", () => {
    const result = proposeActivityAwareLayout({
      sessionPlan: SESSION_PLAN,
      plannedActivities: [],
      daysAvailable: ALL_DAYS_AVAILABLE,
      block: null,
    });

    expect(result.proposedPlan).toBe(SESSION_PLAN);
    expect(result.lightenDays).toEqual({});
    expect(result.flags).toEqual([]);
  });
});

// ─── selectReactiveRung ──────────────────────────────────────────────────────

describe("graceful degradation — selectReactiveRung", () => {
  it("returns rung:'none' when soreRegions is empty, soreSeverity is null, and recentActivity is []", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [],
    });

    expect(result.rung).toBe("none");
  });

  it("returns empty regions when all activity/soreness inputs are absent", () => {
    const result = selectReactiveRung({
      sessionRegions: ["chest", "shoulders"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [],
    });

    expect(result.regions).toEqual([]);
  });

  it("returns rung:'none' across all four lifting session types when inputs are absent", () => {
    const sessions: Array<[string, ("legs" | "lower_back" | "chest" | "shoulders" | "back" | "arms")[]]> = [
      ["Legs",  ["legs", "lower_back"]],
      ["Chest", ["chest", "shoulders"]],
      ["Back",  ["back", "lower_back"]],
      ["Arms",  ["arms", "shoulders"]],
    ];

    for (const [label, regions] of sessions) {
      const result = selectReactiveRung({
        sessionRegions: regions,
        soreRegions: [],
        soreSeverity: null,
        fatigue: null,
        recentActivity: [],
      });

      expect(result.rung, `${label} session should produce rung:none`).toBe("none");
      expect(result.regions, `${label} session should produce empty regions`).toEqual([]);
    }
  });
});

// ─── mergePlannedActivities ──────────────────────────────────────────────────

describe("graceful degradation — mergePlannedActivities", () => {
  it("returns [] when declared, recurring, and detected are all empty", () => {
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring: [],
      detected: [],
    });

    expect(result).toEqual([]);
  });

  it("returns [] regardless of weekStartIso when all sources are empty", () => {
    // Try a different week to confirm it's not week-start-dependent.
    const result = mergePlannedActivities({
      weekStartIso: "2026-07-06",
      declared: [],
      recurring: [],
      detected: [],
    });

    expect(result).toEqual([]);
  });
});

// ─── End-to-end: all inputs absent → planner + ladder produce no-ops ─────────

describe("graceful degradation — end-to-end: no activities + no soreness = today's output", () => {
  it("the full pipeline produces reference-equal plan + rung:none when all inputs absent", () => {
    // Step 1: merge produces no activities.
    const activities = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring: [],
      detected: [],
    });
    expect(activities).toEqual([]);

    // Step 2: propose with empty activities → reference-equal plan.
    const layout = proposeActivityAwareLayout({
      sessionPlan: SESSION_PLAN,
      plannedActivities: activities,
      daysAvailable: ALL_DAYS_AVAILABLE,
    });
    expect(layout.proposedPlan).toBe(SESSION_PLAN);
    expect(layout.lightenDays).toEqual({});
    expect(layout.flags).toEqual([]);

    // Step 3: reactive ladder with no soreness → no intervention.
    const reactive = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [],
    });
    expect(reactive.rung).toBe("none");
    expect(reactive.regions).toEqual([]);
  });
});
