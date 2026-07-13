# Block Command Center + Editable Schedule — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm 2026-07-13; mockups in `.superpowers/brainstorm/1893-1783925154/content/`)

## Problem

Block setup, monitoring, and end-of-block review all live in chat today. Chat gives
reasoning but not control or visibility: the athlete can't see block history at a
glance, can't monitor pace against target without asking, and validates new blocks
through a conversation when every number is already engine-computed. Separately,
the athlete has no manual control over per-exercise sets/weights/order for the
current week — the engine owns `session_prescriptions` end-to-end and the only
user levers are ordering (`exercise_overrides`) and full-session templates.

## Decisions locked during brainstorm

1. **New-block setup is form-first, engine-prefilled.** Chat (`setup_block` mode)
   stays as the optional reasoning path, not the primary path.
2. **Past-block narrative is AI-written once at close and persisted** (Carter
   voice, fabrication-checked, deterministic fallback — the weekly-review /
   Peter-dashboard pattern). Not templated-only, not generated-on-open.
3. **Current-block monitor is deterministic only** — no AI calls; loads instantly.
4. **Schedule editing uses an explicit Edit → Save flow with a scope choice:**
   "This week only" (order + sets + weights + reps, applied verbatim) or
   "Whole block" (order + set counts only — loads/reps keep evolving with the
   engine's RIR/intensity progression across block weeks).
5. **Manual edits live in their own athlete-owned layers** that merge at read
   time — the adaptive-loop repatch keeps rewriting `session_prescriptions`
   without clobbering manual edits.
6. Mid-block target editing is deliberately excluded (targets are set-at-setup;
   the calibration validator exists to prevent exactly that miscalibration class).

## Surfaces

### 1. New "Blocks" tab on `/strength`

Tab order: Coach · **Blocks** · Schedule · By date · By muscle · Log.
Three stacked sections (see mockup `blocks-tab.html`):

**a) Current block monitor** (only when a block is active; indigo-edged card)
- Header: lift focus + target ("SQUAT · 97.5 kg e1RM"), week N of 5, phase badge
  from `evaluateBlockPhase` (`pre_target / consolidation / off_pace / deload_week`).
- Pace panel (4 KPIs): current best e1RM (`bestComparisonValue`, metric-aware),
  observed kg/wk slope (OLS over per-week max e1RM, same math as
  `calibrate-target`), projected hit week (trend line ∩ target), kg to go.
- Block trend chart: per-week best e1RM across the block window, horizontal
  target line, dashed projection to block end. Recharts, `MetricCard` idiom.
- This-week strip: RIR target + intensity multiplier for the current block week,
  sessions done/planned, next primary-lift session with prescribed top set (reads
  `session_prescriptions` — same numbers as logger). Deep-links to Schedule tab.
- Secondary lifts row: other 3 lifts, current working kg + clamp-held status.
- Actions: **Close block early** (confirm dialog rendering the would-be outcome —
  server reuses `executeProposeCloseBlock` / `executeCommitCloseBlock` via a new
  session-authed API route; no chat required) and **Discuss with Carter**
  (deep-link to Carter chat).

**b) Block history**
- Collapsed rows: lift, period, phase tag (HIT EARLY · WK 2 / ON PACE / OFF PACE /
  UNDERPERFORMED), newest first, active block shown with ACTIVE chip.
- Expanded detail: period, target → reached (+%), achievement week,
  `narrative_md` paragraph (performance story + calibration lesson + explicit
  pick-up point for when the lift circles back), secondary lifts at close.

**c) New block editor** (only when NO block is active; otherwise a one-line
"Next block opens when this one closes" hint)
- Focus select, pre-selected from rotation (`recommended_next_focus` of the
  latest unacknowledged/most recent outcome; falls back to rotation order).
- Target stepper, pre-filled from `computeTargetRecommendation` (trend or math),
  sanity band displayed inline. Out-of-band targets require a typed override
  reason (same rule as `propose_block`, surfaced as a conditional text field).
- Period: next Monday → +34 days, read-only in v1.
- **Create block** POSTs to a new `/api/blocks` route that runs the same
  validation as `executeProposeBlock` and the same insert + outcome-acknowledge
  as `executeCommitBlock` (extracted shared helpers — one validator, two entry
  points). No approval-token round-trip: the form IS the approval.
- **Ask Carter first** → `/strength?tab=coach&mode=setup_block`.
- `BlockOutcomeCard`'s "Start block" / "Different priority" buttons re-point to
  `/strength?tab=blocks` (prefill via existing `prefill_focus`/`prefill_target`
  params, now consumed by the editor).

### 2. Schedule tab additions

- **Block context strip** at top (when a block is active): "Squat block · Week N
  of 5 · RIR r · intensity i×" + "VIEW BLOCK →" chip to the Blocks tab.
- **Edit button per day row** → edit mode for that session:
  - Per-exercise steppers: sets (±1, floor 1), weight (± on the exercise's
    equipment grid from `sessionPlans` increments), reps (±1).
  - Reorder via up/down arrows (any dialog portaled to document.body — the
    LoggerSheet z-index lesson).
  - Edited rows show amber EDITED chip + the engine's original values + per-row
    "reset to plan".
- **Save → scope dialog:**
  - **This week only** → writes `training_weeks.manual_session_edits` for that
    weekday (order + per-exercise {sets, kg, reps} deltas, verbatim).
  - **Whole block** → writes `training_blocks.session_structure_overrides` for
    that session_type (order + sets only) AND applies order+sets to the current
    week's `manual_session_edits` so the change is visible immediately. Dialog
    copy states that weights/reps stay engine-managed across weeks.

## Data model — migration 0051

```sql
alter table block_outcomes add column narrative_md text;            -- AI paragraph, written at close
alter table training_weeks add column manual_session_edits jsonb;   -- athlete week-scope edits
alter table training_blocks add column session_structure_overrides jsonb; -- athlete block-scope structure
```

Shapes (TS mirrors in `lib/data/types.ts`):

```ts
type ManualSessionEdits = Partial<Record<WeekdayLong, {
  order?: string[];                                  // full permutation of the resolved day
  exercises?: Record<string, { sets?: number; kg?: number; reps?: number }>;
}>>;

type SessionStructureOverrides = Record<string /* session_type */, {
  order?: string[];
  sets?: Record<string /* exercise name */, number>;
}>;
```

## Resolution chain (the seam that makes edits flow everywhere)

Both `getEffectiveSessionPlan` (client: schedule, today card, brief) and
`resolveSessionPlan` (logger server path) gain the same top layer:

```
1. manual_session_edits[weekday]          ← NEW top (athlete, week-scope)
2. session_prescriptions[weekday]         (engine; repatch keeps owning this)
3. exercise_overrides[weekday]            (legacy ordering layer, unchanged)
4. user_session_templates[session_type]
5. recent-workouts discovery (logger only)
6. SESSION_PLANS
```

Composition note: layers 2+3 keep today's semantics — when both exist, the
ordering override layers on top of the prescription (engine owns loads, user
owns order). When `manual_session_edits.order` is present it supersedes the
`exercise_overrides` ordering for that day; absent, existing ordering holds.

The manual layer is a **merge**, not a replacement: order applies as a
permutation of the resolved exercise list; per-exercise deltas override only the
named fields. Exercises without an entry keep engine values — so an engine
repatch mid-week updates untouched exercises while edited ones hold. Logger
shows an "edited plan" source chip when layer 1 contributed.

`prescribeWeek` reads `session_structure_overrides` from the active block when
generating any week (Sunday cron, weekly-review read, repatch, commit rehydrate):
order applied after engine composition; per-exercise set counts override engine
set counts; warmup-set post-processing runs after (unchanged).

## Narrative generation at close

- Trigger points: `executeCommitCloseBlock` (chat + new API route) and the
  nightly block-outcomes sweep — both call a new
  `generateOutcomeNarrative(outcome, blockRow)` in `lib/coach/block-outcomes/`.
- One Haiku 4.5 call, Carter voice (reuses `CARTER_VOICE_RULES`), input strictly
  the deterministic outcome payload + block dates. Output ≤120 words: performance
  story, calibration lesson, pick-up point ("when <lift> returns, start from X").
- Fabrication check: every number token in the narrative must exist in the
  outcome payload (the Peter-dashboard checker pattern — and per the known
  narrator-drift gotcha, this is a THIRD allow-list checker; keep it in
  `lib/coach/block-outcomes/` with its own fixture test).
- On failure/retry-exhaustion: deterministic template fallback (never a blank
  paragraph); row still written.
- Backfill: one-shot script `scripts/backfill-block-narratives.mjs` for the two
  existing closed blocks.

## API routes (all session-authed, RLS-scoped)

- `GET /api/blocks/summary` — assembled monitor payload (or SSR-hydrate via
  fetcher pair `lib/query/fetchers/blocks.ts`; hooks in `lib/query/hooks/`).
  Follows the hybrid SSR-hydrate pattern like every other tab.
- `POST /api/blocks` — create (shared validator with propose_block).
- `POST /api/blocks/close` — propose-preview (`?preview=true`) + commit close.
- `PATCH /api/training-weeks/[week_start]/manual-edits` — write/clear
  `manual_session_edits` for a weekday (validates: order is a permutation of the
  resolved day; sets ≥1; kg on-grid; reps 1–30).
- `PATCH /api/blocks/[id]/structure-overrides` — write/clear block-scope
  structure (validates same; only while block is active).

## Explicitly out of scope

- Mid-block target editing.
- Editing non-current weeks or closed blocks.
- Removing/adding exercises in edit mode (order + sets/kg/reps only; exercise
  swaps stay with Carter's rotation tools / DaySwapSheet).
- Push notifications, block comparison charts, trajectory analytics (exists in
  /coach/trends already).

## Testing & verification

- Vitest: manual-layer merge semantics (edits win, untouched evolve, reset
  clears), permutation validation, `prescribeWeek` × `session_structure_overrides`
  fixtures, narrative fabrication-checker + fallback.
- `scripts/audit-prescription-rules.mjs`: new assertions for the structure
  override path.
- `npm run build` mandatory (new client components with hooks — no render
  harness).
- Manual: edit Monday's squat sets/weight → open logger → edited numbers +
  "edited plan" chip; trigger a morning-checkin repatch → edited row holds,
  others move.

## Delivery

Two PRs on this arc branch:
1. **Blocks tab + narrative** — migration 0051 (all three columns), monitor,
   history + narrative generation/backfill, new-block editor, BlockOutcomeCard
   re-pointing.
2. **Editable schedule** — resolution-chain layer, edit mode UI, scope dialog,
   `prescribeWeek` integration, logger source chip.
