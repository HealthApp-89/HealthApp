# Post-workout debrief: block truth, warmup rows, and volume coherence

**Date:** 2026-08-03
**Status:** Draft for review
**Area:** `lib/query/fetchers/blockProgress.ts`, `lib/coach/session-debrief/`

## Problem

The 2026-08-03 post-workout debrief contained five defects. Two share a root cause.

### 1. The coach scolded the athlete for following the prescription

The debrief narrative read:

> *"you left **2 in reserve against a 1-RIR target** … There's no physiological excuse for
> backing off effort."*

The athlete hit RIR 2 because RIR 2 is what was prescribed. Two sources disagree:

| Source | Value | Used by |
| --- | --- | --- |
| `training_weeks.rir_target` (`null`) → `?? 2` | **2** | `prescribeWeek`, the logger, the athlete |
| `RIR_BY_WEEK[4]` in `blockProgress.ts` | **1** | the debrief payload's `block.rir_target` |

This is the most damaging defect: it tells the athlete to push harder when he complied, which
drives exactly the train-to-failure pattern that PR #159 and PR #160 were written to correct.

### 2. Block length is hardcoded to 5 weeks

[blockProgress.ts](../../../lib/query/fetchers/blockProgress.ts) declares:

```ts
total_weeks: 5;                                                    // literal TYPE, not a value
const RIR_BY_WEEK   = { 1: 4, 2: 3, 3: 2, 4: 1, 5: null };
const PHASE_BY_WEEK = { 1: "accumulate", …, 5: "deload" };
const currentWeek   = Math.min(5, Math.max(1, weeksElapsed + 1));  // CLAMPED
```

The active block runs `2026-07-13 → 2026-09-06` — **8 weeks**. The prescription engine derives
length from those dates (`totalBlockWeeks` in `block-phase-rule.ts`); this fetcher asserts 5.
Consequences:

- The debrief said "Week 4 of 5" and "with one week left". Four weeks remain.
- `currentWeek` is clamped to 5, so weeks 6, 7 and 8 will all report as **"Week 5 of 5"**.
- `RIR_BY_WEEK` and `PHASE_BY_WEEK` have no entries above 5 — weeks 6-8 yield `undefined`.

`blockProgress.ts` also feeds the `/strength` Block card, so the wrongness is not confined to
the debrief.

### 3. Warmup rows become phantom prescriptions

```
Squat (Barbell) → 0kg — Hold 0 kg
Squat (Barbell) → 0kg — Hold 0 kg
Squat (Barbell) → 80kg — Hold 80 kg
```

[index.ts](../../../lib/coach/session-debrief/index.ts) builds `todayExercises` with
`exs.map(...)` — one entry per exercise **row**. Warmup ramp entries are stored as separate
`exercises` rows sharing the working entry's name, so each becomes its own "lift". `topSet`
correctly returns `null` for a warmup-only row, and that null flows through
`composePrescription` into `Hold 0 kg`.

Same class of bug as the discovery dedup fixed in PR #159; the debrief never got that fix.

### 4. Volume advice contradicts the engine

The narrative said *"Add sets on the curl and calf raise to at least clear MEV."*

PR #159's adherence gate deliberately **withheld** the Calves set bump and wrote a
`VolumeFrequencySignal` to `training_weeks.volume_signals` whose instruction to Carter is:
recommend a second weekly exposure, never more sets in the existing session — that lever
already failed and was not performed. The debrief has its own `below_mev` note logic and does
not read `volume_signals`, so the two surfaces now say opposite things.

### 5. The most important line is buried

`Plan updated for Tuesday: Overhead Press (Barbell) 30 → 25 kg` — a 17% cut on a main lift —
renders as muted grey text below a "check session adherence" nag, because repatch notes and
volume notes share one `prescription.notes: string[]`.

## Design

### A. `blockProgress.ts` becomes a derived view — fixes #1 and #2

Delete `RIR_BY_WEEK`, `PHASE_BY_WEEK`, the `total_weeks: 5` literal, and the `Math.min(5, …)`
clamp. Derive instead:

| Field | After |
| --- | --- |
| `total_weeks: number` | `totalBlockWeeks(block)` |
| `current_week` | `currentBlockWeek(block, today)` — no clamp |
| `rir_target` | current week's `training_weeks.rir_target`, `?? 2` |
| `research_phase` | `evaluateBlockPhase(...) === "deload_week" ? "deload" : "accumulate"` |

`currentBlockWeek` and `totalBlockWeeks` are currently private in
[block-phase-rule.ts](../../../lib/coach/prescription/block-phase-rule.ts). **Export them**
rather than duplicating the arithmetic — a second copy is how this divergence started.

`?? 2` is the exact expression `prescribeWeek` uses (`week.rir_target ?? 2`), so the debrief
and the engine cannot disagree again.

`evaluateBlockPhase` needs `currentWorkingKg` and `recentProgressionRatePerWeek` for its
off-pace branch. The debrief only needs the deload discriminator, and `deload_week` is decided
purely by `week >= totalBlockWeeks(block)` before any of that is read — so pass `null` for both
and the phase resolves correctly (`target_hit_at_week` set → `consolidation`, which maps to
`"accumulate"`; otherwise `pre_target` → `"accumulate"`). Do not fabricate values to satisfy
the signature.

**Extract the derivation as a pure function** so it is testable without stubbing the schema.
`computeBlockProgress` performs several unrelated queries (`rolling4wE1rmMean`, body-comp
lookups, adherence counts); the four fields above depend on none of them:

```ts
export type BlockCalendar = {
  current_week: number;
  total_weeks: number;
  research_phase: "accumulate" | "deload";
  rir_target: number;
};

/** Pure. `weekRirTarget` is training_weeks.rir_target for the current week
 *  (null when unset or no row). */
export function deriveBlockCalendar(
  block: TrainingBlock,
  weekRirTarget: number | null,
  todayIso: string,
): BlockCalendar;
```

`computeBlockProgress` fetches the current week's `rir_target` and calls this. All four
previously-wrong fields live in one pure, directly-testable function.

**Accepted behavioural change:** the periodised 4→3→2→1 RIR ramp disappears as an independent
concept. Until something writes `training_weeks.rir_target` per week, every week resolves to
RIR 2. Carter can still set it via `propose_week_plan`. One honoured source of truth beats a
ladder no other surface respected.

`BlockProgressPayload.total_weeks` widens from the literal `5` to `number`. `StrengthCoachClient`
only displays the value, so this is expected to be safe; typecheck is the check.

### B. Merge same-name exercise rows — fixes #3

In `session-debrief/index.ts`, group `exs` by `name.trim().toLowerCase()`, concatenating each
row's sets, then **drop any group with zero non-warmup sets**. One entry per exercise, not per
row.

Volume counts are unaffected: `compose-volume` already counts `!s.warmup` sets, and a
warmup-only row contributes zero either way.

### C. Debrief reads `volume_signals` — fixes #4

Load `training_weeks.volume_signals` for the current week in `session-debrief/index.ts` and
pass it into `composePrescription`.

`WorkoutDebriefPayload.prescription` gains:

```ts
/** Muscles whose set bump the engine withheld for non-adherence (migration
 *  0054). The fix for these is a second weekly exposure, never more sets. */
volume_signals?: Array<{ muscle: string; weekly_sets: number; mev: number; weekly_exposures: number }>;
```

Note rewrite: for a `below_mev` muscle that carries a signal, emit
`"<Muscle> below MEV at <n> session(s)/week — a second exposure is the fix, not more sets"`
instead of the generic "check session adherence". Muscles below MEV **without** a signal keep
the existing note.

### D. Split plan changes out of notes — fixes #5

`WorkoutDebriefPayload.prescription` gains:

```ts
/** Mid-week repatch entries ("Plan updated for <weekday>: …"). Split out of
 *  `notes` so the UI can surface a real load change above advisory text. */
plan_changes?: string[];
```

`composePrescription` routes any note starting with `"Plan updated for "` here instead of into
`notes`. [SessionDebriefView.tsx](../../../components/coach/SessionDebriefView.tsx) renders
`plan_changes` as a distinct emphasised block above the muted `notes` list.
`tldrFromPayload` currently derives its `↻ Plan updated` line by filtering `notes` for that
prefix — it must read `plan_changes` instead, with a `?? []` fallback.

### E. Narrative prompt guardrails

Add three rules to [narrative-prompt.ts](../../../lib/coach/session-debrief/narrative-prompt.ts):

1. The RIR target is `block.rir_target` in the payload. Never infer it from week number, and
   never characterise the athlete as under-performing when the logged RIR met that target.
2. Never state a block length or "weeks remaining" other than what `block.week_num` /
   `block.total_weeks` give. If either is null, omit block framing entirely.
3. For any muscle in `prescription.volume_signals`, never recommend adding sets. The
   prescribed remedy is a second weekly exposure.

### Back-compat

`WorkoutDebriefPayload` gains only optional fields; stored debrief rows predate them, so every
reader uses `?? []`. `chat_messages.ui` is jsonb — **no migration required**.

## Goals

1. The debrief's block week, block length, phase, and RIR target agree with the prescription engine.
2. No prescription line references a warmup-only row or a 0 kg load.
3. The debrief never recommends a remedy the engine has already withheld.

## Non-goals

- Reinstating a periodised RIR ladder in any form (see accepted behavioural change in A).
- Changing `prescribeWeek`, the volume rules, or migration 0054.
- Redesigning the debrief card beyond splitting `plan_changes` out of `notes`.
- `compose-prescription.ts`'s `lift.tag === "PR"` cleanliness proxy — a known open follow-up
  from PR #160, unrelated to these five defects.

## Testing

- **New unit suite** `lib/query/fetchers/__tests__/blockProgress.test.ts`, covering the pure
  `deriveBlockCalendar` (no Supabase stub needed): `total_weeks` derived from dates (the real
  `2026-07-13 → 2026-09-06` block → **8**, not 5); `current_week` unclamped (week 7 of an
  8-week block → **7**, not 5); `research_phase` is `"deload"` only on the final week and
  `"accumulate"` before it; `rir_target` returns the week row's value when set and **2** when
  null — the same fallback `prescribeWeek` uses.
- **New unit suite** `lib/coach/session-debrief/__tests__/merge-exercise-rows.test.ts`: three
  same-name rows (2 warmup + 1 working) collapse to one entry with 3 working sets; a
  warmup-only exercise is dropped entirely; distinct exercises are not merged.
- **Extend** the prescription-composer coverage in `scripts/audit-prescription-rules.mjs`: a
  below-MEV muscle **with** a signal produces the frequency-framed note and **no** "add sets"
  phrasing; without a signal it keeps the existing note; `plan_changes` receives
  `"Plan updated for …"` entries and `notes` does not.
- **Regression fixture:** the exact 2026-08-03 debrief inputs must produce a payload with
  `block.total_weeks === 8`, `block.rir_target === 2`, exactly one `Squat (Barbell)` entry in
  `weight_changes`, and no entry with `baseKg === 0`.
- **Verification gate:** `npm run typecheck`, `npx vitest run`,
  `scripts/audit-prescription-rules.mjs`, `scripts/audit-workout-debrief.mjs`.
- **Manual:** regenerate the 2026-08-03 debrief and confirm the narrative no longer claims a
  1-RIR target, no longer says "week 4 of 5", and no longer recommends adding calf sets.

## Risks

- **`/strength` Block card changes with the fetcher.** It shares `computeBlockProgress`, so the
  displayed week count and RIR move there too. That is the intended correction, but it is a
  second visible surface — check it after the change rather than assuming the debrief is the
  only consumer.
- **Every week now reports RIR 2** until `training_weeks.rir_target` is populated. Intended,
  but it will read as "the RIR ramp disappeared" if not expected.
- **Historical debriefs keep their wrong numbers.** Stored payloads are not rewritten; only
  newly generated debriefs are correct. Acceptable — they are a historical record of what the
  coach said.

## Follow-ups (not in scope)

- Nothing writes `training_weeks.rir_target` automatically. If a periodised ramp is wanted
  again, it belongs in the Sunday prescription cron writing a real value per week, not in a
  read-side fetcher inventing one.
- Three exercises fail the e2e on-grid check (Rear Delt Fly 29.3 kg, Hip Abductor 61 kg,
  Chest Fly 32 kg) — realized machine pin weights vs declared library steps. Pre-existing.
