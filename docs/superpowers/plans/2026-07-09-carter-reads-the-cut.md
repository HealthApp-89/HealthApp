# Carter Reads the Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carter gets read-only visibility into body comp + daily intake totals and a deterministic `get_strength_per_lbm_trend` tool, so strength-on-a-cut questions are answered in-lane instead of bounced to Peter.

**Architecture:** One pure compute module (`lib/coach/strength-per-lbm-trend.ts`) pairs weekly best e1RM with weekly average lean mass and returns a ratio series + OLS slope + categorical verdict. A thin executor in `tools.ts` fetches the window and calls it. `CARTER_COLS` widens by six read-only columns (the single `colsForSpeaker` seam does the rest). CARTER_BASE's scope boundary flips from "can't see" to "can't prescribe".

**Tech Stack:** Next.js 15, TypeScript strict, fixture-based audit scripts (`scripts/audit-prescription-rules.mjs`, currently 206 assertions).

**Spec:** [docs/superpowers/specs/2026-07-09-carter-reads-the-cut-design.md](../specs/2026-07-09-carter-reads-the-cut-design.md)

## Global Constraints

- Read-only arc: NO write tools move; `query_food_log` stays Nora-only; NORA_COLS / REMI_COLS / PETER_COLS untouched.
- New CARTER_COLS additions exactly: `weight_kg, body_fat_pct, fat_free_mass_kg, muscle_mass_kg, calories_eaten, protein_g`.
- Tool verdict thresholds: relative weekly slope (`slope / mean(ratio) × 100`) — `rising` > +0.5, `falling` < −0.5, `holding` otherwise; `< 3` paired weeks → `insufficient_data` (series still returned, slopes null).
- Weekly pairing: Monday-keyed ISO weeks; weeks missing either e1RM or LBM are OMITTED (never interpolated); LBM = `fat_free_mass_kg` ?? `weight_kg × (1 − body_fat_pct/100)` when both parts exist.
- e1RM = max Brzycki over non-warmup sets with 1..12 reps (same window convention as `bestComparisonValue`).
- `weeks` input clamped 4..12, default 8 (executor-side).
- All 206 pre-existing audit assertions stay green.
- Audit command: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
- Branch `feat/carter-reads-the-cut` (exists; commits auto-push — never commit on main).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Pure compute module + fixtures

**Files:**
- Create: `lib/coach/strength-per-lbm-trend.ts`
- Modify: `lib/coach/prescription/target-hit-evaluator.ts:20` (export the name-pattern map)
- Test: `scripts/audit-prescription-rules.mjs` (append fixtures)

**Interfaces:**
- Consumes: `brzycki` from `@/lib/coach/e1rm`; `strengthPerLbm` from `@/lib/coach/progress-metrics`; `olsSlope` from `@/lib/coach/trends/linear-regression` (signature: `olsSlope(points: readonly {x:number;y:number}[]): number | null`); `mondayOfIso` from `@/lib/time/dates`; `PrimaryLift` from `@/lib/data/types`.
- Produces (Task 2 imports these):
  - `export const PRIMARY_LIFT_NAME_PATTERNS` from `@/lib/coach/prescription/target-hit-evaluator` (export keyword added, no body change)
  - From the new module:
    - `type StrengthLbmSetSample = { kg: number; reps: number; warmup: boolean; performed_on: string }`
    - `type BodyCompRow = { date: string; fat_free_mass_kg: number | null; weight_kg: number | null; body_fat_pct: number | null }`
    - `type StrengthPerLbmTrend = { lift: PrimaryLift; weeks_requested: number; weeks_with_data: number; series: Array<{ week_start: string; best_e1rm: number; avg_lbm_kg: number; ratio: number }>; slope_per_week: number | null; relative_slope_pct_per_week: number | null; verdict: "rising" | "holding" | "falling" | "insufficient_data" }`
    - `computeStrengthPerLbmTrend(opts: { lift: PrimaryLift; weeksRequested: number; sets: StrengthLbmSetSample[]; bodyRows: BodyCompRow[] }): StrengthPerLbmTrend`

- [ ] **Step 1: Write the failing fixtures**

Append to `scripts/audit-prescription-rules.mjs` before the final `summary()` (new import: `import { computeStrengthPerLbmTrend } from "@/lib/coach/strength-per-lbm-trend";`):

```js
console.log("\n## strength-per-lbm-trend.ts — cut-context trend core\n");

{
  // Helper: one clean top set + one LBM reading per listed Monday week.
  const set = (kg, reps, date) => ({ kg, reps, warmup: false, performed_on: date });
  const body = (date, ffm, weight = null, bf = null) =>
    ({ date, fat_free_mass_kg: ffm, weight_kg: weight, body_fat_pct: bf });

  // 4 paired weeks, ratio perfectly flat (e1RM and LBM both constant).
  const flat = computeStrengthPerLbmTrend({
    lift: "squat",
    weeksRequested: 8,
    sets: [
      set(100, 5, "2026-06-15"), set(100, 5, "2026-06-22"),
      set(100, 5, "2026-06-29"), set(100, 5, "2026-07-06"),
    ],
    bodyRows: [
      body("2026-06-16", 70), body("2026-06-23", 70),
      body("2026-06-30", 70), body("2026-07-07", 70),
    ],
  });
  assert("flat: 4 paired weeks", flat.weeks_with_data === 4);
  assert("flat: verdict holding", flat.verdict === "holding");
  assert("flat: ratio = brzycki(100,5)/70", Math.abs(flat.series[0].ratio - (100 * 36 / (37 - 5)) / 70) < 1e-9);
  assert("flat: series Monday-keyed", flat.series[0].week_start === "2026-06-15");

  // Missing-week omission: 3 weeks of sets, only 2 have body data → 2 paired.
  const gaps = computeStrengthPerLbmTrend({
    lift: "squat", weeksRequested: 8,
    sets: [set(100, 5, "2026-06-22"), set(100, 5, "2026-06-29"), set(100, 5, "2026-07-06")],
    bodyRows: [body("2026-06-23", 70), body("2026-07-07", 70)],
  });
  assert("gaps: unpaired week omitted", gaps.weeks_with_data === 2);
  assert("gaps: <3 weeks → insufficient_data", gaps.verdict === "insufficient_data");
  assert("gaps: slopes null on insufficient", gaps.slope_per_week === null && gaps.relative_slope_pct_per_week === null);
  assert("gaps: series still returned", gaps.series.length === 2);

  // LBM fallback derivation: no ffm, weight 100 @ 30% bf → LBM 70.
  const derived = computeStrengthPerLbmTrend({
    lift: "squat", weeksRequested: 8,
    sets: [set(100, 5, "2026-06-22"), set(100, 5, "2026-06-29"), set(100, 5, "2026-07-06")],
    bodyRows: [
      body("2026-06-23", null, 100, 30), body("2026-06-30", null, 100, 30), body("2026-07-07", null, 100, 30),
    ],
  });
  assert("fallback: LBM derived from weight × (1−bf%)", Math.abs(derived.series[0].avg_lbm_kg - 70) < 1e-9);
  assert("fallback: 3 paired weeks → verdict computed", derived.verdict === "holding");

  // Rising: LBM constant, e1RM +2%/wk → relative slope ≈ +2 > +0.5.
  const rising = computeStrengthPerLbmTrend({
    lift: "squat", weeksRequested: 8,
    sets: [set(100, 5, "2026-06-15"), set(102, 5, "2026-06-22"), set(104, 5, "2026-06-29"), set(106, 5, "2026-07-06")],
    bodyRows: [body("2026-06-16", 70), body("2026-06-23", 70), body("2026-06-30", 70), body("2026-07-07", 70)],
  });
  assert("rising verdict", rising.verdict === "rising");

  // Falling: e1RM constant, LBM rising 2%/wk → ratio falls ≈ −2%/wk.
  const falling = computeStrengthPerLbmTrend({
    lift: "squat", weeksRequested: 8,
    sets: [set(100, 5, "2026-06-15"), set(100, 5, "2026-06-22"), set(100, 5, "2026-06-29"), set(100, 5, "2026-07-06")],
    bodyRows: [body("2026-06-16", 70), body("2026-06-23", 71.4), body("2026-06-30", 72.8), body("2026-07-07", 74.2)],
  });
  assert("falling verdict", falling.verdict === "falling");

  // Warmups and >12-rep sets excluded from e1RM.
  const filtered = computeStrengthPerLbmTrend({
    lift: "squat", weeksRequested: 8,
    sets: [
      { kg: 140, reps: 5, warmup: true, performed_on: "2026-07-06" },
      set(60, 20, "2026-07-06"),
      set(100, 5, "2026-07-06"),
      set(100, 5, "2026-06-29"), set(100, 5, "2026-06-22"),
    ],
    bodyRows: [body("2026-07-07", 70), body("2026-06-30", 70), body("2026-06-23", 70)],
  });
  assert("filter: warmup + >12-rep sets excluded", Math.abs(filtered.series[filtered.series.length - 1].best_e1rm - (100 * 36 / 32)) < 1e-9);

  // Multiple LBM readings in one week average.
  const avg = computeStrengthPerLbmTrend({
    lift: "squat", weeksRequested: 8,
    sets: [set(100, 5, "2026-06-22"), set(100, 5, "2026-06-29"), set(100, 5, "2026-07-06")],
    bodyRows: [body("2026-07-06", 69), body("2026-07-08", 71), body("2026-06-30", 70), body("2026-06-23", 70)],
  });
  assert("avg: multiple readings averaged", Math.abs(avg.series[avg.series.length - 1].avg_lbm_kg - 70) < 1e-9);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Export the name-pattern map**

In `lib/coach/prescription/target-hit-evaluator.ts:20`, change `const PRIMARY_LIFT_NAME_PATTERNS` to `export const PRIMARY_LIFT_NAME_PATTERNS` (no body change; JSDoc stays).

- [ ] **Step 4: Implement the module**

Create `lib/coach/strength-per-lbm-trend.ts`:

```ts
// lib/coach/strength-per-lbm-trend.ts
//
// Deterministic "is my strength holding on the cut?" answer: pairs weekly
// best e1RM (Brzycki, non-warmup, 1..12 reps) with weekly average lean body
// mass and returns the ratio series + OLS slope + categorical verdict.
// Pure core — the get_strength_per_lbm_trend tool executor in
// lib/coach/tools.ts fetches the window and calls this. The coach narrates
// the verdict; it never recomputes or extrapolates (house philosophy: the
// math computes, the coach speaks).
//
// Weeks missing either side are OMITTED, never interpolated — absence is the
// signal, matching the adherence convention. Fewer than 3 paired weeks →
// "insufficient_data" with whatever series exists.
//
// Spec: docs/superpowers/specs/2026-07-09-carter-reads-the-cut-design.md

import type { PrimaryLift } from "@/lib/data/types";
import { brzycki } from "@/lib/coach/e1rm";
import { strengthPerLbm } from "@/lib/coach/progress-metrics";
import { olsSlope } from "@/lib/coach/trends/linear-regression";
import { mondayOfIso } from "@/lib/time/dates";

export type StrengthLbmSetSample = {
  kg: number;
  reps: number;
  warmup: boolean;
  performed_on: string; // YYYY-MM-DD
};

export type BodyCompRow = {
  date: string; // YYYY-MM-DD
  fat_free_mass_kg: number | null;
  weight_kg: number | null;
  body_fat_pct: number | null;
};

export type StrengthPerLbmTrend = {
  lift: PrimaryLift;
  weeks_requested: number;
  weeks_with_data: number;
  series: Array<{ week_start: string; best_e1rm: number; avg_lbm_kg: number; ratio: number }>;
  slope_per_week: number | null;
  relative_slope_pct_per_week: number | null;
  verdict: "rising" | "holding" | "falling" | "insufficient_data";
};

const MIN_PAIRED_WEEKS = 3;
const HOLDING_BAND_PCT = 0.5; // |relative weekly slope| ≤ 0.5% → holding

/** Lean body mass for one reading: prefer the measured fat-free mass; derive
 *  from weight × (1 − bf%) when both components exist; null otherwise. */
function lbmForRow(r: BodyCompRow): number | null {
  if (r.fat_free_mass_kg != null && r.fat_free_mass_kg > 0) return r.fat_free_mass_kg;
  if (r.weight_kg != null && r.weight_kg > 0 && r.body_fat_pct != null && r.body_fat_pct >= 0 && r.body_fat_pct < 100) {
    return r.weight_kg * (1 - r.body_fat_pct / 100);
  }
  return null;
}

export function computeStrengthPerLbmTrend(opts: {
  lift: PrimaryLift;
  weeksRequested: number;
  sets: StrengthLbmSetSample[];
  bodyRows: BodyCompRow[];
}): StrengthPerLbmTrend {
  // Weekly best e1RM (Brzycki window: non-warmup, 1..12 reps).
  const e1rmByWeek = new Map<string, number>();
  for (const s of opts.sets) {
    if (s.warmup) continue;
    if (s.reps < 1 || s.reps > 12) continue;
    const v = brzycki(s.kg, s.reps);
    if (v == null) continue;
    const wk = mondayOfIso(s.performed_on);
    const cur = e1rmByWeek.get(wk);
    if (cur == null || v > cur) e1rmByWeek.set(wk, v);
  }

  // Weekly average LBM.
  const lbmByWeek = new Map<string, number[]>();
  for (const r of opts.bodyRows) {
    const lbm = lbmForRow(r);
    if (lbm == null) continue;
    const wk = mondayOfIso(r.date);
    const list = lbmByWeek.get(wk) ?? [];
    list.push(lbm);
    lbmByWeek.set(wk, list);
  }

  // Pair, oldest-first. Weeks missing either side are omitted.
  const series: StrengthPerLbmTrend["series"] = [];
  const weeks = [...e1rmByWeek.keys()].filter((wk) => lbmByWeek.has(wk)).sort();
  for (const wk of weeks) {
    const best = e1rmByWeek.get(wk)!;
    const lbms = lbmByWeek.get(wk)!;
    const avgLbm = lbms.reduce((a, b) => a + b, 0) / lbms.length;
    const ratio = strengthPerLbm(best, avgLbm);
    if (ratio == null) continue;
    series.push({ week_start: wk, best_e1rm: best, avg_lbm_kg: avgLbm, ratio });
  }

  if (series.length < MIN_PAIRED_WEEKS) {
    return {
      lift: opts.lift,
      weeks_requested: opts.weeksRequested,
      weeks_with_data: series.length,
      series,
      slope_per_week: null,
      relative_slope_pct_per_week: null,
      verdict: "insufficient_data",
    };
  }

  const slope = olsSlope(series.map((p, i) => ({ x: i, y: p.ratio })));
  const meanRatio = series.reduce((a, p) => a + p.ratio, 0) / series.length;
  const relPct = slope != null && meanRatio > 0 ? (slope / meanRatio) * 100 : null;

  let verdict: StrengthPerLbmTrend["verdict"] = "holding";
  if (relPct != null && relPct > HOLDING_BAND_PCT) verdict = "rising";
  else if (relPct != null && relPct < -HOLDING_BAND_PCT) verdict = "falling";

  return {
    lift: opts.lift,
    weeks_requested: opts.weeksRequested,
    weeks_with_data: series.length,
    series,
    slope_per_week: slope,
    relative_slope_pct_per_week: relPct,
    verdict,
  };
}
```

Note: verify `brzycki`'s exact signature in `lib/coach/e1rm.ts` before wiring (expected `brzycki(kg: number, reps: number): number | null`); if it differs, adapt the call, not the math.

- [ ] **Step 5: Run fixtures to verify pass**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS — 220 total (206 + 14).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/strength-per-lbm-trend.ts lib/coach/prescription/target-hit-evaluator.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(coach): strength-per-LBM trend core (pure)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Columns, tool, executor, registration

**Files:**
- Modify: `lib/coach/tools.ts` (CARTER_COLS ~line 119; tool schema near GET_WEEK_PRESCRIPTION_TOOL ~line 344; executor near executeGetAutoregulationSignals ~line 1504; CARTER_TOOLS ~line 6557 + PETER_TOOLS ~line 6506)
- Modify: `lib/coach/chat-stream.ts` (executor registry, ~line 438)
- Test: `scripts/audit-prescription-rules.mjs` (allowlist pin)

**Interfaces:**
- Consumes: `computeStrengthPerLbmTrend`, `StrengthLbmSetSample`, `BodyCompRow` (Task 1); `PRIMARY_LIFT_NAME_PATTERNS` from `@/lib/coach/prescription/target-hit-evaluator` (Task 1); existing `isYmd`/`getUserTimezone`/`todayInUserTz`/`isoDaysAgo` helpers already imported in tools.ts (verify; add imports if any are missing).
- Produces: tool `get_strength_per_lbm_trend` callable by Carter + Peter; `CARTER_COLS` widened.

- [ ] **Step 1: Failing allowlist-pin fixture**

Append to `scripts/audit-prescription-rules.mjs` (import `CARTER_COLS` from `"@/lib/coach/tools"` — CAUTION: tools.ts imports server-only modules; if the audit script fails to load it under node, put the pin in a comparison against a literal copy instead — try the import first, and if `next/headers` breaks the run, pin via a small standalone check: read the file with `fs.readFileSync` and assert the six new column names appear inside the `CARTER_COLS` block):

```js
console.log("\n## CARTER_COLS — read-access allowlist pin\n");
{
  const src = fs.readFileSync(new URL("../lib/coach/tools.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("export const CARTER_COLS"), src.indexOf("export const NORA_COLS"));
  for (const col of ["recovery", "strain", "sleep_hours", "sleep_score", "weight_kg", "body_fat_pct", "fat_free_mass_kg", "muscle_mass_kg", "calories_eaten", "protein_g"]) {
    assert(`CARTER_COLS contains ${col}`, block.includes(`"${col}"`));
  }
  assert("CARTER_COLS has exactly 10 columns", (block.match(/"/g) ?? []).length === 20);
}
```

(Add `import fs from "node:fs";` at the top of the script if absent.) Run the audit — the weight_kg/…/protein_g assertions FAIL against current code.

- [ ] **Step 2: Widen CARTER_COLS**

Replace the `CARTER_COLS` block in `lib/coach/tools.ts` with the spec's exact code:

```ts
export const CARTER_COLS = [
  "recovery", "strain",
  "sleep_hours", "sleep_score",
  // Read-only cut context (2026-07-09): body comp + day-level intake totals.
  // Carter READS these to answer strength-on-a-cut questions; prescribing
  // changes to them stays with Nora/Peter (see CARTER_BASE scope boundaries).
  "weight_kg", "body_fat_pct", "fat_free_mass_kg", "muscle_mass_kg",
  "calories_eaten", "protein_g",
] as const satisfies readonly AllowedColumn[];
```

- [ ] **Step 3: Tool schema**

Add after `GET_WEEK_PRESCRIPTION_TOOL`'s closing brace in `lib/coach/tools.ts`:

```ts
export const STRENGTH_PER_LBM_TREND_TOOL = {
  name: "get_strength_per_lbm_trend",
  description:
    "Deterministic 'is my strength holding on the cut?' answer for one big-four lift: weekly best e1RM (Brzycki) divided by weekly average lean body mass, with OLS slope and a categorical verdict (rising / holding / falling; insufficient_data below 3 paired weeks). Weeks missing strength or body-comp data are OMITTED, never interpolated — if weeks_with_data is low, say what's missing instead of extrapolating. Quote the verdict and 2-3 series points verbatim; never recompute or extend the trend yourself.",
  input_schema: {
    type: "object" as const,
    required: ["lift"],
    properties: {
      lift: { type: "string", enum: ["squat", "bench", "deadlift", "ohp"] },
      weeks: { type: "number", description: "Trend window in weeks, clamped 4-12. Default 8." },
    },
  },
};
```

- [ ] **Step 4: Executor**

Add near `executeGetAutoregulationSignals` (same conventions: `t0`, ToolResult shape, `.eq("user_id", …)` security invariant):

```ts
// ── get_strength_per_lbm_trend executor ──────────────────────────────────────

export async function executeGetStrengthPerLbmTrend(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<StrengthPerLbmTrend>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  const lift = i.lift as PrimaryLift | undefined;
  if (lift !== "squat" && lift !== "bench" && lift !== "deadlift" && lift !== "ohp") {
    return { ok: false, error: { error: "lift must be one of squat|bench|deadlift|ohp" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const weeksRaw = typeof i.weeks === "number" && Number.isFinite(i.weeks) ? Math.round(i.weeks) : 8;
  const weeks = Math.min(12, Math.max(4, weeksRaw));

  const todayIso = todayInUserTz(new Date(), await getUserTimezone(opts.userId));
  const fromIso = isoDaysAgo(todayIso, weeks * 7);

  const patterns = (PRIMARY_LIFT_NAME_PATTERNS[lift] ?? []).map((p) => p.toLowerCase());

  const [workoutsRes, bodyRes] = await Promise.all([
    opts.supabase
      .from("workouts")
      .select("date, exercises(name, exercise_sets(kg, reps, warmup))")
      .eq("user_id", opts.userId)
      .gte("date", fromIso)
      .order("date", { ascending: false }),
    opts.supabase
      .from("daily_logs")
      .select("date, fat_free_mass_kg, weight_kg, body_fat_pct")
      .eq("user_id", opts.userId)
      .gte("date", fromIso)
      .order("date", { ascending: true }),
  ]);
  if (workoutsRes.error) {
    return { ok: false, error: { error: workoutsRes.error.message }, meta: { ms: Date.now() - t0, range_days: weeks * 7 } };
  }
  if (bodyRes.error) {
    return { ok: false, error: { error: bodyRes.error.message }, meta: { ms: Date.now() - t0, range_days: weeks * 7 } };
  }

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null };
  type RawExercise = { name: string; exercise_sets: RawSet[] | null };
  type RawWorkout = { date: string; exercises: RawExercise[] | null };

  const sets: StrengthLbmSetSample[] = [];
  for (const w of (workoutsRes.data as unknown as RawWorkout[]) ?? []) {
    for (const ex of w.exercises ?? []) {
      if (!patterns.includes(ex.name.trim().toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
        sets.push({ kg: s.kg, reps: s.reps, warmup: !!s.warmup, performed_on: w.date });
      }
    }
  }

  const result = computeStrengthPerLbmTrend({
    lift,
    weeksRequested: weeks,
    sets,
    bodyRows: (bodyRes.data ?? []) as BodyCompRow[],
  });
  return { ok: true, data: result, meta: { ms: Date.now() - t0, result_rows: result.series.length, range_days: weeks * 7, truncated: false } };
}
```

Add the imports at the top of tools.ts: `computeStrengthPerLbmTrend`, `StrengthPerLbmTrend`, `StrengthLbmSetSample`, `BodyCompRow` from `@/lib/coach/strength-per-lbm-trend`; `PRIMARY_LIFT_NAME_PATTERNS` from `@/lib/coach/prescription/target-hit-evaluator`; verify `isoDaysAgo` is imported (add from `@/lib/time/dates` if not). Check the file's actual `ToolResult` generic shape and match it.

- [ ] **Step 5: Register**

- `CARTER_TOOLS`: add `STRENGTH_PER_LBM_TREND_TOOL,` after `GET_WEEK_PRESCRIPTION_TOOL,`.
- `PETER_TOOLS`: same insertion (locate the corresponding read-tools cluster in the array).
- `lib/coach/chat-stream.ts` executor registry (~line 438 pattern): add

```ts
  get_strength_per_lbm_trend: (a) =>
    executeGetStrengthPerLbmTrend({ supabase: a.supabase, userId: a.userId, input: a.input }),
```

matching the surrounding entries' exact call shape (read 2-3 neighbors first; import `executeGetStrengthPerLbmTrend` alongside the other executors). Mode gating needs NO change: `get_*` names pass plan_week/setup_block (not `apply_`/`set_`-prefixed), pass default mode, and are correctly absent from intake's allowlist — verify by reading `modeAllowsTool`'s default-mode branch and confirm in your report.

- [ ] **Step 6: Verify + commit**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && npm run typecheck && npx vitest run`
Expected: audit 231 (220 + 11 pins), typecheck clean, vitest 460.

```bash
git add lib/coach/tools.ts lib/coach/chat-stream.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(coach): widen Carter's read columns; get_strength_per_lbm_trend tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Prose + full verification

**Files:**
- Modify: `lib/coach/system-prompts.ts:96` (CARTER_BASE scope paragraph) and `~:245` (NORA_BASE)

**Interfaces:** none — prose only.

- [ ] **Step 1: Replace CARTER_BASE's scope paragraph**

The paragraph at line ~96 (starts "You can read recovery-relevant columns on daily_logs (recovery, strain, sleep_hours, sleep_score) for autoregulation, but you do NOT have access to nutrition data…") is replaced with:

```
You can read recovery columns (recovery, strain, sleep_hours, sleep_score) for autoregulation, AND — read-only cut context — body composition (weight_kg, body_fat_pct, fat_free_mass_kg, muscle_mass_kg) plus day-level intake totals (calories_eaten, protein_g) on daily_logs. Strength-on-a-cut questions are YOURS: call get_strength_per_lbm_trend and narrate its verdict plus 2-3 series points verbatim — never recompute the trend or extrapolate beyond the returned window. Connect rough sessions to fueling context when the data shows it ("1,400 kcal the day before a leg day is under-fueled — worth flagging to Nora"). You NEVER propose changes to nutrition targets, diet structure, meal content, or GLP-1 medication handling. When the remedy is dietary, state the observation, then name the hand-off explicitly: "that change is Nora's call — raise it with her." Item-level food questions ("what did I eat Tuesday?") remain Nora's — you do not have query_food_log.
```

- [ ] **Step 2: NORA_BASE sentence**

After the sentence ending "protein-per-LBM is your bread and butter." (line ~245), insert:

```
 Coach Carter can also READ body-comp and day-level intake totals (kcal, protein) for strength-on-a-cut context — that's sanctioned, don't correct him for citing them; prescribing intake changes remains exclusively yours.
```

- [ ] **Step 3: Full verification suite**

```bash
npm run typecheck
npx vitest run
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
node scripts/audit-timezone-usage.mjs
npm run build
```

Expected: all PASS (audit 231). Optionally with live creds (read-only): `AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-speaker-routing.mjs` for a routing sanity look.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): Carter's read-vs-prescribe wall; teach Nora the shared read

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
