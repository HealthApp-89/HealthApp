// lib/food/meal-targets.ts
//
// Pure derivation of per-meal kcal targets from a day-level kcal target +
// optional user ratios. Consumed by MealSlotCard and the day-summary card.

import type { MealSlot } from "./types";

export type MealRatios = {
  breakfast: number;
  lunch: number;
  dinner: number;
  snacks: number;
};

export const DEFAULT_MEAL_RATIOS: MealRatios = {
  breakfast: 0.30,
  lunch:     0.35,
  dinner:    0.30,
  snacks:    0.05,
};

export function targetForSlot(
  slot: MealSlot,
  dayKcal: number,
  ratios: MealRatios = DEFAULT_MEAL_RATIOS,
): number {
  const k =
    slot === "breakfast" ? ratios.breakfast :
    slot === "lunch"     ? ratios.lunch     :
    slot === "dinner"    ? ratios.dinner    :
    ratios.snacks;
  return Math.round(dayKcal * k);
}

export function targetsForAllSlots(
  dayKcal: number,
  ratios: MealRatios = DEFAULT_MEAL_RATIOS,
): Record<MealSlot, number> {
  return {
    breakfast: targetForSlot("breakfast", dayKcal, ratios),
    lunch:     targetForSlot("lunch",     dayKcal, ratios),
    dinner:    targetForSlot("dinner",    dayKcal, ratios),
    snack:     targetForSlot("snack",     dayKcal, ratios),
  };
}
