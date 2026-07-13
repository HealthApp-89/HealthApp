// lib/coach/blocks/__tests__/create-block.test.ts
import { describe, expect, test } from "vitest";
import { validateBlockInput } from "@/lib/coach/blocks/create-block";

const rec = { recommended_target: 97.5, sanity_bounds: [92.5, 99] as [number, number] };
const base = { primary_lift: "squat", target_metric: "e1rm", target_value: 97.5,
  start_date: "2026-07-13", end_date: "2026-08-16", goal_text: "Squat focus block" };

describe("validateBlockInput", () => {
  test("in-bounds target passes", () => {
    expect(validateBlockInput(base, rec).ok).toBe(true);
  });
  test("out-of-bounds without reason fails with code", () => {
    const r = validateBlockInput({ ...base, target_value: 110 }, rec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("target_out_of_bounds");
  });
  test("out-of-bounds with override_reason passes", () => {
    expect(validateBlockInput({ ...base, target_value: 110, override_reason: "returning from layoff" }, rec).ok).toBe(true);
  });
  test("null recommendation (no bounds) passes any target", () => {
    expect(validateBlockInput({ ...base, target_value: 110 }, null).ok).toBe(true);
  });
});
