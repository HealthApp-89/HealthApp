# Activity-Aware Session Adjustment — Design

**Date:** 2026-06-29
**Status:** Approved (design); pending implementation plan
**Owner area:** Coach / strength prescription (Carter)

## Problem

When the athlete logs a conflicting activity mid-week — e.g. "padel tomorrow" — the
coach is expected to adjust the affected training session so the legs stay fresh for
the sport. Observed behaviour: the coach lightened *only the squat* and left leg press,
hip thrust, and the other accessories at normal load.

### Root cause

Two distinct gaps, neither of which is the per-exercise lighten *logic* (which is
already correct):

1. **The deterministic engine never re-runs mid-week.** `prescribeWeek()` only fires on
   the Sunday cron (`/api/coach/sunday-prescriptions/sync`), on an explicit day-swap
   (`/api/training-weeks/[week_start]/swap`), or on apply-activity-layout. Logging an
   activity through Carter's `add_planned_activity` tool writes
   `training_weeks.planned_activities` but triggers **no re-prescription**. So the
   engine's `lightenExercise()` — which maps *every* Legs exercise to the `"legs"`
   region and would lighten them all — simply never runs. Carter falls back to prose and
   produces a partial, headline-lift-only answer.

2. **The lighten lever is blunt and not evidence-based.** Even when it does run,
   `lightenExercise()` applies a uniform `−1 set / −1 rep` and holds load. That is
   *directionally* correct (see research below) but ignores exercise role: it treats the
   main compound, the high-eccentric quad/ham accessories, and calves identically.

The architectural invariant is deliberate and must be preserved: **the engine is the
single source of truth for loads. Carter never authors loads.** (`propose_week_plan`
ignores any `session_prescriptions` it receives and recomputes via `prescribeWeek`;
`commit_week_plan` rehydrates fresh at write time.) The fix therefore must *trigger and
preview* the engine, not let Carter free-hand numbers.

## Research basis (training the day before an intermittent change-of-direction sport)

Padel is high-eccentric, deceleration- and lunge-heavy on quads/hamstrings/lower back.
The day-before strength session should shed fatigue and DOMS without losing the strength
stimulus.

- **Taper/peaking literature — cut volume, not intensity.** Reducing *training volume*
  ~40–60% while *holding load/intensity* maximises freshness; dropping the weight is the
  one lever that reliably costs performance (detraining-like).
  ([Bosquet meta-analysis](https://pubmed.ncbi.nlm.nih.gov/17762369/),
  [resistance-taper review](https://pmc.ncbi.nlm.nih.gov/articles/PMC7552788/))
- **DOMS — the enemy is eccentric volume, not weight on the bar.** DOMS peaks 24–72h;
  eccentric, high-rep work drives it; heavy resistance the day before impairs agility and
  force at 24–48h.
  ([DOMS/agility study](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7559839/))
- **Priming — low-volume + high-load the day before can help.** A low-volume,
  high-intensity (≥85% 1RM) session 6–33h out produces a delayed potentiation effect
  without hurting recovery.
  ([Resistance priming review, Sports Medicine](https://pubmed.ncbi.nlm.nih.gov/31203499/),
  [practical priming recs](https://www.scienceforsport.com/practical-recommendations-for-priming-exercise-when-what-and-how/))

**Coaching conclusion:** volume-led lighten, **hold the load on the main compound**, and
concentrate the volume cut on the high-eccentric accessories that hit the sport-relevant
muscles. Raise RIR (leave more in the tank) across the board.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Where the per-exercise intelligence lives | Engine re-runs and owns all numbers; Carter previews + commits. **Not** raw load authoring by Carter. |
| Lighten lever | **Tiered + RIR-aware** (below). |
| Resolution behaviour | **Full ladder: MOVE first, else LIGHTEN** (reuse `proposeActivityAwareLayout`). FLAG when a priority session can't move. |
| Surfacing | **Proactive on conflict** — logging the activity offers the adjustment immediately. |

## Design

### Part 1 — Tiered, RIR-aware `lightenExercise()`

Replace the uniform trim in
[lib/coach/prescription/prescribe-week.ts](lib/coach/prescription/prescribe-week.ts).
Classification uses data the engine already has: `exerciseRegion(name)`,
`getExerciseMuscles(name)` (primary/secondary), `ex.key`/BIG_FOUR membership, `ex.baseReps`,
and `affectedRegions` from `lightenDays`.

- **Tier A — primary compound** (BIG_FOUR / barbell compound, or the session's first
  loaded compound): **hold load**, drop 1 set to a **floor of 2**, **+1 RIR**. Keeps a
  low-volume primer.
- **Tier B — eccentric/high-rep accessory on a sport-relevant muscle**
  (not a primary compound AND `exerciseRegion ∈ affectedRegions` AND (`baseReps ≥ 10` or
  isolation machine)): **cut hardest** — drop sets toward a **floor of 1**, **+2 RIR**.
  (e.g. leg extension, seated leg curl, hip thrust, hip abductor.)
- **Tier C — other accessories** (no region overlap, or low-eccentric e.g. calves):
  mild — −1 set, **+1 RIR**.

Warmup sets are never lightened (unchanged). Exercises with no `sets`/`baseReps` are
skipped (unchanged). The unmapped-exercise fallback to session-level gating is retained.

**Per-exercise RIR.** Today RIR is week-global (`training_weeks.rir_target`); per-exercise
RPE is computed at render by `annotateSession` from fatigue tier. To carry the per-tier
RIR bump:

- Add optional `rir?: number` to `PlannedExercise`
  ([lib/coach/sessionPlans.ts](lib/coach/sessionPlans.ts)) — additive, back-compatible,
  serialised into `session_prescriptions` jsonb.
- `annotateSession` ([lib/coach/session-structure/annotate.ts](lib/coach/session-structure/annotate.ts))
  prefers `ex.rir` when present; otherwise unchanged tier-derived RPE.
- Brief session list and the strength `TodayPlanCard` display the per-exercise RIR when
  present.

### Part 2 — `prescribeWeek` exposes the layout proposal

`prescribeWeek` already calls `proposeActivityAwareLayout` internally and sources
`daysAvailable`. Have it (or a thin wrapper) return:

```
{ prescriptions: SessionPrescriptions,
  layout: { proposedPlan: SessionPlan, lightenDays: Record<string, MuscleRegion[]>, flags: ActivityConflictFlag[] } }
```

so callers get the human-readable move/lighten/flag diff with the **same** `daysAvailable`
sourcing — no second `proposeActivityAwareLayout` call that could drift. Existing callers
that only want `prescriptions` keep working (destructure).

### Part 3 — Carter conversational flow (proactive, ladder, preview→confirm)

1. **Conflict surfacing.** `executeAddPlannedActivity`
   ([lib/coach/tools.ts](lib/coach/tools.ts)) runs conflict detection after storing the
   activity and returns conflict info (`has_conflict`, the affected session/day, and
   whether the resolution is a move or a lighten). No conflict → it confirms plainly.

2. **New tool pair** `propose_activity_adjustment` / `commit_activity_adjustment`,
   mirroring `propose_week_plan` / `commit_week_plan` exactly:
   - **Propose** computes the resolution via the Part-2 layout output + `prescribeWeek`,
     builds a structured preview (`moves: [{day, before, after}]`,
     `lightened: [{day, exercise, before:{sets,reps,rir}, after:{sets,reps,rir}}]`,
     `flags`), and signs an HMAC approval token (new `ApprovalAction` value
     `"activity_adjustment"` in [lib/coach/approval-token.ts](lib/coach/approval-token.ts)).
     Loads in the preview are engine-computed; any caller-supplied loads are ignored.
   - **Commit** verifies the token, **rehydrates** via `prescribeWeek` (so a workout
     committed between propose and commit is reflected), then persists by reusing the
     [apply-activity-layout](app/api/training-weeks/[week_start]/apply-activity-layout/route.ts)
     persistence logic: clear `exercise_overrides` on changed days, upsert
     `session_plan` (if moved) + `session_prescriptions`. Idempotent via upsert.

3. **Ladder semantics** (from `proposeActivityAwareLayout`): prefer **MOVE** the whole
   session to a conflict-free available day; if none, apply the **tiered LIGHTEN**; if a
   priority session (focus lift) is blocked, **FLAG** — Carter surfaces it and asks the
   athlete rather than silently compromising a priority day.

### Part 4 — Wiring, prompt, tests

- **Tool partitions** ([lib/coach/tools.ts](lib/coach/tools.ts)): add both tools to
  `CARTER_TOOLS` and `PETER_TOOLS`.
- **`PERSIST_RESULT_TOOLS`** and **`modeAllowsTool`**
  ([lib/coach/chat-stream.ts](lib/coach/chat-stream.ts)): add both tools to the persist
  set; add explicit default-mode allows (the `propose_*`/`commit_*` prefix guard would
  otherwise reject them).
- **`renderToolReceiptChip`** ([components/chat/ChatMessage.tsx](components/chat/ChatMessage.tsx)):
  preview chip for `propose_activity_adjustment` (move/lighten summary) and confirmation
  chip for `commit_activity_adjustment` (e.g. "✓ Adjusted Wed Legs — moved/lightened").
- **ChatPanel** ([components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx)): dispatch
  the assistant stub with `speaker: "carter"` so the chip/reply attributes correctly.
- **DB:** reuse `chat_messages.kind = "coach"` and `mode = "default"` — **no new kind/mode
  value, no migration.**
- **Prompt:** CARTER_BASE ([lib/coach/system-prompts.ts](lib/coach/system-prompts.ts))
  teaches: move-before-lighten discipline; the "hold load on the compound, cut eccentric
  accessory volume, raise RIR" rationale; and that the engine owns the numbers (Carter
  proposes/explains, never authors loads).
- **Tests:** extend [scripts/audit-prescription-rules.mjs](scripts/audit-prescription-rules.mjs)
  with fixtures for the three tiers (Tier A holds load + floors sets at 2 + RIR;
  Tier B floors sets at 1 + RIR; Tier C mild). Verify the full feature with
  `npm run typecheck` and `npm run build` (no render-test harness — keep hooks above early
  returns). Optionally add `scripts/audit-activity-adjustment.mjs` to dry-run conflict
  detection + preview for the current week.

## Edge cases & error handling

- **No conflict** → activity stored, Carter confirms plainly, no proposal.
- **MOVE available** → propose relocation (preferred); lighten not offered.
- **FLAG (priority session can't move)** → surface the flag, ask the athlete; do not
  auto-lighten a priority day.
- **Multiple activities** → handled by `proposeActivityAwareLayout` (already).
- **Same-day / past activity** → no adjustment.
- **Token expiry (30-min TTL)** → commit fails cleanly; Carter re-proposes.
- **Double commit** → upsert is deterministic and idempotent.

## Known limitation (accepted)

Re-running mid-week recomputes the whole week's `session_prescriptions`; past days are
overwritten cosmetically. This matches existing swap/apply behaviour, and the logger/card
read only the current day, so there is no functional impact. Scoping persistence to
affected-days-forward is a possible future refinement.

## Out of scope (possible follow-ups)

- Removing an exercise entirely (vs. flooring to 1 set) as the heaviest Tier-B cut.
- Distinguishing calves from quad/ham within the `"legs"` region for a finer Tier-C.
- Scoping persisted recompute to affected days only.
- A non-chat UI entry point beyond the existing Schedule-tab layout surface.

## Files touched (summary)

| File | Change |
| --- | --- |
| `lib/coach/prescription/prescribe-week.ts` | Tiered `lightenExercise`; expose layout from `prescribeWeek`. |
| `lib/coach/sessionPlans.ts` | Add optional `rir` to `PlannedExercise`. |
| `lib/coach/session-structure/annotate.ts` | Prefer `ex.rir` when present. |
| `lib/coach/tools.ts` | Conflict info from `executeAddPlannedActivity`; new propose/commit pair; partition sets. |
| `lib/coach/approval-token.ts` | Add `"activity_adjustment"` action. |
| `lib/coach/chat-stream.ts` | `PERSIST_RESULT_TOOLS` + `modeAllowsTool` allows. |
| `lib/coach/system-prompts.ts` | CARTER_BASE flow + rationale. |
| `app/api/training-weeks/[week_start]/apply-activity-layout/route.ts` | Extract reusable persistence helper. |
| `components/chat/ChatMessage.tsx` | Preview + confirmation chips. |
| `components/chat/ChatPanel.tsx` | `speaker: "carter"` stub. |
| `components/morning/BriefSessionList.tsx`, `components/strength/TodayPlanCard.tsx` | Display per-exercise RIR. |
| `scripts/audit-prescription-rules.mjs` | Tiered-lighten fixtures. |
