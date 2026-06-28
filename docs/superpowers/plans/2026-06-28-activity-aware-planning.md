# Activity-Aware Planning & Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the weekly plan aware of self-directed activities (padel/running/cycling) — proactively sequencing the strength week around them and reactively adapting by feel — via one shared activity load-profile model.

**Architecture:** A new pure `lib/coach/activity/` module models each activity as fixed regions + intensity-scaled magnitude/recovery-window. A normalized read merges three capture sources (recurring profile pattern, per-week manual, auto-detected from Strava/WHOOP). Proactive: a pure planner detects conflicts and emits a layout proposal (applied via the existing swap engine) + per-day lighten flags (consumed by `prescribeWeek`). Reactive: a pure rung-selector replaces the morning brief's all-or-nothing suggestion with a graded ladder (load→volume→exercise-swap→day-swap), threaded into `annotateSession` and logged as `coach_interventions`. Everything is additive and degrades to today's behavior when no activities/soreness exist.

**Tech Stack:** TypeScript (strict), Zod, vitest (node env), Supabase, Next.js. No new AI calls.

## Global Constraints

- Pure functions for all model/planner/selector logic (no Supabase inside them); the orchestrators (`prescribeWeek`, brief assembler, the new read helper) do I/O and pass data in. Mirrors `lib/coach/intelligence/` + `lib/coach/plan-builder/`.
- **Graceful degradation is load-bearing:** with NO planned activities AND no soreness, the Sunday plan + morning brief produce output **byte-identical to today**. Unknown activity type → neutral profile → no action. Strava/WHOOP absent → declared intensity + soreness only. Nothing here can block plan generation or the brief. A regression test enforces this.
- Magnitude is intensity-driven — never hardcode an activity as high-cost; regions are the only fixed part.
- Timezone: no raw `new Date().toISOString().slice(0,10)` / `.getHours()`; use `getUserTimezone`/`todayInUserTz`/`nowInUserTz`. `node scripts/audit-timezone-usage.mjs` is a gate.
- Reuse, don't rebuild: `prescribeWeek`, `/api/training-weeks/[week_start]/swap`, `pickCoachSuggestion`, `annotateSession`, `get_substitutes`/exercise-library, recovery-intelligence subjective series, the `coach_interventions` table + #3-#1 evaluator.
- Keep existing suites green (374 tests at branch start); typecheck clean.
- Migrations via `supabase db query --linked -f` (CLI `db push` is blocked by a pre-existing duplicate 0026 prefix). Next number is **0044**.
- Commits per task: `feat: activity: <thing>` / `test: ...`. Watch worktree-stranding — commits land on the feature branch.

---

## File Structure

**New:**
- `lib/coach/activity/model.ts` — pure: regions, intensity→recovery-window, `regionOverlap`
- `lib/coach/activity/types.ts` — `ActivityType`, `ActivityIntensity`, `PlannedActivity`, `RecurringActivity`, region enums
- `lib/coach/activity/read-planned.ts` — normalized merge of recurring + per-week + auto-detected
- `lib/coach/activity/sequence-week.ts` — pure proactive planner (`proposeActivityAwareLayout`)
- `lib/coach/activity/reactive-ladder.ts` — pure `selectReactiveRung`
- `lib/coach/activity/__tests__/*.test.ts` (model, read-planned, sequence-week, reactive-ladder, graceful-degradation)
- `supabase/migrations/0044_activity_aware.sql`
- `components/activity/WeekActivityStrip.tsx` + `components/profile/RecurringActivitySection.tsx` + `app/api/training-weeks/[week_start]/activities/route.ts` + `app/api/profile/recurring-activities/route.ts`

**Modified:**
- `lib/data/types.ts` — `TrainingWeek.planned_activities`, `Profile.recurring_activities`, new suggestion kinds
- `lib/coach/prescription/prescribe-week.ts` — read lighten flags, trim overlapping-region volume
- `lib/morning/brief/assembler.ts` — `pickCoachSuggestion` graded ladder
- `lib/coach/session-structure/annotate.ts` — optional sore-region context
- the weekly-review / Sunday propose flow — surface the layout proposal

---

## PHASE 1 — Foundation

### Task 1: Activity Load-Profile Model (pure)

**Files:**
- Create: `lib/coach/activity/types.ts`, `lib/coach/activity/model.ts`
- Test: `lib/coach/activity/__tests__/model.test.ts`

**Interfaces:**
- Produces: `activityRegions(type): MuscleRegion[]`; `recoveryWindowHours(type, intensity): number`; `regionOverlap(a: MuscleRegion[], b: MuscleRegion[]): MuscleRegion[]`; types `ActivityType`, `ActivityIntensity`, `MuscleRegion`.

- [ ] **Step 1: Types** — create `lib/coach/activity/types.ts`:

```typescript
import { z } from "zod";

export const MUSCLE_REGIONS = ["legs", "lower_back", "shoulders", "chest", "back", "arms", "core"] as const;
export const MuscleRegionSchema = z.enum(MUSCLE_REGIONS);
export type MuscleRegion = z.infer<typeof MuscleRegionSchema>;

export const ACTIVITY_TYPES = ["padel", "running", "cycling", "swimming", "other"] as const;
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const ActivityIntensitySchema = z.enum(["light", "moderate", "hard"]);
export type ActivityIntensity = z.infer<typeof ActivityIntensitySchema>;

export const ActivitySourceSchema = z.enum(["recurring", "manual", "detected"]);

export const PlannedActivitySchema = z.object({
  date: z.string(),                       // YYYY-MM-DD
  type: ActivityTypeSchema,
  intensity_estimate: ActivityIntensitySchema,
  source: ActivitySourceSchema,
});
export type PlannedActivity = z.infer<typeof PlannedActivitySchema>;

export const RecurringActivitySchema = z.object({
  type: ActivityTypeSchema,
  weekdays: z.array(z.number().int().min(0).max(6)),  // 0=Sun..6=Sat
  typical_intensity: ActivityIntensitySchema,
});
export type RecurringActivity = z.infer<typeof RecurringActivitySchema>;
```

- [ ] **Step 2: Failing tests** — `model.test.ts`: padel regions === [legs, lower_back, shoulders]; cycling === [legs]; unknown/"other" → []; `recoveryWindowHours("padel","light")` small (≤24) and `("padel","hard")` large (≥36) and hard>light for every type; `recoveryWindowHours("cycling","hard") < recoveryWindowHours("running","hard")` (cycling recovers faster); `regionOverlap(["legs","lower_back"],["legs"])` === ["legs"]; no overlap → [].

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Implement `model.ts`:**

```typescript
import type { ActivityType, ActivityIntensity, MuscleRegion } from "./types";

const REGIONS: Record<ActivityType, MuscleRegion[]> = {
  padel: ["legs", "lower_back", "shoulders"],
  running: ["legs"],
  cycling: ["legs"],
  swimming: ["back", "shoulders"],
  other: [],
};

// Eccentric/impact factor scales the recovery window. Cycling is low-damage even
// when hard; running/padel carry eccentric+impact so they cost more per intensity.
const DAMAGE_FACTOR: Record<ActivityType, number> = {
  padel: 1.0, running: 1.0, cycling: 0.5, swimming: 0.6, other: 0.6,
};
const INTENSITY_BASE_HOURS: Record<ActivityIntensity, number> = { light: 14, moderate: 28, hard: 44 };

export function activityRegions(type: ActivityType): MuscleRegion[] {
  return REGIONS[type] ?? [];
}

export function recoveryWindowHours(type: ActivityType, intensity: ActivityIntensity): number {
  const base = INTENSITY_BASE_HOURS[intensity];
  return Math.round(base * (DAMAGE_FACTOR[type] ?? 0.6));
}

export function regionOverlap(a: MuscleRegion[], b: MuscleRegion[]): MuscleRegion[] {
  const set = new Set(b);
  return a.filter((r) => set.has(r));
}
```

- [ ] **Step 5: Run → pass; typecheck.**
- [ ] **Step 6: Commit** `feat: activity: load-profile model (regions + intensity-scaled recovery + overlap)`

---

### Task 2: Migration + Row Types

**Files:**
- Create: `supabase/migrations/0044_activity_aware.sql`
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Migration** — `0044_activity_aware.sql`:

```sql
-- 0044_activity_aware.sql — activity-aware planning.
alter table public.training_weeks
  add column if not exists planned_activities jsonb not null default '[]'::jsonb;
alter table public.profiles
  add column if not exists recurring_activities jsonb not null default '[]'::jsonb;
```

- [ ] **Step 2: Apply** — `supabase db query --linked -f supabase/migrations/0044_activity_aware.sql --agent=no`; verify both columns exist via an information_schema query.

- [ ] **Step 3: Row types** — in `lib/data/types.ts`: add `planned_activities: PlannedActivity[]` to `TrainingWeek`, `recurring_activities: RecurringActivity[]` to `Profile` (import the types from `@/lib/coach/activity/types`). Add the new morning-brief suggestion kinds to the `MorningBriefCoachSuggestion` union: `"load_down"`, `"volume_down"`, `"swap_exercise"` (alongside the existing `swap_to_mobility`/`reduce_intensity`).

- [ ] **Step 4: Typecheck; commit** `feat: activity: migration 0044 + planned_activities/recurring_activities row types`

---

## PHASE 2 — Capture

### Task 3: Normalized Read Helper (pure core + thin I/O)

**Files:**
- Create: `lib/coach/activity/read-planned.ts`
- Test: `lib/coach/activity/__tests__/read-planned.test.ts`

**Interfaces:**
- Produces: pure `mergePlannedActivities(args): PlannedActivity[]` where `args = { weekStartIso, declared: PlannedActivity[], recurring: RecurringActivity[], detected: PlannedActivity[] }` — materializes recurring into the week's dates, concatenates manual, merges detected (declared wins on same date+type; detected fills gaps). Plus thin `loadPlannedActivities(supabase, userId, week, todayIso): Promise<PlannedActivity[]>` that gathers the three sources (declared from `week.planned_activities`, recurring from profile, detected from `endurance_activities` + WHOOP strain spikes) and calls the pure merge.

- [ ] **Step 1: Failing tests** for `mergePlannedActivities`: recurring `{type:padel, weekdays:[2,4]}` over a Mon-start week → padel on that week's Tue + Thu with `source:"recurring"`; a manual item on Tue padel overrides the recurring one (declared wins, no dupe); a detected cycling on Wed with no declared → included as `source:"detected"`; detected duplicate of a declared item (same date+type) → dropped. Empty everything → [].

- [ ] **Step 2: Run → fail; implement the pure merge; run → pass.** (Detection mapping from `endurance_activities`: `sport` → ActivityType via the existing mapSport-style mapping, intensity from TSS buckets — light/moderate/hard thresholds documented inline; a WHOOP strain spike with no Strava activity → `type:"other"`, intensity from strain magnitude.)

- [ ] **Step 3: Implement `loadPlannedActivities`** (thin I/O: read profile.recurring_activities + week.planned_activities + endurance_activities for the week + daily_logs.strain; call merge). Guard each read so failure → that source empty (graceful).

- [ ] **Step 4: Typecheck; commit** `feat: activity: normalized planned-activities read (recurring + manual + detected merge)`

### Task 4: Capture UI + APIs

**Files:**
- Create: `app/api/training-weeks/[week_start]/activities/route.ts` (write per-week `planned_activities`), `app/api/profile/recurring-activities/route.ts` (write `profiles.recurring_activities`), `components/activity/WeekActivityStrip.tsx`, `components/profile/RecurringActivitySection.tsx`

- [ ] **Step 1:** APIs — session-auth (RLS), Zod-validate against `PlannedActivitySchema[]` / `RecurringActivitySchema[]`, upsert the jsonb. Mirror an existing simple profile/training-week write route.
- [ ] **Step 2:** `RecurringActivitySection` on `/profile` — add/remove recurring items (type + weekday chips + intensity). `WeekActivityStrip` on the week/strength view — quick-add a per-week activity (type + date + intensity chips), list this week's items, delete.
- [ ] **Step 3:** Verify typecheck + `npm run build` compiles; manual visual is the user's. Commit `feat: activity: capture UI + APIs (recurring on /profile, per-week strip)`.

---

## PHASE 3 — Proactive sequencing (#3-B)

### Task 5: Proactive Planner (pure)

**Files:**
- Create: `lib/coach/activity/sequence-week.ts`
- Test: `lib/coach/activity/__tests__/sequence-week.test.ts`

**Interfaces:**
- Produces: `proposeActivityAwareLayout(args): { proposedPlan: SessionPlan; lightenDays: Record<string, MuscleRegion[]>; flags: ActivityConflictFlag[] }` where `args = { sessionPlan, plannedActivities, daysAvailable, block, today }`. `proposedPlan` is the rearranged day→session-type map (=== input when no move possible/needed); `lightenDays` maps a weekday to the overlapping regions to trim; `flags` are unresolved conflicts (Accept/Override).

- [ ] **Step 1: Failing tests** (fixtures: a session_plan, planned activities, days_available):
  - Padel(hard) Tue + heavy Legs Mon, Wed free → planner MOVES Legs to a day outside padel's recovery window; `proposedPlan` differs, `lightenDays` empty, no flag.
  - Padel(hard) Tue + Legs Mon, no free day to move → `proposedPlan` unchanged, `lightenDays` has Monday→[legs] (lighten), no flag.
  - Padel(hard) Tue + Legs Mon AND Wed (unavoidable adjacency) → a `flag`.
  - Padel(light) Tue + Legs Mon → minimal/no action (magnitude-gated: ~14h window doesn't reach Monday's session).
  - Cycling(hard) Tue + Legs Wed → low damage factor → likely no conflict (window short).
  - Priority leg-block + padel(hard) → stronger separation / strategic flag.
  - No activities → `proposedPlan === sessionPlan`, lightenDays empty, flags empty (graceful).
  Conflict detection checks BOTH directions (day before + after) within `recoveryWindowHours`.

- [ ] **Step 2: Run → fail; implement; run → pass.** Resolution ladder: move (if `daysAvailable` permits and a non-conflicting slot exists) → else lighten → else flag. Magnitude via `recoveryWindowHours`; priority via `block.primary_lift` region. Sort/iterate deterministically.

- [ ] **Step 3: Typecheck; commit** `feat: activity: proactive week-sequencing planner (move/lighten/flag, magnitude+priority gated)`

### Task 6: Wire Proactive into prescribeWeek + propose-then-confirm

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts`, the Sunday/weekly-review propose flow, the swap engine call path

- [ ] **Step 1:** `prescribeWeek` reads `loadPlannedActivities` + calls `proposeActivityAwareLayout`; applies `lightenDays` by trimming sets/reps on exercises whose region is in the lighten set (reuse the existing volume-trim path; default no-op when empty). Graceful: no activities → `lightenDays` empty → today's prescriptions byte-identical.
- [ ] **Step 2:** Surface the `proposedPlan` + `flags` as a **propose-then-confirm** in the Sunday plan / weekly review (reuse the weekly-review commit + `/api/training-weeks/[week_start]/swap` to apply the layout on Approve). Rationale strings ("Moved Legs → Thursday — padel Tue + Fri"). Flags use the #3-A Accept/Override chip.
- [ ] **Step 3:** Verify: `npx vitest run lib/` all green; typecheck; tz audit; build. Commit `feat: activity: wire proactive layout proposal + lighten flags into prescribeWeek + weekly propose`

---

## PHASE 4 — Reactive ladder (#3-C)

### Task 7: Reactive Rung Selector (pure)

**Files:**
- Create: `lib/coach/activity/reactive-ladder.ts`
- Test: `lib/coach/activity/__tests__/reactive-ladder.test.ts`

**Interfaces:**
- Produces: `selectReactiveRung(args): { rung: "none"|"load_down"|"volume_down"|"swap_exercise"|"swap_day"; regions: MuscleRegion[]; rationale: string }` where `args = { sessionRegions, soreRegions, soreSeverity: "mild"|"sharp"|null, fatigue, recentActivity: { regions, intensity, withinRecoveryWindow }[] }`.

- [ ] **Step 1: Failing tests:** mild soreness overlap → `load_down`; moderate (some fatigue + overlap, or moderate recent activity in window) → `volume_down`; high (sharp soreness on a non-primary overlapping region, or hard activity still in window) → `swap_exercise` with the sore regions; severe (sharp soreness on today's primary region, OR hard activity inside window overlapping the day) → `swap_day`; no overlap / no soreness / no recent activity → `none`. Scaled by severity×intensity (light recent activity + mild soreness stays low rung; hard match + sharp → swap_day).

- [ ] **Step 2: Run → fail; implement; run → pass.** Deterministic thresholds documented inline.

- [ ] **Step 3: Typecheck; commit** `feat: activity: reactive autoregulation rung selector (load→volume→swap-exercise→swap-day)`

### Task 8: Replace pickCoachSuggestion top-rung + thread into annotateSession

**Files:**
- Modify: `lib/morning/brief/assembler.ts` (`pickCoachSuggestion`), `lib/coach/session-structure/annotate.ts`

- [ ] **Step 1:** Extend `pickCoachSuggestion` args with `recentActivity` (from `loadPlannedActivities` + the model) and call `selectReactiveRung`; map its rung to the suggestion kinds (`load_down`/`volume_down`/`swap_exercise`/`swap_to_mobility` for swap_day). PRESERVE existing fallbacks (low band, recovery crash). Graceful: no soreness + no recent activity → same suggestion as today.
- [ ] **Step 2:** `annotateSession(exercises, context?)` gains an OPTIONAL `context?: { soreRegions: MuscleRegion[]; rung }`; when present, reflect reduced targets / a cue on overlapping exercises. Optional → today's stateless behavior preserved when absent. For `swap_exercise`, reuse `get_substitutes` excluding the sore region.
- [ ] **Step 3:** Verify all suites green; typecheck; build. Commit `feat: activity: graded reactive ladder in morning brief + soreness-aware session annotation`

### Task 9: Log reactive adjustments as interventions

**Files:**
- Modify: the brief/swap path that applies a reactive adjustment

- [ ] **Step 1:** When the athlete accepts a reactive adjustment (load_down/volume_down/swap_exercise/swap_day), insert a `coach_interventions` row (kind `exercise_swap` for swaps; reuse the existing best-effort `recordIntervention` helper) so the #3-#1 evaluator measures whether it resolved the soreness. Best-effort: failure never breaks the brief.
- [ ] **Step 2:** Verify suites green; typecheck. Commit `feat: activity: log reactive adjustments as interventions for responsiveness evaluation`

---

## PHASE 5 — Regression + final

### Task 10: Graceful-Degradation Regression + Final Verification

**Files:**
- Create: `lib/coach/activity/__tests__/graceful-degradation.test.ts`

- [ ] **Step 1:** Regression test proving the load-bearing rule via the pure functions: `proposeActivityAwareLayout` with `plannedActivities: []` → `proposedPlan === sessionPlan` (reference-equal), `lightenDays` empty, `flags` empty; `selectReactiveRung` with no soreness + no recent activity → `rung: "none"`; `mergePlannedActivities` with all sources empty → []. Assert no activities + no soreness ⇒ planner/ladder produce no-op outputs.
- [ ] **Step 2: Final gates:** `npm run typecheck`; `npx vitest run lib/` (report total); `node scripts/audit-timezone-usage.mjs`; `npm run build`.
- [ ] **Step 3: Commit** `test: activity: graceful-degradation regression (no activities/soreness = today's output)`

---

## Specification Coverage Checklist

- [x] Activity model (regions fixed + intensity→recovery, overlap) → Task 1
- [x] planned_activities + recurring pattern storage (migration) → Task 2
- [x] Three-source normalized capture (recurring + manual + detected) → Tasks 3, 4
- [x] Proactive: conflict-detect both directions, move/lighten/flag, magnitude + priority gated, propose-then-confirm → Tasks 5, 6
- [x] Reactive: graded ladder by severity×intensity, threads into annotateSession → Tasks 7, 8
- [x] Reactive adjustments feed #3-#1 responsiveness memory → Task 9
- [x] Graceful degradation byte-identical when absent → every task's defaults + Task 10 regression
- [x] No new AI calls; pure + fixture-tested; timezone-safe; reuse existing engines → all tasks

## Notes for Execution

- Phases sequential (1→2→3→4→5); within a phase, pure-module tasks precede their wiring task.
- "Move" = session_plan change (swap engine); "lighten" = within-day volume trim (prescribeWeek). Don't conflate.
- Reuse the listed engines; do not duplicate. Do NOT edit `lib/coach/intelligence/` or `lib/coach/interventions/` except to CALL `recordIntervention` (Task 9).
- UI/capture (Task 4) + the propose-confirm (Task 6) verify by build-compile + the user's manual browser check; the pure logic carries the test weight.
