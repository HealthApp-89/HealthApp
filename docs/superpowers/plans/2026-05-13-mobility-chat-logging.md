# Mobility chat logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two chat tools (`mark_mobility_done` / `unmark_mobility_done`) so the user can confirm a completed mobility session in coach chat — adherence then sees the row and stops marking Wednesday's mobility as `missed`.

**Architecture:** Two new write-tools that upsert/delete a row in the existing `workouts` table with `type='Mobility'`, `source='chat'`, `external_id='chat-mobility-${date}'`. No schema migration, no UI, no changes to adherence math (existing `matches()` handles Mobility correctly). WHOOP-sourced `daily_logs.strain` covers the load signal next morning, unchanged.

**Tech Stack:** Next.js 15 App Router · Supabase (service-role client for tool execution) · Anthropic SDK tool schemas · TypeScript strict.

**Spec:** [docs/superpowers/specs/2026-05-13-mobility-chat-logging-design.md](docs/superpowers/specs/2026-05-13-mobility-chat-logging-design.md)

---

## Conventions (read once before starting)

- **No test suite.** This repo has no unit-test harness and `next lint` is unconfigured (per [CLAUDE.md](CLAUDE.md)). The verification gate for every task is **`npm run typecheck`** (must be clean) plus, for the wiring tasks, a manual chat exercise documented in Task 5. Do not add a test runner or `*.test.ts` files — that's out of scope.
- **Path alias:** use `@/...` not relative climbs (`tsconfig.json` configures `@/*` → repo root).
- **Service role:** tool executors run with the service-role client (`opts.sr` in chat-stream, `opts.supabase` in the executor signature). Every query must still `.eq("user_id", userId)` — this is the project's security invariant (see [lib/coach/tools.ts:5-15](lib/coach/tools.ts#L5-L15)).
- **Sign-off command** at the end of each task:
  ```bash
  npm run typecheck
  ```
  Expected output: no errors, exits 0. If `tsc` reports any error, fix it before committing.
- **Git workflow:** commit at the end of each task using the messages provided. Each task is a single commit.

---

## Files touched (whole-plan map)

| File | Action | Why |
|---|---|---|
| [lib/coach/tools.ts](lib/coach/tools.ts) | Modify (append) | New schemas + executors |
| [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts) | Modify (3 spots) | Import, register in `allTools`, extend mode filter, add dispatch branches |
| [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) | Modify (append section) | Trigger phrasing for the model |

No other files. No migration. No type changes outside `tools.ts`.

---

## Task 1: Add tool schemas + executors in `lib/coach/tools.ts`

**Files:**
- Modify: [lib/coach/tools.ts](lib/coach/tools.ts) — append new schemas and executors after `executeMarkGlp1Discontinued` (file currently ends around line ~2330; append at the bottom).

- [ ] **Step 1: Add the two tool schemas**

Append to [lib/coach/tools.ts](lib/coach/tools.ts) at the end of file, immediately after the last existing executor:

```ts
// ── Mobility chat tools: schemas ─────────────────────────────────────────────

export const MARK_MOBILITY_DONE_TOOL = {
  name: "mark_mobility_done",
  description:
    "User confirmation that a mobility session is complete (today by default; pass `date` for explicit backdates the user mentions). Inserts a workouts row with type='Mobility' and source='chat' so adherence sees the session. Idempotent on (user_id, external_id) where external_id = `chat-mobility-${date}`. Call when the user signals completion (e.g., 'done', 'finished mobility', 'did my session'). Do NOT call without an explicit completion signal.",
  input_schema: {
    type: "object" as const,
    required: [],
    properties: {
      date:  { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD in user's local TZ. Defaults to today." },
      notes: { type: ["string", "null"], maxLength: 280 },
    },
  },
};

export const UNMARK_MOBILITY_DONE_TOOL = {
  name: "unmark_mobility_done",
  description:
    "User retracts a previous mobility confirmation ('actually didn't do it', 'scratch that'). Deletes the chat-inserted workouts row for the given date. NEVER deletes Strong CSV imports — guarded by source='chat' filter. Returns removed=false if nothing was deleted.",
  input_schema: {
    type: "object" as const,
    required: [],
    properties: {
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD in user's local TZ. Defaults to today." },
    },
  },
};
```

- [ ] **Step 2: Add the `mark_mobility_done` executor**

Append below the schemas:

```ts
// ── Mobility chat tools: executors ───────────────────────────────────────────

export async function executeMarkMobilityDone(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; date: string; was_already_done: boolean }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Resolve date: default to today in user TZ; validate shape if provided.
  const today = todayInUserTz();
  let date: string;
  if (i.date === undefined || i.date === null) {
    date = today;
  } else if (typeof i.date === "string" && ISO_DATE_PATTERN.test(i.date)) {
    date = i.date;
  } else {
    return { ok: false, error: { error: "date must be a YYYY-MM-DD string or omitted" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // No future-dating.
  if (date > today) {
    return { ok: false, error: { error: `date ${date} is in the future (today is ${today})` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Optional notes — accept string or null/undefined.
  let notes: string | null = null;
  if (typeof i.notes === "string") {
    notes = i.notes.slice(0, 280);
  } else if (i.notes !== undefined && i.notes !== null) {
    return { ok: false, error: { error: "notes must be a string or null" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const external_id = `chat-mobility-${date}`;

  // Look up first so we can report was_already_done accurately.
  const { data: existing, error: selErr } = await opts.supabase
    .from("workouts")
    .select("id")
    .eq("user_id", opts.userId)
    .eq("external_id", external_id)
    .maybeSingle();
  if (selErr) {
    return { ok: false, error: { error: `select_failed: ${selErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const was_already_done = existing !== null;

  // Upsert against the partial-unique index workouts_user_external_id_idx.
  const { error: upErr } = await opts.supabase
    .from("workouts")
    .upsert(
      {
        user_id: opts.userId,
        date,
        type: "Mobility",
        notes,
        source: "chat",
        external_id,
      },
      { onConflict: "user_id,external_id" },
    );
  if (upErr) {
    return { ok: false, error: { error: `upsert_failed: ${upErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { ok: true, date, was_already_done },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}
```

- [ ] **Step 3: Add the `unmark_mobility_done` executor**

Append below `executeMarkMobilityDone`:

```ts
export async function executeUnmarkMobilityDone(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; removed: boolean }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  const today = todayInUserTz();
  let date: string;
  if (i.date === undefined || i.date === null) {
    date = today;
  } else if (typeof i.date === "string" && ISO_DATE_PATTERN.test(i.date)) {
    date = i.date;
  } else {
    return { ok: false, error: { error: "date must be a YYYY-MM-DD string or omitted" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const external_id = `chat-mobility-${date}`;

  // Delete ONLY when source='chat'. Strong CSV imports are never touched.
  const { data: deleted, error: delErr } = await opts.supabase
    .from("workouts")
    .delete()
    .eq("user_id", opts.userId)
    .eq("external_id", external_id)
    .eq("source", "chat")
    .select("id");
  if (delErr) {
    return { ok: false, error: { error: `delete_failed: ${delErr.message}` }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { ok: true, removed: (deleted?.length ?? 0) > 0 },
    meta: { ms: Date.now() - t0, result_rows: deleted?.length ?? 0, range_days: 0, truncated: false },
  };
}
```

Notes on the code:
- `todayInUserTz()` and `ISO_DATE_PATTERN` are already imported/defined in this file (lines 37 and 2081 respectively); no new imports needed.
- `ToolResult<T>` shape and the `meta.range_days: 0` / `result_rows` fields match every other write-tool in this file ([executeSetGlp1TaperStarted](lib/coach/tools.ts) is the canonical reference).
- `.upsert({…}, { onConflict: "user_id,external_id" })` relies on `workouts_user_external_id_idx` ([supabase/migrations/0003_integrations.sql:35](supabase/migrations/0003_integrations.sql#L35)). That index is partial (`where external_id is not null`); supabase-js handles it fine because we always pass a non-null `external_id`.

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: clean (no errors, exits 0).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(coach): mark_mobility_done and unmark_mobility_done tool schemas + executors

Two new chat write-tools that upsert/delete a workouts row with
type='Mobility', source='chat', external_id='chat-mobility-<date>'.
Idempotent on the existing workouts_user_external_id_idx partial-unique
index. unmark filters on source='chat' so Strong CSV imports are never
touched.

Not yet wired into chat-stream.ts — that's the next commit.

Refs spec: docs/superpowers/specs/2026-05-13-mobility-chat-logging-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire tools into `lib/coach/chat-stream.ts`

**Files:**
- Modify: [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts) — imports (around line 30-65), `allTools` array (around line 184), `plan_week`/`setup_block` mode filter (around line 199-208), tool dispatch chain (around line 322-400).

- [ ] **Step 1: Extend the imports from `./tools`**

Find the multi-line import block at the top of [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts) (starts around line 30, imports `DAILY_LOGS_TOOL`, `WORKOUTS_TOOL`, etc.). Find the line:

```ts
  MARK_GLP1_DISCONTINUED_TOOL,
  REGENERATE_MORNING_BRIEF_TOOL,
```

Add the two new schemas immediately after `MARK_GLP1_DISCONTINUED_TOOL`:

```ts
  MARK_GLP1_DISCONTINUED_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
  REGENERATE_MORNING_BRIEF_TOOL,
```

Then find the executor imports further down in the same import block (where `executeQueryDailyLogs`, `executeQueryWorkouts`, etc. are listed). Find the line containing `executeMarkGlp1Discontinued` (or `executeRegenerateMorningBrief` — whichever you find first) and add the two new executors. The two executor imports must be on contiguous lines adjacent to existing executor imports, e.g.:

```ts
  executeMarkGlp1Discontinued,
  executeMarkMobilityDone,
  executeUnmarkMobilityDone,
  executeRegenerateMorningBrief,
```

(If the existing order differs, just add `executeMarkMobilityDone` and `executeUnmarkMobilityDone` anywhere in that executor import list — order doesn't matter for correctness.)

- [ ] **Step 2: Register both tools in the `allTools` array**

Find the `allTools` array (around [lib/coach/chat-stream.ts:184](lib/coach/chat-stream.ts#L184)) — it currently ends with:

```ts
    SET_GLP1_STATUS_TOOL,
    SET_GLP1_TAPER_STARTED_TOOL,
    MARK_GLP1_DISCONTINUED_TOOL,
    REGENERATE_MORNING_BRIEF_TOOL,
  ];
```

Insert the two new entries right after `MARK_GLP1_DISCONTINUED_TOOL`:

```ts
    SET_GLP1_STATUS_TOOL,
    SET_GLP1_TAPER_STARTED_TOOL,
    MARK_GLP1_DISCONTINUED_TOOL,
    MARK_MOBILITY_DONE_TOOL,
    UNMARK_MOBILITY_DONE_TOOL,
    REGENERATE_MORNING_BRIEF_TOOL,
  ];
```

- [ ] **Step 3: Extend the `plan_week`/`setup_block` mode-filter exclusion list**

Find the `plan_week`/`setup_block` filter (around [lib/coach/chat-stream.ts:199](lib/coach/chat-stream.ts#L199)). Currently:

```ts
  if (opts.mode === "plan_week" || opts.mode === "setup_block") {
    toolsForMode = allTools.filter(
      (t) =>
        !t.name.startsWith("apply_") &&
        !t.name.startsWith("set_") &&
        t.name !== "propose_plan" &&
        t.name !== "commit_plan" &&
        t.name !== "mark_glp1_discontinued" &&
        t.name !== "regenerate_morning_brief",
    );
  }
```

Add two exclusions so the planning lanes don't see mobility-completion tools:

```ts
  if (opts.mode === "plan_week" || opts.mode === "setup_block") {
    toolsForMode = allTools.filter(
      (t) =>
        !t.name.startsWith("apply_") &&
        !t.name.startsWith("set_") &&
        t.name !== "propose_plan" &&
        t.name !== "commit_plan" &&
        t.name !== "mark_glp1_discontinued" &&
        t.name !== "mark_mobility_done" &&
        t.name !== "unmark_mobility_done" &&
        t.name !== "regenerate_morning_brief",
    );
  }
```

The `default` mode filter (around line 222-232) requires no change: its condition `!startsWith("propose_") && !startsWith("commit_") && !startsWith("apply_") && (!startsWith("set_") || name === "set_glp1_taper_started")` already lets `mark_mobility_done` and `unmark_mobility_done` through.

The `intake` mode filter (around line 211-220) is a whitelist and doesn't include these tools, so they're already excluded. No change.

- [ ] **Step 4: Add dispatch branches for the two new tools**

Find the tool-dispatch chain (starts around [lib/coach/chat-stream.ts:322](lib/coach/chat-stream.ts#L322) with `if (block.name === "query_daily_logs")`). Find the existing `mark_glp1_discontinued` branch:

```ts
        } else if (block.name === "mark_glp1_discontinued") {
          result = await executeMarkGlp1Discontinued({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "regenerate_morning_brief") {
```

Insert two new branches between `mark_glp1_discontinued` and `regenerate_morning_brief`:

```ts
        } else if (block.name === "mark_glp1_discontinued") {
          result = await executeMarkGlp1Discontinued({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "mark_mobility_done") {
          result = await executeMarkMobilityDone({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "unmark_mobility_done") {
          result = await executeUnmarkMobilityDone({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "regenerate_morning_brief") {
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "feat(coach): wire mark_mobility_done / unmark_mobility_done into chat-stream

Imports the two new schemas + executors, registers them in allTools, adds
dispatch branches, and excludes them from plan_week/setup_block modes
(default mode passes them through automatically; intake whitelist
already excludes them).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add trigger-phrasing directive to the default system prompt

**Files:**
- Modify: [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) — extend `DEFAULT_SYSTEM_PROMPT` (the file's main export, the user-facing default coach prompt — *not* `prompts.ts`, which is for the weekly review, not the chat coach).

- [ ] **Step 1: Append a new section to `DEFAULT_SYSTEM_PROMPT`**

In [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts), find the closing backtick of `DEFAULT_SYSTEM_PROMPT` (the template-literal ends right after the morning-brief refresh section). The current ending looks like:

```ts
re-describe the brief contents in markdown text (that would duplicate
what the card already shows).`;
```

Insert a new section *before* the closing backtick:

```ts
re-describe the brief contents in markdown text (that would duplicate
what the card already shows).

## Mobility session confirmation

When the user signals they've completed a mobility session — phrases
like "done", "finished mobility", "did my session", "knocked out the
mobility work", "all done with my stretches" — call mark_mobility_done.
With no arguments it logs today; pass an explicit date only if the user
specifies a different day ("I did mobility yesterday"). Don't prompt
for notes — accept the completion at face value. After the tool returns
ok, briefly acknowledge ("Logged. Strain will land tomorrow from WHOOP.")
and move on; don't quote the tool output.

If the user retracts ("actually I didn't", "scratch that", "I lied"),
call unmark_mobility_done. If it returns removed=false, tell the user
there was nothing to remove.

Only call these tools on explicit completion / retraction signals — not
on hypothetical phrasing ("I'm about to do mobility", "thinking of doing
mobility tonight"). A future-tense or conditional statement is NOT a
completion signal.`;
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: clean (template-literal changes can't fail typecheck unless syntax breaks).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): teach default coach to call mark_mobility_done on completion signals

Adds a 'Mobility session confirmation' section to DEFAULT_SYSTEM_PROMPT
listing the trigger phrases (done / finished / did it), the explicit
'don't fire on future-tense' guard, and the post-call ack pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Manual verification

**No file changes.** This task exercises the end-to-end path against a real Supabase + Anthropic stack. The repo has no test harness; this is the project's verification primitive.

- [ ] **Step 1: Run the dev server**

```bash
npm run dev
```
Wait for `Ready on http://localhost:3000`. Leave running.

- [ ] **Step 2: Confirm completion (happy path)**

Open `http://localhost:3000/coach` in a browser. Send: `done with my mobility`

Expected:
- The coach replies with a brief ack ("Logged.") rather than a long paragraph.
- In Supabase Dashboard → Table Editor → `workouts`, a row appears for the current user with: `date = <today>`, `type = "Mobility"`, `source = "chat"`, `external_id = "chat-mobility-<today>"`, `notes = null`.

If no row appears: check the dev server logs for tool-execution errors (look for `mark_mobility_done` or `upsert_failed`).

- [ ] **Step 3: Idempotency**

In the same chat, send: `actually I did mobility again, mark it done`

Expected:
- Coach calls `mark_mobility_done` again. Tool returns `was_already_done: true`. Coach's reply still acknowledges; only one row in `workouts` for that date.

- [ ] **Step 4: Retraction**

Send: `scratch that, I didn't actually do it`

Expected:
- Coach calls `unmark_mobility_done`. Tool returns `removed: true`. The `workouts` row is gone.

- [ ] **Step 5: Retraction with nothing to remove**

Send the retraction phrase again (no row exists now): `actually nope, undo that`

Expected:
- Tool returns `removed: false`. Coach surfaces the "nothing to remove" message.

- [ ] **Step 6: Strong-CSV safety**

Sanity-check the SQL guard. In Supabase Dashboard → SQL Editor, run:
```sql
insert into workouts (user_id, date, type, source, external_id)
values (auth.uid(), current_date - 7, 'Mobility', 'strong', 'strong-mobility-safety-test')
on conflict (user_id, external_id) do nothing;
```
(Use your actual `user_id` UUID instead of `auth.uid()` if running from the dashboard SQL editor as the service role.)

Then in chat, send: `undo my mobility from last week — ${YYYY-MM-DD seven days ago}` (substitute the actual date).

Expected:
- Coach calls `unmark_mobility_done` with that date. Tool returns `removed: false` because `source != 'chat'`. The Strong-sourced row remains intact.

Clean up the test row afterwards:
```sql
delete from workouts where external_id = 'strong-mobility-safety-test';
```

- [ ] **Step 7: Plan-mode containment**

Navigate to `/coach?mode=plan_week`. Send: `done with mobility`.

Expected:
- The coach does NOT call `mark_mobility_done` (the tool isn't in the available tool list for `plan_week` mode — model gets no chance to call it). The coach should either ignore the line or steer the conversation back to weekly planning.

- [ ] **Step 8: Future-date guard**

Back in `/coach` (default mode). Send: `mark mobility done for tomorrow`.

Expected:
- Either the coach refuses to call the tool (the prompt directive should discourage future-tense), OR the tool is called with tomorrow's date and returns an error. Either path is acceptable; a row for a future date is NOT.

- [ ] **Step 9: Stop the dev server**

`Ctrl+C` in the terminal running `npm run dev`.

- [ ] **Step 10: Final typecheck**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 11: Open a PR**

The branch is ready to ship. From the working tree:

```bash
git push -u origin feat/mobility-chat-logging
gh pr create --title "feat(coach): mobility session logging via chat" --body "$(cat <<'EOF'
Lets the user confirm a completed mobility session in coach chat. Two
new write-tools insert/delete a row in the existing `workouts` table
with `type='Mobility'`, `source='chat'`, `external_id='chat-mobility-<date>'`.
Adherence picks it up automatically; WHOOP-sourced strain comes the next
morning as it always has.

## Why

Strong can't log mobility (no weight×reps to record), so Wednesday
mobility sessions were always marked `missed` by adherence even when
completed. This closes that gap with a 3-file, 0-migration change.

## What changed

- `lib/coach/tools.ts` — two new schemas + executors.
- `lib/coach/chat-stream.ts` — registered in `allTools`, added dispatch
  branches, excluded from `plan_week`/`setup_block` modes.
- `lib/coach/system-prompts.ts` — added trigger-phrasing section to
  `DEFAULT_SYSTEM_PROMPT`.

No migration, no UI changes, no changes to adherence math.

## Verification

- `npm run typecheck` clean.
- Manual chat exercise per Task 4 of the plan (mark / re-mark / unmark /
  Strong-CSV safety / plan-mode containment / future-date guard).

Spec: `docs/superpowers/specs/2026-05-13-mobility-chat-logging-design.md`
Plan: `docs/superpowers/plans/2026-05-13-mobility-chat-logging.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist (for the executing engineer)

Before declaring done:

- [ ] All 4 tasks complete, each with its own commit.
- [ ] `npm run typecheck` clean on the final commit.
- [ ] Task 4 manual exercise reproduced end-to-end at least for steps 2, 3, 4 (happy path + idempotency + retraction).
- [ ] No new files outside the three listed in the "Files touched" map.
- [ ] No `.test.ts` files added — out of scope for this repo.
- [ ] No migration created — `workouts` schema is unchanged.
