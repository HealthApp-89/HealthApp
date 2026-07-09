# Carter Reads the Cut — Design

**Date:** 2026-07-09
**Status:** Approved
**Arc:** Lane C from the 2026-07-09 audit (widen Carter's read access)

## Problem

Carter — the strength specialist — bounces the athlete's most natural daily question ("is my strength holding while I lose weight?") to Peter. Three facts frame the fix:

1. His `query_daily_logs` allowlist (`CARTER_COLS`, [lib/coach/tools.ts:119](../../../lib/coach/tools.ts)) is `recovery, strain, sleep_hours, sleep_score` — no body comp, no intake. Cut trends need 8–12 weeks of weight/lean-mass/intake data he cannot query.
2. **The snapshot prefix was never speaker-filtered** — every coach, Carter included, already sees 14 days of `weight_kg`, `calories_eaten`, `protein_g` in the per-day lines ([lib/coach/snapshot.ts:582](../../../lib/coach/snapshot.ts)) plus the ATHLETE INTELLIGENCE nutrition-vs-performance digest. CARTER_BASE's scope-boundaries prose ("you DO NOT have nutrition data / body composition") is literally false and produces awkward refusals about data sitting in his own context.
3. The math for the headline question already exists as pure functions: `strengthPerLbm` in [lib/coach/progress-metrics.ts](../../../lib/coach/progress-metrics.ts), Brzycki e1RM in [lib/coach/e1rm.ts](../../../lib/coach/e1rm.ts), OLS in [lib/coach/trends/linear-regression.ts](../../../lib/coach/trends/linear-regression.ts). Nothing composes them into a coach-usable answer.

Decision locked with the athlete: **read scope = body comp + daily totals** (weight, body-fat, lean masses + day-level kcal/protein). Item-level food log stays Nora's; every nutrition/body-comp WRITE tool stays with Nora/Peter.

## Goals

- Carter can query the columns his lane's questions need, over real trend windows.
- Carter answers strength-on-a-cut questions himself, grounded in a deterministic tool — no bouncing, no in-head statistics.
- The specialist wall moves from "can't see" to "can't prescribe": reading and citing intake/body-comp is in-lane; proposing changes to them is an explicit named hand-off.

## Non-goals

- No write tools move (nutrition targets, GLP-1 milestones, meal logging all stay Nora/Peter).
- `query_food_log` (item-level) stays Nora-only.
- No snapshot prefix changes (it already carries what's needed).
- NORA_COLS / REMI_COLS / PETER_COLS untouched.
- No UI changes.

## Design

### 1. Widen `CARTER_COLS`

[lib/coach/tools.ts:119](../../../lib/coach/tools.ts) becomes:

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

The existing intersection logic in `executeQueryDailyLogs` (opts.allowedColumns) and the single `colsForSpeaker` seam ([chat-stream.ts:406](../../../lib/coach/chat-stream.ts)) do the rest — no tool-shape or orchestrator changes.

### 2. New deterministic read tool: `get_strength_per_lbm_trend`

Registered in **CARTER_TOOLS and PETER_TOOLS** (read-only; allowed in all chat modes except `intake`, same gating class as `get_week_prescription`).

**Input:** `{ lift: "squat" | "bench" | "deadlift" | "ohp", weeks?: number }` — `weeks` clamped to 4..12, default 8.

**Computation** (new module `lib/coach/strength-per-lbm-trend.ts`, pure core + thin fetch):

1. Fetch non-warmup sets for the lift's name patterns over the window (same name-pattern matching as target-hit-evaluator) and `daily_logs` rows with `fat_free_mass_kg` (fallback: derive LBM as `weight_kg × (1 − body_fat_pct/100)` when `fat_free_mass_kg` is null but both components exist).
2. Per ISO week (Monday-keyed): `best_e1rm` = max Brzycki over 1..12-rep sets; `avg_lbm_kg` = mean of available LBM readings that week. Weeks missing either side are omitted (absence is the signal — same convention as adherence).
3. `ratio = strengthPerLbm(best_e1rm, avg_lbm_kg)` per week; OLS slope over `(weekIndex, ratio)`.
4. **Verdict** on the relative weekly slope (`slope / mean(ratio)`): `rising` > +0.5%/wk; `falling` < −0.5%/wk; `holding` otherwise. Fewer than 3 paired weeks → `insufficient_data` with the weeks that DO exist returned (the coach says what's missing rather than fabricating).

**Output:** `{ lift, weeks_requested, weeks_with_data, series: [{ week_start, best_e1rm, avg_lbm_kg, ratio }], slope_per_week, relative_slope_pct_per_week, verdict }`.

CARTER_BASE teaches: quote the verdict and 2-3 series points; never recompute or extrapolate beyond the returned window.

### 3. CARTER_BASE scope-boundaries rewrite

The current paragraph ("You have recovery-relevant columns… You DO NOT have nutrition data… suggest the athlete re-ask Peter") is replaced with a **read-vs-prescribe wall**:

- You can READ and cite body composition (weight, body-fat, lean mass) and day-level intake totals (calories, protein) — in your snapshot and via `query_daily_logs`.
- Strength-on-a-cut questions are YOURS: call `get_strength_per_lbm_trend` and narrate its verdict; connect rough sessions to fueling context when the data shows it ("1,400 kcal the day before a leg day is under-fueled — flag it to Nora").
- You NEVER propose changes to nutrition targets, diet structure, meal content, or GLP-1 anything. When the remedy is dietary, name the hand-off explicitly: state the observation, then "that change is Nora's call — raise it with her." Item-level "what did I eat" questions remain Nora's.

One sentence also lands in NORA_BASE's team section noting Carter now reads intake/body-comp context (prevents Nora "correcting" him for citing it).

### 4. Testing

- Pure-core fixtures in [scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs) (or a sibling block): weekly pairing (missing-week omission, LBM fallback derivation), ratio math against known values, slope + all three verdict thresholds ± boundary, `insufficient_data` at <3 paired weeks, weeks clamping.
- One assertion pinning `CARTER_COLS` exact content (regression gate on the allowlist).
- `typecheck`, `vitest`, `build`; `scripts/audit-speaker-routing.mjs` available for post-deploy behavior checks.

## Invariants preserved

- Write-tool partitioning unchanged (PERSIST_RESULT_TOOLS, HMAC pairs, mode gating all untouched except registering the one new read tool).
- Peter's superset property holds (Peter gains the tool too; his columns already cover Carter's new ones).
- The tool computes; the coach narrates — no in-prose statistics.
