# Nora Suggestion Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deterministic, history-grounded meal suggestion engine for Nora with hard dietary exclusions, tappable one-tap-log cards, and recipe discovery from log co-occurrence.

**Architecture:** New `lib/coach/nora-suggestions/` module family hangs off the existing `nutrition-intelligence/` and `proactive/` patterns. A daily cron materializes an `EatingIdentity` payload into `profiles.eating_identity_cache`. A pure scoring engine consumes that payload + structured `dietary_exclusions` + remaining-day macros and emits ranked suggestions. A new `propose_meal_suggestions` tool surfaces them as chat cards whose Log buttons reuse the existing `[approve:<token>]` short-circuit pipeline — no new commit endpoint. Recipe discovery rides on the existing `proactive_nudge` infrastructure.

**Tech Stack:** Next.js 15 App Router, Supabase (RLS), Postgres jsonb, Anthropic Sonnet (no AI in engine critical path — only NORA_BASE prompt narration), Tailwind v4, TanStack Query, HMAC approval tokens (`COACH_TOOL_SECRET`).

**Spec:** [docs/superpowers/specs/2026-05-29-nora-suggestion-engine-design.md](../specs/2026-05-29-nora-suggestion-engine-design.md)

**No test suite in this project.** Verification = typecheck (`npm run typecheck`) + audit scripts via the alias-loader pattern + manual UI exercise on `npm run dev`. The plan replaces TDD's "write failing test first" with "write audit script, run, observe expected output."

---

## File Structure

**Migrations**
- Create: `supabase/migrations/0038_nora_suggestion_engine.sql` — adds `profiles.dietary_exclusions` + `profiles.eating_identity_cache`.

**Types**
- Modify: `lib/data/types.ts` — add `ExclusionTag`, `DietaryExclusions`, `EatingIdentity`, `MealSuggestion`, `SuggestEngineOutput` exports.

**Engine modules** (new dir `lib/coach/nora-suggestions/`)
- `exclusions.ts` — closed-vocabulary predicates + `passesExclusions`.
- `canonicalize.ts` — name canonicalization for frequency grouping.
- `compose-eating-identity.ts` — 90-day rollup composer (pure-ish: reads supabase, returns payload).
- `suggest-meal.ts` — pure scoring engine (no I/O).
- `rationale.ts` — deterministic template selection.
- `render-injection.ts` — snapshot-prefix block for Nora.
- `recipe-discovery.ts` — qualifying-combo filter + dedup orchestration.

**Tool wiring**
- Modify: `lib/coach/tools.ts` — add `PROPOSE_MEAL_SUGGESTIONS_TOOL` schema + handler; add to `NORA_TOOLS`.
- Modify: `lib/coach/chat-stream.ts` — add tool to `PERSIST_RESULT_TOOLS` + `modeAllowsTool` allowlist.
- Modify: `lib/coach/system-prompts.ts` — append three new sections to `NORA_BASE`.
- Modify: `app/api/chat/messages/route.ts` — load Nora's eating-identity injection block for nora-routed turns.

**Routes**
- Create: `app/api/profile/dietary-exclusions/route.ts` — PATCH handler.
- Create: `app/api/coach/eating-identity/sync/route.ts` — cron.
- Create: `app/api/coach/recipe-discovery/check/route.ts` — cron.
- Modify or create: `app/api/chat/nudge-dismiss/route.ts` — extends if exists, otherwise creates.

**UI**
- Create: `components/chat/MealSuggestionsCard.tsx` — suggestion card with per-option Log/Tweak.
- Create: `components/profile/DietaryExclusionsSection.tsx` — tag-chip multi-select + free-text.
- Modify: `components/chat/ChatThread.tsx` — dispatcher case for `propose_meal_suggestions` tool result.
- Modify: `components/chat/ProactiveNudgeCard.tsx` — render branch for `kind: 'save_recipe'`.
- Modify: `app/profile/page.tsx` (or the profile client) — mount `DietaryExclusionsSection`.

**Cron config**
- Modify: `vercel.json` — add two cron entries.

**Scripts**
- Create: `scripts/migrate-exclusions.mjs` — one-shot backfill.
- Create: `scripts/audit-eating-identity.mjs` — composer dry-run + sanity.
- Create: `scripts/audit-suggest-meal.mjs` — engine dry-run + invariant checks.
- Create: `scripts/audit-recipe-discovery.mjs` — discovery dry-run + dedup trace.

---

## Phase 1 — Data layer

### Task 1: Migration + types skeleton

**Files:**
- Create: `supabase/migrations/0038_nora_suggestion_engine.sql`
- Modify: `lib/data/types.ts` — add new exports near existing nutrition types

- [ ] **Step 1: Write migration SQL**

```sql
-- supabase/migrations/0038_nora_suggestion_engine.sql
-- Nora suggestion engine: structured dietary exclusions + cached 90d eating identity rollup.

alter table profiles
  add column if not exists dietary_exclusions jsonb not null
    default '{"tags": [], "free_text": null, "version": 1}'::jsonb,
  add column if not exists eating_identity_cache jsonb;

comment on column profiles.dietary_exclusions is
  'Structured hard-NO list for Nora suggestion engine. Shape: { tags: ExclusionTag[], free_text: string|null, version: 1 }. Tags drive deterministic filter; free_text is advisory for Nora prose.';

comment on column profiles.eating_identity_cache is
  '90d log rollup for Nora suggestion engine. Shape: EatingIdentity (see lib/data/types.ts). Cron-populated at 03:30 UTC daily. NULL = first-run user, not yet synced.';

-- Helpful index for the daily eating-identity sync walking profiles with logged data.
-- Profiles is tiny in this single-user app, but the pattern matches existing migrations.
```

- [ ] **Step 2: Apply migration**

Run: `supabase db push`
Expected: `Applying migration 20260529..._nora_suggestion_engine.sql... Done.`

If the migration was already applied to remote (you're working on a worktree branch and main has the migration), run instead: `supabase migration repair --status applied 20260529<the_timestamp>` then `supabase db push`.

- [ ] **Step 3: Add types to `lib/data/types.ts`**

Find the nutrition types block (search for `export type MealSlot` or `type ProteinCategory`) and append below it:

```ts
// ── Nora suggestion engine ───────────────────────────────────────────────

export type ExclusionTag =
  | "pork"
  | "shellfish"
  | "alcohol"
  | "gluten"
  | "dairy"
  | "eggs"
  | "peanuts"
  | "tree_nuts"
  | "soy"
  | "red_meat"
  | "all_meat"
  | "fish";

export type DietaryExclusions = {
  tags: ExclusionTag[];
  free_text: string | null;
  version: 1;
};

export type EatingIdentityTopItem = {
  canonical_name: string;
  name_variants: string[];
  source: "user_library" | "db" | "llm";
  library_item_id?: string;
  log_count: number;
  typical_qty_g: number;
  macros_per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  slot_distribution: Record<MealSlot, number>;
  last_logged: string;
};

export type EatingIdentitySlotPattern = {
  typical_kcal_avg: number;
  typical_protein_g_avg: number;
  top_items: string[];
};

export type EatingIdentityCombo = {
  items: string[];
  co_occurrence_count: number;
  last_seen: string;
  avg_slot: MealSlot;
};

export type EatingIdentity = {
  generated_on: string;
  window_days: 90;
  top_items: EatingIdentityTopItem[];
  protein_category_counts: Record<ProteinCategory, number>;
  carb_category_counts: Record<CarbCategory, number>;
  cooking_method_counts: Record<CookingMethod, number>;
  slot_patterns: Record<MealSlot, EatingIdentitySlotPattern>;
  frequent_combos: EatingIdentityCombo[];
  monotone_flags: {
    protein_top_share: number;
    carb_top_share: number;
    most_repeated_meal: { items: string[]; count: number } | null;
  };
};

export type MealSuggestionSource =
  | "library_recipe"
  | "frequent_combo"
  | "slot_pattern_recombination"
  | "adjacent_substitution";

export type MealSuggestionItem = {
  name: string;
  qty_g: number;
  per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  library_item_id?: string;
};

export type MealSuggestionScores = {
  macro_fit: number;
  familiarity: number;
  variety_boost: number;
  slot_fit: number;
  final: number;
};

export type MealSuggestion = {
  rank: number;
  source: MealSuggestionSource;
  source_ref?: { library_item_id?: string; combo_signature?: string };
  items: MealSuggestionItem[];
  total_macros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  macro_delta_vs_remaining: { kcal: number; protein_g: number; fits_slot: boolean };
  rationale: string;
  scores: MealSuggestionScores;
};

export type SuggestEngineError = "exclusions_exhausted" | "no_history";

export type SuggestEngineOutput = {
  suggestions: MealSuggestion[];
  context: {
    remaining_macros_for_day: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
    slot_target: { kcal: number; protein_g: number };
    monotone_signal: { protein_top: string; share: number } | null;
  };
  filter_stats: {
    tier1_candidates: number;
    after_exclusion: number;
    surfaced: number;
  };
  error?: SuggestEngineError;
};
```

If `ProteinCategory`, `CarbCategory`, `CookingMethod`, `MealSlot` aren't imported into `types.ts` yet, add the missing imports from `@/lib/food/types` and `@/lib/coach/nutrition-intelligence/word-lists` at the top.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0038_nora_suggestion_engine.sql lib/data/types.ts
git commit -m "feat(nora): add dietary_exclusions + eating_identity_cache schema + types"
```

---

### Task 2: Exclusion predicates module

**Files:**
- Create: `lib/coach/nora-suggestions/exclusions.ts`

- [ ] **Step 1: Write the module**

```ts
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
    !/\b(pork|bacon|ham|prosciutto|chorizo|pancetta|jam[oó]n|salami|sausage)\b/i.test(it.name) &&
    !usdaStartsWith(it, ["Pork", "Sausages and Luncheon"]),
  shellfish: (it) =>
    !/\b(shrimp|prawn|lobster|crab|mussels?|oysters?|clams?|scallops?|crayfish)\b/i.test(it.name),
  alcohol: (it) =>
    !/\b(wine|beer|whisk(e)?y|vodka|rum|gin|tequila|champagne|prosecco|cocktail|spirits?)\b/i.test(it.name),
  gluten: (it) =>
    !/\b(wheat|barley|rye|bread|pasta|noodles?|couscous|bulgur|semolina|farro)\b/i.test(it.name),
  dairy: (it) =>
    !/\b(milk|cheese|yogurt|yoghurt|butter|cream|whey|casein|kefir)\b/i.test(it.name) &&
    !usdaStartsWith(it, ["Dairy and Egg"]),
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
```

- [ ] **Step 2: Write smoke check inline**

Create `scripts/check-exclusions.mjs`:

```js
// scripts/check-exclusions.mjs
// Quick sanity check that exclusion predicates fire on obvious cases.

import { passesExclusions, violatedTags } from "../lib/coach/nora-suggestions/exclusions.ts";

const cases = [
  { name: "pork", input: [{ name: "pork shoulder" }], tags: ["pork"], expect: false },
  { name: "bacon→pork", input: [{ name: "bacon strips" }], tags: ["pork"], expect: false },
  { name: "chicken passes pork", input: [{ name: "chicken breast" }], tags: ["pork"], expect: true },
  { name: "shrimp→shellfish", input: [{ name: "garlic shrimp" }], tags: ["shellfish"], expect: false },
  { name: "salmon→fish", input: [{ name: "smoked salmon" }], tags: ["fish"], expect: false },
  { name: "tofu→soy", input: [{ name: "tofu cubes" }], tags: ["soy"], expect: false },
  { name: "rice passes all", input: [{ name: "jasmine rice" }], tags: ["pork", "shellfish", "fish", "soy"], expect: true },
  { name: "no tags = pass", input: [{ name: "anything" }], tags: [], expect: true },
  { name: "multi-item one violation", input: [{ name: "chicken" }, { name: "wine"}], tags: ["alcohol"], expect: false },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = passesExclusions(c.input, c.tags);
  const ok = got === c.expect;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name} — got ${got}, expected ${c.expect}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`   violations:`, c.input.map((i) => ({ name: i.name, tags: violatedTags(i, c.tags) })));
  }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the smoke check**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/check-exclusions.mjs`
Expected: `9/9 passed`

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/nora-suggestions/exclusions.ts scripts/check-exclusions.mjs
git commit -m "feat(nora): dietary exclusion predicates"
```

---

### Task 3: Dietary exclusions PATCH route + backfill script

**Files:**
- Create: `app/api/profile/dietary-exclusions/route.ts`
- Create: `scripts/migrate-exclusions.mjs`

- [ ] **Step 1: Write PATCH route**

```ts
// app/api/profile/dietary-exclusions/route.ts
//
// PATCH the structured dietary_exclusions jsonb on profiles. Partial:
// { tags?: ExclusionTag[], free_text?: string|null } — undefined keys keep,
// null clears (for free_text), arrays replace.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ExclusionTag } from "@/lib/data/types";

const ALL_TAGS: ExclusionTag[] = [
  "pork", "shellfish", "alcohol", "gluten", "dairy", "eggs",
  "peanuts", "tree_nuts", "soy", "red_meat", "all_meat", "fish",
];

const Body = z.object({
  tags: z.array(z.enum(ALL_TAGS as [ExclusionTag, ...ExclusionTag[]])).optional(),
  free_text: z.union([z.string().max(500), z.null()]).optional(),
});

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // Load current, merge, write back. profiles row exists for every authed user.
  const { data: row, error: readErr } = await supabase
    .from("profiles")
    .select("dietary_exclusions")
    .eq("user_id", user.id)
    .single();
  if (readErr) return NextResponse.json({ error: "read_failed", detail: readErr.message }, { status: 500 });

  const current = (row?.dietary_exclusions ?? { tags: [], free_text: null, version: 1 }) as {
    tags: ExclusionTag[];
    free_text: string | null;
    version: 1;
  };

  const next = {
    tags: parsed.data.tags ?? current.tags,
    free_text: parsed.data.free_text === undefined ? current.free_text : parsed.data.free_text,
    version: 1 as const,
  };

  const { error: writeErr } = await supabase
    .from("profiles")
    .update({ dietary_exclusions: next })
    .eq("user_id", user.id);
  if (writeErr) return NextResponse.json({ error: "write_failed", detail: writeErr.message }, { status: 500 });

  return NextResponse.json({ dietary_exclusions: next });
}
```

- [ ] **Step 2: Write backfill script**

```js
// scripts/migrate-exclusions.mjs
//
// One-shot: parse athlete_profile_documents intake.nutrition.restrictions +
// intake.health.allergies free-text into structured exclusion tags. Reports
// per-user diff. Idempotent — skips profiles whose tags array is non-empty.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const TAG_PATTERNS = [
  { tag: "pork", re: /\b(no |avoid |without )?(pork|bacon|ham|prosciutto|chorizo|halal|muslim)\b/i },
  { tag: "shellfish", re: /\b(no |avoid )?shellfish|shrimp|prawn|lobster|crab\b/i },
  { tag: "alcohol", re: /\b(no |without )?alcohol|wine|beer|spirits?\b/i },
  { tag: "gluten", re: /\b(gluten[- ]?free|celiac|coeliac|no gluten|no wheat)\b/i },
  { tag: "dairy", re: /\b(lactose intolerant|dairy[- ]?free|no dairy|no milk)\b/i },
  { tag: "eggs", re: /\b(no eggs?|egg allerg|egg-free)\b/i },
  { tag: "peanuts", re: /\b(peanut allerg|no peanuts?)\b/i },
  { tag: "tree_nuts", re: /\b(tree nut allerg|nut allerg|no nuts?)\b/i },
  { tag: "soy", re: /\b(soy allerg|no soy)\b/i },
  { tag: "red_meat", re: /\b(no red meat)\b/i },
  { tag: "all_meat", re: /\b(vegetarian|vegan|no meat)\b/i },
  { tag: "fish", re: /\b(no fish|pescetarian (no )?fish)\b/i },
];

function parse(text) {
  if (!text) return [];
  const hits = new Set();
  for (const { tag, re } of TAG_PATTERNS) {
    if (re.test(text)) hits.add(tag);
  }
  return [...hits];
}

const { data: profiles, error } = await supabase
  .from("profiles")
  .select("user_id, dietary_exclusions");
if (error) { console.error(error); process.exit(1); }

let touched = 0, skipped = 0;
for (const p of profiles ?? []) {
  const existing = p.dietary_exclusions ?? { tags: [], free_text: null, version: 1 };
  if ((existing.tags ?? []).length > 0) { skipped++; continue; }

  // Pull latest acknowledged athlete profile doc.
  const { data: doc } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("user_id", p.user_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nutritionRestrictions = doc?.intake_payload?.nutrition?.restrictions ?? "";
  const allergies = doc?.intake_payload?.health?.allergies ?? "";
  const tags = parse(`${nutritionRestrictions}\n${allergies}`);
  if (tags.length === 0) { skipped++; continue; }

  const next = { tags, free_text: existing.free_text, version: 1 };
  const { error: upErr } = await supabase
    .from("profiles")
    .update({ dietary_exclusions: next })
    .eq("user_id", p.user_id);
  if (upErr) { console.error(p.user_id, upErr); continue; }

  console.log(`user=${p.user_id} parsed tags:`, tags);
  touched++;
}

console.log(`\n${touched} updated, ${skipped} skipped`);
```

- [ ] **Step 3: Run backfill (dry — single-user app, expect 0 or 1 updates)**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/migrate-exclusions.mjs`
Expected: `0 updated, 1 skipped` (because your profile's tags array starts empty unless you have parseable free-text restrictions).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/profile/dietary-exclusions/route.ts scripts/migrate-exclusions.mjs
git commit -m "feat(profile): dietary exclusions PATCH route + backfill script"
```

---

### Task 4: Profile UI — DietaryExclusionsSection

**Files:**
- Create: `components/profile/DietaryExclusionsSection.tsx`
- Modify: `app/profile/page.tsx` (or the existing profile client component) — mount the section

- [ ] **Step 1: Find where to mount the section**

Run: `grep -rn "NutritionTargetsSection\|profiles.system_prompt\|SleepBaseline" app/profile components/profile | head -10`

You're looking for the existing profile sections list. Most likely candidates: `components/profile/ProfileClient.tsx` or `app/profile/page.tsx`. Identify the section ordering — Nutrition baseline should appear before Sleep baseline; mount our new section **between** them.

- [ ] **Step 2: Write the section component**

```tsx
// components/profile/DietaryExclusionsSection.tsx
"use client";

import { useState } from "react";
import type { ExclusionTag, DietaryExclusions } from "@/lib/data/types";

const ALL_TAGS: { tag: ExclusionTag; label: string }[] = [
  { tag: "pork", label: "Pork" },
  { tag: "shellfish", label: "Shellfish" },
  { tag: "alcohol", label: "Alcohol" },
  { tag: "gluten", label: "Gluten" },
  { tag: "dairy", label: "Dairy" },
  { tag: "eggs", label: "Eggs" },
  { tag: "peanuts", label: "Peanuts" },
  { tag: "tree_nuts", label: "Tree nuts" },
  { tag: "soy", label: "Soy" },
  { tag: "red_meat", label: "Red meat" },
  { tag: "all_meat", label: "All meat" },
  { tag: "fish", label: "Fish" },
];

export function DietaryExclusionsSection({ initial }: { initial: DietaryExclusions }) {
  const [tags, setTags] = useState<Set<ExclusionTag>>(new Set(initial.tags));
  const [freeText, setFreeText] = useState(initial.free_text ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const toggle = (t: ExclusionTag) => {
    const next = new Set(tags);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTags(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/profile/dietary-exclusions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: [...tags], free_text: freeText.trim() === "" ? null : freeText }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Dietary exclusions</h2>
        <p className="text-sm text-neutral-400">
          Hard NOs that Nora will respect when she suggests meals. Tags drive a deterministic filter; free-text captures nuance.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {ALL_TAGS.map(({ tag, label }) => {
          const active = tags.has(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                active
                  ? "border-rose-400 bg-rose-500/15 text-rose-200"
                  : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <label className="block space-y-1">
        <span className="text-sm text-neutral-300">Notes (advisory, Nora reads in prose)</span>
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="e.g. no raw fish, limit dairy at night"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save exclusions"}
        </button>
        {savedAt !== null && (
          <span className="text-xs text-emerald-400">Saved</span>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Mount the section in the profile page**

Locate the profile client (per Step 1). Add:
- Server-side: fetch `profiles.dietary_exclusions` alongside the existing profile fetch.
- Client-side: render `<DietaryExclusionsSection initial={...} />` between Nutrition baseline and Sleep baseline sections.

Concrete edit (adjust to actual file paths):

```tsx
// At the top of the profile client:
import { DietaryExclusionsSection } from "@/components/profile/DietaryExclusionsSection";

// Inside the JSX, between Nutrition baseline and Sleep baseline:
<DietaryExclusionsSection initial={profile.dietary_exclusions ?? { tags: [], free_text: null, version: 1 }} />
```

If the profile fetch uses a select string, ensure `dietary_exclusions` is added to it.

- [ ] **Step 4: Verify in browser**

Run: `npm run dev`
Open: `http://localhost:3000/profile`
Verify: Dietary exclusions section renders between Nutrition baseline and Sleep baseline. Toggle 2 tags. Type a note. Click Save. See "Saved." Refresh page; selections persist.

If your profile has no `dietary_exclusions` column data yet (migration applied but column unread), the default `{ tags: [], free_text: null, version: 1 }` from the SQL default kicks in.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add components/profile/DietaryExclusionsSection.tsx app/profile/page.tsx <or the profile client>
git commit -m "feat(profile): dietary exclusions tag picker + free-text"
```

---

## Phase 2 — EatingIdentity composer + cron + audit

### Task 5: Name canonicalizer

**Files:**
- Create: `lib/coach/nora-suggestions/canonicalize.ts`

- [ ] **Step 1: Write canonicalizer**

```ts
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
```

- [ ] **Step 2: Spot-check inline**

Add to `scripts/check-exclusions.mjs` (or create a new check script):

```js
// scripts/check-canonicalize.mjs
import { canonicalizeItemName } from "../lib/coach/nora-suggestions/canonicalize.ts";

const cases = [
  ["grilled chicken breast", "chicken breast"],
  ["Chicken Breast, Cooked", "chicken breast"],
  ["raw jasmine rice", "jasmine rice"],
  ["sliced cucumber", "cucumber"],
  ["smoked salmon fillet", "salmon fillet"],
  ["overnight oats", "overnight oats"],
];
let pass = 0, fail = 0;
for (const [input, expected] of cases) {
  const got = canonicalizeItemName(input);
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${input} → ${got} (expected ${expected})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/check-canonicalize.mjs`
Expected: `6/6 passed`

- [ ] **Step 4: Commit**

```bash
git add lib/coach/nora-suggestions/canonicalize.ts scripts/check-canonicalize.mjs
git commit -m "feat(nora): item-name canonicalizer for frequency grouping"
```

---

### Task 6: EatingIdentity composer

**Files:**
- Create: `lib/coach/nora-suggestions/compose-eating-identity.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/nora-suggestions/compose-eating-identity.ts
//
// 90-day rollup. Reads food_log_entries (committed) + user_food_items
// (library + recipe expansion) + food_db_cache (USDA category for the
// category-classifier fallback). Returns EatingIdentity payload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EatingIdentity,
  EatingIdentityTopItem,
  EatingIdentityCombo,
  MealSlot,
} from "@/lib/data/types";
import type { FoodItem } from "@/lib/food/types";
import { canonicalizeItemName } from "./canonicalize";
import {
  classifyProtein,
  classifyCarb,
  classifyCookingMethod,
} from "@/lib/coach/nutrition-intelligence/classify";

const WINDOW_DAYS = 90;
const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

type Entry = {
  eaten_at: string;
  meal_slot: MealSlot;
  items: FoodItem[] | null;
  recipe_id: string | null;
};

type Recipe = {
  id: string;
  name: string;
  composite_of: Array<{ name: string; qty_g: number; per_100g: FoodItem["per_100g"] }> | null;
  per_100g: FoodItem["per_100g"] | null;
};

export async function composeEatingIdentity(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<EatingIdentity> {
  const { supabase, userId, today } = args;
  const windowStart = shiftDays(today, -WINDOW_DAYS);

  // 1. Fetch committed entries in window.
  const { data: rawEntries, error } = await supabase
    .from("food_log_entries")
    .select("eaten_at, meal_slot, items, recipe_id")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${windowStart}T00:00:00Z`)
    .lte("eaten_at", `${today}T23:59:59Z`);
  if (error) throw error;
  const entries = (rawEntries as Entry[] | null) ?? [];

  // 2. Resolve library + recipe lookup table.
  const libraryIds = collectLibraryIds(entries);
  const libraryById = await fetchLibrary(supabase, userId, libraryIds);

  // 3. Resolve USDA categories for db items (uses food_db_cache).
  const canonicalIds = collectDbCanonicalIds(entries);
  const usdaCatByCanonical = await fetchUsdaCategories(supabase, canonicalIds);

  // 4. Build per-item rows: every counted "item" is either a recipe (atomic)
  //    or a single item (USDA / library single / llm). Recipes contribute one
  //    row to top_items and weighted component votes to category counts.
  const itemRows: ItemRow[] = [];
  for (const e of entries) {
    for (const it of e.items ?? []) {
      const ref = it.db_ref;
      const libId = ref?.source === "user_library" ? (ref.canonical_id as string) : null;
      const libRow = libId ? libraryById.get(libId) ?? null : null;

      // Recipe entry: counted atomically.
      if (libRow?.composite_of) {
        itemRows.push({
          kind: "recipe",
          canonical: canonicalizeItemName(libRow.name),
          variant: it.name,
          source: "user_library",
          library_item_id: libRow.id,
          qty_g: it.qty_g ?? 0,
          per_100g: libRow.per_100g ?? it.per_100g ?? defaultPer100g(),
          eaten_at: e.eaten_at,
          slot: e.meal_slot,
          components: libRow.composite_of,
        });
        continue;
      }

      // Single library / db / llm.
      const usdaCat = ref?.canonical_id ? usdaCatByCanonical.get(ref.canonical_id) ?? null : null;
      itemRows.push({
        kind: "single",
        canonical: canonicalizeItemName(libRow?.name ?? it.name),
        variant: it.name,
        source: libRow ? "user_library" : (ref?.source === "db" ? "db" : "llm"),
        library_item_id: libRow?.id,
        usda_category: usdaCat,
        qty_g: it.qty_g ?? 0,
        per_100g: libRow?.per_100g ?? it.per_100g ?? defaultPer100g(),
        eaten_at: e.eaten_at,
        slot: e.meal_slot,
      });
    }
  }

  // 5. Frequency-rank top items by canonical name.
  const byCanonical = new Map<string, ItemRow[]>();
  for (const r of itemRows) {
    const k = r.canonical;
    if (!byCanonical.has(k)) byCanonical.set(k, []);
    byCanonical.get(k)!.push(r);
  }
  const top_items: EatingIdentityTopItem[] = [...byCanonical.entries()]
    .map(([canonical, rows]) => {
      const variants = [...new Set(rows.map((r) => r.variant))];
      const qty = rows.map((r) => r.qty_g).filter((q) => q > 0).sort((a, b) => a - b);
      const typical_qty_g = qty.length > 0 ? qty[Math.floor(qty.length / 2)] : 0;
      const slot_distribution: Record<MealSlot, number> = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
      for (const r of rows) slot_distribution[r.slot]++;
      const last_logged = rows.map((r) => r.eaten_at).sort().slice(-1)[0]!.slice(0, 10);
      const head = rows[0];
      return {
        canonical_name: canonical,
        name_variants: variants,
        source: head.source,
        library_item_id: head.library_item_id,
        log_count: rows.length,
        typical_qty_g,
        macros_per_100g: head.per_100g,
        slot_distribution,
        last_logged,
      };
    })
    .sort((a, b) => b.log_count - a.log_count)
    .slice(0, 40);

  // 6. Category counts. For recipes: proportional votes per component.
  const proteinCounts = emptyRecord<ReturnType<typeof classifyProtein>["category"]>();
  const carbCounts = emptyRecord<ReturnType<typeof classifyCarb>["category"]>();
  const cookingCounts = emptyRecord<ReturnType<typeof classifyCookingMethod>>();
  for (const r of itemRows) {
    if (r.kind === "recipe" && r.components) {
      const totalQty = r.components.reduce((s, c) => s + (c.qty_g ?? 0), 0) || 1;
      for (const c of r.components) {
        const w = (c.qty_g ?? 0) / totalQty;
        const p = classifyProtein(c.name, null);
        proteinCounts[p.category] = (proteinCounts[p.category] ?? 0) + w;
        const cb = classifyCarb(c.name, null);
        carbCounts[cb.category] = (carbCounts[cb.category] ?? 0) + w;
        const cm = classifyCookingMethod(c.name);
        cookingCounts[cm] = (cookingCounts[cm] ?? 0) + w;
      }
    } else {
      const p = classifyProtein(r.variant, r.usda_category ?? null);
      proteinCounts[p.category] = (proteinCounts[p.category] ?? 0) + 1;
      const cb = classifyCarb(r.variant, r.usda_category ?? null);
      carbCounts[cb.category] = (carbCounts[cb.category] ?? 0) + 1;
      const cm = classifyCookingMethod(r.variant);
      cookingCounts[cm] = (cookingCounts[cm] ?? 0) + 1;
    }
  }

  // 7. Per-slot patterns. Group entries by (date, slot) using ±90min grouping.
  const meals = groupIntoMeals(entries, libraryById);
  const slot_patterns = computeSlotPatterns(meals);

  // 8. Frequent combos (pairs + trios) at meal granularity.
  const frequent_combos = computeCombos(meals).slice(0, 12);

  // 9. Monotone flags.
  const monotone_flags = computeMonotoneFlags(proteinCounts, carbCounts, meals);

  return {
    generated_on: today,
    window_days: 90,
    top_items,
    protein_category_counts: proteinCounts as EatingIdentity["protein_category_counts"],
    carb_category_counts: carbCounts as EatingIdentity["carb_category_counts"],
    cooking_method_counts: cookingCounts as EatingIdentity["cooking_method_counts"],
    slot_patterns,
    frequent_combos,
    monotone_flags,
  };
}

// ── Helpers ──

type ItemRow = {
  kind: "single" | "recipe";
  canonical: string;
  variant: string;
  source: "user_library" | "db" | "llm";
  library_item_id?: string;
  usda_category?: string | null;
  qty_g: number;
  per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  eaten_at: string;
  slot: MealSlot;
  components?: Array<{ name: string; qty_g: number; per_100g: ItemRow["per_100g"] }>;
};

function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function defaultPer100g() {
  return { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
}

function collectLibraryIds(entries: Entry[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.recipe_id) ids.add(e.recipe_id);
    for (const it of e.items ?? []) {
      if (it.db_ref?.source === "user_library" && typeof it.db_ref.canonical_id === "string") {
        ids.add(it.db_ref.canonical_id);
      }
    }
  }
  return [...ids];
}

function collectDbCanonicalIds(entries: Entry[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    for (const it of e.items ?? []) {
      const ref = it.db_ref;
      if (ref?.source === "db" && typeof ref.canonical_id === "string") {
        ids.add(ref.canonical_id);
      }
    }
  }
  return [...ids];
}

async function fetchLibrary(supabase: SupabaseClient, userId: string, ids: string[]): Promise<Map<string, Recipe>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("user_food_items")
    .select("id, name, composite_of, per_100g")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw error;
  return new Map((data as Recipe[]).map((r) => [r.id, r]));
}

async function fetchUsdaCategories(supabase: SupabaseClient, canonicalIds: string[]): Promise<Map<string, string>> {
  if (canonicalIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("food_db_cache")
    .select("canonical_id, raw_payload")
    .in("canonical_id", canonicalIds);
  if (error) throw error;
  const m = new Map<string, string>();
  for (const r of (data as Array<{ canonical_id: string; raw_payload: Record<string, unknown> | null }>) ?? []) {
    const cat = (r.raw_payload as { foodCategory?: { description?: string } } | null)?.foodCategory?.description;
    if (typeof cat === "string") m.set(r.canonical_id, cat);
  }
  return m;
}

function emptyRecord<K extends string>(): Record<K, number> {
  return {} as Record<K, number>;
}

type Meal = {
  date: string;
  slot: MealSlot;
  items: Array<{ canonical: string; qty_g: number }>;
};

function groupIntoMeals(entries: Entry[], libraryById: Map<string, Recipe>): Meal[] {
  // Sort entries by eaten_at then group within (date, slot) with ±90min window.
  type E = Entry & { eaten_ts: number };
  const flat: E[] = entries.map((e) => ({ ...e, eaten_ts: Date.parse(e.eaten_at) }));
  flat.sort((a, b) => a.eaten_ts - b.eaten_ts);
  const meals: Meal[] = [];
  let bucket: { date: string; slot: MealSlot; ts: number; items: Array<{ canonical: string; qty_g: number }> } | null = null;
  for (const e of flat) {
    const date = e.eaten_at.slice(0, 10);
    const itemsCanon = (e.items ?? []).map((it) => {
      const libId = it.db_ref?.source === "user_library" ? (it.db_ref.canonical_id as string) : null;
      const libRow = libId ? libraryById.get(libId) : null;
      const name = libRow?.name ?? it.name;
      return { canonical: canonicalizeItemName(name), qty_g: it.qty_g ?? 0 };
    });
    if (bucket && bucket.date === date && bucket.slot === e.meal_slot && Math.abs(e.eaten_ts - bucket.ts) <= 90 * 60_000) {
      bucket.items.push(...itemsCanon);
    } else {
      if (bucket) meals.push({ date: bucket.date, slot: bucket.slot, items: bucket.items });
      bucket = { date, slot: e.meal_slot, ts: e.eaten_ts, items: [...itemsCanon] };
    }
  }
  if (bucket) meals.push({ date: bucket.date, slot: bucket.slot, items: bucket.items });
  return meals;
}

function computeSlotPatterns(meals: Meal[]): EatingIdentity["slot_patterns"] {
  const out: EatingIdentity["slot_patterns"] = {
    breakfast: { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
    lunch:     { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
    dinner:    { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
    snack:     { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
  };
  for (const slot of MEAL_SLOTS) {
    const inSlot = meals.filter((m) => m.slot === slot);
    const itemCounts = new Map<string, number>();
    for (const m of inSlot) for (const i of m.items) itemCounts.set(i.canonical, (itemCounts.get(i.canonical) ?? 0) + 1);
    out[slot].top_items = [...itemCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    // kcal/protein averages: best-effort from item qty_g + macros. Use 0 if no per_100g info.
    // For simplicity in v1, leave at 0 (the suggestion engine reads slot_target from getTodayTargets which is the authoritative source).
  }
  return out;
}

function computeCombos(meals: Meal[]): EatingIdentityCombo[] {
  const sigCounts = new Map<string, { items: string[]; count: number; last_seen: string; slots: MealSlot[] }>();
  const within30d = (date: string): boolean => {
    // Rolling-30d evaluated relative to the last meal's date for this composer's window
    return true; // composer's window is 90d; we filter by recency at qualifying-stage in recipe-discovery.ts
  };
  for (const m of meals) {
    const sorted = [...new Set(m.items.map((i) => i.canonical))].filter((n) => n.length > 0).sort();
    if (sorted.length < 2) continue;
    // Pairs
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = [sorted[i], sorted[j]].join("|");
        bump(sigCounts, key, [sorted[i], sorted[j]], m.date, m.slot);
      }
    }
    // Trios
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        for (let k = j + 1; k < sorted.length; k++) {
          const key = [sorted[i], sorted[j], sorted[k]].join("|");
          bump(sigCounts, key, [sorted[i], sorted[j], sorted[k]], m.date, m.slot);
        }
      }
    }
  }
  return [...sigCounts.values()]
    .filter((c) => c.count >= 2)
    .map((c) => ({
      items: c.items,
      co_occurrence_count: c.count,
      last_seen: c.last_seen,
      avg_slot: mode(c.slots),
    }))
    .sort((a, b) => b.co_occurrence_count - a.co_occurrence_count);
}

function bump(
  m: Map<string, { items: string[]; count: number; last_seen: string; slots: MealSlot[] }>,
  key: string, items: string[], date: string, slot: MealSlot,
) {
  const cur = m.get(key);
  if (cur) {
    cur.count++;
    if (date > cur.last_seen) cur.last_seen = date;
    cur.slots.push(slot);
  } else {
    m.set(key, { items, count: 1, last_seen: date, slots: [slot] });
  }
}

function mode<T extends string>(xs: T[]): T {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function computeMonotoneFlags(
  proteinCounts: Record<string, number>,
  carbCounts: Record<string, number>,
  meals: Meal[],
): EatingIdentity["monotone_flags"] {
  const totalP = Object.values(proteinCounts).reduce((s, v) => s + v, 0) || 1;
  const totalC = Object.values(carbCounts).reduce((s, v) => s + v, 0) || 1;
  const topP = Math.max(0, ...Object.values(proteinCounts));
  const topC = Math.max(0, ...Object.values(carbCounts));
  const protein_top_share = totalP > 0 ? topP / totalP : 0;
  const carb_top_share = totalC > 0 ? topC / totalC : 0;

  // most_repeated_meal: the most-frequent canonical-item-set across meals.
  const mealSigCounts = new Map<string, { items: string[]; count: number }>();
  for (const m of meals) {
    const sorted = [...new Set(m.items.map((i) => i.canonical))].filter((n) => n.length > 0).sort();
    if (sorted.length < 1) continue;
    const key = sorted.join("|");
    const cur = mealSigCounts.get(key);
    if (cur) cur.count++;
    else mealSigCounts.set(key, { items: sorted, count: 1 });
  }
  const top = [...mealSigCounts.values()].sort((a, b) => b.count - a.count)[0];
  const most_repeated_meal = top && top.count >= 3 ? { items: top.items, count: top.count } : null;

  return { protein_top_share, carb_top_share, most_repeated_meal };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors. If `classify.ts` import paths or signatures don't match, adjust the import + call sites.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/nora-suggestions/compose-eating-identity.ts
git commit -m "feat(nora): 90d eating-identity composer (top items, slot patterns, combos, monotone flags)"
```

---

### Task 7: Eating-identity cron route + audit script

**Files:**
- Create: `app/api/coach/eating-identity/sync/route.ts`
- Create: `scripts/audit-eating-identity.mjs`
- Modify: `vercel.json`

- [ ] **Step 1: Write cron route**

```ts
// app/api/coach/eating-identity/sync/route.ts
//
// Daily cron — walks profiles, recomputes EatingIdentity, writes back.
// Single-user app: profiles row count is 1. Idempotent.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { composeEatingIdentity } from "@/lib/coach/nora-suggestions/compose-eating-identity";

export const dynamic = "force-dynamic";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!auth || !secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: profiles, error } = await supabase.from("profiles").select("user_id");
  if (error) return NextResponse.json({ error: "read_failed", detail: error.message }, { status: 500 });

  const today = todayUtc();
  const results: Array<{ user_id: string; ok: boolean; error?: string }> = [];
  for (const p of profiles ?? []) {
    try {
      const payload = await composeEatingIdentity({ supabase, userId: p.user_id, today });
      const { error: upErr } = await supabase
        .from("profiles")
        .update({ eating_identity_cache: payload })
        .eq("user_id", p.user_id);
      if (upErr) throw upErr;
      results.push({ user_id: p.user_id, ok: true });
    } catch (e) {
      results.push({ user_id: p.user_id, ok: false, error: String(e) });
    }
  }
  return NextResponse.json({ today, results });
}
```

- [ ] **Step 2: Add cron entry to `vercel.json`**

Edit `vercel.json`, add to the `crons` array:

```json
{
  "path": "/api/coach/eating-identity/sync",
  "schedule": "30 3 * * *"
}
```

- [ ] **Step 3: Write audit script**

```js
// scripts/audit-eating-identity.mjs
//
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-eating-identity.mjs

import { createClient } from "@supabase/supabase-js";
import { composeEatingIdentity } from "../lib/coach/nora-suggestions/compose-eating-identity.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const today = new Date().toISOString().slice(0, 10);
const payload = await composeEatingIdentity({ supabase, userId, today });

console.log(`\n=== Eating identity for ${userId} on ${today} ===`);
console.log(`Window: ${payload.window_days}d, ${payload.top_items.length} unique items ranked\n`);

console.log("TOP 20 ITEMS:");
for (const it of payload.top_items.slice(0, 20)) {
  console.log(`  ${it.log_count.toString().padStart(3)}× ${it.canonical_name}  (${it.source}${it.library_item_id ? "/" + it.library_item_id.slice(0, 8) : ""})  qty≈${it.typical_qty_g}g  last=${it.last_logged}`);
  if (it.name_variants.length > 5) {
    console.log(`     ⚠ variants leak (${it.name_variants.length}): ${it.name_variants.slice(0, 8).join(" | ")}`);
  }
}

console.log("\nPROTEIN CATEGORY COUNTS:");
for (const [k, v] of Object.entries(payload.protein_category_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v.toFixed(1)}`);
}

console.log("\nCARB CATEGORY COUNTS:");
for (const [k, v] of Object.entries(payload.carb_category_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v.toFixed(1)}`);
}

console.log("\nTOP 10 COMBOS:");
for (const c of payload.frequent_combos.slice(0, 10)) {
  console.log(`  ${c.co_occurrence_count}×  ${c.items.join(" + ")}  (avg_slot=${c.avg_slot}, last=${c.last_seen})`);
}

console.log("\nMONOTONE FLAGS:");
console.log(`  protein_top_share: ${(payload.monotone_flags.protein_top_share * 100).toFixed(1)}%`);
console.log(`  carb_top_share:    ${(payload.monotone_flags.carb_top_share * 100).toFixed(1)}%`);
console.log(`  most_repeated_meal: ${payload.monotone_flags.most_repeated_meal ? `${payload.monotone_flags.most_repeated_meal.count}× ${payload.monotone_flags.most_repeated_meal.items.join(" + ")}` : "none"}`);

// Unknown-share sanity: any item not classified into a named protein/carb category counts.
const total = payload.top_items.reduce((s, i) => s + i.log_count, 0);
const unknownPCount = payload.protein_category_counts["unknown"] ?? 0;
const unknownCCount = payload.carb_category_counts["unknown"] ?? 0;
console.log(`\nUNKNOWN SHARE (sanity): protein=${(unknownPCount * 100 / (total || 1)).toFixed(1)}%, carb=${(unknownCCount * 100 / (total || 1)).toFixed(1)}%`);
if (unknownPCount / (total || 1) > 0.15) {
  console.log("⚠  > 15% unknown protein share — token list may need extension or library items need explicit categories (v2 follow-up).");
}
```

- [ ] **Step 4: Run audit against current data**

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-eating-identity.mjs`

Get your UUID from the profile page or via Supabase dashboard. Verify the output:
- Top items are real foods you've logged (not garbled strings).
- Variants are reasonable (e.g. ["grilled chicken breast", "chicken breast"] both under "chicken breast").
- Combos look like meals you actually eat.
- Unknown share under 15% (warning if not — note for v2).

- [ ] **Step 5: Manually trigger the cron once locally**

Run: `curl -X GET http://localhost:3000/api/coach/eating-identity/sync -H "Authorization: Bearer $CRON_SECRET"`
Expected: `{"today":"2026-05-29","results":[{"user_id":"...","ok":true}]}`

Then in Supabase Dashboard, run: `SELECT eating_identity_cache->>'generated_on' FROM profiles;` — expect today's date.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: 0 errors.

```bash
git add app/api/coach/eating-identity/sync/route.ts scripts/audit-eating-identity.mjs vercel.json
git commit -m "feat(nora): eating-identity daily cron + audit script"
```

---

## Phase 3 — Suggestion engine

### Task 8: Rationale templates

**Files:**
- Create: `lib/coach/nora-suggestions/rationale.ts`

- [ ] **Step 1: Write module**

```ts
// lib/coach/nora-suggestions/rationale.ts
//
// Deterministic template selection by dominant score factor.

import type { MealSuggestionScores, MealSlot } from "@/lib/data/types";

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
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add lib/coach/nora-suggestions/rationale.ts
git commit -m "feat(nora): deterministic rationale templates for suggestion cards"
```

---

### Task 9: Suggestion engine

**Files:**
- Create: `lib/coach/nora-suggestions/suggest-meal.ts`

- [ ] **Step 1: Write the engine**

```ts
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
  MealSlot,
  MealSuggestion,
  MealSuggestionItem,
  MealSuggestionScores,
  SuggestEngineOutput,
} from "@/lib/data/types";
import { passesExclusions } from "./exclusions";
import { renderRationale } from "./rationale";
import { createHash } from "node:crypto";

const FAMILIARITY_FLOOR = 0.5;
const VARIETY_THRESHOLD_PROTEIN_SHARE = 0.6;
const MONOTONE_PRESSURE_THRESHOLD = 0.5;
const VARIETY_BOOST_PROTEIN_LOW_SHARE = 0.2;
const SLOT_KCAL_FIT_TOL = 0.2;

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
  let candidates = [...tier1];
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
    const sig = sig(s.cand.items);
    if (seen.has(sig)) continue;
    seen.add(sig);
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
  for (const t of id.top_items) {
    const inSlot = t.slot_distribution[input.slot] ?? 0;
    if (t.source === "user_library" && t.library_item_id && inSlot >= 2 && /* recipe heuristic: has macros and isn't a single ingredient */ true) {
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
  return out.filter((c) => !existingSigs.has(sig(c.items))).slice(0, 6);
}

function generateTier3(input: SuggestMealInput, id: EatingIdentity, existing: Candidate[]): Candidate[] {
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
  cand: { items: MealSuggestionItem[]; total: MealSuggestionItem["per_100g"] & {} };
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
  let variety_boost = 0;
  if (id.monotone_flags.protein_top_share > MONOTONE_PRESSURE_THRESHOLD) {
    // proxy: assume cand.items[0] is the protein. Look up its protein category from word-list classify.
    // We don't re-import here for cycle reasons — use a coarse name check.
    const candFirstName = cand.items[0]?.name ?? "";
    const head = id.top_items.find((t) => t.canonical_name === candFirstName);
    const cat = head ? bestProteinCategoryForItem(candFirstName, id) : null;
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

function sumMacros(items: MealSuggestionItem[]) {
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
  return {
    name: t.canonical_name,
    qty_g: t.typical_qty_g,
    per_100g: t.macros_per_100g,
    library_item_id: t.library_item_id,
  };
}

function comboToItems(canonicalNames: string[], id: EatingIdentity): MealSuggestionItem[] {
  return canonicalNames.map((n) => itemFor(n, id));
}

function topItemsOfKind(id: EatingIdentity, slot: MealSlot, kind: "protein" | "carb" | "side"): string[] {
  // Filter id.top_items by slot presence (slot_distribution[slot] > 0) and rank.
  // Kind classification at this layer uses a name token check inline so we don't
  // re-fetch USDA categories here.
  const candidates = id.top_items
    .filter((t) => (t.slot_distribution[slot] ?? 0) > 0)
    .sort((a, b) => b.log_count - a.log_count);
  const PROTEIN_RE = /\b(chicken|turkey|beef|lamb|pork|fish|salmon|tuna|sardines?|eggs?|tofu|tempeh|cottage cheese|yog(h)?urt|whey|greek yogurt|lentils?|chickpeas?)\b/i;
  const CARB_RE = /\b(rice|pasta|bread|oats?|oatmeal|potato|sweet potato|quinoa|couscous|tortilla|wrap|bagel|noodles?)\b/i;
  const filtered = candidates.filter((t) => {
    if (kind === "protein") return PROTEIN_RE.test(t.canonical_name);
    if (kind === "carb") return CARB_RE.test(t.canonical_name);
    return !PROTEIN_RE.test(t.canonical_name) && !CARB_RE.test(t.canonical_name);
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

function bestProteinCategoryForItem(name: string, id: EatingIdentity): keyof EatingIdentity["protein_category_counts"] | null {
  const lower = name.toLowerCase();
  if (/(chicken|turkey|beef|lamb|pork)/.test(lower)) return "meat_protein" as keyof EatingIdentity["protein_category_counts"];
  if (/(fish|salmon|tuna|sardine)/.test(lower)) return "fish_protein" as keyof EatingIdentity["protein_category_counts"];
  if (/eggs?/.test(lower)) return "eggs" as keyof EatingIdentity["protein_category_counts"];
  if (/(milk|cheese|yog|whey)/.test(lower)) return "dairy_protein" as keyof EatingIdentity["protein_category_counts"];
  if (/(tofu|tempeh|lentil|chickpea|bean)/.test(lower)) return "plant_protein" as keyof EatingIdentity["protein_category_counts"];
  return null;
}

function topProteinName(id: EatingIdentity): string | null {
  for (const t of id.top_items) {
    if (/(chicken|turkey|beef|lamb|pork|fish|salmon|tuna|eggs?|tofu|tempeh)/.test(t.canonical_name.toLowerCase())) {
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
```

The `ProteinCategory` literal strings used in `bestProteinCategoryForItem` must match what `classify.ts` actually emits. If they don't (e.g. `classify.ts` uses different names), adjust to the actual literal values from `lib/coach/nutrition-intelligence/word-lists.ts`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors. Fix any type mismatch against `EatingIdentity` / `MealSuggestion` from Task 1.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/nora-suggestions/suggest-meal.ts
git commit -m "feat(nora): suggestion engine (3-tier candidates, exclusion filter, score = macro×fam×variety×slot)"
```

---

### Task 10: Suggest-meal audit script

**Files:**
- Create: `scripts/audit-suggest-meal.mjs`

- [ ] **Step 1: Write audit**

```js
// scripts/audit-suggest-meal.mjs
//
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-suggest-meal.mjs

import { createClient } from "@supabase/supabase-js";
import { suggestMeal } from "../lib/coach/nora-suggestions/suggest-meal.ts";
import { passesExclusions } from "../lib/coach/nora-suggestions/exclusions.ts";
import { getTodayTargets } from "../lib/morning/brief/get-today-targets.ts";
import { targetsForAllSlots, DEFAULT_MEAL_RATIOS } from "../lib/food/meal-targets.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: row } = await supabase
  .from("profiles")
  .select("eating_identity_cache, dietary_exclusions")
  .eq("user_id", userId)
  .single();

if (!row?.eating_identity_cache) {
  console.error("No eating_identity_cache — run /api/coach/eating-identity/sync first.");
  process.exit(1);
}

const targets = await getTodayTargets(supabase, userId);
const slotTargetsAll = targets ? targetsForAllSlots(targets.kcal, targets.protein_g, targets.carbs_g, targets.fat_g, targets.meal_ratios ?? DEFAULT_MEAL_RATIOS) : null;

const remainingMacros = { kcal: targets?.kcal ?? 2400, protein_g: targets?.protein_g ?? 180, carbs_g: targets?.carbs_g ?? 240, fat_g: targets?.fat_g ?? 70 };

for (const slot of ["breakfast", "lunch", "dinner", "snack"]) {
  console.log(`\n=== Slot: ${slot} ===`);
  const out = suggestMeal({
    slot,
    count: 5,
    eatingIdentity: row.eating_identity_cache,
    exclusions: row.dietary_exclusions ?? { tags: [], free_text: null, version: 1 },
    remainingMacros,
    slotTargets: slotTargetsAll?.[slot] ?? { kcal: 600, protein_g: 45 },
    preferNovelty: false,
  });
  console.log(`tier1_candidates=${out.filter_stats.tier1_candidates}  after_exclusion=${out.filter_stats.after_exclusion}  surfaced=${out.filter_stats.surfaced}`);
  if (out.error) { console.log(`⚠ error=${out.error}`); continue; }

  // INVARIANT: every surfaced item passes the exclusion filter.
  for (const s of out.suggestions) {
    const ok = passesExclusions(s.items.map((i) => ({ name: i.name })), (row.dietary_exclusions?.tags ?? []));
    if (!ok) {
      console.error(`❌ EXCLUSION LEAK: rank=${s.rank} items=${s.items.map((i) => i.name).join(", ")}`);
      process.exit(1);
    }
  }

  // INVARIANT: tier1 saturation when no variety pressure.
  if ((row.eating_identity_cache.monotone_flags.protein_top_share ?? 0) < 0.6) {
    if (out.filter_stats.tier1_candidates < out.filter_stats.surfaced && out.filter_stats.tier1_candidates > 0) {
      console.error(`⚠ tier1 under-served when no variety pressure: t1=${out.filter_stats.tier1_candidates}, surfaced=${out.filter_stats.surfaced}`);
    }
  }

  for (const s of out.suggestions) {
    console.log(`  #${s.rank} [${s.source}]  ${s.items.map((i) => `${i.name} ${i.qty_g}g`).join(" + ")}`);
    console.log(`     macros: ${Math.round(s.total_macros.kcal)}kcal ${Math.round(s.total_macros.protein_g)}P ${Math.round(s.total_macros.carbs_g)}C ${Math.round(s.total_macros.fat_g)}F`);
    console.log(`     scores: macro=${s.scores.macro_fit.toFixed(2)} fam=${s.scores.familiarity.toFixed(2)} variety=${s.scores.variety_boost.toFixed(2)} slot=${s.scores.slot_fit.toFixed(2)} final=${s.scores.final.toFixed(3)}`);
    console.log(`     rationale: ${s.rationale}`);
  }
}
```

- [ ] **Step 2: Run audit**

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-suggest-meal.mjs`
Expected: per-slot suggestions with score breakdowns. No "EXCLUSION LEAK" errors. Inspect output for sanity.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-suggest-meal.mjs
git commit -m "test(nora): audit script for suggestion engine — exclusion + tier-1 invariants"
```

---

## Phase 4 — Tool wiring + card UI + prompt updates + injection

### Task 11: propose_meal_suggestions tool schema + handler

**Files:**
- Modify: `lib/coach/tools.ts` — add schema, handler, NORA_TOOLS entry

- [ ] **Step 1: Locate the tool schema region**

Open `lib/coach/tools.ts`. Find where the existing meal-log tools (`PROPOSE_MEAL_LOG_TOOL`, `COMMIT_MEAL_LOG_TOOL`) are declared. The new tool schema goes adjacent to them.

- [ ] **Step 2: Add the tool schema**

Insert near the meal-log tool block:

```ts
const PROPOSE_MEAL_SUGGESTIONS_TOOL: ToolSchema = {
  name: "propose_meal_suggestions",
  description:
    "Generate 2-3 meal options for a slot, grounded in the athlete's 90-day eating identity, with hard dietary exclusions enforced. Each option is one-tap loggable via pre-issued HMAC approval token. Use when the athlete asks 'what should I have for X', 'alternatives to Y', or 'I'm bored of Z' — never improvise meal names in prose.",
  input_schema: {
    type: "object",
    properties: {
      slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
      count: { type: "number", minimum: 2, maximum: 4, default: 3 },
      prefer_novelty: { type: "boolean", default: false },
    },
    required: ["slot"],
  },
};
```

- [ ] **Step 3: Add the handler**

Find the tool-execution switch (search for `case "propose_meal_log":` to anchor). Add a new case adjacent:

```ts
case "propose_meal_suggestions": {
  const { slot, count = 3, prefer_novelty = false } = input as { slot: MealSlot; count?: number; prefer_novelty?: boolean };

  // 1. Load eating identity (rebuild if stale).
  const { data: prof } = await ctx.supabase
    .from("profiles")
    .select("eating_identity_cache, dietary_exclusions")
    .eq("user_id", ctx.userId)
    .single();
  let identity = prof?.eating_identity_cache as EatingIdentity | null;
  const today = new Date().toISOString().slice(0, 10);
  const staleMs = identity?.generated_on
    ? Date.now() - new Date(identity.generated_on).getTime()
    : Infinity;
  if (!identity || staleMs > 48 * 3600_000) {
    identity = await composeEatingIdentity({ supabase: ctx.supabase, userId: ctx.userId, today });
    await ctx.supabase.from("profiles").update({ eating_identity_cache: identity }).eq("user_id", ctx.userId);
  }

  // 2. Compute remaining macros for today.
  const targets = await getTodayTargets(ctx.supabase, ctx.userId);
  const { data: todayEntries } = await ctx.supabase
    .from("food_log_entries")
    .select("totals")
    .eq("user_id", ctx.userId)
    .eq("status", "committed")
    .gte("eaten_at", `${today}T00:00:00Z`)
    .lte("eaten_at", `${today}T23:59:59Z`);
  const totals = (todayEntries ?? []).reduce(
    (acc, r: any) => ({
      kcal: acc.kcal + (r.totals?.kcal ?? 0),
      protein_g: acc.protein_g + (r.totals?.protein_g ?? 0),
      carbs_g: acc.carbs_g + (r.totals?.carbs_g ?? 0),
      fat_g: acc.fat_g + (r.totals?.fat_g ?? 0),
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
  const remainingMacros = {
    kcal: Math.max(0, (targets?.kcal ?? 2400) - totals.kcal),
    protein_g: Math.max(0, (targets?.protein_g ?? 180) - totals.protein_g),
    carbs_g: Math.max(0, (targets?.carbs_g ?? 240) - totals.carbs_g),
    fat_g: Math.max(0, (targets?.fat_g ?? 70) - totals.fat_g),
  };

  const slotTargetsAll = targets
    ? targetsForAllSlots(targets.kcal, targets.protein_g, targets.carbs_g, targets.fat_g, targets.meal_ratios ?? DEFAULT_MEAL_RATIOS)
    : null;
  const slotTargets = slotTargetsAll?.[slot] ?? { kcal: 600, protein_g: 45 };

  // 3. Look up newly-saved recipe-discovery recipes for tight loop (§9.6 spec).
  const { data: recentRecipes } = await ctx.supabase
    .from("user_food_items")
    .select("id, metadata, created_at")
    .eq("user_id", ctx.userId)
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
  const newRecipeBoosts = ((recentRecipes ?? []) as Array<{ id: string; metadata: any }>)
    .filter((r) => r.metadata?.source === "recipe_discovery")
    .map((r) => ({ library_item_id: r.id, weight: 0.15 }));

  // 4. Call the engine.
  const out = suggestMeal({
    slot,
    count,
    eatingIdentity: identity,
    exclusions: prof?.dietary_exclusions ?? { tags: [], free_text: null, version: 1 },
    remainingMacros,
    slotTargets,
    preferNovelty: prefer_novelty,
    newRecipeBoosts,
  });

  if (out.error) {
    return { ok: false, error: out.error, context: out.context };
  }

  // 5. Mint HMAC approval token per surfaced suggestion.
  const eatenAtIso = new Date().toISOString();
  const tokens = await Promise.all(
    out.suggestions.map((s) =>
      signApprovalToken({
        userId: ctx.userId,
        action: "meal_log",
        payload: {
          items: s.items.map((i) => ({ name: i.name, qty_g: i.qty_g, per_100g: i.per_100g, library_item_id: i.library_item_id ?? null })),
          meal_slot: slot,
          eaten_at: eatenAtIso,
        },
      }),
    ),
  );

  return {
    ok: true,
    suggestions: out.suggestions,
    tokens,
    context: out.context,
    filter_stats: out.filter_stats,
  };
}
```

Add the imports at the top of `lib/coach/tools.ts` (only if not already imported):

```ts
import { composeEatingIdentity } from "@/lib/coach/nora-suggestions/compose-eating-identity";
import { suggestMeal } from "@/lib/coach/nora-suggestions/suggest-meal";
import { signApprovalToken } from "@/lib/coach/approval-token";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
import { targetsForAllSlots, DEFAULT_MEAL_RATIOS } from "@/lib/food/meal-targets";
import type { EatingIdentity, MealSlot } from "@/lib/data/types";
```

- [ ] **Step 4: Add to `NORA_TOOLS`**

Edit the NORA_TOOLS array at the end of the file:

```ts
export const NORA_TOOLS: readonly ToolSchema[] = [
  FOOD_LOG_TOOL,
  DAILY_LOGS_TOOL,
  PROPOSE_NUTRITION_TARGETS_TOOL,
  COMMIT_NUTRITION_TARGETS_TOOL,
  APPLY_MACROS_CORRECTION_TOOL,
  APPLY_PROTEIN_CORRECTION_TOOL,
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  SEARCH_LIBRARY_TOOL,
  PICK_LIBRARY_ITEM_TOOL,
  SAVE_TO_LIBRARY_TOOL,
  RESOLVE_FOOD_MACROS_TOOL,
  PROPOSE_MEAL_LOG_TOOL,
  COMMIT_MEAL_LOG_TOOL,
  PROPOSE_MEAL_SUGGESTIONS_TOOL,
];
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors. Most likely fixes: signApprovalToken signature mismatch (verify against `lib/coach/approval-token.ts:87`), or `getTodayTargets` return shape.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(nora): propose_meal_suggestions tool — engine call + HMAC token mint"
```

---

### Task 12: Wire chat-stream landmines (PERSIST_RESULT_TOOLS + modeAllowsTool)

**Files:**
- Modify: `lib/coach/chat-stream.ts`

- [ ] **Step 1: Add to PERSIST_RESULT_TOOLS**

Edit `lib/coach/chat-stream.ts` around line 84-109. Add the new tool to the Set:

```ts
const PERSIST_RESULT_TOOLS = new Set([
  "propose_block",
  "commit_block",
  // ... existing entries unchanged ...
  "propose_meal_log",
  "commit_meal_log",
  "propose_meal_suggestions",   // ← new
]);
```

- [ ] **Step 2: Add to modeAllowsTool default-mode allowlist**

Edit `lib/coach/chat-stream.ts` around line 327-330. Add the explicit allow before the `propose_` prefix guard:

```ts
    if (name === "propose_nutrition_targets") return true;
    if (name === "commit_nutrition_targets") return true;
    if (name === "propose_meal_log") return true;
    if (name === "commit_meal_log") return true;
    if (name === "propose_meal_suggestions") return true;   // ← new
    if (name === "propose_session_today") return true;
    if (name === "commit_session_today") return true;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Manual verification — ask Nora in dev**

Run: `npm run dev`. Open `http://localhost:3000/coach`. Ask Nora: "What should I have for dinner?"

Expected (from logs / Anthropic call):
- Nora calls `propose_meal_suggestions({ slot: "dinner" })`.
- Tool returns `ok: true, suggestions: [...]`.
- Reply renders with the suggestion card placeholder text (the actual MealSuggestionsCard component comes in the next task — for now you may see raw JSON or a "tool result received" stub).

If the tool isn't called and Nora narrates in prose, check:
- `modeAllowsTool` returns true for the name (Step 2).
- `NORA_TOOLS` includes the schema (Task 11 Step 4).
- The NORA_BASE prompt update (next task) is essential — until Task 13 lands, Nora may not know to call the tool.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "feat(nora): chat-stream wiring for propose_meal_suggestions (persist + allow)"
```

---

### Task 13: NORA_BASE prompt additions

**Files:**
- Modify: `lib/coach/system-prompts.ts`

- [ ] **Step 1: Append three new sections to NORA_BASE**

Open `lib/coach/system-prompts.ts`. Find `export const NORA_BASE = `…``. Append the following three blocks BEFORE the closing backtick + voice line. They should appear after the existing "Library + meal-log workflow" section and before the "Confidentiality" section:

```
## Eating identity (in your context)

The "Eating identity" block above is a 90-day rollup: which proteins/carbs/cooking
methods the athlete actually eats, their top items, monotone flags, and structured
exclusions. Reference identity facts directly ("you log chicken 5/7 of last week",
"your top breakfast item is overnight oats") without calling query_food_log first.
For deeper "what did I eat on date X" questions, query_food_log is still the source.

## Suggestion flow

When the athlete asks for ideas ("what should I have for dinner", "alternatives to
chicken", "I'm bored of my breakfasts"), call propose_meal_suggestions immediately.
Do not improvise meal names in prose — the engine is what knows the athlete's
repertoire and respects their exclusions.

- "what should I have for {slot}" → propose_meal_suggestions({ slot, count: 3 })
- "different ideas" / "give me variety" → add prefer_novelty: true
- "I'm bored" without a slot → ask which slot, then call
- After the tool returns, one framing sentence is enough — the card shows the options.
  Name the dominant rationale (slot fit / variety / macro fit) and let the card speak.
- If the engine returns exclusions_exhausted, surface it concisely with ONE specific
  relaxation offer ("relax pork for this meal?") — don't recite the full tag list.

NEVER suggest a meal in prose if propose_meal_suggestions would have served the same
request. Prose-only suggestions are non-loggable — every accepted suggestion should be
one tap to log.

## Hard exclusions

dietary_exclusions.tags are structured hard-NOs. The engine enforces them in cards;
YOU never propose an excluded food in prose either. If the athlete explicitly asks
about an excluded food ("can I eat shrimp once?"), defer the decision to them — do
not unilaterally relax. The free_text field captures nuance ("no raw fish") and is
in your context — avoid violating it in prose too.
```

- [ ] **Step 2: Verify Nora's voice line still closes the template**

The string should still end with the existing "Your voice: warm but technical..." sentence followed by the backtick. The three new sections insert before that.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(nora): prompt — eating identity, suggestion flow, hard exclusions sections"
```

---

### Task 14: Snapshot-prefix injection for Nora

**Files:**
- Create: `lib/coach/nora-suggestions/render-injection.ts`
- Modify: `app/api/chat/messages/route.ts` — load + thread the block for Nora turns

- [ ] **Step 1: Write the render-injection helper**

```ts
// lib/coach/nora-suggestions/render-injection.ts
//
// Renders the "Eating identity" markdown block for Nora's system prompt.
// Compact (~25 lines): top-10 items, category counts, monotone flags,
// dietary exclusions. Verbose fields (frequent_combos, slot_patterns)
// stay in the engine — too much to thread into every Nora turn.

import type { EatingIdentity, DietaryExclusions } from "@/lib/data/types";

export function renderEatingIdentityBlock(
  identity: EatingIdentity | null,
  exclusions: DietaryExclusions,
): string {
  const lines: string[] = ["# Eating identity"];

  if (!identity) {
    lines.push("");
    lines.push("Not yet generated — athlete has logged too few meals or sync hasn't run.");
    appendExclusions(lines, exclusions);
    return lines.join("\n");
  }

  lines.push(`Generated ${identity.generated_on}, ${identity.window_days}-day window.`);
  lines.push("");

  lines.push("## Top 10 items (by log count)");
  for (const t of identity.top_items.slice(0, 10)) {
    const slots = Object.entries(t.slot_distribution).filter(([, n]) => n > 0).map(([s, n]) => `${s[0]}${n}`).join("/");
    lines.push(`- ${t.canonical_name}  (×${t.log_count}, ${slots})  qty≈${Math.round(t.typical_qty_g)}g`);
  }
  lines.push("");

  lines.push("## Protein categories (count)");
  for (const [k, v] of Object.entries(identity.protein_category_counts).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    lines.push(`- ${k}: ${v.toFixed(1)}`);
  }
  lines.push("");

  lines.push("## Carb categories (count)");
  for (const [k, v] of Object.entries(identity.carb_category_counts).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    lines.push(`- ${k}: ${v.toFixed(1)}`);
  }
  lines.push("");

  lines.push("## Monotone flags");
  lines.push(`- protein_top_share: ${(identity.monotone_flags.protein_top_share * 100).toFixed(0)}%`);
  lines.push(`- carb_top_share: ${(identity.monotone_flags.carb_top_share * 100).toFixed(0)}%`);
  if (identity.monotone_flags.most_repeated_meal) {
    lines.push(`- most_repeated_meal: ${identity.monotone_flags.most_repeated_meal.count}× ${identity.monotone_flags.most_repeated_meal.items.join(" + ")}`);
  }
  lines.push("");

  appendExclusions(lines, exclusions);
  return lines.join("\n");
}

function appendExclusions(lines: string[], exclusions: DietaryExclusions): void {
  lines.push("## Dietary exclusions");
  if (exclusions.tags.length === 0 && !exclusions.free_text) {
    lines.push("- none");
  } else {
    if (exclusions.tags.length > 0) lines.push(`- tags: ${exclusions.tags.join(", ")}`);
    if (exclusions.free_text) lines.push(`- notes: ${exclusions.free_text}`);
  }
}
```

- [ ] **Step 2: Thread the block into Nora-routed turns**

Open `app/api/chat/messages/route.ts`. Find where the system prompt or context is assembled for the chat stream — most likely near the `runChatStream` call. Search for an existing injection pattern like `peterDashboardBlock` or `peterContext`. The Nora injection should mirror that pattern:

```ts
// Near the top of the route handler, after speaker is resolved:
import { renderEatingIdentityBlock } from "@/lib/coach/nora-suggestions/render-injection";

// Then where context blocks are assembled:
let noraIdentityBlock: string | undefined;
if (speaker === "nora") {
  const { data: prof } = await supabase
    .from("profiles")
    .select("eating_identity_cache, dietary_exclusions")
    .eq("user_id", user.id)
    .single();
  noraIdentityBlock = renderEatingIdentityBlock(
    prof?.eating_identity_cache ?? null,
    prof?.dietary_exclusions ?? { tags: [], free_text: null, version: 1 },
  );
}

// Pass noraIdentityBlock to runChatStream alongside peterDashboardBlock etc.
// The exact param name depends on how runChatStream is structured — match its
// existing pattern (e.g., it may already accept an `additionalContext` map).
```

If `runChatStream` doesn't have a slot for this, add one: an optional `noraIdentityBlock?: string` parameter that gets appended to the system prompt after the snapshot prefix for nora-routed turns.

- [ ] **Step 3: Verify in dev**

Run: `npm run dev`. Send a message to Nora. Check the server logs / Anthropic request payload (you may need a `console.log` in `runChatStream` temporarily) to verify the "# Eating identity" block is present in Nora's system prompt.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add lib/coach/nora-suggestions/render-injection.ts app/api/chat/messages/route.ts
git commit -m "feat(nora): inject 90d eating-identity block into Nora's system prompt"
```

---

### Task 15: MealSuggestionsCard component + ChatThread dispatcher

**Files:**
- Create: `components/chat/MealSuggestionsCard.tsx`
- Modify: `components/chat/ChatThread.tsx` — add dispatcher case

- [ ] **Step 1: Write the card component**

```tsx
// components/chat/MealSuggestionsCard.tsx
"use client";

import { useState } from "react";
import type { MealSuggestion, MealSlot } from "@/lib/data/types";

type Props = {
  suggestions: MealSuggestion[];
  tokens: string[];                                  // length === suggestions.length
  context: {
    slot_target: { kcal: number; protein_g: number };
    remaining_macros_for_day: { kcal: number; protein_g: number };
    monotone_signal: { protein_top: string; share: number } | null;
  };
  slot: MealSlot;
  error?: "exclusions_exhausted" | "no_history";
  onSubmitText: (text: string) => void;              // host-supplied; types into chat input
  onOpenTweak: (items: MealSuggestion["items"], slot: MealSlot) => void;
};

export function MealSuggestionsCard({ suggestions, tokens, context, slot, error, onSubmitText, onOpenTweak }: Props) {
  const [pending, setPending] = useState<number | null>(null);

  if (error === "exclusions_exhausted") {
    return (
      <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4 text-sm text-amber-100">
        <div className="font-medium">No clean fit</div>
        <p className="mt-1 text-amber-200/80">
          With your current exclusions and remaining macros, I don't have a meal that works. Want to relax one tag for this meal, or aim for a lighter snack first?
        </p>
      </div>
    );
  }

  if (error === "no_history" || suggestions.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-200">
        I don't have enough log history yet to suggest from your repertoire. Log a few more meals and I'll be able to offer real options.
      </div>
    );
  }

  const submitApprove = async (idx: number) => {
    const token = tokens[idx];
    if (!token) return;
    setPending(idx);
    try {
      onSubmitText(`[approve:${token}]`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Suggestions for {slot}</h3>
        <span className="text-xs text-neutral-400">
          Slot target ≈ {Math.round(context.slot_target.kcal)} kcal
        </span>
      </div>

      <ol className="space-y-2">
        {suggestions.map((s, idx) => (
          <li key={s.rank} className="rounded-lg border border-neutral-700 bg-neutral-900 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm font-medium">
                  {s.items.map((i) => i.name).join(" + ")}
                </div>
                <div className="mt-1 text-xs text-neutral-300">
                  {Math.round(s.total_macros.kcal)} kcal · {Math.round(s.total_macros.protein_g)}P {Math.round(s.total_macros.carbs_g)}C {Math.round(s.total_macros.fat_g)}F
                  {s.total_macros.fiber_g > 0 ? ` · fiber ${s.total_macros.fiber_g.toFixed(1)}g` : ""}
                </div>
                <div className="mt-1 text-xs italic text-neutral-400">{s.rationale}</div>
              </div>
              <div className="flex flex-shrink-0 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => submitApprove(idx)}
                  disabled={pending !== null}
                  className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                >
                  {pending === idx ? "Logging…" : "Log this"}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenTweak(s.items, slot)}
                  className="rounded-md border border-neutral-600 px-3 py-1 text-xs text-neutral-200"
                >
                  Tweak
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={() => onSubmitText("different ideas, please")}
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300"
      >
        Show different ideas
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add dispatcher case in ChatThread.tsx**

Open `components/chat/ChatThread.tsx`. Find the existing tool-result-to-component dispatcher (search for `renderToolReceiptChip` or for cases handling `propose_meal_log` / `save_to_library`). Add a case for `propose_meal_suggestions`:

```tsx
import { MealSuggestionsCard } from "./MealSuggestionsCard";

// inside the dispatcher switch / if-chain:
if (toolName === "propose_meal_suggestions" && result?.ok === true) {
  return (
    <MealSuggestionsCard
      suggestions={result.suggestions}
      tokens={result.tokens}
      context={result.context}
      slot={inputFromCall.slot}
      onSubmitText={(text) => submitMessage(text)}     // existing helper
      onOpenTweak={(items, slot) => openMealLoggerSheet({ prefill: { items, slot } })}  // existing helper or stub
    />
  );
}

if (toolName === "propose_meal_suggestions" && result?.ok === false) {
  return (
    <MealSuggestionsCard
      suggestions={[]}
      tokens={[]}
      context={result.context ?? { slot_target: { kcal: 0, protein_g: 0 }, remaining_macros_for_day: { kcal: 0, protein_g: 0 }, monotone_signal: null }}
      slot={inputFromCall.slot}
      error={result.error}
      onSubmitText={(text) => submitMessage(text)}
      onOpenTweak={() => {}}
    />
  );
}
```

The exact `submitMessage` / `openMealLoggerSheet` helper names depend on `ChatThread.tsx`'s existing shape — adapt to the actual prop drilling pattern used for `propose_meal_log`'s Approve chip (that case is the closest precedent).

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. On `/coach`, ask Nora: "What should I have for dinner?"

Expected:
- Card renders with 2-3 suggestions, each showing name, macros, rationale, [Log] [Tweak] buttons.
- Tap [Log] on option 1 → submits `[approve:<token>]` → backend short-circuits to `commit_meal_log` → entry appears on `/diet?view=journal` for today's dinner slot.
- Tap [Tweak] on option 2 → MealLoggerSheet opens with the items pre-filled.
- Tap [Show different ideas] → submits "different ideas, please" → Nora calls `propose_meal_suggestions` with `prefer_novelty: true` → new card replaces old behavior.

If a Log tap doesn't write, check:
- Token validity (chat-stream's short-circuit only fires on EXACT message shape `[approve:<token>]`).
- HMAC token's payload binding matches what `commit_meal_log` expects.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add components/chat/MealSuggestionsCard.tsx components/chat/ChatThread.tsx
git commit -m "feat(chat): meal-suggestions card with one-tap log + tweak"
```

---

## Phase 5 — Recipe discovery

### Task 16: Recipe-discovery composer + nudge variant

**Files:**
- Create: `lib/coach/nora-suggestions/recipe-discovery.ts`
- Modify: existing `ProactiveNudgeCard` payload union (find via grep) — add `save_recipe` variant
- Modify: `components/chat/ProactiveNudgeCard.tsx` — render branch

- [ ] **Step 1: Find the proactive-nudge payload union**

Run: `grep -nE "ProactiveNudgeCard|kind.*plateau|kind.*hrv" lib/data/types.ts lib/coach/proactive/render-card.ts | head -20`

Locate the discriminated union definition (likely in `lib/data/types.ts` or `lib/coach/proactive/types.ts`).

- [ ] **Step 2: Extend payload union with save_recipe variant**

Add to the union (file location per Step 1):

```ts
// Add to the discriminated union ProactiveNudgeCard:
| {
    kind: "save_recipe";
    combo_signature: string;
    items: Array<{ name: string; qty_g: number; per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number } }>;
    suggested_name: string;
    co_occurrence_count: number;
    last_seen: string;
    avg_slot: "breakfast" | "lunch" | "dinner" | "snack";
    per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  }
```

- [ ] **Step 3: Write the discovery composer**

```ts
// lib/coach/nora-suggestions/recipe-discovery.ts
//
// Reads eating_identity_cache.frequent_combos, applies the qualifying filter
// (≥4 in last 30d, ≤14d last_seen, no recipe overlap, no library-recipe member),
// applies dedup against proactive_nudge_dedup. Returns at most one nudge per call.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EatingIdentity, EatingIdentityCombo, MealSlot } from "@/lib/data/types";
import { createHash } from "node:crypto";

const QUALIFY_MIN_COUNT = 4;
const RECENCY_DAYS = 14;
const RATE_LIMIT_WINDOW_DAYS = 30;
const RATE_LIMIT_MAX = 3;

export type SaveRecipeCandidate = {
  combo_signature: string;
  items: Array<{ name: string; qty_g: number; per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number } }>;
  suggested_name: string;
  co_occurrence_count: number;
  last_seen: string;
  avg_slot: MealSlot;
  per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
};

const SLOT_MEAL_WORD: Record<MealSlot, string> = {
  breakfast: "plate", lunch: "bowl", dinner: "bowl", snack: "bite",
};

export function comboSignature(canonicalNames: string[]): string {
  return createHash("sha1").update([...canonicalNames].sort().join("|")).digest("hex").slice(0, 12);
}

export async function pickDiscoveryCandidate(args: {
  supabase: SupabaseClient;
  userId: string;
  identity: EatingIdentity;
  today: string;
}): Promise<SaveRecipeCandidate | null> {
  const { supabase, userId, identity, today } = args;

  // 1. Filter combos by threshold + recency.
  const recencyCutoff = shiftDays(today, -RECENCY_DAYS);
  const qualifying = identity.frequent_combos.filter(
    (c) => c.co_occurrence_count >= QUALIFY_MIN_COUNT && c.last_seen >= recencyCutoff,
  );
  if (qualifying.length === 0) return null;

  // 2. Drop combos that overlap an existing recipe (≥2 shared canonical items).
  const { data: libRecipes } = await supabase
    .from("user_food_items")
    .select("composite_of")
    .eq("user_id", userId)
    .not("composite_of", "is", null);
  const recipeItemSets = ((libRecipes ?? []) as Array<{ composite_of: Array<{ name: string }> | null }>)
    .map((r) => new Set((r.composite_of ?? []).map((c) => c.name.toLowerCase())));

  const overlapsExisting = (combo: EatingIdentityCombo): boolean => {
    const candSet = new Set(combo.items.map((i) => i.toLowerCase()));
    for (const recipeSet of recipeItemSets) {
      let shared = 0;
      for (const n of candSet) if (recipeSet.has(n)) shared++;
      if (shared >= 2) return true;
    }
    return false;
  };

  const noOverlap = qualifying.filter((c) => !overlapsExisting(c));
  if (noOverlap.length === 0) return null;

  // 3. Drop combos whose any member is itself a library recipe.
  const { data: libRecipeNames } = await supabase
    .from("user_food_items")
    .select("name")
    .eq("user_id", userId)
    .not("composite_of", "is", null);
  const recipeNameSet = new Set(((libRecipeNames ?? []) as Array<{ name: string }>).map((r) => r.name.toLowerCase()));
  const noRecipeMember = noOverlap.filter((c) => !c.items.some((i) => recipeNameSet.has(i.toLowerCase())));
  if (noRecipeMember.length === 0) return null;

  // 4. Dedup vs proactive_nudge_dedup + 30d rate limit.
  const sigsSorted = noRecipeMember
    .sort((a, b) => b.co_occurrence_count - a.co_occurrence_count)
    .map((c) => ({ combo: c, sig: comboSignature(c.items) }));

  const rateCutoff = shiftDays(today, -RATE_LIMIT_WINDOW_DAYS);
  const { data: dedupRows } = await supabase
    .from("proactive_nudge_dedup")
    .select("trigger_key, fired_on")
    .eq("user_id", userId)
    .like("trigger_key", "save_recipe:%")
    .gte("fired_on", rateCutoff);
  const consumed = ((dedupRows ?? []) as Array<{ trigger_key: string; fired_on: string }>).length;
  if (consumed >= RATE_LIMIT_MAX) return null;
  const blockedKeys = new Set(((dedupRows ?? []) as Array<{ trigger_key: string }>).map((r) => r.trigger_key));

  const winner = sigsSorted.find(({ sig }) => !blockedKeys.has(`save_recipe:${sig}`));
  if (!winner) return null;

  // 5. Resolve item qty + macros for the card.
  const itemsResolved = winner.combo.items.map((canon) => {
    const top = identity.top_items.find((t) => t.canonical_name === canon);
    return {
      name: canon,
      qty_g: top?.typical_qty_g ?? 100,
      per_100g: top?.macros_per_100g ?? { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    };
  });
  const totalQty = itemsResolved.reduce((s, i) => s + i.qty_g, 0) || 1;
  const totals = itemsResolved.reduce(
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
  const per_100g = {
    kcal: (totals.kcal / totalQty) * 100,
    protein_g: (totals.protein_g / totalQty) * 100,
    carbs_g: (totals.carbs_g / totalQty) * 100,
    fat_g: (totals.fat_g / totalQty) * 100,
    fiber_g: (totals.fiber_g / totalQty) * 100,
  };

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const suggested_name = `${cap(winner.combo.avg_slot)} ${SLOT_MEAL_WORD[winner.combo.avg_slot]}`;

  return {
    combo_signature: winner.sig,
    items: itemsResolved,
    suggested_name,
    co_occurrence_count: winner.combo.co_occurrence_count,
    last_seen: winner.combo.last_seen,
    avg_slot: winner.combo.avg_slot,
    per_100g,
  };
}

function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Extend ProactiveNudgeCard component with render branch**

Open `components/chat/ProactiveNudgeCard.tsx`. Add a branch that renders the save-recipe variant:

```tsx
import { useState } from "react";

// In the existing switch on payload.kind, add:
case "save_recipe": {
  const [name, setName] = useState(payload.suggested_name);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<"saved" | "dismissed" | null>(null);

  if (done === "saved") return <div className="text-sm text-emerald-300">Saved to your library.</div>;
  if (done === "dismissed") return <div className="text-sm text-neutral-400">Dismissed.</div>;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/coach/save-recipe-from-nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          composite_of: payload.items.map((i) => ({ name: i.name, qty_g: i.qty_g, per_100g: i.per_100g })),
          per_100g: payload.per_100g,
          combo_signature: payload.combo_signature,
        }),
      });
      if (res.ok) setDone("saved");
    } finally {
      setSaving(false);
    }
  };

  const dismiss = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/chat/nudge-dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger_key: `save_recipe:${payload.combo_signature}` }),
      });
      if (res.ok) setDone("dismissed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm">
      <div className="font-medium">Nora noticed</div>
      <p className="mt-1 text-neutral-300">
        You've logged {payload.items.map((i) => i.name).join(" + ")} together {payload.co_occurrence_count}× in the last 30 days.
      </p>
      <p className="mt-2 text-neutral-400">Save as a recipe? 1 tap to log next time.</p>

      <label className="mt-3 block">
        <span className="text-xs text-neutral-400">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          className="mt-1 block w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
        />
      </label>

      <ul className="mt-3 space-y-1 text-xs text-neutral-300">
        {payload.items.map((i) => (
          <li key={i.name}>• {i.name} — {Math.round(i.qty_g)}g (median)</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-neutral-400">
        Per 100g: {Math.round(payload.per_100g.kcal)} kcal · {Math.round(payload.per_100g.protein_g)}P {Math.round(payload.per_100g.carbs_g)}C {Math.round(payload.per_100g.fat_g)}F
      </p>

      <div className="mt-3 flex gap-2">
        <button type="button" disabled={saving} onClick={save} className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50">
          Save to library
        </button>
        <button type="button" disabled={saving} onClick={dismiss} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300">
          Not this one
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/nora-suggestions/recipe-discovery.ts components/chat/ProactiveNudgeCard.tsx lib/data/types.ts
git commit -m "feat(nora): recipe discovery composer + save_recipe nudge variant"
```

---

### Task 17: Discovery cron + save-from-nudge route + nudge-dismiss route + audit

**Files:**
- Create: `app/api/coach/recipe-discovery/check/route.ts`
- Create: `app/api/coach/save-recipe-from-nudge/route.ts`
- Modify or create: `app/api/chat/nudge-dismiss/route.ts`
- Create: `scripts/audit-recipe-discovery.mjs`
- Modify: `vercel.json` — add discovery cron entry

- [ ] **Step 1: Write the discovery cron**

```ts
// app/api/coach/recipe-discovery/check/route.ts
//
// Daily cron — walks profiles, picks at most one save-recipe candidate per
// user per day. Writes a chat_messages row with kind='proactive_nudge' + the
// save_recipe payload variant. Idempotent on (user_id, fired_on, trigger_key)
// via proactive_nudge_dedup.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { pickDiscoveryCandidate } from "@/lib/coach/nora-suggestions/recipe-discovery";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!auth || !secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, eating_identity_cache");

  const today = new Date().toISOString().slice(0, 10);
  const fired: Array<{ user_id: string; sig?: string }> = [];

  for (const p of profiles ?? []) {
    if (!p.eating_identity_cache) continue;
    const cand = await pickDiscoveryCandidate({
      supabase,
      userId: p.user_id,
      identity: p.eating_identity_cache,
      today,
    });
    if (!cand) continue;

    // Write chat_messages row.
    const { error: msgErr } = await supabase.from("chat_messages").insert({
      user_id: p.user_id,
      role: "assistant",
      speaker: "nora",
      kind: "proactive_nudge",
      content: "",
      ui: {
        kind: "save_recipe",
        combo_signature: cand.combo_signature,
        items: cand.items,
        suggested_name: cand.suggested_name,
        co_occurrence_count: cand.co_occurrence_count,
        last_seen: cand.last_seen,
        avg_slot: cand.avg_slot,
        per_100g: cand.per_100g,
      },
    });
    if (msgErr) { console.error(p.user_id, msgErr); continue; }

    // Write dedup row.
    const { error: dedupErr } = await supabase.from("proactive_nudge_dedup").insert({
      user_id: p.user_id,
      trigger_key: `save_recipe:${cand.combo_signature}`,
      fired_on: today,
    });
    if (dedupErr) console.error("dedup write failed:", p.user_id, dedupErr);

    fired.push({ user_id: p.user_id, sig: cand.combo_signature });
  }

  return NextResponse.json({ today, fired_count: fired.length, fired });
}
```

- [ ] **Step 2: Add cron entry to `vercel.json`**

```json
{
  "path": "/api/coach/recipe-discovery/check",
  "schedule": "45 3 * * *"
}
```

- [ ] **Step 3: Save-from-nudge route**

```ts
// app/api/coach/save-recipe-from-nudge/route.ts
//
// One-shot: insert user_food_items row from a save-recipe nudge tap. Tracks
// metadata.source='recipe_discovery' for the §9.6 tight-loop boost.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const Body = z.object({
  name: z.string().min(1).max(80),
  composite_of: z.array(z.object({
    name: z.string(),
    qty_g: z.number().nonnegative(),
    per_100g: z.object({ kcal: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number(), fiber_g: z.number() }),
  })).min(2),
  per_100g: z.object({ kcal: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number(), fiber_g: z.number() }),
  combo_signature: z.string(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid", issues: parsed.error.issues }, { status: 400 });

  const { error, data } = await supabase
    .from("user_food_items")
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      composite_of: parsed.data.composite_of,
      per_100g: parsed.data.per_100g,
      metadata: { source: "recipe_discovery", combo_signature: parsed.data.combo_signature },
    })
    .select("id")
    .single();

  // 23505 unique violation → return existing row's id with was_duplicate semantics
  if (error?.code === "23505") {
    const { data: existing } = await supabase
      .from("user_food_items")
      .select("id")
      .eq("user_id", user.id)
      .ilike("name", parsed.data.name)
      .maybeSingle();
    return NextResponse.json({ id: existing?.id, was_duplicate: true });
  }
  if (error) return NextResponse.json({ error: "write_failed", detail: error.message }, { status: 500 });

  return NextResponse.json({ id: data?.id, was_duplicate: false });
}
```

- [ ] **Step 4: Nudge-dismiss route (create if missing)**

Run: `ls app/api/chat/nudge-dismiss/route.ts 2>/dev/null` to check if it exists.

If missing, create it:

```ts
// app/api/chat/nudge-dismiss/route.ts
//
// Writes a dedup row with dismissed_at set so the same trigger_key is
// blocked for the dedup window (90d for save_recipe via cron logic).

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const Body = z.object({ trigger_key: z.string().min(1) });

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  // Upsert: if already present (cron fired the same day), set dismissed_at.
  const { error } = await supabase.from("proactive_nudge_dedup").upsert(
    { user_id: user.id, trigger_key: parsed.data.trigger_key, fired_on: today, dismissed_at: new Date().toISOString() },
    { onConflict: "user_id,trigger_key,fired_on" },
  );
  if (error) return NextResponse.json({ error: "write_failed", detail: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
```

Check that `proactive_nudge_dedup` schema has a `dismissed_at` column. If not, the row insert without the column will still dedup correctly (the row's existence = blocking). Adjust query if column is missing.

- [ ] **Step 5: Discovery audit script**

```js
// scripts/audit-recipe-discovery.mjs
//
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-recipe-discovery.mjs

import { createClient } from "@supabase/supabase-js";
import { pickDiscoveryCandidate, comboSignature } from "../lib/coach/nora-suggestions/recipe-discovery.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: prof } = await supabase
  .from("profiles")
  .select("eating_identity_cache")
  .eq("user_id", userId)
  .single();
if (!prof?.eating_identity_cache) { console.error("No eating_identity_cache."); process.exit(1); }

const identity = prof.eating_identity_cache;
const today = new Date().toISOString().slice(0, 10);

console.log("\n=== Qualifying combos (raw, before dedup) ===");
const recencyCutoff = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
for (const c of identity.frequent_combos) {
  const qualifies = c.co_occurrence_count >= 4 && c.last_seen >= recencyCutoff;
  const sig = comboSignature(c.items);
  console.log(`  ${qualifies ? "✓" : "·"}  ${c.co_occurrence_count}×  sig=${sig}  ${c.items.join(" + ")}  (avg_slot=${c.avg_slot}, last=${c.last_seen})`);
}

console.log("\n=== Rate-limit consumption (last 30d) ===");
const rateCutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
const { data: rows } = await supabase
  .from("proactive_nudge_dedup")
  .select("trigger_key, fired_on, dismissed_at")
  .eq("user_id", userId)
  .like("trigger_key", "save_recipe:%")
  .gte("fired_on", rateCutoff);
console.log(`Used ${rows?.length ?? 0} / 3 nudges in window`);
for (const r of rows ?? []) console.log(`  ${r.fired_on}  ${r.trigger_key}  ${r.dismissed_at ? "(dismissed)" : ""}`);

console.log("\n=== Pending winner ===");
const cand = await pickDiscoveryCandidate({ supabase, userId, identity, today });
if (cand) {
  console.log(`Would fire: sig=${cand.combo_signature}`);
  console.log(`  name: ${cand.suggested_name}`);
  console.log(`  items: ${cand.items.map((i) => `${i.name} ${Math.round(i.qty_g)}g`).join(" + ")}`);
  console.log(`  per_100g: ${Math.round(cand.per_100g.kcal)}kcal ${Math.round(cand.per_100g.protein_g)}P`);
} else {
  console.log("Nothing qualifies right now.");
}
```

- [ ] **Step 6: Run audit**

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-recipe-discovery.mjs`
Expected: a list of combos with qualify markers, the current rate-limit consumption, and whether anything would fire today.

- [ ] **Step 7: Trigger cron once locally and verify chat row**

Run: `curl -X GET http://localhost:3000/api/coach/recipe-discovery/check -H "Authorization: Bearer $CRON_SECRET"`
Expected: `{"today":"...","fired_count":0 or 1,"fired":[...]}`

If fired_count=1, open `/coach` and verify the save-recipe nudge card appears. Tap "Save to library" — verify `/profile/library` shows the new recipe.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add app/api/coach/recipe-discovery/check/route.ts app/api/coach/save-recipe-from-nudge/route.ts app/api/chat/nudge-dismiss/route.ts scripts/audit-recipe-discovery.mjs vercel.json
git commit -m "feat(nora): recipe-discovery cron + save-from-nudge route + audit"
```

---

## Self-Review

Spec coverage check — each section of the spec maps to a task:

| Spec section | Covered by |
|---|---|
| §5.1 Migration | Task 1 |
| §5.2 Tag vocabulary | Task 1 (types) + Task 2 (predicates) |
| §5.3 Profile UI | Task 4 |
| §5.4 Backfill | Task 3 |
| §6.1 EatingIdentity shape | Task 1 (types) + Task 6 (composer) |
| §6.2 Name canonicalization | Task 5 |
| §6.3 Library + recipe handling | Task 6 |
| §6.4 Meal grouping | Task 6 (`groupIntoMeals`) |
| §6.5 Caching + cron | Task 7 |
| §6.6 Audit | Task 7 |
| §7 Suggestion engine | Tasks 8 + 9 + 10 |
| §8.1 Tool schema | Task 11 |
| §8.2 One-tap log flow | Task 11 (token mint) + Task 15 (card submits `[approve:<token>]`) |
| §8.3 Card UI | Task 15 |
| §8.4 Chat-stream landmines | Task 12 |
| §8.5 Snapshot injection | Task 14 |
| §8.6 NORA_BASE additions | Task 13 |
| §9.1 Trigger threshold | Task 16 (`QUALIFY_MIN_COUNT` etc.) |
| §9.2 Nudge variant | Task 16 |
| §9.3 Card UI | Task 16 |
| §9.4 Save flow | Task 17 (save-from-nudge route) |
| §9.5 Detection cron | Task 17 |
| §9.6 Tight loop | Task 11 (newRecipeBoosts lookup) + Task 9 (scoring boost) |
| §9.7 Audit | Task 17 |

All spec sections covered.

**Type consistency:** `EatingIdentity`, `MealSuggestion`, `SuggestEngineOutput`, `DietaryExclusions`, `ExclusionTag` defined once in Task 1, referenced everywhere downstream by name. `passesExclusions` defined in Task 2, used in Tasks 9, 10, 16. `composeEatingIdentity` defined in Task 6, called in Tasks 7, 11. `suggestMeal` defined in Task 9, called in Tasks 10, 11. `pickDiscoveryCandidate` defined in Task 16, called in Tasks 17. `renderEatingIdentityBlock` defined in Task 14. All signatures consistent across calls.

**No placeholders:** All steps contain actual code or actual commands. No "implement appropriate error handling" — failure modes are spec'd in §10 of the design doc and surface as `error: 'exclusions_exhausted' | 'no_history'` enums in the engine output, handled in the card (Task 15 Step 1).

**Known imprecisions an executor will need to resolve at the file:**
- Task 4 Step 3 — exact mount point in profile page depends on the current profile-client structure; engineer locates via grep in Step 1.
- Task 14 Step 2 — `runChatStream` parameter name for the injection block must match existing pattern in `app/api/chat/messages/route.ts`; engineer matches the `peterDashboardBlock` precedent.
- Task 15 Step 2 — `submitMessage` / `openMealLoggerSheet` helper names in `ChatThread.tsx` may differ; engineer adapts to existing prop drilling pattern from the `propose_meal_log` Approve chip case.
- Task 16 Step 1 — exact file location of `ProactiveNudgeCard` payload union depends on where the discriminated union currently lives; engineer locates via grep.

These are all "find the actual file location" lookups, not design decisions — the design is fully specified.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-nora-suggestion-engine.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
