# Daily Coach Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #2 of the coach-as-real-coach arc — a single adaptive `morning_brief` card per day with Monday-kickoff and Tue-Sat-analytical variants. The kickoff anchors the week's prescription from the committed `weekly_reviews`; the analytical variant cites yesterday's per-lift performance vs the planned session and prescribes today's specific loads. Teacher tone (jargon-defined-on-first-use + phase-transition-explainer) is baked into the AI prompt and retrofit into Sub-project #1's narrative prompt.

**Architecture:** Mirror the existing `lib/morning/brief/` pipeline — one Anthropic Haiku 4.5 call per brief, no new tables, no migration. Extend the existing `MorningBriefCard.ui` jsonb with a widened `variant` discriminator and two optional new blocks (`this_week_plan`, `yesterday_vs_plan`). New data source helper reads from `training_weeks` (committed plan) + latest `committed` `weekly_reviews` row. Two new UI section components plus dispatcher wiring.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + RLS), TanStack Query (hybrid SSR-hydrate), Anthropic SDK (Haiku 4.5 via existing `callClaude` wrapper), Tailwind v4. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-15-daily-coach-loop-design.md](../specs/2026-05-15-daily-coach-loop-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create feature branch off main**

  ```bash
  cd "/Users/abdelouahedelbied/Health app"
  git checkout main
  git pull origin main
  git checkout -b feat/daily-coach-loop
  ```

- [ ] **Pre-flight 2: Verify clean baseline**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0. If it doesn't, stop and fix unrelated breakage before continuing.

- [ ] **Pre-flight 3: Verify dev fixture is in place**

  The Weekly Review Document fixture should be live in production Supabase from the prior session (see `memory/project_weekly_review_dev_fixture.md`). Run:

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  import { readFileSync } from 'fs';
  import { createClient } from '@supabase/supabase-js';
  const env = {};
  for (const l of readFileSync('.env.local','utf-8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: blk } = await sb.from('training_blocks').select('start_date, end_date, status').eq('status', 'active').single();
  console.log('Active block:', blk);
  const { data: rev } = await sb.from('weekly_reviews').select('id, week_start, version, status').order('generated_at', { ascending: false }).limit(1).maybeSingle();
  console.log('Latest review:', rev);
  "
  ```

  Expected: active block at `start_date: 2026-05-04`, a committed/draft review at `week_start: 2026-05-04`. If empty or block dates differ, run the fixture setup from `memory/project_weekly_review_dev_fixture.md`.

---

## File Structure

**New files (3):**

| Path | Purpose |
|---|---|
| `lib/morning/brief/yesterday-vs-plan.ts` | Pure composer: per-lift planned vs actual for big-four lifts |
| `components/morning/BriefThisWeekPlan.tsx` | Kickoff block — phase pill, per-lift mini-table, volume strip, weekly_focus excerpt |
| `components/morning/BriefYesterdayVsPlan.tsx` | Analytical block — planned-vs-actual per-lift table with rep-completion% |

**Modified files (8):**

| Path | Change |
|---|---|
| `lib/data/types.ts` | Widen `MorningBriefVariant`; add `ThisWeekPlanBlock` + `YesterdayVsPlanBlock` types; extend `MorningBriefCard` with two optional new fields |
| `lib/morning/brief/data-sources.ts` | Add `getThisWeekPrescription(supabase, userId)` export |
| `lib/morning/brief/flags.ts` | Add `phase_transition_this_week: boolean` to `AdviceFlags` |
| `lib/morning/brief/assembler.ts` | Pick variant by weekday; populate `this_week_plan` / `yesterday_vs_plan` ui fields; extend `BriefInputs` |
| `lib/morning/brief/advice-prompt.ts` | Add common teacher-tone rules; branch system prompt on variant; thread new data into prompt context |
| `lib/coach/weekly-review/narrative-prompt.ts` | Retrofit always-define-jargon rule (~5 lines of system prompt) |
| `components/morning/MorningBriefCard.tsx` | Dispatch new blocks based on `ui.variant` |
| `components/morning/BriefSessionList.tsx` | Show per-lift load + RIR target inline for big-four lifts |

---

## Slice 1 — Types, data sources, composer, flag

Goal: All data plumbing in place. Types compile. Pure composer produces correct `YesterdayVsPlanBlock` from canned inputs. No prompt changes, no UI changes, no assembler integration yet.

### Task 1.1: Add types to lib/data/types.ts

**Files:**
- Modify: `lib/data/types.ts:648` (widen `MorningBriefVariant`)
- Modify: `lib/data/types.ts:699-734` (extend `MorningBriefCard`)
- Modify: `lib/data/types.ts:739+` (extend `AdviceFlags`)

- [ ] **Step 1: Widen `MorningBriefVariant`**

  Find line `export type MorningBriefVariant = "training" | "rest";` (around line 648). Replace with:

  ```ts
  export type MorningBriefVariant = "training" | "rest" | "kickoff" | "analytical";
  // "training" is the legacy variant retained for back-compat with rows
  // written before sub-project #2. "kickoff" fires on Monday after a
  // committed weekly review; "analytical" fires Tue-Sat on training days.
  // "rest" is unchanged.
  ```

- [ ] **Step 2: Add new block types right before `MorningBriefCard`**

  Insert above the existing `export type MorningBriefCard = {` (around line 699):

  ```ts
  export type ThisWeekPlanBlock = {
    schema_version: 1;
    week_n: number;
    total_weeks: number;
    phase_now: WeeklyPhase;             // "mev" | "mav" | "mrv" | "deload" — see lib/data/types.ts
    phase_changed_this_week: boolean;
    per_lift: Array<{
      lift: string;                     // e.g. "Deadlift (Barbell)" — matches SESSION_PLANS keys
      load_kg: number;
      sets: number;
      reps: number;
      rir_target: number | null;
      delta_from_last_week_pct: number | null;
    }>;
    volume_summary: Array<{
      muscle: string;
      sets: number;
      tier: "mev" | "mav" | "mrv";
    }>;
    weekly_focus: string | null;        // excerpted from the committed weekly review
  };

  export type YesterdayVsPlanBlock = {
    schema_version: 1;
    session_logged: boolean;
    swap_applied: boolean;
    per_lift: Array<{
      lift: string;                     // "Squat (Barbell)" etc — big-four only
      planned: { load_kg: number; sets: number; reps: number; rir_target: number | null };
      actual:
        | { top_set_load_kg: number | null; sets_done: number; total_reps_done: number }
        | null;
      reps_completed_pct: number | null;
      rir_target_met: boolean | null;
    }>;
  };
  ```

- [ ] **Step 3: Extend `MorningBriefCard` with two optional fields**

  Find `export type MorningBriefCard = {` and append two optional fields after `tonight`:

  ```ts
  export type MorningBriefCard = {
    variant: MorningBriefVariant;
    readiness: MorningBriefReadiness;
    recap: MorningBriefRecap;
    session: {
      type: string;
      start_time: string | null;
      exercises: MorningBriefExercise[];
      volume_gaps?: Array<{
        group: TargetedMuscleGroup;
        actual: number;
        target: number;
        label: "below_mev" | "near_mrv";
      }>;
    };
    hydration?: MorningBriefHydration | null;
    macros: MorningBriefMacros;
    advice_md: string;
    coach_suggestion: MorningBriefCoachSuggestion;
    tonight: MorningBriefTonight;
    /** Populated when variant === 'kickoff' (Monday after a committed weekly review). */
    this_week_plan?: ThisWeekPlanBlock | null;
    /** Populated when variant === 'analytical' (Tue-Sat training day with a committed week). */
    yesterday_vs_plan?: YesterdayVsPlanBlock | null;
  };
  ```

- [ ] **Step 4: Extend `AdviceFlags` with `phase_transition_this_week`**

  Locate `export type AdviceFlags = {` (around line 739). Append a new boolean field (preserving existing fields):

  ```ts
    /** True when the active committed weekly review's payload.header.block_phase_now
     *  differs from the previous committed review's. Drives the kickoff explainer
     *  rule. False when no prior review exists (treat first-ever week as a transition). */
    phase_transition_this_week: boolean;
  ```

- [ ] **Step 5: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/data/types.ts
  git commit -m "feat(types): widen MorningBriefVariant + add ThisWeekPlanBlock/YesterdayVsPlanBlock"
  ```

### Task 1.2: Add getThisWeekPrescription to data-sources.ts

**Files:**
- Modify: `lib/morning/brief/data-sources.ts` (append new export at end)

- [ ] **Step 1: Inspect existing patterns**

  ```bash
  grep -n "^export async function\|^export function" lib/morning/brief/data-sources.ts
  ```

  Note how existing fetchers return null gracefully on miss. Mirror that.

- [ ] **Step 2: Add the helper at end of file**

  Append to `lib/morning/brief/data-sources.ts`:

  ```ts
  // ── This-week prescription (sub-project #2) ─────────────────────────────────

  import type { WeeklyReviewRow } from "@/lib/data/types";
  // ↑ if this import already exists at the top of the file, skip the duplicate.

  /**
   * Read this week's prescription. Returns the current `training_weeks` row
   * for the week containing today + the latest `committed` `weekly_reviews`
   * row for that same `week_start`. Used by the brief assembler to populate
   * the kickoff block on Monday and to anchor today's prescribed loads on
   * Tue-Sat.
   *
   * Returns null when either:
   *   - no `training_weeks` row exists for today's week, OR
   *   - no `committed` `weekly_reviews` row exists for that week.
   *
   * Caller should gracefully fall back to legacy 'training' variant.
   */
  export async function getThisWeekPrescription(
    supabase: SupabaseClient,
    userId: string,
    today: string,           // "YYYY-MM-DD"
  ): Promise<{ trainingWeek: TrainingWeek; review: WeeklyReviewRow } | null> {
    const weekStart = mondayOf(today);

    const [twResult, revResult] = await Promise.all([
      supabase
        .from("training_weeks")
        .select("*")
        .eq("user_id", userId)
        .eq("week_start", weekStart)
        .maybeSingle(),
      supabase
        .from("weekly_reviews")
        .select(`
          id, user_id, week_start, next_week_start, version, status, block_id,
          payload, narrative_md, reconfirm_responses,
          committed_at, committed_training_week_id,
          generated_at, updated_at, created_at
        `)
        .eq("user_id", userId)
        .eq("week_start", weekStart)
        .eq("status", "committed")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (twResult.error) throw twResult.error;
    if (revResult.error) throw revResult.error;

    const trainingWeek = twResult.data as TrainingWeek | null;
    const review = revResult.data as WeeklyReviewRow | null;
    if (!trainingWeek || !review) return null;
    return { trainingWeek, review };
  }

  function mondayOf(yyyyMmDd: string): string {
    const d = new Date(`${yyyyMmDd}T12:00:00Z`);
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (dow - 1));
    return d.toISOString().slice(0, 10);
  }
  ```

  Note: the file may already have a `WeeklyReviewRow` import — if so, deduplicate. The `mondayOf` helper may also exist elsewhere; check `lib/coach/weekly-review/date-utils.ts` (shipped in Sub-project #1) and use it instead if present:

  ```ts
  import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
  ```

  If `mondayOf` is already imported, drop the local definition.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add lib/morning/brief/data-sources.ts
  git commit -m "feat(brief): getThisWeekPrescription reads committed training_weeks + weekly_review"
  ```

### Task 1.3: Create yesterday-vs-plan composer

**Files:**
- Create: `lib/morning/brief/yesterday-vs-plan.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/morning/brief/yesterday-vs-plan.ts`:

  ```ts
  // lib/morning/brief/yesterday-vs-plan.ts
  //
  // Pure composer for the Tue-Sat analytical block. Given yesterday's planned
  // session and yesterday's actual workout, produce a per-lift comparison for
  // the big-four lifts (Squat / Deadlift / Decline Bench / OHP).
  //
  // Returns null when yesterday was a planned rest day (nothing to compare).
  // When no workout was logged for yesterday, session_logged=false and per_lift
  // entries have actual=null + reps_completed_pct=null. The block still renders
  // with an explicit "no logged session yesterday" annotation.

  import type {
    YesterdayVsPlanBlock,
    TrainingWeek,
    WeeklyReviewRow,
  } from "@/lib/data/types";
  import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
  import { readSessionForDay } from "@/lib/coach/session-plan-reader";
  import { roundToValidWeight } from "@/lib/coach/weight-rounding";

  const BIG_FOUR = [
    "Squat (Barbell)",
    "Deadlift (Barbell)",
    "Decline Bench Press (Barbell)",
    "Overhead Press (Barbell)",
  ];

  /** A single set logged in a workout, in the shape Slice 2a's compose-recap
   *  established (workouts → exercises → exercise_sets via Supabase embedded
   *  select). */
  export type LoggedSet = {
    exercise: string;
    kg: number | null;
    reps: number | null;
    warmup: boolean;
  };

  export type YesterdayWorkoutForBlock = {
    type: string;                       // session label, e.g. "Legs"
    sets: LoggedSet[];                  // flat list across all exercises
  };

  export type ComposeYesterdayVsPlanInput = {
    yesterdayWeekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
    trainingWeek: TrainingWeek;         // for prescribed loads (per_lift_intent if any) and session_plan
    review: WeeklyReviewRow;            // for per-lift prescription from the committed review's payload
    yesterdayWorkout: YesterdayWorkoutForBlock | null;
    /** True when the actual session type differs from original_session_plan[yesterday]. */
    swapApplied: boolean;
  };

  export function composeYesterdayVsPlan(
    input: ComposeYesterdayVsPlanInput,
  ): YesterdayVsPlanBlock | null {
    const plannedType = readSessionForDay(
      input.trainingWeek.session_plan as Record<string, string>,
      yesterdayLong(input.yesterdayWeekday),
    );
    if (!plannedType || /^rest$/i.test(plannedType)) {
      // No comparison to make if yesterday was a planned rest day. Caller skips the block.
      return null;
    }

    const sessionLogged = input.yesterdayWorkout !== null;
    const perLift = BIG_FOUR.map((lift) =>
      buildPerLiftEntry(lift, plannedType, input.review, input.yesterdayWorkout),
    ).filter((entry) => entry !== null) as YesterdayVsPlanBlock["per_lift"];

    return {
      schema_version: 1,
      session_logged: sessionLogged,
      swap_applied: input.swapApplied,
      per_lift: perLift,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  const WEEKDAY_LONG: Record<string, string> = {
    Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday",
    Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
  };
  function yesterdayLong(wd: string): string {
    return WEEKDAY_LONG[wd] ?? wd;
  }

  function buildPerLiftEntry(
    lift: string,
    plannedSessionType: string,
    review: WeeklyReviewRow,
    workout: YesterdayWorkoutForBlock | null,
  ): YesterdayVsPlanBlock["per_lift"][number] | null {
    // The planned per-lift load/sets/reps comes from the committed weekly_review's
    // prescription. If the lift wasn't prescribed for this week, skip it.
    const reviewLift = review.payload?.prescription?.per_lift?.find(
      (p) => p.lift === lift,
    );
    if (!reviewLift) return null;

    // Was this lift even part of yesterday's planned session?
    // SESSION_PLANS[type] enumerates exercises; we check by name.
    const sessionExercises = SESSION_PLANS[plannedSessionType] as PlannedExercise[] | undefined;
    if (!sessionExercises) return null;
    const isInPlannedSession = sessionExercises.some((e) => e.name === lift);
    if (!isInPlannedSession) return null;

    const planned = {
      load_kg: reviewLift.weight_kg,
      sets: reviewLift.sets,
      reps: reviewLift.reps,
      rir_target: review.payload.prescription.rir_target,
    };

    if (workout === null) {
      return {
        lift,
        planned,
        actual: null,
        reps_completed_pct: null,
        rir_target_met: null,
      };
    }

    const liftSets = workout.sets.filter(
      (s) => s.exercise === lift && !s.warmup,
    );

    const setsDone = liftSets.length;
    const totalRepsDone = liftSets.reduce((sum, s) => sum + (s.reps ?? 0), 0);
    const topSetLoad = liftSets.reduce<number | null>(
      (max, s) => (s.kg != null && (max === null || s.kg > max) ? s.kg : max),
      null,
    );

    const totalRepsPlanned = planned.sets * planned.reps;
    const repsCompletedPct = totalRepsPlanned > 0 ? totalRepsDone / totalRepsPlanned : null;

    // rir_target_met: heuristic — if total reps done ≥ 90% of planned, treat as met.
    // Stricter logic (per-set RIR) requires per-set rir field on exercise_sets which
    // isn't populated reliably. Document this approximation in the spec; revisit
    // when RIR-per-set logging lands.
    const rirTargetMet =
      repsCompletedPct === null ? null : repsCompletedPct >= 0.9;

    return {
      lift,
      planned,
      actual: {
        top_set_load_kg: topSetLoad,
        sets_done: setsDone,
        total_reps_done: totalRepsDone,
      },
      reps_completed_pct: repsCompletedPct,
      rir_target_met: rirTargetMet,
    };
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Common issue: `readSessionForDay` may expect short-form `Weekday` keys. Verify its signature:

  ```bash
  grep -n "^export.*readSessionForDay" lib/coach/session-plan-reader.ts
  ```

  If it accepts short form (`Mon`, `Tue`, ...), drop the `yesterdayLong` helper and pass the short form directly. Adapt the type imports accordingly.

- [ ] **Step 3: Commit**

  ```bash
  git add lib/morning/brief/yesterday-vs-plan.ts
  git commit -m "feat(brief): yesterday-vs-plan composer for big-four lifts"
  ```

### Task 1.4: Add phase_transition_this_week flag to flags.ts

**Files:**
- Modify: `lib/morning/brief/flags.ts`

- [ ] **Step 1: Inspect existing flag computation pattern**

  ```bash
  grep -n "FlagInputs\|computeAdviceFlags" lib/morning/brief/flags.ts | head -10
  ```

  Note how existing flags accept their inputs as part of `FlagInputs` and assignments happen in `computeAdviceFlags`.

- [ ] **Step 2: Extend FlagInputs**

  Find `export type FlagInputs = {` (around line 31). Append a new optional field at the bottom:

  ```ts
    /** The latest committed weekly_review for this user (if any). Used to
     *  derive phase_transition_this_week by comparing block_phase_now to
     *  the previous committed review's block_phase_now. */
    latestCommittedReview?: WeeklyReviewRow | null;
    /** The previous-week committed weekly_review (if any). Used for the
     *  same comparison. Null when no prior review exists. */
    previousCommittedReview?: WeeklyReviewRow | null;
  ```

  Add `WeeklyReviewRow` to the existing type imports at the top of the file.

- [ ] **Step 3: Compute the flag in computeAdviceFlags**

  Find the `computeAdviceFlags` function body. Inside the returned object, add the new flag:

  ```ts
    phase_transition_this_week:
      inputs.latestCommittedReview && inputs.previousCommittedReview
        ? inputs.latestCommittedReview.payload.header.block_phase_now !==
          inputs.previousCommittedReview.payload.header.block_phase_now
        : inputs.latestCommittedReview != null,
        // No previous review = first ever committed week = treat as transition.
  ```

- [ ] **Step 4: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 5: Commit Slice 1**

  ```bash
  git add lib/morning/brief/flags.ts
  git commit -m "feat(brief): phase_transition_this_week flag for kickoff explainer"
  git push -u origin feat/daily-coach-loop
  gh pr create --title "feat(brief): daily coach loop — data plumbing (Slice 1/3)" \
    --body "Types + new composer + getThisWeekPrescription helper + phase_transition flag. No prompt changes, no UI changes yet. Builds the data layer for sub-project #2."
  ```

---

## Slice 2 — Prompt rewrite, assembler integration, narrative-prompt retrofit

Goal: End-to-end variant selection works. Triggering a morning intake on Monday produces a kickoff-variant brief with the new `this_week_plan` field populated. Tue-Sat produces analytical-variant with `yesterday_vs_plan`. AI prompt cites the new data. Components still render via legacy paths.

### Task 2.1: Extend BriefInputs and assembler

**Files:**
- Modify: `lib/morning/brief/assembler.ts`

- [ ] **Step 1: Extend BriefInputs**

  Find `export type BriefInputs = {` in `lib/morning/brief/assembler.ts`. Append three new fields:

  ```ts
    /** The committed training_weeks row + committed weekly_review for the
     *  current week. Populated by getThisWeekPrescription in data-sources.
     *  Null when either is missing — triggers the legacy 'training' fallback. */
    thisWeekPrescription: { trainingWeek: TrainingWeek; review: WeeklyReviewRow } | null;
    /** Yesterday's workout in the flat shape the yesterday-vs-plan composer
     *  consumes. Null when no workout logged. */
    yesterdayWorkoutForBlock: import("./yesterday-vs-plan").YesterdayWorkoutForBlock | null;
    /** True when yesterday's actual session type differs from
     *  training_weeks.original_session_plan for yesterday. Per migration 0012. */
    swapAppliedYesterday: boolean;
  ```

  Add to the imports at the top:

  ```ts
  import type { TrainingWeek, WeeklyReviewRow } from "@/lib/data/types";
  ```

- [ ] **Step 2: Add the variant picker**

  Below the existing `pickVariant` function (which currently returns `'training' | 'rest'` based on `sessionType`), replace its body with the four-variant logic:

  ```ts
  function pickVariant(
    sessionType: string,
    today: string,
    thisWeekPrescription: BriefInputs["thisWeekPrescription"],
  ): MorningBriefVariant {
    if (/^rest$/i.test(sessionType)) return "rest";
    if (!thisWeekPrescription) return "training";  // legacy fallback

    const weekday = weekdayFromDate(today);
    if (weekday === "Monday") return "kickoff";
    return "analytical";
  }

  function weekdayFromDate(yyyyMmDd: string): string {
    const d = new Date(`${yyyyMmDd}T12:00:00Z`);
    return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()];
  }
  ```

- [ ] **Step 3: Populate the new ui fields in assembleBriefExceptAdvice**

  In `assembleBriefExceptAdvice`, change the variant resolution and add the two new fields to the returned object:

  ```ts
  export function assembleBriefExceptAdvice(
    inputs: BriefInputs,
  ): Omit<MorningBriefCard, "advice_md"> {
    const variant: MorningBriefVariant = pickVariant(
      inputs.sessionType,
      inputs.today,
      inputs.thisWeekPrescription,
    );
    const readiness = composeReadiness(inputs);

    const thisWeekPlan =
      variant === "kickoff" && inputs.thisWeekPrescription
        ? composeThisWeekPlan(inputs.thisWeekPrescription)
        : null;

    const yesterdayVsPlan =
      variant === "analytical" && inputs.thisWeekPrescription
        ? composeYesterdayVsPlan({
            yesterdayWeekday: shortWeekdayFromDate(inputs.yesterday),
            trainingWeek: inputs.thisWeekPrescription.trainingWeek,
            review: inputs.thisWeekPrescription.review,
            yesterdayWorkout: inputs.yesterdayWorkoutForBlock,
            swapApplied: inputs.swapAppliedYesterday,
          })
        : null;

    return {
      variant,
      readiness,
      recap: composeRecap(inputs),
      session: composeSession(variant, inputs),
      hydration: composeHydration(inputs),
      macros: composeMacros(inputs),
      tonight: composeTonight(inputs),
      coach_suggestion: pickCoachSuggestion(
        readiness.band,
        inputs.sessionType,
        inputs.hasTrainingWeek,
      ),
      this_week_plan: thisWeekPlan,
      yesterday_vs_plan: yesterdayVsPlan,
    };
  }
  ```

  Add the import for the new composer at the top:

  ```ts
  import { composeYesterdayVsPlan } from "./yesterday-vs-plan";
  ```

  Add a helper `shortWeekdayFromDate` next to `weekdayFromDate`:

  ```ts
  function shortWeekdayFromDate(yyyyMmDd: string): "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun" {
    const d = new Date(`${yyyyMmDd}T12:00:00Z`);
    return (["Sun","Mon","Tue","Wed","Thu","Fri","Sat"] as const)[d.getUTCDay()];
  }
  ```

- [ ] **Step 4: Add composeThisWeekPlan helper to assembler.ts**

  Append to the bottom of `lib/morning/brief/assembler.ts`:

  ```ts
  function composeThisWeekPlan(
    prescription: NonNullable<BriefInputs["thisWeekPrescription"]>,
  ): import("@/lib/data/types").ThisWeekPlanBlock {
    const { review } = prescription;
    const header = review.payload.header;
    const presc = review.payload.prescription;
    const volumeFromPayload = review.payload.volume?.per_muscle ?? [];

    return {
      schema_version: 1,
      week_n: header.week_n,
      total_weeks: header.total_weeks,
      phase_now: header.block_phase_now,
      phase_changed_this_week: header.block_phase_now !== header.block_phase_next
        ? false   // header.block_phase_now is THIS week; block_phase_next is next week.
        // The "phase_changed" flag here refers to the OPEN of this week, i.e.
        // whether THIS week's phase differs from LAST week's. The flag computed
        // upstream in flags.ts (phase_transition_this_week) is authoritative.
        // We mirror it here for renderer convenience; the assembler passes the
        // flag value via a side-channel below.
        : false,
      per_lift: presc.per_lift.map((p) => ({
        lift: p.lift,
        load_kg: p.weight_kg,
        sets: p.sets,
        reps: p.reps,
        rir_target: presc.rir_target,
        delta_from_last_week_pct: p.delta_pct_from_last_week,
      })),
      volume_summary: volumeFromPayload.map((v) => ({
        muscle: v.muscle,
        sets: v.next_week_sets,
        tier: v.tier,
      })),
      weekly_focus: presc.weekly_focus ?? null,
    };
  }
  ```

  **Implementation note for the engineer:** the `phase_changed_this_week` field on `ThisWeekPlanBlock` is set authoritatively by the assembler from the flags computation. Plumb the flag through `BriefInputs` and pass it into `composeThisWeekPlan`. Adjust:

  ```ts
  // In BriefInputs, add:
    phaseTransitionThisWeek: boolean;

  // In composeThisWeekPlan signature, accept it:
  function composeThisWeekPlan(
    prescription: NonNullable<BriefInputs["thisWeekPrescription"]>,
    phaseTransitionThisWeek: boolean,
  ): ThisWeekPlanBlock {
    // ... use phaseTransitionThisWeek for phase_changed_this_week field
  }

  // In assembleBriefExceptAdvice call site, pass it:
    const thisWeekPlan =
      variant === "kickoff" && inputs.thisWeekPrescription
        ? composeThisWeekPlan(inputs.thisWeekPrescription, inputs.phaseTransitionThisWeek)
        : null;
  ```

- [ ] **Step 5: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  If `WeeklyPhase` import is missing, add it to the imports at the top of `assembler.ts`.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/morning/brief/assembler.ts
  git commit -m "feat(brief): variant picker + composeThisWeekPlan + composeYesterdayVsPlan integration"
  ```

### Task 2.2: Thread new data through the brief pipeline orchestrator

**Files:**
- Modify: `lib/morning/brief/index.ts` (or wherever the orchestrator that calls `assembleBriefExceptAdvice` lives)

- [ ] **Step 1: Locate the brief orchestrator**

  ```bash
  grep -rn "assembleBriefExceptAdvice\|generateAdvice" lib/morning/brief/ app/api/ 2>/dev/null
  ```

  Identify the orchestrator file. Typically `lib/morning/brief/index.ts`. Read it to understand the existing data-fetch + assembly flow.

- [ ] **Step 2: Call getThisWeekPrescription in the data-fetch step**

  In the orchestrator (likely `index.ts`), find the parallel `Promise.all` data fetch. Add `getThisWeekPrescription` to that fan-out:

  ```ts
  import { getThisWeekPrescription } from "./data-sources";

  // Inside the orchestrator, add to the parallel Promise.all:
  const [
    /* existing entries */,
    thisWeekPrescription,
  ] = await Promise.all([
    /* existing fetches */,
    getThisWeekPrescription(supabase, userId, today),
  ]);
  ```

  Then build the `yesterdayWorkoutForBlock`:

  ```ts
  // Convert the existing yesterdayWorkout into the flat shape composeYesterdayVsPlan expects.
  // The existing data source returns YesterdayWorkoutSummary (one top_e1rm). We need
  // the full set list — fetch separately or have data-sources return it.
  ```

  **Adapt:** the existing `getYesterdayWorkout` returns `YesterdayWorkoutSummary` (only top_e1rm). To get the full flat set list, add a NEW data-source helper `getYesterdayWorkoutFlat(supabase, userId, yesterday)` that returns the embedded-select shape. Edit `lib/morning/brief/data-sources.ts`:

  ```ts
  import type { YesterdayWorkoutForBlock } from "./yesterday-vs-plan";

  export async function getYesterdayWorkoutFlat(
    supabase: SupabaseClient,
    userId: string,
    yesterday: string,
  ): Promise<YesterdayWorkoutForBlock | null> {
    const { data, error } = await supabase
      .from("workouts")
      .select("type, exercises (name, sets:exercise_sets (kg, reps, warmup))")
      .eq("user_id", userId)
      .eq("date", yesterday)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    type Row = {
      type: string;
      exercises: Array<{ name: string; sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
    };
    const row = data as Row;
    const flat: YesterdayWorkoutForBlock = {
      type: row.type,
      sets: row.exercises.flatMap((ex) =>
        ex.sets.map((s) => ({
          exercise: ex.name,
          kg: s.kg,
          reps: s.reps,
          warmup: s.warmup,
        })),
      ),
    };
    return flat;
  }
  ```

  Call this in the orchestrator parallel fetch alongside `getThisWeekPrescription`.

- [ ] **Step 3: Compute swapAppliedYesterday**

  In the orchestrator, after `thisWeekPrescription` is fetched, compute the swap flag:

  ```ts
  const swapAppliedYesterday = (() => {
    if (!thisWeekPrescription) return false;
    const tw = thisWeekPrescription.trainingWeek;
    // training_weeks.original_session_plan is nullable (migration 0012)
    const original = (tw.original_session_plan ?? tw.session_plan) as Record<string, string>;
    const current = tw.session_plan as Record<string, string>;
    const yesterdayLong = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
      [new Date(`${yesterday}T12:00:00Z`).getUTCDay()];
    return original[yesterdayLong] !== current[yesterdayLong];
  })();
  ```

- [ ] **Step 4: Compute phaseTransitionThisWeek + propagate flags**

  Fetch the previous-week committed review:

  ```ts
  async function getPreviousCommittedReview(
    supabase: SupabaseClient,
    userId: string,
    weekStart: string,
  ): Promise<WeeklyReviewRow | null> {
    const prevMonday = new Date(`${weekStart}T12:00:00Z`);
    prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);
    const prev = prevMonday.toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("weekly_reviews")
      .select(`
        id, user_id, week_start, next_week_start, version, status, block_id,
        payload, narrative_md, reconfirm_responses,
        committed_at, committed_training_week_id,
        generated_at, updated_at, created_at
      `)
      .eq("user_id", userId)
      .eq("week_start", prev)
      .eq("status", "committed")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as WeeklyReviewRow | null;
  }
  ```

  Add this to the parallel fetch.

  In the existing `computeAdviceFlags(...)` call site, pass the new inputs:

  ```ts
  const flags = computeAdviceFlags({
    /* existing inputs */,
    latestCommittedReview: thisWeekPrescription?.review ?? null,
    previousCommittedReview,
  });
  ```

  Then plumb `flags.phase_transition_this_week` into the `BriefInputs.phaseTransitionThisWeek` when calling `assembleBriefExceptAdvice`:

  ```ts
  const card = assembleBriefExceptAdvice({
    /* existing inputs */,
    thisWeekPrescription,
    yesterdayWorkoutForBlock,
    swapAppliedYesterday,
    phaseTransitionThisWeek: flags.phase_transition_this_week,
  });
  ```

- [ ] **Step 5: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add lib/morning/brief/index.ts lib/morning/brief/data-sources.ts
  git commit -m "feat(brief): orchestrator threads this-week prescription + yesterday flat workout"
  ```

### Task 2.3: Rewrite advice-prompt.ts with variant branches

**Files:**
- Modify: `lib/morning/brief/advice-prompt.ts`

- [ ] **Step 1: Add common teacher-tone rules constant**

  Near the top of `lib/morning/brief/advice-prompt.ts`, after the imports, add:

  ```ts
  const TEACHER_TONE_RULES = `
  TONE & TEACHING RULES (apply to every reply):
  1. Second person, conversational. "You" not "the athlete".
  2. On first mention in this reply, define jargon in 5-10 words of plain English:
     - MEV → "the minimum weekly sets that drive growth"
     - MAV → "the productive volume range"
     - MRV → "your weekly recovery ceiling"
     - RIR → "reps you could still do at the same weight"
     - deload → "a lighter week to absorb the training"
     - e1RM → "estimated one-rep max from your top set"
     - efficiency (sleep) → "time actually asleep ÷ time in bed"
     If a term appears again later in the same reply, don't re-define.
  3. Prefer everyday language. Don't write "myofibrillar hypertrophy" when "muscle growth" works.
  4. Explain why a concept matters when it drives a decision today. Skip the textbook tone.
  `.trim();
  ```

- [ ] **Step 2: Extend AdviceContext**

  Find `export type AdviceContext = {` and add a variant-specific field:

  ```ts
  export type AdviceContext = {
    activeProfile: AthleteProfileDocument | null;
    card: Omit<MorningBriefCard, "advice_md">;
    flags: AdviceFlags;
    targets: TodayTargets | null;
    muscleVolumeFlags?: MuscleVolumeFlag[];
    muscleVolume?: StrengthMuscleVolume | null;
  };
  ```

  (No change — the variant is already available on `card.variant`. We branch on that.)

- [ ] **Step 3: Refactor buildSystemPrompt to branch on variant**

  Find `function buildSystemPrompt(ctx: AdviceContext): string` and replace with:

  ```ts
  function buildSystemPrompt(ctx: AdviceContext): string {
    const variant = ctx.card.variant;

    if (variant === "kickoff") return buildKickoffPrompt(ctx);
    if (variant === "analytical") return buildAnalyticalPrompt(ctx);
    // 'training' (legacy) and 'rest' use the existing prompt unchanged.
    return buildLegacyPrompt(ctx);
  }

  function buildKickoffPrompt(ctx: AdviceContext): string {
    const athleteContextBlock = buildAthleteContext(ctx);
    const dataBlock = buildDataBlock(ctx.card);
    const flagsBlock = buildFlagsBlock(ctx.flags);
    const coachingContext = buildCoachingContext(ctx.flags, ctx.targets);
    const muscleVolumeBlock = buildMuscleVolumeBlock(ctx.muscleVolumeFlags, ctx.muscleVolume);
    const planBlock = buildThisWeekPlanBlock(ctx.card.this_week_plan ?? null);

    const phaseExplainer = ctx.flags.phase_transition_this_week
      ? "PHASE TRANSITION: this week's phase differs from last week. Open with one plain-English sentence explaining what the new phase asks of the athlete."
      : "Phase is unchanged from last week. Don't re-explain the phase; reference it briefly.";

    return [
      `You are this athlete's coach delivering today's Monday morning kickoff brief.`,
      TEACHER_TONE_RULES,
      "",
      athleteContextBlock,
      "",
      planBlock,
      "",
      "FLAGS:",
      flagsBlock,
      "",
      "COACHING CONTEXT:",
      coachingContext,
      "",
      muscleVolumeBlock,
      "",
      "TODAY'S DATA:",
      dataBlock,
      "",
      "WRITING INSTRUCTIONS:",
      `${phaseExplainer}`,
      "Length: 100-150 words of prose. Cover, in order:",
      "  1. The phase and what it means (1 sentence if changed; brief mention if unchanged).",
      "  2. Today's session focus (today's biggest lift + its prescribed load).",
      "  3. The volume context (1 sentence on per-muscle targets if notable).",
      "  4. Nutrition + sleep anchors (1 sentence each).",
      "",
      "Never invent numbers. Reference exact values from the payload.",
    ].join("\n");
  }

  function buildAnalyticalPrompt(ctx: AdviceContext): string {
    const athleteContextBlock = buildAthleteContext(ctx);
    const dataBlock = buildDataBlock(ctx.card);
    const flagsBlock = buildFlagsBlock(ctx.flags);
    const coachingContext = buildCoachingContext(ctx.flags, ctx.targets);
    const muscleVolumeBlock = buildMuscleVolumeBlock(ctx.muscleVolumeFlags, ctx.muscleVolume);
    const yesterdayBlock = buildYesterdayVsPlanBlock(ctx.card.yesterday_vs_plan ?? null);

    return [
      `You are this athlete's coach delivering today's Tue-Sat morning brief.`,
      TEACHER_TONE_RULES,
      "",
      athleteContextBlock,
      "",
      yesterdayBlock,
      "",
      "FLAGS:",
      flagsBlock,
      "",
      "COACHING CONTEXT:",
      coachingContext,
      "",
      muscleVolumeBlock,
      "",
      "TODAY'S DATA:",
      dataBlock,
      "",
      "WRITING INSTRUCTIONS:",
      "Length: 80-130 words of prose. Cover, in order:",
      "  1. Yesterday's per-lift performance — rep completion, any RIR miss. 1-2 sentences.",
      "  2. Today's prescribed lift(s) with exact loads. 1-2 sentences.",
      "  3. One adaptive cue (form, fatigue, nutrition gap) — pick the most actionable.",
      "",
      "If yesterday's session was not logged (session_logged: false), acknowledge it briefly and pivot to today-prescription-only framing.",
      "",
      "Never invent numbers. Reference exact values from the payload.",
    ].join("\n");
  }

  function buildLegacyPrompt(ctx: AdviceContext): string {
    // Move the current buildSystemPrompt function body here verbatim,
    // returning its existing string. Then prepend TEACHER_TONE_RULES.
    // Implementation: COPY the current function body from advice-prompt.ts
    // line-for-line into this function and have it return the existing prompt
    // string prefixed with `${TEACHER_TONE_RULES}\n\n`. The kickoff and
    // analytical branches above use new builders; the legacy/rest path keeps
    // everything that was working pre-refactor.
  }
  ```

  **Concrete refactor operation for the implementer:**

  1. Find the current `buildSystemPrompt(ctx: AdviceContext): string` function in `advice-prompt.ts`.
  2. Rename it to `buildLegacyPrompt(ctx: AdviceContext): string`. Keep its full body unchanged.
  3. In the new `buildLegacyPrompt`, before the existing `return` statement, prepend `TEACHER_TONE_RULES` to the prompt string.
  4. Add the new `buildSystemPrompt` dispatcher (shown earlier in this task) that routes to `buildKickoffPrompt` / `buildAnalyticalPrompt` / `buildLegacyPrompt` based on `ctx.card.variant`.
  5. Extract the helpers (`buildAthleteContext`, `buildDataBlock`, `buildFlagsBlock`, `buildCoachingContext`, `buildMuscleVolumeBlock`) into standalone functions so both the kickoff and analytical builders can call them. Most are likely already inline in the current `buildSystemPrompt` — pull them out into module-private functions.

- [ ] **Step 4: Add buildThisWeekPlanBlock + buildYesterdayVsPlanBlock helpers**

  Append below the prompt builders:

  ```ts
  function buildThisWeekPlanBlock(plan: import("@/lib/data/types").ThisWeekPlanBlock | null): string {
    if (!plan) return "(No committed weekly review available for this week.)";
    const lines = [
      `THIS WEEK'S PLAN (committed weekly review):`,
      `  Week ${plan.week_n} of ${plan.total_weeks} · phase: ${plan.phase_now}${plan.phase_changed_this_week ? " (NEW THIS WEEK)" : ""}`,
      `  Per-lift loads:`,
    ];
    for (const p of plan.per_lift) {
      const rir = p.rir_target != null ? `, RIR ${p.rir_target}` : "";
      const delta = p.delta_from_last_week_pct != null
        ? ` (${(p.delta_from_last_week_pct * 100).toFixed(1)}% from last week)`
        : "";
      lines.push(`    - ${p.lift}: ${p.load_kg}kg × ${p.sets} × ${p.reps}${rir}${delta}`);
    }
    if (plan.volume_summary.length > 0) {
      lines.push(`  Volume targets:`);
      for (const v of plan.volume_summary) {
        lines.push(`    - ${v.muscle}: ${v.sets} sets (${v.tier})`);
      }
    }
    if (plan.weekly_focus) {
      lines.push(`  Weekly focus: ${plan.weekly_focus}`);
    }
    return lines.join("\n");
  }

  function buildYesterdayVsPlanBlock(block: import("@/lib/data/types").YesterdayVsPlanBlock | null): string {
    if (!block) return "(Yesterday was a planned rest day.)";
    if (!block.session_logged) {
      return [
        "YESTERDAY VS PLAN:",
        "  (No session logged for yesterday — actual data unavailable.)",
        ...(block.swap_applied ? ["  Note: yesterday's session was swapped from the original prescription."] : []),
      ].join("\n");
    }
    const lines = ["YESTERDAY VS PLAN:"];
    if (block.swap_applied) {
      lines.push("  Note: yesterday's session was swapped from the original prescription.");
    }
    for (const p of block.per_lift) {
      const planned = `${p.planned.load_kg}kg × ${p.planned.sets} × ${p.planned.reps}`;
      if (p.actual === null) {
        lines.push(`  - ${p.lift}: planned ${planned}; no actual logged.`);
        continue;
      }
      const repsPct = p.reps_completed_pct != null
        ? `${Math.round(p.reps_completed_pct * 100)}% reps completed`
        : "rep completion unknown";
      const topLoad = p.actual.top_set_load_kg != null
        ? `, top set ${p.actual.top_set_load_kg}kg`
        : "";
      lines.push(`  - ${p.lift}: planned ${planned}; actual ${p.actual.sets_done} sets, ${p.actual.total_reps_done} reps${topLoad} (${repsPct})`);
    }
    return lines.join("\n");
  }
  ```

- [ ] **Step 5: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add lib/morning/brief/advice-prompt.ts
  git commit -m "feat(brief): variant-aware advice prompt + teacher-tone rules"
  ```

### Task 2.4: Retrofit narrative-prompt.ts (sub-project #1)

**Files:**
- Modify: `lib/coach/weekly-review/narrative-prompt.ts`

- [ ] **Step 1: Add the always-define-jargon rule to the weekly review system prompt**

  Open `lib/coach/weekly-review/narrative-prompt.ts`. Find the existing system prompt string (search for "RULES" or similar). Append (preserving existing rules):

  ```ts
  // Just before the existing RULES list, add:
  TEACHING:
  - On first mention in this reply, define jargon in 5-10 words of plain English:
    MEV ("minimum sets that drive growth"), MAV ("productive volume range"),
    MRV ("weekly recovery ceiling"), RIR ("reps you could still do at the same weight"),
    deload ("a lighter week to absorb training"), e1RM ("one-rep max estimated from your top set"),
    efficiency ("time asleep ÷ time in bed"). Don't re-define within the same reply.
  - Prefer everyday language. Avoid textbook tone.
  ```

  Place this block above the existing numbered RULES so the teaching rule applies before the per-rule constraints (e.g., "Never invent numbers" stays the highest-priority hard rule). Match the existing prompt's style (string formatting, line breaks).

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Manual exercise — regenerate the existing fixture review**

  Start the dev server in a separate terminal:

  ```bash
  npm run dev
  ```

  Then in another terminal, hit the regenerate endpoint to produce a new narrative against the retrofit prompt:

  ```bash
  source .env.local
  # The fixture review id is from memory/project_weekly_review_dev_fixture.md
  REVIEW_ID="$(node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  import { readFileSync } from 'fs';
  import { createClient } from '@supabase/supabase-js';
  const env = {};
  for (const l of readFileSync('.env.local','utf-8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data } = await sb.from('weekly_reviews').select('id').order('generated_at',{ascending:false}).limit(1).single();
  console.log(data.id);
  ")"
  echo "Regenerating review $REVIEW_ID..."
  # The regenerate endpoint requires user auth (not CRON_SECRET). For manual exercise,
  # tap "Regenerate" on the page UI at /coach/weeks/2026-05-04, or use a direct DB
  # inspection of the resulting narrative.
  ```

  Visit `http://localhost:3000/coach/weeks/2026-05-04` and tap the "Regenerate" chip in §8. Check the §6 narrative defines a jargon term (MEV/MAV/etc) in plain English on first use.

  Stop the dev server.

- [ ] **Step 4: Commit Slice 2**

  ```bash
  git add lib/coach/weekly-review/narrative-prompt.ts
  git commit -m "feat(coach): retrofit always-define-jargon rule into weekly-review narrative prompt"
  git push
  gh pr edit <slice-2-PR-number> --add-commit  # (or use gh pr create if Slice 2 is its own PR)
  ```

  If you're stacking PRs (Slice 2 onto Slice 1), this commit lands on the same branch and updates the Slice 1 PR's diff. If splitting per-slice, open a new PR:

  ```bash
  gh pr create --title "feat(brief): daily coach loop — prompt + assembler (Slice 2/3)" \
    --body "Variant-aware system prompt with teacher-tone rules. Assembler picks kickoff/analytical/legacy/rest by weekday. Orchestrator threads this-week prescription + yesterday flat workout into the brief. Retrofit always-define-jargon rule into sub-project #1's narrative prompt."
  ```

---

## Slice 3 — UI components, dispatcher, end-to-end exercise

Goal: Mon kickoff and Tue-Sat analytical briefs render the new structured blocks in the browser. Existing UI is unchanged for legacy/rest variants.

### Task 3.1: Create BriefThisWeekPlan component

**Files:**
- Create: `components/morning/BriefThisWeekPlan.tsx`

- [ ] **Step 1: Inspect existing brief components for visual conventions**

  ```bash
  cat components/morning/BriefMacrosGrid.tsx
  ```

  Note: light theme, Tailwind v4 (no config file), uses `COLOR` from `@/lib/ui/theme`, `fmtNum` from `@/lib/ui/score`.

- [ ] **Step 2: Write the component**

  Create `components/morning/BriefThisWeekPlan.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { ThisWeekPlanBlock } from "@/lib/data/types";

  function shortLift(name: string): string {
    return name.replace(/\s*\([^)]+\)/, "");
  }

  export function BriefThisWeekPlan({ plan }: { plan: ThisWeekPlanBlock }) {
    return (
      <Card>
        <SectionLabel>
          THIS WEEK · WK {plan.week_n}/{plan.total_weeks} · {plan.phase_now.toUpperCase()}
          {plan.phase_changed_this_week ? " · NEW PHASE" : ""}
        </SectionLabel>
        <table style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-dm-mono), monospace", marginTop: 8, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: COLOR.textFaint, fontSize: 9 }}>
              <th style={{ textAlign: "left" }}>LIFT</th>
              <th style={{ textAlign: "right" }}>LOAD</th>
              <th style={{ textAlign: "right" }}>SETS×REPS</th>
              <th style={{ textAlign: "right" }}>RIR</th>
            </tr>
          </thead>
          <tbody>
            {plan.per_lift.map((p) => (
              <tr key={p.lift}>
                <td style={{ color: COLOR.textStrong, padding: "2px 0" }}>{shortLift(p.lift)}</td>
                <td style={{ textAlign: "right", color: COLOR.textStrong }}>
                  {fmtNum(p.load_kg)}kg
                  {p.delta_from_last_week_pct != null && (
                    <span style={{
                      color: p.delta_from_last_week_pct > 0 ? "#16a34a" : p.delta_from_last_week_pct < 0 ? "#dc2626" : COLOR.textMuted,
                      fontSize: 9, marginLeft: 4,
                    }}>
                      ({p.delta_from_last_week_pct > 0 ? "+" : ""}{fmtNum(p.delta_from_last_week_pct * 100)}%)
                    </span>
                  )}
                </td>
                <td style={{ textAlign: "right", color: COLOR.textMuted }}>{p.sets}×{p.reps}</td>
                <td style={{ textAlign: "right", color: COLOR.textMuted }}>
                  {p.rir_target != null ? p.rir_target : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {plan.volume_summary.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: COLOR.textMuted }}>
            <strong style={{ color: COLOR.textStrong }}>Volume targets:</strong>{" "}
            {plan.volume_summary.map((v) => `${v.muscle} ${v.sets} (${v.tier})`).join(" · ")}
          </div>
        )}
        {plan.weekly_focus && (
          <div style={{ marginTop: 6, fontSize: 11, color: COLOR.textMuted, fontStyle: "italic" }}>
            Focus: {plan.weekly_focus}
          </div>
        )}
      </Card>
    );
  }
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add components/morning/BriefThisWeekPlan.tsx
  git commit -m "feat(brief): BriefThisWeekPlan kickoff block component"
  ```

### Task 3.2: Create BriefYesterdayVsPlan component

**Files:**
- Create: `components/morning/BriefYesterdayVsPlan.tsx`

- [ ] **Step 1: Write the component**

  Create `components/morning/BriefYesterdayVsPlan.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { YesterdayVsPlanBlock } from "@/lib/data/types";

  function shortLift(name: string): string {
    return name.replace(/\s*\([^)]+\)/, "");
  }

  export function BriefYesterdayVsPlan({ block }: { block: YesterdayVsPlanBlock }) {
    return (
      <Card>
        <SectionLabel>
          YESTERDAY VS PLAN
          {block.swap_applied ? " · SWAPPED" : ""}
        </SectionLabel>
        {!block.session_logged && (
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 6, fontStyle: "italic" }}>
            No session logged yesterday.
          </div>
        )}
        {block.session_logged && block.per_lift.length === 0 && (
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 6 }}>
            No big-four lifts in yesterday's session.
          </div>
        )}
        {block.session_logged && block.per_lift.length > 0 && (
          <table style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-dm-mono), monospace", marginTop: 8, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: COLOR.textFaint, fontSize: 9 }}>
                <th style={{ textAlign: "left" }}>LIFT</th>
                <th style={{ textAlign: "right" }}>PLAN</th>
                <th style={{ textAlign: "right" }}>ACTUAL</th>
                <th style={{ textAlign: "right" }}>REPS %</th>
              </tr>
            </thead>
            <tbody>
              {block.per_lift.map((p) => {
                const planned = `${fmtNum(p.planned.load_kg)}×${p.planned.sets}×${p.planned.reps}`;
                const actual = p.actual
                  ? `${fmtNum(p.actual.top_set_load_kg ?? 0)}×${p.actual.sets_done}`
                  : "—";
                const repsPct = p.reps_completed_pct != null
                  ? `${Math.round(p.reps_completed_pct * 100)}%`
                  : "—";
                const repsColor = p.reps_completed_pct == null
                  ? COLOR.textMuted
                  : p.reps_completed_pct >= 0.9 ? "#16a34a"
                  : p.reps_completed_pct >= 0.75 ? COLOR.textStrong
                  : "#dc2626";
                return (
                  <tr key={p.lift}>
                    <td style={{ color: COLOR.textStrong, padding: "2px 0" }}>{shortLift(p.lift)}</td>
                    <td style={{ textAlign: "right", color: COLOR.textMuted }}>{planned}</td>
                    <td style={{ textAlign: "right", color: COLOR.textStrong }}>{actual}</td>
                    <td style={{ textAlign: "right", color: repsColor }}>{repsPct}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add components/morning/BriefYesterdayVsPlan.tsx
  git commit -m "feat(brief): BriefYesterdayVsPlan analytical block component"
  ```

### Task 3.3: Extend BriefSessionList with per-lift load + RIR inline

**Files:**
- Modify: `components/morning/BriefSessionList.tsx`

- [ ] **Step 1: Inspect current shape**

  ```bash
  cat components/morning/BriefSessionList.tsx
  ```

  Note: the component already renders exercise names. The extension is to show prescribed `load_kg` and `rir_target` inline for the big-four lifts when the data is available.

- [ ] **Step 2: Add big-four load + RIR inline display**

  Find the loop that renders exercise list items. For each item, after the exercise name, if the exercise is one of the big-four AND `card.this_week_plan` has a matching entry, render the load + RIR:

  ```tsx
  // At the top of BriefSessionList:
  import type { MorningBriefCard } from "@/lib/data/types";

  const BIG_FOUR_NAMES = new Set([
    "Squat (Barbell)",
    "Deadlift (Barbell)",
    "Decline Bench Press (Barbell)",
    "Overhead Press (Barbell)",
  ]);

  // Inside the existing component, accept the full card so we can pull
  // this_week_plan if present:
  export function BriefSessionList({
    session,
    thisWeekPlan,
  }: {
    session: MorningBriefCard["session"];
    thisWeekPlan?: MorningBriefCard["this_week_plan"];
  }) {
    // ... existing exercise list rendering ...
    // For each exercise:
    {session.exercises.map((ex) => {
      const planEntry = thisWeekPlan?.per_lift.find((p) => p.lift === ex.name);
      const showPrescription = BIG_FOUR_NAMES.has(ex.name) && planEntry != null;
      return (
        <li key={ex.name}>
          <span>{ex.name}</span>
          {showPrescription && planEntry && (
            <span style={{ marginLeft: 8, color: COLOR.textMuted, fontSize: 11, fontFamily: "var(--font-dm-mono), monospace" }}>
              {planEntry.load_kg}kg × {planEntry.sets} × {planEntry.reps}
              {planEntry.rir_target != null && ` · RIR ${planEntry.rir_target}`}
            </span>
          )}
        </li>
      );
    })}
  ```

  **Adapt to the actual current JSX structure.** Read the existing file end-to-end and integrate the prescription display inline with the existing item rendering — don't replace, augment.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add components/morning/BriefSessionList.tsx
  git commit -m "feat(brief): BriefSessionList shows per-lift load + RIR for big-four"
  ```

### Task 3.4: Wire dispatcher in MorningBriefCard

**Files:**
- Modify: `components/morning/MorningBriefCard.tsx`

- [ ] **Step 1: Inspect dispatcher pattern**

  ```bash
  cat components/morning/MorningBriefCard.tsx
  ```

- [ ] **Step 2: Render the new blocks conditionally**

  Find the JSX. Above the existing `BriefAdvice` rendering (or wherever the structured blocks sit), add:

  ```tsx
  import { BriefThisWeekPlan } from "@/components/morning/BriefThisWeekPlan";
  import { BriefYesterdayVsPlan } from "@/components/morning/BriefYesterdayVsPlan";

  // Inside the render, after BriefRecapStats and before BriefAdvice:
  {card.variant === "kickoff" && card.this_week_plan && (
    <BriefThisWeekPlan plan={card.this_week_plan} />
  )}
  {card.variant === "analytical" && card.yesterday_vs_plan && (
    <BriefYesterdayVsPlan block={card.yesterday_vs_plan} />
  )}
  ```

  Also pass `thisWeekPlan` to `BriefSessionList`:

  ```tsx
  <BriefSessionList
    session={card.session}
    thisWeekPlan={card.this_week_plan}
  />
  ```

  Adapt to the actual existing JSX. The dispatcher should ONLY add new conditional blocks; existing structure unchanged.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add components/morning/MorningBriefCard.tsx
  git commit -m "feat(brief): MorningBriefCard dispatches kickoff + analytical blocks"
  ```

### Task 3.5: Manual end-to-end exercise

- [ ] **Step 1: Start dev server**

  ```bash
  npm run dev
  ```

- [ ] **Step 2: Trigger a Monday-variant brief**

  The fixture has block dates 2026-05-04 → 2026-06-07. Today is 2026-05-15 (Friday). To trigger a Monday-flavored brief, you have two options:

  **Option A — visit /coach in the browser and trigger morning intake** (recommended): on the dev fixture's Monday-equivalent (any day that falls within the active block), open the morning intake bot via the dashboard. Complete the intake. The brief that fires at the end will be `analytical` because today is Friday — not Monday. To force a `kickoff` variant for visual verification:

  **Option B — directly invoke the brief generation against a Monday date.** Add a tiny dev-only script that calls the orchestrator with `today: "2026-05-11"` (Monday in the fixture window):

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  // Direct invocation requires importing the orchestrator and supabase service-role client.
  // See lib/morning/brief/index.ts for the entrypoint.
  // Run a regenerate against today's brief via the existing regenerate_morning_brief
  // tool path — this fires the latest pipeline. For Monday-variant testing, set
  // checkins.brief_state back to 'awaiting_brief' for a row dated 2026-05-11 and
  // trigger via the morning intake bot."
  ```

  **Simplest approach:** verify the analytical variant first by triggering a Tue-Sat brief (today's actual day works). Then mentally validate the kickoff layout by visually inspecting `BriefThisWeekPlan.tsx` against the spec's mockup — the kickoff path will fire naturally next Monday when the cron runs.

- [ ] **Step 3: Visit /coach and find the latest brief**

  Open `http://localhost:3000/coach`. The most recent `morning_brief` chat card should render. If today's brief was generated post-Slice-3, it should include:
  - `BriefYesterdayVsPlan` block (because today is Friday, an analytical day)
  - `BriefSessionList` with per-lift load + RIR for big-four lifts
  - Advice prose that references yesterday's per-lift performance + today's specific loads

  If the brief is from before this slice (variant: 'training' or 'rest'), trigger a fresh one via:
  - Tap "Regenerate" if the brief offers it, OR
  - Update `checkins.brief_state` to `'awaiting_brief'` for today's checkin row and re-trigger the morning intake bot.

- [ ] **Step 4: Stop dev server**

  ```bash
  pkill -f "next dev"
  ```

### Task 3.6: Commit + open Slice 3 PR

- [ ] **Step 1: Push and PR**

  ```bash
  git push
  gh pr create --title "feat(brief): daily coach loop — UI components + dispatcher (Slice 3/3)" \
    --body "Two new section components (BriefThisWeekPlan, BriefYesterdayVsPlan) + BriefSessionList extension showing per-lift load + RIR for big-four lifts + MorningBriefCard dispatcher wiring. Manual exercise verified the analytical variant fires on Tue-Sat. Kickoff variant will fire next Monday when the cron runs."
  ```

  If Slices 1-3 are stacking on the same branch, just push and update the existing PR's title via `gh pr edit`:

  ```bash
  gh pr edit <PR-number> --title "feat(brief): daily coach loop (Slices 1-3/3)"
  ```

---

## Self-Review

After Slice 3 merges, run the spec self-review:

- [ ] Re-read [docs/superpowers/specs/2026-05-15-daily-coach-loop-design.md](../specs/2026-05-15-daily-coach-loop-design.md) — every Goal (1-8) has a corresponding task.
- [ ] Walk the full flow on real data: open /coach, find today's brief. If today is a training day, verify `BriefYesterdayVsPlan` renders with planned vs actual per-lift table. Advice prose should reference yesterday's reps and today's specific loads. Teacher tone: pick a brief where MEV/MAV is mentioned and verify the model defined it in plain English on first use.
- [ ] On the upcoming Monday after merge, verify the kickoff variant fires correctly with `BriefThisWeekPlan` rendered. Phase-explainer should appear if `phase_transition_this_week` is true.
- [ ] Confirm no orphan files and no leftover `TODO` comments in shipped code.
- [ ] Update [CLAUDE.md](../../../CLAUDE.md) with a one-line entry under the morning brief architecture section noting the new variants + retrofit to the weekly review narrative prompt.

When all three slices are merged and verified, sub-project #2 is done. Move on to sub-project #3 (Coach Tab UX shell + tool-discovery) via fresh spec → plan → implement cycle.
