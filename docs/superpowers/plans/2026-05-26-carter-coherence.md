# Carter Coherence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four 2026-05-26 Carter inconsistencies in one arc: unblock Carter's same-day session writes in default chat, prevent off-grid weight prescriptions, add a cron backstop for missed workout debriefs, and reconcile the morning brief's session block with live override state at render time.

**Architecture:** Five surgical changes, no schema migrations. (1) Two-line allow-list extension in `modeAllowsTool`. (2) Inject "this week's exercises + increments" into Carter's snapshot for grounding. (3) Server-side validator on `propose_session_today` payloads rejects off-grid weights via tool error → model retries. (4) New hourly cron `/api/coach/debrief/sweep` finds logger workouts without a debrief and runs the existing generator. (5) `BriefSessionList` re-resolves the override chain at view time and renders a divergence chip.

**Tech Stack:** Next 15 App Router, Supabase + RLS, TanStack Query, Anthropic SDK, Tailwind v4. No test suite — verification is `npm run typecheck` + manual browser exercise (see [CLAUDE.md](../../../CLAUDE.md)).

**Spec:** [docs/superpowers/specs/2026-05-26-carter-coherence-design.md](../specs/2026-05-26-carter-coherence-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/coach/chat-stream.ts` | modify | Add two `return true` lines in `modeAllowsTool` default branch (Fix 2). Add `carterContext` opt to `runChatStream` + splice into Carter's system text (Fix 4 layer 1 plumb). |
| `lib/coach/system-prompts.ts` | modify | CARTER_BASE: clarify swap requests use `propose_session_today` (Fix 2). Cite-step rule + injected context awareness (Fix 4 layer 2). |
| `lib/coach/carter-context/this-weeks-exercises.ts` | create | Pure builder: takes user + week → returns markdown block listing each exercise's `name`, `increment.step`, `pairedDb`, current `baseKg`. |
| `app/api/chat/messages/route.ts` | modify | Build + pass `carterContext` to `runChatStream` when speaker is Carter. Mirrors existing `peterContext` pattern. |
| `lib/coach/tools.ts` | modify | `executeProposeSessionToday`: validate every `baseKg` against the library's `increment.step` + `pairedDb`. Return structured `off_grid_weight` tool error on violation. |
| `app/api/coach/debrief/sweep/route.ts` | create | CRON_SECRET-gated route: find logger workouts in last 48h with no `chat_messages.kind='workout_debrief'`, call existing debrief generator for each. |
| `vercel.json` | modify | Add hourly cron entry for the sweep route. |
| `components/morning/BriefSessionList.tsx` | modify | Query `useUserSessionTemplate`, compute live exercises via the override chain, render live list with `<UpdatedSinceBriefChip />` on divergence. |

No DB migrations. No RPC changes. No new env vars.

---

## Task 1: Unblock Carter's session-write tools in default chat mode

**Files:**
- Modify: `lib/coach/chat-stream.ts:315-320`

This is the smoking gun. The current default-mode branch of `modeAllowsTool` allows `propose_nutrition_targets` / `propose_meal_log` (and commits) but rejects every other `propose_*` / `commit_*`. `propose_session_today` shipped without being added to that allow-list, so when Carter calls it in default chat the tool is silently stripped from his toolset and the model falls back to "do it manually." The block carries a code comment that anticipated exactly this failure mode.

- [ ] **Step 1: Add two allows after the existing `commit_meal_log` line**

In `lib/coach/chat-stream.ts`, locate the `// default mode` block at line 307 and the four existing `return true` lines (315-318). Add two more immediately after `commit_meal_log`:

```ts
// default mode
// propose_/commit_ tools are blocked by default to prevent accidental plan
// writes — but a few pairs are explicitly exempted because the athlete
// legitimately initiates them from chat: nutrition target proposals
// (Nora/Peter), meal logging (Nora), and same-day session overrides
// (Carter; long-form template changes still gated to plan_week mode).
// New propose_/commit_ pairs added for future write features must add
// their own explicit allows here, or they'll be stripped from the tool
// list and the model will hallucinate a fake commit in prose — see
// 2026-05-22 Nora-meal-log silent-fail.
if (name === "propose_nutrition_targets") return true;
if (name === "commit_nutrition_targets") return true;
if (name === "propose_meal_log") return true;
if (name === "commit_meal_log") return true;
if (name === "propose_session_today") return true;
if (name === "commit_session_today") return true;
if (name.startsWith("propose_")) return false;
if (name.startsWith("commit_")) return false;
```

Note: the comment update is part of this change so the precedent stays accurate for future edits.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. No type signatures changed.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "fix(coach): allow propose_session_today in default chat mode

Carter's session-write tools were silently stripped by modeAllowsTool
in default mode, leaving him to fall back to 'do it manually in the
logger' prose instead of the propose chip the athlete actually needs.
The block already carried a code comment anticipating this exact bug.

Refs spec 2026-05-26-carter-coherence-design.md (Fix 2)."
```

---

## Task 2: CARTER_BASE — replace "do it manually" defection with propose path

**Files:**
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE, the "Session content" paragraph)

CARTER_BASE already tells Carter to call `propose_session_today` for swap requests. But the existing text leaves room for the "do it manually" defection. Tighten it so Carter has no out.

- [ ] **Step 1: Add an explicit anti-defection rule to CARTER_BASE**

Locate the "Session content" block in `lib/coach/system-prompts.ts` (the multi-paragraph block ending with "your prescription artefacts — week labels, session templates, today overrides — you write."). Append the following paragraph at the end of CARTER_BASE (just before the closing backtick of the template literal):

```
When the athlete explicitly asks you to change today's session — swap an exercise, drop one, substitute due to pain or unavailable equipment — your only correct action is to call propose_session_today. Do NOT tell the athlete to "edit it yourself in the logger" or "go to the strength tab and reorder it" — that path is for athlete-initiated saves of their own deviations, not for executing your recommendations. The athlete sees an Approve chip; on tap, training_weeks.exercise_overrides[<today>] is written and the logger picks it up on next open. If propose_session_today fails (no training_weeks row, off-grid weight, etc.), surface the error verbatim — don't paper over it with a manual-action workaround.
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "fix(coach): forbid Carter from suggesting manual logger edits

Tightens CARTER_BASE so swap requests route to propose_session_today,
not the 'do it yourself' defection the athlete saw on 2026-05-26."
```

---

## Task 3: Create `this-weeks-exercises` context builder

**Files:**
- Create: `lib/coach/carter-context/this-weeks-exercises.ts`

A small pure module that builds a markdown block for Carter listing every exercise in this week's session_plan, with its `increment.step`, `pairedDb`, and current `baseKg` (from `user_session_templates` if present, else from `SESSION_PLANS`). Injected into Carter's system text so he doesn't need to call `query_exercise_library` for in-scope exercises — and so a "17 kg DB" hallucination is structurally harder.

- [ ] **Step 1: Create the new file**

Create `lib/coach/carter-context/this-weeks-exercises.ts` with:

```ts
// lib/coach/carter-context/this-weeks-exercises.ts
//
// Builds the "This week's exercises" context block appended to Carter's
// system prompt. Mirrors the same resolution chain the logger uses
// (lib/logger/resolve-plan.ts) so Carter sees the same exercise list the
// athlete will see on next logger open.
//
// Goal: structurally prevent the 2026-05-26 "17 kg DB" off-grid weight bug
// by putting `increment.step` + `pairedDb` directly in Carter's context.
// He can still call query_exercise_library if he wants more (substitutes,
// muscle metadata) — but for any weight he proposes inside this week's
// scope, the data is already in his prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { resolveExercise } from "@/lib/coach/exercise-library";
import { fetchUserSessionTemplateServer } from "@/lib/query/fetchers/userSessionTemplates";
import { currentWeekMonday } from "@/lib/coach/week";

type WeeklyExerciseRow = {
  sessionType: string;
  weekday: string;
  name: string;
  step: number | null;
  pairedDb: boolean | null;
  baseKg: number | null;
  source: "week_override" | "user_template" | "code_default";
};

/**
 * Pure assembly — no Anthropic call. Returns null if no training_weeks row
 * exists for the current week (Carter falls back to query_exercise_library
 * the way he does today; no context block injected).
 */
export async function buildThisWeeksExercisesBlock(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const weekStart = currentWeekMonday();

  const { data: tw, error } = await supabase
    .from("training_weeks")
    .select("session_plan, exercise_overrides")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  if (!tw) return null;

  const sessionPlan = (tw.session_plan ?? {}) as Record<string, string>;
  const overrides = (tw.exercise_overrides ?? {}) as Record<string, PlannedExercise[]>;

  const rows: WeeklyExerciseRow[] = [];
  const weekdays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  for (const weekday of weekdays) {
    const sessionType = sessionPlan[weekday];
    if (!sessionType || sessionType === "REST") continue;

    let exercises: PlannedExercise[];
    let source: WeeklyExerciseRow["source"];
    if (overrides[weekday]?.length) {
      exercises = overrides[weekday];
      source = "week_override";
    } else {
      const template = await fetchUserSessionTemplateServer(supabase, userId, sessionType);
      if (template?.exercises?.length) {
        exercises = template.exercises;
        source = "user_template";
      } else {
        exercises = SESSION_PLANS[sessionType] ?? [];
        source = "code_default";
      }
    }

    for (const ex of exercises) {
      const lib = resolveExercise(ex.name);
      rows.push({
        sessionType,
        weekday,
        name: ex.name,
        step: lib?.increment?.step ?? ex.increment?.step ?? null,
        pairedDb: lib?.pairedDb ?? null,
        baseKg: ex.baseKg ?? null,
        source,
      });
    }
  }

  if (rows.length === 0) return null;

  const lines = rows.map((r) => {
    const baseKgStr = r.baseKg == null ? "—" : `${r.baseKg} kg`;
    const stepStr = r.step == null ? "n/a (bodyweight/duration)" : `${r.step} kg`;
    const pairedStr =
      r.pairedDb === true ? " paired DB" :
      r.pairedDb === false ? " single DB" :
      "";
    return `- ${r.weekday} · ${r.sessionType} · ${r.name} — step=${stepStr}${pairedStr}, current baseKg=${baseKgStr} (${r.source})`;
  });

  return [
    "<this_weeks_exercises>",
    "This week's planned exercises with their library-grounded load increments. Ground every weight you propose in these rows; never quote a kg value that isn't a multiple of the listed step. For dumbbells, step is PER DB (paired = +step per hand). Bodyweight / duration entries (step=n/a) are progressed via reps, tempo, or external load, not kg.",
    "",
    ...lines,
    "</this_weeks_exercises>",
  ].join("\n");
}
```

- [ ] **Step 2: Verify imports resolve**

Run: `grep -n "export function currentWeekMonday\|export async function fetchUserSessionTemplateServer" lib/coach/week.ts lib/query/fetchers/userSessionTemplates.ts`
Expected: both functions found.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. The new file is not imported yet so any local type issue surfaces independently.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/carter-context/this-weeks-exercises.ts
git commit -m "feat(coach): build this-weeks-exercises context block for Carter

Pure builder that mirrors lib/logger/resolve-plan.ts and surfaces every
exercise's increment.step + pairedDb + current baseKg. Wired into the
chat stream in the next task."
```

---

## Task 4: Wire `carterContext` parameter through `runChatStream`

**Files:**
- Modify: `lib/coach/chat-stream.ts` (`RunChatStreamOpts` + system-text assembly)

Mirror the existing `peterContext` plumbing so Carter turns can carry a similar block.

- [ ] **Step 1: Add `carterContext` to `RunChatStreamOpts`**

In `lib/coach/chat-stream.ts`, locate the `peterContext` field in `RunChatStreamOpts` (around line 206). Add a sibling field directly after:

```ts
  /** Pre-built "This week's exercises" markdown from
   *  buildThisWeeksExercisesBlock(). Appended after the base system
   *  prompt for Carter turns only. Null/undefined means no training_weeks
   *  row for the current week — fall back to query_exercise_library. */
  carterContext?: string | null;
```

- [ ] **Step 2: Splice `carterContext` into the system text for Carter turns**

Locate the existing splice around line 259:

```ts
if (opts.peterContext) systemText = `${systemText}\n\n${opts.peterContext}`;
```

Add a sibling splice for Carter immediately after:

```ts
if (opts.peterContext) systemText = `${systemText}\n\n${opts.peterContext}`;
if (opts.carterContext && speaker === "carter") {
  systemText = `${systemText}\n\n${opts.carterContext}`;
}
```

The `speaker === "carter"` guard makes the block a no-op for Peter delegating to a Carter turn (Peter has his own dashboard block) — only the Carter-speaking stream uses it.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. Optional field is additive; no caller is required to set it.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/chat-stream.ts
git commit -m "feat(coach): plumb carterContext through runChatStream

Mirrors peterContext: optional system-prompt suffix appended for Carter
turns only. Filled in by the route in the next task."
```

---

## Task 5: Build and pass `carterContext` from the chat route

**Files:**
- Modify: `app/api/chat/messages/route.ts`

Mirror the `peterContext` build site so Carter turns get the block computed once per request.

- [ ] **Step 1: Import the builder**

Add to the existing imports at the top of `app/api/chat/messages/route.ts`:

```ts
import { buildThisWeeksExercisesBlock } from "@/lib/coach/carter-context/this-weeks-exercises";
```

- [ ] **Step 2: Build `carterContext` alongside `peterContext`**

Locate the block where `peterContext` and `peterDashboardBlock` are computed (around line 781). Add a sibling for Carter:

```ts
      const peterContext = initialSpeaker === "peter"
        ? await buildPeterContextBlock(sr, user.id).catch((err) => {
            console.warn("[chat] buildPeterContextBlock failed", err);
            return null;
          })
        : null;
      const peterDashboardBlock = initialSpeaker === "peter"
        ? await loadLatestPeterDashboard(sr, user.id, new Date().toISOString().slice(0, 10))
            .then((row) => row?.narrative_md ?? null)
            .catch((err) => {
              console.warn("[chat] loadLatestPeterDashboard failed", err);
              return null;
            })
        : null;
      const carterContext = initialSpeaker === "carter"
        ? await buildThisWeeksExercisesBlock({ supabase: sr, userId: user.id }).catch((err) => {
            console.warn("[chat] buildThisWeeksExercisesBlock failed", err);
            return null;
          })
        : null;
```

- [ ] **Step 3: Pass `carterContext` into the `runChatStream` call**

Locate the `runChatStream({ ... })` invocation inside `drainStream` (around line 803). Add `carterContext` next to `peterContext`:

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
            carterContext,
          })) {
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

Run `npm run dev`, open `/coach`, send Carter a question like "what should I do today?" Then check the server logs for any `[chat] buildThisWeeksExercisesBlock failed` warnings. The block is invisible to the athlete (it lives in the system prompt) — if the request returns without error, the wiring is sound.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "feat(coach): inject this-weeks-exercises block into Carter turns

Closes the structural gap behind the 2026-05-26 '17 kg DB' bug — Carter
now sees every in-scope exercise's increment.step + pairedDb in his
system prompt and no longer needs to call query_exercise_library for
weight-grounding."
```

---

## Task 6: Validate `propose_session_today` payloads against library increments

**Files:**
- Modify: `lib/coach/tools.ts` (`executeProposeSessionToday`, around line 1934-1975)

Tool-input validator: for every `exercise` in the payload with a `baseKg`, look up the exercise in the library, get `increment.step`, and reject if `baseKg` is not a multiple of `step`. Returns a structured tool error so the model retries with a corrected value — Anthropic's tool loop handles the retry automatically.

- [ ] **Step 1: Add the validator after the existing payload checks**

In `lib/coach/tools.ts`, locate `executeProposeSessionToday`. After the existing today-weekday guard (the `if (i.weekday !== todayWeekday)` block ending around line 1962) and BEFORE the `const payload: SessionTodayPayload = {` line (around 1964), insert:

```ts
  // Off-grid weight guard. Each library entry carries `increment.step` (per-DB
  // for paired DBs; total otherwise) and `pairedDb`. baseKg must be a multiple
  // of step. Free-form exercises not in the library are skipped — Carter
  // flagged the library gap in the rationale and the athlete will see it on
  // the chip. See spec 2026-05-26-carter-coherence-design.md §6.
  for (const ex of i.exercises as Array<Record<string, unknown>>) {
    const name = typeof ex.name === "string" ? ex.name : null;
    const baseKg = typeof ex.baseKg === "number" ? ex.baseKg : null;
    if (!name || baseKg == null) continue;

    const lib = resolveExercise(name);
    if (!lib || !lib.increment) continue;  // bodyweight / duration / library gap

    const step = lib.increment.step;
    const intermediate = lib.increment.intermediate;
    const onGrid =
      Math.abs((baseKg / step) - Math.round(baseKg / step)) < 1e-6 ||
      (intermediate != null &&
        Math.abs((baseKg / intermediate) - Math.round(baseKg / intermediate)) < 1e-6);
    if (!onGrid) {
      const nearest = Math.round(baseKg / step) * step;
      const next = nearest + step;
      const prev = Math.max(0, nearest - step);
      return {
        ok: false,
        error: {
          error: "off_grid_weight",
          exercise: name,
          proposed_kg: baseKg,
          step,
          paired_db: lib.pairedDb ?? null,
          valid_neighbors: Array.from(new Set([prev, nearest, next])).filter((v) => v >= 0),
          rule:
            lib.pairedDb === true
              ? `Paired DB: step is ${step} kg PER DB (total system load jumps by ${step * 2} kg).`
              : lib.pairedDb === false
              ? `Single DB: step is ${step} kg total.`
              : `Step is ${step} kg.`,
        },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
  }
```

You'll also need to make sure `resolveExercise` is imported. Locate the existing imports at the top of `lib/coach/tools.ts` and confirm `resolveExercise` (or an equivalent) is already in scope (this file already uses `query_exercise_library` so the library is likely imported). If not, add:

```ts
import { resolveExercise } from "@/lib/coach/exercise-library";
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

This is the hardest validation step to exercise — propose_session_today is gated behind Carter chat. Two options:
  - **Cheap path:** open a Node REPL with the alias-loader and call `executeProposeSessionToday` directly with a synthetic `baseKg: 17` on a paired DB exercise (e.g. `lateral_raise`). Confirm the return shape is `{ ok: false, error: { error: "off_grid_weight", ... } }`.
  - **Real path:** in dev, chat with Carter and explicitly ask "set today's session with lateral raises at 17kg per DB." The model should either (a) round to 18 in the payload (already grounded by the new context block) or (b) submit 17 and see the structured error → retry with 18. Inspect the SSE event stream for the tool error.

If neither path is convenient, skip — the typecheck pass plus the simple arithmetic of the validator is enough confidence for a v1 ship.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "fix(coach): reject off-grid baseKg in propose_session_today

Carter prescribed '17 kg DB' (impossible: paired DBs step by +2 kg per
hand → 16→18, not 17). Validator returns a structured tool error with
valid neighbors; Anthropic's tool loop retries with a corrected weight.

Refs spec 2026-05-26-carter-coherence-design.md (Fix 4 layer 3)."
```

---

## Task 7: CARTER_BASE — cite the step, refuse without context

**Files:**
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE, the dumbbell-rules block)

Two small additions: (a) cite the step before any kg, so hallucination is visible mid-stream; (b) trust the new `<this_weeks_exercises>` block as the source of truth for in-scope load planning.

- [ ] **Step 1: Edit CARTER_BASE**

In `lib/coach/system-prompts.ts`, locate the paragraph in CARTER_BASE that starts with "Before quoting a target weight for a future session, fetch the entry via query_exercise_library…". Replace that paragraph (keep surrounding paragraphs intact) with:

```
Before quoting a target weight for any exercise, cite the increment.step you are rounding to in one phrase — e.g. "Lateral Raise step is 2 kg per DB, paired — so 16 → 18 kg, not 17." This makes off-grid prescriptions obvious mid-reply and helps the athlete trust the number.

For exercises in this week's training plan, the increment.step, pairedDb, and current baseKg are pre-injected as the <this_weeks_exercises> block in your context — use that block as the source of truth, do not call query_exercise_library for those exercises. For exercises outside this week's scope (substitutions, new accessories, library exploration), call query_exercise_library or get_substitutes before quoting a kg value. If you cannot see the step for an exercise you want to prescribe, refuse to quote a number and explain why — the athlete will tell you the rack or you can call the library tool.

Never propose a sub-step value like "+1 kg per DB" or "+2.5 kg on the curl" — the rack doesn't have it. If +4 kg total feels excessive for an isolation lift, prescribe rep progression (double progression) instead of a smaller kg jump. The propose_session_today endpoint validates baseKg against increment.step server-side and returns an "off_grid_weight" error on violation — if you see that error, retry with the nearest valid neighbor it returned.
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

Run `npm run dev`, chat with Carter, ask "what should I do for biceps next week?" Verify Carter cites a step (e.g., "step is 2 kg per DB, paired") before any weight number.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "fix(coach): make Carter cite increment.step before every weight

Layer 2 of the off-grid weight fix. Forces the citation to be visible
in the reply so the athlete can spot hallucinations, and points Carter
at the <this_weeks_exercises> block as the grounding source.

Refs spec 2026-05-26-carter-coherence-design.md (Fix 4 layer 2)."
```

---

## Task 8: Create `/api/coach/debrief/sweep` route

**Files:**
- Create: `app/api/coach/debrief/sweep/route.ts`

Hourly cron that catches workouts whose client-fired debrief never landed. Uses the existing `/api/coach/workout-debrief` POST handler's idempotency check via a direct call to the same generator.

- [ ] **Step 1: Inspect the existing debrief route to understand the shared code path**

Read `app/api/coach/workout-debrief/route.ts` end-to-end. Confirm:
  - The body of the handler — auth, idempotency check on `chat_messages.kind='workout_debrief'` with `ui->>'workout_id'`, generator call, chat_messages insert — is a sequence we want to reuse, not duplicate.
  - `generateWorkoutDebrief` and `tldrFromPayload` are already exported from `lib/coach/session-debrief/` and `lib/coach/session-debrief/payload.ts`.

We will NOT factor the existing route's body into a shared helper as part of this task (that risks regressing the client-fired path). Instead, the sweep route duplicates the post-auth body but iterates over multiple workouts. Acceptable v1 duplication; consolidation is a follow-up.

- [ ] **Step 2: Create the sweep route**

Create `app/api/coach/debrief/sweep/route.ts`:

```ts
// app/api/coach/debrief/sweep/route.ts
//
// Hourly cron backstop for the client-fired workout debrief. Finds logger
// workouts in the last 48h with no matching chat_messages.kind='workout_debrief'
// row and runs the existing debrief generator for each.
//
// Idempotent by construction: the SELECT excludes workouts that already have
// a debrief row. A race between two sweeps (shouldn't happen — single Vercel
// cron entry) would still be safe because the chat_messages insert is
// transactional and a duplicate would simply be a second row tagged with the
// same workout_id (still distinguishable; not a correctness bug, just noise).
// We add the existence check inside the loop to guard against that anyway.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateWorkoutDebrief } from "@/lib/coach/session-debrief";
import { tldrFromPayload } from "@/lib/coach/session-debrief/payload";

export const dynamic = "force-dynamic";
export const maxDuration = 300;  // sweep multiple workouts in one invocation

type SweepResult = {
  swept: number;
  generated: number;
  skipped: number;
  errors: { workout_id: string; message: string }[];
};

export async function GET(req: Request) {
  // Vercel cron calls GET with `Authorization: Bearer ${CRON_SECRET}`.
  const auth = req.headers.get("authorization");
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sr = createSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Pull logger workouts from the last 48h. External_id filter narrows to
  // the in-app logger source (Strong CSV uses `strong-<date>-<slug>`).
  const { data: candidates, error: candErr } = await sr
    .from("workouts")
    .select("id, user_id, external_id, created_at")
    .gte("created_at", cutoff)
    .like("external_id", "logger-%");
  if (candErr) {
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }

  const result: SweepResult = { swept: candidates?.length ?? 0, generated: 0, skipped: 0, errors: [] };

  for (const workout of candidates ?? []) {
    // Idempotency check: does a debrief row already exist for this workout?
    const { data: existing, error: lookupErr } = await sr
      .from("chat_messages")
      .select("id")
      .eq("user_id", workout.user_id)
      .eq("kind", "workout_debrief")
      .eq("ui->>workout_id", workout.id)
      .maybeSingle();
    if (lookupErr) {
      result.errors.push({ workout_id: workout.id, message: `lookup: ${lookupErr.message}` });
      continue;
    }
    if (existing) {
      result.skipped += 1;
      continue;
    }

    // Generate.
    let genResult;
    try {
      genResult = await generateWorkoutDebrief({
        supabase: sr,
        userId: workout.user_id,
        workoutId: workout.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ workout_id: workout.id, message: `generate: ${msg}` });
      continue;
    }
    if (!genResult.ok) {
      result.skipped += 1;
      continue;
    }

    const tldr = tldrFromPayload(genResult.payload);
    const { error: insertErr } = await sr
      .from("chat_messages")
      .insert({
        user_id: workout.user_id,
        role: "assistant",
        speaker: "carter",
        thread: "carter",
        kind: "workout_debrief",
        content: tldr,
        ui: genResult.payload,
      });
    if (insertErr) {
      result.errors.push({ workout_id: workout.id, message: `insert: ${insertErr.message}` });
      continue;
    }

    revalidatePath("/coach");
    revalidatePath(`/coach/sessions/${workout.id}`);
    result.generated += 1;
  }

  return NextResponse.json(result);
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Local smoke (optional)**

In dev with `.env.local` containing `CRON_SECRET=<value>`, run:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/debrief/sweep
```

Expected: a JSON response shaped `{ swept: N, generated: K, skipped: M, errors: [] }` where N is the count of logger workouts in the last 48h, K = N minus existing debriefs, M = existing debriefs in window, errors empty on a healthy state.

- [ ] **Step 5: Commit**

```bash
git add app/api/coach/debrief/sweep/route.ts
git commit -m "feat(coach): add hourly debrief sweep cron

Backstop for the client-fired workout debrief. Finds logger workouts
in the last 48h with no debrief row and runs the existing generator.
Idempotent by SELECT exclusion + per-iteration existence check.

Refs spec 2026-05-26-carter-coherence-design.md (Fix 3)."
```

---

## Task 9: Wire the sweep cron in `vercel.json`

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the cron entry**

In `vercel.json`, add a new entry to the `crons` array (after the existing `proactive/check` entry, before the closing `]`):

```json
    {
      "path": "/api/coach/proactive/check",
      "schedule": "0 11 * * *"
    },
    {
      "path": "/api/coach/debrief/sweep",
      "schedule": "0 * * * *"
    }
```

The cron expression `0 * * * *` is "minute 0 of every hour" — hourly cadence so the worst-case latency between "client fire failed" and "debrief lands" is ~1 hour.

- [ ] **Step 2: Validate the JSON parses**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('vercel.json', 'utf8')).crons.length)"`
Expected: prints `7` (was 6, plus the new entry).

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "chore(cron): schedule hourly debrief sweep"
```

---

## Task 10: BriefSessionList — render-time reconciliation with live overrides

**Files:**
- Modify: `components/morning/BriefSessionList.tsx`

The brief snapshots `session.exercises` into `chat_messages.ui` at write time. The strength tab and logger re-resolve at view time. If overrides changed in between, the brief shows stale exercises. Fix: re-read the override chain client-side in `BriefSessionList` and render the live list when it diverges from the frozen snapshot, with an explanatory chip.

- [ ] **Step 1: Add `useUserSessionTemplate` import and divergence helper**

In `components/morning/BriefSessionList.tsx`, add to the imports (top of file):

```ts
import { useUserSessionTemplate } from "@/lib/query/hooks/useUserSessionTemplate";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
```

Below the existing helpers (`fmtRestRange`, `findAnnotation`) and BEFORE the `BriefSessionList` function declaration (~ line 28), add:

```ts
function sameExerciseList(a: PlannedExercise[], b: PlannedExercise[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: PlannedExercise[]) =>
    xs.map((x) => (x.key ?? x.name).toLowerCase().trim()).sort().join("|");
  return norm(a) === norm(b);
}

function resolveLiveExercises(args: {
  weekOverrides: import("@/lib/data/types").ExerciseOverrides | null;
  weekday: string;
  sessionType: string;
  template: { exercises: PlannedExercise[] } | null | undefined;
}): { exercises: PlannedExercise[]; source: "week_override" | "user_template" | "code_default" } {
  const override = args.weekOverrides?.[args.weekday];
  if (override && override.length > 0) {
    return { exercises: override, source: "week_override" };
  }
  if (args.template?.exercises && args.template.exercises.length > 0) {
    return { exercises: args.template.exercises, source: "user_template" };
  }
  return {
    exercises: SESSION_PLANS[args.sessionType] ?? [],
    source: "code_default",
  };
}
```

- [ ] **Step 2: Query the user template + compute divergence inside `BriefSessionList`**

Locate the existing top of the `BriefSessionList` function body. The current first few lines look like:

```ts
  const { exercises, volume_gaps } = session;
  const [loggerOpen, setLoggerOpen] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const loggerSessionType = liveType ?? session.type;
  const hasDraft = useExistingLoggerDraft(userId, loggerSessionType, draftEpoch);
```

Add immediately after, BEFORE the `if (exercises.length === 0)` early return:

```ts
  const { data: template } = useUserSessionTemplate(userId, loggerSessionType);
  const live = resolveLiveExercises({
    weekOverrides,
    weekday,
    sessionType: loggerSessionType,
    template,
  });
  const frozenExercises: PlannedExercise[] = exercises as PlannedExercise[];
  const exercisesDiverged =
    live.exercises.length > 0 && !sameExerciseList(live.exercises, frozenExercises);
  const renderedExercises = exercisesDiverged ? live.exercises : frozenExercises;
  const [showOriginal, setShowOriginal] = useState(false);
```

- [ ] **Step 3: Replace every read of the frozen `exercises` array with `renderedExercises`**

Inside `BriefSessionList`, the frozen list is read in (at minimum) the main exercise-render loop and the `volume_gaps` adjacent block. Find every place that maps over `exercises` (the destructured variable from `session.exercises`) and rename the variable being mapped to `renderedExercises`.

Concretely: search the function body for `.map((e` and `for ... of exercises` and similar. Each render-time consumer reads `renderedExercises` now. The `exercises.length === 0` early return uses `renderedExercises.length === 0` instead (so an empty live override is also handled correctly).

```ts
  if (renderedExercises.length === 0) {
    // ... unchanged body ...
  }
```

`findAnnotation` calls take an exercise `name` — the `session.structure.exercises` array is frozen too. If `exercisesDiverged`, structure annotations may not match the live exercise names; in that case skip the annotation rather than render a stale one:

```ts
                  const ann = exercisesDiverged
                    ? null
                    : findAnnotation(session.structure, e.name);
```

Apply this to BOTH `findAnnotation` call sites inside the function body (the audit found two — around lines 120 and 166).

- [ ] **Step 4: Render the divergence chip**

In the JSX returned by `BriefSessionList`, find the section that renders the list header. Above the list itself (and after any existing header label), add a conditional chip:

```tsx
      {exercisesDiverged && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            marginBottom: 8,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 8,
            fontSize: 12,
            color: COLOR.textMuted,
            background: COLOR.surfaceAlt,
          }}
        >
          <span style={{ flex: 1 }}>
            Plan updated since this morning · showing current ({live.source.replace("_", " ")})
          </span>
          <button
            type="button"
            onClick={() => setShowOriginal((v) => !v)}
            style={{
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 6,
              border: `1px solid ${COLOR.divider}`,
              background: "transparent",
              color: COLOR.textMuted,
              cursor: "pointer",
            }}
          >
            {showOriginal ? "Hide original" : "View original"}
          </button>
        </div>
      )}
      {exercisesDiverged && showOriginal && (
        <div
          style={{
            padding: 8,
            marginBottom: 8,
            borderRadius: 6,
            background: COLOR.surfaceAlt,
            fontSize: 12,
            color: COLOR.textMuted,
          }}
        >
          <div style={{ marginBottom: 4, fontWeight: 600 }}>This morning's plan</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {frozenExercises.map((e, i) => (
              <li key={`${e.key ?? e.name}-${i}`}>{e.name}</li>
            ))}
          </ul>
        </div>
      )}
```

`COLOR.surfaceAlt`, `COLOR.divider`, and `COLOR.textMuted` are confirmed tokens in [lib/ui/theme.ts](../../../lib/ui/theme.ts). If a neighbor like `VolumeGapsBanner` uses a more specific styling pattern (e.g., its own border-radius or padding), prefer matching it for visual parity over the literal values above.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Manual smoke — verify the chip surfaces**

Run `npm run dev` and reproduce the original bug:
  1. Open `/coach` and confirm the morning brief renders today's session.
  2. In a separate tab, open `/coach?sub=strength` and use the reorder/swap controls to change today's exercise order (this writes `training_weeks.exercise_overrides[<weekday>]`).
  3. Refresh `/coach`. The brief's session block should now show the new order, with the "Plan updated since this morning" chip visible. Clicking "View original" expands the frozen list.

If the chip never appears, log `exercisesDiverged`, `live.source`, and `frozenExercises[0]?.name` to console once and verify the comparison fires.

- [ ] **Step 7: Commit**

```bash
git add components/morning/BriefSessionList.tsx
git commit -m "fix(brief): reconcile session block with live override state

Brief snapshots session.exercises into chat_messages.ui at write time;
when overrides change after, the brief lies. This re-resolves the
override chain at render time (same chain the logger uses), renders
the live list, and shows an explanatory chip with a 'view original'
expansion. Frozen ui jsonb is preserved (audit trail intact).

Refs spec 2026-05-26-carter-coherence-design.md (Fix 1)."
```

---

## Verification before final hand-off

After all tasks land, exercise the full athlete journey once in dev:

1. **Carter same-day swap (Fix 2):** In `/coach`, ask Carter "swap incline DB press for flat DB press today, my shoulder is grumpy." Confirm Carter calls `propose_session_today` and the chip appears (not "do it manually in the logger" prose).
2. **Off-grid weight (Fix 4):** Ask Carter "what should I lift for lateral raises today, aim for around 17 kg per DB." Confirm Carter either rounds to 18 in the chip preview, or the chip shows an `off_grid_weight` error and his retry lands on 18.
3. **Debrief sweep (Fix 3):** Open the logger, commit a session, force a tab close before the client fetch lands (DevTools → Network → offline mode → save → re-enable network). Then `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/debrief/sweep`. Confirm a debrief chat_messages row appears.
4. **Brief reconciliation (Fix 1):** Commit a `propose_session_today` override via Carter chat. Reload `/coach`. Confirm the brief's session block now shows the override exercises with the chip.

Each of these is a 30-second exercise. The whole journey is ~5 minutes total. If anything misfires, the failing piece is contained to one task above.

---

## Out-of-scope reminders (per spec §2)

- We do NOT add a tool to edit logged sets/weights post-commit — athlete-owned data, separate spec covers reopening in `LoggerSheet`.
- We do NOT unblock `propose_session_template` / `commit_session_template` in default mode — template changes are mesocycle-scale, stay in `plan_week`.
- We do NOT regenerate the brief on override commit — render-time reconciliation is the chosen surface.
- We do NOT scan Carter's free-form prose for off-grid weights — too fragile; layers 1-3 catch the structured cases.
- We do NOT add `@vercel/functions` `waitUntil` — the workout-debrief spec rejected this; we honor it.
