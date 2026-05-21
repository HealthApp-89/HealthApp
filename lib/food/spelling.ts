// lib/food/spelling.ts
//
// British→American spelling normaliser for catalog queries.
//
// USDA's database uses American spellings ("omelet", "yogurt", "zucchini").
// Users naturally type British spellings ("omelette", "yoghurt", "courgette").
// resolveItemMacros calls USDA once with the literal query; if it returns
// zero foods, lookupUsda retries once with the normalised variant via this
// helper. No extra round-trip on the common case (query already in US English).
//
// Pure data + one function. Extend the map only when a real miss is observed
// — don't speculate.

const BRIT_TO_US: Record<string, string> = {
  omelette: "omelet",
  yoghurt: "yogurt",
  courgette: "zucchini",
  aubergine: "eggplant",
  prawn: "shrimp",
  prawns: "shrimps",
  rocket: "arugula",
  coriander: "cilantro",
  // Extension policy: only add when an audit/manual test confirms USDA has the
  // US-spelled food but the British-spelled query returns 0 foods.
};

/** Return a US-spelled variant of the query if any token maps, else null.
 *  Case-insensitive — the returned string is lowercase. */
export function maybeNormalize(query: string): string | null {
  const toks = query.toLowerCase().split(/\s+/);
  let changed = false;
  const out = toks.map((t) => {
    const v = BRIT_TO_US[t];
    if (v) { changed = true; return v; }
    return t;
  });
  return changed ? out.join(" ") : null;
}
