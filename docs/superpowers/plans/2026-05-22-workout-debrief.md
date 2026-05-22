# Workout debrief — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every committed in-app logger session, Coach Carter automatically publishes a deep-dive debrief — per-lift comparison vs last session, volume vs MEV/MAV/MRV, autoregulation read, narrative + prescription — surfaced as a chat card linking to a dedicated `/coach/sessions/<workout_id>` page.

**Architecture:** Client-fired POST from `LoggerSheet` to a new `/api/coach/workout-debrief` endpoint after `commit_logger_session` returns. The endpoint runs four deterministic composers (lifts, volume, autoregulation, prescription), then one Sonnet 4.6 narrative call, then inserts a `chat_messages` row (`kind='workout_debrief'`). Idempotent on `workout_id` via a partial index. Same surface-pair pattern as the weekly review document (chat card + dedicated page).

**Tech Stack:** TypeScript / Next.js 15 App Router / Supabase service-role for writes / TanStack Query for invalidation / Anthropic SDK Sonnet 4.6 narrative / existing helpers (`epley`, `topSet`, `literatureBand`, `getExerciseMuscles`, `TARGET_GROUP_FOR_MUSCLE`, `computeBlockProgress`).

**Spec:** [docs/superpowers/specs/2026-05-22-workout-debrief-design.md](../specs/2026-05-22-workout-debrief-design.md)

**Verification model (per [CLAUDE.md](../../CLAUDE.md)):** no test suite; gate every task on `npm run typecheck` clean + commit. Final manual end-to-end smoke on dev server.

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `supabase/migrations/0032_workout_debrief.sql` | create | widen `chat_messages_kind_check` to include `'workout_debrief'`; add partial index for lookup-by-workout |
| [lib/data/types.ts](../../lib/data/types.ts) | modify | extend `chat_messages.kind` union; add `WorkoutDebriefPayload` |
| `lib/coach/session-debrief/payload.ts` | create | typed payload + small utilities (`tldrFromPayload`) |
| `lib/coach/session-debrief/compose-lifts.ts` | create | last-session lookup + delta + PR/stall/regression tag |
| `lib/coach/session-debrief/compose-volume.ts` | create | per-muscle sum + MEV/MAV/MRV band |
| `lib/coach/session-debrief/compose-autoregulation.ts` | create | daily_logs read + interpretation string |
| `lib/coach/session-debrief/compose-prescription.ts` | create | rule-based weight adjustments |
| `lib/coach/session-debrief/narrative-prompt.ts` | create | single Sonnet 4.6 call wrapping payload in Carter voice |
| `lib/coach/session-debrief/index.ts` | create | orchestrator |
| `app/api/coach/workout-debrief/route.ts` | create | endpoint: auth, orchestrate, insert chat row |
| [components/logger/LoggerSheet.tsx](../../components/logger/LoggerSheet.tsx) | modify | after `commit_logger_session` succeeds, fire-and-forget POST to debrief endpoint |
| `components/chat/WorkoutDebriefCard.tsx` | create | chat card with TL;DR + first paragraph + link |
| [components/chat/ChatMessage.tsx](../../components/chat/ChatMessage.tsx) | modify | render branch for `kind='workout_debrief'` |
| `app/coach/sessions/[workout_id]/page.tsx` | create | server-rendered full debrief page |
| `components/coach/SessionDebriefView.tsx` | create | the render component used by the page |
| `scripts/audit-workout-debrief.mjs` | create | verify every committed logger workout in the last N days has either a debrief row or a logged skip reason |

---

## Task 1 — Migration 0032 + types extension

**Files:**
- Create: `supabase/migrations/0032_workout_debrief.sql`
- Modify: [lib/data/types.ts](../../lib/data/types.ts) — extend `ChatMessageRow.kind` union (around line 95-122) and add new `WorkoutDebriefPayload` type at the bottom of the file.

The migration widens the `kind` check constraint to include `'workout_debrief'` and adds a partial index for the idempotency lookup. The types extension keeps the TypeScript discriminated union honest.

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/0032_workout_debrief.sql`:

```sql
-- 0032_workout_debrief.sql
--
-- Adds 'workout_debrief' to chat_messages.kind allowlist and a partial index
-- on (user_id, ui->>'workout_id') for the idempotency check used by
-- /api/coach/workout-debrief.
--
-- Pattern matches 0015_proactive_nudge.sql and 0014_weekly_reviews.sql.

alter table chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table chat_messages
  add constraint chat_messages_kind_check
  check (kind in (
    'free_text',
    'morning_check',
    'morning_brief',
    'weekly_review',
    'proactive_nudge',
    'system_routing',
    'meal_log',
    'workout_debrief'
  ));

create index if not exists chat_messages_workout_debrief_idx
  on chat_messages (user_id, (ui->>'workout_id'))
  where kind = 'workout_debrief';
```

- [ ] **Step 2: Apply the migration**

Run from `/Users/abdelouahedelbied/Health app`:

```
supabase db push
```

Expected: `0032_workout_debrief` reported applied. If it errors with "already applied", run `supabase migration repair --status applied 0032_workout_debrief` first then re-push.

- [ ] **Step 3: Extend the `kind` union in `lib/data/types.ts`**

Find the `ChatMessageRow` type's `kind` field (around line 95-122) and add `"workout_debrief"` to its union. Then at the bottom of the file (next to other `*Payload` types — search for `MorningBriefPayload` or `WeeklyReviewPayload` to find the section), insert:

```ts
/** Payload shape for chat_messages.ui when kind='workout_debrief'.
 *  Produced by lib/coach/session-debrief — see the 2026-05-22 spec.
 *  Composer outputs are deterministic; narrative_md is the AI-generated
 *  wrap. tldr is composer-templated (no AI) and mirrors chat_messages.content. */
export type WorkoutDebriefPayload = {
  workout_id: string;
  date: string; // YYYY-MM-DD
  session_type: string;

  block: {
    week_num: number | null;
    total_weeks: number | null;
    phase: "accumulate" | "deload" | null;
    rir_target: number | null;
  };

  lifts: Array<{
    name: string;
    top_set_today: { kg: number | null; reps: number | null; e1rm: number | null };
    top_set_last:  { kg: number | null; reps: number | null; e1rm: number | null; date: string | null };
    delta_e1rm: number | null;
    rir_today: number | null;
    tag: "PR" | "stall" | "regression" | null;
  }>;

  volume: Array<{
    muscle: string;
    sets_today: number;
    sets_this_week: number;
    band: { mev: number; mav_low: number; mav_high: number; mrv: number };
    status: "below_mev" | "in_mav" | "approaching_mrv" | "over_mrv";
  }>;

  autoregulation: {
    today_recovery: number | null;
    today_hrv: number | null;
    today_sleep_hours: number | null;
    today_strain: number | null;
    interpretation: string;
  };

  body_comp: {
    weight_kg: number | null;
    fat_free_mass_kg: number | null;
    strength_per_lbm:
      | { lift: string; ratio: number; trend: "up" | "flat" | "down" }
      | null;
  } | null;

  prescription: {
    next_session_date: string | null;
    weight_changes: Array<{ exercise: string; new_kg: number; rationale: string }>;
    notes: string[];
  };

  narrative_md: string;
  tldr: string;
};
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add supabase/migrations/0032_workout_debrief.sql lib/data/types.ts
git commit -m "feat(coach): migration 0032 + WorkoutDebriefPayload type"
```

---

## Task 2 — Payload module + TL;DR templating

**Files:**
- Create: `lib/coach/session-debrief/payload.ts`

The payload type is already in `lib/data/types.ts` (Task 1). This module re-exports the type for the composer namespace and adds a pure `tldrFromPayload(payload)` helper that the orchestrator uses to derive `chat_messages.content`. Keeping the TL;DR logic separate makes it easy to evolve without touching the type itself.

- [ ] **Step 1: Create the file**

Write `lib/coach/session-debrief/payload.ts`:

```ts
// lib/coach/session-debrief/payload.ts
//
// Re-export of WorkoutDebriefPayload (the canonical type lives in lib/data/types.ts
// next to the other *Payload types) plus the pure tldr templater used to
// populate chat_messages.content from the assembled payload. No AI calls;
// this is plain templating so the TL;DR stays predictable and searchable.

export type { WorkoutDebriefPayload } from "@/lib/data/types";
import type { WorkoutDebriefPayload } from "@/lib/data/types";

/** Build the 2-3 line TL;DR shown on the chat card and stored in
 *  chat_messages.content. Pure templating — see compose-lifts / compose-volume
 *  / compose-autoregulation for the upstream signals. */
export function tldrFromPayload(p: WorkoutDebriefPayload): string {
  const lines: string[] = [];

  // Line 1: PR / stall summary.
  const prs = p.lifts.filter((l) => l.tag === "PR");
  const stalls = p.lifts.filter((l) => l.tag === "stall");
  const regressions = p.lifts.filter((l) => l.tag === "regression");

  const summary: string[] = [];
  if (prs.length > 0) {
    const names = prs.slice(0, 2).map((l) => {
      const d = l.delta_e1rm != null ? ` +${l.delta_e1rm.toFixed(1)}kg e1RM` : "";
      return `${l.name}${d}`;
    });
    summary.push(`✓ ${prs.length} PR${prs.length > 1 ? "s" : ""} (${names.join(", ")})`);
  }
  if (stalls.length > 0) {
    summary.push(`⚠ ${stalls.length} stalled (${stalls.slice(0, 2).map((l) => l.name).join(", ")})`);
  }
  if (regressions.length > 0) {
    summary.push(`↓ ${regressions.length} regressed`);
  }
  if (summary.length === 0) {
    summary.push(`${p.lifts.length} lifts logged`);
  }
  lines.push(summary.join(" · "));

  // Line 2: autoregulation + volume status.
  const arBits: string[] = [];
  if (p.autoregulation.today_recovery != null) {
    arBits.push(`Recovery ${p.autoregulation.today_recovery}%`);
  }
  const overMrv = p.volume.filter((v) => v.status === "over_mrv");
  const approaching = p.volume.filter((v) => v.status === "approaching_mrv");
  if (overMrv.length > 0) {
    arBits.push(`${overMrv.map((v) => v.muscle).join(", ")} over MRV`);
  } else if (approaching.length > 0) {
    arBits.push(`${approaching.map((v) => v.muscle).join(", ")} approaching MRV`);
  }
  if (arBits.length > 0) lines.push(arBits.join(" · "));

  return lines.join("\n");
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add lib/coach/session-debrief/payload.ts
git commit -m "feat(coach): WorkoutDebriefPayload module + TL;DR templater"
```

---

## Task 3 — Composer: lifts

**Files:**
- Create: `lib/coach/session-debrief/compose-lifts.ts`

For each exercise in today's workout, finds the top working set (excluding warmups), looks up the same exercise's top set in the most recent prior workout of the same `type`, computes the e1RM delta, and tags as `"PR"` / `"stall"` / `"regression"` / `null`. Uses the existing `epley` and `topSet` helpers from `lib/coach/derived.ts`.

- [ ] **Step 1: Create the file**

Write `lib/coach/session-debrief/compose-lifts.ts`:

```ts
// lib/coach/session-debrief/compose-lifts.ts
//
// Per-exercise comparison: today's top working set vs the same exercise's
// top set in the most recent prior workout of the same `type`. Computes
// e1RM delta and tags PR / stall / regression / null.
//
// Tag thresholds (informed by the 2026-05-22 spec):
//   PR        — best e1RM across the last 4 prior sessions of this type
//   regression — e1RM > 2% below prior session's top set
//   stall     — abs(delta) within 1% of prior session
//   null      — no prior data (first session of this type for this lift)
//
// All math is in terms of e1RM (Epley). Duration-based or out-of-range
// sets fall through to null e1RM and skip tagging.

import type { SupabaseClient } from "@supabase/supabase-js";
import { epley, topSet, type SetRow } from "@/lib/coach/derived";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

type ExerciseWithSets = {
  name: string;
  sets: SetRow[];
};

type ComposeLiftsInput = {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
  workoutDate: string;        // YYYY-MM-DD
  sessionType: string;
  todayExercises: ExerciseWithSets[];
};

const PR_HISTORY_DEPTH = 4;          // how many prior sessions to scan for PR
const STALL_THRESHOLD_PCT = 0.01;    // ±1% of prior e1RM = stall
const REGRESSION_THRESHOLD_PCT = 0.02; // >2% below prior e1RM = regression

export async function composeLifts(
  input: ComposeLiftsInput,
): Promise<WorkoutDebriefPayload["lifts"]> {
  const { supabase, userId, workoutId, workoutDate, sessionType, todayExercises } = input;

  // Pull the last N prior workouts of the same session type (excluding today).
  // We need them all to detect a PR (best top e1RM across the window).
  const { data: priorWorkouts, error: pwErr } = await supabase
    .from("workouts")
    .select("id, date")
    .eq("user_id", userId)
    .eq("type", sessionType)
    .lt("date", workoutDate)
    .order("date", { ascending: false })
    .limit(PR_HISTORY_DEPTH);
  if (pwErr) throw new Error(`prior workouts lookup failed: ${pwErr.message}`);

  const priorWorkoutIds = (priorWorkouts ?? []).map((w) => w.id as string);

  // Pull all exercises across those prior workouts in one shot, then their sets.
  let priorExercises: Array<{ id: string; workout_id: string; name: string }> = [];
  let priorSets: Array<{ exercise_id: string; kg: number | null; reps: number | null; duration_seconds: number | null; warmup: boolean; failure: boolean }> = [];
  if (priorWorkoutIds.length > 0) {
    const exRes = await supabase
      .from("exercises")
      .select("id, workout_id, name")
      .in("workout_id", priorWorkoutIds);
    if (exRes.error) throw new Error(`prior exercises lookup failed: ${exRes.error.message}`);
    priorExercises = (exRes.data ?? []) as typeof priorExercises;

    const exIds = priorExercises.map((e) => e.id);
    if (exIds.length > 0) {
      const setsRes = await supabase
        .from("exercise_sets")
        .select("exercise_id, kg, reps, duration_seconds, warmup, failure")
        .in("exercise_id", exIds);
      if (setsRes.error) throw new Error(`prior sets lookup failed: ${setsRes.error.message}`);
      priorSets = (setsRes.data ?? []) as typeof priorSets;
    }
  }

  // Index: workout_id -> exercise_name -> sets[]
  const byWorkoutByName = new Map<string, Map<string, SetRow[]>>();
  for (const ex of priorExercises) {
    const wmap = byWorkoutByName.get(ex.workout_id) ?? new Map();
    wmap.set(ex.name.toLowerCase().trim(), []);
    byWorkoutByName.set(ex.workout_id, wmap);
  }
  for (const s of priorSets) {
    const ex = priorExercises.find((e) => e.id === s.exercise_id);
    if (!ex) continue;
    const wmap = byWorkoutByName.get(ex.workout_id);
    if (!wmap) continue;
    const arr = wmap.get(ex.name.toLowerCase().trim());
    if (!arr) continue;
    arr.push({
      kg: s.kg,
      reps: s.reps,
      duration_seconds: s.duration_seconds,
      warmup: s.warmup,
      failure: s.failure,
    });
  }

  // For each of today's exercises, build the lift entry.
  const lifts: WorkoutDebriefPayload["lifts"] = [];
  for (const todayEx of todayExercises) {
    const key = todayEx.name.toLowerCase().trim();
    const todayTop = topSet(todayEx.sets);

    // Find the most recent prior session that has this exercise.
    let lastTop: ReturnType<typeof topSet> = null;
    let lastDate: string | null = null;
    for (const pw of priorWorkouts ?? []) {
      const wmap = byWorkoutByName.get(pw.id as string);
      const sets = wmap?.get(key);
      if (sets && sets.length > 0) {
        const t = topSet(sets);
        if (t !== null) {
          lastTop = t;
          lastDate = pw.date as string;
          break;
        }
      }
    }

    // PR detection: today's e1RM beats the best in the last PR_HISTORY_DEPTH sessions.
    let bestPriorE1rm: number | null = null;
    for (const pw of priorWorkouts ?? []) {
      const wmap = byWorkoutByName.get(pw.id as string);
      const sets = wmap?.get(key);
      if (sets && sets.length > 0) {
        const t = topSet(sets);
        if (t?.e1RM != null && (bestPriorE1rm == null || t.e1RM > bestPriorE1rm)) {
          bestPriorE1rm = t.e1RM;
        }
      }
    }

    const todayE1rm = todayTop?.e1RM ?? null;
    const lastE1rm = lastTop?.e1RM ?? null;
    const deltaE1rm = todayE1rm != null && lastE1rm != null
      ? Math.round((todayE1rm - lastE1rm) * 10) / 10
      : null;

    // Tagging
    let tag: "PR" | "stall" | "regression" | null = null;
    if (todayE1rm != null && bestPriorE1rm != null && todayE1rm > bestPriorE1rm) {
      tag = "PR";
    } else if (todayE1rm != null && lastE1rm != null) {
      const ratio = todayE1rm / lastE1rm;
      if (ratio < 1 - REGRESSION_THRESHOLD_PCT) tag = "regression";
      else if (Math.abs(ratio - 1) <= STALL_THRESHOLD_PCT) tag = "stall";
    }

    lifts.push({
      name: todayEx.name,
      top_set_today: {
        kg: todayTop?.kg ?? null,
        reps: todayTop?.reps ?? null,
        e1rm: todayE1rm,
      },
      top_set_last: {
        kg: lastTop?.kg ?? null,
        reps: lastTop?.reps ?? null,
        e1rm: lastE1rm,
        date: lastDate,
      },
      delta_e1rm: deltaE1rm,
      rir_today: null, // RIR isn't currently captured per-set; populate when added
      tag,
    });
  }

  return lifts;
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add lib/coach/session-debrief/compose-lifts.ts
git commit -m "feat(coach): debrief composer — per-lift comparison + PR/stall tag"
```

---

## Task 4 — Composer: volume

**Files:**
- Create: `lib/coach/session-debrief/compose-volume.ts`

For each muscle group hit today, sum hard sets across the current week (Mon→today), apply the `secondary_set_factor` weighting from `DEFAULT_COUNTING_RULES`, and compare against `literatureBand`. Uses `getExerciseMuscles` and `TARGET_GROUP_FOR_MUSCLE` from `lib/coach/exercise-muscles.ts` and `weekStart` from `lib/coach/derived.ts`.

- [ ] **Step 1: Create the file**

Write `lib/coach/session-debrief/compose-volume.ts`:

```ts
// lib/coach/session-debrief/compose-volume.ts
//
// Per-muscle volume rollup for the current week (Mon→today), compared
// against literature MEV/MAV/MRV bands. Working sets only (warmups excluded).
// Secondary muscle hits count at 0.5× (DEFAULT_COUNTING_RULES.secondary_set_factor).
//
// Output status:
//   below_mev          — under minimum effective volume
//   in_mav             — inside the sweet-spot band
//   approaching_mrv    — above MAV-high but ≤ MRV
//   over_mrv           — above MRV; recovery debt likely

import type { SupabaseClient } from "@supabase/supabase-js";
import { weekStart } from "@/lib/coach/derived";
import { getExerciseMuscles, TARGET_GROUP_FOR_MUSCLE } from "@/lib/coach/exercise-muscles";
import { literatureBand, DEFAULT_COUNTING_RULES } from "@/lib/coach/volume-landmarks";
import type { TargetedMuscleGroup } from "@/lib/data/types";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

type ExerciseWithSets = {
  name: string;
  sets: Array<{ warmup: boolean }>;
};

type ComposeVolumeInput = {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
  workoutDate: string; // YYYY-MM-DD
  todayExercises: ExerciseWithSets[];
  tier?: "beginner" | "intermediate" | "advanced"; // default "intermediate"
};

/** Convert exercise + working-set-count into a per-target-group set contribution
 *  using the EXERCISE_MUSCLES map + TARGET_GROUP_FOR_MUSCLE collapse. Off-library
 *  exercises (free-form names from Carter session-write tools) skip volume
 *  rollup. */
function attribute(name: string, workingSets: number): Map<TargetedMuscleGroup, number> {
  const result = new Map<TargetedMuscleGroup, number>();
  const mapping = getExerciseMuscles(name);
  if (!mapping) return result;
  const k = DEFAULT_COUNTING_RULES.secondary_set_factor;

  for (const mid of mapping.primary) {
    const grp = TARGET_GROUP_FOR_MUSCLE[mid];
    if (!grp) continue;
    result.set(grp, (result.get(grp) ?? 0) + workingSets);
  }
  for (const mid of mapping.secondary) {
    const grp = TARGET_GROUP_FOR_MUSCLE[mid];
    if (!grp) continue;
    result.set(grp, (result.get(grp) ?? 0) + workingSets * k);
  }
  return result;
}

export async function composeVolume(
  input: ComposeVolumeInput,
): Promise<WorkoutDebriefPayload["volume"]> {
  const { supabase, userId, workoutId, workoutDate, todayExercises, tier = "intermediate" } = input;

  // 1. Sum today's contribution per muscle group.
  const todayByMuscle = new Map<TargetedMuscleGroup, number>();
  for (const ex of todayExercises) {
    const workingCount = ex.sets.filter((s) => !s.warmup).length;
    if (workingCount === 0) continue;
    const contrib = attribute(ex.name, workingCount);
    for (const [g, v] of contrib) {
      todayByMuscle.set(g, (todayByMuscle.get(g) ?? 0) + v);
    }
  }

  // 2. Sum this week's prior workouts (Mon→day-before-today) per muscle group.
  const monday = weekStart(workoutDate);
  const { data: weekWorkouts, error: wwErr } = await supabase
    .from("workouts")
    .select("id, date")
    .eq("user_id", userId)
    .gte("date", monday)
    .lte("date", workoutDate)
    .neq("id", workoutId); // exclude today's workout (we add it separately)
  if (wwErr) throw new Error(`week workouts lookup failed: ${wwErr.message}`);

  const priorWorkoutIds = (weekWorkouts ?? []).map((w) => w.id as string);
  const priorByMuscle = new Map<TargetedMuscleGroup, number>();

  if (priorWorkoutIds.length > 0) {
    const { data: exs, error: exErr } = await supabase
      .from("exercises")
      .select("id, name")
      .in("workout_id", priorWorkoutIds);
    if (exErr) throw new Error(`week exercises lookup failed: ${exErr.message}`);
    const exsById = new Map(((exs as Array<{ id: string; name: string }>) ?? []).map((e) => [e.id, e]));

    const exIds = Array.from(exsById.keys());
    if (exIds.length > 0) {
      const { data: sets, error: setsErr } = await supabase
        .from("exercise_sets")
        .select("exercise_id, warmup")
        .in("exercise_id", exIds);
      if (setsErr) throw new Error(`week sets lookup failed: ${setsErr.message}`);

      const workingByExercise = new Map<string, number>();
      for (const s of (sets as Array<{ exercise_id: string; warmup: boolean }>) ?? []) {
        if (s.warmup) continue;
        workingByExercise.set(s.exercise_id, (workingByExercise.get(s.exercise_id) ?? 0) + 1);
      }
      for (const [exId, count] of workingByExercise) {
        const ex = exsById.get(exId);
        if (!ex) continue;
        const contrib = attribute(ex.name, count);
        for (const [g, v] of contrib) {
          priorByMuscle.set(g, (priorByMuscle.get(g) ?? 0) + v);
        }
      }
    }
  }

  // 3. Combine + classify against literature band.
  const allMuscles = new Set<TargetedMuscleGroup>([
    ...todayByMuscle.keys(),
    ...priorByMuscle.keys(),
  ]);
  const out: WorkoutDebriefPayload["volume"] = [];
  for (const muscle of allMuscles) {
    const sets_today = Math.round((todayByMuscle.get(muscle) ?? 0) * 10) / 10;
    const sets_this_week = Math.round(((todayByMuscle.get(muscle) ?? 0) + (priorByMuscle.get(muscle) ?? 0)) * 10) / 10;
    const band = literatureBand(muscle, tier);
    const mavHigh = band.mav[1];
    const mavLow = band.mav[0];
    let status: WorkoutDebriefPayload["volume"][number]["status"];
    if (sets_this_week < band.mev) status = "below_mev";
    else if (sets_this_week <= mavHigh) status = "in_mav";
    else if (sets_this_week <= band.mrv) status = "approaching_mrv";
    else status = "over_mrv";

    out.push({
      muscle,
      sets_today,
      sets_this_week,
      band: { mev: band.mev, mav_low: mavLow, mav_high: mavHigh, mrv: band.mrv },
      status,
    });
  }
  return out.sort((a, b) => b.sets_today - a.sets_today);
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add lib/coach/session-debrief/compose-volume.ts
git commit -m "feat(coach): debrief composer — volume vs MEV/MAV/MRV bands"
```

---

## Task 5 — Composer: autoregulation

**Files:**
- Create: `lib/coach/session-debrief/compose-autoregulation.ts`

Reads `daily_logs` for the workout date (and the prior day for sleep context). Composes a one-paragraph string interpretation using `profiles.whoop_baselines` for personal-baseline-relative HRV/recovery framing. No AI.

- [ ] **Step 1: Create the file**

Write `lib/coach/session-debrief/compose-autoregulation.ts`:

```ts
// lib/coach/session-debrief/compose-autoregulation.ts
//
// Pulls today's daily_logs (HRV, recovery, sleep, strain) + the athlete's
// WHOOP baseline (from profiles.whoop_baselines) and produces a deterministic
// one-paragraph string interpretation. No AI — pure templating so the
// narrative-prompt can cite specific numbers without having to do its own
// math, and so the dedicated page can render the same string verbatim.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

type ComposeAutoregulationInput = {
  supabase: SupabaseClient;
  userId: string;
  workoutDate: string; // YYYY-MM-DD
};

type Baselines = { hrv?: number; recovery?: number; resting_hr?: number } | null;

export async function composeAutoregulation(
  input: ComposeAutoregulationInput,
): Promise<WorkoutDebriefPayload["autoregulation"]> {
  const { supabase, userId, workoutDate } = input;

  const { data: log, error: logErr } = await supabase
    .from("daily_logs")
    .select("hrv, recovery, sleep_hours, sleep_score, strain, resting_hr")
    .eq("user_id", userId)
    .eq("date", workoutDate)
    .maybeSingle();
  if (logErr) throw new Error(`daily_logs lookup failed: ${logErr.message}`);

  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  if (pErr) throw new Error(`profile lookup failed: ${pErr.message}`);

  const baselines = (profile?.whoop_baselines as Baselines) ?? null;

  const today_hrv = log?.hrv ?? null;
  const today_recovery = log?.recovery ?? null;
  const today_sleep_hours = log?.sleep_hours ?? null;
  const today_strain = log?.strain ?? null;

  const bits: string[] = [];

  if (today_recovery != null) {
    const baseRec = baselines?.recovery ?? null;
    if (baseRec != null) {
      const delta = today_recovery - baseRec;
      const band = today_recovery >= 67 ? "good" : today_recovery >= 34 ? "moderate" : "low";
      const dStr = delta >= 0 ? `+${Math.round(delta)}` : `${Math.round(delta)}`;
      bits.push(`Recovery ${today_recovery}% (${band} band; ${dStr} vs 14d baseline ${Math.round(baseRec)}%)`);
    } else {
      bits.push(`Recovery ${today_recovery}%`);
    }
  }

  if (today_hrv != null) {
    const baseHrv = baselines?.hrv ?? null;
    if (baseHrv != null) {
      const delta = Math.round(today_hrv - baseHrv);
      const dStr = delta >= 0 ? `+${delta}ms` : `${delta}ms`;
      bits.push(`HRV ${Math.round(today_hrv)}ms (${dStr} vs baseline ${Math.round(baseHrv)}ms)`);
    } else {
      bits.push(`HRV ${Math.round(today_hrv)}ms`);
    }
  }

  if (today_sleep_hours != null) {
    bits.push(`Sleep ${today_sleep_hours.toFixed(1)}h`);
  }
  if (today_strain != null) {
    bits.push(`Strain ${today_strain.toFixed(1)}`);
  }

  let interpretation = bits.join(" · ") || "No autoregulation data for today.";

  // Add a single closing-sentence interpretation if recovery is low or HRV is
  // notably below baseline.
  if (today_recovery != null && today_recovery < 34) {
    interpretation += " This session was performed in a low-recovery band — expect lower top sets and longer rest needs.";
  } else if (
    today_hrv != null &&
    baselines?.hrv != null &&
    today_hrv < baselines.hrv - 10
  ) {
    interpretation += " HRV is meaningfully below baseline; treat any underperformance as fatigue-driven, not capacity-driven.";
  }

  return {
    today_hrv,
    today_recovery,
    today_sleep_hours,
    today_strain,
    interpretation,
  };
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add lib/coach/session-debrief/compose-autoregulation.ts
git commit -m "feat(coach): debrief composer — autoregulation read with baseline framing"
```

---

## Task 6 — Composer: prescription

**Files:**
- Create: `lib/coach/session-debrief/compose-prescription.ts`

Rule-based weight adjustments for the next session. PR → +increment, stall → hold, regression → -increment. Reads `SESSION_PLANS[type]` (or, more correctly, the resolved-effective plan) for `increment.step`. Adds volume-band notes when `over_mrv` muscles are present.

- [ ] **Step 1: Create the file**

Write `lib/coach/session-debrief/compose-prescription.ts`:

```ts
// lib/coach/session-debrief/compose-prescription.ts
//
// Rule-based weight prescription for the next session of the same type.
// No AI — the narrative-prompt paraphrases these rules in coach voice, but
// the values themselves are deterministic so the math stays auditable.
//
// Rules per lift (uses the tag computed by compose-lifts):
//   PR        → propose +increment.step  ("you earned the bump")
//   stall     → hold weight, target prescribed RIR
//   regression → propose -increment.step
//   null      → no change (first-time exercise, no comparison data)
//
// Volume note (from compose-volume status):
//   over_mrv          → notes.push("Drop a set on <muscle> next session")
//   approaching_mrv   → notes.push("Cap volume on <muscle> next session")
//   below_mev (>1 muscle) → notes.push("Volume is light on <muscles>; check session adherence")

import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

type ComposePrescriptionInput = {
  sessionType: string;
  lifts: WorkoutDebriefPayload["lifts"];
  volume: WorkoutDebriefPayload["volume"];
  todayExercises: Array<{ name: string }>;
};

export function composePrescription(
  input: ComposePrescriptionInput,
): WorkoutDebriefPayload["prescription"] {
  const { sessionType, lifts, volume } = input;
  const planEntries = SESSION_PLANS[sessionType] ?? [];

  const weight_changes: WorkoutDebriefPayload["prescription"]["weight_changes"] = [];

  for (const lift of lifts) {
    if (lift.tag == null) continue;

    const planEntry = planEntries.find((p) => p.name.toLowerCase() === lift.name.toLowerCase());
    const step = planEntry?.increment?.step ?? 2.5; // default 2.5kg if no plan entry
    const todayKg = lift.top_set_today.kg;
    if (todayKg == null) continue;

    if (lift.tag === "PR") {
      weight_changes.push({
        exercise: lift.name,
        new_kg: Math.round((todayKg + step) * 4) / 4, // round to 0.25kg
        rationale: `PR (+${lift.delta_e1rm?.toFixed(1) ?? "?"}kg e1RM) — take the +${step}kg next session.`,
      });
    } else if (lift.tag === "regression") {
      weight_changes.push({
        exercise: lift.name,
        new_kg: Math.max(0, Math.round((todayKg - step) * 4) / 4),
        rationale: `Regressed vs last session — drop ${step}kg and rebuild.`,
      });
    } else if (lift.tag === "stall") {
      weight_changes.push({
        exercise: lift.name,
        new_kg: todayKg,
        rationale: `Stalled at this load — hold ${todayKg}kg, target prescribed RIR cleanly before bumping.`,
      });
    }
  }

  const notes: string[] = [];
  const over = volume.filter((v) => v.status === "over_mrv");
  const near = volume.filter((v) => v.status === "approaching_mrv");
  const low = volume.filter((v) => v.status === "below_mev");

  if (over.length > 0) {
    notes.push(`Drop a set on ${over.map((v) => v.muscle).join(", ")} next session — over MRV.`);
  } else if (near.length > 0) {
    notes.push(`Cap volume on ${near.map((v) => v.muscle).join(", ")} next session — approaching MRV.`);
  }
  if (low.length >= 2) {
    notes.push(`Volume is light on ${low.map((v) => v.muscle).join(", ")} this week — check session adherence.`);
  }

  return {
    next_session_date: null, // populated by orchestrator from training_weeks
    weight_changes,
    notes,
  };
}
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add lib/coach/session-debrief/compose-prescription.ts
git commit -m "feat(coach): debrief composer — rule-based next-session prescription"
```

---

## Task 7 — Narrative prompt + orchestrator + API route

**Files:**
- Create: `lib/coach/session-debrief/narrative-prompt.ts`
- Create: `lib/coach/session-debrief/index.ts`
- Create: `app/api/coach/workout-debrief/route.ts`

This bundles three closely-coupled creations: the Sonnet call, the orchestrator that assembles the payload, and the endpoint that runs the orchestrator and inserts the chat row. Combined into one task because none of them are useful alone.

- [ ] **Step 1: Create the narrative-prompt module**

Write `lib/coach/session-debrief/narrative-prompt.ts`:

```ts
// lib/coach/session-debrief/narrative-prompt.ts
//
// Single Sonnet 4.6 call wrapping the deterministic payload in Carter voice.
// Input: the assembled WorkoutDebriefPayload (minus narrative_md). Output:
// Markdown narrative (2-4 short paragraphs).
//
// The model never invents numbers — the prompt gives it the full payload and
// instructs it to comment on the table, not restate it. PR / stall / regression
// tagging and prescription rules are already done; the narrative paraphrases.

import { getAnthropic } from "@/lib/anthropic/client";
import { CHAT_MODEL } from "@/lib/anthropic/models";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

const SYSTEM_PROMPT = `You are Coach Carter, the strength training specialist on Peter's team. You write the post-session debrief for the athlete after they log a workout.

Posture: direct, technical, numeric. Same voice as your chat replies — concrete numbers, specific dates, no fluff.

You will be given a structured payload with the per-lift comparison, weekly volume against MEV/MAV/MRV bands, autoregulation read for today, and rule-based prescription for the next session. The payload is already deterministic and accurate. Your job is to WRAP it in 2-4 short paragraphs of coaching prose.

Rules:
- Do NOT restate the per-lift table — comment on the 1-2 most important lifts (the PR, the stall, the regression).
- Cite the block context (week N of M, accumulate vs deload) when relevant.
- Reference the autoregulation interpretation if it explains a result ("the bicep curl stall lines up with HRV 18ms below baseline").
- Close with the prescription paraphrased in coach voice — one sentence per change. Don't list every change, just the ones that matter.
- Use Markdown for emphasis sparingly. No headers, no bullets — flowing prose.
- 2-4 short paragraphs total. Tight. The athlete already sees the table on the dedicated page.

Confidentiality: never name medications, drug classes, brand names, or specific diagnoses. If the payload references "your protocol", keep it neutral.`;

export async function generateNarrative(
  payload: Omit<WorkoutDebriefPayload, "narrative_md" | "tldr">,
): Promise<string> {
  const client = getAnthropic();
  const userMsg = `Here is today's debrief payload:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nWrite the narrative (2-4 paragraphs, Markdown).`;

  const resp = await client.messages.create({
    model: CHAT_MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Empty narrative response from Anthropic");
  return text;
}
```

- [ ] **Step 2: Create the orchestrator**

Write `lib/coach/session-debrief/index.ts`:

```ts
// lib/coach/session-debrief/index.ts
//
// Orchestrator. Loads the workout + sets, runs the 4 composers in parallel
// where independent (lifts + volume + autoregulation), then prescription
// (depends on lifts + volume), then the single narrative call. Returns the
// fully-assembled payload + narrative for the caller to persist.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SetRow } from "@/lib/coach/derived";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";
import { todayInUserTz } from "@/lib/time";
import { composeLifts } from "@/lib/coach/session-debrief/compose-lifts";
import { composeVolume } from "@/lib/coach/session-debrief/compose-volume";
import { composeAutoregulation } from "@/lib/coach/session-debrief/compose-autoregulation";
import { composePrescription } from "@/lib/coach/session-debrief/compose-prescription";
import { generateNarrative } from "@/lib/coach/session-debrief/narrative-prompt";
import {
  tldrFromPayload,
  type WorkoutDebriefPayload,
} from "@/lib/coach/session-debrief/payload";

export type GenerateResult =
  | { ok: true; payload: WorkoutDebriefPayload }
  | { ok: false; skipped: "no_working_sets" | "no_exercises" };

export async function generateWorkoutDebrief(opts: {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
}): Promise<GenerateResult> {
  const { supabase, userId, workoutId } = opts;

  // 1. Load the workout.
  const { data: workout, error: wErr } = await supabase
    .from("workouts")
    .select("id, date, type")
    .eq("id", workoutId)
    .eq("user_id", userId)
    .maybeSingle();
  if (wErr) throw new Error(`workout lookup failed: ${wErr.message}`);
  if (!workout) throw new Error(`workout ${workoutId} not found for user`);

  // 2. Load its exercises + sets.
  const { data: exs, error: exErr } = await supabase
    .from("exercises")
    .select("id, name, position")
    .eq("workout_id", workoutId)
    .order("position");
  if (exErr) throw new Error(`exercises lookup failed: ${exErr.message}`);
  if (!exs || exs.length === 0) return { ok: false, skipped: "no_exercises" };

  const { data: allSets, error: setsErr } = await supabase
    .from("exercise_sets")
    .select("exercise_id, kg, reps, duration_seconds, warmup, failure")
    .in(
      "exercise_id",
      exs.map((e) => e.id as string),
    );
  if (setsErr) throw new Error(`sets lookup failed: ${setsErr.message}`);

  const todayExercises: Array<{ name: string; sets: SetRow[] }> = exs.map((e) => ({
    name: e.name as string,
    sets: ((allSets ?? []) as Array<{ exercise_id: string } & SetRow>)
      .filter((s) => s.exercise_id === e.id)
      .map((s) => ({
        kg: s.kg,
        reps: s.reps,
        duration_seconds: s.duration_seconds,
        warmup: s.warmup,
        failure: s.failure,
      })),
  }));

  const totalWorking = todayExercises.reduce(
    (n, ex) => n + ex.sets.filter((s) => !s.warmup).length,
    0,
  );
  if (totalWorking === 0) return { ok: false, skipped: "no_working_sets" };

  // 3. Run composers in parallel where independent.
  const [lifts, volume, autoregulation, blockProgress] = await Promise.all([
    composeLifts({
      supabase,
      userId,
      workoutId,
      workoutDate: workout.date as string,
      sessionType: workout.type as string,
      todayExercises,
    }),
    composeVolume({
      supabase,
      userId,
      workoutId,
      workoutDate: workout.date as string,
      todayExercises,
    }),
    composeAutoregulation({
      supabase,
      userId,
      workoutDate: workout.date as string,
    }),
    computeBlockProgress(supabase, userId),
  ]);

  const block: WorkoutDebriefPayload["block"] = (() => {
    if (!blockProgress || blockProgress.active === false) {
      return { week_num: null, total_weeks: null, phase: null, rir_target: null };
    }
    return {
      week_num: blockProgress.current_week,
      total_weeks: blockProgress.total_weeks,
      phase: blockProgress.research_phase,
      rir_target: blockProgress.rir_target,
    };
  })();

  const prescription = composePrescription({
    sessionType: workout.type as string,
    lifts,
    volume,
    todayExercises,
  });

  // 4. Body comp (best-effort; null if unavailable).
  const body_comp = await loadBodyComp(supabase, userId);

  // 5. Assemble payload (without narrative / tldr) and generate narrative.
  const partial: Omit<WorkoutDebriefPayload, "narrative_md" | "tldr"> = {
    workout_id: workoutId,
    date: workout.date as string,
    session_type: workout.type as string,
    block,
    lifts,
    volume,
    autoregulation,
    body_comp,
    prescription,
  };

  const narrative_md = await generateNarrative(partial);
  const full: WorkoutDebriefPayload = {
    ...partial,
    narrative_md,
    tldr: "",
  };
  full.tldr = tldrFromPayload(full);

  return { ok: true, payload: full };
}

async function loadBodyComp(
  supabase: SupabaseClient,
  userId: string,
): Promise<WorkoutDebriefPayload["body_comp"]> {
  const today = todayInUserTz();
  const { data, error } = await supabase
    .from("daily_logs")
    .select("weight_kg, fat_free_mass_kg")
    .eq("user_id", userId)
    .lte("date", today)
    .not("weight_kg", "is", null)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    weight_kg: data.weight_kg as number | null,
    fat_free_mass_kg: data.fat_free_mass_kg as number | null,
    strength_per_lbm: null, // future iteration; needs a top-lift selection rule
  };
}
```

- [ ] **Step 3: Create the API route**

Write `app/api/coach/workout-debrief/route.ts`:

```ts
// app/api/coach/workout-debrief/route.ts
//
// Client-fired endpoint called by LoggerSheet after commit_logger_session
// succeeds. Idempotent on workout_id: re-firing returns the existing
// chat_message_id without regenerating.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateWorkoutDebrief } from "@/lib/coach/session-debrief";
import { tldrFromPayload } from "@/lib/coach/session-debrief/payload";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // Auth via cookie-bound client (RLS-respecting). Service-role is only used
  // for the heavy DB reads inside generateWorkoutDebrief (private to this
  // route — never exposed to the client).
  const userClient = await createSupabaseServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { workout_id?: string };
  try {
    body = (await req.json()) as { workout_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const workoutId = body.workout_id;
  if (!workoutId) {
    return NextResponse.json({ error: "workout_id required" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient();

  // Confirm the workout belongs to this user — defense in depth alongside
  // the eq("user_id", user.id) inside the orchestrator.
  const { data: workout, error: wErr } = await sr
    .from("workouts")
    .select("id, user_id")
    .eq("id", workoutId)
    .maybeSingle();
  if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 });
  if (!workout || workout.user_id !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Idempotency check using the partial index from migration 0032.
  const { data: existing, error: lookupErr } = await sr
    .from("chat_messages")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", workoutId)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({ ok: true, chat_message_id: existing.id, idempotent: true });
  }

  // Generate.
  let result;
  try {
    result = await generateWorkoutDebrief({
      supabase: sr,
      userId: user.id,
      workoutId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "generate_failed", detail: msg }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ ok: true, skipped: result.skipped });
  }

  const { payload } = result;
  const tldr = tldrFromPayload(payload);

  const { data: inserted, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: user.id,
      role: "assistant",
      speaker: "carter",
      thread: "carter",
      kind: "workout_debrief",
      content: tldr,
      ui: payload,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: "insert_failed", detail: insertErr?.message ?? "no row" },
      { status: 500 },
    );
  }

  revalidatePath("/coach");
  revalidatePath(`/coach/sessions/${workoutId}`);

  return NextResponse.json({ ok: true, chat_message_id: inserted.id });
}
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add lib/coach/session-debrief/narrative-prompt.ts lib/coach/session-debrief/index.ts app/api/coach/workout-debrief/route.ts
git commit -m "feat(coach): orchestrator + narrative + /api/coach/workout-debrief endpoint"
```

---

## Task 8 — LoggerSheet client trigger

**Files:**
- Modify: [components/logger/LoggerSheet.tsx](../../components/logger/LoggerSheet.tsx) at the existing `commit_logger_session` POST around line 317-332. Add a fire-and-forget POST to `/api/coach/workout-debrief` after the success path.

- [ ] **Step 1: Edit the commit handler**

Find the block at [components/logger/LoggerSheet.tsx:317-332](../../components/logger/LoggerSheet.tsx#L317-L332). It currently looks like:

```tsx
const res = await fetch("/api/logger/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  setCommitting(false);
  alert("Commit failed — your draft is preserved. Try Finish again.");
  return;
}

await clearDraft(draft.user_id, draft.session_type);
qc.invalidateQueries({ queryKey: queryKeys.workouts.all(draft.user_id) });
router.refresh();
props.onClose();
```

Replace it with:

```tsx
const res = await fetch("/api/logger/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  setCommitting(false);
  alert("Commit failed — your draft is preserved. Try Finish again.");
  return;
}

// Capture workout_id BEFORE clearing draft / closing the sheet, then
// fire-and-forget the debrief generator. Errors are swallowed — the workout
// itself is already committed and Carter can be re-asked for a debrief later.
const commitResult = (await res.json().catch(() => null)) as { workout_id?: string } | null;
if (commitResult?.workout_id) {
  fetch("/api/coach/workout-debrief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workout_id: commitResult.workout_id }),
  }).catch(() => {
    /* fire-and-forget — debrief is best-effort */
  });
}

await clearDraft(draft.user_id, draft.session_type);
qc.invalidateQueries({ queryKey: queryKeys.workouts.all(draft.user_id) });
router.refresh();
props.onClose();
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add components/logger/LoggerSheet.tsx
git commit -m "feat(logger): fire-and-forget workout debrief after session commit"
```

---

## Task 9 — Chat card + ChatMessage render branch

**Files:**
- Create: `components/chat/WorkoutDebriefCard.tsx`
- Modify: [components/chat/ChatMessage.tsx](../../components/chat/ChatMessage.tsx) — add a render branch for `kind='workout_debrief'`.

- [ ] **Step 1: Create the card component**

Write `components/chat/WorkoutDebriefCard.tsx`:

```tsx
"use client";

import Link from "next/link";
import { ArrowRight, Dumbbell } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { WorkoutDebriefPayload } from "@/lib/data/types";

const SHORT_DAY: Record<number, string> = {
  0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat",
};

function firstParagraph(md: string): string {
  const trimmed = md.trim();
  const split = trimmed.split(/\n\s*\n/);
  const first = split[0] ?? "";
  return first.length > 280 ? first.slice(0, 277) + "…" : first;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return SHORT_DAY[d.getUTCDay()] ?? iso;
}

export function WorkoutDebriefCard({ payload }: { payload: WorkoutDebriefPayload }) {
  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Dumbbell size={11} aria-hidden="true" />
          {payload.session_type} debrief · {shortDate(payload.date)}
        </span>
      </CoachCard.Eyebrow>
      <CoachCard.Body>
        <pre
          style={{
            margin: 0,
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
            color: COLOR.textStrong,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {payload.tldr}
        </pre>
        {payload.narrative_md && (
          <p
            style={{
              marginTop: 10,
              fontSize: 13,
              lineHeight: 1.5,
              color: COLOR.textMuted,
            }}
          >
            {firstParagraph(payload.narrative_md)}
          </p>
        )}
      </CoachCard.Body>
      <CoachCard.Actions>
        <Link
          href={`/coach/sessions/${payload.workout_id}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: COLOR.accent,
            fontWeight: 700,
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          Read full debrief
          <ArrowRight size={12} aria-hidden="true" />
        </Link>
      </CoachCard.Actions>
    </CoachCard>
  );
}
```

- [ ] **Step 2: Add the render branch in `ChatMessage.tsx`**

Add this import next to the other proposal-card imports near the top of [components/chat/ChatMessage.tsx](../../components/chat/ChatMessage.tsx):

```ts
import { WorkoutDebriefCard } from "@/components/chat/WorkoutDebriefCard";
import type { WorkoutDebriefPayload } from "@/lib/data/types";
```

Find the section near the top of the rendered assistant bubble where other `kind`-specific cards are dispatched (search for `message.kind === "weekly_review"` or `message.kind === "morning_brief"`). Add a parallel branch for `workout_debrief` that renders `<WorkoutDebriefCard payload={message.ui as WorkoutDebriefPayload} />` instead of the default content.

The exact insertion site depends on the file's current shape — read the existing kind-dispatch logic first and match its structure. If no kind-dispatcher exists, add one in the assistant-bubble branch before the markdown render, modeled on how `kind='weekly_review'` is handled in the existing code.

- [ ] **Step 3: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```
git add components/chat/WorkoutDebriefCard.tsx components/chat/ChatMessage.tsx
git commit -m "feat(chat): render workout_debrief card with TL;DR + link to full debrief"
```

---

## Task 10 — Full debrief page + SessionDebriefView

**Files:**
- Create: `app/coach/sessions/[workout_id]/page.tsx`
- Create: `components/coach/SessionDebriefView.tsx`

The page is server-rendered. It reads the `chat_messages` row by `(user_id, kind='workout_debrief', ui->>'workout_id' = $1)` and passes the payload to `SessionDebriefView`. If no row exists (race condition: page opened before debrief landed), shows a placeholder.

- [ ] **Step 1: Create the view component**

Write `components/coach/SessionDebriefView.tsx`:

```tsx
import { COLOR } from "@/lib/ui/theme";
import type { WorkoutDebriefPayload } from "@/lib/data/types";
import { fmtNum } from "@/lib/ui/score";

function statusBadge(status: WorkoutDebriefPayload["volume"][number]["status"]) {
  const map = {
    below_mev: { label: "Below MEV", color: COLOR.textMuted },
    in_mav: { label: "In MAV", color: COLOR.success },
    approaching_mrv: { label: "Approaching MRV", color: COLOR.warning },
    over_mrv: { label: "Over MRV", color: COLOR.danger },
  } as const;
  return map[status];
}

function liftTag(tag: WorkoutDebriefPayload["lifts"][number]["tag"]) {
  if (tag === "PR") return { label: "PR", color: COLOR.success };
  if (tag === "stall") return { label: "Stall", color: COLOR.warning };
  if (tag === "regression") return { label: "Regression", color: COLOR.danger };
  return null;
}

export function SessionDebriefView({ payload }: { payload: WorkoutDebriefPayload }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "16px 16px 80px" }}>
      <header>
        <div style={{ fontSize: 10, color: COLOR.textMuted, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {payload.date} · Session debrief
        </div>
        <h1 style={{ margin: "2px 0 0 0", fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {payload.session_type}
        </h1>
        {payload.block.week_num != null && payload.block.total_weeks != null && (
          <div style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 4 }}>
            Mesocycle week {payload.block.week_num} of {payload.block.total_weeks}
            {payload.block.phase && ` · ${payload.block.phase}`}
            {payload.block.rir_target != null && ` · RIR ${payload.block.rir_target}`}
          </div>
        )}
      </header>

      {/* Per-lift table */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Lifts</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {payload.lifts.map((lift) => {
            const tag = liftTag(lift.tag);
            return (
              <div
                key={lift.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 4,
                  padding: "8px 10px",
                  background: COLOR.surface,
                  borderRadius: 10,
                  border: `1px solid ${COLOR.divider}`,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{lift.name}</div>
                {tag && (
                  <div style={{ fontSize: 11, fontWeight: 700, color: tag.color }}>{tag.label}</div>
                )}
                <div style={{ fontSize: 12, color: COLOR.textMuted, gridColumn: "1 / -1" }}>
                  Today: {lift.top_set_today.kg != null ? `${fmtNum(lift.top_set_today.kg)}kg` : "—"}
                  {lift.top_set_today.reps != null && ` × ${lift.top_set_today.reps}`}
                  {lift.top_set_today.e1rm != null && ` (e1RM ${fmtNum(lift.top_set_today.e1rm)}kg)`}
                  {lift.top_set_last.date && (
                    <>
                      {" · Last ("}
                      {lift.top_set_last.date}
                      {"): "}
                      {lift.top_set_last.kg != null ? `${fmtNum(lift.top_set_last.kg)}kg` : "—"}
                      {lift.top_set_last.e1rm != null && ` (e1RM ${fmtNum(lift.top_set_last.e1rm)}kg)`}
                    </>
                  )}
                  {lift.delta_e1rm != null && (
                    <>
                      {" · Δe1RM "}
                      <span style={{ color: lift.delta_e1rm >= 0 ? COLOR.success : COLOR.danger }}>
                        {lift.delta_e1rm >= 0 ? "+" : ""}
                        {fmtNum(lift.delta_e1rm)}kg
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Volume vs landmarks */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Volume vs MEV / MAV / MRV</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {payload.volume.map((v) => {
            const badge = statusBadge(v.status);
            const pct = Math.min(100, (v.sets_this_week / v.band.mrv) * 100);
            return (
              <div
                key={v.muscle}
                style={{
                  padding: "8px 10px",
                  background: COLOR.surface,
                  borderRadius: 10,
                  border: `1px solid ${COLOR.divider}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{v.muscle}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: badge.color }}>{badge.label}</span>
                </div>
                <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
                  {fmtNum(v.sets_this_week)} sets this week (today {fmtNum(v.sets_today)}) · band MEV {v.band.mev} · MAV {v.band.mav_low}–{v.band.mav_high} · MRV {v.band.mrv}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    height: 4,
                    background: COLOR.divider,
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div style={{ width: `${pct}%`, height: "100%", background: badge.color }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Autoregulation */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Autoregulation</h2>
        <p style={{ fontSize: 13, color: COLOR.textStrong, lineHeight: 1.5, margin: 0 }}>
          {payload.autoregulation.interpretation}
        </p>
      </section>

      {/* Narrative */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Coach Carter</h2>
        <div
          style={{ fontSize: 13, lineHeight: 1.55, color: COLOR.textStrong, whiteSpace: "pre-wrap" }}
          dangerouslySetInnerHTML={{ __html: simpleMarkdown(payload.narrative_md) }}
        />
      </section>

      {/* Prescription */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Prescription for next session</h2>
        {payload.prescription.weight_changes.length === 0 && payload.prescription.notes.length === 0 && (
          <p style={{ fontSize: 13, color: COLOR.textMuted }}>No changes — repeat the session as written.</p>
        )}
        {payload.prescription.weight_changes.length > 0 && (
          <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: COLOR.textStrong, lineHeight: 1.5 }}>
            {payload.prescription.weight_changes.map((w) => (
              <li key={w.exercise}>
                <strong>{w.exercise}</strong> → {fmtNum(w.new_kg)}kg — {w.rationale}
              </li>
            ))}
          </ul>
        )}
        {payload.prescription.notes.length > 0 && (
          <ul style={{ paddingLeft: 18, margin: "6px 0 0 0", fontSize: 13, color: COLOR.textMuted, lineHeight: 1.5 }}>
            {payload.prescription.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function simpleMarkdown(md: string): string {
  // Tiny renderer: paragraphs + bold/italic only. No links, no headings.
  const escaped = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return withItalic
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin: 0 0 8px 0">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}
```

- [ ] **Step 2: Create the page**

Write `app/coach/sessions/[workout_id]/page.tsx`:

```tsx
import { redirect, notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SessionDebriefView } from "@/components/coach/SessionDebriefView";
import { COLOR } from "@/lib/ui/theme";
import type { WorkoutDebriefPayload } from "@/lib/data/types";

export const dynamic = "force-dynamic";

export default async function SessionDebriefPage({
  params,
}: {
  params: Promise<{ workout_id: string }>;
}) {
  const { workout_id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: row, error } = await supabase
    .from("chat_messages")
    .select("ui")
    .eq("user_id", user.id)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", workout_id)
    .maybeSingle();
  if (error) {
    return (
      <div style={{ padding: 24, color: COLOR.danger }}>
        Failed to load debrief: {error.message}
      </div>
    );
  }
  if (!row) {
    // Race condition: page opened before the async generator landed the chat
    // row. v1: static message; the user can refresh.
    return (
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>Carter is still reviewing this session…</div>
        <div style={{ fontSize: 12, color: COLOR.textMuted }}>
          Refresh in a few seconds. If nothing appears, the debrief job may have failed —
          re-trigger from the workout history.
        </div>
      </div>
    );
  }

  const payload = row.ui as WorkoutDebriefPayload;
  return <SessionDebriefView payload={payload} />;
}
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```
git add components/coach/SessionDebriefView.tsx app/coach/sessions/[workout_id]/page.tsx
git commit -m "feat(coach): dedicated /coach/sessions/[workout_id] page with full debrief view"
```

---

## Task 11 — Audit script + final manual verification

**Files:**
- Create: `scripts/audit-workout-debrief.mjs`

The audit script confirms every committed in-app logger workout in the last N days (default 14) has a corresponding `chat_messages` row with `kind='workout_debrief'` (or was legitimately skipped because all sets were warmups). It's a regression-watch for the trigger.

- [ ] **Step 1: Create the audit script**

Write `scripts/audit-workout-debrief.mjs`:

```js
// Verify every in-app logger workout has a corresponding workout_debrief
// chat row. Run:
//   AUDIT_USER_ID=<uuid> AUDIT_DAYS=14 \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//     --env-file=.env.local scripts/audit-workout-debrief.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.AUDIT_USER_ID;
const days = Number(process.env.AUDIT_DAYS ?? "14");

if (!url || !key) { console.error("Missing SUPABASE env"); process.exit(1); }
if (!userId) { console.error("Set AUDIT_USER_ID"); process.exit(1); }

const supabase = createClient(url, key, { auth: { persistSession: false } });

const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const { data: workouts, error: wErr } = await supabase
  .from("workouts")
  .select("id, date, type, external_id")
  .eq("user_id", userId)
  .gte("date", since)
  .order("date", { ascending: false });
if (wErr) { console.error(wErr); process.exit(1); }

const loggerWorkouts = (workouts ?? []).filter(
  (w) => typeof w.external_id === "string" && w.external_id.startsWith("logger-"),
);
console.log(`Found ${loggerWorkouts.length} in-app logger workouts since ${since}.`);

let missing = 0;
let present = 0;
for (const w of loggerWorkouts) {
  const { data: chat } = await supabase
    .from("chat_messages")
    .select("id, created_at")
    .eq("user_id", userId)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", w.id)
    .maybeSingle();
  if (chat) {
    present++;
    console.log(`  ✓ ${w.date} ${w.type}  → chat_message ${chat.id}`);
  } else {
    missing++;
    console.log(`  ✗ ${w.date} ${w.type}  → MISSING (workout_id=${w.id})`);
  }
}
console.log(`\n${present} present · ${missing} missing.`);
process.exit(missing > 0 ? 2 : 0);
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: clean (the audit script is `.mjs`, not part of TS compilation, but a clean typecheck on the rest of the tree is still required).

- [ ] **Step 3: Commit**

```
git add scripts/audit-workout-debrief.mjs
git commit -m "feat(coach): audit script for workout_debrief coverage"
```

- [ ] **Step 4: Manual end-to-end verification**

1. Start dev: `npm run dev`. Open `http://localhost:3000`.
2. Open `/strength`. Tap "Start session" on the TodayPlanCard (or any session). The LoggerSheet opens.
3. Log a couple of working sets (real or scratch). Tap Finish.
4. Navigate to `/coach`. Within ~5-10 seconds a Carter card should appear with the `workout_debrief` shape: eyebrow "X debrief · Day", TL;DR (PR / stall / volume), first paragraph of narrative, "Read full debrief →" link.
5. Click the link. `/coach/sessions/<workout_id>` should render the per-lift table, volume bars, autoregulation read, full narrative, prescription block.
6. Re-fire the endpoint manually (idempotency check):
   ```
   curl -X POST http://localhost:3000/api/coach/workout-debrief \
     -H "content-type: application/json" \
     -H "cookie: <your dev session cookie>" \
     -d '{"workout_id":"<the workout id from step 4>"}'
   ```
   Expected: `{ "ok": true, "chat_message_id": "<same id>", "idempotent": true }`. No new chat row.
7. Log a second session of the same type a few days later (or by manipulating the system date). The new debrief's `top_set_last` should reference the earlier session with the correct delta + tag.
8. Edge: log a session with only warmup sets → endpoint returns `{ ok: true, skipped: "no_working_sets" }`, no chat row appears.
9. Run the audit script:
   ```
   AUDIT_USER_ID=<your user_id> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-workout-debrief.mjs
   ```
   Expected: 0 missing.

---

## Out of scope (deferred per spec)

- Retry UI on missing debrief.
- `profiles.disable_workout_debrief` opt-out flag.
- Streaming the narrative live (SSE).
- Per-lift PR celebration micro-cards.
- Cross-session trend integration (weekly review owns that).

## Self-review notes

- **Spec §3 (trigger)** → Task 8 (LoggerSheet client trigger) + Task 7 (endpoint).
- **Spec §4 (generator)** → Tasks 3-7 (composers + orchestrator + narrative).
- **Spec §5 (chat card + dedicated page)** → Tasks 9 + 10.
- **Spec §6 (data shapes)** → Task 1 (types) + Task 2 (payload module).
- **Spec §7 (files touched)** → matches Tasks 1-10. Audit script (Task 11) is "verification" per §9, not "files touched" in §7.
- **Spec §8 (edge cases)** → no-working-sets (Task 7 orchestrator returns `skipped`); no-block (Task 7 reads `BlockProgressPayload` and accepts the `active: false` branch); off-library names (Task 4 `attribute` returns empty Map → no volume contribution; lift composer still works); first-ever workout (Task 3 returns `tag: null`); Strong CSV (no client trigger, no debrief — only LoggerSheet fires the POST).
- **Spec §9 (verification)** → Task 11 Step 4.
- **Placeholder scan** clean.
- **Type consistency** — `WorkoutDebriefPayload` defined in Task 1, re-exported from `payload.ts` in Task 2, consumed by all later tasks. Composer signatures take typed args (e.g. `todayExercises: ExerciseWithSets[]`) and return typed slices of the payload — orchestrator wires them with consistent field names.
