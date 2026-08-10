# Live session coaching — the coach speaks between sets

**Date:** 2026-08-10
**Status:** Design approved, ready for implementation plan
**Surface:** in-app workout logger (`components/logger/`)

## Problem

The logger records a session faithfully and says nothing about it. During a
session the athlete sees: an elapsed timer, a `Previous` column (the
same-ordinal set from last time), a `T{tier} · RPE` chip, the rest bar, and the
RIR input. Every *verdict* — PR, stall, regression, next week's load — arrives
hours later in the workout debrief card.

A coach standing next to you does most of their work in the ninety seconds
between sets. That window is currently dead air.

Form analysis is out of scope: there is no camera input, and video upload for
form review is a separate future arc.

## Scope

**In:** one deterministic coaching line after each committed set, rendered in
the logger, with an optional one-tap load application. Plus the visible
`Target` column that the line refers to.

**Out (deliberate, revisit after soak):**

- Session pacing ("48 min in, ~75 at this rate")
- Live weekly-MRV counter per muscle
- Mid-session exercise substitution from the exercise library
- Readiness framing banner at logger open
- Warmup ramp load computation and plate/dumbbell math
- The pre-set "one more rep and it's a PR" nudge — it needs a second render
  site on the pending set row; prove the post-set channel isn't annoying first

**Out permanently for this arc:** form/technique feedback of any kind.

## Decisions locked during brainstorming

1. **Advisory with one-tap apply**, not silent auto-application. The tap is the
   consent. Ignoring the line changes nothing.
2. **Speak only on deviation.** An on-plan set at the prescribed RIR produces
   silence. Scarcity is what keeps the line credible; a line appearing means
   something happened.
3. **Deterministic templating, no AI call.** Mid-set latency, unreliable gym
   wifi, and consistency with the codebase's standing discipline: the engine
   decides, AI only ever narrates.
4. **Nothing new is persisted.** The committed sets already carry the realized
   truth that the weekly engine and the debrief read. A suggestion, taken or
   ignored, leaves its trace in the numbers. No suggestion-audit table.
5. **Audio is reserved for PRs.** Everything else is silent text. (The rest-done
   cue this depends on was broken on iOS and was fixed separately — see
   "Dependency" below.)

## Architecture

### New module: `lib/coach/live-session/`

Pure, synchronous, no I/O, no AI. Mirrors the structure of
`lib/coach/prescription/` and `lib/coach/session-structure/`.

```
lib/coach/live-session/
  index.ts              // barrel + evaluateSet orchestrator
  types.ts              // LiveSetInput, LiveSessionContext, CoachLine
  rule-pr.ts
  rule-failure-budget.ts
  rule-drop-off.ts
  rule-load-call.ts
  rule-rest-discipline.ts
  __tests__/
```

Entry point:

```ts
evaluateSet(input: LiveSetInput): CoachLine | null
```

Each rule module exports a function of the same shape returning
`CoachLine | null`. The orchestrator evaluates them in fixed priority order and
returns the first non-null. Rules never see each other.

### Types

```ts
export type CoachLineKind = "pr" | "guardrail" | "load_call";

export type CoachLine = {
  kind: CoachLineKind;
  /** Single sentence, no markdown. Target ≤ 90 chars. */
  text: string;
  /** Present only on load calls. Tapping writes this into the next pending
   *  set's kg field. Absent when the call is "same weight". */
  apply_kg?: number;
  /** True only for PRs — the one line that also fires the audio cue. */
  cue: boolean;
  /** Which rule produced this. For tests and future observability. */
  rule: string;
};

export type LiveSetInput = {
  /** The set just committed. */
  set: ExerciseSetDraft;
  /** Its exercise, including `prescribed: PlannedExercise`. */
  exercise: ExerciseDraft;
  /** Sets committed so far THIS session, across all exercises — the failure
   *  budget is a session-level count, not a per-exercise one. */
  sessionSets: { exerciseName: string; set: ExerciseSetDraft }[];
  context: LiveSessionContext;
};

export type LiveSessionContext = {
  /** Per exercise name: 28 days of prior sets, in the exact shape the weekly
   *  prescription engine consumes. */
  historyByExercise: Record<string, WorkoutSetSample[]>;
  /** Per exercise name: best Brzycki e1RM over a 180-day window, via
   *  bestComparisonValue. Null when there is no usable history. The window is
   *  long on purpose — a "best" computed over a short recency window silently
   *  resets after any training gap, which would manufacture fake PRs. */
  bestByExercise: Record<string, number | null>;
  blockPhase: BlockPhase;
  /** training_weeks.rir_target for the current week. */
  rirTarget: number;
};
```

### Data flow

`LiveSessionContext` is fetched **once, at logger open**, by a new hook
`useLiveSessionContext(userId, date, exerciseNames)` following the standard
two-variant fetcher pattern in `lib/query/fetchers/`. One round trip. Rules then
run synchronously on every ✓ tap, so nothing touches the network in the hot
path — the feature keeps working when gym wifi drops, matching the draft's
existing IndexedDB resilience.

Rejected alternatives:

- **Per-set server call.** Latency on every tap and dead offline.
- **Per-rule hooks.** N+1 queries, and no rule could see cross-exercise state
  such as the session-wide failure budget.

### Reuse, do not restate

This is the single most load-bearing constraint in the spec. The four most
recent bugs in this area were all the same disease: a second copy of an engine
rule that drifted from the first. The live engine is a **new caller** of
existing rules, never a new author of them.

| Question | Existing owner |
|---|---|
| What is the effort band (easy / on / strained) for this set? | **New to this module:** `effortBand()` — `lib/coach/live-session/helpers.ts`. This is deliberately NOT `isCleanSet`/`isStrainedSet` (`lib/coach/prescription/session-grouping.ts`) — those two answer a session-level question over a `WorkoutSetSample[]` history the weekly engine has assembled; the live rule needs a three-way easy/on/strained band on a single in-flight draft set, mid-set, before any session exists to group. |
| What is the next load up / down on this grid? | `nextUpKg`, `nextDownKg` — `lib/coach/prescription/double-progression-rule.ts` |
| Is this a PR? | `brzycki`, `bestComparisonValue` — `lib/coach/e1rm.ts` |
| What tier / rest / RPE is this exercise? | `tierOf`, `restPrescription`, `repsForExercise` — `lib/coach/session-structure/` |
| Snapping an off-grid load | `roundToStep` — `lib/coach/prescription/calibrate-target.ts` |

No rule module may define its own notion of "one step up" or "PR". Effort
classification is the one new predicate this module owns — see the row above
for why.

## The rules

Priority order. First non-null wins; at most one line per committed set.

### 1. PR — `rule-pr.ts`

**Fires when** the committed set is non-warmup, its reps are in 1..12, and
`brzycki(kg, reps)` exceeds `context.bestByExercise[name]`.

**Line:** `PR — 82.5 × 5 = 95.6 e1RM, past your best by 2.1.`

`kind: "pr"`, `cue: true`.

**Guards:**

- Silent when there is no prior history for the exercise (`best` is null) —
  a first-ever entry is not a PR.
- Silent when the implied e1RM jump exceeds **15%** in a single session. That
  is a mistyped weight far more often than a genuine PR, and a false
  celebration is worse than a missed one.

### 2. Failure budget — `rule-failure-budget.ts`

**Fires when** this set is marked `failure` (or `rir === 0`), the count of such
sets across `sessionSets` today is ≥ 2, and this is **not** the final working
set of a tier-3/4 isolation exercise (where training to failure is appropriate).

**Line:** `3rd set to failure today. That's fatigue you'll pay for Thursday — leave 2 in the tank.`

`kind: "guardrail"`.

### 3. Drop-off — `rule-drop-off.ts`

**Fires when** ≥3 working sets of this exercise are committed and the latest
set's reps are below **75%** of the best working set at the same-or-higher load.

**Line:** `12 → 9 → 7. Past the useful range — last set or move on.`

`kind: "guardrail"`. Rationale: rep drop-off at fixed load is the practical
proxy for velocity loss, which is the standard in-session stopping criterion.

### 4. Load call — `rule-load-call.ts`

The core verdict. Requires both `reps` and `rir` on the committed set; silent
when RIR was not recorded. Rep target comes from `repsForExercise(prescribed)`,
effort target from `prescribed.rir ?? context.rirTarget`.

Let `R` = reps, `T` = rep target, `r` = recorded RIR, `t` = effort target.
Effort bands are exactly three: **easy** (`r ≥ t + 2`), **on** (`t ≤ r < t + 2`),
**strained** (`r < t`, or the set is marked `failure`). The table below is
exhaustive over `{R ≥ T, R < T} × {easy, on, strained}` — all six cells are
specified, so no input falls through.

| Reps | Effort | Output |
|---|---|---|
| `R ≥ T` | easy | `Too easy at RIR 4. → 65 next set.` `apply_kg = nextUpKg(kg, increment)` |
| `R ≥ T` | on | **null — silent.** The set went exactly to plan. |
| `R ≥ T` | strained | `Hit 10, but that cost more than it should. Same weight.` no `apply_kg` |
| `R < T` | easy | `Stopped 3 short with 4 in reserve. Same weight — push it.` no `apply_kg` |
| `R < T` | on | `3 short at the right effort. Load's heavy for this range — hold and let reps climb.` no `apply_kg` |
| `R < T` | strained | `Short by 3 with nothing left. → 57.5.` `apply_kg = nextDownKg(kg, increment)` |

The step-up threshold is deliberately `r ≥ t + 2` rather than `r > t`. One rep
easier than intended is inside normal RIR-estimation error; two or more is an
unambiguous signal the load is light. This is stricter than the weekly engine's
step-up (which requires *every* set clean at the range top) on purpose — a
single set is weaker evidence than a session, so it takes a clearer signal to
move a number mid-workout.

`kind: "load_call"`.

**Final-set reframing:** when the committed set is the last working set of the
exercise, the same rule swaps its horizon from "next set" to "next time":
`Too easy at RIR 4. → 62.5 next time.` The load arithmetic is identical; only
the wording changes. It says "next time" rather than naming a weekday because
resolving the next occurrence of this session type needs calendar logic the
rule has no business owning.

**Block-phase gate:** when `blockPhase` is `consolidation`, `off_pace`, or
`deload_week`, load is frozen — the first two by the block-phase rule, deload
by the accessory rule's deload branch, which holds load and halves sets. The
live rule must not contradict any of them, so in those phases a call degrades
to a rep-scope line (`Too easy at RIR 4. Add a rep next set — load's held this
block.`) with no `apply_kg`, in **both** directions. An exercise with no
`increment` grid (bodyweight work) is treated identically: advise, never name a
weight.

### 5. Rest discipline — `rule-rest-discipline.ts`

**Fires when** the recorded rest before this set is under **60%** of
`restPrescription(tier, reps).min` on a tier-1 or tier-2 exercise.

**Line:** `55s on a 3-minute lift. Expect the next set to come up short.`

`kind: "guardrail"`. At most once per exercise per session, so it informs
rather than nags. The over-resting case (padding on accessories) is dropped
from v1 — it is real but not costly enough to spend a line on.

**Warmups are excluded from the measurement on both sides.** Every lifting
day's first exercise carries warmup sets in the same `exercise.sets[]` /
`set_index` space as the working sets, and the warmup-to-first-working-set
transition is legitimately short — it is not the inter-working-set rest that
`restPrescription` describes. Counting a warmup as the "prior" set would
false-flag that transition and, through the once-per-exercise gate, then
suppress the rule for the remainder of the exercise. The accepted consequence
is that the first working set of an exercise stays silent: there is nothing to
judge until a second working set exists. The once-per-exercise scan skips
warmups for the same reason.

Rest is derived from `committed_at` deltas between working sets, NOT from
`ExerciseSetDraft.rest_seconds_actual` — that field is undefined mid-session
and only gets populated at commit time. Deriving it the same way keeps the
live number consistent with the one eventually persisted.

## Surface

A `CoachLine` component rendered inside `ExerciseCard`, in the row slot
directly beneath the set just committed and immediately above `RestBar`.

- One line, replaced by the next commit. No dismiss button — one less tap.
- Colour by `kind`: green for `pr`, amber for `guardrail`, blue for
  `load_call`. Follows the existing token usage in `ExerciseCard`.
- `role="status"` with `aria-live="polite"`.
- When `apply_kg` is present the number is a tap target. Tapping writes it into
  the next pending set's kg field via the existing `patchSet` callback and
  nothing else.
- PRs additionally call `fireCue()` from `lib/logger/audio-cue.ts`.

### Target column

`ExerciseCard`'s set table gains a `Target` column beside `Previous`, showing
`{baseKg} × {baseReps} @{rir}` from `exercise.prescribed`. Today the prescribed
load is silently pre-filled into the kg input and the rep target is not shown
at all, so the athlete cannot see the number the coaching line refers to. This
column is a prerequisite for the rules above, not a nice-to-have.

The table is already dense on a phone. `Previous` and `Target` share a column
group with `Target` on top and `Previous` beneath it in smaller type, rather
than adding a seventh column.

## Failure handling

Every rule is total: any missing input yields `null`, never a throw. A
malformed or absent `LiveSessionContext` (fetch failed, offline at open)
degrades the feature to silence — the logger records the session exactly as it
does today. The coaching line is strictly additive and never blocks a commit.

`evaluateSet` is wrapped at the call site so a rule bug can never prevent a set
from being logged.

## Verification

Rule modules are pure and live under `lib/coach/live-session/__tests__/`, which
the vitest glob (`lib/**/__tests__/**/*.test.ts`) already covers. Unlike the
logger components, this layer is genuinely testable.

- One `describe` per rule, fixture-driven.
- One `describe` for orchestrator priority ordering: a set that satisfies both
  the PR rule and the load-call rule must emit the PR line and only that line.
- One `describe` asserting **silence** — an on-plan set at the prescribed RIR
  returns `null`. This is the rule most likely to rot.
- Guard coverage: no-history PR suppression, the 15% jump suppression, the
  block-phase freeze degradation, the once-per-exercise rest cap.
- Exhaustiveness: a table-driven test over all six `{R ≥ T, R < T} × {easy, on,
  strained}` cells, asserting exactly one is silent and the two `apply_kg`
  cells carry the grid-correct load.
- `scripts/audit-live-session-rules.mjs`, fixture-based and DB-free, mirroring
  `scripts/audit-prescription-rules.mjs`.

**Anti-drift assertion:** a live step-up call must equal
`nextUpKg(currentKg, increment)` exactly, and a step-down must equal
`nextDownKg(...)`.

To be straight about the limit of that test: it is not a full equivalence proof
against `prescribeAccessoryDoubleProgression`. That function reasons over 28
days of *sessions*; this one reasons over *one set*. They answer different
questions and will legitimately disagree — the weekly engine can see a pattern
across sessions that a single set cannot. What the test does guarantee is that
both land on the same equipment grid through the same function, which is where
drift would actually bite.

Manual verification: `npm run typecheck`, `npx vitest run`, `npm run build`
(components are not render-tested, and React #310-class hook errors surface only
in a production build), then a real session in the gym.

## Risks

| Risk | Mitigation |
|---|---|
| The line becomes wallpaper | The silence rule. Nothing on an on-plan set. |
| A mistyped weight fakes a PR | Suppress e1RM jumps >15% in one session. |
| Apply-tap races the athlete typing | Only write into an empty, uncommitted kg field. |
| Live and weekly engines disagree | Shared predicates and grid functions; anti-drift test. |
| Guardrails read as nagging | Failure budget needs ≥2 prior failure sets; rest discipline caps at once per exercise. |

## Dependency

This design assumes the logger's audio cue works. It did not: the cue shipped
in `5111bf0` constructed a fresh `AudioContext` inside the countdown's 250ms
interval, and iOS only permits audio from a context created or resumed
synchronously within a user gesture, so it emitted silence on iPhone from day
one. `navigator.vibrate` compounded it — iOS Safari has never implemented the
Vibration API. Both failures were swallowed by empty `catch` blocks.

Fixed on branch `fix/logger-rest-cue-ios` (commit `aa23880`) ahead of this
work: `lib/logger/audio-cue.ts` splits the cue into `unlockCue()` (runs from a
real tap, builds one `AudioContext` and one primed `<audio>` element per
session) and `fireCue()` (runs from timers, constructs nothing). The media
element is the primary output because WebAudio on iOS routes to the ringer
channel and is silenced by the physical mute switch — the default state in a
gym. Awaiting on-device confirmation.

## Follow-on arcs

The deferred items in Scope, roughly in the order they earn their place:
pre-set near-PR nudge, warmup ramp loads with plate math, session pacing, live
MRV counter, mid-session substitution.
