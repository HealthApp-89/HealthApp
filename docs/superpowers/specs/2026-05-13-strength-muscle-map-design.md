# Strength session muscle-map — design

**Date:** 2026-05-13
**Branch target:** `feat/strength-muscle-map`
**Status:** spec — pending user review

---

## What we're building

On the strength tab's "By Date" view, the session card currently shows a header (type pill + date + duration + total volume) immediately followed by a flat exercise list with set tables. We're adding a **muscle map** between the header and the exercises: a front + back human-body silhouette with the session's primary muscles highlighted in the workout-type accent color (95% opacity) and secondary muscles at 42% opacity. Below the silhouette: a row of muscle-group pills naming what was hit. Below the pills: a tap-to-expand affordance that hides/reveals the exercise/set details.

**Why:** the existing card is dense and undifferentiated — every session looks the same. A muscle map turns it into a glanceable "session report" you can scan in a list (the inspiration is Garmin Connect's Muscle Map view, redrawn to fit our dark, single-hue tinted card system).

**Goal of this phase:** ship the muscle-map visualization on the By Date view only. Future phases (Recent view summaries, weekly muscle-distribution view) are out of scope.

---

## Architecture overview

Five new pieces, one modified component, no DB changes.

### 1. Static anatomical asset (committed to `public/anatomy/`)

Source: the [wger workout manager](https://github.com/wger-project/wger) open-source SVGs (CC-BY-SA-4.0). Hand-drawn anatomical illustration in Inkscape — looks human, not polygonal.

```
public/anatomy/
├── front.svg                   — base front body (314 KB)
├── back.svg                    — base back body (395 KB)
├── main-1.svg  … main-16.svg   — per-muscle overlay shapes (~3 KB × 16 ≈ 50 KB)
├── main-17.svg                 — custom rear-delts overlay (we trace this; ~3 KB)
└── LICENSE.txt                 — CC-BY-SA-4.0 attribution + link to wger upstream
```

Total: ~770 KB static, served once with `Cache-Control: public, max-age=31536000, immutable` (Next.js handles this automatically for `/public/*`).

The base body SVGs are grayscale (`#303030`–`#cfcfcf`); the overlay SVGs are pure-shape masks (a single `<path fill="#fc0000">` per file; we use them via CSS `mask-image` so the fill color is replaced by `var(--accent)`).

**Muscle ID convention** (mirrors wger's API; we add 17 ourselves):

| ID | Name              | View  | ID | Name             | View  |
|----|-------------------|-------|----|------------------|-------|
| 1  | Biceps            | front | 10 | Quadriceps       | front |
| 2  | Anterior deltoid  | front | 11 | Hamstrings       | back  |
| 3  | Serratus anterior | front | 12 | Latissimus dorsi | back  |
| 4  | Pectoralis major  | front | 13 | Brachialis       | front |
| 5  | Triceps           | back  | 14 | Obliques         | front |
| 6  | Rectus abdominis  | front | 15 | Soleus           | back  |
| 7  | Gastrocnemius     | back  | 16 | (unused)         | —     |
| 8  | Gluteus maximus   | back  | **17** | **Posterior deltoid (custom)** | **back** |
| 9  | Trapezius         | back  |    |                  |       |

The custom rear-delts overlay (id 17) is necessary because wger only ships "shoulders" (id 2) as a front-view muscle. We trace a posterior-deltoid path once during implementation and commit it as `main-17.svg`.

### 2. Muscle mapping (`lib/coach/exercise-muscles.ts`)

A static lookup from normalized Strong-export exercise names → `{ primary: MuscleId[], secondary: MuscleId[] }`. The Strong export library for one user is bounded (~50–100 unique exercises across all their training), so a hand-curated table is the right tool — deterministic, no API calls, free.

```ts
// lib/coach/exercise-muscles.ts

export const MUSCLE_ID = {
  Biceps: 1, FrontDelts: 2, Serratus: 3, Chest: 4, Triceps: 5,
  Abs: 6, Calves: 7, Glutes: 8, Traps: 9, Quads: 10,
  Hams: 11, Lats: 12, Brachialis: 13, Obliques: 14, Soleus: 15,
  RearDelts: 17,
} as const
export type MuscleId = (typeof MUSCLE_ID)[keyof typeof MUSCLE_ID]

export const MUSCLE_NAMES: Record<MuscleId, string> = {
  1: 'Biceps', 2: 'Front delts', 3: 'Serratus', 4: 'Chest', 5: 'Triceps',
  6: 'Abs', 7: 'Calves', 8: 'Glutes', 9: 'Traps', 10: 'Quads',
  11: 'Hams', 12: 'Lats', 13: 'Brachialis', 14: 'Obliques', 15: 'Soleus',
  17: 'Rear delts',
}

/** Which view each muscle is rendered on. Drives BodyView filtering. */
export const MUSCLE_VIEW: Record<MuscleId, 'front' | 'back'> = {
  1: 'front', 2: 'front', 3: 'front', 4: 'front', 5: 'back',
  6: 'front', 7: 'back', 8: 'back', 9: 'back', 10: 'front',
  11: 'back', 12: 'back', 13: 'front', 14: 'front', 15: 'back',
  17: 'back',
}

type MuscleMapping = { primary: MuscleId[]; secondary: MuscleId[] }

const M = MUSCLE_ID

/** Strong exercise name (post-normalize) → muscles. Hand-curated; grow as new exercises appear. */
export const EXERCISE_MUSCLES: Record<string, MuscleMapping> = {
  // Chest
  'bench press':            { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  'incline bench press':    { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  'incline dumbbell press': { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  'dumbbell bench press':   { primary: [M.Chest], secondary: [M.FrontDelts, M.Triceps] },
  'cable fly':              { primary: [M.Chest], secondary: [M.FrontDelts] },
  'dumbbell fly':           { primary: [M.Chest], secondary: [M.FrontDelts] },
  'dip':                    { primary: [M.Chest, M.Triceps], secondary: [M.FrontDelts] },

  // Back
  'pull up':                { primary: [M.Lats], secondary: [M.Biceps, M.Traps] },
  'chin up':                { primary: [M.Lats, M.Biceps], secondary: [M.Traps] },
  'lat pulldown':           { primary: [M.Lats], secondary: [M.Biceps] },
  'barbell row':            { primary: [M.Lats], secondary: [M.Traps, M.RearDelts, M.Biceps] },
  'dumbbell row':           { primary: [M.Lats], secondary: [M.Traps, M.RearDelts, M.Biceps] },
  'seated cable row':       { primary: [M.Lats], secondary: [M.Traps, M.Biceps] },
  'face pull':              { primary: [M.RearDelts], secondary: [M.Traps] },

  // Shoulders
  'overhead press':         { primary: [M.FrontDelts], secondary: [M.Triceps, M.Traps] },
  'seated dumbbell press':  { primary: [M.FrontDelts], secondary: [M.Triceps] },
  'lateral raise':          { primary: [M.FrontDelts], secondary: [M.Traps] },
  'rear delt fly':          { primary: [M.RearDelts], secondary: [M.Traps] },
  'shrug':                  { primary: [M.Traps], secondary: [] },

  // Arms
  'barbell curl':           { primary: [M.Biceps], secondary: [M.Brachialis] },
  'dumbbell curl':          { primary: [M.Biceps], secondary: [M.Brachialis] },
  'hammer curl':            { primary: [M.Biceps, M.Brachialis], secondary: [] },
  'preacher curl':          { primary: [M.Biceps], secondary: [M.Brachialis] },
  'tricep pushdown':        { primary: [M.Triceps], secondary: [] },
  'overhead tricep extension': { primary: [M.Triceps], secondary: [] },
  'skull crusher':          { primary: [M.Triceps], secondary: [] },
  'close grip bench press': { primary: [M.Triceps], secondary: [M.Chest, M.FrontDelts] },

  // Legs
  'squat':                  { primary: [M.Quads], secondary: [M.Glutes] },
  'front squat':            { primary: [M.Quads], secondary: [M.Glutes] },
  'leg press':              { primary: [M.Quads], secondary: [M.Glutes, M.Hams] },
  'romanian deadlift':      { primary: [M.Hams], secondary: [M.Glutes] },
  'deadlift':               { primary: [M.Hams, M.Glutes], secondary: [M.Lats, M.Traps] },
  'hip thrust':             { primary: [M.Glutes], secondary: [M.Hams] },
  'leg extension':          { primary: [M.Quads], secondary: [] },
  'leg curl':               { primary: [M.Hams], secondary: [] },
  'calf raise':             { primary: [M.Calves], secondary: [M.Soleus] },
  'lunge':                  { primary: [M.Quads, M.Glutes], secondary: [M.Hams] },
  'bulgarian split squat':  { primary: [M.Quads, M.Glutes], secondary: [M.Hams] },

  // Core
  'plank':                  { primary: [M.Abs], secondary: [M.Obliques] },
  'crunch':                 { primary: [M.Abs], secondary: [] },
  'hanging leg raise':      { primary: [M.Abs], secondary: [] },
  'russian twist':          { primary: [M.Obliques], secondary: [M.Abs] },
  'ab wheel':               { primary: [M.Abs], secondary: [] },

  // (Add new exercises as the user logs them. Unrecognized exercises fall back to session.type — see below.)
}

/** Normalize for lookup: lowercase, strip equipment parens, collapse whitespace. */
export function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')      // drop "(Barbell)", "(Dumbbell)", etc.
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Per-session-type fallback used when no exercises matched the lookup. */
export const TYPE_FALLBACK: Record<string, MuscleMapping> = {
  Chest:     { primary: [M.Chest],                       secondary: [M.FrontDelts, M.Triceps] },
  Back:      { primary: [M.Lats],                        secondary: [M.Traps, M.RearDelts, M.Biceps] },
  Shoulders: { primary: [M.FrontDelts, M.RearDelts],     secondary: [M.Traps] },
  Arms:      { primary: [M.Biceps, M.Triceps],           secondary: [M.Brachialis] },
  Legs:      { primary: [M.Quads, M.Glutes, M.Hams],     secondary: [M.Calves, M.Abs] },
  'Full Body': { primary: [M.Chest, M.Lats, M.Quads],    secondary: [M.FrontDelts, M.Glutes, M.Abs] },
}
```

### 3. Session aggregation (same file)

Roll up the per-exercise muscle hits into a session-level `{ primary: MuscleId[], secondary: MuscleId[] }`. The algorithm:

```
For each exercise:
  workingVolume = sum over non-warmup sets of (kg ?? BODYWEIGHT_PROXY_KG) × reps
  Look up the exercise's MuscleMapping (normalize name first).
  If no mapping, mark exercise as "unmapped."

totalVolume = sum of workingVolume across all mapped exercises

For each muscle that appeared in any exercise's primary list:
  primaryScore[muscle] = sum of (workingVolume[ex] / totalVolume) for exercises where it's listed primary

A muscle is SESSION-PRIMARY if primaryScore[muscle] ≥ 0.15 (i.e., it contributed ≥15% of total mapped volume as a primary target).

A muscle is SESSION-SECONDARY if it appears anywhere (primary or secondary in any exercise) and isn't already session-primary.

If NO exercises mapped (or all warmup-only with zero working volume):
  return TYPE_FALLBACK[fallbackType] ?? { primary: [], secondary: [] }
```

Concrete constants:
- `BODYWEIGHT_PROXY_KG = 70` — used when `set.kg` is null (bodyweight exercise) so pull-ups vs bench press contribute on a comparable scale. Documented approximation; we don't read user's actual bodyweight here to keep the function pure and dependency-free.
- `PRIMARY_THRESHOLD = 0.15` — chosen to match the example "Chest day with 4 exercises" intuition (chest at 81% → primary, triceps at 18% → primary, front delts at 0% primary contribution but appears secondary → secondary). If tuning is needed we adjust this single constant.

Pure function, no React, no DB access. Lives next to the lookup table so they evolve together.

```ts
const BODYWEIGHT_PROXY_KG = 70
const PRIMARY_THRESHOLD = 0.15

export type AggregatedMuscles = { primary: MuscleId[]; secondary: MuscleId[] }

export function aggregateSessionMuscles(
  exercises: WorkoutExercise[],
  fallbackType: string | null,
): AggregatedMuscles { /* … as described above … */ }
```

### 4. UI components (`components/strength/anatomy/`)

```
components/strength/anatomy/
├── MuscleMap.tsx           — front + back silhouette pair
├── BodyView.tsx            — single silhouette (used twice by MuscleMap)
├── MuscleOverlay.tsx       — one CSS-masked overlay, recolored to accent
└── MuscleLegendPills.tsx   — pill row below the body
```

**MuscleMap.tsx** — public component, consumed by `SessionTable`:

```tsx
'use client'
import { BodyView } from './BodyView'
import type { MuscleId } from '@/lib/coach/exercise-muscles'

export type MuscleMapProps = {
  primary: MuscleId[]
  secondary: MuscleId[]
  accent: string      // e.g., WCOLORS[session.type]
  size?: 'sm' | 'md'  // sm for compact, md for By Date hero (default md)
}

export function MuscleMap({ primary, secondary, accent, size = 'md' }: MuscleMapProps) {
  return (
    <div className="flex justify-center gap-1.5">
      <BodyView view="front" primary={primary} secondary={secondary} accent={accent} size={size} />
      <BodyView view="back"  primary={primary} secondary={secondary} accent={accent} size={size} />
    </div>
  )
}
```

**BodyView.tsx** — renders one silhouette (front or back) with overlays filtered to that view:

```tsx
import { MUSCLE_VIEW, type MuscleId } from '@/lib/coach/exercise-muscles'
import { MuscleOverlay } from './MuscleOverlay'

const SIZE_MAP = { sm: 90, md: 130 } as const

export function BodyView({ view, primary, secondary, accent, size }: {
  view: 'front' | 'back'
  primary: MuscleId[]
  secondary: MuscleId[]
  accent: string
  size: 'sm' | 'md'
}) {
  const w = SIZE_MAP[size]
  const h = Math.round(w * 369 / 200)   // wger SVG aspect (200×369)

  const here = (ids: MuscleId[]) => ids.filter(id => MUSCLE_VIEW[id] === view)

  return (
    <div className="relative" style={{ width: w, height: h }}>
      <img
        src={`/anatomy/${view}.svg`}
        alt={`${view} body`}
        className="absolute inset-0 h-full w-full object-contain opacity-90 brightness-[0.4] contrast-110"
      />
      {here(primary).map(id => (
        <MuscleOverlay key={`p-${id}`} id={id} accent={accent} opacity={0.95} />
      ))}
      {here(secondary).map(id => (
        <MuscleOverlay key={`s-${id}`} id={id} accent={accent} opacity={0.42} />
      ))}
    </div>
  )
}
```

**MuscleOverlay.tsx** — one CSS-masked div per highlighted muscle:

```tsx
import type { MuscleId } from '@/lib/coach/exercise-muscles'

export function MuscleOverlay({ id, accent, opacity }: {
  id: MuscleId
  accent: string
  opacity: number
}) {
  const url = `url(/anatomy/main-${id}.svg)`
  return (
    <div
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        background: accent,
        opacity,
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  )
}
```

**MuscleLegendPills.tsx** — pill row, one per highlighted muscle. Pill background/border use `color-mix(in srgb, var(--accent) X%, transparent)` exactly like the mockup. Primary muscles get the brighter pill; secondary get the softer one.

### 5. Modified: `components/strength/SessionTable.tsx`

The component becomes a controlled card with two regions:

**Always visible:**
- Existing header (type pill, date, stats)
- NEW: `<MuscleMap />` with aggregated primary/secondary
- NEW: `<MuscleLegendPills />`
- NEW: `<button>` toggle (chevron icon + "Tap for exercises" / "Hide exercises")

**Visible only when `expanded`:**
- Existing exercise blocks (the current table of sets per exercise)

The component manages its own local `useState<boolean>(false)` for expansion. No URL state, no server round-trip — just a UI affordance per card. The card opens lazily; if the user navigates to a different date, the next card starts collapsed again.

Aggregation runs in `useMemo`:

```ts
const muscles = useMemo(
  () => aggregateSessionMuscles(session.exercises, session.type),
  [session]
)
```

---

## Data flow

```
WorkoutSession (existing, from lib/data/workouts.ts)
   │
   │ exercises: WorkoutExercise[]   ← each has .name (string from Strong CSV)
   │ type: string | null            ← e.g., "Chest"
   ▼
aggregateSessionMuscles(exercises, type)   ← pure fn in lib/coach/exercise-muscles.ts
   │
   │ For each exercise: normalize name, look up in EXERCISE_MUSCLES
   │ Weight by working volume, classify as session-primary / secondary
   │ Fall back to TYPE_FALLBACK[type] if no match
   ▼
{ primary: MuscleId[], secondary: MuscleId[] }
   │
   ▼
<MuscleMap primary={...} secondary={...} accent={WCOLORS[type]} />
   │
   ├─ <BodyView view="front" /> → <img src="/anatomy/front.svg"> + <MuscleOverlay> per muscle (filtered to front)
   └─ <BodyView view="back"  /> → <img src="/anatomy/back.svg">  + <MuscleOverlay> per muscle (filtered to back)
```

All client-side. No DB read, no API call. No new query keys. The aggregation function is pure and ~30 lines of TS.

---

## Error handling

| Case                                       | Behavior                                                                  |
|--------------------------------------------|---------------------------------------------------------------------------|
| Session has 0 exercises                    | Render body silhouette greyed-out; no overlays; no pills                  |
| `session.type` is null AND no exercises match lookup | Same as above — silhouette only, no pills                         |
| Exercise name not in `EXERCISE_MUSCLES`    | That exercise contributes nothing; aggregate from remaining + type fallback |
| All exercise names unknown                 | Use `TYPE_FALLBACK[session.type]` if `session.type` is recognized         |
| `session.type` unknown to `TYPE_FALLBACK`  | Silhouette only, no pills, no error                                       |
| Anatomy SVG fails to load (network)        | Browser shows broken-img — acceptable degradation; non-blocking          |
| User on Safari < 15.4                      | `mask-image` is well-supported; `-webkit-mask-image` covers older Safari  |

No throws, no error boundaries, no toasts. The silhouette is a presentational enhancement — if any input is missing or unknown, the card degrades gracefully to "less highlighted" and the existing card content stays intact.

---

## Performance

- **Bundle:** ~770 KB of static SVG in `/public/anatomy/` — served with `immutable` cache headers, browser fetches once per device.
- **Per-card render:** at most 6 small `<div>` overlays (typical session: 1–3 primary + 2–3 secondary muscles, split across 2 views). CSS masks are GPU-accelerated.
- **Hydration:** `MuscleMap` is `'use client'` but only because it consumes the cached `useFullWorkouts` result. The SVG paths are static `src=`/`mask-image:url()` — no JSX inflation, no React reconciliation cost per overlay.
- **No new network requests** beyond the one-time anatomy fetch.

---

## Files

### New

| Path                                                  | Purpose                                |
|-------------------------------------------------------|----------------------------------------|
| `public/anatomy/front.svg`                            | wger front body (314 KB)               |
| `public/anatomy/back.svg`                             | wger back body (395 KB)                |
| `public/anatomy/main-1.svg` … `main-16.svg`           | wger per-muscle overlays               |
| `public/anatomy/main-17.svg`                          | custom rear-delts overlay              |
| `public/anatomy/LICENSE.txt`                          | CC-BY-SA-4.0 attribution               |
| `lib/coach/exercise-muscles.ts`                       | lookup + aggregation                   |
| `components/strength/anatomy/MuscleMap.tsx`           | front+back pair                        |
| `components/strength/anatomy/BodyView.tsx`            | single view                            |
| `components/strength/anatomy/MuscleOverlay.tsx`       | one CSS-masked overlay                 |
| `components/strength/anatomy/MuscleLegendPills.tsx`   | pill row                               |

### Modified

| Path                                          | Change                                                              |
|-----------------------------------------------|---------------------------------------------------------------------|
| `components/strength/SessionTable.tsx`        | Add `MuscleMap` + `MuscleLegendPills` + collapse-by-default exercises |

### Not changed

- No DB migrations.
- No API routes.
- No changes to `lib/data/workouts.ts` or the workouts fetcher.
- No changes to other strength views (`SessionRow`, recent, today) — out of scope.

---

## Phased rollout

This is a single PR — no phases. All five components ship together with the modified `SessionTable`. The user can immediately see the muscle map on any session they tap into on `/strength?view=date`.

---

## Open questions / known gaps

1. **Custom rear-delts SVG quality.** The wger asset doesn't ship a posterior-deltoid overlay; we trace one. The traced path will visually match the back-view shoulder region in the wger illustration but won't be hand-drawn art at the same fidelity — it's a single closed `<path>` we author. Acceptable trade-off; we own the file so no license entanglement.
2. **Lookup-table coverage.** The `EXERCISE_MUSCLES` table starts at ~40 entries. When the user logs an exercise not in the table, that exercise contributes nothing to the aggregation and the session falls back to `TYPE_FALLBACK[type]`. The expectation is that we add entries as we notice gaps — there's no automatic detection; we'd notice when a session card highlights "less than expected" and add the missing entry. Adding an entry is one line in `EXERCISE_MUSCLES` and ships with the next deploy.
3. **Lateral deltoid.** wger only distinguishes anterior + posterior delts. Lateral raises currently map to `FrontDelts` (id 2) — anatomically slightly off but visually fine because the deltoid cap on the front body is what reads as "shoulders." Not worth a custom asset.
4. **Session.type accent color.** We assume `WCOLORS[session.type]` always resolves (existing `lib/ui/colors.ts` has `Other: '#9094a8'` as the fallback). No new color work needed.

---

## Out of scope (future work)

- Adding the muscle map to the **Today** view's session card, the **Recent** view, or a weekly muscle-distribution chart.
- A "muscle volume over time" trend chart (e.g., "chest sets per week, last 8 weeks").
- Letting the user override the muscle mapping per exercise (manual edit UI).
- Compressing/optimizing the wger SVGs further (they're already <800 KB total and cached forever; not worth the work).
- LLM-based exercise-to-muscle inference for unknown exercises.
