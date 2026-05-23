# Diet redesign (Yazio-style) + ephemeral meal-log chat

**Date:** 2026-05-23
**Status:** Design — pending user review
**Sub-project:** B of the meal-logging-improvement arc (A=chat-drop bug fix shipped; C=trends view; D=Nora coaching intelligence)

## Problem

Two complaints converge on `/diet`:

1. **The journal looks bare.** Today's `/diet` shows day-totals as text + four flat macro bars, with per-meal cards underneath. Yazio's diary tab is the reference: a calorie ring (Eaten / Remaining / Burned), three macro bars beneath it, then collapsed per-meal cards. The user wants Yazio's structure on `/diet`.
2. **Nora's meal-log chat lingers.** Today every user+Nora message lands as a `chat_messages` row with `kind='meal_log'`. The MealLoggerSheet's Chat tab queries the whole day's rows and renders them, so by snack time you see breakfast and lunch's clarification turns above the current draft. The user only wants the chat alive while a draft is in flight — once a meal is committed (or cancelled), the back-and-forth should disappear.

## Decisions locked with user

| Decision | Choice |
|---|---|
| `/diet` page structure | **Yazio-clone, no internal tabs.** Drop the existing Coach\|Log split. BodyCompCard moves out of `/diet` (sub-project C owns the body comp trend). |
| Meal-log chat lifecycle | **Delete on commit/cancel.** Each draft is its own bounded exchange; resolution wipes its messages. |

## Decisions taken inside the chosen path

- **"Burned" panel**: show `daily_logs.active_calories`. Fallback to "—" if NULL.
- **Water tracker**: skipped (not tracked anywhere in app; YAGNI).
- **Date scrubber**: keep the existing 7-day swipe at the top.
- **Per-meal cards**: collapsed by default (icon + slot name + `eaten / target kcal` + `+`). Tap card body → expand the entries inline. Tap `+` → open MealLoggerSheet pinned to that slot. (Matches Yazio's collapse-by-default behavior.)
- **MealLoggerSheet**: 3-tab structure (Chat / Search / Library) stays. Default tab = Chat.
- **Chat→draft association**: a new `chat_messages.draft_entry_id uuid` column (no FK; tag-only).
- **`/metrics` "+ Log entry" FAB**: stays. Same `MealLoggerSheet`.
- **"Details" link in Yazio's Summary header**: defer. When sub-project C lands, link to `/coach/trends?section=nutrition`. Until then, omit.
- **"More" link in Yazio's Nutrition header**: omit. We don't browse recipes on this surface.

## Architecture overview

Three pieces, each independently testable:

```
┌─────────────────────────────────────────────────────────────┐
│  /diet  (Server Component, hybrid SSR-hydrate)              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ <DietJournalClient userId date>                       │  │
│  │   <DayHeader date scrubber/>                          │  │
│  │   <SummaryCard kcalRing macroBars/>      ◄─ NEW       │  │
│  │   <MealsList>                            ◄─ refactor  │  │
│  │     <MealSlotCard slot collapsed default/> × 4        │  │
│  │   </MealsList>                                        │  │
│  │ </DietJournalClient>                                  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  MealLoggerSheet (existing, behavior change in Chat tab)    │
│  ┌──────────┬──────────┬──────────┐                         │
│  │  Chat    │  Search  │  Library │                         │
│  ├──────────┴──────────┴──────────┤                         │
│  │ MealLoggerChatTab  ◄─ ephemeral                          │
│  │   • on send: insert message with draft_entry_id          │
│  │   • on commit: DELETE all rows for draft_entry_id        │
│  │   • on cancel: DELETE all rows for draft_entry_id        │
│  │   • on open with no active draft: empty thread           │
│  │   • on open with active draft: only that draft's rows    │
│  └──────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────────┐
│ DB                           │
│ chat_messages                │
│   + draft_entry_id uuid NULL │   ◄─ migration 0031
│   + idx (user_id,            │
│         draft_entry_id) WHERE │
│         draft_entry_id NOT    │
│         NULL                  │
└──────────────────────────────┘
```

## Detailed design

### 1. New `/diet` page layout

**Replaces:** `app/diet/page.tsx` two-tab Coach\|Log layout. Top-of-page chrome ("Diet" / "Nora") gone. BodyCompCard removed entirely (lives in sub-project C eventually).

**New tree:**

```
app/diet/page.tsx (Server Component)
  ├─ auth gate → redirect("/login")
  ├─ resolve userId
  ├─ prefetch (hybrid SSR-hydrate, see CLAUDE.md):
  │    • today's food_log_entries (this week)
  │    • today's daily_logs row (kcal eaten + burned + macros)
  │    • today's targets (via getTodayTargets)
  │    • meal_slot kcal targets (via targetsForAllSlots)
  └─ <DietJournalClient userId date={today}/>
       ├─ <DayScrubber/> (existing 7-day swipe; reused)
       ├─ <SummaryCard/> (NEW)
       │    ├─ ring (Eaten / Remaining / Burned)
       │    └─ MacroBars (Carbs / Protein / Fat, with X/Y g)
       └─ <MealsList/>
            └─ <MealSlotCard/> × 4
                 ├─ collapsed by default: icon, slot name, "X/Y kcal", "+"
                 └─ expanded: entry rows (existing MealSlotCard rendering)
```

**Files to create:**
- `components/diet/SummaryCard.tsx` — composes `KcalRing` + `MacroBars`.
- `components/diet/KcalRing.tsx` — SVG ring (270°, gap at bottom) with `eaten/remaining/burned` triplet in the center. Pure presentation.
- `components/diet/MacroBars.tsx` — three rows (Carbs / Protein / Fat), each a horizontal bar + `X/Y g` label. Pure presentation.
- `components/diet/MealSlotCardCollapsed.tsx` — collapsed slot card. Tap body → toggle expansion (local `useState`). Tap "+" → call existing `onLog(slot)`.

**Files to modify:**
- `app/diet/page.tsx` — drop Coach\|Log tab logic. Mount `<DietJournalClient/>` directly. Prefetch (a) today's `daily_logs` row, (b) today's food entries, (c) today's resolved targets.
- `components/meal/MealJournalClient.tsx` → rename to `components/diet/DietJournalClient.tsx`. Replace the day-totals block with `<SummaryCard/>`. Wrap the existing slot loop with `<MealsList/>`. Use `<MealSlotCardCollapsed/>` for default state; reuse current `<MealSlotCard/>` for expanded state (or inline the rows there).
- `components/meal/MealJournalDay.tsx` — drop; logic absorbed by `<SummaryCard/>` and the new scrubber composition. Tests / consumers: confirm via `grep -r MealJournalDay`.

**Files to delete:**
- `components/diet/DietCoachClient.tsx` — gone (Coach tab removed).
- `components/diet/BodyCompCard.tsx` — **left on disk untouched, no imports**. Sub-project C will move it to `components/trends/` (or absorb its logic) when the weekly/monthly view lands. Don't delete: it's the only working "weight trend chart" implementation today and rewriting from scratch in C wastes work.

**Data flow:**
- `eaten kcal` ← `daily_logs.calories_eaten` (already populated by `sum_food_entries`).
- `target kcal` ← `getTodayTargets(userId).kcal`.
- `burned kcal` ← `daily_logs.active_calories`. Render "—" if NULL.
- `macros` ← `daily_logs.{protein_g, carbs_g, fat_g}` vs `getTodayTargets(userId).macros.{p,c,f}`.
- `per-slot kcal target` ← `targetsForAllSlots(targets).{slot}.kcal`.
- `per-slot kcal eaten` ← aggregated client-side from today's food entries by `meal_slot`.

**Empty / loading states:**
- No food entries today: ring shows full remaining = target; bars at 0; meal cards at 0/target with "+".
- `daily_logs` row missing entirely: same as above; burned = "—".
- Targets unresolved (new user, no plan, no intake): defer to existing `getTodayTargets` fallback (already returns sane defaults).

### 2. Ephemeral meal-log chat

**Goal:** the MealLoggerSheet's Chat tab shows only the current draft's exchange. Once the draft is committed or cancelled, all related `chat_messages` rows are deleted.

**Schema change** (migration `0031_meal_log_draft_tag.sql`):

```sql
-- Tag every meal_log chat_message with the draft it belongs to. Tag-only;
-- no FK because the draft (food_log_entries) is hard-deleted on cancel and
-- we want the cascade-delete to happen explicitly via the DELETE query, not
-- via a referential trigger we forget about.
alter table public.chat_messages
  add column draft_entry_id uuid;

-- Hot path for the post-commit/post-cancel cleanup. Partial because the
-- column is NULL for every non-meal_log message.
create index if not exists chat_messages_draft_entry_idx
  on public.chat_messages (user_id, draft_entry_id)
  where draft_entry_id is not null;

-- One-shot cleanup of historical meal_log rows. We retroactively remove
-- every meal_log message whose draft entry is already committed — those
-- are the rows the user is complaining about today.
delete from public.chat_messages
  where kind = 'meal_log'
    and id in (
      select cm.id
      from public.chat_messages cm
      left join public.food_log_entries fle
        on fle.id = (cm.ui->>'entry_id')::uuid
      where cm.kind = 'meal_log'
        and (
          -- Preview/committed rows: drop if entry is committed.
          (cm.ui is not null and fle.status = 'committed')
          -- Plain text rows (no ui): drop if any committed entry exists
          -- on the same day (best-effort backfill — they have no
          -- draft_entry_id yet).
          or (
            cm.ui is null
            and exists (
              select 1 from public.food_log_entries x
              where x.user_id = cm.user_id
                and x.status = 'committed'
                and date(x.eaten_at) = date(cm.created_at)
            )
          )
        )
    );
```

The one-shot cleanup is best-effort: text-bubble messages without `ui` get nuked if any committed entry exists on the same day. Worst case it deletes a few non-meal turns; the user has explicitly said they don't want that history.

**Write path** (`lib/food/` or chat-route):

Every place that inserts a `chat_messages` row with `kind='meal_log'` must now set `draft_entry_id`. Touch points:

| Insert site | File | What to set |
|---|---|---|
| User bubble after parse | `components/log/MealLoggerChatTab.tsx:360-388` | `draft_entry_id = parseJson.entry.id` |
| Nora preview row after parse | `components/log/MealLoggerChatTab.tsx:390-419` | `draft_entry_id = parseJson.entry.id` (same id as the preview's `ui.entry_id`) |
| User bubble during streamNoraReply | `app/api/chat/messages/route.ts` (the chat-route that writes user+assistant rows for `mode='meal_log'`) | `draft_entry_id` derived from `hidden_context` (see below) |
| Nora assistant row during streamNoraReply | same chat-route | `draft_entry_id` = same |
| Barcode preview row | `components/log/MealLoggerChatTab.tsx:530-547` | `draft_entry_id = entry.id` |

**`hidden_context` parsing**: `buildDraftContext()` already emits the line `entry_id: <uuid>`. The chat-route receives `hidden_context` in the POST body for `mode='meal_log'`. Extract `entry_id` with a single regex, set as `draft_entry_id` on both inserted rows.

**Delete path:**

On commit (in `MealLoggerChatTab.tsx`'s `onCommitted` callback) and on cancel (existing `cancelActiveDraft` + `onCancelled` paths), after the existing local state cleanup:

```ts
await supabase
  .from("chat_messages")
  .delete()
  .eq("user_id", userId)
  .eq("kind", "meal_log")
  .eq("draft_entry_id", activeDraft.id);
```

Then refetch the thread (`refetchThread()` already exists) to drop the rows from local state. Concrete edit points:

- `MealLoggerPreviewCard.onCommitted` → drop the existing `update({ui:{mode:'committed',...}})` step (the preview row is part of what we're deleting). Run the DELETE above, then prune local state.
- `MealLoggerPreviewCard.onCancelled` (and `cancelActiveDraft`) → same DELETE before/after the existing local prune.

**Post-commit feedback** (avoids the "empty-screen after Confirm" jarring effect):

Since the sheet stays open after commit (per existing MealLoggerSheet design — user often logs multiple meals back-to-back), the Chat tab clearing to empty would feel like nothing happened. Add a transient confirmation:

- After the DELETE + refetch, set a local `recentlyCommitted: { slot, summary }` state with a 3-second timer.
- Render a small `✓ Logged · breakfast — 2 eggs · 140 kcal` pill at the top of the Chat tab body while `recentlyCommitted !== null`.
- The empty-state copy ("Tell Nora what you ate…") sits below it. After 3 seconds, the pill fades out and only the empty-state remains, ready for the next meal.
- React-local state only — not persisted. Sheet close discards it.

`recentlyCommitted.summary` is built client-side from the just-committed entry's items (name + total kcal). No new query.

**Read path:**

The fetch query in `MealLoggerChatTab.tsx:107-139` and `156-180` already filters by `kind='meal_log'`. After the delete-on-commit/cancel behavior is in place, the thread query returns only in-flight drafts' rows by construction (committed/cancelled drafts have no chat_messages rows anymore). No query change needed.

**Edge cases:**

- **Two drafts open in parallel** (user starts breakfast, abandons mid-clarification, opens snack): each insert tags with its own draft_entry_id. Closing the sheet without committing/cancelling leaves both drafts and both chats alive. On next sheet-open the most recent draft surfaces via `findActiveDraft()`; older draft + its chat persist until user explicitly cancels (via "+ New meal" pill) or commits. Acceptable.
- **Sheet closed mid-stream**: streamingNora is React-local, gone on close. The assistant row is persisted by the chat-route on `done`. If commit/cancel hasn't happened yet, the row stays — picked up on next sheet-open.
- **Edit committed entry from the slot card**: out of scope for this delete-on-commit behavior. Editing reopens the entry via `FoodEntryEditSheet` (existing), which doesn't use the chat thread. No new conversation generated.

### 3. Slot detail expand (collapsed → expanded)

When the user taps the body of a collapsed `<MealSlotCardCollapsed/>`, expand inline:

```tsx
const [expanded, setExpanded] = useState(false);
...
<button onClick={() => setExpanded(v => !v)}>
  /* collapsed header */
</button>
{expanded && <EntriesList entries={entriesForSlot}/>}
```

`<EntriesList/>` reuses the per-entry row rendering from today's `<MealSlotCard/>` (the row with food name, kcal, edit/delete affordances). No new server data needed — entries are already in the prefetched query.

Expansion state is per-card, not persisted. Refresh resets to collapsed.

## Migration order

1. Apply `supabase/migrations/0031_meal_log_draft_tag.sql` via Supabase Dashboard or `supabase db push`.
2. Ship the chat-route patch (set `draft_entry_id` on every meal_log insert) **before** the delete-on-commit patch in the client, so any messages written in the window between migration and deploy can still be cleaned up by the post-commit DELETE (otherwise they'd have NULL `draft_entry_id` and orphan).
3. Ship the MealLoggerChatTab delete-on-commit / delete-on-cancel patch.
4. Ship the `/diet` redesign as the final piece. Independent of the chat changes; could ship first if it lands faster.

## Out of scope

- Water tracker.
- The "Details" link on Summary card → trends view (depends on sub-project C).
- The "More" link on Nutrition section.
- Per-meal photo thumbnails on the slot cards (Yazio uses emoji; we don't need photos for now).
- Streak / flame icons in the header.
- Editing food entries via chat after commit.
- Multi-day Nora chat thread for "what did I eat yesterday?" — that's `/coach` Nora territory (sub-project D).

## Testing plan

- **Visual**: open `/diet`, confirm new layout matches the Yazio reference for ring + bars + collapsed slot cards. Tap each slot to expand entries.
- **Date scrubber**: swipe back through 7 days; confirm summary + slot cards re-fetch correctly.
- **Burned fallback**: pick a day with no Apple Health sync; confirm "—" renders for Burned, no crash.
- **Chat ephemerality**:
  - Open sheet → type "had eggs" → Nora replies "two eggs?" → reply "yes" → Confirm → verify `chat_messages` rows for that draft are gone (`select count(*) from chat_messages where kind='meal_log' and user_id=$1 and created_at>now()-interval '1 hour'` should be 0 after commit).
  - Open sheet → type "had eggs" → Nora replies → tap "+ New meal" → verify same DELETE fired and the rows are gone.
  - Open sheet for snack after committing breakfast → verify Chat tab thread is empty (no breakfast clarification visible).
- **Parallel drafts** (edge): start a breakfast draft (don't commit), open snack and commit it → verify breakfast's chat is untouched.
- **Historical cleanup**: run the migration in a copy of prod-data → confirm pre-existing committed meal_log conversations are gone.

## Risks

- **One-shot cleanup is destructive.** The migration's same-day backfill rule (`delete plain-text rows on days with any committed entry`) could nuke a row that wasn't actually about food. The blast radius is bounded to `kind='meal_log'`, so it can't touch `/coach` history. Acceptable given user's explicit "I don't need history" intent.
- **No FK on `draft_entry_id`.** If `food_log_entries` gets hard-deleted by some other path (admin tool, future feature), the chat rows orphan. Mitigation: only one path hard-deletes food entries today (cancel-draft); that path also runs the chat DELETE. Document the invariant in the migration comment.
- **`/diet` layout regression**: removing the Coach tab means the BodyCompCard is no longer visible until sub-project C ships. Acceptable per user's locked decision.
