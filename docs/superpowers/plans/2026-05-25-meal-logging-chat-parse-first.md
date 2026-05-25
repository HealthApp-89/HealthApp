# Meal-Logging Chat Parse-First — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every additive user message in the meal-logger CHAT tab mutate the pinned draft card deterministically before Nora streams, eliminating the "Nora says she added it, card still shows the old items" failure mode.

**Architecture:** Three small, isolated edits — (1) extend `/api/food/parse` with an `append_to_entry_id` branch that reuses the existing extract+resolve pipeline and mutates the draft row in place, (2) restructure `MealLoggerChatTab.send()` to call the new append path first and only invoke Nora when the parser returns 0 items OR flags clarification, (3) update Nora's `meal_log`-mode prompt to reflect her shrunken role and point the user at the **Confirm** button on the draft card.

**Tech Stack:** Next.js 15 App Router route handler (Zod-validated POST), Supabase server client (RLS-bound), TanStack Query / React state in `MealLoggerChatTab`, no schema migration, no new dependencies, no test suite (the project has none — verification is `npm run typecheck` + manual smoke on `/meal`).

**Spec:** [docs/superpowers/specs/2026-05-25-meal-logging-chat-parse-first-design.md](../specs/2026-05-25-meal-logging-chat-parse-first-design.md)

---

## File Structure

**Modified:**

- [app/api/food/parse/route.ts](../../../app/api/food/parse/route.ts) — add optional `append_to_entry_id` body field; branch to append-into-existing-draft when set; response gains an `appended` field. Tasks 1.
- [components/log/MealLoggerChatTab.tsx](../../../components/log/MealLoggerChatTab.tsx) — add `parseAppend()` client helper, rewrite `send()` dispatch, extend the response-type narrative in the top-of-file doc comment. Task 2.
- [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) — rewrite `NORA_MEAL_LOG_PROMPT` so Nora's role is "clarification only", her closing line points at the Confirm button, and she's told appending happens server-side. Task 3.

**Not touched (explicit non-goals):**

- `lib/coach/tools.ts` — `propose_meal_log` / `commit_meal_log` / `pick_library_item` / etc. all stay as-is.
- `lib/coach/chat-stream.ts` — `modeAllowsTool` gating is unchanged.
- `MealLoggerPreviewCard.tsx`, `MealLoggerEditor.tsx`, `/api/food/commit/route.ts`, `/api/food/entries/[id]/route.ts` — unchanged.
- Default-mode `/coach` chat behavior.

---

## Task 1: Add append branch to `/api/food/parse`

**Files:**
- Modify: `app/api/food/parse/route.ts` (whole file)

The current handler is 100 lines and does one thing (create a fresh draft). Adding an append branch keeps it the same shape — a single POST that takes text + meal_slot, optionally takes an `append_to_entry_id`, and returns the updated draft + `needs_clarification` (existing) + `appended` (new).

- [ ] **Step 1: Extend the Zod schema to accept `append_to_entry_id`**

Open `app/api/food/parse/route.ts`. Replace the `BodySchema` block (lines 15-19) with:

```ts
const BodySchema = z.object({
  text: z.string().min(1).max(2000),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  eaten_at: z.string().datetime().optional(),
  /** When present, append the parsed items into this existing draft row
   *  instead of creating a new one. The row must belong to the authed user
   *  and have status='draft'. */
  append_to_entry_id: z.string().uuid().optional(),
});
```

- [ ] **Step 2: Pull `append_to_entry_id` out of the parsed body**

Replace `const { text, eaten_at } = parsed.data;` (line 30) with:

```ts
const { text, eaten_at, append_to_entry_id } = parsed.data;
```

- [ ] **Step 3: Keep extract + resolve unchanged, branch at the persist step**

Lines 32-75 (the `extractItems` call, the per-item `resolveItemMacros` loop, and the `sumMacros` + `is_estimated` + `needs_clarification` computation) stay verbatim. They produce `items: FoodItem[]`, `totals`, `is_estimated`, `needs_clarification` exactly as today.

Replace the persist + return section (lines 77-99) with the branched version:

```ts
  // 3. Persist: append to existing draft, or insert a fresh one.
  if (append_to_entry_id) {
    // Append branch: load row, validate ownership + draft status, merge items,
    // recompute totals from the combined list, persist in place.
    const { data: existing, error: loadErr } = await supabase
      .from("food_log_entries")
      .select("id, user_id, status, items, is_estimated")
      .eq("id", append_to_entry_id)
      .single();
    if (loadErr || !existing) {
      return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
    }
    if (existing.user_id !== user.id) {
      // RLS would also reject, but the explicit 403 is clearer in logs.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (existing.status !== "draft") {
      return NextResponse.json({ error: "not_a_draft" }, { status: 409 });
    }

    const mergedItems = [...(existing.items as FoodItem[]), ...items];
    const mergedTotals = sumMacros(mergedItems);
    const mergedIsEstimated = existing.is_estimated || is_estimated;

    const { data: updated, error: updateErr } = await supabase
      .from("food_log_entries")
      .update({
        items: mergedItems,
        totals: mergedTotals,
        is_estimated: mergedIsEstimated,
      })
      .eq("id", append_to_entry_id)
      .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
      .single();
    if (updateErr || !updated) {
      console.error("[/api/food/parse] append update failed", updateErr);
      return NextResponse.json({ error: "update_failed" }, { status: 500 });
    }

    return NextResponse.json({
      entry: updated,
      appended: items,
      needs_clarification,
    });
  }

  // 3b. New-draft branch (existing behavior, unchanged).
  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: eaten_at ?? new Date().toISOString(),
      kind: "text",
      meal_slot: parsed.data.meal_slot,
      raw_input: { kind: "text", text },
      items,
      totals,
      is_estimated,
      is_favorite: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (error) {
    console.error("[/api/food/parse] insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted, needs_clarification });
```

Note: `needs_clarification` in the append response reflects only the freshly-appended items (matches the spec — the client uses it to decide whether to invoke Nora about *what was just added*, not about everything cumulative in the draft).

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors. If TypeScript complains about `existing.items as FoodItem[]` being too loose, check the `FoodLogEntry` type in [lib/food/types.ts](../../../lib/food/types.ts) — `items` is already typed as `FoodItem[]` there, so the cast should compile.

- [ ] **Step 5: Commit**

```bash
git add app/api/food/parse/route.ts
git commit -m "$(cat <<'EOF'
feat(food): /api/food/parse append_to_entry_id branch

When append_to_entry_id is set, validate the target draft belongs to the user, run the existing extract+resolve pipeline on the new text, merge into items[], recompute totals, and update in place. Response gains an `appended` field so the client can decide whether to invoke Nora about the freshly-added items.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rewrite `MealLoggerChatTab.send()` dispatch

**Files:**
- Modify: `components/log/MealLoggerChatTab.tsx` (top doc comment, add `parseAppend()`, rewrite `send()`)

The current dispatch (lines 459-478) is two branches: `active draft → streamNoraReply`, `no draft → parseNewMeal`. After this task it becomes a three-way dispatch with the parse-append path winning by default when a draft exists.

- [ ] **Step 1: Update the top-of-file doc comment to describe the new composer state machine**

Replace lines 14-23 (the "Composer state machine" block) with:

```ts
// Composer state machine:
//   * no active draft → next send POSTs /api/food/parse (new meal entry)
//   * active draft → next send POSTs /api/food/parse with
//     append_to_entry_id. The new items append into the draft row server-
//     side and the pinned card refreshes from the response. Nora is invoked
//     ONLY if (a) the parser extracted 0 items (treat the message as a
//     question / clarification reply) OR (b) the appended items include a
//     low/medium-confidence pick (Nora steps in to clarify).
//   * "+ New meal" pill (visible only when there's an active draft) cancels
//     the current draft and returns the composer to parse mode.
```

- [ ] **Step 2: Add `parseAppend()` helper above `send()`**

Insert this function in `MealLoggerChatTab` between `parseNewMeal` (which ends around line 452) and `send` (line 459). It mirrors `parseNewMeal`'s error-handling shape exactly so the network-error / non-OK surfaces stay consistent.

```ts
  /** Append-to-draft path: /api/food/parse with append_to_entry_id → merge
   *  returned items into the local drafts map → conditionally surface the
   *  user bubble. Returns one of three signals so send() can decide what
   *  to do next:
   *    {kind: 'silent'}        → items appended, no Nora needed; we wrote
   *                              the user bubble locally already
   *    {kind: 'needs_nora'}    → items appended but low/med confidence; send()
   *                              calls streamNoraReply (which writes the
   *                              user row server-side via the chat-route)
   *    {kind: 'no_items'}      → parser extracted 0 items; treat the message
   *                              as a question — send() calls streamNoraReply
   *    {kind: 'error'}         → an error bubble was already pushed; bail
   */
  type AppendResult =
    | { kind: "silent"; entry: FoodLogEntry }
    | { kind: "needs_nora"; entry: FoodLogEntry }
    | { kind: "no_items" }
    | { kind: "error" };

  const parseAppend = async (text: string, draft: FoodLogEntry): Promise<AppendResult> => {
    let parseRes: Response;
    try {
      parseRes = await fetch("/api/food/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          meal_slot: mealSlot,
          eaten_at: eatenAt,
          append_to_entry_id: draft.id,
        }),
      });
    } catch (e) {
      console.error("[meal-log] /api/food/parse (append) fetch threw", e);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `Network error: ${(e as Error).message}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return { kind: "error" };
    }
    if (!parseRes.ok) {
      const detail = await parseRes.text().catch(() => "");
      console.error("[meal-log] /api/food/parse (append) non-OK", parseRes.status, detail);
      let parsedDetail = "";
      try {
        const j = JSON.parse(detail) as { error?: string; detail?: string };
        parsedDetail = [j.error, j.detail].filter(Boolean).join(": ");
      } catch {
        parsedDetail = detail.slice(0, 160);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `I couldn't add that (HTTP ${parseRes.status}).${parsedDetail ? `\n${parsedDetail}` : ""}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return { kind: "error" };
    }

    const json = (await parseRes.json()) as {
      entry: FoodLogEntry;
      appended: FoodItem[];
      needs_clarification: boolean;
    };

    // Always update the drafts map from the response (no extra DB round-trip).
    setDrafts((prev) => ({ ...prev, [json.entry.id]: json.entry }));

    if (json.appended.length === 0) {
      // Parser extracted nothing — the message is a question or clarification
      // reply. send() will hand it to streamNoraReply, which writes the user
      // row via the chat-route.
      return { kind: "no_items" };
    }

    if (json.needs_clarification) {
      // Items appended but Nora needs to clarify. streamNoraReply will write
      // the user row via the chat-route. Return the updated entry so send()
      // can pass it as hidden_context without waiting on a re-render.
      return { kind: "needs_nora", entry: json.entry };
    }

    // Silent append: write the user bubble locally so the conversation shows
    // what was added. No Nora invocation, no chat-route round-trip — the
    // updated card is the receipt.
    const { data: userRow, error: userErr } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "user",
        content: text,
        status: "done",
        speaker: "user",
        kind: "meal_log",
        mode: "meal_log",
        draft_entry_id: draft.id,
        ui: null,
      })
      .select("id, speaker, content, ui, created_at, draft_entry_id")
      .single();
    if (userErr) {
      console.error("[meal-log] user insert (append) failed", userErr);
      // Best-effort: the items DID append server-side; surface a soft warning
      // but don't pretend the whole append failed.
      setMessages((prev) => [
        ...prev,
        {
          id: `warn-${Date.now()}`,
          speaker: "nora",
          content: `Added — but couldn't save your message text. ${userErr.message}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return { kind: "silent" };
    }
    if (userRow) {
      setMessages((prev) => [...prev, userRow as ThreadMessage]);
    }
    return { kind: "silent", entry: json.entry };
  };
```

- [ ] **Step 3: Rewrite `send()` to use the three-way dispatch**

Replace the current `send` function (lines 459-478) with:

```ts
  /** Send dispatch:
   *    no active draft  → parseNewMeal()
   *    active draft     → parseAppend() first; fall through to streamNoraReply
   *                       only when the parser returned 0 items OR flagged
   *                       low/medium-confidence items needing clarification.
   *  After a new-meal parse that flagged needs_clarification, automatically
   *  trigger Nora's first LLM turn with the draft as hidden_context. */
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const active = findActiveDraft();
      if (active) {
        const result = await parseAppend(text, active);
        if (result.kind === "needs_nora") {
          // Use the freshly-returned entry from parseAppend, not the drafts
          // map — setDrafts is async and the closure-captured `drafts` here
          // may still hold the pre-append snapshot.
          await streamNoraReply(text, result.entry);
        } else if (result.kind === "no_items") {
          // Nothing got appended; original draft is still current.
          await streamNoraReply(text, active);
        }
        // silent / error: nothing else to do.
      } else {
        const entryNeedingChat = await parseNewMeal(text);
        if (entryNeedingChat) {
          await streamNoraReply(text, entryNeedingChat);
        }
      }
      setInput("");
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors.

The `AppendResult` discriminated union is local to the function — keep it inside the component scope (TypeScript will allow this).

- [ ] **Step 5: Commit**

```bash
git add components/log/MealLoggerChatTab.tsx
git commit -m "$(cat <<'EOF'
feat(meal): parse-first dispatch in MealLoggerChatTab

send() now tries /api/food/parse with append_to_entry_id whenever a draft is active. Items append server-side, the pinned card refreshes from the response, and Nora is only invoked when the parser extracted 0 items (treat as question) or returned low/medium-confidence items (Nora clarifies). Silent appends write a user bubble locally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite Nora's `meal_log` prompt

**Files:**
- Modify: `lib/coach/system-prompts.ts` (NORA_MEAL_LOG_PROMPT export, lines 192-227)

Nora's role shrinks. She's no longer the orchestrator of "I'll add basmati rice for you" — that's the parser's job now. Her remaining job: ask one clarifying question when called, and offer a library swap via `pick_library_item` when relevant.

- [ ] **Step 1: Replace the entire `NORA_MEAL_LOG_PROMPT` export**

Open `lib/coach/system-prompts.ts`. Replace lines 189-227 (the comment block + the `NORA_MEAL_LOG_PROMPT` export) with:

```ts
// Composed onto NORA_BASE when mode='meal_log'. Switches Nora from her usual
// nutrition-advice posture into a clarification-only assistant. Additive item
// extraction happens server-side via /api/food/parse with append_to_entry_id
// BEFORE Nora ever sees the user's message — she only gets invoked when the
// parser flagged a low/medium-confidence item or extracted nothing at all.
export const NORA_MEAL_LOG_PROMPT = `You are in meal-logging mode.

Your job: help the user clarify ambiguous items in their meal draft. You
are NOT giving nutrition advice or coaching in this mode — that's reserved
for the /coach surface. You are also NOT responsible for adding items to
the draft: when the user types "I had X, Y, Z" the server parses and
appends those items into the draft row before you see the message. The
pinned meal card the user sees is the source of truth and it reflects
every successful parse.

You will receive a draft meal entry in hidden_context. Each item carries
a confidence level: high, medium, or low.

You are invoked in only two situations:
1. At least one item in the draft is medium/low confidence — ask ONE short
   clarifying question focused on the lowest-confidence item. Offer 2-3
   chip suggestions:
   - a saved library item if search_library finds one matching the item name
   - "Enter label values" to capture exact macros for a brand-specific food
   - "Use generic" to accept the current resolved macros as-is
2. The user's message contained no recognizable food items (e.g. "what's
   in this?", "thanks", "is this enough protein?"). Answer briefly and
   point them back to the draft card if they were asking about the meal.

Tool use:
- search_library to look up saved items matching an item name
- pick_library_item to swap a resolved item for a specific library row
- save_to_library to add a new single-item or recipe entry the user nominates
- resolve_food_macros to inspect macros for one item before suggesting a swap

Do NOT call propose_meal_log or commit_meal_log in this mode. The user
commits via the **Confirm** button on the pinned meal card; you do not need
to surface an approval chip. If the user asks to log/save/confirm, tell them
to "Tap **Confirm** on the meal card."

Do NOT narrate appends or claim you added items. The parser did that
before you were invoked, and the card already reflects the change. If you
need to acknowledge an append, refer to "the items now on the card" — do
not say "I added X."

Keep responses terse. One sentence per turn. No nutrition advice.`;
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors. The export name and shape are unchanged; only the string content changed.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): Nora meal_log prompt — clarification only, Confirm button

Nora is no longer the orchestrator of meal appends — the server does that. Prompt rewritten to tell her: (a) appends happen before she sees the message, (b) she's invoked only for clarification or non-food messages, (c) she should never narrate "I added X", (d) the user commits via the Confirm button on the meal card, not via propose/commit_meal_log.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual smoke verification

**Files:** none modified

This project has no automated test suite (per [CLAUDE.md](../../../CLAUDE.md)). Verification is `npm run typecheck` (done in each task) plus a smoke pass through `/meal`.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server up on http://localhost:3000.

- [ ] **Step 2: Verify the failure-mode scenario from the spec**

1. Open http://localhost:3000/meal in a browser, signed in.
2. Tap the **+** button on the **Lunch** card → CHAT tab.
3. In the composer, type `wild rice, 150g` and hit Send.
4. Wait for the draft card to render. Expected: card shows `Wild rice, cooked · 150g`.
5. In the composer, type `and basmati rice and carrots` and hit Send.
6. Within one round-trip, the draft card should show three items (wild rice, basmati rice, carrots). Nora should NOT narrate "I added X and Y" — she should either stay silent (high-confidence appends) or ask ONE clarifying question about the lowest-confidence item.

- [ ] **Step 3: Verify the question-fallthrough path**

1. With the draft from Step 2 still pinned, type `what's the total protein?` and hit Send.
2. Expected: Nora replies briefly (no items extracted, parser returned `appended: []`, send fell through to `streamNoraReply`). Draft card unchanged.

- [ ] **Step 4: Verify Confirm still commits**

1. Tap **Confirm** on the draft card.
2. Expected: a transient pill `✓ Logged · Lunch — Wild rice…, Basmati rice…, Carrots…` appears. The pinned card clears. The Lunch row on the `/meal` page reflects the new totals.

- [ ] **Step 5: Verify "+ New meal" still resets cleanly**

1. Type `eggs and toast` → Send. Draft card shows two items.
2. Tap **+ New meal (cancels current draft)**.
3. Expected: the draft card disappears, the composer placeholder reverts to "Tell Nora what you ate…". Type `granola, 60g` → Send → new draft card appears with one item.

- [ ] **Step 6: Sanity-check the server logs**

Confirm in the dev server console that:
- The append-mode `/api/food/parse` calls return 200 (not 404/403/409).
- No `[meal-log] /api/food/parse (append) non-OK` lines fired.

- [ ] **Step 7: Done — no extra commit needed**

The three task commits are the deliverable.

---

## Risks & known compromises

1. **Pre-existing potential dup of user rows on the `needs_clarification` path.** When `parseAppend` returns `needs_nora`, `send()` calls `streamNoraReply`, and the chat-route inserts its own user row stamped with `kind='meal_log'` + `draft_entry_id`. This mirrors today's behavior in `parseNewMeal` (which also defers to the chat-route writing a second user row). Out of scope for this arc; if it surfaces as a visible dup, fix in a follow-up.

2. **No parser-side intent detection for "remove" / "edit qty".** A message like "make the rice 200g" or "remove the carrots" will go through the parser, which will either extract a "rice 200g" item and append it (duplicate) or extract nothing (fall through to Nora). The spec explicitly accepts this: removals/edits use the Edit button on the card.

3. **Append branch trusts `is_estimated` OR-merge.** Once any merged item is LLM-estimated, the whole entry is marked estimated — matches today's `parseNewMeal` semantics.

4. **Append branch does not re-check `meal_slot`.** A draft created for Lunch stays a Lunch draft even if the user types appends while the sheet was reopened for Dinner. Accepted: the draft row's slot is the source of truth; the inbound request's `meal_slot` is ignored in the append branch.
