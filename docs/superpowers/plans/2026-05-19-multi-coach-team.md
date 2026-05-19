# Multi-coach Team Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the single coach AI into a 4-coach team — Peter (Head Coach, default chat agent + router), Coach Carter (Strength), Nora (Nutrition), Remi (Recovery/Sleep). Peter delegates to specialists via a `delegate_to_specialist` tool; specialists run with restricted tool subsets and their own voice. Cross-domain surfaces (morning brief, weekly review, proactive nudges, trends) stay narrated by Peter with specialist chip attribution.

**Architecture:** All existing deterministic composers (`plan-builder/`, `weekly-review/`, `trends/`, `proactive/`) stay unchanged — they produce per-domain structured payloads. The change is in the AI-narrator layer (now four prompts instead of one) and the chat stream orchestrator (now intercepts `delegate_to_specialist` tool calls and pipes a fresh specialist stream back to the client). Tools get partitioned by speaker + intersected with mode. New `chat_messages.speaker` column tracks who authored each message; new `'system_routing'` kind hides routing-audit rows from the chat UI.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + RLS), TanStack Query (existing pattern), Anthropic SDK (`callClaude` + `streamClaude` — no new SDK calls). Tailwind v4. No new external integrations. No new env vars. No test framework in this project — verification uses `npm run typecheck` + manual chat exercise via `npm run dev` + audit script.

**Spec:** [docs/superpowers/specs/2026-05-19-multi-coach-team-design.md](../specs/2026-05-19-multi-coach-team-design.md). Note: the spec text references migration 0020 for `chat_messages.speaker`; that number was taken by `food_log_meal_slot`. This plan uses **0024** (after PR #94's 0023 merges) — if PR #94 hasn't merged when implementation starts, downshift to 0023 and renumber PR #94. Pre-flight will check.

---

## Pre-flight

- [ ] **Pre-flight 1: Create feature branch off latest main**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/coach-team
```

- [ ] **Pre-flight 2: Verify clean baseline**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Pre-flight 3: Confirm migration number is available**

```bash
ls supabase/migrations/ | tail -3
```

Expected: latest is `0023_food_log_favorites_and_library.sql` (after PR #94 merges) or `0022_exercise_overrides.sql` (if PR #94 hasn't merged). The migration this plan creates is **0024**. If 0024 is already taken on `main`, bump to 0025 and find/replace `0024` → `0025` across the entire plan before continuing.

---

## File Structure

**New files (5):**

```
supabase/migrations/0024_coach_team.sql
lib/coach/speakers.ts                — Speaker type, colors, display names, lookup helpers
lib/coach/delegate-tool.ts           — DELEGATE_TOOL schema (Peter-only)
components/chat/SpeakerChip.tsx
components/chat/HandoffLine.tsx
scripts/audit-speaker-routing.mjs
```

**Modified files (10):**

```
lib/coach/system-prompts.ts          — replace DEFAULT_SYSTEM_PROMPT with PETER_BASE + CARTER_BASE + NORA_BASE + REMI_BASE
lib/coach/tools.ts                   — partition into PETER_TOOLS / CARTER_TOOLS / NORA_TOOLS / REMI_TOOLS + column-restricted DAILY_LOGS wrappers + executeQueryDailyLogs accepts allowedColumns
lib/coach/chat-stream.ts             — intercept delegate_to_specialist tool call, spawn specialist stream, pipe to client
app/api/chat/messages/route.ts       — emit handoff SSE event, persist speaker column, persist hidden system_routing rows
lib/data/types.ts                    — Speaker type, ChatMessage.speaker field, StreamEvent.handoff variant, ChatMessageKind union extended
components/chat/ChatThread.tsx       — render SpeakerChip per assistant message + HandoffLine on speaker change
lib/ui/theme.ts                      — speaker color tokens (peter/carter/nora/remi)
components/morning/MorningBriefCard.tsx        — small specialist chip per data block (recovery=Remi, nutrition=Nora, training=Carter)
components/coach/WeekReviewBanner.tsx OR weekly review page — specialist chip attribution on §3 trends rows + §6 prescription cells
components/chat/ProactiveNudgeCard.tsx         — speaker chip in header (plateau=Carter, off-pace=Nora, hrv=Remi)
CLAUDE.md                            — migration 0024 entry + Multi-coach team sub-section
```

---

## Task 1: Migration 0024 — chat_messages.speaker + system_routing kind

**Files:**
- Create: `supabase/migrations/0024_coach_team.sql`

- [ ] **Step 1.1: Write the migration**

Create `supabase/migrations/0024_coach_team.sql`:

```sql
-- 0024_coach_team.sql
--
-- Multi-coach team architecture (sub-project #2 of coach-team arc). Adds:
--   - chat_messages.speaker: who authored the message
--     ('peter', 'carter', 'nora', 'remi', 'user')
--   - chat_messages.kind extended with 'system_routing' (hidden audit rows
--     capturing Peter's routing decision before he delegated to a specialist)
--   - Backfills existing rows: role='user' → speaker='user'; everything else
--     → speaker='peter' (the previous single coach becomes structurally the
--     Head Coach).
--
-- See CLAUDE.md "Coach / AI" section after this migration applies.

-- ── speaker column ────────────────────────────────────────────────────────
alter table chat_messages
  add column speaker text not null default 'peter'
  check (speaker in ('peter', 'carter', 'nora', 'remi', 'user'));

-- Backfill: user messages get 'user'; everything else stays 'peter' (default).
update chat_messages
  set speaker = 'user'
  where role = 'user';

-- ── Extend kind allowlist with 'system_routing' ──────────────────────────
alter table chat_messages
  drop constraint if exists chat_messages_kind_check;
alter table chat_messages
  add constraint chat_messages_kind_check check (
    kind in (
      'coach',
      'morning_intake',
      'morning_brief',
      'weekly_review',
      'proactive_nudge',
      'system_routing'
    )
  );

-- ── Index for filtering visible chat history (excludes system_routing) ──
-- Used by the chat history loader. Partial index since system_routing rows
-- are << visible rows; full index would waste space.
create index chat_messages_visible_idx
  on chat_messages (user_id, created_at desc)
  where kind != 'system_routing';
```

- [ ] **Step 1.2: Apply via Supabase CLI**

```bash
supabase db push
```

Expected: `Applying migration 0024_coach_team.sql...` exits 0.

- [ ] **Step 1.3: Verify schema**

Run via Supabase Dashboard SQL Editor (or service-role probe):

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'chat_messages' and column_name = 'speaker';
```

Expected: `speaker | text | NO | 'peter'::text`.

```sql
select count(*) from chat_messages where speaker = 'peter';  -- existing assistant rows
select count(*) from chat_messages where speaker = 'user';   -- existing user rows
```

Both should match prior `role` counts.

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/0024_coach_team.sql
git commit -m "feat(coach-team): migration 0024 — speaker column + system_routing kind"
```

---

## Task 2: TypeScript types

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 2.1: Add Speaker types + extend ChatMessage**

In `lib/data/types.ts`, locate the section where chat types live (search for `ChatMessage` or `chat_messages` references). Add:

```ts
export const SPEAKERS = ["peter", "carter", "nora", "remi"] as const;
export type Speaker = (typeof SPEAKERS)[number];

/** Speaker as it can appear in chat_messages.speaker — includes 'user'. */
export type ChatSpeaker = Speaker | "user";
```

Find the `ChatMessage` type. Add `speaker: ChatSpeaker;` (between role and kind, or wherever it fits the existing layout).

Find the `ChatMessageKind` union (or wherever `kind` values are typed). Extend with `"system_routing"`. If it's typed as a string literal union like:

```ts
type ChatMessageKind = "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge";
```

Change to:

```ts
type ChatMessageKind = "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge" | "system_routing";
```

- [ ] **Step 2.2: Add StreamEvent.handoff variant**

Locate the chat-stream SSE event type. It probably lives in `lib/chat/types.ts` or `lib/anthropic/client.ts`. Find the existing `StreamEvent` union:

```ts
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };
```

Extend with the handoff variant:

```ts
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "handoff"; from: Speaker; to: Speaker; briefing: string | null };
```

Import `Speaker` from `@/lib/data/types` at the top of the file.

- [ ] **Step 2.3: Typecheck**

```bash
npm run typecheck
```

Expected: exits 0. If a downstream consumer breaks (e.g., an exhaustive switch on `StreamEvent.type` that doesn't handle `'handoff'`), add a passthrough branch — those will be properly wired in Task 7. For now, `default: break;` is fine.

- [ ] **Step 2.4: Commit**

```bash
git add lib/data/types.ts lib/chat/types.ts lib/anthropic/client.ts
# Add whichever files actually changed.
git commit -m "feat(coach-team): types — Speaker, ChatMessage.speaker, StreamEvent.handoff, system_routing kind"
```

---

## Task 3: lib/coach/speakers.ts — Speaker registry

**Files:**
- Create: `lib/coach/speakers.ts`

- [ ] **Step 3.1: Write the registry**

Create `lib/coach/speakers.ts`:

```ts
// lib/coach/speakers.ts
//
// Speaker registry: display names, colors, system-prompt + tool-list lookups.
// One source of truth for the 4-coach team. Importers should never inline
// speaker-related literals.

import type { Speaker, ChatSpeaker } from "@/lib/data/types";

export const SPEAKER_DISPLAY: Record<Speaker, { name: string; role: string }> = {
  peter:  { name: "Peter",         role: "Head Coach" },
  carter: { name: "Coach Carter",  role: "Strength" },
  nora:   { name: "Nora",          role: "Nutrition" },
  remi:   { name: "Remi",          role: "Recovery" },
};

/** Background + text + border colors for the speaker chip rendered next to
 *  each assistant message. Picked to read on the dark theme. */
export const SPEAKER_COLOR: Record<Speaker, { bg: string; fg: string; border: string }> = {
  peter:  { bg: "bg-zinc-800",  fg: "text-zinc-100",   border: "border-zinc-600" },
  carter: { bg: "bg-red-950",   fg: "text-red-200",    border: "border-red-700" },
  nora:   { bg: "bg-emerald-950", fg: "text-emerald-200", border: "border-emerald-700" },
  remi:   { bg: "bg-cyan-950",  fg: "text-cyan-200",   border: "border-cyan-700" },
};

/** Display label for a speaker — e.g., "Peter · Head Coach". */
export function speakerLabel(s: Speaker): string {
  const d = SPEAKER_DISPLAY[s];
  return `${d.name} · ${d.role}`;
}

/** Short label (just the name). */
export function speakerName(s: Speaker): string {
  return SPEAKER_DISPLAY[s].name;
}

/** True when the speaker is one of the assistant coaches (vs the user). */
export function isCoachSpeaker(s: ChatSpeaker): s is Speaker {
  return s !== "user";
}
```

- [ ] **Step 3.2: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/speakers.ts
git commit -m "feat(coach-team): lib/coach/speakers.ts — Speaker registry (names, colors, helpers)"
```

---

## Task 4: lib/coach/system-prompts.ts — four coach prompts

**Files:**
- Modify: `lib/coach/system-prompts.ts`

- [ ] **Step 4.1: Read the existing file**

Read `lib/coach/system-prompts.ts` end-to-end. It currently exports `DEFAULT_SYSTEM_PROMPT` and `SCHEMA_EXPLAINER` and `normalizePromptForCompare()`. The replacement keeps `SCHEMA_EXPLAINER` and `normalizePromptForCompare()` unchanged, replaces `DEFAULT_SYSTEM_PROMPT` with four `*_BASE` prompts, and adds a lookup helper.

- [ ] **Step 4.2: Replace DEFAULT_SYSTEM_PROMPT with 4 prompts**

Replace the entire `DEFAULT_SYSTEM_PROMPT` export with this block (paste BEFORE the existing `SCHEMA_EXPLAINER` export):

```ts
// lib/coach/system-prompts.ts — multi-coach team (sub-project #2)
//
// Four coach voices. PETER is the default chat agent and the only one with
// access to delegate_to_specialist. CARTER / NORA / REMI run with restricted
// tool subsets when delegated to. Cross-domain surfaces (morning brief
// advice block, weekly review narrative, plan-builder narrative) are voiced
// by PETER.
//
// User customization: profiles.system_prompt is interpreted as PETER's
// override. The three specialists stay code-defined for v1.

import type { Speaker } from "@/lib/data/types";

// ── Peter — Head Coach ────────────────────────────────────────────────────
export const PETER_BASE = `You are Peter, the Head Coach. You lead a team of three specialists — Coach Carter (strength training), Nora (nutrition), Remi (recovery and sleep) — and you're the athlete's primary point of contact in this chat.

Your job is twofold:
1. ANSWER cross-domain questions yourself — questions about how the athlete is progressing overall, block-level strategy, goal alignment, "should I push hard today?", "how is my mesocycle going?", weekly review interpretation. You hold the holistic picture.
2. DELEGATE clearly-in-domain questions to the right specialist via the delegate_to_specialist tool — strength programming → Carter; food/macros/portion → Nora; HRV/sleep/recovery → Remi.

When delegating, do so as your FIRST move in the turn. Don't preamble before the tool call — the athlete doesn't see your pre-delegation tokens (they're discarded by the orchestrator). The orchestrator will swap to the specialist and pipe their answer back to the athlete.

When answering directly:
- Speak in concrete numbers (kg, reps, hours, %, kcal, ms) and cite specific dates from the snapshot or query results. Never approximate when a value is queryable: if you don't have the data, call query_daily_logs or query_workouts or query_food_log before answering.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- Don't restate data the athlete just gave you.
- Don't pad with disclaimers.
- When citing the athlete's plan, reference plan_payload from the snapshot prefix.

For block-level decisions (progressing to next mesocycle, deload timing, goal shifts), you own them. Call propose_block / commit_block when proposing block-level changes. For within-week training plan tactics, defer to Carter — when in doubt about whether a question is block-level or week-level, delegate to Carter and let them defer back if it's bigger than their scope.

If the user signals a GLP-1 mode transition or asks about morning brief regeneration, handle it yourself (don't delegate) — those tools (set_glp1_*, regenerate_morning_brief) are yours.

Existing voice + numeric-citation rules from the original Coach Carter prompt apply: concrete numbers always, dates always, no approximations on queryable values.`;

// ── Coach Carter — Strength specialist ────────────────────────────────────
export const CARTER_BASE = `You are Coach Carter, the strength training specialist on Peter's team. Peter is the Head Coach; he routes strength questions to you. You own within-week training execution: exercise programming, RPE/RIR judgment, autoregulation, exercise selection given equipment + injury constraints, mobility recommendations.

Your scope is the next session, the next week's training plan, and the technical details of strength training. Peter owns block-level decisions and cross-domain synthesis.

When you answer:
- Speak in concrete numbers (kg, reps, sets, RPE, %1RM) and cite specific dates from query results.
- Use query_workouts liberally to ground your advice in the athlete's actual lift history. Don't approximate when a value is queryable.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- When proposing a week plan, use propose_week / commit_week tools.

You can read recovery-relevant columns on daily_logs (recovery, strain, sleep_hours, sleep_score) for autoregulation, but you do NOT have access to nutrition data (query_food_log, the nutrition columns on daily_logs) or body composition. If the athlete's question requires that data — e.g., "should I cut harder this week?" — say so in your reply and recommend they ask Peter, who can pull cross-domain context.

Your voice: direct, technical, no fluff. Numbers, not vibes. You're the specialist they go to when they want a real strength-training answer.`;

// ── Nora — Nutrition specialist ───────────────────────────────────────────
export const NORA_BASE = `You are Nora, the nutrition specialist on Peter's team. Peter is the Head Coach; he routes nutrition questions to you. You own day-to-day food choices, macro distribution, hydration, GLP-1 phase awareness, micronutrient gaps, and portion calibration.

Your scope is the athlete's eating: what they're eating, how much, when, and how it lines up with their current plan's macro targets. Peter owns the macro-level plan strategy (calorie target deltas across blocks, plan-builder decisions).

When you answer:
- Speak in concrete grams, kcal, ratios. Cite specific dates and meals from query_food_log results.
- Use query_food_log to ground advice in actual item-level food data — names of foods, portions, frequency, meal slots. Don't approximate when item-level data is queryable.
- When the athlete is in a GLP-1 mode (active / tapering / discontinued), apply the mode-specific protein floor and hydration targets the plan specifies. If a transition signal appears (started taper, discontinued), call set_glp1_taper_started or mark_glp1_discontinued — those are routed through Peter normally, but if the user mentions it to you directly, surface it in your reply ("you should let Peter know about the taper start").
- Reply concisely (2-5 sentences for normal questions; longer for analysis).

You can read the athlete's body composition (weight_kg, body_fat_pct, fat_free_mass_kg) for context — protein-per-LBM is your bread and butter. You do NOT have access to query_workouts or full daily_logs. If a question requires training context — "should I eat more on heavy days?" — defer to Peter for cross-domain framing.

Your voice: warm but technical. You care about the athlete's relationship with food; you also care about the numbers. Both matter.`;

// ── Remi — Recovery / Sleep specialist ────────────────────────────────────
export const REMI_BASE = `You are Remi, the recovery and sleep specialist on Peter's team. Peter is the Head Coach; he routes recovery, sleep, and HRV questions to you. You own day-to-day recovery interpretation: HRV trends vs personal baseline, sleep architecture, training stress vs recovery balance, illness flags, mobility prescription.

Your scope is the athlete's recovery state — what HRV / sleep / strain say about today and the last few days. Peter owns the strategic balance of stress and recovery across blocks.

When you answer:
- Speak in concrete numbers (HRV ms, recovery %, sleep hours, sleep score, strain). Cite specific dates from query_daily_logs results.
- Use the athlete's WHOOP baselines (in the snapshot) to interpret today's numbers — HRV "low" only makes sense relative to their personal 30-day baseline.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- For mobility completion signals ("done with my stretches"), call mark_mobility_done.

You can read recovery + sleep columns on daily_logs (hrv, resting_hr, recovery, sleep_*, deep_sleep_hours, rem_sleep_hours, spo2, skin_temp_c, respiratory_rate, strain). You do NOT have access to query_workouts (you read training stress via the strain column on daily_logs) or nutrition or body composition data. If a question requires that data — "is my low HRV because I'm not eating enough?" — defer to Peter for cross-domain framing.

Your voice: calm, observational. You're the team's pulse-check. You notice patterns before they become problems.`;

/** Speaker → system-prompt-base lookup. */
export function speakerSystemPrompt(speaker: Speaker): string {
  switch (speaker) {
    case "peter":  return PETER_BASE;
    case "carter": return CARTER_BASE;
    case "nora":   return NORA_BASE;
    case "remi":   return REMI_BASE;
  }
}

/** Back-compat — old DEFAULT_SYSTEM_PROMPT consumers point to PETER_BASE. */
export const DEFAULT_SYSTEM_PROMPT = PETER_BASE;
```

The existing `SCHEMA_EXPLAINER` export and `normalizePromptForCompare()` function stay in place — they were below `DEFAULT_SYSTEM_PROMPT` in the original file. Keep them.

- [ ] **Step 4.3: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/system-prompts.ts
git commit -m "feat(coach-team): system-prompts.ts — PETER/CARTER/NORA/REMI base prompts"
```

---

## Task 5: lib/coach/delegate-tool.ts — delegate_to_specialist schema

**Files:**
- Create: `lib/coach/delegate-tool.ts`

- [ ] **Step 5.1: Write the tool schema**

Create `lib/coach/delegate-tool.ts`:

```ts
// lib/coach/delegate-tool.ts
//
// DELEGATE_TOOL — Peter-only. Routes a question to a specialist coach.
// The orchestrator in lib/coach/chat-stream.ts INTERCEPTS this tool call
// (rather than executing it and feeding a tool_result back to Peter). It
// emits a 'handoff' SSE event, opens a fresh specialist stream with the
// specialist's system prompt + restricted tools, and pipes that stream
// back to the client.
//
// Why intercept rather than execute? Because Peter has no value to add
// after he's identified the right specialist — the specialist is the one
// who should answer. Two roundtrips (Peter → tool → Peter → text) would
// waste tokens and add latency for zero benefit.

export const DELEGATE_TOOL = {
  name: "delegate_to_specialist",
  description: `Route this question to a specialist coach with deeper domain expertise. Use when the user's question is clearly within one specialist's lane:
  - 'carter' for strength training, exercise programming, RPE/RIR, autoregulation, within-week training plan, mobility execution
  - 'nora' for food choices, macros, portion sizes, hydration, GLP-1 phase questions, micronutrient gaps
  - 'remi' for HRV interpretation, sleep quality, recovery interpretation, illness flags
For cross-domain questions ("should I push hard today?", "how is my block going?"), strategic block-level decisions, weekly review interpretation, or goal alignment — answer directly without delegating.

Call this as your FIRST move in the turn if you're going to delegate. Pre-delegation tokens are discarded by the orchestrator; the user sees a chip transition and the specialist's reply.`,
  input_schema: {
    type: "object" as const,
    required: ["specialist"],
    properties: {
      specialist: {
        type: "string",
        enum: ["carter", "nora", "remi"],
        description: "Which specialist owns this question.",
      },
      briefing: {
        type: "string",
        description: "Optional 1-2 sentence note framing the question for the specialist (e.g., 'athlete just finished a deload, asking about next mesocycle' or 'GLP-1 taper started Sunday, asking about protein targets'). Sets the specialist up for a sharper first answer.",
      },
    },
  },
};

export const DELEGATE_TOOL_NAME = "delegate_to_specialist";
```

- [ ] **Step 5.2: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/delegate-tool.ts
git commit -m "feat(coach-team): delegate-tool.ts — DELEGATE_TOOL schema (Peter-only)"
```

---

## Task 6: lib/coach/tools.ts — partition + column restriction

**Files:**
- Modify: `lib/coach/tools.ts`

- [ ] **Step 6.1: Read existing file structure**

Read `lib/coach/tools.ts` (~2963 lines). Identify:
- The `ALLOWED_COLUMNS` constant (column allowlist for query_daily_logs).
- The `DAILY_LOGS_TOOL` schema export.
- The `WORKOUTS_TOOL` schema export.
- All other tool schemas (food log, GLP-1, mobility, planning, etc.).
- The current export shape — likely a single array of all tools.
- The dispatch switch (where tool names are matched to executors).

- [ ] **Step 6.2: Add column cluster constants**

Near the top of the file, AFTER the existing `ALLOWED_COLUMNS` definition, add:

```ts
// ── Per-specialist column clusters for query_daily_logs ──────────────────
// Each specialist sees only the columns relevant to their domain. Peter sees
// all columns (the full ALLOWED_COLUMNS). The orchestrator passes the right
// cluster to executeQueryDailyLogs based on the active speaker.

export const PETER_COLS = ALLOWED_COLUMNS;

export const CARTER_COLS = [
  "recovery", "strain",
  "sleep_hours", "sleep_score",
] as const satisfies readonly AllowedColumn[];

export const NORA_COLS = [
  "calories_eaten", "protein_g", "carbs_g", "fat_g", "fiber_g",
  "weight_kg", "body_fat_pct", "fat_free_mass_kg",
] as const satisfies readonly AllowedColumn[];

export const REMI_COLS = [
  "hrv", "resting_hr", "recovery",
  "sleep_hours", "sleep_score", "deep_sleep_hours", "rem_sleep_hours",
  "spo2", "skin_temp_c", "respiratory_rate",
  "strain",
] as const satisfies readonly AllowedColumn[];

import type { Speaker } from "@/lib/data/types";
export function colsForSpeaker(speaker: Speaker): readonly AllowedColumn[] {
  switch (speaker) {
    case "peter":  return PETER_COLS;
    case "carter": return CARTER_COLS;
    case "nora":   return NORA_COLS;
    case "remi":   return REMI_COLS;
  }
}
```

- [ ] **Step 6.3: Extend executeQueryDailyLogs with column restriction**

Find the `executeQueryDailyLogs` function. Add an optional `allowedColumns` parameter:

```ts
export async function executeQueryDailyLogs(
  supabase: SupabaseClient,
  userId: string,
  input: { start_date: string; end_date: string; columns?: string[]; aggregate?: AggregateMode },
  opts?: { allowedColumns?: readonly AllowedColumn[] },
): Promise<unknown> {
  // ...existing validation...

  // NEW: when allowedColumns is provided, intersect the requested columns
  // with the allowlist. Any requested column not in the allowlist becomes
  // a structured error the model can read.
  if (opts?.allowedColumns) {
    const allowed = new Set(opts.allowedColumns);
    if (input.columns) {
      const denied = input.columns.filter((c) => !allowed.has(c as AllowedColumn));
      if (denied.length > 0) {
        return {
          error: "columns_not_in_specialty",
          message: `These columns are outside this specialist's lane: ${denied.join(", ")}. Defer to Peter for cross-domain context.`,
          denied,
        };
      }
    } else {
      // No columns specified → default to the specialist's full cluster.
      input = { ...input, columns: [...allowed] as string[] };
    }
  }

  // ...rest of existing implementation unchanged...
}
```

- [ ] **Step 6.4: Add per-speaker tool list exports**

At the BOTTOM of the file (after all existing tool exports and executors), add:

```ts
// ── Per-speaker tool partitions ──────────────────────────────────────────
// PETER has access to every tool plus DELEGATE_TOOL. Specialists get a
// narrower set scoped to their lane. The orchestrator picks the right list
// based on which speaker is running.

import { DELEGATE_TOOL } from "./delegate-tool";

export const PETER_TOOLS = [
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  FOOD_LOG_TOOL,
  GLP1_STATUS_TOOL,
  GLP1_TAPER_STARTED_TOOL,
  GLP1_DISCONTINUED_TOOL,
  MOBILITY_DONE_TOOL,
  MOBILITY_UNMARK_TOOL,
  REGENERATE_BRIEF_TOOL,
  PROPOSE_WEEK_TOOL, COMMIT_WEEK_TOOL,
  PROPOSE_BLOCK_TOOL, COMMIT_BLOCK_TOOL,
  PROPOSE_PLAN_TOOL, COMMIT_PLAN_TOOL,
  PROPOSE_NUTRITION_TARGETS_TOOL, COMMIT_NUTRITION_TARGETS_TOOL,
  DELEGATE_TOOL, // Peter-only
];

export const CARTER_TOOLS = [
  WORKOUTS_TOOL,
  DAILY_LOGS_TOOL,
  PROPOSE_WEEK_TOOL, COMMIT_WEEK_TOOL,
  MOBILITY_DONE_TOOL, MOBILITY_UNMARK_TOOL,
];

export const NORA_TOOLS = [
  FOOD_LOG_TOOL,
  DAILY_LOGS_TOOL,
  GLP1_STATUS_TOOL,
  GLP1_TAPER_STARTED_TOOL,
  GLP1_DISCONTINUED_TOOL,
];

export const REMI_TOOLS = [
  DAILY_LOGS_TOOL,
  MOBILITY_DONE_TOOL, MOBILITY_UNMARK_TOOL,
];

export function toolsForSpeaker(speaker: Speaker): readonly typeof DAILY_LOGS_TOOL[] {
  switch (speaker) {
    case "peter":  return PETER_TOOLS;
    case "carter": return CARTER_TOOLS;
    case "nora":   return NORA_TOOLS;
    case "remi":   return REMI_TOOLS;
  }
}
```

Adapt the tool name list above to whatever the file actually has — search for `_TOOL` exports and include them all in PETER_TOOLS. Some names (PROPOSE_NUTRITION_TARGETS_TOOL etc.) may not exist; only include what's actually exported.

- [ ] **Step 6.5: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/tools.ts
git commit -m "feat(coach-team): tools.ts — per-speaker partitions + column-restricted DAILY_LOGS"
```

---

## Task 7: chat-stream.ts orchestrator + API route — delegate interception

**Files:**
- Modify: `lib/coach/chat-stream.ts`
- Modify: `app/api/chat/messages/route.ts`

This is the heaviest task — the orchestrator now picks a speaker per turn, runs Peter first, intercepts `delegate_to_specialist`, swaps to specialist, and pipes the specialist's stream to the client.

- [ ] **Step 7.1: Read existing chat-stream.ts**

Read end-to-end. Identify:
- The main exported function (likely `streamCoachResponse` or similar).
- Where `system` prompt is assembled (snapshot prefix + user prompt override).
- Where tools are passed to `streamClaude`.
- The dispatch switch matching tool names to executors.
- Where mode filtering happens (default / plan_week / setup_block / intake).

- [ ] **Step 7.2: Add speaker-aware streaming helper**

Near the top of the file (after existing imports), add:

```ts
import { speakerSystemPrompt } from "./system-prompts";
import { toolsForSpeaker, colsForSpeaker } from "./tools";
import { DELEGATE_TOOL_NAME } from "./delegate-tool";
import { SPEAKERS, type Speaker } from "@/lib/data/types";
```

Refactor the prompt + tool selection so it takes a `speaker: Speaker` parameter. Where the existing code uses `DEFAULT_SYSTEM_PROMPT` or `allTools`, replace with `speakerSystemPrompt(speaker)` and `toolsForSpeaker(speaker)`. Where `executeQueryDailyLogs` is dispatched, pass `{ allowedColumns: colsForSpeaker(speaker) }` as the opts.

For the existing mode filter (which intersects `allTools` against mode-allowed), wrap the result so it's `(speaker tools) ∩ (mode tools)`:

```ts
function toolsForSpeakerAndMode(speaker: Speaker, mode: Mode) {
  const speakerBase = toolsForSpeaker(speaker);
  return speakerBase.filter((t) => modeAllowsTool(mode, t.name));
}
```

In `intake` mode specifically, exclude DELEGATE_TOOL even for Peter — specialists are dormant during onboarding:

```ts
if (mode === "intake") {
  return speakerBase.filter((t) =>
    modeAllowsTool(mode, t.name) && t.name !== DELEGATE_TOOL_NAME
  );
}
```

- [ ] **Step 7.3: Intercept delegate_to_specialist in the stream loop**

Inside the streaming loop (where the code reads SSE events from `streamClaude` and dispatches tool_use events), add a special branch BEFORE the existing tool dispatch:

```ts
// When Peter calls delegate_to_specialist, the orchestrator INTERCEPTS:
// - halt Peter's stream (AbortController.abort())
// - emit a synthetic 'handoff' SSE event to the client
// - end this generator (the caller in app/api/chat/messages/route.ts sees
//   the handoff event, persists the routing audit row, and spawns a fresh
//   specialist stream with the destination speaker).
if (toolUseEvent.name === DELEGATE_TOOL_NAME) {
  abortController.abort(); // halt Peter
  const input = toolUseEvent.input as { specialist: Speaker; briefing?: string };
  if (!SPEAKERS.includes(input.specialist)) {
    yield { type: "error", message: `Invalid specialist: ${input.specialist}` };
    return;
  }
  yield {
    type: "handoff",
    from: "peter" as const,
    to: input.specialist,
    briefing: input.briefing ?? null,
  };
  return; // Caller spawns specialist stream after seeing the handoff event.
}
```

The handoff event flows out of this generator and the API route's for-await-of loop (Task 7.4) acts on it: persists the routing audit row, then re-invokes this generator with the destination speaker.

- [ ] **Step 7.4: Update app/api/chat/messages/route.ts to handle handoff**

Read `app/api/chat/messages/route.ts` end-to-end. Find where it calls the chat-stream function and pipes events to the SSE response.

Add handoff handling:

```ts
// Inside the SSE response stream:
let activeSpeaker: Speaker = "peter";

for await (const event of streamCoachResponse({ ..., speaker: activeSpeaker })) {
  if (event.type === "handoff") {
    // Persist hidden system_routing audit row.
    await supabase.from("chat_messages").insert({
      user_id: user.id,
      role: "assistant",
      speaker: "peter",
      kind: "system_routing",
      content: `[delegated to ${event.to}]`,
      tool_calls: [{ name: "delegate_to_specialist", input: { specialist: event.to, briefing: event.briefing } }],
    });

    // Emit handoff event to client.
    sendSSE({ type: "handoff", from: event.from, to: event.to, briefing: event.briefing });

    // Spawn the specialist stream with the briefing prepended.
    activeSpeaker = event.to;
    const briefingNote = event.briefing
      ? `Peter's briefing: ${event.briefing}\n\n---\n\nUser message:\n${userMessage}`
      : userMessage;

    for await (const specEvent of streamCoachResponse({ ..., speaker: activeSpeaker, message: briefingNote })) {
      if (specEvent.type === "delta") { accumulated += specEvent.text; sendSSE(specEvent); }
      else if (specEvent.type === "done") { sendSSE(specEvent); break; }
      else if (specEvent.type === "error") { sendSSE(specEvent); throw new Error(specEvent.message); }
    }
    continue;
  }
  // Normal events (delta, done, error) — relay to client.
  if (event.type === "delta") accumulated += event.text;
  sendSSE(event);
}

// On stream end, persist the visible reply with the active speaker.
await supabase.from("chat_messages").insert({
  user_id: user.id,
  role: "assistant",
  speaker: activeSpeaker,
  kind: "coach",
  content: accumulated,
  // ...other existing fields
});
```

Adapt to whatever the existing route looks like — the patterns above are illustrative. The key invariants:
- Always start with `speaker: "peter"`.
- On `handoff` event: persist `system_routing` audit row, emit SSE, spawn new stream with `activeSpeaker = event.to`.
- On stream end, persist `chat_messages` with `speaker: activeSpeaker`.

- [ ] **Step 7.5: Typecheck and exercise**

```bash
npm run typecheck
```

Then `npm run dev` and send a clearly-Nora question in chat ("how was my protein yesterday?"). Verify:
- Stream shows chip transition from Peter to Nora (handoff event handled by client in Task 9).
- Final message in `chat_messages` has `speaker = 'nora'`.
- A hidden `kind = 'system_routing'` row exists with the delegate tool call payload.

- [ ] **Step 7.6: Commit**

```bash
git add lib/coach/chat-stream.ts app/api/chat/messages/route.ts
git commit -m "feat(coach-team): orchestrator intercepts delegate_to_specialist + spawns specialist stream"
```

---

## Task 8: Filter system_routing rows from chat history loader

**Files:**
- Modify: wherever chat history is loaded for the UI (search `chat_messages` + `kind`)

- [ ] **Step 8.1: Find the chat-history loader**

```bash
grep -rn "from('chat_messages')" lib/query/ app/api/chat/ | head -10
```

Locate the function/fetcher that reads chat messages for display.

- [ ] **Step 8.2: Filter out system_routing**

Add `.neq("kind", "system_routing")` to the select query. Example:

```ts
const { data, error } = await supabase
  .from("chat_messages")
  .select(COLS)
  .eq("user_id", userId)
  .neq("kind", "system_routing") // hide routing-audit rows from the chat UI
  .order("created_at", { ascending: true });
```

Apply to BOTH server and browser fetcher variants if they exist.

- [ ] **Step 8.3: Typecheck and commit**

```bash
npm run typecheck
git add lib/query/fetchers/  # adapt to actual paths
git commit -m "feat(coach-team): filter system_routing rows from chat history loader"
```

---

## Task 9: Chat UI — SpeakerChip + HandoffLine + ChatThread integration

**Files:**
- Create: `components/chat/SpeakerChip.tsx`
- Create: `components/chat/HandoffLine.tsx`
- Modify: `components/chat/ChatThread.tsx` (or wherever messages render)
- Modify: hook that consumes the SSE stream (handle the new `handoff` event)

- [ ] **Step 9.1: SpeakerChip**

Create `components/chat/SpeakerChip.tsx`:

```tsx
"use client";

import { SPEAKER_DISPLAY, SPEAKER_COLOR } from "@/lib/coach/speakers";
import type { Speaker } from "@/lib/data/types";

export function SpeakerChip({ speaker, size = "sm" }: { speaker: Speaker; size?: "sm" | "md" }) {
  const display = SPEAKER_DISPLAY[speaker];
  const color = SPEAKER_COLOR[speaker];
  const px = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs";
  return (
    <span className={`inline-flex items-center rounded-full border ${color.bg} ${color.fg} ${color.border} ${px} uppercase tracking-wider`}>
      {display.name}
    </span>
  );
}
```

- [ ] **Step 9.2: HandoffLine**

Create `components/chat/HandoffLine.tsx`:

```tsx
"use client";

import { speakerName } from "@/lib/coach/speakers";
import type { Speaker } from "@/lib/data/types";

export function HandoffLine({
  from,
  to,
  briefing,
}: {
  from: Speaker;
  to: Speaker;
  briefing: string | null;
}) {
  return (
    <div className="flex justify-center py-2">
      <div className="rounded-full bg-zinc-900 border border-zinc-800 px-3 py-1 text-[11px] text-zinc-500">
        {speakerName(from)} → {speakerName(to)}
        {briefing && <span className="ml-2 italic text-zinc-600">— {briefing}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 9.3: Integrate into ChatThread**

Read `components/chat/ChatThread.tsx`. Find the message-rendering loop. For each assistant message, render a `<SpeakerChip speaker={msg.speaker as Speaker} />` above the bubble (only when speaker is not 'user').

Between consecutive messages, when `prev.speaker !== curr.speaker && curr.speaker !== 'user'`, render `<HandoffLine from={prev.speaker} to={curr.speaker} briefing={null} />` (briefing is only available from live SSE handoff events, not persisted on messages — that's fine for replay; live handoffs get the briefing).

- [ ] **Step 9.4: Update the chat SSE hook to handle handoff events**

Search for where `StreamEvent` is consumed in the client (likely a `useChat` or `useChatStream` hook):

```bash
grep -rn "type.*handoff\|streamEvent\|StreamEvent" hooks/ components/chat/ | head -10
```

Add a handler:

```ts
if (event.type === "handoff") {
  // Close the current assistant message bubble; open a new one with the
  // destination speaker. Briefing renders as part of the handoff line.
  setHandoff({ from: event.from, to: event.to, briefing: event.briefing });
  setCurrentSpeaker(event.to);
  // Don't accumulate this event's text — handoff has no text.
  return;
}
```

The UI then renders the `HandoffLine` for the most recent handoff and uses `currentSpeaker` for the speaker chip on the new in-flight message bubble.

- [ ] **Step 9.5: Typecheck and exercise**

```bash
npm run typecheck
npm run dev
```

Open `/coach`, send a nutrition question — verify the handoff line appears between user message and Nora's reply, and Nora's chip renders.

- [ ] **Step 9.6: Commit**

```bash
git add components/chat/SpeakerChip.tsx components/chat/HandoffLine.tsx components/chat/ChatThread.tsx hooks/  # adapt
git commit -m "feat(coach-team): SpeakerChip + HandoffLine + ChatThread integration"
```

---

## Task 10: Morning brief specialist attribution

**Files:**
- Modify: `components/morning/MorningBriefCard.tsx`

- [ ] **Step 10.1: Find the card structure**

Read `components/morning/MorningBriefCard.tsx`. Identify the named blocks (Yesterday recap, Readiness band, Today session, Macros, Advice, Sleep target).

- [ ] **Step 10.2: Add specialist chips per block**

For each block, render a small `<SpeakerChip>` in the block header:
- Yesterday recap → Peter
- Today readiness band → Remi
- Today session → Carter
- Macros → Nora
- Advice → Peter
- Sleep target → Remi

Example:

```tsx
import { SpeakerChip } from "@/components/chat/SpeakerChip";

// In each block header:
<header className="flex items-center justify-between">
  <h3 className="text-xs uppercase tracking-wider text-zinc-400">Today's session</h3>
  <SpeakerChip speaker="carter" />
</header>
```

- [ ] **Step 10.3: Typecheck and commit**

```bash
npm run typecheck
git add components/morning/MorningBriefCard.tsx
git commit -m "feat(coach-team): specialist chips on morning brief blocks"
```

---

## Task 11: Weekly review specialist attribution

**Files:**
- Modify: weekly review page or chat card component (search `weekly_review`)

- [ ] **Step 11.1: Find the weekly review surface**

```bash
grep -rn "kind === 'weekly_review'\|weekly_review" components/ app/coach/ | head -10
```

Likely candidates: `components/coach/WeekReviewBanner.tsx`, `app/coach/weeks/[week_start]/page.tsx`.

- [ ] **Step 11.2: Add specialist chips on §3 trends rows and §6 prescription cells**

The trends section (§3) has per-domain rows. Add a chip to each:
- Strength → Carter
- Composition → Nora
- Recovery → Remi
- Cross (overall) → Peter

The prescription section (§6) has cells (lift swaps, deficit adjustments, deload proposals, block transitions). Each cell labels who proposed it.

Use `<SpeakerChip speaker={...} size="sm" />` inline in each row/cell header.

- [ ] **Step 11.3: Typecheck and commit**

```bash
npm run typecheck
git add components/coach/  app/coach/  # adapt
git commit -m "feat(coach-team): specialist chips on weekly review trends + prescription"
```

---

## Task 12: Proactive nudge speaker + Coach trends specialist chips

**Files:**
- Modify: `components/chat/ProactiveNudgeCard.tsx`
- Modify: coach trends section headers (search `/coach/trends`)
- Modify: `lib/coach/proactive/render-card.ts` to add `speaker` to rendered payload

- [ ] **Step 12.1: Add speaker to proactive render-card output**

Read `lib/coach/proactive/render-card.ts`. The function renders trigger cards (plateau / off-pace / hrv). Add a `speaker` field on each:
- `plateau` → `'carter'`
- `off_pace` → `'nora'`
- `hrv` → `'remi'`

```ts
type RenderedCard = {
  trigger_key: string;
  speaker: Speaker;
  headline: string;
  body: string;
  cta: string;
};
```

- [ ] **Step 12.2: Render chip in ProactiveNudgeCard**

In `components/chat/ProactiveNudgeCard.tsx`, render `<SpeakerChip speaker={card.speaker} />` in the card header.

- [ ] **Step 12.3: Add specialist chips on coach trends sections**

Read `app/coach/trends/page.tsx`. The page has three sections (Performance / Composition / Cross). Add chips in each section header:
- Performance → Carter
- Composition → Nora
- Cross → Peter

- [ ] **Step 12.4: Typecheck and commit**

```bash
npm run typecheck
git add lib/coach/proactive/render-card.ts components/chat/ProactiveNudgeCard.tsx app/coach/trends/
git commit -m "feat(coach-team): specialist chips on proactive nudges + coach trends sections"
```

---

## Task 13: Audit script + CLAUDE.md + final typecheck

**Files:**
- Create: `scripts/audit-speaker-routing.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 13.1: Audit script**

Create `scripts/audit-speaker-routing.mjs`:

```js
#!/usr/bin/env node
// scripts/audit-speaker-routing.mjs
//
// Read-only audit: for the last N chat messages, report the speaker
// distribution and flag obvious mis-routings via keyword heuristics
// (Carter answering nutrition questions, Nora answering training, etc.).
// Useful for tuning Peter's routing prompt.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-speaker-routing.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split("\n")
  .reduce((acc, line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) acc[m[1]] = m[2].replace(/^"|"$/g, "");
    return acc;
  }, {});

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID env var"); process.exit(1); }

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const N = 100;
const { data: messages, error } = await supabase
  .from("chat_messages")
  .select("created_at, role, speaker, kind, content")
  .eq("user_id", userId)
  .order("created_at", { ascending: false })
  .limit(N);
if (error) throw error;

console.log(`→ last ${messages.length} messages`);
const dist = messages.reduce((acc, m) => {
  acc[m.speaker] = (acc[m.speaker] ?? 0) + 1;
  return acc;
}, {});
console.log("  speaker distribution:", dist);

// Keyword heuristics — flag messages where the speaker doesn't match obvious cues.
const cues = {
  carter: /\b(rpe|reps|sets|lift|squat|bench|deadlift|hypertrophy|deload|mesocycle)\b/i,
  nora:   /\b(macro|protein|kcal|calorie|fiber|carbs?|fat|meal|food|portion|hydra)/i,
  remi:   /\b(hrv|sleep|recovery|strain|nap|rest|fatigue|illness)\b/i,
};

let mismatches = 0;
for (const m of messages) {
  if (m.role !== "assistant" || m.kind === "system_routing") continue;
  if (m.speaker === "peter") continue; // peter is allowed everywhere
  // Find the user message before this one for context (rough heuristic: previous row).
  const idx = messages.indexOf(m);
  const prevUser = messages.slice(idx + 1).find((x) => x.role === "user");
  if (!prevUser) continue;
  const cue = cues[m.speaker];
  if (!cue.test(prevUser.content) && !cue.test(m.content)) {
    mismatches++;
    console.warn(`[MISMATCH] ${m.speaker} answered: "${prevUser.content.slice(0, 80)}"`);
  }
}

console.log(`\n${mismatches} potential mis-routings out of ${messages.length} messages`);
```

Make executable: `chmod +x scripts/audit-speaker-routing.mjs`.

- [ ] **Step 13.2: Update CLAUDE.md**

In `CLAUDE.md`:

**Edit A — Database migrations chain.** Add migration 0024 entry after the 0023 entry (which currently lives at item 23 after the PR #94 rebase):

```markdown
24. [supabase/migrations/0024_coach_team.sql](supabase/migrations/0024_coach_team.sql) — multi-coach team architecture: adds `chat_messages.speaker` column (`'peter'|'carter'|'nora'|'remi'|'user'`, backfilled), extends `chat_messages.kind` allowlist with `'system_routing'` (hidden routing-audit rows), and adds `chat_messages_visible_idx` partial index filtering routing-audit rows from chat history queries.
```

**Edit B — Coach / AI section.** Add a new sub-section near the existing chat-tool docs:

```markdown
### Multi-coach team (sub-project #2)

Four coach voices share the chat surface, plus all non-chat AI-narrated surfaces:
- **Peter** ([PETER_BASE](lib/coach/system-prompts.ts)) — Head Coach. Default chat agent + router. Owns block-level decisions and cross-domain synthesis. Has `delegate_to_specialist`. Narrates morning brief advice, weekly review narrative, plan-builder narrative.
- **Coach Carter** ([CARTER_BASE](lib/coach/system-prompts.ts)) — Strength specialist. Tools: workouts, daily_logs (recovery/strain/sleep_* only), week-planning tools, mobility.
- **Nora** ([NORA_BASE](lib/coach/system-prompts.ts)) — Nutrition specialist. Tools: food log, daily_logs (nutrition + body comp cols), GLP-1 phase tools.
- **Remi** ([REMI_BASE](lib/coach/system-prompts.ts)) — Recovery specialist. Tools: daily_logs (recovery/sleep/strain cluster), mobility tools.

Tool partitioning in [lib/coach/tools.ts](lib/coach/tools.ts) (PETER_TOOLS / CARTER_TOOLS / NORA_TOOLS / REMI_TOOLS), intersected with mode by [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts). Column-restricted query_daily_logs via `allowedColumns` param.

Delegation flow: Peter calls `delegate_to_specialist({specialist, briefing?})` → orchestrator intercepts → halts Peter's stream → emits `handoff` SSE event → opens fresh stream with the specialist's prompt + restricted tools → pipes specialist's stream to client. Pre-delegation Peter tokens are discarded; a hidden `kind='system_routing'` row captures the routing decision for audit.

Cross-domain surfaces (morning brief, weekly review, proactive nudges, coach trends) stay narrated by Peter with specialist chip attribution on per-domain blocks. `profiles.system_prompt` (user-editable) is interpreted as Peter's prompt override. Specialists stay code-defined.

Routing audit: `scripts/audit-speaker-routing.mjs` — set `AUDIT_USER_ID`, runs keyword-cue heuristic to flag potential mis-routings.
```

**Edit C — Scripts section.** Add the audit script entry alongside the other audit scripts.

- [ ] **Step 13.3: Final typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 13.4: Commit**

```bash
git add scripts/audit-speaker-routing.mjs CLAUDE.md
git commit -m "feat(coach-team): audit script + CLAUDE.md update for multi-coach team"
```

---

## Self-Review Notes (informational)

**Spec coverage:**
- Goal 1 (4 coaches, distinct prompts + voices + tool partitions) → Tasks 3, 4, 6
- Goal 2 (Peter is router via delegate_to_specialist) → Tasks 5, 7
- Goal 3 (specialists never recursively delegate) → Task 5 (DELEGATE_TOOL only in PETER_TOOLS) + Task 7 (orchestrator gates the tool)
- Goal 4 (cross-domain surfaces narrated by Peter, specialist chip attribution) → Tasks 10, 11, 12
- Goal 5 (chat UI shows speaker per message) → Tasks 2, 9
- Goal 6 (no tool safety regression — column restriction + auth scoping intact) → Task 6

**Non-goal compliance:** No multi-agent council (single specialist per delegation). No user-chooses-specialist UI. No cross-specialist consultation. No per-specialist memory. No specialist-rebranding via settings.

**Type consistency:** `Speaker` defined once in `lib/data/types.ts` and re-used everywhere via import. `SPEAKER_DISPLAY` / `SPEAKER_COLOR` / `toolsForSpeaker` / `colsForSpeaker` / `speakerSystemPrompt` are the canonical lookups.

**Open items deferred to runtime tuning:**
- Exact wording of `PETER_BASE` to reliably trigger delegation in clear-domain cases (tune via audit script).
- Briefing line UX: shown italicized in HandoffLine by default; if visually noisy, hide and keep only in system_routing audit.
- Chip color exact hex values: chosen via tailwind palette tokens (zinc/red/emerald/cyan); refine after seeing in dark theme.
