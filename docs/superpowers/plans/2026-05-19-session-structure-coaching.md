# Session-Structure Coaching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode bodybuilding intra-session expertise (fatigue tiers, ordering rules, rest periods, RPE cues) as a deterministic rule engine that annotates today's prescribed session in the morning brief and `/strength` tab, with a one-tap "Apply reorder" chip when ordering violations are detected.

**Architecture:** Pure-function rule engine at `lib/coach/session-structure/`. New `training_weeks.exercise_overrides jsonb` column persists per-weekday reorders. Brief assembler and the `/strength` page both call `getEffectiveSessionPlan(...)` → `annotateSession(...)` and pass the result to shared UI (chip + cue + banner). Reorder chip POSTs to a new endpoint that upserts the override map.

**Tech Stack:** Next 15 App Router, TypeScript strict, Supabase (RLS-respecting cookie-bound server client + service-role for migrations), TanStack Query for client cache, Tailwind v4. **No test suite** — verification is `npm run typecheck` plus manual browser exercise per CLAUDE.md.

**Spec:** [`docs/superpowers/specs/2026-05-19-session-structure-coaching-design.md`](../specs/2026-05-19-session-structure-coaching-design.md) (commit `323cd5e`).

---

## Verification convention

This codebase has no test runner. Every task ends with:
1. `npm run typecheck` — must pass with no new errors.
2. (Tasks touching UI) `npm run dev` and load the affected page; confirm the described behavior.
3. Commit with the prescribed conventional-commit message.

The plan calls `npm run typecheck` and `npm run dev` out explicitly where needed.

---

## Task 1: Add migration `0022_exercise_overrides.sql`

**Files:**
- Create: `supabase/migrations/0022_exercise_overrides.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0022_exercise_overrides.sql`:

```sql
-- 0022_exercise_overrides.sql
--
-- Adds exercise_overrides jsonb to training_weeks. Shape (validated app-side
-- by /api/training-weeks/[week_start]/exercise-overrides — jsonb stays flexible):
--   {
--     "Monday": [ {name, sets?, reps?, baseKg?, warmup?, note?, key?, increment?, baseReps?} ... ],
--     "Tuesday": [...],
--     ...
--   } | null
-- NULL means "no overrides; resolver falls through to SESSION_PLANS[session_plan[weekday]]".
-- Keys use FULL weekday names ("Monday", not "Mon") to match what weekdayInUserTz() returns
-- and what the AI planning bot already writes in session_plan jsonb.
-- Permutation-only: the override list for a day must contain the same set of exercise
-- names as the static SESSION_PLANS[type] for that day; only order may change.

alter table training_weeks
  add column exercise_overrides jsonb;

comment on column training_weeks.exercise_overrides is
  'Per-day reorder of the static SESSION_PLANS exercise list. Shape: {"Monday": [PlannedExercise...], ...}. NULL = no overrides; resolver falls through to SESSION_PLANS[session_plan[weekday]]. Written by /api/training-weeks/[week_start]/exercise-overrides.';
```

- [ ] **Step 2: Apply the migration**

Run:
```bash
supabase db push
```

Expected: prints a "Pushed migration 0022_exercise_overrides.sql" line. If the CLI reports "already applied", run `supabase migration repair --status applied 0022` then re-push.

Verify the column exists:
```bash
supabase db psql --command "\d training_weeks" | grep exercise_overrides
```

Expected output:
```
 exercise_overrides | jsonb |
```

- [ ] **Step 3: Update CLAUDE.md migration list**

Open `CLAUDE.md`, find the numbered list under "## Database migrations", append after item 21:

```markdown
22. [supabase/migrations/0022_exercise_overrides.sql](supabase/migrations/0022_exercise_overrides.sql) — adds nullable `training_weeks.exercise_overrides jsonb` storing per-day reordered exercise lists. NULL fallback to static `SESSION_PLANS`. Permutation-only (same name set, different order). Written by `/api/training-weeks/[week_start]/exercise-overrides`.
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0022_exercise_overrides.sql CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(coach): add training_weeks.exercise_overrides migration

Per-day reorder column for the session-structure feature. NULL by
default; resolver in a follow-up commit falls through to static
SESSION_PLANS when absent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `ExerciseOverrides` type + `exercise_overrides` field on `TrainingWeek`

**Files:**
- Modify: `lib/data/types.ts` (around line 232–263, training_weeks block)

- [ ] **Step 1: Read the current TrainingWeek block**

Verify the current shape at [lib/data/types.ts:230-263](../../lib/data/types.ts#L230-L263) matches the spec.

- [ ] **Step 2: Add `ExerciseOverrides` type and field**

Edit `lib/data/types.ts`. Find the line:

```ts
export type ProposedBy = "coach" | "user";
```

Immediately after it (before `export type TrainingWeek = {`), add:

```ts
/** Per-weekday reorder of the static SESSION_PLANS exercise list. Keys are
 *  full weekday names ("Monday", not "Mon") to match weekdayInUserTz() and
 *  the AI bot's session_plan output. Each value is the complete reordered
 *  PlannedExercise[] for that day. Permutation-only: same name set as the
 *  static plan, different order. NULL means no overrides for any day. */
export type ExerciseOverrides = Record<string, import("@/lib/coach/sessionPlans").PlannedExercise[]>;
```

Then find the `TrainingWeek` type body and add `exercise_overrides` immediately after `original_session_plan`:

Replace:
```ts
  original_session_plan: SessionPlan | null;
  weekly_focus: string | null;
```

With:
```ts
  original_session_plan: SessionPlan | null;
  /** Per-day reordered exercise lists. NULL means no overrides set for any day;
   *  resolver falls through to SESSION_PLANS[session_plan[weekday]]. */
  exercise_overrides: ExerciseOverrides | null;
  weekly_focus: string | null;
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes. (The `import(...)` inline type avoids circular imports between `types.ts` and `sessionPlans.ts`.)

- [ ] **Step 4: Commit**

```bash
git add lib/data/types.ts
git commit -m "$(cat <<'EOF'
feat(coach): TrainingWeek.exercise_overrides type

TS type mirror for migration 0022. Inline import avoids the circular
sessionPlans <-> types dep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fix static `SESSION_PLANS.Chest` order + add `getEffectiveSessionPlan()`

**Files:**
- Modify: `lib/coach/sessionPlans.ts`

- [ ] **Step 1: Reorder Chest array and drop the redundant note**

Edit `lib/coach/sessionPlans.ts`. Find the `Chest:` block (around line 28). Replace:

```ts
  Chest: [
    { name: "Push Up", warmup: true, reps: "12×3" },
    { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench", increment: { step: 2.5 } },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 32, baseReps: 11, sets: 3, key: "incline_db", increment: { step: 2 } },
    { name: "Chest Fly", baseKg: 22, baseReps: 15, sets: 3, key: "chest_fly", increment: { step: 5, intermediate: 2.3 } },
    { name: "Overhead Press (Barbell)", baseKg: 30, baseReps: 7, sets: 3, key: "ohp", note: "Do BEFORE Incline DB", increment: { step: 5 } },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 12, sets: 4, key: "lateral_raise", note: "Jump from 8kg — next DB is 12kg", increment: { step: 2 } },
    { name: "Triceps Pushdown (Cable)", baseKg: 23, baseReps: 15, sets: 3, key: "triceps", increment: { step: 2.5 } },
  ],
```

With (OHP moved to slot 3, after Decline Bench; redundant `note` dropped):

```ts
  Chest: [
    { name: "Push Up", warmup: true, reps: "12×3" },
    { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench", increment: { step: 2.5 } },
    { name: "Overhead Press (Barbell)", baseKg: 30, baseReps: 7, sets: 3, key: "ohp", increment: { step: 5 } },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 32, baseReps: 11, sets: 3, key: "incline_db", increment: { step: 2 } },
    { name: "Chest Fly", baseKg: 22, baseReps: 15, sets: 3, key: "chest_fly", increment: { step: 5, intermediate: 2.3 } },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 12, sets: 4, key: "lateral_raise", note: "Jump from 8kg — next DB is 12kg", increment: { step: 2 } },
    { name: "Triceps Pushdown (Cable)", baseKg: 23, baseReps: 15, sets: 3, key: "triceps", increment: { step: 2.5 } },
  ],
```

Tier sequence is now: Push Up (0) → Decline Bench (1) → OHP (1) → Incline DB (2) → Chest Fly (3) → Lateral Raise (3) → Triceps Pushdown (3) — strictly non-decreasing.

- [ ] **Step 2: Add `getEffectiveSessionPlan` resolver at the bottom of the file**

Append to `lib/coach/sessionPlans.ts`:

```ts
import type { ExerciseOverrides } from "@/lib/data/types";

/** Resolve the effective exercise list for a given session type + weekday,
 *  preferring an `exercise_overrides` entry when present. Override keys are
 *  full weekday names ("Monday", not "Mon"). When no override exists for
 *  `weekday`, returns the static `SESSION_PLANS[sessionType]` (or [] if the
 *  type is unknown / "REST"). */
export function getEffectiveSessionPlan(
  sessionType: string,
  weekday: string,
  overrides: ExerciseOverrides | null | undefined,
): PlannedExercise[] {
  const override = overrides?.[weekday];
  if (override && override.length > 0) return override;
  return SESSION_PLANS[sessionType] ?? [];
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes. The new helper is unused yet but the import resolves.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/sessionPlans.ts
git commit -m "$(cat <<'EOF'
feat(coach): SESSION_PLANS.Chest reorder + getEffectiveSessionPlan resolver

OHP moves from slot 5 to slot 3 (after Decline Bench, before Incline DB),
which is what the existing 'Do BEFORE Incline DB' note already prescribed
manually. Note dropped — order now enforces it. Tier sequence is
strictly non-decreasing.

getEffectiveSessionPlan() reads training_weeks.exercise_overrides first,
falls back to the static SESSION_PLANS entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Build `lib/coach/session-structure/tiers.ts`

**Files:**
- Create: `lib/coach/session-structure/tiers.ts`

- [ ] **Step 1: Create the tiers module**

Create `lib/coach/session-structure/tiers.ts`:

```ts
// lib/coach/session-structure/tiers.ts
//
// Fatigue-tier classification. Orthogonal to EXERCISE_CATEGORY (push/pull/
// squat/hinge/single-leg/core/accessory) — that one answers "what movement
// pattern", this one answers "how taxing / where should this sit in the
// session?". Lookup is by NORMALIZED exercise name (see normalize() from
// exercise-categories.ts). Unknown names fall back to a category-based
// heuristic.
//
// Tiers:
//   0 — warmup / mobility ramp-up
//   1 — heavy compound, CNS-taxing (BIG_FOUR, plus weighted dip/pull-up)
//   2 — secondary compound (DB bench, leg press, RDL, row, pulldown, pullover)
//   3 — isolation (curls, pushdowns, lateral raise, fly, leg ext/curl, calf,
//       shrug, abductor)
//   4 — bodyweight to-failure / finisher (push-up [non-warmup], BW dip,
//       back extension, abs)

import { normalize, categorize } from "@/lib/coach/exercise-categories";
import { BIG_FOUR_SET } from "@/lib/coach/big-four";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type FatigueTier = 0 | 1 | 2 | 3 | 4;

/** Explicit fatigue tier overrides keyed on normalize(name).
 *  Catches everything in SESSION_PLANS plus common variants the user could
 *  log via Strong. Anything not in this map falls back to TIER_BY_CATEGORY. */
const FATIGUE_TIER: Record<string, FatigueTier> = {
  // ── TIER 1 — heavy compound ─────────────────────────────────────────────
  "squat": 1,
  "back squat": 1,
  "barbell squat": 1,
  "front squat": 1,
  "deadlift": 1,
  "conventional deadlift": 1,
  "sumo deadlift": 1,
  "bench press": 1,
  "incline bench press": 1,
  "decline bench press": 1,
  "overhead press": 1,
  "weighted pull-up": 1,
  "weighted chin-up": 1,
  "weighted dip": 1,

  // ── TIER 2 — secondary compound ─────────────────────────────────────────
  "dumbbell bench press": 2,
  "incline dumbbell press": 2,
  "dumbbell shoulder press": 2,
  "arnold press": 2,
  "machine shoulder press": 2,
  "shoulder press": 2,
  "close-grip bench press": 2,
  "romanian deadlift": 2,
  "stiff-leg deadlift": 2,
  "barbell row": 2,
  "bent over row": 2,
  "pendlay row": 2,
  "dumbbell row": 2,
  "seated cable row": 2,
  "seated row": 2,
  "t-bar row": 2,
  "machine row": 2,
  "lat pulldown": 2,
  "neutral grip pulldown": 2,
  "pullover": 2,
  "leg press": 2,
  "seated leg press": 2,
  "hack squat": 2,
  "machine squat": 2,
  "hip thrust": 2,
  "barbell hip thrust": 2,
  "good morning": 2,

  // ── TIER 3 — isolation ──────────────────────────────────────────────────
  "chest fly": 3,
  "cable fly": 3,
  "pec deck": 3,
  "lateral raise": 3,
  "front raise": 3,
  "cable lateral raise": 3,
  "rear delt fly": 3,
  "reverse fly": 3,
  "face pull": 3,
  "tricep extension": 3,
  "triceps extension": 3,
  "tricep pushdown": 3,
  "triceps pushdown": 3,
  "skull crusher": 3,
  "bicep curl": 3,
  "barbell curl": 3,
  "dumbbell curl": 3,
  "hammer curl": 3,
  "preacher curl": 3,
  "cable curl": 3,
  "leg extension": 3,
  "leg curl": 3,
  "lying leg curl": 3,
  "seated leg curl": 3,
  "calf raise": 3,
  "standing calf raise": 3,
  "seated calf raise": 3,
  "donkey calf raise": 3,
  "shrug": 3,
  "hip abductor": 3,
  "wrist curl": 3,
  "reverse wrist curl": 3,

  // ── TIER 4 — bodyweight to-failure / finisher ───────────────────────────
  "push-up": 4,
  "push up": 4,
  "dip": 4,
  "bench dip": 4,
  "chest dip": 4,
  "pull-up": 4,
  "chin-up": 4,
  "back extension": 4,
  "hyperextension": 4,
  "plank": 4,
  "side plank": 4,
  "ab wheel rollout": 4,
  "hanging leg raise": 4,
  "cable crunch": 4,
  "russian twist": 4,
  "dead bug": 4,
  "pallof press": 4,
  "hollow body hold": 4,
  "sit-up": 4,
  "v-up": 4,
  "glute bridge": 4,
};

/** Fallback tier when an exercise isn't in FATIGUE_TIER. Hinge/squat/push/pull
 *  are assumed compound (tier 2) — anything genuinely heavy or genuinely
 *  isolated should be in the explicit map. */
const TIER_BY_CATEGORY: Record<string, FatigueTier> = {
  push: 2,
  pull: 2,
  squat: 2,
  hinge: 2,
  "single-leg": 2,
  core: 3,
  accessory: 3,
  uncategorized: 3,
};

/** Classify an exercise into one of five fatigue tiers.
 *
 *  @param name      Exercise display name ("Push Up", "Decline Bench Press (Barbell)", ...)
 *  @param isWarmup  When true (PlannedExercise.warmup === true), always returns 0
 *                   regardless of the name. Allows the static plan to override
 *                   the heuristic for push-ups-as-warmup-ramp.
 */
export function getFatigueTier(name: string, isWarmup: boolean): FatigueTier {
  if (isWarmup) return 0;
  const key = normalize(name);
  const explicit = FATIGUE_TIER[key];
  if (explicit !== undefined) return explicit;
  return TIER_BY_CATEGORY[categorize(name)] ?? 3;
}

/** Convenience: tier on a PlannedExercise, honoring the warmup flag. */
export function tierOf(ex: PlannedExercise): FatigueTier {
  return getFatigueTier(ex.name, ex.warmup === true);
}

/** Re-export for downstream modules so they don't reach back into big-four.ts. */
export { BIG_FOUR_SET };
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/session-structure/tiers.ts
git commit -m "$(cat <<'EOF'
feat(coach): fatigue-tier classification module

5-tier scheme (0 warmup → 1 heavy compound → 2 secondary → 3 isolation
→ 4 finisher). Static lookup by normalized name, falls back to
category-based heuristic when unknown. Honors PlannedExercise.warmup
override.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Build `lib/coach/session-structure/rules.ts`

**Files:**
- Create: `lib/coach/session-structure/rules.ts`

- [ ] **Step 1: Create the rules module**

Create `lib/coach/session-structure/rules.ts`:

```ts
// lib/coach/session-structure/rules.ts
//
// Pure rule functions for session structure. Each function takes the inputs
// it needs and returns a typed record — no I/O, no side effects.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { getExerciseMuscles } from "@/lib/coach/exercise-muscles";
import { categorize } from "@/lib/coach/exercise-categories";
import { tierOf, BIG_FOUR_SET, type FatigueTier } from "./tiers";

export type OrderingWarning = {
  rule:
    | "tier_ascending"
    | "bodyweight_finisher_on_fatigued_muscle"
    | "big_four_first";
  exercise: string;
  related_exercise?: string;
  message: string;
  suggested_action:
    | "move_to_warmup"
    | "swap_with"
    | "substitute"
    | "move_to_end";
};

/** Parse a reps spec ("8", "8-12", "12×3", "5×2") to a single numeric reps
 *  count for rest-table lookup. Returns null when the spec encodes time or
 *  duration ("Hold 60s×2"). */
function parseReps(spec: string | number | undefined): number | null {
  if (spec === undefined) return null;
  if (typeof spec === "number") return spec;
  const m = spec.match(/^(\d+)/);
  if (!m) return null;
  const reps = parseInt(m[1], 10);
  return Number.isFinite(reps) ? reps : null;
}

/** Rest prescription per fatigue tier and rep target.
 *
 *  Rules:
 *   - Tier 1 + reps ≤ 5  (strength)              → 180–300 s
 *   - Tier 1 / 2 + reps 6–12 (hypertrophy comp)  → 120–180 s
 *   - Tier 3 + reps 8–15 (isolation)              → 60–120 s
 *   - Tier 4 / metabolic                         → 30–60 s
 *   - Tier 0 (warmup ramp)                       → 30–60 s
 *
 *  Boundary cases:
 *   - Tier 1 with reps > 12 (e.g. high-rep deadlift) → hypertrophy row.
 *   - Tier 2 with reps ≤ 5 → strength row.
 *   - Tier 3 with reps outside 8–15 → isolation row anyway. */
export function restPrescription(
  tier: FatigueTier,
  reps: number | null,
): { min: number; max: number } {
  if (tier === 0) return { min: 30, max: 60 };
  if (tier === 4) return { min: 30, max: 60 };
  if (tier === 3) return { min: 60, max: 120 };
  // Tiers 1 + 2
  if (reps !== null && reps <= 5) return { min: 180, max: 300 };
  return { min: 120, max: 180 };
}

/** RPE/RIR target string per fatigue tier. */
export function rpePrescription(tier: FatigueTier): string {
  switch (tier) {
    case 0: return "warm-up — ramp only, RPE 5–6";
    case 1: return "RPE 7–8 across sets, top set 8–9";
    case 2: return "RPE 7–9 (1–3 RIR)";
    case 3: return "RPE 8–10, last set near failure";
    case 4: return "AMRAP / RPE 10";
  }
}

/** Returns reps as a numeric where possible from a PlannedExercise. Reads
 *  baseReps first (typed numeric), then parses `reps` (string like "12×3"). */
export function repsForExercise(ex: PlannedExercise): number | null {
  if (typeof ex.baseReps === "number") return ex.baseReps;
  return parseReps(ex.reps);
}

/** Check `note` for the pre-exhaust opt-out tag.
 *  Returns true when the exercise's note contains "pre-exhaust" (case-insensitive),
 *  which suppresses tier_ascending warnings for the immediately-following
 *  same-pattern exercise. */
function isPreExhaustTagged(ex: PlannedExercise): boolean {
  if (!ex.note) return false;
  return /pre[-\s]?exhaust/i.test(ex.note);
}

/** Detect ordering rule violations across a session.
 *
 *  Three rules:
 *  1. **tier_ascending** — within the session, post-warmup tiers must be
 *     non-decreasing. A higher-tier exercise (e.g. tier 1 OHP) appearing
 *     after a lower-tier one (e.g. tier 3 Chest Fly) is a violation.
 *  2. **bodyweight_finisher_on_fatigued_muscle** — a tier-4 movement whose
 *     primary muscle (via EXERCISE_MUSCLES) overlaps with any earlier
 *     tier-2/3 exercise's primary muscle is a violation.
 *  3. **big_four_first** — a BIG_FOUR member must appear before any
 *     non-BIG_FOUR exercise sharing its EXERCISE_CATEGORY bucket. */
export function findOrderingWarnings(exercises: PlannedExercise[]): OrderingWarning[] {
  const warnings: OrderingWarning[] = [];
  const tiers = exercises.map(tierOf);
  const cats = exercises.map((e) => categorize(e.name));
  const primaries = exercises.map((e) => {
    const m = getExerciseMuscles(e.name);
    return m?.primary ?? [];
  });

  // Rule 1: tier ascending. Iterate post-warmup; for each pair (i-1, i),
  // require tiers[i] >= tiers[i-1]. Skip the comparison when the predecessor
  // is pre-exhaust-tagged.
  for (let i = 1; i < exercises.length; i++) {
    if (tiers[i - 1] === 0) continue; // warm-up doesn't establish a floor
    if (isPreExhaustTagged(exercises[i - 1])) continue;
    if (tiers[i] < tiers[i - 1] && tiers[i] > 0) {
      warnings.push({
        rule: "tier_ascending",
        exercise: exercises[i].name,
        related_exercise: exercises[i - 1].name,
        message: `${exercises[i].name} (tier ${tiers[i]}) is sequenced after ${exercises[i - 1].name} (tier ${tiers[i - 1]}). Heavier compounds should come first when the body is fresh.`,
        suggested_action: "swap_with",
      });
    }
  }

  // Rule 2: tier-4 finisher with primary muscle overlap on an earlier tier 2/3.
  for (let i = 0; i < exercises.length; i++) {
    if (tiers[i] !== 4) continue;
    const myPrimary = primaries[i];
    if (myPrimary.length === 0) continue;
    for (let j = 0; j < i; j++) {
      if (tiers[j] !== 2 && tiers[j] !== 3) continue;
      const earlierPrimary = primaries[j];
      const overlaps = myPrimary.some((p) => earlierPrimary.includes(p));
      if (overlaps) {
        warnings.push({
          rule: "bodyweight_finisher_on_fatigued_muscle",
          exercise: exercises[i].name,
          related_exercise: exercises[j].name,
          message: `${exercises[i].name} loads a muscle already fatigued by ${exercises[j].name}. Move to warm-up or substitute a non-overlapping movement.`,
          suggested_action: "move_to_warmup",
        });
        break; // one warning per finisher is enough
      }
    }
  }

  // Rule 3: BIG_FOUR member must precede non-BIG_FOUR same-category exercises.
  for (let i = 0; i < exercises.length; i++) {
    if (!BIG_FOUR_SET.has(exercises[i].name)) continue;
    const myCat = cats[i];
    for (let j = 0; j < i; j++) {
      if (tiers[j] === 0) continue; // warmup ramp doesn't trigger
      if (cats[j] !== myCat) continue;
      if (BIG_FOUR_SET.has(exercises[j].name)) continue;
      warnings.push({
        rule: "big_four_first",
        exercise: exercises[i].name,
        related_exercise: exercises[j].name,
        message: `${exercises[i].name} (BIG_FOUR ${myCat}) belongs before ${exercises[j].name} — heavier and more CNS-taxing.`,
        suggested_action: "swap_with",
      });
      break;
    }
  }

  return warnings;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/session-structure/rules.ts
git commit -m "$(cat <<'EOF'
feat(coach): session-structure rule engine — pure rule functions

Three ordering rules (tier_ascending, bodyweight_finisher_on_fatigued_muscle,
big_four_first), rest table, RPE prescription. Pure TS, no I/O. Reads
EXERCISE_MUSCLES + EXERCISE_CATEGORY + BIG_FOUR_SET. Pre-exhaust tag in
PlannedExercise.note suppresses tier_ascending for the tagged pair.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build `lib/coach/session-structure/reorder.ts`

**Files:**
- Create: `lib/coach/session-structure/reorder.ts`

- [ ] **Step 1: Create the reorder module**

Create `lib/coach/session-structure/reorder.ts`:

```ts
// lib/coach/session-structure/reorder.ts
//
// Stable suggested-reorder algorithm. Goal: produce a permutation of the
// input that minimizes ordering-rule violations.
//
// Algorithm (intentionally simple, not optimal):
//   1. Partition into two zones: warm-ups (warmup === true) up front, rest after.
//   2. Within the post-warmup zone, stable-sort by:
//      - fatigue_tier ascending (1 → 2 → 3 → 4),
//      - within same tier: BIG_FOUR before non-BIG_FOUR.
//   3. Concatenate warmups + sorted post-warmup.
//
// This handles:
//   - tier_ascending (rule 1) — explicit sort key
//   - big_four_first (rule 3) — secondary sort key
//
// It does NOT fully address rule 2 (bodyweight_finisher_on_fatigued_muscle)
// beyond moving tier-4 items to the end, where they belong by tier alone. In
// the rare case where the suggested order still violates rule 2 (e.g. every
// tier-3 in the session shares a primary muscle with the tier-4 finisher),
// the orchestrator (annotate.ts) re-runs findOrderingWarnings on the
// suggested order; if warnings remain, suggested_order is set to null and
// the banner shows the warnings without an Apply chip.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { tierOf, BIG_FOUR_SET } from "./tiers";

/** Stable sort by (tier asc, BIG_FOUR-first within tier). Returns a new
 *  PlannedExercise[] with the same length and contents as input. */
export function suggestReorder(exercises: PlannedExercise[]): PlannedExercise[] {
  const warmups = exercises.filter((e) => e.warmup === true);
  const rest = exercises.filter((e) => e.warmup !== true);

  // Stable sort: attach original index, sort, drop index.
  const indexed = rest.map((ex, idx) => ({ ex, idx }));
  indexed.sort((a, b) => {
    const ta = tierOf(a.ex);
    const tb = tierOf(b.ex);
    if (ta !== tb) return ta - tb;
    // Same tier — BIG_FOUR first.
    const aIsBig = BIG_FOUR_SET.has(a.ex.name);
    const bIsBig = BIG_FOUR_SET.has(b.ex.name);
    if (aIsBig !== bIsBig) return aIsBig ? -1 : 1;
    // Stable fallback: original order.
    return a.idx - b.idx;
  });

  return [...warmups, ...indexed.map((x) => x.ex)];
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/session-structure/reorder.ts
git commit -m "$(cat <<'EOF'
feat(coach): session-structure suggested-reorder algorithm

Stable two-key sort (tier asc, BIG_FOUR first within tier). Warm-ups
stay anchored at the front. Simple and predictable; the orchestrator
re-validates the suggestion and discards it when rule 2 still violates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Build `lib/coach/session-structure/annotate.ts` + `index.ts`

**Files:**
- Create: `lib/coach/session-structure/annotate.ts`
- Create: `lib/coach/session-structure/index.ts`

- [ ] **Step 1: Create the orchestrator**

Create `lib/coach/session-structure/annotate.ts`:

```ts
// lib/coach/session-structure/annotate.ts
//
// Orchestrator. Annotates a PlannedExercise[] with tier/rest/RPE/cue,
// computes ordering warnings, and proposes a suggested reorder when
// violations are present.
//
// Inputs:
//   - exercises: the PlannedExercise[] for today's session (post-resolver,
//     so this may be the static plan or the user's override).
//
// Output: SessionStructure (see types below). All four fields are
// populated deterministically — no AI, no I/O.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { tierOf, type FatigueTier } from "./tiers";
import {
  findOrderingWarnings,
  restPrescription,
  rpePrescription,
  repsForExercise,
  type OrderingWarning,
} from "./rules";
import { suggestReorder } from "./reorder";

export type AnnotatedExercise = PlannedExercise & {
  fatigue_tier: FatigueTier;
  rest_seconds: { min: number; max: number };
  rpe_target: string;
  /** Optional per-exercise cue derived from related warnings (e.g.,
   *  "Pre-fatigued from Triceps Pushdown — expect ~15% strength drop"). */
  cue?: string;
};

export type SessionStructure = {
  exercises: AnnotatedExercise[];
  warnings: OrderingWarning[];
  /** Populated iff warnings.length > 0 AND the suggested reorder validates
   *  clean. Null when the engine can't find a permutation that satisfies
   *  all rules. */
  suggested_order: AnnotatedExercise[] | null;
};

function annotateOne(ex: PlannedExercise): AnnotatedExercise {
  const tier = tierOf(ex);
  const reps = repsForExercise(ex);
  return {
    ...ex,
    fatigue_tier: tier,
    rest_seconds: restPrescription(tier, reps),
    rpe_target: rpePrescription(tier),
  };
}

/** Attach a one-line cue under each AnnotatedExercise whose name matches a
 *  warning. We attach to `warning.exercise` (the affected one), not to the
 *  related one. */
function attachCues(
  annotated: AnnotatedExercise[],
  warnings: OrderingWarning[],
): AnnotatedExercise[] {
  if (warnings.length === 0) return annotated;
  const cueByName = new Map<string, string>();
  for (const w of warnings) {
    // Prefer the rule-2 message (more concrete) when multiple rules touch
    // the same exercise.
    if (w.rule === "bodyweight_finisher_on_fatigued_muscle") {
      cueByName.set(w.exercise, w.message);
    } else if (!cueByName.has(w.exercise)) {
      cueByName.set(w.exercise, w.message);
    }
  }
  return annotated.map((ex) =>
    cueByName.has(ex.name) ? { ...ex, cue: cueByName.get(ex.name) } : ex,
  );
}

export function annotateSession(exercises: PlannedExercise[]): SessionStructure {
  const annotated = exercises.map(annotateOne);
  const warnings = findOrderingWarnings(exercises);
  const withCues = attachCues(annotated, warnings);

  let suggested: AnnotatedExercise[] | null = null;
  if (warnings.length > 0) {
    const proposal = suggestReorder(exercises);
    // Re-validate — if the proposal still violates, drop it.
    const stillBad = findOrderingWarnings(proposal);
    if (stillBad.length === 0) {
      suggested = proposal.map(annotateOne);
    }
  }

  return {
    exercises: withCues,
    warnings,
    suggested_order: suggested,
  };
}
```

- [ ] **Step 2: Create the barrel**

Create `lib/coach/session-structure/index.ts`:

```ts
// lib/coach/session-structure/index.ts
export { getFatigueTier, tierOf, type FatigueTier } from "./tiers";
export {
  findOrderingWarnings,
  restPrescription,
  rpePrescription,
  repsForExercise,
  type OrderingWarning,
} from "./rules";
export { suggestReorder } from "./reorder";
export {
  annotateSession,
  type AnnotatedExercise,
  type SessionStructure,
} from "./annotate";
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Sanity-check the rules against the (now-fixed) Chest plan**

Create a one-off scratch file `scripts/sanity-session-structure.mjs` to confirm zero warnings on the corrected Chest plan:

```js
import { SESSION_PLANS } from "../lib/coach/sessionPlans.ts";
import { annotateSession } from "../lib/coach/session-structure/index.ts";

const result = annotateSession(SESSION_PLANS.Chest);
console.log("warnings:", JSON.stringify(result.warnings, null, 2));
console.log("tier sequence:", result.exercises.map((e) => e.fatigue_tier).join(" → "));
```

Run it:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/sanity-session-structure.mjs
```

Expected output:
```
warnings: []
tier sequence: 0 → 1 → 1 → 2 → 3 → 3 → 3
```

Delete the scratch file:
```bash
rm scripts/sanity-session-structure.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/coach/session-structure/annotate.ts lib/coach/session-structure/index.ts
git commit -m "$(cat <<'EOF'
feat(coach): session-structure orchestrator + barrel

annotateSession(PlannedExercise[]) → SessionStructure. Computes
per-exercise tier/rest/RPE, attaches cues from warnings, and proposes a
re-validated suggested order. Zero warnings on the fixed
SESSION_PLANS.Chest order (tier sequence 0→1→1→2→3→3→3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add `exercise_overrides` to the `TrainingWeek` fetcher select

**Files:**
- Modify: `lib/query/fetchers/trainingWeek.ts`
- Modify: `app/api/training-weeks/[week_start]/swap/route.ts` (the `TRAINING_WEEK_SELECT` constant)

- [ ] **Step 1: Update the fetcher COLS**

Edit `lib/query/fetchers/trainingWeek.ts`. Find:

```ts
const COLS =
  "id, user_id, block_id, week_start, session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";
```

Replace with (insert `exercise_overrides` after `session_plan`; the existing select is missing `original_session_plan` which is a separate latent bug — leave it as-is, fixing it is out of scope):

```ts
const COLS =
  "id, user_id, block_id, week_start, session_plan, exercise_overrides, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";
```

- [ ] **Step 2: Update the swap route's select constant**

Edit `app/api/training-weeks/[week_start]/swap/route.ts`. Find:

```ts
const TRAINING_WEEK_SELECT =
  "id, user_id, block_id, week_start, session_plan, original_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";
```

Replace with:

```ts
const TRAINING_WEEK_SELECT =
  "id, user_id, block_id, week_start, session_plan, original_session_plan, exercise_overrides, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add lib/query/fetchers/trainingWeek.ts app/api/training-weeks/\[week_start\]/swap/route.ts
git commit -m "$(cat <<'EOF'
feat(coach): include exercise_overrides in training_weeks selects

Fetcher + swap-route select strings now pull the new column so the
session-structure resolver has the data on the client side and the
swap endpoint can clear stale overrides (next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Brief integration — embed `SessionStructure` in `MorningBriefCard.session`

**Files:**
- Modify: `lib/data/types.ts` (around line 750, `MorningBriefCard.session` block)
- Modify: `lib/morning/brief/assembler.ts`

- [ ] **Step 1: Add `structure` to the brief card type**

Edit `lib/data/types.ts`. Find the `MorningBriefCard.session` block (around line 750–767). After the `volume_gaps?: ...` field, before the closing `};` of the `session` object, add:

```ts
    /** Deterministic intra-session coaching: per-exercise tier/rest/RPE,
     *  ordering warnings, and a suggested reorder when violations exist.
     *  Computed by lib/coach/session-structure/annotateSession() from the
     *  effective plan (training_weeks.exercise_overrides → SESSION_PLANS).
     *  Optional for backwards compatibility with briefs written before the
     *  feature shipped. */
    structure?: import("@/lib/coach/session-structure").SessionStructure | null;
```

- [ ] **Step 2: Locate the brief assembler's session-block code**

Read `lib/morning/brief/assembler.ts` end-to-end. Find where the `session.exercises` array is constructed (it currently reads `SESSION_PLANS[sessionType]`). That's the integration point.

- [ ] **Step 3: Wire annotateSession into the assembler**

In `lib/morning/brief/assembler.ts`, the assembler already has access to the user's `training_weeks` row (it's loaded for swap-handling and `coach_suggestion`). Find the spot where the session block is built. Just before that block returns, add:

```ts
import { weekdayInUserTz } from "@/lib/time";
import { getEffectiveSessionPlan } from "@/lib/coach/sessionPlans";
import { annotateSession } from "@/lib/coach/session-structure";
import type { ExerciseOverrides } from "@/lib/data/types";
```

(Add at the top of the file with the other imports. Remove duplicate imports already present.)

Then, inside the session-block construction, replace the bare reference to `SESSION_PLANS[sessionType]` (or whatever produces the exercise list — find the assignment that ultimately feeds `session.exercises`) with the resolver call, and compute the structure:

```ts
// Load any per-day reorder; null on weeks without overrides.
const overrides =
  (trainingWeekRow?.exercise_overrides as ExerciseOverrides | null) ?? null;
const weekday = weekdayInUserTz(); // "Monday" .. "Sunday"
const effectivePlan = getEffectiveSessionPlan(sessionType, weekday, overrides);

// Existing code that maps PlannedExercise[] → MorningBriefExercise[]
// continues to consume `effectivePlan` instead of SESSION_PLANS[sessionType].
const exercises = mapPlannedExercisesToBriefExercises(effectivePlan, /* ...same args... */);

// New: compute structure for the same effective plan.
const structure =
  sessionType === "REST" || effectivePlan.length === 0
    ? null
    : annotateSession(effectivePlan);
```

Then in the `session: { ... }` object being returned, add the structure field:

```ts
session: {
  type: sessionType,
  start_time: /* ... existing ... */,
  exercises,
  volume_gaps: /* ... existing ... */,
  structure,
},
```

> **Note for the implementer:** The exact identifiers (`trainingWeekRow`, `mapPlannedExercisesToBriefExercises`) reflect what's already in `assembler.ts` — keep their original names; the diff above is an outline of where the new lines go, not literal replacement text. If the assembler currently reads `SESSION_PLANS` inline (not via a helper), apply the resolver call inline and pass `effectivePlan` to the rest of the existing logic.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 5: Sanity-run the brief locally**

```bash
npm run dev
```

Open `http://localhost:3000/` while logged in on a Chest day. The brief renders without errors. The new `session.structure` payload won't be visible yet (UI tasks below render it).

If you want to verify the payload, open Chrome DevTools → Network, find the `/api/chat/morning/recommendation` response (or whatever wrote today's brief), and inspect `payload.ui.session.structure`. Expect a `{ exercises, warnings: [], suggested_order: null }` shape.

- [ ] **Step 6: Commit**

```bash
git add lib/data/types.ts lib/morning/brief/assembler.ts
git commit -m "$(cat <<'EOF'
feat(coach): morning brief carries session structure annotation

Brief assembler now resolves the effective plan via
getEffectiveSessionPlan() and embeds annotateSession() output as
MorningBriefCard.session.structure. Optional field — older brief cards
render unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Build shared `SessionStructureBanner` component

**Files:**
- Create: `components/strength/SessionStructureBanner.tsx`

- [ ] **Step 1: Create the banner**

Create `components/strength/SessionStructureBanner.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COLOR } from "@/lib/ui/theme";
import type { SessionStructure } from "@/lib/coach/session-structure";

type Props = {
  structure: SessionStructure;
  /** Week-start (Sunday, YYYY-MM-DD) needed by the reorder endpoint. */
  weekStart: string;
  /** Full weekday name ("Monday"...) — the override key. */
  weekday: string;
};

/** Yellow banner shown when session-structure ordering rules fire. Renders
 *  the warnings inline, exposes an Apply-reorder button when
 *  suggested_order is non-null, and POSTs the override on click. */
export function SessionStructureBanner({ structure, weekStart, weekday }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (structure.warnings.length === 0) return null;

  const visible = structure.warnings.slice(0, 3);
  const overflow = structure.warnings.length - visible.length;

  async function applyReorder() {
    if (!structure.suggested_order) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/training-weeks/${weekStart}/exercise-overrides`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            weekday,
            exercises: structure.suggested_order.map(stripAnnotations),
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply reorder");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="note"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: COLOR.warningSoft,
        border: `1px solid ${COLOR.warning}`,
        borderRadius: 8,
        fontSize: 13,
        color: COLOR.warningDeep,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div>
        <strong>
          {structure.warnings.length} ordering issue{structure.warnings.length === 1 ? "" : "s"}
        </strong>
        <ul style={{ margin: "6px 0 0 18px", padding: 0, listStyle: "disc" }}>
          {visible.map((w, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {w.message}
            </li>
          ))}
          {overflow > 0 && (
            <li style={{ fontStyle: "italic", opacity: 0.85 }}>
              +{overflow} more
            </li>
          )}
        </ul>
      </div>
      {structure.suggested_order && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={applyReorder}
            disabled={submitting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: COLOR.warning,
              color: "#fff",
              border: "none",
              cursor: submitting ? "wait" : "pointer",
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "Applying…" : "Apply reorder"}
          </button>
          {error && (
            <span style={{ fontSize: 12, color: COLOR.danger }}>{error}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip the annotation fields before sending to the endpoint — server
 *  re-validates and persists only PlannedExercise fields. */
function stripAnnotations(e: SessionStructure["exercises"][number]) {
  const { fatigue_tier: _t, rest_seconds: _r, rpe_target: _rpe, cue: _c, ...rest } = e;
  return rest;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes (even though no consumer mounts the banner yet).

- [ ] **Step 3: Commit**

```bash
git add components/strength/SessionStructureBanner.tsx
git commit -m "$(cat <<'EOF'
feat(coach): SessionStructureBanner shared component

Yellow ordering-issue banner with Apply-reorder button. POSTs to the
new /api/training-weeks/[week_start]/exercise-overrides endpoint and
calls router.refresh() on success. Reused by brief + /strength.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Render rest/RPE chip + cue + banner in `BriefSessionList`

**Files:**
- Modify: `components/morning/BriefSessionList.tsx`

- [ ] **Step 1: Pass week context into BriefSessionList**

Open `components/morning/BriefSessionList.tsx`. Add two new props (`weekStart`, `weekday`) the banner needs, and pull the structure off the session object.

Find the prop block:

```tsx
export function BriefSessionList({
  session,
  isSwapped,
  liveType,
  thisWeekPlan,
}: {
  session: MorningBriefCard["session"];
  isSwapped: boolean;
  liveType: string | null;
  thisWeekPlan?: MorningBriefCard["this_week_plan"];
}) {
```

Replace with:

```tsx
export function BriefSessionList({
  session,
  isSwapped,
  liveType,
  thisWeekPlan,
  weekStart,
  weekday,
}: {
  session: MorningBriefCard["session"];
  isSwapped: boolean;
  liveType: string | null;
  thisWeekPlan?: MorningBriefCard["this_week_plan"];
  weekStart: string;
  weekday: string;
}) {
```

- [ ] **Step 2: Render the chip and cue inline on each exercise row**

The exercise rows render in the `.map((e, i) => ...)` block. Currently the right column shows weight + sets×reps + RIR. Add the rest/RPE line and the cue under the name.

Add this helper near the top of the file (after imports):

```tsx
import type { SessionStructure } from "@/lib/coach/session-structure";

function fmtRestRange(r: { min: number; max: number }): string {
  // Show as "3–5 min" when >= 90s, "60–120 s" otherwise.
  if (r.min >= 60 && r.max >= 90 && r.min % 60 === 0 && r.max % 60 === 0) {
    return `${r.min / 60}–${r.max / 60} min`;
  }
  return `${r.min}–${r.max} s`;
}

function findAnnotation(
  structure: SessionStructure | null | undefined,
  name: string,
): SessionStructure["exercises"][number] | null {
  if (!structure) return null;
  return structure.exercises.find((e) => e.name === name) ?? null;
}
```

In the row mapping, inside the right-side `<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" ... }}>`, after the existing RIR pill block, add:

```tsx
{(() => {
  const ann = findAnnotation(session.structure, e.name);
  if (!ann) return null;
  return (
    <div
      style={{
        fontSize: 10,
        color: COLOR.textFaint,
        lineHeight: 1.2,
        fontFamily: "var(--font-dm-mono), monospace",
        marginTop: 1,
      }}
      aria-label={`Rest ${fmtRestRange(ann.rest_seconds)}, ${ann.rpe_target}`}
    >
      {fmtRestRange(ann.rest_seconds)} · {ann.rpe_target.replace(/across sets, top set .*/, "").trim()}
    </div>
  );
})()}
```

Then in the left column (the `<div>` rendering name + note), after the existing `e.note` rendering, add the cue:

```tsx
{(() => {
  const ann = findAnnotation(session.structure, e.name);
  if (!ann?.cue) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: COLOR.warningDeep,
        fontStyle: "italic",
        marginTop: 2,
      }}
    >
      ⚠ {ann.cue}
    </div>
  );
})()}
```

- [ ] **Step 3: Render the banner above the exercise list**

Above the `<div style={{ background: COLOR.surfaceAlt, ... }}>` that contains the exercise rows, mount the banner:

```tsx
import { SessionStructureBanner } from "@/components/strength/SessionStructureBanner";

// ... inside the component, right after the exercises.length === 0 guard:
{session.structure && session.structure.warnings.length > 0 && (
  <SessionStructureBanner
    structure={session.structure}
    weekStart={weekStart}
    weekday={weekday}
  />
)}
```

- [ ] **Step 4: Update the brief card parent to pass weekStart + weekday**

Find every place that mounts `<BriefSessionList ... />`. Grep:

```bash
grep -rln "BriefSessionList" app/ components/ 2>/dev/null
```

For each caller, add `weekStart` and `weekday` props. The values come from the same source as the rest of the brief card: weekStart is the current week's Sunday (already passed for the swap chip), weekday is `weekdayInUserTz()`.

Likely caller: a parent like `MorningBriefCard.tsx` that already receives the card. If the parent doesn't have weekStart in scope, accept it as a new prop from its parent (the chat thread renderer) and pass it through. weekday can be derived inline via `weekdayInUserTz()` from `lib/time`.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 6: Manual UI verification**

```bash
npm run dev
```

Load `/` while logged in. On a Chest day, the brief's session block now shows:
- Per-exercise trailing rest/RPE line, e.g. `"3–5 min · RPE 7–8"`.
- No banner (the canonical Chest order is clean post-Task 3).
- No cues (no warnings to derive them from).

To force a warning, run this once in `psql`:

```sql
update training_weeks
set exercise_overrides = jsonb_build_object(
  'Monday',
  jsonb_build_array(
    (select session_plan from training_weeks where week_start = '2026-05-17' and user_id = '<your-user-id>')->'placeholder' -- replaced below
  )
);
```

Or simpler — apply a deliberately bad override via the Supabase SQL editor, swapping the order so Push Up sits at slot 7:

```sql
update training_weeks
set exercise_overrides = '{
  "Monday": [
    {"name":"Decline Bench Press (Barbell)","baseKg":60,"baseReps":8,"sets":3,"key":"decline_bench","increment":{"step":2.5}},
    {"name":"Overhead Press (Barbell)","baseKg":30,"baseReps":7,"sets":3,"key":"ohp","increment":{"step":5}},
    {"name":"Incline Bench Press (Dumbbell)","baseKg":32,"baseReps":11,"sets":3,"key":"incline_db","increment":{"step":2}},
    {"name":"Chest Fly","baseKg":22,"baseReps":15,"sets":3,"key":"chest_fly","increment":{"step":5,"intermediate":2.3}},
    {"name":"Lateral Raise (Dumbbell)","baseKg":12,"baseReps":12,"sets":4,"key":"lateral_raise","increment":{"step":2}},
    {"name":"Triceps Pushdown (Cable)","baseKg":23,"baseReps":15,"sets":3,"key":"triceps","increment":{"step":2.5}},
    {"name":"Push Up","reps":"12×3"}
  ]
}'::jsonb
where week_start = '<current-week-sunday>'
  and user_id = '<your-user-id>';
```

Reload `/`. Expect:
- Yellow banner: "1 ordering issue — Push Up loads a muscle already fatigued by Chest Fly. Move to warm-up or substitute a non-overlapping movement." with an **Apply reorder** button.
- Cue under Push Up: same message in italic warning color.

Don't tap Apply yet — the next task wires the endpoint.

- [ ] **Step 7: Commit**

```bash
git add components/morning/BriefSessionList.tsx components/morning/MorningBriefCard.tsx
git commit -m "$(cat <<'EOF'
feat(coach): brief session block renders rest/RPE + cues + banner

BriefSessionList consumes session.structure when present. Each exercise
gets a trailing rest/RPE chip. Cues from warnings render under affected
exercises. SessionStructureBanner mounts above the list when ordering
violations exist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Adjust the staged file list to match whichever parent component you modified in Step 4.)

---

## Task 12: Render annotations + banner in `TodayPlanCard` on `/strength`

**Files:**
- Modify: `lib/coach/readiness.ts` (extend `buildDailyPlan` to accept overrides)
- Modify: `components/strength/StrengthClient.tsx` (pass overrides through)
- Modify: `components/strength/TodayPlanCard.tsx` (render annotations)

- [ ] **Step 1: Extend `buildDailyPlan` to accept an effective plan**

Read `lib/coach/readiness.ts` around line 196 (the `buildDailyPlan` function). The function currently reads `SESSION_PLANS[sessionType]` directly. Adapt it to accept an optional `effectiveExercises?: PlannedExercise[]` argument.

Find:

```ts
export function buildDailyPlan(
  // existing args...
): DailyPlan {
  // existing logic...
  const exercises = (SESSION_PLANS[sessionType] ?? []).map((ex) => {
    // ...
  });
  // ...
  return { readiness, mode, sessionType, exercises };
}
```

Modify the signature and body. First, add a `structure` field to `DailyPlan`:

```ts
export type DailyPlan = {
  readiness: ReadinessSummary;
  mode: IntensityMode;
  sessionType: string;
  exercises: (PlannedExercise & {
    target: string;
    adjKg?: number;
    adjReps?: number;
    adjusted?: boolean;
    isPRAttempt?: boolean;
  })[];
  /** Deterministic intra-session coaching. Null on REST or empty plans. */
  structure: import("@/lib/coach/session-structure").SessionStructure | null;
};
```

Then update `buildDailyPlan` (find the exact signature in the file; the call site argument order doesn't change but a final optional param is added):

```ts
export function buildDailyPlan(
  // ... existing required args, exactly as they are ...
  effectiveExercises?: PlannedExercise[],
): DailyPlan {
  // existing logic for readiness + mode...

  const basePlan = effectiveExercises ?? SESSION_PLANS[sessionType] ?? [];
  const exercises = basePlan.map((ex) => {
    // ... existing per-exercise adjustment logic, unchanged
  });

  const structure =
    sessionType === "REST" || basePlan.length === 0
      ? null
      : annotateSession(basePlan);

  return { readiness, mode, sessionType, exercises, structure };
}
```

Add the import at the top of `lib/coach/readiness.ts`:

```ts
import { annotateSession } from "@/lib/coach/session-structure";
```

- [ ] **Step 2: Pass overrides through `StrengthClient`**

Open `components/strength/StrengthClient.tsx`. It already calls `useTrainingWeek(...)`. After that hook, extract the overrides:

```tsx
const { data: trainingWeek = null } = useTrainingWeek(userId, currentWeekStart);
const exerciseOverrides =
  (trainingWeek?.exercise_overrides as
    | import("@/lib/data/types").ExerciseOverrides
    | null) ?? null;
```

Then find where `buildDailyPlan(...)` is called. Locate the call and add the resolver result as the final argument:

```tsx
import { getEffectiveSessionPlan } from "@/lib/coach/sessionPlans";
import { weekdayInUserTz } from "@/lib/time";

// where the call is constructed:
const weekday = weekdayInUserTz();
const sessionTypeForDay = readSessionForDay(trainingWeek?.session_plan ?? null, weekday) ?? "REST";
const effectivePlan = getEffectiveSessionPlan(sessionTypeForDay, weekday, exerciseOverrides);

const dailyPlan = buildDailyPlan(
  // ...existing args...
  effectivePlan,
);
```

(The existing `buildDailyPlan` call may already derive `sessionTypeForDay` differently — keep its sourcing intact; just compute `effectivePlan` from the same `sessionTypeForDay` you pass to `buildDailyPlan`.)

Pass `weekStart` and `weekday` through to `<TodayPlanCard>`:

```tsx
<TodayPlanCard
  plan={dailyPlan}
  committedFromPlan={/* ...existing... */}
  rirTarget={/* ...existing... */}
  researchPhase={/* ...existing... */}
  weekStart={currentWeekStart}
  weekday={weekday}
/>
```

- [ ] **Step 3: Render chip + cue + banner in `TodayPlanCard`**

Open `components/strength/TodayPlanCard.tsx`. Extend the props:

```tsx
type Props = {
  plan: DailyPlan;
  committedFromPlan?: boolean;
  rirTarget?: number | null;
  researchPhase?: "accumulate" | "deload" | null;
  weekStart: string;
  weekday: string;
};

export function TodayPlanCard({ plan, committedFromPlan, rirTarget, researchPhase, weekStart, weekday }: Props) {
```

Add the banner above the exercise list, after the `<p>` with `plan.mode.desc`:

```tsx
import { SessionStructureBanner } from "@/components/strength/SessionStructureBanner";

// after `<p style={{ fontSize: "12px", opacity: 0.85, ... }}>{plan.mode.desc}</p>`:
{plan.structure && plan.structure.warnings.length > 0 && (
  <SessionStructureBanner
    structure={plan.structure}
    weekStart={weekStart}
    weekday={weekday}
  />
)}
```

Then in the exercise mapping, add the chip + cue. Find the existing row:

```tsx
{plan.exercises.map((ex) => (
  <div key={ex.name} style={{ ... }}>
    <span style={{ opacity: 0.85 }}>{ex.name.split("(")[0].trim()}</span>
    <span data-tnum style={{ fontWeight: 600, opacity: 0.95 }}>
      {ex.target}
    </span>
  </div>
))}
```

Replace with:

```tsx
{plan.exercises.map((ex) => {
  const ann = plan.structure?.exercises.find((a) => a.name === ex.name) ?? null;
  return (
    <div
      key={ex.name}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "6px 0",
        borderTop: "1px solid rgba(255,255,255,0.18)",
        fontSize: "12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ opacity: 0.85 }}>{ex.name.split("(")[0].trim()}</span>
        <span data-tnum style={{ fontWeight: 600, opacity: 0.95 }}>
          {ex.target}
        </span>
      </div>
      {ann && (
        <div
          style={{
            fontSize: 10,
            opacity: 0.7,
            fontFamily: "var(--font-dm-mono), monospace",
            marginTop: 2,
          }}
        >
          {fmtRestRange(ann.rest_seconds)} · {ann.rpe_target}
        </div>
      )}
      {ann?.cue && (
        <div
          style={{
            fontSize: 11,
            fontStyle: "italic",
            marginTop: 2,
            opacity: 0.85,
          }}
        >
          ⚠ {ann.cue}
        </div>
      )}
    </div>
  );
})}
```

Add the helper at the top of the file (just below the existing imports):

```tsx
function fmtRestRange(r: { min: number; max: number }): string {
  if (r.min >= 60 && r.max >= 90 && r.min % 60 === 0 && r.max % 60 === 0) {
    return `${r.min / 60}–${r.max / 60} min`;
  }
  return `${r.min}–${r.max} s`;
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 5: Manual UI verification**

```bash
npm run dev
```

Navigate to `/metrics?sub=strength`. The Today's Plan card renders the rest/RPE line under each exercise. If the bad-order override from Task 11 is still in place, the banner shows here too.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/readiness.ts components/strength/StrengthClient.tsx components/strength/TodayPlanCard.tsx
git commit -m "$(cat <<'EOF'
feat(coach): /strength TodayPlanCard renders session structure

buildDailyPlan now accepts an effective plan (resolver output) and
attaches annotateSession() output as plan.structure. TodayPlanCard
mounts SessionStructureBanner and renders per-exercise rest/RPE + cue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Reorder endpoint — `POST /api/training-weeks/[week_start]/exercise-overrides`

**Files:**
- Create: `app/api/training-weeks/[week_start]/exercise-overrides/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/training-weeks/[week_start]/exercise-overrides/route.ts`:

```ts
// app/api/training-weeks/[week_start]/exercise-overrides/route.ts
//
// Persist a per-day exercise reorder. Permutation-only: the submitted list
// must contain the same set of exercise names as the static
// SESSION_PLANS[session_plan[weekday]] for that day. PlannedExercise fields
// (sets/reps/baseKg/etc.) are carried as-submitted; we do not re-merge with
// the static plan.
//
// Body: { weekday: "Monday"..., exercises: PlannedExercise[] }

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import type { ExerciseOverrides, SessionPlan } from "@/lib/data/types";

const FULL_WEEKDAYS = new Set([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function asExercise(x: unknown): PlannedExercise | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  // Permissive — only name is required at the type level. The static plan
  // dictates which optional fields are present; we carry whatever was sent.
  return o as PlannedExercise;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;
  if (!isYmd(week_start)) {
    return NextResponse.json(
      { ok: false, error: "week_start must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "body must be an object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.weekday !== "string" || !FULL_WEEKDAYS.has(b.weekday)) {
    return NextResponse.json(
      { ok: false, error: "weekday must be a full weekday name (Monday..Sunday)" },
      { status: 400 },
    );
  }
  if (!Array.isArray(b.exercises)) {
    return NextResponse.json(
      { ok: false, error: "exercises must be an array" },
      { status: 400 },
    );
  }
  const exercises: PlannedExercise[] = [];
  for (const item of b.exercises) {
    const ex = asExercise(item);
    if (!ex) {
      return NextResponse.json(
        { ok: false, error: "each exercise must be an object with a non-empty name" },
        { status: 400 },
      );
    }
    exercises.push(ex);
  }

  const weekday = b.weekday;

  // Load the row.
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select("session_plan, exercise_overrides")
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json(
      { ok: false, error: `load failed: ${loadErr.message}` },
      { status: 500 },
    );
  }
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no training_weeks row for week_start=${week_start}` },
      { status: 404 },
    );
  }

  // Resolve session type for the weekday — session_plan keys may be short or
  // full form (per session-plan-reader.ts).
  const sessionType = readSessionForDay(row.session_plan as Record<string, string>, weekday);
  if (!sessionType || sessionType === "REST") {
    return NextResponse.json(
      { ok: false, error: `weekday=${weekday} is REST or not scheduled — nothing to reorder` },
      { status: 400 },
    );
  }
  const staticPlan = SESSION_PLANS[sessionType] ?? [];
  if (staticPlan.length === 0) {
    return NextResponse.json(
      { ok: false, error: `unknown session type "${sessionType}"` },
      { status: 400 },
    );
  }

  // Permutation check: same multiset of names.
  if (exercises.length !== staticPlan.length) {
    return NextResponse.json(
      {
        ok: false,
        error: `expected ${staticPlan.length} exercises for ${sessionType}, got ${exercises.length}`,
      },
      { status: 400 },
    );
  }
  const staticNames = staticPlan.map((e) => e.name).sort();
  const submittedNames = exercises.map((e) => e.name).sort();
  for (let i = 0; i < staticNames.length; i++) {
    if (staticNames[i] !== submittedNames[i]) {
      return NextResponse.json(
        {
          ok: false,
          error: `permutation only — submitted names do not match SESSION_PLANS.${sessionType}`,
        },
        { status: 400 },
      );
    }
  }

  // Upsert the weekday slot in the override map.
  const existing =
    (row.exercise_overrides as ExerciseOverrides | null) ?? ({} as ExerciseOverrides);
  const next: ExerciseOverrides = { ...existing, [weekday]: exercises };

  const { error: updateErr } = await supabase
    .from("training_weeks")
    .update({ exercise_overrides: next, updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("week_start", week_start);
  if (updateErr) {
    return NextResponse.json(
      { ok: false, error: `update failed: ${updateErr.message}` },
      { status: 500 },
    );
  }

  revalidatePath("/");
  revalidatePath("/metrics");

  return NextResponse.json({ ok: true, exercise_overrides: next });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: End-to-end check**

```bash
npm run dev
```

With the bad-order override from Task 11 still applied, reload `/`. Tap **Apply reorder** in the banner. Expect:
1. Button shows "Applying…" momentarily.
2. Banner disappears.
3. Push Up is back at the top (warm-up position).
4. Cue text under Push Up is gone.

Reload the page — the corrected order persists (the override now matches the canonical permutation, which is clean).

- [ ] **Step 4: Commit**

```bash
git add app/api/training-weeks/\[week_start\]/exercise-overrides/route.ts
git commit -m "$(cat <<'EOF'
feat(coach): POST /api/training-weeks/[week_start]/exercise-overrides

Validates auth, week_start format, weekday name (full), permutation-only
constraint (same multiset of names as SESSION_PLANS[session_type]).
Upserts the weekday slot in exercise_overrides jsonb. revalidatePath('/')
and revalidatePath('/metrics') so brief + strength tab refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Swap-route invariant — clear stale `exercise_overrides[weekday]`

**Files:**
- Modify: `app/api/training-weeks/[week_start]/swap/route.ts`

When the user swaps Monday from Chest → Back (or any `replace` that changes the session type), the existing `exercise_overrides[Monday]` holds chest exercises — stale. Clear it.

- [ ] **Step 1: Compute the set of affected weekdays in the swap route**

Open `app/api/training-weeks/[week_start]/swap/route.ts`. The `applySwap` helper in `lib/training-weeks/apply-swap.ts` already produces the `newPlan`. For each weekday in `WEEKDAYS`, if the session type changed (`current[wd] !== newPlan[wd]`), clear `exercise_overrides[fullWeekdayName]`.

Find the UPDATE block (around line 173):

```ts
const update: Record<string, unknown> = {
  session_plan: newPlan,
  updated_at: new Date().toISOString(),
};
if (isIdentityRestore) {
  update.original_session_plan = null;
} else if (original === null) {
  // First edit — snapshot the committed plan.
  update.original_session_plan = current;
}
// else: original is already set, subsequent non-restore edit — leave it alone.
```

Replace with (add override-clearing logic):

```ts
import { SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import type { ExerciseOverrides } from "@/lib/data/types";

// ... inside the handler, just before the existing `const update` line:

// Clear exercise_overrides for any day whose session type changed.
const currentOverrides =
  (row.exercise_overrides as ExerciseOverrides | null) ?? null;
let nextOverrides: ExerciseOverrides | null = currentOverrides;
if (currentOverrides) {
  const drop: string[] = [];
  for (const shortKey of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const) {
    const fullKey = SHORT_TO_FULL[shortKey];
    if (current[shortKey] !== newPlan[shortKey] && currentOverrides[fullKey]) {
      drop.push(fullKey);
    }
  }
  if (drop.length > 0) {
    const cleaned: ExerciseOverrides = { ...currentOverrides };
    for (const k of drop) delete cleaned[k];
    nextOverrides = Object.keys(cleaned).length > 0 ? cleaned : null;
  }
}

const update: Record<string, unknown> = {
  session_plan: newPlan,
  exercise_overrides: nextOverrides,
  updated_at: new Date().toISOString(),
};
// ... rest unchanged
```

(Move the `SHORT_TO_FULL` import up with the other imports at the top of the file; the diff above shows it inline for clarity.)

- [ ] **Step 2: Document the invariant in the swap route comment header**

At the top of `app/api/training-weeks/[week_start]/swap/route.ts`, find the comment block describing the server flow. Add a new step:

Find:

```
// Server flow:
//   1. Auth (cookie-bound supabase, RLS-respecting)
//   2. Load training_weeks row by (user_id, week_start). 404 if missing.
//   3. Validate body (action, days, session_type closed-set for replace).
//   4. Compute new plan via applySwap.
//   5. Identity check — 200 no-op when new === current.
//   6. Conflict check via detectConflicts.
//      - ?confirm=false (default) AND conflicts non-empty → 409 with preview.
//      - Otherwise → proceed.
//   7. Identity-restore detection — if new === original, set original to NULL.
//   8. UPDATE with COALESCE-on-first-edit (set original=current) OR
//      identity-restore-clears (set original=null) OR no-op (subsequent edit).
//   9. Return SwapResult.
```

Replace step 8 (and renumber):

```
// Server flow:
//   1. Auth (cookie-bound supabase, RLS-respecting)
//   2. Load training_weeks row by (user_id, week_start). 404 if missing.
//   3. Validate body (action, days, session_type closed-set for replace).
//   4. Compute new plan via applySwap.
//   5. Identity check — 200 no-op when new === current.
//   6. Conflict check via detectConflicts.
//      - ?confirm=false (default) AND conflicts non-empty → 409 with preview.
//      - Otherwise → proceed.
//   7. Identity-restore detection — if new === original, set original to NULL.
//   8. Clear exercise_overrides[weekday] for any day whose session type
//      changed. Stale overrides would hold exercises for the old session
//      type. NULL the entire column when the resulting map is empty.
//   9. UPDATE with COALESCE-on-first-edit (set original=current) OR
//      identity-restore-clears (set original=null) OR no-op (subsequent edit).
//  10. Return SwapResult.
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Manual verification**

```bash
npm run dev
```

Test:
1. Set up an override for Monday (re-run the SQL from Task 11 with a clean permutation, e.g. apply via the API or psql).
2. Verify Monday's strength tab shows the override order.
3. Swap Monday from Chest → Back via the strength tab's `DaySwapSheet`.
4. Reload — Monday should now show Back's static exercises (no leftover Chest override).
5. Run in psql:
   ```sql
   select exercise_overrides from training_weeks
   where week_start = '<current-sunday>' and user_id = '<your-id>';
   ```
   Expected: NULL (the only override was for Monday, which was cleared and the empty object collapsed to NULL).

- [ ] **Step 5: Commit**

```bash
git add app/api/training-weeks/\[week_start\]/swap/route.ts
git commit -m "$(cat <<'EOF'
feat(coach): swap route clears stale exercise_overrides

When a session type changes for a weekday, the corresponding
exercise_overrides[fullWeekdayName] is dropped — the old order belongs
to a different session type and would mislead the resolver. Empty
override maps collapse to NULL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Augment `DEFAULT_SYSTEM_PROMPT` so Carter cites brief structure

**Files:**
- Modify: `lib/coach/system-prompts.ts`

- [ ] **Step 1: Add the "Session structure" section**

Open `lib/coach/system-prompts.ts`. Find the `DEFAULT_SYSTEM_PROMPT` template literal. Insert a new section after the existing "## Mobility session confirmation" block, before the closing backtick. Locate:

```ts
Only call these tools on explicit completion / retraction signals — not
on hypothetical phrasing ("I'm about to do mobility", "thinking of doing
mobility tonight"). A future-tense or conditional statement is NOT a
completion signal.`;
```

Right before the closing backtick (`\``), add a blank line and the new section:

```text

## Session structure

When the user asks about rest periods, exercise ordering, or fatigue
management for today's session, reference the values in the morning
brief's session block — each exercise carries fatigue_tier, rest_seconds,
rpe_target, and possibly a cue. Cite those values verbatim; do not
estimate.

Ordering rules in effect:
  1. Heavy compound (tier 1) → secondary compound (tier 2) → isolation
     (tier 3) → bodyweight finisher (tier 4). Warm-up bodyweight ramps
     (tier 0) at the start.
  2. Bodyweight to-failure movements (push-ups, dips) never end a session
     for a pre-fatigued primary muscle. Push-ups belong at warm-up or on
     a different muscle group, not as the finisher after triceps work.
  3. The BIG_FOUR lifts (Squat, Deadlift, Decline Bench, OHP) lead their
     movement-pattern bucket.

If the brief shows an ordering warning and the user asks about it, point
them to the "Apply reorder" button — that is the action surface. Don't
suggest running the swap tool for an intra-session reorder.
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Manual verification**

```bash
npm run dev
```

Open `/coach`. Ask: "how much rest between sets on bench today?" — the chat should respond with the rest range from today's brief structure (e.g. "120-180s on Decline Bench today"), not an estimate. If the user has saved a custom system prompt, the change won't appear — that's expected (per spec).

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): Carter cites brief-computed rest/RPE from structure

DEFAULT_SYSTEM_PROMPT gains a 'Session structure' section pointing
Carter at MorningBriefCard.session.structure for rest, RPE, and
ordering questions. Compact rules summary so he can answer "why is
OHP first?" without re-deriving from scratch. Users with a saved
custom prompt are unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Update CLAUDE.md architecture section

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the architecture paragraph**

Open `CLAUDE.md`. Under the `### Coach / AI` section, find the bullet list of capabilities. Append a new bullet (place it after the `query_food_log` chat tool bullet, before the `### UI conventions` heading):

```markdown
- **Session-structure coaching** ([lib/coach/session-structure/](lib/coach/session-structure/)) — deterministic rule engine annotating today's prescribed session with per-exercise fatigue tier (0 warmup → 4 finisher), rest seconds, RPE/RIR target, and a cue when ordering rules fire. Three rules: tier-ascending, bodyweight-finisher-on-fatigued-muscle, BIG_FOUR-first-within-pattern. `annotateSession(PlannedExercise[]) → SessionStructure`. Consumed by [components/morning/BriefSessionList.tsx](components/morning/BriefSessionList.tsx) (chip + cue + banner in the brief's session block) and [components/strength/TodayPlanCard.tsx](components/strength/TodayPlanCard.tsx) (same affordances on `/metrics?sub=strength`). Reorder chip persists via `training_weeks.exercise_overrides jsonb` (migration `0022`); `POST /api/training-weeks/[week_start]/exercise-overrides` validates permutation-only writes (same multiset of names as `SESSION_PLANS[type]`). Swap route ([app/api/training-weeks/[week_start]/swap/route.ts](app/api/training-weeks/[week_start]/swap/route.ts)) clears `exercise_overrides[weekday]` for days whose session type changed — the old order belongs to a different session type. `DEFAULT_SYSTEM_PROMPT` includes a "Session structure" section so coach chat cites brief-computed values rather than estimating. Spec: [docs/superpowers/specs/2026-05-19-session-structure-coaching-design.md](docs/superpowers/specs/2026-05-19-session-structure-coaching-design.md).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(coach): document session-structure module in CLAUDE.md

Adds the architecture paragraph under Coach / AI so future Claude
sessions can find the rule engine, surfaces, persistence column, and
swap-route invariant without re-deriving from the spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Final manual verification pass + cleanup

- [ ] **Step 1: Verify the happy path end-to-end**

```bash
npm run typecheck
npm run dev
```

On a Chest day:
1. Load `/` — brief renders without warnings. Per-exercise rest/RPE chip visible. No cues. No banner.
2. Navigate to `/metrics?sub=strength` — TodayPlanCard renders the same chip + RPE under each exercise. No banner.
3. Navigate to `/coach`. Ask: "what's my rest between sets on Decline Bench today?". Expect a response citing "3–5 min" (or the exact rest range from the structure), not an estimate.

- [ ] **Step 2: Verify the violation path end-to-end**

Re-apply the bad-order override via psql (Task 11 SQL block).

1. Load `/` — banner shows on the brief. Cue under Push Up.
2. Tap **Apply reorder** — banner disappears, order corrects.
3. Verify in psql:
   ```sql
   select exercise_overrides from training_weeks where week_start = '<sunday>' and user_id = '<your-id>';
   ```
   Expect the override holds the corrected order. The order is now Push Up → Decline Bench → OHP → Incline DB → Chest Fly → Lateral Raise → Triceps Pushdown.
4. Reload `/metrics?sub=strength` — TodayPlanCard shows the corrected order, no banner.

- [ ] **Step 3: Verify the swap invariant**

1. With an override still applied for Monday, swap Monday from Chest → Back via the strength tab.
2. Verify `exercise_overrides` was cleared:
   ```sql
   select exercise_overrides from training_weeks where week_start = '<sunday>' and user_id = '<your-id>';
   ```
   Expect NULL (since Monday was the only override key).

- [ ] **Step 4: Restore today's session for normal use**

If you swapped Monday during testing, swap it back to its scheduled type via the strength tab.

- [ ] **Step 5: Final commit (only if any cleanup edits were needed during verification — otherwise skip)**

```bash
git status
```

If nothing's outstanding, skip. Otherwise commit the cleanup.

---

## Files touched (summary)

**Created:**
- `supabase/migrations/0022_exercise_overrides.sql`
- `lib/coach/session-structure/tiers.ts`
- `lib/coach/session-structure/rules.ts`
- `lib/coach/session-structure/reorder.ts`
- `lib/coach/session-structure/annotate.ts`
- `lib/coach/session-structure/index.ts`
- `app/api/training-weeks/[week_start]/exercise-overrides/route.ts`
- `components/strength/SessionStructureBanner.tsx`

**Modified:**
- `lib/data/types.ts` — `ExerciseOverrides` type + `TrainingWeek.exercise_overrides` field + `MorningBriefCard.session.structure?`
- `lib/coach/sessionPlans.ts` — fix Chest order, drop redundant note, add `getEffectiveSessionPlan`
- `lib/coach/readiness.ts` — `buildDailyPlan` accepts effective plan, attaches structure
- `lib/morning/brief/assembler.ts` — resolves effective plan, embeds structure
- `lib/query/fetchers/trainingWeek.ts` — select includes `exercise_overrides`
- `app/api/training-weeks/[week_start]/swap/route.ts` — select + clear stale overrides
- `components/morning/BriefSessionList.tsx` — chip + cue + banner
- `components/morning/MorningBriefCard.tsx` (and any other `<BriefSessionList>` mount sites) — pass weekStart + weekday
- `components/strength/StrengthClient.tsx` — pass overrides through
- `components/strength/TodayPlanCard.tsx` — chip + cue + banner
- `lib/coach/system-prompts.ts` — `DEFAULT_SYSTEM_PROMPT` "Session structure" section
- `CLAUDE.md` — migration list + architecture paragraph
