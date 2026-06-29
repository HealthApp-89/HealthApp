import { expect, test } from "vitest";
import { renderPlannedActivitiesBlock } from "../render-activities-block";

test("renders this-week activities + a deterministic load note", () => {
  const block = renderPlannedActivitiesBlock(
    [
      { date: "2026-06-30", type: "padel", intensity_estimate: "hard", source: "manual" },
      { date: "2026-07-04", type: "cycling", intensity_estimate: "moderate", source: "detected" },
    ],
    [],
  );
  expect(block).not.toBeNull();
  expect(block).toContain("PLANNED ACTIVITIES");
  expect(block!.toLowerCase()).toContain("padel");
  expect(block!.toLowerCase()).toContain("legs"); // load note cites regions from the model
});

test("returns null when no activities (block omitted)", () => {
  expect(renderPlannedActivitiesBlock([], [])).toBeNull();
});

/**
 * GRACEFUL DEGRADATION — load-bearing guard
 *
 * Contract: when there are no planned activities AND no recurring patterns,
 * `renderPlannedActivitiesBlock` MUST return null.
 *
 * The snapshot builder (lib/coach/snapshot.ts) spreads the block conditionally:
 *   ...(activitiesBlock ? [``, activitiesBlock] : [])
 *
 * null-return → conditional evaluates to false → nothing is pushed into the
 * prefix lines → the coach context is byte-identical to what it was before
 * the activity feature was added.  No "PLANNED ACTIVITIES" heading, no load
 * note, no coach behavioural change.
 *
 * If this test fails it means the builder now emits a block even for zero
 * inputs — that would inject activity-awareness context into every coach turn,
 * including users who have never entered an activity.
 */
test("GRACEFUL GUARD: renderPlannedActivitiesBlock([], []) → null — block omitted, coach context unchanged", () => {
  const result = renderPlannedActivitiesBlock([], []);

  // Primary: must be null, not an empty string or a stub block.
  expect(result).toBeNull();

  // Belt-and-suspenders: definitely not a string of any kind.
  expect(typeof result).not.toBe("string");
});

test("includes recurring patterns when present", () => {
  const block = renderPlannedActivitiesBlock([], [{ type: "padel", weekdays: [2, 4], typical_intensity: "moderate" }]);
  expect(block).not.toBeNull();
  expect(block!.toLowerCase()).toContain("recurring");
});

test("load note cites recovery window hours from model", () => {
  const block = renderPlannedActivitiesBlock(
    [{ date: "2026-06-30", type: "running", intensity_estimate: "hard", source: "manual" }],
    [],
  );
  expect(block).not.toBeNull();
  // running hard: base 44h * damage_factor 1.0 = 44h
  expect(block).toContain("44h");
});

test("multiple activity types all appear in the block", () => {
  const block = renderPlannedActivitiesBlock(
    [
      { date: "2026-06-29", type: "cycling", intensity_estimate: "light", source: "recurring" },
      { date: "2026-07-01", type: "swimming", intensity_estimate: "moderate", source: "detected" },
    ],
    [],
  );
  expect(block).not.toBeNull();
  expect(block!.toLowerCase()).toContain("cycling");
  expect(block!.toLowerCase()).toContain("swimming");
});

test("weekday label is rendered for activity dates", () => {
  // 2026-06-30 is a Tuesday
  const block = renderPlannedActivitiesBlock(
    [{ date: "2026-06-30", type: "padel", intensity_estimate: "moderate", source: "manual" }],
    [],
  );
  expect(block).not.toBeNull();
  expect(block).toContain("Tue");
});

test("recurring weekdays are shown as short names", () => {
  const block = renderPlannedActivitiesBlock(
    [],
    [{ type: "running", weekdays: [1, 4], typical_intensity: "moderate" }],
  );
  expect(block).not.toBeNull();
  expect(block).toContain("Mon");
  expect(block).toContain("Thu");
});
