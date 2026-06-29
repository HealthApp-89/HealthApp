# Reactive DOMS Autoregulation — Design

**Date:** 2026-06-29
**Status:** Approved (design); pending implementation plan
**Owner area:** Coach / strength prescription (Carter), reactive ladder

## Problem

The proactive path (shipped 2026-06-29, `feat/activity-aware-session-adjustment`)
rewrites a whole session deterministically when a conflicting activity is logged
*before* it happens. The **reactive** path — when DOMS actually shows up after the
activity — is still weak:

1. **Capture is morning-only.** Soreness registers via the morning intake bot or the
   Log tab (`checkins.soreness_areas` / `soreness_severity` / `fatigue`). Telling
   Carter "my lower back is wrecked from padel" in normal `/coach` chat does nothing.
2. **It's advisory, not enforced.** The reactive ladder
   ([lib/coach/activity/reactive-ladder.ts](lib/coach/activity/reactive-ladder.ts))
   picks a rung (`none → load_down → volume_down → swap_exercise → swap_day`), but
   only `swap_day` (→ swap-to-Mobility chip) actually changes the session. `load_down`
   / `volume_down` / `swap_exercise` render as per-exercise *cues* via
   `sorenessAwareCue` in [annotate.ts](lib/coach/session-structure/annotate.ts) and
   adjust nothing.
3. **It misses exercises.** The reactive exercise→region hints
   (`EXERCISE_REGION_HINTS` in annotate.ts) have no pattern for **Back Extension**, so
   the one Back-day movement that hammers the erectors isn't flagged when the lower
   back is sore. Only the deadlift gets cued.

This is the same "headline-lift-only, suggestion-not-action" gap the proactive work
fixed — just on the post-activity side.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Report path | **Anytime in chat (new Carter tool) + morning intake**, with an on-demand re-adjust that works after the brief is delivered. |
| Reactive lever | **Drop load + cut volume, scaled by severity** — the DOMS-appropriate inverse of the proactive primer (proactive holds load; reactive drops it because the tissue is damaged). Engine-owned + persisted, not a cue. |
| Offender rung (sharp on a secondary muscle) | **Minimize or drop the offending exercise** (1 set + deep load cut, or skip), keep non-overlapping exercises normal. No library substitution. |
| Trigger for enforcement | A **reported soreness** signal. Recent-activity overlap escalates severity but does not by itself force a change. |

## Research basis

Established earlier in this work and reaffirmed here: tapering/priming says *hold*
intensity when fresh, but training *through* DOMS is the opposite situation — when a
muscle is already damaged you reduce **intensity** (load) and volume, or work
unaffected parts; loading a sore muscle near-max raises strain/re-injury risk and
force output is already impaired. Hence the reactive lever drops load, unlike the
proactive primer. ([DOMS/agility study](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7559839/),
[Bosquet taper meta-analysis](https://pubmed.ncbi.nlm.nih.gov/17762369/) for the
fresh-muscle contrast.)

## Design

### Part 1 — `report_soreness` chat tool

A new Carter/Peter tool, allowed in default mode, that records today's soreness from a
free-form chat message into the existing `checkins` columns:
`soreness_areas` (subset of `chest|back|legs|shoulders|arms|core`), `soreness_severity`
(`mild|sharp`), and optionally `fatigue` (`none|some|heavy`). It resolves today's date
in the user's timezone, upserts the `checkins` row (preserving other intake fields),
and returns the recorded soreness plus a `should_adjust` hint so Carter knows to offer
`propose_reactive_adjustment`. The morning intake and Log tab remain unchanged as the
other entry points. **Enforcement requires this reported signal** — the recent-padel
overlap escalates severity but won't silently change a session when the athlete feels
fine.

### Part 2 — `reactiveAdjustSession` (engine-owned lever)

A new pure module (e.g. `lib/coach/activity/reactive-adjust.ts`):

```
reactiveAdjustSession(
  exercises: PlannedExercise[],          // engine's session_prescriptions[today] as base
  ctx: { soreRegions, soreSeverity, fatigue, sessionRegions, rung }
): { exercises: PlannedExercise[], changes: ReactiveChange[] }
```

It applies the rung (from `selectReactiveRung`) per exercise, gated by whether the
exercise's region overlaps the sore regions:

- **load_down** (mild, no extra fatigue) → multiply `baseKg` by ~0.9 (round to the
  exercise's `increment.step`); hold sets/reps.
- **volume_down** (mild + `some`/`heavy` fatigue) → ~0.9 × load **and** −1 set (floor 1).
- **minimize_offender** (sharp on a *secondary* session muscle) → cut the offending
  exercise(s) to 1 set with a deep load cut (~0.75 ×), or drop it entirely; leave
  non-overlapping exercises untouched. (Renamed from the old `swap_exercise` rung's
  cue semantics — no library substitution.)
- **swap_day** (sharp on the day's *primary* muscle, or sharp + heavy fatigue) → not a
  per-exercise transform; handled by the existing swap-to-Mobility route (Part 3).

Load (`baseKg`) reduction here is legitimate and keeps "engine owns loads" true: the
drop is a **deterministic rule** given the soreness input, not an LLM-authored number —
exactly like the proactive `lightenExercise` is a deterministic rule given the activity
input. The per-exercise `rir`/`note` fields added in the proactive work carry the
"reactive: −10% for lower-back DOMS" annotation so it's visible on the brief/card.

### Part 3 — Trigger + persist (mirror the proactive propose/commit)

A `propose_reactive_adjustment` / `commit_reactive_adjustment` HMAC tool pair
(new `ApprovalAction` value `"reactive_adjustment"`), mirroring
`propose_/commit_activity_adjustment`:

- **Propose** reads today's `checkins` soreness + recent activity, runs
  `selectReactiveRung`, and:
  - for load/volume/minimize rungs: applies `reactiveAdjustSession` to today's resolved
    prescription and returns a preview diff (per-exercise before/after sets/reps/load);
  - for swap_day: returns a "swap to Mobility" proposal (delegates to the existing swap
    route on commit).
  Signs a token with `{ date, rung, adjusted_today }` (small payload).
- **Commit** verifies the token and persists: for load/volume/minimize, upsert the
  adjusted exercises into `session_prescriptions[<today-long-weekday>]` (today only — a
  surgical write, not a whole-week recompute, since soreness is a today signal); for
  swap_day, call the swap route with `action:"replace", session_type:"Mobility",
  reactive_context`.

Because it writes today's prescription, it works **after the morning brief is already
delivered** — the logger ([resolve-plan.ts](lib/logger/resolve-plan.ts)), the strength
card, and the brief all read `session_prescriptions[today]`, so they reflect the change
on next load. No new override layer in the resolution chain.

### Part 4 — Make the morning-brief reactive cues actionable

Today the brief assembler ([lib/morning/brief/assembler.ts](lib/morning/brief/assembler.ts))
turns load_down/volume_down/swap_exercise into display-only cues. Upgrade those rungs to
surface the same preview→confirm chip (driving `commit_reactive_adjustment`) instead of
bare text, so a sore-morning check-in enforces the change. Keep the existing
swap-to-Mobility chip for swap_day unchanged.

### Part 5 — Region-map fix

Add **Back Extension** (and verify good-morning / hyperextension-type names) to the
reactive `EXERCISE_REGION_HINTS` so lower-back work is flagged when the lower back is
sore. The proactive (`exerciseRegion` via `getExerciseMuscles`, no `lower_back`/`core`
vocabulary) and reactive (`EXERCISE_REGION_HINTS` regex, has `lower_back`/`core`) paths
use two different mappers; this spec fixes the reactive mapper's gap only and records
the duplication as tech debt rather than risking a unify-refactor here.

### Part 6 — Log all enforced rungs as interventions

The swap route already logs swap_day to `coach_interventions`
([swap/route.ts](app/api/training-weeks/[week_start]/swap/route.ts)). Extend
`commit_reactive_adjustment` to log load_down/volume_down/minimize_offender too
(best-effort, never blocks the commit), so the existing outcome evaluators can learn
whether the reactive adjustment helped recovery.

### Part 7 — Wiring, prompt, tests

- Tool partitions (CARTER_TOOLS + PETER_TOOLS), `PERSIST_RESULT_TOOLS`, `modeAllowsTool`
  default-mode allows, chat-stream dispatch branches, and `renderToolReceiptChip`
  for `report_soreness` + `propose_/commit_reactive_adjustment`.
- `ApprovalAction` += `"reactive_adjustment"` in
  [approval-token.ts](lib/coach/approval-token.ts).
- CARTER_BASE / PETER_BASE teach: read a reported-soreness signal → offer
  `propose_reactive_adjustment` proactively; the reactive lever drops load
  deterministically (you don't author it); minimize the offender for sharp secondary
  soreness; swap the day for sharp primary / sharp+heavy fatigue.
- Reuse `chat_messages.kind="coach"`, `mode="default"` — no new migration.
- Tests: pure-function fixtures for `reactiveAdjustSession` (each rung: load drop on
  grid, volume cut floors, minimize-offender keeps non-overlapping exercises, region
  gating); a read-only e2e audit (`scripts/audit-reactive-adjustment.mjs`) dry-running
  the rung + preview for the current day. Verify with `npm run typecheck` +
  `npm run build` (no render-test harness).

## Edge cases & error handling

- **No soreness reported** → no enforcement; activity-only overlap stays advisory.
- **No `session_prescriptions[today]`** (un-prescribed week / no active block) → fall
  back to the resolved effective plan as the base for the preview (same lesson as the
  proactive lighten-only fix); don't return a false "no adjustment".
- **swap_day on a day with no training_weeks row** → graceful error, ask the athlete.
- **report_soreness** is best-effort about the conflict computation: recording the
  soreness must never fail because the adjustment preview threw.
- **Token expiry (30 min)** → commit fails cleanly; Carter re-proposes.
- **Double commit** → idempotent (today's prescription upsert is deterministic; swap
  route is idempotent).

## Out of scope (possible follow-ups)

- Unifying the proactive and reactive exercise→region mappers into one source of truth.
- Library-based exercise substitution for the offender rung.
- Auto-enforcing on the activity-only signal (no soreness report).
- Multi-day soreness carry-over (each day is evaluated from that day's check-in).

## Files touched (summary)

| File | Change |
| --- | --- |
| `lib/coach/tools.ts` | `report_soreness` tool + executor; `propose_/commit_reactive_adjustment` pair; partitions. |
| `lib/coach/activity/reactive-adjust.ts` (new) | `reactiveAdjustSession` pure lever. |
| `lib/coach/activity/reactive-ladder.ts` | rung name/semantics alignment (`minimize_offender`). |
| `lib/coach/session-structure/annotate.ts` | add Back Extension to `EXERCISE_REGION_HINTS`. |
| `lib/coach/approval-token.ts` | add `"reactive_adjustment"`. |
| `lib/coach/chat-stream.ts` | dispatch + `PERSIST_RESULT_TOOLS` + `modeAllowsTool`. |
| `lib/morning/brief/assembler.ts` | reactive cues → actionable chips. |
| `components/chat/ChatMessage.tsx` | receipt chips. |
| `components/morning/BriefCoachSuggestion.tsx` | actionable chip for load/volume/minimize rungs. |
| `app/api/training-weeks/[week_start]/swap/route.ts` | (reuse) swap_day path; intervention logging already present. |
| `lib/coach/system-prompts.ts` | CARTER_BASE / PETER_BASE reactive flow. |
| `scripts/audit-reactive-adjustment.mjs` (new) + `scripts/audit-prescription-rules.mjs` | tests. |
