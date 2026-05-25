// lib/food/atwater.ts
//
// Derive kcal from macros using Atwater factors (4·protein + 4·carbs + 9·fat).
// Used by CustomFoodForm so kcal is optional during manual food creation.
// Fiber is ignored (its caloric contribution is small and partially
// non-bioavailable; standard Atwater excludes it). Alcohol-containing foods
// or low-digestible-carb foods may legitimately diverge from this estimate —
// the form surfaces a soft warning on >30% divergence but never blocks.

export function deriveKcalFromMacros(m: {
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}): number {
  const p = Number.isFinite(m.protein_g) ? Math.max(0, m.protein_g) : 0;
  const c = Number.isFinite(m.carbs_g) ? Math.max(0, m.carbs_g) : 0;
  const f = Number.isFinite(m.fat_g) ? Math.max(0, m.fat_g) : 0;
  return 4 * p + 4 * c + 9 * f;
}
