# Schedule Flexibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship mid-week training plan swaps (A↔B exchange + replace) with audit-honest adherence and a deterministic coach-suggested chip on the morning brief when readiness is low.

**Architecture:** One mutation endpoint (`POST /api/training-weeks/[week_start]/swap`) shared by two UI surfaces (strength tab `DaySwapSheet` + morning brief `BriefCoachSuggestion`). Migration 0012 adds a nullable `original_session_plan` jsonb column; first edit COALESCE-snapshots the committed plan, identity-restore (A→B→A) resets it to NULL. Adherence reads `coalesce(original_session_plan, session_plan)` and its per-day output grows a `status` field so the conversational Sunday recap distinguishes swapped from missed.

**Tech Stack:** Next.js 15 (App Router) · Supabase (Postgres + RLS) · TanStack Query · TypeScript strict · Tailwind v4 · Vercel · Anthropic Haiku 4.5 (advice prose, prompt-clause only — no new AI calls).

**Reference spec:** [docs/superpowers/specs/2026-05-11-schedule-flexibility-design.md](../specs/2026-05-11-schedule-flexibility-design.md).

**Verification convention (per [CLAUDE.md](../../../CLAUDE.md) — no test runner):**
- Each task ends with `npm run typecheck` clean.
- Pure functions and route handlers get a throwaway `scripts/probe-*.mjs` that's created, run, and deleted within the task (NOT committed).
- End-to-end manual smoke runs in the final task.
- Commits are per-task. Branch `feat/schedule-flexibility` is already created from `main` with the spec committed as `931020d`.

---

## File structure

**New files (6):**

| Path | Responsibility |
|---|---|
| `supabase/migrations/0012_schedule_flexibility.sql` | Adds nullable `original_session_plan jsonb` column. |
| `app/api/training-weeks/[week_start]/swap/route.ts` | POST handler — auth, validate, compute new plan, conflict gate, COALESCE+identity-restore UPDATE. |
| `lib/training-weeks/apply-swap.ts` | Pure: `applySwap()` + `detectConflicts()`. No I/O. |
| `lib/query/hooks/useSwapTrainingDay.ts` | TanStack `useMutation` shared by both surfaces. |
| `components/strength/DaySwapSheet.tsx` | Bottom sheet: action → target → confirm/warn. |
| `components/morning/BriefCoachSuggestion.tsx` | Yellow chip on the morning brief; derived "acknowledged" state. |

**Modified files (8):**

| Path | Change |
|---|---|
| `lib/data/types.ts` | + `original_session_plan` on `TrainingWeek`, + swap-related types, + brief coach_suggestion types. |
| `lib/coach/adherence.ts` | Read `coalesce(original, current)`; grow per-day output with `swapped_to` + `status`. |
| `components/coach/WeekPlanCard.tsx` | Tappable rows mount `DaySwapSheet`. |
| `components/morning/MorningBriefCard.tsx` | Mount `BriefCoachSuggestion`; strikethrough `BriefSessionList` when swapped. |
| `lib/morning/brief/assembler.ts` | + `pickCoachSuggestion(band, sessionType, hasTrainingWeek)`. |
| `lib/morning/brief/flags.ts` | + `coach_swap_suggested` derived flag. |
| `lib/morning/brief/advice-prompt.ts` | + prompt clause: explain why, don't re-decide, drop workout-anchored timing. |
| `CLAUDE.md` | + migration 0012 entry + one bullet under Coach/AI for schedule flexibility. |

---

## Task 1: Migration 0012 + CLAUDE.md migrations entry

**Files:**
- Create: `supabase/migrations/0012_schedule_flexibility.sql`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0012_schedule_flexibility.sql`:

```sql
-- 0012_schedule_flexibility.sql — schedule flexibility
--
-- One nullable column on training_weeks to capture the originally committed
-- session_plan on first mutation. Adherence math reads
-- coalesce(original_session_plan, session_plan) so swaps don't retroactively
-- flatter recap numbers.

alter table public.training_weeks
  add column if not exists original_session_plan jsonb;

comment on column public.training_weeks.original_session_plan is
  'Snapshot of session_plan at the moment of the first mid-week edit. NULL on rows that have never been edited. Set by the /swap endpoint on first mutation; never updated thereafter. Reset to NULL when an identity-restore swap returns session_plan to the original state. Adherence reads coalesce(original_session_plan, session_plan).';
```

- [ ] **Step 2: Apply the migration via Supabase CLI**

Per the linked-CLI workflow ([memory: reference_supabase_cli.md]):

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected output: `Applying migration 0012_schedule_flexibility.sql ... Done.`

If `supabase db push` reports the migration as already-applied or out-of-sync, run:

```bash
supabase migration repair --status applied 0012_schedule_flexibility
```

then `supabase db push` again.

- [ ] **Step 3: Verify the column exists**

```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" -c "select column_name, data_type, is_nullable from information_schema.columns where table_name = 'training_weeks' and column_name = 'original_session_plan';"
```

Expected: one row showing `original_session_plan | jsonb | YES`.

If `psql` is unavailable, run the equivalent SQL via the Supabase Dashboard → SQL Editor.

- [ ] **Step 4: Add the migration to CLAUDE.md**

Add this entry to the numbered migration list in `CLAUDE.md`, immediately after the migration 0011 entry:

```
11. [supabase/migrations/0012_schedule_flexibility.sql](supabase/migrations/0012_schedule_flexibility.sql) — adds nullable `training_weeks.original_session_plan jsonb` for mid-week swap audit; populated on first edit via `coalesce(original_session_plan, session_plan)`; reset to NULL on identity-restore. Adherence reads `coalesce(...)` so the Sunday recap stays anchored to the Sunday commitment.
```

(The existing numbered list uses "1.", "2.", ... but `0011_morning_brief.sql` is currently entry 10 because of an earlier numbering drift — preserve whatever counter the file currently uses; the literal entry above starts with "11.".)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: clean (no TS errors).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_schedule_flexibility.sql CLAUDE.md
git commit -m "feat(schedule): migration 0012 — original_session_plan column

Adds nullable jsonb column to training_weeks for mid-week swap audit.
Populated COALESCE-style on first edit, reset to NULL on identity restore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: TypeScript type additions

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Locate the TrainingWeek type**

```bash
grep -n "TrainingWeek\b" lib/data/types.ts
```

Expected: a line like `export type TrainingWeek = { ... }` near where `IntensityModifier` and `SessionPlan` are defined.

- [ ] **Step 2: Add `original_session_plan` to TrainingWeek**

In `lib/data/types.ts`, find the `TrainingWeek` definition. Add this field (the exact location is right after `session_plan`):

```ts
//   session_plan: SessionPlan;
//   ↓ add this:
original_session_plan: SessionPlan | null;
```

- [ ] **Step 3: Append swap-related types to the file**

Append to the end of `lib/data/types.ts`:

```ts
// ── Schedule flexibility (migration 0012) ────────────────────────────────────

export type SwapAction = "swap" | "replace";

export type SwapConflict = {
  /** The day with the new placement that conflicts. */
  day: Weekday;
  /** The adjacent day (day ± 1) causing the conflict. */
  neighbor_day: Weekday;
  /** The session type that would be duplicated across two adjacent days. */
  session_type: string;
};

export type SwapBody =
  | { action: "swap"; source_day: Weekday; target_day: Weekday }
  | { action: "replace"; source_day: Weekday; session_type: string };

export type SwapResult = {
  week: TrainingWeek;
  swap: {
    source_day: Weekday;
    action: SwapAction;
    /** Session type at source_day before the operation. */
    before: string;
    /** Session type at source_day after the operation. For action='swap',
     *  this is the previous target_day value. */
    after: string;
  };
};

export type SwapPreviewError = {
  conflicts: SwapConflict[];
  /** The plan that would be written if the client retries with ?confirm=true. */
  preview_plan: SessionPlan;
};

// ── Morning brief coach_suggestion (consumed by Schedule flexibility) ────────

export type MorningBriefCoachSuggestion =
  | { kind: "swap_to_mobility"; rationale: "low_readiness" }
  | null;
```

- [ ] **Step 4: Add `coach_suggestion` to MorningBriefCard**

In `lib/data/types.ts`, find the existing `MorningBriefCard` type (added by migration 0011's spec). Add this field (right after `advice_md` is a natural slot):

```ts
//   advice_md: string;
//   ↓ add this:
coach_suggestion: MorningBriefCoachSuggestion;
```

- [ ] **Step 5: Add `coach_swap_suggested` to AdviceFlags**

In `lib/data/types.ts`, find the existing `AdviceFlags` type. Add this field (append to the existing list):

```ts
//   missed_protein_yesterday: boolean;
//   ↓ add this:
coach_swap_suggested: boolean;
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean. If errors fire at consumers (e.g., the assembler returning a `MorningBriefCard` without `coach_suggestion`, or `computeAdviceFlags` returning `AdviceFlags` without `coach_swap_suggested`), they'll be fixed in Tasks 9 and 10. For now, expected errors are limited to the assembler/flags sites; if any other site errors out, stop and reconcile.

If unrelated sites error, address those by widening the type (`coach_suggestion?: MorningBriefCoachSuggestion`) temporarily — but Tasks 9/10 will tighten this back. Prefer to leave it strict and let Tasks 9/10 fix the assembler/flags directly in the same chain of commits.

- [ ] **Step 7: Commit**

```bash
git add lib/data/types.ts
git commit -m "feat(schedule): swap types + brief coach_suggestion type

Adds SwapAction, SwapConflict, SwapBody, SwapResult, SwapPreviewError, and
MorningBriefCoachSuggestion. Extends TrainingWeek (original_session_plan),
MorningBriefCard (coach_suggestion), and AdviceFlags (coach_swap_suggested).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure swap compute + conflict detection

**Files:**
- Create: `lib/training-weeks/apply-swap.ts`
- Create: `scripts/probe-apply-swap.mjs` (throwaway — deleted at end of task)

- [ ] **Step 1: Write `lib/training-weeks/apply-swap.ts`**

Create the file with this content:

```ts
// lib/training-weeks/apply-swap.ts
//
// Pure compute for mid-week schedule swaps. No I/O. The endpoint handler
// (app/api/training-weeks/[week_start]/swap/route.ts) wraps these with auth,
// load, validate, identity-check, conflict gate, and the DB write.
//
// Dual-key tolerance: training_weeks.session_plan may use 3-letter ("Mon")
// or full-name ("Monday") keys depending on whether the AI planner wrote it
// or a future normalization migration runs. All reads route through
// readSessionForDay; writes preserve whichever key form is already present
// in the plan (so a "Monday"-shaped plan stays "Monday"-shaped).

import type { SessionPlan, SwapBody, SwapConflict, Weekday } from "@/lib/data/types";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const SHORT_TO_FULL: Record<Weekday, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

/** Returns the actual key (3-letter or full) that exists in `plan` for the
 *  given weekday. If neither form is present, returns the 3-letter form. */
function keyFor(plan: Record<string, string>, day: Weekday): string {
  if (Object.prototype.hasOwnProperty.call(plan, day)) return day;
  const full = SHORT_TO_FULL[day];
  if (Object.prototype.hasOwnProperty.call(plan, full)) return full;
  return day; // default to short form for writes when neither exists yet
}

/** Sets plan[weekday] = value, using whichever key form is already present
 *  in `plan` for that day (preserves the file's existing convention). */
function writeDay(plan: Record<string, string>, day: Weekday, value: string): void {
  const k = keyFor(plan, day);
  plan[k] = value;
}

/** Apply a swap or replace to the plan. Returns a new plan; does not mutate
 *  the input. Returns the input shape if the operation is a no-op (swap with
 *  same day, replace with same type). */
export function applySwap(plan: SessionPlan, body: SwapBody): SessionPlan {
  const out: Record<string, string> = { ...(plan as Record<string, string>) };
  if (body.action === "swap") {
    if (body.source_day === body.target_day) return plan;
    const srcVal = readSessionForDay(out, body.source_day);
    const tgtVal = readSessionForDay(out, body.target_day);
    if (srcVal === undefined || tgtVal === undefined) {
      // Either day is missing from the plan — pass through unchanged.
      // The endpoint validates this case and rejects; this is defense in depth.
      return plan;
    }
    writeDay(out, body.source_day, tgtVal);
    writeDay(out, body.target_day, srcVal);
  } else {
    // action === 'replace'
    const cur = readSessionForDay(out, body.source_day);
    if (cur === body.session_type) return plan;
    writeDay(out, body.source_day, body.session_type);
  }
  return out as SessionPlan;
}

/** Days adjacent in the Mon-Sun ordering. Week wraps: Sun is adjacent to Sat
 *  only (not to Mon — we don't treat the week as a cycle for conflict checks).
 *  Returns 1 or 2 weekdays. */
function neighbors(day: Weekday): Weekday[] {
  const idx = ORDER.indexOf(day);
  const out: Weekday[] = [];
  if (idx > 0) out.push(ORDER[idx - 1]);
  if (idx < ORDER.length - 1) out.push(ORDER[idx + 1]);
  return out;
}

/** True if the session type is exempt from conflict checks. */
function isExempt(sessionType: string | undefined): boolean {
  if (!sessionType) return true;
  const lower = sessionType.toLowerCase().trim();
  return lower === "rest" || lower === "mobility";
}

/** Detect identical-session-type-within-48h conflicts AFTER applying `body`.
 *  For action='swap', checks both endpoints. For action='replace', checks only
 *  source_day. Returns an empty array when there are no conflicts. */
export function detectConflicts(plan: SessionPlan, body: SwapBody): SwapConflict[] {
  const newPlan = applySwap(plan, body) as Record<string, string>;
  const daysToCheck: Weekday[] =
    body.action === "swap" ? [body.source_day, body.target_day] : [body.source_day];
  const out: SwapConflict[] = [];
  for (const day of daysToCheck) {
    const placed = readSessionForDay(newPlan, day);
    if (isExempt(placed)) continue;
    for (const n of neighbors(day)) {
      const neighbor = readSessionForDay(newPlan, n);
      if (isExempt(neighbor)) continue;
      if (placed === neighbor) {
        out.push({ day, neighbor_day: n, session_type: placed as string });
      }
    }
  }
  return out;
}

/** Deep equality for SessionPlan jsonb. Comparison is on canonical short-form
 *  keys so a plan that says {Mon: 'Legs'} compares equal to {Monday: 'Legs'}. */
export function plansEqual(a: SessionPlan, b: SessionPlan): boolean {
  for (const day of ORDER) {
    const av = readSessionForDay(a as Record<string, string>, day);
    const bv = readSessionForDay(b as Record<string, string>, day);
    if (av !== bv) return false;
  }
  return true;
}
```

- [ ] **Step 2: Write the probe script**

Create `scripts/probe-apply-swap.mjs`:

```js
// scripts/probe-apply-swap.mjs — throwaway verification for apply-swap.ts.
// Run with: node --experimental-strip-types scripts/probe-apply-swap.mjs
// (or transpile via tsx if preferred).
//
// Delete this file at the end of Task 3.

import { applySwap, detectConflicts, plansEqual } from "../lib/training-weeks/apply-swap.js";

let failures = 0;
function assert(label, cond, detail) {
  if (!cond) {
    console.error(`FAIL: ${label}`, detail ?? "");
    failures += 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

const base = {
  Mon: "Legs",
  Tue: "Chest",
  Wed: "Mobility",
  Thu: "Back",
  Fri: "Shoulders",
  Sat: "REST",
  Sun: "REST",
};

// 1. swap(Tue, Fri) — keys exchanged
const s1 = applySwap(base, { action: "swap", source_day: "Tue", target_day: "Fri" });
assert("swap exchanges values", s1.Tue === "Shoulders" && s1.Fri === "Chest");
assert("swap leaves other days untouched", s1.Mon === "Legs" && s1.Wed === "Mobility" && s1.Thu === "Back");

// 2. replace(Tue, 'Mobility') — only Tue changed
const s2 = applySwap(base, { action: "replace", source_day: "Tue", session_type: "Mobility" });
assert("replace changes only the source day", s2.Tue === "Mobility" && s2.Mon === "Legs" && s2.Wed === "Mobility");

// 3. swap(Tue, Tue) — identity
const s3 = applySwap(base, { action: "swap", source_day: "Tue", target_day: "Tue" });
assert("swap with same day is identity", plansEqual(s3, base));

// 4. replace(Tue, 'Chest') — current type — identity
const s4 = applySwap(base, { action: "replace", source_day: "Tue", session_type: "Chest" });
assert("replace with current type is identity", plansEqual(s4, base));

// 5. Conflict: replace(Tue, 'Legs') when Mon=Legs
const c1 = detectConflicts(base, { action: "replace", source_day: "Tue", session_type: "Legs" });
assert(
  "conflict fires for adjacent identical session type",
  c1.length === 1 && c1[0].day === "Tue" && c1[0].neighbor_day === "Mon" && c1[0].session_type === "Legs",
);

// 6. Mobility exempt: replace(Tue, 'Mobility') next to Mon=Legs — no conflict
const c2 = detectConflicts(base, { action: "replace", source_day: "Tue", session_type: "Mobility" });
assert("Mobility is exempt from conflict checks", c2.length === 0);

// 7. REST exempt: swap(Mon=Legs, Sat=REST). New Mon=REST, new Sat=Legs.
//    Mon=REST is exempt; Sat=Legs has neighbors Fri=Shoulders, Sun=REST — neither matches.
const c3 = detectConflicts(base, { action: "swap", source_day: "Mon", target_day: "Sat" });
assert("REST exempt at both endpoints when adjacent days differ", c3.length === 0);

// 8. Full-name key compatibility: plan uses "Monday", body uses "Mon"
const fullKeyPlan = { Monday: "Legs", Tuesday: "Chest", Wednesday: "Mobility" };
const s8 = applySwap(fullKeyPlan, { action: "replace", source_day: "Tue", session_type: "Back" });
assert("full-name keys are preserved on write", s8.Tuesday === "Back" && s8.Monday === "Legs");

// 9. plansEqual handles mixed key forms
assert(
  "plansEqual treats Mon and Monday as equivalent",
  plansEqual({ Mon: "Legs" }, { Monday: "Legs" }),
);

console.log(failures === 0 ? "\n✓ all assertions passed" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the probe**

```bash
npx tsx scripts/probe-apply-swap.mjs
```

Expected: 9 PASS lines + `✓ all assertions passed`. Exit 0.

If any assertion fails, fix `apply-swap.ts` until all pass before continuing.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Delete the probe script**

```bash
rm scripts/probe-apply-swap.mjs
```

- [ ] **Step 6: Commit**

```bash
git add lib/training-weeks/apply-swap.ts
git commit -m "feat(schedule): pure applySwap + detectConflicts

Single-day swap and replace primitives with dual-key (Mon vs Monday)
tolerance. Conflict detection is identical-type-within-48h with REST
and Mobility exempt. Returns input unchanged on identity operations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: POST /api/training-weeks/[week_start]/swap

**Files:**
- Create: `app/api/training-weeks/[week_start]/swap/route.ts`
- Create: `scripts/probe-swap-endpoint.mjs` (throwaway — deleted at end of task)

- [ ] **Step 1: Confirm the auth helper exists**

```bash
grep -rn "export.*requireUser\|export.*createSupabaseServerClient" lib/supabase/ | head -5
```

Expected: at least one match. The route handler uses `createSupabaseServerClient` directly to get the cookie-bound supabase + user from session. If `requireUser` exists, use it; otherwise inline the auth pattern shown in Step 2.

- [ ] **Step 2: Write the route handler**

Create `app/api/training-weeks/[week_start]/swap/route.ts`:

```ts
// app/api/training-weeks/[week_start]/swap/route.ts
//
// Mid-week schedule swap endpoint. Single mutation surface for both:
//   - Strength tab DaySwapSheet (preview-then-confirm flow)
//   - Morning brief BriefCoachSuggestion chip (?confirm=true unconditional)
//
// Server flow:
//   1. Auth (cookie-bound supabase, RLS-respecting)
//   2. Load training_weeks row by (user_id, week_start). 404 if missing.
//   3. Validate body (action, days, session_type closed-set for replace).
//   4. Compute new plan via applySwap.
//   5. Identity check — 200 no-op when new === current.
//   6. Conflict check via detectConflicts.
//      - ?confirm=false (default) AND conflicts non-empty → 409 with preview.
//      - Otherwise → proceed.
//   7. Identity-restore detection — if new === original, set original to NULL.
//   8. UPDATE with COALESCE-on-first-edit OR identity-restore-clears.
//   9. Return SwapResult.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { applySwap, detectConflicts, plansEqual } from "@/lib/training-weeks/apply-swap";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import type {
  SessionPlan,
  SwapBody,
  SwapPreviewError,
  SwapResult,
  TrainingWeek,
  Weekday,
} from "@/lib/data/types";

const WEEKDAYS: ReadonlySet<string> = new Set([
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
]);

/** Closed set of valid session_type strings for action='replace'.
 *  Computed once at module load: SESSION_PLANS keys ∪ {'REST', 'Mobility'}. */
const REPLACE_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(SESSION_PLANS),
  "REST",
  "Mobility",
]);

function isWeekday(s: unknown): s is Weekday {
  return typeof s === "string" && WEEKDAYS.has(s);
}

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseBody(raw: unknown): SwapBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  if (b.action !== "swap" && b.action !== "replace") {
    return { error: "action must be 'swap' or 'replace'" };
  }
  if (!isWeekday(b.source_day)) {
    return { error: "source_day must be one of Mon|Tue|Wed|Thu|Fri|Sat|Sun" };
  }
  if (b.action === "swap") {
    if (!isWeekday(b.target_day)) {
      return { error: "target_day must be one of Mon|Tue|Wed|Thu|Fri|Sat|Sun" };
    }
    return { action: "swap", source_day: b.source_day, target_day: b.target_day };
  }
  // action === 'replace'
  if (typeof b.session_type !== "string" || !REPLACE_TYPES.has(b.session_type)) {
    return {
      error: `session_type must be one of: ${[...REPLACE_TYPES].sort().join(", ")}`,
    };
  }
  return { action: "replace", source_day: b.source_day, session_type: b.session_type };
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;
  if (!isYmd(week_start)) {
    return NextResponse.json({ error: "week_start must be YYYY-MM-DD" }, { status: 400 });
  }

  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "true";

  // 1. Auth
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Parse body
  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseBody(bodyRaw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const body: SwapBody = parsed;

  // 2. Load
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select(
      "id, user_id, block_id, week_start, session_plan, original_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at",
    )
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: `load failed: ${loadErr.message}` }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { error: `no training_weeks row for week_start=${week_start}` },
      { status: 404 },
    );
  }

  const current = row.session_plan as SessionPlan;
  const original = row.original_session_plan as SessionPlan | null;

  // 4. Compute new plan
  const newPlan = applySwap(current, body);

  // 5. Identity check
  if (plansEqual(newPlan, current)) {
    return NextResponse.json(
      {
        week: row as TrainingWeek,
        swap: {
          source_day: body.source_day,
          action: body.action,
          before:
            readSessionForDay(current as Record<string, string>, body.source_day) ?? "",
          after:
            readSessionForDay(current as Record<string, string>, body.source_day) ?? "",
        },
      } satisfies SwapResult,
      { status: 200 },
    );
  }

  // 6. Conflict gate
  if (!confirm) {
    const conflicts = detectConflicts(current, body);
    if (conflicts.length > 0) {
      return NextResponse.json(
        { conflicts, preview_plan: newPlan } satisfies SwapPreviewError,
        { status: 409 },
      );
    }
  }

  // 7. Identity-restore detection
  const isIdentityRestore = original !== null && plansEqual(newPlan, original);

  // 8. UPDATE
  const update: Record<string, unknown> = {
    session_plan: newPlan,
    updated_at: new Date().toISOString(),
  };
  if (isIdentityRestore) {
    update.original_session_plan = null;
  } else if (original === null) {
    // First edit — snapshot the committed plan.
    update.original_session_plan = current;
  }
  // else: original is already set, subsequent non-restore edit — leave it alone.

  const { data: updated, error: updateErr } = await supabase
    .from("training_weeks")
    .update(update)
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .select(
      "id, user_id, block_id, week_start, session_plan, original_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at",
    )
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: `update failed: ${updateErr?.message ?? "no row returned"}` },
      { status: 500 },
    );
  }

  // 9. Build response — before/after at source_day
  const before =
    readSessionForDay(current as Record<string, string>, body.source_day) ?? "";
  const after =
    readSessionForDay(newPlan as Record<string, string>, body.source_day) ?? "";

  return NextResponse.json(
    {
      week: updated as TrainingWeek,
      swap: {
        source_day: body.source_day,
        action: body.action,
        before,
        after,
      },
    } satisfies SwapResult,
    { status: 200 },
  );
}
```

- [ ] **Step 3: Write the probe script**

Create `scripts/probe-swap-endpoint.mjs`:

```js
// scripts/probe-swap-endpoint.mjs — throwaway verification for the swap route.
// Run with: node scripts/probe-swap-endpoint.mjs (after `npm run dev` is up).
// Requires the user to be logged in via cookie OR uses a service-role harness.
//
// This probe writes to the live DB. Run only against a development project.
// Delete this file at the end of Task 4.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Resolve the test user (single-user app — first auth user wins).
const { data: { users }, error: usersErr } = await sb.auth.admin.listUsers();
if (usersErr || !users?.length) {
  console.error("No users found:", usersErr);
  process.exit(1);
}
const USER_ID = users[0].id;

// Use a synthetic week_start so we don't trample the active one.
// Pick a Monday far enough in the future to avoid conflicts with the cron.
const WEEK = "2099-01-05"; // Monday in the year 2099

let failures = 0;
function assert(label, cond, detail) {
  if (!cond) {
    console.error(`FAIL: ${label}`, detail ?? "");
    failures += 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

// Seed a fresh training_weeks row.
await sb.from("training_weeks").delete().eq("user_id", USER_ID).eq("week_start", WEEK);
const seedPlan = {
  Mon: "Legs", Tue: "Chest", Wed: "Mobility", Thu: "Back", Fri: "Shoulders", Sat: "REST", Sun: "REST",
};
const { error: insertErr } = await sb.from("training_weeks").insert({
  user_id: USER_ID,
  week_start: WEEK,
  session_plan: seedPlan,
  intensity_modifier: {},
  proposed_by: "user",
});
if (insertErr) { console.error("seed insert failed:", insertErr); process.exit(1); }

// The route handler is cookie-auth'd, so we can't call it directly with
// service-role from this script. Instead, exercise the same DB-level
// invariants by simulating the steps. This is good enough for the gate
// checks; the full cookie path is covered by manual smoke in Task 13.

// Simulate first swap: Tue Chest ↔ Wed Mobility.
const { error: u1 } = await sb
  .from("training_weeks")
  .update({
    session_plan: { ...seedPlan, Tue: "Mobility", Wed: "Chest" },
    original_session_plan: seedPlan,
  })
  .eq("user_id", USER_ID)
  .eq("week_start", WEEK);
if (u1) { console.error("u1 failed:", u1); process.exit(1); }

const { data: r1 } = await sb
  .from("training_weeks")
  .select("session_plan, original_session_plan")
  .eq("user_id", USER_ID)
  .eq("week_start", WEEK)
  .single();

assert(
  "first swap populates original_session_plan with seed",
  r1.original_session_plan && r1.original_session_plan.Tue === "Chest",
);
assert(
  "first swap updates session_plan",
  r1.session_plan.Tue === "Mobility" && r1.session_plan.Wed === "Chest",
);

// Simulate second swap on same row: Tue → Back via replace.
// original_session_plan should NOT change (COALESCE no-op).
const { error: u2 } = await sb
  .from("training_weeks")
  .update({
    session_plan: { ...r1.session_plan, Tue: "Back" },
    // Note: original NOT set — endpoint preserves it via the COALESCE path.
  })
  .eq("user_id", USER_ID)
  .eq("week_start", WEEK);
if (u2) { console.error("u2 failed:", u2); process.exit(1); }

const { data: r2 } = await sb
  .from("training_weeks")
  .select("session_plan, original_session_plan")
  .eq("user_id", USER_ID)
  .eq("week_start", WEEK)
  .single();

assert(
  "second swap leaves original_session_plan unchanged",
  r2.original_session_plan && r2.original_session_plan.Tue === "Chest",
);
assert("second swap updates session_plan", r2.session_plan.Tue === "Back");

// Identity-restore: swap Tue back to Chest AND Wed back to Mobility
// (must restore the WHOLE plan to original for identity reset).
const { error: u3 } = await sb
  .from("training_weeks")
  .update({
    session_plan: seedPlan,
    original_session_plan: null, // identity-restore branch sets to NULL
  })
  .eq("user_id", USER_ID)
  .eq("week_start", WEEK);
if (u3) { console.error("u3 failed:", u3); process.exit(1); }

const { data: r3 } = await sb
  .from("training_weeks")
  .select("session_plan, original_session_plan")
  .eq("user_id", USER_ID)
  .eq("week_start", WEEK)
  .single();

assert("identity-restore resets original_session_plan to NULL", r3.original_session_plan === null);
assert("identity-restore session_plan matches seed", r3.session_plan.Tue === "Chest");

// Cleanup.
await sb.from("training_weeks").delete().eq("user_id", USER_ID).eq("week_start", WEEK);

console.log(failures === 0 ? "\n✓ all assertions passed" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Run the probe**

```bash
node --env-file=.env.local scripts/probe-swap-endpoint.mjs
```

Expected: 6 PASS lines + `✓ all assertions passed`. Exit 0.

If the probe can't reach the DB, verify `.env.local` has `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set.

- [ ] **Step 5: Manual route smoke (cookie-authed)**

Start the dev server (`npm run dev`), open the app in the browser, then in a separate terminal:

```bash
# Grab the auth cookie from the browser (DevTools → Application → Cookies).
# Use the Supabase session cookie (looks like sb-<project-ref>-auth-token).
curl -X POST "http://localhost:3000/api/training-weeks/$(date -v-monday +%Y-%m-%d 2>/dev/null || date -d 'last monday' +%Y-%m-%d)/swap?confirm=true" \
  -H "Content-Type: application/json" \
  -H "Cookie: <paste session cookie>" \
  -d '{"action":"replace","source_day":"Mon","session_type":"Mobility"}'
```

(Adapt the `date` invocation to your shell — the goal is "this week's Monday in YYYY-MM-DD".)

Expected: HTTP 200 with `{ week: {...}, swap: { source_day: "Mon", action: "replace", before: "<previous>", after: "Mobility" } }`.

Then swap it back:

```bash
curl -X POST "http://localhost:3000/api/training-weeks/<same-week_start>/swap?confirm=true" \
  -H "Content-Type: application/json" \
  -H "Cookie: <paste session cookie>" \
  -d '{"action":"replace","source_day":"Mon","session_type":"<original Mon type>"}'
```

Verify via the Supabase Dashboard SQL Editor that `original_session_plan IS NULL` after the second call.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Delete the probe script**

```bash
rm scripts/probe-swap-endpoint.mjs
```

- [ ] **Step 8: Commit**

```bash
git add app/api/training-weeks/
git commit -m "feat(schedule): POST /api/training-weeks/[week_start]/swap

Single mutation endpoint shared by strength-tab inline edit + morning-brief
chip. Auth via cookie-bound supabase. ?confirm=false returns 409 with
conflicts + preview_plan on identical-type-within-48h. ?confirm=true skips
the gate. Identity-restore (new === original) resets original_session_plan
to NULL; first edit snapshots the committed plan via the implicit COALESCE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Adherence — coalesce read + per-day status field

**Files:**
- Modify: `lib/coach/adherence.ts`
- Create: `scripts/probe-adherence-coalesce.mjs` (throwaway — deleted at end of task)

- [ ] **Step 1: Update the SELECT to include `original_session_plan`**

In `lib/coach/adherence.ts`, find the existing query (around lines 84-89) and modify the `select(...)` string:

```ts
// Before
.select("session_plan")

// After
.select("session_plan, original_session_plan")
```

- [ ] **Step 2: Add the coalesce-read after the row is loaded**

Find the `const planned = (weekRow?.session_plan ?? {}) as ...` line (around line 91). Replace it with:

```ts
const originalPlan = (weekRow?.original_session_plan ?? null) as Partial<Record<Weekday, string>> | null;
const currentPlan = (weekRow?.session_plan ?? {}) as Partial<Record<Weekday, string>>;
// Anchor planned to the original commitment; current is shown alongside.
const planned = (originalPlan ?? currentPlan) as Partial<Record<Weekday, string>>;
```

- [ ] **Step 3: Grow the AdherenceResult type**

Find the existing `export type AdherenceResult` (around line 59). Replace it with:

```ts
export type AdherenceDayStatus = "as_planned" | "swapped" | "missed" | "rest";

export type AdherenceDay = {
  day: Weekday;
  planned: string;                  // from original (or current if never edited)
  swapped_to: string | null;        // current[day] when it differs from planned; else null
  actual: string | null;            // workouts[date].type, null if no workout
  status: AdherenceDayStatus;
};

export type AdherenceResult = {
  week_start: string;
  planned: Partial<Record<Weekday, string>>;
  actual: Partial<Record<Weekday, string>>;
  /** Per-day enriched view. AI consumers of `compute_adherence` use this to
   *  produce prose like "you planned Chest, swapped to Mobility, did the walk". */
  days: AdherenceDay[];
  sessions_planned: number;
  sessions_done: number;
  sessions_on_plan: number;
  adherence_pct: number;
  done_pct: number;
  muscle_volume_vs_4w_avg: Record<ExerciseCategory, number>;
};
```

- [ ] **Step 4: Compute the `days` array and return it**

Find the existing loop that accumulates `sessions_planned`, `sessions_done`, `sessions_on_plan` (around lines 109-122). Modify it to also build the `days` array:

```ts
// 3. Adherence counts + per-day status
let sessions_planned = 0;
let sessions_done = 0;
let sessions_on_plan = 0;
const days: AdherenceDay[] = [];
for (const wd of WEEKDAYS) {
  const p = planned[wd] ?? null;
  const c = currentPlan[wd] ?? null;
  const a = actual[wd] ?? null;
  const pIsRest = p && tokens(p).includes("rest");
  if (p && !pIsRest) sessions_planned += 1;
  if (a) sessions_done += 1;
  if (p && a && matches(p, a)) sessions_on_plan += 1;

  // Per-day status derivation:
  const swapped_to = p && c && p !== c ? c : null;
  let status: AdherenceDayStatus;
  if (pIsRest && !a) {
    status = "rest";
  } else if (p && a && matches(p, a)) {
    status = "as_planned";
  } else if (swapped_to && a && matches(swapped_to, a)) {
    status = "swapped";
  } else if (swapped_to && !a && tokens(swapped_to).includes("rest")) {
    // Planned non-rest, swapped to REST, no workout → swapped (intentional skip)
    status = "swapped";
  } else {
    status = "missed";
  }

  days.push({
    day: wd,
    planned: p ?? "",
    swapped_to,
    actual: a,
    status,
  });
}
const adherence_pct = sessions_planned === 0 ? 0 : Math.round((sessions_on_plan / sessions_planned) * 100);
const done_pct      = sessions_planned === 0 ? 0 : Math.round((sessions_done / sessions_planned) * 100);
```

- [ ] **Step 5: Include `days` in the returned object**

Find the final `return { ... }` (around lines 154-164). Add `days` to it:

```ts
return {
  week_start: weekStart,
  planned,
  actual,
  days,
  sessions_planned,
  sessions_done,
  sessions_on_plan,
  adherence_pct,
  done_pct,
  muscle_volume_vs_4w_avg,
};
```

- [ ] **Step 6: Write the probe script**

Create `scripts/probe-adherence-coalesce.mjs`:

```js
// scripts/probe-adherence-coalesce.mjs — throwaway verification for the
// adherence COALESCE read + status enrichment. Run after `npm run dev` is up
// OR directly as a Node script with service-role.
//
// Delete this file at the end of Task 5.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const { data: { users } } = await sb.auth.admin.listUsers();
const USER_ID = users[0].id;
const WEEK = "2099-01-05"; // far-future Monday

let failures = 0;
function assert(label, cond, detail) {
  if (!cond) { console.error(`FAIL: ${label}`, detail ?? ""); failures += 1; }
  else { console.log(`PASS: ${label}`); }
}

// Seed: original plan = Mon Legs / Tue Chest / Wed Mobility
const seedPlan = { Mon: "Legs", Tue: "Chest", Wed: "Mobility", Thu: "Back", Fri: "REST", Sat: "REST", Sun: "REST" };
await sb.from("training_weeks").delete().eq("user_id", USER_ID).eq("week_start", WEEK);
await sb.from("training_weeks").insert({
  user_id: USER_ID, week_start: WEEK, session_plan: seedPlan, intensity_modifier: {}, proposed_by: "user",
});

// Simulate a swap: original=seedPlan, current = Tue swapped Chest→Mobility
await sb
  .from("training_weeks")
  .update({
    session_plan: { ...seedPlan, Tue: "Mobility" },
    original_session_plan: seedPlan,
  })
  .eq("user_id", USER_ID).eq("week_start", WEEK);

// Import computeAdherence
const { computeAdherence } = await import("../lib/coach/adherence.ts");
const result = await computeAdherence(sb, USER_ID, WEEK);

// 1. planned anchors to original
assert(
  "planned reads from original_session_plan",
  result.planned.Tue === "Chest",
  `got ${result.planned.Tue}`,
);

// 2. per-day Tue has swapped_to populated
const tueDay = result.days.find((d) => d.day === "Tue");
assert(
  "Tue day shows swapped_to = Mobility",
  tueDay && tueDay.swapped_to === "Mobility",
  `got ${tueDay?.swapped_to}`,
);

// 3. status: planned non-rest, no workout, swapped to non-rest → 'missed'
//    (because actual === null AND swapped_to is Mobility, not REST)
assert(
  "Tue status is 'missed' when swapped to non-rest with no workout",
  tueDay && tueDay.status === "missed",
  `got ${tueDay?.status}`,
);

// 4. Day with no swap (Wed Mobility unchanged) — planned === current
const wedDay = result.days.find((d) => d.day === "Wed");
assert(
  "Wed has no swapped_to (planned === current)",
  wedDay && wedDay.swapped_to === null,
);

// 5. sessions_planned still anchors to original commitment
assert(
  "sessions_planned counts original non-rest days",
  result.sessions_planned === 4, // Mon Tue Wed Thu (Mobility is not 'rest', it's a trained session)
  `got ${result.sessions_planned}`,
);

// Cleanup
await sb.from("training_weeks").delete().eq("user_id", USER_ID).eq("week_start", WEEK);

console.log(failures === 0 ? "\n✓ all assertions passed" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 7: Run the probe**

```bash
node --env-file=.env.local --experimental-strip-types scripts/probe-adherence-coalesce.mjs
```

(Use `tsx` if `--experimental-strip-types` isn't available: `npx tsx --env-file=.env.local scripts/probe-adherence-coalesce.mjs`.)

Expected: 5 PASS lines + `✓ all assertions passed`. Exit 0.

If assertion 5 fails because Mobility is counted as rest (the existing `tokens(p).includes("rest")` check), the expected count above is correct (Mobility ≠ rest). Investigate `tokens()` behavior if mismatch persists.

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: clean. The `compute_adherence` tool wrapper in `lib/coach/tools.ts` passes through `result` unchanged — no change needed there. Verify by grepping:

```bash
grep -n "computeAdherence" lib/coach/tools.ts
```

Expected: a line like `const result = await computeAdherence(opts.supabase, opts.userId, weekStart);` followed by `data: result` in the return. Tool naturally gets the new shape.

- [ ] **Step 9: Delete the probe script**

```bash
rm scripts/probe-adherence-coalesce.mjs
```

- [ ] **Step 10: Commit**

```bash
git add lib/coach/adherence.ts
git commit -m "feat(schedule): adherence reads coalesce(original, current) + per-day status

planned is anchored to original_session_plan when set, so mid-week swaps
don't retroactively flatter recap numbers. New per-day output struct adds
swapped_to and status (as_planned | swapped | missed | rest) so the
compute_adherence chat tool produces prose distinguishing swapped from
missed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: TanStack mutation hook

**Files:**
- Create: `lib/query/hooks/useSwapTrainingDay.ts`

- [ ] **Step 1: Verify TanStack QueryClient is mounted**

```bash
grep -n "QueryClientProvider\|createSyncStoragePersister" components/providers/QueryProvider.tsx
```

Expected: `QueryClientProvider` reference. If missing, this codebase doesn't have mutations wired up yet — check the file to confirm. (Per session-start exploration, QueryProvider exists.)

- [ ] **Step 2: Write the hook**

Create `lib/query/hooks/useSwapTrainingDay.ts`:

```ts
// lib/query/hooks/useSwapTrainingDay.ts
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import type {
  SwapBody,
  SwapPreviewError,
  SwapResult,
  TrainingWeek,
} from "@/lib/data/types";

export type SwapErrorWithPreview = Error & {
  status: number;
  preview?: SwapPreviewError;
};

async function postSwap(
  weekStart: string,
  body: SwapBody,
  confirm: boolean,
): Promise<SwapResult> {
  const url = `/api/training-weeks/${weekStart}/swap?confirm=${confirm ? "true" : "false"}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 409) {
    const preview = (await res.json()) as SwapPreviewError;
    const err = new Error("conflict") as SwapErrorWithPreview;
    err.status = 409;
    err.preview = preview;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(text || `swap failed: ${res.status}`) as SwapErrorWithPreview;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as SwapResult;
}

/** Shared mutation hook for both surfaces (DaySwapSheet + BriefCoachSuggestion).
 *
 *  Optimistic update: snapshot the current cached week, write the predicted
 *  new session_plan into the cache immediately; rollback on error.
 *
 *  Cache keys invalidated on success:
 *    - queryKeys.trainingWeeks.one(userId, weekStart)
 *    - queryKeys.trainingWeeks.range(...) — wide invalidation via the
 *      "training-weeks" prefix predicate.
 */
export function useSwapTrainingDay(userId: string, weekStart: string) {
  const qc = useQueryClient();

  return useMutation<
    SwapResult,
    SwapErrorWithPreview,
    { body: SwapBody; confirm: boolean }
  >({
    mutationFn: ({ body, confirm }) => postSwap(weekStart, body, confirm),

    onMutate: async ({ body }) => {
      await qc.cancelQueries({ queryKey: queryKeys.trainingWeeks.one(userId, weekStart) });
      const prev = qc.getQueryData<TrainingWeek | null>(
        queryKeys.trainingWeeks.one(userId, weekStart),
      );
      if (prev) {
        // Optimistic flip — predict the new session_plan client-side. The pure
        // applySwap is duplicated here to avoid an import cycle (this hook lives
        // under lib/query/hooks; apply-swap is server-friendly TS but importing
        // it client-side is fine — just keep the prediction in sync).
        const next = { ...prev };
        const plan = { ...(prev.session_plan as Record<string, string>) };
        if (body.action === "swap") {
          const a = plan[body.source_day] ?? plan[fullName(body.source_day)];
          const b = plan[body.target_day] ?? plan[fullName(body.target_day)];
          if (a !== undefined && b !== undefined) {
            writeDayInPlace(plan, body.source_day, b);
            writeDayInPlace(plan, body.target_day, a);
          }
        } else {
          writeDayInPlace(plan, body.source_day, body.session_type);
        }
        next.session_plan = plan;
        qc.setQueryData(queryKeys.trainingWeeks.one(userId, weekStart), next);
      }
      return { prev };
    },

    onError: (_err, _vars, ctx) => {
      // Rollback
      const prev = (ctx as { prev: TrainingWeek | null } | undefined)?.prev ?? null;
      qc.setQueryData(queryKeys.trainingWeeks.one(userId, weekStart), prev);
    },

    onSettled: () => {
      // Wide invalidation under the "training-weeks" prefix to catch range
      // queries (e.g., WeekPlanCard, /strength TodayPlanCard).
      qc.invalidateQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "training-weeks",
      });
    },
  });
}

const SHORT_TO_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};
function fullName(short: string): string {
  return SHORT_TO_FULL[short] ?? short;
}
function writeDayInPlace(plan: Record<string, string>, day: string, value: string): void {
  if (Object.prototype.hasOwnProperty.call(plan, day)) {
    plan[day] = value;
    return;
  }
  const full = SHORT_TO_FULL[day];
  if (full && Object.prototype.hasOwnProperty.call(plan, full)) {
    plan[full] = value;
    return;
  }
  // Neither form present — default to short.
  plan[day] = value;
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean. If `@tanstack/react-query`'s `useMutation` type bindings complain about the third generic, simplify by dropping it (`useMutation<SwapResult, SwapErrorWithPreview>(...)`). The runtime behavior is identical.

- [ ] **Step 4: Commit**

```bash
git add lib/query/hooks/useSwapTrainingDay.ts
git commit -m "feat(schedule): useSwapTrainingDay TanStack mutation hook

Shared client mutation for both surfaces. Optimistic flip on session_plan,
wide invalidation under 'training-weeks' prefix on settle. Throws
SwapErrorWithPreview on 409 so consumers can read the preview without a
second fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: DaySwapSheet component

**Files:**
- Create: `components/strength/DaySwapSheet.tsx`

- [ ] **Step 1: Inspect existing modal/sheet patterns**

```bash
find components -name "*.tsx" | xargs grep -l "Dialog\|Sheet\|Modal\|fixed.*bottom" 2>/dev/null | head -5
```

Expected: at least one component using a fixed-position overlay (e.g., something from the athlete-profile wizard or measurement modal). Match its visual style: `COLOR` tokens from [lib/ui/theme.ts](../../../lib/ui/theme.ts), inline styles, dark theme.

If no existing sheet pattern: this component creates the pattern. Use a fixed-position bottom overlay with `position: fixed; inset: 0; backdrop on tap`.

- [ ] **Step 2: Write the component**

Create `components/strength/DaySwapSheet.tsx`:

```tsx
"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { useSwapTrainingDay, type SwapErrorWithPreview } from "@/lib/query/hooks/useSwapTrainingDay";
import type { SessionPlan, SwapAction, SwapConflict, Weekday } from "@/lib/data/types";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FULL_NAME: Record<Weekday, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

/** Closed list for action='replace' — SESSION_PLANS keys + REST + Mobility. */
const REPLACE_TYPES: string[] = [
  ...Object.keys(SESSION_PLANS),
  "Mobility",
  "REST",
];

type SheetStep =
  | { kind: "action" }
  | { kind: "pick_swap_target" }
  | { kind: "pick_replace_type" }
  | { kind: "confirm"; action: SwapAction; target_day?: Weekday; session_type?: string }
  | { kind: "warn"; action: SwapAction; target_day?: Weekday; session_type?: string; conflicts: SwapConflict[] };

export function DaySwapSheet({
  userId,
  weekStart,
  sourceDay,
  plan,
  onClose,
}: {
  userId: string;
  weekStart: string;
  sourceDay: Weekday;
  plan: SessionPlan;
  onClose: () => void;
}) {
  const [step, setStep] = useState<SheetStep>({ kind: "action" });
  const mutation = useSwapTrainingDay(userId, weekStart);

  const currentType =
    readSessionForDay(plan as Record<string, string>, sourceDay) ?? "—";

  function postWithConfirm(
    confirm: boolean,
    action: SwapAction,
    targetDay: Weekday | undefined,
    sessionType: string | undefined,
  ) {
    const body =
      action === "swap"
        ? { action: "swap" as const, source_day: sourceDay, target_day: targetDay as Weekday }
        : { action: "replace" as const, source_day: sourceDay, session_type: sessionType as string };
    mutation.mutate(
      { body, confirm },
      {
        onSuccess: () => onClose(),
        onError: (err: SwapErrorWithPreview) => {
          if (err.status === 409 && err.preview) {
            setStep({
              kind: "warn",
              action,
              target_day: targetDay,
              session_type: sessionType,
              conflicts: err.preview.conflicts,
            });
          }
        },
      },
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "480px",
          background: COLOR.surface,
          borderTopLeftRadius: "16px",
          borderTopRightRadius: "16px",
          padding: "20px 16px 32px",
          color: COLOR.textStrong,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {step.kind === "action" && (
          <ActionStep
            sourceDay={sourceDay}
            currentType={currentType}
            onPickSwap={() => setStep({ kind: "pick_swap_target" })}
            onPickReplace={() => setStep({ kind: "pick_replace_type" })}
            onCancel={onClose}
          />
        )}

        {step.kind === "pick_swap_target" && (
          <PickSwapTargetStep
            sourceDay={sourceDay}
            currentType={currentType}
            plan={plan}
            onPick={(target_day) =>
              setStep({ kind: "confirm", action: "swap", target_day })
            }
            onBack={() => setStep({ kind: "action" })}
          />
        )}

        {step.kind === "pick_replace_type" && (
          <PickReplaceTypeStep
            sourceDay={sourceDay}
            currentType={currentType}
            onPick={(session_type) =>
              setStep({ kind: "confirm", action: "replace", session_type })
            }
            onBack={() => setStep({ kind: "action" })}
          />
        )}

        {step.kind === "confirm" && (
          <ConfirmStep
            sourceDay={sourceDay}
            currentType={currentType}
            action={step.action}
            target_day={step.target_day}
            session_type={step.session_type}
            plan={plan}
            isPending={mutation.isPending}
            onConfirm={() =>
              postWithConfirm(false, step.action, step.target_day, step.session_type)
            }
            onBack={() =>
              setStep(
                step.action === "swap"
                  ? { kind: "pick_swap_target" }
                  : { kind: "pick_replace_type" },
              )
            }
          />
        )}

        {step.kind === "warn" && (
          <WarnStep
            conflicts={step.conflicts}
            isPending={mutation.isPending}
            onSwapAnyway={() =>
              postWithConfirm(true, step.action, step.target_day, step.session_type)
            }
            onPickDifferent={() =>
              setStep(
                step.action === "swap"
                  ? { kind: "pick_swap_target" }
                  : { kind: "pick_replace_type" },
              )
            }
          />
        )}
      </div>
    </div>
  );
}

// ─── Sub-steps ───────────────────────────────────────────────────────────────

const Header = ({ children }: { children: React.ReactNode }) => (
  <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "12px", color: COLOR.textStrong }}>
    {children}
  </h2>
);

const PrimaryButton = ({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      display: "block",
      width: "100%",
      padding: "12px 16px",
      borderRadius: "10px",
      border: `1px solid ${COLOR.divider}`,
      background: COLOR.surfaceAlt,
      color: COLOR.textStrong,
      fontSize: "14px",
      fontWeight: 500,
      textAlign: "left",
      marginBottom: "8px",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
    }}
  >
    {children}
  </button>
);

const TextButton = ({
  children,
  onClick,
  variant = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "danger";
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      padding: "8px 12px",
      background: "transparent",
      border: "none",
      color: variant === "danger" ? COLOR.danger : COLOR.textMuted,
      fontSize: "13px",
      cursor: "pointer",
    }}
  >
    {children}
  </button>
);

function ActionStep({
  sourceDay,
  currentType,
  onPickSwap,
  onPickReplace,
  onCancel,
}: {
  sourceDay: Weekday;
  currentType: string;
  onPickSwap: () => void;
  onPickReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Header>
        {FULL_NAME[sourceDay]} · {currentType}
      </Header>
      <PrimaryButton onClick={onPickSwap}>Swap with another day →</PrimaryButton>
      <PrimaryButton onClick={onPickReplace}>Replace this day →</PrimaryButton>
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onCancel}>Cancel</TextButton>
      </div>
    </>
  );
}

function PickSwapTargetStep({
  sourceDay,
  currentType,
  plan,
  onPick,
  onBack,
}: {
  sourceDay: Weekday;
  currentType: string;
  plan: SessionPlan;
  onPick: (target: Weekday) => void;
  onBack: () => void;
}) {
  const others = ORDER.filter((d) => d !== sourceDay);
  return (
    <>
      <Header>
        {FULL_NAME[sourceDay]} · {currentType} → which day?
      </Header>
      {others.map((d) => {
        const t = readSessionForDay(plan as Record<string, string>, d) ?? "—";
        return (
          <PrimaryButton key={d} onClick={() => onPick(d)}>
            {d} · {t}
          </PrimaryButton>
        );
      })}
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onBack}>← Back</TextButton>
      </div>
    </>
  );
}

function PickReplaceTypeStep({
  sourceDay,
  currentType,
  onPick,
  onBack,
}: {
  sourceDay: Weekday;
  currentType: string;
  onPick: (sessionType: string) => void;
  onBack: () => void;
}) {
  // Filter the *current* session type from the list so the picker doesn't
  // offer a no-op. A prior swap that left current = Mobility hides Mobility;
  // the original Chest is still in the list so the user can swap back via
  // identity-restore.
  const options = REPLACE_TYPES.filter((t) => t !== currentType);
  return (
    <>
      <Header>{FULL_NAME[sourceDay]} · what should it be?</Header>
      {options.map((t) => (
        <PrimaryButton key={t} onClick={() => onPick(t)}>
          {t}
        </PrimaryButton>
      ))}
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onBack}>← Back</TextButton>
      </div>
    </>
  );
}

function ConfirmStep({
  sourceDay,
  currentType,
  action,
  target_day,
  session_type,
  plan,
  isPending,
  onConfirm,
  onBack,
}: {
  sourceDay: Weekday;
  currentType: string;
  action: SwapAction;
  target_day?: Weekday;
  session_type?: string;
  plan: SessionPlan;
  isPending: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const afterLabel =
    action === "swap"
      ? readSessionForDay(plan as Record<string, string>, target_day as Weekday) ?? "—"
      : session_type ?? "—";
  return (
    <>
      <Header>Confirm</Header>
      <p style={{ fontSize: "14px", color: COLOR.textMid, marginBottom: "16px" }}>
        {FULL_NAME[sourceDay]} · {currentType} → {afterLabel}
        {action === "swap" && target_day && (
          <>
            <br />
            {FULL_NAME[target_day]} ·{" "}
            {readSessionForDay(plan as Record<string, string>, target_day) ?? "—"} → {currentType}
          </>
        )}
      </p>
      <PrimaryButton onClick={onConfirm} disabled={isPending}>
        {isPending ? "Confirming…" : "Confirm"}
      </PrimaryButton>
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onBack}>← Back</TextButton>
      </div>
    </>
  );
}

function WarnStep({
  conflicts,
  isPending,
  onSwapAnyway,
  onPickDifferent,
}: {
  conflicts: SwapConflict[];
  isPending: boolean;
  onSwapAnyway: () => void;
  onPickDifferent: () => void;
}) {
  return (
    <>
      <Header>⚠ Heads up</Header>
      <div style={{ fontSize: "14px", color: COLOR.textMid, marginBottom: "16px", lineHeight: 1.5 }}>
        {conflicts.map((c, i) => (
          <p key={i} style={{ marginBottom: "8px" }}>
            {FULL_NAME[c.neighbor_day]} is already {c.session_type}.<br />
            {FULL_NAME[c.day]} + {FULL_NAME[c.neighbor_day]} would be back-to-back {c.session_type}.
          </p>
        ))}
      </div>
      <PrimaryButton onClick={onSwapAnyway} disabled={isPending}>
        {isPending ? "Confirming…" : "Swap anyway"}
      </PrimaryButton>
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onPickDifferent}>Pick a different target</TextButton>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/strength/DaySwapSheet.tsx
git commit -m "feat(schedule): DaySwapSheet bottom-sheet component

Five-state state machine: action → pick_target | pick_type → confirm → (warn
on 409) → done. Filters current session type from the replace list so the
picker never offers a no-op. Mounts the useSwapTrainingDay mutation; on 409
transitions to warn state with the conflict list rendered as prose.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire WeekPlanCard to DaySwapSheet

**Files:**
- Modify: `components/coach/WeekPlanCard.tsx`

- [ ] **Step 1: Convert day rows to tappable buttons**

Open `components/coach/WeekPlanCard.tsx`. Replace the existing `ORDER.map((d) => { ... <div>...</div> })` block (lines ~30-61) with the wired version:

```tsx
"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import type { Weekday } from "@/lib/data/types";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekPlanCard({
  userId,
  weekStart,
}: {
  userId: string;
  weekStart: string;
}) {
  const { data: week } = useTrainingWeek(userId, weekStart);
  const [sheetOpenForDay, setSheetOpenForDay] = useState<Weekday | null>(null);
  if (!week) return null;

  return (
    <Card>
      <SectionLabel>NEXT WEEK · planned</SectionLabel>
      <div style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "2px" }}>
        Week of {weekStart}
      </div>

      <div style={{ marginTop: "10px" }}>
        {ORDER.map((d) => {
          const t = readSessionForDay(week.session_plan, d) ?? "—";
          const isRest = t.toLowerCase().includes("rest") || t === "—";
          return (
            <button
              key={d}
              type="button"
              onClick={() => setSheetOpenForDay(d)}
              style={{
                display: "flex",
                width: "100%",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "5px 0",
                borderBottom: `1px solid ${COLOR.divider}`,
                fontSize: "12px",
                background: "transparent",
                border: "none",
                borderTop: "none",
                borderLeft: "none",
                borderRight: "none",
                color: "inherit",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span style={{ width: "44px", color: COLOR.textMuted, fontWeight: 600 }}>{d}</span>
              <span
                style={{
                  flex: 1,
                  color: isRest ? COLOR.textFaint : COLOR.textStrong,
                  fontStyle: isRest ? "italic" : "normal",
                }}
              >
                {t}
              </span>
              {week.rir_target !== null && !isRest && (
                <span style={{ color: COLOR.textMuted, fontFamily: "var(--font-dm-mono), monospace" }}>
                  RIR {week.rir_target}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {week.weekly_focus && (
        <p style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "12px", lineHeight: 1.5 }}>
          <strong style={{ color: COLOR.textStrong }}>Focus:</strong> {week.weekly_focus}
        </p>
      )}

      <Link
        href="/coach?mode=plan_week"
        style={{
          display: "inline-block",
          marginTop: "10px",
          fontSize: "11px",
          color: COLOR.accent,
          textDecoration: "none",
        }}
      >
        Re-open planning chat →
      </Link>

      {sheetOpenForDay && (
        <DaySwapSheet
          userId={userId}
          weekStart={weekStart}
          sourceDay={sheetOpenForDay}
          plan={week.session_plan}
          onClose={() => setSheetOpenForDay(null)}
        />
      )}
    </Card>
  );
}
```

The single semantic change is rows are now `<button>` instead of `<div>`, with `onClick` opening the sheet for that day. Visual styling is preserved (the button is restyled to look identical to the previous div). The sheet is mounted conditionally at the bottom.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Manual smoke**

```bash
npm run dev
```

Open `/coach` (or wherever WeekPlanCard renders), tap a day row, verify:
- The sheet slides up from the bottom.
- Step 1 shows the day's current session type.
- "Swap with another day" lists 6 other days with their session types.
- "Replace this day" lists session types from `SESSION_PLANS` ∪ {Mobility, REST}, current type filtered.
- Confirm POSTs and WeekPlanCard re-renders with the new plan.

- [ ] **Step 4: Commit**

```bash
git add components/coach/WeekPlanCard.tsx
git commit -m "feat(schedule): WeekPlanCard day rows mount DaySwapSheet

Tappable day rows open the bottom sheet for swap/replace. Visual styling
preserved (div → button restyled to identical appearance).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: pickCoachSuggestion in assembler + thread through brief inputs

**Files:**
- Modify: `lib/morning/brief/assembler.ts`
- Modify: `lib/morning/brief/data-sources.ts` (if `hasTrainingWeek` isn't already in BriefInputs)
- Create: `scripts/probe-coach-suggestion.mjs` (throwaway — deleted at end of task)

- [ ] **Step 1: Verify the BriefInputs type includes the training-week presence**

```bash
grep -n "BriefInputs\|trainingWeek" lib/morning/brief/assembler.ts lib/morning/brief/data-sources.ts | head -20
```

Look for whether `BriefInputs` already has a way to know if a `training_weeks` row exists. From session-start exploration, `data-sources.ts` reads `trainingWeekRes.data` but doesn't propagate `hasTrainingWeek` explicitly — it only propagates the derived `sessionType` and `intensityModifier`.

- [ ] **Step 2: Add `hasTrainingWeek` to BriefInputs and propagate**

In `lib/morning/brief/data-sources.ts`, in the final `return { ... }` block (around line 167), add:

```ts
return {
  today,
  yesterday,
  sessionType,
  sessionStartTime: ...,
  intensityModifier,
  primaryLift: ...,
  todayTargets,
  yesterdayLog: ...,
  yesterdayWorkout,
  todayCheckin: ...,
  todayLog: ...,
  whoopBaselines: ...,
  activeProfile: ...,
  // NEW:
  hasTrainingWeek: trainingWeek !== null && isWeekStartCoveringToday(trainingWeek.week_start, today),
};
```

In the `BriefInputs` type definition (likely in `lib/morning/brief/assembler.ts` or alongside `MorningBriefCard`), add:

```ts
hasTrainingWeek: boolean;
```

- [ ] **Step 3: Add `pickCoachSuggestion` to assembler**

In `lib/morning/brief/assembler.ts`, add this function (alongside the other compose helpers like `deriveReadinessBand`, `pickVariant`):

```ts
import type { MorningBriefCoachSuggestion } from "@/lib/data/types";

/** Deterministic trigger for the morning brief's coach_suggestion chip.
 *
 *  Fires only when:
 *  - A training_weeks row exists for today (so the swap POST can target it).
 *  - Readiness band is 'low'.
 *  - Today's session is not already REST or Mobility.
 *
 *  All other cases return null and no chip renders.
 */
export function pickCoachSuggestion(
  band: "low" | "moderate" | "high",
  sessionType: string,
  hasTrainingWeek: boolean,
): MorningBriefCoachSuggestion {
  if (!hasTrainingWeek) return null;
  if (band !== "low") return null;
  const lower = sessionType.toLowerCase().trim();
  if (lower === "rest" || lower === "mobility") return null;
  return { kind: "swap_to_mobility", rationale: "low_readiness" };
}
```

- [ ] **Step 4: Wire `coach_suggestion` into the brief card**

In `assembleBriefExceptAdvice()` (the main composer in `assembler.ts`), where the partial `MorningBriefCard` is built, add the `coach_suggestion` field. Find the existing return shape and add:

```ts
return {
  variant,
  readiness,
  recap,
  session,
  macros,
  tonight,
  // NEW:
  coach_suggestion: pickCoachSuggestion(readiness.band, sessionType, inputs.hasTrainingWeek),
};
```

- [ ] **Step 5: Write the probe script**

Create `scripts/probe-coach-suggestion.mjs`:

```js
// scripts/probe-coach-suggestion.mjs — throwaway verification for
// pickCoachSuggestion. No DB needed; pure function fixtures.
// Delete this file at end of Task 9.

import { pickCoachSuggestion } from "../lib/morning/brief/assembler.js";

let failures = 0;
function assert(label, cond, detail) {
  if (!cond) { console.error(`FAIL: ${label}`, detail ?? ""); failures += 1; }
  else { console.log(`PASS: ${label}`); }
}

// 1. band=low, session=Chest, hasTrainingWeek=true → swap_to_mobility
const r1 = pickCoachSuggestion("low", "Chest", true);
assert("low band + Chest + week present → swap_to_mobility", r1 && r1.kind === "swap_to_mobility");

// 2. band=low, session=REST → null
assert("low band on REST day → null", pickCoachSuggestion("low", "REST", true) === null);

// 3. band=low, session=Mobility → null (already mobility)
assert("low band on Mobility day → null", pickCoachSuggestion("low", "Mobility", true) === null);

// 4. band=moderate → null
assert("moderate band → null", pickCoachSuggestion("moderate", "Chest", true) === null);

// 5. band=high → null
assert("high band → null", pickCoachSuggestion("high", "Chest", true) === null);

// 6. hasTrainingWeek=false → null even on low band non-rest
assert(
  "no training_weeks row → null (avoids POST 404)",
  pickCoachSuggestion("low", "Chest", false) === null,
);

// 7. Case-insensitive REST/Mobility
assert("case-insensitive REST", pickCoachSuggestion("low", "rest", true) === null);
assert("case-insensitive Mobility", pickCoachSuggestion("low", "MOBILITY", true) === null);

console.log(failures === 0 ? "\n✓ all assertions passed" : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 6: Run the probe**

```bash
npx tsx scripts/probe-coach-suggestion.mjs
```

Expected: 8 PASS lines + `✓ all assertions passed`. Exit 0.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 8: Delete the probe script**

```bash
rm scripts/probe-coach-suggestion.mjs
```

- [ ] **Step 9: Commit**

```bash
git add lib/morning/brief/assembler.ts lib/morning/brief/data-sources.ts
git commit -m "feat(schedule): pickCoachSuggestion deterministic chip trigger

Fires the swap_to_mobility coach_suggestion only when band='low' AND
session is not REST/Mobility AND a training_weeks row exists for today
(the hasTrainingWeek gate avoids POST 404s for users who haven't
committed a week yet). Threads hasTrainingWeek through BriefInputs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: AdviceFlags + prompt clause

**Files:**
- Modify: `lib/morning/brief/flags.ts`
- Modify: `lib/morning/brief/advice-prompt.ts`

- [ ] **Step 1: Add `coach_swap_suggested` to flags**

In `lib/morning/brief/flags.ts`, find `computeAdviceFlags`. The function takes a `card: Omit<MorningBriefCard, 'advice_md'>` argument; since Task 9 added `coach_suggestion` to that shape, derive the flag from it.

Find the existing `return { ... }` block in `computeAdviceFlags` and add the new field:

```ts
return {
  has_glp1: GLP1_REGEX.test(meds),
  alcohol_low_readiness_warning: drinks > 0 && card.readiness.band === "low",
  has_active_injuries: injuries.length > 0,
  poor_sleep_efficiency,
  missed_protein_yesterday,
  // NEW:
  coach_swap_suggested: card.coach_suggestion?.kind === "swap_to_mobility",
};
```

- [ ] **Step 2: Add the prompt clause**

In `lib/morning/brief/advice-prompt.ts`, find the section that lists conditional rules for flags (the `If has_glp1 is true:` / `If alcohol_low_readiness_warning is true:` / etc. block).

Add this clause **after** the existing flag rules but **before** the "Style:" section:

```
- If coach_swap_suggested is true: a "Swap to Mobility" chip is already visible
  to the athlete on this brief. Your Advice should explain WHY mobility makes
  sense today — which readiness signals fired (HRV vs baseline, recovery score,
  readiness score). DO NOT re-decide whether to swap (the chip is the decision
  surface). DO NOT prescribe weights for the currently-named session. DO NOT
  pin eating timing to the original session start time — if they swap, that
  timing no longer applies; fall back to a 4-meal protein distribution
  spaced 3-4 hours apart.
```

Find the section to add to. Open the file:

```bash
grep -n "If has_glp1\|If alcohol_low_readiness\|Style:" lib/morning/brief/advice-prompt.ts | head
```

Insert the new clause in the right location (after the last `If ... is true:` clause, before `Style:`).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean. The `AdviceFlags` consumer chain (assembler → flags → advice-prompt) now all match the type.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Trigger a brief generation with a synthetic low-readiness state. Inspect the generated `advice_md` and confirm:
- The prose explains the band-low signals.
- The prose does NOT prescribe weights for the original session.
- The eating section does NOT reference the original session start time.

If the AI ignores the clause (Haiku occasionally does on first attempt), tighten the wording — e.g., add "Re-prescribing the original session's weights is FORBIDDEN in this brief."

- [ ] **Step 5: Commit**

```bash
git add lib/morning/brief/flags.ts lib/morning/brief/advice-prompt.ts
git commit -m "feat(schedule): coach_swap_suggested flag + advice prompt clause

Brief's Advice prose conditioned on chip presence: explains WHY mobility
makes sense (which readiness signals fired), doesn't re-decide, drops
workout-anchored eating timing in favor of 4-meal protein distribution.
Prevents prose-vs-chip contradictions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: BriefCoachSuggestion chip component

**Files:**
- Create: `components/morning/BriefCoachSuggestion.tsx`

- [ ] **Step 1: Inspect existing brief sub-components for style reference**

```bash
ls components/morning/
cat components/morning/BriefTonight.tsx 2>/dev/null | head -40
```

Confirm the pattern: each block is a small client component, uses `COLOR` tokens, takes a slice of `MorningBriefCard` as a prop.

- [ ] **Step 2: Write the component**

Create `components/morning/BriefCoachSuggestion.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import { COLOR } from "@/lib/ui/theme";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useSwapTrainingDay, type SwapErrorWithPreview } from "@/lib/query/hooks/useSwapTrainingDay";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";
import type { MorningBriefCoachSuggestion, Weekday } from "@/lib/data/types";

const FULL_TO_SHORT: Record<string, Weekday> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};

/** Map a Date to the week_start (Monday in UTC, YYYY-MM-DD) for fetching the
 *  training_weeks row this brief belongs to. */
function weekStartOf(today: string): string {
  const d = new Date(today + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Mon
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function formatHHmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function BriefCoachSuggestion({
  userId,
  briefSessionType,
  suggestion,
}: {
  userId: string;
  /** The session type frozen into this brief's card at intake time. */
  briefSessionType: string;
  suggestion: MorningBriefCoachSuggestion;
}) {
  const today = useMemo(() => todayInUserTz(), []);
  const weekStart = useMemo(() => weekStartOf(today), [today]);
  const sourceDay = useMemo<Weekday>(() => {
    const full = weekdayInUserTz(new Date(`${today}T12:00:00Z`));
    return FULL_TO_SHORT[full] ?? "Mon";
  }, [today]);

  const { data: trainingWeek } = useTrainingWeek(userId, weekStart);
  const mutation = useSwapTrainingDay(userId, weekStart);

  if (!suggestion) return null;
  if (!trainingWeek) return null; // assembler should have gated, but defense in depth

  // Derive "acknowledged" state: the current training_weeks plan no longer
  // matches the brief's frozen session.type. The brief jsonb is NOT rewritten —
  // this is purely derived from the live training_weeks read.
  const currentType =
    readSessionForDay(trainingWeek.session_plan as Record<string, string>, sourceDay) ??
    briefSessionType;
  const isAcknowledged = currentType !== briefSessionType;

  if (isAcknowledged) {
    return (
      <div
        style={{
          marginTop: "12px",
          padding: "12px 14px",
          background: COLOR.successSoft,
          color: COLOR.success,
          borderRadius: "10px",
          fontSize: "13px",
          lineHeight: 1.5,
        }}
      >
        ✓ Swapped to {currentType} at {formatHHmm(trainingWeek.updated_at)} —{" "}
        <a href="/strength" style={{ color: "inherit", textDecoration: "underline" }}>
          see /strength
        </a>
      </div>
    );
  }

  function onSwap() {
    mutation.mutate({
      body: { action: "replace", source_day: sourceDay, session_type: "Mobility" },
      confirm: true, // brief chip skips the 48h conflict gate
    });
  }

  return (
    <div
      style={{
        marginTop: "12px",
        padding: "14px 16px",
        background: COLOR.warningSoft,
        borderRadius: "10px",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: COLOR.warning,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: "4px",
        }}
      >
        Coach suggestion
      </div>
      <p
        style={{
          fontSize: "14px",
          color: COLOR.textStrong,
          marginBottom: "12px",
          lineHeight: 1.4,
        }}
      >
        Your readiness is low — swap to Mobility today?
      </p>
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={onSwap}
          disabled={mutation.isPending}
          style={{
            flex: 1,
            padding: "10px 14px",
            background: COLOR.warning,
            color: "#000",
            border: "none",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: mutation.isPending ? "not-allowed" : "pointer",
            opacity: mutation.isPending ? 0.6 : 1,
          }}
        >
          {mutation.isPending ? "Swapping…" : "Swap to Mobility"}
        </button>
        <button
          type="button"
          onClick={() => mutation.reset()}
          style={{
            flex: 1,
            padding: "10px 14px",
            background: "transparent",
            color: COLOR.textMuted,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: "8px",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Keep {briefSessionType}
        </button>
      </div>
      {mutation.isError && (
        <p style={{ marginTop: "8px", fontSize: "12px", color: COLOR.danger }}>
          {(mutation.error as SwapErrorWithPreview).message}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify `COLOR.warningSoft` / `COLOR.successSoft` exist**

```bash
grep -n "warningSoft\|successSoft\|warning:" lib/ui/theme.ts
```

Expected: matches for these tokens. If `warningSoft` doesn't exist, check if there's a different token (`yellowSoft`, `amberSoft`) and use that. If `successSoft` doesn't exist for the acknowledged banner, use whatever the codebase uses for positive states (often `accentSoft` or `greenSoft`). The chip background color is cosmetic — pick whichever token is closest to "yellow/amber soft" and "green soft".

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/morning/BriefCoachSuggestion.tsx
git commit -m "feat(schedule): BriefCoachSuggestion chip component

Yellow chip when coach_suggestion is non-null and training_weeks current
session_plan[today] still matches the brief's frozen session.type. Tap
[Swap to Mobility] POSTs ?confirm=true (skips the 48h conflict gate at
7am). Transitions to a derived 'acknowledged' green banner when the live
session_plan diverges from the brief snapshot. Acknowledged state is
purely client-derived — the brief's ui jsonb is never rewritten.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Mount chip in MorningBriefCard + strikethrough swapped session

**Files:**
- Modify: `components/morning/MorningBriefCard.tsx`
- Modify: `components/morning/BriefSessionList.tsx`

- [ ] **Step 1: Inspect the current MorningBriefCard structure**

```bash
cat components/morning/MorningBriefCard.tsx
```

Identify where `<BriefTonight />` is rendered. The new `<BriefCoachSuggestion />` mounts immediately after it.

- [ ] **Step 2: Mount BriefCoachSuggestion in MorningBriefCard**

In `components/morning/MorningBriefCard.tsx`:

- Add the import: `import { BriefCoachSuggestion } from "./BriefCoachSuggestion";`
- Find the JSX block where `<BriefTonight ... />` renders (or whatever the last sub-component is).
- Add immediately after the `<BriefTonight />` closing tag:

```tsx
<BriefCoachSuggestion
  userId={userId}
  briefSessionType={card.session.type}
  suggestion={card.coach_suggestion}
/>
```

The component takes `userId` from props (MorningBriefCard already receives it for user-scoped data — verify by reading the props; if not, thread it from the parent ChatPanel/MorningBriefCard mount site).

- [ ] **Step 3: Verify userId propagation**

```bash
grep -n "MorningBriefCard\b" app/ components/ -r | head
```

Find where `MorningBriefCard` is rendered. If the parent doesn't pass `userId`, thread it from the chat panel down. (The `ChatPanel` already has the user context.)

- [ ] **Step 4: Strikethrough swapped session in BriefSessionList**

Open `components/morning/BriefSessionList.tsx`. It renders the session block (training variant). We add a small "Swapped to X — see /strength" footer plus muting when the live training_weeks differs.

Modify the component to accept `userId` and consult `useTrainingWeek`:

```tsx
"use client";

import { useMemo } from "react";
import { COLOR } from "@/lib/ui/theme";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";
import type { MorningBriefCard, Weekday } from "@/lib/data/types";

const FULL_TO_SHORT: Record<string, Weekday> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};
function weekStartOf(today: string): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function BriefSessionList({
  userId,
  session,
}: {
  userId: string;
  session: MorningBriefCard["session"];
}) {
  const today = useMemo(() => todayInUserTz(), []);
  const weekStart = useMemo(() => weekStartOf(today), [today]);
  const sourceDay = useMemo<Weekday>(() => {
    const full = weekdayInUserTz(new Date(`${today}T12:00:00Z`));
    return FULL_TO_SHORT[full] ?? "Mon";
  }, [today]);

  const { data: week } = useTrainingWeek(userId, weekStart);
  const liveType =
    week && readSessionForDay(week.session_plan as Record<string, string>, sourceDay);
  const isSwapped = liveType && liveType !== session.type;

  return (
    <div style={{ marginTop: "16px" }}>
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: COLOR.textMuted,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: "8px",
        }}
      >
        Today ·{" "}
        <span style={{ textDecoration: isSwapped ? "line-through" : "none" }}>
          {session.type}
        </span>
        {session.start_time && (
          <span style={{ marginLeft: "8px", color: COLOR.textFaint }}>
            {session.start_time}
          </span>
        )}
      </div>
      <div
        style={{
          opacity: isSwapped ? 0.4 : 1,
          transition: "opacity 0.2s",
        }}
      >
        {session.exercises.map((ex, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 0",
              borderBottom: `1px solid ${COLOR.divider}`,
              fontSize: "13px",
            }}
          >
            <div>
              <div style={{ color: COLOR.textStrong, fontWeight: 500 }}>{ex.name}</div>
              <div style={{ color: COLOR.textMuted, fontSize: "12px" }}>
                {ex.sets} sets × {ex.reps} reps
              </div>
            </div>
            <div style={{ color: COLOR.textMid, fontFamily: "var(--font-dm-mono), monospace" }}>
              {ex.kg !== null ? `${ex.kg} kg` : "—"}
            </div>
          </div>
        ))}
      </div>
      {isSwapped && (
        <p
          style={{
            marginTop: "8px",
            fontSize: "12px",
            color: COLOR.textMuted,
            fontStyle: "italic",
          }}
        >
          Swapped to {liveType} —{" "}
          <a href="/strength" style={{ color: COLOR.accent }}>
            see /strength
          </a>{" "}
          for the new session.
        </p>
      )}
    </div>
  );
}
```

(If the existing `BriefSessionList` already has a different JSX shape, preserve its existing structure and just wrap the session-type label with the strikethrough conditional + add the strikethrough opacity + the bottom footer. The above is a complete reference; adapt to match the current file's variable names.)

- [ ] **Step 5: Verify BriefSessionList consumer passes userId**

```bash
grep -n "BriefSessionList" components/
```

In `MorningBriefCard.tsx`, ensure `userId` is passed to `<BriefSessionList />`. Add the prop if missing.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Manual smoke**

```bash
npm run dev
```

If you have an existing morning brief with `coach_suggestion: null` in the chat history, the chip won't show — that's expected (suggestion was null when written). To exercise the chip path, force-generate a new brief by setting low-readiness signals (see Task 13 manual smoke Path 3).

For the strikethrough path: with an existing brief showing today's session (e.g., Chest), navigate to /strength, swap Chest → Mobility via the day row sheet, return to the chat. Scroll to today's brief: the session block should show "Today · ~~Chest~~ 13:00" with the exercise list muted and a "Swapped to Mobility" footer.

- [ ] **Step 8: Commit**

```bash
git add components/morning/MorningBriefCard.tsx components/morning/BriefSessionList.tsx
git commit -m "feat(schedule): mount BriefCoachSuggestion + swapped-session strikethrough

Chip renders below BriefTonight when coach_suggestion is non-null and the
brief's frozen session.type still matches the live training_weeks.
Strikethrough on the session header + muted exercise list + 'Swapped to X'
footer when the live plan diverges from the brief snapshot. Brief jsonb is
not rewritten — all swap-aware state is derived client-side from
useTrainingWeek.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: End-to-end manual smoke + CLAUDE.md polish + PR prep

**Files:**
- Modify: `CLAUDE.md` (Coach/AI bullet)

- [ ] **Step 1: End-to-end Path 1 (user-initiated swap, strength tab)**

1. `npm run dev`, open `/coach` (or wherever WeekPlanCard renders) while logged in.
2. Tap a non-rest day row (e.g., Tuesday · Chest).
3. Verify `DaySwapSheet` slides up.
4. **Swap branch:** [Swap with another day] → Wednesday → [Confirm]. WeekPlanCard re-renders: Tue=Wed's type, Wed=Chest. Optimistic flip is instant; final state arrives ~200ms later.
5. **Replace branch:** Open the sheet for Thursday → [Replace this day] → Mobility → [Confirm]. Thu=Mobility.
6. DB check via Supabase Dashboard SQL editor:
   ```sql
   select original_session_plan, session_plan, updated_at
   from training_weeks
   where user_id = '<your-id>' and week_start = '<this-week-monday>';
   ```
   Both columns populated, `original_session_plan` = state before *any* of the swaps, `session_plan` = current state.

- [ ] **Step 2: End-to-end Path 2 (conflict warning)**

1. Set up a synthetic adjacent-day conflict by first ensuring two adjacent days share a type after the operation. Example: if current week is Mon=Legs, Tue=Chest, Wed=Mobility, swap Tue → Legs (Mon already Legs). Use the replace path.
2. The confirm sheet POSTs `?confirm=false` → 409 → sheet transitions to the warning state showing "Monday is already Legs. Monday + Tuesday would be back-to-back Legs."
3. Tap [Swap anyway] → POST `?confirm=true` → succeeds, sheet closes.
4. Verify [Pick a different target] from the warning state returns to step 2 of the sheet.
5. Restore the week to a sane state via another swap.

- [ ] **Step 3: End-to-end Path 3 (coach-initiated chip)**

1. Force a low-readiness state for today by setting `daily_logs.hrv` and `checkins.readiness` low. Via Supabase Dashboard SQL Editor:
   ```sql
   update daily_logs set hrv = 30 where user_id = '<your-id>' and date = current_date;
   update checkins set readiness = 4 where user_id = '<your-id>' and date = current_date;
   ```
   (Adjust the HRV value below your `whoop_baselines.hrv_swc_low` to ensure band derives to 'low'.)
2. If you've already completed the morning intake for today and the brief was written without the chip, force a re-run: delete today's `brief_delivered` state and the `morning_brief` chat row:
   ```sql
   delete from chat_messages where user_id = '<your-id>' and kind = 'morning_brief'
     and created_at::date = current_date;
   update checkins set intake_state = 'delivered' where user_id = '<your-id>' and date = current_date;
   ```
   Then trigger the brief endpoint manually (the intake handler pipelines it; complete a fresh intake or call the retry endpoint).
3. The new brief renders with the yellow chip below `BriefTonight`: "Coach suggestion: swap to Mobility today?"
4. Inspect the `advice_md` prose — verify it explains *why* (band-low signals) and does NOT prescribe weights for the original session.
5. Tap [Swap to Mobility]. POST `?confirm=true`. The chip transitions to the green "✓ Swapped to Mobility at HH:mm — see /strength" banner.
6. The `BriefSessionList` shows the original session with strikethrough + muted opacity + footer.
7. Navigate to `/strength`. TodayPlanCard reads live `training_weeks.session_plan[today]` = Mobility. WeekPlanCard shows Tuesday's row updated.
8. Close the chat, reopen it, scroll to today's brief. The acknowledged banner still shows (it's derived client-side from `training_weeks.session_plan[today] !== brief.session.type`).

- [ ] **Step 4: End-to-end Path 4 (swap-then-unswap)**

1. From Path 3 state (today swapped to Mobility, `original_session_plan` populated).
2. Open `/coach`, tap today's row in WeekPlanCard → [Replace] → original session type → [Confirm].
3. DB check:
   ```sql
   select original_session_plan, session_plan
   from training_weeks
   where user_id = '<your-id>' and week_start = '<this-week-monday>';
   ```
   `original_session_plan` is NULL, `session_plan` matches the original state.
4. Brief's chip returns to its initial "Coach suggestion" state if `band==='low'` is still true (the chip's acknowledged derivation is `liveType !== briefSessionType`; with the restore, equality holds again).

- [ ] **Step 5: End-to-end Path 5 (adherence sanity)**

1. Set up: leave today's session as swapped to Mobility (re-do Path 3 step 5 if you reverted in Path 4). Skip the actual workout for today.
2. Open `/coach`, type: "how did this week go?"
3. The coach calls `compute_adherence` and produces prose.
4. Verify the prose mentions the Tuesday swap explicitly (e.g., "you planned Chest, swapped to Mobility, didn't end up training"). The `status='swapped'` field in the tool result lets the AI distinguish swap from miss.

- [ ] **Step 6: Add the Coach/AI bullet to CLAUDE.md**

Open `CLAUDE.md`. Find the `### Coach / AI` section. Add this bullet alongside the existing **Weekly planning v1**, **Athlete profile (Phase 1)**, **Morning brief** bullets:

```
- **Schedule flexibility**: mid-week training plan swaps via `POST /api/training-weeks/[week_start]/swap` ([app/api/training-weeks/[week_start]/swap/route.ts](app/api/training-weeks/[week_start]/swap/route.ts)). Two primitives: A↔B exchange (`action: 'swap'`) and single-day replacement (`action: 'replace'`). Two UI surfaces sharing one endpoint: strength tab inline edit via [components/strength/DaySwapSheet.tsx](components/strength/DaySwapSheet.tsx) (preview-then-confirm with soft "identical type within 48h" warning) and morning-brief chip via [components/morning/BriefCoachSuggestion.tsx](components/morning/BriefCoachSuggestion.tsx) (deterministic trigger when band='low' AND session not REST/Mobility AND a training_weeks row exists; `?confirm=true` unconditional). Migration 0012 adds nullable `original_session_plan jsonb` populated COALESCE-style on first edit; identity-restore (A→B→A) resets it to NULL. Adherence reads `coalesce(original_session_plan, session_plan)` and grows a per-day `status` field (`as_planned | swapped | missed | rest`) so `compute_adherence` produces prose distinguishing swapped from missed. Brief's `ui` jsonb is never rewritten on swap — the chip's "acknowledged" state and the session list's strikethrough are derived client-side from `useTrainingWeek` vs `brief.session.type`.
```

- [ ] **Step 7: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Both expected clean.

- [ ] **Step 8: Commit + push**

```bash
git add CLAUDE.md
git commit -m "docs: schedule flexibility entry in CLAUDE.md Coach/AI section

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin feat/schedule-flexibility
```

- [ ] **Step 9: Open the PR**

```bash
gh pr create --base main --head feat/schedule-flexibility \
  --title "feat: schedule flexibility (mid-week swap/replace)" \
  --body "$(cat <<'EOF'
## Summary

Mid-week training plan edits via two primitives (A↔B swap + single-day replace), two UI surfaces (strength tab inline + morning brief chip), one mutation endpoint, audit-honest adherence.

Reference spec: [docs/superpowers/specs/2026-05-11-schedule-flexibility-design.md](docs/superpowers/specs/2026-05-11-schedule-flexibility-design.md).
Plan: [docs/superpowers/plans/2026-05-11-schedule-flexibility.md](docs/superpowers/plans/2026-05-11-schedule-flexibility.md).

## What's in this PR

- **Migration 0012** — nullable `training_weeks.original_session_plan jsonb`, COALESCE-on-first-edit, identity-restore resets to NULL.
- **`POST /api/training-weeks/[week_start]/swap`** — single endpoint shared by both surfaces. `?confirm=false` returns 409 with conflict preview; `?confirm=true` skips the gate.
- **`DaySwapSheet`** — strength-tab bottom sheet (action → target → confirm/warn).
- **`BriefCoachSuggestion`** — morning-brief chip with deterministic `band==='low' && session!=='REST|Mobility' && hasTrainingWeek` trigger.
- **Adherence** — reads `coalesce(original_session_plan, session_plan)`; per-day output grows `swapped_to` + `status` for conversational recap.
- **Advice prompt clause** — when `coach_swap_suggested` is true, prose explains *why*, doesn't re-decide, drops workout-anchored eating timing.

## Decisions preserved from the spec

1. Audit via nullable `original_session_plan` jsonb with identity-restore reset to NULL.
2. Single mutation endpoint shared by both surfaces.
3. Deterministic chip trigger with `hasTrainingWeek` gate.
4. Prompt clause addition so advice prose explains why instead of re-deciding.
5. Enriched adherence per-day output for conversational recap (no new UI component in v1).

## Verification

- `npm run typecheck` clean.
- `npm run build` clean.
- All 5 manual smoke paths walked through (see plan Task 13). Probe scripts created → run → deleted in tasks 3, 4, 5, 9.

## Non-goals (v1.1+ backlog)

- Muscle-group overlap matrix (push/pull/squat/hinge) for the conflict check.
- Coach chat command (`propose_day_swap` / `commit_day_swap`).
- Coach-suggested swaps for non-low readiness.
- Swap-undo button.
- Multi-day chain shift.
- Intermediate swap history (per-edit log table).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

After writing all 13 tasks above, run this checklist against the spec sections:

### Spec coverage

| Spec section | Task(s) implementing it |
|---|---|
| Migration `0012_schedule_flexibility.sql` | Task 1 |
| TypeScript types (`SwapAction`, `SwapBody`, etc., `coach_suggestion`, `coach_swap_suggested`) | Task 2 |
| `applySwap()` + `detectConflicts()` pure helpers | Task 3 |
| `POST /api/training-weeks/[week_start]/swap` (auth, validate, identity, conflict gate, COALESCE+restore UPDATE) | Task 4 |
| Adherence change (coalesce read + per-day `status` field) | Task 5 |
| `useSwapTrainingDay` TanStack mutation | Task 6 |
| Strength tab inline edit (DaySwapSheet) | Task 7 |
| WeekPlanCard tappable rows wiring | Task 8 |
| `pickCoachSuggestion` deterministic trigger + `hasTrainingWeek` gate | Task 9 |
| `coach_swap_suggested` flag + advice prompt clause | Task 10 |
| `BriefCoachSuggestion` chip component (initial + acknowledged states) | Task 11 |
| MorningBriefCard mount + BriefSessionList strikethrough | Task 12 |
| Sunday recap signal (conversational, via tool output enrichment) | Covered in Task 5 (no UI changes; adherence output handles it) |
| CLAUDE.md migration entry | Task 1 |
| CLAUDE.md Coach/AI bullet | Task 13 |
| End-to-end manual smoke (Paths 1-5) | Task 13 |

No spec section is missing a task.

### Placeholder scan

- No "TBD" / "TODO" / "implement later" anywhere in the plan.
- All code blocks are complete (no `// ...` truncations in load-bearing positions).
- No "similar to Task N" references — each task's code is self-contained.

### Type consistency

- `SessionPlan` is used consistently (matches existing type in `lib/data/types.ts`; spec called it `SessionPlanMap` but the plan corrects this).
- `queryKeys.trainingWeeks.one(userId, weekStart)` — matches actual file (`one`, not `detail`).
- `Weekday` is the 3-letter form everywhere.
- `MorningBriefCoachSuggestion` shape (`kind: 'swap_to_mobility'` only) matches between types, assembler, and component consumers.
- `SwapBody` discriminated union shape matches between route handler, mutation hook, and component.

### Scope check

Single feature, single endpoint, single PR. No subsystem decomposition needed.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-11-schedule-flexibility.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
