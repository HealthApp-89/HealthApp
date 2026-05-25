# Edit a saved logged workout — design

**Date:** 2026-05-25
**Status:** spec
**Author:** Abdelouahed (with Claude)

## Problem

The in-app workout logger ([components/logger/LoggerSheet.tsx](../../../components/logger/LoggerSheet.tsx)) writes a saved session via `commit_logger_session` and closes. After save, there is no way to fix a typo in kg/reps, add a missed set, or remove a junk set. The only options today are "edit the row in Supabase" or "live with the bad data." This breaks the entire reason for adopting in-app logging over Strong CSV.

## Goal

Let the user reopen any logger-sourced workout, modify exercises and sets (add / remove / edit kg / reps / failure / warmup), and save the corrections. Same UI as creation. No new editing surface to maintain.

Out of scope (deferred — call out only):
- Deleting an entire workout (separate "remove a session" affordance).
- Editing Strong-CSV-imported workouts (`source='strong'`). The logger's commit payload shape is wrong for those; they stay read-only.
- Editing a workout's `date` (would muddle adherence reads on `training_weeks`).

## Architecture insight

`commit_logger_session(payload jsonb)` ([supabase/migrations/0026_workout_logger.sql:59](../../../supabase/migrations/0026_workout_logger.sql)) is already edit-safe:

```sql
insert into workouts (...) on conflict (user_id, external_id) where external_id is not null do update
  set type = excluded.type, duration_min = excluded.duration_min
returning id into new_workout_id;

delete from exercises where workout_id = new_workout_id;  -- wipe then re-insert
```

Re-POST'ing `/api/logger/session` with the same `external_id` upserts the workout row and atomically replaces all child exercises and sets. So editing is just:

1. Fetch the saved workout
2. Rehydrate into a `LoggerDraft` (reusing the original `external_id`)
3. Open `LoggerSheet` in "edit mode"
4. POST the same payload on save

**No migration. No RPC change.**

## Approach (selected)

**Reopen the saved session in `LoggerSheet`.** One UI for create + edit; backend already handles the round-trip.

Alternatives rejected:
- *Inline cell editor in `SessionTable`* — second editing surface to maintain, can't add exercises/sets, bypasses voice/rest-timer parity.
- *Bare quick-edit modal* — same issue; yet-another-UI, diverges from logger affordances.

## Entry points

Two surfaces share one `EditSessionButton` component:

1. **`SessionTable`** ([components/strength/SessionTable.tsx](../../../components/strength/SessionTable.tsx)) — appears in `/strength?tab=date` and `/strength?tab=by_muscle`. The button sits in the session header next to the type pill. This is the post-save canonical "look back at my workouts" surface.

2. **`/coach/sessions/[workout_id]`** debrief page — header-level button so the user can fix numbers Carter is currently debriefing.

Both entry points are eligibility-gated: only `source='logger'` workouts (i.e. `external_id LIKE 'logger-%'`) show the button. Strong-CSV and legacy workouts hide it.

`FinishSummary` is NOT an entry point — it's the pre-save modal, not post-save. Users land back on whatever page launched the sheet after save (already a SessionTable consumer).

## Data flow

```
[SessionTable | debrief page]
        │
        ▼  (click Edit)
EditSessionButton
        │
        ▼  fetchWorkoutForEdit(workout_id)
{ workout, exercises[], sets[] }
        │
        ▼  hydrateWorkoutAsDraft(...)
LoggerDraft (with original external_id)
        │
        ▼
LoggerSheet (editMode={ initialDraft })
        │
        ▼  user modifies
        │
        ▼  Finish → commit
POST /api/logger/session (same external_id)
        │
        ▼
commit_logger_session RPC upserts → revalidatePath('/strength', '/', '/coach')
        │
        ▼  if a workout_debrief chat row exists for this workout_id:
        │     re-trigger debrief generator
        │
LoggerSheet closes → user back on launching page → SessionTable reflects edit
```

## Components and files

### New

- **[lib/logger/hydrate-from-workout.ts](../../../lib/logger/hydrate-from-workout.ts)** (new)
  `hydrateWorkoutAsDraft({ workout, exercises, sets, resolvedPlan }) → LoggerDraft`. Pure function. Maps DB rows to `LoggerDraft` ([lib/logger/types.ts](../../../lib/logger/types.ts)) preserving `external_id`, `set_index`, `kg`, `reps`, `warmup`, `failure`, `rest_seconds_actual`, `duration_seconds`. All sets get `committed_at = workout.created_at` (they're already committed). `paused_at: null`, `paused_ms_total: 0`. `prescribed` per exercise resolves from `lib/coach/sessionPlans` for the session type when name matches; falls back to a bare PlannedExercise with the exercise name when no plan entry exists.

- **[lib/data/fetch-workout-for-edit.ts](../../../lib/data/fetch-workout-for-edit.ts)** (new)
  Server + browser dual fetcher (mirrors the [client-cache pattern](../specs/2026-05-07-client-cache-refactor-design.md)). Returns `{ workout: { id, user_id, date, type, duration_min, external_id, source, created_at }, exercises: [{ id, name, position, sets: [...] }] }` where each set carries every column the rehydration needs (`set_index, kg, reps, warmup, failure, rest_seconds_actual, duration_seconds`). Throws on supabase error. Distinct from `WORKOUT_QUERY_COLS` ([lib/data/workouts.ts](../../../lib/data/workouts.ts)) which is missing `external_id`/`rest_seconds_actual`/`created_at`; widening that shared query would touch every `WorkoutSession` consumer — out of scope.

- **[components/logger/EditSessionButton.tsx](../../../components/logger/EditSessionButton.tsx)** (new)
  Client component. Props: `{ workoutId: string, eligible: boolean }`. If `!eligible`, renders nothing. On click: fetches via `fetchWorkoutForEditBrowser`, calls `hydrateWorkoutAsDraft`, opens a `LoggerSheet` instance with `editMode={{ initialDraft }}`. Owns the sheet's open/close state.

### Modified

- **[components/logger/LoggerSheet.tsx](../../../components/logger/LoggerSheet.tsx)**
  Add prop `editMode?: { initialDraft: LoggerDraft }`. When set:
  - Skip the `resolve-plan` + `create-fresh-draft` path; seed state from `initialDraft`.
  - Skip the `ResumeDraftPrompt` flow (we're hydrating from DB, not a stale IndexedDB draft).
  - Skip `draftStore` writes (no checkpointing during edit — YAGNI; if user bails mid-edit, the original session is intact).
  - Header reads "Edit session" + date string (read-only). The date pill in normal mode stays the same.
  - The Finish-summary "Finish & save" button reads "Save changes".
  - Rest-timer doesn't auto-arm; existing `rest_seconds_actual` values are preserved on the wire; new sets added during edit emit `rest_seconds_actual: null`.

- **[components/strength/SessionTable.tsx](../../../components/strength/SessionTable.tsx)**
  Mount `<EditSessionButton workoutId={session.id} eligible={isLoggerSourced(session)} />` in the session header next to the type pill. Eligibility helper: `isLoggerSourced(session) = session.external_id?.startsWith('logger-')`. The existing `WORKOUT_QUERY_COLS` does NOT select `external_id` or `source`, so we extend the query string and the `RawWorkoutRow` / `WorkoutSession` types with `external_id: string | null` and `source: string | null`. This is the one shared-shape change.

- **[app/coach/sessions/[workout_id]/page.tsx](../../../app/coach/sessions/[workout_id]/page.tsx)**
  Server-side, fetch the workout's `external_id` and `source`. Pass eligibility down. Render `<EditSessionButton>` in the page header.

- **[lib/logger/commit-session.ts](../../../lib/logger/commit-session.ts)**
  After the successful RPC call, look up `chat_messages` for any row with `kind='workout_debrief'` and `ui->>'workout_id' = <new_workout_id>`. If found, re-trigger debrief generation. Failure to regenerate must NOT fail the save — log and continue; the user explicitly saved correct numbers, that is the primary success.

- **[lib/coach/workout-debrief/generate.ts](../../../lib/coach/workout-debrief/generate.ts)** (extract)
  Move the generator body out of `app/api/coach/workout-debrief/route.ts` into a shared `generateWorkoutDebrief(userId, workoutId)` helper. The route handler becomes a thin wrapper; `commit-session.ts` calls the same helper on edit. Single implementation across cron / manual re-trigger / edit-regenerate paths. (If the helper already exists in this shape, skip this step — the implementation plan should verify.)

## Edge cases

- **External_id mismatch on edit-mode commit.** `hydrateWorkoutAsDraft` preserves the DB's `external_id`. The RPC upserts on `(user_id, external_id)`. Race: if the user has two tabs open and saves a fresh session in tab B while tab A is editing — the fresh session would use a new `external_id` (different UUID), so no collision. Edit save in tab A still targets the correct row.

- **Session type changed during edit.** Allowed. The `on conflict` clause sets `type = excluded.type`. `compute_adherence` reads `coalesce(original_session_plan, session_plan)` — type change does not corrupt the Sunday-commitment record. The debrief regenerates against the new type.

- **All sets deleted during edit.** Empty `exercises[].sets[]` arrays are valid per the RPC (it loops over whatever's there). User would land with an empty workout row. Acceptable; if they want to remove the whole workout, that's the deferred "delete" affordance.

- **Workout from another day.** Date is read-only in edit mode (passed through unchanged in the payload). No risk of cross-day adherence drift.

- **`rest_seconds_actual` for newly-added sets.** Null. Acceptable — the user is editing past data, no real rest timer was running.

- **`workout_debrief` doesn't exist yet.** The 2-table lookup returns no row; skip regeneration. Common case for very fresh saves where the cron hasn't run.

## What we are not changing

- No migration.
- No `commit_logger_session` RPC change.
- No change to `/api/logger/session` route shape — it's already accepting the upsert.
- No change to draft IndexedDB store ([lib/logger/draft-store.ts](../../../lib/logger/draft-store.ts)) — edit mode bypasses it.
- No change to `compute_adherence`, `daily_logs`, `training_weeks`. The upserted workout row is read by all of them post-edit with no special handling.
- No new test infrastructure (project has no test suite per CLAUDE.md).

## Verification

Manual:
- Log a fresh session via `LoggerSheet`. Save. Confirm it appears in `/strength?tab=date`.
- Click Edit. LoggerSheet opens with the saved data hydrated (all sets show as committed ✓, exercises in original order).
- Change one set's reps. Save. Confirm SessionTable reflects the change. Confirm `workouts` row count did NOT increase (it's the same row, upserted).
- Run `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-logger-write-path.mjs` and confirm parity between `exercise_sets` and the edited UI.
- Trigger a workout_debrief for the workout (or wait for the cron). Edit a set's kg. Save. Confirm a fresh debrief replaces the stale one.
- Open a Strong-CSV-sourced workout in `/strength?tab=date`. Confirm no Edit button shows.

Typecheck: `npm run typecheck`.

## Migration notes

None. Pure code change.
