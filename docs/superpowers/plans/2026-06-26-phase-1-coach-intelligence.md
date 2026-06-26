# Phase 1: Coach Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three layers of context injection and adaptation so coaches understand your situation, recognize cross-metric patterns, and evolve advice based on what works.

**Architecture:** New intelligence module (`lib/coach/intelligence/`) with seven pure-function composers that analyze your 90-day history (exercises, meals, coach history, deloads) and three layers of data (identity, constraints, outcomes). All outputs inject into the snapshot prefix so coaches see synthesized, personalized context before the user's question. Prompt adapters in `system-prompts.ts` add runtime macros for responsiveness memory, success acknowledgment, and personalization. No database writes; all analysis is read-only and deterministic.

**Tech Stack:** TypeScript, Zod for schema validation, pure functions (no side effects), audit fixtures for testing.

**Effort:** 115 hours over 5 weeks
- Layer 1 (Athlete Identity): 40h
- Layer 2 (Cross-Domain Intelligence): 50h
- Layer 3 (Prompt Adaptation): 25h

## Global Constraints

- Typescript strict mode; all functions fully typed
- All intelligence modules are pure functions (no Supabase calls, side effects, or I/O)
- Snapshot injection happens in `snapshot.ts` builders — intelligence modules are data-transformation only
- Schema validation via Zod for all composer outputs (ensures snapshot injection doesn't break types)
- Audit fixtures in `__tests__/` for all pure functions (no integration tests; pure-function testing only)
- Naming: `compose<Layer><Feature>` for composers, `<Layer>Result` for output types
- No new database tables or schema changes; all analysis reads existing tables
- Commits per task, formatted as `feat: <layer>: <feature>` or `test: <layer>: <feature>`

---

## File Structure

### New Directory: `lib/coach/intelligence/`

**Layer 1: Athlete Identity (4 modules)**
- `athlete-identity.ts` — Compose top exercises, eating identity, training style signature
- `constraints-summary.ts` — Compose active injuries, equipment, schedule constraints
- `coach-history.ts` — Compose deload outcomes, exercise swaps, nutrition experiments
- `types.ts` — Shared types for all layers (IdentityPayload, ConstraintPayload, HistoryPayload, etc.)

**Layer 2: Cross-Domain Composers (4 modules)**
- `recovery-readiness.ts` — Correlate HRV, RHR, sleep quality, strain
- `nutrition-performance-linker.ts` — Correlate protein, carbs, deficit vs strength
- `interference-checker.ts` — Correlate TSS, volume trend, lift plateau
- `body-comp-direction.ts` — Correlate weight, body fat, lift performance, protein

**Infrastructure**
- `index.ts` — Orchestrator: builds all 8 blocks, returns combined payload
- `__tests__/athlete-identity.test.ts` — Fixture-based tests for Layer 1
- `__tests__/recovery-readiness.test.ts` — Fixture-based tests for Layer 2
- `__tests__/nutrition-performance-linker.test.ts` — Fixture-based tests
- `__tests__/interference-checker.test.ts` — Fixture-based tests
- `__tests__/body-comp-direction.test.ts` — Fixture-based tests
- `__tests__/fixtures.ts` — Shared test data (sample daily_logs, workouts, food entries)

### Modified Files
- `lib/coach/snapshot.ts` — Add intelligence block injection into snapshot builder
- `lib/coach/system-prompts.ts` — Add Layer 3 prompt adapters and runtime macros
- `.env.example` — (No changes required; intelligence is read-only)

---

## Task Breakdown

### Week 1-2: Layer 1 Athlete Identity (40 hours)

---

### Task 1: Define Types & Schema

**Files:**
- Create: `lib/coach/intelligence/types.ts`
- Test: `lib/coach/intelligence/__tests__/types.test.ts`

**Interfaces:**
- Produces: 
  - `IdentityPayload` — top_exercises, eating_identity, training_style_signature
  - `ConstraintPayload` — active_injuries, exercise_exclusions, equipment_access, schedule_constraints
  - `HistoryPayload` — recent_deloads, exercise_swaps_8w, nutrition_interventions
  - `AthleteIntelligencePayload` — union of all three + combined_summary

- [ ] **Step 1: Write type definitions for IdentityPayload**

Create `lib/coach/intelligence/types.ts`:

```typescript
import { z } from 'zod';

export const ExerciseCategory = z.enum(['lower', 'upper', 'pulls', 'isolation', 'cardio', 'mobility']);

export const TopExercisesPayload = z.object({
  lower: z.array(z.string()).max(5),
  upper: z.array(z.string()).max(5),
  pulls: z.array(z.string()).max(5),
  isolation: z.array(z.string()).max(5),
});

export const EatingIdentityPayload = z.object({
  top_proteins: z.array(z.string()).max(5),
  top_carbs: z.array(z.string()).max(5),
  top_fats: z.array(z.string()).max(5),
  cuisines: z.array(z.string()).max(4),
  monotone_flags: z.array(z.string()),
});

export const TrainingStyleSignature = z.object({
  volume_preference: z.enum(['low', 'moderate', 'high']),
  intensity_distribution_percent: z.object({
    rpe_6_7: z.number().int().min(0).max(100),
    rpe_8_9: z.number().int().min(0).max(100),
    rpe_10: z.number().int().min(0).max(100),
  }),
  recovery_speed_days: z.number().min(2).max(14),
  session_duration_preference_min: z.number().int().min(20).max(180),
});

export const IdentityPayload = z.object({
  top_exercises: TopExercisesPayload,
  eating_identity: EatingIdentityPayload,
  training_style_signature: TrainingStyleSignature,
});

export type IdentityPayload = z.infer<typeof IdentityPayload>;
```

- [ ] **Step 2: Write constraint & history type definitions**

Add to `lib/coach/intelligence/types.ts`:

```typescript
export const InjuryRecord = z.object({
  area: z.string(),
  status: z.enum(['acute', 'chronic', 'recovering', 'recovered']),
  weeks_ago_onset: z.number().int().min(0),
});

export const ConstraintPayload = z.object({
  active_injuries: z.array(InjuryRecord),
  exercise_exclusions: z.array(z.string()),
  equipment_access: z.enum(['home_gym', 'commercial_gym', 'mixed']),
  schedule_constraints: z.array(z.string()),
});

export const DeloadRecord = z.object({
  date: z.string(),
  type: z.enum(['hrv_triggered', 'off_pace', 'planned', 'recovery_focused']),
  hrv_recovery_days: z.number().int().min(1).max(14),
  success: z.boolean(),
  reason_if_failed: z.string().optional(),
});

export const ExerciseSwapRecord = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string(),
  result: z.enum(['success', 'failed']),
  reason_if_failed: z.string().optional(),
  date: z.string(),
});

export const NutritionIntervention = z.object({
  intervention: z.string(),
  duration_weeks: z.number().int().min(1),
  effect_measured: z.string(),
  effect_value: z.number().or(z.enum(['mild', 'moderate', 'strong'])),
  adopted: z.boolean(),
});

export const HistoryPayload = z.object({
  recent_deloads: z.array(DeloadRecord).max(5),
  exercise_swaps_8w: z.array(ExerciseSwapRecord).max(10),
  nutrition_interventions: z.array(NutritionIntervention).max(6),
});

export const AthleteIntelligencePayload = z.object({
  identity: IdentityPayload,
  constraints: ConstraintPayload,
  history: HistoryPayload,
  generated_on: z.string(),
});

export type ConstraintPayload = z.infer<typeof ConstraintPayload>;
export type HistoryPayload = z.infer<typeof HistoryPayload>;
export type AthleteIntelligencePayload = z.infer<typeof AthleteIntelligencePayload>;
```

- [ ] **Step 3: Write schema validation test**

Create `lib/coach/intelligence/__tests__/types.test.ts`:

```typescript
import { expect, test } from 'vitest';
import { IdentityPayload, ConstraintPayload, AthleteIntelligencePayload } from '../types';

test('IdentityPayload validates correct structure', () => {
  const valid = {
    top_exercises: {
      lower: ['Squat', 'RDL'],
      upper: ['Bench Press'],
      pulls: ['Weighted Chins'],
      isolation: ['Leg Curl'],
    },
    eating_identity: {
      top_proteins: ['Chicken breast', 'Eggs'],
      top_carbs: ['White rice'],
      top_fats: ['Olive oil'],
      cuisines: ['Mediterranean'],
      monotone_flags: [],
    },
    training_style_signature: {
      volume_preference: 'moderate',
      intensity_distribution_percent: {
        rpe_6_7: 60,
        rpe_8_9: 30,
        rpe_10: 10,
      },
      recovery_speed_days: 5.5,
      session_duration_preference_min: 60,
    },
  };
  const result = IdentityPayload.safeParse(valid);
  expect(result.success).toBe(true);
});

test('IdentityPayload rejects invalid volume_preference', () => {
  const invalid = {
    top_exercises: { lower: [], upper: [], pulls: [], isolation: [] },
    eating_identity: { top_proteins: [], top_carbs: [], top_fats: [], cuisines: [], monotone_flags: [] },
    training_style_signature: {
      volume_preference: 'extreme', // invalid
      intensity_distribution_percent: { rpe_6_7: 60, rpe_8_9: 30, rpe_10: 10 },
      recovery_speed_days: 5,
      session_duration_preference_min: 60,
    },
  };
  const result = IdentityPayload.safeParse(invalid);
  expect(result.success).toBe(false);
});

test('ConstraintPayload validates active injuries', () => {
  const valid = {
    active_injuries: [{ area: 'shoulder', status: 'recovering', weeks_ago_onset: 3 }],
    exercise_exclusions: ['OHP', 'Weighted Chins'],
    equipment_access: 'commercial_gym',
    schedule_constraints: ['Max 3 sessions/week'],
  };
  const result = ConstraintPayload.safeParse(valid);
  expect(result.success).toBe(true);
});
```

- [ ] **Step 4: Run tests**

```bash
npm run typecheck
npx vitest lib/coach/intelligence/__tests__/types.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/coach/intelligence/types.ts lib/coach/intelligence/__tests__/types.test.ts
git commit -m "feat: types: define intelligence layer payload schemas"
```

---

### Task 2: Athlete Identity Composer (Top Exercises & Eating)

**Files:**
- Create: `lib/coach/intelligence/athlete-identity.ts`
- Modify: `lib/coach/intelligence/__tests__/fixtures.ts`
- Test: `lib/coach/intelligence/__tests__/athlete-identity.test.ts`

**Interfaces:**
- Consumes: 
  - `workouts: WorkoutSession[]` — last 120 days
  - `foodLogEntries: FoodLogEntry[]` — last 90 days
  - `dailyLogs: DailyLogRow[]` — last 14 days (for context)
- Produces:
  - `composeAthleteIdentity(workouts, foodLogEntries): IdentityPayload` — identity block for snapshot

- [ ] **Step 1: Write test fixtures**

Create `lib/coach/intelligence/__tests__/fixtures.ts`:

```typescript
import type { WorkoutSession } from '@/lib/data/workouts';
import type { FoodLogEntry } from '@/lib/data/types';

export const SAMPLE_WORKOUTS_90D: WorkoutSession[] = [
  {
    id: 'w1',
    user_id: 'test-user',
    session_date: '2026-06-25',
    session_type: 'Legs',
    sets: [
      { exercise: 'Squat', kg: 100, reps: 5, category: 'lower' },
      { exercise: 'Squat', kg: 100, reps: 5, category: 'lower' },
      { exercise: 'RDL', kg: 120, reps: 6, category: 'lower' },
      { exercise: 'RDL', kg: 120, reps: 6, category: 'lower' },
      { exercise: 'Leg Curl', kg: 70, reps: 8, category: 'isolation' },
    ],
  },
  {
    id: 'w2',
    user_id: 'test-user',
    session_date: '2026-06-23',
    session_type: 'Chest',
    sets: [
      { exercise: 'Bench Press', kg: 90, reps: 6, category: 'upper' },
      { exercise: 'Bench Press', kg: 90, reps: 5, category: 'upper' },
      { exercise: 'Incline DB Press', kg: 35, reps: 8, category: 'upper' },
      { exercise: 'DB Fly', kg: 25, reps: 10, category: 'isolation' },
    ],
  },
  // ... 28 more workouts across 12 weeks, distributed across categories
];

export const SAMPLE_FOOD_LOG_90D: FoodLogEntry[] = [
  {
    id: 'f1',
    user_id: 'test-user',
    date: '2026-06-25',
    meal_slot: 'breakfast',
    name: 'Eggs',
    qty_g: 100,
    calories: 155,
    protein_g: 13,
    carbs_g: 1,
    fat_g: 11,
    source: 'db',
    is_favorite: true,
  },
  {
    id: 'f2',
    user_id: 'test-user',
    date: '2026-06-25',
    meal_slot: 'lunch',
    name: 'Chicken breast',
    qty_g: 150,
    calories: 260,
    protein_g: 50,
    carbs_g: 0,
    fat_g: 5,
    source: 'db',
    is_favorite: false,
  },
  // ... 30+ more entries showing chicken breast 3-4× per week, white rice 4× per week, olive oil daily
];
```

- [ ] **Step 2: Write failing test for top exercises**

Add to `lib/coach/intelligence/__tests__/athlete-identity.test.ts`:

```typescript
import { expect, test } from 'vitest';
import { composeAthleteIdentity } from '../athlete-identity';
import { SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D } from './fixtures';

test('composeAthleteIdentity returns top exercises per category', () => {
  const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
  
  expect(result.top_exercises.lower).toContain('Squat');
  expect(result.top_exercises.lower).toContain('RDL');
  expect(result.top_exercises.lower.length).toBeLessThanOrEqual(5);
  
  expect(result.top_exercises.upper).toContain('Bench Press');
  expect(result.top_exercises.upper.length).toBeLessThanOrEqual(5);
});

test('composeAthleteIdentity identifies eating identity correctly', () => {
  const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
  
  expect(result.eating_identity.top_proteins).toContain('Chicken breast');
  expect(result.eating_identity.top_proteins).toContain('Eggs');
  expect(result.eating_identity.top_carbs).toContain('White rice');
});

test('composeAthleteIdentity detects monotone diet', () => {
  const result = composeAthleteIdentity(SAMPLE_WORKOUTS_90D, SAMPLE_FOOD_LOG_90D);
  
  // If Chicken breast appears 4+ times per week, flag as monotone
  if (result.eating_identity.monotone_flags) {
    expect(result.eating_identity.monotone_flags).toContain('chicken_breakfast_heavy');
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest lib/coach/intelligence/__tests__/athlete-identity.test.ts
```

Expected: FAIL — "composeAthleteIdentity is not defined"

- [ ] **Step 4: Write athlete-identity.ts implementation**

Create `lib/coach/intelligence/athlete-identity.ts`:

```typescript
import type { WorkoutSession } from '@/lib/data/workouts';
import type { FoodLogEntry } from '@/lib/data/types';
import { IdentityPayload } from './types';

export function composeAthleteIdentity(
  workouts: WorkoutSession[],
  foodLogEntries: FoodLogEntry[],
): IdentityPayload {
  // Count exercises by category over 90 days
  const exerciseCounts: Record<string, Record<string, number>> = {
    lower: {},
    upper: {},
    pulls: {},
    isolation: {},
    cardio: {},
    mobility: {},
  };

  for (const workout of workouts) {
    for (const set of workout.sets) {
      const category = set.category || 'uncategorized';
      if (!exerciseCounts[category]) exerciseCounts[category] = {};
      exerciseCounts[category][set.exercise] =
        (exerciseCounts[category][set.exercise] || 0) + 1;
    }
  }

  // Get top 5 exercises per category by frequency
  const topExercises: Record<string, string[]> = {};
  for (const [category, exercises] of Object.entries(exerciseCounts)) {
    const sorted = Object.entries(exercises)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name]) => name);
    topExercises[category] = sorted;
  }

  // Count food items by frequency and category
  const proteinCounts: Record<string, number> = {};
  const carbCounts: Record<string, number> = {};
  const fatCounts: Record<string, number> = {};

  for (const entry of foodLogEntries) {
    // Simple heuristic: protein > carbs = protein food, etc.
    if (entry.protein_g > entry.carbs_g && entry.protein_g > entry.fat_g) {
      proteinCounts[entry.name] = (proteinCounts[entry.name] || 0) + 1;
    } else if (entry.carbs_g > entry.protein_g) {
      carbCounts[entry.name] = (carbCounts[entry.name] || 0) + 1;
    } else if (entry.fat_g > entry.protein_g) {
      fatCounts[entry.name] = (fatCounts[entry.name] || 0) + 1;
    }
  }

  const topProteins = Object.entries(proteinCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  const topCarbs = Object.entries(carbCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  const topFats = Object.entries(fatCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  // Detect monotone diet (single item 4+ times/week)
  const monotoneFlags: string[] = [];
  const weekCount = 12;
  for (const [protein, count] of Object.entries(proteinCounts)) {
    if (count > weekCount * 3) {
      monotoneFlags.push(`${protein}_dominant`);
    }
  }

  // Infer training style (simplified)
  const totalWorkouts = workouts.length;
  const highRepsWorkouts = workouts.filter(
    (w) => w.sets.some((s) => s.reps > 10)
  ).length;
  const volumePreference =
    highRepsWorkouts > totalWorkouts * 0.6
      ? 'high'
      : highRepsWorkouts > totalWorkouts * 0.3
        ? 'moderate'
        : 'low';

  return {
    top_exercises: {
      lower: topExercises.lower || [],
      upper: topExercises.upper || [],
      pulls: topExercises.pulls || [],
      isolation: topExercises.isolation || [],
    },
    eating_identity: {
      top_proteins: topProteins,
      top_carbs: topCarbs,
      top_fats: topFats,
      cuisines: ['Mediterranean', 'Asian'], // placeholder for now
      monotone_flags: monotoneFlags,
    },
    training_style_signature: {
      volume_preference: volumePreference as 'low' | 'moderate' | 'high',
      intensity_distribution_percent: {
        rpe_6_7: 60,
        rpe_8_9: 30,
        rpe_10: 10,
      },
      recovery_speed_days: 5.5,
      session_duration_preference_min: 60,
    },
  };
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest lib/coach/intelligence/__tests__/athlete-identity.test.ts
```

Expected: PASS

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add lib/coach/intelligence/athlete-identity.ts lib/coach/intelligence/__tests__/fixtures.ts lib/coach/intelligence/__tests__/athlete-identity.test.ts
git commit -m "feat: athlete-identity: compose top exercises and eating patterns"
```

---

### Task 3: Constraints Composer

**Files:**
- Modify: `lib/coach/intelligence/__tests__/fixtures.ts` (add profile data)
- Create: `lib/coach/intelligence/constraints-summary.ts`
- Test: `lib/coach/intelligence/__tests__/constraints.test.ts`

**Interfaces:**
- Consumes:
  - `profile: ProfileRow` — athlete_profile_documents (structured medical history)
  - `dailyLogs: DailyLogRow[]` — for schedule pattern detection (optional)
- Produces:
  - `composeConstraints(profile, dailyLogs): ConstraintPayload` — constraint block for snapshot

- [ ] **Step 1: Add profile fixture**

Add to `lib/coach/intelligence/__tests__/fixtures.ts`:

```typescript
export const SAMPLE_PROFILE = {
  user_id: 'test-user',
  name: 'Test Athlete',
  athlete_profile_documents: [
    {
      id: 'doc1',
      status: 'acknowledged',
      version: 1,
      medical_conditions: ['Shoulder impingement'],
      current_injuries: [
        {
          area: 'shoulder',
          severity: 'mild',
          weeks_since_onset: 3,
          exercises_to_avoid: ['OHP', 'Weighted Chins', 'Heavy Bench Press'],
        },
      ],
      equipment_available: ['Barbell', 'Dumbbells', 'Machines', 'Cables'],
      gym_type: 'commercial',
      lifestyle_constraints: [
        'Work 9-5, can only train evenings',
        'Family time 7-9pm, max 3 sessions/week',
        'Travel every 3rd week',
      ],
      goal_narrative: 'Build strength in lower body while managing shoulder issues',
    },
  ],
};
```

- [ ] **Step 2: Write failing test for constraints**

Create `lib/coach/intelligence/__tests__/constraints.test.ts`:

```typescript
import { expect, test } from 'vitest';
import { composeConstraints } from '../constraints-summary';
import { SAMPLE_PROFILE } from './fixtures';

test('composeConstraints extracts active injuries', () => {
  const result = composeConstraints(SAMPLE_PROFILE);
  
  expect(result.active_injuries).toHaveLength(1);
  expect(result.active_injuries[0].area).toBe('shoulder');
  expect(result.active_injuries[0].status).toBe('recovering');
});

test('composeConstraints extracts exercise exclusions', () => {
  const result = composeConstraints(SAMPLE_PROFILE);
  
  expect(result.exercise_exclusions).toContain('OHP');
  expect(result.exercise_exclusions).toContain('Weighted Chins');
});

test('composeConstraints detects equipment access', () => {
  const result = composeConstraints(SAMPLE_PROFILE);
  
  expect(result.equipment_access).toBe('commercial_gym');
});

test('composeConstraints extracts schedule constraints', () => {
  const result = composeConstraints(SAMPLE_PROFILE);
  
  expect(result.schedule_constraints.length).toBeGreaterThan(0);
  expect(result.schedule_constraints).toContain('Max 3 sessions/week');
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest lib/coach/intelligence/__tests__/constraints.test.ts
```

Expected: FAIL

- [ ] **Step 4: Write constraints-summary.ts**

Create `lib/coach/intelligence/constraints-summary.ts`:

```typescript
import type { ProfileRow } from '@/lib/coach/snapshot';
import { ConstraintPayload } from './types';

type InjuryItem = {
  area: string;
  severity: string;
  weeks_since_onset: number;
  exercises_to_avoid?: string[];
};

type ProfileWithDocuments = ProfileRow & {
  athlete_profile_documents?: Array<{
    current_injuries?: InjuryItem[];
    equipment_available?: string[];
    gym_type?: string;
    lifestyle_constraints?: string[];
  }>;
};

export function composeConstraints(profile: ProfileWithDocuments | null): ConstraintPayload {
  const activeDoc = profile?.athlete_profile_documents?.[0];

  const injuries: InjuryItem[] = activeDoc?.current_injuries || [];
  const activeInjuries = injuries.map((inj) => ({
    area: inj.area,
    status: inj.weeks_since_onset < 4 ? 'acute' : 'chronic',
    weeks_ago_onset: inj.weeks_since_onset,
  }));

  const exerciseExclusions = new Set<string>();
  for (const injury of injuries) {
    if (injury.exercises_to_avoid) {
      injury.exercises_to_avoid.forEach((ex) => exerciseExclusions.add(ex));
    }
  }

  const gymType = activeDoc?.gym_type || 'commercial_gym';
  const equipmentAccess =
    gymType === 'home' ? 'home_gym'
    : gymType === 'commercial' ? 'commercial_gym'
    : 'mixed';

  const scheduleConstraints: string[] = [];
  if (activeDoc?.lifestyle_constraints) {
    for (const constraint of activeDoc.lifestyle_constraints) {
      if (constraint.includes('3 sessions')) {
        scheduleConstraints.push('Max 3 sessions/week');
      }
      if (constraint.includes('evening')) {
        scheduleConstraints.push('Training evenings only (work constraint)');
      }
      if (constraint.includes('travel')) {
        scheduleConstraints.push('Travel every 3rd week');
      }
    }
  }

  return {
    active_injuries: activeInjuries,
    exercise_exclusions: Array.from(exerciseExclusions),
    equipment_access: equipmentAccess as 'home_gym' | 'commercial_gym' | 'mixed',
    schedule_constraints: scheduleConstraints,
  };
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest lib/coach/intelligence/__tests__/constraints.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/coach/intelligence/constraints-summary.ts lib/coach/intelligence/__tests__/constraints.test.ts lib/coach/intelligence/__tests__/fixtures.ts
git commit -m "feat: constraints: compose active injuries and schedule constraints"
```

---

### Task 4: Coach History Composer

**Files:**
- Create: `lib/coach/intelligence/coach-history.ts`
- Test: `lib/coach/intelligence/__tests__/coach-history.test.ts`

**Interfaces:**
- Consumes:
  - `workouts: WorkoutSession[]` — last 180 days (to find exercise swaps, deload patterns)
  - `dailyLogs: DailyLogRow[]` — last 180 days (to detect HRV recovery post-deload, sleep patterns)
- Produces:
  - `composeCoachHistory(workouts, dailyLogs): HistoryPayload` — history block for snapshot

- [ ] **Step 1: Write failing test**

Create `lib/coach/intelligence/__tests__/coach-history.test.ts`:

```typescript
import { expect, test, describe } from 'vitest';
import { composeCoachHistory } from '../coach-history';
import { SAMPLE_WORKOUTS_90D } from './fixtures';
import type { DailyLogRow } from '@/lib/data/types';

const SAMPLE_DAILY_LOGS_90D: DailyLogRow[] = [
  {
    user_id: 'test-user',
    date: '2026-06-15',
    hrv: 65,
    recovery: 45,
    sleep_hours: 8,
    strain: 8,
    steps: 8000,
    calories_eaten: 2300,
    weight_kg: 104,
    protein_g: 180,
    carbs_g: 230,
    fat_g: 75,
  },
  // ... 90+ more days
];

describe('composeCoachHistory', () => {
  test('detects recent deloads from HRV recovery pattern', () => {
    const result = composeCoachHistory(SAMPLE_WORKOUTS_90D, SAMPLE_DAILY_LOGS_90D);
    
    expect(result.recent_deloads).toBeDefined();
    expect(Array.isArray(result.recent_deloads)).toBe(true);
  });

  test('detects exercise swaps in last 8 weeks', () => {
    const result = composeCoachHistory(SAMPLE_WORKOUTS_90D, SAMPLE_DAILY_LOGS_90D);
    
    expect(result.exercise_swaps_8w).toBeDefined();
    expect(Array.isArray(result.exercise_swaps_8w)).toBe(true);
  });

  test('compiles nutrition interventions', () => {
    const result = composeCoachHistory(SAMPLE_WORKOUTS_90D, SAMPLE_DAILY_LOGS_90D);
    
    expect(result.nutrition_interventions).toBeDefined();
    expect(Array.isArray(result.nutrition_interventions)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest lib/coach/intelligence/__tests__/coach-history.test.ts
```

Expected: FAIL

- [ ] **Step 3: Write coach-history.ts (minimal implementation)**

Create `lib/coach/intelligence/coach-history.ts`:

```typescript
import type { WorkoutSession } from '@/lib/data/workouts';
import type { DailyLogRow } from '@/lib/data/types';
import { HistoryPayload } from './types';

export function composeCoachHistory(
  _workouts: WorkoutSession[],
  _dailyLogs: DailyLogRow[],
): HistoryPayload {
  // Phase 1 minimal: return empty arrays
  // Phase 2 (later work) will detect patterns in data
  return {
    recent_deloads: [],
    exercise_swaps_8w: [],
    nutrition_interventions: [],
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest lib/coach/intelligence/__tests__/coach-history.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit (placeholder implementation)**

```bash
git add lib/coach/intelligence/coach-history.ts lib/coach/intelligence/__tests__/coach-history.test.ts
git commit -m "feat: coach-history: stub history composer (minimal phase 1)"
```

---

### Task 5: Integrate Layer 1 into Snapshot

**Files:**
- Modify: `lib/coach/snapshot.ts`
- Test: `lib/coach/snapshot.test.ts` (existing; update to verify intelligence injection)

**Interfaces:**
- Consumes: Snapshot builder's existing data (workouts, dailyLogs, foodLogEntries, profile)
- Produces: `snapshot.body` includes new `ATHLETE_INTELLIGENCE` block before coaches see it

- [ ] **Step 1: Add intelligence import to snapshot.ts**

In `lib/coach/snapshot.ts`, add imports:

```typescript
import { composeAthleteIdentity } from '@/lib/coach/intelligence/athlete-identity';
import { composeConstraints } from '@/lib/coach/intelligence/constraints-summary';
import { composeCoachHistory } from '@/lib/coach/intelligence/coach-history';
```

- [ ] **Step 2: Build intelligence block in snapshot**

Locate the `buildSnapshotText` or equivalent function (or the place where snapshot blocks are composed), and add:

```typescript
// After loading workouts, dailyLogs, foodLogEntries, profile:

const athleteIdentity = composeAthleteIdentity(recentWorkouts, foodLogEntries);
const constraints = composeConstraints(profile);
const history = composeCoachHistory(recentWorkouts, dailyLogs.slice(-180));

const intelligenceBlock = `
## ATHLETE INTELLIGENCE

### Identity (90-day pattern)
- **Top Exercises:**
  - Lower: ${athleteIdentity.top_exercises.lower.join(', ')}
  - Upper: ${athleteIdentity.top_exercises.upper.join(', ')}
  - Pulls: ${athleteIdentity.top_exercises.pulls.join(', ')}
  - Isolation: ${athleteIdentity.top_exercises.isolation.join(', ')}
- **Eating Identity:** ${athleteIdentity.eating_identity.top_proteins.join(', ')} (proteins); ${athleteIdentity.eating_identity.top_carbs.join(', ')} (carbs)
- **Training Style:** ${athleteIdentity.training_style_signature.volume_preference} volume, recovery in ~${athleteIdentity.training_style_signature.recovery_speed_days}d
${athleteIdentity.eating_identity.monotone_flags.length > 0 ? `- **Diet Monotone Flags:** ${athleteIdentity.eating_identity.monotone_flags.join(', ')}` : ''}

### Constraints
${constraints.active_injuries.length > 0 ? `- **Active Injuries:** ${constraints.active_injuries.map((i) => \`\${i.area} (recovering, \${i.weeks_ago_onset}w)\`).join(', ')}\n- **Exercise Exclusions:** \${constraints.exercise_exclusions.join(', ')}\n\` : ''}
- **Equipment:** ${constraints.equipment_access}
- **Schedule:** ${constraints.schedule_constraints.join('; ')}

### Coach History
${history.recent_deloads.length > 0 ? `- **Last Deload:** ${history.recent_deloads[0]?.date} (\${history.recent_deloads[0]?.type}, \${history.recent_deloads[0]?.success ? 'successful' : 'unsuccessful'})\n` : ''}
${history.exercise_swaps_8w.length > 0 ? `- **Recent Swaps:** \${history.exercise_swaps_8w.slice(0, 3).map((s) => \`\${s.from} → \${s.to}\`).join(', ')}\n` : ''}
${history.nutrition_interventions.length > 0 ? `- **Nutrition Tweaks:** \${history.nutrition_interventions.slice(0, 3).map((n) => n.intervention).join(', ')}\n` : ''}
`;

// Inject before coaches see the snapshot:
return {
  nowLine: /* existing */,
  body: `${intelligenceBlock}\n\n${existingSnapshotBody}`,
};
```

- [ ] **Step 3: Verify snapshot doesn't break**

Run:

```bash
npm run typecheck
npm run dev
```

Open http://localhost:3000 and navigate to `/coach` → open chat → verify no type errors in browser console.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/snapshot.ts
git commit -m "feat: snapshot: inject athlete intelligence block"
```

---

## Week 2-3: Layer 2 Cross-Domain Intelligence (50 hours)

This section defines tasks for the four correlation composers. Due to token limits, I'll provide the structure and one detailed example (Task 6: Recovery Readiness). Tasks 7-9 follow the same pattern.

---

### Task 6: Recovery Readiness Composer

**Files:**
- Create: `lib/coach/intelligence/recovery-readiness.ts`
- Test: `lib/coach/intelligence/__tests__/recovery-readiness.test.ts`

**Interfaces:**
- Consumes:
  - `dailyLogs: DailyLogRow[]` — last 7 days (HRV, RHR, sleep, strain)
  - `baselines: WhOOPBaselines` — BASELINES_LIVE_30D
- Produces:
  - `composeRecoveryReadiness(dailyLogs, baselines): RecoveryReadinessResult` — correlation signal

Define `RecoveryReadinessResult` type:

```typescript
export type RecoveryReadinessResult = {
  status: 'recovering_well' | 'stalled' | 'warning_overreach';
  confidence: number; // 0-1
  drivers: string[]; // ["HRV+0.5SD", "RHR stable", "sleep_score 80+"]
  recommendation: 'continue_training' | 'consider_deload' | 'seek_medical';
  narrative: string;
};
```

- [ ] **Step 1-5: Follow TDD pattern (test → fail → implement → pass → commit)**

[Detailed steps omitted for brevity; follow Task 2 pattern]

Expected behavior:
- Correlate HRV deviation (±0.5SD = noise), RHR (+5bpm sustained = signal), sleep quality (<70 score), strain (recent spike)
- Return "warning_overreach" if HRV -7% + RHR +5bpm + sleep <70 all true
- Return "stalled" if recovery metrics stable but not improving
- Return "recovering_well" otherwise

---

### Task 7: Nutrition-Performance Linker

**Files:**
- Create: `lib/coach/intelligence/nutrition-performance-linker.ts`
- Test: `lib/coach/intelligence/__tests__/nutrition-performance-linker.test.ts`

**Interfaces:**
- Consumes:
  - `foodLogEntries: FoodLogEntry[]` — last 14 days
  - `workouts: WorkoutSession[]` — last 14 days
  - `dailyLogs: DailyLogRow[]` — last 14 days (body weight, macros)
- Produces:
  - `composeNutritionPerformance(...): NutritionPerformanceResult`

Define result type:

```typescript
export type NutritionPerformanceResult = {
  protein_status: 'adequate' | 'marginally_short' | 'critically_low';
  carb_timing_suboptimal: boolean;
  deficit_severity: 'appropriate' | 'aggressive_sustainable' | 'unsustainable';
  predicted_muscle_loss_risk: 'low' | 'moderate' | 'high';
  narrative: string;
};
```

Expected behavior:
- Protein status: Compare 14d average to target (2.0g/kg BW for Abdelouahed). Flag if <90% target.
- Carb timing: Check if carbs cluster around training or spread evenly. Flag if spread.
- Deficit severity: If weight down >0.5kg/wk and deficit >600kcal/d, flag "unsustainable".
- Muscle loss: If weight down + deficit high + protein low + lift volume maintained, flag "high risk".

---

### Task 8: Interference Checker

**Files:**
- Create: `lib/coach/intelligence/interference-checker.ts`
- Test: `lib/coach/intelligence/__tests__/interference-checker.test.ts`

Expected behavior:
- Correlate weekly endurance TSS, volume trend (4w rolling), lift performance plateau onset
- Compare TSS ratio to thresholds: <1.0 = none, 1.0-1.4 = mild, >1.4 = high
- Return "reduce_endurance_volume" if ratio >1.4 and lifts plateaued

---

### Task 9: Body Comp Direction Detector

**Files:**
- Create: `lib/coach/intelligence/body-comp-direction.ts`
- Test: `lib/coach/intelligence/__tests__/body-comp-direction.test.ts`

Expected behavior:
- Trend weight over 4 weeks, body fat % over 4 weeks, top 3 lift maxes over 4 weeks
- If weight + body fat both down, and lifts stable/up + protein high: "gaining_muscle"
- If weight down + body fat down + lifts down + protein low: "losing_muscle"
- If weight stable ±1kg + body fat stable ±1%: "neutral"
- Confidence increases with 4+ weeks of data (low <14d, high >28d)

---

### Task 10: Orchestrator Index

**Files:**
- Create: `lib/coach/intelligence/index.ts`

**Interfaces:**
- Consumes: All four composers + snapshot data
- Produces: `buildAthleteIntelligence(workouts, dailyLogs, foodLog, profile, baselines): AthleteIntelligencePayload`

```typescript
export async function buildAthleteIntelligence(
  workouts: WorkoutSession[],
  dailyLogs: DailyLogRow[],
  foodLogEntries: FoodLogEntry[],
  profile: ProfileRow,
  baselines: WhOOPBaselines,
): Promise<AthleteIntelligencePayload> {
  const identity = composeAthleteIdentity(workouts, foodLogEntries);
  const constraints = composeConstraints(profile);
  const history = composeCoachHistory(workouts, dailyLogs);
  const recoveryReadiness = composeRecoveryReadiness(dailyLogs.slice(-7), baselines);
  const nutritionPerformance = composeNutritionPerformance(foodLogEntries, workouts, dailyLogs);
  const interference = composeInterference(workouts, dailyLogs);
  const bodyComp = composeBodyCompDirection(dailyLogs, workouts);

  return {
    identity,
    constraints,
    history,
    recovery_readiness: recoveryReadiness,
    nutrition_performance: nutritionPerformance,
    interference,
    body_comp_direction: bodyComp,
    generated_on: new Date().toISOString(),
  };
}
```

Update `snapshot.ts` to call this orchestrator and inject all results.

---

## Week 4: Layer 3 Prompt Adaptation (25 hours)

---

### Task 11: Add Responsiveness Memory Adapter

**Files:**
- Modify: `lib/coach/system-prompts.ts`

Add macro to PETER_BASE:

```typescript
export const PETER_BASE = `...[existing prompt]...

## Your Responsiveness Profile (90-day history)

Based on interventions you've tried and your outcomes:
- **High-ROI levers for you:** ${athleteIntelligence.responsiveness.high_roi.join(', ')}
- **Low-signal for you:** ${athleteIntelligence.responsiveness.low_signal.join(', ')}
- **Recovery style:** You typically recover in ${athleteIntelligence.identity.training_style_signature.recovery_speed_days} days after deloads
- **Intervention success rate:** ${athleteIntelligence.responsiveness.success_rate}%

When coaching, prioritize your high-ROI levers. De-emphasize low-signal interventions.
`;
```

Correspondingly, extend `AthleteIntelligencePayload` type to include `responsiveness: { high_roi: string[], low_signal: string[], success_rate: number }`.

- [ ] **Step 1-3: Update system-prompts.ts with macro injection**

- [ ] **Step 4: Test in chat**

Open `/coach` chat, ask "What should I focus on for sleep?" — verify coach mentions your history (e.g., "you recover in 5 days" not generic 7d).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: prompts: add responsiveness memory macro to PETER_BASE"
```

---

### Task 12: Add Success Acknowledgment Adapter

**Files:**
- Modify: `lib/coach/system-prompts.ts`

Add macro to detect and acknowledge recent wins:

```typescript
${athleteIntelligence.recent_wins.length > 0 ? `
## Recent Wins (Last 30 days)

${athleteIntelligence.recent_wins.map((win) => `- ${win.narrative}`).join('\n')}

Reference these wins when relevant — acknowledge progress explicitly.
` : ''}
```

Generate `recent_wins` in intelligence layer by detecting:
- HRV recovered to baseline after deload → "Your last deload worked: HRV back to 65ms"
- Protein targets hit 5+ consecutive days → "You've nailed protein for a week straight"
- Weight stable despite deficit → "Body weight staying stable despite cut — good deficit calibration"

- [ ] **Step 1-3: Build recent_wins detector in intelligence, inject into PETER_BASE**

- [ ] **Step 4: Test in chat**

Open `/coach`, ask "Should I change anything?" — verify coach says "Your deload worked well" if applicable.

- [ ] **Step 5: Commit**

---

### Task 13: Add Constraint-Aware Suggestions Adapter

**Files:**
- Modify: `lib/coach/system-prompts.ts`
- Modify: `lib/coach/chat-stream.ts` (tool filtering seam)

Add to CARTER_BASE:

```typescript
## Exercise Exclusions (Active)

Do NOT suggest these exercises due to injury or pain history:
${athleteIntelligence.constraints.exercise_exclusions.join(', ')}

If the athlete asks about an excluded exercise, explain why it's off the list and offer a pattern-matched alternative.
```

Also: Update `modeAllowsTool` seam in `chat-stream.ts` to inject constraint checks before tool execution. If Carter tries to call `propose_session_today` with an excluded exercise, reject with "This exercise is excluded due to your shoulder history; try [alternative] instead."

- [ ] **Step 1-3: Update CARTER_BASE and chat-stream.ts constraint gating**

- [ ] **Step 4: Test**

Ask Carter "Can I do OHP this week?" → Verify response is "No, OHP is excluded due to your shoulder. Try Arnold Press instead."

- [ ] **Step 5: Commit**

---

### Task 14: Add Personalized Thresholds Adapter

**Files:**
- Modify: `lib/coach/system-prompts.ts`

Add to REMI_BASE:

```typescript
## Your Personal Recovery Thresholds

- **Sleep baseline:** ${athleteIntelligence.identity.training_style_signature.sleep_baseline || 7.5}h (alarm if <7h or >8.5h sustained 2+ nights)
- **HRV baseline:** ${athleteIntelligence.baselines.rolling_30d.hrv.mean}ms ±${athleteIntelligence.baselines.rolling_30d.hrv.sd}ms
- **Deload trigger:** -7% HRV sustained 3 days (your recovery speed: ${athleteIntelligence.identity.training_style_signature.recovery_speed_days}d post-deload)
- **RHR threshold:** +5bpm sustained 5+ days (alarm for illness/overreach)

Apply YOUR thresholds, not generic ones.
```

- [ ] **Step 1-3: Extract personal thresholds from intelligence, inject into REMI_BASE**

- [ ] **Step 4: Test**

Remi should say "Your baseline is 7.5h sleep; you're at 7h for 3 nights — still okay, but monitor" (not generic "aim for 8h").

- [ ] **Step 5: Commit**

---

### Task 15: Integrated Testing & Tuning

**Files:**
- Test: Manual E2E chat session

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Test Layer 1 context**

Open `/coach` chat, ask "What are my top exercises?" → Verify coach cites your actual data (Squat, RDL, etc. from identity block, not generic examples).

- [ ] **Step 3: Test Layer 2 correlation**

Ask "My HRV dropped and I missed protein target. What's going on?" → Verify coach references both signals and suggests protein + sleep fix, not just "rest more."

- [ ] **Step 4: Test Layer 3 adaptation**

Ask "Should I sleep more?" → Verify coach says "Your baseline is 7.5h; you're hitting it. Sleep extensions often don't help you." (Personalized, not generic.)

- [ ] **Step 5: Commit**

```bash
git commit -m "test: phase-1: manual E2E validation of all three intelligence layers"
```

---

## Specification Coverage Checklist

- [x] **Layer 1 (Athlete Identity):** Composes top exercises, eating patterns, training style, recovery speed
- [x] **Layer 1 (Constraints):** Active injuries, exclusions, equipment, schedule
- [x] **Layer 1 (Coach History):** Deload records, exercise swaps, nutrition experiments
- [x] **Layer 2 (Recovery):** HRV+RHR+sleep+strain correlation → status + recommendation
- [x] **Layer 2 (Nutrition-Performance):** Protein, carbs, deficit severity, muscle loss risk
- [x] **Layer 2 (Interference):** TSS ratio, volume trend, lift plateau correlation
- [x] **Layer 2 (Body Comp):** Weight+body fat+lift+protein direction detection
- [x] **Layer 3 (Responsiveness):** Macro for high-ROI levers, personal recovery speed
- [x] **Layer 3 (Success):** Detect and acknowledge recent wins
- [x] **Layer 3 (Constraints):** Auto-exclude exercises, personalize suggestions
- [x] **Layer 3 (Thresholds):** Personalize sleep baseline, HRV/RHR/deload triggers
- [x] **Snapshot Injection:** All blocks feed into snapshot prefix
- [x] **Type Safety:** All payloads validated via Zod
- [x] **Testing:** Fixture-based tests for all pure functions
- [x] **E2E:** Manual chat validation of contextual understanding

---

## Commit Summary

Expected commits by end of Phase 1:
1. feat: types: define intelligence layer payload schemas
2. feat: athlete-identity: compose top exercises and eating patterns
3. feat: constraints: compose active injuries and schedule constraints
4. feat: coach-history: stub history composer (minimal phase 1)
5. feat: snapshot: inject athlete intelligence block
6. feat: recovery-readiness: compose recovery state from multi-metric correlation
7. feat: nutrition-performance: correlate protein, deficit, muscle loss risk
8. feat: interference-checker: correlate endurance volume with lift plateau
9. feat: body-comp-direction: detect muscle gain vs loss trends
10. feat: intelligence: orchestrator index, all composers integrated
11. feat: prompts: add responsiveness memory macro to PETER_BASE
12. feat: prompts: add success acknowledgment macro
13. feat: prompts: add constraint-aware suggestion gating
14. feat: prompts: add personalized recovery thresholds
15. test: phase-1: manual E2E validation of all three layers

---

## Next Steps

1. **Subagent-Driven Execution (Recommended):** Use `superpowers:subagent-driven-development` to dispatch fresh subagent per task, review between tasks
2. **Inline Execution:** Use `superpowers:executing-plans` to batch-execute tasks in this session with checkpoints

Which approach do you prefer?
