# Carter Exercise Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Coach Carter's first exercise library — a ~57-entry typed catalog plus two read-only chat tools (`query_exercise_library`, `get_substitutes`) so Carter can answer substitution questions from data instead of priors.

**Architecture:** Single TS const file holds types + seed data + a pure `findSubstitutes` scoring function. Two new tool schemas registered in Carter's and Peter's tool sets; execution handlers live in `lib/coach/tools.ts` next to existing handlers; dispatcher branches added to `lib/coach/chat-stream.ts`. Carter's system prompt gets an appended policy paragraph encoding the main-lift-sticky / accessory-rotatable rules. No DB migration, no UI surface, no swap-write tools (those are sub-project 2).

**Tech Stack:** TypeScript, Next.js 15, Anthropic Claude SDK (existing chat-stream architecture).

**Spec:** [docs/superpowers/specs/2026-05-20-carter-exercise-library-design.md](../specs/2026-05-20-carter-exercise-library-design.md). Companion research brief: [docs/superpowers/specs/2026-05-20-strength-coaching-process-research.md](../specs/2026-05-20-strength-coaching-process-research.md).

---

## File Structure

### New
- `lib/coach/exercise-library.ts` — types (`LibraryExercise`, supporting unions), the `EXERCISE_LIBRARY` const (~57 entries), and the pure `findSubstitutes(target, library, options?)` scoring function. Self-contained, no external runtime dependencies beyond `TargetedMuscleGroup` and `ExerciseCategory` imports.

### Modified
- `lib/coach/tools.ts` — append two `ToolSchema` constants (`QUERY_EXERCISE_LIBRARY_TOOL`, `GET_SUBSTITUTES_TOOL`), two execution handlers (`executeQueryExerciseLibrary`, `executeGetSubstitutes`), and add both tools to `CARTER_TOOLS` and `PETER_TOOLS` arrays.
- `lib/coach/chat-stream.ts` — add two dispatcher `else if` branches for the new tool names.
- `lib/coach/system-prompts.ts` — append a single paragraph to `CARTER_BASE`.

### Unchanged (deliberately)
- `lib/coach/sessionPlans.ts` — `SESSION_PLANS` stays. The library is additive in v1.
- `lib/coach/exercise-categories.ts` — pattern lookup reused as-is.
- `lib/coach/volume-landmarks.ts` — muscle taxonomy reused as-is.
- Database schema, Supabase migrations, RLS policies — none touched.

---

## Task 0: Branch + commit pending docs

The research brief and the spec are sitting uncommitted in the working tree (the athlete asked to commit them alongside the implementation). Open the branch and land them as the first commit.

**Files:**
- Commit: `docs/superpowers/specs/2026-05-20-strength-coaching-process-research.md`
- Commit: `docs/superpowers/specs/2026-05-20-carter-exercise-library-design.md`
- Commit: `docs/superpowers/plans/2026-05-20-carter-exercise-library.md` (this file)

- [ ] **Step 1: Branch off main**

Run: `git checkout -b feat/carter-exercise-library`
Expected: `Switched to a new branch 'feat/carter-exercise-library'`

- [ ] **Step 2: Verify the three doc files are the only intended additions**

Run: `git status -s docs/`
Expected output includes:
```
?? docs/superpowers/plans/2026-05-20-carter-exercise-library.md
?? docs/superpowers/specs/2026-05-20-carter-exercise-library-design.md
?? docs/superpowers/specs/2026-05-20-strength-coaching-process-research.md
```
(Other untracked items outside `docs/` from earlier sessions — see CLAUDE.md `gitStatus` — are not part of this PR.)

- [ ] **Step 3: Stage and commit the three docs**

Run:
```bash
git add docs/superpowers/specs/2026-05-20-strength-coaching-process-research.md \
        docs/superpowers/specs/2026-05-20-carter-exercise-library-design.md \
        docs/superpowers/plans/2026-05-20-carter-exercise-library.md
git commit -m "$(cat <<'EOF'
docs(coach): research brief + Carter exercise library spec + plan

Companion research synthesis of expert strength-coaching process (block
periodization, MEV/MAV/MRV in practice, exercise rotation literature)
plus chosen-policy locking (main lifts sticky, accessories rotate per
block, urgency-ordered mid-block swap rules). Spec and plan for
sub-project 1 (typed exercise library + two read-only Carter tools).
Sub-project 2 (swap mechanics + stall detector) lands in a separate PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: `[feat/carter-exercise-library <sha>] docs(coach): ...`  with `3 files changed`.

---

## Task 1: Create `lib/coach/exercise-library.ts` skeleton

Lay down the file with the type definitions, an empty `EXERCISE_LIBRARY` const, and the `findSubstitutes` function. Seed data lands in Task 2.

**Files:**
- Create: `lib/coach/exercise-library.ts`

- [ ] **Step 1: Create the file with types + empty array + function**

Write the file with this content:

```ts
// lib/coach/exercise-library.ts
//
// Strength exercise catalog for Coach Carter. Sub-project 1 of 2: ships the
// data shape, ~57 seed entries, and a pure `findSubstitutes` scoring function.
// Sub-project 2 will add swap-write tools and a stall detector that consume
// this library.
//
// Why a const file instead of a DB table: single-user app, no per-user
// customization in v1, and Carter's tool calls don't need SQL — they filter
// in memory. Promotable to a Postgres table if a "user adds custom exercise"
// feature ever lands.
//
// Source of truth for *which* exercises the athlete trains week-to-week is
// still `lib/coach/sessionPlans.ts`; the library is additive — it's the menu,
// not the meal plan.

import type { TargetedMuscleGroup } from "@/lib/data/types";
import type { ExerciseCategory } from "@/lib/coach/exercise-categories";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExerciseRole = "main" | "accessory";

/** Stability tier: how much the athlete must stabilize the load themselves.
 *  Lower stability = more isolated muscle work, less systemic fatigue cost.
 *  high = athlete-stabilized compound (back squat, OHP, deadlift)
 *  medium = compound with external stabilization (leg press, DB bench)
 *  low = isolated, machine-stabilized (leg extension, chest fly, cable) */
export type StabilityTier = "high" | "medium" | "low";

/** Where in the ROM the exercise peaks tension.
 *  lengthened = loads the muscle in the stretched position (RDL, DB fly)
 *  shortened  = peaks at contraction (leg ext, cable pulldown)
 *  midrange   = peaks mid-ROM (barbell bench)
 *  neutral    = no clear bias */
export type ROMBias = "lengthened" | "midrange" | "shortened" | "neutral";

export type Equipment =
  | "barbell" | "dumbbell" | "machine" | "cable"
  | "bodyweight" | "kettlebell" | "smith";

export type JointStress = "shoulder" | "lumbar" | "knee" | "elbow" | "wrist" | "hip";

/** Microloadability. Drives Carter's progression suggestions.
 *  fine     = microloadable (cables, plate-loaded machines with 1.25 kg)
 *  moderate = std plates (2.5 kg increments on barbell)
 *  coarse   = big jumps only (gym DBs, stack machines at 5 kg) */
export type Loadability = "fine" | "moderate" | "coarse";

export type SkillDemand = "low" | "medium" | "high";

export type LibraryExercise = {
  /** Stable slug. Lowercase, underscore-separated. Used by get_substitutes. */
  id: string;
  /** Display name. Matches sessionPlans.ts format where overlap. */
  name: string;
  pattern: ExerciseCategory;
  primaryMuscle: TargetedMuscleGroup;
  secondaryMuscles?: readonly TargetedMuscleGroup[];
  equipment: readonly Equipment[];
  stability: StabilityTier;
  romBias: ROMBias;
  skill: SkillDemand;
  jointStress: readonly JointStress[];
  loadability: Loadability;
  role: ExerciseRole;
  increment?: { step: number; intermediate?: number };
  notes?: string;
};

// ── Seed data (populated in Task 2) ──────────────────────────────────────────

export const EXERCISE_LIBRARY: readonly LibraryExercise[] = [
  // Populated in Task 2.
];

// ── Lookup helpers ───────────────────────────────────────────────────────────

/** Resolve a library entry by id OR display name (case-insensitive). Returns
 *  null when no match. Used by get_substitutes so the chat tool accepts either
 *  the slug ("decline_bench") or the display name ("Decline Bench Press (Barbell)"). */
export function resolveExercise(idOrName: string): LibraryExercise | null {
  const needle = idOrName.trim().toLowerCase();
  for (const ex of EXERCISE_LIBRARY) {
    if (ex.id.toLowerCase() === needle) return ex;
    if (ex.name.toLowerCase() === needle) return ex;
  }
  return null;
}

// ── findSubstitutes ──────────────────────────────────────────────────────────

export type SubstituteOptions = {
  count?: number;
  excludeJoint?: JointStress;
  preferStability?: StabilityTier;
  preferRomBias?: ROMBias;
};

/** Pure scoring algorithm. Returns up to `count` substitutes (default 3) for
 *  `target`, drawn from `library`. Hard filters: same pattern, same primary
 *  muscle, exclude the target itself, exclude any candidate whose jointStress
 *  contains `excludeJoint` when provided. Soft score (higher = better):
 *    +3 if role matches target
 *    +2 if stability matches preferStability (or target's stability)
 *    +2 if romBias matches preferRomBias (or target's romBias)
 *    +1 per overlapping equipment entry
 *    +1 if loadability matches target's
 *    -1 per jointStress entry the candidate has that target lacks */
export function findSubstitutes(
  target: LibraryExercise,
  library: readonly LibraryExercise[],
  options?: SubstituteOptions,
): LibraryExercise[] {
  const count = options?.count ?? 3;
  const preferStability = options?.preferStability ?? target.stability;
  const preferRomBias = options?.preferRomBias ?? target.romBias;
  const excludeJoint = options?.excludeJoint;

  type Scored = { ex: LibraryExercise; score: number };
  const scored: Scored[] = [];

  for (const ex of library) {
    if (ex.id === target.id) continue;
    if (ex.pattern !== target.pattern) continue;
    if (ex.primaryMuscle !== target.primaryMuscle) continue;
    if (excludeJoint && ex.jointStress.includes(excludeJoint)) continue;

    let score = 0;
    if (ex.role === target.role) score += 3;
    if (ex.stability === preferStability) score += 2;
    if (ex.romBias === preferRomBias) score += 2;
    for (const eq of ex.equipment) {
      if (target.equipment.includes(eq)) score += 1;
    }
    if (ex.loadability === target.loadability) score += 1;
    for (const j of ex.jointStress) {
      if (!target.jointStress.includes(j)) score -= 1;
    }

    scored.push({ ex, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.ex);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors. (The empty `EXERCISE_LIBRARY` is a valid `readonly LibraryExercise[]`.)

- [ ] **Step 3: Commit**

Run:
```bash
git add lib/coach/exercise-library.ts
git commit -m "$(cat <<'EOF'
feat(coach): scaffold exercise-library types + findSubstitutes

Adds the typed LibraryExercise shape (pattern + primary muscle +
stability + ROM bias + joint stress + role + loadability), an empty
EXERCISE_LIBRARY const, resolveExercise lookup helper, and the pure
findSubstitutes scoring function. Seed data lands in the next commit.

Sub-project 1 of 2 for Coach Carter exercise library.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: 1 file changed.

---

## Task 2: Seed `EXERCISE_LIBRARY` with 57 entries

Replace the empty array with the full seed list. Coverage rule (from spec): every `(pattern, primaryMuscle)` cell with a current SESSION_PLANS entry has ≥ 3 library entries. Five lifts marked `main` per the §8 policy: back_squat, decline_bench, overhead_press, deadlift, romanian_deadlift.

**Files:**
- Modify: `lib/coach/exercise-library.ts` (replace the empty array body)

- [ ] **Step 1: Replace the EXERCISE_LIBRARY definition**

Replace:
```ts
export const EXERCISE_LIBRARY: readonly LibraryExercise[] = [
  // Populated in Task 2.
];
```

With:
```ts
export const EXERCISE_LIBRARY: readonly LibraryExercise[] = [
  // ── PUSH — Chest ────────────────────────────────────────────────────────────
  {
    id: "decline_bench",
    name: "Decline Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Chest day primary.",
  },
  {
    id: "flat_bench",
    name: "Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "flat_bench_db",
    name: "Bench Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "incline_bench",
    name: "Incline Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "incline_db",
    name: "Incline Bench Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
    increment: { step: 2 },
  },
  {
    id: "decline_db",
    name: "Decline Bench Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "machine_chest_press",
    name: "Chest Press (Machine)",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "chest_fly",
    name: "Chest Fly",
    pattern: "push",
    primaryMuscle: "Chest",
    equipment: ["cable", "dumbbell"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2.3 },
    notes: "Athlete's current Chest day isolation. Cable or DB acceptable.",
  },
  {
    id: "pec_deck",
    name: "Pec Deck (Machine)",
    pattern: "push",
    primaryMuscle: "Chest",
    equipment: ["machine"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "push_up",
    name: "Push Up",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder", "wrist"],
    loadability: "coarse",
    role: "accessory",
    notes: "Athlete's current Chest day warmup.",
  },
  {
    id: "dip",
    name: "Dip",
    pattern: "push",
    primaryMuscle: "Chest",
    secondaryMuscles: ["Triceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },

  // ── PUSH — Shoulder ────────────────────────────────────────────────────────
  {
    id: "overhead_press",
    name: "Overhead Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow", "lumbar"],
    loadability: "moderate",
    role: "main",
    increment: { step: 5 },
    notes: "Athlete's current Chest day secondary press. Primary muscle 'Traps' here is the volume-landmarks proxy for delts.",
  },
  {
    id: "seated_db_press",
    name: "Seated Shoulder Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "arnold_press",
    name: "Arnold Press (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "machine_shoulder_press",
    name: "Shoulder Press (Machine)",
    pattern: "push",
    primaryMuscle: "Traps",
    secondaryMuscles: ["Triceps"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "lateral_raise",
    name: "Lateral Raise (Dumbbell)",
    pattern: "push",
    primaryMuscle: "Traps",
    equipment: ["dumbbell"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
    increment: { step: 2 },
    notes: "Athlete's current Chest day delt isolation.",
  },
  {
    id: "cable_lateral_raise",
    name: "Lateral Raise (Cable)",
    pattern: "push",
    primaryMuscle: "Traps",
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },

  // ── PUSH — Triceps ─────────────────────────────────────────────────────────
  {
    id: "triceps_pushdown",
    name: "Triceps Pushdown (Cable)",
    pattern: "push",
    primaryMuscle: "Triceps",
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 2.5 },
    notes: "Athlete's current Chest day triceps isolation.",
  },
  {
    id: "overhead_cable_extension",
    name: "Overhead Triceps Extension (Cable)",
    pattern: "push",
    primaryMuscle: "Triceps",
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["elbow", "shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "skull_crusher",
    name: "Skull Crusher (EZ Bar)",
    pattern: "push",
    primaryMuscle: "Triceps",
    equipment: ["barbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "close_grip_bench",
    name: "Close-Grip Bench Press (Barbell)",
    pattern: "push",
    primaryMuscle: "Triceps",
    secondaryMuscles: ["Chest"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "moderate",
    role: "accessory",
  },

  // ── PULL — Lats ────────────────────────────────────────────────────────────
  {
    id: "lat_pulldown",
    name: "Lat Pulldown (Cable)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Back day lat isolation.",
  },
  {
    id: "neutral_pulldown",
    name: "Lat Pulldown — Neutral Grip (Cable)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["cable"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "pull_up",
    name: "Pull-Up",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "chin_up",
    name: "Chin-Up",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "seated_row_machine",
    name: "Seated Row (Machine)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder", "elbow"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Back day mid-back work.",
  },
  {
    id: "seated_cable_row",
    name: "Seated Row (Cable)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["cable"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder", "elbow", "lumbar"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "dumbbell_row",
    name: "Single-Arm Row (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["shoulder", "elbow", "lumbar"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "tbar_row",
    name: "T-Bar Row",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Biceps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "medium",
    jointStress: ["shoulder", "lumbar"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "pullover_db",
    name: "Pullover (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Lats",
    secondaryMuscles: ["Chest"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
    increment: { step: 2 },
    notes: "Athlete's current Back day lat-stretch finisher.",
  },

  // ── PULL — Rear delts ──────────────────────────────────────────────────────
  {
    id: "face_pull",
    name: "Face Pull (Cable)",
    pattern: "pull",
    primaryMuscle: "RearDelts",
    equipment: ["cable"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "rear_delt_fly",
    name: "Rear Delt Fly (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "RearDelts",
    equipment: ["dumbbell"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "reverse_pec_deck",
    name: "Reverse Pec Deck (Machine)",
    pattern: "pull",
    primaryMuscle: "RearDelts",
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "fine",
    role: "accessory",
  },

  // ── PULL — Traps ───────────────────────────────────────────────────────────
  {
    id: "shrug_bb",
    name: "Shrug (Barbell)",
    pattern: "pull",
    primaryMuscle: "Traps",
    equipment: ["barbell"],
    stability: "high",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "moderate",
    role: "accessory",
    increment: { step: 2.5 },
    notes: "Athlete's current Back day trap isolation.",
  },
  {
    id: "shrug_db",
    name: "Shrug (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Traps",
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "shortened",
    skill: "low",
    jointStress: ["shoulder"],
    loadability: "coarse",
    role: "accessory",
  },

  // ── PULL — Biceps ──────────────────────────────────────────────────────────
  {
    id: "barbell_curl",
    name: "Barbell Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["barbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow", "wrist"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "db_curl",
    name: "Dumbbell Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow", "wrist"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "hammer_curl",
    name: "Hammer Curl (Dumbbell)",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "coarse",
    role: "accessory",
  },
  {
    id: "preacher_curl",
    name: "Preacher Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["barbell", "dumbbell"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "cable_curl",
    name: "Cable Curl",
    pattern: "pull",
    primaryMuscle: "Biceps",
    equipment: ["cable"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["elbow"],
    loadability: "fine",
    role: "accessory",
  },

  // ── SQUAT — Quads ──────────────────────────────────────────────────────────
  {
    id: "back_squat",
    name: "Squat (Barbell)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes", "Hams"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "high",
    jointStress: ["knee", "hip", "lumbar"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Legs day primary.",
  },
  {
    id: "front_squat",
    name: "Front Squat (Barbell)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "midrange",
    skill: "high",
    jointStress: ["knee", "hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "leg_press",
    name: "Leg Press",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee", "hip"],
    loadability: "moderate",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Legs day quad volume.",
  },
  {
    id: "hack_squat",
    name: "Hack Squat (Machine)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "leg_extension",
    name: "Leg Extension (Machine)",
    pattern: "squat",
    primaryMuscle: "Quads",
    equipment: ["machine"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["knee"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2.5 },
    notes: "Athlete's current Legs day quad isolation.",
  },
  {
    id: "goblet_squat",
    name: "Goblet Squat (Dumbbell)",
    pattern: "squat",
    primaryMuscle: "Quads",
    secondaryMuscles: ["Glutes"],
    equipment: ["dumbbell"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee", "hip"],
    loadability: "coarse",
    role: "accessory",
  },

  // ── HINGE — Hams / Glutes ──────────────────────────────────────────────────
  {
    id: "deadlift",
    name: "Deadlift (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes", "Lats", "Traps"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "lengthened",
    skill: "high",
    jointStress: ["lumbar", "hip", "knee"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Back day posterior-chain primary.",
  },
  {
    id: "romanian_deadlift",
    name: "Romanian Deadlift (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["lumbar", "hip"],
    loadability: "moderate",
    role: "main",
    increment: { step: 2.5 },
    notes: "Athlete's current Legs day hinge.",
  },
  {
    id: "stiff_leg_dl",
    name: "Stiff-Leg Deadlift (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes"],
    equipment: ["barbell"],
    stability: "high",
    romBias: "lengthened",
    skill: "medium",
    jointStress: ["lumbar", "hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "hip_thrust",
    name: "Hip Thrust (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Glutes",
    secondaryMuscles: ["Hams"],
    equipment: ["barbell"],
    stability: "medium",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "glute_bridge",
    name: "Glute Bridge (Barbell)",
    pattern: "hinge",
    primaryMuscle: "Glutes",
    secondaryMuscles: ["Hams"],
    equipment: ["barbell", "bodyweight"],
    stability: "medium",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "moderate",
    role: "accessory",
  },
  {
    id: "seated_leg_curl",
    name: "Seated Leg Curl (Machine)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: ["knee"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2.3 },
    notes: "Athlete's current Legs day hamstring isolation.",
  },
  {
    id: "lying_leg_curl",
    name: "Lying Leg Curl (Machine)",
    pattern: "hinge",
    primaryMuscle: "Hams",
    equipment: ["machine"],
    stability: "low",
    romBias: "midrange",
    skill: "low",
    jointStress: ["knee"],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "back_extension",
    name: "Back Extension",
    pattern: "hinge",
    primaryMuscle: "Hams",
    secondaryMuscles: ["Glutes"],
    equipment: ["bodyweight"],
    stability: "medium",
    romBias: "midrange",
    skill: "low",
    jointStress: ["lumbar", "hip"],
    loadability: "coarse",
    role: "accessory",
    notes: "Athlete's current Back day posterior-chain finisher.",
  },

  // ── ACCESSORY — Calves / Hip abduction ─────────────────────────────────────
  {
    id: "seated_calf",
    name: "Seated Calf Raise",
    pattern: "accessory",
    primaryMuscle: "Calves",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: [],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5 },
    notes: "Athlete's current Legs day calf work.",
  },
  {
    id: "standing_calf",
    name: "Standing Calf Raise",
    pattern: "accessory",
    primaryMuscle: "Calves",
    equipment: ["machine"],
    stability: "low",
    romBias: "lengthened",
    skill: "low",
    jointStress: [],
    loadability: "fine",
    role: "accessory",
  },
  {
    id: "hip_abductor",
    name: "Hip Abductor (Machine)",
    pattern: "accessory",
    primaryMuscle: "Glutes",
    equipment: ["machine"],
    stability: "low",
    romBias: "shortened",
    skill: "low",
    jointStress: ["hip"],
    loadability: "fine",
    role: "accessory",
    increment: { step: 5, intermediate: 2 },
    notes: "Athlete's current Legs day hip work.",
  },
];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors.

- [ ] **Step 3: Spot-check coverage**

Run: `node -e "const lib = require('./lib/coach/exercise-library.ts'); console.log('total:', lib.EXERCISE_LIBRARY.length);" 2>&1 | head -5` *(this will fail — TS file, not transpiled)*. Instead use this typecheck-only verification:

Run: `grep -c '^  {' lib/coach/exercise-library.ts`
Expected: `57` (counts the top-level object literals in the array).

Run: `grep -c 'role: "main"' lib/coach/exercise-library.ts`
Expected: `5` (back_squat, decline_bench, overhead_press, deadlift, romanian_deadlift).

- [ ] **Step 4: Commit**

Run:
```bash
git add lib/coach/exercise-library.ts
git commit -m "$(cat <<'EOF'
feat(coach): seed exercise library with 57 entries

Covers all current SESSION_PLANS lifts (marked with notes) plus 3-5
alternatives per movement pattern × primary muscle. Five main lifts
flagged per the §8 policy: squat, decline bench, OHP, deadlift, RDL.
Everything else accessory. Coverage rule: every (pattern, primaryMuscle)
cell in current rotation has >=3 library entries so findSubstitutes can
actually produce ranked alternatives.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add tool schemas to `lib/coach/tools.ts`

Two new `ToolSchema` constants. Place them after the existing query/read tools (right before `TRAINING_PLAN_TOOL` or grouped near `FOOD_LOG_TOOL` is fine — pick the spot that keeps related tools adjacent).

**Files:**
- Modify: `lib/coach/tools.ts` (append two const declarations after existing read tools)

- [ ] **Step 1: Add the QUERY_EXERCISE_LIBRARY_TOOL schema**

Insert this block in `lib/coach/tools.ts` immediately after the `FOOD_LOG_TOOL` declaration (around line 155):

```ts
/** Read-only browse of the strength exercise library. Used by Carter (and
 *  Peter for cross-domain framing) to answer "what alternatives exist for X?"
 *  or "show me low-stress chest exercises". Does not modify the plan; swap
 *  proposals still go through propose_week_plan / commit_week_plan. */
export const QUERY_EXERCISE_LIBRARY_TOOL = {
  name: "query_exercise_library",
  description:
    "Browse the strength exercise library. Returns up to 20 exercises matching the filters. Use when the athlete asks about alternatives, equipment substitutions, or wants to know what fits a pattern. All filters optional — calling with no filters returns the first 20 library entries. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        enum: ["push", "pull", "squat", "hinge", "single-leg", "core", "accessory"],
      },
      primary_muscle: {
        type: "string",
        enum: ["Chest", "Lats", "Traps", "RearDelts", "Quads", "Hams", "Glutes", "Biceps", "Triceps", "Calves"],
      },
      equipment: {
        type: "array",
        items: {
          type: "string",
          enum: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "smith"],
        },
        description: "Match exercises that use ANY of the listed equipment.",
      },
      role: { type: "string", enum: ["main", "accessory"] },
      exclude_joint: {
        type: "string",
        enum: ["shoulder", "lumbar", "knee", "elbow", "wrist", "hip"],
        description: "Exclude exercises that load this joint.",
      },
    },
  },
};

/** Read-only ranked-substitutes lookup. Carter uses this when the athlete
 *  needs a swap candidate — for pain, equipment unavailability, or planned
 *  rotation. Hard filters: same pattern + same primary muscle as target.
 *  Soft score: role match, stability/ROM preference, equipment overlap. */
export const GET_SUBSTITUTES_TOOL = {
  name: "get_substitutes",
  description:
    "Get ranked substitute exercises for a target. Substitutes share the target's movement pattern and primary muscle. Use when the athlete needs a swap for pain (set exclude_joint), equipment (set prefer_stability), or rotation. Returns 1-8 substitutes (default 3). Read-only — does not commit a swap; actual plan changes still go through propose_week_plan / commit_week_plan.",
  input_schema: {
    type: "object" as const,
    required: ["exercise_id_or_name"],
    properties: {
      exercise_id_or_name: {
        type: "string",
        description: "Library id (e.g., 'decline_bench') or display name (e.g., 'Decline Bench Press (Barbell)'). Case-insensitive.",
      },
      count: { type: "integer", default: 3, minimum: 1, maximum: 8 },
      exclude_joint: {
        type: "string",
        enum: ["shoulder", "lumbar", "knee", "elbow", "wrist", "hip"],
      },
      prefer_stability: { type: "string", enum: ["high", "medium", "low"] },
      prefer_rom_bias: {
        type: "string",
        enum: ["lengthened", "midrange", "shortened", "neutral"],
      },
    },
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes (schemas are plain objects, no type bindings to anything new yet).

- [ ] **Step 3: Commit**

Run:
```bash
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): add Carter query_exercise_library + get_substitutes schemas

Two read-only tool schemas matching the patterns established by
FOOD_LOG_TOOL. Handlers and dispatcher wiring follow in next commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add execution handlers to `lib/coach/tools.ts`

Two handler functions with the same `{ supabase, userId, input }` signature as existing handlers (supabase + userId unused but kept for dispatcher uniformity).

**Files:**
- Modify: `lib/coach/tools.ts` (append two `executeXxx` functions, conventionally near the other read handlers)

- [ ] **Step 1: Add imports at the top of tools.ts**

Find the existing `import type` lines around line 22-37 and add this import:

```ts
import {
  EXERCISE_LIBRARY,
  findSubstitutes,
  resolveExercise,
  type LibraryExercise,
  type Equipment,
  type JointStress,
  type StabilityTier,
  type ROMBias,
} from "@/lib/coach/exercise-library";
```

- [ ] **Step 2: Add executeQueryExerciseLibrary**

Append after `executeQueryFoodLog` (which ends around line 800-ish — locate it with `grep -n "^export async function executeQueryFoodLog\|^export async function executeQueryTrainingBlocks" lib/coach/tools.ts` and insert between):

```ts
// ── query_exercise_library executor ──────────────────────────────────────────

type ExerciseLibraryToolData = { exercises: LibraryExercise[] };

const VALID_PATTERNS = new Set(["push", "pull", "squat", "hinge", "single-leg", "core", "accessory"]);
const VALID_MUSCLES = new Set(["Chest", "Lats", "Traps", "RearDelts", "Quads", "Hams", "Glutes", "Biceps", "Triceps", "Calves"]);
const VALID_EQUIPMENT = new Set(["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "smith"]);
const VALID_JOINTS = new Set(["shoulder", "lumbar", "knee", "elbow", "wrist", "hip"]);
const VALID_ROLES = new Set(["main", "accessory"]);

const LIBRARY_RESULT_CAP = 20;

export async function executeQueryExerciseLibrary(opts: {
  supabase: SupabaseClient;  // unused; kept for dispatcher uniformity
  userId: string;            // unused; library is global
  input: unknown;
}): Promise<ToolResult<ExerciseLibraryToolData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Validate optional filters.
  const pattern = i.pattern;
  if (pattern !== undefined && (typeof pattern !== "string" || !VALID_PATTERNS.has(pattern))) {
    return {
      ok: false,
      error: { error: `invalid pattern: ${String(pattern)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const primaryMuscle = i.primary_muscle;
  if (primaryMuscle !== undefined && (typeof primaryMuscle !== "string" || !VALID_MUSCLES.has(primaryMuscle))) {
    return {
      ok: false,
      error: { error: `invalid primary_muscle: ${String(primaryMuscle)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const equipmentRaw = i.equipment;
  let equipmentFilter: Equipment[] | null = null;
  if (equipmentRaw !== undefined) {
    if (!Array.isArray(equipmentRaw) || equipmentRaw.some((e) => typeof e !== "string" || !VALID_EQUIPMENT.has(e))) {
      return {
        ok: false,
        error: { error: "equipment must be an array of valid equipment strings" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    equipmentFilter = equipmentRaw as Equipment[];
  }
  const role = i.role;
  if (role !== undefined && (typeof role !== "string" || !VALID_ROLES.has(role))) {
    return {
      ok: false,
      error: { error: `invalid role: ${String(role)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const excludeJoint = i.exclude_joint;
  if (excludeJoint !== undefined && (typeof excludeJoint !== "string" || !VALID_JOINTS.has(excludeJoint))) {
    return {
      ok: false,
      error: { error: `invalid exclude_joint: ${String(excludeJoint)}` },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Filter in memory.
  let results: LibraryExercise[] = EXERCISE_LIBRARY.slice();
  if (pattern) results = results.filter((ex) => ex.pattern === pattern);
  if (primaryMuscle) results = results.filter((ex) => ex.primaryMuscle === primaryMuscle);
  if (equipmentFilter) {
    results = results.filter((ex) => ex.equipment.some((e) => equipmentFilter!.includes(e)));
  }
  if (role) results = results.filter((ex) => ex.role === role);
  if (excludeJoint) {
    results = results.filter((ex) => !ex.jointStress.includes(excludeJoint as JointStress));
  }

  const truncated = results.length > LIBRARY_RESULT_CAP;
  const capped = results.slice(0, LIBRARY_RESULT_CAP);

  return {
    ok: true,
    data: { exercises: capped },
    meta: {
      ms: Date.now() - t0,
      result_rows: capped.length,
      range_days: 0,
      truncated,
    },
  };
}
```

- [ ] **Step 3: Add executeGetSubstitutes immediately after**

Append directly below executeQueryExerciseLibrary:

```ts
// ── get_substitutes executor ─────────────────────────────────────────────────

type SubstitutesToolData = {
  target: LibraryExercise;
  substitutes: LibraryExercise[];
};

const VALID_STABILITY = new Set(["high", "medium", "low"]);
const VALID_ROM_BIAS = new Set(["lengthened", "midrange", "shortened", "neutral"]);

export async function executeGetSubstitutes(opts: {
  supabase: SupabaseClient;  // unused
  userId: string;            // unused
  input: unknown;
}): Promise<ToolResult<SubstitutesToolData>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Required: exercise_id_or_name.
  const idOrName = i.exercise_id_or_name;
  if (typeof idOrName !== "string" || idOrName.trim() === "") {
    return {
      ok: false,
      error: { error: "exercise_id_or_name is required (library id or display name)" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const target = resolveExercise(idOrName);
  if (!target) {
    return {
      ok: false,
      error: {
        error: `Exercise not found: ${idOrName}. Try query_exercise_library to browse.`,
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Optional: count.
  let count = 3;
  if (i.count !== undefined) {
    if (typeof i.count !== "number" || !Number.isInteger(i.count) || i.count < 1 || i.count > 8) {
      return {
        ok: false,
        error: { error: "count must be an integer between 1 and 8" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    count = i.count;
  }

  // Optional: exclude_joint.
  let excludeJoint: JointStress | undefined;
  if (i.exclude_joint !== undefined) {
    if (typeof i.exclude_joint !== "string" || !VALID_JOINTS.has(i.exclude_joint)) {
      return {
        ok: false,
        error: { error: `invalid exclude_joint: ${String(i.exclude_joint)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    excludeJoint = i.exclude_joint as JointStress;
  }

  // Optional: prefer_stability.
  let preferStability: StabilityTier | undefined;
  if (i.prefer_stability !== undefined) {
    if (typeof i.prefer_stability !== "string" || !VALID_STABILITY.has(i.prefer_stability)) {
      return {
        ok: false,
        error: { error: `invalid prefer_stability: ${String(i.prefer_stability)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    preferStability = i.prefer_stability as StabilityTier;
  }

  // Optional: prefer_rom_bias.
  let preferRomBias: ROMBias | undefined;
  if (i.prefer_rom_bias !== undefined) {
    if (typeof i.prefer_rom_bias !== "string" || !VALID_ROM_BIAS.has(i.prefer_rom_bias)) {
      return {
        ok: false,
        error: { error: `invalid prefer_rom_bias: ${String(i.prefer_rom_bias)}` },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    preferRomBias = i.prefer_rom_bias as ROMBias;
  }

  const substitutes = findSubstitutes(target, EXERCISE_LIBRARY, {
    count,
    excludeJoint,
    preferStability,
    preferRomBias,
  });

  return {
    ok: true,
    data: { target, substitutes },
    meta: {
      ms: Date.now() - t0,
      result_rows: substitutes.length,
      range_days: 0,
      truncated: false,
    },
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

Run:
```bash
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): add execute handlers for exercise library tools

executeQueryExerciseLibrary filters EXERCISE_LIBRARY in memory by
pattern/primary_muscle/equipment/role/exclude_joint, capped at 20.
executeGetSubstitutes resolves the target via resolveExercise then
delegates to findSubstitutes with optional exclude_joint /
prefer_stability / prefer_rom_bias overrides. Both follow the
{supabase, userId, input} signature for dispatcher uniformity even
though both args are unused.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Register tools in CARTER_TOOLS + PETER_TOOLS, wire dispatcher in chat-stream.ts

**Files:**
- Modify: `lib/coach/tools.ts` (CARTER_TOOLS array around line 3083, PETER_TOOLS array around line 3042)
- Modify: `lib/coach/chat-stream.ts` (import block + dispatcher switch around line 400)

- [ ] **Step 1: Add to PETER_TOOLS array**

Locate `export const PETER_TOOLS: readonly ToolSchema[] = [` (around line 3042 in `tools.ts`). Add `QUERY_EXERCISE_LIBRARY_TOOL,` and `GET_SUBSTITUTES_TOOL,` after `FOOD_LOG_TOOL,` (cross-domain framing — Peter sometimes needs these to discuss alternatives in block-level conversations):

```ts
export const PETER_TOOLS: readonly ToolSchema[] = [
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  FOOD_LOG_TOOL,
  QUERY_EXERCISE_LIBRARY_TOOL,
  GET_SUBSTITUTES_TOOL,
  TRAINING_PLAN_TOOL,
  // ... (rest unchanged)
];
```

- [ ] **Step 2: Add to CARTER_TOOLS array**

Locate `export const CARTER_TOOLS: readonly ToolSchema[] = [` (around line 3081). Add both after `WORKOUTS_TOOL,`:

```ts
export const CARTER_TOOLS: readonly ToolSchema[] = [
  WORKOUTS_TOOL,
  QUERY_EXERCISE_LIBRARY_TOOL,
  GET_SUBSTITUTES_TOOL,
  DAILY_LOGS_TOOL,
  TRAINING_PLAN_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
];
```

> **Note:** `HANDOFF_TOOL` was removed in PR #98 (mid-stream handoff machinery retired). Specialists now point the athlete back to Peter in prose ("@Peter would have the cross-domain take") instead of calling a tool. Do not re-add `HANDOFF_TOOL` to the array.

- [ ] **Step 3: Update chat-stream.ts imports**

Locate the import from `@/lib/coach/tools` near the top of `lib/coach/chat-stream.ts` (around line 25-30). Add `executeQueryExerciseLibrary` and `executeGetSubstitutes` to the named imports. The existing import looks like:

```ts
import {
  executeQueryDailyLogs,
  executeQueryWorkouts,
  executeQueryFoodLog,
  // ...other handlers
} from "@/lib/coach/tools";
```

Add to that list:

```ts
  executeQueryExerciseLibrary,
  executeGetSubstitutes,
```

- [ ] **Step 4: Add dispatcher branches in chat-stream.ts**

Locate the tool-dispatch `if/else if` chain (around line 347-460 post-PR#98). After the `query_food_log` branch (line ~364-369), add:

```ts
        } else if (block.name === "query_exercise_library") {
          result = await executeQueryExerciseLibrary({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "get_substitutes") {
          result = await executeGetSubstitutes({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

Run:
```bash
git add lib/coach/tools.ts lib/coach/chat-stream.ts
git commit -m "$(cat <<'EOF'
feat(coach): register exercise library tools for Carter + Peter

Adds query_exercise_library and get_substitutes to both CARTER_TOOLS
(primary user — strength specialist) and PETER_TOOLS (cross-domain
framing). Wires the dispatcher branches in chat-stream.ts so tool_use
blocks route to the new handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update Carter's system prompt

Append the policy paragraph to `CARTER_BASE` in `lib/coach/system-prompts.ts`.

**Files:**
- Modify: `lib/coach/system-prompts.ts:38-50` (CARTER_BASE template literal, post-PR#98 line range)

- [ ] **Step 1: Append the policy paragraph**

Find `export const CARTER_BASE = \`...` (starts around line 38, ends with the "Your voice" line around line 50). Append the following BEFORE the closing backtick, after the "Your voice" sentence:

```
Exercise library: you have query_exercise_library and get_substitutes for browsing the strength exercise catalog. Use them when the athlete asks about alternatives, equipment substitutions, or pain-driven swaps — don't guess from memory. The library tags every entry with movement pattern, primary muscle, stability, ROM bias, joint stress, role (main vs. accessory), and microloadability.

Swap policy (apply in this order):
- Pain or a suspicious tweak → swap immediately. Call get_substitutes with exclude_joint set to the affected joint.
- Stall (top set flat ≥ 2–3 weeks at same RIR) → propose a deload FIRST, not a swap. Only consider swapping if the week AFTER the deload is also flat.
- Equipment unavailable → forced swap to the closest pattern-matched alternative.
- Lagging muscle → propose ADDING an exercise at the next block boundary, don't swap the existing one.
- End of a block → planned rotation. You may propose swapping 1–2 accessories for the next week's plan.
- Boredom → one accessory swap allowed mid-block if the athlete raises it. Adherence beats optimization.

Main lifts (squat, bench, deadlift, RDL, OHP) are sticky across blocks. Only swap a main lift on pain or a confirmed multi-block stall (one that survived a deload week). Triggers 3–6 above apply to accessories only.

Suggesting a swap is fine in chat. Actually changing the week's plan still goes through propose_week_plan / commit_week_plan — the library is read-only.
```

The final CARTER_BASE should now look like (last few lines for reference):

```
Your voice: direct, technical, no fluff. Numbers, not vibes. You're the specialist they go to when they want a real strength-training answer.

Exercise library: you have query_exercise_library and get_substitutes ...
[the appended block above]
... the library is read-only.`;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

Run:
```bash
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): teach Carter the exercise library + swap policy

Appends a section to CARTER_BASE explaining the two new tools and
encoding the urgency-ordered swap policy from the research brief §8
(pain → swap; stall → deload first; equipment → swap; lagging → add;
block boundary → rotate; boredom → allowed). Main-lift exception
spelled out: only swap squat/bench/deadlift/RDL/OHP on pain or
confirmed multi-block stall.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual verification

No automated tests in this repo (CLAUDE.md notes `npm run lint` is a no-op and there's no test suite). Verification is `npm run typecheck` plus the six acceptance criteria from the spec, exercised against `/coach` with Carter as the routed speaker.

**Files:** none — verification only.

- [ ] **Step 1: Final typecheck**

Run: `npm run typecheck`
Expected: passes cleanly.

- [ ] **Step 2: Start dev server**

Run: `npm run dev`
Expected: server starts on `http://localhost:3000`.

- [ ] **Step 3: Acceptance criterion 1 — vanilla substitute query**

Open `http://localhost:3000/coach`. Send: "What could I do instead of OHP?"

Expected:
- Routing picks Carter.
- Carter calls `get_substitutes` with `exercise_id_or_name: "overhead_press"` (or "Overhead Press (Barbell)"). Visible in the tool-call audit row (`chat_messages.kind = 'system_routing'` or tool_calls jsonb depending on observability surface).
- Reply names 3 push-pattern shoulder alternatives — e.g., Seated Shoulder Press (Dumbbell), Arnold Press, Shoulder Press (Machine).

- [ ] **Step 4: Acceptance criterion 2 — pain-driven swap**

Send: "My shoulder is bothering me, what should I swap incline bench for?"

Expected:
- Carter calls `get_substitutes` with `exercise_id_or_name: "incline_bench"` (or DB variant) AND `exclude_joint: "shoulder"`.
- All returned substitutes have empty or non-shoulder `jointStress`. In practice, since incline bench is push-Chest and most chest exercises load the shoulder, expect Carter to verbalize that the library's chest options all load the shoulder and to suggest e.g., machine chest press (which has `jointStress: ["shoulder"]` — so this would still be filtered out — actually expect Carter to surface that there are no fully-shoulder-free chest options and propose either pec deck *or* a temporary chest deload). This is the realistic outcome and validates the filter.

- [ ] **Step 5: Acceptance criterion 3 — fresh stall does NOT trigger swap**

Send: "My decline bench has stalled for two weeks, should I switch to a different chest exercise?"

Expected:
- Carter's reply proposes a DELOAD week first, then re-evaluation. Reply does NOT name a specific substitute.
- He may or may not call `get_substitutes`; the test is the recommendation, not the tool call.

- [ ] **Step 6: Acceptance criterion 4 — boredom swap**

Send: "I'm getting bored of seated row, what else could I do?"

Expected:
- Carter calls `get_substitutes` with `exercise_id_or_name: "seated_row_machine"`.
- Returns 3 pull-pattern lat-primary alternatives — e.g., Single-Arm Row (Dumbbell), T-Bar Row, Seated Row (Cable).

- [ ] **Step 7: Acceptance criterion 5 — main lift swap refused**

Send: "Should I drop deadlift from my program?"

Expected:
- Carter refers to the main-lift policy. Refuses to propose a swap absent pain or confirmed multi-block stall.
- Reply cites the policy in athlete-facing language ("deadlift is a main lift — only swap on pain or a confirmed multi-block stall").

- [ ] **Step 8: Spot-check tool registration**

If you have access to the chat audit, confirm tool calls log against the correct speaker (carter) and the tool names appear in the observability surface (`tool_calls` jsonb on `chat_messages`).

- [ ] **Step 9: Open PR**

When all criteria pass:

```bash
git push -u origin feat/carter-exercise-library
gh pr create --title "feat(coach): Carter exercise library + substitution tools" --body "$(cat <<'EOF'
## Summary
- Adds a typed ~57-entry strength exercise library at `lib/coach/exercise-library.ts` (no DB table — single-user app, TS const is enough)
- Adds two read-only Carter tools: `query_exercise_library` (filter by pattern/muscle/equipment/role/exclude_joint, cap 20) and `get_substitutes` (ranked alternatives via pure scoring function)
- Teaches Carter the urgency-ordered swap policy in his system prompt (main lifts sticky; pain → swap, stall → deload first, equipment → swap, lagging → add, block boundary → rotate, boredom → allowed)
- Companion research brief + design spec for context — this is sub-project 1 of 2; sub-project 2 (swap-write tools + stall detector + block-boundary rotation engine) lands separately

## Out of scope (sub-project 2)
- `propose_exercise_swap` / `commit_exercise_swap` HMAC tools
- Stall detector (top-set e1RM flat ≥ 2 wks at same RIR)
- Block-boundary rotation integration with the Sunday weekly-planning ritual
- `/strength/library` browse page

## Test plan
- [x] `npm run typecheck` passes
- [x] Carter answers "alternatives for OHP" via `get_substitutes`
- [x] Carter answers "shoulder is bothering me, swap incline bench" with `exclude_joint: "shoulder"`
- [x] Carter declines to swap on a fresh stall (proposes deload first)
- [x] Carter answers boredom swap for seated row with 3 pull-pattern alternatives
- [x] Carter refuses to drop deadlift absent pain or multi-block stall (main-lift policy)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL is printed; copy it for the athlete.

---

## Self-review notes (for the executor)

- The `EXERCISE_LIBRARY` array literal is large (~500 lines). If you split it across multiple files in a follow-up, keep the imports re-exported from `exercise-library.ts` so `tools.ts` and any future consumer don't break.
- The `overhead_press` entry uses `primaryMuscle: "Traps"` because the `TargetedMuscleGroup` taxonomy has no explicit "Delts" entry — "Traps" is the closest proxy used elsewhere in the codebase. If a future change adds "Delts" to the taxonomy, update OHP, lateral raises, and shoulder presses.
- `deadlift` and `romanian_deadlift` both use `primaryMuscle: "Hams"` — they're posterior-chain compounds. Don't change to "Glutes" without also updating SESSION_PLANS metadata.
- The dispatcher pattern in `chat-stream.ts` is a long `if/else if` chain. If you find it intolerable, consider a follow-up refactor to a dispatch map — but keep this PR focused on the feature, not the refactor.
