// lib/food/meal-slot.ts
//
// Pure helpers for meal_slot. The deriveMealSlot mapping MUST stay in
// lockstep with the SQL CASE in supabase/migrations/0020_food_log_meal_slot.sql
// (used for the one-shot backfill). Going forward, this TS function is the
// runtime source of truth — the migration mapping is frozen historical code.

import type { MealSlot } from "./types";

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

export function deriveMealSlot(d: Date): MealSlot {
  const h = d.getHours();
  if (h >= 4 && h <= 10) return "breakfast";
  if (h >= 11 && h <= 14) return "lunch";
  if (h >= 15 && h <= 16) return "snack";
  if (h >= 17 && h <= 21) return "dinner";
  return "snack";
}

export function mealSlotLabel(s: MealSlot): string {
  switch (s) {
    case "breakfast": return "Breakfast";
    case "lunch":     return "Lunch";
    case "dinner":    return "Dinner";
    case "snack":     return "Snacks";
  }
}
