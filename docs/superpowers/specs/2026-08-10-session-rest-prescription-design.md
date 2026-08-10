# Session Rest Prescription — Design

**Date:** 2026-08-10
**Status:** Approved, pending implementation
**Touches:** `lib/coach/session-structure/`, the workout logger's rest bar and draft shape, the morning brief + strength card rest chips, `lib/coach/live-session/rule-rest-discipline.ts`
**Branch:** `docs/session-rest-prescription`

## Problem

Three defects in how the app prescribes rest.

**1. The values are ranges, and the logger silently takes the bottom of every one.**
`restPrescription` returns `{min, max}`. [ExerciseCard.tsx:41](../../../components/logger/ExerciseCard.tsx#L41) reads `.min`. So a heavy compound prescribed "3–5 min" runs a 3-minute timer, every time. The athlete never sees the top of the range unless they read the chip on the brief and override manually. A range that one consumer always resolves to its floor is not a range — it is a lower value with extra display noise.

**2. Rest between exercises does not exist as a concept.**
The rest bar fires between sets within an `ExerciseCard`. When the last set of exercise N commits, the bar runs exercise N's set rest and then the athlete moves to card N+1 untimed. In practice the transition into a heavy compound needs more rest than the transition between two sets of an isolation — the current model cannot express that.

**3. Warm-up rest is flat, including the ramp set immediately before a heavy top set.**
`augmentWarmups` in [prescribe-week.ts:495](../../../lib/coach/prescription/prescribe-week.ts#L495) inserts two `warmup: true` `PlannedExercise` entries before the first loaded compound of every lifting day. All warm-up entries get 30–60 s. The second one is the last thing standing between the athlete and their heaviest working set of the day; 45 s there compromises the set the whole session is built around. Per the standing warm-up rule this fires on every lifting day.

**4. A manual rest override does not survive the session.**
The logger's "Edit rest time" dialog stores its value in `useState` on `ExerciseCard` rather than on the draft. It therefore vanishes on resume and on exercise reorder, and it does not reach a rest bar that is already counting down. The athlete's explicit correction to the engine is the one value in the logger that is not durable.

## Evidence base

Rest length matters because it protects volume-load (weight × reps × sets). Anything that costs reps on sets 2–4 costs the hypertrophy stimulus that set 1 bought.

- Schoenfeld et al. 2016 (JSCR): trained men, 3 min vs 1 min rest, identical programme — the 3-min group gained more in both strength and muscle thickness.
- Grgic et al. 2017/2018 meta-analyses: rest ≥2 min is clearly superior for strength. For hypertrophy the gap is smaller and closes only when the short-rest group adds sets to recover the lost volume.
- Practical corollary (Israetel / Helms / Nippard): rest until you can hit the prescribed reps at the prescribed RIR. The clock is a floor, not a target — which is an argument for prescribing one honest number rather than a range whose ceiling nobody reads.

## Design

### 1. Single-value, muscle-size-aware rest table

`restPrescription(tier, reps)` becomes `restPrescription(ex, tier)` and returns **a single number of seconds**. Reps leave the signature entirely — the new table does not branch on them.

| Tier | Bucket | Rest |
|---|---|---|
| 0 | Warm-up ramp | 45 s |
| 0 | Last warm-up before the first working exercise | **120 s** |
| 1 | Heavy compound (squat, deadlift, bench, OHP) | **240 s** |
| 2 | Secondary compound (DB press, RDL, row, pulldown, leg press) | **180 s** |
| 3 | Isolation — large muscle | **120 s** |
| 3 | Isolation — small muscle | **60 s** |
| 4 | Finisher / abs / bodyweight to failure | 45 s |

The tier-3 split is a real coaching distinction: a large-muscle isolation taken near failure (leg extension, leg curl, chest fly, pullover, machine hip thrust) imposes systemic and local fatigue on a par with a light compound, while a small-muscle isolation (curl, pushdown, lateral raise, calf, shrug) recovers in about a minute.

Classification reads `getExerciseMuscles(ex.name).primary` from [lib/coach/exercise-muscles.ts](../../../lib/coach/exercise-muscles.ts):

- **LARGE** — Chest (4), Lats (12), Quads (10), Hams (11), Glutes (8), Traps (9)
- **SMALL** — Biceps (1), Triceps (5), FrontDelts (2), RearDelts (17), Calves (7), Soleus (15), Abs (6), Obliques (14), Brachialis (13), Serratus (3)

Mixed primaries → LARGE wins (any large muscle in the primary set makes the exercise expensive). Unknown name → SMALL, deliberately conservative: it yields the shortest timer, and the athlete can lengthen it from the logger's existing "Edit rest time" dialog. A wrong-but-short default costs one tap; a wrong-but-long default costs four minutes of standing around before the athlete notices.

### 2. Last-warm-up bump

Not implemented inside `restPrescription` — it depends on the neighbouring exercise, and keeping `restPrescription` a pure `(ex, tier) → number` keeps it directly testable. It is a second pass in `annotateSession`: for each `warmup === true` entry whose successor in the annotated array is not a warm-up, overwrite `rest_seconds` with 120.

Edge cases:
- A session with no warm-up entries (rest day, mobility, or a lifting day whose working weight was too low for `augmentWarmups` to fire) — no-op.
- A session that is *entirely* warm-up entries — no entry has a non-warm-up successor, so none is bumped. Correct: there is no working set to protect.

### 3. Between-exercise transition rest

New field on `AnnotatedExercise`:

```ts
/** Seconds to rest BEFORE starting this exercise — i.e. after finishing the
 *  previous one. Null on the session's first exercise and on all warm-up
 *  entries. */
transition_seconds: number | null;
```

Rule: `restPrescription(ex, tier) + 60`. The prescription is set by the demand of what is *coming*, not the fatigue of what just finished; the +60 s covers station change, plate loading, and set-up.

Resulting values: 300 s into a heavy compound, 240 s into a secondary compound, 180 s into large isolation, 120 s into small isolation, 105 s into a finisher.

**Explicitly not doing:** a same-muscle vs different-muscle refinement. Moving from bench to a chest fly genuinely warrants more rest than bench to a leg curl, but the incoming-tier rule already captures most of that ordering, and the extra muscle-overlap check on every transition buys a ±30 s difference. Revisit only if the logged `rest_seconds_actual` data shows athletes systematically overshooting the transition on different-muscle pairs.

**Surface: logger only.** When the last set of exercise N commits, the rest bar runs exercise N+1's `transition_seconds` and labels it `Next: {name}` rather than the generic rest copy. The morning brief and `TodayPlanCard` continue to show one rest chip per exercise — a second number per row is clutter on cards that get a five-second scan.

When exercise N is the last in the session, no transition bar fires; the existing set-rest bar behaviour is unchanged.

### 4. Manual rest override becomes exercise-scoped and durable

The logger already has an "Edit rest time" dialog, and its value already governs every subsequent set of that exercise — `restOverrideSeconds` is `ExerciseCard`-level state feeding `effectiveRest`, which every `commitSet` reads. But it is `useState`, not draft data, and three holes make it behave as if it were not exercise-wide:

1. **Lost on resume.** The override is not in `LoggerDraft`, so [draft-store.ts](../../../lib/logger/draft-store.ts) never mirrors it to IndexedDB. Close the sheet mid-session, reopen, and the timer silently reverts to the prescription with no indication anything changed.
2. **Lost on reorder.** Cards are keyed `` `${draft.started_at}-${ex.name}-${i}` `` at [LoggerSheet.tsx:587](../../../components/logger/LoggerSheet.tsx#L587). The index in that key means reordering exercises remounts the cards and resets every override to null.
3. **Ignored by the running bar.** `activeRestSeconds` is snapshotted into state at commit time, so editing rest while a countdown is on screen does not touch the bar being watched. Only the *next* commit picks the new value up.

Fix: move the override out of component state and onto the draft.

```ts
// ExerciseDraft, lib/logger/types.ts
/** Athlete's manual rest override for this exercise, in seconds. Applies to
 *  every set of the exercise for the rest of the session, including a rest
 *  already counting down. Null/undefined = use the tier prescription.
 *  Draft-only — not sent to commit_logger_session, not persisted past the
 *  session. */
rest_override_seconds?: number | null;
```

`RestTimeDialog`'s `onConfirm` calls `onExerciseChange(exerciseIndex, { ...exercise, rest_override_seconds: seconds })` instead of `setRestOverrideSeconds`. That routes through the existing `LoggerSheet` draft-persist path, which fixes (1) and (2) for free: the value now lives in the data, so IndexedDB mirrors it and remounting a card cannot lose it.

For (3), delete the `activeRestSeconds` state entirely and pass `effectiveRest` straight to `<RestBar duration_seconds={...}>`. `useRestCountdown` recomputes `remaining_seconds = duration_seconds - elapsed_seconds` on every render, so a live value takes effect immediately: shortening rest mid-countdown collapses the bar and fires the done cue, lengthening it extends the bar.

One accepted edge: `doneFiredRef` resets only when `started_at` changes, so lengthening rest *after* the cue has already fired shows a running bar again but does not re-fire the audio cue. That is the right trade — a second cue for a rest the athlete deliberately extended would be noise.

Scope boundaries:
- **Session-scoped, not permanent.** The override dies with the draft. It deliberately does not write to `user_session_templates`, because the point of this arc is to make the tier prescription correct — a persistent override would quietly shadow the new values forever and the athlete would never see them. A per-exercise rest default is a separate arc with its own column.
- **Clears on Replace.** Replacing an exercise builds a fresh `ExerciseDraft`, so the override clears naturally — correct, since the new exercise carries a different prescription.
- **Not carried into edit mode.** `hydrateWorkoutAsDraft` reconstructs drafts from committed rows, which never stored an override; it comes back undefined and falls through to the prescription.
- **Does not affect `transition_seconds`.** The transition into the *next* exercise is derived from that exercise's own prescription. An override on exercise N says nothing about how long to rest before exercise N+1.

### 5. `rest_seconds` becomes a number

`AnnotatedExercise.rest_seconds: { min, max }` → `rest_seconds: number`. The two duplicate `fmtRestRange` helpers ([BriefSessionList.tsx:16](../../../components/morning/BriefSessionList.tsx#L16), [TodayPlanCard.tsx:14](../../../components/strength/TodayPlanCard.tsx#L14)) collapse into one shared `fmtRest(seconds)` rendering `"4 min"`, `"3 min"`, `"2 min"`, `"60s"`, `"45s"`.

## Blast radius

| File | Change |
|---|---|
| [lib/coach/session-structure/rules.ts](../../../lib/coach/session-structure/rules.ts) | Rewrite `restPrescription`; add `isolationSize` helper; drop the now-unused reps lookup from the rest path (`repsForExercise` stays — other callers use it) |
| [lib/coach/session-structure/annotate.ts](../../../lib/coach/session-structure/annotate.ts) | `rest_seconds: number`; new `transition_seconds`; second pass for the last-warm-up bump and transitions |
| [lib/logger/types.ts](../../../lib/logger/types.ts) | `ExerciseDraft` gains `rest_override_seconds?: number \| null` |
| [components/logger/ExerciseCard.tsx](../../../components/logger/ExerciseCard.tsx) | `.min` → the number; drop `restOverrideSeconds` and `activeRestSeconds` state, read the override from `exercise` and pass `effectiveRest` live to `RestBar`; last-set-of-exercise branch in `commitSet` reads the next card's `transition_seconds`; `RestBar` gains the `Next: {name}` label |
| [components/logger/RestTimeDialog.tsx](../../../components/logger/RestTimeDialog.tsx) | `onConfirm` writes through to the draft; presets re-checked against the new table (240 s is present, 45 s is not) |
| [components/morning/BriefSessionList.tsx](../../../components/morning/BriefSessionList.tsx) | `fmtRestRange` → shared `fmtRest` |
| [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx) | `fmtRestRange` → shared `fmtRest` |
| [components/strength/SessionStructureBanner.tsx](../../../components/strength/SessionStructureBanner.tsx) | Must also strip `transition_seconds` in the line-136 destructure, or the annotation leaks into the persisted `exercise_overrides` |
| [lib/coach/live-session/rule-rest-discipline.ts](../../../lib/coach/live-session/rule-rest-discipline.ts) | **Breaking:** two `restPrescription(tier, reps).min` call sites → `restPrescription(exercise.prescribed, tier)`; see below |

### Interaction with the live-session rest-discipline guardrail

`ruleRestDiscipline` flags a working set when the commit-to-commit delta falls below `UNDER_REST_RATIO` (0.6) × the prescribed minimum. Raising the prescription raises the threshold:

| Tier | Old threshold | New threshold |
|---|---|---|
| 1 heavy compound | 108 s (0.6 × 180) | **144 s** (0.6 × 240) |
| 2 secondary compound | 72 s (0.6 × 120) | **108 s** (0.6 × 180) |

`UNDER_REST_RATIO` stays at 0.6. The old thresholds were low because the underlying prescriptions were the floors of ranges nobody honoured; now that the prescription is the honest number, 60% of it is the right line for "meaningfully under-rested". The guardrail firing more often is the intended consequence, not a regression — but it should be watched for nagging in the first week of live use, since the rule's own once-per-exercise gate is the only volume control.

The existing fixtures in [evaluate-set.test.ts](../../../lib/coach/live-session/__tests__/evaluate-set.test.ts) that assert on rest deltas need their timings re-checked against the new thresholds. Line 59 of that file carries a comment pinning the old arithmetic verbatim (`restPrescription(tier 1, 5) = { min: 180 }. 60% = 108s.`) — it must be rewritten, not just the assertions around it.

## Testing

There is no test file for `session-structure` today. `annotateSession` is imported only by [scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs), which makes no rest assertions — so the current table ships unverified. This work adds `lib/coach/session-structure/__tests__/rest.test.ts` covering:

- Each tier's value, including both sides of the tier-3 large/small split
- Mixed-primary exercises resolving to LARGE
- Unknown exercise names resolving to SMALL
- The last-warm-up bump firing on the second of two warm-up entries and not the first
- The no-warm-up and all-warm-up sessions both no-opping
- `transition_seconds` null on the first exercise and on every warm-up entry
- `transition_seconds` = rest + 60 for each tier
- A full realistic lifting-day session end to end (two warm-ups → heavy compound → secondary → isolations → core finisher)

The manual-override work (§4) is UI state and cannot be covered by the node-environment vitest setup. Verify it by hand in a real session:

1. Set a rest override on exercise 2, commit a set, confirm the bar uses it.
2. Close and reopen the sheet — the override must survive (this is the resume fix).
3. Reorder exercises — the override must stay attached to its exercise (this is the remount fix).
4. Edit rest *while* a bar is counting down — the bar must re-scale immediately.
5. Replace the exercise — the override must clear back to the prescription.

Verification: `npx vitest run` + `npm run typecheck`. Per the no-render-test-harness constraint, also `npm run build` — `ExerciseCard` gains a hook-adjacent branch and vitest will not catch a React error there.

## Out of scope

- Same-muscle vs different-muscle transition refinement (see §3)
- Showing transition rest on the brief or strength card
- Per-user rest preferences or a global rest multiplier
- Persisting a manual rest override past the session, or into `user_session_templates` as a per-exercise default (see §4)
- Adjusting a running rest bar with +30 s / −30 s buttons — the "Edit rest time" dialog now covers this, since it re-scales the live bar
- Auto-adjusting rest from readiness or `rest_seconds_actual` history — the data is being collected, but a closed loop is a separate arc
- Changing `UNDER_REST_RATIO` or the rest-discipline rule's structure

## Sequencing note

This work touches `restPrescription`'s signature, which the in-flight live-session-coaching arc consumes (Task 5 of 8 complete on `feat/live-session-coaching`). Recommendation: land the live-session arc first, then implement this on a branch off `main`, updating `ruleRestDiscipline` and its fixtures as part of it. Changing the signature mid-arc would put a breaking edit into a file whose remaining tasks (6–8) still have to build and test against it.
