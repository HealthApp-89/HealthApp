# Block Command Center + Editable Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Blocks" tab on /strength (current-block monitor, block history with AI narrative, form-first new-block editor) plus manual per-exercise editing in the Schedule tab that flows into every surface including the logger.

**Architecture:** Two athlete-owned jsonb override layers (`training_weeks.manual_session_edits` week-scope, `training_blocks.session_structure_overrides` block-scope) merge above the engine's `session_prescriptions` in both resolution chains. Block narrative is one Haiku call at close time, fabrication-checked, persisted to `block_outcomes.narrative_md`. New-block creation reuses the propose_block validator via extracted shared helpers.

**Tech Stack:** Next.js 15 App Router, Supabase (RLS), TanStack Query hybrid SSR-hydrate, Recharts, vitest, Anthropic Haiku 4.5.

**Spec:** [docs/superpowers/specs/2026-07-13-block-command-center-design.md](../specs/2026-07-13-block-command-center-design.md)

## Global Constraints

- Branch: `feat/block-command-center`. PR 1 = Tasks 1–6, PR 2 = Tasks 7–10.
- Migration file MUST be `supabase/migrations/0051_block_command_center.sql` (next free slot is 0051; prefixes uniform-width).
- All user-visible numbers via `fmtNum()` from `lib/ui/score.ts` — never `.toFixed()`.
- No `new Date().toISOString().slice(0,10)` / `.getHours()` — use `todayInUserTz` / profile timezone (audit script enforces).
- Query keys only from `lib/query/keys.ts`; fetchers come in server+browser pairs that `throw` on Supabase error.
- New client components: `npm run build` is a mandatory gate (no render-test harness — hooks bugs only surface in prod build).
- Verify each task with `npm run typecheck` && `npx vitest run`.
- Commit after each task; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## PR 1 — Blocks tab + narrative

### Task 1: Migration 0051 + TS type mirrors

**Files:**
- Create: `supabase/migrations/0051_block_command_center.sql`
- Modify: `lib/data/types.ts` (TrainingWeek, TrainingBlock, BlockOutcome rows + two new shape types)

**Interfaces:**
- Produces: `ManualSessionEdits`, `SessionStructureOverrides` types; `TrainingWeek.manual_session_edits`, `TrainingBlock.session_structure_overrides`, `BlockOutcome.narrative_md` fields. All later tasks import these from `@/lib/data/types`.

- [ ] **Step 1: Write the migration**

```sql
-- 0051_block_command_center.sql
-- Block Command Center arc (spec 2026-07-13):
--   narrative_md            — Carter-voiced outcome paragraph, written once at close
--   manual_session_edits    — athlete week-scope per-exercise edits (merge layer ABOVE session_prescriptions)
--   session_structure_overrides — athlete block-scope structure prefs (order + set counts), consumed by prescribeWeek

alter table public.block_outcomes
  add column if not exists narrative_md text;

comment on column public.block_outcomes.narrative_md is
  'AI-written performance paragraph (Carter voice), generated once at block close. Deterministic fallback text on LLM failure — never NULL for rows closed after migration 0051.';

alter table public.training_weeks
  add column if not exists manual_session_edits jsonb;

comment on column public.training_weeks.manual_session_edits is
  'Athlete-owned week-scope edits keyed by WeekdayLong: { order?: string[], exercises?: { [name]: { sets?, kg?, reps? } } }. Merges at the TOP of the session resolution chain; survives engine repatches of session_prescriptions. NULL = no manual edits.';

alter table public.training_blocks
  add column if not exists session_structure_overrides jsonb;

comment on column public.training_blocks.session_structure_overrides is
  'Athlete-owned block-scope structure prefs keyed by session_type: { order?: string[], sets?: { [name]: number } }. Consumed by prescribeWeek for every week of the block; loads/reps stay engine-evolved. NULL = engine defaults.';
```

- [ ] **Step 2: Apply the migration**

Run: `cd "/Users/abdelouahedelbied/Health app" && supabase db push`
Expected: `Applying migration 0051_block_command_center.sql... Finished supabase db push.`

- [ ] **Step 3: Add TS mirrors**

In `lib/data/types.ts`: add below the `ExerciseOverrides` type:

```ts
/** Athlete-owned week-scope edits (migration 0051). Merges at the TOP of the
 *  session resolution chain — above session_prescriptions — so engine
 *  repatches never clobber manual edits. `order` is a full permutation of the
 *  resolved day's exercise names; `exercises` holds per-field deltas. */
export type ManualSessionEdits = Partial<Record<WeekdayLong, {
  order?: string[];
  exercises?: Record<string, { sets?: number; kg?: number; reps?: number }>;
}>>;

/** Athlete-owned block-scope structure prefs (migration 0051). Keyed by
 *  session_type ("Legs", "Chest", ...). Consumed by prescribeWeek for every
 *  week of the block: order applied post-composition, set counts override
 *  engine counts. Loads/reps stay engine-evolved (RIR/intensity per week). */
export type SessionStructureOverrides = Record<string, {
  order?: string[];
  sets?: Record<string, number>;
}>;
```

Then add fields to the row types (find each `export type` and append):
- `TrainingWeek`: `manual_session_edits: ManualSessionEdits | null;`
- `TrainingBlock`: `session_structure_overrides: SessionStructureOverrides | null;`
- `BlockOutcome`: `narrative_md: string | null;`

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean (fields are additive).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0051_block_command_center.sql lib/data/types.ts
git commit -m "feat(db): migration 0051 — narrative_md + manual edit layers"
```

---

### Task 2: Outcome narrative module (fabrication check + fallback)

**Files:**
- Create: `lib/coach/block-outcomes/narrative.ts`
- Test: `lib/coach/block-outcomes/__tests__/narrative.test.ts`

**Interfaces:**
- Consumes: `BlockOutcome` payload shape (`Omit<BlockOutcome,"id"|"athlete_acknowledged_at"|"created_at"|"updated_at">` — same as `GenerateBlockOutcomeResult["payload"]`).
- Produces:
  - `narrativeNumbersValid(text: string, payload: OutcomePayload): boolean`
  - `deterministicNarrative(payload: OutcomePayload, blockWindow: {start_date: string; end_date: string}): string`
  - `generateOutcomeNarrative(opts: {payload: OutcomePayload; blockWindow: {start_date: string; end_date: string}}): Promise<{narrative: string; source: "ai" | "fallback"}>`

- [ ] **Step 1: Write failing tests for the pure parts**

```ts
// lib/coach/block-outcomes/__tests__/narrative.test.ts
import { describe, expect, test } from "vitest";
import { narrativeNumbersValid, deterministicNarrative } from "@/lib/coach/block-outcomes/narrative";
import type { BlockOutcome } from "@/lib/data/types";

const payload: Omit<BlockOutcome, "id" | "athlete_acknowledged_at" | "created_at" | "updated_at"> = {
  block_id: "b1", user_id: "u1", primary_lift: "bench",
  target_value_kg: 85, target_metric: "e1rm", end_working_kg: 90,
  target_hit: true, target_hit_at_week: 2, block_phase_at_end: "hit_early",
  lessons: {
    observed_step_kg_per_wk: 1.9, projected_kg_at_end: null, gap_kg: 5, gap_pct: 5.9,
    calibration_note: "Target set conservatively.",
    secondary_lifts: [{ lift: "squat", end_kg: 72.5, clamp_held: true }],
  },
  recommended_next_focus: "squat", recommended_target_value_kg: 82.5,
  narrative_md: null,
};
const win = { start_date: "2026-06-08", end_date: "2026-07-12" };

describe("narrativeNumbersValid", () => {
  test("accepts a narrative whose numbers all exist in the payload", () => {
    expect(narrativeNumbersValid("Hit 85 by week 2, ended at 90 (+1.9 kg/wk).", payload)).toBe(true);
  });
  test("rejects a fabricated number", () => {
    expect(narrativeNumbersValid("You ended at 97.5 kg.", payload)).toBe(false);
  });
  test("date fragments and small integers (weeks 1-5) are exempt", () => {
    expect(narrativeNumbersValid("A 5-week block ending Jul 12.", payload)).toBe(true);
  });
});

describe("deterministicNarrative", () => {
  test("mentions target, reached value and pick-up point", () => {
    const text = deterministicNarrative(payload, win);
    expect(text).toContain("85");
    expect(text).toContain("90");
    expect(text.toLowerCase()).toContain("pick up");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/coach/block-outcomes/__tests__/narrative.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/coach/block-outcomes/narrative.ts
//
// Carter-voiced outcome paragraph, written ONCE at block close (chat commit,
// API commit, nightly sweep all call generateOutcomeNarrative). Third
// narrator fabrication-checker in the codebase (Peter dashboard + weekly
// review are the others) — deliberately self-contained here; if you change
// the checker policy, audit the other two (known drift gotcha).

import { getAnthropic } from "@/lib/anthropic/client";
import { CARTER_VOICE_RULES } from "@/lib/coach/planning-prompts";
import { fmtNum } from "@/lib/ui/score";
import type { BlockOutcome } from "@/lib/data/types";

export type OutcomePayload = Omit<BlockOutcome, "id" | "athlete_acknowledged_at" | "created_at" | "updated_at">;
type BlockWindow = { start_date: string; end_date: string };

/** Collect every numeric token the narrative is ALLOWED to use. */
function allowedNumbers(p: OutcomePayload): Set<string> {
  const nums: Array<number | null | undefined> = [
    p.target_value_kg, p.end_working_kg, p.target_hit_at_week,
    p.lessons.observed_step_kg_per_wk, p.lessons.projected_kg_at_end,
    p.lessons.gap_kg, p.lessons.gap_pct,
    p.recommended_target_value_kg,
    ...p.lessons.secondary_lifts.map((s) => s.end_kg),
  ];
  const out = new Set<string>();
  for (const n of nums) {
    if (n == null) continue;
    out.add(fmtNum(n));
    out.add(String(n));
    out.add(n.toFixed(1));
  }
  return out;
}

/** Every number token in the text must be in the allow-list. Weeks 1-5,
 *  block length (34/35), percentages already covered via gap_pct, and
 *  date fragments (4-digit years, day-of-month <= 31 immediately after a
 *  month word) are exempt. */
export function narrativeNumbersValid(text: string, payload: OutcomePayload): boolean {
  const allowed = allowedNumbers(payload);
  const MONTH_RE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*$/i;
  const tokenRe = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[0];
    const val = Number(tok);
    if (allowed.has(tok)) continue;
    if (Number.isInteger(val) && val >= 1 && val <= 5) continue;      // week numbers / small counts
    if (val === 34 || val === 35) continue;                            // block length in days
    if (Number.isInteger(val) && val >= 2020 && val <= 2100) continue; // years
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (Number.isInteger(val) && val <= 31 && MONTH_RE.test(before)) continue; // "Jul 12"
    return false;
  }
  return true;
}

export function deterministicNarrative(p: OutcomePayload, w: BlockWindow): string {
  const lift = p.primary_lift;
  const tgt = p.target_value_kg != null ? `${fmtNum(p.target_value_kg)} kg` : "no target";
  const end = p.end_working_kg != null ? `${fmtNum(p.end_working_kg)} kg` : "n/a";
  const hit = p.target_hit_at_week != null ? ` (week ${p.target_hit_at_week})` : "";
  const step = p.lessons.observed_step_kg_per_wk != null
    ? ` Observed step: +${fmtNum(p.lessons.observed_step_kg_per_wk)} kg/wk.` : "";
  const pick = p.recommended_target_value_kg != null && p.recommended_next_focus === p.primary_lift
    ? ` When ${lift} circles back, pick up around ${fmtNum(p.recommended_target_value_kg)} kg.`
    : ` When ${lift} circles back, pick up from the ${end} base and set the target off the live trend.`;
  return `${w.start_date} → ${w.end_date}: ${lift} block closed ${p.block_phase_at_end.replace(/_/g, " ")}. Target ${tgt}, reached ${end}${hit}.${step} ${p.lessons.calibration_note}${pick}`;
}

const MAX_ATTEMPTS = 2;

export async function generateOutcomeNarrative(opts: {
  payload: OutcomePayload;
  blockWindow: BlockWindow;
}): Promise<{ narrative: string; source: "ai" | "fallback" }> {
  const { payload, blockWindow } = opts;
  const prompt = [
    CARTER_VOICE_RULES,
    "",
    "Write the closing paragraph for a finished 5-week training block. <=120 words, plain prose, no headers, no emoji. Cover: (1) how the block went vs target, (2) what the calibration taught us, (3) an explicit pick-up point for when this lift becomes the focus again.",
    "STRICT: use ONLY numbers present in the JSON below. Do not invent values.",
    "",
    JSON.stringify({ ...payload, blockWindow }, null, 1),
  ].join("\n");

  try {
    const client = getAnthropic();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const res = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
      if (text && narrativeNumbersValid(text, payload)) return { narrative: text, source: "ai" };
    }
  } catch {
    // fall through to deterministic
  }
  return { narrative: deterministicNarrative(payload, blockWindow), source: "fallback" };
}
```

Note: check `lib/anthropic/client.ts` for the actual export (`getAnthropic` vs a named singleton) and match it; if the exported helper differs, use the existing one — do NOT add a second client construction path.

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/coach/block-outcomes/__tests__/narrative.test.ts`
Expected: PASS (3+2 tests). Also `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/block-outcomes/narrative.ts lib/coach/block-outcomes/__tests__/narrative.test.ts
git commit -m "feat(blocks): outcome narrative module — Haiku wrap, fabrication check, deterministic fallback"
```

---

### Task 3: Wire narrative into close paths + backfill script

**Files:**
- Modify: `lib/coach/tools.ts` (`executeCommitCloseBlock` — the `block_outcomes` UPSERT)
- Modify: `app/api/coach/block-outcomes/sweep/route.ts` (the sweep's outcome write)
- Create: `scripts/backfill-block-narratives.mjs`

**Interfaces:**
- Consumes: `generateOutcomeNarrative` from Task 2.
- Produces: every new `block_outcomes` row carries `narrative_md`.

- [ ] **Step 1: Wire into executeCommitCloseBlock**

In `lib/coach/tools.ts`, locate the `block_outcomes` UPSERT inside `executeCommitCloseBlock` (search `commit_close_block executor`). Before the upsert, generate the narrative; include `narrative_md` in the upserted row:

```ts
const { generateOutcomeNarrative } = await import("@/lib/coach/block-outcomes/narrative");
const { narrative } = await generateOutcomeNarrative({
  payload: outcomePayload, // the freshly generated payload variable already in scope
  blockWindow: { start_date: block.start_date as string, end_date: block.end_date as string },
});
// ...then add `narrative_md: narrative` to the upsert object.
```

Match the surrounding code's variable names — read the executor before editing. The upsert must still preserve `athlete_acknowledged_at` semantics (idempotent re-close keeps the existing narrative: add `narrative_md` only via the insert-side of the upsert or `coalesce`-style update that doesn't null it).

- [ ] **Step 2: Wire into the sweep**

In `app/api/coach/block-outcomes/sweep/route.ts`, after `generateBlockOutcome(...)` returns `payload` for a block `b`, call `generateOutcomeNarrative({ payload, blockWindow: { start_date: b.start_date, end_date: b.end_date } })` and include `narrative_md` in the row written. The sweep SELECT must be extended to fetch `start_date` (it currently selects `id, user_id, end_date, primary_lift`).

- [ ] **Step 3: Typecheck + full tests**

Run: `npm run typecheck && npx vitest run`
Expected: clean / all pass.

- [ ] **Step 4: Backfill script**

```js
// scripts/backfill-block-narratives.mjs
// One-shot: writes narrative_md for existing block_outcomes rows where NULL.
// Run: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/backfill-block-narratives.mjs
import { createClient } from "@supabase/supabase-js";
import { generateOutcomeNarrative } from "@/lib/coach/block-outcomes/narrative";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: rows, error } = await sb
  .from("block_outcomes")
  .select("*, training_blocks!inner(start_date, end_date)")
  .is("narrative_md", null);
if (error) { console.error(error); process.exit(1); }
for (const row of rows ?? []) {
  const { training_blocks: tb, ...payload } = row;
  const { narrative, source } = await generateOutcomeNarrative({
    payload,
    blockWindow: { start_date: tb.start_date, end_date: tb.end_date },
  });
  const { error: upErr } = await sb.from("block_outcomes")
    .update({ narrative_md: narrative }).eq("id", row.id);
  console.log(`${row.primary_lift} (${tb.end_date}): ${source}${upErr ? " WRITE FAILED " + upErr.message : ""}`);
}
console.log(`done — ${rows?.length ?? 0} rows`);
```

- [ ] **Step 5: Run the backfill**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/backfill-block-narratives.mjs`
Expected: two lines (`deadlift ... : ai`, `bench ... : ai`), `done — 2 rows`.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/tools.ts app/api/coach/block-outcomes/sweep/route.ts scripts/backfill-block-narratives.mjs
git commit -m "feat(blocks): persist narrative_md on every close path + backfill"
```

---

### Task 4: Block summary compute module + fetcher/hook pair

**Files:**
- Create: `lib/coach/blocks/summary.ts`
- Test: `lib/coach/blocks/__tests__/summary.test.ts`
- Create: `lib/query/fetchers/blockSummary.ts`
- Modify: `lib/query/keys.ts`, create `lib/query/hooks/useBlockSummary.ts`

**Interfaces:**
- Consumes: `olsSlope` from `@/lib/coach/trends/linear-regression`, `bestComparisonValue` from `@/lib/coach/e1rm`, `evaluateBlockPhase` from `@/lib/coach/prescription/block-phase` (verify exact export name before writing; it's the module the CLAUDE.md framework-state section names).
- Produces:
  - `computeBlockPace(points: Array<{week: number; e1rm: number}>, target: number, totalWeeks: number): { currentBest: number | null; slopePerWeek: number | null; projectedHitWeek: number | null; kgToGo: number | null }`
  - `assembleBlockSummary({supabase, userId, todayIso}): Promise<BlockSummaryPayload | null>` (null = no active block)
  - `BlockSummaryPayload` type: `{ block: {...}, weekNum, totalWeeks, phase, pace, chart: Array<{week, e1rm}>, thisWeek: {rir, intensity, sessionsDone, sessionsPlanned, nextSession}, secondaries: Array<{lift, kg, clampHeld}> }`

- [ ] **Step 1: Failing test for computeBlockPace (pure)**

```ts
// lib/coach/blocks/__tests__/summary.test.ts
import { describe, expect, test } from "vitest";
import { computeBlockPace } from "@/lib/coach/blocks/summary";

describe("computeBlockPace", () => {
  test("projects hit week from OLS slope", () => {
    const pts = [{ week: 1, e1rm: 86 }, { week: 2, e1rm: 88 }, { week: 3, e1rm: 90 }];
    const r = computeBlockPace(pts, 94, 5);
    expect(r.currentBest).toBe(90);
    expect(r.slopePerWeek).toBeCloseTo(2, 5);
    expect(r.projectedHitWeek).toBe(5);   // 90 + 2/wk → 94 at week 5
    expect(r.kgToGo).toBe(4);
  });
  test("null-safe with <2 points", () => {
    const r = computeBlockPace([{ week: 1, e1rm: 86 }], 94, 5);
    expect(r.currentBest).toBe(86);
    expect(r.slopePerWeek).toBeNull();
    expect(r.projectedHitWeek).toBeNull();
  });
  test("already-hit target projects the current week", () => {
    const pts = [{ week: 1, e1rm: 86 }, { week: 2, e1rm: 95 }];
    const r = computeBlockPace(pts, 94, 5);
    expect(r.projectedHitWeek).toBe(2);
    expect(r.kgToGo).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run lib/coach/blocks/__tests__/summary.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/coach/blocks/summary.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { olsSlope } from "@/lib/coach/trends/linear-regression";

export function computeBlockPace(
  points: Array<{ week: number; e1rm: number }>,
  target: number,
  totalWeeks: number,
): { currentBest: number | null; slopePerWeek: number | null; projectedHitWeek: number | null; kgToGo: number | null } {
  if (points.length === 0) return { currentBest: null, slopePerWeek: null, projectedHitWeek: null, kgToGo: null };
  const last = points[points.length - 1];
  const currentBest = last.e1rm;
  const kgToGo = Math.max(0, target - currentBest);
  if (points.length < 2) return { currentBest, slopePerWeek: null, projectedHitWeek: null, kgToGo };
  const slope = olsSlope(points.map((p) => ({ x: p.week, y: p.e1rm })));
  if (slope == null || slope <= 0) return { currentBest, slopePerWeek: slope, projectedHitWeek: null, kgToGo };
  if (currentBest >= target) return { currentBest, slopePerWeek: slope, projectedHitWeek: last.week, kgToGo: 0 };
  const projected = Math.ceil(last.week + (target - currentBest) / slope);
  return { currentBest, slopePerWeek: slope, projectedHitWeek: Math.min(projected, totalWeeks + 3), kgToGo };
}
```

Then `assembleBlockSummary` in the same file: fetch active block (`training_blocks status='active' maybeSingle`); if none → null. Fetch non-warmup sets for the block's primary lift within `[start_date, todayIso]` (same query shape as `computeTargetRecommendation` in `lib/coach/prescription/calibrate-target.ts` — read it and reuse its per-week max-e1RM bucketing via `bestComparisonValue`). Fetch current `training_weeks` row (rir_target, intensity, session_plan, session_prescriptions) + workouts count this week for sessionsDone. Secondaries: latest working kg per other lift from last 14d workouts + `clamp_held` from the maintenance evaluator if exported, else kg only (typed `clampHeld: boolean | null`). Assemble `BlockSummaryPayload`. Export the type.

- [ ] **Step 4: Run tests** — `npx vitest run lib/coach/blocks/__tests__/summary.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Fetcher pair + key + hook**

`lib/query/keys.ts` — add:
```ts
blockSummary: {
  all: (userId: string) => ["blockSummary", userId] as const,
  today: (userId: string, todayIso: string) => ["blockSummary", userId, todayIso] as const,
},
```

`lib/query/fetchers/blockSummary.ts` (server assembles; browser re-assembles via RLS client — both call the same module):
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { assembleBlockSummary, type BlockSummaryPayload } from "@/lib/coach/blocks/summary";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export async function fetchBlockSummaryServer(
  supabase: SupabaseClient, userId: string, todayIso: string,
): Promise<BlockSummaryPayload | null> {
  return assembleBlockSummary({ supabase, userId, todayIso });
}

export async function fetchBlockSummaryBrowser(
  userId: string, todayIso: string,
): Promise<BlockSummaryPayload | null> {
  const supabase = createSupabaseBrowserClient();
  return assembleBlockSummary({ supabase: supabase as unknown as SupabaseClient, userId, todayIso });
}
```

`lib/query/hooks/useBlockSummary.ts`:
```ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBlockSummaryBrowser } from "@/lib/query/fetchers/blockSummary";

export function useBlockSummary(userId: string, todayIso: string) {
  return useQuery({
    queryKey: queryKeys.blockSummary.today(userId, todayIso),
    queryFn: () => fetchBlockSummaryBrowser(userId, todayIso),
    enabled: !!todayIso,
  });
}
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npx vitest run` → clean/pass.
```bash
git add lib/coach/blocks/ lib/query/fetchers/blockSummary.ts lib/query/hooks/useBlockSummary.ts lib/query/keys.ts
git commit -m "feat(blocks): summary compute module + SSR-hydrate fetcher/hook"
```

---

### Task 5: Block create/close API routes (shared validator extraction)

**Files:**
- Create: `lib/coach/blocks/create-block.ts` (extracted shared logic)
- Modify: `lib/coach/tools.ts` (`executeProposeBlock` / `executeCommitBlock` delegate to the shared module)
- Create: `app/api/blocks/route.ts` (POST create)
- Create: `app/api/blocks/close/route.ts` (POST preview/commit close)
- Test: `lib/coach/blocks/__tests__/create-block.test.ts`

**Interfaces:**
- Produces:
  - `validateBlockInput(input, recommendation): { ok: true } | { ok: false; error: string; code: "target_out_of_bounds" | "invalid_input" }` — pure; same bounds rule as propose_block (out-of-bounds needs `override_reason` trimmed length ≥ 4).
  - `insertBlock({supabase, userId, input}): Promise<{ok: true; block: TrainingBlock} | {ok: false; error: string; code: string}>` — insert + acknowledge outstanding outcomes (the two writes currently in `executeCommitBlock`).
  - `POST /api/blocks` body `{primary_lift, target_metric, target_value, start_date, end_date, goal_text, override_reason?}` → `{ok, block?|error}`.
  - `POST /api/blocks/close` body `{reason, preview?: boolean, confirm?: boolean}` → preview returns the would-be outcome (reuses `executeProposeCloseBlock` internals); confirm executes the close via `executeCommitCloseBlock`'s core. Session-authed via `createSupabaseServerClient`; writes via service-role after auth (the executors expect service-role).

- [ ] **Step 1: Failing test for validateBlockInput** — bounds acceptance, out-of-bounds rejection without reason, acceptance with reason ≥4 chars (copy the bounds fixtures from `scripts/audit-prescription-rules.mjs`'s calibrate-target section):

```ts
// lib/coach/blocks/__tests__/create-block.test.ts
import { describe, expect, test } from "vitest";
import { validateBlockInput } from "@/lib/coach/blocks/create-block";

const rec = { recommended_target: 97.5, sanity_bounds: [92.5, 99] as [number, number] };
const base = { primary_lift: "squat", target_metric: "e1rm", target_value: 97.5,
  start_date: "2026-07-13", end_date: "2026-08-16", goal_text: "Squat focus block" };

describe("validateBlockInput", () => {
  test("in-bounds target passes", () => {
    expect(validateBlockInput(base, rec).ok).toBe(true);
  });
  test("out-of-bounds without reason fails with code", () => {
    const r = validateBlockInput({ ...base, target_value: 110 }, rec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("target_out_of_bounds");
  });
  test("out-of-bounds with override_reason passes", () => {
    expect(validateBlockInput({ ...base, target_value: 110, override_reason: "returning from layoff" }, rec).ok).toBe(true);
  });
  test("null recommendation (no bounds) passes any target", () => {
    expect(validateBlockInput({ ...base, target_value: 110 }, null).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module not found).

- [ ] **Step 3: Extract.** Read `executeProposeBlock` (bounds check around `computeTargetRecommendation`) and `executeCommitBlock` (insert + acknowledge) in `lib/coach/tools.ts`. Move the bounds comparison into `validateBlockInput` and the two writes into `insertBlock` in `lib/coach/blocks/create-block.ts`; the executors call the shared functions so chat behavior is byte-identical. Keep the executors' error-shape mapping in tools.ts.

- [ ] **Step 4: Run** `npx vitest run` → new tests PASS, existing 480+ still green. `npm run typecheck` clean.

- [ ] **Step 5: API routes.** `app/api/blocks/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeTargetRecommendation } from "@/lib/coach/prescription/calibrate-target";
import { validateBlockInput, insertBlock } from "@/lib/coach/blocks/create-block";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;
  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);
  const lift = body.primary_lift as "squat" | "bench" | "deadlift" | "ohp";
  const recommendation = await computeTargetRecommendation({ supabase: sr, userId: user.id, lift, todayIso })
    .catch(() => null);

  const v = validateBlockInput(body, recommendation);
  if (!v.ok) return NextResponse.json({ ok: false, ...v }, { status: 422 });

  const result = await insertBlock({ supabase: sr, userId: user.id, input: body });
  if (!result.ok) {
    const status = result.code === "23505" ? 409 : 500;
    return NextResponse.json({ ok: false, ...result }, { status });
  }
  return NextResponse.json({ ok: true, block: result.block });
}
```

`app/api/blocks/close/route.ts` mirrors it: auth → `preview: true` calls `executeProposeCloseBlock` and returns `result.data.preview` (discard the token — the form is the approval); `confirm: true` runs the close through a shared `closeBlockCore` — extract the post-verification body of `executeCommitCloseBlock` (fetch-active → generate outcome+narrative → upsert → block update) into `lib/coach/blocks/close-block.ts` the same way as Step 3 so both the HMAC chat path and the API path run identical writes.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npx vitest run` → clean/pass.
```bash
git add lib/coach/blocks/ app/api/blocks/ lib/coach/tools.ts
git commit -m "feat(blocks): create/close API routes sharing propose/commit validators"
```

---

### Task 6: Blocks tab UI + wiring (ends PR 1)

**Files:**
- Create: `components/strength/StrengthBlocksClient.tsx` (container)
- Create: `components/strength/blocks/CurrentBlockCard.tsx`, `components/strength/blocks/BlockHistoryList.tsx`, `components/strength/blocks/NewBlockEditor.tsx`
- Modify: `app/strength/page.tsx` (SUB_TABS + render), `components/chat/BlockOutcomeCard.tsx` (links → `/strength?tab=blocks&prefill_focus=...`)
- Modify: `components/strength/StrengthCoachClient.tsx` (prefill consumption stays for chat path; no change needed unless removing — leave as is)

**Interfaces:**
- Consumes: `useBlockSummary` (Task 4), `useBlockHistory`-style data via a small fetch of `block_outcomes` + `training_blocks` rows (add `narrative_md` to the select in whichever fetcher serves history — reuse `lib/query/fetchers/blockHistory.ts` pattern with a NEW pair `blocksRepo.ts` that returns raw rows: `{block, outcome}` newest-first), `POST /api/blocks`, `POST /api/blocks/close`.
- Produces: the tab UI per mockup `blocks-tab.html`.

- [ ] **Step 1: Tab wiring.** `app/strength/page.tsx`: add `{ key: "blocks", label: "Blocks" }` after Coach in `SUB_TABS`; extend `parseTab`/`Tab` with `"blocks"`; render `{tab === "blocks" && <StrengthBlocksClient userId={user.id} />}`. Server-prefetch `blockSummary` + repo rows with `makeServerQueryClient` + `HydrationBoundary` (copy the hydrate scaffold from another tab's page section — `app/page.tsx` shows the pattern).

- [ ] **Step 2: Components.** Build per mockup:
  - `CurrentBlockCard`: header row (lift/target via `fmtNum`, week chip, phase badge with the `PHASE_TAGS` color mapping copied from `BlockOutcomeCard.tsx`), 4-KPI pace row, Recharts `LineChart` (weekly points + `ReferenceLine y={target}` dashed), this-week strip with `<Link href="/strength?tab=schedule">`, secondaries row, actions row. "Close block early" opens a confirm dialog (portaled to `document.body`) that first POSTs `{preview:true}` to `/api/blocks/close`, renders target/reached/phase from the preview, then POSTs `{confirm:true, reason}` (a required text input, minlength 4). On success invalidate `queryKeys.blockSummary.all(userId)` + blocks repo key.
  - `BlockHistoryList`: collapsed rows; expand-on-tap shows period, target → reached (+gap_pct), `narrative_md` paragraph, secondary chips. Active block renders an ACTIVE chip and no expansion.
  - Add `GET /api/blocks/recommendation?lift=<lift>` (this task): session-authed thin wrapper over `computeTargetRecommendation` returning `{recommended_target, sanity_bounds, current_e1rm, slope_kg_per_wk, used}`.
  - `NewBlockEditor`: rendered only when `useBlockSummary` returns null. Focus select (4 lifts; default = latest outcome's `recommended_next_focus` from the repo data, falling back to rotation order after the last closed block's lift). Target stepper (grid 2.5) pre-filled from `GET /api/blocks/recommendation` — refetch on lift change; sanity band rendered as a hint line. Read-only period (next Monday +34d via profile tz). Conditional override-reason text field appears when the target is outside the band. Create button POSTs `/api/blocks`; a 422 surfaces the message inline; success invalidates blockSummary + repo keys and the monitor replaces the editor. "Ask Carter first" links `/strength?tab=coach&mode=setup_block`.
  - Consume `prefill_focus`/`prefill_target` search params (same allowlist validation as `StrengthCoachClient`).

- [ ] **Step 3: Re-point BlockOutcomeCard.** In `components/chat/BlockOutcomeCard.tsx` change both hrefs from `/strength?tab=coach&mode=setup_block...` to `/strength?tab=blocks...` keeping the prefill params.

- [ ] **Step 4: Verify.** `npm run typecheck && npx vitest run && npm run build` → all clean. Then dev-server smoke: `/strength?tab=blocks` renders monitor with the live squat block; history shows bench + deadlift with narrative paragraphs (backfilled in Task 3).

- [ ] **Step 5: Commit + PR 1**

```bash
git add app/strength/page.tsx components/strength/ components/chat/BlockOutcomeCard.tsx lib/query/
git commit -m "feat(blocks): Blocks tab — monitor, history w/ narrative, form-first editor"
gh pr create --title "Block Command Center (1/2): Blocks tab + outcome narratives" --body "Per spec docs/superpowers/specs/2026-07-13-block-command-center-design.md — migration 0051, narrative at close + backfill, block summary module, create/close APIs, Blocks tab UI. PR 2 adds the editable schedule."
```

---

## PR 2 — Editable schedule

### Task 7: Manual-edits merge layer in both resolution chains

**Files:**
- Create: `lib/coach/manual-edits.ts`
- Test: `lib/coach/__tests__/manual-edits.test.ts`
- Modify: `lib/coach/sessionPlans.ts` (`getEffectiveSessionPlan` — new optional param)
- Modify: `lib/logger/resolve-plan.ts` (layer 1)
- Modify callers of `getEffectiveSessionPlan` to pass the new arg: `components/strength/StrengthCoachClient.tsx:149`, `components/strength/StrengthScheduleClient.tsx:92`, `components/strength/StrengthClient.tsx:136`, `lib/morning/brief/assembler.ts:493` (each already holds the `training_weeks` row — pass `week.manual_session_edits`).
- Modify: `components/logger/LoggerSheet.tsx` + `components/logger/EditSessionButton.tsx` (pass `manual_session_edits` into `resolveSessionPlan`; LoggerSheet shows an "edited plan" chip when `source === "manual_edit"`).

**Interfaces:**
- Produces:
  - `applyManualSessionEdits(exercises: PlannedExercise[], edits: ManualSessionEdits[WeekdayLong] | undefined | null): { exercises: PlannedExercise[]; touched: boolean }`
  - `getEffectiveSessionPlan(sessionType, weekday, sessionPrescriptions, overrides, userTemplate?, manualEdits?: ManualSessionEdits | null)` — 6th optional param, fully back-compatible.
  - `resolveSessionPlan` accepts `manualEdits?: ManualSessionEdits | null` and returns `source: "manual_edit" | ...existing`.

- [ ] **Step 1: Failing tests**

```ts
// lib/coach/__tests__/manual-edits.test.ts
import { describe, expect, test } from "vitest";
import { applyManualSessionEdits } from "@/lib/coach/manual-edits";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const day: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 3, baseKg: 67.5, baseReps: 8 },
  { name: "RDL", sets: 3, baseKg: 80, baseReps: 8 },
  { name: "Hip Thrust (Machine)", sets: 3, baseKg: 100, baseReps: 10 },
];

describe("applyManualSessionEdits", () => {
  test("per-exercise deltas override only named fields", () => {
    const { exercises, touched } = applyManualSessionEdits(day, {
      exercises: { "Squat (Barbell)": { sets: 4, kg: 70 } },
    });
    expect(touched).toBe(true);
    expect(exercises[0]).toMatchObject({ name: "Squat (Barbell)", sets: 4, baseKg: 70, baseReps: 8 });
    expect(exercises[1]).toMatchObject({ name: "RDL", sets: 3, baseKg: 80 });
  });
  test("order permutes; unknown names in order are ignored (falls back to input order)", () => {
    const { exercises } = applyManualSessionEdits(day, {
      order: ["RDL", "Squat (Barbell)", "Hip Thrust (Machine)"],
    });
    expect(exercises.map((e) => e.name)).toEqual(["RDL", "Squat (Barbell)", "Hip Thrust (Machine)"]);
    const bad = applyManualSessionEdits(day, { order: ["Nonexistent"] });
    expect(bad.exercises.map((e) => e.name)).toEqual(day.map((e) => e.name));
  });
  test("edits naming a missing exercise are skipped, others still apply", () => {
    const { exercises } = applyManualSessionEdits(day, {
      exercises: { Ghost: { sets: 9 }, RDL: { reps: 10 } },
    });
    expect(exercises[1].baseReps).toBe(10);
    expect(exercises.every((e) => e.sets !== 9)).toBe(true);
  });
  test("null/empty edits → untouched, same array content", () => {
    expect(applyManualSessionEdits(day, null).touched).toBe(false);
    expect(applyManualSessionEdits(day, {}).touched).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL. 

- [ ] **Step 3: Implement**

```ts
// lib/coach/manual-edits.ts
// Athlete-owned week-scope edit layer (migration 0051). Merges ABOVE
// session_prescriptions in both resolution chains, so engine repatches keep
// flowing to untouched exercises while manually edited entries hold.
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ManualSessionEdits, WeekdayLong } from "@/lib/data/types";

type DayEdits = NonNullable<ManualSessionEdits[WeekdayLong]>;

export function applyManualSessionEdits(
  exercises: PlannedExercise[],
  edits: DayEdits | null | undefined,
): { exercises: PlannedExercise[]; touched: boolean } {
  if (!edits || (!edits.order && !edits.exercises)) return { exercises, touched: false };
  let out = exercises.map((e) => ({ ...e }));
  let touched = false;

  const byName = new Map(out.map((e) => [e.name, e]));
  if (edits.exercises) {
    for (const [name, d] of Object.entries(edits.exercises)) {
      const ex = byName.get(name);
      if (!ex) continue;
      if (d.sets != null) { ex.sets = d.sets; touched = true; }
      if (d.kg != null) { ex.baseKg = d.kg; touched = true; }
      if (d.reps != null) { ex.baseReps = d.reps; touched = true; }
    }
  }
  if (edits.order && edits.order.length > 0) {
    const wanted = edits.order.filter((n) => byName.has(n));
    if (wanted.length === out.length) {
      out = wanted.map((n) => byName.get(n)!);
      touched = true;
    }
  }
  return { exercises: out, touched };
}
```

`getEffectiveSessionPlan`: add 6th param `manualEdits?: ManualSessionEdits | null`; after the existing chain resolves `result`, run `applyManualSessionEdits(result, manualEdits?.[weekday as WeekdayLong])` and return its exercises. `resolveSessionPlan`: same wrap around whatever layer resolved; when `touched`, return `source: "manual_edit"`. Update the 4 client callers + 2 logger callers to pass `committedWeek?.manual_session_edits ?? null` (each already fetches the training_weeks row — extend the row select if the fetcher enumerates columns; check `lib/query/fetchers/trainingWeek*.ts` select strings).

- [ ] **Step 4: Run** — `npx vitest run` all pass, `npm run typecheck` clean, `npm run build` clean (client callers changed).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(schedule): manual_session_edits merge layer across both resolution chains"`

---

### Task 8: prescribeWeek × session_structure_overrides

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts`
- Create: `lib/coach/prescription/structure-overrides.ts`
- Test: `lib/coach/prescription/__tests__/structure-overrides.test.ts`
- Modify: `scripts/audit-prescription-rules.mjs` (2 assertions)

**Interfaces:**
- Produces: `applyStructureOverrides(dayExercises: PlannedExercise[], sessionType: string, overrides: SessionStructureOverrides | null): PlannedExercise[]` — order applied post-composition (permutation-only, same tolerance as `applyManualSessionEdits.order`), per-exercise set counts override engine counts. Runs BEFORE warmup-set post-processing (warmups derive from final structure).
- Consumes: `TrainingBlock.session_structure_overrides` (block row already passed into `prescribeWeek` as `opts.block`).

- [ ] **Step 1: Failing test**

```ts
// lib/coach/prescription/__tests__/structure-overrides.test.ts
import { describe, expect, test } from "vitest";
import { applyStructureOverrides } from "@/lib/coach/prescription/structure-overrides";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const legs: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 3 },
  { name: "RDL", sets: 3 },
];

describe("applyStructureOverrides", () => {
  test("set counts override; order permutes", () => {
    const out = applyStructureOverrides(legs, "Legs", {
      Legs: { order: ["RDL", "Squat (Barbell)"], sets: { RDL: 4 } },
    });
    expect(out.map((e) => e.name)).toEqual(["RDL", "Squat (Barbell)"]);
    expect(out[0].sets).toBe(4);
  });
  test("null overrides / other session types are no-ops", () => {
    expect(applyStructureOverrides(legs, "Legs", null)).toEqual(legs);
    expect(applyStructureOverrides(legs, "Legs", { Chest: { sets: { RDL: 5 } } })).toEqual(legs);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** (mirror `applyManualSessionEdits` mechanics, sets+order only; ~25 lines). Then in `prescribeWeek`, at the point where each day's exercise list is finalized but BEFORE the warmup post-processing (find the `sets + 2` warmup step from the 2026-06 warmup rule), insert:

```ts
const structured = applyStructureOverrides(dayExercises, sessionType, block?.session_structure_overrides ?? null);
```

- [ ] **Step 4: Run** — module tests pass; full `npx vitest run` green; `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs` passes with 2 new assertions (override respected; null → byte-identical output).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(prescription): block-scope structure overrides in prescribeWeek"`

---

### Task 9: Edit-write API routes

**Files:**
- Create: `app/api/training-weeks/[week_start]/manual-edits/route.ts` (PATCH)
- Create: `app/api/blocks/[id]/structure-overrides/route.ts` (PATCH)
- Test: `lib/coach/__tests__/manual-edits-validation.test.ts`

**Interfaces:**
- Produces:
  - `PATCH /api/training-weeks/[week_start]/manual-edits` body `{weekday: WeekdayLong, edits: {order?, exercises?} | null}` — null clears the day. Validates: `week_start` is the current Monday; order is a permutation of the currently-resolved day (resolve server-side via `resolveSessionPlan` sans manual layer); sets 1–10; kg 0–500 on a 0.25 grid; reps 1–30.
  - `PATCH /api/blocks/[id]/structure-overrides` body `{session_type: string, override: {order?, sets?} | null}` — block must be `status='active'` and owned; same order/sets validation against `SESSION_PLANS[session_type]` names ∪ current week's resolved day.
  - Pure validator exported for tests: `validateDayEdits(edits, resolvedNames: string[]): {ok: true} | {ok: false; error: string}` in `lib/coach/manual-edits.ts`.

- [ ] **Step 1: Failing validator tests** (permutation mismatch rejected; sets 0 rejected; kg 71.13 rejected off-grid; happy path passes):

```ts
// lib/coach/__tests__/manual-edits-validation.test.ts
import { describe, expect, test } from "vitest";
import { validateDayEdits } from "@/lib/coach/manual-edits";

const names = ["Squat (Barbell)", "RDL"];
describe("validateDayEdits", () => {
  test("happy path", () => {
    expect(validateDayEdits({ order: ["RDL", "Squat (Barbell)"], exercises: { RDL: { sets: 4, kg: 82.5, reps: 8 } } }, names).ok).toBe(true);
  });
  test("order must be a permutation", () => {
    expect(validateDayEdits({ order: ["RDL"] }, names).ok).toBe(false);
  });
  test("bounds: sets>=1, kg on 0.25 grid, reps<=30", () => {
    expect(validateDayEdits({ exercises: { RDL: { sets: 0 } } }, names).ok).toBe(false);
    expect(validateDayEdits({ exercises: { RDL: { kg: 71.13 } } }, names).ok).toBe(false);
    expect(validateDayEdits({ exercises: { RDL: { reps: 31 } } }, names).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implement `validateDayEdits` + both routes (auth via `createSupabaseServerClient`; jsonb read-modify-write of the single day/session_type key via service-role after ownership check; block route re-runs `prescribeWeek` for the CURRENT week and upserts `session_prescriptions` + applies order/sets into `manual_session_edits` for immediate visibility, per spec).

- [ ] **Step 4: Run** — tests pass, typecheck clean.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(schedule): manual-edits + structure-overrides write APIs"`

---

### Task 10: Schedule edit UI + block strip (ends PR 2)

**Files:**
- Modify: `components/strength/StrengthScheduleClient.tsx` (block context strip; Edit button per day)
- Create: `components/strength/schedule/DayEditSheet.tsx` (steppers + reorder + Save scope dialog; portaled)
- Modify: `components/strength/WeekScheduleAccordion.tsx` (Edit affordance per day row — read the component first; if rows are rendered by `ScheduleDayRow`, put the button there)

**Interfaces:**
- Consumes: `useBlockSummary` (strip), `PATCH` routes (Task 9), `applyManualSessionEdits` for optimistic preview, exercise `increment.step` from resolved `PlannedExercise` for weight stepper grid (fallback 2.5).
- Produces: the UX per mockup `schedule-edit.html` — EDITED chip, engine-values subtext, per-row reset, Save → "This week only" / "Whole block" dialog (block option disabled with hint when no active block).

- [ ] **Step 1: Block context strip.** In `StrengthScheduleClient`, when `useBlockSummary` returns a payload and the viewed week is the current week: render the strip (lift · week N/5 · RIR · intensity, "VIEW BLOCK →" `Link` to `/strength?tab=blocks`).

- [ ] **Step 2: DayEditSheet.** Bottom sheet (portal to `document.body`, z-50 — the LoggerSheet stacking-context lesson): rows per resolved exercise with sets/kg/reps steppers (kg step = `increment.step ?? 2.5`), ▲▼ reorder buttons, EDITED chip when a row differs from the engine-resolved baseline, "reset to plan" per row, footer Save. Save opens the scope dialog: **This week only** → PATCH manual-edits with the full diff (order if changed + per-exercise deltas); **Whole block** → PATCH structure-overrides `{order?, sets?}` (strip kg/reps from the payload; show the "weights & reps stay coach-managed across weeks" note). On success: invalidate `queryKeys.trainingWeeks`-family + `blockSummary` + close.

- [ ] **Step 3: Verify.** `npm run typecheck && npx vitest run && npm run build` all green. Manual smoke on dev: edit Monday squat to 4×70 (this week) → `/strength?tab=schedule` shows EDITED chip; open logger for Monday → 4 working sets @ 70 with "edited plan" chip; save a block-scope reorder → next week's prescription (via `get_week_prescription` or the Sunday cron dry-run) reflects the order.

- [ ] **Step 4: Commit + PR 2**

```bash
git add -A && git commit -m "feat(schedule): day edit sheet with week/block scope + block context strip"
gh pr create --title "Block Command Center (2/2): editable schedule" --body "Manual edit layers wired end-to-end: schedule edit UI → manual_session_edits / session_structure_overrides → resolution chains → logger. Per spec docs/superpowers/specs/2026-07-13-block-command-center-design.md."
```

---

## Post-merge checklist

- Update CLAUDE.md: migration 0051 entry (next free slot → 0052), Blocks tab in Routes section, manual-edit layers in the resolution-chain docs (logger + session-structure sections).
- Run `AUDIT_USER_ID=<uuid> ... scripts/audit-sunday-prescription-e2e.mjs` after the first real Sunday cron with a structure override in place.
