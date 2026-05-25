# Meal Logging Chat — Parse-First Flow

**Status:** draft
**Author:** Claude (with Abdelouahed)
**Date:** 2026-05-25
**Related:** [2026-05-21-meal-logging-chat-revamp-design.md](./2026-05-21-meal-logging-chat-revamp-design.md), [2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md](./2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md)

## Problem

In `MealLoggerSheet` → CHAT tab, the pinned draft card (the box with "Wild rice, cooked · 150g … Confirm / Edit / Cancel") routinely drifts out of sync with the conversation. The user types "I had wild rice" → draft = [wild rice]. They then say "I also had basmati rice and carrots." Nora replies with a markdown table claiming both items were added. The draft card still shows only wild rice. Tapping Confirm logs the wrong meal.

The user lives this as: many back-and-forths with Nora before the card matches reality, and no confidence that "she said it's done" actually committed anything.

### Root cause

The draft card is backed by a `food_log_entries` row with `status='draft'`. The only path that mutates that row from chat is `pick_library_item`, which replaces one item by index. Nora has no tool in `mode='meal_log'` that takes free text like "and carrots" and appends parsed items to the draft. Her remaining options are:

- `propose_meal_log` — creates a *new* approval token + chip; does not touch the active draft row.
- Narrate the change in prose without any tool call — pure hallucination from the card's perspective.

The UI re-fetches the draft via `refetchDraft(id)` only on a successful `pick_library_item` tool completion ([components/log/MealLoggerChatTab.tsx](../../../components/log/MealLoggerChatTab.tsx)). So even if Nora calls `propose_meal_log` with a hallucinated full items list, the pinned card does not refresh.

### Evidence

- Draft card data path: [components/log/MealLoggerPreviewCard.tsx:20-124](../../../components/log/MealLoggerPreviewCard.tsx) reads from the `drafts` map in [MealLoggerChatTab.tsx:95](../../../components/log/MealLoggerChatTab.tsx).
- `refetchDraft` trigger set: [MealLoggerChatTab.tsx:278-287](../../../components/log/MealLoggerChatTab.tsx) — wired exclusively to `tool_call_done` for `pick_library_item`.
- `meal_log` toolset gating: [lib/coach/chat-stream.ts:296-351](../../../lib/coach/chat-stream.ts) — six tools, none of which accept free text + an entry id and append items to it.
- Parser entry point: [app/api/food/parse/route.ts:21-99](../../../app/api/food/parse/route.ts) — always creates a new draft row; no append branch.

## Goals

- Every additive user message in the meal chat updates the pinned draft card deterministically, server-side, before any Nora text streams.
- Eliminate the Nora-as-orchestrator failure surface for the common case of adding items to an in-progress meal.
- Keep the conversational experience: ambiguity prompts and library suggestions still come from Nora when the resolver needs help.

## Non-goals

- Changing default-mode `/coach` chat. `log_meal_entry` remains the one-shot path there, and Nora's role is unchanged outside the meal sheet.
- In-chat edit/remove operations. Modifying or removing items in the draft is owned by the Edit button on the card.
- Restart-intent detection. The "+ New meal (cancels current draft)" link is the explicit reset.
- Deduplicating same-named items across messages. Visible duplicates are obvious on the card; the Edit sheet fixes them.
- SEARCH / LIBRARY tabs, the Edit sheet, and the Confirm/Cancel endpoints. All unchanged.

## Design

### Message dispatch rule

When the user sends a text message in the CHAT tab:

```
on send(text, draft):
  if draft is null:                       # first message of a new meal
    POST /api/food/parse { text }         # existing behavior: create draft
    if needs_clarification: stream Nora
    return

  POST /api/food/parse { text, append_to_entry_id: draft.id }
  if response.appended.length >= 1:
    refetchDraft(draft.id)                # card updates immediately
    if response.needs_clarification:
      stream Nora with hidden_context = { new_items, full_items }
    else:
      no Nora invocation — silent append, card update is the receipt
    return

  # parser extracted 0 items → message is a question or clarification answer
  stream Nora with hidden_context = { full_items }     # existing path
```

The `needs_clarification` flag in the response is the same boolean the parser already returns today — it is true when any item in the parse round is low or medium confidence. The append branch computes it over the freshly-appended items only, not the cumulative draft.

### `/api/food/parse` — append branch

Add optional `append_to_entry_id: string` to the request schema.

When present:

1. Skip the "insert new `food_log_entries` row" branch entirely.
2. Run `extractItems(text)` + `resolveItemMacros(name, qty_g)` per extracted item, exactly as today.
3. Load the target row, validate it belongs to the authed user AND has `status='draft'` (reject 4xx otherwise).
4. Concatenate the new items into `food_log_entries.items[]`.
5. Recompute row-level totals (kcal, P, C, F, fiber) from the merged items via `macrosForQty` (the same primitive the rest of the pipeline uses).
6. Persist.
7. Response extends the existing parse response: adds `appended: ResolvedItem[]` (new items only — lets the client log/inspect what was added without diffing the cumulative items list) and `entry` reflects the updated row. `needs_clarification` is already returned today and is reused — see the dispatch rule above for how its scope changes in the append branch.

The non-append path is byte-for-byte unchanged.

### UI: extend `refetchDraft` trigger set

`MealLoggerChatTab` already owns the `drafts` map and the refetch helper. Add one more trigger:

- After a successful POST to `/api/food/parse` with `append_to_entry_id`, regardless of whether Nora is invoked: `refetchDraft(draft.id)`.

This is one additional call site, not a new mechanism. The existing `tool_call_done` → `refetchDraft` wiring for `pick_library_item` stays.

### Nora's role shrinks (prompt + tool emphasis)

The `meal_log`-mode toolset stays the same. The prompt (in [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) — Nora's base + the meal-log mode supplement) changes:

- Default closing line changes from "Tap **Approve** to log it." to "Tap **Confirm** on the meal card." The card's Confirm button is now the canonical commit path inside the meal sheet.
- Nora is told that additive item extraction happens server-side before she sees the message. Her job is: answer questions about already-resolved items, clarify low-confidence picks via `pick_library_item`, propose `save_to_library` when the user nominates a recipe.
- She is told not to call `propose_meal_log` inside the meal sheet — the draft + Confirm button supersede it. The tool stays available (still load-bearing in default-mode `/coach`) but the prompt steers away from it in `mode='meal_log'`.

`propose_meal_log` and `commit_meal_log` are not removed in this arc. Removing them is out of scope and would touch the default-mode `/coach` flow.

### Sub-decisions

| Question | Resolution | Reasoning |
|---|---|---|
| Edits ("change rice to 200g", "remove the carrots") in chat | Out of scope. Use the Edit button on the card. | Append-only chat is a clean mental model. Edit sheet is one tap away and already exists. |
| Duplicate name detection within a draft | None. Append blindly. | Heuristic dedup misfires more than it helps; the visible card surfaces duplicates immediately. |
| "Let me start over" intent | None. Explicit "+ New meal (cancels current draft)" link. | Already on screen, already labeled. Phrase-matching restart intent is fragile. |
| User typing "yes" / "ok" after a Nora question | Parser returns 0 items → falls through to existing Nora-reply path. | No special-case routing needed. |
| First user message of a new meal (no draft yet) | Unchanged. `/api/food/parse` creates the draft; Nora invoked only if low-confidence. | The bug is on subsequent messages; first-message flow is fine. |
| What if user types in `/coach` default mode about a meal | Unchanged. Default-mode chat uses `log_meal_entry` to write committed entries; no draft model there. | Different surface, different ergonomic. |

## Data model

No schema changes. `food_log_entries.items` is already a jsonb array; the append branch mutates it in place. `status='draft'` continues to gate which rows can be edited.

No new migration.

## API surface

| Endpoint | Change |
|---|---|
| `POST /api/food/parse` | Add optional `append_to_entry_id: string`. New response field `appended: ResolvedItem[]`. Unchanged when omitted. |
| `POST /api/food/commit` | None. |
| `DELETE /api/food/entries/[id]` | None. |
| `POST /api/chat/messages` (mode=meal_log) | None at the route level. Prompt change only. |

## Failure modes addressed

- **Draft lags conversation.** Gone — the card refreshes from a deterministic server response before Nora ever streams.
- **Nora narrates phantom appends.** Gone for the additive path — Nora is not in the loop when the parser succeeds with high confidence.
- **Wrong tool selection** ("she called `propose_meal_log` instead of mutating the draft"). Gone for additive messages — no tool selection happens.
- **Tool-call cap hit on long meals.** Reduced — additive turns no longer consume Nora's tool budget at all.

## Failure modes accepted

- Duplicate item names if the user re-states a food. Mitigated by the visible card and the Edit sheet.
- Append-only chat semantics mean small edits ("nope, 200g not 150g") require switching to the Edit sheet. Acceptable trade for the predictability of "every message extends, nothing else."
- If the parser hallucinates an item from a non-food message ("thanks!"), we'd append nonsense to the draft. Mitigated by `extractItems`'s existing structured-output behavior — it returns an empty array when nothing food-like is present. Worth monitoring in the audit pass.

## Verification

Manual smoke (the failure mode that prompted this spec):

1. Open `/meal`, tap + on Lunch → CHAT tab.
2. Type "wild rice, 150g". Draft card shows [Wild rice 150g].
3. Type "and basmati rice and carrots". Within one round-trip the draft card shows [Wild rice 150g, Basmati rice ~150g, Carrots ~100g]. No Nora narration in between (unless basmati or carrots are flagged low-confidence — in which case her message is the clarification, not a claim of having appended).
4. Tap Confirm. `food_log_entries` row commits with all three items. `daily_logs.calories_eaten` and friends update via `sum_food_entries`.

Audit script extension (proposed, not part of this spec's deliverables): extend `scripts/audit-meal-logging-resolve.mjs` to assert that for every `food_log_entries` row with `status='committed'`, the items list matches the sum of `appended` slices implied by the message history. Out of scope for this design; mentioned as a follow-up.

## Out of scope (explicit)

- Default-mode `/coach` chat behavior.
- `propose_meal_log` / `commit_meal_log` tool removal.
- SEARCH / LIBRARY tab behavior in `MealLoggerSheet`.
- The Edit sheet UI.
- Audit script extension.
- Photo and voice modalities (covered by their own specs).
