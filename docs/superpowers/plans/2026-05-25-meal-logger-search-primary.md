# Meal Logger SEARCH-Primary, CHAT-Removed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the meal-logger CHAT tab and its Nora-in-meal-sheet plumbing; make SEARCH the default (and now only entry-by-name) tab in `MealLoggerSheet`.

**Architecture:** Surgical deletion. SEARCH and LIBRARY tabs are unchanged. CHAT tab + its three component files + the `meal_log` mode plumbing across `lib/coach/system-prompts.ts`, `lib/coach/chat-stream.ts`, `app/api/chat/messages/route.ts`, and `app/profile/coach-prompts/page.tsx` are deleted. `propose_meal_log` / `commit_meal_log` tools stay (still used in `/coach` default-mode chat). No schema migration.

**Tech Stack:** Next.js 15 App Router, React Client Components, TypeScript strict mode. No tests (project has no test suite per CLAUDE.md); verification is `npm run typecheck` per task + manual smoke on `/meal` at the end.

**Spec:** [docs/superpowers/specs/2026-05-25-meal-logger-search-primary-design.md](../specs/2026-05-25-meal-logger-search-primary-design.md)

---

## File Structure

**Modified:**
- `components/log/MealLoggerSheet.tsx` — drop "chat" tab, default to "search", rename tab labels (Task 1).
- `app/profile/coach-prompts/page.tsx` — drop the `NORA_MEAL_LOG_PROMPT` import + Nora's `modeOverride` block (Task 3).
- `lib/coach/system-prompts.ts` — delete `NORA_MEAL_LOG_PROMPT` export + the `meal_log` branch in `speakerSystemPromptForMode` (Task 4).
- `app/api/chat/messages/route.ts` — drop `body.mode === "meal_log"` from the mode validator, drop the `mealLogDraftEntryId` extraction, drop the `meal_log` stamp branch, drop the `mealLogDraftContext` arg passed to `runChatStream` (Task 5).
- `lib/coach/chat-stream.ts` — drop the `meal_log` branch in `modeAllowsTool`, drop the `mealLogDraftContext` injection block, drop `mealLogDraftContext` from `RunChatStreamOpts`, update the stale `meal_log` mention in the `webSearchAllowedForMode` comment (Task 6).

**Deleted (whole-file):**
- `components/log/MealLoggerChatTab.tsx`
- `components/log/MealLoggerPreviewCard.tsx`
- `components/log/MealLoggerEditor.tsx`

**Unchanged (do not touch):**
- `components/log/MealLoggerSearchTab.tsx`, `components/log/MealLoggerLibraryTab.tsx`, `components/log/FoodSearchPicker.tsx`, `components/log/DraftReview.tsx`, `components/log/HistoryPickerSheet.tsx`.
- `lib/food/search.ts`, `lib/food/lookup.ts`, `lib/food/parse.ts`.
- `app/api/food/parse/route.ts` (orphaned-but-deployed per spec).
- `lib/coach/tools.ts` — `propose_meal_log` / `commit_meal_log` tool definitions stay.
- `chat_messages` table, `chat_messages_kind_check` constraint, `chat_messages.draft_entry_id` column — no schema migration.
- `app/api/chat/messages/route.ts` around line 447: the `if (approveAction === "meal_log")` approval-token intercept stays (used by `/coach` default-mode).

---

## Task 1: Promote SEARCH to default + rename tabs

**Files:**
- Modify: `components/log/MealLoggerSheet.tsx`

- [ ] **Step 1: Replace the Tab union, the initial useState value, and the tab bar render**

Open `components/log/MealLoggerSheet.tsx`.

Replace line 12:

```ts
type Tab = "chat" | "search" | "library";
```

with:

```ts
type Tab = "search" | "library";
```

Replace line 27:

```ts
  const [tab, setTab] = useState<Tab>("chat");
```

with:

```ts
  const [tab, setTab] = useState<Tab>("search");
```

Replace the tab-bar block (lines 57-70):

```tsx
        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
          {(["chat", "search", "library"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs uppercase tracking-wider ${
                tab === t ? "text-zinc-100 border-b-2 border-zinc-100" : "text-zinc-500"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
```

with:

```tsx
        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
          {([
            { key: "search", label: "Add food" },
            { key: "library", label: "Library" },
          ] as const).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm ${
                tab === t.key ? "text-zinc-100 border-b-2 border-zinc-100" : "text-zinc-500"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
```

(Two visual changes alongside the structural one: drop `uppercase tracking-wider` because "Add food" reads better in title case, and bump `text-xs` to `text-sm` because there are now two tabs with more horizontal room.)

- [ ] **Step 2: Drop the `MealLoggerChatTab` import and conditional render**

In `components/log/MealLoggerSheet.tsx`:

Delete line 4:

```ts
import { MealLoggerChatTab } from "./MealLoggerChatTab";
```

Delete the `chat` tab render block (lines 72-79):

```tsx
          {tab === "chat" && (
            <MealLoggerChatTab
              userId={userId}
              mealSlot={mealSlot}
              eatenAt={eatenAt}
              onCommitted={onCommitted}
            />
          )}
```

The two remaining render blocks (`tab === "search"` and `tab === "library"`) are unchanged.

- [ ] **Step 3: Update the file-header comment (the "Why" still applies but the tab description doesn't)**

Find any header comment in `MealLoggerSheet.tsx` (currently the file has no top-of-file doc comment — but if there is one referencing "CHAT thread is daily-continuous", drop that line). The `onCommitted` body comment at line 37-39 references the chat thread; replace it:

```tsx
  // Invalidate downstream caches after every commit. Unlike v1.1, do NOT
  // auto-close the sheet — the chat thread is daily-continuous and the user
  // commonly logs multiple meals or makes corrections without leaving.
  const onCommitted = async () => {
```

with:

```tsx
  // Invalidate downstream caches after every commit. Do NOT auto-close —
  // the user often logs several items in one sitting and prefers to stay
  // in the sheet between Confirm taps.
  const onCommitted = async () => {
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors. (The chat-tab component file still exists; we just stopped importing it. Task 2 deletes the file itself.)

- [ ] **Step 5: Commit**

```bash
git add components/log/MealLoggerSheet.tsx
git commit -m "$(cat <<'EOF'
feat(meal): SEARCH-primary tab structure in MealLoggerSheet

Drop the CHAT tab from MealLoggerSheet's tab union, default to SEARCH (now labeled "Add food"), and rename LIBRARY to "Library" with title-case rendering. The MealLoggerChatTab component file still exists; Task 2 deletes it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Delete dead chat-tab component files

**Files:**
- Delete: `components/log/MealLoggerChatTab.tsx`
- Delete: `components/log/MealLoggerPreviewCard.tsx`
- Delete: `components/log/MealLoggerEditor.tsx`

These three files have only one consumer each (`MealLoggerChatTab` is imported only by `MealLoggerSheet` — now removed; `MealLoggerPreviewCard` and `MealLoggerEditor` are imported only by `MealLoggerChatTab`). After Task 1 they're unreferenced.

- [ ] **Step 1: Confirm no remaining consumers**

Run from the repo root:

```bash
grep -rn "MealLoggerChatTab\|MealLoggerPreviewCard\|MealLoggerEditor" components/ app/ lib/ scripts/ 2>/dev/null
```

Expected: only the import lines INSIDE the three files about to be deleted (i.e. `MealLoggerChatTab.tsx` importing `MealLoggerPreviewCard` and `MealLoggerEditor`). No external imports.

If anything else surfaces, STOP and report — there's a consumer we didn't expect.

- [ ] **Step 2: Delete the three files**

```bash
rm components/log/MealLoggerChatTab.tsx
rm components/log/MealLoggerPreviewCard.tsx
rm components/log/MealLoggerEditor.tsx
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add -A components/log/
git commit -m "$(cat <<'EOF'
feat(meal): delete MealLoggerChatTab + PreviewCard + Editor

The three components served the in-sheet Nora chat flow that was producing approximate matches (e.g. basmati → wild rice) and forcing back-and-forth corrections. SEARCH-then-pick (already implemented in MealLoggerSearchTab) replaces them. propose_meal_log / commit_meal_log tools stay; only the meal-sheet chat surface is removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drop Nora's modeOverride from coach-prompts page

**Files:**
- Modify: `app/profile/coach-prompts/page.tsx`

This task must land BEFORE Task 4 (which deletes `NORA_MEAL_LOG_PROMPT`), otherwise the import on line 18 breaks.

- [ ] **Step 1: Drop the `NORA_MEAL_LOG_PROMPT` import**

In `app/profile/coach-prompts/page.tsx`, change the import block (lines 13-20):

```ts
import {
  PETER_BASE,
  CARTER_BASE,
  NORA_BASE,
  REMI_BASE,
  NORA_MEAL_LOG_PROMPT,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
```

to:

```ts
import {
  PETER_BASE,
  CARTER_BASE,
  NORA_BASE,
  REMI_BASE,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
```

- [ ] **Step 2: Drop the `modeOverride` from Nora's entry**

In `app/profile/coach-prompts/page.tsx`, change Nora's COACHES entry (lines 66-79):

```ts
  nora: {
    name: "Nora",
    role: "Nutrition specialist — meals, macros, GLP-1 phase awareness",
    base: NORA_BASE,
    voiceSummary:
      "Grams, kcal, ratios. Reads the food log liberally to ground advice in actual items rather than guessing.",
    tools: NORA_TOOLS,
    dailyLogsCols: NORA_COLS,
    modeOverride: {
      mode: "meal_log",
      addendum: NORA_MEAL_LOG_PROMPT,
      note: "Active when you're inside the meal-logging chat thread on /meal. Switches Nora from coach to terse data-entry assistant.",
    },
  },
```

to:

```ts
  nora: {
    name: "Nora",
    role: "Nutrition specialist — meals, macros, GLP-1 phase awareness",
    base: NORA_BASE,
    voiceSummary:
      "Grams, kcal, ratios. Reads the food log liberally to ground advice in actual items rather than guessing.",
    tools: NORA_TOOLS,
    dailyLogsCols: NORA_COLS,
  },
```

The `CoachSpec.modeOverride` field is optional (`modeOverride?: ...`) so dropping it from Nora is fine — no type changes needed.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add app/profile/coach-prompts/page.tsx
git commit -m "$(cat <<'EOF'
feat(coach): drop Nora meal_log modeOverride from prompts inspector

The /profile/coach-prompts page previewed NORA_MEAL_LOG_PROMPT as Nora's meal-log mode override. With CHAT removed from MealLoggerSheet, that override is dead code; drop the import and the modeOverride block so Task 4 can delete the export itself.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Delete NORA_MEAL_LOG_PROMPT + its prompt-resolver branch

**Files:**
- Modify: `lib/coach/system-prompts.ts`

After Task 3, nothing imports `NORA_MEAL_LOG_PROMPT`. Safe to delete.

- [ ] **Step 1: Delete the export + its preceding doc comment**

In `lib/coach/system-prompts.ts`, delete the block from line 187 through line 237 inclusive:

```ts
// Composed onto NORA_BASE when mode='meal_log'. Switches Nora from her usual
// nutrition-advice posture into a clarification-only assistant. Additive item
// extraction happens server-side via /api/food/parse with append_to_entry_id
// BEFORE Nora ever sees the user's message — she only gets invoked when the
// parser flagged a low/medium-confidence item or extracted nothing at all.
export const NORA_MEAL_LOG_PROMPT = `You are in meal-logging mode.

... (the entire template literal — about 45 lines) ...

Keep responses terse. One sentence per turn. No nutrition advice.`;
```

The next line in the file after deletion should be the `speakerSystemPromptForMode` doc comment (currently line 239).

- [ ] **Step 2: Drop the meal_log branch from `speakerSystemPromptForMode`**

In `lib/coach/system-prompts.ts`, replace the `speakerSystemPromptForMode` function body (currently lines 242-249-ish):

```ts
/** Speaker + mode → system-prompt resolver. For meal-logging Nora composes
 *  NORA_BASE with the mode override; all other (speaker, mode) pairs fall
 *  through to speakerSystemPrompt unchanged. */
export function speakerSystemPromptForMode(
  speaker: Speaker,
  mode: ChatMode,
): string {
  if (speaker === "nora" && mode === "meal_log") {
    return `${NORA_BASE}\n\n${NORA_MEAL_LOG_PROMPT}`;
  }
  return speakerSystemPrompt(speaker);
}
```

with:

```ts
/** Speaker + mode → system-prompt resolver. No mode currently composes an
 *  override; this stays as the resolver seam in case a future mode needs one. */
export function speakerSystemPromptForMode(
  speaker: Speaker,
  _mode: ChatMode,
): string {
  return speakerSystemPrompt(speaker);
}
```

Note the `_mode` rename — `ChatMode` is no longer read inside the function but the signature is preserved so callers don't have to change. The leading underscore satisfies the project's strict-mode unused-arg lint.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors. (No remaining importer of `NORA_MEAL_LOG_PROMPT` per Task 3.)

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): delete NORA_MEAL_LOG_PROMPT export + meal_log resolver branch

The export and its composition into Nora's system prompt are dead with the meal-sheet chat removed. speakerSystemPromptForMode stays as the resolver seam for future mode-specific overrides.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Drop meal_log plumbing from chat-messages route

**Files:**
- Modify: `app/api/chat/messages/route.ts`

This task lands BEFORE Task 6 so removing `mealLogDraftContext` from `RunChatStreamOpts` (Task 6) doesn't break the route's call site.

- [ ] **Step 1: Drop `"meal_log"` from the mode validator**

In `app/api/chat/messages/route.ts`, change the `requestedMode` block (currently lines 226-232):

```ts
  const requestedMode: ChatMode | null =
    body.mode === "plan_week" ||
    body.mode === "setup_block" ||
    body.mode === "intake" ||
    body.mode === "meal_log"
      ? body.mode
      : null;
```

to:

```ts
  const requestedMode: ChatMode | null =
    body.mode === "plan_week" ||
    body.mode === "setup_block" ||
    body.mode === "intake"
      ? body.mode
      : null;
```

A client sending `mode: "meal_log"` will now fall through to `requestedMode = null`, which the route already handles (treats as default mode). No 4xx; just silently downgrades.

- [ ] **Step 2: Drop the `mealLogDraftEntryId` extraction + meal_log stamp branch**

In `app/api/chat/messages/route.ts`, delete the extraction block (currently lines 347-355):

```ts
  // Pull the draft entry id out of hidden_context for meal_log mode. The
  // MealLoggerChatTab includes a line `entry_id: <uuid>` in the hidden
  // context for every reply turn; we tag both the user and assistant rows
  // with it so the post-commit DELETE can scope by draft_entry_id.
  let mealLogDraftEntryId: string | null = null;
  if (effectiveMode === "meal_log" && typeof body.hidden_context === "string") {
    const m = body.hidden_context.match(/entry_id:\s*([0-9a-f-]{36})/i);
    if (m) mealLogDraftEntryId = m[1];
  }
```

And replace the stamp-patch block (currently lines 357-378):

```ts
  // Stamp both rows with the resolved mode + kind + (for meal_log) the
  // draft entry tag. kind defaults to 'coach' from the table; for meal_log
  // mode we need 'meal_log' so the MealLoggerChatTab thread query picks up
  // the assistant reply and the post-commit DELETE-by-draft_entry_id finds
  // these rows.
  const stampPatch: {
    mode: ChatMode;
    updated_at: string;
    kind?: "meal_log";
    draft_entry_id?: string;
  } = {
    mode: effectiveMode,
    updated_at: new Date().toISOString(),
  };
  if (effectiveMode === "meal_log") {
    stampPatch.kind = "meal_log";
    if (mealLogDraftEntryId) stampPatch.draft_entry_id = mealLogDraftEntryId;
  }
  await sr
    .from("chat_messages")
    .update(stampPatch)
    .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);
```

with:

```ts
  // Stamp both rows with the resolved mode + updated_at. With the meal-sheet
  // chat surface removed, no caller sets mode='meal_log' anymore; kind stays
  // at its 'coach' table default.
  const stampPatch: { mode: ChatMode; updated_at: string } = {
    mode: effectiveMode,
    updated_at: new Date().toISOString(),
  };
  await sr
    .from("chat_messages")
    .update(stampPatch)
    .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);
```

- [ ] **Step 3: Drop the `mealLogDraftContext` arg from the `runChatStream` call**

In `app/api/chat/messages/route.ts`, locate the `runChatStream({ ... })` call (currently around lines 830-848). Change the options-object construction:

```ts
          for await (const ev of runChatStream({
            userId,
            systemPrompt: finalSystemPrompt,
            messages: streamMessages,
            signal: req.signal,
            sr,
            toolCallSink,
            usageSink,
            assistantMessageId: assistantId,
            mode: effectiveMode,
            draftDocId,
            speaker: streamSpeaker,
            peterContext,
            peterDashboardBlock,
            mealLogDraftContext: typeof body.hidden_context === "string" && body.hidden_context.length > 0
              ? body.hidden_context
              : null,
          })) {
```

to:

```ts
          for await (const ev of runChatStream({
            userId,
            systemPrompt: finalSystemPrompt,
            messages: streamMessages,
            signal: req.signal,
            sr,
            toolCallSink,
            usageSink,
            assistantMessageId: assistantId,
            mode: effectiveMode,
            draftDocId,
            speaker: streamSpeaker,
            peterContext,
            peterDashboardBlock,
          })) {
```

- [ ] **Step 4: Keep the approval-token intercept untouched**

Sanity check: the `if (approveAction === "meal_log")` block around line 447 (the `executeCommitMealLog` intercept) is UNTOUCHED. This is the `/coach` default-mode commit path and must keep working.

If you accidentally removed it, restore it. The block runs when a user taps an Approve chip for a `meal_log` action token coming from a Nora-in-`/coach` proposal — distinct from the now-deleted meal-sheet chat flow.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors. `mealLogDraftContext` is still defined on `RunChatStreamOpts` (Task 6 removes it); since it's optional, not passing it is fine.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "$(cat <<'EOF'
feat(coach): drop meal_log plumbing from /api/chat/messages

Remove the meal_log mode acceptance, the hidden_context entry_id extraction, the kind/draft_entry_id stamp branch, and the mealLogDraftContext arg passed to runChatStream. The approval-token intercept for executeCommitMealLog (used by /coach default-mode Nora proposals) is preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Drop meal_log plumbing from chat-stream

**Files:**
- Modify: `lib/coach/chat-stream.ts`

After Task 5 no caller passes `mealLogDraftContext` or `mode: "meal_log"`. Safe to remove both internally.

- [ ] **Step 1: Drop `mealLogDraftContext` from `RunChatStreamOpts`**

In `lib/coach/chat-stream.ts`, delete the field from the `RunChatStreamOpts` type (currently lines 217-222):

```ts
  /** Per-turn side-channel context for Nora-in-meal-log. Appended to the
   *  system prompt so Nora knows which food_log_entries draft she's working
   *  on (id + item names + per-item confidence + qty) without it ever
   *  appearing in the user-visible chat_messages thread. Null/empty in any
   *  other (speaker, mode) combination. */
  mealLogDraftContext?: string | null;
```

- [ ] **Step 2: Drop the injection block in `runChatStream`**

In `lib/coach/chat-stream.ts`, delete lines 269-271 (the system-text append for meal-log draft context):

```ts
  if (opts.mealLogDraftContext && speaker === "nora" && opts.mode === "meal_log") {
    systemText = `${systemText}\n\n# Active draft\n${opts.mealLogDraftContext}`;
  }
```

The surrounding `if (opts.peterContext) ...` block on line 268 and the `const system = [...]` block on line 272 stay.

- [ ] **Step 3: Drop the meal_log branch from `modeAllowsTool`**

In `lib/coach/chat-stream.ts`, delete the entire meal_log branch (currently lines 297-312):

```ts
    if (opts.mode === "meal_log") {
      // Nora-in-meal-log is clarification-only: server-side append into
      // food_log_entries (via /api/food/parse with append_to_entry_id) is the
      // canonical write path, and the Confirm button on the pinned meal card
      // is the canonical commit. propose_meal_log / commit_meal_log are
      // explicitly excluded here as defense-in-depth against the prompt-only
      // steering in NORA_MEAL_LOG_PROMPT — if Nora hallucinates an approval
      // echo, the tool isn't in the model's surface to call. Default-mode
      // /coach chat still has those tools (see the explicit allows below).
      return (
        name === "search_library" ||
        name === "pick_library_item" ||
        name === "save_to_library" ||
        name === "resolve_food_macros"
      );
    }
```

The next branch (`if (opts.mode === "plan_week" || opts.mode === "setup_block") { ... }`) is now the first branch — its logic is unchanged.

- [ ] **Step 4: Update the `webSearchAllowedForMode` doc comment**

In `lib/coach/chat-stream.ts`, change the comment block above `webSearchAllowedForMode` (currently lines 134-136):

```ts
// Modes where coaches may search the web. Hidden in meal_log (Nora's
// data-entry flow stays focused on resolving items) and intake (Phase 2
// plan-builder is deterministic — no web noise during the wizard).
function webSearchAllowedForMode(mode: ChatMode): boolean {
  return mode === "default" || mode === "plan_week" || mode === "setup_block";
}
```

to:

```ts
// Modes where coaches may search the web. Hidden in intake (Phase 2
// plan-builder is deterministic — no web noise during the wizard).
function webSearchAllowedForMode(mode: ChatMode): boolean {
  return mode === "default" || mode === "plan_week" || mode === "setup_block";
}
```

(Function body unchanged — `meal_log` falls through to `false` exactly as before, just no longer warrants its own mention.)

- [ ] **Step 5: Update the realistic-batch-comment near MAX_TOOL_INVOCATIONS**

In `lib/coach/chat-stream.ts`, the comment at lines 111-114 references `meal_log/default mode`:

```ts
// Cap counts each tool_use block (parallel tool use included), not each round.
// A realistic Nora batch-save in meal_log/default mode is 2N+2 calls (N search
// + N save + 1 propose_meal_log + 1 commit_meal_log); 25 covers a 12-item meal comfortably while
// still floor-limiting runaway loops on cheap query_* tools.
const MAX_TOOL_INVOCATIONS = 25;
```

Update to:

```ts
// Cap counts each tool_use block (parallel tool use included), not each round.
// A realistic Nora batch-save in default mode is 2N+2 calls (N search + N save
// + 1 propose_meal_log + 1 commit_meal_log); 25 covers a 12-item meal comfortably
// while still floor-limiting runaway loops on cheap query_* tools.
const MAX_TOOL_INVOCATIONS = 25;
```

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "$(cat <<'EOF'
feat(coach): drop meal_log plumbing from runChatStream

Remove mealLogDraftContext from RunChatStreamOpts, the system-text injection block, and the meal_log branch in modeAllowsTool. Update two stale meal_log comments. propose_meal_log / commit_meal_log tool definitions and their default-mode allowlist entries stay (still used by /coach Nora proposals).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final typecheck + manual smoke

**Files:** none modified

The project has no automated test suite (per [CLAUDE.md](../../../CLAUDE.md)). End-to-end verification is `npm run typecheck` once more (all six prior tasks did their own; this is the final sweep) plus a hands-on smoke on `/meal` and `/coach`.

- [ ] **Step 1: Final typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 2: Final dead-reference grep**

Run from the repo root:

```bash
grep -rn "MealLoggerChatTab\|MealLoggerPreviewCard\|MealLoggerEditor\|NORA_MEAL_LOG_PROMPT\|mealLogDraftContext\|mealLogDraftEntryId" components/ app/ lib/ scripts/ 2>/dev/null
```

Expected: NO matches. If any surface, investigate before proceeding.

It's fine for these strings to still appear in:
- Historical commits (`git log -S '...'` will find them; that's expected)
- `chat_messages` rows in the DB with `kind='meal_log'` (left alone per spec)
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — historical docs reference the old design

- [ ] **Step 3: Start the dev server**

Run: `npm run dev`
Expected: server up on http://localhost:3000.

- [ ] **Step 4: Smoke `/meal` — SEARCH is default and works**

1. Open http://localhost:3000/meal in a browser, signed in.
2. Tap the **+** button on the **Lunch** card.
3. Sheet opens. Expected: **two tabs only** ("Add food" and "Library"), with "Add food" selected. No "CHAT" tab anywhere.
4. Type `basmati` in the search box. Within ~300 ms, a ranked candidate list renders from your library + DB cache + USDA Foundation/SR Legacy + Open Food Facts. Tap any candidate, set qty 150g, tap **Add**.
5. Pick a second item (e.g. `chicken breast`, 200g, Add).
6. Tap **Review (2 items)**. Draft review renders. Tap **Log**.
7. Sheet closes (or stays open per the `onCommitted` behavior). Lunch row on `/meal` reflects the new totals.

- [ ] **Step 5: Smoke `/meal` — Library tab still works**

1. Open the sheet again on Lunch. Tap **Library**.
2. Confirm Favorites / Recent / Frequent / Catalog sections render. (If the user has no library yet, sections may be empty — that's fine, no errors.)

- [ ] **Step 6: Smoke `/coach` — Nora's default-mode meal proposal still works**

1. Navigate to http://localhost:3000/coach.
2. Send a message to Nora: `I had a banana for snack`.
3. Expected: Nora responds and (per the multi-coach team design) proposes a `meal_log` via the `propose_meal_log` tool. An Approve chip appears in the chat.
4. Tap **Approve**. The approval-token intercept fires → `executeCommitMealLog` runs → a Snack entry commits.
5. Verify on `/meal` that the new snack entry appears for today.

If step 3 doesn't surface a propose chip, Nora's default-mode behavior was disturbed — investigate before declaring the migration done.

- [ ] **Step 7: Server log spot-check**

Confirm in the dev server console that:
- No `[chat-stream]` errors mentioning `meal_log` or `mealLogDraftContext`.
- No 4xx/5xx from `/api/chat/messages` during the `/meal` smoke (the SEARCH path doesn't hit it at all; the `/coach` path does and should succeed).
- No `[/api/food/parse]` calls during the `/meal` smoke (the SEARCH tab uses `/api/food/draft`, not `/api/food/parse`).

- [ ] **Step 8: Done — no extra commit needed**

The six task commits are the deliverable.

---

## Risks & known compromises

1. **Muscle-memory regression for the user.** You've been using the CHAT tab. The first few times you open the sheet you may tap where it was. Accepted per spec — the failure mode that was frustrating today goes away.

2. **Coverage gaps in SEARCH.** USDA is filtered to Foundation + SR Legacy; USDA Branded is excluded. Open Food Facts covers most regional/branded items but with varying name quality. If a specific food consistently produces "No matches," the data-layer arc (USDA Branded inclusion or commercial DB like Edamam/FatSecret) is the right next move — out of scope here.

3. **`/api/food/parse` is now orphaned-but-deployed.** Per spec, kept as a defensible fallback. If it's still unused in ~1 month, delete in a follow-up.

4. **Historical `chat_messages.kind='meal_log'` rows are orphaned.** Read-only, RLS-protected, harmless. Cost is storage only. Spec explicitly declines a backfill.

5. **Two stale comment fragments in `lib/coach/chat-stream.ts` still mention meal_log in the PERSIST_RESULT_TOOLS area (lines 98-101, 105-107).** Those reference `save_to_library`, `propose_meal_log`, `commit_meal_log` — all still valid in default-mode `/coach` chat. The `meal_log` substring there describes the action token, NOT the deleted mode. Left intact intentionally; updating would obscure the receipt-chip rationale.
