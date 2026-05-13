# Strength Muscle-Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Garmin-style front + back muscle silhouette to the strength tab's By Date session card, with primary/secondary muscle highlighting in the workout-type accent color and a tap-to-expand affordance for the exercise/set details.

**Architecture:** Wger anatomical SVGs (CC-BY-SA-4.0) committed to `public/anatomy/`, recolored at runtime via CSS `mask-image` so the same overlay file works for any accent color. Exercise-to-muscle mapping is a static TS lookup with a per-session-type fallback; session-level aggregation weights by working volume with a 15% primary threshold. Four new presentational components + one constants/aggregation module + one modified card. No DB, no API, no new query keys.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript (strict) · Tailwind v4 · CSS `mask-image` (with `-webkit-` fallback for older Safari)

**Branch:** `feat/strength-muscle-map` (off `main`)

---

## File Structure

NEW:
- `public/anatomy/front.svg` — wger front body
- `public/anatomy/back.svg` — wger back body
- `public/anatomy/main-1.svg` … `main-16.svg` — wger per-muscle overlays (16 files)
- `public/anatomy/main-17.svg` — custom rear-delts overlay (we trace it)
- `public/anatomy/LICENSE.txt` — CC-BY-SA-4.0 attribution
- `lib/coach/exercise-muscles.ts` — constants (MUSCLE_ID, MUSCLE_NAMES, MUSCLE_VIEW, EXERCISE_MUSCLES, TYPE_FALLBACK) + `normalizeExerciseName` + `aggregateSessionMuscles`
- `components/strength/anatomy/MuscleOverlay.tsx` — one CSS-masked div
- `components/strength/anatomy/BodyView.tsx` — single silhouette (front or back) + filtered overlays
- `components/strength/anatomy/MuscleMap.tsx` — front+back pair wrapper
- `components/strength/anatomy/MuscleLegendPills.tsx` — pill row below the body
- `scripts/verify-muscle-aggregation.mts` — one-off spot-check, deleted after PR merges

MODIFIED:
- `components/strength/SessionTable.tsx` — insert MuscleMap + MuscleLegendPills + tap-to-expand for the exercise/set tables

---

### Task 1: Download wger anatomical assets to `public/anatomy/`

**Files:**
- Create: `public/anatomy/front.svg`, `back.svg`
- Create: `public/anatomy/main-1.svg` … `main-16.svg` (16 files)
- Create: `public/anatomy/LICENSE.txt`

- [ ] **Step 1: Create the anatomy directory**

```bash
mkdir -p public/anatomy
```

- [ ] **Step 2: Download base body SVGs**

```bash
curl -fsSL -o public/anatomy/front.svg https://raw.githubusercontent.com/wger-project/wger/master/wger/core/static/images/muscles/muscular_system_front.svg
curl -fsSL -o public/anatomy/back.svg  https://raw.githubusercontent.com/wger-project/wger/master/wger/core/static/images/muscles/muscular_system_back.svg
```

- [ ] **Step 3: Download all 16 per-muscle overlay SVGs**

```bash
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
  curl -fsSL -o "public/anatomy/main-$n.svg" "https://raw.githubusercontent.com/wger-project/wger/master/wger/core/static/images/muscles/main/muscle-$n.svg"
done
```

- [ ] **Step 4: Verify file count and sizes**

```bash
ls -lh public/anatomy/*.svg
```

Expected: 18 SVG files. `front.svg` and `back.svg` should each be ≥300 KB. `main-N.svg` should each be ~3 KB.

- [ ] **Step 5: Write the LICENSE.txt attribution**

Create `public/anatomy/LICENSE.txt`:

```text
Anatomical body SVGs sourced from the wger Workout Manager project.
  https://github.com/wger-project/wger

Files:
  front.svg, back.svg                            — base body illustrations
  main-1.svg through main-16.svg                 — per-muscle overlay shapes
  main-17.svg                                    — posterior deltoid overlay (Apex Health, derivative)

Licensed under Creative Commons Attribution-ShareAlike 4.0 International
(CC BY-SA 4.0).
  https://creativecommons.org/licenses/by-sa/4.0/

Attribution: wger project contributors.
Modifications: recolored at runtime via CSS mask-image; main-17.svg added
as a derivative work.
```

- [ ] **Step 6: Verify assets are served by Next.js**

Start the dev server in one terminal:

```bash
npm run dev
```

In another terminal, hit a few asset URLs:

```bash
curl -sS -o /dev/null -w "front.svg %{http_code}\n"  http://localhost:3000/anatomy/front.svg
curl -sS -o /dev/null -w "back.svg %{http_code}\n"   http://localhost:3000/anatomy/back.svg
curl -sS -o /dev/null -w "main-4.svg %{http_code}\n" http://localhost:3000/anatomy/main-4.svg
```

Expected: `200` for all three.

- [ ] **Step 7: Commit**

```bash
git add public/anatomy/
git commit -m "feat(anatomy): add wger anatomical SVGs to public/anatomy/

CC-BY-SA-4.0. 2 base bodies + 16 per-muscle overlays. ~770 KB total
static assets served once and cached forever by Next.js public/
handling."
```

---

### Task 2: Trace custom rear-delts overlay

**Files:**
- Create: `public/anatomy/main-17.svg`

wger doesn't ship a posterior-deltoid overlay (their muscle id 2 "Shoulders" is the anterior deltoid on the front view only). We trace a back-view rear-delt overlay using the same 200×369 canvas as the wger overlays so it can be consumed identically by `MuscleOverlay`.

- [ ] **Step 1: Inspect the back-view shoulder region**

With the dev server running, open these two URLs in browser tabs side by side:
- http://localhost:3000/anatomy/back.svg — the base back body
- file://(pwd)/public/anatomy/main-9.svg — the trapezius overlay (for size/position reference)

Note where the posterior deltoid sits in the back view (the upper outer shoulder cap, roughly y ≈ 50–85 and x ≈ 50–80 on the viewer's left and x ≈ 120–150 on the viewer's right within the 200×369 canvas).

- [ ] **Step 2: Write the trace SVG**

Create `public/anatomy/main-17.svg`:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="369" viewBox="0 0 200 369">
  <!-- Left posterior deltoid (anatomical right, viewer's left) -->
  <path d="M 55 54 C 48 60, 44 70, 46 82 C 52 88, 64 88, 72 82 C 76 72, 72 58, 64 54 C 60 52, 56 52, 55 54 Z" fill="#fc0000"/>
  <!-- Right posterior deltoid (anatomical left, viewer's right) -->
  <path d="M 145 54 C 152 60, 156 70, 154 82 C 148 88, 136 88, 128 82 C 124 72, 128 58, 136 54 C 140 52, 144 52, 145 54 Z" fill="#fc0000"/>
</svg>
```

- [ ] **Step 3: Visually verify alignment**

Open http://localhost:3000/anatomy/main-17.svg in the browser. The two rear-delt blobs should sit at the top-outer-shoulder area in the canvas. If they look obviously misaligned (e.g., on the chest or below the rib cage), adjust the path coordinates and reload — the path is two cubic-Bezier loops; tweak the start `M x y` and the control points proportionally.

Cross-check by mentally overlaying main-17.svg on top of back.svg in your head: the shapes should land on the back-view shoulder caps.

- [ ] **Step 4: Commit**

```bash
git add public/anatomy/main-17.svg
git commit -m "feat(anatomy): add custom rear-delts overlay (main-17.svg)

wger doesn't ship a posterior-deltoid overlay (their id 2 is anterior
deltoid on the front view only). Trace a back-view rear-delt shape
using the same 200x369 canvas as the wger overlays so MuscleOverlay
can consume it identically."
```

---

### Task 3: Constants module `lib/coach/exercise-muscles.ts`

**Files:**
- Create: `lib/coach/exercise-muscles.ts`

This task lands the static data only — no functions. Splitting constants from behavior keeps the diff reviewable.

- [ ] **Step 1: Write the constants module**

Create `lib/coach/exercise-muscles.ts`:

```typescript
// Static muscle-group mapping for strength sessions.
// Muscle IDs mirror the wger project (https://github.com/wger-project/wger).
// We add id 17 (posterior deltoid) which wger doesn't ship separately.

export const MUSCLE_ID = {
  Biceps: 1,
  FrontDelts: 2,
  Serratus: 3,
  Chest: 4,
  Triceps: 5,
  Abs: 6,
  Calves: 7,
  Glutes: 8,
  Traps: 9,
  Quads: 10,
  Hams: 11,
  Lats: 12,
  Brachialis: 13,
  Obliques: 14,
  Soleus: 15,
  RearDelts: 17,
} as const;

export type MuscleId = (typeof MUSCLE_ID)[keyof typeof MUSCLE_ID];

export const MUSCLE_NAMES: Record<MuscleId, string> = {
  1: "Biceps",
  2: "Front delts",
  3: "Serratus",
  4: "Chest",
  5: "Triceps",
  6: "Abs",
  7: "Calves",
  8: "Glutes",
  9: "Traps",
  10: "Quads",
  11: "Hams",
  12: "Lats",
  13: "Brachialis",
  14: "Obliques",
  15: "Soleus",
  17: "Rear delts",
};

/** Which body view (front or back) each muscle renders on. */
export const MUSCLE_VIEW: Record<MuscleId, "front" | "back"> = {
  1: "front",
  2: "front",
  3: "front",
  4: "front",
  5: "back",
  6: "front",
  7: "back",
  8: "back",
  9: "back",
  10: "front",
  11: "back",
  12: "back",
  13: "front",
  14: "front",
  15: "back",
  17: "back",
};

export type MuscleMapping = {
  primary: MuscleId[];
  secondary: MuscleId[];
};

const M = MUSCLE_ID;

/**
 * Strong exercise name (normalized: lowercase, parens stripped, single spaces)
 * mapped to its primary + secondary muscles. Extend as new exercises appear in
 * the user's Strong exports.
 */
export const EXERCISE_MUSCLES: Record<string, MuscleMapping> = {
  // ----- Chest -----
  "bench press":            { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "incline bench press":    { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "incline dumbbell press": { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "dumbbell bench press":   { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "decline bench press":    { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  "cable fly":              { primary: [M.Chest], secondary: [M.FrontDelts] },
  "dumbbell fly":           { primary: [M.Chest], secondary: [M.FrontDelts] },
  "pec deck":               { primary: [M.Chest], secondary: [M.FrontDelts] },
  "dip":                    { primary: [M.Chest, M.Triceps], secondary: [M.FrontDelts] },
  "push up":                { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },

  // ----- Back -----
  "pull up":                { primary: [M.Lats], secondary: [M.Biceps, M.Traps] },
  "chin up":                { primary: [M.Lats, M.Biceps], secondary: [M.Traps] },
  "lat pulldown":           { primary: [M.Lats], secondary: [M.Biceps] },
  "barbell row":            { primary: [M.Lats], secondary: [M.Traps, M.RearDelts, M.Biceps] },
  "dumbbell row":           { primary: [M.Lats], secondary: [M.Traps, M.RearDelts, M.Biceps] },
  "seated cable row":       { primary: [M.Lats], secondary: [M.Traps, M.Biceps] },
  "t bar row":              { primary: [M.Lats], secondary: [M.Traps, M.Biceps] },
  "face pull":              { primary: [M.RearDelts], secondary: [M.Traps] },

  // ----- Shoulders -----
  "overhead press":         { primary: [M.FrontDelts], secondary: [M.Triceps, M.Traps] },
  "seated dumbbell press":  { primary: [M.FrontDelts], secondary: [M.Triceps] },
  "arnold press":           { primary: [M.FrontDelts], secondary: [M.Triceps] },
  "lateral raise":          { primary: [M.FrontDelts], secondary: [M.Traps] },
  "rear delt fly":          { primary: [M.RearDelts], secondary: [M.Traps] },
  "rear delt raise":        { primary: [M.RearDelts], secondary: [M.Traps] },
  "shrug":                  { primary: [M.Traps], secondary: [] },
  "upright row":            { primary: [M.Traps], secondary: [M.FrontDelts] },

  // ----- Arms -----
  "barbell curl":           { primary: [M.Biceps], secondary: [M.Brachialis] },
  "dumbbell curl":          { primary: [M.Biceps], secondary: [M.Brachialis] },
  "hammer curl":            { primary: [M.Biceps, M.Brachialis], secondary: [] },
  "preacher curl":          { primary: [M.Biceps], secondary: [M.Brachialis] },
  "cable curl":             { primary: [M.Biceps], secondary: [M.Brachialis] },
  "tricep pushdown":        { primary: [M.Triceps], secondary: [] },
  "overhead tricep extension": { primary: [M.Triceps], secondary: [] },
  "skull crusher":          { primary: [M.Triceps], secondary: [] },
  "close grip bench press": { primary: [M.Triceps], secondary: [M.Chest, M.FrontDelts] },
  "rope pushdown":          { primary: [M.Triceps], secondary: [] },

  // ----- Legs -----
  "squat":                  { primary: [M.Quads], secondary: [M.Glutes] },
  "front squat":            { primary: [M.Quads], secondary: [M.Glutes] },
  "leg press":              { primary: [M.Quads], secondary: [M.Glutes, M.Hams] },
  "romanian deadlift":      { primary: [M.Hams], secondary: [M.Glutes] },
  "deadlift":               { primary: [M.Hams, M.Glutes], secondary: [M.Lats, M.Traps] },
  "hip thrust":             { primary: [M.Glutes], secondary: [M.Hams] },
  "leg extension":          { primary: [M.Quads], secondary: [] },
  "leg curl":               { primary: [M.Hams], secondary: [] },
  "calf raise":             { primary: [M.Calves], secondary: [M.Soleus] },
  "seated calf raise":      { primary: [M.Soleus], secondary: [M.Calves] },
  "lunge":                  { primary: [M.Quads, M.Glutes], secondary: [M.Hams] },
  "bulgarian split squat":  { primary: [M.Quads, M.Glutes], secondary: [M.Hams] },

  // ----- Core -----
  "plank":                  { primary: [M.Abs], secondary: [M.Obliques] },
  "crunch":                 { primary: [M.Abs], secondary: [] },
  "hanging leg raise":      { primary: [M.Abs], secondary: [] },
  "russian twist":          { primary: [M.Obliques], secondary: [M.Abs] },
  "ab wheel":               { primary: [M.Abs], secondary: [] },
  "cable crunch":           { primary: [M.Abs], secondary: [] },
};

/**
 * Per-session-type fallback used when no exercises matched the lookup.
 * Keys are values seen in workouts.type (set by Strong's "Workout Name" field).
 */
export const TYPE_FALLBACK: Record<string, MuscleMapping> = {
  Chest:       { primary: [M.Chest],                      secondary: [M.FrontDelts, M.Triceps] },
  Back:        { primary: [M.Lats],                       secondary: [M.Traps, M.RearDelts, M.Biceps] },
  Shoulders:   { primary: [M.FrontDelts, M.RearDelts],    secondary: [M.Traps] },
  Arms:        { primary: [M.Biceps, M.Triceps],          secondary: [M.Brachialis] },
  Legs:        { primary: [M.Quads, M.Glutes, M.Hams],    secondary: [M.Calves, M.Abs] },
  "Full Body": { primary: [M.Chest, M.Lats, M.Quads],     secondary: [M.FrontDelts, M.Glutes, M.Abs] },
};
```

- [ ] **Step 2: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/exercise-muscles.ts
git commit -m "feat(strength): muscle-mapping constants

Static lookup of Strong exercise names to wger muscle IDs (primary +
secondary), plus per-session-type fallback for unrecognized sessions.
Functions land in the next commit."
```

---

### Task 4: Aggregation function + verification script

**Files:**
- Modify: `lib/coach/exercise-muscles.ts` (append functions)
- Create: `scripts/verify-muscle-aggregation.mts`

- [ ] **Step 1: Verify WorkoutExercise/WorkoutSet shape**

```bash
grep -n "type WorkoutSession\|type WorkoutExercise\|type WorkoutSet" lib/data/workouts.ts
```

Expected: three matches. Open the file and confirm `WorkoutExercise` has `name: string` and `sets: WorkoutSet[]`, and `WorkoutSet` has `kg: number | null`, `reps: number | null`, `warmup: boolean`. The implementation below depends on these property names.

- [ ] **Step 2: Append functions to `lib/coach/exercise-muscles.ts`**

Add at the end of the file:

```typescript
import type { WorkoutExercise } from "@/lib/data/workouts";

const BODYWEIGHT_PROXY_KG = 70;
const PRIMARY_THRESHOLD = 0.15;

/** Normalize for lookup: lowercase, strip equipment parens, collapse whitespace. */
export function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "") // drop "(Barbell)", "(Dumbbell)", etc.
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AggregatedMuscles = {
  primary: MuscleId[];
  secondary: MuscleId[];
};

/** Working volume of an exercise, summed over non-warmup sets. Bodyweight sets use a 70 kg proxy. */
function workingVolume(ex: WorkoutExercise): number {
  let v = 0;
  for (const s of ex.sets) {
    if (s.warmup) continue;
    const kg = s.kg ?? BODYWEIGHT_PROXY_KG;
    const reps = s.reps ?? 0;
    v += kg * reps;
  }
  return v;
}

/**
 * Roll up per-exercise muscle hits into session-level primary/secondary.
 *
 * Algorithm:
 *   - For each mapped exercise, compute its working volume and its share of total mapped volume.
 *   - Sum each muscle's primary-share contribution across exercises.
 *   - A muscle is session-primary if its primary share >= 15% of total mapped volume.
 *   - A muscle is session-secondary if it appears anywhere (primary or secondary in any exercise)
 *     and isn't already session-primary.
 *   - If no exercises mapped (or all warmup-only), fall back to TYPE_FALLBACK[fallbackType].
 */
export function aggregateSessionMuscles(
  exercises: WorkoutExercise[],
  fallbackType: string | null,
): AggregatedMuscles {
  type Row = { volume: number; mapping: MuscleMapping };
  const rows: Row[] = [];
  let totalVolume = 0;

  for (const ex of exercises) {
    const key = normalizeExerciseName(ex.name);
    const mapping = EXERCISE_MUSCLES[key];
    if (!mapping) continue;
    const v = workingVolume(ex);
    if (v <= 0) continue;
    rows.push({ volume: v, mapping });
    totalVolume += v;
  }

  if (totalVolume === 0) {
    const fb = fallbackType ? TYPE_FALLBACK[fallbackType] : null;
    return fb
      ? { primary: [...fb.primary], secondary: [...fb.secondary] }
      : { primary: [], secondary: [] };
  }

  const primaryScore = new Map<MuscleId, number>();
  const appearsAnywhere = new Set<MuscleId>();

  for (const { volume, mapping } of rows) {
    const share = volume / totalVolume;
    for (const m of mapping.primary) {
      primaryScore.set(m, (primaryScore.get(m) ?? 0) + share);
      appearsAnywhere.add(m);
    }
    for (const m of mapping.secondary) {
      appearsAnywhere.add(m);
    }
  }

  const primary: MuscleId[] = [];
  for (const [m, score] of primaryScore) {
    if (score >= PRIMARY_THRESHOLD) primary.push(m);
  }
  const primarySet = new Set(primary);
  const secondary = [...appearsAnywhere].filter((m) => !primarySet.has(m));

  return { primary, secondary };
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Write the verification script**

Create `scripts/verify-muscle-aggregation.mts`:

```typescript
// Spot-check the muscle aggregation. Delete after PR merges.
// Run with:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/verify-muscle-aggregation.mts

import {
  aggregateSessionMuscles,
  MUSCLE_NAMES,
  type MuscleId,
} from "@/lib/coach/exercise-muscles";
import type { WorkoutExercise } from "@/lib/data/workouts";

function ex(
  name: string,
  sets: { kg: number | null; reps: number; warmup?: boolean }[],
): WorkoutExercise {
  return {
    name,
    position: 0,
    kind: sets.some((s) => s.kg === null) ? "bodyweight" : "weighted",
    sets: sets.map((s) => ({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: null,
      warmup: s.warmup ?? false,
      failure: false,
    })),
  };
}

function fmt(ids: MuscleId[]): string {
  return ids.map((id) => MUSCLE_NAMES[id]).join(", ") || "(none)";
}

const chestDay: WorkoutExercise[] = [
  ex("Bench Press (Barbell)", [
    { kg: 60, reps: 10, warmup: true },
    { kg: 90, reps: 8 },
    { kg: 100, reps: 6 },
    { kg: 100, reps: 6 },
    { kg: 100, reps: 5 },
  ]),
  ex("Incline Dumbbell Press", [
    { kg: 28, reps: 12 },
    { kg: 32, reps: 10 },
    { kg: 32, reps: 8 },
  ]),
  ex("Cable Fly", [
    { kg: 20, reps: 12 },
    { kg: 20, reps: 12 },
    { kg: 20, reps: 12 },
  ]),
  ex("Tricep Pushdown", [
    { kg: 25, reps: 12 },
    { kg: 25, reps: 12 },
    { kg: 25, reps: 12 },
  ]),
];

const legsDay: WorkoutExercise[] = [
  ex("Squat", [
    { kg: 80, reps: 5, warmup: true },
    { kg: 120, reps: 5 },
    { kg: 130, reps: 5 },
    { kg: 130, reps: 5 },
    { kg: 130, reps: 5 },
  ]),
  ex("Romanian Deadlift", [
    { kg: 100, reps: 8 },
    { kg: 110, reps: 8 },
    { kg: 110, reps: 8 },
  ]),
  ex("Leg Extension", [
    { kg: 60, reps: 12 },
    { kg: 60, reps: 12 },
    { kg: 60, reps: 12 },
  ]),
  ex("Calf Raise", [
    { kg: 80, reps: 15 },
    { kg: 80, reps: 15 },
    { kg: 80, reps: 15 },
  ]),
];

const unknownDay: WorkoutExercise[] = [
  ex("Some Exotic Exercise We Haven't Mapped", [
    { kg: 50, reps: 10 },
    { kg: 50, reps: 10 },
  ]),
];

function run(label: string, exs: WorkoutExercise[], type: string | null) {
  const result = aggregateSessionMuscles(exs, type);
  console.log(`\n=== ${label} (type=${type ?? "null"}) ===`);
  console.log(`  primary:   ${fmt(result.primary)}`);
  console.log(`  secondary: ${fmt(result.secondary)}`);
}

run("Chest day", chestDay, "Chest");
run("Legs day", legsDay, "Legs");
run("Unknown exercises only", unknownDay, "Chest");
run("Empty session, type=Back", [], "Back");
run("Empty session, no type", [], null);
```

- [ ] **Step 5: Run the verification script**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/verify-muscle-aggregation.mts
```

Expected output (exact lists; the threshold and volume math is deterministic):

```
=== Chest day (type=Chest) ===
  primary:   Chest, Triceps
  secondary: Front delts

=== Legs day (type=Legs) ===
  primary:   Quads, Hams, Calves
  secondary: Glutes, Soleus

=== Unknown exercises only (type=Chest) ===
  primary:   Chest
  secondary: Front delts, Triceps

=== Empty session, type=Back ===
  primary:   Lats
  secondary: Traps, Rear delts, Biceps

=== Empty session, no type ===
  primary:   (none)
  secondary: (none)
```

If the output differs from this exactly, the aggregation logic has a bug. Common culprits:
- Warmup sets being included in volume (check the `if (s.warmup) continue` line).
- Threshold mis-applied (should be `>= 0.15`, not `> 0.15`).
- Fallback path not triggering when `totalVolume === 0`.

Debug before continuing.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/exercise-muscles.ts scripts/verify-muscle-aggregation.mts
git commit -m "feat(strength): aggregateSessionMuscles + verification script

Pure function rolls up per-exercise muscle hits into session-level
primary/secondary, weighting by working volume. A muscle is
session-primary if its primary contribution >= 15% of total mapped
volume; otherwise session-secondary if it appears anywhere. Falls back
to TYPE_FALLBACK[type] when no exercises map. Bodyweight sets use a
70 kg proxy.

verify-muscle-aggregation.mts is a one-off spot-check; delete after PR
merges."
```

---

### Task 5: `MuscleOverlay.tsx` (leaf component)

**Files:**
- Create: `components/strength/anatomy/MuscleOverlay.tsx`

One CSS-masked div per highlighted muscle. Renders the wger overlay shape filled with the workout-type accent at the caller's opacity.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p components/strength/anatomy
```

- [ ] **Step 2: Write the component**

Create `components/strength/anatomy/MuscleOverlay.tsx`:

```typescript
import type { MuscleId } from "@/lib/coach/exercise-muscles";

type Props = {
  id: MuscleId;
  accent: string;
  opacity: number;
};

export function MuscleOverlay({ id, accent, opacity }: Props) {
  const url = `url(/anatomy/main-${id}.svg)`;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        background: accent,
        opacity,
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/strength/anatomy/MuscleOverlay.tsx
git commit -m "feat(strength): MuscleOverlay component

One CSS-masked div per highlighted muscle. Mask shape is
/anatomy/main-{id}.svg; fill is the workout-type accent at the
caller's opacity (95% for primary / 42% for secondary)."
```

---

### Task 6: `BodyView.tsx` (single silhouette)

**Files:**
- Create: `components/strength/anatomy/BodyView.tsx`

Renders one body view (front or back) — the dim wger base SVG plus filtered MuscleOverlay children for muscles on this view.

- [ ] **Step 1: Write the component**

Create `components/strength/anatomy/BodyView.tsx`:

```typescript
import { MUSCLE_VIEW, type MuscleId } from "@/lib/coach/exercise-muscles";
import { MuscleOverlay } from "./MuscleOverlay";

const SIZE_MAP = { sm: 90, md: 130 } as const;

type Props = {
  view: "front" | "back";
  primary: MuscleId[];
  secondary: MuscleId[];
  accent: string;
  size: "sm" | "md";
};

export function BodyView({ view, primary, secondary, accent, size }: Props) {
  const w = SIZE_MAP[size];
  const h = Math.round((w * 369) / 200); // wger SVG aspect: 200x369

  const here = (ids: MuscleId[]) => ids.filter((id) => MUSCLE_VIEW[id] === view);

  return (
    <div className="relative" style={{ width: w, height: h }}>
      <img
        src={`/anatomy/${view}.svg`}
        alt={`${view} body`}
        className="absolute inset-0 h-full w-full object-contain opacity-90 brightness-[0.4] contrast-110"
      />
      {here(primary).map((id) => (
        <MuscleOverlay key={`p-${id}`} id={id} accent={accent} opacity={0.95} />
      ))}
      {here(secondary).map((id) => (
        <MuscleOverlay key={`s-${id}`} id={id} accent={accent} opacity={0.42} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/strength/anatomy/BodyView.tsx
git commit -m "feat(strength): BodyView component

Single silhouette (front or back). Renders the wger base body as a
dimmed <img> plus filtered MuscleOverlay children for muscles on this
view. Size is 'sm' (90 px wide) or 'md' (130 px); height derived from
wger's 200x369 aspect."
```

---

### Task 7: `MuscleMap.tsx` (front + back wrapper)

**Files:**
- Create: `components/strength/anatomy/MuscleMap.tsx`

The component `SessionTable` imports.

- [ ] **Step 1: Write the component**

Create `components/strength/anatomy/MuscleMap.tsx`:

```typescript
import type { MuscleId } from "@/lib/coach/exercise-muscles";
import { BodyView } from "./BodyView";

export type MuscleMapProps = {
  primary: MuscleId[];
  secondary: MuscleId[];
  accent: string;
  size?: "sm" | "md";
};

export function MuscleMap({ primary, secondary, accent, size = "md" }: MuscleMapProps) {
  return (
    <div className="flex justify-center gap-1.5">
      <BodyView view="front" primary={primary} secondary={secondary} accent={accent} size={size} />
      <BodyView view="back"  primary={primary} secondary={secondary} accent={accent} size={size} />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/strength/anatomy/MuscleMap.tsx
git commit -m "feat(strength): MuscleMap component

Public wrapper pairing front + back BodyView. SessionTable imports
this."
```

---

### Task 8: `MuscleLegendPills.tsx`

**Files:**
- Create: `components/strength/anatomy/MuscleLegendPills.tsx`

Pill row below the silhouette. Primary pills are brighter; secondary are softer (same color treatment as the body silhouette).

- [ ] **Step 1: Write the component**

Create `components/strength/anatomy/MuscleLegendPills.tsx`:

```typescript
import { MUSCLE_NAMES, type MuscleId } from "@/lib/coach/exercise-muscles";

type Props = {
  primary: MuscleId[];
  secondary: MuscleId[];
  accent: string;
};

export function MuscleLegendPills({ primary, secondary, accent }: Props) {
  if (primary.length === 0 && secondary.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1.5">
      {primary.map((id) => (
        <Pill key={`p-${id}`} accent={accent} kind="primary">
          {MUSCLE_NAMES[id]}
        </Pill>
      ))}
      {secondary.map((id) => (
        <Pill key={`s-${id}`} accent={accent} kind="secondary">
          {MUSCLE_NAMES[id]}
        </Pill>
      ))}
    </div>
  );
}

function Pill({
  accent,
  kind,
  children,
}: {
  accent: string;
  kind: "primary" | "secondary";
  children: React.ReactNode;
}) {
  const bg =
    kind === "primary"
      ? `color-mix(in srgb, ${accent} 20%, transparent)`
      : `color-mix(in srgb, ${accent} 10%, transparent)`;
  const color =
    kind === "primary"
      ? `color-mix(in srgb, ${accent} 80%, #ffffff)`
      : `color-mix(in srgb, ${accent} 65%, #ffffff)`;
  const border =
    kind === "primary"
      ? `color-mix(in srgb, ${accent} 50%, transparent)`
      : `color-mix(in srgb, ${accent} 30%, transparent)`;

  return (
    <span
      className="rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
      style={{ background: bg, color, borderColor: border }}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/strength/anatomy/MuscleLegendPills.tsx
git commit -m "feat(strength): MuscleLegendPills component

Pill row below the silhouette naming each highlighted muscle. Primary
pills brighter, secondary softer (matches the body silhouette accent
treatment). Returns null when there's nothing to show."
```

---

### Task 9: Integrate into `SessionTable.tsx` (muscle map + tap-to-expand)

**Files:**
- Modify: `components/strength/SessionTable.tsx`

- [ ] **Step 1: Read the existing component**

```bash
cat components/strength/SessionTable.tsx
```

Note:
1. Is there a `'use client'` directive at the top? If not, we'll add one (we need `useState` for the expand toggle).
2. Where is the workout color computed? (Likely a line referencing `WCOLORS[session.type]` from `@/lib/ui/colors`.)
3. Where is the exercise list rendered? (Look for `session.exercises.map(...)` or a sub-component that takes the exercise array.) That block will be wrapped in `{expanded && (...)}`.
4. Do any other files import `SessionTable`? Run `grep -rn "from.*SessionTable" .` if curious — the parent `StrengthClient.tsx` is already a Client Component, so converting `SessionTable` to a Client Component is safe.

- [ ] **Step 2: Add `'use client'` and imports**

At the top of `components/strength/SessionTable.tsx`, ensure these (add only the ones missing):

```typescript
"use client";
import { useMemo, useState } from "react";
import { aggregateSessionMuscles } from "@/lib/coach/exercise-muscles";
import { MuscleMap } from "@/components/strength/anatomy/MuscleMap";
import { MuscleLegendPills } from "@/components/strength/anatomy/MuscleLegendPills";
```

- [ ] **Step 3: Add state + memoized aggregation inside the component body**

Find where the component function body begins. Below any existing destructuring and below the `wc` (workout color) computation, add:

```typescript
const [expanded, setExpanded] = useState(false);

const muscles = useMemo(
  () => aggregateSessionMuscles(session.exercises, session.type),
  [session],
);
```

If `wc` doesn't exist as a variable yet, add it now using the existing `WCOLORS` import pattern from the file:

```typescript
import { WCOLORS } from "@/lib/ui/colors";
// …inside component:
const wc = WCOLORS[session.type ?? "Other"] ?? WCOLORS.Other;
```

- [ ] **Step 4: Insert MuscleMap + MuscleLegendPills + toggle button**

Find the JSX block that renders the exercise list (the `session.exercises.map(...)` or equivalent — the block we're about to gate on `expanded`). Immediately *before* that block, insert:

```tsx
<MuscleMap primary={muscles.primary} secondary={muscles.secondary} accent={wc} />
<MuscleLegendPills primary={muscles.primary} secondary={muscles.secondary} accent={wc} />

<button
  type="button"
  onClick={() => setExpanded((e) => !e)}
  aria-expanded={expanded}
  className="mt-2.5 flex w-full items-center justify-center gap-1.5 border-t border-dashed border-[#2c3140] pt-2.5 text-[11px] text-[#6b7080] transition-colors hover:text-[#9094a8]"
>
  <svg
    className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
  {expanded ? "Hide exercises" : "Tap for exercises"}
</button>
```

- [ ] **Step 5: Wrap the exercise list in a conditional**

Take the existing exercise-list JSX block (the one rendering set tables) and wrap it:

```tsx
{expanded && (
  <div className="mt-3 border-t border-white/5 pt-3">
    {/* existing exercise-list JSX, unchanged */}
  </div>
)}
```

If the existing block was already wrapped in a `<div>` with similar styling, you can simply add the `{expanded && (` guard at its outer boundary and the matching `)}` at its closing tag — no need to add a redundant wrapper.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors. Common pitfalls:
- `WCOLORS[session.type]` indexed with a possibly-null key → use the nullish-fallback pattern from Step 3.
- Adding `'use client'` to a component that imports Server-only utilities → unlikely here but check if a typecheck error mentions an RSC boundary.

- [ ] **Step 7: Smoke-test in the browser**

```bash
npm run dev
```

Open http://localhost:3000/strength?view=date. Navigate the date picker to a date with a logged strength session.

Verify:
1. Above the (now-hidden) exercise list, the card shows a front + back silhouette pair with the session's primary muscles highlighted in the workout-type accent at full opacity and secondary muscles at ~42% opacity.
2. The pill row below the silhouette lists the same muscles by name (primary pills brighter than secondary).
3. The exercise list is hidden by default. Clicking "Tap for exercises" reveals it; the chevron flips upward; the label changes to "Hide exercises."
4. Clicking again hides the list and the chevron rotates back.
5. Switching dates resets the card to collapsed (since each card has its own local state).
6. Navigate to a session of a different type (Back, Legs, Shoulders, Arms) and confirm the accent color and highlighted muscles change correctly.
7. If you find a session where nothing lights up but `session.type` is one of `Chest/Back/Shoulders/Arms/Legs/Full Body`, check whether the exercise names in that session match `EXERCISE_MUSCLES` keys (after `normalizeExerciseName`). If not, the type fallback should still highlight via `TYPE_FALLBACK`.

- [ ] **Step 8: Commit**

```bash
git add components/strength/SessionTable.tsx
git commit -m "feat(strength): integrate muscle map into SessionTable

Inserts MuscleMap + MuscleLegendPills above the exercise list on the
By Date view's session card, and gates the exercise/set tables behind
a tap-to-expand toggle. Aggregation is memoized on session changes.
Card converted to Client Component for the useState toggle."
```

---

### Task 10: Delete the verification script

**Files:**
- Delete: `scripts/verify-muscle-aggregation.mts`

- [ ] **Step 1: Delete the script**

```bash
rm scripts/verify-muscle-aggregation.mts
```

- [ ] **Step 2: Commit**

```bash
git add -A scripts/
git commit -m "chore: remove muscle-aggregation verification script

One-off; landed alongside the aggregation function for spot-checking
and is no longer needed."
```

---

### Task 11: Final verification + open PR

- [ ] **Step 1: Final typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Review the branch log**

```bash
git log --oneline main..HEAD
```

Expected: 10 focused commits, each touching a small set of files.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/strength-muscle-map
gh pr create --base main --title "feat(strength): muscle-map on session card (By Date view)" --body "$(cat <<'EOF'
Add a Garmin-style muscle map to the strength tab's By Date session card.

## What

- Front + back human-body silhouette with the session's primary muscles
  highlighted in the workout-type accent color (95% opacity) and secondary
  muscles at 42%.
- Pill row below the silhouette listing the muscles by name.
- Tap-to-expand toggle that hides/reveals the existing exercise/set tables.

## How

- Static anatomical SVGs in `public/anatomy/` (wger project, CC-BY-SA-4.0)
  recolored at runtime via CSS `mask-image` so one overlay file renders
  in any accent color.
- Static exercise-to-muscle lookup in `lib/coach/exercise-muscles.ts`
  (~50 entries). Session-level aggregation weights primary muscle hits
  by working volume; a muscle becomes session-primary when it contributed
  ≥15% of total mapped volume.
- No DB changes, no API changes, no new query keys. Aggregation is a
  memoized pure function.

## Spec

[docs/superpowers/specs/2026-05-13-strength-muscle-map-design.md](docs/superpowers/specs/2026-05-13-strength-muscle-map-design.md)

## Tested

- Manually verified on Chest, Back, Legs, Shoulders, Arms sessions.
- Unknown exercises fall back to `TYPE_FALLBACK[session.type]`.
- Empty sessions degrade gracefully (silhouette only, no pills).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed on success.
