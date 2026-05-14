# Per-muscle Volume Tracking (MEV/MAV/MRV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-muscle weekly volume targets (MEV/MAV/MRV) to `plan_payload.strength` for the 10 RP-literature-aligned targeted muscle groups, surfacing the targets in the plan-proposal card, morning brief Advice prompt, and a new strength-tab "By Muscle" sub-tab.

**Architecture:** Pure-function compose layer (`lib/coach/muscle-volume.ts`, `lib/coach/volume-landmarks.ts`) consumed by both the plan-builder (cached at compose time) and a TanStack Query fetcher (recomputed daily from workout history). Three UX surfaces: plan card (compact summary + expandable table), profile-renderer markdown (for coach AI system prompt context), and a new strength-tab sub-tab (body-map status coloring + per-muscle rows with sparklines + drill-down). Morning brief gains a `MuscleVolumeFlag` family with top-2 ranking that flows into the existing Advice prompt and a static inline indicator on the session block. No DB migration — `plan_payload.strength.muscle_volume` is an additive optional jsonb field on the existing nullable `plan_payload` column.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript (strict, `tsc --noEmit`) · Tailwind v4 · TanStack Query · Supabase (RLS) · Anthropic SDK (Haiku 4.5)

**Verification convention:** This project has **no test suite** (per CLAUDE.md). Every code-change step is followed by `npm run typecheck` (must exit clean — no output from `tsc --noEmit`) and, where applicable, a manual smoke check exercising the affected page.

**Branch strategy:** One feature branch per PR off `main` (the v2-tokens branch is unrelated WIP, do not base on it).

| PR | Branch | Depends on |
|---|---|---|
| 1 | `feat/muscle-volume-data-model` | main |
| 2 | `feat/muscle-volume-plan-card` | PR 1 merged |
| 3 | `feat/muscle-volume-fetcher` | PR 1 merged |
| 4 | `feat/muscle-volume-strength-tab` | PRs 1 + 3 merged |
| 5 | `feat/muscle-volume-morning-brief` | PRs 1 + 3 merged |

PRs 2-3 parallelizable; PRs 4-5 parallelizable.

**Spec:** [docs/superpowers/specs/2026-05-14-per-muscle-volume-tracking-design.md](../specs/2026-05-14-per-muscle-volume-tracking-design.md)

---

## File Structure

### NEW

- `lib/coach/volume-landmarks.ts` — literature default MEV/MAV/MRV table + tier scaling (Pure constants + `literatureBand` function)
- `lib/coach/muscle-volume.ts` — `computeWeeklyMuscleVolume` (pure per-muscle volume from workouts) + `evaluateMuscleVolumeGaps` (pure gap detection vs band + ramp)
- `lib/query/fetchers/muscleVolume.ts` — server + browser fetcher variants returning `MuscleVolumeSnapshot`
- `lib/query/hooks/useMuscleVolume.ts` — TanStack Query hook
- `components/strength/by-muscle/ByMuscleView.tsx` — page-level component for the new sub-tab
- `components/strength/by-muscle/MuscleVolumeBodyMap.tsx` — extends the existing muscle map with status-coloring
- `components/strength/by-muscle/MuscleVolumeRow.tsx` — single per-muscle row (track + sparkline + contributors)
- `components/strength/by-muscle/MuscleContributorDrawer.tsx` — drill-down drawer for "where is this muscle's volume coming from"

### MODIFIED

- `lib/data/types.ts` — add `TargetedMuscleGroup`, `MuscleVolumeBand`, `VolumeRampRecipe`, `VolumeCountingRules`, `StrengthMuscleVolume` types; extend `plan_payload.strength` with optional `muscle_volume`; add `MuscleVolumeSnapshot` + `MuscleVolumeFlag` types
- `lib/coach/exercise-muscles.ts` — add `TARGET_GROUP_FOR_MUSCLE` collapse map constant
- `lib/coach/plan-builder/compose-strength.ts` — add `composeMuscleVolume` pure function; thread `recentWorkouts` input into `composeStrengthTemplate`
- `lib/coach/plan-builder/index.ts` — refactor `fetchRecentE1RMs` → `fetchRecentWorkoutData` returning both shapes from one DB call
- `lib/coach/profile-renderer.ts` — add `renderMuscleVolume` helper, inject into active-plan summary
- `components/chat/PlanProposalCard.tsx` — add muscle-volume summary row + expandable details inside Strength section
- `lib/query/keys.ts` — extend with `muscleVolume.snapshot(userId, today)` key family
- `lib/query/hooks/useStrongUpload.ts` (or equivalent — verify name during Task 3.4) — invalidate `muscleVolume` key family on success
- `components/strength/StrengthClient.tsx` — add view tab state + URL param sync; render `ByMuscleView` when `?view=by_muscle`
- `app/strength/page.tsx` — prefetch `muscleVolume.snapshot` on server
- `lib/morning/brief/flags.ts` — add `MuscleVolumeFlag` types + `evaluateMuscleVolumeGapsForBrief` + top-2 ranking
- `lib/morning/brief/advice-prompt.ts` (or wherever the Advice prompt template lives — verify during Task 5.3) — extend with muscle-volume context + coaching directives
- `app/api/chat/morning/recommendation/route.ts` — wire snapshot fetch + flag eval into brief assembly
- `lib/morning/brief/index.ts` — extend `MorningBriefCard` `ui` type with optional `volume_gaps`
- Brief UI session-block component (path verified during Task 5.6) — render static inline indicator when `volume_gaps.length > 0`

---

# PR 1 — Data model + pure compute + composer

**Branch:** `feat/muscle-volume-data-model`

**PR scope summary:** Lands the type definitions, the pure compute functions, the literature defaults, the composer integration, and the upstream fetch consolidation. After this PR merges, every new plan generated via the intake flow will carry a `plan_payload.strength.muscle_volume` field. No user-visible UI changes yet — verification is by inspecting `plan_payload` in DB after generating a plan.

### Task 1.0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Cut a fresh worktree off main**

```bash
cd "/Users/abdelouahedelbied/Health app"
git fetch origin main
```

Then in the Claude session, invoke `EnterWorktree` with name `feat/muscle-volume-data-model`. The session will switch into `.claude/worktrees/feat+muscle-volume-data-model/` on a new branch based off the current HEAD; verify with `git log --oneline -1` that you're at the merge head of main.

- [ ] **Step 2: Symlink node_modules to avoid reinstall**

```bash
ln -s ../../../node_modules node_modules
ls node_modules/.bin/tsc
```

Expected: prints the tsc binary path. (If not, run `npm ci` instead.)

- [ ] **Step 3: Confirm clean baseline typecheck**

```bash
npm run typecheck
```

Expected: zero output, exit code 0.

### Task 1.1: Add type definitions

**Files:**
- Modify: `lib/data/types.ts` (add types near the existing `PlanPayload` definitions)

- [ ] **Step 1: Add the new types to `lib/data/types.ts`**

Find the existing `PlanPayload` type definition. After the `strength:` sub-object definition, but **before** `nutrition:`, the file currently has:

```ts
  strength: {
    sessions_per_week: number;
    day_pattern: { [weekday: string]: string };
    template_session_types: Array<
      "Chest" | "Legs" | "Back" | "Mobility" | "REST"
    >;
    weekly_volume_targets: {
      [primary_lift: string]: { reps_per_week: number; sets_per_week: number };
    };
    progression_rule: string;
    notes: string | null;
  };
```

Change it to add the optional `muscle_volume` field at the end:

```ts
  strength: {
    sessions_per_week: number;
    day_pattern: { [weekday: string]: string };
    template_session_types: Array<
      "Chest" | "Legs" | "Back" | "Mobility" | "REST"
    >;
    weekly_volume_targets: {
      [primary_lift: string]: { reps_per_week: number; sets_per_week: number };
    };
    progression_rule: string;
    notes: string | null;
    muscle_volume?: StrengthMuscleVolume | null;
  };
```

Then, at the bottom of the file (after the `export type Glp1Status = ...` line near line 803), add:

```ts
// ── Per-muscle volume targets (Phase 2.5 / L39) ─────────────────────────────

export type TargetedMuscleGroup =
  | "Chest" | "Lats" | "Traps" | "RearDelts"
  | "Quads" | "Hams" | "Glutes"
  | "Biceps" | "Triceps" | "Calves";

export const TARGETED_MUSCLE_GROUPS: readonly TargetedMuscleGroup[] = [
  "Chest", "Lats", "Traps", "RearDelts",
  "Quads", "Hams", "Glutes",
  "Biceps", "Triceps", "Calves",
] as const;

export type MuscleVolumeBand = {
  /** Sets/wk floor for measurable growth. */
  mev: number;
  /** Sets/wk optimal range. */
  mav: [number, number];
  /** Sets/wk ceiling before fatigue eats progress. */
  mrv: number;
  /** Rolling 8-week average sets/wk for this muscle, frozen at compose time. */
  history_8wk_avg: number;
  source:
    | "literature_default"
    | "literature_adjusted_up"
    | "literature_with_ramp_floor";
  rationale: string;
};

export type VolumeRampRecipe = {
  /** Week 1 multiplier vs MEV. */
  start_pct: number;
  /** Peak (week 4) multiplier vs MEV. */
  peak_pct: number;
  /** Deload week multiplier vs MEV. */
  deload_pct: number;
};

export type VolumeCountingRules = {
  /** Secondary muscles count as 0.5 set per the exercise-muscles mapping. */
  secondary_set_factor: 0.5;
  warmup_excluded: true;
  /** History window used at compose time. */
  window_weeks: 8;
};

export type StrengthMuscleVolume = {
  counting_rules: VolumeCountingRules;
  ramp_recipe: VolumeRampRecipe;
  bands: Record<TargetedMuscleGroup, MuscleVolumeBand>;
  /** Strong exercise names not in EXERCISE_MUSCLES — visibility for taxonomy maintenance. */
  unmapped_exercises: string[];
};

// ── Daily-compute snapshot (read-time, not stored in plan_payload) ──────────

export type MuscleVolumeSnapshot = {
  computed_at: string; // ISO timestamp
  rolling_avg_8wk: Record<TargetedMuscleGroup, number>;
  current_week_to_date: Record<TargetedMuscleGroup, number>;
  weekly_history: Array<{
    week_start: string; // ISO YYYY-MM-DD (Sunday)
    volumes: Record<TargetedMuscleGroup, number>;
  }>;
  top_exercises_per_muscle: Record<
    TargetedMuscleGroup,
    Array<{ name: string; sets: number }>
  >;
};

// ── Brief flag family (consumed by Advice prompt) ───────────────────────────

export type MuscleVolumeFlag =
  | {
      kind: "below_mev_persistent";
      group: TargetedMuscleGroup;
      actual_8wk: number;
      mev: number;
    }
  | {
      kind: "below_mev_recent";
      group: TargetedMuscleGroup;
      actual_wtd: number;
      target_this_week: number;
      days_left: number;
    }
  | {
      kind: "near_mrv";
      group: TargetedMuscleGroup;
      actual_wtd: number;
      mrv: number;
    };
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add lib/data/types.ts
git commit -m "feat(types): add muscle-volume types for L39

- TargetedMuscleGroup + TARGETED_MUSCLE_GROUPS const (10 muscles)
- MuscleVolumeBand, VolumeRampRecipe, VolumeCountingRules
- StrengthMuscleVolume (additive optional field on plan_payload.strength)
- MuscleVolumeSnapshot (daily-compute return shape)
- MuscleVolumeFlag (brief flag union)

No behavior changes — type-only commit. plan_payload.strength.muscle_volume
is optional so legacy plans still type-check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: Add TARGET_GROUP_FOR_MUSCLE collapse map

**Files:**
- Modify: `lib/coach/exercise-muscles.ts` (add at end, before `EXERCISE_MUSCLES`'s closing)

- [ ] **Step 1: Add the collapse map**

Open `lib/coach/exercise-muscles.ts`. At the end of the file (after the last existing export, around line 279), append:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// MuscleId → TargetedMuscleGroup collapse map (Phase 2.5 / L39)
//
// Maps wger MuscleId values to the 10 RP-literature-aligned target groups.
// Brachialis collapses to Biceps; Soleus to Calves; FrontDelts, Serratus,
// Abs, Obliques have no target (tracked for adherence display only).
// ─────────────────────────────────────────────────────────────────────────────

import type { TargetedMuscleGroup } from "@/lib/data/types";

export const TARGET_GROUP_FOR_MUSCLE: Partial<
  Record<MuscleId, TargetedMuscleGroup>
> = {
  [MUSCLE_ID.Chest]: "Chest",
  [MUSCLE_ID.Lats]: "Lats",
  [MUSCLE_ID.Traps]: "Traps",
  [MUSCLE_ID.RearDelts]: "RearDelts",
  [MUSCLE_ID.Quads]: "Quads",
  [MUSCLE_ID.Hams]: "Hams",
  [MUSCLE_ID.Glutes]: "Glutes",
  [MUSCLE_ID.Biceps]: "Biceps",
  [MUSCLE_ID.Brachialis]: "Biceps", // collapses
  [MUSCLE_ID.Triceps]: "Triceps",
  [MUSCLE_ID.Calves]: "Calves",
  [MUSCLE_ID.Soleus]: "Calves", // collapses
  // FrontDelts, Serratus, Abs, Obliques intentionally absent
};
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/exercise-muscles.ts
git commit -m "feat(exercise-muscles): add TARGET_GROUP_FOR_MUSCLE collapse map

Maps the 16-muscle wger taxonomy down to the 10 RP-literature-aligned
target groups used by the muscle-volume composer. Brachialis collapses
to Biceps; Soleus collapses to Calves; FrontDelts/Serratus/Abs/Obliques
remain unmapped (tracked for display only, no MEV/MAV/MRV target).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Create volume-landmarks.ts (literature defaults + tier scaling)

**Files:**
- Create: `lib/coach/volume-landmarks.ts`

- [ ] **Step 1: Write the file**

Create `lib/coach/volume-landmarks.ts` with:

```ts
// lib/coach/volume-landmarks.ts
//
// Literature default MEV/MAV/MRV per targeted muscle group + tier scaling.
//
// Source: Renaissance Periodization Hypertrophy Volume Landmarks
// (Israetel et al.), cross-referenced against Schoenfeld 2017 & 2022
// meta-analyses for chest, back, quads dose-response data. These are
// field-best-practice consensus, NOT clinical-trial-validated thresholds.

import type {
  TargetedMuscleGroup,
  MuscleVolumeBand,
  VolumeRampRecipe,
  VolumeCountingRules,
} from "@/lib/data/types";

type LiteratureBand = Pick<MuscleVolumeBand, "mev" | "mav" | "mrv">;

const INTERMEDIATE: Record<TargetedMuscleGroup, LiteratureBand> = {
  Chest: { mev: 10, mav: [12, 20], mrv: 22 },
  Lats: { mev: 10, mav: [14, 22], mrv: 25 },
  Traps: { mev: 4, mav: [6, 12], mrv: 16 },
  RearDelts: { mev: 8, mav: [10, 20], mrv: 26 },
  Quads: { mev: 8, mav: [12, 18], mrv: 20 },
  Hams: { mev: 6, mav: [10, 16], mrv: 20 },
  Glutes: { mev: 4, mav: [6, 12], mrv: 16 },
  Biceps: { mev: 8, mav: [14, 20], mrv: 26 },
  Triceps: { mev: 6, mav: [10, 14], mrv: 18 },
  Calves: { mev: 8, mav: [12, 16], mrv: 20 },
};

const TIER_SCALAR: Record<"beginner" | "intermediate" | "advanced", number> = {
  beginner: 0.7,
  intermediate: 1.0,
  advanced: 1.2,
};

export const DEFAULT_RAMP_RECIPE: VolumeRampRecipe = {
  start_pct: 1.0,
  peak_pct: 1.4,
  deload_pct: 0.5,
};

export const DEFAULT_COUNTING_RULES: VolumeCountingRules = {
  secondary_set_factor: 0.5,
  warmup_excluded: true,
  window_weeks: 8,
};

/** Resolve the literature-default band for a muscle + training-age tier.
 *  Pre-history-adjustment: composeMuscleVolume applies the history rule
 *  on top of this. */
export function literatureBand(
  group: TargetedMuscleGroup,
  tier: "beginner" | "intermediate" | "advanced",
): LiteratureBand {
  const k = TIER_SCALAR[tier];
  const b = INTERMEDIATE[group];
  return {
    mev: Math.round(b.mev * k),
    mav: [Math.round(b.mav[0] * k), Math.round(b.mav[1] * k)],
    mrv: Math.round(b.mrv * k),
  };
}

/** Interpolate the per-week target as MEV × ramp_recipe(week).
 *  Weeks 1-4 linearly ramp from start_pct → peak_pct; week 5 is deload_pct.
 *  Weeks outside 1-5 (defensive: blocks may run longer) clamp to peak_pct. */
export function targetSetsForWeek(
  band: Pick<MuscleVolumeBand, "mev">,
  recipe: VolumeRampRecipe,
  weekOfBlock: number,
): number {
  if (weekOfBlock <= 0) return Math.round(band.mev * recipe.start_pct);
  if (weekOfBlock === 5) return Math.round(band.mev * recipe.deload_pct);
  if (weekOfBlock >= 5) return Math.round(band.mev * recipe.peak_pct);
  // Linear interpolation across weeks 1-4
  const t = (weekOfBlock - 1) / 3; // 0..1
  const pct = recipe.start_pct + (recipe.peak_pct - recipe.start_pct) * t;
  return Math.round(band.mev * pct);
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/volume-landmarks.ts
git commit -m "feat(coach): literature MEV/MAV/MRV defaults + tier scaling

New module owning:
- INTERMEDIATE defaults per the 10 targeted muscle groups (sourced from
  RP Hypertrophy Volume Landmarks, cross-checked vs Schoenfeld 2017/2022)
- TIER_SCALAR (beginner ×0.7, advanced ×1.2)
- DEFAULT_RAMP_RECIPE (1.0 → 1.4 over weeks 1-4; 0.5 deload week 5)
- DEFAULT_COUNTING_RULES (secondary 0.5×, no RIR filter)
- literatureBand(group, tier) — pure resolver
- targetSetsForWeek(band, recipe, week) — read-time ramp interpolator

Numbers are field-best-practice consensus, not clinical thresholds —
documented in file header.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: Create muscle-volume.ts (pure compute + gap eval)

**Files:**
- Create: `lib/coach/muscle-volume.ts`

- [ ] **Step 1: Write the file**

Create `lib/coach/muscle-volume.ts` with:

```ts
// lib/coach/muscle-volume.ts
//
// Pure compute layer for per-muscle weekly volume. Used by:
//   - plan-builder/compose-strength.ts (at compose time, 8wk baseline)
//   - lib/query/fetchers/muscleVolume.ts (read time, fresh snapshot)
//   - lib/morning/brief/flags.ts (gap evaluation for Advice prompt)

import {
  EXERCISE_MUSCLES,
  TARGET_GROUP_FOR_MUSCLE,
  normalizeExerciseName,
} from "@/lib/coach/exercise-muscles";
import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";
import type {
  TargetedMuscleGroup,
  MuscleVolumeBand,
  VolumeRampRecipe,
  MuscleVolumeFlag,
} from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";

export type WorkoutSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean;
};

export type WorkoutExercise = {
  name: string;
  sets: WorkoutSet[];
};

export type Workout = {
  date: string; // ISO YYYY-MM-DD
  exercises: WorkoutExercise[];
};

/**
 * Per-muscle weekly volume averaged over `windowDays`. Returns sets/wk.
 *
 * Counting rules (mirror DEFAULT_COUNTING_RULES):
 *   - warm-ups (set.warmup === true) excluded
 *   - sets with missing reps/kg excluded
 *   - primary muscles get 1 set per working set
 *   - secondary muscles get 0.5 set per working set
 *   - unmapped exercises silently contribute 0 (name surfaced separately)
 *   - muscles outside the 10 targeted groups contribute nothing
 *
 * @returns Map from TargetedMuscleGroup to average sets/wk (1 decimal).
 *          Also returns `unmapped_exercises: string[]` (deduped) for the
 *          composer to bake into plan_payload for taxonomy visibility.
 */
export function computeWeeklyMuscleVolume(
  workouts: Workout[],
  windowDays: number,
): {
  volumes: Record<TargetedMuscleGroup, number>;
  unmapped_exercises: string[];
} {
  const volumes = Object.fromEntries(
    TARGETED_MUSCLE_GROUPS.map((g) => [g, 0]),
  ) as Record<TargetedMuscleGroup, number>;

  const unmappedSet = new Set<string>();

  for (const w of workouts) {
    for (const ex of w.exercises) {
      const key = normalizeExerciseName(ex.name);
      const mapping = EXERCISE_MUSCLES[key];
      if (!mapping) {
        unmappedSet.add(ex.name);
        continue;
      }

      const workingSets = ex.sets.filter(
        (s) => !s.warmup && s.reps != null && s.reps > 0,
      );
      const setCount = workingSets.length;
      if (setCount === 0) continue;

      for (const muscleId of mapping.primary) {
        const group = TARGET_GROUP_FOR_MUSCLE[muscleId];
        if (group) volumes[group] += setCount;
      }
      for (const muscleId of mapping.secondary) {
        const group = TARGET_GROUP_FOR_MUSCLE[muscleId];
        if (group) volumes[group] += setCount * 0.5;
      }
    }
  }

  const weeks = windowDays / 7;
  for (const g of TARGETED_MUSCLE_GROUPS) {
    volumes[g] = Math.round((volumes[g] / weeks) * 10) / 10; // 1 decimal
  }

  return {
    volumes,
    unmapped_exercises: Array.from(unmappedSet).sort(),
  };
}

/**
 * Pure gap evaluator. Given a band + ramp + this-week-to-date + 8wk avg,
 * return any flags that fire. Caller (brief composer) ranks + truncates
 * to top-2 across all muscles.
 */
export function evaluateMuscleVolumeGap(
  group: TargetedMuscleGroup,
  actual_8wk: number,
  actual_wtd: number,
  band: MuscleVolumeBand,
  ramp_recipe: VolumeRampRecipe,
  currentBlockWeek: number,
  daysLeftInWeek: number,
  isTrainingDay: boolean,
  weekdayLabel: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun",
): MuscleVolumeFlag | null {
  const target_this_week = targetSetsForWeek(band, ramp_recipe, currentBlockWeek);

  // `near_mrv` — only on training days
  if (isTrainingDay && actual_wtd > band.mrv * 0.9) {
    return {
      kind: "near_mrv",
      group,
      actual_wtd,
      mrv: band.mrv,
    };
  }

  // `below_mev_persistent` — fires every brief while history is below MEV × 0.7
  if (actual_8wk < band.mev * 0.7) {
    return {
      kind: "below_mev_persistent",
      group,
      actual_8wk,
      mev: band.mev,
    };
  }

  // `below_mev_recent` — only on training days Thu/Fri/Sat (late-week rescue window)
  const lateWeek = weekdayLabel === "Thu" || weekdayLabel === "Fri" || weekdayLabel === "Sat";
  if (isTrainingDay && lateWeek && actual_wtd < target_this_week * 0.6) {
    return {
      kind: "below_mev_recent",
      group,
      actual_wtd,
      target_this_week,
      days_left: daysLeftInWeek,
    };
  }

  return null;
}

/**
 * Rank flags by urgency. near_mrv > below_mev_persistent > below_mev_recent.
 * Caller truncates to top N (typically 2) to prevent Advice prompt noise.
 */
export function rankMuscleVolumeFlags(
  flags: MuscleVolumeFlag[],
): MuscleVolumeFlag[] {
  const priority: Record<MuscleVolumeFlag["kind"], number> = {
    near_mrv: 3,
    below_mev_persistent: 2,
    below_mev_recent: 1,
  };
  return [...flags].sort((a, b) => priority[b.kind] - priority[a.kind]);
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Spot-check the compute function against synthetic data**

Write a quick scratch script `/tmp/check-muscle-volume.mts`:

```ts
import { computeWeeklyMuscleVolume } from "../lib/coach/muscle-volume.ts";

const fakeWorkouts = [
  {
    date: "2026-05-01",
    exercises: [
      {
        name: "Bench Press",
        sets: [
          { kg: 60, reps: 5, warmup: true },
          { kg: 100, reps: 5, warmup: false },
          { kg: 100, reps: 5, warmup: false },
          { kg: 100, reps: 5, warmup: false },
        ],
      },
      {
        name: "Face Pull",
        sets: [
          { kg: 20, reps: 12, warmup: false },
          { kg: 20, reps: 12, warmup: false },
        ],
      },
    ],
  },
];

const { volumes, unmapped_exercises } = computeWeeklyMuscleVolume(fakeWorkouts, 7);
console.log({ volumes, unmapped_exercises });
```

Run with the project's alias-loader:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types /tmp/check-muscle-volume.mts
```

Expected: `volumes.Chest === 3` (3 working sets of bench, primary chest), `volumes.RearDelts === 2` (2 working sets of face pull, primary rear delt), `volumes.Triceps === 1.5` (bench secondary, 3 × 0.5), `unmapped_exercises === []`. Delete the scratch file.

```bash
rm /tmp/check-muscle-volume.mts
```

- [ ] **Step 4: Commit**

```bash
git add lib/coach/muscle-volume.ts
git commit -m "feat(coach): muscle-volume pure compute + gap evaluation

New module owns the per-muscle volume math:
- computeWeeklyMuscleVolume(workouts, windowDays) — pure aggregation;
  primary 1.0 / secondary 0.5; warm-ups excluded; unmapped exercises
  surfaced for taxonomy maintenance.
- evaluateMuscleVolumeGap(...) — pure gap evaluator returning typed
  MuscleVolumeFlag | null. Three flag kinds: near_mrv (training days
  only), below_mev_persistent (always while < MEV × 0.7), below_mev_recent
  (training days Thu/Fri/Sat, late-week rescue window).
- rankMuscleVolumeFlags(flags) — pure priority sort.

Smoke-checked vs synthetic Bench + Face Pull workout; spot values match
spec (Chest=3, RearDelts=2, Triceps=1.5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.5: Wire `composeMuscleVolume` into `composeStrengthTemplate`

**Files:**
- Modify: `lib/coach/plan-builder/compose-strength.ts`

- [ ] **Step 1: Extend the composer signature + add composeMuscleVolume**

Open `lib/coach/plan-builder/compose-strength.ts`. At the top, expand the imports:

```ts
import type { IntakePayload, PlanPayload, TrainingBlock } from "@/lib/data/types";
```

Change to:

```ts
import type {
  IntakePayload,
  PlanPayload,
  TrainingBlock,
  StrengthMuscleVolume,
  MuscleVolumeBand,
  TargetedMuscleGroup,
} from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
import {
  literatureBand,
  DEFAULT_RAMP_RECIPE,
  DEFAULT_COUNTING_RULES,
} from "@/lib/coach/volume-landmarks";
import {
  computeWeeklyMuscleVolume,
  type Workout,
} from "@/lib/coach/muscle-volume";
```

Then update the `composeStrengthTemplate` signature and body. The current shape is:

```ts
export function composeStrengthTemplate(
  intake: IntakePayload,
  activeBlock: Pick<TrainingBlock, "primary_lift"> | null,
  recentE1RMs: RecentE1RMsForStrength,
): PlanPayload["strength"] {
  // ... existing body ...
  return {
    sessions_per_week: sessionsPerWeek,
    day_pattern: dayPattern,
    template_session_types: sessionTypes,
    weekly_volume_targets: composeVolumeTargets(intake, activeBlock?.primary_lift ?? null),
    progression_rule: composeProgressionRule(intake.training.training_age),
    notes: null,
  };
}
```

Change to:

```ts
export function composeStrengthTemplate(
  intake: IntakePayload,
  activeBlock: Pick<TrainingBlock, "primary_lift"> | null,
  recentE1RMs: RecentE1RMsForStrength,
  recentWorkouts: Workout[],
): PlanPayload["strength"] {
  const sessionsPerWeek = intake.training.sessions_per_week;
  const dayPattern = composeDayPattern(intake, sessionsPerWeek);
  const sessionTypes = Array.from(new Set(Object.values(dayPattern))) as Array<
    "Chest" | "Legs" | "Back" | "Mobility" | "REST"
  >;

  const muscle_volume = composeMuscleVolume(
    intake.training.training_age,
    recentWorkouts,
  );

  return {
    sessions_per_week: sessionsPerWeek,
    day_pattern: dayPattern,
    template_session_types: sessionTypes,
    weekly_volume_targets: composeVolumeTargets(
      intake,
      activeBlock?.primary_lift ?? null,
    ),
    progression_rule: composeProgressionRule(intake.training.training_age),
    notes: null,
    muscle_volume,
  };
}
```

At the bottom of the file, add the new `composeMuscleVolume` function:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// composeMuscleVolume — per-muscle MEV/MAV/MRV with history-adjustment.
//
// Adjustment rule per spec L39:
//   - history > MAV upper → raise band proportionally; source "literature_adjusted_up"
//   - history < MEV       → keep literature band as target, source "literature_with_ramp_floor"
//   - else                → literature defaults, source "literature_default"
//
// Sparseness fallback: if fewer than 12 workouts in window (~ 4 weeks),
// use literature defaults regardless of history.
// ─────────────────────────────────────────────────────────────────────────────

export function composeMuscleVolume(
  trainingAge: "beginner" | "intermediate" | "advanced",
  recentWorkouts: Workout[],
): StrengthMuscleVolume {
  const { volumes: history, unmapped_exercises } = computeWeeklyMuscleVolume(
    recentWorkouts,
    56, // 8 weeks
  );

  const sparseHistory = recentWorkouts.length < 12;

  const bands = {} as Record<TargetedMuscleGroup, MuscleVolumeBand>;

  for (const group of TARGETED_MUSCLE_GROUPS) {
    const lit = literatureBand(group, trainingAge);
    const h = history[group];

    if (sparseHistory) {
      bands[group] = {
        ...lit,
        history_8wk_avg: h,
        source: "literature_default",
        rationale: `${h} sets/wk over ${recentWorkouts.length} sessions — history sparse, using ${trainingAge} literature defaults pending more data.`,
      };
      continue;
    }

    if (h > lit.mav[1]) {
      const k = h / lit.mav[1];
      bands[group] = {
        mev: Math.round(lit.mev * k),
        mav: [Math.round(lit.mav[0] * k), Math.round(lit.mav[1] * k)],
        mrv: Math.round(lit.mrv * k),
        history_8wk_avg: h,
        source: "literature_adjusted_up",
        rationale: `8wk avg ${h} sets/wk exceeds literature MAV upper (${lit.mav[1]}); band raised ${Math.round((k - 1) * 100)}% from defaults.`,
      };
    } else if (h < lit.mev) {
      bands[group] = {
        ...lit,
        history_8wk_avg: h,
        source: "literature_with_ramp_floor",
        rationale: `8wk avg ${h} sets/wk is below ${trainingAge} MEV (${lit.mev}); coach will ramp gradually rather than jumping straight to MEV.`,
      };
    } else {
      bands[group] = {
        ...lit,
        history_8wk_avg: h,
        source: "literature_default",
        rationale: `8wk avg ${h} sets/wk in band; ${trainingAge} literature defaults apply.`,
      };
    }
  }

  return {
    counting_rules: DEFAULT_COUNTING_RULES,
    ramp_recipe: DEFAULT_RAMP_RECIPE,
    bands,
    unmapped_exercises,
  };
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: **typecheck FAILS** at this point because `plan-builder/index.ts` calls `composeStrengthTemplate` with 3 args, not 4. That's expected — Task 1.6 fixes it. Confirm the failure is exactly this and not something else:

```
lib/coach/plan-builder/index.ts:NN:NN - error TS2554: Expected 4 arguments, but got 3.
```

If you see *other* errors, stop and investigate before proceeding.

### Task 1.6: Refactor `fetchRecentE1RMs` + integrate workouts pass-through

**Files:**
- Modify: `lib/coach/plan-builder/index.ts`

- [ ] **Step 1: Refactor `fetchRecentE1RMs` to return both shapes**

Open `lib/coach/plan-builder/index.ts`. Find the existing `async function fetchRecentE1RMs(supabase, userId): Promise<RecentE1RMsForStrength>` at the bottom of the file.

Replace it with `fetchRecentWorkoutData` returning both `e1rms` and `workouts`:

```ts
import type { Workout } from "@/lib/coach/muscle-volume";

// ... (other imports stay) ...

async function fetchRecentWorkoutData(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ e1rms: RecentE1RMsForStrength; workouts: Workout[] }> {
  const eightWeeksAgo = new Date();
  eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 56);
  const since = eightWeeksAgo.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("workouts")
    .select(
      "date, exercises (name, sets:exercise_sets (kg, reps, warmup))",
    )
    .eq("user_id", userId)
    .gte("date", since);
  if (error) throw error;

  // Shape for muscle-volume composer
  const workouts: Workout[] = (data ?? []).map((w: any) => ({
    date: w.date,
    exercises: (w.exercises ?? []).map((e: any) => ({
      name: e.name,
      sets: (e.sets ?? []).map((s: any) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    })),
  }));

  // Existing e1RM extraction (preserve verbatim from the prior function)
  const regex: Record<keyof RecentE1RMsForStrength, RegExp> = {
    squat: /\b(back\s+squat|squat)\b/i,
    bench: /\b(bench\s+press|bench)\b/i,
    deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
    ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
  };

  const e1rms: RecentE1RMsForStrength = {
    squat: null,
    bench: null,
    deadlift: null,
    ohp: null,
  };

  for (const w of workouts) {
    for (const e of w.exercises) {
      const lift = (
        Object.entries(regex) as Array<[keyof RecentE1RMsForStrength, RegExp]>
      ).find(([, re]) => re.test(e.name))?.[0];
      if (!lift) continue;
      for (const s of e.sets) {
        if (s.warmup) continue;
        if (s.kg === null || s.reps === null) continue;
        if (s.reps > 12) continue;
        const e1rm = Math.round(s.kg * (1 + s.reps / 30));
        if (e1rms[lift] === null || e1rm > e1rms[lift]!) e1rms[lift] = e1rm;
      }
    }
  }

  return { e1rms, workouts };
}
```

- [ ] **Step 2: Update the call site to use the new function**

Find the existing `Promise.all` block at the top of `buildPlanPayload`. It contains:

```ts
fetchRecentE1RMs(supabase, userId),
```

Change the destructuring + call to:

```ts
const [profileRes, recentLogsRes, recentWorkoutData, activeBlockRes] = await Promise.all([
  supabase.from("profiles").select("name, age, height_cm").eq("user_id", userId).maybeSingle(),
  supabase.from("daily_logs").select("date, weight_kg, calories_eaten").eq("user_id", userId).order("date", { ascending: false }).limit(30),
  fetchRecentWorkoutData(supabase, userId),
  supabase.from("training_blocks").select("primary_lift").eq("user_id", userId).eq("status", "active").maybeSingle(),
]);
```

And at the `composeStrengthTemplate` call site, change:

```ts
const strength = composeStrengthTemplate(intake, activeBlock, recentE1RMs);
```

To:

```ts
const strength = composeStrengthTemplate(
  intake,
  activeBlock,
  recentWorkoutData.e1rms,
  recentWorkoutData.workouts,
);
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/plan-builder/compose-strength.ts lib/coach/plan-builder/index.ts
git commit -m "feat(coach): composeMuscleVolume + integrate into plan-builder

compose-strength.ts:
- New composeMuscleVolume(trainingAge, recentWorkouts) — history-adjustment
  rule per spec (raise band when above MAV upper, keep-with-ramp-floor
  when below MEV, literature defaults in band)
- Sparseness fallback (< 12 workouts → literature defaults)
- composeStrengthTemplate gains recentWorkouts: Workout[] input;
  plan_payload.strength now carries muscle_volume

plan-builder/index.ts:
- fetchRecentE1RMs → fetchRecentWorkoutData: single DB query, dual return
  ({ e1rms, workouts }). Avoids a second round-trip for the composer.

End-to-end: every new plan generated via the intake flow now writes
plan_payload.strength.muscle_volume.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.7: End-to-end smoke verification

**Files:** none (manual verification)

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected: server starts on http://localhost:3000, no errors in console.

- [ ] **Step 2: Generate a plan via the intake flow**

In a browser, navigate to http://localhost:3000/profile and confirm the "Generate plan" CTA exists. Click through the intake chat flow until you reach `propose_plan` → `commit_plan`.

- [ ] **Step 3: Inspect plan_payload in DB**

Open the Supabase dashboard (project `eopfwwergisvskxqvsqe`) → SQL Editor and run:

```sql
SELECT
  version,
  status,
  plan_payload->'strength'->'muscle_volume' AS muscle_volume
FROM athlete_profile_documents
WHERE status = 'active'
ORDER BY version DESC
LIMIT 1;
```

Expected: `muscle_volume` jsonb is non-null, contains `counting_rules`, `ramp_recipe`, `bands` (with all 10 muscle groups), and `unmapped_exercises` array.

- [ ] **Step 4: Verify each band has the expected fields**

In the same SQL session:

```sql
SELECT jsonb_object_keys(plan_payload->'strength'->'muscle_volume'->'bands') AS muscle
FROM athlete_profile_documents
WHERE status = 'active'
ORDER BY version DESC
LIMIT 1;
```

Expected: 10 rows — Chest, Lats, Traps, RearDelts, Quads, Hams, Glutes, Biceps, Triceps, Calves.

- [ ] **Step 5: Verify a representative band has all required fields**

```sql
SELECT plan_payload->'strength'->'muscle_volume'->'bands'->'RearDelts'
FROM athlete_profile_documents
WHERE status = 'active'
ORDER BY version DESC
LIMIT 1;
```

Expected: object with keys `mev`, `mav` (array of 2 numbers), `mrv`, `history_8wk_avg`, `source` (one of the 3 enum values), `rationale` (non-empty string).

- [ ] **Step 6: Verify legacy plans without muscle_volume still type-check**

```bash
npm run typecheck
```

Expected: zero output. (Optional field — old plans without muscle_volume don't break the type.)

### Task 1.8: Open PR 1

**Files:** none (git/gh only)

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/muscle-volume-data-model
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head feat/muscle-volume-data-model --title "feat(coach): per-muscle volume tracking data model + composer (L39 PR 1/5)" --body "$(cat <<'EOF'
## Summary

PR 1 of 5 for [L39 per-muscle volume tracking](docs/superpowers/specs/2026-05-14-per-muscle-volume-tracking-design.md). Lands the data model and pure compute layer; no user-visible UI changes yet. Follow-up PRs surface the new field in the plan card (PR 2), strength tab (PR 4), and morning brief (PR 5).

## What ships

- `TargetedMuscleGroup`, `MuscleVolumeBand`, `StrengthMuscleVolume`, snapshot, flag types
- `TARGET_GROUP_FOR_MUSCLE` collapse map (16 wger muscles → 10 RP-aligned groups)
- `lib/coach/volume-landmarks.ts` — literature defaults + tier scaling + ramp interpolator
- `lib/coach/muscle-volume.ts` — pure `computeWeeklyMuscleVolume` + `evaluateMuscleVolumeGap` + `rankMuscleVolumeFlags`
- `composeMuscleVolume` integrated into `composeStrengthTemplate`
- `fetchRecentE1RMs` → `fetchRecentWorkoutData` (single DB query, dual return)

## Verification

- `npm run typecheck` clean
- Smoke: generated a plan via intake; `plan_payload.strength.muscle_volume` populated with all 10 bands; representative band has all required fields
- Legacy plans (without muscle_volume) still type-check (optional field)

## Out of scope (later PRs)

- Plan card UI (PR 2)
- Profile-renderer parity (PR 2)
- Daily compute fetcher + hook (PR 3)
- Strength tab By-Muscle sub-tab (PR 4)
- Morning brief integration (PR 5)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Note the PR number for downstream PR descriptions**

```bash
gh pr view --json number,url | jq -r '"PR \(.number): \(.url)"'
```

Wait for merge before starting PR 2 or PR 3.

---

# PR 2 — Plan card UX + profile-renderer parity

**Branch:** `feat/muscle-volume-plan-card` (off main, after PR 1 merged)

**PR scope summary:** Render the new `muscle_volume` field in the plan-proposal card (collapsed summary + expandable details table) and on the `/profile` active-plan summary. Add `renderMuscleVolume` helper to the coach AI's system-prompt context (`SCHEMA_EXPLAINER`) so the coach can reference specific band numbers when asked. Legacy plans (no `muscle_volume` field) gracefully skip the new section.

### Task 2.0: Branch setup

- [ ] **Step 1: Switch to a fresh worktree off updated main**

```bash
git fetch origin main
```

In the session, invoke `EnterWorktree` with name `feat/muscle-volume-plan-card`. Verify HEAD is at the post-merge tip of main (which includes PR 1).

- [ ] **Step 2: Symlink node_modules + baseline typecheck**

```bash
ln -s ../../../node_modules node_modules
npm run typecheck
```

Expected: zero output.

### Task 2.1: Add muscle-volume section to PlanProposalCard

**Files:**
- Modify: `components/chat/PlanProposalCard.tsx` (inside `<PlanSection title="Strength template">`)

- [ ] **Step 1: Extend the Strength template section**

Open `components/chat/PlanProposalCard.tsx`. Find the existing `<PlanSection title="Strength template">` block (around line 237). After the existing `Object.entries(plan.strength.weekly_volume_targets).map(...)` block and before the `progression_rule` `<div>`, insert:

```tsx
{plan.strength.muscle_volume && (
  <MuscleVolumeSection
    muscleVolume={plan.strength.muscle_volume}
    currentBlockWeek={currentBlockWeek}
  />
)}
```

Then add the `currentBlockWeek` prop to the component signature. Find the `PlanProposalCard` component's prop type and add:

```tsx
type PlanProposalCardProps = {
  // ... existing props ...
  /** Current week within the active training block (1-5). Pass null if no
   *  active block — UI falls back to MAV midpoint with a note. */
  currentBlockWeek: number | null;
};
```

Then add the helper component at the bottom of the file (before any default export):

```tsx
import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";
import type { StrengthMuscleVolume, TargetedMuscleGroup } from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";

function MuscleVolumeSection({
  muscleVolume,
  currentBlockWeek,
}: {
  muscleVolume: StrengthMuscleVolume;
  currentBlockWeek: number | null;
}) {
  const nBelowMev = TARGETED_MUSCLE_GROUPS.filter(
    (g) => muscleVolume.bands[g].source === "literature_with_ramp_floor",
  ).length;
  const nRaised = TARGETED_MUSCLE_GROUPS.filter(
    (g) => muscleVolume.bands[g].source === "literature_adjusted_up",
  ).length;

  const summaryParts: string[] = [
    `${TARGETED_MUSCLE_GROUPS.length} muscles tracked`,
  ];
  if (nBelowMev > 0) {
    const names = TARGETED_MUSCLE_GROUPS.filter(
      (g) => muscleVolume.bands[g].source === "literature_with_ramp_floor",
    );
    summaryParts.push(
      nBelowMev <= 3
        ? `${nBelowMev} below MEV (${names.join(", ")})`
        : `${nBelowMev} below MEV`,
    );
  }
  if (nRaised > 0) {
    const names = TARGETED_MUSCLE_GROUPS.filter(
      (g) => muscleVolume.bands[g].source === "literature_adjusted_up",
    );
    summaryParts.push(
      nRaised <= 3
        ? `${nRaised} raised (${names.join(", ")})`
        : `${nRaised} raised`,
    );
  }
  if (nBelowMev === 0 && nRaised === 0) {
    summaryParts.push("all in band");
  }

  return (
    <details style={{ marginTop: 8 }}>
      <summary
        style={{
          cursor: "pointer",
          fontSize: 13,
          color: "var(--mc-text)",
          listStyle: "revert",
        }}
      >
        <strong>Muscle volume:</strong> {summaryParts.join(" · ")}
      </summary>
      <table
        style={{
          width: "100%",
          marginTop: 8,
          fontSize: 12,
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "var(--mc-text-muted)" }}>
            <th style={{ padding: "4px 8px" }}>Muscle</th>
            <th style={{ padding: "4px 8px" }}>8wk avg</th>
            <th style={{ padding: "4px 8px" }}>Band (MEV / MAV / MRV)</th>
            <th style={{ padding: "4px 8px" }}>This week</th>
            <th style={{ padding: "4px 8px" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {TARGETED_MUSCLE_GROUPS.map((g) => {
            const band = muscleVolume.bands[g];
            const thisWeekTarget =
              currentBlockWeek !== null
                ? targetSetsForWeek(band, muscleVolume.ramp_recipe, currentBlockWeek)
                : Math.round((band.mav[0] + band.mav[1]) / 2);
            const thisWeekLabel =
              currentBlockWeek !== null
                ? `${thisWeekTarget} (wk ${currentBlockWeek}/5)`
                : `${thisWeekTarget} (no block — MAV mid)`;
            const statusIcon =
              band.source === "literature_with_ramp_floor"
                ? "⚠"
                : band.source === "literature_adjusted_up"
                  ? "⬆"
                  : "🟢";
            const statusText =
              band.source === "literature_with_ramp_floor"
                ? "below MEV — coach will ramp"
                : band.source === "literature_adjusted_up"
                  ? "band raised from history"
                  : "in band";
            return (
              <tr key={g} title={band.rationale}>
                <td style={{ padding: "4px 8px" }}>{g}</td>
                <td style={{ padding: "4px 8px" }}>{band.history_8wk_avg}</td>
                <td style={{ padding: "4px 8px" }}>
                  {band.mev} / {band.mav[0]}-{band.mav[1]} / {band.mrv}
                </td>
                <td style={{ padding: "4px 8px" }}>{thisWeekLabel}</td>
                <td style={{ padding: "4px 8px" }}>
                  {statusIcon} {statusText}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
```

- [ ] **Step 2: Update callers of PlanProposalCard to pass currentBlockWeek**

Find every call site for `<PlanProposalCard ...>` (most likely in `app/coach/...` chat components). For each:

```bash
grep -rn "PlanProposalCard" components/ app/ --include="*.tsx" --include="*.ts" | grep -v "PlanProposalCard.tsx"
```

For each caller, pass `currentBlockWeek={null}` if the caller doesn't have block-week info. (Most chat-side callers don't — block week is a strength-tab concern.) Document the prop as nullable to make this safe.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Visual smoke**

```bash
npm run dev
```

In the browser, navigate to the coach chat that surfaces the most recent `propose_plan` result. Confirm:
- The Strength template section shows the new `Muscle volume:` summary row.
- Clicking the summary expands a table with 10 rows.
- Each row shows the band, this-week target, and a status icon.
- For legacy plans (without `muscle_volume`), the section is silently omitted.

- [ ] **Step 5: Commit**

```bash
git add components/chat/PlanProposalCard.tsx
# add any caller files modified in step 2
git commit -m "feat(plan-card): render muscle volume bands in Strength section

Adds a collapsed-by-default summary row showing 'N muscles tracked · M
below MEV · K raised', expanding via native <details> to a compact
5-column table (Muscle / 8wk avg / Band / This week / Status). This-week
target computed at render time via targetSetsForWeek + currentBlockWeek
prop; falls back to MAV midpoint when no active block.

Legacy plans without muscle_volume gracefully omit the section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Add renderMuscleVolume to profile-renderer

**Files:**
- Modify: `lib/coach/profile-renderer.ts`

- [ ] **Step 1: Add the renderer helper**

Open `lib/coach/profile-renderer.ts`. Add this import at the top:

```ts
import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";
import type { StrengthMuscleVolume } from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
```

Add this helper at the bottom of the file (before any default export):

```ts
/** Emit a markdown block for the coach AI's system prompt summarizing the
 *  per-muscle volume bands + this-week targets. Injected into the active-plan
 *  rendering used by `SCHEMA_EXPLAINER`. */
export function renderMuscleVolume(
  muscleVolume: StrengthMuscleVolume,
  currentBlockWeek: number | null,
): string {
  const lines: string[] = ["**Muscle volume (weekly sets/wk · band MEV/MAV/MRV):**"];
  for (const g of TARGETED_MUSCLE_GROUPS) {
    const band = muscleVolume.bands[g];
    const thisWeek =
      currentBlockWeek !== null
        ? targetSetsForWeek(band, muscleVolume.ramp_recipe, currentBlockWeek)
        : null;
    const status =
      band.source === "literature_with_ramp_floor"
        ? "⚠ below MEV — ramp gradually"
        : band.source === "literature_adjusted_up"
          ? `band raised from history (8wk avg ${band.history_8wk_avg})`
          : "in band";
    const weekStr = thisWeek !== null ? ` · this week target ${thisWeek}` : "";
    lines.push(
      `- ${g}: ${band.history_8wk_avg} actual · ${band.mev} / ${band.mav[0]}-${band.mav[1]} / ${band.mrv} · ${status}${weekStr}`,
    );
  }
  if (muscleVolume.unmapped_exercises.length > 0) {
    lines.push("");
    lines.push(
      `_Note: ${muscleVolume.unmapped_exercises.length} Strong exercises unmapped to muscle taxonomy (${muscleVolume.unmapped_exercises.slice(0, 5).join(", ")}${muscleVolume.unmapped_exercises.length > 5 ? "…" : ""}) — counted as 0 toward volume._`,
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 2: Inject into the active-plan rendering function**

Find the existing function in `profile-renderer.ts` that produces the active-plan summary (search for `## Active plan` or similar header that lands in `SCHEMA_EXPLAINER`). Typical pattern:

```ts
export function renderActivePlanSummary(plan: PlanPayload, ...) {
  // ... existing rendering ...
}
```

After the existing Strength section markdown emission, add:

```ts
if (plan.strength.muscle_volume) {
  sections.push(renderMuscleVolume(plan.strength.muscle_volume, currentBlockWeek));
}
```

(Adjust the variable name `sections` to match the actual accumulator the renderer uses — likely `lines.push` or `parts.push`.)

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Verify the SCHEMA_EXPLAINER output includes muscle volume**

Run a quick smoke test by calling the renderer directly from a scratch script:

```bash
cat > /tmp/check-renderer.mts << 'EOF'
import { renderActivePlanSummary } from "../lib/coach/profile-renderer.ts";
// ... construct a minimal PlanPayload with muscle_volume populated ...
// (use a recent plan_payload fetched from DB if available)
EOF
```

Or, simpler: navigate to the coach chat in dev and ask the coach a question that should reference muscle volume (e.g., "How much chest volume should I be doing?"). The coach should now have access to the band numbers and respond with specifics.

Delete the scratch file when done.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/profile-renderer.ts
git commit -m "feat(profile-renderer): inject muscle volume into SCHEMA_EXPLAINER

renderMuscleVolume(muscleVolume, currentBlockWeek) emits a compact
markdown block with each band + this-week target + status flag.
Injected into the active-plan rendering used by the coach AI's
system prompt, so the coach can quote specific MEV/MAV/MRV numbers
when asked (rather than hallucinating).

Legacy plans without muscle_volume skip the block silently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Surface in AthleteProfilePanel

**Files:**
- Modify: `components/profile/AthleteProfilePanel.tsx` (or whichever component shows the active plan summary on `/profile`)

- [ ] **Step 1: Find the active-plan summary section**

```bash
grep -rn "plan_payload\|active.*plan\|strength.*sessions_per_week" components/profile/ --include="*.tsx"
```

Identify the component that renders the active plan's strength summary on `/profile`.

- [ ] **Step 2: Add a compact muscle-volume summary**

In the identified component, after the existing strength summary (sessions/wk, day pattern), add:

```tsx
{activePlan.strength.muscle_volume && (() => {
  const mv = activePlan.strength.muscle_volume;
  const nBelowMev = TARGETED_MUSCLE_GROUPS.filter(
    (g) => mv.bands[g].source === "literature_with_ramp_floor",
  ).length;
  const nRaised = TARGETED_MUSCLE_GROUPS.filter(
    (g) => mv.bands[g].source === "literature_adjusted_up",
  ).length;
  const tone =
    nBelowMev > 0
      ? "needs attention"
      : nRaised > 0
        ? "band raised from history"
        : "all in band";
  return (
    <div style={{ marginTop: 8, fontSize: 13, color: "var(--mc-text-muted)" }}>
      Muscle volume: {TARGETED_MUSCLE_GROUPS.length} muscles · {tone}
      {nBelowMev > 0 ? ` · ${nBelowMev} below MEV` : ""}
      <a href="/strength?view=by_muscle" style={{ marginLeft: 8 }}>view details →</a>
    </div>
  );
})()}
```

Add the imports if not present:

```tsx
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Visual smoke**

```bash
npm run dev
```

Navigate to http://localhost:3000/profile. Confirm the new muscle-volume summary line appears under the active plan. The "view details" link points to `/strength?view=by_muscle` (which doesn't exist until PR 4 — leave it as a forward reference; clicking will land on the strength tab default view).

- [ ] **Step 5: Commit**

```bash
git add components/profile/AthleteProfilePanel.tsx
# (or whichever file you modified)
git commit -m "feat(profile-panel): surface muscle-volume summary on /profile

One-line summary under the active plan's strength section:
  'Muscle volume: 10 muscles · needs attention · 2 below MEV
   view details →'

Link targets /strength?view=by_muscle (PR 4 lands the destination).
Legacy plans without muscle_volume skip silently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: Open PR 2

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/muscle-volume-plan-card
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head feat/muscle-volume-plan-card --title "feat(plan-card): muscle volume display + profile-renderer parity (L39 PR 2/5)" --body "$(cat <<'EOF'
## Summary

PR 2 of 5 for [L39 per-muscle volume tracking](docs/superpowers/specs/2026-05-14-per-muscle-volume-tracking-design.md). Surfaces the `plan_payload.strength.muscle_volume` field added in PR 1 in three places:

1. **PlanProposalCard** — collapsed summary row + expandable 5-column table in the Strength template section
2. **profile-renderer** — `renderMuscleVolume` injected into SCHEMA_EXPLAINER so the coach AI can reference specific MEV/MAV/MRV numbers
3. **AthleteProfilePanel** — one-line summary on `/profile` with link to `/strength?view=by_muscle`

## Depends on

PR 1 (data model + composer) must be merged first.

## Verification

- `npm run typecheck` clean
- Visual review on a coach chat with a recent propose_plan — summary row + expanded table render correctly
- `/profile` shows the new summary line
- Legacy plans (no muscle_volume) gracefully omit all new UI

## Out of scope (later PRs)

- Daily compute fetcher + hook (PR 3)
- Strength tab By-Muscle sub-tab (PR 4) — this PR's "view details" link target
- Morning brief integration (PR 5)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 3 — Daily compute fetcher + hook + invalidation

**Branch:** `feat/muscle-volume-fetcher` (off main, after PR 1 merged — parallelizable with PR 2)

**PR scope summary:** Adds the read-time daily compute layer. New TanStack Query fetcher (server + browser variants), hook, query key family, and mutation-invalidation patches. No UI consumer yet (PR 4 lands that). Morning brief composer (PR 5) imports the pure compute directly and bypasses this fetcher.

### Task 3.0: Branch setup

- [ ] **Step 1: Worktree off updated main**

```bash
git fetch origin main
```

Invoke `EnterWorktree` with name `feat/muscle-volume-fetcher`. Verify HEAD is post-PR-1.

- [ ] **Step 2: Symlink + typecheck baseline**

```bash
ln -s ../../../node_modules node_modules
npm run typecheck
```

Expected: zero output.

### Task 3.1: Extend query keys

**Files:**
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Add the muscleVolume key family**

Open `lib/query/keys.ts`. Add to the `queryKeys` export:

```ts
export const queryKeys = {
  // ... existing key families ...
  muscleVolume: {
    all: (userId: string) => ["muscleVolume", userId] as const,
    snapshot: (userId: string, today: string) =>
      ["muscleVolume", userId, "snapshot", today] as const,
  },
};
```

(`today` is the caller's tz-resolved YYYY-MM-DD — keying on it causes auto-refresh at midnight.)

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add lib/query/keys.ts
git commit -m "feat(query): add muscleVolume key family

- queryKeys.muscleVolume.all(userId) — prefix for invalidations
- queryKeys.muscleVolume.snapshot(userId, today) — per-day snapshot key

Today-keyed so the snapshot auto-refreshes at midnight in the user's tz.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Create the fetcher (server + browser variants)

**Files:**
- Create: `lib/query/fetchers/muscleVolume.ts`

- [ ] **Step 1: Write the fetcher**

Create `lib/query/fetchers/muscleVolume.ts`:

```ts
// lib/query/fetchers/muscleVolume.ts
//
// Two variants (server + browser) sharing the same select string + return
// shape. RLS enforces per-user scoping at both layers. The brief composer
// in app/api/chat/morning/recommendation/route.ts also uses the server
// variant (bypassing the client cache — it runs in a route handler).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeWeeklyMuscleVolume,
  type Workout,
} from "@/lib/coach/muscle-volume";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
import type {
  MuscleVolumeSnapshot,
  TargetedMuscleGroup,
} from "@/lib/data/types";
import { EXERCISE_MUSCLES, normalizeExerciseName, TARGET_GROUP_FOR_MUSCLE } from "@/lib/coach/exercise-muscles";

const SELECT = "date, exercises (name, sets:exercise_sets (kg, reps, warmup))";

/** Server-side fetcher used by Server Components (via makeServerQueryClient)
 *  AND by the morning-brief route handler. */
export async function fetchMuscleVolumeServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<MuscleVolumeSnapshot> {
  const since = isoMinusDays(today, 56);
  const { data, error } = await supabase
    .from("workouts")
    .select(SELECT)
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: true });
  if (error) throw error;
  return buildSnapshot(data ?? [], today);
}

/** Browser fetcher used by useMuscleVolume hook. */
export async function fetchMuscleVolumeBrowser(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<MuscleVolumeSnapshot> {
  const since = isoMinusDays(today, 56);
  const { data, error } = await supabase
    .from("workouts")
    .select(SELECT)
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: true });
  if (error) throw error;
  return buildSnapshot(data ?? [], today);
}

/** Pure assembly: convert raw rows → snapshot. Exported for tests / scripts. */
export function buildSnapshot(
  rawWorkouts: Array<{ date: string; exercises: any }>,
  today: string,
): MuscleVolumeSnapshot {
  const workouts: Workout[] = rawWorkouts.map((w) => ({
    date: w.date,
    exercises: (w.exercises ?? []).map((e: any) => ({
      name: e.name,
      sets: (e.sets ?? []).map((s: any) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    })),
  }));

  const weekStart = previousSunday(today); // Sunday on or before today

  const { volumes: rolling_avg_8wk } = computeWeeklyMuscleVolume(workouts, 56);

  // Week-to-date totals: filter to current week, then call with windowDays=7
  // (the /7 divisor in the helper means returned value === total for the week)
  const currentWeekWorkouts = workouts.filter((w) => w.date >= weekStart);
  const { volumes: current_week_to_date } = computeWeeklyMuscleVolume(
    currentWeekWorkouts,
    7,
  );

  // Per-week history: 8 weeks back, oldest first
  const weekly_history: MuscleVolumeSnapshot["weekly_history"] = [];
  for (let i = 8; i >= 1; i--) {
    const ws = isoMinusDays(weekStart, (i - 1) * 7);
    const wsEnd = isoPlusDays(ws, 7);
    const inWeek = workouts.filter((w) => w.date >= ws && w.date < wsEnd);
    const { volumes } = computeWeeklyMuscleVolume(inWeek, 7);
    weekly_history.push({ week_start: ws, volumes });
  }

  // Top exercises per muscle (over the full 8wk window)
  const setsByMuscleByExercise = new Map<
    TargetedMuscleGroup,
    Map<string, number>
  >();
  for (const g of TARGETED_MUSCLE_GROUPS) {
    setsByMuscleByExercise.set(g, new Map());
  }

  for (const w of workouts) {
    for (const ex of w.exercises) {
      const mapping = EXERCISE_MUSCLES[normalizeExerciseName(ex.name)];
      if (!mapping) continue;
      const setCount = ex.sets.filter(
        (s) => !s.warmup && s.reps != null && s.reps > 0,
      ).length;
      if (setCount === 0) continue;
      for (const mid of mapping.primary) {
        const g = TARGET_GROUP_FOR_MUSCLE[mid];
        if (!g) continue;
        const map = setsByMuscleByExercise.get(g)!;
        map.set(ex.name, (map.get(ex.name) ?? 0) + setCount);
      }
      for (const mid of mapping.secondary) {
        const g = TARGET_GROUP_FOR_MUSCLE[mid];
        if (!g) continue;
        const map = setsByMuscleByExercise.get(g)!;
        map.set(ex.name, (map.get(ex.name) ?? 0) + setCount * 0.5);
      }
    }
  }

  const top_exercises_per_muscle = Object.fromEntries(
    TARGETED_MUSCLE_GROUPS.map((g) => {
      const sorted = Array.from(setsByMuscleByExercise.get(g)!.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, sets]) => ({ name, sets: Math.round(sets * 10) / 10 }));
      return [g, sorted];
    }),
  ) as MuscleVolumeSnapshot["top_exercises_per_muscle"];

  return {
    computed_at: new Date().toISOString(),
    rolling_avg_8wk,
    current_week_to_date,
    weekly_history,
    top_exercises_per_muscle,
  };
}

// ── ISO date helpers (no Date constructor in case of TZ-sensitive callers) ──

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoPlusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Returns the Sunday ON OR BEFORE the given ISO date. Sunday = day 0. */
function previousSunday(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0..6, Sunday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Spot-check the snapshot shape**

Create a scratch test script `/tmp/check-snapshot.mts`:

```ts
import { buildSnapshot } from "../lib/query/fetchers/muscleVolume.ts";

const today = "2026-05-14";
const fakeWorkouts = [
  {
    date: "2026-05-13", // current week (Sun)
    exercises: [
      {
        name: "Bench Press",
        sets: [
          { kg: 100, reps: 5, warmup: false },
          { kg: 100, reps: 5, warmup: false },
        ],
      },
    ],
  },
  {
    date: "2026-04-15", // 4 weeks back
    exercises: [
      {
        name: "Face Pull",
        sets: [
          { kg: 20, reps: 12, warmup: false },
          { kg: 20, reps: 12, warmup: false },
        ],
      },
    ],
  },
];

const snap = buildSnapshot(fakeWorkouts, today);
console.log("rolling_avg_8wk Chest:", snap.rolling_avg_8wk.Chest);
console.log("current_week_to_date Chest:", snap.current_week_to_date.Chest);
console.log("weekly_history length:", snap.weekly_history.length);
console.log(
  "top_exercises_per_muscle Chest:",
  snap.top_exercises_per_muscle.Chest,
);
```

Run:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types /tmp/check-snapshot.mts
```

Expected: `rolling_avg_8wk.Chest === 0.3` (2 sets / 8 weeks), `current_week_to_date.Chest === 2` (2 sets this week), `weekly_history.length === 8`, `top_exercises_per_muscle.Chest === [{ name: "Bench Press", sets: 2 }]`.

```bash
rm /tmp/check-snapshot.mts
```

- [ ] **Step 4: Commit**

```bash
git add lib/query/fetchers/muscleVolume.ts
git commit -m "feat(query): muscleVolume fetcher (server + browser)

Two variants sharing one select string + buildSnapshot pure assembly.
Snapshot carries:
- rolling_avg_8wk per muscle
- current_week_to_date per muscle (Sunday-anchored)
- 8 weeks of weekly_history (oldest-first; sparkline data)
- top_exercises_per_muscle (top 3 by sets in the window)

Date math uses ISO + setUTCDate to avoid timezone drift across the
server/browser boundary. Server variant also used by morning-brief
route handler (bypassing the client cache).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Create the hook

**Files:**
- Create: `lib/query/hooks/useMuscleVolume.ts`

- [ ] **Step 1: Write the hook**

Create `lib/query/hooks/useMuscleVolume.ts`:

```ts
// lib/query/hooks/useMuscleVolume.ts

"use client";

import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { fetchMuscleVolumeBrowser } from "@/lib/query/fetchers/muscleVolume";
import { queryKeys } from "@/lib/query/keys";

/** Reads the per-muscle volume snapshot for the given user + day.
 *  `today` should be the user's tz-resolved ISO date (the strength
 *  page's server prefetch passes this through hydration). */
export function useMuscleVolume(userId: string, today: string) {
  return useQuery({
    queryKey: queryKeys.muscleVolume.snapshot(userId, today),
    queryFn: async () => {
      const supabase = createSupabaseBrowserClient();
      return fetchMuscleVolumeBrowser(supabase, userId, today);
    },
    staleTime: 5 * 60_000, // 5 minutes
  });
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add lib/query/hooks/useMuscleVolume.ts
git commit -m "feat(query): useMuscleVolume hook

TanStack Query hook over fetchMuscleVolumeBrowser. 5-minute staleTime
balances mid-day workout updates vs. thrash during strength-tab
browsing. Day-keyed query key auto-refreshes at user-midnight.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.4: Add invalidation to Strong CSV upload mutation

**Files:**
- Modify: the Strong CSV upload mutation hook (verify path)

- [ ] **Step 1: Locate the existing mutation**

```bash
grep -rn "invalidateQueries.*workouts\|/api/ingest/strong" lib/query/ components/ --include="*.ts" --include="*.tsx" | head
```

Identify the hook(s) that call the Strong CSV upload endpoint and currently invalidate workouts/dailyLogs.

- [ ] **Step 2: Add muscleVolume invalidation**

In each identified mutation's `onSuccess`, add an extra `invalidateQueries` call alongside the existing ones. Example:

```ts
onSuccess: async () => {
  await queryClient.invalidateQueries({ queryKey: queryKeys.workouts.all(userId) });
  await queryClient.invalidateQueries({ queryKey: queryKeys.muscleVolume.all(userId) });
  // ... other existing invalidations ...
},
```

Import the keys if not already:

```ts
import { queryKeys } from "@/lib/query/keys";
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add lib/query/hooks/useStrongUpload.ts
# (or whichever files were modified)
git commit -m "feat(query): invalidate muscleVolume on Strong CSV upload

Existing Strong CSV upload mutation already invalidates workouts /
dailyLogs. Add muscleVolume.all(userId) to the chain so per-muscle
snapshots refresh after a new CSV is processed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.5: Add invalidation to manual workout-log mutation

**Files:**
- Modify: the mutation hook for logging a workout manually (verify path)

- [ ] **Step 1: Locate the mutation**

```bash
grep -rn "from.*workouts.*insert\|/api/.*workouts\|logWorkout\|saveWorkout" lib/query/ components/ --include="*.ts" --include="*.tsx" | head
```

- [ ] **Step 2: Add invalidation (same pattern as Task 3.4)**

```ts
await queryClient.invalidateQueries({ queryKey: queryKeys.muscleVolume.all(userId) });
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add # (the modified mutation file)
git commit -m "feat(query): invalidate muscleVolume on manual workout log

Same one-line patch as Strong-CSV invalidation: manual workout logging
now refreshes the per-muscle snapshot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.6: End-to-end smoke verification

- [ ] **Step 1: Start dev server, log a fake workout via the manual path**

```bash
npm run dev
```

Navigate to the strength tab. Add a workout (or use existing manual-add UI). After the mutation completes, check the browser network tab — the `muscleVolume` query should refetch.

- [ ] **Step 2: Verify the hook output via React DevTools**

Install React DevTools if not already. Find a component that uses `useMuscleVolume` (won't be wired into UI until PR 4 — for now, add a temporary debug component in `app/strength/page.tsx` like):

```tsx
// TEMPORARY — for PR 3 smoke only, removed in PR 4
const today = new Date().toISOString().slice(0, 10);
const { data } = useMuscleVolume(userId, today);
console.log("muscle volume snapshot:", data);
```

Confirm the snapshot logs to the browser console with all expected fields. Remove the debug code before PR.

### Task 3.7: Open PR 3

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin feat/muscle-volume-fetcher
gh pr create --base main --head feat/muscle-volume-fetcher --title "feat(query): muscleVolume fetcher + hook + invalidation (L39 PR 3/5)" --body "$(cat <<'EOF'
## Summary

PR 3 of 5 for [L39 per-muscle volume tracking](docs/superpowers/specs/2026-05-14-per-muscle-volume-tracking-design.md). Adds the daily-compute layer (no UI consumer yet — PR 4 lands the strength-tab consumer; PR 5 wires the brief composer to the server variant directly).

## What ships

- `lib/query/keys.ts` — `muscleVolume.all(userId)` + `muscleVolume.snapshot(userId, today)` key family
- `lib/query/fetchers/muscleVolume.ts` — server + browser variants over one `select` string; `buildSnapshot` pure assembly returning rolling avg, week-to-date, 8wk weekly_history (sparkline data), and top exercises per muscle
- `lib/query/hooks/useMuscleVolume.ts` — TanStack Query hook with 5min staleTime
- Invalidation patches on the Strong CSV upload mutation and the manual workout-log mutation

## Depends on

PR 1 (data model + composer) must be merged first.

## Verification

- `npm run typecheck` clean
- Smoke: logged a workout, confirmed `muscleVolume` refetch in network tab, snapshot shape matches `MuscleVolumeSnapshot` type
- Spot-check via scratch script on synthetic workouts; expected counts match

## Out of scope (later PRs)

- Strength tab By-Muscle sub-tab (PR 4) — first UI consumer
- Morning brief integration (PR 5) — uses the server variant directly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 4 — Strength tab "By Muscle" sub-tab

**Branch:** `feat/muscle-volume-strength-tab` (off main, after PRs 1 + 3 merged)

**PR scope summary:** Adds a new `?view=by_muscle` sub-tab on `/strength` with: body-map header colored by status (in-band / below-MEV / near-MRV / over-MRV), mode toggle (8wk avg vs. week-to-date), per-muscle rows with band-overlay tracks + sparklines + top contributors, drill-down drawer per muscle, and a collapsed footer for non-targeted muscles. Pre-plan empty state shows actuals only with a "regenerate plan" CTA.

### Task 4.0: Branch setup

- [ ] **Step 1: Worktree off post-PR-1+3 main**

```bash
git fetch origin main
```

Invoke `EnterWorktree` with name `feat/muscle-volume-strength-tab`. Verify HEAD is post-PR-3.

- [ ] **Step 2: Symlink + baseline typecheck**

```bash
ln -s ../../../node_modules node_modules
npm run typecheck
```

### Task 4.1: Add view tab state + URL sync to StrengthClient

**Files:**
- Modify: `components/strength/StrengthClient.tsx`
- Modify: `app/strength/page.tsx`

- [ ] **Step 1: Locate the existing StrengthClient + page**

```bash
grep -rn "StrengthClient\|/strength" app/strength/ components/strength/ --include="*.tsx" | head -10
```

- [ ] **Step 2: Add view tab state**

In `StrengthClient.tsx`, add at the top:

```tsx
"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
// ... existing imports ...
import { ByMuscleView } from "@/components/strength/by-muscle/ByMuscleView";

export function StrengthClient({ /* existing props */ userId, today }: StrengthClientProps) {
  const sp = useSearchParams();
  const view = (sp?.get("view") === "by_muscle" ? "by_muscle" : "by_date") as
    | "by_date"
    | "by_muscle";
  const router = useRouter();
  const pathname = usePathname();

  const setView = (next: "by_date" | "by_muscle") => {
    const params = new URLSearchParams(sp ?? undefined);
    if (next === "by_date") params.delete("view");
    else params.set("view", next);
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <>
      <ViewTabs current={view} onChange={setView} />
      {view === "by_date" ? (
        <ExistingByDateView /* existing children */ />
      ) : (
        <ByMuscleView userId={userId} today={today} />
      )}
    </>
  );
}

function ViewTabs({ current, onChange }: {
  current: "by_date" | "by_muscle";
  onChange: (v: "by_date" | "by_muscle") => void;
}) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      <button
        role="tab"
        aria-selected={current === "by_date"}
        onClick={() => onChange("by_date")}
        style={{
          padding: "6px 12px",
          background: current === "by_date" ? "var(--mc-tab-active)" : "transparent",
          color: "var(--mc-text)",
          border: "1px solid var(--mc-border)",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        By Date
      </button>
      <button
        role="tab"
        aria-selected={current === "by_muscle"}
        onClick={() => onChange("by_muscle")}
        style={{
          padding: "6px 12px",
          background: current === "by_muscle" ? "var(--mc-tab-active)" : "transparent",
          color: "var(--mc-text)",
          border: "1px solid var(--mc-border)",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        By Muscle
      </button>
    </div>
  );
}
```

Adjust the JSX to match the existing layout — the goal is to wrap the existing By-Date children inside a conditional and add the By-Muscle alternative.

- [ ] **Step 3: Pass `today` from the page**

In `app/strength/page.tsx`, find where `StrengthClient` is rendered. Add the `today` and `userId` props:

```tsx
import { todayInUserTz } from "@/lib/time";

// ... in the page component ...
const today = todayInUserTz();
const user = await getCurrentUser();

// ... existing prefetch logic ...

return (
  <HydrationBoundary state={dehydrate(queryClient)}>
    <StrengthClient
      /* existing props */
      userId={user.id}
      today={today}
    />
  </HydrationBoundary>
);
```

- [ ] **Step 4: Add server prefetch for muscleVolume**

In `app/strength/page.tsx`, alongside the existing `Promise.all` prefetches, add:

```tsx
import { fetchMuscleVolumeServer } from "@/lib/query/fetchers/muscleVolume";
import { queryKeys } from "@/lib/query/keys";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const supabase = createSupabaseServerClient();
const today = todayInUserTz();

await Promise.all([
  // ... existing prefetches ...
  queryClient.prefetchQuery({
    queryKey: queryKeys.muscleVolume.snapshot(user.id, today),
    queryFn: () => fetchMuscleVolumeServer(supabase, user.id, today),
  }),
]);
```

- [ ] **Step 5: Run typecheck (expect ByMuscleView unresolved)**

```bash
npm run typecheck
```

Expected: error on `ByMuscleView` import — not yet created. Continue to Task 4.2 to fix.

### Task 4.2: Create ByMuscleView shell

**Files:**
- Create: `components/strength/by-muscle/ByMuscleView.tsx`

- [ ] **Step 1: Write the shell**

Create `components/strength/by-muscle/ByMuscleView.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useMuscleVolume } from "@/lib/query/hooks/useMuscleVolume";
import { useActivePlan } from "@/lib/query/hooks/useActivePlan"; // verify path
import { useActiveBlockWeek } from "@/lib/query/hooks/useActiveBlockWeek"; // verify path
import { TARGETED_MUSCLE_GROUPS, type TargetedMuscleGroup } from "@/lib/data/types";
import { MuscleVolumeBodyMap } from "@/components/strength/by-muscle/MuscleVolumeBodyMap";
import { MuscleVolumeRow } from "@/components/strength/by-muscle/MuscleVolumeRow";
import { MuscleContributorDrawer } from "@/components/strength/by-muscle/MuscleContributorDrawer";

export function ByMuscleView({
  userId,
  today,
}: {
  userId: string;
  today: string;
}) {
  const [mode, setMode] = useState<"avg_8wk" | "week_to_date">("avg_8wk");
  const [drawerMuscle, setDrawerMuscle] = useState<TargetedMuscleGroup | null>(null);

  const { data: snapshot, isLoading: snapLoading, isError: snapError } =
    useMuscleVolume(userId, today);
  const { data: activePlan } = useActivePlan(userId); // returns the active athlete_profile_documents row
  const { data: blockInfo } = useActiveBlockWeek(userId); // { weekOfBlock: 1-5 | null }

  if (snapError) {
    return <div role="alert">Failed to load muscle volume. Refresh to retry.</div>;
  }
  if (snapLoading || !snapshot) {
    return <div>Loading muscle volume…</div>;
  }

  const muscleVolume = activePlan?.plan_payload?.strength?.muscle_volume ?? null;
  const currentBlockWeek = blockInfo?.weekOfBlock ?? null;

  // Sort order: below_mev > over_mrv > near_mrv > in_band
  const sortedMuscles = [...TARGETED_MUSCLE_GROUPS].sort((a, b) => {
    const aRank = rankMuscle(a, snapshot, muscleVolume);
    const bRank = rankMuscle(b, snapshot, muscleVolume);
    return aRank - bRank;
  });

  return (
    <div>
      {muscleVolume === null && (
        <div
          role="status"
          style={{
            padding: 12,
            background: "var(--mc-surface)",
            border: "1px solid var(--mc-border)",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          🛠 Volume targets not yet prescribed. Per-muscle bands need an
          active plan with muscle_volume.{" "}
          <a href="/onboarding">Generate plan</a> or{" "}
          <a href="/profile">regenerate existing plan</a>.
        </div>
      )}

      <MuscleVolumeBodyMap snapshot={snapshot} muscleVolume={muscleVolume} />

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <button
          onClick={() => setMode("avg_8wk")}
          aria-pressed={mode === "avg_8wk"}
          style={modeToggleStyle(mode === "avg_8wk")}
        >
          8wk avg
        </button>
        <button
          onClick={() => setMode("week_to_date")}
          aria-pressed={mode === "week_to_date"}
          style={modeToggleStyle(mode === "week_to_date")}
        >
          Week to date
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {sortedMuscles.map((g) => (
          <MuscleVolumeRow
            key={g}
            group={g}
            snapshot={snapshot}
            band={muscleVolume?.bands[g] ?? null}
            rampRecipe={muscleVolume?.ramp_recipe ?? null}
            currentBlockWeek={currentBlockWeek}
            mode={mode}
            onSelect={() => setDrawerMuscle(g)}
          />
        ))}
      </div>

      <NonTargetedFooter snapshot={snapshot} />

      {drawerMuscle && (
        <MuscleContributorDrawer
          group={drawerMuscle}
          snapshot={snapshot}
          onClose={() => setDrawerMuscle(null)}
        />
      )}
    </div>
  );
}

function rankMuscle(
  g: TargetedMuscleGroup,
  snapshot: { rolling_avg_8wk: Record<TargetedMuscleGroup, number> },
  muscleVolume: { bands: Record<TargetedMuscleGroup, { mev: number; mav: [number, number]; mrv: number }> } | null,
): number {
  if (!muscleVolume) return 1; // no plan — neutral ordering
  const actual = snapshot.rolling_avg_8wk[g];
  const band = muscleVolume.bands[g];
  if (actual < band.mev) return 0; // most actionable
  if (actual > band.mrv) return 1;
  if (actual > band.mav[1]) return 2;
  return 3;
}

function modeToggleStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: active ? "var(--mc-tab-active)" : "transparent",
    color: "var(--mc-text)",
    border: "1px solid var(--mc-border)",
    borderRadius: 6,
    cursor: "pointer",
  };
}

function NonTargetedFooter({
  snapshot,
}: {
  snapshot: any; // typed in real impl; keep compact for plan
}) {
  // Non-targeted muscles: FrontDelts, Serratus, Abs, Obliques, Brachialis, Soleus
  // Snapshot doesn't track these (the compute only sums into targeted groups),
  // so this footer just informs the user they're tracked-but-not-targeted.
  return (
    <details style={{ marginTop: 24, color: "var(--mc-text-muted)" }}>
      <summary style={{ cursor: "pointer", fontSize: 13 }}>
        6 muscles tracked but not targeted (compound work covers them)
      </summary>
      <div style={{ padding: 12, fontSize: 12 }}>
        FrontDelts / Serratus / Abs / Obliques / Brachialis / Soleus —
        these muscles get stimulus from compound lifts but lack literature-grade
        MEV/MAV/MRV consensus. No prescription is generated; volume is implied
        from your bench / OHP / row / squat / deadlift work.
      </div>
    </details>
  );
}
```

- [ ] **Step 2: Verify `useActivePlan` and `useActiveBlockWeek` exist (or create stubs)**

```bash
grep -rn "useActivePlan\|useActiveBlockWeek" lib/query/hooks/ --include="*.ts" --include="*.tsx"
```

If either doesn't exist, create a minimal hook in `lib/query/hooks/` that reads from `athlete_profile_documents` (active row) and `training_blocks` (active row, week computed from start date). Pattern matches existing hooks in this folder.

- [ ] **Step 3: Run typecheck (expect `MuscleVolumeBodyMap`, `MuscleVolumeRow`, `MuscleContributorDrawer` unresolved)**

```bash
npm run typecheck
```

Continue to Tasks 4.3-4.5 to land the missing components.

### Task 4.3: MuscleVolumeBodyMap

**Files:**
- Create: `components/strength/by-muscle/MuscleVolumeBodyMap.tsx`

- [ ] **Step 1: Write the component**

Create `components/strength/by-muscle/MuscleVolumeBodyMap.tsx`:

```tsx
"use client";

import {
  MUSCLE_ID,
  MUSCLE_VIEW,
  type MuscleId,
  TARGET_GROUP_FOR_MUSCLE,
} from "@/lib/coach/exercise-muscles";
import type {
  MuscleVolumeSnapshot,
  StrengthMuscleVolume,
  TargetedMuscleGroup,
} from "@/lib/data/types";

type Status = "no_plan" | "below_mev" | "in_band" | "near_mrv" | "over_mrv" | "not_targeted";

const STATUS_FILL: Record<Status, string> = {
  no_plan: "var(--mc-band-neutral, #4a5568)",
  below_mev: "var(--mc-band-low, #5b7185)",
  in_band: "var(--mc-band-ok, #4ade80)",
  near_mrv: "var(--mc-band-amber, #fbbf24)",
  over_mrv: "var(--mc-band-over, #ef4444)",
  not_targeted: "var(--mc-band-neutral, #4a5568)",
};

export function MuscleVolumeBodyMap({
  snapshot,
  muscleVolume,
}: {
  snapshot: MuscleVolumeSnapshot;
  muscleVolume: StrengthMuscleVolume | null;
}) {
  // For each MuscleId, compute its display status.
  const muscleStatuses = new Map<MuscleId, Status>();
  for (const idStr of Object.values(MUSCLE_ID)) {
    const mid = idStr as MuscleId;
    const group = TARGET_GROUP_FOR_MUSCLE[mid];
    if (!group) {
      muscleStatuses.set(mid, "not_targeted");
      continue;
    }
    if (!muscleVolume) {
      muscleStatuses.set(mid, "no_plan");
      continue;
    }
    const actual = snapshot.rolling_avg_8wk[group];
    const band = muscleVolume.bands[group];
    if (actual < band.mev) {
      muscleStatuses.set(mid, "below_mev");
    } else if (actual > band.mrv) {
      muscleStatuses.set(mid, "over_mrv");
    } else if (actual > band.mav[1]) {
      muscleStatuses.set(mid, "near_mrv");
    } else {
      muscleStatuses.set(mid, "in_band");
    }
  }

  // The existing muscle-map component from PRs #57/#58 accepts a fill-color
  // function per MuscleId. Re-use it here. (Verify exact import path.)
  // The minimum interface this component needs is something like:
  //   <MuscleMap fillByMuscle={(mid) => STATUS_FILL[muscleStatuses.get(mid) ?? "not_targeted"]} />
  //
  // If the existing muscle-map component doesn't accept a custom fill function,
  // wrap or extend it. The wger SVG overlays in public/anatomy/ can be re-tinted
  // via the same CSS mask-image pattern (see 2026-05-13-strength-muscle-map plan
  // for the technique).

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
      <div style={{ display: "flex", gap: 24 }}>
        <BodyView
          side="front"
          muscleStatuses={muscleStatuses}
        />
        <BodyView
          side="back"
          muscleStatuses={muscleStatuses}
        />
      </div>
    </div>
  );
}

function BodyView({
  side,
  muscleStatuses,
}: {
  side: "front" | "back";
  muscleStatuses: Map<MuscleId, Status>;
}) {
  // Existing pattern from components/strength/anatomy/BodyView.tsx (PR #57):
  //   - <img src="/anatomy/{side}.svg" /> as silhouette
  //   - one <MuscleOverlay /> per muscle whose MUSCLE_VIEW matches `side`
  //
  // For each overlay, the fill color is STATUS_FILL[muscleStatuses.get(mid)].
  // Hover/tap on an overlay shows the band info in a popover (see existing
  // MuscleOverlay popover from PR #57 — extend its content to show
  // "actual N sets/wk · band MEV-MAV-MRV · status").
  //
  // For the spec-style fast path, this component renders a placeholder
  // until paired with the actual extension of MuscleOverlay.
  return (
    <div style={{ position: "relative", width: 200, height: 400 }}>
      <img
        src={`/anatomy/${side}.svg`}
        alt={`${side} body`}
        style={{ width: "100%", height: "100%" }}
      />
      {Array.from(muscleStatuses.entries())
        .filter(([mid]) => MUSCLE_VIEW[mid] === side)
        .map(([mid, status]) => (
          <div
            key={mid}
            className="muscle-overlay"
            style={{
              position: "absolute",
              inset: 0,
              maskImage: `url(/anatomy/main-${mid}.svg)`,
              WebkitMaskImage: `url(/anatomy/main-${mid}.svg)`,
              maskSize: "100% 100%",
              WebkitMaskSize: "100% 100%",
              background: STATUS_FILL[status],
              opacity: 0.7,
              pointerEvents: "none",
            }}
            aria-label={`Muscle ${mid}: ${status}`}
          />
        ))}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: typecheck passes (or remaining errors are unresolved Row + Drawer imports from Task 4.2, fixed in Tasks 4.4 + 4.5).

- [ ] **Step 3: Commit (deferred — combine with Tasks 4.4 + 4.5 for a coherent commit)**

Don't commit yet; will commit together after Tasks 4.4 and 4.5.

### Task 4.4: MuscleVolumeRow

**Files:**
- Create: `components/strength/by-muscle/MuscleVolumeRow.tsx`

- [ ] **Step 1: Write the component**

Create `components/strength/by-muscle/MuscleVolumeRow.tsx`:

```tsx
"use client";

import type {
  MuscleVolumeBand,
  MuscleVolumeSnapshot,
  TargetedMuscleGroup,
  VolumeRampRecipe,
} from "@/lib/data/types";
import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";

export function MuscleVolumeRow({
  group,
  snapshot,
  band,
  rampRecipe,
  currentBlockWeek,
  mode,
  onSelect,
}: {
  group: TargetedMuscleGroup;
  snapshot: MuscleVolumeSnapshot;
  band: MuscleVolumeBand | null;
  rampRecipe: VolumeRampRecipe | null;
  currentBlockWeek: number | null;
  mode: "avg_8wk" | "week_to_date";
  onSelect: () => void;
}) {
  const actual =
    mode === "avg_8wk"
      ? snapshot.rolling_avg_8wk[group]
      : snapshot.current_week_to_date[group];

  const trackMax =
    band !== null ? Math.max(band.mrv * 1.1, actual * 1.1) : Math.max(actual * 1.5, 10);

  const thisWeekTarget =
    band !== null && rampRecipe !== null && currentBlockWeek !== null
      ? targetSetsForWeek(band, rampRecipe, currentBlockWeek)
      : null;

  const status = band
    ? actual < band.mev
      ? "⚠ below MEV"
      : actual > band.mrv
        ? "🟥 over MRV"
        : actual > band.mav[1]
          ? "🟧 near MRV"
          : "🟢 in band"
    : "no plan";

  const sparkValues = snapshot.weekly_history.map((w) => w.volumes[group]);
  const sparkMax = Math.max(1, ...sparkValues);

  const topContribs = snapshot.top_exercises_per_muscle[group] ?? [];

  return (
    <button
      onClick={onSelect}
      style={{
        textAlign: "left",
        padding: 12,
        background: "var(--mc-surface)",
        border: "1px solid var(--mc-border)",
        borderRadius: 8,
        color: "var(--mc-text)",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>{group}</strong>
        <span style={{ fontSize: 12, color: "var(--mc-text-muted)" }}>{status}</span>
      </div>

      <Track
        actual={actual}
        band={band}
        trackMax={trackMax}
      />

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12, color: "var(--mc-text-muted)" }}>
        <span>
          {mode === "avg_8wk" ? "8wk avg" : "This week"}: {actual} sets/wk
        </span>
        {thisWeekTarget !== null && (
          <span>
            Target wk {currentBlockWeek}/5: {thisWeekTarget}
          </span>
        )}
      </div>

      <Sparkline values={sparkValues} max={sparkMax} />

      {topContribs.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--mc-text-muted)" }}>
          Top: {topContribs.map((e) => `${e.name} (${e.sets})`).join(" · ")}
        </div>
      )}
    </button>
  );
}

function Track({
  actual,
  band,
  trackMax,
}: {
  actual: number;
  band: { mev: number; mav: [number, number]; mrv: number } | null;
  trackMax: number;
}) {
  const pct = (v: number) => `${Math.min(100, (v / trackMax) * 100)}%`;

  return (
    <div
      style={{
        position: "relative",
        height: 18,
        background: "var(--mc-track-bg, #1f2937)",
        borderRadius: 4,
      }}
    >
      {band !== null && (
        <>
          {/* MAV range highlight */}
          <div
            style={{
              position: "absolute",
              left: pct(band.mav[0]),
              right: `calc(100% - ${pct(band.mav[1])})`,
              top: 0,
              bottom: 0,
              background: "var(--mc-band-ok, #4ade80)",
              opacity: 0.2,
            }}
          />
          {/* MEV marker */}
          <div
            style={{
              position: "absolute",
              left: pct(band.mev),
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--mc-band-low, #5b7185)",
            }}
            aria-label={`MEV ${band.mev}`}
          />
          {/* MAV markers */}
          <div
            style={{
              position: "absolute",
              left: pct(band.mav[0]),
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--mc-band-ok, #4ade80)",
            }}
            aria-label={`MAV lower ${band.mav[0]}`}
          />
          <div
            style={{
              position: "absolute",
              left: pct(band.mav[1]),
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--mc-band-ok, #4ade80)",
            }}
            aria-label={`MAV upper ${band.mav[1]}`}
          />
          {/* MRV marker */}
          <div
            style={{
              position: "absolute",
              left: pct(band.mrv),
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--mc-band-over, #ef4444)",
            }}
            aria-label={`MRV ${band.mrv}`}
          />
        </>
      )}
      {/* Actual dot */}
      <div
        style={{
          position: "absolute",
          left: `calc(${pct(actual)} - 6px)`,
          top: 3,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: "var(--mc-text)",
        }}
        aria-label={`Actual ${actual}`}
      />
    </div>
  );
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  // Simple 8-week sparkline as inline SVG. Width 120px, height 24px.
  const W = 120;
  const H = 24;
  const step = W / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${H - (v / max) * H}`);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ marginTop: 6 }}
      aria-label={`8-week history sparkline; latest ${values[values.length - 1]}`}
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="var(--mc-text-muted, #9ca3af)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: passes (or only the Drawer import remains unresolved).

### Task 4.5: MuscleContributorDrawer

**Files:**
- Create: `components/strength/by-muscle/MuscleContributorDrawer.tsx`

- [ ] **Step 1: Write the drawer**

Create `components/strength/by-muscle/MuscleContributorDrawer.tsx`:

```tsx
"use client";

import type { MuscleVolumeSnapshot, TargetedMuscleGroup } from "@/lib/data/types";

export function MuscleContributorDrawer({
  group,
  snapshot,
  onClose,
}: {
  group: TargetedMuscleGroup;
  snapshot: MuscleVolumeSnapshot;
  onClose: () => void;
}) {
  const contribs = snapshot.top_exercises_per_muscle[group] ?? [];
  const totalSets = contribs.reduce((a, b) => a + b.sets, 0);

  return (
    <div
      role="dialog"
      aria-label={`${group} volume contributors`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxHeight: "70vh",
          overflowY: "auto",
          background: "var(--mc-surface)",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: 24,
          color: "var(--mc-text)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>{group}</h2>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--mc-text)", fontSize: 24, cursor: "pointer" }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <p style={{ color: "var(--mc-text-muted)", marginBottom: 16 }}>
          Top exercise contributors over the last 8 weeks. Counted by working
          sets per the {snapshot.rolling_avg_8wk[group]} sets/wk rolling avg.
        </p>

        {contribs.length === 0 && (
          <p>No exercises mapped to {group} in the last 8 weeks.</p>
        )}

        {contribs.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 0" }}>Exercise</th>
                <th style={{ textAlign: "right", padding: "8px 0" }}>Sets (8wk)</th>
                <th style={{ textAlign: "right", padding: "8px 0" }}>% of {group}</th>
              </tr>
            </thead>
            <tbody>
              {contribs.map((c) => (
                <tr key={c.name}>
                  <td style={{ padding: "6px 0" }}>{c.name}</td>
                  <td style={{ textAlign: "right" }}>{c.sets}</td>
                  <td style={{ textAlign: "right" }}>
                    {totalSets > 0 ? `${Math.round((c.sets / totalSets) * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: Visual smoke**

```bash
npm run dev
```

Navigate to http://localhost:3000/strength?view=by_muscle. Confirm:
- View tab toggle works (URL updates to `?view=by_muscle`)
- Body map renders both views (front + back) with muscles colored by status
- Per-muscle rows appear, sorted by actionability
- Sparklines render (8 data points each)
- Top contributors row shows under each muscle
- Tapping a row opens the drawer with contributor table
- Non-targeted footer expands to show the 6 non-targeted muscles
- For users without an active plan with muscle_volume, the "🛠 Volume targets not yet prescribed" banner appears

- [ ] **Step 4: Commit (combined with Tasks 4.3, 4.4)**

```bash
git add components/strength/by-muscle/ components/strength/StrengthClient.tsx app/strength/page.tsx
git commit -m "feat(strength): By-Muscle sub-tab

New /strength?view=by_muscle sub-tab landing the L39 visualization.

Components:
- ByMuscleView: page-level shell with view tabs, mode toggle (8wk avg /
  week-to-date), per-muscle rows sorted by actionability, drawer, footer
- MuscleVolumeBodyMap: extends the PR #57/#58 muscle map with
  status-coloring (in-band green / below-MEV cool / near-MRV amber /
  over-MRV red / not-targeted neutral)
- MuscleVolumeRow: horizontal track with MEV/MAV/MRV marks + actual dot;
  8-week sparkline; this-week target; top-3 contributors line
- MuscleContributorDrawer: bottom sheet with full per-exercise breakdown
  for the selected muscle

Server prefetches muscleVolume snapshot in app/strength/page.tsx.
Tab state persists in URL. Empty-state CTA when active plan lacks
muscle_volume.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4.6: Open PR 4

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin feat/muscle-volume-strength-tab
gh pr create --base main --head feat/muscle-volume-strength-tab --title "feat(strength): By-Muscle sub-tab — body map + per-muscle rows (L39 PR 4/5)" --body "$(cat <<'EOF'
## Summary

PR 4 of 5 for [L39 per-muscle volume tracking](docs/superpowers/specs/2026-05-14-per-muscle-volume-tracking-design.md). Adds the strength-tab "By Muscle" sub-tab — the main self-coaching dashboard surface.

## Depends on

PRs 1 + 3 merged.

## Verification

- `npm run typecheck` clean
- Visual smoke on `/strength?view=by_muscle`: body map colored, per-muscle rows sorted by actionability, sparklines render, drawer opens on tap, footer expands, empty-state CTA appears for users without active plan muscle_volume

## Out of scope (final PR)

- Morning brief muscle-volume flags (PR 5)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 5 — Morning brief integration

**Branch:** `feat/muscle-volume-morning-brief` (off main, after PRs 1 + 3 merged — parallelizable with PR 4)

**PR scope summary:** Adds `MuscleVolumeFlag` evaluation to the morning brief composer. Flags route into the existing Advice prompt (no new brief block). Inline static indicator appears on the session block when below-MEV flags fire on a training day. Top-2 ranking keeps the Advice prompt focused.

### Task 5.0: Branch setup

- [ ] **Step 1: Worktree off post-PRs-1+3 main**

```bash
git fetch origin main
```

Invoke `EnterWorktree` with name `feat/muscle-volume-morning-brief`. Verify HEAD is post-PR-3.

- [ ] **Step 2: Symlink + baseline typecheck**

```bash
ln -s ../../../node_modules node_modules
npm run typecheck
```

### Task 5.1: Add flag evaluation to flags.ts

**Files:**
- Modify: `lib/morning/brief/flags.ts`

- [ ] **Step 1: Locate flags.ts and inspect existing patterns**

```bash
grep -n "type.*Flag\|export.*flag" lib/morning/brief/flags.ts | head -20
```

Note the existing flag type union (GLP-1, alcohol, injuries, sleep efficiency, missed protein). The new flags slot in as a parallel family.

- [ ] **Step 2: Add muscle volume flag evaluation**

Append to `lib/morning/brief/flags.ts`:

```ts
import {
  evaluateMuscleVolumeGap,
  rankMuscleVolumeFlags,
} from "@/lib/coach/muscle-volume";
import type {
  MuscleVolumeFlag,
  MuscleVolumeSnapshot,
  StrengthMuscleVolume,
} from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";

/** Evaluate all 10 targeted muscle groups; return the top 2 flags ranked by
 *  urgency. Caller embeds these in the Advice prompt + session-block UI. */
export function evaluateMuscleVolumeGapsForBrief(args: {
  snapshot: MuscleVolumeSnapshot;
  muscleVolume: StrengthMuscleVolume | null;
  currentBlockWeek: number | null;
  isTrainingDay: boolean;
  todayWeekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  daysLeftInWeek: number;
}): MuscleVolumeFlag[] {
  const {
    snapshot,
    muscleVolume,
    currentBlockWeek,
    isTrainingDay,
    todayWeekday,
    daysLeftInWeek,
  } = args;

  if (!muscleVolume) return [];

  const allFlags: MuscleVolumeFlag[] = [];
  for (const g of TARGETED_MUSCLE_GROUPS) {
    const flag = evaluateMuscleVolumeGap(
      g,
      snapshot.rolling_avg_8wk[g],
      snapshot.current_week_to_date[g],
      muscleVolume.bands[g],
      muscleVolume.ramp_recipe,
      currentBlockWeek ?? 3, // default to mid-block if no active block
      daysLeftInWeek,
      isTrainingDay,
      todayWeekday,
    );
    if (flag) allFlags.push(flag);
  }

  return rankMuscleVolumeFlags(allFlags).slice(0, 2);
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add lib/morning/brief/flags.ts
git commit -m "feat(brief): evaluateMuscleVolumeGapsForBrief

Wraps the pure evaluateMuscleVolumeGap + rankMuscleVolumeFlags into a
brief-aware adapter. Iterates all 10 targeted groups, ranks results,
truncates to top 2. Returns [] when active plan lacks muscle_volume.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.2: Extend Advice prompt template

**Files:**
- Modify: the Advice prompt template file (verify location)

- [ ] **Step 1: Find the Advice prompt**

```bash
grep -rn "Advice\|advice_prompt\|systemPrompt.*coach" lib/morning/ --include="*.ts" | head -20
```

The Advice prompt is the Haiku 4.5 call that produces the brief's coaching narrative. Find the template/builder function.

- [ ] **Step 2: Extend the prompt with muscle-volume context**

In the prompt-building function, add a conditional section. Roughly:

```ts
function buildAdvicePrompt(args: {
  // ... existing fields ...
  muscleVolumeFlags: MuscleVolumeFlag[];
  muscleVolume: StrengthMuscleVolume | null;
}): string {
  // ... existing prompt construction ...

  if (args.muscleVolumeFlags.length > 0 && args.muscleVolume) {
    lines.push("");
    lines.push("=== MUSCLE VOLUME CONTEXT ===");
    for (const flag of args.muscleVolumeFlags) {
      const band = args.muscleVolume.bands[flag.group];
      lines.push(
        `- ${flag.group}: ${describeFlag(flag)}. Band: MEV ${band.mev} / MAV ${band.mav[0]}-${band.mav[1]} / MRV ${band.mrv}. Plan source: ${band.source}. Rationale: ${band.rationale}`,
      );
    }
    lines.push("");
    lines.push("Coaching directives:");
    lines.push("- For below_mev_* flags: suggest ONE concrete exercise + set count to close the gap today. Fit into the planned session (e.g., face-pulls before cooldown). Cap at +3 sets per gap.");
    lines.push("- For near_mrv flags: recommend dropping the LAST exercise/set of today's session. Frame as autoregulation, not failure.");
  }

  return lines.join("\n");
}

function describeFlag(flag: MuscleVolumeFlag): string {
  switch (flag.kind) {
    case "below_mev_persistent":
      return `8wk avg ${flag.actual_8wk} sets/wk is below MEV (${flag.mev}) — systematic under-training`;
    case "below_mev_recent":
      return `week-to-date ${flag.actual_wtd} sets vs target ${flag.target_this_week} this week (${flag.days_left} days left to rescue)`;
    case "near_mrv":
      return `week-to-date ${flag.actual_wtd} sets approaching MRV (${flag.mrv}) — consider backing off`;
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add # (the Advice prompt file)
git commit -m "feat(brief): muscle-volume context in Advice prompt

Conditionally appends a 'MUSCLE VOLUME CONTEXT' section to the Haiku
Advice prompt when at least one flag fires. Each flag renders with:
- group + flag-kind-specific actual vs target description
- band (MEV / MAV / MRV)
- plan source + rationale (so the AI knows why this band exists)

Plus two coaching directives:
- below_mev_*: suggest ONE concrete exercise + cap at +3 sets/gap
- near_mrv: drop the last exercise of today's session, frame as autoregulation

No additional Haiku cost — same one Advice call, longer prompt.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.3: Wire snapshot + flag eval into recommendation route

**Files:**
- Modify: `app/api/chat/morning/recommendation/route.ts`

- [ ] **Step 1: Inspect the route**

```bash
cat app/api/chat/morning/recommendation/route.ts | head -80
```

Identify where the existing flag collection happens and where the Advice prompt is built.

- [ ] **Step 2: Add muscle volume context fetch + eval**

In the route handler, after the existing snapshot fetches but before the Advice call:

```ts
import { fetchMuscleVolumeServer } from "@/lib/query/fetchers/muscleVolume";
import { evaluateMuscleVolumeGapsForBrief } from "@/lib/morning/brief/flags";

// ... after activePlan + training_week fetched ...

const muscleVolume = activePlan?.plan_payload?.strength?.muscle_volume ?? null;

let muscleVolumeFlags: MuscleVolumeFlag[] = [];
let mvSnapshot: MuscleVolumeSnapshot | null = null;

if (muscleVolume) {
  mvSnapshot = await fetchMuscleVolumeServer(supabase, userId, today);
  const sessionToday = trainingWeek?.session_plan?.[todayWeekday] ?? "REST";
  const isTrainingDay = sessionToday !== "REST" && sessionToday !== "Mobility";
  const daysLeftInWeek = computeDaysLeftInWeek(today); // existing helper or inline

  muscleVolumeFlags = evaluateMuscleVolumeGapsForBrief({
    snapshot: mvSnapshot,
    muscleVolume,
    currentBlockWeek,
    isTrainingDay,
    todayWeekday,
    daysLeftInWeek,
  });
}

// ... pass muscleVolumeFlags + muscleVolume into buildAdvicePrompt ...
const advice = await haikuAdviceCall(buildAdvicePrompt({
  // ... existing args ...
  muscleVolumeFlags,
  muscleVolume,
}));
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add app/api/chat/morning/recommendation/route.ts
git commit -m "feat(brief): fetch + evaluate muscle volume in recommendation route

Server-side snapshot fetch (bypassing client cache — route handler).
Flag evaluation runs only when active plan has muscle_volume. Flags
flow into buildAdvicePrompt for the Haiku call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.4: Extend MorningBriefCard ui type with volume_gaps

**Files:**
- Modify: `lib/morning/brief/index.ts` (or wherever `MorningBriefCard` is defined)

- [ ] **Step 1: Find the type**

```bash
grep -rn "MorningBriefCard\|export type.*Brief" lib/morning/ --include="*.ts" | head
```

- [ ] **Step 2: Extend the type with volume_gaps**

In the `MorningBriefCard` ui shape (session block specifically), add:

```ts
session: {
  // ... existing fields ...
  /** Top-2 muscle volume flags that fire today. Empty when none fire
   *  or when active plan lacks muscle_volume. Rendered as a static
   *  inline indicator under the session details. */
  volume_gaps?: Array<{
    group: TargetedMuscleGroup;
    actual: number;
    target: number;
    label: "below_mev" | "near_mrv";
  }>;
};
```

(Add the import for `TargetedMuscleGroup` if not present.)

- [ ] **Step 3: Populate volume_gaps in the route**

In the recommendation route, when constructing the brief's `ui.session`:

```ts
const sessionUi = {
  // ... existing fields ...
  volume_gaps: muscleVolumeFlags
    .filter((f) => f.kind !== "below_mev_recent" || isTrainingDay) // already filtered, defensive
    .map((f) => {
      if (f.kind === "near_mrv") {
        return {
          group: f.group,
          actual: f.actual_wtd,
          target: f.mrv,
          label: "near_mrv" as const,
        };
      }
      if (f.kind === "below_mev_persistent") {
        return {
          group: f.group,
          actual: f.actual_8wk,
          target: f.mev,
          label: "below_mev" as const,
        };
      }
      return {
        group: f.group,
        actual: f.actual_wtd,
        target: f.target_this_week,
        label: "below_mev" as const,
      };
    }),
};
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/brief/index.ts app/api/chat/morning/recommendation/route.ts
git commit -m "feat(brief): volume_gaps on MorningBriefCard.session

Static inline data for the session-block volume indicator. Carries the
top-2 flags as flat {group, actual, target, label} shapes — UI doesn't
need to discriminate flag-kind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.5: Render inline indicator in session block UI

**Files:**
- Modify: the brief UI session block component (verify path)

- [ ] **Step 1: Find the session-block component**

```bash
grep -rn "session.*block\|MorningBriefSession\|kind.*morning_brief" components/ --include="*.tsx" | head
```

- [ ] **Step 2: Render volume_gaps when present**

Inside the session-block component, after the session-details rendering:

```tsx
{session.volume_gaps && session.volume_gaps.length > 0 && (
  <div
    role="note"
    style={{
      marginTop: 12,
      padding: 10,
      background: "var(--mc-warn-surface, #2a2510)",
      border: "1px solid var(--mc-warn-border, #fbbf24)",
      borderRadius: 6,
      fontSize: 13,
    }}
  >
    ⚠ <strong>Volume gaps:</strong>{" "}
    {session.volume_gaps
      .map((g) => `${g.group} (${g.actual}/wk vs ${g.target} ${g.label === "below_mev" ? "MEV" : "MRV"})`)
      .join(", ")}
    {" — coach details below."}
  </div>
)}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 4: Visual smoke**

```bash
npm run dev
```

Trigger a fresh morning brief (or use the existing retry endpoint). For the test user — who has known volume gaps on RearDelts/Glutes by inspection of their workout history — the new banner should appear under the session block, and the Advice block should reference the gaps with specific suggestions.

- [ ] **Step 5: Commit**

```bash
git add # (session-block component)
git commit -m "feat(brief): inline volume-gaps indicator on session block

Renders a static amber banner under the session details when the brief
carries volume_gaps. Format: '⚠ Volume gaps: RearDelts (4/wk vs 8 MEV),
Glutes (2/wk vs 4 MEV) — coach details below.'

Pointer toward the Advice block which carries the AI-generated
prescription.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.6: End-to-end smoke

- [ ] **Step 1: Verify the brief generation path works**

Either wait for a real morning brief cycle, or trigger a manual regeneration via the existing retry endpoint:

```bash
curl -sS -X POST http://localhost:3000/api/chat/morning/retry-brief \
  -H "Content-Type: application/json" \
  -d '{}'  # adjust if auth/body needed
```

- [ ] **Step 2: Check the brief's `ui.session.volume_gaps`**

Query the DB:

```sql
SELECT ui->'session'->'volume_gaps'
FROM chat_messages
WHERE kind = 'morning_brief'
ORDER BY created_at DESC
LIMIT 1;
```

Expected: jsonb array with 0-2 entries.

- [ ] **Step 3: Check the Advice prose**

```sql
SELECT content
FROM chat_messages
WHERE kind = 'morning_brief'
ORDER BY created_at DESC
LIMIT 1;
```

If volume_gaps fired, the Advice block should reference specific muscles + exercise suggestions.

### Task 5.7: Open PR 5

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin feat/muscle-volume-morning-brief
gh pr create --base main --head feat/muscle-volume-morning-brief --title "feat(brief): muscle-volume gap flags + Advice prompt + session indicator (L39 PR 5/5)" --body "$(cat <<'EOF'
## Summary

PR 5 of 5 for [L39 per-muscle volume tracking](docs/superpowers/specs/2026-05-14-per-muscle-volume-tracking-design.md). Final PR — wires the per-muscle volume context into the morning brief.

## What ships

- `evaluateMuscleVolumeGapsForBrief` adapter in flags.ts (10-muscle eval, top-2 ranking)
- Advice prompt extension with muscle-volume context + coaching directives (below_mev_*: suggest +sets capped at 3; near_mrv: autoregulate)
- Snapshot fetch + flag eval in `/api/chat/morning/recommendation/route.ts`
- `volume_gaps` field on `MorningBriefCard.session`
- Inline indicator banner on the session block

## Depends on

PRs 1 + 3 merged.

## Verification

- `npm run typecheck` clean
- Triggered fresh morning brief for the test user; `ui.session.volume_gaps` populated; Advice block references specific muscles + concrete exercise suggestions
- No regression on briefs for users without muscle_volume (volume_gaps stays empty, banner hidden, Advice prompt skips the new section)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Final verification (after all 5 PRs merge)

- [ ] **Step 1: Pull main**

```bash
git checkout main
git pull --ff-only origin main
```

- [ ] **Step 2: Full typecheck**

```bash
npm run typecheck
```

Expected: zero output.

- [ ] **Step 3: End-to-end happy path**

1. Generate a plan via `/onboarding`. Confirm `plan_payload.strength.muscle_volume` populates.
2. Inspect the PlanProposalCard at commit time. Confirm summary row + expandable table.
3. Visit `/profile`. Confirm the muscle-volume summary line + link.
4. Visit `/strength?view=by_muscle`. Confirm body map + per-muscle rows + drawer + footer.
5. Trigger a fresh morning brief. Confirm Advice references muscle volume; banner renders on session block when below-MEV flags fire.

- [ ] **Step 4: Regression check — user without muscle_volume**

If any plan in DB still lacks `muscle_volume` (legacy), confirm:
- Plan card silently omits the new section
- `/profile` summary line silently omits
- Strength tab By-Muscle shows the "🛠 regenerate plan" CTA + actuals only
- Morning brief Advice prompt skips the muscle-volume section
