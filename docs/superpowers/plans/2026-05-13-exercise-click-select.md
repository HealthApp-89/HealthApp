# Exercise Click-to-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a mapped exercise row in the strength session card re-renders the muscle map to show only that exercise's muscles; clicking again toggles back to the session aggregate.

**Architecture:** Add one helper to the existing `lib/coach/exercise-muscles.ts` module. In `components/strength/SessionTable.tsx`, add a `selectedExerciseName` state, derive `displayedMuscles` from it (falling back to the existing session aggregate), pipe that into `<MuscleMap>` and `<MuscleLegendPills>`, and convert `ExerciseBlock` into a clickable element with selected / hover / unmapped states. No new components, no DB/API changes.

**Tech Stack:** Next.js 15 · React 19 · TypeScript (strict) · Tailwind v4

**Spec:** [docs/superpowers/specs/2026-05-13-exercise-click-select-design.md](docs/superpowers/specs/2026-05-13-exercise-click-select-design.md)

**Branch:** `feat/strength-exercise-click-select` (off `main`)

---

## File Structure

MODIFIED:
- `lib/coach/exercise-muscles.ts` — add `getExerciseMuscles(name)` export
- `components/strength/SessionTable.tsx` — new state, derived muscles, click handlers, label, `ExerciseBlock` becomes clickable

UNCHANGED:
- All four components in `components/strength/anatomy/`
- All anatomy SVG assets

---

### Task 1: Add `getExerciseMuscles` helper

**Files:**
- Modify: `lib/coach/exercise-muscles.ts` (append one function)

- [ ] **Step 1: Append the helper to `lib/coach/exercise-muscles.ts`**

Open `/Users/abdelouahedelbied/Health app/.claude/worktrees/<worktree>/lib/coach/exercise-muscles.ts` and append at the very end (after `aggregateSessionMuscles`):

```typescript
/**
 * Return the static muscle mapping for an exercise, or null if the exercise
 * name isn't in EXERCISE_MUSCLES. Used by the session card to highlight only
 * one exercise's muscles when the user clicks it.
 */
export function getExerciseMuscles(name: string): MuscleMapping | null {
  return EXERCISE_MUSCLES[normalizeExerciseName(name)] ?? null;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/exercise-muscles.ts
git commit -m "feat(strength): add getExerciseMuscles helper

Pure wrapper over EXERCISE_MUSCLES + normalizeExerciseName so consumers
don't have to import both. Returns null for unmapped exercises.
SessionTable will use this for the per-exercise click-to-highlight
feature."
```

---

### Task 2: Wire click-to-select into `SessionTable.tsx`

**Files:**
- Modify: `components/strength/SessionTable.tsx`

This is the meat of the change. Five distinct edits in the same file:

1. Import the new helper + add the type import.
2. Add `selectedExerciseName` state + `displayedMuscles` useMemo + a `handleToggleExpanded` that resets selection on collapse.
3. Switch the existing toggle button's `onClick` from inline `setExpanded` to the new handler.
4. Switch `<MuscleMap>` and `<MuscleLegendPills>` from `muscles` to `displayedMuscles`. Add the "Showing muscles for X" label between the pills and the toggle.
5. Convert `ExerciseBlock` into a clickable element; pass `isSelected`, `isMapped`, `accent`, `onClick` from the parent.

- [ ] **Step 1: Read the current `SessionTable.tsx`**

```bash
cat components/strength/SessionTable.tsx
```

Familiarize yourself with the file. Two things to confirm:
- The existing import block (you'll be adding to it).
- The `ExerciseBlock` function signature at the bottom (you'll be changing it).

- [ ] **Step 2: Update the imports**

Replace the existing line that reads:

```typescript
import { aggregateSessionMuscles } from "@/lib/coach/exercise-muscles";
```

with:

```typescript
import {
  aggregateSessionMuscles,
  getExerciseMuscles,
  type AggregatedMuscles,
} from "@/lib/coach/exercise-muscles";
```

- [ ] **Step 3: Update component state and derived muscles**

Inside the `SessionTable` function body, find the existing:

```typescript
const [expanded, setExpanded] = useState(false);
const muscles = useMemo(
  () => aggregateSessionMuscles(session.exercises, session.type),
  [session.exercises, session.type],
);
```

Replace that block with:

```typescript
const [expanded, setExpanded] = useState(false);
const [selectedExerciseName, setSelectedExerciseName] = useState<string | null>(null);

const displayedMuscles = useMemo<AggregatedMuscles>(() => {
  if (selectedExerciseName) {
    const m = getExerciseMuscles(selectedExerciseName);
    if (m) return { primary: m.primary, secondary: m.secondary };
  }
  return aggregateSessionMuscles(session.exercises, session.type);
}, [selectedExerciseName, session.exercises, session.type]);

const handleToggleExpanded = () => {
  setExpanded((prev) => {
    if (prev) setSelectedExerciseName(null);
    return !prev;
  });
};

const handleSelectExercise = (name: string) => {
  setSelectedExerciseName((prev) => (prev === name ? null : name));
};
```

- [ ] **Step 4: Switch `<MuscleMap>` and `<MuscleLegendPills>` to `displayedMuscles`**

Find this block in the JSX:

```tsx
<MuscleMap primary={muscles.primary} secondary={muscles.secondary} accent={wc} />
<MuscleLegendPills primary={muscles.primary} secondary={muscles.secondary} accent={wc} />
```

Replace it with:

```tsx
<MuscleMap primary={displayedMuscles.primary} secondary={displayedMuscles.secondary} accent={wc} />
<MuscleLegendPills primary={displayedMuscles.primary} secondary={displayedMuscles.secondary} accent={wc} />

{selectedExerciseName && (
  <div
    className="mt-2 text-center text-[10px] font-mono"
    style={{ color: COLOR.textFaint }}
  >
    Showing muscles for{" "}
    <span style={{ color: COLOR.textMid }}>{selectedExerciseName}</span>
  </div>
)}
```

- [ ] **Step 5: Update the toggle button's `onClick`**

Find the existing toggle button:

```tsx
<button
  type="button"
  onClick={() => setExpanded((e) => !e)}
  aria-expanded={expanded}
  …
>
```

Change `onClick={() => setExpanded((e) => !e)}` to `onClick={handleToggleExpanded}`. Everything else on the button stays.

- [ ] **Step 6: Pass new props to `ExerciseBlock` in the map**

Find the existing expanded-list rendering:

```tsx
{expanded && (
  session.exercises.length === 0 ? (
    <div className="mt-3 text-xs italic py-6 text-center" style={{ color: COLOR.textMuted }}>
      No exercises in this session.
    </div>
  ) : (
    <div className="mt-3 flex flex-col gap-3">
      {session.exercises.map((e) => (
        <ExerciseBlock key={`${e.name}-${e.position}`} exercise={e} />
      ))}
    </div>
  )
)}
```

Replace the `<ExerciseBlock …/>` line so it passes the new props. The block becomes:

```tsx
{expanded && (
  session.exercises.length === 0 ? (
    <div className="mt-3 text-xs italic py-6 text-center" style={{ color: COLOR.textMuted }}>
      No exercises in this session.
    </div>
  ) : (
    <div className="mt-3 flex flex-col gap-3">
      {session.exercises.map((e) => {
        const isMapped = getExerciseMuscles(e.name) !== null;
        return (
          <ExerciseBlock
            key={`${e.name}-${e.position}`}
            exercise={e}
            isSelected={selectedExerciseName === e.name}
            isMapped={isMapped}
            accent={wc}
            onSelect={() => handleSelectExercise(e.name)}
          />
        );
      })}
    </div>
  )
)}
```

- [ ] **Step 7: Update the `ExerciseBlock` component**

Find the existing `ExerciseBlock` function at the bottom of the file. Its current signature is:

```typescript
function ExerciseBlock({ exercise: e }: { exercise: WorkoutExercise }) {
```

Replace the entire `ExerciseBlock` function (signature + body) with this version:

```typescript
function ExerciseBlock({
  exercise: e,
  isSelected,
  isMapped,
  accent,
  onSelect,
}: {
  exercise: WorkoutExercise;
  isSelected: boolean;
  isMapped: boolean;
  accent: string;
  onSelect: () => void;
}) {
  // Per-exercise summary line. Weighted exercises show top weighted set + kg vol;
  // bodyweight exercises show top reps in a single set + total reps for the day.
  let summary: string | null = null;
  if (e.kind === "weighted") {
    const working = e.sets.filter((s) => !s.warmup && s.kg && s.reps);
    const top = working.length
      ? working.reduce((a, b) => (est1rm(b.kg!, b.reps!) > est1rm(a.kg!, a.reps!) ? b : a))
      : null;
    const exVol = working.reduce((acc, s) => acc + (s.kg ?? 0) * (s.reps ?? 0), 0);
    if (top) summary = `top ${fmtNum(top.kg!)}×${top.reps} · ${fmtNum(exVol)} kg vol`;
  } else {
    let topReps = 0;
    let totalReps = 0;
    for (const s of e.sets) {
      if (s.warmup || s.kg || !s.reps) continue;
      totalReps += s.reps;
      if (s.reps > topReps) topReps = s.reps;
    }
    if (totalReps > 0) summary = `top ${topReps} reps · ${totalReps} reps total`;
  }

  const interactive = isMapped;
  const bgColor = isSelected
    ? `color-mix(in srgb, ${accent} 14%, transparent)`
    : "transparent";
  const nameOpacity = isMapped ? 1 : 0.55;

  const inner = (
    <div className="p-2 rounded-md transition-colors" style={{ background: bgColor }}>
      <div className="flex justify-between items-baseline mb-1.5 gap-2">
        <span
          className="text-[12px] font-semibold"
          style={{ color: COLOR.textStrong, opacity: nameOpacity }}
        >
          {e.name}
        </span>
        {summary && (
          <span className="text-[10px] font-mono whitespace-nowrap" style={{ color: COLOR.textMuted }}>
            {summary}
          </span>
        )}
      </div>
      <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${COLOR.divider}` }}>
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr style={{ color: COLOR.textMuted, background: COLOR.surfaceAlt }}>
              <th className="text-left px-2.5 py-1 w-12 font-normal">Set</th>
              <th className="text-right px-2.5 py-1 font-normal">Weight</th>
              <th className="text-right px-2.5 py-1 font-normal">Reps</th>
              <th className="text-right px-2.5 py-1 font-normal">est 1RM</th>
              <th className="text-right px-2.5 py-1 w-14 font-normal">Flag</th>
            </tr>
          </thead>
          <tbody>
            {e.sets.map((s, i) => {
              const r1 = s.kg && s.reps ? est1rm(s.kg, s.reps) : null;
              const isBodyweight = !s.kg && s.reps != null;
              const isCardio = s.duration_seconds != null && !s.kg && !s.reps;
              return (
                <tr
                  key={i}
                  className="border-t"
                  style={{
                    borderColor: COLOR.divider,
                    opacity: s.warmup ? 0.45 : 1,
                  }}
                >
                  <td className="px-2.5 py-1" style={{ color: COLOR.textMid }}>{i + 1}</td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textStrong }}>
                    {isBodyweight ? "BW" : s.kg != null ? fmtNum(s.kg) : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textStrong }}>
                    {s.reps != null ? s.reps : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textMid }}>
                    {r1 != null ? fmtNum(r1) : isCardio ? `${s.duration_seconds}s` : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right">
                    {s.warmup && (
                      <span
                        className="text-[9px] px-1 rounded"
                        style={{ background: COLOR.surfaceAlt, color: COLOR.textMid }}
                      >
                        W
                      </span>
                    )}
                    {s.failure && (
                      <span
                        className="text-[9px] px-1 rounded ml-1"
                        style={{ background: COLOR.dangerSoft, color: COLOR.danger }}
                        title="trained to failure"
                      >
                        F
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (!interactive) return inner;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className="block w-full text-left cursor-pointer hover:opacity-95 transition-opacity"
    >
      {inner}
    </button>
  );
}
```

Key changes in this rewrite:
- New props: `isSelected`, `isMapped`, `accent`, `onSelect`.
- Body content (the existing `<div>` with header + table) is now stored in a local `inner` variable.
- If the exercise is mapped, the whole row is wrapped in a `<button>` with `aria-pressed` reflecting selection state and a hover affordance.
- If unmapped (no muscle data), it renders the plain inner content with the exercise name at reduced opacity (signals "no data" without making the row look broken).
- Selected row gets a subtle accent-tinted background (`color-mix` 14%).

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add components/strength/SessionTable.tsx
git commit -m "feat(strength): click an exercise to highlight its muscles only

Adds per-exercise muscle highlighting to the expanded session card.
Clicking a mapped exercise row swaps the silhouette + pills from the
session-aggregate view to that exercise's muscles; click the same row
to toggle back; click another row to swap. Unmapped exercises render
non-interactive at reduced name-opacity. A 'Showing muscles for X'
label appears under the pills when an exercise is selected. Selection
state resets when the card collapses."
```

---

### Task 3: Final verification + open PR

- [ ] **Step 1: Run typecheck one more time**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Smoke-test in the browser (optional but encouraged)**

If you can run the dev server:

```bash
npm run dev
```

Then visit http://localhost:3000/strength?view=date and verify:
1. Expand a session card.
2. Click a mapped exercise (e.g., Bench Press) → silhouette shifts to chest/front-delts/triceps; "Showing muscles for Bench Press" appears below the pills.
3. Click the same exercise again → silhouette returns to the session aggregate; label disappears.
4. Click a different exercise → swaps cleanly.
5. Try clicking an unmapped exercise (something not in `EXERCISE_MUSCLES` — most users' Strong libraries will have at least a few): row shouldn't react, name should look slightly muted.
6. Collapse the card → re-expand → no exercise is preselected (state reset).

- [ ] **Step 3: Branch log**

```bash
git log --oneline main..HEAD
```

Expected: two commits (`feat(strength): add getExerciseMuscles helper`, `feat(strength): click an exercise to highlight its muscles only`).

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin <local-branch-name>:feat/strength-exercise-click-select
gh pr create --base main --head feat/strength-exercise-click-select --title "feat(strength): click an exercise to highlight its muscles" --body "$(cat <<'EOF'
Incremental upgrade on top of PR #56. When the strength session card is expanded, clicking a mapped exercise row swaps the muscle silhouette + pills from the session-aggregate view to that exercise's primary/secondary muscles. Click the same row again to toggle back; click another row to swap.

## What

- Click a mapped exercise → silhouette + pills show only that exercise.
- Click again → back to session aggregate.
- Selected row gets a subtle accent-tinted background; \`aria-pressed\` reflects state.
- Unmapped exercises (not in \`EXERCISE_MUSCLES\`) render non-interactive at reduced opacity — clear signal that there's no muscle data for that one yet.
- A "Showing muscles for &lt;Exercise&gt;" label appears under the pills in per-exercise mode.
- Selection resets when the card collapses.

## How

- Added \`getExerciseMuscles(name)\` to [lib/coach/exercise-muscles.ts](lib/coach/exercise-muscles.ts) — pure wrapper over the existing lookup.
- \`SessionTable.tsx\` gains a \`selectedExerciseName\` state and a \`useMemo\`'d \`displayedMuscles\` that prefers the selected exercise's muscles when set, otherwise falls back to the existing session aggregate.
- \`ExerciseBlock\` becomes a \`<button>\` for mapped exercises (with hover + selected state) and renders plain for unmapped exercises.

## Files

Modified:
- [lib/coach/exercise-muscles.ts](lib/coach/exercise-muscles.ts) — +8 lines
- [components/strength/SessionTable.tsx](components/strength/SessionTable.tsx) — ~30 lines diff

No DB changes, no API changes, no new components.

## Spec

[docs/superpowers/specs/2026-05-13-exercise-click-select-design.md](docs/superpowers/specs/2026-05-13-exercise-click-select-design.md)

## Verified

- Typecheck passes
- Manual smoke-test: mapped exercises swap correctly, same-row toggle works, unmapped rows are non-interactive, label appears/disappears, collapse resets state.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace `<local-branch-name>` with the local branch the worktree is on (likely `worktree-feat+strength-exercise-click-select` if EnterWorktree was used; otherwise just `feat/strength-exercise-click-select`).
