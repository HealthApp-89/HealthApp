// lib/coach/nutrition-intelligence/classify.ts
//
// Pure classifiers for food_log_entries.name → protein / carb / cooking
// categories. No I/O. Caller passes the optional USDA category extracted
// from food_db_cache.raw_payload.foodCategory.

import {
  CARB_TOKENS,
  COOKING_METHOD_TOKENS,
  PROTEIN_TOKENS,
  USDA_CARB_CATEGORY,
  USDA_PROTEIN_CATEGORY,
  type CarbCategory,
  type CookingMethod,
  type ProteinCategory,
} from "./word-lists";

export type Confidence = "high" | "medium" | "low";

export function classifyProtein(
  name: string,
  usdaCategory?: string | null,
): { category: ProteinCategory; confidence: Confidence } {
  const lower = name.toLowerCase();

  // 1. USDA category override (high confidence).
  if (usdaCategory) {
    const mapped = USDA_PROTEIN_CATEGORY[usdaCategory];
    if (mapped) {
      // Dairy-and-eggs ambiguity: split by name token.
      if (mapped === "dairy_protein" && /\begg(s|\b)/.test(lower)) {
        return { category: "eggs", confidence: "high" };
      }
      return { category: mapped, confidence: "high" };
    }
  }

  // 2. Name-token match — first hit wins.
  for (const bucket of PROTEIN_TOKENS) {
    if (bucket.tokens.some((t) => lower.includes(t))) {
      return { category: bucket.cat, confidence: "medium" };
    }
  }
  return { category: "unknown", confidence: "low" };
}

export function classifyCarb(
  name: string,
  usdaCategory?: string | null,
): { category: CarbCategory; confidence: Confidence } {
  const lower = name.toLowerCase();

  if (usdaCategory) {
    const mapped = USDA_CARB_CATEGORY[usdaCategory];
    if (mapped) {
      // "Cereal Grains and Pasta" — promote whole grains by name.
      if (mapped === "refined_grain" && /\b(oat|brown rice|quinoa|wild rice|barley|farro|whole)/.test(lower)) {
        return { category: "whole_grain", confidence: "high" };
      }
      // "Vegetables and Vegetable Products" — promote starchy.
      if (mapped === "non_starchy_veg" && /\b(potato|sweet potato|yam|corn|plantain)/.test(lower)) {
        return { category: "starchy_veg", confidence: "high" };
      }
      return { category: mapped, confidence: "high" };
    }
  }

  for (const bucket of CARB_TOKENS) {
    if (bucket.tokens.some((t) => lower.includes(t))) {
      return { category: bucket.cat, confidence: "medium" };
    }
  }
  return { category: "unknown", confidence: "low" };
}

export function classifyCookingMethod(
  name: string,
): { method: CookingMethod; confidence: Confidence } {
  const lower = name.toLowerCase();

  // Order matters — deep_fried / air_fried before pan_fried so the more
  // specific match wins on items like "deep fried tofu".
  for (const bucket of COOKING_METHOD_TOKENS) {
    if (bucket.tokens.some((t) => lower.includes(t))) {
      return { method: bucket.method, confidence: "medium" };
    }
  }
  return { method: "unknown", confidence: "low" };
}
