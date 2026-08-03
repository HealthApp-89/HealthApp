# Debrief reads the stored prescription instead of re-deriving it

**Date:** 2026-08-03
**Status:** Draft for review
**Area:** `lib/coach/session-debrief/`

## Problem

`composePrescription` re-derives the next session's loads with its own rules instead of
reading what the prescription engine actually wrote. Its inputs disagree with the engine's in
three places, so the debrief card can display a weight the athlete will never be asked to lift.

### 1. "PR" is used as a proxy for "clean"

[compose-prescription.ts:93](../../../lib/coach/session-debrief/compose-prescription.ts):

```ts
lastWeekHitRirTargetCleanly: lift.tag === "PR", // PR tag = clean overshoot
```

`tag === "PR"` means *today's top-set e1RM beat the previous session's*. The engine's
`lastWeekClean` means *every working set hit the prescribed reps at the target RIR without
failing*. These are different questions and they disagree precisely when the athlete sets a
PR while grinding.

**Seven such sessions exist in this athlete's history** (top-set e1RM beat the prior session
AND the session contained a `failure` or `rir === 0` set):

```
2026-05-22  Triceps Pushdown        26.7 → 29.3
2026-06-17  Decline Bench Press     85.5 → 88.7
2026-06-17  Incline Bench Press     48.0 → 53.3
2026-06-17  Lateral Raise           16.4 → 21.3
2026-06-19  Lateral Raise           21.3 → 22.4
2026-07-07  Chest Fly               42.0 → 42.7
2026-07-14  Incline Bench Press     53.3 → 54.7
```

In each, the debrief would render *"take the +Xkg next session"* while the engine holds.
**PR #160 widened this gap**: `lastWeekClean` became stricter (all working sets must be
clean), so PR-with-failure now diverges deterministically rather than occasionally.

### 2. The load baseline differs

The composer passes `currentWorkingKg: lift.top_set_today.kg`. The engine uses
`maintenanceLoadFor` — the max kg across *clean* working sets over 28 days. A single heavy
grinding set today moves the composer's baseline and not the engine's.

### 3. `rirTarget` is a hardcoded placeholder

`rirTarget: 2, // placeholder; doesn't influence kg in this rule`. True for the current rule
body, but it is a hardcoded constant in a call whose sibling arguments were just corrected in
PR #161 to come from `training_weeks.rir_target`.

### Blast radius

The debrief's `weight_changes` is **display-only** — the stored plan is written by
`prescribeWeek` / `repatchRemainingWeek`, and this code never writes. So no wrong weight is
ever persisted. But a wrong weight can be *shown*, and the athlete plans around what he is
shown. That is worse than a wording defect, which is how it was previously characterised.

### Dead field

`prescription.next_session_date` is documented as *"populated by orchestrator from
training_weeks"*. Nothing has ever populated it, and nothing reads it. It is always `null`.

## Design

### Precedent

This is the same collapse already performed on the weekly review, recorded in CLAUDE.md:

> **Engine collapse (2026-06-06):** the weekly review's bespoke `compose-prescription.ts` was
> deleted in favour of reading the just-cron-written `training_weeks.session_prescriptions`
> row via `read-prescription.ts`. Same engine as Carter + Sunday cron, same numbers, one
> source of truth.

The debrief keeps its own copy. This spec removes it the same way.

### New module: `lib/coach/session-debrief/next-session-prescription.ts`

```ts
export type NextSessionPrescription = {
  /** ISO date of the next session of this type. */
  date: string;
  weekday: WeekdayLong;
  /** Non-warmup prescribed entries for that day. */
  exercises: PlannedExercise[];
  /** "row" when read from training_weeks.session_prescriptions, "inline"
   *  when prescribeWeek was called as the fallback. */
  source: "row" | "inline";
};

export async function readNextSessionPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
  /** Workout date — the search starts the day AFTER this. */
  afterIso: string;
  block: TrainingBlock | null;
  todayIso: string;
}): Promise<NextSessionPrescription | null>;
```

**Search:** walk forward one day at a time from `afterIso + 1` for at most **14 days**. For
each date, resolve its week via `mondayOfIso` and read that `training_weeks` row (cache per
week — at most two rows are ever touched). The first date whose
`session_plan[weekdayLong] === sessionType` wins.

**Two-tier read**, mirroring `read-prescription.ts`:

1. `session_prescriptions[weekdayLong]` present and non-empty → use it, `source: "row"`.
2. Otherwise call `prescribeWeek` for that week (read-only, no write) and take that
   weekday's entries → `source: "inline"`.

**Returns `null`** when no matching weekday is found within 14 days — the session type was
dropped from the plan. Callers must handle null; they must NOT fall back to a bespoke rule.

**Warmup entries are filtered out** of `exercises`. Warmup ramps are separate entries sharing
the working entry's name (the trap fixed in PR #161); including them would reintroduce
`0 kg`-class noise.

### `composePrescription` stops computing loads

New input field `nextSession: NextSessionPrescription | null`. For each lift the athlete
performed today, find the matching non-warmup prescribed entry by
`name.trim().toLowerCase()`. When found:

```ts
if (prescribed.baseKg == null) continue; // bodyweight / unloaded — nothing to report
weight_changes.push({ exercise: lift.name, new_kg: prescribed.baseKg, rationale });
```

No arithmetic. The number is whatever the engine stored.

**`baseKg == null` must skip the lift, never coerce to `0`.** Bodyweight entries (Push Up,
Back Extension, Reverse Crunch) legitimately carry no load, and a `?? 0` fallback would
reintroduce the `→ 0kg — Hold 0 kg` rows that PR #161 removed. The same applies to a lift
present in today's session but absent from the prescription: skip it, do not emit a zero.

`next_session_date` becomes `nextSession?.date ?? null` — the field stops lying.

When `nextSession` is `null`, `weight_changes` is empty and `notes` gains
`"Next <sessionType> session isn't planned yet — no load changes to report."`

**Rationale prose is preserved.** `evaluateBlockPhase` is still called for the block's focus
lift, so the consolidation / off_pace / deload_week / pre_target framing survives verbatim —
it now narrates the stored number instead of one it derived. For non-focus lifts the
rationale compares today's top set against the prescribed load (stepped up / holding /
dropped).

### Deleted

- `lastWeekHitRirTargetCleanly: lift.tag === "PR"` and the whole `prescribePrimaryFromPhase`
  call (plus its import).
- The naive `+step` / `−step` / hold branches keyed off `lift.tag`.
- `PRIMARY_LIFT_NAME_PATTERNS` and `liftFromExerciseName` **only if** they fall unused after
  the focus-lift detection is rewritten; the focus-lift check is still needed for rationale
  selection, so expect them to survive.

`weeksLeft` stays — the off_pace rationale uses it.

## Goals

1. Every weight the debrief displays is the weight the plan actually contains.
2. No second implementation of load progression exists in the codebase.
3. `next_session_date` is either correct or absent, never a lie.

## Non-goals

- Showing exercises that are in the next session but were not performed today. That changes
  what the card is for and is a separate decision.
- Changing `prescribeWeek`, the volume rules, or anything PR #159/#160/#161 touched.
- Changing `compose-lifts`'s `tag` computation — `tag` remains correct and useful for the
  PR / stall / regression narrative; it simply stops being misused as a cleanliness proxy.
- Persisting anything. This path stays read-only.

## Testing

- **New unit suite** `lib/coach/session-debrief/__tests__/next-session-prescription.test.ts`
  against a stubbed Supabase client: finds the next matching weekday in the current week;
  crosses into next week when the current week has no later match; returns `source: "row"`
  when the stored prescription exists; returns `null` when no matching weekday appears within
  14 days; **filters warmup entries out of `exercises`**.
- **Audit assertions** in `scripts/audit-prescription-rules.mjs`: given a `nextSession`, every
  emitted `new_kg` equals the corresponding `prescribed.baseKg`; **no** `weight_changes` entry
  is produced for a lift absent from the prescription; **no** entry is produced for a
  prescribed entry whose `baseKg` is null (bodyweight), and in particular no entry with
  `new_kg === 0`; a `null` `nextSession` yields empty `weight_changes` plus the "isn't planned
  yet" note.
- **Regression fixture** for the exact defect: a lift whose `tag === "PR"` but whose session
  contained a failure set must report the STORED load, not `today + step`.
- **End-to-end** (vitest, live data — the orchestrator cannot load in a plain node script
  because `getUserTimezone` → `lib/supabase/server` → `next/headers`): every
  `weight_changes[].new_kg` equals the stored `session_prescriptions` value for the resolved
  next session, and `next_session_date` is non-null.
- **Verification gate:** `npm run typecheck`, `npx vitest run`,
  `scripts/audit-prescription-rules.mjs`, `scripts/audit-workout-debrief.mjs`, `npm run build`.

## Risks

- **Two extra queries per debrief** (at most two `training_weeks` rows). Negligible; the
  debrief already issues several and makes an Anthropic call.
- **The inline fallback runs `prescribeWeek`**, which is heavier than a row read. It fires
  only when the next session's week has no stored prescription — the same condition under
  which the weekly review already pays this cost.
- **Displayed weights will change** for any lift where the old proxy disagreed with the
  engine. That is the correction, but it is visible: a card that previously said "take the
  +2.5 kg" may now say "hold". Historical debriefs are not rewritten.

## Follow-ups (not in scope)

- Three exercises fail the e2e on-grid check (Rear Delt Fly 29.3 kg, Hip Abductor 61 kg,
  Chest Fly 32 kg) — realized machine pin weights vs declared library steps. Pre-existing
  across all four of today's arcs and worth its own fix: the engine is prescribing loads the
  machines cannot be set to.
