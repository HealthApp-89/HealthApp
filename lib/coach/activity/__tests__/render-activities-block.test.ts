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
