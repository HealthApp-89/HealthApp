# Carter session-write tools — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Coach Carter chat-level write capability over his own prescription artefact — the exercises inside a session — so an "Arms" day doesn't render an empty `/strength` card and Carter doesn't have to defer to Peter for routine specialty work.

**Architecture:** Two new HMAC-gated tool pairs (`propose_session_template` / `commit_session_template` and `propose_session_today` / `commit_session_today`) mirror the existing `propose_week_plan` / `commit_week_plan` pattern from [lib/coach/tools.ts](../../lib/coach/tools.ts). Tool B writes `user_session_templates[session_type]` (persistent default). Tool A writes `training_weeks.exercise_overrides[<weekdayLong>]` (today only, no permutation rule). Prompt is updated so Carter calls these tools rather than narrating exercises; two new preview cards render the proposal chip; one rendering unification fixes a latent inconsistency between `/strength` (`getEffectiveSessionPlan`) and the logger (`resolveSessionPlan`).

**Tech Stack:** TypeScript / Next.js 15 App Router; Anthropic SDK tool-use; Supabase service-role for writes; TanStack Query for client cache; HMAC approval tokens from [lib/coach/approval-token.ts](../../lib/coach/approval-token.ts).

**Spec:** [docs/superpowers/specs/2026-05-22-carter-session-write-tools-design.md](../specs/2026-05-22-carter-session-write-tools-design.md)

**Verification model (per [CLAUDE.md](../../CLAUDE.md)):** no test suite; gate every task on `npm run typecheck` clean + commit. Final manual smoke test on dev server.

---

## File map

| Path | Action | Purpose |
|---|---|---|
| [lib/coach/approval-token.ts](../../lib/coach/approval-token.ts) | modify | extend `ApprovalAction` union with two new values |
| [lib/coach/tools.ts](../../lib/coach/tools.ts) | modify | 4 new tool schemas + 4 new executors + extend `CARTER_TOOLS` |
| [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) | modify | 4 new dispatch branches |
| [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) | modify | 3 edits to `CARTER_BASE` |
| [components/chat/SessionTodayProposalCard.tsx](../../components/chat/) | create | preview card for `propose_session_today` |
| [components/chat/SessionTemplateProposalCard.tsx](../../components/chat/) | create | preview card for `propose_session_template` |
| [components/chat/ChatMessage.tsx](../../components/chat/ChatMessage.tsx) | modify | 2 new branches in `toolCalls.map` + 2 new `hasCommittedX` checks |
| [components/chat/ChatPanel.tsx](../../components/chat/ChatPanel.tsx) | modify | invalidate `trainingWeeks.one` / `userSessionTemplates.one` on commit |
| [lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts) | modify | extend `getEffectiveSessionPlan` signature to accept `userTemplate` |
| [components/strength/StrengthClient.tsx](../../components/strength/StrengthClient.tsx) | modify | call `useUserSessionTemplate`, pass through |
| [components/strength/StrengthCoachClient.tsx](../../components/strength/StrengthCoachClient.tsx) | modify | same |

No DB migrations. No new query hooks (`useUserSessionTemplate` already exists from migration 0026's rollout).

---

## Task 1 — Extend `ApprovalAction` union

**Files:**
- Modify: [lib/coach/approval-token.ts:17](../../lib/coach/approval-token.ts#L17)

- [ ] **Step 1: Add two new values to the union**

Edit [lib/coach/approval-token.ts:17](../../lib/coach/approval-token.ts#L17):

```ts
export type ApprovalAction = "block" | "week" | "plan" | "weekly_review" | "nutrition_targets" | "session_today" | "session_template";
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean. Adding union members can't break callers — `verifyApprovalToken` only accepts an action argument; broadening the union doesn't reject any existing call sites.

- [ ] **Step 3: Commit**

```
git add lib/coach/approval-token.ts
git commit -m "feat(coach): extend ApprovalAction with session_today + session_template"
```

---

## Task 2 — Tool A (propose_session_today + commit_session_today)

**Files:**
- Modify: [lib/coach/tools.ts](../../lib/coach/tools.ts) — add 4 things in this order: input type, schema, propose executor, commit executor. Insert next to the existing `executeProposeWeekPlan` / `executeCommitWeekPlan` block at [lib/coach/tools.ts:1763-1857](../../lib/coach/tools.ts#L1763-L1857).

The new code uses helpers already imported at the top of the file: `signApprovalToken`, `verifyApprovalToken`, `ApprovalTokenError`, `approvalTokenUserMessage` ([lib/coach/tools.ts:21](../../lib/coach/tools.ts#L21)); `weekStart` from `./derived` ([lib/coach/tools.ts:42](../../lib/coach/tools.ts#L42)); `todayInUserTz`, `weekdayInUserTz` from `@/lib/time` ([lib/coach/tools.ts:47](../../lib/coach/tools.ts#L47) — `weekdayInUserTz` needs to be added to that import line).

- [ ] **Step 1: Add `weekdayInUserTz` to the time import**

Edit [lib/coach/tools.ts:47](../../lib/coach/tools.ts#L47):

```ts
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";
```

- [ ] **Step 2: Add `PlannedExercise` import**

Add a new import line near the top (next to the existing `import type { PlannedExercise }` candidates — there's none currently, so place it after [lib/coach/tools.ts:22](../../lib/coach/tools.ts#L22)):

```ts
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
```

- [ ] **Step 3: Add the input type, tool schema, and two executors**

Insert this block right after `executeCommitWeekPlan` (after [lib/coach/tools.ts:1857](../../lib/coach/tools.ts#L1857)):

```ts
// ── propose_session_today / commit_session_today ─────────────────────────────
//
// One-off override of today's exercises. Writes
// training_weeks.exercise_overrides[<weekdayLong>] without the permutation
// rule the /api/training-weeks/[week_start]/exercise-overrides route enforces
// (that route still protects the drag-to-reorder chip's contract).
//
// Used for swap-policy rules 1 (pain), 3 (equipment), 6 (athlete-raised
// boredom) and illness scaling. Tomorrow's same-type session reverts to the
// template; this is single-day only.

const WEEKDAYS_LONG = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"] as const;
type WeekdayLong = (typeof WEEKDAYS_LONG)[number];

type SessionTodayPayload = {
  weekday: WeekdayLong;
  exercises: PlannedExercise[];
  rationale: string;
};

export const PROPOSE_SESSION_TODAY_TOOL = {
  name: "propose_session_today",
  description:
    "Propose a one-off override of today's exercises for the athlete to approve. Use ONLY for mid-block exceptions: pain (swap-policy rule 1), equipment unavailable (rule 3), illness scaling, athlete-raised boredom (rule 6). Tomorrow's same-type session reverts to the saved template. Writes to training_weeks.exercise_overrides[weekday]; does NOT persist beyond today. Requires a committed training_weeks row for the current week.",
  input_schema: {
    type: "object" as const,
    required: ["weekday", "exercises", "rationale"],
    properties: {
      weekday: { type: "string", enum: WEEKDAYS_LONG, description: "Full weekday name; must match today's user-tz weekday." },
      exercises: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name:     { type: "string", minLength: 2, maxLength: 80 },
            warmup:   { type: "boolean" },
            reps:     { type: "string", maxLength: 40 },
            baseKg:   { type: "number", minimum: 0, maximum: 500 },
            baseReps: { type: "integer", minimum: 1, maximum: 60 },
            sets:     { type: "integer", minimum: 1, maximum: 12 },
            key:      { type: "string", maxLength: 40 },
            note:     { type: "string", maxLength: 200 },
            increment: {
              type: "object",
              required: ["step"],
              properties: {
                step:         { type: "number", minimum: 0.5, maximum: 20 },
                intermediate: { type: "number", minimum: 0.5, maximum: 20 },
              },
            },
          },
        },
      },
      rationale: { type: "string", minLength: 4, maxLength: 400, description: "Plain-language reasoning shown to the athlete on the approval chip." },
    },
  },
};

export const COMMIT_SESSION_TODAY_TOOL = {
  name: "commit_session_today",
  description:
    "Commit a previously proposed one-off session override. Requires approval_token from propose_session_today. Writes training_weeks.exercise_overrides for today's weekday slot.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export async function executeProposeSessionToday(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: SessionTodayPayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.weekday !== "string" || !(WEEKDAYS_LONG as readonly string[]).includes(i.weekday)) {
    return { ok: false, error: { error: "weekday must be a full weekday name (Monday-Sunday)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!Array.isArray(i.exercises) || i.exercises.length === 0) {
    return { ok: false, error: { error: "exercises must be a non-empty array" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.rationale !== "string" || i.rationale.length < 4) {
    return { ok: false, error: { error: "rationale required (4-400 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Soft anchor: the weekday should match today's user-tz weekday. If it
  // doesn't, the override would land on the wrong day. Reject cleanly rather
  // than silently writing the wrong slot.
  const todayWeekday = weekdayInUserTz();
  if (i.weekday !== todayWeekday) {
    return {
      ok: false,
      error: { error: `weekday=${i.weekday} doesn't match today (${todayWeekday}). For future days, propose a week plan instead.` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const payload: SessionTodayPayload = {
    weekday: i.weekday as WeekdayLong,
    exercises: i.exercises as PlannedExercise[],
    rationale: i.rationale as string,
  };
  const token = signApprovalToken({ userId: opts.userId, action: "session_today", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 1, truncated: false },
  };
}

export async function executeCommitSessionToday(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ week_start: string; weekday: WeekdayLong; exercises: PlannedExercise[] }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;

  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "session_today" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the session payload. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as SessionTodayPayload;

  const today = todayInUserTz();
  const week_start = weekStart(today);

  const { data: row, error: loadErr } = await opts.supabase
    .from("training_weeks")
    .select("id, exercise_overrides")
    .eq("user_id", opts.userId)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: "Couldn't load this week's plan. Please try again.", code: loadErr.code ?? "load_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!row) {
    return {
      ok: false,
      error: { error: "No weekly plan committed yet for this week. Tell me 'plan my week' first.", code: "no_week" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const existing = (row.exercise_overrides as Record<string, PlannedExercise[]> | null) ?? {};
  const next = { ...existing, [p.weekday]: p.exercises };

  const { error: updateErr } = await opts.supabase
    .from("training_weeks")
    .update({ exercise_overrides: next, updated_at: new Date().toISOString() })
    .eq("user_id", opts.userId)
    .eq("week_start", week_start);
  if (updateErr) {
    return { ok: false, error: { error: "Couldn't save today's session override. Please try again.", code: updateErr.code ?? "update_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { week_start, weekday: p.weekday, exercises: p.exercises },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 1, truncated: false },
  };
}
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean. The new code is additive; existing executors are untouched.

- [ ] **Step 5: Commit**

```
git add lib/coach/tools.ts
git commit -m "feat(coach): add propose_session_today / commit_session_today tool"
```

---

## Task 3 — Tool B (propose_session_template + commit_session_template)

**Files:**
- Modify: [lib/coach/tools.ts](../../lib/coach/tools.ts) — append immediately after the Tool A block from Task 2.

- [ ] **Step 1: Add the input type, tool schema, and two executors**

Insert right after `executeCommitSessionToday` from Task 2:

```ts
// ── propose_session_template / commit_session_template ───────────────────────
//
// Defines the canonical exercise list for a session type (what "Arms"
// contains). Persists across weeks via user_session_templates. Used for:
//   - first-time setup of a session type (today's empty-card gap)
//   - block-boundary 1-2 accessory rotation (swap-policy rule 5)
// Carter is instructed to call query_exercise_library first and prefer
// library-canonical names; free-form names are allowed but flagged in the
// rationale (they skip downstream metadata like session-structure tiering).

type SessionTemplatePayload = {
  session_type: string;
  exercises: PlannedExercise[];
  rationale: string;
};

export const PROPOSE_SESSION_TEMPLATE_TOOL = {
  name: "propose_session_template",
  description:
    "Propose the canonical exercise list for a session type (e.g. what 'Arms' contains). Persists across weeks via user_session_templates. Use when a session type has no exercises set up yet, or at a block boundary to rotate 1-2 accessories (swap-policy rule 5). Call query_exercise_library first to source canonical names; free-form names are allowed when the library has a genuine gap but should be flagged in the rationale.",
  input_schema: {
    type: "object" as const,
    required: ["session_type", "exercises", "rationale"],
    properties: {
      session_type: { type: "string", minLength: 2, maxLength: 40, description: "e.g. 'Arms', 'Push', 'Pull', 'Chest'." },
      exercises: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name:     { type: "string", minLength: 2, maxLength: 80 },
            warmup:   { type: "boolean" },
            reps:     { type: "string", maxLength: 40 },
            baseKg:   { type: "number", minimum: 0, maximum: 500 },
            baseReps: { type: "integer", minimum: 1, maximum: 60 },
            sets:     { type: "integer", minimum: 1, maximum: 12 },
            key:      { type: "string", maxLength: 40 },
            note:     { type: "string", maxLength: 200 },
            increment: {
              type: "object",
              required: ["step"],
              properties: {
                step:         { type: "number", minimum: 0.5, maximum: 20 },
                intermediate: { type: "number", minimum: 0.5, maximum: 20 },
              },
            },
          },
        },
      },
      rationale: { type: "string", minLength: 4, maxLength: 400, description: "Plain-language reasoning shown to the athlete on the approval chip." },
    },
  },
};

export const COMMIT_SESSION_TEMPLATE_TOOL = {
  name: "commit_session_template",
  description:
    "Commit a previously proposed session-type template. Requires approval_token from propose_session_template. Upserts user_session_templates by (user_id, session_type).",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};

export async function executeProposeSessionTemplate(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: SessionTemplatePayload; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.session_type !== "string" || i.session_type.length < 2 || i.session_type.length > 40) {
    return { ok: false, error: { error: "session_type required (2-40 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!Array.isArray(i.exercises) || i.exercises.length === 0) {
    return { ok: false, error: { error: "exercises must be a non-empty array" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (typeof i.rationale !== "string" || i.rationale.length < 4) {
    return { ok: false, error: { error: "rationale required (4-400 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const payload: SessionTemplatePayload = {
    session_type: i.session_type as string,
    exercises: i.exercises as PlannedExercise[],
    rationale: i.rationale as string,
  };
  const token = signApprovalToken({ userId: opts.userId, action: "session_template", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeCommitSessionTemplate(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ session_type: string; exercises: PlannedExercise[] }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;

  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "session_template" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the template payload. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as SessionTemplatePayload;

  const { error: upsertErr } = await opts.supabase
    .from("user_session_templates")
    .upsert(
      {
        user_id: opts.userId,
        session_type: p.session_type,
        exercises: p.exercises,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,session_type" },
    );
  if (upsertErr) {
    return { ok: false, error: { error: "Couldn't save the session template. Please try again.", code: upsertErr.code ?? "upsert_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { session_type: p.session_type, exercises: p.exercises },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add lib/coach/tools.ts
git commit -m "feat(coach): add propose_session_template / commit_session_template tool"
```

---

## Task 4 — Wire dispatch in chat-stream + extend CARTER_TOOLS

**Files:**
- Modify: [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) — import the 4 new executors and add 4 dispatch branches.
- Modify: [lib/coach/tools.ts:3973-3985](../../lib/coach/tools.ts#L3973-L3985) — add 4 schemas to `CARTER_TOOLS`.

- [ ] **Step 1: Import the new executors in chat-stream.ts**

Edit [lib/coach/chat-stream.ts:36-44](../../lib/coach/chat-stream.ts#L36-L44) (the executor import block) — add the 4 new names alongside the existing `executeProposeWeekPlan` / `executeCommitWeekPlan`:

```ts
import {
  // ...existing imports unchanged...
  executeProposeWeekPlan,
  executeCommitWeekPlan,
  executeProposeSessionToday,
  executeCommitSessionToday,
  executeProposeSessionTemplate,
  executeCommitSessionTemplate,
  // ...rest unchanged...
} from "@/lib/coach/tools";
```

- [ ] **Step 2: Add 4 dispatch branches in chat-stream.ts**

Find the existing else-if chain around [lib/coach/chat-stream.ts:550-562](../../lib/coach/chat-stream.ts#L550-L562) (where `propose_week_plan` and `commit_week_plan` dispatch to executors). Add four new branches in the same chain, after `commit_week_plan`:

```ts
} else if (block.name === "propose_session_today") {
  result = await executeProposeSessionToday({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else if (block.name === "commit_session_today") {
  result = await executeCommitSessionToday({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else if (block.name === "propose_session_template") {
  result = await executeProposeSessionTemplate({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else if (block.name === "commit_session_template") {
  result = await executeCommitSessionTemplate({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
```

- [ ] **Step 3: Add the 4 tools to CARTER_TOOLS**

Edit [lib/coach/tools.ts:3973-3985](../../lib/coach/tools.ts#L3973-L3985):

```ts
export const CARTER_TOOLS: readonly ToolSchema[] = [
  WORKOUTS_TOOL,
  QUERY_EXERCISE_LIBRARY_TOOL,
  GET_SUBSTITUTES_TOOL,
  DAILY_LOGS_TOOL,
  TRAINING_PLAN_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  PROPOSE_SESSION_TODAY_TOOL,
  COMMIT_SESSION_TODAY_TOOL,
  PROPOSE_SESSION_TEMPLATE_TOOL,
  COMMIT_SESSION_TEMPLATE_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
];
```

`PETER_TOOLS` stays unchanged — specialist owns the specialty.

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add lib/coach/tools.ts lib/coach/chat-stream.ts
git commit -m "feat(coach): wire session-write tools into Carter's toolbox + chat dispatch"
```

---

## Task 5 — Update CARTER_BASE prompt

**Files:**
- Modify: [lib/coach/system-prompts.ts:40-66](../../lib/coach/system-prompts.ts#L40-L66) (the `CARTER_BASE` template literal).

Three edits per the spec's §4.

- [ ] **Step 1: Append a sentence to the "Exercise library:" paragraph**

Locate the existing block at [lib/coach/system-prompts.ts:54](../../lib/coach/system-prompts.ts#L54):

```
Exercise library: you have query_exercise_library and get_substitutes for browsing the strength exercise catalog. Use them when the athlete asks about alternatives, equipment substitutions, or pain-driven swaps — don't guess from memory. The library tags every entry with movement pattern, primary muscle, stability, ROM bias, joint stress, role (main vs. accessory), and microloadability.
```

Append (in the same paragraph, after the last sentence):

```
 Before calling propose_session_template or propose_session_today, call query_exercise_library or get_substitutes to pull canonical names. Library entries carry metadata (movement pattern, primary muscle, joint stress, microloadability) that session-structure annotation and get_substitutes depend on downstream. Free-form names are allowed when the library has a genuine gap — flag this in the rationale so the athlete knows it will skip downstream metadata.
```

- [ ] **Step 2: Insert the "Session content" block before the "Swap policy" section**

Find the line `Swap policy (apply in this order):` (currently at [lib/coach/system-prompts.ts:56](../../lib/coach/system-prompts.ts#L56)). Insert this new block immediately ABOVE that line, with a blank line between this block and Swap policy:

```
Session content. The week-plan tools (propose_week_plan / commit_week_plan) write the session-type LABELS (Mon=Chest, Wed=Arms, ...). They do NOT write the exercises inside each session. You have two more write tools for session content, both gated by an Approve chip:

- propose_session_template / commit_session_template — defines the canonical exercise list for a session type (what "Arms" contains). Persists across weeks. Use when:
  • the session type has no exercises set up yet (e.g. the card is empty because no template exists);
  • a block boundary triggers the 1-2 accessory rotation (swap-policy rule 5 below). You're changing what the session-type means going forward, not patching one day.

- propose_session_today / commit_session_today — patches TODAY only, doesn't persist. Use for the mid-block exceptions: pain (swap-policy rule 1), equipment unavailable (rule 3), illness scaling, athlete-raised boredom (rule 6). Tomorrow's same-type session reverts to the template.

Within a block, exercises don't change — only load and rep targets do, and those are the athlete's job in the logger. Do NOT call a session-write tool when the athlete asks "what should I lift today" — the answer is "your standing session; here's the load progression for week N."
```

- [ ] **Step 3: Replace the closing line**

Find and delete this line (currently the last line of `CARTER_BASE` at [lib/coach/system-prompts.ts:66](../../lib/coach/system-prompts.ts#L66)):

```
Suggesting a swap is fine in chat. Actually changing the week's plan still goes through propose_week_plan / commit_week_plan — the library is read-only.
```

Replace with:

```
"Suggest" and "do" are the same action for you: when the athlete asks you to set a session, build a workout, or swap an exercise, you call the relevant propose_* tool — don't narrate exercises in chat and leave the athlete to type them in somewhere. The athlete sees a preview chip and approves; the /strength card and the logger pick up the change automatically. The exercise library itself is read-only (it's the catalog), but your prescription artefacts — week labels, session templates, today overrides — you write.
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean (prompt is a string constant, can't break types).

- [ ] **Step 5: Commit**

```
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): teach Carter when to write session content vs. narrate"
```

---

## Task 6 — Build `SessionTodayProposalCard`

**Files:**
- Create: [components/chat/SessionTodayProposalCard.tsx](../../components/chat/)

The card shape mirrors `WeekPlanProposalCard` ([components/chat/WeekPlanProposalCard.tsx](../../components/chat/WeekPlanProposalCard.tsx)) but renders a list of exercises instead of a Mon-Sun grid.

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type SessionTodayProposal = {
  weekday: string;
  exercises: PlannedExercise[];
  rationale: string;
};

export function SessionTodayProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: SessionTodayProposal;
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
              Today&apos;s session updated
            </span>
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>Today only · {proposal.weekday}</CoachCard.Eyebrow>
      <CoachCard.Body>
        <div>
          {proposal.exercises.map((ex, idx) => {
            const target = formatTarget(ex);
            return (
              <div
                key={`${ex.name}-${idx}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "3px 0",
                  fontSize: "12px",
                  color: COLOR.textStrong,
                }}
              >
                <span style={{ flex: 1 }}>{ex.name}</span>
                {target && (
                  <span style={{ color: COLOR.textMuted, marginLeft: 8 }}>{target}</span>
                )}
              </div>
            );
          })}
        </div>

        {proposal.rationale && (
          <p
            style={{
              fontSize: "11px",
              color: COLOR.textFaint,
              marginTop: "8px",
              lineHeight: 1.4,
              fontStyle: "italic",
            }}
          >
            Why: {proposal.rationale}
          </p>
        )}
      </CoachCard.Body>

      <CoachCard.Actions>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onApprove(approvalToken);
          }}
          style={{ ...btnPrimary, flex: 1 }}
        >
          Approve
        </button>
        <button onClick={onTweak} style={{ ...btnSecondary, flex: 1 }}>
          Tweak in chat
        </button>
      </CoachCard.Actions>
    </CoachCard>
  );
}

function formatTarget(ex: PlannedExercise): string {
  if (ex.reps) return ex.reps;
  const parts: string[] = [];
  if (ex.baseKg !== undefined) parts.push(`${ex.baseKg}kg`);
  if (ex.baseReps !== undefined && ex.sets !== undefined) {
    parts.push(`${ex.baseReps}×${ex.sets}`);
  } else if (ex.baseReps !== undefined) {
    parts.push(`${ex.baseReps} reps`);
  } else if (ex.sets !== undefined) {
    parts.push(`${ex.sets} sets`);
  }
  return parts.join(" · ");
}

const btnPrimary: React.CSSProperties = {
  padding: "8px 12px",
  border: "none",
  borderRadius: "9999px",
  background: COLOR.accent,
  color: "#fff",
  fontWeight: 700,
  fontSize: "12px",
  cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px",
  background: COLOR.surface,
  color: COLOR.textStrong,
  fontWeight: 600,
  fontSize: "12px",
  cursor: "pointer",
};
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add components/chat/SessionTodayProposalCard.tsx
git commit -m "feat(chat): SessionTodayProposalCard preview for propose_session_today"
```

---

## Task 7 — Build `SessionTemplateProposalCard`

**Files:**
- Create: [components/chat/SessionTemplateProposalCard.tsx](../../components/chat/)

Same shape as `SessionTodayProposalCard` minus the today-anchored eyebrow; carries the session-type header and a "Saves as your default" subtitle so the athlete understands persistence.

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type SessionTemplateProposal = {
  session_type: string;
  exercises: PlannedExercise[];
  rationale: string;
};

export function SessionTemplateProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: SessionTemplateProposal;
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
              {proposal.session_type} template saved
            </span>
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>
        {proposal.session_type} template · saves as your default
      </CoachCard.Eyebrow>
      <CoachCard.Body>
        <div>
          {proposal.exercises.map((ex, idx) => {
            const target = formatTarget(ex);
            return (
              <div
                key={`${ex.name}-${idx}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "3px 0",
                  fontSize: "12px",
                  color: COLOR.textStrong,
                }}
              >
                <span style={{ flex: 1 }}>{ex.name}</span>
                {target && (
                  <span style={{ color: COLOR.textMuted, marginLeft: 8 }}>{target}</span>
                )}
              </div>
            );
          })}
        </div>

        {proposal.rationale && (
          <p
            style={{
              fontSize: "11px",
              color: COLOR.textFaint,
              marginTop: "8px",
              lineHeight: 1.4,
              fontStyle: "italic",
            }}
          >
            Why: {proposal.rationale}
          </p>
        )}
      </CoachCard.Body>

      <CoachCard.Actions>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onApprove(approvalToken);
          }}
          style={{ ...btnPrimary, flex: 1 }}
        >
          Approve
        </button>
        <button onClick={onTweak} style={{ ...btnSecondary, flex: 1 }}>
          Tweak in chat
        </button>
      </CoachCard.Actions>
    </CoachCard>
  );
}

function formatTarget(ex: PlannedExercise): string {
  if (ex.reps) return ex.reps;
  const parts: string[] = [];
  if (ex.baseKg !== undefined) parts.push(`${ex.baseKg}kg`);
  if (ex.baseReps !== undefined && ex.sets !== undefined) {
    parts.push(`${ex.baseReps}×${ex.sets}`);
  } else if (ex.baseReps !== undefined) {
    parts.push(`${ex.baseReps} reps`);
  } else if (ex.sets !== undefined) {
    parts.push(`${ex.sets} sets`);
  }
  return parts.join(" · ");
}

const btnPrimary: React.CSSProperties = {
  padding: "8px 12px",
  border: "none",
  borderRadius: "9999px",
  background: COLOR.accent,
  color: "#fff",
  fontWeight: 700,
  fontSize: "12px",
  cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px",
  background: COLOR.surface,
  color: COLOR.textStrong,
  fontWeight: 600,
  fontSize: "12px",
  cursor: "pointer",
};
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add components/chat/SessionTemplateProposalCard.tsx
git commit -m "feat(chat): SessionTemplateProposalCard preview for propose_session_template"
```

---

## Task 8 — Wire the two cards into `ChatMessage.tsx`

**Files:**
- Modify: [components/chat/ChatMessage.tsx](../../components/chat/ChatMessage.tsx) — add two `hasCommittedX` checks and two render branches in `toolCalls.map`.

- [ ] **Step 1: Add imports at the top of the file**

Add to the existing component imports block (where `WeekPlanProposalCard`, `BlockProposalCard`, `NutritionTargetsProposalCard` are imported):

```ts
import { SessionTodayProposalCard, type SessionTodayProposal } from "@/components/chat/SessionTodayProposalCard";
import { SessionTemplateProposalCard, type SessionTemplateProposal } from "@/components/chat/SessionTemplateProposalCard";
```

- [ ] **Step 2: Add the two `hasCommittedX` checks**

After the existing `hasCommittedNutritionTargets` line ([components/chat/ChatMessage.tsx:53-55](../../components/chat/ChatMessage.tsx#L53-L55)), append:

```ts
const hasCommittedSessionToday = toolCalls.some(
  (c) => c.name === "commit_session_today" && !c.error,
);
const hasCommittedSessionTemplate = toolCalls.some(
  (c) => c.name === "commit_session_template" && !c.error,
);
```

- [ ] **Step 3: Add the two render branches in `toolCalls.map`**

Inside the `toolCalls.map((call, i) => { ... })` block, after the existing `if (call.name === "propose_nutrition_targets")` block ([components/chat/ChatMessage.tsx:309-325](../../components/chat/ChatMessage.tsx#L309-L325)) and before the `return null` at line 326, insert:

```tsx
if (call.name === "propose_session_today") {
  return (
    <div key={i} style={{ marginTop: 8 }}>
      <SessionTodayProposalCard
        proposal={result.preview as SessionTodayProposal}
        approvalToken={result.approval_token}
        committed={hasCommittedSessionToday}
        onApprove={(token) =>
          onSendUserMessage?.(`[approve:${token}]`)
        }
        onTweak={() =>
          onFocusComposer?.("e.g., 'swap the curls for hammer curls'")
        }
      />
    </div>
  );
}
if (call.name === "propose_session_template") {
  return (
    <div key={i} style={{ marginTop: 8 }}>
      <SessionTemplateProposalCard
        proposal={result.preview as SessionTemplateProposal}
        approvalToken={result.approval_token}
        committed={hasCommittedSessionTemplate}
        onApprove={(token) =>
          onSendUserMessage?.(`[approve:${token}]`)
        }
        onTweak={() =>
          onFocusComposer?.("e.g., 'add a triceps finisher'")
        }
      />
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add components/chat/ChatMessage.tsx
git commit -m "feat(chat): render session-today and session-template approval chips"
```

---

## Task 9 — Wire query invalidation in ChatPanel.tsx

**Context:** After Carter calls `commit_session_today` or `commit_session_template`, the chat-stream returns success but the `/strength` page's `useTrainingWeek` / `useUserSessionTemplate` caches don't know. The existing stream-done handler at [components/chat/ChatPanel.tsx:476-516](../../components/chat/ChatPanel.tsx#L476-L516) already inspects `inlineToolCalls` for side-effect tools (`regenerate_morning_brief`). Extend it to invalidate the relevant TanStack keys.

**Files:**
- Modify: [components/chat/ChatPanel.tsx:488-516](../../components/chat/ChatPanel.tsx#L488-L516)

- [ ] **Step 1: Confirm import for `currentWeekMonday`**

Open [components/chat/ChatPanel.tsx](../../components/chat/ChatPanel.tsx) and check the imports near the top. If `currentWeekMonday` from `@/lib/coach/week` is not already imported (search for `currentWeekMonday`), add it:

```ts
import { currentWeekMonday } from "@/lib/coach/week";
```

`queryKeys` is already imported (`hasSideEffectInsert` uses it at line 956 via `queryKeys.dailyLogs`). Confirm with:

```
grep -n "queryKeys" components/chat/ChatPanel.tsx | head
```

If not imported in the top-level imports, add:

```ts
import { queryKeys } from "@/lib/query/keys";
```

- [ ] **Step 2: Extend the inline-tool-calls handler**

In the block at [components/chat/ChatPanel.tsx:488-516](../../components/chat/ChatPanel.tsx#L488-L516), AFTER the existing `if (hasSideEffectInsert) { ... }` block, append:

```ts
// Carter's session-write tools mutate training_weeks / user_session_templates.
// Invalidate the relevant TanStack caches so /strength reflects the change
// without a manual refresh.
const committedSessionToday = (inlineToolCalls ?? []).some(
  (c) => c.name === "commit_session_today" && !c.error,
);
const committedSessionTemplate = (inlineToolCalls ?? []).find(
  (c) => c.name === "commit_session_template" && !c.error,
);
if (committedSessionToday) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.trainingWeeks.one(userId, currentWeekMonday()),
  });
}
if (committedSessionTemplate) {
  const sessionType = (committedSessionTemplate.result as { session_type?: string } | null)?.session_type;
  if (sessionType) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.userSessionTemplates.one(userId, sessionType),
    });
  } else {
    // Defensive fallback: if the result didn't carry session_type, blow the
    // whole namespace for this user.
    queryClient.invalidateQueries({
      queryKey: queryKeys.userSessionTemplates.all(userId),
    });
  }
}
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```
git add components/chat/ChatPanel.tsx
git commit -m "feat(chat): invalidate strength caches after commit_session_* tools"
```

---

## Task 10 — Unify `/strength` and logger resolution chain

**Context:** [getEffectiveSessionPlan](../../lib/coach/sessionPlans.ts#L87) reads `override → SESSION_PLANS`. The logger's [resolveSessionPlan](../../lib/logger/resolve-plan.ts) reads `override → user_session_templates → SESSION_PLANS`. Tool B writes templates; without this fix, `/strength` won't render them.

**Approach:** extend `getEffectiveSessionPlan` to accept a fourth argument `userTemplate?: PlannedExercise[]` slotted between override and SESSION_PLANS. Both strength clients call `useUserSessionTemplate` (already exists) and pass the fetched exercises in.

**Files:**
- Modify: [lib/coach/sessionPlans.ts:84-95](../../lib/coach/sessionPlans.ts#L84-L95)
- Modify: [components/strength/StrengthClient.tsx](../../components/strength/StrengthClient.tsx)
- Modify: [components/strength/StrengthCoachClient.tsx](../../components/strength/StrengthCoachClient.tsx)

- [ ] **Step 1: Extend `getEffectiveSessionPlan`**

Replace the function at [lib/coach/sessionPlans.ts:84-95](../../lib/coach/sessionPlans.ts#L84-L95):

```ts
/** Returns the effective exercise list for a given session type + weekday.
 *  Resolution chain (matches lib/logger/resolve-plan.ts): per-weekday override
 *  in training_weeks.exercise_overrides → per-user persistent template in
 *  user_session_templates → static SESSION_PLANS code default. Returns []
 *  when no source has exercises (e.g. an unknown session type with no
 *  override and no template).
 *
 *  This is the synchronous variant used by client components that already
 *  fetch override + template via TanStack hooks. The async server-side
 *  variant in lib/logger/resolve-plan.ts queries Supabase directly. */
export function getEffectiveSessionPlan(
  sessionType: string,
  weekday: string,
  overrides: ExerciseOverrides | null | undefined,
  userTemplate?: PlannedExercise[] | null,
): PlannedExercise[] {
  const override = overrides?.[weekday];
  if (override && override.length > 0) return override;
  if (userTemplate && userTemplate.length > 0) return userTemplate;
  return SESSION_PLANS[sessionType] ?? [];
}
```

- [ ] **Step 2: Update `StrengthCoachClient.tsx`**

Add the hook import at [components/strength/StrengthCoachClient.tsx:8-14](../../components/strength/StrengthCoachClient.tsx#L8-L14) (next to the other `useX` hook imports):

```ts
import { useUserSessionTemplate } from "@/lib/query/hooks/useUserSessionTemplate";
```

Call the hook in the data-hooks block (near [components/strength/StrengthCoachClient.tsx:53](../../components/strength/StrengthCoachClient.tsx#L53)):

```ts
const { data: userTemplate = null } = useUserSessionTemplate(
  userId,
  committedSessionType ?? "",
);
```

Note: the hook's `enabled` flag short-circuits when `sessionType` is empty, so the empty-string fallback is safe.

Update the `getEffectiveSessionPlan` call at [components/strength/StrengthCoachClient.tsx:92-94](../../components/strength/StrengthCoachClient.tsx#L92-L94):

```ts
const effectivePlan = committedSessionType
  ? getEffectiveSessionPlan(
      committedSessionType,
      fullWeekday,
      exerciseOverrides,
      userTemplate?.exercises ?? null,
    )
  : null;
```

- [ ] **Step 3: Update `StrengthClient.tsx`**

Open [components/strength/StrengthClient.tsx](../../components/strength/StrengthClient.tsx) and search for its `getEffectiveSessionPlan` call (around [components/strength/StrengthClient.tsx:129](../../components/strength/StrengthClient.tsx#L129)). Apply the same two changes:

1. Add `useUserSessionTemplate` import next to its other hook imports.
2. Add the hook call:

```ts
const { data: userTemplate = null } = useUserSessionTemplate(
  userId,
  committedSessionType ?? "",
);
```

3. Update the `getEffectiveSessionPlan` invocation to pass `userTemplate?.exercises ?? null` as the 4th argument.

Find the exact variable names in this file (`committedSessionType` / `effectivePlan` / `fullWeekday` / `exerciseOverrides`) before editing — they may have slight differences from `StrengthCoachClient`. The argument order is `(sessionType, weekday, overrides, userTemplate)`.

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean. If typecheck flags missing types, confirm `PlannedExercise` is imported in `sessionPlans.ts` (it's defined there) and `useUserSessionTemplate` returns `UserSessionTemplate | null` (it does — see [lib/query/fetchers/userSessionTemplates.ts:26](../../lib/query/fetchers/userSessionTemplates.ts#L26)).

- [ ] **Step 5: Commit**

```
git add lib/coach/sessionPlans.ts components/strength/StrengthClient.tsx components/strength/StrengthCoachClient.tsx
git commit -m "fix(strength): /strength card reads user_session_templates same as logger"
```

---

## Task 11 — Final verification

**Files:** none — verification only.

- [ ] **Step 1: Typecheck end-to-end**

```
npm run typecheck
```

Expected: clean across the whole tree.

- [ ] **Step 2: Start dev server**

```
npm run dev
```

Open `http://localhost:3000` in a browser.

- [ ] **Step 3: Template happy path**

In a session where today's `/strength` card is empty (e.g. session type "Arms" with no template):

1. Navigate to `/strength?tab=coach`.
2. Confirm the TodayPlanCard renders no exercise rows.
3. In the chat panel, type: `Carter, set my arms session`.
4. Wait for Carter's turn to finish streaming. He should call `query_exercise_library` (or `get_substitutes`), then `propose_session_template`.
5. Verify the SessionTemplateProposalCard renders with the exercise list and rationale.
6. Tap Approve.
7. Confirm Carter's next turn calls `commit_session_template` and the chip flips to "{SessionType} template saved".
8. Without refreshing, confirm `/strength` TodayPlanCard now renders the exercises (TanStack invalidation in Task 9).
9. Open the logger from the card — confirm the same exercises pre-load.

- [ ] **Step 4: Override happy path**

While the template from Step 3 is in place:

1. Tell Carter: `my elbow's sore, give me a tendon-friendly arms today`.
2. Confirm he calls `propose_session_today` (not template).
3. Verify the SessionTodayProposalCard renders with "Today only · {Weekday}" eyebrow.
4. Tap Approve.
5. Confirm `/strength` reflects today's new list.
6. Tomorrow (or by changing the system clock in a separate window), confirm the same session-type reverts to the template.

- [ ] **Step 5: No-week-plan error path**

1. In Supabase Studio, delete the `training_weeks` row for `week_start = currentWeekMonday()`.
2. Refresh `/strength`.
3. Tell Carter: `my elbow's sore today, swap something`.
4. Carter calls `propose_session_today` → athlete approves → `commit_session_today` returns the coach-voice error: `"No weekly plan committed yet for this week. Tell me 'plan my week' first."`
5. Restore the `training_weeks` row.

- [ ] **Step 6: Re-routing sanity**

Tell Peter (via @Peter or coach picker): `set my arms session`. Per the spec, Peter doesn't have these tools. Confirm he points back to Carter ("@Carter would have a more specific take") rather than narrating exercises or erroring.

- [ ] **Step 7: Final commit summary**

No code commit at this step — just confirm `git log` shows the expected 10 commits from Tasks 1-10:

```
git log --oneline -10
```

Expected commits (newest first):
- `fix(strength): /strength card reads user_session_templates same as logger`
- `feat(chat): invalidate strength caches after commit_session_* tools`
- `feat(chat): render session-today and session-template approval chips`
- `feat(chat): SessionTemplateProposalCard preview for propose_session_template`
- `feat(chat): SessionTodayProposalCard preview for propose_session_today`
- `feat(coach): teach Carter when to write session content vs. narrate`
- `feat(coach): wire session-write tools into Carter's toolbox + chat dispatch`
- `feat(coach): add propose_session_template / commit_session_template tool`
- `feat(coach): add propose_session_today / commit_session_today tool`
- `feat(coach): extend ApprovalAction with session_today + session_template`

---

## Out of scope (deferred per spec)

- Auto-rotation of accessories at block boundary (Carter still proposes explicitly).
- Movement-pattern coverage / volume-sum readouts on the approval chip.
- `/profile` catalog page to view/edit templates outside chat.
- Carter-driven `baseKg` initialization from `query_workouts` for rotated-in accessories.
- Surfacing the new tools to Peter.

## Self-review notes (from plan author)

- **Spec §3 (the two tools)** → Tasks 2 + 3 implement them; Task 4 wires dispatch + adds to CARTER_TOOLS.
- **Spec §4 (prompt changes)** → Task 5 covers all three edits.
- **Spec §5 (rendering fix)** → Task 10. Note: spec said "delete `getEffectiveSessionPlan` and switch callers to `resolveSessionPlan`." The realized approach is cleaner: extend `getEffectiveSessionPlan`'s signature to accept the userTemplate, and have the clients fetch the template via the existing `useUserSessionTemplate` hook. This keeps the function synchronous (which client components need) and avoids restructuring the strength page to be server-rendered. End behavior is the same: override → template → SESSION_PLANS. If the spec's wording matters for audit, update the spec post-implementation.
- **Spec §6 (files touched)** → Files map at the top of this plan matches §6 exactly, plus `ChatPanel.tsx` for invalidation (mentioned in §6's "wherever `propose_*` tool calls are routed" cell — Task 9).
- **Spec §7 (edge cases)** → No-week-plan path verified in Task 11 Step 5; token replay / soft-fail messages inherit verbatim from the existing `verifyApprovalToken` primitive. Free-form name handling is implicit (no schema-level library validation).
- **Spec §9 (verification)** → Task 11.
- **Placeholder scan** clean. No TBDs. All code blocks are complete and concrete. The "find variable names" step in Task 10 (StrengthClient) is a deliberate read-before-edit cue, not a placeholder.
- **Type consistency** — `SessionTodayProposal` and `SessionTemplateProposal` types declared in Tasks 6/7 are imported in Task 8 (`ChatMessage.tsx`). Executor return types in Tasks 2/3 carry the `preview` shape that Tasks 6/7's components expect.
