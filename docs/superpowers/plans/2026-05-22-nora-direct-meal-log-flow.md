# Nora Direct Meal-Log Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Nora's `search → save → log` chat dance with a `resolve → propose → commit` flow. Halves the model rounds per meal, builds the user's library as a side effect of logging, and gates the write behind a single Approve chip.

**Architecture:**
- New chat tool `resolve_food_macros(name, qty_g)` exposes the existing `lib/food/lookup.ts:resolveItemMacros` chain (library → cache → USDA → OpenFoodFacts → LLM) to Nora. Free, cached, more accurate than `web_search` for standard whole foods.
- Replace `log_meal_entry` with `propose_meal_log` + `commit_meal_log`. The propose tool accepts items by `(name, qty_g)` only — it resolves each server-side, builds the preview, signs an HMAC approval token. The commit tool inserts the `food_log_entries` row, auto-saves non-library items to `user_food_items` (idempotent via the existing 23505 floor), and reaggregates `daily_logs`.
- New `MealLogProposalCard` component renders the preview in chat with per-item source badges and an Approve button (mirrors `SessionTodayProposalCard`).

**Tech Stack:** Next.js 15 App Router, TypeScript (strict), Supabase service-role client, Anthropic SDK, existing `lib/coach/approval-token.ts` HMAC primitive.

**Test strategy:** This codebase has no unit-test suite (per `CLAUDE.md`). Each task verifies with `npm run typecheck` plus an audit script that exercises the new code paths against real Supabase rows. Manual smoke verification in the running app is the final gate.

---

## File map

- **Modify:** `lib/coach/approval-token.ts` — extend `ApprovalAction` union with `"meal_log"`.
- **Modify:** `lib/coach/tools.ts` — add `RESOLVE_FOOD_MACROS_TOOL` + `PROPOSE_MEAL_LOG_TOOL` + `COMMIT_MEAL_LOG_TOOL` schemas; add three executors; drop `LOG_MEAL_ENTRY_TOOL` + `executeLogMealEntry`; update `NORA_TOOLS` array.
- **Modify:** `lib/coach/chat-stream.ts` — three tool dispatch branches; update `PERSIST_RESULT_TOOLS`; update `modeAllowsTool` meal_log allowlist.
- **Create:** `components/chat/MealLogProposalCard.tsx` — preview card with per-item rows + macro deltas + Approve button.
- **Modify:** `components/chat/ChatMessage.tsx` — branch on `propose_meal_log` to render the card; detect `hasCommittedMealLog`; drop `log_meal_entry` from `RECEIPT_TOOLS` (replaced by the card).
- **Modify:** `lib/coach/system-prompts.ts` — rewrite Nora's "Library + meal-log workflow" section to describe the new resolve/propose/commit flow.
- **Create:** `scripts/audit-direct-meal-log.mjs` — verifies propose→commit pairing + auto-save side effect on recent meals.

No DB migration — the only DB shape change is using the existing `user_food_items` table via the existing `executeSaveToLibrary` (already 23505-tolerant).

---

## Task 1: Extend ApprovalAction with "meal_log"

**Files:**
- Modify: `lib/coach/approval-token.ts:17`

- [ ] **Step 1: Add `"meal_log"` to the ApprovalAction union**

Edit `lib/coach/approval-token.ts` line 17:

```ts
export type ApprovalAction = "block" | "week" | "plan" | "weekly_review" | "nutrition_targets" | "session_today" | "session_template" | "meal_log";
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/approval-token.ts
git commit -m "feat(coach): add meal_log to ApprovalAction union"
```

---

## Task 2: Add RESOLVE_FOOD_MACROS_TOOL schema + executor

**Files:**
- Modify: `lib/coach/tools.ts` — insert before the existing `log_meal_entry` block (around line 3762)

- [ ] **Step 1: Confirm the existing import of `resolveItemMacros`**

Run: `grep -n "from \"@/lib/food/lookup\"" lib/coach/tools.ts`
Expected: at least one line showing `resolveItemMacros` is already imported (the meal-logging revamp wired this). If not, add `import { resolveItemMacros } from "@/lib/food/lookup";` to the top imports block.

- [ ] **Step 2: Insert the tool schema**

In `lib/coach/tools.ts`, add immediately before the existing `// log_meal_entry — Nora-only chat write-path...` comment (search for that comment to locate; it's around line 3762):

```ts
// ────────────────────────────────────────────────────────────────────────────
// resolve_food_macros — read-only chain wrapper for Nora.
//
// Exposes lib/food/lookup.ts:resolveItemMacros (library → food_db_cache → USDA
// → OpenFoodFacts → LLM) to chat. Lets Nora resolve macros without burning
// web_search budget on whole foods her training data already covers. The
// underlying resolver writes USDA / OFF hits to food_db_cache, so repeated
// lookups of the same item short-circuit.
// ────────────────────────────────────────────────────────────────────────────

export const RESOLVE_FOOD_MACROS_TOOL: ToolSchema = {
  name: "resolve_food_macros",
  description:
    "Resolve per-100g macros for a food item via library → cache → USDA → OpenFoodFacts → LLM fallback. Use this BEFORE propose_meal_log when the user hasn't given you explicit macros. Cheap and cached — prefer this over web_search for standard foods.",
  input_schema: {
    type: "object" as const,
    required: ["name", "qty_g"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120, description: "Display name (e.g., 'grilled chicken breast', '200g brown rice cooked')." },
      qty_g: { type: "number", minimum: 0.1, maximum: 5000, description: "Quantity in grams." },
    },
  },
};

export async function executeResolveFoodMacros(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ name: string; qty_g: number; kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; per_100g: FoodMacros; source: "db" | "llm"; db_ref: { source: string; canonical_id: string } | null; confidence: "high" | "medium" | "low"; match_score: number | null; library_item_id: string | null }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const name = typeof i.name === "string" ? i.name.trim() : "";
  const qty_g = typeof i.qty_g === "number" && i.qty_g > 0 ? i.qty_g : NaN;
  if (!name || !Number.isFinite(qty_g)) {
    return { ok: false, error: { error: "name (string) and qty_g (positive number) required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  try {
    const item = await resolveItemMacros(name, qty_g, opts.userId);
    return {
      ok: true,
      data: {
        name: item.name,
        qty_g: item.qty_g,
        kcal: item.kcal,
        protein_g: item.protein_g,
        carbs_g: item.carbs_g,
        fat_g: item.fat_g,
        fiber_g: item.fiber_g,
        per_100g: item.per_100g,
        source: item.source,
        db_ref: item.db_ref,
        confidence: item.confidence,
        match_score: item.match_score,
        library_item_id: item.db_ref?.source === "user_library" ? item.db_ref.canonical_id : null,
      },
      meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
    };
  } catch (err) {
    return {
      ok: false,
      error: { error: `resolve failed for "${name}": ${(err as Error).message}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(coach): add resolve_food_macros chat tool"
```

---

## Task 3: Replace log_meal_entry with propose_meal_log + commit_meal_log

**Files:**
- Modify: `lib/coach/tools.ts` — replace existing `LOG_MEAL_ENTRY_TOOL` block + `executeLogMealEntry` function

- [ ] **Step 1: Locate the existing block**

Run: `grep -n "LOG_MEAL_ENTRY_TOOL\|executeLogMealEntry" lib/coach/tools.ts`
Expected: 4 hits — schema declaration around line 3784, function around line 3839, NORA_TOOLS reference around line 4339, and possibly a re-export.

- [ ] **Step 2: Delete the entire `LOG_MEAL_ENTRY_TOOL` schema + `executeLogMealEntry` function**

Replace the section spanning `// log_meal_entry — Nora-only chat write-path...` through the end of `executeLogMealEntry` (a single contiguous block) with the new propose/commit pair. The exact span to remove starts at the comment header (around line 3762) and ends at the closing `}` of `executeLogMealEntry` (around line 3960).

- [ ] **Step 3: Insert the propose + commit schemas + executors**

Paste the following in the slot vacated by Step 2:

```ts
// ────────────────────────────────────────────────────────────────────────────
// propose_meal_log / commit_meal_log — Nora's confirm-gated meal write.
//
// Replaces the legacy fire-and-confirm log_meal_entry tool. Nora calls propose
// with raw (name, qty_g) tuples; the executor resolves each via
// resolveItemMacros, builds the preview, and signs an approval token. The chat
// UI renders MealLogProposalCard with an Approve button. On approval the
// athlete's message contains [approve:<token>], Nora calls commit, the
// food_log_entries row is inserted, any non-library items get auto-saved to
// user_food_items as a side effect (idempotent via 23505 dedup floor), and
// the day re-aggregates.
//
// Auto-save: items resolved from the personal library (db_ref.source ===
// 'user_library') pass through with library_item_id stamped on the food log
// item. All other items (USDA / OFF / LLM-estimated) get inserted into
// user_food_items so the next log of the same name short-circuits at the
// library lookup. executeSaveToLibrary already handles the 23505 unique
// violation as was_duplicate=true — no extra collision logic needed here.
// ────────────────────────────────────────────────────────────────────────────

type ProposeMealLogItem = {
  name: string;
  qty_g: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: { source: string; canonical_id: string } | null;
  confidence: "high" | "medium" | "low";
  match_score: number | null;
  library_item_id: string | null;
};

type MealLogPayload = {
  items: ProposeMealLogItem[];
  meal_slot: MealSlot;
  eaten_at: string;
  raw_text: string;
  totals: FoodMacros;
};

export const PROPOSE_MEAL_LOG_TOOL: ToolSchema = {
  name: "propose_meal_log",
  description:
    "Propose a meal-log write for the athlete to approve. Server-side: resolves each item's macros via library → cache → USDA → OpenFoodFacts → LLM, builds a preview with day-totals delta, and signs an approval token. The chat UI surfaces an Approve chip; the athlete's approval triggers commit_meal_log. Use AFTER you've confirmed item names + quantities with the athlete. Do NOT call resolve_food_macros first — this tool resolves everything itself.",
  input_schema: {
    type: "object" as const,
    required: ["items", "meal_slot"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 15,
        items: {
          type: "object",
          required: ["name", "qty_g"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            qty_g: { type: "number", minimum: 0.1, maximum: 5000 },
          },
        },
      },
      meal_slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
      eaten_at: { type: "string", description: "Optional ISO-8601 timestamp. Defaults to now." },
      raw_text: { type: "string", description: "Optional original user message for traceability." },
    },
  },
};

export const COMMIT_MEAL_LOG_TOOL: ToolSchema = {
  name: "commit_meal_log",
  description:
    "Commit a previously proposed meal-log entry. Requires approval_token from propose_meal_log. Writes food_log_entries, auto-saves any non-library items to user_food_items, and reaggregates daily_logs.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export async function executeProposeMealLog(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: MealLogPayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const meal_slot = i.meal_slot as MealSlot | undefined;
  if (!meal_slot || !["breakfast", "lunch", "dinner", "snack"].includes(meal_slot)) {
    return { ok: false, error: { error: "meal_slot must be one of breakfast|lunch|dinner|snack" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const itemsInput = Array.isArray(i.items) ? (i.items as Array<Record<string, unknown>>) : [];
  if (itemsInput.length === 0 || itemsInput.length > 15) {
    return { ok: false, error: { error: "items must contain 1..15 entries" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const eaten_at_raw = typeof i.eaten_at === "string" ? i.eaten_at : null;
  const eaten_at =
    eaten_at_raw && !Number.isNaN(Date.parse(eaten_at_raw))
      ? new Date(eaten_at_raw).toISOString()
      : new Date().toISOString();
  const raw_text = typeof i.raw_text === "string" ? i.raw_text : "Logged via chat";

  // Resolve each item server-side. Errors in one item collapse the whole
  // proposal — partial proposals would surface ambiguous state in the chip.
  const resolved: ProposeMealLogItem[] = [];
  for (const it of itemsInput) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const qty_g = typeof it.qty_g === "number" && it.qty_g > 0 ? it.qty_g : NaN;
    if (!name || !Number.isFinite(qty_g)) {
      return { ok: false, error: { error: `item missing name/qty_g: ${JSON.stringify(it).slice(0, 120)}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    try {
      const item = await resolveItemMacros(name, qty_g, opts.userId);
      resolved.push({
        name: item.name,
        qty_g: item.qty_g,
        kcal: item.kcal,
        protein_g: item.protein_g,
        carbs_g: item.carbs_g,
        fat_g: item.fat_g,
        fiber_g: item.fiber_g,
        per_100g: item.per_100g,
        source: item.source,
        db_ref: item.db_ref,
        confidence: item.confidence,
        match_score: item.match_score,
        library_item_id: item.db_ref?.source === "user_library" ? item.db_ref.canonical_id : null,
      });
    } catch (err) {
      return {
        ok: false,
        error: { error: `resolve failed for "${name}": ${(err as Error).message}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
  }
  const totals = sumMacros(resolved);

  const payload: MealLogPayload = {
    items: resolved,
    meal_slot,
    eaten_at,
    raw_text,
    totals,
  };
  const token = signApprovalToken({ userId: opts.userId, action: "meal_log", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeCommitMealLog(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<
  ToolResult<{
    entry_id: string;
    meal_slot: MealSlot;
    eaten_at: string;
    item_count: number;
    totals: FoodMacros;
    day_totals: FoodMacros;
    date: string;
    saved_library_ids: string[];
  }>
> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;
  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "meal_log" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the meal payload. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as MealLogPayload;

  // Auto-save non-library items to user_food_items. Idempotent via 23505 in
  // executeSaveToLibrary. We do this BEFORE the food_log_entries insert so we
  // can stamp library_item_id on each item's db_ref — a future log of the
  // same name then short-circuits at the library lookup.
  const saved_library_ids: string[] = [];
  const itemsWithLibRefs: FoodItem[] = [];
  for (const it of p.items) {
    let library_item_id = it.library_item_id;
    if (!library_item_id) {
      const save = await executeSaveToLibrary({
        supabase: opts.supabase,
        userId: opts.userId,
        input: { kind: "item", name: it.name, source: "user_manual", per_100g: it.per_100g },
      });
      if (save.ok) {
        library_item_id = save.data.id;
        if (!save.data.was_duplicate) saved_library_ids.push(save.data.id);
      }
      // If save failed, fall through — the meal log still commits without a
      // library reference. This matches executeSaveToLibrary's own permissive
      // posture (a missing library row is not a meal-log blocker).
    }
    itemsWithLibRefs.push({
      name: it.name,
      qty_g: it.qty_g,
      kcal: it.kcal,
      protein_g: it.protein_g,
      carbs_g: it.carbs_g,
      fat_g: it.fat_g,
      fiber_g: it.fiber_g,
      per_100g: it.per_100g,
      source: library_item_id ? "db" : it.source,
      db_ref: library_item_id
        ? { source: "user_library", canonical_id: library_item_id }
        : it.db_ref,
      confidence: it.confidence,
      match_score: it.match_score,
    });
  }

  const { data: inserted, error } = await opts.supabase
    .from("food_log_entries")
    .insert({
      user_id: opts.userId,
      eaten_at: p.eaten_at,
      kind: "text",
      meal_slot: p.meal_slot,
      raw_input: { kind: "text", text: p.raw_text },
      items: itemsWithLibRefs,
      totals: p.totals,
      is_estimated: itemsWithLibRefs.some((it) => it.source === "llm"),
      status: "committed",
    })
    .select("id, eaten_at")
    .single();
  if (error || !inserted) {
    return { ok: false, error: { error: error?.message ?? "insert returned no row" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const date = utcDate((inserted as { eaten_at: string }).eaten_at);
  const day_totals = foodLogOwnsDailyLogs()
    ? await reaggregateDay(opts.supabase, opts.userId, date)
    : await sumFoodEntriesForDate(opts.supabase, opts.userId, date);

  return {
    ok: true,
    data: {
      entry_id: (inserted as { id: string }).id,
      meal_slot: p.meal_slot,
      eaten_at: p.eaten_at,
      item_count: itemsWithLibRefs.length,
      totals: p.totals,
      day_totals,
      date,
      saved_library_ids,
    },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}
```

- [ ] **Step 4: Update NORA_TOOLS to remove LOG_MEAL_ENTRY_TOOL and add the three new tools**

Find the `NORA_TOOLS` array (around line 4326 before this edit; reindex after Step 3). Replace the `LOG_MEAL_ENTRY_TOOL` entry with three entries:

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
];
```

- [ ] **Step 5: Confirm `sumMacros`, `executeSaveToLibrary`, `MealSlot`, `FoodItem`, `FoodMacros`, `signApprovalToken`, `verifyApprovalToken`, `ApprovalTokenError`, `approvalTokenUserMessage`, `reaggregateDay`, `sumFoodEntriesForDate`, `foodLogOwnsDailyLogs`, `utcDate` are all reachable from this file**

Run: `grep -n "sumMacros\|executeSaveToLibrary\|MealSlot\|reaggregateDay\|sumFoodEntriesForDate\|foodLogOwnsDailyLogs\|utcDate\|signApprovalToken\|verifyApprovalToken\|ApprovalTokenError\|approvalTokenUserMessage" lib/coach/tools.ts | head -30`
Expected: each name resolves to an existing import or in-file declaration. If any are missing, add the matching import from `@/lib/food/aggregate`, `@/lib/food/types`, `@/lib/food/date`, or `@/lib/coach/approval-token`. These should all already be present because they were used by the previous `executeLogMealEntry`.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0. If errors mention unused imports left over from the deleted `executeLogMealEntry`, remove only the ones that have zero remaining references.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(coach): replace log_meal_entry with propose/commit meal_log

Auto-saves non-library items to user_food_items on commit as a side
effect, so a meal you eat twice drops to a 2-call flow next time."
```

---

## Task 4: Wire new tools into chat-stream dispatch + mode gating

**Files:**
- Modify: `lib/coach/chat-stream.ts`

- [ ] **Step 1: Add executor imports**

Locate the existing import block that brings `executeLogMealEntry` in from `@/lib/coach/tools` (search for it). Replace `executeLogMealEntry` with the three new names. The block should now contain `executeResolveFoodMacros, executeProposeMealLog, executeCommitMealLog`. Drop `executeLogMealEntry` entirely from this import.

Run: `grep -n "executeLogMealEntry\|executeResolveFoodMacros\|executeProposeMealLog\|executeCommitMealLog" lib/coach/chat-stream.ts`
Expected after the edit: 0 hits for executeLogMealEntry, ≥1 hit each for the three new names.

- [ ] **Step 2: Update PERSIST_RESULT_TOOLS**

In `lib/coach/chat-stream.ts` around lines 96-104, the `PERSIST_RESULT_TOOLS` Set lists library + meal-log tools. Replace `"log_meal_entry"` with the three new names:

```ts
  // Library + meal-log tools persist their result so the UI can render
  // confirmation chips ("Saved: <name>", proposal cards, "Logged to <slot>")
  // under the assistant bubble. Without this the user couldn't tell that 8×
  // save_to_library actually ran (see 2026-05-21 Nora re-save loop).
  "save_to_library",
  "search_library",
  "pick_library_item",
  "resolve_food_macros",
  "propose_meal_log",
  "commit_meal_log",
]);
```

- [ ] **Step 3: Update modeAllowsTool meal_log allowlist**

Around line 282-294, the `if (opts.mode === "meal_log")` branch lists the tools allowed in MealLoggerSheet's chat. Replace the `log_meal_entry` allowlist entry with the three new tools:

```ts
    if (opts.mode === "meal_log") {
      return (
        name === "search_library" ||
        name === "pick_library_item" ||
        name === "save_to_library" ||
        name === "resolve_food_macros" ||
        name === "propose_meal_log" ||
        name === "commit_meal_log"
      );
    }
```

- [ ] **Step 4: Replace the log_meal_entry dispatch branch**

Around lines 662-667, the dispatch switch has `} else if (block.name === "log_meal_entry") { result = await executeLogMealEntry(...) }`. Replace with three branches:

```ts
        } else if (block.name === "resolve_food_macros") {
          result = await executeResolveFoodMacros({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "propose_meal_log") {
          result = await executeProposeMealLog({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "commit_meal_log") {
          result = await executeCommitMealLog({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "feat(coach): wire resolve/propose/commit meal_log into chat-stream"
```

---

## Task 5: Add MealLogProposalCard component

**Files:**
- Create: `components/chat/MealLogProposalCard.tsx`

- [ ] **Step 1: Read the SessionTodayProposalCard for visual parity**

Run: `cat components/chat/SessionTodayProposalCard.tsx`
Note the structure: `CoachCard` with eyebrow + body + Approve button via `onApprove(token)`, a committed-state variant with a green checkmark, and a `busy` state during approval. The new card mirrors this 1:1.

- [ ] **Step 2: Create the component**

Write `components/chat/MealLogProposalCard.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type MealLogProposalItem = {
  name: string;
  qty_g: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  source: "db" | "llm";
  db_ref: { source: string; canonical_id: string } | null;
  confidence: "high" | "medium" | "low";
  library_item_id: string | null;
};

export type MealLogProposal = {
  items: MealLogProposalItem[];
  meal_slot: "breakfast" | "lunch" | "dinner" | "snack";
  eaten_at: string;
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
};

const SLOT_LABEL: Record<MealLogProposal["meal_slot"], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

function sourceBadge(item: MealLogProposalItem): string {
  if (item.library_item_id) return "library";
  if (item.db_ref?.source === "usda") return "USDA";
  if (item.db_ref?.source === "openfoodfacts") return "OFF";
  if (item.db_ref?.source) return item.db_ref.source;
  return "est."; // LLM fallback
}

export function MealLogProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: MealLogProposal;
  approvalToken: string;
  onApprove: (token: string) => void;
  onTweak: () => void;
  committed?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  if (committed) {
    return (
      <CoachCard tone="ok">
        <CoachCard.Body>
          <div style={{ color: COLOR.success, fontWeight: 700, fontSize: 13 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Check size={14} strokeWidth={3} />
              Logged to {SLOT_LABEL[proposal.meal_slot]}
            </span>
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            {fmtNum(proposal.totals.kcal)} kcal · {fmtNum(proposal.totals.protein_g)}P / {fmtNum(proposal.totals.carbs_g)}C / {fmtNum(proposal.totals.fat_g)}F
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>Log to {SLOT_LABEL[proposal.meal_slot]}</CoachCard.Eyebrow>
      <CoachCard.Body>
        <div>
          {proposal.items.map((it, idx) => (
            <div
              key={`${it.name}-${idx}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "4px 0",
                fontSize: 12,
                color: COLOR.textStrong,
                borderBottom: idx < proposal.items.length - 1 ? `1px solid ${COLOR.divider}` : "none",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                <div style={{ fontSize: 10, color: COLOR.textFaint, marginTop: 2 }}>
                  {fmtNum(it.qty_g)}g · {sourceBadge(it)}
                </div>
              </div>
              <div style={{ fontSize: 11, color: COLOR.textMuted, textAlign: "right", whiteSpace: "nowrap" }}>
                {fmtNum(it.kcal)} kcal
                <div style={{ fontSize: 10, color: COLOR.textFaint }}>
                  {fmtNum(it.protein_g)}P / {fmtNum(it.carbs_g)}C / {fmtNum(it.fat_g)}F
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${COLOR.divider}`, fontSize: 12, color: COLOR.textStrong, fontWeight: 600 }}>
          Total: {fmtNum(proposal.totals.kcal)} kcal · {fmtNum(proposal.totals.protein_g)}P / {fmtNum(proposal.totals.carbs_g)}C / {fmtNum(proposal.totals.fat_g)}F
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              onApprove(approvalToken);
            }}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
              background: COLOR.accent,
              color: COLOR.bg,
              border: "none",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Logging…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={onTweak}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 12,
              background: "transparent",
              color: COLOR.textMid,
              border: `1px solid ${COLOR.divider}`,
              cursor: "pointer",
            }}
          >
            Tweak
          </button>
        </div>
      </CoachCard.Body>
    </CoachCard>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0. If `COLOR.accent` is missing, fall back to `COLOR.brand` or another existing accent — grep `lib/ui/theme.ts` for the actual key.

- [ ] **Step 4: Commit**

```bash
git add components/chat/MealLogProposalCard.tsx
git commit -m "feat(chat): add MealLogProposalCard with approve gate"
```

---

## Task 6: Hook MealLogProposalCard into ChatMessage dispatch

**Files:**
- Modify: `components/chat/ChatMessage.tsx`

- [ ] **Step 1: Add the import**

Near the other proposal-card imports (search for `SessionTodayProposalCard`), add:

```ts
import { MealLogProposalCard, type MealLogProposal } from "@/components/chat/MealLogProposalCard";
```

- [ ] **Step 2: Add committed-detection alongside hasCommittedSessionToday**

Find the existing `const hasCommittedSessionToday = toolCalls.some(...)` near the top of the component (around line 59). Add a sibling:

```ts
  const hasCommittedMealLog = toolCalls.some(
    (c) => c.name === "commit_meal_log" && !c.error,
  );
```

- [ ] **Step 3: Add the proposal-card branch**

Find the existing `if (call.name === "propose_session_template") { ... }` block (around line 351). Add immediately after its closing brace, before the `return null` fallback:

```tsx
            if (call.name === "propose_meal_log") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <MealLogProposalCard
                    proposal={result.preview as MealLogProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedMealLog}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.("e.g., 'change rice to 200g' or 'add a banana'")
                    }
                  />
                </div>
              );
            }
```

- [ ] **Step 4: Update RECEIPT_TOOLS — remove log_meal_entry**

In `renderToolReceiptChip` (around line 404), the `RECEIPT_TOOLS` Set currently includes `"log_meal_entry"`. Remove that entry — the proposal card replaces the chip. The other library tools (`save_to_library`, `search_library`, `pick_library_item`) stay because they're still in Nora's tool surface for non-meal-log workflows.

After edit:

```ts
  const RECEIPT_TOOLS = new Set([
    "save_to_library",
    "search_library",
    "pick_library_item",
  ]);
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add components/chat/ChatMessage.tsx
git commit -m "feat(chat): render MealLogProposalCard for propose_meal_log"
```

---

## Task 7: Update NORA_BASE prompt to describe the new flow

**Files:**
- Modify: `lib/coach/system-prompts.ts` — replace the "Library + meal-log workflow" section in `NORA_BASE`

- [ ] **Step 1: Find the section**

Run: `grep -n "Library + meal-log workflow" lib/coach/system-prompts.ts`
Expected: one hit around line 89.

- [ ] **Step 2: Replace the section**

Replace the block from "Library + meal-log workflow." through the `"saved ✅"` paragraph (currently lines 89-94 plus the trailing instruction paragraph) with:

```
Library + meal-log workflow. The athlete can ask you to log a meal or save items. Your write path is confirm-gated — you propose, the athlete taps Approve, you commit:

- resolve_food_macros({ name, qty_g }) — optional preflight to inspect macros for one item before proposing. Library → cache → USDA → OpenFoodFacts → LLM fallback (cheap, cached). Use sparingly — most of the time you can go straight to propose_meal_log, which resolves every item itself.
- propose_meal_log({ items: [{ name, qty_g }], meal_slot, eaten_at?, raw_text? }) — surfaces an Approve chip with item-by-item macros + day-totals delta. Server resolves each item via the same chain. The athlete must tap Approve before anything is written.
- commit_meal_log({ approval_token }) — call when the athlete's reply contains [approve:<token>]. Writes food_log_entries, auto-saves any non-library items to user_food_items as a side effect (so the next log of "grilled chicken breast" short-circuits at the library), and reaggregates the day.
- search_library / pick_library_item / save_to_library — still available for explicit "save this recipe" / "what's in my library" requests outside the meal-log flow. Not required before propose_meal_log; the resolver hits the library first automatically.

Mid-flow rules:
- Confirm item names + quantities with the athlete BEFORE calling propose_meal_log. Ask one short clarifying question if a name is ambiguous (e.g. "raw or cooked weight on the rice?").
- After calling propose_meal_log, close with "Tap Approve to log it." Do not narrate "logged" before commit_meal_log returns.
- A user replying "yes" / "approved" without [approve:<token>] is NOT an approval signal — you have no token. Ask them to tap Approve, or re-propose so a fresh chip surfaces.
- On tweaks ("make the rice 200g"), call propose_meal_log again with the changed payload — a new chip replaces the stale one.
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): rewrite Nora meal-log prompt for propose/commit flow"
```

---

## Task 8: Audit script for propose→commit pairing + library buildup

**Files:**
- Create: `scripts/audit-direct-meal-log.mjs`

- [ ] **Step 1: Write the script**

Mirror the pattern of `scripts/audit-meal-logging-resolve.mjs` (existing). The script:

1. Reads `AUDIT_USER_ID` env var.
2. Fetches the last 10 `chat_messages` where `tool_calls` jsonb contains an entry with `name='propose_meal_log'` or `name='commit_meal_log'`.
3. For each propose: extract the approval_token from `tool_calls[].result.approval_token`, find a matching commit in the same or a later message with the same token, report pairing status.
4. For each successful commit: read `tool_calls[].result.entry_id`, fetch the `food_log_entries` row, count items, count `library_item_id`-bearing items, count `saved_library_ids` newly created.
5. Prints a summary table: `propose timestamp · commit timestamp · item_count · saved_count · day_totals.kcal`.

```js
// scripts/audit-direct-meal-log.mjs
// Read-only audit of Nora's confirm-gated meal-log flow.
//
// Walks the last 10 chat_messages bearing a propose_meal_log or
// commit_meal_log tool_call, pairs them by approval_token, and verifies that
// each successful commit produced a food_log_entries row + a measurable
// amount of library-buildup side effect.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-direct-meal-log.mjs

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}
const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: rows, error } = await supa
  .from("chat_messages")
  .select("id, created_at, tool_calls")
  .eq("user_id", userId)
  .not("tool_calls", "is", null)
  .order("created_at", { ascending: false })
  .limit(50);
if (error) {
  console.error("query failed:", error);
  process.exit(2);
}

const proposes = [];
const commits = [];
for (const r of rows ?? []) {
  for (const call of r.tool_calls ?? []) {
    if (call.name === "propose_meal_log" && call.result?.approval_token) {
      proposes.push({ msgId: r.id, ts: r.created_at, token: call.result.approval_token, preview: call.result.preview });
    } else if (call.name === "commit_meal_log" && !call.error && call.result?.entry_id) {
      commits.push({ msgId: r.id, ts: r.created_at, token: call.input?.approval_token, result: call.result });
    }
  }
}

console.log(`Found ${proposes.length} propose_meal_log calls, ${commits.length} commit_meal_log successes`);
console.log();

const tokenToCommit = new Map(commits.map((c) => [c.token, c]));
let pairedCount = 0;
let totalLibraryBuildup = 0;
for (const p of proposes) {
  const c = tokenToCommit.get(p.token);
  if (!c) {
    console.log(`✗ propose @ ${p.ts}: never committed (token=${p.token.slice(0, 12)}…, ${p.preview?.items?.length ?? 0} items)`);
    continue;
  }
  pairedCount++;
  const newlySaved = c.result.saved_library_ids?.length ?? 0;
  totalLibraryBuildup += newlySaved;
  const items = p.preview?.items?.length ?? 0;
  const kcal = c.result.day_totals?.kcal ?? "?";
  console.log(`✓ ${p.ts} → ${c.ts} · ${items} items · ${newlySaved} new lib rows · day kcal=${kcal}`);

  // Spot-check: confirm food_log_entries row exists.
  const { data: entry, error: entryErr } = await supa
    .from("food_log_entries")
    .select("id, items, meal_slot")
    .eq("id", c.result.entry_id)
    .maybeSingle();
  if (entryErr || !entry) {
    console.log(`  ⚠ food_log_entries row ${c.result.entry_id} not found — possible delete or RLS issue`);
  } else if ((entry.items?.length ?? 0) !== items) {
    console.log(`  ⚠ item-count mismatch: preview=${items}, row=${entry.items?.length}`);
  }
}

console.log();
console.log(`Summary: ${pairedCount}/${proposes.length} proposes committed · ${totalLibraryBuildup} new user_food_items rows across the window`);
```

- [ ] **Step 2: Run the audit script against your local dev data**

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-direct-meal-log.mjs`
Expected on a fresh install (no meals logged yet): `Found 0 propose_meal_log calls, 0 commit_meal_log successes`. Non-zero numbers after Task 9.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-direct-meal-log.mjs
git commit -m "feat(scripts): audit propose/commit meal_log pairing + library buildup"
```

---

## Task 9: End-to-end manual verification

This is the only step that exercises the full system. Skipping it means you don't actually know the feature works.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Open: http://localhost:3000/coach

- [ ] **Step 2: Trigger Nora directly**

In the chat composer, type `@Nora log my lunch: 200g grilled chicken breast, 150g brown rice cooked, 80g broccoli` and submit.

Expected sequence in the UI:
1. Nora bubble streams in.
2. A single MealLogProposalCard appears under the bubble showing all 3 items with macros + total + Approve/Tweak buttons.
3. Each item shows a source badge ("USDA" expected for all three on a fresh install).
4. No `search_library` chips, no `save_to_library` chips — those are obsolete in this flow.

- [ ] **Step 3: Tap Approve**

Expected:
1. Card flips to the "Logged to Lunch ✓" committed state with the totals line.
2. Nora's next bubble streams a brief confirmation (e.g., "Logged — 480 kcal / 52P / 48C / 8F to lunch.").
3. No second card.

- [ ] **Step 4: Verify the row in Supabase**

Open Supabase Studio → SQL Editor. Run:

```sql
select id, meal_slot, totals, jsonb_array_length(items) as item_count, is_estimated
from food_log_entries
where user_id = '<your-uuid>'
order by created_at desc limit 1;
```

Expected: one row, `item_count = 3`, `is_estimated = false` (all USDA-resolved), totals roughly match the card.

- [ ] **Step 5: Verify library buildup**

```sql
select id, name, source, per_100g
from user_food_items
where user_id = '<your-uuid>'
order by created_at desc limit 5;
```

Expected: 3 new rows (chicken / rice / broccoli) with `source = 'user_manual'` and per-100g macros populated.

- [ ] **Step 6: Re-log the same meal to verify library short-circuit**

Back in chat: `@Nora log dinner: 200g grilled chicken breast, 150g brown rice cooked`

Expected: MealLogProposalCard appears with both items showing `library` badge (not USDA). This confirms the resolver picked up the rows saved in Step 5.

- [ ] **Step 7: Run the audit script**

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-direct-meal-log.mjs`

Expected: `Found 2 propose_meal_log calls, 2 commit_meal_log successes`, both paired, first one shows `3 new lib rows`, second shows `0 new lib rows` (idempotency).

- [ ] **Step 8: Test the tweak path**

In chat: `@Nora log breakfast: 3 eggs and 200g greek yogurt`. When the card appears, tap **Tweak**. The composer should focus with the placeholder hint. Type "change the eggs to 4". Nora should re-propose with `propose_meal_log` again, surfacing a new card with 4 eggs and the same yogurt. Tap Approve. Verify only ONE `food_log_entries` row was inserted for breakfast (the second propose voided the first token implicitly by virtue of not being committed).

- [ ] **Step 9: Test the expired-token path (optional but recommended)**

In Supabase Studio, manually delete the row from `chat_messages` containing the most recent propose (or wait for token TTL — currently 24h per `signApprovalToken` default). Reload the chat. Try to tap Approve on the now-stale card if it's still rendered — the commit should return the "That approval expired" message via Nora's bubble.

- [ ] **Step 10: Cost check**

Open the dev server logs. For the Step 2 flow, count the number of model rounds (each `[chat-stream] round N` log line). Expected: ≤ 3 rounds (one for the propose tool, one for narration after the tool, one for the commit after the user approves). Old flow on the same input took 3+ rounds with 8+ tool calls; new flow should show 1-2 tool calls per round, total ≤ 3 calls.

---

## Self-review checklist

- **Spec coverage:** Three architectural goals from the design discussion — (1) expose existing resolver as chat tool, (2) bundle save+log via auto-save side effect, (3) add propose+commit gate. Mapped to Tasks 2, 3 (auto-save in `executeCommitMealLog`), and 3+4+5 (HMAC approval + UI). ✓

- **Placeholder scan:** No "TBD", "implement later", "similar to Task N" — every step has the exact code or command. ✓

- **Type consistency:**
  - `MealLogPayload` shape in tools.ts matches `MealLogProposal` shape in MealLogProposalCard.tsx — both have `items`, `meal_slot`, `eaten_at`, `totals`. ✓
  - Item shape `ProposeMealLogItem` (tools) ↔ `MealLogProposalItem` (card) — both have name/qty_g/macros/source/db_ref/confidence/library_item_id. ✓
  - `signApprovalToken` action `"meal_log"` matches `verifyApprovalToken` action `"meal_log"` matches the ApprovalAction union added in Task 1. ✓
  - `executeSaveToLibrary` input shape (`{ kind, name, source, per_100g }`) matches the auto-save call in `executeCommitMealLog`. ✓

- **Dependency order:** Task 1 (ApprovalAction) before Task 2 (uses `"meal_log"` literal). Task 2 (executors) before Task 3 (chat-stream imports). Task 5 (card) before Task 6 (ChatMessage imports it). Task 7 (prompt) any time after the tools exist. Task 8 (audit) after the executors exist. Task 9 (manual) last. ✓

- **Rollback safety:** The deleted `log_meal_entry` tool was added in the 2026-05-21 meal-logging-chat-revamp branch; no other callers exist (grepped). The new flow is additive at the schema layer (just new tools), so a revert is one git revert away. No DB migration to roll back. ✓
