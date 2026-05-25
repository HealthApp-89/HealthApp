# Edit Logged Workout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reopen any logger-sourced workout in `LoggerSheet`, modify exercises and sets, and save the corrections via the existing upsert path.

**Architecture:** `commit_logger_session` already upserts on `(user_id, external_id)`. So editing = fetch saved workout → hydrate into `LoggerDraft` (reusing the original `external_id`) → open `LoggerSheet` in `editMode` → save fires the same `/api/logger/session` POST. Debrief regenerates via a `force` flag on the existing debrief route.

**Tech Stack:** Next 15 App Router, Supabase, TanStack Query, Tailwind v4. No test suite — verification is `npm run typecheck` + manual browser exercise (see [CLAUDE.md](../../../CLAUDE.md)).

**Spec:** [docs/superpowers/specs/2026-05-25-edit-logged-workout-design.md](../specs/2026-05-25-edit-logged-workout-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/logger/hydrate-from-workout.ts` | create | Pure `hydrateWorkoutAsDraft(...)` mapping DB rows → `LoggerDraft` |
| `lib/data/fetch-workout-for-edit.ts` | create | Server + browser dual fetcher; returns workout row + exercises + sets with every column rehydration needs |
| `components/logger/EditSessionButton.tsx` | create | Client component: fetch → hydrate → open `LoggerSheet` with `editMode` |
| `components/logger/LoggerSheet.tsx` | modify | Add `editMode?: { initialDraft }` prop; bypass mount-effect, draft-store writes, ResumeDraftPrompt; relabel header + Save button; pass `force: true` on debrief POST |
| `components/strength/SessionTable.tsx` | modify | Mount `<EditSessionButton>` in session header (eligibility-gated on `source==='logger'`) |
| `lib/data/workouts.ts` | modify | Extend `WORKOUT_QUERY_COLS`, `RawWorkoutRow`, `WorkoutSession`, `processRawWorkouts` to carry `source` (one new column) |
| `app/coach/sessions/[workout_id]/page.tsx` | modify | Fetch `source`, mount `<EditSessionButton>` in page header |
| `app/api/coach/workout-debrief/route.ts` | modify | Accept `force?: boolean`; when true, delete existing chat row before regenerating |

No migration. No RPC change.

---

## Task 1: Extend `workouts` shared types with `source`

**Files:**
- Modify: `lib/data/workouts.ts`

The `SessionTable` button needs to gate on `source === 'logger'`. The shared query string + types must carry `source`. This is the only shape change that ripples through existing consumers; it's additive (new column) so consumers tolerate it.

- [ ] **Step 1: Add `source` to `WorkoutSession`, `RawWorkoutRow`, and `WORKOUT_QUERY_COLS`**

In `lib/data/workouts.ts`:

```ts
// Extend WorkoutSession (add line near `duration_min`):
export type WorkoutSession = {
  id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  source: string | null;
  exercises: WorkoutExercise[];
  vol: number;
  bwReps: number;
  sets: number;
};
```

```ts
// Extend the query string:
export const WORKOUT_QUERY_COLS =
  "id, date, type, duration_min, source, exercises(name, position, exercise_sets(kg, reps, duration_seconds, warmup, failure, set_index))";
```

```ts
// Extend RawWorkoutRow:
export type RawWorkoutRow = {
  id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  source: string | null;
  exercises:
    | { name: string; position: number | null; exercise_sets: { /* unchanged */ }[] }[]
    | null;
};
```

In `processRawWorkouts`, when building each session in pass 2, add `source: w.source` to the object literal that pushes into `sessions`. Locate the existing `sessions.push({ id, date, type, duration_min, exercises, vol, bwReps, sets: setsCount })` and add `source: w.source` before `exercises`.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumer needs to read `source` yet; column is additive).

- [ ] **Step 3: Commit**

```bash
git add lib/data/workouts.ts
git commit -m "feat(workouts): carry source on WorkoutSession for edit eligibility"
```

---

## Task 2: Create `fetchWorkoutForEdit` dual fetcher

**Files:**
- Create: `lib/data/fetch-workout-for-edit.ts`

A dedicated fetcher returning every column the rehydration needs (`external_id`, `created_at`, per-set `rest_seconds_actual`, etc.) — distinct from `WORKOUT_QUERY_COLS` which is missing several of those.

- [ ] **Step 1: Create the dual fetcher**

Create `lib/data/fetch-workout-for-edit.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type WorkoutForEditSet = {
  set_index: number;
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
  rest_seconds_actual: number | null;
};

export type WorkoutForEditExercise = {
  id: string;
  name: string;
  position: number;
  sets: WorkoutForEditSet[];
};

export type WorkoutForEdit = {
  id: string;
  user_id: string;
  date: string;
  type: string;
  duration_min: number | null;
  external_id: string;
  source: string;
  created_at: string;
  exercises: WorkoutForEditExercise[];
};

const QUERY_COLS =
  "id, user_id, date, type, duration_min, external_id, source, created_at, exercises(id, name, position, exercise_sets(set_index, kg, reps, duration_seconds, warmup, failure, rest_seconds_actual))";

type RawSet = WorkoutForEditSet;
type RawExercise = { id: string; name: string; position: number | null; exercise_sets: RawSet[] | null };
type RawRow = Omit<WorkoutForEdit, "exercises"> & { exercises: RawExercise[] | null };

function shape(row: RawRow): WorkoutForEdit {
  return {
    ...row,
    exercises: (row.exercises ?? [])
      .map((e) => ({
        id: e.id,
        name: e.name,
        position: e.position ?? 0,
        sets: [...(e.exercise_sets ?? [])].sort((a, b) => a.set_index - b.set_index),
      }))
      .sort((a, b) => a.position - b.position),
  };
}

export async function fetchWorkoutForEditServer(
  supabase: SupabaseClient,
  workoutId: string,
): Promise<WorkoutForEdit | null> {
  const { data, error } = await supabase
    .from("workouts")
    .select(QUERY_COLS)
    .eq("id", workoutId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return shape(data as unknown as RawRow);
}

export async function fetchWorkoutForEditBrowser(
  workoutId: string,
): Promise<WorkoutForEdit | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("workouts")
    .select(QUERY_COLS)
    .eq("id", workoutId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return shape(data as unknown as RawRow);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/data/fetch-workout-for-edit.ts
git commit -m "feat(workouts): add fetchWorkoutForEdit dual fetcher"
```

---

## Task 3: Create `hydrateWorkoutAsDraft` pure helper

**Files:**
- Create: `lib/logger/hydrate-from-workout.ts`

Pure function: `WorkoutForEdit + resolvedPlan → LoggerDraft` with the original `external_id` preserved and every set marked `committed_at = workout.created_at`.

- [ ] **Step 1: Create the hydrator**

Create `lib/logger/hydrate-from-workout.ts`:

```ts
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type {
  LoggerDraft,
  ExerciseDraft,
  ExerciseSetDraft,
} from "@/lib/logger/types";
import type { WorkoutForEdit } from "@/lib/data/fetch-workout-for-edit";

/**
 * Map a saved logger workout back into a LoggerDraft so LoggerSheet can edit
 * it. The DB workout's external_id is preserved — re-committing upserts the
 * same workouts row (see commit_logger_session RPC).
 *
 * `prescribed` per exercise: look up by name in resolvedPlan; fall back to a
 * bare PlannedExercise with the saved set count.
 */
export function hydrateWorkoutAsDraft(
  workout: WorkoutForEdit,
  resolvedPlan: PlannedExercise[],
): LoggerDraft {
  const committedAt = workout.created_at;
  const nowIso = new Date().toISOString();

  const exercises: ExerciseDraft[] = workout.exercises.map((e, i) => {
    const fromPlan = resolvedPlan.find((p) => p.name === e.name);
    const prescribed: PlannedExercise = fromPlan ?? {
      name: e.name,
      sets: e.sets.length,
      baseReps: e.sets[0]?.reps ?? 10,
    };
    const sets: ExerciseSetDraft[] = e.sets.map((s) => ({
      set_index: s.set_index,
      kg: s.kg,
      reps: s.reps,
      warmup: s.warmup,
      failure: s.failure,
      committed_at: committedAt,
    }));
    return { name: e.name, position: i, prescribed, sets };
  });

  return {
    user_id: workout.user_id,
    session_type: workout.type,
    date: workout.date,
    started_at: nowIso,
    updated_at: nowIso,
    paused_at: null,
    paused_ms_total: 0,
    exercises,
    resolved_plan: resolvedPlan,
    external_id: workout.external_id,
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/logger/hydrate-from-workout.ts
git commit -m "feat(logger): add hydrateWorkoutAsDraft pure helper"
```

---

## Task 4: Add `editMode` prop to `LoggerSheet`

**Files:**
- Modify: `components/logger/LoggerSheet.tsx`

Wire an optional `editMode?: { initialDraft: LoggerDraft }` prop. When set:
- Mount-effect short-circuits: skip `loadDraft`, skip `resolveSessionPlan`, seed state from `editMode.initialDraft`.
- `saveDraft` mirror effect skips (no IndexedDB writes during edit).
- `ResumeDraftPrompt` never renders.
- Header reads "Editing · {type}" instead of "{elapsed} · {type}". Hide pause/reset buttons in edit mode (no live timer).
- `FinishSummary` "Finish & save" button reads "Save changes" (passed via a new prop).
- Existing callers untouched — `editMode` is optional and defaults to `undefined`.

- [ ] **Step 1: Widen `Props` and gate mount-effect**

In `components/logger/LoggerSheet.tsx`, change the `Props` type to:

```ts
type Props = {
  userId: string;
  sessionType: string;
  date: string;            // YYYY-MM-DD
  weekdayLong: string;     // "Monday"
  weekOverrides: Record<string, PlannedExercise[]> | null;
  onClose: () => void;
  /** When set, LoggerSheet boots in edit mode: seeds state from initialDraft,
   *  skips draft-store reads/writes, hides timer controls. */
  editMode?: { initialDraft: LoggerDraft };
};
```

In the mount effect (the `useEffect` that calls `loadDraft` then `resolveSessionPlan`), short-circuit at the top:

```ts
useEffect(() => {
  if (props.editMode) {
    setDraft(props.editMode.initialDraft);
    return;
  }
  let cancelled = false;
  // ... existing body unchanged
  return () => { cancelled = true; };
}, [props.userId, props.sessionType, props.date, props.weekdayLong, props.weekOverrides, supabase, props.editMode]);
```

In the IndexedDB mirror effect (the one calling `saveDraft`), add a guard:

```ts
useEffect(() => {
  if (!draft) return;
  if (props.editMode) return;       // edit mode: no draft persistence
  const updated = { ...draft, updated_at: new Date().toISOString() };
  void saveDraft(updated);
}, [draft, props.editMode]);
```

Drop the `ResumeDraftPrompt` early-return when in edit mode (`resumePrompt` will never be set because the mount effect short-circuits before assigning it; no extra change needed).

- [ ] **Step 2: Relabel header + hide live-timer controls in edit mode**

Locate the header `<div>` containing `elapsedLabel`, the pause button, and the Reset button. Wrap the pause + reset buttons and the elapsed label in `{!props.editMode && (...)}`. Replace the wrapped block with an "Editing · {draft.session_type}" label when `props.editMode` is truthy:

```tsx
<div className="text-zinc-300 text-sm flex items-center gap-2">
  {props.editMode ? (
    <span className="font-mono tabular-nums text-zinc-400">Editing · {draft.session_type}</span>
  ) : (
    <>
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${isPaused ? "bg-yellow-500" : "bg-green-500"}`}></span>
        <span className="font-mono tabular-nums">{elapsedLabel}</span>
        <span>· {draft.session_type}</span>
      </div>
      <button onClick={togglePause} /* …existing… */>{isPaused ? "Resume" : "Pause"}</button>
      <button onClick={() => setResetConfirmOpen(true)} /* …existing… */>Reset</button>
    </>
  )}
</div>
```

- [ ] **Step 3: Hide divergence banner in edit mode**

`exerciseListDiverged(draft)` compares saved exercises against `resolved_plan`. In edit mode the "Save deviations as my {type} default" banner doesn't make sense (the resolved_plan is today's plan, not the session's original plan). Hide it.

Find the existing banner render (the `{diverged && (<button …>Save deviations as my {draft.session_type} default</button>)}` block in the scrollable area) and change the guard to:

```tsx
{!props.editMode && diverged && (
  <button onClick={() => setSaveDefaultOpen(true)} /* …existing… */>
    Save deviations as my {draft.session_type} default
  </button>
)}
```

- [ ] **Step 4: Forward edit-mode label into `FinishSummary`**

Modify `FinishSummary` ([components/logger/FinishSummary.tsx](../../../components/logger/FinishSummary.tsx)) to accept an optional `confirmLabel` prop:

```tsx
type Props = {
  draft: LoggerDraft;
  durationMin: number;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
  confirmLabel?: string;          // default: "Finish & save"
};
```

In the JSX, replace `{saving ? "Saving…" : "Finish & save"}` with `{saving ? "Saving…" : (confirmLabel ?? "Finish & save")}`.

Back in `LoggerSheet.tsx`, update the `<FinishSummary ... />` render to pass `confirmLabel={props.editMode ? "Save changes" : undefined}`.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/logger/LoggerSheet.tsx components/logger/FinishSummary.tsx
git commit -m "feat(logger): editMode prop on LoggerSheet seeds draft, skips persistence"
```

---

## Task 5: Pass `force: true` on debrief POST in edit mode

**Files:**
- Modify: `components/logger/LoggerSheet.tsx`

In edit mode, the existing debrief is stale — must be regenerated. The route is currently idempotent; we extend it in Task 6. Client side, just include `force` when in edit mode.

- [ ] **Step 1: Add `force` to the debrief POST**

In `LoggerSheet.tsx`'s `commitNow` function, find the fire-and-forget debrief fetch and modify the body:

```ts
if (commitResult?.workout_id) {
  fetch("/api/coach/workout-debrief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workout_id: commitResult.workout_id,
      force: !!props.editMode,
    }),
  }).catch(() => { /* fire-and-forget */ });
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/logger/LoggerSheet.tsx
git commit -m "feat(logger): edit-mode commits force debrief regeneration"
```

---

## Task 6: Add `force` handling to workout-debrief route

**Files:**
- Modify: `app/api/coach/workout-debrief/route.ts`

When `force=true` and an existing debrief row is found, delete it before regenerating instead of returning early.

- [ ] **Step 1: Parse `force` and branch the idempotency check**

In `app/api/coach/workout-debrief/route.ts`, update the body parsing:

```ts
let body: { workout_id?: string; force?: boolean };
try {
  body = (await req.json()) as { workout_id?: string; force?: boolean };
} catch {
  return NextResponse.json({ error: "invalid_json" }, { status: 400 });
}
const workoutId = body.workout_id;
const force = body.force === true;
if (!workoutId) {
  return NextResponse.json({ error: "workout_id required" }, { status: 400 });
}
```

Then replace the existing `if (existing) { return … idempotent: true … }` block with:

```ts
if (existing) {
  if (!force) {
    return NextResponse.json({ ok: true, chat_message_id: existing.id, idempotent: true });
  }
  // Force regenerate: drop the stale row so the insert below lands cleanly.
  const { error: delErr } = await sr
    .from("chat_messages")
    .delete()
    .eq("id", existing.id)
    .eq("user_id", user.id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/coach/workout-debrief/route.ts
git commit -m "feat(coach): workout-debrief route accepts force flag for edit regen"
```

---

## Task 7: Create `EditSessionButton` component

**Files:**
- Create: `components/logger/EditSessionButton.tsx`

Eligibility-gated client component. Renders nothing when `!eligible`. On click: fetches workout, resolves the day's plan (best-effort), hydrates, opens `LoggerSheet` with `editMode`. Owns sheet open/close state. Shows a fetch-error toast on failure.

- [ ] **Step 1: Create the button**

Create `components/logger/EditSessionButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { LoggerSheet } from "@/components/logger/LoggerSheet";
import { fetchWorkoutForEditBrowser } from "@/lib/data/fetch-workout-for-edit";
import { hydrateWorkoutAsDraft } from "@/lib/logger/hydrate-from-workout";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { LoggerDraft } from "@/lib/logger/types";

type Props = {
  workoutId: string;
  /** When false (or omitted), the button renders nothing. Caller decides
   *  eligibility (source === 'logger'). */
  eligible: boolean;
  /** Tailwind className passthrough so callers can tune spacing. */
  className?: string;
  /** Optional label override. Default: "Edit". */
  label?: string;
};

export function EditSessionButton(props: Props) {
  const [initialDraft, setInitialDraft] = useState<LoggerDraft | null>(null);
  const [loading, setLoading] = useState(false);

  if (!props.eligible) return null;

  async function openEdit() {
    setLoading(true);
    try {
      const workout = await fetchWorkoutForEditBrowser(props.workoutId);
      if (!workout) {
        alert("Workout not found.");
        return;
      }
      if (workout.source !== "logger") {
        alert("This workout can't be edited (not logger-sourced).");
        return;
      }
      // Best-effort plan resolution: weekday inferred from the workout's date.
      // weekOverrides null is acceptable — falls through to user template /
      // SESSION_PLANS via resolveSessionPlan.
      const weekdayLong = new Date(workout.date + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "long",
      });
      const supabase = createSupabaseBrowserClient();
      const resolved = await resolveSessionPlan({
        supabase,
        userId: workout.user_id,
        sessionType: workout.type,
        weekdayLong,
        weekOverrides: null,
      });
      const draft = hydrateWorkoutAsDraft(workout, resolved.exercises);
      setInitialDraft(draft);
    } catch (e) {
      console.error("EditSessionButton open failed", e);
      alert("Failed to open edit. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={openEdit}
        disabled={loading}
        className={
          props.className ??
          "text-[11px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-200 px-2 py-1 disabled:opacity-50"
        }
        aria-label="Edit session"
      >
        {loading ? "…" : (props.label ?? "Edit")}
      </button>

      {initialDraft && (
        <LoggerSheet
          userId={initialDraft.user_id}
          sessionType={initialDraft.session_type}
          date={initialDraft.date}
          weekdayLong={new Date(initialDraft.date + "T00:00:00").toLocaleDateString("en-US", {
            weekday: "long",
          })}
          weekOverrides={null}
          editMode={{ initialDraft }}
          onClose={() => setInitialDraft(null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/logger/EditSessionButton.tsx
git commit -m "feat(logger): EditSessionButton wires fetch → hydrate → LoggerSheet"
```

---

## Task 8: Wire `EditSessionButton` into `SessionTable`

**Files:**
- Modify: `components/strength/SessionTable.tsx`

Mount the button in the session header next to the type pill. Eligibility = `session.source === 'logger'`.

- [ ] **Step 1: Import and mount the button**

In `components/strength/SessionTable.tsx`, add the import near the top:

```tsx
import { EditSessionButton } from "@/components/logger/EditSessionButton";
```

Find the session-header `<div className="flex justify-between items-baseline mb-3 flex-wrap gap-2">` (around the section that renders the type pill + date + volume). Add the button on the right side of that header — replace the closing `</div>` of the header row with a wrapper:

Locate the existing header:

```tsx
<div className="flex justify-between items-baseline mb-3 flex-wrap gap-2">
  <div className="flex gap-2 items-center">
    {/* type pill */}
  </div>
  {/* right side: existing date/volume/sets info */}
</div>
```

Add `<EditSessionButton workoutId={session.id} eligible={session.source === "logger"} />` as the last child inside the right-side flex container. If the right side is a single inline-flex group, wrap the existing right-side content + the button in a `<div className="flex items-center gap-2">`.

(Use Read to inspect the current right-side structure before editing; place the button so it visually sits at the end of the header row without disrupting existing layout.)

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/strength/SessionTable.tsx
git commit -m "feat(strength): Edit button on SessionTable for logger-sourced sessions"
```

---

## Task 9: Wire `EditSessionButton` into the workout debrief page

**Files:**
- Modify: `app/coach/sessions/[workout_id]/page.tsx`

The page currently fetches only the `chat_messages` row. Add a small `workouts` fetch to read `source` for eligibility, then mount `EditSessionButton` in the page header.

- [ ] **Step 1: Fetch source + mount button**

In `app/coach/sessions/[workout_id]/page.tsx`, after the existing `chat_messages` query and before rendering, add:

```ts
const { data: workoutRow } = await supabase
  .from("workouts")
  .select("source")
  .eq("id", workout_id)
  .eq("user_id", user.id)
  .maybeSingle();
const eligible = workoutRow?.source === "logger";
```

Then update the JSX to mount the button. Import at the top:

```tsx
import { EditSessionButton } from "@/components/logger/EditSessionButton";
```

Above (or within) `<SessionDebriefView payload={payload} />`, render the button. If `SessionDebriefView` doesn't already have a header slot for the button, wrap its render in a flex container with the button at the top right:

```tsx
return (
  <div>
    <div style={{ padding: "12px 16px 0 16px", display: "flex", justifyContent: "flex-end" }}>
      <EditSessionButton workoutId={workout_id} eligible={eligible} />
    </div>
    <SessionDebriefView payload={payload} />
  </div>
);
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/coach/sessions/[workout_id]/page.tsx
git commit -m "feat(coach): Edit button on workout debrief page for logger-sourced sessions"
```

---

## Task 10: Manual verification

**Files:** none (verification only).

Walk through the user-facing flows on a running dev server. CLAUDE.md is explicit: no test suite, verify by exercising the affected pages.

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Expected: server listens on http://localhost:3000.

- [ ] **Step 2: Verify create-flow regression**

In a browser: open `/`, start a session from the dashboard / morning brief, commit a couple sets, hit Finish & save. Confirm:
- LoggerSheet closes.
- The new session appears in `/strength?tab=date`.
- One `workouts` row was inserted (not two — check the row count via Supabase Studio or a single query).

- [ ] **Step 3: Verify the Edit entry points**

On `/strength?tab=date`: the saved session shows an "Edit" button in its header.
On `/strength?tab=by_muscle`: same.
On `/coach/sessions/<workout_id>` for that session: an "Edit" button shows in the page header.

- [ ] **Step 4: Verify edit save**

Click Edit on the saved session. Confirm:
- LoggerSheet opens with the session's exercises and committed sets pre-populated (every set row shows the ✓ committed marker).
- Header reads "Editing · {type}" (no live timer; no pause/reset buttons).
- Change one set's reps from N to N+1. Hit Finish. The FinishSummary modal's button reads "Save changes". Confirm.
- Sheet closes. Return to `/strength?tab=date`. The session now shows N+1.
- Confirm only ONE workouts row exists for that date+type (the upsert preserved the row).

- [ ] **Step 5: Verify add-a-set within edit**

Edit the same session again. Add a new set to any exercise (use the existing "+ Add set" affordance in `ExerciseCard`). Commit the new set with a kg/reps value. Save changes. Reload `/strength?tab=date` and confirm the new set is present.

- [ ] **Step 6: Verify debrief regeneration**

Wait for or manually trigger a workout debrief for the edited session (if the cron hasn't run, visit `/coach/sessions/<id>` to see the existing debrief, or POST to `/api/coach/workout-debrief` with `{ workout_id }`). Then edit the session again, change a kg value notably, save. Visit `/coach/sessions/<id>`. The debrief should reflect the new value — the row was force-regenerated.

- [ ] **Step 7: Verify ineligibility hides the button**

If you have a Strong-CSV-imported workout in the database (any historical row with `source = 'strong'`), confirm it does NOT show an Edit button on `/strength?tab=date` or its debrief page. (If no Strong row exists, manually `update workouts set source = 'strong' where id = '<some_test_id>'` for one row, verify, then revert.)

- [ ] **Step 8: Final typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: No-op commit (or skip if no changes)**

If any tweaks were needed during manual verification, commit them. Otherwise this task has no commit.

---

## What we are NOT doing

- No deletion affordance — out of scope for this spec.
- No editing of Strong-CSV workouts — eligibility-guarded.
- No editing of `date` — pass-through unchanged.
- No new test suite (project has none).
- No migration, no RPC change.
- No refactor of `commit-session.ts` to own debrief regen — kept client-side via the `force` flag for minimal blast radius.
