# Diet redesign + ephemeral meal-log chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project B from the meal-logging-improvement arc: (a) redesign `/diet` as a single Yazio-style page (kcal ring + macro bars + collapsed per-meal cards), dropping the Coach|Log tabs, and (b) make Nora's meal-log chat ephemeral — chat rows are deleted the moment the meal is committed or cancelled.

**Architecture:** Two independent pieces in one plan. Phase 1 (Tasks 1-7) adds a `chat_messages.draft_entry_id` tag column, wires every meal_log insert site to set it, scopes the sheet's thread query to the active draft only, and DELETEs by `draft_entry_id` on commit/cancel. Phase 2 (Tasks 8-13) builds 4 new presentational components, a new top-level client for `/diet`, refactors `app/diet/page.tsx` to drop the tabs, and deletes the dead Coach-tab files.

**Tech Stack:** Next.js 15 App Router · Supabase (linked CLI) · TanStack Query (hybrid SSR-hydrate per CLAUDE.md) · TypeScript strict · no test framework — verification via `npm run typecheck` + audit scripts + manual dev-server exercise.

**Reference spec:** [docs/superpowers/specs/2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md](../specs/2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md)

---

## Phase 1 — Ephemeral meal-log chat

### Task 1: Add `draft_entry_id` column + one-shot historical cleanup

**Files:**
- Create: `supabase/migrations/0031_meal_log_draft_tag.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0031_meal_log_draft_tag.sql
-- Tag every meal_log chat_message with the draft food_log_entry it belongs
-- to, so the post-commit / post-cancel cleanup can delete by tag instead of
-- by fuzzy time-bounds. Tag-only (no FK) because the draft entry is
-- hard-deleted on cancel and we want the cascade to happen explicitly via
-- our DELETE query, not via a referential trigger we forget about.
--
-- Migration order is documented in the design spec:
--   docs/superpowers/specs/2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md

alter table public.chat_messages
  add column if not exists draft_entry_id uuid;

-- Hot path for the post-commit / post-cancel DELETE. Partial because
-- draft_entry_id is NULL for every non-meal_log row.
create index if not exists chat_messages_draft_entry_idx
  on public.chat_messages (user_id, draft_entry_id)
  where draft_entry_id is not null;

-- ── One-shot historical cleanup ───────────────────────────────────────────
-- Retroactively remove the meal_log clutter the user is complaining about
-- today: chat rows whose draft entry is already committed. Best-effort for
-- text-bubble rows (no ui column to join through), so we use same-day
-- proximity. Blast radius is bounded to kind='meal_log'.
delete from public.chat_messages cm
  where cm.kind = 'meal_log'
    and (
      -- Preview/committed rows: drop if entry exists and is committed.
      exists (
        select 1
        from public.food_log_entries fle
        where fle.id = (cm.ui->>'entry_id')::uuid
          and fle.status = 'committed'
      )
      -- Plain text rows (no ui.entry_id): drop if any committed entry
      -- exists on the same date for this user.
      or (
        cm.ui is null
        and exists (
          select 1
          from public.food_log_entries x
          where x.user_id = cm.user_id
            and x.status = 'committed'
            and date(x.eaten_at) = date(cm.created_at)
        )
      )
    );
```

- [ ] **Step 2: Apply the migration via Supabase CLI**

Run: `supabase db push`

Expected output ends with `Finished supabase db push.` and the migration file is recorded in `supabase_migrations.schema_migrations`.

If `supabase db push` errors with "already applied" for prior numbered migrations, repair with `supabase migration repair --status applied <number>` then re-run push.

- [ ] **Step 3: Manually verify in SQL Editor**

```sql
-- Should print: column exists.
select column_name, data_type
from information_schema.columns
where table_name = 'chat_messages' and column_name = 'draft_entry_id';

-- Should print: index exists.
select indexname from pg_indexes
where indexname = 'chat_messages_draft_entry_idx';

-- Should print: zero rows whose draft entry is committed.
select count(*) from public.chat_messages cm
where cm.kind = 'meal_log'
  and exists (
    select 1 from public.food_log_entries fle
    where fle.id = (cm.ui->>'entry_id')::uuid
      and fle.status = 'committed'
  );
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0031_meal_log_draft_tag.sql
git commit -m "feat(db): tag meal_log chat_messages with draft_entry_id

Adds chat_messages.draft_entry_id uuid (no FK, tag-only) + partial index
+ one-shot cleanup of historical meal_log rows whose draft is already
committed. Foundation for the post-commit chat deletion behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Widen TS types + add audit script

**Files:**
- Modify: `lib/chat/types.ts:53` (kind union + add draft_entry_id)
- Create: `scripts/audit-meal-log-draft-tag.mjs`

- [ ] **Step 1: Widen ChatMessage type**

In `lib/chat/types.ts`, modify the `ChatMessage` type — the `kind` union is currently missing `'meal_log'` (DB constraint allows it; type drifted). Add it, then add a nullable `draft_entry_id` field below `mode`:

```ts
export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatStatus;
  error: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  images: ChatMessageImage[];
  speaker: import("@/lib/data/types").ChatSpeaker;
  thread: import("@/lib/data/types").Speaker;
  kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge" | "system_routing" | "workout_debrief" | "meal_log";
  ui: MorningUI | MorningBriefCard | WeeklyReviewCardUI | ProactiveNudgeCard | WorkoutDebriefPayload | null;
  tool_calls?: import("@/lib/data/types").ToolCallLog[] | null;
  mode?: import("@/lib/data/types").ChatMode;
  /** For kind='meal_log' rows only: the food_log_entries.id this message
   *  belongs to. Populated on insert; used to DELETE the row when the draft
   *  resolves (commit/cancel). NULL on every non-meal_log row. */
  draft_entry_id?: string | null;
};
```

Also update `lib/data/types.ts` `ChatMessageRow` type at line ~95 to include the same new field (mirrors DB row).

- [ ] **Step 2: Write the audit script**

```js
// scripts/audit-meal-log-draft-tag.mjs
// Read-only audit: count meal_log rows with NULL draft_entry_id. After the
// route + client patches land, this should be 0 for new rows. Pre-patch
// rows may still be NULL — that's expected (one-shot cleanup deleted the
// committed ones; the rest stay).
//
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//        --experimental-strip-types --env-file=.env.local \
//        scripts/audit-meal-log-draft-tag.mjs

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var.");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const { data, error } = await supabase
  .from("chat_messages")
  .select("id, role, speaker, ui, draft_entry_id, created_at")
  .eq("user_id", userId)
  .eq("kind", "meal_log")
  .gte("created_at", since)
  .order("created_at", { ascending: false });

if (error) {
  console.error("query failed:", error);
  process.exit(1);
}

const total = data.length;
const untagged = data.filter((r) => r.draft_entry_id === null);

console.log(`meal_log rows in last 24h: ${total}`);
console.log(`untagged (draft_entry_id IS NULL): ${untagged.length}`);

if (untagged.length > 0) {
  console.log("\nUntagged rows (first 10):");
  for (const r of untagged.slice(0, 10)) {
    console.log(`  ${r.created_at}  ${r.role}/${r.speaker}  ui=${JSON.stringify(r.ui)}`);
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0. If any consumer of `ChatMessage.kind` switch-narrows and misses `'meal_log'`, it'll fail here — fix the consumer.

- [ ] **Step 4: Commit**

```bash
git add lib/chat/types.ts lib/data/types.ts scripts/audit-meal-log-draft-tag.mjs
git commit -m "feat(chat): add draft_entry_id to ChatMessage type + audit script

Widens kind union to include 'meal_log' (was drifted from DB constraint)
and adds nullable draft_entry_id. Audit script counts untagged meal_log
rows in the last 24h for verifying the upcoming write-path patches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Route patch — stamp `kind='meal_log'` + `draft_entry_id` for mode='meal_log'

**Files:**
- Modify: `app/api/chat/messages/route.ts:346-350`

- [ ] **Step 1: Parse the draft entry id out of hidden_context in the route**

Above the existing "Stamp both rows with the resolved mode" block (around line 346), add a parser. The existing `body.hidden_context` for meal_log mode contains a line like `entry_id: <uuid>` (see `buildDraftContext` in `components/log/MealLoggerChatTab.tsx:52-66`).

Insert this block before the `.update({ mode: effectiveMode, ... })` call:

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

- [ ] **Step 2: Merge kind + draft_entry_id into the existing mode-stamp UPDATE**

Replace the existing block:

```ts
// Stamp both rows with the resolved mode.
await sr
  .from("chat_messages")
  .update({ mode: effectiveMode, updated_at: new Date().toISOString() })
  .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);
```

with:

```ts
// Stamp both rows with the resolved mode + kind + (for meal_log) the
// draft entry tag. kind defaults to 'coach' from the table; for meal_log
// mode we need 'meal_log' so the MealLoggerChatTab thread query picks up
// the assistant reply and the post-commit DELETE-by-draft_entry_id finds
// these rows. Stamping kind here means future-mode-specific kinds (intake
// already has its own write path so it's fine) get a single touchpoint.
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

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Manual smoke test**

Run dev server: `npm run dev`

In the browser (logged in), open `/diet`, tap "+" on Breakfast → type "had a banana" → send. After Nora replies, in Supabase SQL Editor:

```sql
select id, role, speaker, kind, mode, draft_entry_id, content
from public.chat_messages
where user_id = '<your-user-id>'
  and kind = 'meal_log'
order by created_at desc
limit 6;
```

Expected: the user bubble + Nora's reply both have `kind='meal_log'`, `mode='meal_log'`, `draft_entry_id=<the food_log_entry uuid from /api/food/parse>`.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "feat(chat): stamp kind+draft_entry_id for mode=meal_log writes

The chat-route's atomic RPC path defaulted kind='coach' for every row,
even mode='meal_log' turns — visible Nora replies in the meal-log sheet
disappeared from the thread after the stream ended. Stamps kind='meal_log'
+ draft_entry_id (parsed from hidden_context) on both user + assistant
rows so the sheet query picks them up and the post-commit DELETE can
scope by tag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Tag client-side meal_log inserts in MealLoggerChatTab

**Files:**
- Modify: `components/log/MealLoggerChatTab.tsx:360-388` (user bubble after parse)
- Modify: `components/log/MealLoggerChatTab.tsx:390-419` (Nora preview row after parse)
- Modify: `components/log/MealLoggerChatTab.tsx:530-547` (barcode preview row)

- [ ] **Step 1: Add `draft_entry_id` to the user bubble insert (after parse)**

At line 362-373, the user row insert. Add `draft_entry_id: parseJson.entry.id` to the insert payload:

```ts
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
    ui: null,
    draft_entry_id: parseJson.entry.id,
  })
  .select("id, speaker, content, ui, created_at")
  .single();
```

- [ ] **Step 2: Add `draft_entry_id` to the Nora preview row insert (after parse)**

At line 391-403, the preview row insert. Same treatment:

```ts
const { data: noraPreviewRow, error: noraErr } = await supabase
  .from("chat_messages")
  .insert({
    user_id: userId,
    role: "assistant",
    content: "",
    status: "done",
    speaker: "nora",
    kind: "meal_log",
    mode: "meal_log",
    ui: { mode: "preview", entry_id: parseJson.entry.id },
    draft_entry_id: parseJson.entry.id,
  })
  .select("id, speaker, content, ui, created_at")
  .single();
```

- [ ] **Step 3: Add `draft_entry_id` to the barcode preview row insert**

At line 531-543, the barcode insert. Same treatment:

```ts
supabase
  .from("chat_messages")
  .insert({
    user_id: userId,
    role: "assistant",
    content: "",
    status: "done",
    speaker: "nora",
    kind: "meal_log",
    mode: "meal_log",
    ui: { mode: "preview", entry_id: entry.id },
    draft_entry_id: entry.id,
  })
  .select("id, speaker, content, ui, created_at")
  .single()
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 5: Manual smoke test + audit**

Restart dev server. Open the meal logger sheet, send "had two eggs" → wait for Nora's clarification reply → also try the barcode path (button → enter UPC like `737628064502`). Then run the audit:

```bash
AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-meal-log-draft-tag.mjs
```

Expected: every meal_log row in the last 24h has a non-NULL `draft_entry_id`. `untagged` count = 0.

- [ ] **Step 6: Commit**

```bash
git add components/log/MealLoggerChatTab.tsx
git commit -m "feat(meal-log): tag client inserts with draft_entry_id

Adds draft_entry_id to the 3 direct chat_messages inserts in
MealLoggerChatTab (user-bubble-after-parse, preview-after-parse, barcode-
preview). Paired with the route patch this means every new meal_log row
carries the tag from creation, ready for delete-by-tag at commit/cancel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Scope the sheet thread query to the active draft only

**Files:**
- Modify: `components/log/MealLoggerChatTab.tsx:107-122` (initial fetch)
- Modify: `components/log/MealLoggerChatTab.tsx:156-180` (refetchThread)

After the delete-on-commit/cancel work in Tasks 6+7, "today's committed meals" won't have any chat_messages rows left, so the existing day-window query will return only active-draft rows. But scoping the query explicitly by `draft_entry_id IN (active draft ids)` is more defensive and survives any future drift in the cleanup behavior.

- [ ] **Step 1: Modify the initial fetch to filter by draft state**

In the `fetchThread` callback at lines 108-138, replace the existing `chat_messages` select with one that joins via `draft_entry_id`. The simplest path: drop the `today` time-window filter and instead select only rows whose `draft_entry_id` references a `food_log_entries` row with `status='draft'` (i.e. not committed, not cancelled-then-deleted).

```ts
useEffect(() => {
  const fetchThread = async () => {
    // First: get the user's active draft entry ids. Drafts are
    // food_log_entries rows with status='draft'. Cancelled drafts are
    // hard-deleted by cancelActiveDraft, so the set is naturally bounded.
    const { data: drafts, error: draftsErr } = await supabase
      .from("food_log_entries")
      .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status, recipe_id")
      .eq("user_id", userId)
      .eq("status", "draft");
    if (draftsErr) {
      console.error("[chat-tab] drafts fetch failed", draftsErr);
      return;
    }
    const draftIds = (drafts ?? []).map((d) => d.id);
    if (draftIds.length === 0) {
      setMessages([]);
      setDrafts({});
      return;
    }

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, speaker, content, ui, created_at")
      .eq("user_id", userId)
      .eq("kind", "meal_log")
      .in("draft_entry_id", draftIds)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[chat-tab] thread fetch failed", error);
      return;
    }
    setMessages((data ?? []) as ThreadMessage[]);

    // Hydrate the drafts map from the rows we already fetched.
    const dict: Record<string, FoodLogEntry> = {};
    for (const e of (drafts ?? []) as unknown as FoodLogEntry[]) dict[e.id] = e;
    setDrafts(dict);
  };
  fetchThread();
}, [userId, supabase]);
```

- [ ] **Step 2: Modify `refetchThread` the same way**

In `refetchThread` at lines 156-180, replace the existing implementation with the same draft-scoped query. Preserve the local-committed-override merge logic for messages that get stamped client-side before the refetch:

```ts
const refetchThread = async () => {
  const { data: drafts } = await supabase
    .from("food_log_entries")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "draft");
  const draftIds = (drafts ?? []).map((d) => d.id);
  if (draftIds.length === 0) {
    setMessages([]);
    return;
  }

  const { data } = await supabase
    .from("chat_messages")
    .select("id, speaker, content, ui, created_at")
    .eq("user_id", userId)
    .eq("kind", "meal_log")
    .in("draft_entry_id", draftIds)
    .order("created_at", { ascending: true });
  if (!data) return;

  setMessages((prev) => {
    const byId = new Map(prev.map((m) => [m.id, m]));
    for (const r of data as ThreadMessage[]) {
      const existing = byId.get(r.id);
      byId.set(r.id, existing?.ui?.mode === "committed" ? existing : r);
    }
    return Array.from(byId.values()).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  });
};
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Manual verify**

Restart dev server. With at least one *committed* meal from earlier today: open the meal logger sheet. The Chat tab should be empty (no scroll back through earlier meals). Now start a new meal: tap "+" → type "had toast" → confirm Nora's preview appears. Cancel the draft via "+ New meal". Re-open the sheet → empty again.

- [ ] **Step 5: Commit**

```bash
git add components/log/MealLoggerChatTab.tsx
git commit -m "feat(meal-log): scope sheet thread query to active drafts only

The fetch query was time-windowed to today's start, which surfaced every
meal-logging exchange of the day (including completed meals' clarification
turns). New query joins via food_log_entries.status='draft' so the thread
only renders rows belonging to in-flight drafts. Cancelled drafts are
already hard-deleted; committed drafts will be after Tasks 6+7 land.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: DELETE chat on commit + transient "✓ Logged" pill

**Files:**
- Modify: `components/log/MealLoggerChatTab.tsx:644-666` (the `onCommitted` callback passed to `MealLoggerPreviewCard`)

- [ ] **Step 1: Add `recentlyCommitted` state for the post-commit pill**

Near the other `useState` declarations at the top of the component (around lines 92-103), add:

```ts
// Transient post-commit confirmation: appears for ~3s after a successful
// commit so the chat tab doesn't appear to do nothing when it suddenly
// clears. React-local; cleared by timer or sheet close.
const [recentlyCommitted, setRecentlyCommitted] = useState<{
  slot: MealSlot;
  summary: string;
} | null>(null);
```

- [ ] **Step 2: Patch the `onCommitted` callback to DELETE + show the pill**

Replace the existing `onCommitted` callback at lines 644-666:

```ts
onCommitted={async () => {
  // Build the summary BEFORE we drop the draft from local state.
  const summary = activeDraft.items
    .map((it) => `${it.name} · ${Math.round(it.kcal)} kcal`)
    .join(", ");

  // Delete all chat rows tagged with this draft. Includes the preview row
  // itself — that's intentional. The MealSlotCard on /diet now shows the
  // committed meal as the durable record.
  const { error: delErr } = await supabase
    .from("chat_messages")
    .delete()
    .eq("user_id", userId)
    .eq("kind", "meal_log")
    .eq("draft_entry_id", activeDraft.id);
  if (delErr) console.warn("[meal-log] chat cleanup failed", delErr);

  // Local state prune (don't wait for refetch).
  setMessages((prev) => prev.filter((m) => m.draft_entry_id !== activeDraft.id && m.id !== activePreviewMsg.id));
  setDrafts((prev) => {
    const next = { ...prev };
    delete next[activeDraft.id];
    return next;
  });

  // Transient pill — auto-clear after 3s.
  setRecentlyCommitted({ slot: activeDraft.meal_slot, summary });
  setTimeout(() => setRecentlyCommitted(null), 3000);

  await onCommitted();
}}
```

Note: the existing `update({ ui: { mode: 'committed', ... } })` call is gone — we're deleting the row entirely, not updating it.

The `m.draft_entry_id` reference requires extending the local `ThreadMessage` type at lines 39-45:

```ts
type ThreadMessage = {
  id: string;
  speaker: "user" | "nora";
  content: string;
  ui: { mode: "preview" | "committed" | "cancelled"; entry_id?: string } | null;
  created_at: string;
  draft_entry_id?: string | null;
};
```

And include `draft_entry_id` in both fetch selects (Task 5's queries):

```ts
.select("id, speaker, content, ui, created_at, draft_entry_id")
```

- [ ] **Step 3: Render the "✓ Logged" pill at the top of the chat feed**

Just inside the scrolling feed div at `MealLoggerChatTab.tsx:579`, above the `messages.length === 0` empty-state block, add:

```tsx
{recentlyCommitted && (
  <div className="flex justify-center">
    <div className="rounded-full bg-emerald-900/60 text-emerald-200 px-3 py-1 text-xs">
      ✓ Logged · {mealSlotLabel(recentlyCommitted.slot)} — {recentlyCommitted.summary}
    </div>
  </div>
)}
```

Import `mealSlotLabel` at the top of the file if not already imported: `import { mealSlotLabel } from "@/lib/food/meal-slot";`

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 5: Manual verify**

Dev server. Open meal logger → "had a banana" → Nora replies → Confirm. Expected:
- The "✓ Logged · Breakfast — banana · 105 kcal" pill appears, fades after ~3s.
- The Chat tab thread becomes empty (the user bubble + Nora's reply are gone).
- The `/diet` Breakfast slot card now shows the entry.

Verify in SQL:

```sql
select count(*) from public.chat_messages
where user_id = '<your-uuid>'
  and kind = 'meal_log'
  and draft_entry_id = '<the-just-committed-entry-id>';
-- Expected: 0
```

- [ ] **Step 6: Commit**

```bash
git add components/log/MealLoggerChatTab.tsx
git commit -m "feat(meal-log): delete chat rows on commit + transient pill

DELETE chat_messages WHERE draft_entry_id=<just-committed> on the commit
path, then show a ~3s '✓ Logged' pill so the suddenly-empty Chat tab
doesn't read as a no-op. Sheet stays open per existing UX (user often
logs multiple meals back to back).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: DELETE chat on cancel

**Files:**
- Modify: `components/log/MealLoggerChatTab.tsx:458-479` (`cancelActiveDraft`)
- Modify: `components/log/MealLoggerChatTab.tsx:667-674` (`onCancelled` callback)

- [ ] **Step 1: Add chat DELETE to `cancelActiveDraft`**

Replace `cancelActiveDraft` at lines 458-479:

```ts
const cancelActiveDraft = async () => {
  const active = findActiveDraft();
  if (!active) return;

  // Delete the food_log_entries draft row (existing behavior).
  await fetch(`/api/food/entries/${active.id}`, { method: "DELETE" }).catch(
    (e) => console.warn("[meal-log] DELETE entry failed (best-effort)", e),
  );

  // Delete all chat rows tagged with this draft (new).
  const { error: delErr } = await supabase
    .from("chat_messages")
    .delete()
    .eq("user_id", userId)
    .eq("kind", "meal_log")
    .eq("draft_entry_id", active.id);
  if (delErr) console.warn("[meal-log] chat cleanup on cancel failed", delErr);

  // Local state prune — clear ALL messages tied to the cancelled draft,
  // not just the preview row.
  setMessages((prev) => prev.filter((m) => m.draft_entry_id !== active.id));
  setDrafts((prev) => {
    const next = { ...prev };
    delete next[active.id];
    return next;
  });
};
```

- [ ] **Step 2: Add the same DELETE to the `onCancelled` callback**

In the `MealLoggerPreviewCard` props at lines 667-674:

```ts
onCancelled={async () => {
  const { error: delErr } = await supabase
    .from("chat_messages")
    .delete()
    .eq("user_id", userId)
    .eq("kind", "meal_log")
    .eq("draft_entry_id", activeDraft.id);
  if (delErr) console.warn("[meal-log] chat cleanup on cancel failed", delErr);

  setMessages((prev) => prev.filter((m) => m.draft_entry_id !== activeDraft.id));
  setDrafts((prev) => {
    const next = { ...prev };
    delete next[activeDraft.id];
    return next;
  });
}}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Manual verify both cancel paths**

Dev server. Test path A (in-card Cancel):
- Open meal logger → "had cheese" → wait for Nora reply → tap Cancel on the preview card → confirm both the food entry and the chat exchange disappear.

Test path B (sheet-level "+ New meal"):
- Open meal logger → "had bread" → wait for reply → tap "+ New meal (cancels current draft)" pill → confirm same outcome.

SQL verify:

```sql
select count(*) from public.chat_messages
where user_id = '<your-uuid>'
  and kind = 'meal_log'
  and draft_entry_id = '<the-just-cancelled-entry-id>';
-- Expected: 0
```

- [ ] **Step 5: Commit**

```bash
git add components/log/MealLoggerChatTab.tsx
git commit -m "feat(meal-log): delete chat rows on cancel

Mirrors Task 6's commit path: DELETE chat_messages WHERE
draft_entry_id=<cancelled> on both cancellation paths (cancelActiveDraft
via the '+ New meal' pill and the preview card's Cancel button).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — /diet redesign (Yazio-style)

### Task 8: KcalRing pure component

**Files:**
- Create: `components/diet/KcalRing.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/diet/KcalRing.tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  eaten: number;
  target: number;
  burned: number | null;
};

/** Yazio-style 270° calorie ring. Eaten on the left, burned on the right,
 *  remaining in the center as the dominant number. Pure presentation —
 *  parent supplies the three values; ring fills based on (eaten / target)
 *  clamped to [0, 1.2] (overshoots show a fuller-than-full arc). */
export function KcalRing({ eaten, target, burned }: Props) {
  const safeTarget = target > 0 ? target : 2000;
  const remaining = Math.max(0, safeTarget - eaten);
  const fillPct = Math.min(1.2, eaten / safeTarget);

  // 270deg arc: stroke-dasharray totals 270/360 of the circumference.
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * (270 / 360);
  const filled = arcLength * fillPct;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-[180px] h-[180px]">
        <svg
          width={180}
          height={180}
          viewBox="0 0 180 180"
          style={{ transform: "rotate(135deg)" }}
        >
          {/* Track (full 270deg) */}
          <circle
            cx={90}
            cy={90}
            r={radius}
            fill="none"
            stroke={COLOR.divider}
            strokeWidth={10}
            strokeDasharray={`${arcLength} ${circumference}`}
          />
          {/* Fill (eaten portion) */}
          <circle
            cx={90}
            cy={90}
            r={radius}
            fill="none"
            stroke={COLOR.accent}
            strokeWidth={10}
            strokeDasharray={`${filled} ${circumference}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-3xl font-bold tabular-nums" style={{ color: COLOR.textStrong }}>
            {fmtNum(remaining)}
          </div>
          <div className="text-xs uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
            Remaining
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-8 text-center">
        <div>
          <div className="text-lg font-semibold tabular-nums" style={{ color: COLOR.textStrong }}>
            {fmtNum(eaten)}
          </div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
            Eaten
          </div>
        </div>
        <div>
          <div className="text-lg font-semibold tabular-nums" style={{ color: COLOR.textStrong }}>
            {burned === null ? "—" : fmtNum(burned)}
          </div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
            Burned
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add components/diet/KcalRing.tsx
git commit -m "feat(diet): KcalRing presentational component

270deg arc with eaten/target fill, remaining as the dominant center
number, eaten + burned as supporting numbers below. Pure presentation;
consumer supplies the three values. Burned renders '—' when NULL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: MacroBars pure component

**Files:**
- Create: `components/diet/MacroBars.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/diet/MacroBars.tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Macro = { label: string; eaten: number; target: number; color: string };

type Props = {
  carbs: { eaten: number; target: number };
  protein: { eaten: number; target: number };
  fat: { eaten: number; target: number };
};

export function MacroBars({ carbs, protein, fat }: Props) {
  const rows: Macro[] = [
    { label: "Carbs", eaten: carbs.eaten, target: carbs.target, color: "#fbbf24" },
    { label: "Protein", eaten: protein.eaten, target: protein.target, color: "#34d399" },
    { label: "Fat", eaten: fat.eaten, target: fat.target, color: "#a78bfa" },
  ];

  return (
    <div className="flex flex-col gap-2 mt-4">
      {rows.map((r) => {
        const pct = r.target > 0 ? Math.min(1, r.eaten / r.target) : 0;
        return (
          <div key={r.label}>
            <div className="flex justify-between text-[11px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
              <span>{r.label}</span>
              <span className="tabular-nums">{fmtNum(r.eaten)} / {fmtNum(r.target)} g</span>
            </div>
            <div className="h-1.5 rounded-full mt-1 overflow-hidden" style={{ background: COLOR.divider }}>
              <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: r.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add components/diet/MacroBars.tsx
git commit -m "feat(diet): MacroBars presentational component

Three rows (Carbs/Protein/Fat) with label + eaten/target + fill bar.
Pure presentation; one consumer (SummaryCard) feeds it the values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: SummaryCard composing KcalRing + MacroBars

**Files:**
- Create: `components/diet/SummaryCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/diet/SummaryCard.tsx
"use client";

import { COLOR, RADIUS } from "@/lib/ui/theme";
import { KcalRing } from "./KcalRing";
import { MacroBars } from "./MacroBars";

type Props = {
  eaten: number;
  target: number;
  burned: number | null;
  macros: {
    carbs: { eaten: number; target: number };
    protein: { eaten: number; target: number };
    fat: { eaten: number; target: number };
  };
};

export function SummaryCard({ eaten, target, burned, macros }: Props) {
  return (
    <div
      className="mx-4 p-5"
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.cardHero,
      }}
    >
      <div className="text-[11px] uppercase tracking-wider mb-3" style={{ color: COLOR.textMuted }}>
        Summary
      </div>
      <KcalRing eaten={eaten} target={target} burned={burned} />
      <MacroBars carbs={macros.carbs} protein={macros.protein} fat={macros.fat} />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add components/diet/SummaryCard.tsx
git commit -m "feat(diet): SummaryCard composes KcalRing + MacroBars

Single consumer entry point for the /diet hero block. Wraps the ring +
bars in the shared surface treatment with a 'Summary' label.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: MealSlotCardCollapsed component

**Files:**
- Create: `components/diet/MealSlotCardCollapsed.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/diet/MealSlotCardCollapsed.tsx
"use client";

import { useState } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { MealSlot, FoodLogEntry } from "@/lib/food/types";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import { MealSlotCard } from "@/components/meal/MealSlotCard";
import { MealSlotEmptyCard } from "@/components/meal/MealSlotEmptyCard";

const SLOT_ICON: Record<MealSlot, string> = {
  breakfast: "🍳",
  lunch: "🍝",
  dinner: "🥗",
  snack: "🍎",
};

type Props = {
  slot: MealSlot;
  entries: FoodLogEntry[];
  targetKcal: number;
  onLog: (slot: MealSlot) => void;
  onCopyYesterday?: (slot: MealSlot) => void;
};

/** Collapsed Yazio-style slot card. Tap the card body → expand inline
 *  (renders the existing per-slot detail rows). Tap "+" → open logger
 *  pinned to this slot. */
export function MealSlotCardCollapsed({
  slot,
  entries,
  targetKcal,
  onLog,
  onCopyYesterday,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const eatenKcal = entries.reduce((sum, e) => sum + (e.totals?.kcal ?? 0), 0);

  return (
    <div
      className="mx-4 mb-2"
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        overflow: "hidden",
      }}
    >
      <div className="flex items-center px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <div className="text-2xl">{SLOT_ICON[slot]}</div>
          <div className="flex-1">
            <div className="text-sm font-semibold" style={{ color: COLOR.textStrong }}>
              {mealSlotLabel(slot)}
            </div>
            <div className="text-xs tabular-nums" style={{ color: COLOR.textMuted }}>
              {fmtNum(eatenKcal)} / {fmtNum(targetKcal)} kcal
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onLog(slot)}
          aria-label={`Log ${mealSlotLabel(slot)}`}
          className="w-9 h-9 rounded-full flex items-center justify-center text-lg font-bold ml-2"
          style={{ background: COLOR.surfaceAlt, color: COLOR.textStrong }}
        >
          +
        </button>
      </div>

      {expanded && entries.length > 0 && (
        <div className="px-4 pb-3" style={{ borderTop: `1px solid ${COLOR.divider}` }}>
          <MealSlotCard
            slot={slot}
            entries={entries}
            onLog={onLog}
            onCopyYesterday={onCopyYesterday}
          />
        </div>
      )}

      {expanded && entries.length === 0 && (
        <div className="px-4 pb-3" style={{ borderTop: `1px solid ${COLOR.divider}` }}>
          <MealSlotEmptyCard
            slot={slot}
            onLog={onLog}
            onCopyYesterday={onCopyYesterday}
          />
        </div>
      )}
    </div>
  );
}
```

If the existing `<MealSlotCard/>` / `<MealSlotEmptyCard/>` prop signatures differ from what's above, adjust to match — open those files first and copy the prop shapes exactly. Don't re-derive what they're computing.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0. If the prop shape doesn't match, the typecheck will tell you which prop is wrong — fix the call site, not the underlying component (those are still in use elsewhere).

- [ ] **Step 3: Commit**

```bash
git add components/diet/MealSlotCardCollapsed.tsx
git commit -m "feat(diet): MealSlotCardCollapsed with tap-to-expand

Yazio-style slot card: icon + name + eaten/target kcal + '+' to log,
collapsed by default. Tap the card body to expand the existing
MealSlotCard / MealSlotEmptyCard inline. Expansion state is per-card,
not persisted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: DietJournalClient — the new top-level client

**Files:**
- Create: `components/diet/DietJournalClient.tsx`
- Source for the date scrubber + targets/entries fetching: `components/meal/MealJournalClient.tsx` (copy the parts that still apply; drop the old summary block)

- [ ] **Step 1: Read the existing MealJournalClient to understand its hooks**

Open `components/meal/MealJournalClient.tsx`. Identify: which TanStack Query hooks it uses, how it computes `entriesBySlot`, how `targetsForAllSlots` is invoked, and what the date-scrubber API looks like. You're going to reuse all of these — the only thing changing is the rendering layer.

- [ ] **Step 2: Write the new client**

```tsx
// components/diet/DietJournalClient.tsx
"use client";

import { useMemo, useState } from "react";
import type { MealSlot } from "@/lib/food/types";
import { SummaryCard } from "./SummaryCard";
import { MealSlotCardCollapsed } from "./MealSlotCardCollapsed";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";

// NOTE: import the same hooks/helpers MealJournalClient uses. Substitute
// these for the actual ones from your codebase — the names below mirror
// the hybrid-SSR-hydrate convention from CLAUDE.md.
import { useFoodEntries } from "@/lib/query/hooks/foodEntries"; // adjust if name differs
import { useTodayTargets } from "@/lib/query/hooks/todayTargets"; // adjust
import { useDailyLog } from "@/lib/query/hooks/dailyLogs"; // adjust
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { DayScrubber } from "@/components/meal/DayScrubber"; // adjust path if needed

const SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

type Props = { userId: string; initialDate: string };

export function DietJournalClient({ userId, initialDate }: Props) {
  const [date, setDate] = useState<string>(initialDate);
  const [loggerSlot, setLoggerSlot] = useState<MealSlot | null>(null);

  const { data: entries = [] } = useFoodEntries(userId, date);
  const { data: targets } = useTodayTargets(userId, date);
  const { data: dailyLog } = useDailyLog(userId, date);

  const eaten = dailyLog?.calories_eaten ?? 0;
  const burned = dailyLog?.active_calories ?? null;
  const target = targets?.kcal ?? 0;

  const slotTargets = useMemo(
    () => (targets ? targetsForAllSlots(targets) : null),
    [targets],
  );

  const entriesBySlot = useMemo(() => {
    const map: Record<MealSlot, typeof entries> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: [],
    };
    for (const e of entries) {
      const slot = e.meal_slot as MealSlot;
      if (map[slot]) map[slot].push(e);
    }
    return map;
  }, [entries]);

  return (
    <>
      <DayScrubber date={date} onDateChange={setDate} />

      <SummaryCard
        eaten={eaten}
        target={target}
        burned={burned}
        macros={{
          carbs: { eaten: dailyLog?.carbs_g ?? 0, target: targets?.macros?.carbs_g ?? 0 },
          protein: { eaten: dailyLog?.protein_g ?? 0, target: targets?.macros?.protein_g ?? 0 },
          fat: { eaten: dailyLog?.fat_g ?? 0, target: targets?.macros?.fat_g ?? 0 },
        }}
      />

      <div className="mt-5">
        <div className="mx-4 mb-2 text-[11px] uppercase tracking-wider" style={{ color: "#888" }}>
          Meals
        </div>
        {SLOTS.map((slot) => (
          <MealSlotCardCollapsed
            key={slot}
            slot={slot}
            entries={entriesBySlot[slot]}
            targetKcal={slotTargets?.[slot]?.kcal ?? 0}
            onLog={(s) => setLoggerSlot(s)}
          />
        ))}
      </div>

      {loggerSlot && (
        <MealLoggerSheet
          open={loggerSlot !== null}
          onClose={() => setLoggerSlot(null)}
          userId={userId}
          initialMealSlot={loggerSlot}
        />
      )}
    </>
  );
}
```

If the hook names / shapes in your codebase differ (likely — the names above are best-guess based on CLAUDE.md), update the imports to the actual ones. Search the existing `MealJournalClient.tsx` for the exact patterns and copy them. The point is the *structure* of this component; the data hooks are whatever the project already uses.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0. Resolve any import name mismatches by checking what `MealJournalClient.tsx` imports.

- [ ] **Step 4: Commit**

```bash
git add components/diet/DietJournalClient.tsx
git commit -m "feat(diet): DietJournalClient top-level client

Replaces MealJournalClient as /diet's render entry point. Composes
SummaryCard (ring + bars) + four collapsed slot cards + DayScrubber +
MealLoggerSheet. Reuses the existing TanStack Query hooks for entries,
targets, and daily_logs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Refactor /diet page, delete dead components, manual verify

**Files:**
- Modify: `app/diet/page.tsx`
- Delete: `components/diet/DietCoachClient.tsx`, `components/meal/MealJournalClient.tsx`, `components/meal/MealJournalDay.tsx`
- Leave on disk untouched (no imports): `components/diet/BodyCompCard.tsx` (sub-project C reuses it later — see spec)

- [ ] **Step 1: Refactor `app/diet/page.tsx`**

Open `app/diet/page.tsx` and look at its current shape (the Coach|Log tab switching). Replace its render block to mount `<DietJournalClient/>` directly. Keep the existing auth gate + prefetch logic intact; just update the prefetch list and the rendered child.

Sketch (adapt to your actual page shape):

```tsx
// app/diet/page.tsx
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets";
import { fetchDailyLogServer } from "@/lib/query/fetchers/dailyLogs";
import { queryKeys } from "@/lib/query/keys";
import { DietJournalClient } from "@/components/diet/DietJournalClient";

export default async function DietPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);
  const queryClient = makeServerQueryClient();

  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.foodEntries.byDate(user.id, today),
      queryFn: () => fetchFoodEntriesServer(supabase, user.id, today),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.todayTargets.forDate(user.id, today),
      queryFn: () => fetchTodayTargetsServer(supabase, user.id, today),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.forDate(user.id, today),
      queryFn: () => fetchDailyLogServer(supabase, user.id, today),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DietJournalClient userId={user.id} initialDate={today} />
    </HydrationBoundary>
  );
}
```

Substitute fetcher / queryKey names with the ones your project actually uses. The pattern is "hybrid SSR-hydrate" from CLAUDE.md.

- [ ] **Step 2: Delete the now-orphan files**

```bash
rm components/diet/DietCoachClient.tsx
rm components/meal/MealJournalClient.tsx
rm components/meal/MealJournalDay.tsx
```

Run a grep to confirm nothing imports them:

```bash
grep -rn "DietCoachClient\|MealJournalClient\|MealJournalDay" --include="*.ts" --include="*.tsx"
```

Expected: zero hits (or only inside the deleted files themselves, which are now gone).

If you find dangling imports, fix them by routing to the new components, then re-run.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Manual verify in browser**

```bash
npm run dev
```

Open `/diet` in the browser.

Check each:
- Header shows the date / scrubber row (no "Diet"/"Nora" chrome, no Coach|Log tabs).
- Summary card shows the kcal ring with Eaten / Remaining / Burned.
- "Burned" shows a number (your active_calories) or "—" if no Apple Health for today.
- Three macro bars below the ring.
- Four collapsed meal cards, each with icon + label + "0 / target kcal" + "+".
- Tap "+" on any slot → MealLoggerSheet opens pinned to that slot.
- Tap card body → expands to show entries (if any).
- Date scrubber: swipe back a few days → summary + cards re-fetch.

Run the end-to-end smoke test:
- Tap "+" on Breakfast → "had two eggs" → wait for Nora → Confirm.
- Expected: pill appears ~3s, chat tab clears, sheet stays open, Breakfast card on `/diet` updates to show "140 / 570 kcal" (or whatever the eggs computed to).

- [ ] **Step 5: Commit**

```bash
git add app/diet/page.tsx components/diet/ components/meal/
git rm components/diet/DietCoachClient.tsx components/meal/MealJournalClient.tsx components/meal/MealJournalDay.tsx 2>/dev/null || true
git commit -m "feat(diet): mount DietJournalClient + drop Coach|Log tabs

Replaces app/diet/page.tsx's Coach|Log tab layout with a single
DietJournalClient render. Deletes DietCoachClient, MealJournalClient,
MealJournalDay — superseded by the new components. BodyCompCard left
on disk for sub-project C to absorb.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Wrap-up

After Task 13:

- [ ] Re-run the audit script one more time on the live data to confirm no untagged meal_log rows are being created.
- [ ] Open `/coach` (the main Nora chat surface) and confirm it's untouched — meal-logging chat changes shouldn't leak there.
- [ ] Open `/metrics?sub=log` and `/metrics?sub=strength` and `/metrics?sub=body` — the Log sub-pill in particular must still work (per CLAUDE.md "Never delete the Log tab"; this plan touches `/diet` but not `/metrics`).
- [ ] If you'd like to commit a CLAUDE.md update reflecting the new `/diet` shape, that's a follow-up; this plan deliberately doesn't.

## Out of scope (per spec)

- Water tracker.
- "Details" / "More" header links.
- Per-meal photo thumbnails.
- Streak/flame icons.
- Editing committed food entries via chat.
- BodyCompCard removal — left on disk for sub-project C.
- Sub-projects C (trends view) and D (Nora coaching intelligence).
