// lib/coach/interventions/__tests__/classify-strength.test.ts
//
// Tests for the block-aware planned-vs-reactive classifier.
// Only reactive events feed responsiveness memory — planned deloads and
// block-boundary rotations must never be credited as interventions.
//
// Run: npx vitest run lib/coach/interventions/__tests__/classify-strength.test.ts

import { expect, test } from "vitest";
import { classifyDeload, classifySwap } from "../classify-strength";
import { makeBlock } from "./fixtures";

// ── classifyDeload ─────────────────────────────────────────────────────────

test("a load drop in the block's deload week is PLANNED, never reactive", () => {
  // Block starts 2026-05-25; week 5 (deload) starts 2026-06-22.
  // todayIso 2026-06-26 is in week 5.
  const block = makeBlock({ start_date: "2026-05-25" });
  const r = classifyDeload({
    block,
    weekPhase: "deload_week",
    loadDropPct: 0.2,
    todayIso: "2026-06-26",
  });
  expect(r).toBe("planned");
});

test("a mid-block load drop outside deload_week is REACTIVE", () => {
  // Block starts 2026-05-25; week 3 starts 2026-06-08; todayIso 2026-06-12 is in week 3.
  const block = makeBlock({ start_date: "2026-05-25" });
  const r = classifyDeload({
    block,
    weekPhase: "pre_target",
    loadDropPct: 0.18,
    todayIso: "2026-06-12",
  });
  expect(r).toBe("reactive");
});

test("a trivial load change is not a deload at all", () => {
  // 3% drop is below the DELOAD_MIN_DROP_PCT threshold → not_a_deload regardless of phase.
  const block = makeBlock({});
  const r = classifyDeload({
    block,
    weekPhase: "pre_target",
    loadDropPct: 0.03,
    todayIso: "2026-06-12",
  });
  expect(r).toBe("not_a_deload");
});

test("a load drop during consolidation phase is REACTIVE", () => {
  const block = makeBlock({ start_date: "2026-05-25", target_hit_at_week: 2 });
  const r = classifyDeload({
    block,
    weekPhase: "consolidation",
    loadDropPct: 0.15,
    todayIso: "2026-06-12",
  });
  expect(r).toBe("reactive");
});

test("exact threshold drop (10%) is treated as a deload", () => {
  const block = makeBlock({ start_date: "2026-05-25" });
  const r = classifyDeload({
    block,
    weekPhase: "pre_target",
    loadDropPct: 0.1,
    todayIso: "2026-06-12",
  });
  expect(r).toBe("reactive");
});

test("drop just below threshold (9.9%) is not_a_deload", () => {
  const block = makeBlock({});
  const r = classifyDeload({
    block,
    weekPhase: "pre_target",
    loadDropPct: 0.099,
    todayIso: "2026-06-12",
  });
  expect(r).toBe("not_a_deload");
});

// ── classifySwap ──────────────────────────────────────────────────────────

test("a swap at the start of a new block (boundary week) is PLANNED_ROTATION", () => {
  const r = classifySwap({
    isBoundaryWeek: true,
    sameExercise: false,
  });
  expect(r).toBe("planned_rotation");
});

test("a mid-block exercise swap is REACTIVE", () => {
  const r = classifySwap({
    isBoundaryWeek: false,
    sameExercise: false,
  });
  expect(r).toBe("reactive");
});

test("identical exercise set is not a swap at all", () => {
  // sameExercise: true always wins — no meaningful swap occurred.
  const r = classifySwap({
    isBoundaryWeek: false,
    sameExercise: true,
  });
  expect(r).toBe("not_a_swap");
});

test("identical exercise at boundary week is still not a swap", () => {
  // sameExercise guard takes priority over boundary-week check.
  const r = classifySwap({
    isBoundaryWeek: true,
    sameExercise: true,
  });
  expect(r).toBe("not_a_swap");
});
