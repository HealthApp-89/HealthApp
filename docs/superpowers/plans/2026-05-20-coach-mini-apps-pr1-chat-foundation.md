# PR 1 — Chat foundation (coach mini-apps restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `chat_messages.thread` column, retire the `delegate_to_specialist` (`handoff_to`) tool and its mid-stream handoff machinery, and stamp `thread` on every chat-message write. Old `/coach` continues to work — the pre-stream `classifyTurn` router still picks a speaker, and the resulting `thread` value just mirrors that speaker.

**Architecture:** Two structural moves. (1) Schema: `chat_messages.thread text not null check in ('peter','carter','nora','remi')` with backfill. Every assistant insert / update path in the codebase learns to stamp it; the column's default of `'peter'` covers anything we miss. (2) Code: the `handoff_to` tool, the `HANDOFF_TOOL` import chain, the `'handoff'` yield in `ChatStreamYield`, the mode-gating handoff filter in `chat-stream.ts`, and the re-entry loop in `/api/chat/messages/route.ts` all come out. `lib/coach/router.ts` stays untouched — it survives until PR 6 because the existing `/coach` UI still depends on it.

No UI moves. No new routes. No new specialist pages. This PR is pure plumbing for everything PRs 2-6 will build on.

**Tech Stack:** Next.js 15 App Router, Supabase Postgres (migrations applied via `supabase db push`), Anthropic SDK, TypeScript strict mode. **This repo has no test suite** — verification at every task is `npm run typecheck` plus a manual `/coach` smoke (send a message, confirm a response streams).

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md)

**Suggested branch:** `feat/coach-pr1-chat-foundation` (cut from `main`).

---

## File Structure

**New:**
- `supabase/migrations/0025_per_coach_threads.sql` — adds `chat_messages.thread`, backfills from `speaker`, adds per-thread index.

**Modified:**
- `lib/coach/chat-stream.ts` — drops handoff intercept, drops `handoff` yield variant, drops `handoffDepth`/`HANDOFF_TOOL` gating, drops `HANDOFF_TOOL_NAME` import.
- `lib/coach/tools.ts` — removes `HANDOFF_TOOL` from `PETER_TOOLS` / `CARTER_TOOLS` / `NORA_TOOLS` / `REMI_TOOLS` and drops the import.
- `app/api/chat/messages/route.ts` — drops the handoff re-entry loop around `runChatStream`; stamps `thread` on every `chat_messages` insert/update inside this route.
- `lib/coach/proactive/index.ts` — stamps `thread` (and the corresponding `speaker`) per event based on trigger ownership.

**Deleted:**
- `lib/coach/handoff-tool.ts`

**Untouched (deferred to PR 6):**
- `lib/coach/router.ts` — still used by `/coach` UI; deleted in PR 6.
- `lib/chat/sse.ts` `handoff` wire event (if present) — vestigial after this PR but only removed once no producer remains.

---

## Task 1: Migration 0025 — `chat_messages.thread`

**Files:**
- Create: `supabase/migrations/0025_per_coach_threads.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 0025_per_coach_threads.sql
--
-- Per-coach threading. Adds chat_messages.thread (peter|carter|nora|remi).
-- Every message belongs to exactly one thread; this is the conversation lane
-- a user is in when they tap a coach page. Assistant turns get their speaker's
-- thread; user turns inherit from the adjacent assistant turn (best-effort
-- backfill).
--
-- The earlier chat_messages.speaker column (migration 0024) stays — speaker
-- identifies WHO authored a message; thread identifies WHICH conversation it
-- belongs to. For assistant rows the two are equal; for user rows speaker='user'
-- but thread is one of the four coaches.
--
-- See spec: docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md

alter table chat_messages
  add column thread text not null default 'peter';

alter table chat_messages
  add constraint chat_messages_thread_check
  check (thread in ('peter','carter','nora','remi'));

-- Assistant rows: thread mirrors speaker.
update chat_messages
   set thread = speaker
 where speaker in ('peter','carter','nora','remi');

-- User rows: inherit thread from the next assistant row in the same user's
-- timeline, or the previous one if there is no later one, or 'peter' as a
-- final fallback. Best-effort — historical conversations stay readable.
with user_turns as (
  select id, user_id, created_at
    from chat_messages
   where speaker = 'user'
),
inferred as (
  select u.id,
         coalesce(
           (select cm.thread
              from chat_messages cm
             where cm.user_id = u.user_id
               and cm.speaker in ('peter','carter','nora','remi')
               and cm.created_at > u.created_at
             order by cm.created_at asc
             limit 1),
           (select cm.thread
              from chat_messages cm
             where cm.user_id = u.user_id
               and cm.speaker in ('peter','carter','nora','remi')
               and cm.created_at < u.created_at
             order by cm.created_at desc
             limit 1),
           'peter'
         ) as inferred_thread
    from user_turns u
)
update chat_messages cm
   set thread = i.inferred_thread
  from inferred i
 where cm.id = i.id;

create index chat_messages_thread_idx
  on chat_messages (user_id, thread, created_at desc);
```

- [ ] **Step 2: Apply the migration**

Run from repo root:
```bash
supabase db push
```

Expected: prints `Applying migration 0025_per_coach_threads.sql...` and finishes without error. If there's a history-state mismatch (this is the project's known recovery path), run `supabase migration repair --status applied 0024_coach_team` and retry.

- [ ] **Step 3: Verify the column + backfill**

```bash
supabase db remote query "select thread, count(*) from chat_messages group by thread order by count desc;"
```

Expected: rows show non-zero counts for `peter` (everything pre-multi-coach) and possibly `carter`/`nora`/`remi` if you've previously used the auto-routing UI. No rows should be missing `thread` (the column is NOT NULL with a default).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0025_per_coach_threads.sql
git commit -m "feat(chat): add chat_messages.thread column for per-coach threading"
```

---

## Task 2: Drop handoff intercept from `chat-stream.ts`

**Files:**
- Modify: `lib/coach/chat-stream.ts`

This task removes the entire handoff machinery from the streaming loop. The route's re-entry loop comes out in Task 4; this task makes the chat-stream stop producing handoff events.

- [ ] **Step 1: Remove the `HANDOFF_TOOL_NAME` import**

In `lib/coach/chat-stream.ts`, delete this line (around line 63):

```ts
import { HANDOFF_TOOL_NAME } from "@/lib/coach/handoff-tool";
```

- [ ] **Step 2: Remove the `handoff` yield variant**

In `lib/coach/chat-stream.ts`, find the `ChatStreamYield` union type (starts around line 86). Remove the entire `| { type: "handoff"; ... }` arm and its preceding doc-comment. Also remove `SPEAKERS` from the existing `@/lib/data/types` import in the same file if `SPEAKERS` is no longer referenced after this task completes (grep for it inside `chat-stream.ts` after the edits).

Replace:

```ts
export type ChatStreamYield =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number }
  | { type: "done" }
  | { type: "error"; message: string }
  /** Any coach called HANDOFF_TOOL. ... */
  | { type: "handoff"; from: Speaker; to: Speaker; briefing: string | null };
```

With:

```ts
export type ChatStreamYield =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number }
  | { type: "done" }
  | { type: "error"; message: string };
```

- [ ] **Step 3: Remove `handoffDepth` from `RunChatStreamOpts` and add `thread`**

In `lib/coach/chat-stream.ts`, find `RunChatStreamOpts` (around line 122). Remove the `handoffDepth?: number;` field and its leading doc-comment block.

In the same `RunChatStreamOpts` type, add a new optional field right below `speaker?`:

```ts
  /** Conversation thread this turn belongs to. One of 'peter' | 'carter' |
   *  'nora' | 'remi'. Defaults to opts.speaker (assistant turns are always
   *  in their own speaker's thread). Reserved for PR 6 when the chat surface
   *  no longer routes — the page passes the thread directly and chat-stream
   *  fixes the speaker to it. In PR 1 this is informational; the route still
   *  derives speaker from the router and passes thread = speaker. */
  thread?: "peter" | "carter" | "nora" | "remi";
```

Then, inside the `runChatStream` function body, just below the existing `const speaker: Speaker = opts.speaker ?? "peter";` line (around line 171), add:

```ts
  // Resolve thread for symmetry with PR 6. In PR 1 it equals speaker; the
  // route does not yet pass thread explicitly, but the helper supports it
  // so subsequent PRs can wire it without touching this file's signature.
  const _thread: Speaker = opts.thread ?? speaker;
  void _thread;
```

The `void _thread` keeps TypeScript happy about the unused binding while documenting intent.

- [ ] **Step 4: Remove the handoff filter in `modeAllowsTool`**

In `lib/coach/chat-stream.ts`, inside the `runChatStream` function body (around line 210), remove:

```ts
  const handoffDepth = opts.handoffDepth ?? 0;
```

And inside `modeAllowsTool` (around line 215), remove the entire `if (name === HANDOFF_TOOL_NAME) { ... }` block at the top of the function.

- [ ] **Step 5: Remove the handoff intercept inside the tool-use loop**

In `lib/coach/chat-stream.ts`, around line 337-372, find the comment block starting `// ── Handoff intercept ───────` and delete from that comment through the closing `return;` of the `if (handoffBlock)` body (inclusive). Stop just before the line `// Append the assistant message verbatim` so that the surrounding loop is intact.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. Any remaining reference to `HANDOFF_TOOL_NAME` or `handoffDepth` in `chat-stream.ts` will surface here.

If typecheck flags an unused `Speaker` import or similar, leave the imports alone — they're used elsewhere in this file (the `speaker: Speaker = opts.speaker ?? "peter"` line still needs the type).

- [ ] **Step 7: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "refactor(chat): remove mid-stream handoff intercept from chat-stream"
```

---

## Task 3: Drop `HANDOFF_TOOL` from tool arrays + delete `handoff-tool.ts`

**Files:**
- Modify: `lib/coach/tools.ts`
- Delete: `lib/coach/handoff-tool.ts`

- [ ] **Step 1: Remove `HANDOFF_TOOL` from all four tool arrays**

In `lib/coach/tools.ts`, find each of `PETER_TOOLS`, `CARTER_TOOLS`, `NORA_TOOLS`, `REMI_TOOLS` (around lines 3042-3120). In each array, delete the `HANDOFF_TOOL,` entry. In `PETER_TOOLS` the line is:

```ts
  HANDOFF_TOOL, // generalized handoff — any speaker, any target except self
```

In the other three it's a bare `HANDOFF_TOOL,`. Remove all four. Update the comment block above `PETER_TOOLS` that says "HANDOFF_TOOL is appended to every speaker's list so any coach can punt a turn to another. Mode gating in chat-stream.ts hides HANDOFF_TOOL during intake mode (single-voice wizard)." — replace it with:

```ts
// Per-speaker tool partitions. Each specialist gets a narrower lane-specific
// subset (column-restricted at execute time via colsForSpeaker(speaker)).
// The legacy handoff_to tool (sub-project #2 "multi-coach team") was removed
// when the coach mini-apps restructure (sub-project #3) moved each specialist
// onto its own page — users now pick a coach by tab, so mid-stream handoff is
// dead UX. See docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md.
```

- [ ] **Step 2: Remove the `HANDOFF_TOOL` import**

In `lib/coach/tools.ts`, delete (around line 3030):

```ts
import { HANDOFF_TOOL } from "./handoff-tool";
```

- [ ] **Step 3: Delete `handoff-tool.ts`**

```bash
git rm lib/coach/handoff-tool.ts
```

- [ ] **Step 4: Confirm no remaining callers**

```bash
grep -rn "handoff-tool\|HANDOFF_TOOL\|HANDOFF_TOOL_NAME\|handoff_to" lib app components 2>/dev/null | grep -v ".next"
```

Expected: no results. (The route's `'handoff'` event listener disappears in Task 4 — if grep flags it now, that's expected and will be cleaned up in Task 4.)

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS, except for one expected failure in `app/api/chat/messages/route.ts` if it currently has a `case "handoff":` branch on the `chat-stream` yield union — that branch will reference the now-removed `handoff` arm. That's the work for Task 4.

If typecheck fails outside the chat route, investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "refactor(chat): remove handoff_to tool and delete handoff-tool.ts"
```

---

## Task 4: Remove handoff re-entry loop from `/api/chat/messages/route.ts`

**Files:**
- Modify: `app/api/chat/messages/route.ts`

The route wraps `runChatStream` in a local helper `drainStream(activeSpeaker, messages, handoffDepth)` that returns a `{ to, briefing }` object when the underlying stream yields a `handoff` event. The current code then calls `drainStream` a second time with `handoffDepth=1` for the receiving coach. With the `handoff` yield variant gone (Task 2), the second call is dead and `drainStream`'s return type collapses to `void`.

- [ ] **Step 1: Find the handoff branch**

```bash
grep -n "handoff\|drainStream\|runChatStream" app/api/chat/messages/route.ts
```

The handoff branch is the `if (handoff && !errored && !aborted) { ... }` block around lines 705-793 (your line numbers may shift slightly after Task 5's edits — re-grep if so).

- [ ] **Step 2: Delete the handoff branch**

In `app/api/chat/messages/route.ts`, delete the entire block starting at the `if (handoff && !errored && !aborted) {` line and ending at its closing `}` (currently lines 705-793). This removes:

- The `system_routing` audit row insert for the handoff (block "1) Persist hidden audit row...").
- The `formatSseEvent({event: "handoff", ...})` emission to the client (block "2) Emit handoff SSE event...").
- The `activeSpeaker = handoff.to` reassignment and the stub re-stamp (block "3) Re-stamp the assistant stub...").
- The briefing-injection into `specialistMessages` (block "4) Build the receiving coach's message array...").
- The `accumulated = ""` reset (block "5) Reset accumulated text...").
- The second `drainStream(activeSpeaker, specialistMessages, 1)` call and its defensive `console.warn` (block "6) Re-enter drainStream...").

- [ ] **Step 3: Simplify `drainStream`**

Find the `drainStream` function definition (it's nested inside the route handler, just above the first call). It currently takes `(activeSpeaker, messages, handoffDepth)` and returns a handoff object or `null`. Update it:

- Remove the third parameter `handoffDepth`.
- Remove the `handoffDepth` field from the `runChatStream({...})` call inside `drainStream` (Task 2 already removed it from `RunChatStreamOpts`).
- Inside the `for await (const ev of runChatStream(...))` consumer, the `case "handoff"` branch (or `if (ev.type === "handoff")` check) no longer exists in the union — TypeScript will catch any remaining reference. Delete the branch.
- Change the return type from `Promise<{ to: Speaker; briefing: string | null } | null>` to `Promise<void>` and remove any `return handoffYield` statements.

- [ ] **Step 4: Update the call-site**

Where the route originally did `const handoff = await drainStream(activeSpeaker, messages, 0);`, change to `await drainStream(activeSpeaker, messages);` and delete the now-unused `handoff` binding.

If `activeSpeaker` is no longer reassigned anywhere after the handoff branch is gone, change `let activeSpeaker = initialSpeaker;` to `const activeSpeaker = initialSpeaker;` — TypeScript will flag if any reassignment remains.

- [ ] **Step 5: Check the wire-format SSE helper**

```bash
grep -n "\"handoff\"\|'handoff'" lib/chat/sse.ts components/chat
```

If `lib/chat/sse.ts` has a typed `"handoff"` event variant on its event union, leave it alone for now — the type stays harmless until the client consumer is removed in PR 6. The route's emission (deleted in Step 2) is the only producer in this codebase, so dead clients won't see it after PR 1 lands. Note any client consumer (e.g., `components/chat/ChatPanel.tsx`'s `case "handoff"`) for later cleanup, but do not touch it in PR 1 — removing it now without an SSE producer is safe but expands the PR's surface area.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If a `'handoff'` reference remains anywhere in `app/`, typecheck will fail with a "Type ... is not assignable" error on the `ChatStreamYield` union — find and remove that reference.

- [ ] **Step 7: Smoke `/coach` locally**

```bash
npm run dev
```

In a browser, open `http://localhost:3000/coach`. Send a message: "what should I eat today?" Expected: an assistant response streams in within a few seconds. The router (still alive) probably picks Nora and the response comes back in Nora's voice. No handoff event in the network panel.

If the response hangs or errors, stop and investigate before commit.

- [ ] **Step 8: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "refactor(chat): flatten handoff re-entry loop in /api/chat/messages"
```

---

## Task 5: Stamp `thread` on every chat-message write in the route

**Files:**
- Modify: `app/api/chat/messages/route.ts`

The migration added the column with a default of `'peter'`, so untouched code paths still insert valid rows. But every insert/update in this route that sets `speaker` should also set `thread = <same value>` so the data is correct from day one, and so future per-thread history filters work without surprises.

- [ ] **Step 1: Inventory every `chat_messages` write in this file**

```bash
grep -n "from(\"chat_messages\")\|from('chat_messages')" app/api/chat/messages/route.ts
```

Note every line. Each is either an `insert` or an `update`. There are roughly 8-10 such call-sites in this file.

- [ ] **Step 2: Stamp `thread` on the user-message + assistant-stub creation**

The route uses an RPC `start_chat_turn` (or similar — the inserts you saw at lines 59, 210, 254 are tangential) to create the matched pair. After the RPC returns `{user_message_id, assistant_message_id}`, the route updates both with `mode`. Add `thread: initialSpeaker` to that update.

Find (around line 308):

```ts
await sr
  .from("chat_messages")
  .update({ mode: effectiveMode, updated_at: new Date().toISOString() })
  .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);
```

Note that `initialSpeaker` isn't defined yet at this line — it's set a few lines below after `classifyTurn`. Move this `mode` update so it happens AFTER `initialSpeaker` is computed, OR split it into two updates (one for `mode` here, one for `thread` after routing). The cleaner: split into two updates.

Replace the block above (lines 308-311) with just the `mode` update unchanged. Then, after the line:

```ts
const initialSpeaker: Speaker = routerDecision.speaker;
```

(around line 341), add:

```ts
await sr
  .from("chat_messages")
  .update({ thread: initialSpeaker, updated_at: new Date().toISOString() })
  .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);
```

- [ ] **Step 3: Stamp `thread` on the assistant stub `speaker` update**

Right below that, the route stamps the assistant stub with `speaker: initialSpeaker` (around line 345-348). Add `thread: initialSpeaker` to that same update:

Replace:

```ts
await sr
  .from("chat_messages")
  .update({ speaker: initialSpeaker, updated_at: new Date().toISOString() })
  .eq("id", rpcTyped.assistant_message_id);
```

With:

```ts
await sr
  .from("chat_messages")
  .update({
    speaker: initialSpeaker,
    thread: initialSpeaker,
    updated_at: new Date().toISOString(),
  })
  .eq("id", rpcTyped.assistant_message_id);
```

- [ ] **Step 4: Stamp `thread` on the system_routing audit insert**

A few lines below (around line 352-368), the route inserts the system_routing audit row. Add `thread: initialSpeaker`:

Find the `await sr.from("chat_messages").insert({ ... });` block whose `kind` is `'system_routing'`. Add `thread: initialSpeaker,` between the `speaker:` and `kind:` lines.

- [ ] **Step 5: Stamp `thread` on remaining inserts/updates in this file**

For every other `chat_messages` insert/update you noted in Step 1, check whether it already sets `speaker`. If it does, add `thread:` with the same value next to it. If it doesn't set `speaker` (it's an inert update like setting `status='done'` or `content=...`), leave it — the row already has the correct `thread` from a prior write.

One specific site to update: the `finally` block's final assistant-stub update (around line 804-814 — search for `content: accumulated, status: finalStatus`). It already sets `speaker: activeSpeaker`; add `thread: activeSpeaker` to the same `.update({...})` object so the final persisted state is consistent.

```ts
await sr
  .from("chat_messages")
  .update({
    content: accumulated,
    status: finalStatus,
    error: errored,
    speaker: activeSpeaker,
    thread: activeSpeaker,           // <— add this line
    tool_calls: toolCallSink.length > 0 ? toolCallSink : null,
    updated_at: new Date().toISOString(),
  })
  .eq("id", assistantId);
```

Note: after Task 4 deleted the handoff branch, `activeSpeaker` no longer mutates after `initialSpeaker` is assigned. The `thread: activeSpeaker` stamp is therefore the same value the earlier Step 3 update already wrote, but stamping it again is correct and defensive (the row may have been updated by an out-of-band path in the meantime).

The handoff-audit insert (route.ts ~line 707) is already deleted by Task 4 — skip it.

- [ ] **Step 6: Run typecheck and smoke**

```bash
npm run typecheck
```

Expected: PASS.

```bash
npm run dev
```

Open `/coach`, send a message. Then run:

```bash
supabase db remote query "select id, role, speaker, thread, created_at from chat_messages order by created_at desc limit 5;"
```

Expected: the just-sent user row and assistant row both have `thread` matching the router's pick (`peter`/`carter`/`nora`/`remi` depending on the message content). No `thread = null` rows.

- [ ] **Step 7: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "feat(chat): stamp thread on chat_messages writes in /api/chat/messages"
```

---

## Task 6: Tag proactive nudges with the owning coach's thread

**Files:**
- Modify: `lib/coach/proactive/index.ts`

Currently every proactive nudge insert defaults to `speaker='peter'` (the column default). Under the new model, plateau → Carter, off-pace → Nora, HRV → Remi. The owning coach drives both `speaker` and `thread`.

- [ ] **Step 1: Add a trigger-to-coach map**

In `lib/coach/proactive/index.ts`, just below the imports (around line 27), add:

```ts
import type { Speaker } from "@/lib/data/types";

/** Maps a proactive trigger to the coach whose thread the card lives in.
 *  Plateau (strength stagnation) → Carter; off-pace (weight trend drift)
 *  → Nora; HRV (recovery flag) → Remi. New trigger kinds added later must
 *  appear here with an explicit owner — there is no fallback by design. */
const TRIGGER_OWNER: Record<string, Speaker> = {
  plateau: "carter",
  off_pace: "nora",
  hrv_low: "remi",
};

function ownerForTrigger(triggerKey: string): Speaker {
  const prefix = triggerKey.split(":")[0];
  const owner = TRIGGER_OWNER[prefix];
  if (!owner) {
    throw new Error(`proactive: no owning coach for trigger '${triggerKey}'`);
  }
  return owner;
}
```

The exact set of prefixes depends on what `event.trigger_key` strings the three checkers produce. Confirm before writing:

```bash
grep -n "trigger_key" lib/coach/proactive/check-plateau.ts lib/coach/proactive/check-off-pace.ts lib/coach/proactive/check-hrv.ts
```

If the keys are something other than `plateau:*`, `off_pace:*`, `hrv_low:*` (e.g., `bench_plateau`, `weight_off_pace_4w`, `hrv_below_baseline_5d`), update `TRIGGER_OWNER` to match the actual prefix used by each checker. The mapping must cover every key the three checkers can return.

- [ ] **Step 2: Stamp `speaker` and `thread` on the insert**

In `lib/coach/proactive/index.ts`, find the `await supabase.from("chat_messages").insert({...})` block (around line 88). Add two lines computing the owner and update the insert:

Replace:

```ts
const { data: inserted, error: insertErr } = await supabase
  .from("chat_messages")
  .insert({
    user_id: userId,
    role: "assistant",
    kind: "proactive_nudge",
    content: card.headline,
    ui: card,
  })
  .select("id")
  .single();
```

With:

```ts
const owner = ownerForTrigger(event.trigger_key);
const { data: inserted, error: insertErr } = await supabase
  .from("chat_messages")
  .insert({
    user_id: userId,
    role: "assistant",
    speaker: owner,
    thread: owner,
    kind: "proactive_nudge",
    content: card.headline,
    ui: card,
  })
  .select("id")
  .single();
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Smoke proactive insert (optional but recommended)**

If the project has a way to trigger the proactive cron locally (check `app/api/coach/proactive/check/route.ts` for a `?dry_run=true` query param or a `CRON_SECRET`-bearing curl recipe), run it once with `dry_run=true` to confirm no throws. The dry-run short-circuits the dedup lookup and insert, but exercises `ownerForTrigger` for every event that would fire.

Example (substitute your CRON_SECRET):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/coach/proactive/check?dry_run=true&user_id=<your_uuid>"
```

Expected: 200 OK with a JSON body listing fired/suppressed events. If `ownerForTrigger` throws on any event, the JSON surfaces the error — fix the `TRIGGER_OWNER` map.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/proactive/index.ts
git commit -m "feat(proactive): route nudges to owning coach's thread (Carter/Nora/Remi)"
```

---

## Task 7: Final typecheck + manual smoke + push

- [ ] **Step 1: Full typecheck from a clean state**

```bash
rm -rf .next
npm run typecheck
```

Expected: PASS with zero errors. (Wiping `.next` rules out stale-cache surprises noted in your project memory.)

- [ ] **Step 2: Manual smoke of `/coach`**

```bash
npm run dev
```

In a browser:

1. Open `http://localhost:3000/coach`. Send: "what should I lift today?" → expect Carter to respond (keyword routing).
2. Send: "how many calories did I eat yesterday?" → expect Nora to respond.
3. Send: "@Peter how am I trending overall this month?" → expect Peter via mention.
4. Open the network panel and inspect the SSE stream for the most recent message. Confirm no event with `type: "handoff"` appears in the event log.

- [ ] **Step 3: Confirm chat_messages rows**

```bash
supabase db remote query "select role, speaker, thread, kind, substring(content,1,40) as preview, created_at from chat_messages order by created_at desc limit 12;"
```

Expected: the three test turns from Step 2 show as 6 rows (user + assistant pairs). For each pair, the user row and the assistant row share the same `thread` (`carter`, `nora`, `peter` respectively).

- [ ] **Step 4: Push the branch and open PR (manual)**

The plan stops at the branch push. The user takes over from here to open the PR with their preferred title / description. Suggested title: `feat(chat): coach mini-apps PR1 — chat thread foundation`.

```bash
git push -u origin feat/coach-pr1-chat-foundation
```

---

## Subsequent PRs (not in this plan)

PR 2-6 each get their own plan written when PR 1 ships. Outline from the spec:

- **PR 2** — six-tab nav, new route shells, redirects.
- **PR 3** — Strength page (Coach + Log, read-only history).
- **PR 4** — Diet page (Coach + Log via `/meal` lift).
- **PR 5** — Health page (Coach + Log via morning-intake lift).
- **PR 6** — Metrics page (Peter's synthesis surface with `peter-context.ts` injection) + cleanup of `router.ts`, `app/coach/*`, `app/metrics/_sub/*`, `audit-speaker-routing.mjs`.

Each PR begins from a fresh planning pass against the updated `main` and the spec.
