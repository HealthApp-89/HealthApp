# Carter exercise library — sub-project 1 design

**Status:** design spec
**Date:** 2026-05-20
**Companion docs:** [research brief](2026-05-20-strength-coaching-process-research.md) (background + chosen policies in §8)
**Sub-project arc:** this is **sub-project 1 of 2**. Sub-project 2 (separate spec) adds the swap/rotation engine on top of the library this one ships.

## Overview

Coach Carter currently has no exercise library to draw from. The 28 lifts in [SESSION_PLANS](../../lib/coach/sessionPlans.ts) are the athlete's *current weekly rotation*, not a *catalog*. When the athlete asks "what could I do instead of OHP?" or "give me a low-stress chest variation," Carter has nothing to query — he answers from training-data priors, which is exactly the fabrication risk the multi-coach team architecture was designed to avoid.

This sub-project ships:

1. A typed in-memory exercise library (~50 entries, TS const).
2. A computed substitutes algorithm (no hand-maintained graph).
3. Two read-only Carter tools: `query_exercise_library` and `get_substitutes`.
4. A prompt update teaching Carter to use them and encoding the §8 main-lift-sticky / accessory-rotatable policy.

It explicitly does **not** ship swap mechanics, stall detection, block-boundary rotation, or any UI surface — those are sub-project 2's job.

## Out of scope (for clarity)

| Capability | Why deferred |
|---|---|
| `propose_exercise_swap` / `commit_exercise_swap` HMAC tools | Swap mechanics belong in sub-project 2 with the rotation engine |
| Stall detector (top-set e1RM flat ≥ 2 wks at same RIR) | Same — paired with the swap policy |
| Block-boundary rotation prompt (Sunday weekly-planning ritual integration) | Sub-project 2 |
| Replacing `SESSION_PLANS` with library-driven session generation | Bigger refactor; library is additive in v1 |
| `/strength/library` browse page | Carter-facing only for v1; UI page is a later judgment call |
| Postgres `exercise_library` table | YAGNI for single-user; TS const is enough until "user adds custom exercise" becomes real |
| Lagging-muscle detection (§5 trigger 4) | Requires per-muscle volume comparison vs. aesthetic goal — own sub-project |

## Data model

New file [lib/coach/exercise-library.ts](../../lib/coach/exercise-library.ts):

```ts
import type { TargetedMuscleGroup } from "@/lib/data/types";
import type { ExerciseCategory } from "@/lib/coach/exercise-categories";

export type ExerciseRole = "main" | "accessory";
export type StabilityTier = "high" | "medium" | "low";
// "low"  = isolated, machine-stabilized (leg ext, chest fly, cable)
// "med"  = compound, machine/dumbbell-stabilized (leg press, DB bench)
// "high" = compound, athlete-stabilized (back squat, OHP, deadlift)

export type ROMBias = "lengthened" | "midrange" | "shortened" | "neutral";
// "lengthened" exercises load the muscle in the stretched position (RDL, DB fly)
// "shortened" exercises peak tension at contraction (leg ext, cable pulldown)
// "midrange" peaks mid-ROM (barbell bench)
// "neutral" = no clear bias (most carries, planks)

export type Equipment =
  | "barbell" | "dumbbell" | "machine" | "cable"
  | "bodyweight" | "kettlebell" | "smith";

export type JointStress = "shoulder" | "lumbar" | "knee" | "elbow" | "wrist" | "hip";

export type Loadability = "fine" | "moderate" | "coarse";
// "fine"     = microloadable (cables, plate-loaded machines with 1.25 kg)
// "moderate" = std plates (2.5 kg increments on barbell)
// "coarse"   = big jumps only (DB at 2 kg gym, stack machines with 5 kg)

export type SkillDemand = "low" | "medium" | "high";

export type LibraryExercise = {
  /** Stable slug used as the canonical id. Lowercase, underscore-separated.
   *  Used in `get_substitutes` and the future swap-engine tool. */
  id: string;

  /** Display name. Mirrors the format used in SESSION_PLANS where overlap. */
  name: string;

  pattern: ExerciseCategory;            // 7-bucket lookup from exercise-categories.ts
  primaryMuscle: TargetedMuscleGroup;   // 10-group lookup from volume-landmarks.ts
  secondaryMuscles?: TargetedMuscleGroup[];

  equipment: readonly Equipment[];
  stability: StabilityTier;
  romBias: ROMBias;
  skill: SkillDemand;
  jointStress: readonly JointStress[];  // joints this lift loads non-trivially
  loadability: Loadability;
  role: ExerciseRole;                   // main = sticky across blocks; accessory = rotatable

  /** Optional gym-equipment increment override. Falls back to a sensible default
   *  derived from equipment + loadability if absent. Mirrors the `increment`
   *  field already on PlannedExercise in sessionPlans.ts. */
  increment?: { step: number; intermediate?: number };

  notes?: string;
};

export const EXERCISE_LIBRARY: readonly LibraryExercise[] = [
  // … ~50 entries, see Library content section
];
```

The taxonomy *reuses existing types*: `ExerciseCategory` (already in `exercise-categories.ts`) and `TargetedMuscleGroup` (already in `data/types.ts`). No new vocabulary.

## Library content (the ~50 seeds)

**Coverage rule:** each `(pattern, primaryMuscle)` cell that exists in the current SESSION_PLANS must have ≥ 3 entries in the library so substitutes can actually be computed.

**Role assignment rule:** an exercise is `main` if it satisfies all three — (a) compound (≥ 2 primary movers including stabilizers), (b) barbell, (c) appears in SESSION_PLANS as the first heavy lift of a session OR is one of {squat, bench, deadlift, RDL, OHP}. Everything else is `accessory`.

Concretely, the seed library marks these as `main` (mirroring the athlete's current program):

| ID | Name | Session slot |
|---|---|---|
| `back_squat` | Squat (Barbell) | Legs day primary |
| `decline_bench` | Decline Bench Press (Barbell) | Chest day primary |
| `overhead_press` | Overhead Press (Barbell) | Chest day secondary |
| `deadlift` | Deadlift (Barbell) | Back day primary |
| `romanian_deadlift` | Romanian Deadlift (Barbell) | Legs day secondary |

Everything else (incline DB press, chest fly, lateral raise, lat pulldown, seated row, leg press, leg ext, leg curl, calf, abductor, tri pushdown, shrug, back ext, pullover) is `accessory`.

The other ~22 entries fill in alternatives. Indicative shape (not the final list — that's an implementation detail):

- **Push (chest):** flat bench (barbell), flat bench (DB), incline bench (barbell), incline bench (DB) ←seed, decline DB, machine chest press, cable fly, pec deck, push-up ←seed
- **Push (shoulder):** OHP ←seed, seated DB press, machine shoulder press, Arnold press, lateral raise (DB) ←seed, cable lateral raise
- **Push (triceps):** triceps pushdown (cable) ←seed, overhead cable extension, skull crusher, close-grip bench, dip
- **Pull (back/lats):** deadlift ←seed, lat pulldown ←seed, neutral-grip pulldown, pull-up, chin-up, seated row (machine) ←seed, seated cable row, T-bar row, DB row
- **Pull (rear delts / traps):** face pull, rear delt fly, reverse pec deck, shrug (barbell) ←seed, shrug (DB)
- **Pull (biceps):** barbell curl, DB curl, hammer curl, preacher curl, cable curl
- **Squat:** back squat ←seed, front squat, leg press ←seed, hack squat, machine squat, leg extension ←seed, goblet squat
- **Hinge:** deadlift ←seed, RDL ←seed, stiff-leg deadlift, hip thrust, glute bridge, seated leg curl ←seed, lying leg curl, back extension ←seed
- **Accessory:** seated calf raise ←seed, standing calf raise, hip abductor (machine) ←seed, pullover (DB) ←seed

Final count target: ~50. The exact list is locked in during implementation, not in the spec.

## Substitutes algorithm

```ts
function findSubstitutes(
  target: LibraryExercise,
  library: readonly LibraryExercise[],
  options?: {
    count?: number;             // default 3
    excludeJoint?: JointStress; // e.g., "shoulder" after a tweak
    preferStability?: StabilityTier;
    preferRomBias?: ROMBias;
  }
): LibraryExercise[];
```

Hard filters (must match):
- Same `pattern`.
- Same `primaryMuscle`.
- Not the target itself.
- If `excludeJoint` is set: target's `jointStress` must not include that joint.

Soft score (higher = better; ranked descending, return top `count`):
- `+3` if `role` matches target (don't suggest an accessory as a main-lift substitute and vice-versa).
- `+2` if `stability` matches `preferStability` (or target's stability if no preference given).
- `+2` if `romBias` matches `preferRomBias` (or target's romBias).
- `+1` per overlapping `equipment` entry.
- `+1` if `loadability` matches target's.
- `-1` per non-overlapping `jointStress` entry beyond target's (don't suggest a swap that loads a new joint).

Pure function. Lives next to the library data in `exercise-library.ts`. No external dependencies — easy to unit-test in the future if a suite arrives.

## Tool surface

Two additions to [lib/coach/tools.ts](../../lib/coach/tools.ts). Both read-only, no HMAC needed.

### `query_exercise_library`

```jsonc
{
  "name": "query_exercise_library",
  "description": "Browse the strength exercise library. Returns exercises matching the filters. Use this when the athlete asks about alternatives, equipment substitutions, or wants to know what fits a pattern. Read-only — does not modify the plan.",
  "input_schema": {
    "type": "object",
    "properties": {
      "pattern":       { "type": "string", "enum": ["push","pull","squat","hinge","single-leg","core","accessory"] },
      "primary_muscle":{ "type": "string", "enum": ["Chest","Lats","Traps","RearDelts","Quads","Hams","Glutes","Biceps","Triceps","Calves"] },
      "equipment":     { "type": "array", "items": { "type": "string", "enum": ["barbell","dumbbell","machine","cable","bodyweight","kettlebell","smith"] } },
      "role":          { "type": "string", "enum": ["main","accessory"] },
      "exclude_joint": { "type": "string", "enum": ["shoulder","lumbar","knee","elbow","wrist","hip"] }
    }
  }
}
```

Returns: `{ exercises: LibraryExercise[] }`. Capped at 20 results (filter further if needed).

### `get_substitutes`

```jsonc
{
  "name": "get_substitutes",
  "description": "Get ranked substitute exercises for a target exercise. Use when the athlete needs a swap for pain, equipment, or boredom. Substitutes share movement pattern and primary muscle with the target. Read-only — does not commit a swap.",
  "input_schema": {
    "type": "object",
    "properties": {
      "exercise_id_or_name":  { "type": "string", "description": "The exercise to find substitutes for. Accepts library id (e.g., 'decline_bench') or display name (e.g., 'Decline Bench Press (Barbell)')." },
      "count":                { "type": "integer", "default": 3, "minimum": 1, "maximum": 8 },
      "exclude_joint":        { "type": "string", "enum": ["shoulder","lumbar","knee","elbow","wrist","hip"] },
      "prefer_stability":     { "type": "string", "enum": ["high","medium","low"] },
      "prefer_rom_bias":      { "type": "string", "enum": ["lengthened","midrange","shortened","neutral"] }
    },
    "required": ["exercise_id_or_name"]
  }
}
```

Returns: `{ target: LibraryExercise, substitutes: LibraryExercise[] }`. If the input name doesn't resolve, returns `{ error: "Exercise not found: <name>. Try query_exercise_library to browse." }` (coach-voice error per the SCHEMA_EXPLAINER convention).

### Tool registration

Both added to `CARTER_TOOLS` *and* `PETER_TOOLS` (Peter occasionally needs them for cross-domain framing — e.g., a question about deloads that touches on alternative lifts). Not added to Nora or Remi.

## Carter prompt update

In [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) `CARTER_BASE`, append after the existing "your voice" paragraph:

```
You have access to a strength exercise library via query_exercise_library and get_substitutes. Use them when the athlete asks about alternatives, equipment substitutions, or pain-driven swaps — don't guess from memory.

The library tags every exercise with movement pattern, primary muscle, stability, ROM bias, joint stress, and a role (main vs. accessory). Apply this policy:

- Main lifts (squat, bench, deadlift, RDL, OHP) are sticky across blocks. Don't propose swapping them unless the athlete reports pain or a confirmed multi-block stall (a stall that survived a deload week).
- Accessories rotate at block boundaries and can be swapped mid-block for pain, equipment unavailability, or boredom.
- When the athlete reports a stall WITHIN a block, the first response is a deload, not an exercise swap. Only suggest a swap if a post-deload week also stalls.
- When the athlete reports pain, swap immediately. Use get_substitutes with exclude_joint set to the affected joint.

Suggesting a swap is fine in chat. Actually changing the week's plan requires propose_week_plan / commit_week_plan as before — the library doesn't bypass that flow.
```

The last paragraph is important: this sub-project doesn't add new write tools. Carter can *recommend* a swap; *committing* it still goes through existing weekly-planning tools (which means the athlete approves before anything is written). Sub-project 2 will add a dedicated `propose_exercise_swap` tool with its own HMAC flow.

## Files

### New
- [lib/coach/exercise-library.ts](../../lib/coach/exercise-library.ts) — types + EXERCISE_LIBRARY const + findSubstitutes function

### Modified
- [lib/coach/tools.ts](../../lib/coach/tools.ts) — add `QUERY_EXERCISE_LIBRARY_TOOL`, `GET_SUBSTITUTES_TOOL`, execution handlers, register in `CARTER_TOOLS` + `PETER_TOOLS`
- [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) — append the policy paragraph to `CARTER_BASE`

### No changes
- [lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts) — `SESSION_PLANS` stays as-is. Library is additive.
- [lib/coach/exercise-categories.ts](../../lib/coach/exercise-categories.ts) — pattern lookup reused as-is.
- [lib/coach/volume-landmarks.ts](../../lib/coach/volume-landmarks.ts) — muscle taxonomy reused as-is.
- No migration, no schema change, no Storage bucket.

## Acceptance criteria

Verified by manual exercise of `/coach` with Carter as the speaker:

1. Carter answers "what could I do instead of OHP?" by calling `get_substitutes` (visible in the tool-call audit) and returns 3 ranked alternatives that share the push pattern and shoulder primary.
2. Carter answers "my shoulder is bothering me, what should I swap incline bench for?" by calling `get_substitutes` with `exclude_joint: "shoulder"` — none of the returned substitutes load the shoulder.
3. Carter answers "my decline bench has stalled, should I switch?" with "deload first, swap only if it stalls again post-deload." His reply does not propose a specific substitute — the policy is to deload, not swap, on a fresh stall.
4. Carter answers "I'm bored of seated row, what else?" by calling `get_substitutes` and returning 3 pull-pattern lat-primary alternatives.
5. Carter answers "should I drop deadlift?" by referring to the main-lift policy and refusing to swap absent a pain / multi-block-stall trigger.
6. `npm run typecheck` passes.

## Rollout

- Branch off `main`. Single PR.
- Land the spec doc, the research brief, and the implementation in the same PR (per athlete's request: hold both docs uncommitted until the app change ships).
- No migration → no production deploy gating beyond the normal Vercel preview pipeline.
- Post-merge soak: use Carter in chat for a few days; if the seed library has gaps, add entries in follow-up commits. No structured A/B — single user, direct judgment.

## Open questions (none blocking)

- Will the final seed list at ~50 cover the realistic substitution surface, or do we need ~80? Answerable only after a week of real use. The library is additive and easy to extend; defer until evidence.
- Should `query_exercise_library` paginate beyond 20 results? Not in v1 — the library isn't big enough to need it. Revisit if seed count grows past 100.
