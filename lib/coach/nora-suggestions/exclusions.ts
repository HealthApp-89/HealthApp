// lib/coach/nora-suggestions/exclusions.ts
//
// Deterministic exclusion predicates for Nora's suggestion engine.
// Each tag maps to a name regex + (optionally) a USDA category check.
// passesExclusions returns false the moment any item violates any active tag.

import type { ExclusionTag } from "@/lib/data/types";

export type ExclusionableItem = {
  name: string;
  usda_category?: string | null;
};

type Predicate = (item: ExclusionableItem) => boolean;

const usdaStartsWith = (item: ExclusionableItem, prefixes: string[]): boolean =>
  !!item.usda_category && prefixes.some((p) => (item.usda_category as string).startsWith(p));

export const EXCLUSION_PREDICATES: Record<ExclusionTag, Predicate> = {
  pork: (it) =>
    !/\b(pork|bacon|ham|prosciutto|chorizo|pancetta|jam[oó]n|salami|sausage|pepperoni|mortadella|lard(ons?)?|guanciale|speck|carnitas)\b/i.test(it.name) &&
    !usdaStartsWith(it, ["Pork", "Sausages and Luncheon"]),
  shellfish: (it) =>
    !/\b(shrimp|prawn|lobster|crab|mussels?|oysters?|clams?|scallops?|crayfish)\b/i.test(it.name),
  alcohol: (it) =>
    !/\b(wine|beer|whisk(e)?y|vodka|rum|gin|tequila|champagne|prosecco|cocktail|spirits?)\b/i.test(it.name),
  gluten: (it) =>
    !/\b(wheat|barley|rye|bread|pasta|noodles?|couscous|bulgur|semolina|farro)\b/i.test(it.name),
  dairy: (it) => {
    // Plant-based "milk/cream/butter/yoghurt" are NOT dairy — exempt the common prefixes.
    if (/\b(coconut|oat|almond|soy|soya|rice|hemp|cashew|hazelnut|pea)\s+(milk|cream|butter|yog(h)?urt)\b/i.test(it.name)) return true;
    return !/\b(milk|cheese|yogurt|yoghurt|butter|cream|whey|casein|kefir|lactose|ghee)\b/i.test(it.name) &&
      !usdaStartsWith(it, ["Dairy and Egg"]);
  },
  eggs: (it) => !/\beggs?\b/i.test(it.name),
  peanuts: (it) => !/\bpeanuts?\b/i.test(it.name),
  tree_nuts: (it) =>
    !/\b(almonds?|walnuts?|cashews?|pistachios?|hazelnuts?|pecans?|brazil nuts?|macadamia)\b/i.test(it.name),
  soy: (it) => !/\b(soy|tofu|tempeh|edamame|miso)\b/i.test(it.name),
  red_meat: (it) => !/\b(beef|lamb|venison|bison)\b/i.test(it.name),
  all_meat: (it) =>
    !/\b(chicken|turkey|beef|lamb|pork|fish|salmon|tuna|sardines?|bacon|ham|sausage|venison|duck)\b/i.test(it.name),
  fish: (it) =>
    !/\b(fish|salmon|tuna|sardines?|cod|haddock|mackerel|trout|halibut|anchov(y|ies))\b/i.test(it.name),
};

/** Returns true iff every item passes every active tag. */
export function passesExclusions(items: ExclusionableItem[], tags: ExclusionTag[]): boolean {
  if (tags.length === 0) return true;
  for (const it of items) {
    for (const tag of tags) {
      if (!EXCLUSION_PREDICATES[tag](it)) return false;
    }
  }
  return true;
}

/** Which tag(s) a given item violates — for audit + Nora's prose. */
export function violatedTags(item: ExclusionableItem, tags: ExclusionTag[]): ExclusionTag[] {
  return tags.filter((t) => !EXCLUSION_PREDICATES[t](item));
}
