# Meal Logger — SEARCH-primary, CHAT removed

**Status:** draft
**Author:** Claude (with Abdelouahed)
**Date:** 2026-05-25
**Related:**
- [2026-05-25-meal-logging-chat-parse-first-design.md](./2026-05-25-meal-logging-chat-parse-first-design.md) (the previous arc this supersedes)
- [2026-05-21-meal-logging-chat-revamp-design.md](./2026-05-21-meal-logging-chat-revamp-design.md) (the original Nora-led chat thread)
- [2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md](./2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md)

## Problem

The meal-logger CHAT tab — Nora-led free-text meal entry — is producing approximate answers on nearly every food. Real-world examples from production today:

- "basmati" → resolves to "Wild rice, cooked" with `confidence: 'high'`
- "use generic" (a chip reply) → 502 `extraction_failed`, error bubble to user
- Multiple round-trips with Nora narrating "I added X" while the pinned card stays stale

The pattern is structural, not a series of fixable bugs: free-text → LLM-extract → auto-resolve to one item produces an approximation for any food the resolver isn't confident about, and we have no good way to surface "I'm not sure" before committing. The earlier parse-first arc (2026-05-25) reduced the chat-side flakiness but kept the same primary affordance — and the primary affordance is the problem.

Zero successful meal-logging apps use conversational AI as the primary entry path. MFP, Yazio, Cronometer, MacroFactor, LoseIt, Cal AI — all of them are search-then-pick. The category converged here because meal logging is a high-frequency, low-cognitive-load task where the user wants 10-second entry with the right item, not a dialogue about what they meant.

A SEARCH tab already exists in `MealLoggerSheet` and has the right shape: typeahead-as-you-type (300 ms debounce), multi-source ranked candidates (user library → DB cache → USDA → OFF), per-100g macros + source badge + quantity input with preset chips, multi-item assembly via a picks list, then Review → Confirm. It is currently the second tab, hidden behind CHAT.

The fix is to recognize what we already built does the job and stop fighting the chat detour.

## Goals

- Make typing "basmati" produce a basmati pick in two taps: type, see ranked list, tap the entry.
- Eliminate the entire class of "argue with Nora until the macros are right" frustration.
- Reduce the meal-logger surface area so future work compounds instead of fights the chat detour.

## Non-goals

- AI photo / voice modalities. Different arc, different complexity envelope.
- Commercial food DB (Edamam / FatSecret / Nutritionix). Resurface if SEARCH-primary still hits coverage gaps after real use; not in this arc.
- Re-ranking / scoring overhaul. SEARCH already merges and ranks across sources; tuning lives in its own follow-up if real usage shows gaps.
- Backfilling or migrating historical `chat_messages` rows with `kind='meal_log'`. They stay orphaned, RLS-protected, harmless.
- Nora's role in `/coach` default-mode chat. She still proposes/commits meals there via `propose_meal_log` / `commit_meal_log` for users who actually want to log mid-conversation. That path stays.
- The LIBRARY tab and its v1.1 surfaces (favorites, recent, frequent, copy-yesterday's-lunch). All stay as-is.

## Architecture

Before: `MealLoggerSheet` has three tabs — CHAT (default) / SEARCH / LIBRARY. CHAT routes free-text through `/api/food/parse` + Nora SSE stream.

After: `MealLoggerSheet` has two tabs — **Add food** (the renamed SEARCH tab, default) / **Library**. The CHAT tab, the Nora-in-meal-sheet thread, the parse-first dispatch we shipped today, and the meal-log mode in the chat-stream tool gating all go away.

```
  before                          after
  ┌──────┬────────┬─────────┐    ┌──────────┬─────────┐
  │ CHAT │ SEARCH │ LIBRARY │ →  │ Add food │ Library │
  └──────┴────────┴─────────┘    └──────────┴─────────┘
   ^                                ^
   default                          default
```

## Design

### Tab structure

`components/log/MealLoggerSheet.tsx`:
- Tab array becomes `["search", "library"]` (two tabs).
- Initial state becomes `"search"`.
- Tab label rendered as "Add food" instead of "SEARCH" (and "Library" instead of "LIBRARY"). Title-case, less technical.
- Remove the import and conditional render of `<MealLoggerChatTab />`.

The SEARCH tab itself (`components/log/MealLoggerSearchTab.tsx`) is unchanged in behavior. The single visual change is renaming the tab label in the parent.

### Deletions

These files become dead with no remaining consumers and are deleted entirely:

- `components/log/MealLoggerChatTab.tsx` — the chat tab component (931 lines).
- `components/log/MealLoggerPreviewCard.tsx` — the pinned draft card. Used only by the chat tab; SEARCH uses `DraftReview` instead.
- `components/log/MealLoggerEditor.tsx` — the edit-mode UI for the pinned draft. Same single-consumer pattern.

### Modifications

`lib/coach/system-prompts.ts`:
- Delete the `NORA_MEAL_LOG_PROMPT` export (the doc comment + the template literal).
- In `speakerSystemPromptForMode`, delete the `if (speaker === "nora" && mode === "meal_log") return ...` branch; fall through to the speaker-default for any caller that somehow still sends `mode='meal_log'`.

`lib/coach/chat-stream.ts`:
- Delete the entire `if (opts.mode === "meal_log") { ... }` branch in `modeAllowsTool` (recently rewritten in `cb41be9`).
- Delete the `mealLogDraftContext` hidden-context injection block (the block that prepends the draft items to Nora's system prompt when she's in meal_log mode).

`app/api/chat/messages/route.ts`:
- Delete the `mealLogDraftEntryId` extraction block (around line 351) — the side-channel that pulled `entry_id:` out of `hidden_context` to stamp on the rows.
- Keep the `if (approveAction === "meal_log") { executeCommitMealLog(...) }` intercept around line 447. That's the `/coach`-default-mode approval flow, not meal-sheet-specific.

`app/profile/coach-prompts/page.tsx`:
- Remove any `mode='meal_log'` override in the prompt-preview UI. Per the explorer's audit, there's a `modeOverride` reference around line 80 that surfaces the meal-log composed prompt for inspection; with `NORA_MEAL_LOG_PROMPT` gone, that branch becomes a "no override" case.

### Endpoint kept-but-orphaned

`app/api/food/parse/route.ts` becomes unused (its only callers were `parseNewMeal` and `parseAppend` in the deleted chat tab). Two valid moves:

- **Kept (recommended):** leave the endpoint deployed. Cost is near-zero (a route handler that nobody calls), and it's a defensible fallback if we later want a small inline "quick add free text" affordance without rebuilding the route.
- Delete: marginally cleaner. Adds a small risk that the GLP-1-aware nutrition coach context or some other consumer we forgot starts 404'ing.

Default: keep. Revisit deletion at the end of the next clean-up arc.

The `propose_meal_log` / `commit_meal_log` tools in `lib/coach/tools.ts` stay entirely. They're still allowed in default-mode chat (see `modeAllowsTool` lines 344-345) and `executeCommitMealLog` is still called via the `[approve:<token>]` intercept in the chat-messages route.

### Data model

No schema changes. No migration.

`chat_messages` rows with `kind='meal_log'` already in the DB stay where they are. No reader will hit them after `MealLoggerChatTab` is gone; they cost storage and nothing else. The `chat_messages_kind_check` constraint still includes `'meal_log'` — leave it so the historical rows remain insertable in a hypothetical restore, and so future arcs can revive the value without a migration if needed.

The `chat_messages.draft_entry_id` column and its index also stay. Same reasoning: free, future-flexible.

### What stays untouched

- `components/log/MealLoggerLibraryTab.tsx` — the LIBRARY tab and all its v1.1 surfaces (favorites, recent, frequent, copy-yesterday's-lunch, history picker).
- `components/log/MealLoggerSearchTab.tsx`, `FoodSearchPicker`, `DraftReview` — the SEARCH tab's components.
- `lib/food/search.ts` — multi-source merge and ranking.
- `/api/food/draft`, `/api/food/commit`, `/api/food/entries/[id]`, `/api/food/barcode`, `/api/food/library`, `/api/food/library/draft`, `/api/food/history`, `/api/food/entries/[id]/copy`, `/api/food/entries/[id]/favorite`, `/api/food/item-favorites`, `/api/food/user-items/*`.
- The MealSlot card and its "+ Copy yesterday's lunch" pill on `/meal`.
- The `/coach` default-mode chat behavior (Nora can still propose/commit meals there if a user actually asks).
- `/api/food/parse` endpoint (kept-but-orphaned per the above).
- All `propose_meal_log` / `commit_meal_log` tool plumbing.

### Sub-decisions

| Question | My call | Reasoning |
|---|---|---|
| Tab labels | "Add food" / "Library" | Verb-based, plain language. "SEARCH" / "LIBRARY" are technical caps that reveal the implementation. |
| Multi-item entry ("eggs, toast, coffee") in one go | Out of scope. Add items one at a time via SEARCH. | MFP/Yazio don't have batch parse. The perceived benefit of batch entry is dominated by the actual cost of "AI got the items wrong, fix them." |
| AI photo / voice | Out of scope, separate spec | Different complexity envelope. |
| Edamam/FatSecret/Nutritionix | Out of scope; resurface after ~2 weeks of real SEARCH-primary use if coverage gaps remain | Don't pre-pay for data we may not need once the affordance is right. |
| Historical `meal_log` chat rows | No backfill, no migration | Orphaned but harmless. |
| `/api/food/parse` route | Kept | Near-zero cost; defensible future fallback. |
| Default tab when sheet opens to a specific meal slot | "Add food" always | Consistent. The LIBRARY tab is one tap away if the user has saved meals. |
| Add a recent-foods strip to SEARCH | Out of scope this arc | LIBRARY tab already exposes Favorites/Recent/Frequent. Adding a third surface duplicates without simplifying. |

## Verification

`npm run typecheck` clean.

Smoke (manual, no automated tests in this project):

1. Open `/meal` → tap **+** on Lunch. Sheet opens with **Add food** selected (not CHAT, not LIBRARY).
2. Type "basmati" in the search box. Within ~300 ms, see a ranked candidate list merged from your library + the local DB cache + USDA Foundation/SR Legacy + Open Food Facts. Even if USDA has no dedicated basmati entry, OFF returns branded basmati products and the picker shows them. Pick any one — no LLM-auto-resolution between you and the entry.
3. Tap one. Quantity input appears with 100g default + preset chips. Tap 150g → Add.
4. Pick a second item (e.g. "grilled chicken breast" → Add 200g).
5. Tap **Review (2 items)**. Draft summary appears. Tap **Log**.
6. Sheet closes. Lunch row on `/meal` reflects the committed meal.
7. Open `/meal` again. The CHAT tab is gone (only **Add food** and **Library** visible).
8. Open `/coach`. Send a message like "I had a banana" to Nora. She still proposes and commits the meal via the existing default-mode flow (this confirms we didn't accidentally break the `/coach` Nora path while ripping out the meal-sheet one).

Audit script update (proposed, not required this arc): `scripts/audit-meal-logging-resolve.mjs` currently exercises the chat-side resolve path. Either repoint it at `/api/food/search` (the SEARCH-tab path), or retire it. Out of scope here; mentioned for completeness.

## Risks

1. **Muscle-memory regression.** You've been using the chat tab; the first few times you reach for the sheet you'll tap where CHAT was. Cost: 1-2 days of mild surprise; benefit: the failure mode that's been frustrating today goes away. Net positive.

2. **Coverage gaps in SEARCH that the chat-tab Nora flow was masking.** If a food genuinely isn't in any of USDA / OFF / your library, SEARCH will return "No matches" — and there's no LLM-estimate fallback there today. Real risk: a few foods will produce "I can't find this." Known specific gap: USDA's search is filtered to Foundation + SR Legacy datasets (per `lib/food/search.ts:139`); USDA Branded is excluded. Most generic / regional / branded items therefore rely on Open Food Facts coverage and the cache. Mitigation: type a closer variant and pick the closest match; save it to library so it short-circuits next time; or — if this becomes a recurring pattern after ~2 weeks of real use — widen the data layer (the deferred Edamam/FatSecret arc, or include USDA Branded in `lib/food/search.ts`).

3. **`/coach` default-mode meal-log path is now harder to test.** With the meal-sheet chat path gone, the only place to exercise `propose_meal_log` / `commit_meal_log` is `/coach`. Coverage is fine — that path was already independent — but the test surface is narrower.

4. **`/api/food/parse` becomes an unmonitored orphan.** Kept-but-orphaned routes can rot. Mitigation: keep an eye out next arc; delete if it's still unused in a month.

## Out of scope (explicit)

- AI photo / voice meal entry.
- Commercial food DB integration.
- Re-ranking / scoring overhaul in `lib/food/search.ts`.
- Backfill or migration of historical `chat_messages` rows.
- Changes to `/coach` default-mode meal-log behavior.
- Changes to the LIBRARY tab.
- Recent-foods strip / favorites-in-search.
- Audit-script repointing.
