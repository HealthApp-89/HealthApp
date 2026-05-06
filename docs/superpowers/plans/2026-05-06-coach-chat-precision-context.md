# Coach Chat — Precision Context, Tool Fetch, Editable System Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat coach's static 14-day blob with: a user-editable system prompt at `/profile`, a fresh per-turn ephemeral header (today + yesterday + sync freshness), two tool-callable Supabase queries (`query_daily_logs`, `query_workouts`) so the model can fetch any historical day on demand instead of approximating, and observability for tool calls.

**Architecture:** The chat path moves off the hand-rolled `streamClaude` to the official `@anthropic-ai/sdk` for tool-delta accumulation. The hand-rolled client stays for non-chat paths (insights / weekly review). The 14-day cached snapshot prefix is preserved unchanged (cache-friendly); the ephemeral header re-queries today/yesterday at request time so freshly-arrived data isn't lied about. Tools execute server-side with `userId` injected from the session — model never passes `user_id`. Persisted observability via `chat_messages.tool_calls jsonb`, captured in the existing `finally` block so partial failures still record diagnostics.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Supabase Postgres + RLS, `@anthropic-ai/sdk`, Tailwind v4, no automated test harness — verify via `npm run typecheck` + manual scenarios after each task.

**Reference spec:** [docs/superpowers/specs/2026-05-06-coach-chat-precision-context-design.md](../specs/2026-05-06-coach-chat-precision-context-design.md). When this plan and the spec disagree, the spec wins — fix the plan inline.

---

## File Structure

**New files:**

- `supabase/migrations/0006_chat_settings.sql` — adds `profiles.system_prompt text` and `chat_messages.tool_calls jsonb`. Applied via Supabase Dashboard SQL Editor.
- `lib/coach/system-prompts.ts` — `DEFAULT_SYSTEM_PROMPT` + `SCHEMA_EXPLAINER` constants. Single source of truth.
- `lib/coach/derived.ts` — pure helpers: `epley(kg, reps)`, `topSet(sets)`, `workingVolume(sets)`, `weeklyBuckets(...)`, `monthlyBuckets(...)`. Reused by tool executors and tests.
- `lib/coach/exercise-categories.ts` — 7-bucket lookup `EXERCISE_CATEGORY` + `categorize()` + `normalize()`.
- `lib/coach/tools.ts` — Anthropic tool schemas (`DAILY_LOGS_TOOL`, `WORKOUTS_TOOL`), `ALLOWED_COLUMNS`, security-invariant validators, `executeQueryDailyLogs`, `executeQueryWorkouts`.
- `lib/coach/chat-stream.ts` — `runChatStream({ userId, systemPrompt, messages, signal })` — tool-aware streaming wrapper around `@anthropic-ai/sdk`. Yields `delta | tool_call_start | tool_call_done | done | error`.

**Modified files:**

- `lib/data/types.ts` — add `system_prompt` to `Profile`, add `ChatMessageRow.tool_calls` jsonb shape.
- `app/profile/actions.ts` — extract `system_prompt`, normalize, NULL-when-equals-default check.
- `app/profile/page.tsx` — fetch + pass `system_prompt`.
- `components/profile/ProfileForm.tsx` — add "Coach instructions" section: textarea + Restore Default button.
- `lib/coach/snapshot.ts` — add `buildEphemeralHeader(userId, tz)` and `getSyncFreshness(userId)`.
- `lib/chat/types.ts` + `lib/chat/sse.ts` — extend `ChatStreamEvent` / `ServerStreamEvent` with `tool_call_start` and `tool_call_done`.
- `components/chat/sseClient.ts` — accept the new event types in the parser (no-op handlers in v1).
- `app/api/chat/messages/route.ts` — replace inline `SYSTEM_PROMPT`, call `buildEphemeralHeader`, switch to `runChatStream`, persist `tool_calls` in `finally`.
- `package.json` — add `@anthropic-ai/sdk`.

**Untouched:**

- `lib/anthropic/client.ts` (still used by insights / weekly review).
- `lib/coach/{readiness,impact,week,sessionPlans,prompts}.ts`.
- `app/coach/page.tsx`, `components/chat/ChatPanel.tsx` (public SSE shape unchanged for `delta`/`done`/`error`; new event types ignored in v1).

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/0006_chat_settings.sql`
- Apply: Supabase Dashboard → SQL Editor (matches the convention for 0002–0005 per CLAUDE.md; do NOT use `supabase db push` — local CLI link state isn't trustworthy for this codebase).

- [ ] **Step 1: Create the migration file**

```sql
-- 0006_chat_settings.sql — editable coach system prompt + tool-call observability
-- Apply via Supabase Dashboard → SQL Editor (matches 0002–0005 convention).

alter table public.profiles
  add column if not exists system_prompt text;

alter table public.chat_messages
  add column if not exists tool_calls jsonb;

comment on column public.profiles.system_prompt is
  'User-edited coach prompt. NULL = use the code-side default (lib/coach/system-prompts.ts:DEFAULT_SYSTEM_PROMPT).';

comment on column public.chat_messages.tool_calls is
  'Array of tool calls executed for this assistant message: [{name, input, ms, result_rows, range_days, truncated, error}]. NULL on user messages or assistant messages with no tool use.';
```

- [ ] **Step 2: Apply via Supabase Dashboard**

1. Open https://supabase.com/dashboard/project/eopfwwergisvskxqvsqe/sql/new
2. Paste the migration SQL.
3. Run.
4. Expected: green "Success. No rows returned."

- [ ] **Step 3: Verify columns exist**

In the same SQL Editor, run:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('profiles', 'chat_messages')
  and column_name in ('system_prompt', 'tool_calls')
order by table_name, column_name;
```

Expected output:

| table_name | column_name | data_type | is_nullable |
|---|---|---|---|
| chat_messages | tool_calls | jsonb | YES |
| profiles | system_prompt | text | YES |

- [ ] **Step 4: Commit the migration file**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add supabase/migrations/0006_chat_settings.sql
git commit -m "$(cat <<'EOF'
feat(db): 0006_chat_settings — add profiles.system_prompt + chat_messages.tool_calls

profiles.system_prompt: user-edited coach prompt; NULL = use code default.
chat_messages.tool_calls: jsonb array of tool calls executed for an assistant
message; persisted for observability and inspection.

Applied via Supabase Dashboard → SQL Editor (matches 0002–0005 convention).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mirror DB shape in TypeScript

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Add `system_prompt` to `Profile` and add `ChatMessageRow` with `tool_calls`**

Edit `lib/data/types.ts`. The `Profile` type currently ends at the closing brace after `training_plan`. Add the field:

```ts
export type Profile = {
  user_id: string;
  name: string | null;
  age: number | null;
  height_cm: number | null;
  goal: string | null;
  whoop_baselines: Record<string, unknown> | null;
  training_plan: Record<string, unknown> | null;
  /** User-edited coach prompt. NULL = use code default from
   *  lib/coach/system-prompts.ts:DEFAULT_SYSTEM_PROMPT. */
  system_prompt: string | null;
};
```

Then append a `ChatMessageRow` type after the existing types so the chat route has a typed shape for the row including the new column:

```ts
/** DB row shape for chat_messages. The route's typed return shape
 *  (lib/chat/types.ts:ChatMessage) is the API surface; this mirrors what's
 *  in the column directly. */
export type ChatMessageRow = {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error";
  error: string | null;
  model: string | null;
  /** [{name, input, ms, result_rows, range_days, truncated, error}] */
  tool_calls: ToolCallLog[] | null;
  created_at: string;
  updated_at: string;
};

export type ToolCallLog = {
  name: "query_daily_logs" | "query_workouts";
  input: Record<string, unknown>;
  ms: number;
  result_rows: number;
  range_days: number;
  truncated: boolean;
  error: string | null;
};
```

- [ ] **Step 2: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: clean exit (no errors). The new `system_prompt` field is optional in select queries (it's nullable + new), so existing `.select("name, age, ...")` callers will continue to compile. The new types only add to the surface.

- [ ] **Step 3: Commit**

```bash
git add lib/data/types.ts
git commit -m "$(cat <<'EOF'
types: add Profile.system_prompt + ChatMessageRow + ToolCallLog

Mirrors columns added in 0006_chat_settings.sql. ToolCallLog is the shape
serialised into chat_messages.tool_calls jsonb by the chat route.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: System prompts module

**Files:**
- Create: `lib/coach/system-prompts.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/coach/system-prompts.ts
//
// Single source of truth for the chat coach's system prompt.
//
//   SCHEMA_EXPLAINER — server-owned plumbing. Documents the snapshot/header
//     shape, units, today/yesterday semantics, tool contracts, and derived-
//     field caveats (uncategorized, hard_set_count, non_null_count, image OCR).
//     The user never sees or edits this. Always prepended to the user's prompt
//     before being sent to Claude.
//
//   DEFAULT_SYSTEM_PROMPT — user-facing default coaching style + the no-
//     approximation rule. Editable from /profile. The NULL-when-equals-default
//     check at save time uses normalized comparison (\r\n → \n + trim) so that
//     code-side updates of this default propagate to users who haven't
//     customised their prompt.
//
// If a column meaning changes (e.g. CLAUDE.md "Data sources & precedence"),
// SCHEMA_EXPLAINER must be updated alongside the code.

export const DEFAULT_SYSTEM_PROMPT = `You are an elite strength and performance coach having an ongoing chat with this athlete.

Speak in concrete numbers — kg, reps, hours, %, kcal, ms — and cite specific dates from the snapshot or tool results. Never approximate when a value is queryable: if you do not have the data in the snapshot or current conversation, you MUST call query_daily_logs or query_workouts before answering. Saying "around", "roughly", or "about" for any value that could be fetched is a failure.

Reply concisely (2-5 sentences for normal questions; longer only when the athlete asks for analysis). Don't restate data the athlete just gave you. Don't pad with disclaimers.

Numbers extracted from screenshots are less reliable than numbers from the query tools. When both are available, prefer the query.`;

export const SCHEMA_EXPLAINER = `# Reference: how the data you receive is shaped

## Snapshot prefix (cached, ~14 days)
Profile + WHOOP baselines + training plan + last 14 days of daily_logs (date, hrv, recovery, sleep, strain, steps, calories, weight, macros) + the 5 most recent workout summaries (date, type, sets, vol, top exercises). Stable across turns.

## Per-turn header (fresh, NOT cached)
NOW timestamp + TODAY (today's daily_logs row, may be partial — sources arrive at different times) + YESTERDAY (full row) + DATA FRESHNESS (when each source last wrote a row, in hours-ago precision). Use this for "today" and "yesterday" questions; the snapshot prefix may be stale by minutes.

## Tools
- query_daily_logs(start_date, end_date, columns?, aggregate?) — fetch daily_logs for any range. raw mode capped at 90 days; aggregate (avg/sum/min/max) is uncapped (returns one row). Aggregate responses include non_null_count + null_count per column — when non_null_count < days_in_range, mention sparse coverage rather than presenting the aggregate as a complete total.
- query_workouts(start_date, end_date, exercise_name?, granularity) — granularity: "summary" (default, one row per workout), "sets" (one row per set), "by_week" / "by_month" (per-period rollups with set counts by category). Warmups always excluded from volume / e1RM / counts. e1RM uses Epley and is null when reps > 12 or for duration-based sets (planks/holds).

## Derived-field caveats
- category: "uncategorized" is a missing-data flag, NOT a category. When filtering or rolling up by category, exclude or report these separately. Do not infer the category from the exercise name.
- hard_set_count counts only sets manually flagged failure: true in Strong. It is sparse — often unset. Do not infer training intensity from it alone; pair with rep counts, top-set e1RM, and athlete self-report.
- non_null_count is the truth about coverage on aggregate responses. If non_null_count < days_in_range, the aggregate is over a partial window — say so.
- duration_seconds is populated for planks/carries/holds; kg/reps/e1RM are null for those.

## Reference frame
When the athlete references a day ("Monday"), interpret it relative to NOW. "Monday" means the most recent Monday on or before today. If ambiguous, ask.

## What to do when you don't have a value
If a value is not in the snapshot, the per-turn header, or the conversation, you MUST call query_daily_logs or query_workouts. Do not estimate. The only correct action when a value is fetchable but absent from your context is to call the tool.`;

/** Normalized form for byte-stable comparison between user-saved prompt and the
 *  canonical default. Used by saveProfile() to decide whether to write NULL. */
export function normalizePromptForCompare(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: no errors (this is a leaf module — only exports constants and one pure helper).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): system-prompts module — DEFAULT_SYSTEM_PROMPT + SCHEMA_EXPLAINER

Single source of truth for the chat coach's prompt.

  - DEFAULT_SYSTEM_PROMPT: user-facing coaching style + no-approximation rule.
    Editable from /profile in a later task.
  - SCHEMA_EXPLAINER: server-owned plumbing covering the snapshot shape, tool
    contracts, and derived-field caveats. Always prepended at request time.
  - normalizePromptForCompare: \r\n → \n + trim, used by NULL-when-equals-default
    check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Save action — persist `system_prompt` with normalized NULL-when-default

**Files:**
- Modify: `app/profile/actions.ts`

- [ ] **Step 1: Update `saveProfile` to handle `system_prompt`**

Replace the entire contents of `app/profile/actions.ts` with:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DEFAULT_SYSTEM_PROMPT,
  normalizePromptForCompare,
} from "@/lib/coach/system-prompts";

export async function saveProfile(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const num = (k: string) => {
    const v = formData.get(k);
    if (typeof v !== "string" || v.trim() === "") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  // system_prompt: empty/whitespace → null. Otherwise compare normalized form
  // against the normalized canonical default; if they match, persist null so
  // future code-side updates of DEFAULT_SYSTEM_PROMPT propagate. Else persist
  // the normalized value (also strips \r\n drift from clipboard round-trips).
  const systemPromptInput = formData.get("system_prompt");
  let systemPrompt: string | null = null;
  if (typeof systemPromptInput === "string" && systemPromptInput.trim() !== "") {
    const normalized = normalizePromptForCompare(systemPromptInput);
    const defaultNormalized = normalizePromptForCompare(DEFAULT_SYSTEM_PROMPT);
    systemPrompt = normalized === defaultNormalized ? null : normalized;
  }

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      name: str("name"),
      age: num("age"),
      height_cm: num("height_cm"),
      goal: str("goal"),
      system_prompt: systemPrompt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  revalidatePath("/profile");
  revalidatePath("/");
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. (`@/lib/coach/system-prompts` resolves; `Profile` type now has `system_prompt`.)

- [ ] **Step 3: Commit**

```bash
git add app/profile/actions.ts
git commit -m "$(cat <<'EOF'
feat(profile): saveProfile persists system_prompt with NULL-when-default check

Compares submitted prompt against DEFAULT_SYSTEM_PROMPT after normalising line
endings + trimming. When equal, writes NULL so code-side default updates
propagate. Otherwise writes the normalised value, which also fixes silent
\r\n drift from clipboard round-trips (Windows pastes, etc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Profile page — load `system_prompt`, pass to form

**Files:**
- Modify: `app/profile/page.tsx`

- [ ] **Step 1: Update the profile select + ProfileForm props**

Edit `app/profile/page.tsx`. Find the `profiles` select call (around line 30) and add `system_prompt` to the column list. Then update the `<ProfileForm initial={...} />` call to pass it through.

Replace the existing profile select:

```ts
    supabase
      .from("profiles")
      .select("name, age, height_cm, goal")
      .eq("user_id", user.id)
      .maybeSingle(),
```

With:

```ts
    supabase
      .from("profiles")
      .select("name, age, height_cm, goal, system_prompt")
      .eq("user_id", user.id)
      .maybeSingle(),
```

And the existing ProfileForm call:

```tsx
        <ProfileForm
          initial={{
            name: profile?.name ?? null,
            age: profile?.age ?? null,
            height_cm: profile?.height_cm ?? null,
            goal: profile?.goal ?? null,
          }}
        />
```

becomes:

```tsx
        <ProfileForm
          initial={{
            name: profile?.name ?? null,
            age: profile?.age ?? null,
            height_cm: profile?.height_cm ?? null,
            goal: profile?.goal ?? null,
            system_prompt: profile?.system_prompt ?? null,
          }}
        />
```

`profile?.system_prompt` cleanly handles all three cases: row missing (`profile` is `null` from `maybeSingle()` → `null`), column null (the column is null → `null`), and column set (the saved string passes through).

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: a typecheck error in `ProfileForm.tsx` because the `Props.initial` type doesn't accept `system_prompt` yet — that's fine, fix it in the next task.

- [ ] **Step 3: Commit (will fix the form type error in Task 6, this commit captures the page-side change separately)**

Skip the commit here; combine with Task 6 to keep the working tree green between commits.

---

## Task 6: Profile form — Coach Instructions textarea + Restore Default button

**Files:**
- Modify: `components/profile/ProfileForm.tsx`

- [ ] **Step 1: Replace the entire form file**

Replace the contents of `components/profile/ProfileForm.tsx` with:

```tsx
"use client";

import { useState, useTransition, useRef } from "react";
import { saveProfile } from "@/app/profile/actions";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/coach/system-prompts";

type Props = {
  initial: {
    name: string | null;
    age: number | null;
    height_cm: number | null;
    goal: string | null;
    system_prompt: string | null;
  };
};

export function ProfileForm({ initial }: Props) {
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  function onSubmit(formData: FormData) {
    setFlash(null);
    startTransition(async () => {
      try {
        await saveProfile(formData);
        setFlash("✓ Saved");
      } catch (e) {
        setFlash(`✗ ${(e as Error).message}`);
      }
    });
  }

  function restoreDefault() {
    if (promptRef.current) {
      promptRef.current.value = DEFAULT_SYSTEM_PROMPT;
      // Bring focus to the field so the user sees the change happened.
      promptRef.current.focus();
    }
  }

  return (
    <form action={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {flash && (
        <div
          style={{
            borderRadius: RADIUS.input,
            padding: "10px 14px",
            fontSize: "12px",
            background: flash.startsWith("✗") ? COLOR.dangerSoft : COLOR.accentSoft,
            border: `1px solid ${flash.startsWith("✗") ? COLOR.danger + "44" : COLOR.accent + "44"}`,
            color: flash.startsWith("✗") ? COLOR.danger : COLOR.accent,
          }}
        >
          {flash}
        </div>
      )}
      <Field name="name" label="Name" defaultValue={initial.name ?? ""} />
      <Field name="age" label="Age" type="number" defaultValue={initial.age?.toString() ?? ""} />
      <Field
        name="height_cm"
        label="Height"
        unit="cm"
        type="number"
        defaultValue={initial.height_cm?.toString() ?? ""}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: COLOR.textFaint,
            fontWeight: 600,
          }}
        >
          Goal
        </label>
        <textarea
          name="goal"
          defaultValue={initial.goal ?? ""}
          rows={3}
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "10px 12px",
            fontSize: "14px",
            outline: "none",
            resize: "vertical",
            color: COLOR.textStrong,
            fontFamily: "inherit",
          }}
        />
      </div>

      {/* Coach instructions — full system prompt, with Restore Default. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textFaint,
              fontWeight: 600,
            }}
          >
            Coach instructions
          </label>
          <button
            type="button"
            onClick={restoreDefault}
            style={{
              background: "transparent",
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.input,
              padding: "4px 10px",
              fontSize: "10px",
              color: COLOR.textMuted,
              cursor: "pointer",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            Restore default
          </button>
        </div>
        <textarea
          ref={promptRef}
          name="system_prompt"
          defaultValue={initial.system_prompt ?? DEFAULT_SYSTEM_PROMPT}
          rows={12}
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "10px 12px",
            fontSize: "13px",
            lineHeight: 1.5,
            outline: "none",
            resize: "vertical",
            color: COLOR.textStrong,
            fontFamily: "inherit",
          }}
        />
        <div style={{ fontSize: "10px", color: COLOR.textFaint, lineHeight: 1.4 }}>
          Steers the chat coach. The schema explainer (column meanings, tool contracts) is added
          automatically and isn't editable here.
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        style={{
          alignSelf: "flex-end",
          background: COLOR.accent,
          border: "none",
          borderRadius: "12px",
          padding: "10px 20px",
          fontSize: "12px",
          fontWeight: 700,
          color: "#fff",
          cursor: "pointer",
          opacity: pending ? 0.5 : 1,
        }}
      >
        {pending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  unit,
  type = "text",
  defaultValue,
}: {
  name: string;
  label: string;
  unit?: string;
  type?: "text" | "number";
  defaultValue: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: COLOR.textFaint,
          fontWeight: 600,
        }}
      >
        {label}
        {unit && <span style={{ color: COLOR.textFaint, marginLeft: "2px" }}>{unit}</span>}
      </label>
      <input
        name={name}
        type={type}
        step="any"
        defaultValue={defaultValue}
        style={{
          background: COLOR.surfaceAlt,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: RADIUS.input,
          padding: "10px 12px",
          fontSize: "14px",
          fontFamily: "monospace",
          outline: "none",
          color: COLOR.textStrong,
        }}
      />
    </div>
  );
}
```

The unused `Card` import in the original file is dropped (it wasn't referenced). Everything else preserves the existing styling.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Manual verification**

1. `npm run dev`
2. Open `http://localhost:3000/profile`.
3. Confirm the new "Coach instructions" textarea is rendered, prefilled with the canonical default text, with a "Restore default" button to its right.
4. Edit the textarea (e.g. add the line "Always end replies with a 🦾"), save.
5. Reload the page; confirm your edit persisted.
6. Click "Restore default" — confirm textarea contents replaced with the canonical default.
7. Save. Run in the Supabase Dashboard SQL Editor:
   ```sql
   select system_prompt from public.profiles where user_id = auth.uid();
   ```
   Expected: NULL (because the saved value matched the normalized default, the action wrote null).
8. Edit the textarea again, save. Re-run the query — confirm column now holds the edited string.

- [ ] **Step 4: Commit**

```bash
git add app/profile/page.tsx components/profile/ProfileForm.tsx
git commit -m "$(cat <<'EOF'
feat(profile): coach instructions textarea + restore default

ProfileForm now exposes the chat coach's user-editable system prompt as a
12-row textarea, prefilled with the canonical DEFAULT_SYSTEM_PROMPT when no
custom value is saved. Restore Default rewrites the textarea contents
client-side; saving an unchanged default writes NULL to the column so future
code-side default updates propagate.

The schema explainer (server-owned plumbing) is excluded from this surface;
the helper text under the textarea calls that out.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Snapshot — `getSyncFreshness` + `buildEphemeralHeader`

**Files:**
- Modify: `lib/coach/snapshot.ts`

- [ ] **Step 1: Append the two new helpers to `snapshot.ts`**

Append the following at the end of `lib/coach/snapshot.ts`:

```ts
// ── Ephemeral header (per-turn, NOT cached) ──────────────────────────────────
//
// Built fresh at request time. Carries today's row + yesterday's row (re-
// queried so freshly-arrived sync data isn't lied about) and a DATA FRESHNESS
// block giving hours-ago precision per source. Sits as a separate text block
// AFTER the cached snapshot prefix; never use cache_control on it.

export type SyncFreshnessRow = {
  source: "WHOOP" | "Withings" | "Apple Health" | "Yazio";
  /** ISO timestamp of the most recent daily_logs.updated_at where the
   *  source-signature column is non-null. Null if no rows ever. */
  last_write_at: string | null;
};

const FRESHNESS_SOURCES: { source: SyncFreshnessRow["source"]; signatureCol: string }[] = [
  { source: "WHOOP", signatureCol: "hrv" },
  { source: "Withings", signatureCol: "weight_kg" },
  { source: "Apple Health", signatureCol: "steps" },
  { source: "Yazio", signatureCol: "protein_g" },
];

export async function getSyncFreshness(
  supabase: SupabaseClient,
  userId: string,
): Promise<SyncFreshnessRow[]> {
  return Promise.all(
    FRESHNESS_SOURCES.map(async ({ source, signatureCol }) => {
      const { data } = await supabase
        .from("daily_logs")
        .select("updated_at")
        .eq("user_id", userId)
        .not(signatureCol, "is", null)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      return {
        source,
        last_write_at: (data?.updated_at as string | undefined) ?? null,
      };
    }),
  );
}

/** Render hours-ago in `Nh Mm ago (today|yesterday|N days ago)` form. */
export function formatFreshness(now: Date, last: string | null): string {
  if (!last) return "no data";
  const lastDate = new Date(last);
  const ms = now.getTime() - lastDate.getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  // Day bucket: compare calendar dates in user's tz proxy (UTC here is fine
  // for the bucket label since the precision is ±1 day; the hours-ago value
  // is the load-bearing number).
  const today = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const lastDay = new Date(last.slice(0, 10) + "T00:00:00Z");
  const dayDelta = Math.round((today.getTime() - lastDay.getTime()) / 86_400_000);
  let dayLabel: string;
  if (dayDelta <= 0) dayLabel = "today";
  else if (dayDelta === 1) dayLabel = "yesterday";
  else dayLabel = `${dayDelta} days ago`;
  return `${hours}h ${mins.toString().padStart(2, "0")}m ago (${dayLabel})`;
}

/** Build the per-turn ephemeral header. Re-queries today + yesterday rows
 *  fresh so post-cache data lands. Returned as a single string; the caller
 *  places it as the LAST text block of the user message right before the new
 *  user content, AFTER the cached snapshot prefix. NOT cacheable. */
export async function buildEphemeralHeader(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string> {
  const { supabase, userId } = opts;
  const today = todayInUserTz();
  const yesterdayDate = new Date(`${today}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  // Pull both rows + freshness in parallel.
  const [{ data: rows }, freshness, n] = await Promise.all([
    supabase
      .from("daily_logs")
      .select(
        "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories, weight_kg, protein_g, carbs_g, fat_g",
      )
      .eq("user_id", userId)
      .in("date", [today, yesterday]),
    getSyncFreshness(supabase, userId),
    Promise.resolve(nowInUserTz()),
  ]);

  const byDate = new Map<string, DailyLogRow>();
  for (const r of (rows ?? []) as DailyLogRow[]) byDate.set(r.date, r);

  const renderRow = (label: string, date: string) => {
    const r = byDate.get(date);
    const fmt = (v: number | null | undefined, unit = "") =>
      v === null || v === undefined ? "null" : `${v}${unit}`;
    return [
      `${label} (${date}):`,
      `  recovery=${fmt(r?.recovery)}  hrv=${fmt(r?.hrv)}  resting_hr=${fmt(r?.resting_hr)}  sleep_hours=${fmt(r?.sleep_hours)}  sleep_score=${fmt(r?.sleep_score)}`,
      `  strain=${fmt(r?.strain)}  steps=${fmt(r?.steps)}  weight_kg=${fmt(r?.weight_kg)}`,
      `  protein_g=${fmt(r?.protein_g)}  carbs_g=${fmt(r?.carbs_g)}  fat_g=${fmt(r?.fat_g)}`,
    ].join("\n");
  };

  const nowJsDate = new Date();
  const freshnessLines = freshness.map(
    (f) => `  ${f.source} last write: ${formatFreshness(nowJsDate, f.last_write_at)}`,
  );

  return [
    `NOW: ${n.date} ${n.time} ${n.utcOffset} (${n.weekday})`,
    ``,
    renderRow("TODAY", today),
    ``,
    renderRow("YESTERDAY", yesterday),
    ``,
    `DATA FRESHNESS:`,
    ...freshnessLines,
  ].join("\n");
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean. (Reuses existing imports `SupabaseClient`, `nowInUserTz`, `todayInUserTz`, the local `DailyLogRow` type.)

- [ ] **Step 3: Local sanity print (one-off, no commit)**

Add a temporary call inside the POST handler of `app/api/chat/messages/route.ts`, just before the existing `buildSnapshotText` line, **only as a smoke test** (revert before committing):

```ts
// TEMP: smoke-test the ephemeral header — REMOVE before commit.
const _ephSmokeHeader = await buildEphemeralHeader({ supabase: sr as unknown as SupabaseClient, userId: user.id });
console.log("[ephemeral header]\n" + _ephSmokeHeader);
```

Required imports at the top of the file (these are kept; they're the same imports Task 8 adds for real):

```ts
import { buildEphemeralHeader } from "@/lib/coach/snapshot";
import type { SupabaseClient } from "@supabase/supabase-js";
```

Send a chat message via the UI; expected log output looks like:

```
[ephemeral header]
NOW: 2026-05-06 14:32 +02:00 (Wednesday)

TODAY (2026-05-06):
  recovery=72  hrv=58  resting_hr=49  sleep_hours=7.4  sleep_score=82
  strain=null  steps=null  weight_kg=null
  protein_g=null  carbs_g=null  fat_g=null

YESTERDAY (2026-05-05):
  recovery=64  hrv=51  resting_hr=52  sleep_hours=6.8  sleep_score=74
  ...

DATA FRESHNESS:
  WHOOP last write: 6h 18m ago (today)
  Withings last write: 18h 42m ago (yesterday)
  Apple Health last write: 21h 03m ago (yesterday)
  Yazio last write: 22h 51m ago (yesterday)
```

After confirming the shape, **revert the temporary smoke-test code** (don't commit it). The header gets wired in for real in Task 8.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/snapshot.ts
git commit -m "$(cat <<'EOF'
feat(coach): buildEphemeralHeader + getSyncFreshness for per-turn header

The chat route currently sees only the 14-day cached snapshot, which can lag
behind sync arrivals (WHOOP cron at 08:00 UTC, Withings event-driven, etc).
buildEphemeralHeader re-queries today + yesterday rows at request time and
appends a DATA FRESHNESS line (hours-ago precision per source-signature
column) so the model can tell "today's data landed an hour ago" vs "...landed
last night". Returned as plain string; caller places it AFTER the cached
prefix as a non-cached text block.

Wiring into the chat route follows in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `system_prompt` + ephemeral header into chat route (still using `streamClaude`, no tools yet)

**Files:**
- Modify: `app/api/chat/messages/route.ts`

This is an intermediate state — the route now uses the user-editable system prompt and the ephemeral header, but still goes through the hand-rolled `streamClaude` (no tools). This keeps the chat working while we build out the tool layer.

- [ ] **Step 1: Replace the hardcoded `SYSTEM_PROMPT` constant**

In `app/api/chat/messages/route.ts`, delete the multi-line `SYSTEM_PROMPT` constant (currently around lines 108–115) and replace with imports:

```ts
import {
  DEFAULT_SYSTEM_PROMPT,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
import { buildEphemeralHeader } from "@/lib/coach/snapshot";
import type { SupabaseClient } from "@supabase/supabase-js";
```

- [ ] **Step 2: Load the user's `system_prompt` and build the final system block**

Inside `POST(req)`, after the existing `const sr = createSupabaseServiceRoleClient();` line and before the rolling-window query (around current line 218), add:

```ts
  // Resolve effective system prompt: SCHEMA_EXPLAINER + (user override OR default).
  const { data: profileRow } = await sr
    .from("profiles")
    .select("system_prompt")
    .eq("user_id", user.id)
    .maybeSingle();
  const userPrompt =
    typeof profileRow?.system_prompt === "string" && profileRow.system_prompt.length > 0
      ? profileRow.system_prompt
      : DEFAULT_SYSTEM_PROMPT;
  const finalSystemPrompt = `${SCHEMA_EXPLAINER}\n\n---\n\n${userPrompt}`;
```

- [ ] **Step 3: Build the ephemeral header and append it as the last user-message text block**

After the existing `messages.push({ role: "user", content: newTurnBlocks });` line (around current line 300), add:

```ts
  // Ephemeral header (NOT cached): fresh today + yesterday + sync freshness.
  // Placed as a separate user message AFTER any cached prefix, BEFORE the
  // assistant turn the model is about to emit.
  const ephemeralHeader = await buildEphemeralHeader({
    supabase: sr as unknown as SupabaseClient,
    userId: user.id,
  });
  messages.push({
    role: "user",
    content: [{ type: "text", text: ephemeralHeader }],
  });
```

Wait — Anthropic requires alternating user/assistant turns. The new-user-message immediately followed by another user message would violate that. **Correct approach:** prepend the ephemeral header as an additional content block on the same final user message, not as a separate message. Update the block above the new-user-turn instead.

Replace the prior new-turn push:

```ts
  messages.push({ role: "user", content: newTurnBlocks });
```

With:

```ts
  // Ephemeral header is the FIRST text block of the new user turn (preceding
  // the actual content). Stays out of the cached snapshot prefix and adjacent
  // to the user's question so the model has the freshest context next to the
  // ask. Not marked cache_control — must NOT be cached.
  const ephemeralHeader = await buildEphemeralHeader({
    supabase: sr as unknown as SupabaseClient,
    userId: user.id,
  });
  const headerBlock: ContentBlock = { type: "text", text: ephemeralHeader };
  messages.push({ role: "user", content: [headerBlock, ...newTurnBlocks] });
```

- [ ] **Step 4: Replace the inline `SYSTEM_PROMPT` reference inside the streamClaude call**

Find the existing call (around current line 317):

```ts
        for await (const ev of streamClaude(messages, {
          model: MODEL,
          system: [
            { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
          maxTokens: 2000,
          signal: req.signal,
        })) {
```

Replace `SYSTEM_PROMPT` with `finalSystemPrompt`:

```ts
        for await (const ev of streamClaude(messages, {
          model: MODEL,
          system: [
            { type: "text", text: finalSystemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
          maxTokens: 2000,
          signal: req.signal,
        })) {
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Manual verification**

1. `npm run dev`
2. Open `/coach`. Send a message: "What was my recovery this morning?"
3. Confirm the reply cites the actual recovery number from `daily_logs` for today (or yesterday if today's row hasn't landed) — not an estimate.
4. Add a server-side log line right before the `streamClaude` call to spot-check the system prompt contains both `SCHEMA_EXPLAINER` and either the default or your edited `Coach instructions`. Remove the log after spot-check.
5. Edit `Coach instructions` at `/profile` (e.g. add "Always reply in lowercase."). Save. Send a chat. Confirm the reply respects the override.

- [ ] **Step 7: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "$(cat <<'EOF'
feat(chat): wire user-editable system prompt + ephemeral header into route

- System prompt is now SCHEMA_EXPLAINER + (profile.system_prompt ?? DEFAULT).
  Replaces the inline SYSTEM_PROMPT constant; the schema explainer is server-
  owned plumbing that's never editable.
- Per-turn ephemeral header (today + yesterday + sync freshness) is prepended
  to the new-user-turn content blocks. Sits OUTSIDE the cached snapshot prefix
  so freshly-arrived sync data is reflected without busting cache.

Tools remain unwired in this commit; still streaming via streamClaude.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Pure derived helpers

**Files:**
- Create: `lib/coach/derived.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/coach/derived.ts
//
// Pure helpers for the coach tool layer. No DB access, no Supabase client —
// inputs are typed values, outputs are typed values. Keep this side-effect-
// free so it's trivial to reason about and to unit-test (when we add a test
// harness).
//
// Why a separate `epley` from lib/ui/score.ts:est1rm: the existing helper
// returns 0 for missing/zero inputs and rounds to int. The tool layer needs
// `null` semantics (so the model sees "missing" not "zero") and unrounded
// floats (so cumulative comparisons don't drift).

export type SetRow = {
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
};

/** Epley one-rep-max estimate. Returns null when reps is out of the
 *  reliable range (<=0 or >12) or kg/reps is missing. */
export function epley(kg: number | null, reps: number | null): number | null {
  if (kg === null || reps === null) return null;
  if (reps <= 0 || reps > 12) return null;
  if (kg <= 0) return null;
  if (reps === 1) return kg;
  return Math.round(kg * (1 + reps / 30) * 10) / 10; // 1-decimal precision
}

/** Sum of (kg × reps) over the working sets only. Warmups excluded.
 *  Duration-based sets (kg or reps null) contribute zero. */
export function workingVolume(sets: SetRow[]): number {
  let v = 0;
  for (const s of sets) {
    if (s.warmup) continue;
    if (s.kg === null || s.reps === null) continue;
    v += s.kg * s.reps;
  }
  return Math.round(v);
}

/** Working sets count (warmups excluded). */
export function workingSetCount(sets: SetRow[]): number {
  let n = 0;
  for (const s of sets) if (!s.warmup) n++;
  return n;
}

/** Sets flagged failure: true (working sets only). */
export function hardSetCount(sets: SetRow[]): number {
  let n = 0;
  for (const s of sets) if (!s.warmup && s.failure) n++;
  return n;
}

/** Pick the "top set" for an exercise within a workout: highest e1RM among
 *  working sets; tie-broken by higher kg. For duration-based exercises with
 *  no e1RM, fall back to the longest duration_seconds. Returns null if no
 *  working sets at all. */
export function topSet(sets: SetRow[]):
  | { kg: number | null; reps: number | null; duration_seconds: number | null; e1RM: number | null }
  | null {
  const working = sets.filter((s) => !s.warmup);
  if (working.length === 0) return null;

  // Path 1: weighted sets with e1RM.
  const withE1rm = working
    .map((s) => ({ s, e: epley(s.kg, s.reps) }))
    .filter((x) => x.e !== null) as { s: SetRow; e: number }[];
  if (withE1rm.length > 0) {
    withE1rm.sort((a, b) => {
      if (b.e !== a.e) return b.e - a.e;
      return (b.s.kg ?? 0) - (a.s.kg ?? 0);
    });
    const best = withE1rm[0];
    return {
      kg: best.s.kg,
      reps: best.s.reps,
      duration_seconds: best.s.duration_seconds,
      e1RM: best.e,
    };
  }

  // Path 2: weighted but reps>12 (e1RM null) — pick highest kg, then highest reps.
  const weighted = working.filter((s) => s.kg !== null && s.reps !== null);
  if (weighted.length > 0) {
    weighted.sort((a, b) => {
      const dk = (b.kg ?? 0) - (a.kg ?? 0);
      if (dk !== 0) return dk;
      return (b.reps ?? 0) - (a.reps ?? 0);
    });
    const best = weighted[0];
    return {
      kg: best.kg,
      reps: best.reps,
      duration_seconds: best.duration_seconds,
      e1RM: null,
    };
  }

  // Path 3: duration-based — longest duration wins.
  const duration = working.filter((s) => s.duration_seconds !== null);
  if (duration.length > 0) {
    duration.sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0));
    const best = duration[0];
    return {
      kg: best.kg,
      reps: best.reps,
      duration_seconds: best.duration_seconds,
      e1RM: null,
    };
  }

  return null;
}

/** ISO-week start (Monday, UTC). YYYY-MM-DD in / YYYY-MM-DD out. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat. Monday → 0 offset, Sunday → 6.
  const dow = d.getUTCDay();
  const offset = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Calendar month start. YYYY-MM-DD in / YYYY-MM-DD (the 01) out. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Quick sanity check**

In a Node REPL:

```bash
cd "/Users/abdelouahedelbied/Health app"
node --input-type=module -e "
import('./lib/coach/derived.ts').catch(()=>null);
" 2>&1 | head
```

This will fail because Node can't import TS directly. Instead, do a typecheck-only verification (already done) and trust the types. Actual behavioral verification happens through the executor in Task 11/12.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/derived.ts
git commit -m "$(cat <<'EOF'
feat(coach): derived.ts — pure helpers for tool layer

epley (Epley e1RM with reps≤12 cap, null-aware), workingVolume,
workingSetCount, hardSetCount, topSet (e1RM-first with weighted-only and
duration-only fallbacks), weekStart, monthStart. No DB access, no Supabase —
pure inputs/outputs so the tool executors stay easy to reason about.

Distinct from lib/ui/score.ts:est1rm because the tool layer needs null
semantics ("missing" vs "zero") and unrounded floats.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Exercise category lookup — seed table

**Files:**
- Create: `lib/coach/exercise-categories.ts`

This is the one task that needs an actual one-off query against the user's data to seed the lookup table. Run the SQL, get the distinct exercise names, build the literal, audit it.

- [ ] **Step 1: Pull the user's distinct exercise names**

In Supabase Dashboard → SQL Editor, run:

```sql
select distinct lower(name) as name
from public.exercises e
join public.workouts w on w.id = e.workout_id
where w.user_id = auth.uid()
order by 1;
```

Save the output as a flat list (one exercise per line). The point is to ensure the lookup table covers everything currently logged.

- [ ] **Step 2: Build the lookup file**

Write `lib/coach/exercise-categories.ts`:

```ts
// lib/coach/exercise-categories.ts
//
// Seven-bucket movement-pattern lookup. Coarser than per-muscle resolution
// (chest/quads/etc.), finer than workout.type. Lets the coach answer "am I
// doing enough push work this week?" / "any pattern I'm neglecting?" without
// the maintenance tarpit of secondary-mover weighting.
//
// Buckets:
//   push        — chest, shoulders, triceps; lateral raises; tricep isolation
//   pull        — back, lats, rear delts, biceps, face pulls
//   squat       — bilateral knee-dominant (back/front/leg-press/hack)
//   hinge       — hip-dominant (deadlift, RDL, good morning, hip thrust, swing)
//   single-leg  — unilateral lower (lunge, split squat, step-up, pistol)
//   core        — abs, obliques, anti-extension/anti-rotation
//   accessory   — calves, forearms, neck, grip, anything that doesn't fit
//   uncategorized — fallback; a missing-data flag, NOT a category. The schema
//                   explainer instructs the model to exclude these from rollups
//                   rather than infer.
//
// Lookup is on the NORMALISED key (lowercase, parens stripped, whitespace
// collapsed). Responses always carry the ORIGINAL exercise_name — otherwise
// barbell-bench-press and dumbbell-bench-press would collide and we'd lose
// progression tracking per implement.

export type ExerciseCategory =
  | "push" | "pull" | "squat" | "hinge"
  | "single-leg" | "core" | "accessory" | "uncategorized";

export const EXERCISE_CATEGORY: Record<string, ExerciseCategory> = {
  // ── PUSH ─────────────────────────────────────────────────────────────────
  "bench press": "push",
  "incline bench press": "push",
  "decline bench press": "push",
  "dumbbell bench press": "push",
  "incline dumbbell press": "push",
  "overhead press": "push",
  "seated overhead press": "push",
  "dumbbell shoulder press": "push",
  "arnold press": "push",
  "lateral raise": "push",
  "front raise": "push",
  "cable lateral raise": "push",
  "machine shoulder press": "push",
  "push-up": "push",
  "dip": "push",
  "tricep extension": "push",
  "tricep pushdown": "push",
  "skull crusher": "push",
  "close-grip bench press": "push",
  "chest fly": "push",
  "cable fly": "push",
  "pec deck": "push",

  // ── PULL ─────────────────────────────────────────────────────────────────
  "barbell row": "pull",
  "pendlay row": "pull",
  "dumbbell row": "pull",
  "seated cable row": "pull",
  "t-bar row": "pull",
  "machine row": "pull",
  "pull-up": "pull",
  "chin-up": "pull",
  "lat pulldown": "pull",
  "neutral grip pulldown": "pull",
  "face pull": "pull",
  "rear delt fly": "pull",
  "reverse fly": "pull",
  "bicep curl": "pull",
  "barbell curl": "pull",
  "dumbbell curl": "pull",
  "hammer curl": "pull",
  "preacher curl": "pull",
  "cable curl": "pull",
  "shrug": "pull",

  // ── SQUAT ────────────────────────────────────────────────────────────────
  "back squat": "squat",
  "barbell squat": "squat",
  "front squat": "squat",
  "high-bar squat": "squat",
  "low-bar squat": "squat",
  "goblet squat": "squat",
  "leg press": "squat",
  "hack squat": "squat",
  "machine squat": "squat",
  "leg extension": "squat",

  // ── HINGE ────────────────────────────────────────────────────────────────
  "deadlift": "hinge",
  "conventional deadlift": "hinge",
  "sumo deadlift": "hinge",
  "romanian deadlift": "hinge",
  "stiff-leg deadlift": "hinge",
  "good morning": "hinge",
  "hip thrust": "hinge",
  "barbell hip thrust": "hinge",
  "glute bridge": "hinge",
  "kettlebell swing": "hinge",
  "back extension": "hinge",
  "hyperextension": "hinge",
  "leg curl": "hinge",
  "lying leg curl": "hinge",
  "seated leg curl": "hinge",

  // ── SINGLE-LEG ───────────────────────────────────────────────────────────
  "lunge": "single-leg",
  "walking lunge": "single-leg",
  "reverse lunge": "single-leg",
  "split squat": "single-leg",
  "bulgarian split squat": "single-leg",
  "step-up": "single-leg",
  "single-leg press": "single-leg",
  "pistol squat": "single-leg",
  "single-leg deadlift": "single-leg",

  // ── CORE ─────────────────────────────────────────────────────────────────
  "plank": "core",
  "side plank": "core",
  "ab wheel rollout": "core",
  "hanging leg raise": "core",
  "cable crunch": "core",
  "russian twist": "core",
  "dead bug": "core",
  "pallof press": "core",
  "hollow body hold": "core",
  "sit-up": "core",
  "v-up": "core",

  // ── ACCESSORY ────────────────────────────────────────────────────────────
  "calf raise": "accessory",
  "standing calf raise": "accessory",
  "seated calf raise": "accessory",
  "donkey calf raise": "accessory",
  "wrist curl": "accessory",
  "reverse wrist curl": "accessory",
  "farmer's carry": "accessory",
  "farmers walk": "accessory",
  "neck flexion": "accessory",
  "neck extension": "accessory",

  // NOTE: This seed mapping covers the canonical names. If the SQL query in
  // Task 10 step 1 returns names not present here, add them with one of the
  // 7 buckets and re-commit. Variants with equipment in parens are stripped
  // by normalize() so the same key works for "Bench Press" and
  // "Bench Press (Barbell)".
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function categorize(name: string): ExerciseCategory {
  return EXERCISE_CATEGORY[normalize(name)] ?? "uncategorized";
}
```

- [ ] **Step 3: Audit pass — match the seed against the user's actual exercises**

Take the list from Step 1 and walk through it. For each exercise name:

- If `categorize(name)` (mentally apply normalize → lookup) returns the right bucket → fine.
- If it returns `"uncategorized"` and you know the right bucket → add the entry to `EXERCISE_CATEGORY`.
- If it's an ambiguous edge case (e.g. cable lateral raise — push or accessory?) → pick one, document the choice in a comment. The rule of thumb in `system-prompts.ts SCHEMA_EXPLAINER` is "exclude or report uncategorized separately"; defaulting borderline cases to a real bucket is preferable to a false `"uncategorized"`.

The goal is **zero `"uncategorized"` results from the user's existing data**. If anything remains uncategorized, add it before commit.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/exercise-categories.ts
git commit -m "$(cat <<'EOF'
feat(coach): exercise-categories — 7-bucket movement-pattern lookup

push / pull / squat / hinge / single-leg / core / accessory / uncategorized.
Coarser than per-muscle volume (no secondary-mover weighting tarpit),
finer than workout.type. Used by tool responses so the coach can answer
push:pull balance and movement-pattern coverage questions concretely.

Lookup runs on the NORMALISED key (lowercase, parens stripped); responses
always carry the original exercise_name to preserve barbell-vs-DB
progression. Seeded against the user's distinct logged exercises so
\`uncategorized\` is empty out of the gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Tool definitions + `query_daily_logs` executor

**Files:**
- Create: `lib/coach/tools.ts`

- [ ] **Step 1: Write the tool definitions, validators, and `query_daily_logs` executor**

```ts
// lib/coach/tools.ts
//
// Anthropic tool schemas + server-side executors for the chat coach.
//
// Security invariants (load-bearing — must hold for every executor):
//   1. Tool input schemas NEVER include user_id. The model cannot pass it;
//      the route injects it from supabase.auth.getUser().
//   2. Every executor's underlying query MUST .eq("user_id", userId), even
//      though service_role bypasses RLS. This .eq is the actual scoping.
//   3. Inputs are validated against closed enums (ALLOWED_COLUMNS, granularity,
//      aggregate) BEFORE any query is constructed.
//   4. Date strings are parsed and re-formatted to YYYY-MM-DD before going
//      into a query. Never interpolated raw.
//   5. Range caps are enforced before the query runs.
//
// Tool errors are returned as `tool_result` content with is_error: true.
// They are part of the conversation; only Anthropic-level failures escalate
// to a top-level SSE error.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  epley,
  hardSetCount,
  monthStart,
  topSet,
  weekStart,
  workingSetCount,
  workingVolume,
  type SetRow,
} from "@/lib/coach/derived";
import { categorize, type ExerciseCategory } from "@/lib/coach/exercise-categories";

// ── Allowlist (cross-checked against lib/data/types.ts:DailyLog + schema.sql) ─
export const ALLOWED_COLUMNS = [
  "hrv", "resting_hr", "recovery",
  "sleep_hours", "sleep_score", "deep_sleep_hours", "rem_sleep_hours",
  "spo2", "skin_temp_c", "respiratory_rate", "strain",
  "steps", "calories", "active_calories", "distance_km", "exercise_min",
  "weight_kg", "body_fat_pct",
  "fat_mass_kg", "fat_free_mass_kg", "muscle_mass_kg", "bone_mass_kg", "hydration_kg",
  "protein_g", "carbs_g", "fat_g", "calories_eaten",
  "notes",
] as const;
export type AllowedColumn = (typeof ALLOWED_COLUMNS)[number];

const ALLOWED_AGGREGATES = ["raw", "avg", "sum", "min", "max"] as const;
type AggregateMode = (typeof ALLOWED_AGGREGATES)[number];

const ALLOWED_GRANULARITIES = ["summary", "sets", "by_week", "by_month"] as const;
type WorkoutGranularity = (typeof ALLOWED_GRANULARITIES)[number];

// ── Tool schemas exposed to Anthropic ────────────────────────────────────────
export const DAILY_LOGS_TOOL = {
  name: "query_daily_logs",
  description:
    "Fetch the athlete's daily_logs for a date range. Returns one row per day in `raw` mode, or one aggregated row in `avg`/`sum`/`min`/`max` mode. Use this whenever you need numbers older than today/yesterday or outside the orientation snapshot. Respect the 90-day cap in raw mode; aggregate mode is uncapped (one row regardless of range).",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date", description: "YYYY-MM-DD inclusive lower bound." },
      end_date: { type: "string", format: "date", description: "YYYY-MM-DD inclusive upper bound." },
      columns: {
        type: "array",
        items: { type: "string", enum: ALLOWED_COLUMNS },
        description: "Subset of columns to return. Omit for the full default set.",
      },
      aggregate: {
        type: "string",
        enum: ALLOWED_AGGREGATES,
        default: "raw",
        description:
          "raw → one row per day; avg/sum/min/max → one row over the whole range, with non_null_count + null_count per column.",
      },
    },
  },
};

export const WORKOUTS_TOOL = {
  name: "query_workouts",
  description:
    "Fetch the athlete's strength training history. granularity: 'summary' (default, one row per workout with derived volume/top-set/e1RM), 'sets' (one row per set), 'by_week'/'by_month' (per-period rollups with set counts by 7-bucket category). exercise_name filters to one exercise. Warmups are always excluded from volume / e1RM / counts.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date" },
      exercise_name: { type: "string" },
      granularity: {
        type: "string",
        enum: ALLOWED_GRANULARITIES,
        default: "summary",
      },
    },
  },
};

// ── Validation helpers ───────────────────────────────────────────────────────
function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function reformatYmd(s: string): string {
  // Already validated to YYYY-MM-DD by isYmd(); re-stringify via Date to catch
  // invalid calendar dates like 2026-02-30.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error("invalid_date");
  return d.toISOString().slice(0, 10);
}
function diffDays(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1; // inclusive
}

export type ToolError = { error: string; hint?: string };
export type ToolResult<T> =
  | { ok: true; data: T; meta: { ms: number; result_rows: number; range_days: number; truncated: boolean } }
  | { ok: false; error: ToolError; meta: { ms: number; range_days: number } };

// ── query_daily_logs executor ────────────────────────────────────────────────
type DailyLogsRawData = Record<string, unknown>[];
type DailyLogsAggData = {
  range: { start_date: string; end_date: string; days: number };
  values: Record<string, number | string | null>;
  non_null_count: Record<string, number>;
  null_count: Record<string, number>;
};

export async function executeQueryDailyLogs(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<DailyLogsRawData | DailyLogsAggData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // --- Validation (security invariants 3, 4) ---
  if (!isYmd(i.start_date) || !isYmd(i.end_date)) {
    return {
      ok: false,
      error: { error: "start_date and end_date must be YYYY-MM-DD" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  let start: string, end: string;
  try {
    start = reformatYmd(i.start_date);
    end = reformatYmd(i.end_date);
  } catch {
    return {
      ok: false,
      error: { error: "invalid calendar date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (start > end) {
    return {
      ok: false,
      error: { error: "start_date must be <= end_date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const range_days = diffDays(start, end);

  const aggregateRaw = i.aggregate ?? "raw";
  if (typeof aggregateRaw !== "string" || !ALLOWED_AGGREGATES.includes(aggregateRaw as AggregateMode)) {
    return {
      ok: false,
      error: { error: `aggregate must be one of: ${ALLOWED_AGGREGATES.join(", ")}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const aggregate = aggregateRaw as AggregateMode;

  let columns: AllowedColumn[];
  if (i.columns === undefined) {
    columns = [...ALLOWED_COLUMNS];
  } else if (Array.isArray(i.columns) && i.columns.every((c) => typeof c === "string")) {
    const unknownCol = (i.columns as string[]).find((c) => !ALLOWED_COLUMNS.includes(c as AllowedColumn));
    if (unknownCol !== undefined) {
      return {
        ok: false,
        error: { error: `unknown column: ${unknownCol}`, hint: `allowed: ${ALLOWED_COLUMNS.join(", ")}` },
        meta: { ms: Date.now() - t0, range_days },
      };
    }
    columns = i.columns as AllowedColumn[];
  } else {
    return {
      ok: false,
      error: { error: "columns must be an array of strings or omitted" },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  // --- Range cap (security invariant 5) ---
  if (aggregate === "raw" && range_days > 90) {
    return {
      ok: false,
      error: {
        error: `raw mode max 90 days; got ${range_days}`,
        hint: "switch to aggregate or narrow start_date",
      },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  // --- Query (security invariant 2: .eq("user_id", userId)) ---
  const selectCols = ["date", ...columns].join(", ");
  const { data: rows, error } = await opts.supabase
    .from("daily_logs")
    .select(selectCols)
    .eq("user_id", opts.userId)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true });
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }

  if (aggregate === "raw") {
    const data = (rows ?? []) as DailyLogsRawData;
    return {
      ok: true,
      data,
      meta: { ms: Date.now() - t0, result_rows: data.length, range_days, truncated: false },
    };
  }

  // --- Aggregate path ---
  const values: Record<string, number | string | null> = {};
  const nonNull: Record<string, number> = {};
  const nulls: Record<string, number> = {};
  for (const c of columns) {
    nonNull[c] = 0;
    nulls[c] = 0;
  }
  // For string columns (notes), aggregate is meaningless — emit null.
  const numericCols: AllowedColumn[] = columns.filter((c) => c !== "notes") as AllowedColumn[];
  const stringCols: AllowedColumn[] = columns.filter((c) => c === "notes") as AllowedColumn[];

  for (const r of rows ?? []) {
    const row = r as Record<string, unknown>;
    for (const c of columns) {
      const v = row[c];
      if (v === null || v === undefined) nulls[c]++;
      else nonNull[c]++;
    }
  }

  for (const c of numericCols) {
    const nums: number[] = [];
    for (const r of rows ?? []) {
      const v = (r as Record<string, unknown>)[c];
      if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    }
    if (nums.length === 0) {
      values[c] = null;
      continue;
    }
    let agg: number;
    switch (aggregate) {
      case "avg":
        agg = nums.reduce((a, b) => a + b, 0) / nums.length;
        agg = Math.round(agg * 100) / 100;
        break;
      case "sum":
        agg = nums.reduce((a, b) => a + b, 0);
        agg = Math.round(agg * 100) / 100;
        break;
      case "min":
        agg = Math.min(...nums);
        break;
      case "max":
        agg = Math.max(...nums);
        break;
      default:
        agg = NaN;
    }
    values[c] = Number.isFinite(agg) ? agg : null;
  }
  for (const c of stringCols) {
    values[c] = null; // aggregate over text is meaningless
  }

  const data: DailyLogsAggData = {
    range: { start_date: start, end_date: end, days: range_days },
    values,
    non_null_count: nonNull,
    null_count: nulls,
  };
  return {
    ok: true,
    data,
    meta: { ms: Date.now() - t0, result_rows: 1, range_days, truncated: false },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): tools.ts — DAILY_LOGS_TOOL schema + executeQueryDailyLogs

- Anthropic tool schema with closed-enum allowlists for columns + aggregate
- Validators enforce security invariants (no user_id in input, .eq scoping,
  YYYY-MM-DD parse + re-format, range cap)
- Raw mode returns rows with date + requested columns
- Aggregate mode (avg/sum/min/max) returns one row plus per-column
  non_null_count + null_count so the model can call out sparse coverage

Workouts executor + tool loop wiring follow in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `query_workouts` executor (all four granularities)

**Files:**
- Modify: `lib/coach/tools.ts` (append `executeQueryWorkouts`)

- [ ] **Step 1: Append the workouts executor**

At the bottom of `lib/coach/tools.ts`, add:

```ts
// ── query_workouts executor ──────────────────────────────────────────────────

type WorkoutSummaryRow = {
  date: string;
  type: string | null;
  duration_min: number | null;
  total_volume_kg: number;
  working_set_count: number;
  hard_set_count: number;
  top_sets_per_exercise: {
    exercise_name: string;
    category: ExerciseCategory;
    kg: number | null;
    reps: number | null;
    duration_seconds: number | null;
    e1RM: number | null;
  }[];
};

type WorkoutSetRow = {
  date: string;
  exercise_name: string;
  category: ExerciseCategory;
  set_index: number;
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  e1RM: number | null;
  failure: boolean;
};

type WorkoutPeriodRow = {
  period_start: string;
  period_end: string;
  workout_count: number;
  total_volume_kg: number;
  set_counts_by_category: Record<ExerciseCategory, number>;
  top_set_per_exercise: {
    exercise_name: string;
    category: ExerciseCategory;
    kg: number | null;
    reps: number | null;
    duration_seconds: number | null;
    e1RM: number | null;
    date: string;
  }[];
};

const SETS_PER_EXERCISE_CAP = 60;
const SETS_TOTAL_CAP = 400;
const SUMMARY_CAP = 90;

type RawWorkout = {
  id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  exercises: {
    name: string;
    position: number | null;
    exercise_sets: {
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      set_index: number;
    }[];
  }[] | null;
};

export async function executeQueryWorkouts(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<WorkoutSummaryRow[] | WorkoutSetRow[] | WorkoutPeriodRow[]>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // --- Validation ---
  if (!isYmd(i.start_date) || !isYmd(i.end_date)) {
    return {
      ok: false,
      error: { error: "start_date and end_date must be YYYY-MM-DD" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  let start: string, end: string;
  try {
    start = reformatYmd(i.start_date);
    end = reformatYmd(i.end_date);
  } catch {
    return {
      ok: false,
      error: { error: "invalid calendar date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (start > end) {
    return {
      ok: false,
      error: { error: "start_date must be <= end_date" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const range_days = diffDays(start, end);

  const granRaw = i.granularity ?? "summary";
  if (typeof granRaw !== "string" || !ALLOWED_GRANULARITIES.includes(granRaw as WorkoutGranularity)) {
    return {
      ok: false,
      error: { error: `granularity must be one of: ${ALLOWED_GRANULARITIES.join(", ")}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const granularity = granRaw as WorkoutGranularity;

  const exerciseFilterRaw = i.exercise_name;
  if (exerciseFilterRaw !== undefined && typeof exerciseFilterRaw !== "string") {
    return {
      ok: false,
      error: { error: "exercise_name must be a string or omitted" },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const exerciseFilter = (exerciseFilterRaw as string | undefined)?.toLowerCase() ?? null;

  // --- Query (security invariant 2: .eq) ---
  const { data: workouts, error } = await opts.supabase
    .from("workouts")
    .select(
      `id, date, type, duration_min,
       exercises(name, position,
         exercise_sets(kg, reps, duration_seconds, warmup, failure, set_index))`,
    )
    .eq("user_id", opts.userId)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true });
  if (error) {
    return {
      ok: false,
      error: { error: `db_error: ${error.message}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  const raws = (workouts ?? []) as RawWorkout[];

  // --- Branch by granularity ---
  if (granularity === "summary") {
    const all = raws.map((w) => buildSummary(w, exerciseFilter));
    const truncated = all.length > SUMMARY_CAP;
    const slice = truncated ? all.slice(-SUMMARY_CAP) : all;
    return {
      ok: true,
      data: slice,
      meta: { ms: Date.now() - t0, result_rows: slice.length, range_days, truncated },
    };
  }

  if (granularity === "sets") {
    const all = flattenSets(raws, exerciseFilter);
    // Per-exercise cap, then total cap. Both apply; per-exercise first so a
    // dominant lift can't starve everything else.
    const byExercise = new Map<string, WorkoutSetRow[]>();
    for (const r of all) {
      const arr = byExercise.get(r.exercise_name) ?? [];
      arr.push(r);
      byExercise.set(r.exercise_name, arr);
    }
    let perExerciseTrimmed = 0;
    for (const [k, arr] of byExercise) {
      if (arr.length > SETS_PER_EXERCISE_CAP) {
        perExerciseTrimmed += arr.length - SETS_PER_EXERCISE_CAP;
        byExercise.set(k, arr.slice(-SETS_PER_EXERCISE_CAP));
      }
    }
    const merged: WorkoutSetRow[] = [];
    for (const arr of byExercise.values()) merged.push(...arr);
    merged.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.exercise_name.localeCompare(b.exercise_name) ||
        a.set_index - b.set_index,
    );
    const totalTrimmed = merged.length > SETS_TOTAL_CAP;
    const slice = totalTrimmed ? merged.slice(-SETS_TOTAL_CAP) : merged;
    return {
      ok: true,
      data: slice,
      meta: {
        ms: Date.now() - t0,
        result_rows: slice.length,
        range_days,
        truncated: totalTrimmed || perExerciseTrimmed > 0,
      },
    };
  }

  // by_week / by_month
  const bucketFn = granularity === "by_week" ? weekStart : monthStart;
  const buckets = new Map<string, RawWorkout[]>();
  for (const w of raws) {
    const k = bucketFn(w.date);
    const arr = buckets.get(k) ?? [];
    arr.push(w);
    buckets.set(k, arr);
  }
  const periodRows: WorkoutPeriodRow[] = [];
  for (const [k, ws] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    periodRows.push(buildPeriodRow(k, ws, granularity, exerciseFilter));
  }
  return {
    ok: true,
    data: periodRows,
    meta: { ms: Date.now() - t0, result_rows: periodRows.length, range_days, truncated: false },
  };
}

// ── Internal builders ────────────────────────────────────────────────────────

function flattenSets(workouts: RawWorkout[], exerciseFilter: string | null): WorkoutSetRow[] {
  const out: WorkoutSetRow[] = [];
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      if (exerciseFilter && !e.name.toLowerCase().includes(exerciseFilter)) continue;
      const cat = categorize(e.name);
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue; // warmups always excluded
        out.push({
          date: w.date,
          exercise_name: e.name,
          category: cat,
          set_index: s.set_index,
          kg: s.kg,
          reps: s.reps,
          duration_seconds: s.duration_seconds,
          e1RM: epley(s.kg, s.reps),
          failure: s.failure,
        });
      }
    }
  }
  return out;
}

function buildSummary(w: RawWorkout, exerciseFilter: string | null): WorkoutSummaryRow {
  // Accumulate volume / set counts across the WHOLE session even when the
  // user filtered to one exercise (filter applies to top_sets_per_exercise
  // listing only — the volume/counts answer "how was this session" honestly).
  const allWorkingSets: SetRow[] = [];
  for (const e of w.exercises ?? []) {
    for (const s of e.exercise_sets ?? []) {
      allWorkingSets.push({
        kg: s.kg,
        reps: s.reps,
        duration_seconds: s.duration_seconds,
        warmup: s.warmup,
        failure: s.failure,
      });
    }
  }
  const topPerExercise: WorkoutSummaryRow["top_sets_per_exercise"] = [];
  for (const e of w.exercises ?? []) {
    if (exerciseFilter && !e.name.toLowerCase().includes(exerciseFilter)) continue;
    const sets: SetRow[] = (e.exercise_sets ?? []).map((s) => ({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: s.duration_seconds,
      warmup: s.warmup,
      failure: s.failure,
    }));
    const top = topSet(sets);
    if (top) {
      topPerExercise.push({
        exercise_name: e.name,
        category: categorize(e.name),
        kg: top.kg,
        reps: top.reps,
        duration_seconds: top.duration_seconds,
        e1RM: top.e1RM,
      });
    }
  }
  return {
    date: w.date,
    type: w.type,
    duration_min: w.duration_min,
    total_volume_kg: workingVolume(allWorkingSets),
    working_set_count: workingSetCount(allWorkingSets),
    hard_set_count: hardSetCount(allWorkingSets),
    top_sets_per_exercise: topPerExercise,
  };
}

function buildPeriodRow(
  bucketStart: string,
  workouts: RawWorkout[],
  granularity: "by_week" | "by_month",
  exerciseFilter: string | null,
): WorkoutPeriodRow {
  // Period end is the last workout in the bucket — caller doesn't need
  // exact week-end / month-end since the bucket is computed by start key.
  const lastDate = workouts[workouts.length - 1].date;
  // Aggregate volume + per-category set counts across the bucket.
  let total = 0;
  const setCounts: Record<ExerciseCategory, number> = {
    push: 0, pull: 0, squat: 0, hinge: 0,
    "single-leg": 0, core: 0, accessory: 0, uncategorized: 0,
  };
  // Track top set per exercise across the period.
  const bestByExercise = new Map<
    string,
    { kg: number | null; reps: number | null; duration_seconds: number | null; e1RM: number | null; date: string; category: ExerciseCategory }
  >();
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      const cat = categorize(e.name);
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue;
        if (s.kg !== null && s.reps !== null) {
          total += s.kg * s.reps;
        }
        setCounts[cat]++;
      }
      // Top set across this period for this exercise:
      if (exerciseFilter && !e.name.toLowerCase().includes(exerciseFilter)) continue;
      const sets: SetRow[] = (e.exercise_sets ?? []).map((s) => ({
        kg: s.kg, reps: s.reps, duration_seconds: s.duration_seconds,
        warmup: s.warmup, failure: s.failure,
      }));
      const top = topSet(sets);
      if (top) {
        const prev = bestByExercise.get(e.name);
        const beats =
          !prev ||
          (top.e1RM !== null && (prev.e1RM === null || top.e1RM > prev.e1RM)) ||
          (top.e1RM === null &&
            prev.e1RM === null &&
            ((top.kg ?? 0) > (prev.kg ?? 0) ||
              ((top.kg ?? 0) === (prev.kg ?? 0) && (top.reps ?? 0) > (prev.reps ?? 0))));
        if (beats) {
          bestByExercise.set(e.name, {
            kg: top.kg,
            reps: top.reps,
            duration_seconds: top.duration_seconds,
            e1RM: top.e1RM,
            date: w.date,
            category: cat,
          });
        }
      }
    }
  }
  const topList: WorkoutPeriodRow["top_set_per_exercise"] = [];
  for (const [name, b] of bestByExercise) {
    topList.push({
      exercise_name: name,
      category: b.category,
      kg: b.kg,
      reps: b.reps,
      duration_seconds: b.duration_seconds,
      e1RM: b.e1RM,
      date: b.date,
    });
  }
  return {
    period_start: bucketStart,
    period_end: lastDate,
    workout_count: workouts.length,
    total_volume_kg: Math.round(total),
    set_counts_by_category: setCounts,
    top_set_per_exercise: topList,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): executeQueryWorkouts — summary | sets | by_week | by_month

- summary: per-workout rows with derived total_volume_kg, working_set_count,
  hard_set_count, and top_sets_per_exercise (each with category + e1RM).
- sets: per-set rows with category + e1RM + duration_seconds; warmups always
  excluded. Caps: 60/exercise + 400 total, with truncated flag.
- by_week / by_month: per-period rollups with workout_count, total_volume_kg,
  set_counts_by_category (8 buckets including uncategorized), and top set
  per exercise across the bucket. Uncapped (one row per period).
- Volume / e1RM / counts always exclude warmups (no include_warmups flag).
- exercise_name filter applies to per-exercise listings; session-level volume
  and counts answer "how was this session" honestly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: SSE protocol additions for tool events

**Files:**
- Modify: `lib/chat/types.ts`
- Modify: `lib/chat/sse.ts`
- Modify: `components/chat/sseClient.ts`

The new event types are additive — the existing client UI doesn't consume them yet, but defining them now means the protocol is locked and the loop in Task 15 has a wire format to emit.

- [ ] **Step 1: Extend `ChatStreamEvent` in `lib/chat/types.ts`**

Replace the `ChatStreamEvent` union (last block of the file):

```ts
/** SSE event sent from server to client. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; message_id: string; partial?: boolean }
  | { type: "error"; message: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number };
```

- [ ] **Step 2: Extend `ServerStreamEvent` + `formatSseEvent` in `lib/chat/sse.ts`**

Replace the file body:

```ts
// lib/chat/sse.ts
//
// Server-side helper: format one SSE event as a string ready to write to
// a ReadableStream. Format:
//
//     event: <name>\n
//     data: <json>\n
//     \n
//
// Each event MUST end with a blank line (\n\n) — that's the frame boundary
// the client's line-buffer parser splits on.

export type ServerStreamEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { message_id: string; partial?: boolean } }
  | { event: "error"; data: { message: string } }
  | { event: "tool_call_start"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { event: "tool_call_done"; data: { id: string; ok: boolean; ms: number } };

export function formatSseEvent(e: ServerStreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
```

- [ ] **Step 3: Extend the client parser in `components/chat/sseClient.ts`**

Replace the parser body. Find the inner switch on `eventName`:

```ts
        if (eventName === "delta") {
          yield { type: "delta", text: data.text as string };
        } else if (eventName === "done") {
          yield {
            type: "done",
            message_id: data.message_id as string,
            partial: data.partial as boolean | undefined,
          };
        } else if (eventName === "error") {
          yield { type: "error", message: data.message as string };
        }
```

Replace with:

```ts
        if (eventName === "delta") {
          yield { type: "delta", text: data.text as string };
        } else if (eventName === "done") {
          yield {
            type: "done",
            message_id: data.message_id as string,
            partial: data.partial as boolean | undefined,
          };
        } else if (eventName === "error") {
          yield { type: "error", message: data.message as string };
        } else if (eventName === "tool_call_start") {
          yield {
            type: "tool_call_start",
            id: data.id as string,
            name: data.name as string,
            input: (data.input ?? {}) as Record<string, unknown>,
          };
        } else if (eventName === "tool_call_done") {
          yield {
            type: "tool_call_done",
            id: data.id as string,
            ok: data.ok as boolean,
            ms: data.ms as number,
          };
        }
```

- [ ] **Step 4: Verify the existing `ChatPanel` tolerates the new event types**

Open `components/chat/ChatPanel.tsx` and search for the `for await` loop that consumes `postSse`. Confirm the loop's switch on `ev.type` falls through cleanly when `ev.type === "tool_call_start"` or `"tool_call_done"` (no `default: throw`). If the file uses an exhaustiveness assertion, add no-op cases for the new types so the typecheck passes:

```ts
        case "tool_call_start":
        case "tool_call_done":
          // v1: ignore. UI affordance for tool-execution dead air is a follow-up.
          break;
```

If there's no exhaustive switch, no change needed. (The current file at `components/chat/ChatPanel.tsx:174-228` uses `if/else if` without a default throw; just confirm by reading it.)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/chat/types.ts lib/chat/sse.ts components/chat/sseClient.ts components/chat/ChatPanel.tsx
git commit -m "$(cat <<'EOF'
feat(chat): SSE protocol — add tool_call_start / tool_call_done events

Additive change to the SSE wire shape so the upcoming tool loop has a place
to surface tool execution start/end without breaking the existing client.
Server emits, parser reads; ChatPanel ignores them in v1 — UI affordance for
tool-execution dead air is a follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Add `@anthropic-ai/sdk` dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm install @anthropic-ai/sdk
```

Expected: dependency added under `"dependencies"` in `package.json`. Pinned version is whatever npm resolves; that's fine.

- [ ] **Step 2: Confirm**

```bash
node -e "console.log(require('@anthropic-ai/sdk/package.json').version)"
```

Expected: prints a version string, e.g. `"0.32.1"` or similar.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean. (No code uses the new dep yet.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): add @anthropic-ai/sdk

Server-only dependency for tool-aware streaming in the chat path. The hand-
rolled lib/anthropic/client.ts stays for non-chat paths (insights, weekly
review).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Tool-aware streaming wrapper

**Files:**
- Create: `lib/coach/chat-stream.ts`

This is the largest task. The wrapper handles: streaming text deltas, accumulating `tool_use` blocks via the SDK's `messageStream` API, executing tools server-side with `userId` injected, restarting the stream with `tool_result` blocks appended, capping at 5 invocations, and emitting `tool_call_start`/`tool_call_done` events for observability.

- [ ] **Step 1: Write the file**

```ts
// lib/coach/chat-stream.ts
//
// Tool-aware Anthropic streaming for the chat coach.
//
// The hand-rolled streamClaude in lib/anthropic/client.ts doesn't process
// input_json_delta events (lib/anthropic/client.ts:183 explicitly drops them),
// so it can't accumulate tool_use blocks. We use the official SDK here
// because client.messages.stream() handles delta accumulation for us via
// finalMessage().
//
// Loop invariants:
//   * After each .stream() ends, if the final message contains tool_use
//     blocks, we execute them serially (disable_parallel_tool_use: true keeps
//     this deterministic), append tool_result blocks, and re-call .stream().
//   * Cap at 5 individual tool invocations. On the 6th attempt, restart with
//     tool_choice: { type: "none" } so the model HAS to write a final text.
//   * The async generator yields delta + tool_call_start/done + done/error
//     events that map 1:1 to the SSE wire format defined in lib/chat/sse.ts.
//
// userId is injected by the caller from supabase.auth.getUser() — model
// never passes it, executors enforce .eq("user_id", userId) (security
// invariants in lib/coach/tools.ts).

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  executeQueryDailyLogs,
  executeQueryWorkouts,
  type ToolResult,
} from "@/lib/coach/tools";
import type { ToolCallLog } from "@/lib/data/types";

const MODEL = "claude-sonnet-4-5";
const MAX_TOOL_INVOCATIONS = 5;
const MAX_TOKENS = 2000;

type RichBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }
  | { type: "image"; source: { type: "url"; url: string } };

export type RichInputMessage = {
  role: "user" | "assistant";
  content: string | RichBlock[];
};

export type ChatStreamYield =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number }
  | { type: "done" }
  | { type: "error"; message: string };

export type RunChatStreamOpts = {
  userId: string;
  /** Already concatenated: SCHEMA_EXPLAINER + (user prompt or default). */
  systemPrompt: string;
  /** The full message history including cached snapshot prefix + ephemeral
   *  header + new user turn. The route assembles this. */
  messages: RichInputMessage[];
  /** AbortSignal from the request. Threaded into the SDK so cancelling
   *  closes the underlying HTTP connection. */
  signal: AbortSignal;
  /** Service-role client for tool execution. */
  sr: SupabaseClient;
  /** Mutable array; the loop pushes a ToolCallLog for each invocation so
   *  the route can persist it in its `finally` block. */
  toolCallSink: ToolCallLog[];
};

export async function* runChatStream(opts: RunChatStreamOpts): AsyncGenerator<ChatStreamYield> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const client = new Anthropic({ apiKey });
  // The SDK accepts a system prompt as a string OR typed blocks. We use the
  // typed-block form so we can attach cache_control for the prompt-cache.
  const system = [
    { type: "text" as const, text: opts.systemPrompt, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
  ];

  let invocations = 0;
  // Conversation state — we mutate this each round as the loop appends
  // assistant messages with tool_use blocks and the matching tool_result
  // user-message follow-ups.
  const messages: RichInputMessage[] = opts.messages.slice();

  while (true) {
    const forceText = invocations >= MAX_TOOL_INVOCATIONS;
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: [DAILY_LOGS_TOOL, WORKOUTS_TOOL],
        tool_choice: forceText ? { type: "none" } : { type: "auto" },
        disable_parallel_tool_use: true,
        messages: messages as Anthropic.MessageParam[],
      },
      { signal: opts.signal },
    );

    // Pipe deltas to the caller as they arrive.
    try {
      for await (const ev of stream) {
        if (opts.signal.aborted) {
          yield { type: "error", message: "aborted" };
          return;
        }
        if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta" &&
          typeof ev.delta.text === "string"
        ) {
          yield { type: "delta", text: ev.delta.text };
        }
        // Other events (input_json_delta, content_block_start, message_stop)
        // are accumulated by the SDK; we read the final assembled message
        // below via finalMessage().
      }
    } catch (e) {
      const msg = (e as Error).message ?? "stream_error";
      if ((e as Error).name === "AbortError") {
        yield { type: "error", message: "aborted" };
        return;
      }
      yield { type: "error", message: `anthropic_stream: ${msg}` };
      return;
    }

    let finalMsg: Anthropic.Message;
    try {
      finalMsg = await stream.finalMessage();
    } catch (e) {
      yield { type: "error", message: `anthropic_finalize: ${(e as Error).message}` };
      return;
    }

    // Identify any tool_use blocks the model emitted in this round.
    const toolUseBlocks = finalMsg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // No tool calls → we're done.
    if (toolUseBlocks.length === 0 || forceText) {
      yield { type: "done" };
      return;
    }

    // Append the assistant message verbatim (it has both text and tool_use
    // blocks) — required so subsequent rounds reference the right tool_use_id.
    messages.push({
      role: "assistant",
      content: finalMsg.content as unknown as RichBlock[],
    });

    // Execute each tool_use block serially. disable_parallel_tool_use is
    // already set, so this loop sees at most one block per round in practice.
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      invocations++;
      yield {
        type: "tool_call_start",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };

      const t0 = Date.now();
      let result: ToolResult<unknown>;
      try {
        if (block.name === "query_daily_logs") {
          result = await executeQueryDailyLogs({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "query_workouts") {
          result = await executeQueryWorkouts({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else {
          result = {
            ok: false,
            error: { error: `unknown_tool: ${block.name}` },
            meta: { ms: Date.now() - t0, range_days: 0 },
          };
        }
      } catch (e) {
        result = {
          ok: false,
          error: { error: `executor_threw: ${(e as Error).message}` },
          meta: { ms: Date.now() - t0, range_days: 0 },
        };
      }
      const elapsed = Date.now() - t0;

      // Persist into the sink so the route's finally block writes it.
      opts.toolCallSink.push({
        name: block.name as ToolCallLog["name"],
        input: (block.input ?? {}) as Record<string, unknown>,
        ms: elapsed,
        result_rows: result.ok ? result.meta.result_rows : 0,
        range_days: result.meta.range_days,
        truncated: result.ok ? result.meta.truncated : false,
        error: result.ok ? null : result.error.error,
      });

      yield { type: "tool_call_done", id: block.id, ok: result.ok, ms: elapsed };

      // Convert to tool_result block for the next round.
      const content = result.ok ? result.data : result.error;
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(content),
        is_error: !result.ok,
      });
    }

    // Append all tool_results as a single user message — Anthropic requires
    // them in one user turn between assistant tool_use and the next assistant
    // turn.
    messages.push({
      role: "user",
      content: toolResultBlocks as unknown as RichBlock[],
    });
    // Loop back; next stream() call will see the tool_result and either
    // call another tool or emit the final text.
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean. The `Anthropic.MessageParam` / `Anthropic.ToolResultBlockParam` types come from the SDK; if any compile error mentions them, double-check the SDK version's type exports and adjust import paths (a quick search of `node_modules/@anthropic-ai/sdk/resources/messages.d.ts` is the fastest fix).

- [ ] **Step 3: Commit (no manual run yet — wired into the route in Task 16)**

```bash
git add lib/coach/chat-stream.ts
git commit -m "$(cat <<'EOF'
feat(coach): chat-stream — tool-aware streaming wrapper

runChatStream wraps @anthropic-ai/sdk's client.messages.stream with a serial
tool loop:

  - Yields delta events as text streams in (matches existing SSE shape).
  - On tool_use: executes via executeQueryDailyLogs / executeQueryWorkouts
    with userId injected from session, builds tool_result block, restarts
    the stream with the tool_result appended.
  - Caps at 5 invocations per turn; on the 6th, restarts with
    tool_choice: { type: "none" } to force a final text response.
  - disable_parallel_tool_use keeps the loop deterministic.
  - Pushes ToolCallLog entries into a caller-supplied sink so the route's
    finally block can persist on success / error / abort alike.
  - tool_call_start / tool_call_done events are emitted for observability;
    UI affordance for tool dead-air is a follow-up.

Hand-rolled streamClaude unchanged (still used by insights / weekly review).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Wire `runChatStream` into the chat route + persist `tool_calls` in finally

**Files:**
- Modify: `app/api/chat/messages/route.ts`

- [ ] **Step 1: Replace the `streamClaude` call with `runChatStream`, sink tool calls, persist them**

In `app/api/chat/messages/route.ts`:

1. Add import:

```ts
import { runChatStream } from "@/lib/coach/chat-stream";
import type { ToolCallLog } from "@/lib/data/types";
import { formatSseEvent } from "@/lib/chat/sse"; // already imported
```

2. Drop the `streamClaude` import if no longer used in this file:

```ts
// Before:
import { streamClaude, type RichMessage, type ContentBlock } from "@/lib/anthropic/client";
// After:
import { type RichMessage, type ContentBlock } from "@/lib/anthropic/client";
```

(Keep `RichMessage` and `ContentBlock` — the route still uses them to assemble the message array.)

3. Inside the `start(controller)` IIFE, replace the existing `for await (const ev of streamClaude(...))` loop block. Find this section:

```ts
      try {
        for await (const ev of streamClaude(messages, {
          model: MODEL,
          system: [
            { type: "text", text: finalSystemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
          maxTokens: 2000,
          signal: req.signal,
        })) {
          if (req.signal.aborted) {
            aborted = true;
            break;
          }
          if (ev.type === "delta") {
            accumulated += ev.text;
            controller.enqueue(
              encoder.encode(formatSseEvent({ event: "delta", data: { text: ev.text } })),
            );
          } else if (ev.type === "error") {
            errored = ev.message;
            break;
          } else if (ev.type === "done") {
            // handled below
          }
        }
      } catch (e) {
        errored = (e as Error).message;
      } finally {
```

Replace with:

```ts
      const toolCallSink: ToolCallLog[] = [];
      try {
        for await (const ev of runChatStream({
          userId: user.id,
          systemPrompt: finalSystemPrompt,
          messages: messages as unknown as Parameters<typeof runChatStream>[0]["messages"],
          signal: req.signal,
          sr,
          toolCallSink,
        })) {
          if (req.signal.aborted) {
            aborted = true;
            break;
          }
          if (ev.type === "delta") {
            accumulated += ev.text;
            controller.enqueue(
              encoder.encode(formatSseEvent({ event: "delta", data: { text: ev.text } })),
            );
          } else if (ev.type === "tool_call_start") {
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "tool_call_start",
                  data: { id: ev.id, name: ev.name, input: ev.input },
                }),
              ),
            );
          } else if (ev.type === "tool_call_done") {
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "tool_call_done",
                  data: { id: ev.id, ok: ev.ok, ms: ev.ms },
                }),
              ),
            );
          } else if (ev.type === "error") {
            errored = ev.message;
            break;
          } else if (ev.type === "done") {
            // handled below
          }
        }
      } catch (e) {
        errored = (e as Error).message;
      } finally {
```

4. Update the `finally` block's UPDATE call to also persist `tool_calls`. Find:

```ts
        // Persist the final state of the assistant stub.
        const finalStatus = errored ? "error" : "done";
        await sr
          .from("chat_messages")
          .update({
            content: accumulated,
            status: finalStatus,
            error: errored,
            updated_at: new Date().toISOString(),
          })
          .eq("id", assistantId);
```

Replace with:

```ts
        // Persist the final state of the assistant stub. tool_calls is set
        // even on error/abort paths so we keep the diagnostic record.
        const finalStatus = errored ? "error" : "done";
        await sr
          .from("chat_messages")
          .update({
            content: accumulated,
            status: finalStatus,
            error: errored,
            tool_calls: toolCallSink.length > 0 ? toolCallSink : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", assistantId);
```

5. Update the structured `console.log` line to include tool-call metrics:

```ts
        // Structured log line for observability.
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            evt: "chat_turn",
            user_id: user.id,
            window: windowAsc.length,
            images: imageIds.length,
            status: aborted ? "aborted" : finalStatus,
            tool_calls: toolCallSink.length,
            tool_errors: toolCallSink.filter((c) => c.error !== null).length,
            latency_ms: Date.now() - startedAt,
          }),
        );
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Manual verification — happy path**

1. `npm run dev`
2. Open `/coach`. Send: "What was my hrv 30 days ago?"
3. Confirm the model's reply cites a concrete number — not "around" / "roughly".
4. Run in Supabase Dashboard SQL Editor:
   ```sql
   select id, role, status, tool_calls, length(content) as len
   from public.chat_messages
   where user_id = auth.uid()
   order by created_at desc
   limit 4;
   ```
   Expected: the most recent assistant row has `tool_calls` populated, e.g.:
   ```jsonb
   [
     {
       "name": "query_daily_logs",
       "input": { "start_date": "2026-04-06", "end_date": "2026-04-06" },
       "ms": 38,
       "result_rows": 1,
       "range_days": 1,
       "truncated": false,
       "error": null
     }
   ]
   ```

- [ ] **Step 4: Manual verification — error path**

1. Send: "Pull every set of bench press from the last 5 years."
2. Expected model behavior: tool returns an error (range too large in raw mode for daily_logs OR, for workouts, summary mode hits the 90-cap → truncated). The model retries with `by_month` or narrows the range. The final reply mentions truncation honestly.
3. Verify `tool_calls` jsonb has at least two entries — the first with `error` non-null or `truncated: true`, the second adapted.

- [ ] **Step 5: Manual verification — abort path**

1. Send a long-form question that takes multiple seconds to stream.
2. Click the Stop button (or otherwise abort the fetch).
3. Re-run the SQL query above. Expected: the abandoned assistant row has `status: error` and `tool_calls` populated up through the last attempted call (not lost despite the abort).

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "$(cat <<'EOF'
feat(chat): wire runChatStream into route, persist tool_calls in finally

The chat path now uses runChatStream (tool-aware) instead of streamClaude.
Tool invocations stream as new SSE events (tool_call_start / tool_call_done)
that the client UI ignores in v1; a sink array threads ToolCallLog entries
into the existing finally block so the diagnostic record is preserved on
success / error / abort paths alike.

Structured log line now reports tool_calls and tool_errors counts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Final manual verification pass against the spec's testing strategy

**Files:** None (verification only).

Walk the full 20-item checklist from the spec [docs/superpowers/specs/2026-05-06-coach-chat-precision-context-design.md "Testing strategy"](../specs/2026-05-06-coach-chat-precision-context-design.md). For any item that fails, file follow-up tasks; do not bend the spec.

- [ ] **Step 1: Migration** — already verified in Task 1.

- [ ] **Step 2: Settings round-trip — happy path** — already verified in Task 6.

- [ ] **Step 3: Settings round-trip — Restore Default** — already verified in Task 6.

- [ ] **Step 4: Settings round-trip — line-ending drift**

In a JS console at `/profile`:

```js
const ta = document.querySelector('textarea[name="system_prompt"]');
ta.value = ta.value.replace(/\n/g, '\r\n');
// then click Save
```

Run:
```sql
select system_prompt from public.profiles where user_id = auth.uid();
```
Expected: NULL (normalisation neutralised the \r\n drift).

- [ ] **Step 5: No profile row**

In Supabase SQL Editor:
```sql
delete from public.profiles where user_id = auth.uid();
```
Reload `/profile`. Expected: form renders with default in the textarea, no error. Save. Re-query — expected: a row exists with `system_prompt = NULL`.

- [ ] **Step 6: Snapshot + ephemeral header** — already exercised in Task 8.

- [ ] **Step 7: query_daily_logs raw fire** — already verified in Task 16 step 3.

- [ ] **Step 8: query_daily_logs aggregate with sparse data**

Send: "What's my average protein over the last 30 days?"

Inspect the assistant message's `tool_calls`:
```sql
select tool_calls from public.chat_messages
where user_id = auth.uid() and role = 'assistant'
order by created_at desc limit 1;
```
Expected: `aggregate: "avg"`. Reply mentions sparse coverage if any day was missing — e.g. "average over 22 of the 30 days you tracked".

- [ ] **Step 9: query_workouts summary**

Send: "How many lifts did I do last month?"

Expected: tool called with `granularity: "summary"` (default). Reply gives an exact count.

- [ ] **Step 10: query_workouts sets**

Send: "Show me my last five bench sets."

Expected: tool called with `granularity: "sets"` and `exercise_name: "bench"`. Each set in the reply has explicit kg×reps and the original exercise name (e.g. "Barbell Bench Press" not "bench press").

- [ ] **Step 11: query_workouts by_week**

Send: "Show me my weekly volume for the last 3 months."

Expected: tool called with `granularity: "by_week"`. Reply lists per-week volume + per-category set counts.

- [ ] **Step 12: query_workouts duration-based**

If you log planks/carries/holds, send: "What's my plank progression?"

Expected: response shows `duration_seconds` populated, `kg/reps/e1RM` null. Model reads the duration and reasons about progression.

- [ ] **Step 13: Range cap enforcement**

In a chat, send a question that would require >90 days of raw daily_logs (e.g. "List my hrv every day for the last year"). Expected: tool first call returns `is_error: true` (range cap), the model adapts (retries with `aggregate` or narrower), and the reply makes sense without a turn-level abort.

- [ ] **Step 14: 5-invocation cap**

Send a multi-pivot question that could chain many lookups (e.g. "Compare bench, squat, deadlift, OHP, and row top sets across each of the last 4 weeks."). Expected: at most 5 entries in `tool_calls`; the final reply may be slightly less detailed than ideal but is generated.

- [ ] **Step 15: Tool-error recovery**

Temporarily monkey-patch `executeQueryDailyLogs` to throw at the top:

```ts
export async function executeQueryDailyLogs(...) {
  throw new Error("temp_test");
  // ... existing body
}
```

Send a chat that uses it. Expected: SSE does NOT emit `error`; the assistant emits some recovery text. `tool_calls` records the attempt with `error: "executor_threw: temp_test"`. Revert the monkey-patch before committing anything.

- [ ] **Step 16: Persistence on abort** — already verified in Task 16 step 5.

- [ ] **Step 17: Cache hit on second turn**

Add a temporary log line in `app/api/chat/messages/route.ts` that captures the `usage` object returned with the assistant message — easiest way: log inside `runChatStream` after `stream.finalMessage()`:

```ts
console.log("[anthropic usage]", finalMsg.usage);
```

Send two short turns within ~30 seconds. On the second, expected `usage.cache_read_input_tokens > 0` for the system block (and ideally the snapshot prefix). Remove the temp log after spot-check.

- [ ] **Step 18: Security invariants**

Open the browser devtools, find a recent chat POST request, copy the JSON body. Construct a malicious crafted body — but the model is what makes tool calls, not the user, so the actual security test is: confirm `executeQueryDailyLogs` and `executeQueryWorkouts` reject any input that includes a `user_id` field (the schemas don't even define it; validators ignore extra fields). Spot-check by sending a chat where the model would naturally try to call a tool, and confirm the SQL it ends up running is `.eq("user_id", $session_uid)` — easiest verification: add a temp log inside the executors:

```ts
console.log(`[exec] user_id=${opts.userId}`);
```

Send a chat. Confirm the logged userId equals your session UID, not anything from the input. Remove the temp log.

- [ ] **Step 19: No-approximation regression**

Pick 10 questions where the answer is queryable. Examples:
1. "Avg HRV last week."
2. "Last week's total volume."
3. "Heaviest squat ever."
4. "Sleep score 14 days ago."
5. "Steps yesterday."
6. "How many push sessions in April?"
7. "Bench top set last Wednesday."
8. "Calories yesterday."
9. "Body fat % trend the last 30 days."
10. "How many times did I fail bench reps in the last month?"

Send each. Grep replies for "around", "roughly", "about", "approximately". Expected: zero hits where the answer was queryable.

- [ ] **Step 20: Observability**

Run:
```sql
select tool_calls
from public.chat_messages
where role = 'assistant' and tool_calls is not null
order by created_at desc limit 20;
```

Confirm a healthy distribution of tool names + the diagnostic fields (`truncated`, `range_days`, `error`) are populated as expected.

- [ ] **Step 21: Final sweep + summary commit**

If everything passed, this task makes no code changes. If any item failed and you fixed it inline, commit the fix with a clear message referencing the test step that caught it.

```bash
# If no fixes needed:
git log --oneline -20  # confirm the feature's commit history is clean
# Otherwise:
# git add ...
# git commit -m "fix(coach): <issue caught in test step N>"
```

---

## Self-review checklist (run after Task 17)

Walk the spec [§ Components 1–6, § Data flow, § Schema migration, § Files affected, § Testing strategy] against this plan. For each requirement:

- Editable system prompt with full-replace + Restore Default + NULL-when-default → **Tasks 3, 4, 6** ✓
- Cached prefix unchanged → **Task 8** preserves existing `buildSnapshotText` ✓
- Per-turn ephemeral header (today + yesterday + freshness with hours-ago precision) → **Tasks 7, 8** ✓
- `query_daily_logs` with allowlist + aggregate + non_null/null counts → **Task 11** ✓
- `query_workouts` with summary/sets/by_week/by_month + caps + truncation hints → **Task 12** ✓
- Server-side derived fields (Epley with reps≤12 cap, top_set, working_volume, hard_set_count) → **Task 9** ✓
- 7-bucket category lookup with normalize() preserving original name in responses → **Task 10** ✓
- Tool error surfacing as is_error tool_result, not SSE error → **Tasks 11, 12, 15** ✓
- Security invariants (no user_id in input, .eq enforced, allowlist before query, date parse+reformat) → **Task 11** validators + reused in Task 12 ✓
- Cache breakpoint #1 (system) + #2 (snapshot prefix) → already in route from prior work; **Task 8** preserves the existing `cache_control` markers ✓
- Tool loop with 5-invocation cap, disable_parallel_tool_use, force-text fallback → **Task 15** ✓
- SSE additions tool_call_start / tool_call_done → **Task 13** ✓
- Persist `tool_calls` in finally block (success/error/abort) → **Task 16** ✓
- Schema migration via Dashboard → **Task 1** ✓
- Test scenarios 1–20 → **Task 17** ✓

If any row above flips to ✗, fix the plan inline before handing off.

---

## End

Plan complete. The next step is to invoke superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to start running the tasks.
