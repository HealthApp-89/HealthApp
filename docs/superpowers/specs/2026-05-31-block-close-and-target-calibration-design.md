# Block close-early + target calibration validator

**Date:** 2026-05-31
**Status:** Design
**Related:** [2026-05-28-sunday-prescription-system-design.md](./2026-05-28-sunday-prescription-system-design.md), [2026-05-29-block-outcomes-rotation-engine-design.md](./2026-05-29-block-outcomes-rotation-engine-design.md)

## Problem

Two related gaps in the block-planning flow:

**1. No clean way to close a block early.** The current deadlift focus block crossed its 115 kg e1RM target in week 3 of 5 — the framework correctly recommended consolidation for weeks 4-5, but the block was clearly miscalibrated low. There's no chat tool or UI surface for "close this block early so we can recalibrate." Today the only path is direct SQL on `training_blocks.status`. The `block-outcomes/sweep` cron only closes blocks whose `end_date < today`, so an early close also leaves the `block_outcomes` row ungenerated until the original end date passes — by which time the rotation rationale is stale.

**2. Block targets are not sanity-checked at creation.** `executeProposeBlock` accepts whatever `target_value` Carter sends. The 115 kg deadlift miscalibration happened because the target was set without anchoring to the athlete's current e1RM, and nothing in the validator rejected an obviously-too-easy number. The athlete's actual current was ~112 e1RM at block start; a 115 target meant the block was over-by-week-3 by construction. The athlete asked: *"how can we make sure the target is realistic to achieve by end of block, not by week 2 or 3?"* — this spec answers that.

## Goals

- Add a `close_block_early` chat tool (Peter-owned, HMAC-gated propose/commit pair) that closes an active block and writes its `block_outcomes` row in one operation.
- Add trend-derived target recommendation + sanity-bounds validation inside `executeProposeBlock`, so future block targets land in a realistic 4-week-progression window unless the athlete explicitly overrides.
- Surface the trend recommendation in `setup_block` context so Carter narrates the recommended number rather than asking the athlete to invent one.
- Run the operational sequence for *this* athlete: close current deadlift block, run this week as a bridge deload (no active block), start a bench focus block on Mon Jun 8 with target 85 kg e1RM.

## Non-goals

- **Not changing the "non-focus primaries drop 1 set during a focus block" rule.** The athlete confirmed (2026-05-31) that this trade-off is appropriate for cutting on Mounjaro 2.5 mg.
- **Not changing the Sunday prescription cron, `get_week_prescription` tool, or the locked propose_week_plan flow.** All deployed in the prior arc (commit `0533eb6` + `efa0825`).
- **Not building a separate "block calibration trend chart" UI.** The trend math lives in the validator; the existing coach trends UI already plots per-lift e1RM. No new visual.
- **Not changing rotation logic.** [recommendNextFocus](../../lib/coach/block-outcomes/rotation.ts) already handles the next-focus selection based on history + `rotation_priority_lift`.

## Architecture

Three new components in [lib/coach/](../../lib/coach/) + executor wiring in [tools.ts](../../lib/coach/tools.ts) + chat-stream dispatcher + prompt updates. No new database tables; no migration.

```
                            ┌──────────────────────────────────────┐
                            │  block_outcomes/index.ts             │
                            │    generateBlockOutcome(blockId)     │
                            │       (existing)                     │
                            └────────────┬─────────────────────────┘
                                         │
        ┌────────────────────────────────┴───────────────────────┐
        │                                                         │
┌───────▼──────────────┐                            ┌─────────────▼─────────────┐
│ close_block_early    │                            │ block-outcomes/sweep cron │
│ (NEW, this spec)     │                            │ (existing, runs daily)    │
│ HMAC propose/commit  │                            │ only fires when end_date  │
│ chat tool            │                            │   < today                 │
└──────────────────────┘                            └───────────────────────────┘


                       ┌──────────────────────────────────────────────────┐
                       │  prescription/calibrate-target.ts (NEW)          │
                       │  computeTargetRecommendation(lift, userId, today)│
                       │   → { current_e1rm, slope_kg_per_wk,             │
                       │       trend_target, math_target, used,           │
                       │       sanity_bounds: [min, max] }                │
                       └────────────────┬─────────────────────────────────┘
                                        │
                ┌───────────────────────┼───────────────────────────┐
                │                       │                           │
┌───────────────▼────────┐  ┌───────────▼───────────┐ ┌─────────────▼──────────┐
│ executeProposeBlock    │  │ BLOCK_OUTCOME_CONTEXT │ │ recalibrate-target.ts  │
│ (existing, extended)   │  │ in planning-prompts   │ │ (existing — output     │
│ rejects out-of-bounds  │  │ Carter cites trend    │ │  becomes one of the    │
│ targets unless         │  │ recommendation        │ │  candidates the new    │
│ override_reason set    │  │ verbatim              │ │  helper unifies)       │
└────────────────────────┘  └───────────────────────┘ └────────────────────────┘
```

## Components

### B1. `close_block_early` chat tool

**Files:** [lib/coach/tools.ts](../../lib/coach/tools.ts) (schema + executor), [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) (dispatcher), [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) (PETER_BASE narration guidance)

**Tool surface** (HMAC propose/commit pair, action `"close_block"`):

```ts
PROPOSE_CLOSE_BLOCK_TOOL = {
  name: "propose_close_block",
  description: "Preview closing the athlete's active block before its end_date. Returns the would-be block_outcomes payload + approval_token. Use ONLY when the athlete asks to close early (target hit early, block miscalibrated, schedule change, injury). The standard end-of-block flow runs via block-outcomes/sweep at end_date automatically and does NOT need this tool.",
  input_schema: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        minLength: 4,
        maxLength: 200,
        description: "Why are we closing early? (e.g., 'target hit week 3, recalibrating', 'shoulder pain forcing rotation')."
      },
    },
  },
};

COMMIT_CLOSE_BLOCK_TOOL = {
  name: "commit_close_block",
  description: "Commit a previously proposed early block close. Requires approval_token from propose_close_block. Updates training_blocks.status='completed' and writes block_outcomes row.",
  input_schema: {
    type: "object",
    required: ["approval_token"],
    properties: { approval_token: { type: "string", minLength: 60 } },
  },
};
```

**Executor behavior:**

`executeProposeCloseBlock(opts)`:
1. Find the user's active block (`training_blocks` where `status='active'`). Reject with structured error if none.
2. Compute the prospective outcome payload via `generateBlockOutcome({ supabase, userId, blockId })` *without* writing — preview only.
3. Sign HMAC approval token containing `{ blockId, reason, prospectiveOutcome }`.
4. Return `{ preview: { blockId, primary_lift, target_value, would_be_outcome }, approval_token }`.

`executeCommitCloseBlock(opts)`:
1. Verify token; extract `blockId`.
2. Re-run `generateBlockOutcome` (re-compute from current data, not the preview snapshot — the athlete may have logged a workout between propose and commit).
3. In a single transaction (or sequential service-role writes since Supabase JS lacks true txns from the client):
   - `INSERT INTO block_outcomes (...)` with the freshly-computed payload, leaving `athlete_acknowledged_at` NULL (gets stamped when the next `commit_block` runs, matching existing pattern from [executeCommitBlock](../../lib/coach/tools.ts))
   - `UPDATE training_blocks SET status='completed', completed_at=now(), updated_at=now() WHERE id=:blockId AND user_id=:userId AND status='active'`
4. **Idempotency**: if `status` is already `completed`, no-op the UPDATE; if a `block_outcomes` row already exists for `block_id`, ON CONFLICT DO UPDATE refreshes the payload but preserves `athlete_acknowledged_at`.

**Mode gating** ([chat-stream.ts:modeAllowsTool](../../lib/coach/chat-stream.ts)):
- `default` mode: allow `propose_close_block` + `commit_close_block` (Peter-initiated from athlete chat)
- `setup_block` mode: also allowed (athlete might trigger close-then-setup in one conversation)
- `plan_week` / `intake` / `meal_log`: blocked

**`PERSIST_RESULT_TOOLS` entry**: both `propose_close_block` and `commit_close_block` added to the persist set ([chat-stream.ts:92](../../lib/coach/chat-stream.ts)). Without this the close-confirmation chip vanishes on chat history reload (the 2026-05-21 Nora re-save loop class of bug).

**PETER_BASE addition** (in `## Block-level decisions` section of [system-prompts.ts](../../lib/coach/system-prompts.ts)):

> When the athlete asks to close a block early — they hit the target early, the target is unreachable, they're injured, or schedule forces a rotation — call `propose_close_block({ reason })`. Do NOT prompt them to wait until end_date. The chip surfaces the would-be outcome (block_phase_at_end, rotation recommendation, recommended next target). After they tap Approve and you call commit_close_block, follow up with `setup_block` mode to plan the next block.

### B2. Target calibration helper

**File (new):** [lib/coach/prescription/calibrate-target.ts](../../lib/coach/prescription/calibrate-target.ts)

Pure function (single Supabase read, no AI calls):

```ts
export type TargetRecommendation = {
  current_e1rm: number | null;        // null when no logged data exists
  slope_kg_per_wk: number | null;     // null when <3 weeks of data
  trend_target: number | null;        // current + (slope × 4), grid-rounded
  math_target: number | null;         // current + (coefficient × 4), grid-rounded
  used: "trend" | "math" | "neither"; // which one feeds `recommended_target`
  recommended_target: number | null;
  sanity_bounds: [number, number] | null; // [min, max] target values for the validator
};

export async function computeTargetRecommendation(opts: {
  supabase: SupabaseClient;
  userId: string;
  lift: PrimaryLift;
  todayIso: string;
  /** Athlete phase: drives the math coefficient. Defaults to 'cut' for now —
   *  future enhancement will read from plan_payload.nutrition.current_phase. */
  phase?: "bulk" | "maintenance" | "cut";
}): Promise<TargetRecommendation>;
```

**Coefficient table** (cut, intermediate, kg/wk e1RM gain on focus lift):

| Lift     | Bulk | Maintenance | Cut  |
|----------|------|-------------|------|
| deadlift | 2.5  | 1.5         | 1.5  |
| squat    | 2.0  | 1.25        | 1.25 |
| bench    | 1.0  | 0.75        | 0.75 |
| ohp      | 0.75 | 0.4         | 0.4  |

Numbers source: Wendler 5/3/1 cycle deltas (5 lb upper / 10 lb lower per 3-week cycle), Helms 3DMJ intermediate male cut protocols, cross-checked against [Stronger by Science training-progression literature reviews](https://www.strongerbyscience.com/). Coefficients are conservative — they target "realistic if execution is clean," not "best-case." Saved as a const map in the module; revisit if/when literature updates.

**Algorithm:**

1. **Pull realized data**: 90-day window of non-warmup working sets for the lift's tracked exercises (use `PRIMARY_LIFT_NAME_PATTERNS` from [current-comparison-value.ts](../../lib/coach/prescription/current-comparison-value.ts)). Filter `reps ∈ [1, 12]`. Convert each set to Brzycki e1RM via [bestComparisonValue](../../lib/coach/e1rm.ts).
2. **Current e1RM**: max across the filtered sets.
3. **Slope**: bucket sets to per-week max e1RM. Need ≥3 weeks of data. OLS regression `(week_index, week_max_e1rm)` → `slope_kg_per_wk`.
4. **Trend target**: `current + slope × 4`, rounded down to nearest grid step (2.5 kg for barbell lifts — the helper hard-codes 2.5 since all four primary lifts are barbell-loaded).
5. **Math target**: `current + (coefficient × 4)`, same grid rounding.
6. **`used`**: `'trend'` when slope is non-null AND positive (negative slope on a focus lift is suspicious — fall back to math); `'math'` otherwise; `'neither'` when `current_e1rm` is null (no logged data).
7. **Sanity bounds**: `[current + 1, current + coefficient × 4 × 1.5]`. The upper bound's 1.5× factor allows for reasonably ambitious-but-not-insane targets; below the lower bound is "too easy, would hit by week 1."

**Edge cases handled:**
- No logged data for the lift → returns all-nulls; validator falls back to "accept whatever Carter sends" (preserves bootstrap path for first-ever block)
- Slope is negative (e1RM declining over the window) → fall back to math; surface this in the return so Carter can narrate the decline
- ≥3 weeks of data but flat slope (~0) → trend target = current; math is more useful, use math
- Single-rep PR skews max e1RM upward → that's actually what we want (current = true best); validator uses this number for bounds

### B3. `executeProposeBlock` validator extension

**File:** [lib/coach/tools.ts:executeProposeBlock](../../lib/coach/tools.ts)

After existing field validation (lines ~1736-1759), before signing the token:

1. If `primary_lift` + `target_value` + `target_metric` are all set, call `computeTargetRecommendation({ supabase, userId, lift: primary_lift, todayIso: today })`.
2. If `recommendation.sanity_bounds != null`:
   - If `payload.target_value < bounds[0]` OR `payload.target_value > bounds[1]`:
     - If `payload.override_reason` is also a non-empty string: log telemetry `{event: 'target_out_of_bounds_override', userId, lift, proposed, bounds, reason}`, accept the payload, attach `override_used: true` to the preview.
     - Else: reject with `code: 'target_out_of_bounds'` and a structured error message that names the bounds + the recommendation, e.g. *"Bench target 100 kg e1RM is above the realistic 4-week range (your current best is 81, sanity ceiling for a bench focus block is 85.5). If you intend this, include `override_reason` in the next call explaining why."*
3. Attach `recommendation` to the preview return value: `{ preview, approval_token, recommendation }`. This is what Carter narrates back to the athlete on the proposal chip.

**Schema additions** to `PROPOSE_BLOCK_TOOL.input_schema.properties`:

```ts
override_reason: {
  type: "string",
  minLength: 4,
  maxLength: 200,
  description: "Required ONLY when target_value falls outside the trend-derived sanity bounds. Explain why you want to go above/below the realistic 4-week range — e.g. 'returning from injury, conservative target' or 'priming meet attempt, intentionally aggressive'.",
},
```

### B4. `setup_block` prompt + context wiring

**File:** [lib/coach/planning-prompts.ts](../../lib/coach/planning-prompts.ts) (`fetchSetupBlockContext` + `SETUP_BLOCK_PROMPT`)

Extend `BLOCK_OUTCOME_CONTEXT` to include trend recommendation for the *recommended next focus lift* (separate from the closing block's outcome):

```
BLOCK_OUTCOME_CONTEXT:
  primary_lift: deadlift                                  ← closed block
  block_phase_at_end: hit_early
  ...
  recommended_next_focus: bench                           ← rotation
  recommended_target_value_kg: 84                         ← from recalibrate-target.ts (rotation-based)
  ...

NEXT_BLOCK_TARGET_RECOMMENDATION:                         ← NEW
  lift: bench
  current_e1rm: 80.7
  observed_slope_kg_per_wk: 1.45
  trend_target: 86                                        ← current + slope × 4
  math_target: 84                                         ← current + 0.75 × 4
  used: trend                                             ← prefers trend when ≥3 weeks data
  recommended_target: 86
  sanity_bounds: [82, 85]                                 ← validator will reject outside this
```

`SETUP_BLOCK_PROMPT` beat 2 (ELICIT) gets a new paragraph:

> When narrating the target to the athlete, cite both `NEXT_BLOCK_TARGET_RECOMMENDATION.recommended_target` AND the underlying math (current e1RM + observed slope OR math coefficient). E.g.: *"Your decline bench is at 80.7 e1RM; trend over 6 weeks is +1.45 kg/wk. Recommended target for a 4-week-progression focus block is 86 kg e1RM. That hits around week 4 if execution is clean."*
> If the athlete proposes a different number outside `sanity_bounds`, the propose_block call will fail with `target_out_of_bounds`. In that case, ask why and pass their answer as `override_reason` on the retry — do NOT silently capitulate to "what the athlete wants" if their stated reason is just "I want to push harder" without concrete justification.

### A. Operational sequence (this athlete, this week)

Not a code change, but a one-shot run after B1-B4 land:

1. **In a chat turn, Peter calls `propose_close_block({ reason: "deadlift target 115 e1RM hit week 3 of 5 — block was calibrated low; recalibrating with a real anchor" })`** → athlete approves → `commit_close_block` writes the outcome row + flips block to completed.
2. **This week (Jun 1-7) runs between-blocks.** The existing [framework-state.ts](../../lib/coach/carter-context/framework-state.ts) between-blocks branch already injects the correct prompt context ("BETWEEN BLOCKS, do not propose a new <same lift> block immediately"). No formal training_weeks prescription written. Athlete sessions are light maintenance, self-directed.
3. **Sun Jun 7 evening or Mon Jun 8 morning, Peter calls `setup_block` mode**. `BLOCK_OUTCOME_CONTEXT` shows the deadlift outcome + `NEXT_BLOCK_TARGET_RECOMMENDATION` for bench. Athlete chooses bench (rotation default) at target 85 kg e1RM. `propose_block` → `commit_block` writes the active block.
4. **Sunday Jun 14 03:30 UTC**: the `sunday-prescriptions/sync` cron runs and populates `training_weeks.session_prescriptions` for the bench block's first prescription-targeted week.

## Data flow

**Block close path:**
```
chat: "close the block early" ─→ propose_close_block ─→ generateBlockOutcome (preview)
                                       ↓
                              [approval token returned]
                                       ↓
                              athlete taps Approve
                                       ↓
                            commit_close_block ─→ generateBlockOutcome (re-run)
                                       ↓
                              INSERT block_outcomes
                                       ↓
                       UPDATE training_blocks status='completed'
```

**Target calibration path (inside propose_block):**
```
Carter calls propose_block(target=85)
              ↓
executeProposeBlock validates standard fields
              ↓
computeTargetRecommendation(lift, userId, today)
              ↓
        ┌─────┴─────┐
        ↓           ↓
  fetch 90d sets   coefficient table lookup
        ↓           ↓
   Brzycki e1RM    math_target
        ↓
   per-week max
        ↓
   OLS slope
        ↓
   trend_target + sanity_bounds [82, 85]
              ↓
   payload.target_value (85) ∈ [82, 85]? YES
              ↓
   sign token, return preview + recommendation
```

## Error handling

| Failure | Behavior |
|---|---|
| `propose_close_block` called when no active block exists | Reject with `code: 'no_active_block'` + message *"You're not in an active block; nothing to close."* |
| `commit_close_block` token expired (5-min HMAC TTL) | Standard `ApprovalTokenError` flow, athlete asked to re-propose |
| `generateBlockOutcome` throws (e.g., no workouts in window) | Surface error verbatim; do NOT half-close the block. The UPDATE statement only fires after the outcome write succeeds. |
| `computeTargetRecommendation` Supabase query errors | Return `{ ...all_nulls, used: 'neither' }`; validator falls through to bootstrap path (accept Carter's target as-is). Don't block block creation on a transient data fetch. |
| `propose_block` with out-of-bounds target + no `override_reason` | Structured rejection (`target_out_of_bounds`) with the recommendation embedded so Carter can narrate the bounds and ask for justification |
| `propose_block` with out-of-bounds target + `override_reason` present | Accept, log telemetry, attach `override_used: true` to preview so the athlete sees a "you overrode the sanity check" badge on the chip |

## Testing / verification

- **Audit script extension**: add `prescription/calibrate-target.ts` assertions to [scripts/audit-prescription-rules.mjs](../../scripts/audit-prescription-rules.mjs):
  - Slope = 0 (flat e1RM) → falls back to math
  - Slope < 0 (declining) → falls back to math, returns slope value for narration
  - ≥3 weeks of strictly-rising e1RM → returns trend target rounded to grid
  - <3 weeks of data → returns math target only
  - Sanity bounds rejection / acceptance fixture for each `PrimaryLift`
- **No new typecheck breakage**: `npm run typecheck` clean
- **Manual smoke**: after deploy, ask Peter in chat *"close the deadlift block, we hit early"* → verify the close chip surfaces, approve → verify `block_outcomes` row written + `training_blocks` status flipped. Then ask *"plan next block"* → setup_block mode opens with the trend recommendation populated.

## Open implementation questions

None. All component shapes are defined above; the executor + helper + prompt edits compose without ambiguity.

## Rollout

Single PR:
1. New file: `lib/coach/prescription/calibrate-target.ts` (helper + coefficient table)
2. Modified: `lib/coach/tools.ts` (new tool schemas, executors; extend `executeProposeBlock`)
3. Modified: `lib/coach/chat-stream.ts` (dispatcher, `PERSIST_RESULT_TOOLS`, `modeAllowsTool` allowance)
4. Modified: `lib/coach/system-prompts.ts` (PETER_BASE close-block narration paragraph)
5. Modified: `lib/coach/planning-prompts.ts` (`fetchSetupBlockContext` extension, SETUP_BLOCK_PROMPT calibration paragraph)
6. Modified: `scripts/audit-prescription-rules.mjs` (new assertions)
7. Modified: `CLAUDE.md` (architecture note on close-block flow + calibration validator)

No migration. No cron change. No new env vars.

After merge + deploy: run the one-shot operational sequence in [A. Operational sequence](#a-operational-sequence-this-athlete-this-week) above for the active deadlift block.
