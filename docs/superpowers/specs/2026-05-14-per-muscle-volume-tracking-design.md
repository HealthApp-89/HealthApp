# Per-muscle volume tracking — MEV / MAV / MRV

**Date:** 2026-05-14
**Status:** Design — pending user sign-off before implementation plan
**Spec source:** Phase 2 Tier-2 deferred item L39 from [2026-05-11-athlete-profile-phase-2-design.md](2026-05-11-athlete-profile-phase-2-design.md)
**Phase positioning:** Phase 2.5 — extends the plan-builder without entering Phase 3 (drift detection)

## Problem statement

Phase 2's plan-builder prescribes weekly volume **per primary lift** (Squat, Bench, Deadlift, OHP). Real strength coaches think in **per-muscle volume** because:

- The same lift contributes to multiple muscles (bench → chest + front delts + triceps), so per-lift counts double-count and under-count simultaneously.
- Stimulus accumulates differently per muscle: 14 chest sets/week from bench + incline + dips is mid-MAV; 14 rear-delt sets/week requires face-pulls + rows because no compound covers them.
- Under-trained muscles (rear delts, glutes) are silent failure modes in compound-heavy programs — invisible to per-lift tracking, visible to per-muscle tracking.

The literature anchor is Renaissance Periodization's **Hypertrophy Volume Landmarks**: MEV (Minimum Effective Volume — the floor for growth), MAV (Maximum Adaptive Volume — the optimal range), MRV (Maximum Recoverable Volume — the ceiling before fatigue eats gains). These are not clinical-trial-validated thresholds; they are field-best-practice consensus from Israetel et al., cross-referenced against Schoenfeld 2017/2022 meta-analyses for the muscles where dose-response data exists (chest, back, quads).

## Goal

Add per-muscle volume targets (MEV/MAV/MRV) to `plan_payload.strength`, surface them in three places:

1. **Plan card** — review the prescribed bands at plan-proposal time.
2. **Morning brief** — flag gaps in the Advice prompt; inline indicator on the session block.
3. **Strength tab — "By Muscle" sub-tab** — body-map viz + per-muscle rows with sparkline history.

## Decisions locked

| Decision | Value | Rationale |
|---|---|---|
| **Target taxonomy** | Hybrid (γ): 10 targeted muscle groups, 16 tracked | Literature-aligned targets, full-fidelity viz, preserves rear-delt distinction (most under-trained group) |
| **Targeted groups** | Chest, Lats, Traps, RearDelts, Quads, Hams, Glutes, Biceps, Triceps, Calves | Brachialis → Biceps; Soleus → Calves; FrontDelts/Serratus/Abs/Obliques tracked but not targeted |
| **Defaults source** | Literature-anchored, history-adjusted (C) | Literature is teaching authority; history is adaptation reality; gap-surfacing is the point |
| **Periodization** | Static band + ramp recipe (γ) | Band stored per-muscle; per-week target computed at read-time via recipe |
| **Adjustment rule** | History above MAV upper → raise band proportionally; below MEV → keep band, flag for gradual ramp; else literature defaults | Matches how RP coaches actually behave |
| **Counting** | Direct = 1 set, secondary = 0.5 set per exercise-muscles mapping; warm-ups excluded; no RIR filter | Strong CSV doesn't carry per-set RIR; rule must be enforceable |
| **History window** | 8 weeks (fixed) | Matches existing e1RM window; ~24 sessions = stable baseline |
| **Schema migration** | None | `plan_payload.strength.muscle_volume` is additive jsonb on existing nullable column |

## Data model

### Types ([lib/data/types.ts](../../../lib/data/types.ts))

```ts
export type TargetedMuscleGroup =
  | "Chest" | "Lats" | "Traps" | "RearDelts"
  | "Quads" | "Hams" | "Glutes"
  | "Biceps" | "Triceps" | "Calves";

export type MuscleVolumeBand = {
  mev: number;
  mav: [number, number];
  mrv: number;
  history_8wk_avg: number;        // cached at compose time
  source: "literature_default" | "literature_adjusted_up" | "literature_with_ramp_floor";
  rationale: string;
};

export type VolumeRampRecipe = {
  start_pct: number;   // default 1.0 — week 1 multiplier vs MEV
  peak_pct: number;    // default 1.4 — week 4 multiplier vs MEV
  deload_pct: number;  // default 0.5 — week 5 multiplier vs MEV
};

export type VolumeCountingRules = {
  secondary_set_factor: 0.5;
  warmup_excluded: true;
  window_weeks: 8;
};

export type StrengthMuscleVolume = {
  counting_rules: VolumeCountingRules;
  ramp_recipe: VolumeRampRecipe;
  bands: Record<TargetedMuscleGroup, MuscleVolumeBand>;
  unmapped_exercises: string[];   // surfaced for taxonomy maintenance
};
```

### Extension to `plan_payload.strength`

```ts
strength: {
  // ... existing fields ...
  muscle_volume?: StrengthMuscleVolume | null;   // NEW; optional for legacy plans
};
```

### Collapse map ([lib/coach/exercise-muscles.ts](../../../lib/coach/exercise-muscles.ts))

```ts
export const TARGET_GROUP_FOR_MUSCLE: Partial<Record<MuscleId, TargetedMuscleGroup>> = {
  [MUSCLE_ID.Chest]:      "Chest",
  [MUSCLE_ID.Lats]:       "Lats",
  [MUSCLE_ID.Traps]:      "Traps",
  [MUSCLE_ID.RearDelts]:  "RearDelts",
  [MUSCLE_ID.Quads]:      "Quads",
  [MUSCLE_ID.Hams]:       "Hams",
  [MUSCLE_ID.Glutes]:     "Glutes",
  [MUSCLE_ID.Biceps]:     "Biceps",
  [MUSCLE_ID.Brachialis]: "Biceps",
  [MUSCLE_ID.Triceps]:    "Triceps",
  [MUSCLE_ID.Calves]:     "Calves",
  [MUSCLE_ID.Soleus]:     "Calves",
  // FrontDelts, Serratus, Abs, Obliques intentionally absent
};
```

### Literature defaults (new file [lib/coach/volume-landmarks.ts](../../../lib/coach/volume-landmarks.ts))

Israetel/RP intermediate defaults. Tier scalars: beginner ×0.7, intermediate ×1.0, advanced ×1.2.

| Muscle | MEV | MAV | MRV |
|---|---|---|---|
| Chest | 10 | 12–20 | 22 |
| Lats | 10 | 14–22 | 25 |
| Traps | 4 | 6–12 | 16 |
| RearDelts | 8 | 10–20 | 26 |
| Quads | 8 | 12–18 | 20 |
| Hams | 6 | 10–16 | 20 |
| Glutes | 4 | 6–12 | 16 |
| Biceps | 8 | 14–20 | 26 |
| Triceps | 6 | 10–14 | 18 |
| Calves | 8 | 12–16 | 20 |

Source: RP Hypertrophy Volume Landmarks (Israetel et al.); cross-checked against Schoenfeld 2017 & 2022 meta-analyses for chest, back, quads.

## Compose-time logic

### Pure compute layer — [lib/coach/muscle-volume.ts](../../../lib/coach/muscle-volume.ts) (NEW)

```ts
export function computeWeeklyMuscleVolume(
  workouts: Workout[],
  windowDays: number,
): Record<TargetedMuscleGroup, number>;
```

- Iterates `workouts → exercises → working sets (warm-ups excluded)`.
- Looks up each exercise in `EXERCISE_MUSCLES`; unmapped → skip + record name.
- Primary muscles get full set count; secondary get `set_count × 0.5`.
- Collapses MuscleId → TargetedMuscleGroup via `TARGET_GROUP_FOR_MUSCLE`.
- Returns per-week average over the window. Unmapped names exposed via second return field or side-channel for the composer to bake into `unmapped_exercises`.

### Composer — [lib/coach/plan-builder/compose-strength.ts](../../../lib/coach/plan-builder/compose-strength.ts)

New `composeMuscleVolume(trainingAge, history)` function (pure):

```ts
for each TargetedMuscleGroup:
  lit = literatureBand(group, trainingAge)
  h = history[group]
  if h > lit.mav[1]:
    k = h / lit.mav[1]
    band = { mev: lit.mev * k, mav: [lit.mav[0] * k, lit.mav[1] * k], mrv: lit.mrv * k,
             history_8wk_avg: h, source: "literature_adjusted_up", rationale: "..." }
  elif h < lit.mev:
    band = { ...lit, history_8wk_avg: h, source: "literature_with_ramp_floor", rationale: "..." }
  else:
    band = { ...lit, history_8wk_avg: h, source: "literature_default", rationale: "..." }
```

Integrated into `composeStrengthTemplate` with `recentWorkouts: Workout[]` as a new input.

### Upstream fetch consolidation — [lib/coach/plan-builder/index.ts](../../../lib/coach/plan-builder/index.ts)

`fetchRecentE1RMs` becomes `fetchRecentWorkoutData` returning `{ e1rms, workouts }`. One DB call, two consumers. No extra round-trip.

### Sparseness fallback

If `recentWorkouts.length < 12` (less than 4 weeks of sessions): all bands use literature defaults regardless of history. Rationale includes "history sparse — using defaults pending more data."

## Daily compute layer

### TanStack Query integration (per CLAUDE.md hybrid SSR-hydrate pattern)

```
lib/query/fetchers/muscleVolume.ts      ← server + browser variants
lib/query/hooks/useMuscleVolume.ts      ← TanStack Query hook
lib/query/keys.ts                       ← muscleVolume.snapshot(userId, today)
```

### Snapshot shape

```ts
export type MuscleVolumeSnapshot = {
  computed_at: string;                                          // ISO
  rolling_avg_8wk: Record<TargetedMuscleGroup, number>;
  current_week_to_date: Record<TargetedMuscleGroup, number>;
  weekly_history: Array<{
    week_start: string;                                         // ISO Sunday
    volumes: Record<TargetedMuscleGroup, number>;
  }>;                                                           // last 8 weeks, oldest first
  top_exercises_per_muscle: Record<TargetedMuscleGroup, Array<{ name: string; sets: number }>>;
};
```

### Invalidation

`workouts`-mutating route handlers (`/api/ingest/strong` CSV upload, manual workout-log mutation) invalidate `queryKeys.muscleVolume.all(userId)`. One-line patches in 2 existing mutations.

### Stale time

5 minutes — workouts aren't logged minute-by-minute; long enough to avoid thrash, short enough that a freshly-logged workout shows up on next page nav.

### Brief composer bypass

The morning-brief composer at [app/api/chat/morning/recommendation/route.ts](../../../app/api/chat/morning/recommendation/route.ts) runs server-side and does **not** use the client cache. It imports `fetchMuscleVolumeServer` and pure `evaluateMuscleVolumeGaps` directly.

## UX surfaces

### Surface 1 — Plan card ([components/chat/PlanProposalCard.tsx](../../../components/chat/PlanProposalCard.tsx))

Slots into the existing `<PlanSection title="Strength template">`, after `weekly_volume_targets` KeyVals, before `progression_rule` footer.

**Default (collapsed):** one summary `KeyVal` row.

```
Muscle volume    10 muscles tracked · 2 below MEV (RearDelts, Glutes) · 1 raised (Quads)   [expand ▾]
```

Summary fields are **derived**, not stored:
- `n_below_mev` = count of bands with `source === "literature_with_ramp_floor"`
- `n_raised` = count of bands with `source === "literature_adjusted_up"`

**Expanded (`<details>`):** 5-column table with rows for all 10 targeted muscles.

| Muscle | 8wk avg | Band (MEV / MAV / MRV) | This week's target | Status |

This-week's target is computed at render time: `MEV × interpolate(currentBlockWeek, ramp_recipe)`. If no active block: shows MAV midpoint with note. Stored band `rationale` shows on hover.

Mobile (~480px): table collapses to stacked card-per-muscle.

**No edit UI** at plan-proposal time. Overrides happen during intake chat in a future iteration (`propose_band_override` tool — out of scope here).

### Surface 2 — Profile-renderer parity ([lib/coach/profile-renderer.ts](../../../lib/coach/profile-renderer.ts))

`renderMuscleVolume(muscle_volume, currentBlockWeek)` emits a compact markdown block into `SCHEMA_EXPLAINER` so the coach AI can reference specific band numbers when asked.

```markdown
**Muscle volume (weekly sets/wk · band MEV/MAV/MRV):**
- Chest: 14 actual · 10 / 12-20 / 22 · in band
- RearDelts: 4 actual · 8 / 10-20 / 26 · ⚠ below MEV — ramp gradually
- Quads: 22 actual · 10 / 14-22 / 24 · band raised from 18 (history above MAV)
...
```

### Surface 3 — Morning brief

#### Flags ([lib/morning/brief/flags.ts](../../../lib/morning/brief/flags.ts))

New flag family `MuscleVolumeFlag`:

```ts
type MuscleVolumeFlag =
  | { kind: "below_mev_persistent"; group: TargetedMuscleGroup; actual_8wk: number; mev: number }
  | { kind: "below_mev_recent";     group: TargetedMuscleGroup; actual_wtd: number; target_this_week: number; days_left: number }
  | { kind: "near_mrv";             group: TargetedMuscleGroup; actual_wtd: number; mrv: number };
```

Firing rules:

| Flag | Condition | When |
|---|---|---|
| `below_mev_persistent` | 8wk avg < MEV × 0.7 | Every brief until addressed |
| `below_mev_recent` | current-week-to-date < this-week-target × 0.6 | Training days only, Thu/Fri/Sat |
| `near_mrv` | current-week-to-date > MRV × 0.9 | Training days only |

**Top-2 only.** Rank: `near_mrv` > `below_mev_persistent` > `below_mev_recent`. Prevents Advice prompt noise.

#### Inline indicator on session block

When ≥1 below-MEV flag fires on a training day: session block gains one static line:

> ⚠ **Volume gaps:** RearDelts (4/wk vs 8 MEV), Glutes (2/wk vs 4 MEV) — coach details below.

#### Advice-prompt extension

New section in [lib/morning/brief/advice-prompt.ts](../../../lib/morning/brief/advice-prompt.ts) renders the surviving flags with coaching directives:

- For `below_mev_*`: suggest ONE concrete exercise + set count to fit into today's session; cap +3 sets per gap.
- For `near_mrv`: suggest dropping the last exercise/set, frame as autoregulation not failure.
- No additional Haiku cost — same one Advice call, longer prompt.

### Surface 4 — Strength tab "By Muscle" sub-tab

URL: `/strength?view=by_muscle` (linkable from brief inline indicator).

**Layout, top-to-bottom:**

1. **Body map header** — front/back, each muscle colored by status:
   - `--mc-band-ok` (greenish, in band)
   - `--mc-band-low` (cool grey-blue, below MEV)
   - `--mc-band-amber` (warm amber, near MRV)
   - `--mc-band-over` (saturated red, over MRV)
   - Neutral fill for non-targeted muscles
   - Hover/tap → popover with band + actuals
2. **Mode toggle:** `8wk avg` (default) vs `Week to date`.
3. **Per-muscle rows** (10 muscles, sorted by actionability — below_mev first, then over_mrv, then near_mrv, then in_band):
   - Horizontal track with MEV/MAV/MRV marks and an actuals dot
   - 8-week sparkline from `weekly_history`
   - This-week-to-date + target + week-of-block
   - Top contributors (top 3 exercises by sets in the window) from `top_exercises_per_muscle`
   - Click → drawer with full 8wk contributor breakdown
4. **Non-targeted muscles footer** (collapsed `<details>`): FrontDelts / Serratus / Abs / Obliques / Brachialis / Soleus, showing only current 8wk volume.

**Pre-plan empty state:** if `plan.strength.muscle_volume == null`, hide band overlays but show actuals + "regenerate plan to enable targets" CTA → `/profile`.

## Shipping order

No DB migration. All shipping is code. 5 PRs.

| # | Scope | Depends on |
|---|---|---|
| **PR 1** | Data model + pure compute + composer | — |
| **PR 2** | Plan card UX + profile-renderer parity | PR 1 |
| **PR 3** | Daily compute fetcher + hook + invalidation | PR 1 |
| **PR 4** | Strength tab "By Muscle" sub-tab | PRs 1 + 3 |
| **PR 5** | Morning brief flags + Advice prompt + session-block indicator | PRs 1 + 3 |

PRs 2-3 parallelizable; PRs 4-5 parallelizable.

### Per-PR validation gates

| PR | Smoke check |
|---|---|
| 1 | Generate a plan via intake; inspect `plan_payload.strength.muscle_volume` in DB; legacy plans (no field) still type-check |
| 2 | Visual review on PlanProposalCard, AthleteProfilePanel; both legacy and new plans render |
| 3 | `useMuscleVolume` returns expected shape; mutation invalidation triggers refetch on workout log |
| 4 | Real workout history renders correctly; sort order right; sparklines accurate; drill-down loads |
| 5 | Test brief generation surfaces flags for the test user (RearDelts gap by inspection); Advice prose sensible; retry idempotent |

## Forward-compatibility

- **Legacy plans** (no `muscle_volume`) keep working. UI branches on the optional field.
- **User-driven migration:** "Regenerate plan to enable targets" CTA on `/profile`. No backfill script.
- **Exercise taxonomy gaps:** unmapped exercises surface in `plan_payload.strength.muscle_volume.unmapped_exercises` — easy to extend `EXERCISE_MUSCLES` afterward without invalidating existing plans.

## Risks & edge cases

| Risk | Mitigation |
|---|---|
| User has < 4 weeks of workout data when generating | Composer falls back to literature defaults regardless of history; rationale notes "history sparse" |
| Unmapped Strong exercises (e.g., a new lift the user added to Strong but not to `EXERCISE_MUSCLES`) | Silently contribute 0; logged into `unmapped_exercises` field for visibility; manual extension of `EXERCISE_MUSCLES` is the fix |
| Cardio/HIIT in workouts table | Not in `EXERCISE_MUSCLES`; contributes 0 — correct (they're tracked via daily_logs, not strength volume) |
| Plan-level band drift over a long block | Out of scope here; would be Phase 3 drift detection territory |
| Coach AI hallucinating band numbers | Profile-renderer injection (Surface 2) gives the AI the actual values; reduces hallucination risk |

## Out of scope (explicit non-goals)

- Adaptive caloric drift logic (L43) — different domain, Phase 3
- Goal decomposition outcome/process/leading (L42) — separate goal-shape feature
- Biomarker targets in `plan_payload` (L41) — HRV/RHR/body-comp prescription
- Session-type flexibility (L44) — different file, different design pass
- Lab work integration in `plan_payload` (L46) — needs its own spec
- Micronutrient targets (L47) — needs Yazio data shape investigation first
- `propose_band_override` tool during intake chat — hook noted; defer to future iteration
- Per-muscle e1RM tracking — strength tab volume tab is volume only; intensity stays per-lift

## References

- Phase 2 design: [2026-05-11-athlete-profile-phase-2-design.md](2026-05-11-athlete-profile-phase-2-design.md) (Tier-2 deferred list L37-L48)
- Existing muscle taxonomy: [lib/coach/exercise-muscles.ts](../../../lib/coach/exercise-muscles.ts) (16-muscle wger-based)
- Existing per-lift volume tracking: [lib/coach/plan-builder/compose-strength.ts](../../../lib/coach/plan-builder/compose-strength.ts)
- Body map UI (from PRs #57/#58): components/strength muscle map
- Renaissance Periodization Hypertrophy Volume Landmarks (Israetel et al.) — literature source for default bands
- Schoenfeld B.J. et al. 2017, 2022 — meta-analyses cross-referenced for chest/back/quads dose-response
