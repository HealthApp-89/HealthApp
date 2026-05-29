// lib/coach/nora-suggestions/suggest-meal.ts
//
// Pure deterministic meal-suggestion engine. No I/O. Caller hands in
// eating identity, exclusions, remaining macros, slot targets.
//
// Three-tier candidate generation:
//   tier 1 — repertoire (frequent combos + library recipes for this slot)
//   tier 2 — recombination of familiar parts at this slot
//   tier 3 — adjacent substitution (only when prefer_novelty)
//
// Hard filter: exclusions. Tier 1 fills first; 2/3 top up.

import type {
  EatingIdentity,
  DietaryExclusions,
  MealSuggestion,
  MealSuggestionItem,
  MealSuggestionScores,
  SuggestEngineOutput,
} from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";
import { passesExclusions } from "./exclusions";
import { renderRationale } from "./rationale";
import { createHash } from "node:crypto";

const FAMILIARITY_FLOOR = 0.5;
const VARIETY_THRESHOLD_PROTEIN_SHARE = 0.6;
const MONOTONE_PRESSURE_THRESHOLD = 0.5;
const VARIETY_BOOST_PROTEIN_LOW_SHARE = 0.2;
const SLOT_KCAL_FIT_TOL = 0.2;

const PROTEIN_NAME_RE = /\b(chicken|turkey|beef|lamb|pork|fish|salmon|tuna|sardines?|eggs?|tofu|tempeh|cottage cheese|yog(h)?urt|whey|greek yogurt|lentils?|chickpeas?)\b/i;
const CARB_NAME_RE = /\b(rice|pasta|bread|oats?|oatmeal|potato|sweet potato|quinoa|couscous|tortilla|wrap|bagel|noodles?)\b/i;

export type SuggestMealInput = {
  slot: MealSlot;
  count: number;                               // 2-4
  eatingIdentity: EatingIdentity;
  exclusions: DietaryExclusions;
  remainingMacros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  slotTargets: { kcal: number; protein_g: number };
  preferNovelty: boolean;
  newRecipeBoosts?: Array<{ library_item_id: string; weight: number }>;  // §9.6 tight loop
};

export function suggestMeal(input: SuggestMealInput): SuggestEngineOutput {
  const id = input.eatingIdentity;

  if (id.top_items.length === 0) {
    return {
      suggestions: [],
      context: emptyContext(input, null),
      filter_stats: { tier1_candidates: 0, after_exclusion: 0, surfaced: 0 },
      error: "no_history",
    };
  }

  const monotone_signal = monotoneSignal(id);

  // 1. Generate candidates tier by tier.
  const tier1 = generateTier1(input, id);
  const candidates = [...tier1];
  const tier1Count = tier1.length;

  const enterTier2 =
    candidates.length < input.count ||
    id.monotone_flags.protein_top_share > VARIETY_THRESHOLD_PROTEIN_SHARE;
  if (enterTier2) candidates.push(...generateTier2(input, id, candidates));

  if (input.preferNovelty) candidates.push(...generateTier3(input, id, candidates));

  // 2. Hard exclusion filter.
  const afterExclusion = candidates.filter((c) =>
    passesExclusions(c.items.map((i) => ({ name: i.name })), input.exclusions.tags),
  );

  if (afterExclusion.length === 0) {
    return {
      suggestions: [],
      context: emptyContext(input, monotone_signal),
      filter_stats: { tier1_candidates: tier1Count, after_exclusion: 0, surfaced: 0 },
      error: "exclusions_exhausted",
    };
  }

  // 3. Score each surviving candidate.
  const slot_typical_kcal = id.slot_patterns[input.slot]?.typical_kcal_avg || input.slotTargets.kcal;
  const protein_top_name = topProteinName(id);

  const scored = afterExclusion.map((cand) => {
    const total = sumMacros(cand.items);
    const scores = score({
      cand: { items: cand.items, total },
      input,
      id,
      slot_typical_kcal,
      protein_top_name,
      tierFamiliarity: cand.familiarity,
      newRecipeBoosts: input.newRecipeBoosts ?? [],
    });
    const rationale = renderRationale({
      scores,
      slot: input.slot,
      slot_typical_kcal,
      protein_remaining_g: input.remainingMacros.protein_g,
      protein_top_name,
      protein_top_share: id.monotone_flags.protein_top_share,
      components_protein_name: cand.items[0]?.name,
      components_carb_name: cand.items[1]?.name,
    });
    return { cand, total, scores, rationale };
  });

  // 4. Sort by final score, dedup by item signature, take top N.
  const sorted = scored
    .sort((a, b) => b.scores.final - a.scores.final);
  const seen = new Set<string>();
  const top: typeof sorted = [];
  for (const s of sorted) {
    const itemSig = sig(s.cand.items);
    if (seen.has(itemSig)) continue;
    seen.add(itemSig);
    top.push(s);
    if (top.length >= input.count) break;
  }

  const suggestions: MealSuggestion[] = top.map((s, idx) => ({
    rank: idx + 1,
    source: s.cand.source,
    source_ref: s.cand.source_ref,
    items: s.cand.items,
    total_macros: s.total,
    macro_delta_vs_remaining: {
      kcal: s.total.kcal - input.remainingMacros.kcal,
      protein_g: s.total.protein_g - input.remainingMacros.protein_g,
      fits_slot: Math.abs(s.total.kcal - input.slotTargets.kcal) / Math.max(input.slotTargets.kcal, 1) <= SLOT_KCAL_FIT_TOL,
    },
    rationale: s.rationale,
    scores: s.scores,
  }));

  return {
    suggestions,
    context: { remaining_macros_for_day: input.remainingMacros, slot_target: input.slotTargets, monotone_signal },
    filter_stats: { tier1_candidates: tier1Count, after_exclusion: afterExclusion.length, surfaced: suggestions.length },
  };
}

// ── Candidate generators ──

type Candidate = {
  source: MealSuggestion["source"];
  source_ref?: MealSuggestion["source_ref"];
  items: MealSuggestionItem[];
  familiarity: number;            // 0..1, used by scorer
};

function generateTier1(input: SuggestMealInput, id: EatingIdentity): Candidate[] {
  const out: Candidate[] = [];

  // 1a. Library recipes for this slot (log_count >= 2 at this slot).
  // EatingIdentityTopItem.source is a discriminated union; narrow before reading library_item_id.
  for (const t of id.top_items) {
    const inSlot = t.slot_distribution[input.slot] ?? 0;
    if (t.source === "user_library" && inSlot >= 2) {
      out.push({
        source: "library_recipe",
        source_ref: { library_item_id: t.library_item_id },
        items: [{
          name: t.canonical_name,
          qty_g: t.typical_qty_g,
          per_100g: t.macros_per_100g,
          library_item_id: t.library_item_id,
        }],
        familiarity: 1.0,
      });
    }
  }

  // 1b. Frequent combos with avg_slot === this slot.
  for (const c of id.frequent_combos) {
    if (c.avg_slot !== input.slot) continue;
    const items = comboToItems(c.items, id);
    if (items.length === 0) continue;
    out.push({
      source: "frequent_combo",
      source_ref: { combo_signature: comboSignature(c.items) },
      items,
      familiarity: 1.0,
    });
  }

  return out;
}

function generateTier2(input: SuggestMealInput, id: EatingIdentity, existing: Candidate[]): Candidate[] {
  const proteins = topItemsOfKind(id, input.slot, "protein").slice(0, 3);
  const carbs = topItemsOfKind(id, input.slot, "carb").slice(0, 3);
  const sides = topItemsOfKind(id, input.slot, "side").slice(0, 3);
  const out: Candidate[] = [];
  const maxLog = Math.max(1, ...id.top_items.map((t) => t.log_count));

  for (const p of proteins) {
    for (const c of carbs) {
      for (const s of sides) {
        const items: MealSuggestionItem[] = [];
        if (p) items.push(itemFor(p, id));
        if (c) items.push(itemFor(c, id));
        if (s) items.push(itemFor(s, id));
        if (items.length < 2) continue;
        const meanLog = items.reduce((sum, i) => sum + (lookupLogCount(i.name, id) || 0), 0) / items.length;
        out.push({
          source: "slot_pattern_recombination",
          items,
          familiarity: Math.min(1.0, meanLog / maxLog),
        });
      }
    }
  }

  // Drop duplicates of existing tier-1 signatures.
  const existingSigs = new Set(existing.map((c) => sig(c.items)));
  // Cap Tier 2 at 6 candidates. The full 3×3×3=27 product would feed too many
  // sub-Tier-1 candidates into scoring; Tier 1 dominates on familiarity anyway,
  // so 6 covers the realistic case where Tier 1 supply is below `count` AND
  // monotone pressure is high. If you raise this cap, also raise the dedup +
  // top-N slicing downstream to keep ordering predictable.
  return out.filter((c) => !existingSigs.has(sig(c.items))).slice(0, 6);
}

function generateTier3(_input: SuggestMealInput, id: EatingIdentity, existing: Candidate[]): Candidate[] {
  // Take each existing candidate, find a protein-category sibling that is in the
  // repertoire (log_count >= 1) and substitute its first item. The substitute
  // exits this tier with a uniform 0.4 familiarity (per spec).
  const out: Candidate[] = [];
  const existingSigs = new Set(existing.map((c) => sig(c.items)));
  for (const cand of existing) {
    if (cand.items.length === 0) continue;
    const head = cand.items[0];
    const sib = findCategorySibling(head.name, id);
    if (!sib) continue;
    const swapped: MealSuggestionItem[] = [itemFor(sib, id), ...cand.items.slice(1)];
    const s = sig(swapped);
    if (existingSigs.has(s)) continue;
    out.push({ source: "adjacent_substitution", items: swapped, familiarity: 0.4 });
  }
  return out.slice(0, 4);
}

// ── Scoring ──

function score(args: {
  cand: { items: MealSuggestionItem[]; total: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number } };
  input: SuggestMealInput;
  id: EatingIdentity;
  slot_typical_kcal: number;
  protein_top_name: string | null;
  tierFamiliarity: number;
  newRecipeBoosts: Array<{ library_item_id: string; weight: number }>;
}): MealSuggestionScores {
  const { cand, input, id, slot_typical_kcal, tierFamiliarity, newRecipeBoosts } = args;
  const rem = input.remainingMacros;

  // macro_fit: weighted L1 distance.
  const denomKcal = Math.max(rem.kcal, 200);
  const denomP = Math.max(rem.protein_g, 10);
  const denomC = Math.max(rem.carbs_g, 20);
  const denomF = Math.max(rem.fat_g, 5);
  const dKcal = Math.abs(cand.total.kcal - rem.kcal) / denomKcal;
  const dP = (Math.abs(cand.total.protein_g - rem.protein_g) / denomP) * 2;
  const dC = (Math.abs(cand.total.carbs_g - rem.carbs_g) / denomC) * 0.5;
  const dF = (Math.abs(cand.total.fat_g - rem.fat_g) / denomF) * 0.5;
  const macro_fit = clamp(1 - (dKcal + dP + dC + dF) / 4, 0, 1);

  // familiarity: tier-supplied + optional new-recipe boost.
  let familiarity = clamp(tierFamiliarity, 0, 1);
  if (newRecipeBoosts.length > 0) {
    for (const it of cand.items) {
      if (it.library_item_id) {
        const b = newRecipeBoosts.find((x) => x.library_item_id === it.library_item_id);
        if (b) familiarity = clamp(familiarity + b.weight, 0, 1);
      }
    }
  }

  // variety_boost: only when monotone_top_share > 0.5 AND candidate's first item
  // is in a low-share protein category.
  //
  // variety_boost: fire when monotone pressure is detected and the candidate's
  // primary protein category is under-represented in the athlete's repertoire.
  //
  // Spec §7.4 specifies "logged in <20% of last 14 days" — v1 uses the full
  // 90-day window (protein_category_counts) as a proxy. For a slow-changing diet
  // this is equivalent; recent protein-switch users may see slightly stale boost
  // signals. v2 may add a 14d-scoped count to EatingIdentity if needed.
  let variety_boost = 0;
  if (id.monotone_flags.protein_top_share > MONOTONE_PRESSURE_THRESHOLD) {
    // proxy: assume cand.items[0] is the protein. Look up its protein category from word-list classify.
    // We don't re-import here for cycle reasons — use a coarse name check.
    const candFirstName = cand.items[0]?.name ?? "";
    const head = id.top_items.find((t) => t.canonical_name === candFirstName);
    const cat = head ? bestProteinCategoryForItem(candFirstName) : null;
    if (cat) {
      const total = Object.values(id.protein_category_counts).reduce((s, v) => s + v, 0) || 1;
      const share = (id.protein_category_counts[cat] ?? 0) / total;
      if (share < VARIETY_BOOST_PROTEIN_LOW_SHARE) variety_boost = 1;
    }
  }

  // slot_fit: kcal closeness to slot_typical_kcal.
  const slot_fit = clamp(1 - Math.abs(cand.total.kcal - slot_typical_kcal) / Math.max(slot_typical_kcal, 200), 0, 1);

  const final = macro_fit * (FAMILIARITY_FLOOR + (1 - FAMILIARITY_FLOOR) * familiarity) * (1 + 0.3 * variety_boost) * slot_fit;

  return { macro_fit, familiarity, variety_boost, slot_fit, final };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sumMacros(items: MealSuggestionItem[]): { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number } {
  return items.reduce(
    (acc, i) => {
      const f = i.qty_g / 100;
      return {
        kcal: acc.kcal + i.per_100g.kcal * f,
        protein_g: acc.protein_g + i.per_100g.protein_g * f,
        carbs_g: acc.carbs_g + i.per_100g.carbs_g * f,
        fat_g: acc.fat_g + i.per_100g.fat_g * f,
        fiber_g: acc.fiber_g + i.per_100g.fiber_g * f,
      };
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  );
}

function sig(items: MealSuggestionItem[]): string {
  return items.map((i) => i.name.toLowerCase()).sort().join("|");
}

function comboSignature(names: string[]): string {
  const h = createHash("sha1").update([...names].sort().join("|")).digest("hex");
  return h.slice(0, 12);
}

// ── Reusable lookups against EatingIdentity ──

function lookupLogCount(name: string, id: EatingIdentity): number | null {
  const hit = id.top_items.find((t) => t.canonical_name === name);
  return hit?.log_count ?? null;
}

function itemFor(canonicalName: string, id: EatingIdentity): MealSuggestionItem {
  const t = id.top_items.find((x) => x.canonical_name === canonicalName);
  if (!t) {
    return { name: canonicalName, qty_g: 100, per_100g: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 } };
  }
  const base: MealSuggestionItem = {
    name: t.canonical_name,
    qty_g: t.typical_qty_g,
    per_100g: t.macros_per_100g,
  };
  if (t.source === "user_library") base.library_item_id = t.library_item_id;
  return base;
}

function comboToItems(canonicalNames: string[], id: EatingIdentity): MealSuggestionItem[] {
  // Drop zero-macro fallbacks: when a combo item is outside top_items (top-40
  // cap), itemFor returns a stub with per_100g.kcal=0. Including those would
  // silently corrupt macro_fit scoring — the candidate would look lighter than
  // it actually is. A combo we can't fully resolve is dropped entirely.
  const items = canonicalNames.map((n) => itemFor(n, id));
  if (items.some((i) => i.per_100g.kcal === 0 && i.per_100g.protein_g === 0)) return [];
  return items;
}

function topItemsOfKind(id: EatingIdentity, slot: MealSlot, kind: "protein" | "carb" | "side"): string[] {
  // Filter id.top_items by slot presence (slot_distribution[slot] > 0) and rank.
  // Kind classification at this layer uses a name token check inline so we don't
  // re-fetch USDA categories here.
  const candidates = id.top_items
    .filter((t) => (t.slot_distribution[slot] ?? 0) > 0)
    .filter((t) => t.log_count >= 3)   // spec §7.2 — Tier 2 needs familiar parts
    .sort((a, b) => b.log_count - a.log_count);
  const filtered = candidates.filter((t) => {
    if (kind === "protein") return PROTEIN_NAME_RE.test(t.canonical_name);
    if (kind === "carb") return CARB_NAME_RE.test(t.canonical_name);
    return !PROTEIN_NAME_RE.test(t.canonical_name) && !CARB_NAME_RE.test(t.canonical_name);
  });
  return filtered.map((t) => t.canonical_name);
}

function findCategorySibling(name: string, id: EatingIdentity): string | null {
  // Heuristic: protein siblings — if name matches "chicken", look for "turkey" in top_items.
  // For v1 keep simple: chicken↔turkey, beef↔lamb, rice↔quinoa, oats↔rice.
  const PAIRS: Record<string, string[]> = {
    chicken: ["turkey"],
    turkey: ["chicken"],
    beef: ["lamb"],
    lamb: ["beef"],
    rice: ["quinoa", "couscous"],
    oats: ["rice"],
  };
  const lower = name.toLowerCase();
  for (const [k, sibs] of Object.entries(PAIRS)) {
    if (lower.includes(k)) {
      for (const s of sibs) {
        const found = id.top_items.find((t) => t.canonical_name.toLowerCase().includes(s));
        if (found) return found.canonical_name;
      }
    }
  }
  return null;
}

/**
 * Coarse protein-category classifier for variety-boost scoring.
 * Uses the actual `ProteinCategory` literals from lib/data/types.ts
 * (poultry / red_meat / fish_seafood / eggs / dairy_protein / plant_protein),
 * not the plan's draft `meat_protein` / `fish_protein` placeholders.
 */
function bestProteinCategoryForItem(name: string): keyof EatingIdentity["protein_category_counts"] | null {
  const lower = name.toLowerCase();
  if (/(chicken|turkey|duck|hen|quail)/.test(lower)) return "poultry";
  if (/(beef|lamb|pork|veal|venison|bison|mutton|ham|bacon|sausage|chorizo|salami|prosciutto|pepperoni)/.test(lower)) return "red_meat";
  if (/(fish|salmon|tuna|sardine|cod|halibut|mackerel|anchov|shrimp|prawn|lobster|crab|trout|tilapia|bass)/.test(lower)) return "fish_seafood";
  if (/eggs?/.test(lower)) return "eggs";
  if (/(milk|cheese|yog|whey|kefir|skyr|ricotta|cottage)/.test(lower)) return "dairy_protein";
  if (/(tofu|tempeh|lentil|chickpea|chick pea|garbanzo|bean|hummus|edamame|seitan)/.test(lower)) return "plant_protein";
  return null;
}

function topProteinName(id: EatingIdentity): string | null {
  for (const t of id.top_items) {
    if (PROTEIN_NAME_RE.test(t.canonical_name)) {
      return t.canonical_name;
    }
  }
  return null;
}

function monotoneSignal(id: EatingIdentity): SuggestEngineOutput["context"]["monotone_signal"] {
  if (id.monotone_flags.protein_top_share <= MONOTONE_PRESSURE_THRESHOLD) return null;
  const name = topProteinName(id);
  if (!name) return null;
  return { protein_top: name, share: id.monotone_flags.protein_top_share };
}

function emptyContext(
  input: SuggestMealInput,
  monotone_signal: SuggestEngineOutput["context"]["monotone_signal"],
): SuggestEngineOutput["context"] {
  return { remaining_macros_for_day: input.remainingMacros, slot_target: input.slotTargets, monotone_signal };
}
