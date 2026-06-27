# Coach Responsiveness Memory — Design Spec

**Date:** 2026-06-26
**Phase:** 3, sub-project #1 ("the coach remembers what works")
**Status:** Approved design, ready for implementation plan

---

## Problem

The coaches can see the athlete's data and cross-domain patterns (shipped in Phase 1), but they do not track **which interventions actually helped this athlete**. So advice cycles without learning: the coach keeps suggesting deloads, protein bumps, or sleep fixes without knowing whether those moves worked *for him* last time. This is the unresolved half of the original audit's Weakness C ("coach repeats itself").

Phase 1 deliberately left the slot for this: `composeCoachHistory` is an empty stub returning `{ recent_deloads: [], exercise_swaps_8w: [], nutrition_interventions: [] }`, the snapshot's `### Coach History` block renders only when those arrays are non-empty (so it is currently always absent), and the two Layer 3 prompt adapters that would consume it (responsiveness memory, success acknowledgment) were never written because there was no data to feed them.

This sub-project fills that gap.

## Goal

Give the coaches a durable, block-aware memory of interventions and their outcomes, so they (a) prioritize the athlete's high-ROI levers and stop pushing the low-signal ones, and (b) acknowledge a recent win instead of re-prescribing the same thing.

## Non-Goals (v1)

- No UI to browse the intervention log — the value is the coach *using* it, not the athlete *reading* it.
- No nutrition *inference* — nutrition interventions are explicit-capture only in v1 (self-driven macro changes are noisy to infer; Nora's changes already go through commit tools).
- No cross-block trend analytics — single-intervention outcomes only.
- No new AI calls — capture, outcome evaluation, and the composer are all deterministic. The two prompt adapters inject text into existing coach prompts; they do not add model calls.

---

## Architecture

Three layers, mirroring the Phase 1 intelligence shape:

1. **Capture** — record an intervention when it happens (explicit via approval chips + inferred from data).
2. **Outcome** — after the intervention's window closes, deterministically measure what happened and stamp the result.
3. **Consumption** — fill the `composeCoachHistory` stub (auto-surfaces in the snapshot) + write the two deferred prompt adapters.

**Block-awareness is the load-bearing principle.** A drop in training volume looks identical in raw data whether it is a *planned* end-of-block deload (the program running) or a *reactive* deload (a response to overreach). Crediting "the deload worked" for a scheduled deload would measure program structure, not physiology. So every strength intervention records the `evaluateBlockPhase` verdict ([lib/coach/prescription/block-phase-rule.ts](../../../lib/coach/prescription/block-phase-rule.ts)) at capture time, and only **reactive** interventions (outside the `deload_week` phase / outside block boundaries) count toward responsiveness memory.

---

## Data Model: `coach_interventions`

New table, RLS self-scoped. One row per intervention.

| column | type | meaning |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid | FK auth.users, RLS self |
| `kind` | text | `reactive_deload` \| `exercise_swap` \| `nutrition_change` (CHECK constraint) |
| `source` | text | `explicit` \| `inferred` (CHECK constraint) |
| `started_on` | date | date the change took effect |
| `context` | jsonb NOT NULL | capture-time context (see below) |
| `outcome` | jsonb | null until evaluated; `{ success: bool\|null, ...signal }` |
| `outcome_evaluated_at` | timestamptz | null until the outcome window closes |
| `created_at` | timestamptz default now() | |

**`context` jsonb shape** (per kind):
- All kinds: `{ block_id, block_phase, block_week }` (block context at capture; block_* null when no active block).
- `reactive_deload`: `+ { deload_depth_pct, trigger }` (trigger e.g. `low_hrv` / `athlete_request` / `inferred`).
- `exercise_swap`: `+ { from_exercise, to_exercise, reason }` (reason `pain` / `stall` / `equipment` / `boredom`).
- `nutrition_change`: `+ { field, from, to }` (field e.g. `kcal` / `protein_g` / `glp1_phase`).

**`outcome` jsonb shape** (per kind, stamped by the evaluator):
- `reactive_deload`: `{ success: bool|null, hrv_recovery_days: number|null, performance_resumed: bool }`.
- `exercise_swap`: `{ success: bool|null, pain_resolved: bool, swap_stuck: bool }`.
- `nutrition_change`: `{ success: bool|null, signal: string, improved: bool }`.

`success: null` means **inconclusive** (insufficient data in the window) — never fabricated. Inconclusive rows are never cited as "what works."

**Dedup:** explicit wins. If the athlete approved an intervention and the inferred detector also spots it (same kind, overlapping date window), they reconcile to a single row. Mirrors the [proactive_nudge_dedup](../../../supabase/migrations/0017_proactive_nudge_dedup.sql) precedent.

Migration applies via `supabase db push`. Row shape mirrored in [lib/data/types.ts](../../../lib/data/types.ts).

---

## Layer 1 — Capture

### Explicit capture (precise)
At commit time of an approval-gated coach tool that *is* an intervention, insert a row:
- A reactive load drop / deload proposal → `reactive_deload`, **only when `evaluateBlockPhase` ≠ `deload_week`** (a scheduled deload is the program, not an intervention; it is not recorded as an intervention at all).
- `propose_session_today` / session-template swap → `exercise_swap` (with from→to + reason).
- `commit_nutrition_targets` / GLP-1 macro milestone → `nutrition_change`.

Each insert stamps the live `evaluateBlockPhase` verdict + block id/week into `context`. Hook into the existing commit paths in [lib/coach/tools.ts](../../../lib/coach/tools.ts) — additive, behind the same approval-token flow that already runs.

### Inferred capture (coverage for self-driven changes)
A deterministic detector (pure function, fixture-tested) scans recent data and inserts `source: 'inferred'` rows:
- **Reactive deload** — a week where primary-lift load/volume dropped meaningfully **while `block_phase ≠ deload_week`**. The block-aware classifier refuses to flag scheduled deloads. (This is the core function the athlete specifically asked to be block-aware.)
- **Exercise swap** — an exercise leaves a session slot and a new one takes it **outside a block boundary** (boundary swaps are planned rotation).
- Nutrition: **not inferred in v1** (explicit-only).

The detector runs in the same sweep as the outcome evaluator cron (below).

---

## Layer 2 — Outcome Evaluation

A deterministic evaluator runs on the existing daily-cron pattern, finds interventions whose outcome window has closed and `outcome_evaluated_at IS NULL`, measures, and stamps. No AI. Pure functions, fixture-tested.

| kind | window | success criteria | measured signal |
|---|---|---|---|
| `reactive_deload` | ~7–10 days | HRV/recovery returned to 30-day baseline **and** primary lift didn't regress | `hrv_recovery_days` |
| `exercise_swap` | ~14 days | pain flag stopped recurring on the area (no soreness checkins 14d) **and** replacement was trained + progressed | `pain_resolved`, `swap_stuck` |
| `nutrition_change` | ~14 days | the intended thing moved (protein adherence up / body-comp direction shifted right / target hit) | `signal`, `improved` |

If the window has insufficient data (sparse HRV, missed checkins) → `success: null` (inconclusive), never a fabricated verdict. Windows are constants, tunable in one place.

HRV-baseline reads reuse `readRolling30d` / `isMeaningfulDeviation` ([lib/whoop/baselines.ts](../../../lib/whoop/baselines.ts)) — same anchors Phase 1's recovery composer uses. Lift-progression reuses `brzycki` / `bestComparisonValue` ([lib/coach/e1rm.ts](../../../lib/coach/e1rm.ts)).

---

## Layer 3 — Consumption

### Fill `composeCoachHistory`
Replace the stub ([lib/coach/intelligence/coach-history.ts](../../../lib/coach/intelligence/coach-history.ts)) to read `coach_interventions` and return the three populated arrays with outcomes. Only `success ∈ {true,false}` rows surface; inconclusive stays hidden. Because the snapshot's `### Coach History` block already renders conditionally on non-empty arrays (Phase 1), it appears automatically with no rendering change. Note: this composer currently takes `(workouts, dailyLogs)` and is pure; it will now need the intervention rows — the orchestrator ([lib/coach/intelligence/index.ts](../../../lib/coach/intelligence/index.ts)) fetches them and passes them in, keeping the composer pure (same pattern as the other composers).

### Two prompt adapters (deferred from Phase 1)
Additive edits to [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts), same discipline as Phase 1's Layer 3:

- **Responsiveness memory** — synthesize a per-athlete rollup ("responds well to reactive deloads: 3/3 recovered in ~5d; low signal from nutrition tweaks: 2 changes, no movement") and inject per coach lane: Remi cites deload responsiveness, Carter cites swap outcomes, Nora cites nutrition outcomes, Peter sees the cross-domain rollup. The coach prioritizes high-ROI levers and de-emphasizes duds.
- **Success acknowledgment** — when a recent intervention's outcome is `success: true`, the coach states it ("the reactive deload 6 days ago worked — HRV back to baseline") instead of re-prescribing.

Both carry the Phase 1 anti-fabrication rule: cite only what the block shows; if Coach History is absent or a row is inconclusive, say nothing about it.

---

## Testing

- **Pure, fixture-tested** (mirrors Phase 1's `scripts/audit-*` + vitest style): the block-aware deload/swap classifier (must refuse scheduled deloads), and the three outcome evaluators (incl. the inconclusive path).
- **Schema/integration:** migration applies via `supabase db push`; an audit script verifies `coach_interventions` outcomes are internally consistent and that no `deload_week`-phase deload was ever recorded as an intervention.
- **Regression:** Phase 1's 142 intelligence tests must stay green (the composer signature change is the only Phase-1-adjacent edit).

## Risks & Mitigations

- **Mislabeling planned as reactive** → block-phase classifier is the explicit guard; an audit assertion checks no `deload_week` deload is ever an intervention.
- **Fabricated outcomes on thin data** → `success: null` inconclusive state; inconclusive rows never surface to prompts.
- **Composer signature change rippling** → orchestrator fetches + injects the rows; composer stays pure; typecheck + the 142 tests gate it.

## Build Order (for the plan)

1. Migration + `coach_interventions` row type.
2. Block-aware classifier (pure) + tests.
3. Explicit capture hooks in commit paths.
4. Inferred detector (pure) + tests, wired to a cron sweep.
5. Outcome evaluators (pure) + tests, wired to the same cron.
6. Fill `composeCoachHistory` + orchestrator wiring.
7. The two prompt adapters.
8. Audit script + final review.
