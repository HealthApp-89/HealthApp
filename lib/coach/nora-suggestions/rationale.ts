// lib/coach/nora-suggestions/rationale.ts
//
// Deterministic template selection by dominant score factor.

import type { MealSuggestionScores } from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";

type RationaleArgs = {
  scores: MealSuggestionScores;
  slot: MealSlot;
  slot_typical_kcal: number;
  protein_remaining_g: number | null;
  protein_top_name: string | null;     // e.g. "chicken"
  protein_top_share: number;            // 0..1
  components_protein_name?: string;
  components_carb_name?: string;
};

export function renderRationale(a: RationaleArgs): string {
  const { scores } = a;
  const dominants: Array<{ key: keyof MealSuggestionScores; val: number }> = [
    { key: "slot_fit", val: scores.slot_fit },
    { key: "familiarity", val: scores.familiarity },
    { key: "variety_boost", val: scores.variety_boost },
    { key: "macro_fit", val: scores.macro_fit },
  ];
  dominants.sort((x, y) => y.val - x.val);
  const top = dominants[0].key;

  switch (top) {
    case "slot_fit":
      return `Same shape as your typical ${a.slot} (~${Math.round(a.slot_typical_kcal)} kcal)`;
    case "familiarity":
      return `Your usual ${a.components_protein_name ?? "protein"} + ${a.components_carb_name ?? "carb"} combo`;
    case "variety_boost":
      return a.protein_top_name
        ? `Mixes up your protein — ${a.protein_top_name} ${Math.round(a.protein_top_share * 100)}% of recent meals`
        : `Mixes up your protein choice`;
    case "macro_fit":
      return a.protein_remaining_g != null
        ? `Lighter carb to keep protein on track (${Math.round(a.protein_remaining_g)}g left)`
        : `Fits the day's remaining macros`;
    default:
      return a.protein_remaining_g != null
        ? `Lighter carb to keep protein on track (${Math.round(a.protein_remaining_g)}g left)`
        : `Fits the day's remaining macros`;
  }
}
