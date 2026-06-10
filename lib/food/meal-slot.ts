// lib/food/meal-slot.ts
//
// Pure helpers for meal_slot. The deriveMealSlot mapping MUST stay in
// lockstep with the SQL CASE in supabase/migrations/0020_food_log_meal_slot.sql
// (used for the one-shot backfill). Going forward, this TS function is the
// runtime source of truth — the migration mapping is frozen historical code.

import { USER_TIMEZONE } from "@/lib/time";
import type { MealSlot } from "./types";

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

// Uses tz-aware local-clock hours. Without tz, callers fall back to the
// env-var USER_TIMEZONE (transitional — Task 13 makes tz required).
export function deriveMealSlot(d: Date, tz: string = USER_TIMEZONE): MealSlot {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  }).format(d);
  // en-US numeric hour returns "0" through "23" (no zero-pad).
  const h = Number(hourStr);
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
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}
