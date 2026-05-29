// lib/coach/nora-suggestions/canonicalize.ts
//
// Strip cooking-method tokens + prep modifiers so frequency counting
// groups "grilled chicken breast" with "chicken breast cooked".

const COOKING_METHOD_TOKENS = [
  "grilled", "roasted", "boiled", "steamed", "fried", "baked", "sauteed", "sautéed",
  "pan-fried", "deep-fried", "stir-fried", "smoked", "poached", "broiled",
];

const PREP_MODIFIER_TOKENS = [
  "cooked", "raw", "chopped", "sliced", "diced", "whole", "minced", "ground",
  "shredded", "cubed", "fresh", "frozen", "canned", "dried",
];

const STRIP_TOKENS = new Set([...COOKING_METHOD_TOKENS, ...PREP_MODIFIER_TOKENS]);

const PUNCT = /[.,;:!?()\[\]'"`]/g;

export function canonicalizeItemName(raw: string): string {
  const lowered = raw.toLowerCase().replace(PUNCT, " ").trim();
  const tokens = lowered.split(/\s+/).filter((t) => t.length > 0 && !STRIP_TOKENS.has(t));
  return tokens.join(" ");
}
