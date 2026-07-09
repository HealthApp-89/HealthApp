# Morning-Ladder Prescription Patches — Design

**Date:** 2026-07-09
**Status:** Approved
**Arc:** Adaptive-loop tightening, sub-project 2 of 2 (sub-project 1 — effort-aware engine + mid-week repatch — shipped as PR #143; this arc consumes its `repatch_log` machinery and `preserveDaysThrough` merge)

## Problem

The morning intake's reactive ladder ([lib/coach/activity/reactive-ladder.ts](../../../lib/coach/activity/reactive-ladder.ts)) grades soreness + fatigue + recent-activity into five rungs, but its graded rungs die at render time:

- `load_down` / `volume_down` produce only **cue text** on the brief ("Soreness in legs — drop weight ~10%…"). Nothing writes back to `training_weeks.session_prescriptions`, so the logger pre-fills the *unadjusted* numbers ([lib/logger/resolve-plan.ts](../../../lib/logger/resolve-plan.ts) reads `session_prescriptions[weekday]` directly and has zero cue awareness). The athlete answers soreness questions every morning and the numbers he lifts to never change.
- The cue prose also contradicts the engine's philosophy: it advises a ~10% **weight** drop, while the engine's lighten primitive (`lightenExercise`) deliberately never touches `baseKg` — volume and RIR are the evidence-based levers (see the comment at [prescribe-week.ts:119-124](../../../lib/coach/prescription/prescribe-week.ts)).
- The escalation rungs (`swap_exercise`, `swap_day`) already have a real action path (the confirm-based `BriefCoachSuggestion` chip → swap route) and are **not** changed by this arc.

Decision locked with the athlete: **auto-apply + revert chip** (no confirm gate — the intake answers are the consent; the engine already writes without asking on the same authority).

## Goals

- `load_down` / `volume_down` rungs write real, deterministic changes to **today's** `session_prescriptions` entry before the brief assembles — so brief, Carter's `<this_weeks_prescription>`, TodayPlanCard, and the logger all show the same adjusted numbers with no changes to those consumers.
- Every patch is logged (field-level diff) and revertible to exact pre-patch values.
- Later engine runs the same day must not clobber the patch (I1 groundwork).
- Cue text states what was done, not what the athlete should do.

## Non-goals (explicitly out of scope)

- Re-patching when the check-in is edited later in the day (patch fires once, at brief assembly).
- Any change to `swap_exercise` / `swap_day` handling (existing chip owns those).
- Sick-day handling (the recommendation route's sick guard already returns before the patch point).
- Weight (`baseKg`) reductions — volume + RIR only, per engine philosophy.
- Push notifications or chat cards for the patch (the brief session block is the surface).

## Design

### 1. Groundwork — I1 fast-follow (first task, independent commit)

The three remaining full-week `session_prescriptions` writers gain `preserveDaysThrough: todayIso` so days ≤ today keep stored state verbatim:

- `get_week_prescription` `persist: true` path ([lib/coach/tools.ts](../../../lib/coach/tools.ts) ~2262) — unconditional; provably safe for `week: 'next'` (boundary index < 0 → merge returns computed untouched).
- The swap route's prescription rewrite ([app/api/training-weeks/[week_start]/swap/route.ts](../../../app/api/training-weeks/[week_start]/swap/route.ts) ~264).
- [lib/training-weeks/apply-activity-layout.ts](../../../lib/training-weeks/apply-activity-layout.ts) ~95.

For the swap/layout writers there is one nuance: when the change **touches today's session type**, today's prescription must be recomputed for the new type, not preserved — but a swap that only affects other days must NOT recompute today (it would silently wipe a morning patch). Those two callers therefore compute the boundary conditionally: `preserveDaysThrough = (newPlan[today] !== oldPlan[today]) ? isoDaysAgo(todayIso, 1) : todayIso`. `get_week_prescription` (read-side persist) always uses `todayIso`. This is load-bearing beyond hygiene: it is what protects the morning patch from being silently undone by a later engine run.

Note: a swap or activity-layout apply that changes **today's** session type legitimately discards today's morning patch (new session type ⇒ new exercises); the `repatch_log` entry keeps the audit trail, and the revert chip hides because the patched exercise names no longer match (see §5).

### 2. Rung → transform mapping (new pure module)

New module `lib/coach/prescription/patch-today.ts`:

```
patchExercisesForRung(exercises: PlannedExercise[], rung: ReactiveRung,
                      sessionType: string, regions: MuscleRegion[]): PlannedExercise[]
```

- `load_down` → affected exercises (same region gating as `lightenExercise`: `exerciseRegion(name)` with session-level fallback; warmups and target-less rows untouched): **`rir: min(5, (ex.rir ?? 2) + 1)`, everything else held** — the gentlest touch.
- `volume_down` → delegate to the existing exported `lightenExercise(ex, sessionType, regions)` — tiered sets/reps cuts + RIR bumps, load held.
- `none`, `swap_exercise`, `swap_day` → return input unchanged (escalation rungs are the chip's job; numbers are not the remedy).

Pure and fixture-testable. The region-gating helper is shared with `lightenExercise` (export `exerciseRegion` from prescribe-week.ts rather than duplicating it).

### 3. Apply primitive + trigger

`applyMorningPatch({ supabase, userId, todayIso })` in the same module:

1. Load today's `checkins` row; compute the rung exactly as the brief does (`selectReactiveRung` with `sorenessAreasToRegions(soreness_areas)`, `soreness_severity`, `fatigue`, and the same `loadRecentActivityForBrief` recent-activity signal). Rung ∉ {load_down, volume_down} → return null.
2. Load the current week's `training_weeks` row (`mondayOfIso(todayIso)`). No row, no `session_prescriptions[today]`, or today is REST/Mobility → return null.
3. **Idempotency guard:** if `repatch_log` already contains an entry with `reason: "morning_checkin"` and `workout_date: todayIso` → return null (covers the `brief_failed` retry path).
4. Map today's stored exercises through `patchExercisesForRung`; diff old vs new with the existing `diffFutureDays` machinery restricted to today (a thin `diffDay` wrapper, or reuse the field-comparison helper directly). Empty diff → return null, write nothing.
5. Write the patched day back to `session_prescriptions` (single-day read-modify-write on the row) and append a `RepatchLogEntry` `{ at, reason: "morning_checkin", workout_date: todayIso, changes }`.

**Trigger:** in [app/api/chat/morning/recommendation/route.ts](../../../app/api/chat/morning/recommendation/route.ts), after the sick/idempotency/WHOOP gates and immediately **before** `buildMorningBriefStreaming` — so `composeSession` reads the patched prescriptions. Non-fatal try/catch (a patch failure must never block the brief); the brief degrades to cue-only, exactly today's behavior.

### 4. Revert

`POST /api/chat/morning/revert-patch` (session-auth):

1. Find today's `morning_checkin` entry in the current week's `repatch_log`; 404 if absent or already reverted.
2. Restore each `RepatchChange`'s `from` value onto today's `session_prescriptions` entry (field-level; exercises matched by name, first non-warmup row — same convention as the diff).
3. Append `{ reason: "morning_checkin_revert", workout_date: todayIso, changes: <inverse diff> }`.

Idempotent: a second call 404s (revert entry present). Apply → revert is an exact identity on the stored day (fixture-proven).

### 5. Athlete visibility

- **BriefSessionList** gains a small status row when today's `repatch_log` holds an unreverted `morning_checkin` entry: "Adjusted for soreness — Revert" (derived live from `useTrainingWeek`-style fetch of the week row, brief `ui` jsonb never rewritten — the same derivation pattern as the swap chip's acknowledged state). Tapping Revert calls the endpoint and invalidates the training-week query so numbers refresh in place. The row hides if the patched exercise names no longer match today's plan (day-type swap after the patch).
- **Cue text** ([lib/coach/session-structure/annotate.ts](../../../lib/coach/session-structure/annotate.ts) `sorenessAwareCue`): rewritten from advice to fact —
  - `load_down`: "Effort eased on {regions} today — weight unchanged."
  - `volume_down`: "Volume trimmed on {regions} today — soreness + fatigue."
  - `swap_exercise` / `swap_day` strings unchanged.
- **Carter** reads patched numbers automatically via `<this_weeks_prescription>`. One sentence added to the existing repatch bullet in CARTER_BASE: morning check-in answers may also adjust today's numbers; the stored row remains canonical.
- The post-workout debrief needs no change: `loadRepatchNotes` filters by `workout_date === workout date`, so the morning entry (same date) will surface as a "Plan updated for …" note automatically if the athlete trains that day. Verify in fixtures rather than adding code.

### 6. Error handling

- Patch and revert never throw into their callers (route-level try/catch; patch failure → cue-only brief).
- Malformed/absent `repatch_log` → treated as empty (same readers' convention as PR #143).
- Concurrent brief-retry double-fire is absorbed by the idempotency guard (step 3).

### 7. Testing & verification

House style — extend [scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs):

- `patchExercisesForRung` fixtures: load_down RIR bump (cap 5, per-exercise `ex.rir` respected), volume_down tier delegation, warmup/target-less untouched, non-affected region untouched, escalation rungs identity.
- Apply → revert identity on a fixture day.
- Idempotency: entry-present guard returns null.
- I1: merge behavior already fixture-covered in PR #143; add one assertion that `preserveDaysThrough: <yesterday>` recomputes today.
- `npm run typecheck`, `npx vitest run`, `npm run build`, and a live pass of `audit-sunday-prescription-e2e.mjs`.

## Invariants preserved

- `session_prescriptions` writers remain deterministic rule modules; Carter still never authors numbers. The upsert-seam header gains one line naming the morning patch as the third sanctioned writer (engine recompute, mid-week repatch, morning patch).
- `baseKg` untouched by every path in this arc.
- Sunday cron and next-week computation unchanged.
- Brief `ui` jsonb is never rewritten after delivery.
