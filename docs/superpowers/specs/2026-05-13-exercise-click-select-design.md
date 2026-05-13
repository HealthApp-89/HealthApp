# Strength session — click-to-select per-exercise highlighting

**Date:** 2026-05-13
**Branch target:** `feat/strength-exercise-click-select`
**Status:** spec — approved, advancing to plan

---

## What we're building

Incremental upgrade to the strength tab's session card ([components/strength/SessionTable.tsx](components/strength/SessionTable.tsx)) shipped in PR #56. Today the muscle map shows the session's aggregate primary/secondary muscles. After this change, clicking a specific exercise row in the (expanded) list re-renders the muscle map to show only that exercise's muscles; clicking the same row toggles back to the aggregate.

## Interaction

| Action | Result |
|---|---|
| Default state (no selection) | Map shows the session's aggregate muscles (current behavior — unchanged) |
| Click a **mapped** exercise row | `selectedExercise = row.name`; map + pills re-render to that exercise's `{ primary, secondary }` |
| Click the same row again | `selectedExercise = null`; map back to aggregate |
| Click a different mapped row | Swap to that exercise's muscles |
| Click an **unmapped** exercise row | No-op (row is non-interactive — see styling below) |
| Collapse the session card | `selectedExercise` resets to `null` so the next expand starts clean |

Visual cues:
- Mapped row: `cursor: pointer`, subtle hover-tint, and a "selected" background tint (workout-type accent at low opacity) when active.
- Unmapped row: no cursor change, no hover tint, exercise name renders at slightly reduced opacity to signal "no muscle data yet."
- A `<div>` label appears between the muscle pills and the toggle button when an exercise is selected: `"Showing muscles for <Exercise Name>"`. Hidden in aggregate mode.

## Architecture

### `lib/coach/exercise-muscles.ts` — new export

```ts
/** Return the static muscle mapping for an exercise, or null if not in the lookup. */
export function getExerciseMuscles(name: string): MuscleMapping | null {
  return EXERCISE_MUSCLES[normalizeExerciseName(name)] ?? null;
}
```

Three lines. Pure wrapper over the existing lookup; exists so consumers don't need to import `normalizeExerciseName` + `EXERCISE_MUSCLES` separately.

### `components/strength/SessionTable.tsx` — state + rendering

New state alongside `expanded`:

```ts
const [selectedExerciseName, setSelectedExerciseName] = useState<string | null>(null);
```

Computed muscles for the map:

```ts
const displayedMuscles = useMemo<AggregatedMuscles>(() => {
  if (selectedExerciseName) {
    const m = getExerciseMuscles(selectedExerciseName);
    if (m) return { primary: m.primary, secondary: m.secondary };
  }
  return aggregateSessionMuscles(session.exercises, session.type);
}, [selectedExerciseName, session.exercises, session.type]);
```

`<MuscleMap>` and `<MuscleLegendPills>` consume `displayedMuscles` instead of the previous `muscles`.

Reset on collapse:

```ts
const toggleExpanded = () => {
  setExpanded((e) => {
    if (e) setSelectedExerciseName(null);
    return !e;
  });
};
```

(The toggle button's `onClick` switches from inline `setExpanded` to `toggleExpanded`.)

A small label between the pills and the toggle:

```tsx
{selectedExerciseName && (
  <div className="mt-2 text-center text-[10px] font-mono" style={{ color: COLOR.textFaint }}>
    Showing muscles for <span style={{ color: COLOR.textMid }}>{selectedExerciseName}</span>
  </div>
)}
```

### `ExerciseBlock` — make it clickable

`ExerciseBlock` already lives at the bottom of `SessionTable.tsx`. Add three new props:

```ts
function ExerciseBlock({
  exercise: e,
  isSelected,
  isMapped,
  onClick,
}: {
  exercise: WorkoutExercise;
  isSelected: boolean;
  isMapped: boolean;
  onClick: () => void;
}) { ... }
```

Wrap the existing JSX in a `<button>` (or render-conditional `<div>`) so the whole row is clickable for mapped exercises. Apply:
- `cursor-pointer` + `hover:bg-[…]` for mapped exercises (background uses `color-mix(in srgb, ${wc} 8%, transparent)` for hover and `12%` for selected; we'll need to pass `wc` down — or simpler: use `accent` from the parent and inline-style it).
- Reduced opacity (~0.6) on the exercise name when not mapped.

`SessionTable` computes `isMapped` per exercise via `getExerciseMuscles(e.name) !== null` and passes it down along with `isSelected = selectedExerciseName === e.name` and `onClick = () => setSelectedExerciseName(s => s === e.name ? null : e.name)`.

## Data flow

```
ExerciseBlock onClick → SessionTable's setSelectedExerciseName
  → triggers useMemo on selectedExerciseName change
  → displayedMuscles updates
  → MuscleMap + MuscleLegendPills re-render with per-exercise muscles
```

All client-side, all memoized. No DB read, no API call.

## Error handling

| Case | Behavior |
|---|---|
| Exercise has no mapping | Row stays non-interactive; `onClick` not bound; visual styling muted |
| Selected exercise gets removed from `session.exercises` (impossible in practice — session is read-only) | `selectedExerciseName` would stay set but `getExerciseMuscles` returns null and the map falls back to session aggregate. Safe degradation. |
| Session has 0 exercises | Exercise list is empty when expanded; nothing to click; `selectedExerciseName` stays null |

## Files

### Modified

- [lib/coach/exercise-muscles.ts](lib/coach/exercise-muscles.ts) — add `getExerciseMuscles` export
- [components/strength/SessionTable.tsx](components/strength/SessionTable.tsx) — selection state, computed displayed muscles, click handler, label, ExerciseBlock prop additions

### Not touched

- Anatomy components (`MuscleMap`, `BodyView`, `MuscleOverlay`, `MuscleLegendPills`) — they consume `{ primary, secondary }` arrays which now come from a different source but the same shape
- No DB changes, no API changes, no new query keys

## Out of scope

- A "deselect by clicking outside the row" gesture (the same-row-toggle is sufficient)
- Multi-select (e.g., Cmd-click multiple exercises to union their muscles) — speculative
- Animating the transition between aggregate and per-exercise views — pure swap is fine
