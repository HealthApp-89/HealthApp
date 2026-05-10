# Athlete Profile Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a durable, versioned, user-acknowledged Athlete Profile (medical, training history, equipment, lifestyle, nutrition baseline, sleep baseline, goal-with-why) via a 6-step `/onboarding` form wizard, surface it in `/profile` with version history, and inject a condensed summary into the coach AI's snapshot prefix so default-mode replies naturally reference athlete context.

**Architecture:** One new table (`athlete_profile_documents`) with full forward-compatible schema (Phase 2's `plan_payload` and `rendered_md` columns nullable from day 1). New `/onboarding` route hosts a 6-step wizard; submit creates a draft row, the user reviews/edits the deterministically-rendered markdown, then acknowledges. Acknowledgment is a single transaction that flips draft → active and supersedes the prior active row. The coach reads the active doc via the cached snapshot prefix; no changes to chat modes or tools in Phase 1.

**Tech Stack:** Next.js 15 App Router, Supabase (RLS-respecting server client, service-role NOT needed in Phase 1), TanStack Query for client cache, Zod for runtime validation, no new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-10-athlete-profile-phase-1-design.md](../specs/2026-05-10-athlete-profile-phase-1-design.md)

**Verification posture:** This codebase has no test runner (`npm run lint` is unconfigured per CLAUDE.md). Each task ends with `npm run typecheck` plus targeted manual checks. Pure functions in `lib/coach/profile-renderer.ts` and `lib/validation/intakePayload.ts` are exercised via one-shot probe scripts (`scripts/probe-*.mjs`) that print known-input/known-output pairs for visual confirmation; these scripts are deleted after verification (not committed) since the codebase doesn't have a tests directory.

**Migration number:** `0010_athlete_profile.sql` — locked in spec at 2026-05-10 after the health-tab merge claimed `0009_body_measurements.sql`.

**Branching:** Implementer creates `feat/athlete-profile-phase-1` from `main`; commits land there per task. The spec + plan PR (this docs branch) merges separately to main beforehand.

---

## File Structure

**New files (24):**
- `supabase/migrations/0010_athlete_profile.sql` — schema (table + indexes + RLS)
- `lib/validation/intakePayload.ts` — Zod schema + parser
- `lib/coach/profile-renderer.ts` — `renderProfileMarkdown` + `renderProfileSummary` (pure)
- `lib/query/fetchers/athleteProfile.ts` — server + browser variants for active / history / draft reads
- `lib/query/fetchers/recentE1RMs.ts` — server + browser variants for the wizard pre-fill
- `lib/query/hooks/useAthleteProfile.ts` — TanStack hook for active doc
- `lib/query/hooks/useAthleteProfileHistory.ts` — TanStack hook for superseded versions
- `lib/query/hooks/useAthleteProfileDraft.ts` — TanStack hook for the user's current draft
- `lib/query/hooks/useRecentE1RMs.ts` — TanStack hook for pre-fill
- `app/onboarding/page.tsx` — Server Component (auth gate + revise pre-fill)
- `app/onboarding/loading.tsx` — Loading skeleton
- `app/onboarding/actions.ts` — Server actions (create / update / acknowledge / discard)
- `components/onboarding/OnboardingWizard.tsx` — Step orchestrator
- `components/onboarding/StepHealth.tsx` — Step 1
- `components/onboarding/StepTraining.tsx` — Step 2
- `components/onboarding/StepLifestyle.tsx` — Step 3
- `components/onboarding/StepNutrition.tsx` — Step 4
- `components/onboarding/StepSleep.tsx` — Step 5
- `components/onboarding/StepGoals.tsx` — Step 6
- `components/onboarding/ReviewAndAcknowledge.tsx` — Final review screen with inline edit
- `components/onboarding/WizardNav.tsx` — Back/Next buttons + step indicator (shared)
- `components/profile/AthleteProfilePanel.tsx` — Active card + CTA + revise/view/history triggers
- `components/profile/AthleteProfileViewModal.tsx` — Modal showing frozen `rendered_md`
- `components/profile/AthleteProfileHistory.tsx` — Collapsible list of superseded versions

**Modified files (5):**
- `lib/data/types.ts` — add `AthleteProfileDocument`, `AthleteProfileStatus`, `IntakePayload` types
- `lib/query/keys.ts` — add `athleteProfile` key factory
- `lib/coach/snapshot.ts` — append athlete-profile section to `body` when active doc exists
- `lib/coach/system-prompts.ts` — extend `SCHEMA_EXPLAINER` + `DEFAULT_SYSTEM_PROMPT`
- `app/profile/page.tsx` — prefetch active + history + draft
- `components/profile/ProfileClient.tsx` — render `AthleteProfilePanel` between "Profile details" and "Connected sources"
- `CLAUDE.md` — add migration 0010 entry to the Database migrations list

**Env additions:** none.

---

## Task index (18 tasks)

- Task 1: DB migration + CLAUDE.md entry
- Task 2: TypeScript types — `IntakePayload`, `AthleteProfileDocument`, `AthleteProfileStatus`
- Task 3: Zod validation schema for `IntakePayload`
- Task 4: Profile renderer (markdown + summary)
- Task 5: Query keys for `athleteProfile`
- Task 6: Server + browser fetchers (active / history / draft)
- Task 7: Client hooks (active / history / draft)
- Task 8: Pre-fill — `useRecentE1RMs` fetcher + hook
- Task 9: Server actions (create / update / acknowledge / discard)
- Task 10: WizardNav + OnboardingWizard scaffolding + StepHealth (exemplar)
- Task 11: StepTraining + StepLifestyle
- Task 12: StepNutrition + StepSleep
- Task 13: StepGoals
- Task 14: ReviewAndAcknowledge with inline edit
- Task 15: `/onboarding` route (page + loading)
- Task 16: AthleteProfilePanel + ViewModal + History
- Task 17: `/profile` page integration
- Task 18: Snapshot integration + system prompt updates + end-to-end verification

---

### Task 1: DB migration — `0010_athlete_profile.sql`

**Files:**
- Create: `supabase/migrations/0010_athlete_profile.sql`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/0010_athlete_profile.sql`:

```sql
-- 0010_athlete_profile.sql — athlete profile phase 1
--
-- One new table (athlete_profile_documents). Captures a durable, versioned,
-- user-acknowledged athlete profile (medical, training history, equipment,
-- lifestyle, nutrition baseline, sleep baseline, goal-with-why). Phase 1
-- writes intake_payload + rendered_md only; plan_payload is reserved-null
-- and populated by Phase 2 when AI plan generation lands.

create table if not exists public.athlete_profile_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  version         int not null,
  status          text not null default 'draft'
    check (status in ('draft', 'active', 'superseded', 'discarded')),
  intake_payload  jsonb not null,
  plan_payload    jsonb,
  rendered_md     text,
  acknowledged_at timestamptz,
  superseded_at   timestamptz,
  superseded_by   uuid references public.athlete_profile_documents on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check ((status = 'draft') = (acknowledged_at is null)),
  check ((status = 'superseded') = (superseded_at is not null)),
  unique (user_id, version)
);

-- At most one active per user
create unique index if not exists athlete_profile_documents_one_active_per_user
  on public.athlete_profile_documents (user_id) where status = 'active';

-- At most one draft per user
create unique index if not exists athlete_profile_documents_one_draft_per_user
  on public.athlete_profile_documents (user_id) where status = 'draft';

-- Common reads: history list ordered by version desc
create index if not exists athlete_profile_documents_user_status_version_idx
  on public.athlete_profile_documents (user_id, status, version desc);

alter table public.athlete_profile_documents enable row level security;

drop policy if exists "athlete_profile_documents self" on public.athlete_profile_documents;
create policy "athlete_profile_documents self"
  on public.athlete_profile_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Comments (load-bearing context for future contributors) ──────────────────
comment on column public.athlete_profile_documents.plan_payload is
  'NULL in Phase 1 (intake-only). Phase 2 populates with structured plan from AI generation. Forward-compatible nullable column avoids ALTER between phases.';

comment on column public.athlete_profile_documents.rendered_md is
  'Frozen markdown rendered from intake_payload at acknowledgment time (Phase 1) or from intake+plan in Phase 2. Byte-stable for the lifetime of the version — never regenerated. The artifact the user signs.';

comment on column public.athlete_profile_documents.status is
  'Lifecycle: draft (in progress) → active (acknowledged) → superseded (replaced by newer version) | discarded (manually abandoned). One active and one draft maximum per user (partial unique indexes).';

comment on column public.athlete_profile_documents.version is
  'Monotonically increasing per user, enforced by code at insert time. Each acknowledgment commits a new version.';
```

- [ ] **Step 2: Apply the migration**

Per CLAUDE.md, the Supabase CLI is linked. Run:

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected: a single migration applies. If it complains about migration history mismatch, run `supabase migration repair --status applied <history>` per CLAUDE.md guidance and retry. The migration is purely additive; if any prompt asks to confirm a destructive change, abort and investigate.

- [ ] **Step 3: Verify schema applied**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db diff
```

Expected: no diff (migration applied cleanly).

Visually confirm in Supabase Dashboard → Table Editor that `athlete_profile_documents` exists with RLS enabled (lock icon on table). Confirm two partial unique indexes (`one_active_per_user`, `one_draft_per_user`) under the table's Indexes tab.

- [ ] **Step 4: Add migration entry to CLAUDE.md**

Open `CLAUDE.md`, find the "Database migrations" section, and add the entry after the highest-numbered entry currently present. Use the next available list number (the existing list has a numbering bug at 7 → fix only if it produces a markdown rendering issue; otherwise just match the existing pattern):

```diff
+10. [supabase/migrations/0010_athlete_profile.sql](supabase/migrations/0010_athlete_profile.sql) — adds `athlete_profile_documents` (versioned, user-acknowledged athlete profile capturing medical/training/lifestyle/nutrition/sleep baselines + goal-with-why) for the Phase 1 onboarding wizard. `plan_payload` and `rendered_md` columns are nullable in Phase 1; Phase 2 populates them when AI plan generation lands.
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add supabase/migrations/0010_athlete_profile.sql CLAUDE.md
git commit -m "feat(db): athlete profile schema (0010)

Adds athlete_profile_documents table for Phase 1 of the Athlete Profile
+ Coaching Plan feature. Captures durable, versioned, user-acknowledged
athlete context (medical, training history, equipment, lifestyle,
nutrition + sleep baselines, goal-with-why) via a typed intake_payload
jsonb plus a frozen rendered_md.

plan_payload and rendered_md are nullable in Phase 1 (intake-only).
Phase 2 will populate plan_payload with AI-generated structured plans.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TypeScript types

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Add types to `lib/data/types.ts`**

Append the following block to the end of `lib/data/types.ts` (after the last existing type — the body-measurement types from health-tab):

```ts
// ── Athlete profile (Phase 1) ────────────────────────────────────────────────

export type AthleteProfileStatus = "draft" | "active" | "superseded" | "discarded";

/** Phase 1 intake_payload shape. Phase 2 will add `goal_narrative_chat`,
 *  `coaching_preferences`, and `free_form_constraints` slots populated by the
 *  chat mode; those keys are reserved-absent in Phase 1.
 *
 *  Schema is snake_case to mirror what gets stored in Postgres jsonb.
 *  `schema_version` discriminates future migrations of this shape. */
export type IntakePayload = {
  schema_version: 1;
  health: {
    conditions: {
      cardiac: boolean;
      hypertension: boolean;
      diabetes: "none" | "type1" | "type2" | "prediabetic";
      autoimmune: boolean;
      joint_surgeries: Array<{ joint: string; year: number; notes?: string }>;
      other: string;
    };
    medications: string;
    recent_illness_injury: string;
    active_injuries: Array<{ joint: string; restriction: string }>;
    allergies: string;
  };
  training: {
    years_lifting: number;
    training_age: "beginner" | "intermediate" | "advanced";
    sessions_per_week: number;
    typical_session_minutes: number;
    equipment: {
      barbell: boolean;
      rack: boolean;
      bench: boolean;
      dumbbells: boolean;
      cables: boolean;
      machines: boolean;
      platform: boolean;
      ghd: boolean;
      sled: boolean;
      treadmill: boolean;
      rower: boolean;
      bike: boolean;
      kettlebells: boolean;
      bands: boolean;
      other: string;
    };
    current_e1rm: {
      squat: number | null;
      bench: number | null;
      deadlift: number | null;
      ohp: number | null;
    };
    best_ever_pr: {
      squat: number | null;
      bench: number | null;
      deadlift: number | null;
      ohp: number | null;
    };
    previous_programs: string;
    recent_plateaus: string;
  };
  lifestyle: {
    job_demands: "sedentary" | "mixed" | "active" | "labor";
    commute_minutes: number;
    has_dependents: boolean;
    dependent_notes: string;
    stress_self_rating: 1 | 2 | 3 | 4 | 5;
    days_available: {
      mon: boolean;
      tue: boolean;
      wed: boolean;
      thu: boolean;
      fri: boolean;
      sat: boolean;
      sun: boolean;
    };
    earliest_session_time: string; // "HH:mm"
    latest_session_time: string; // "HH:mm"
    travel_frequency: "none" | "rare" | "monthly" | "weekly";
  };
  nutrition: {
    current_phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
    current_kcal: number;
    current_macros: { protein_g: number; carb_g: number; fat_g: number };
    tracking_experience: "none" | "on_off" | "consistent";
    restrictions: string;
    alcohol_drinks_per_week: number;
    caffeine_mg_per_day: number;
    supplements: string;
  };
  sleep_recovery: {
    avg_sleep_hours: number;
    typical_bedtime: string; // "HH:mm"
    typical_wake_time: string; // "HH:mm"
    sleep_latency_minutes: number;
    awakenings: "none" | "1_2" | "3_plus";
    mobility_work: string;
    soreness_frequency: "rare" | "common" | "always";
  };
  goals: {
    primary_type: "strength" | "body_comp" | "performance" | "health";
    primary_metric: string;
    target_value: number;
    target_unit: string;
    target_date: string; // "YYYY-MM-DD"
    why_narrative: string;
  };
};

/** Row mirror of public.athlete_profile_documents. */
export type AthleteProfileDocument = {
  id: string;
  user_id: string;
  version: number;
  status: AthleteProfileStatus;
  intake_payload: IntakePayload;
  plan_payload: unknown | null; // populated in Phase 2
  rendered_md: string | null;
  acknowledged_at: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 2: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS (zero errors). Types are additive — no consumers yet — so no downstream errors should appear.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/data/types.ts
git commit -m "feat(types): add IntakePayload + AthleteProfileDocument types

Mirrors the 0010_athlete_profile.sql schema. IntakePayload covers the 6
form-step domains (health, training, lifestyle, nutrition,
sleep_recovery, goals). schema_version: 1 discriminator allows future
migrations of the jsonb shape. Phase 2 will extend IntakePayload with
chat-elicited slots (goal_narrative_chat, coaching_preferences,
free_form_constraints).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Zod validation schema for `IntakePayload`

**Files:**
- Create: `lib/validation/intakePayload.ts`

- [ ] **Step 1: Check whether `lib/validation/` exists**

```bash
cd "/Users/abdelouahedelbied/Health app"
ls lib/validation/ 2>&1
```

If the directory does not exist, the `Write` in Step 2 creates it implicitly. If it exists with other validators, follow their export style (default vs. named).

- [ ] **Step 2: Create the schema file**

Write `lib/validation/intakePayload.ts`:

```ts
// lib/validation/intakePayload.ts
//
// Zod runtime validator for the IntakePayload jsonb stored in
// athlete_profile_documents.intake_payload. Used by:
//   - Server actions (createDraftProfile, updateDraftProfile) on submit
//   - Probe scripts during development
//
// The shape MUST stay in sync with IntakePayload in lib/data/types.ts.
// If you change one, change the other.

import { z } from "zod";

const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");
const YYYYMMDD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const NonNegInt = z.number().int().min(0);
const PosNum = z.number().positive();
const NonNegNum = z.number().min(0);

const HealthSchema = z.object({
  conditions: z.object({
    cardiac: z.boolean(),
    hypertension: z.boolean(),
    diabetes: z.enum(["none", "type1", "type2", "prediabetic"]),
    autoimmune: z.boolean(),
    joint_surgeries: z.array(
      z.object({
        joint: z.string().min(1),
        year: z.number().int().min(1900).max(2100),
        notes: z.string().optional(),
      }),
    ),
    other: z.string(),
  }),
  medications: z.string(),
  recent_illness_injury: z.string(),
  active_injuries: z.array(
    z.object({
      joint: z.string().min(1),
      restriction: z.string().min(1),
    }),
  ),
  allergies: z.string(),
});

const EquipmentSchema = z.object({
  barbell: z.boolean(),
  rack: z.boolean(),
  bench: z.boolean(),
  dumbbells: z.boolean(),
  cables: z.boolean(),
  machines: z.boolean(),
  platform: z.boolean(),
  ghd: z.boolean(),
  sled: z.boolean(),
  treadmill: z.boolean(),
  rower: z.boolean(),
  bike: z.boolean(),
  kettlebells: z.boolean(),
  bands: z.boolean(),
  other: z.string(),
});

const LiftMapNullable = z.object({
  squat: z.number().nullable(),
  bench: z.number().nullable(),
  deadlift: z.number().nullable(),
  ohp: z.number().nullable(),
});

const TrainingSchema = z.object({
  years_lifting: NonNegNum,
  training_age: z.enum(["beginner", "intermediate", "advanced"]),
  sessions_per_week: NonNegInt.max(14),
  typical_session_minutes: NonNegInt.max(600),
  equipment: EquipmentSchema,
  current_e1rm: LiftMapNullable,
  best_ever_pr: LiftMapNullable,
  previous_programs: z.string(),
  recent_plateaus: z.string(),
});

const LifestyleSchema = z.object({
  job_demands: z.enum(["sedentary", "mixed", "active", "labor"]),
  commute_minutes: NonNegInt.max(600),
  has_dependents: z.boolean(),
  dependent_notes: z.string(),
  stress_self_rating: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  days_available: z.object({
    mon: z.boolean(),
    tue: z.boolean(),
    wed: z.boolean(),
    thu: z.boolean(),
    fri: z.boolean(),
    sat: z.boolean(),
    sun: z.boolean(),
  }),
  earliest_session_time: HHmm,
  latest_session_time: HHmm,
  travel_frequency: z.enum(["none", "rare", "monthly", "weekly"]),
});

const NutritionSchema = z.object({
  current_phase: z.enum(["cut", "maintain", "lean_bulk", "recomp", "unsure"]),
  current_kcal: NonNegInt.max(15000),
  current_macros: z.object({
    protein_g: NonNegNum,
    carb_g: NonNegNum,
    fat_g: NonNegNum,
  }),
  tracking_experience: z.enum(["none", "on_off", "consistent"]),
  restrictions: z.string(),
  alcohol_drinks_per_week: NonNegNum.max(200),
  caffeine_mg_per_day: NonNegNum.max(5000),
  supplements: z.string(),
});

const SleepRecoverySchema = z.object({
  avg_sleep_hours: NonNegNum.max(24),
  typical_bedtime: HHmm,
  typical_wake_time: HHmm,
  sleep_latency_minutes: NonNegNum.max(600),
  awakenings: z.enum(["none", "1_2", "3_plus"]),
  mobility_work: z.string(),
  soreness_frequency: z.enum(["rare", "common", "always"]),
});

const GoalsSchema = z.object({
  primary_type: z.enum(["strength", "body_comp", "performance", "health"]),
  primary_metric: z.string().min(1),
  target_value: PosNum,
  target_unit: z.string().min(1),
  target_date: YYYYMMDD,
  why_narrative: z.string().min(10, "Please share a sentence or two on why this goal matters"),
});

export const IntakePayloadSchema = z.object({
  schema_version: z.literal(1),
  health: HealthSchema,
  training: TrainingSchema,
  lifestyle: LifestyleSchema,
  nutrition: NutritionSchema,
  sleep_recovery: SleepRecoverySchema,
  goals: GoalsSchema,
});

/** Parse + assert. Throws ZodError on invalid input — server action callers
 *  catch and surface as form errors. */
export function parseIntakePayload(input: unknown) {
  return IntakePayloadSchema.parse(input);
}

/** Soft variant — returns SafeParseResult. Use when you want to display
 *  field-level errors in the wizard without throwing. */
export function safeParseIntakePayload(input: unknown) {
  return IntakePayloadSchema.safeParse(input);
}
```

- [ ] **Step 3: Confirm zod is already installed**

```bash
cd "/Users/abdelouahedelbied/Health app"
node -e "console.log(require('zod/package.json').version)"
```

Expected: prints a version string (e.g., `3.x.x`). If it errors with "Cannot find module 'zod'", install it:

```bash
npm install zod
```

- [ ] **Step 4: Probe the validator**

Create `scripts/probe-intake-validator.mjs` (deleted at end of task):

```js
// scripts/probe-intake-validator.mjs
import { IntakePayloadSchema } from "../lib/validation/intakePayload.ts";

const valid = {
  schema_version: 1,
  health: {
    conditions: { cardiac: false, hypertension: false, diabetes: "none",
                  autoimmune: false, joint_surgeries: [], other: "" },
    medications: "", recent_illness_injury: "",
    active_injuries: [], allergies: "",
  },
  training: {
    years_lifting: 5, training_age: "intermediate", sessions_per_week: 4,
    typical_session_minutes: 75,
    equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                 cables: true, machines: true, platform: false, ghd: false,
                 sled: false, treadmill: true, rower: false, bike: false,
                 kettlebells: false, bands: false, other: "" },
    current_e1rm: { squat: 165, bench: 110, deadlift: 200, ohp: 70 },
    best_ever_pr: { squat: 180, bench: 120, deadlift: 220, ohp: 80 },
    previous_programs: "5/3/1, RP", recent_plateaus: "",
  },
  lifestyle: {
    job_demands: "mixed", commute_minutes: 30, has_dependents: false,
    dependent_notes: "", stress_self_rating: 3,
    days_available: { mon: true, tue: true, wed: false, thu: true,
                      fri: true, sat: true, sun: false },
    earliest_session_time: "06:00", latest_session_time: "21:00",
    travel_frequency: "rare",
  },
  nutrition: {
    current_phase: "recomp", current_kcal: 2650,
    current_macros: { protein_g: 200, carb_g: 280, fat_g: 85 },
    tracking_experience: "consistent", restrictions: "",
    alcohol_drinks_per_week: 2, caffeine_mg_per_day: 200, supplements: "creatine 5g",
  },
  sleep_recovery: {
    avg_sleep_hours: 7.5, typical_bedtime: "23:00", typical_wake_time: "06:30",
    sleep_latency_minutes: 15, awakenings: "1_2",
    mobility_work: "10 min daily", soreness_frequency: "common",
  },
  goals: {
    primary_type: "strength", primary_metric: "deadlift e1RM",
    target_value: 220, target_unit: "kg", target_date: "2026-08-01",
    why_narrative: "Setting up for first powerlifting meet",
  },
};

console.log("=== valid case ===");
const r1 = IntakePayloadSchema.safeParse(valid);
console.log("success:", r1.success);
if (!r1.success) console.log(r1.error.issues);

console.log("\n=== invalid: bad time format ===");
const r2 = IntakePayloadSchema.safeParse({
  ...valid,
  lifestyle: { ...valid.lifestyle, earliest_session_time: "6am" },
});
console.log("success:", r2.success);
if (!r2.success) console.log(r2.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

console.log("\n=== invalid: short why_narrative ===");
const r3 = IntakePayloadSchema.safeParse({
  ...valid,
  goals: { ...valid.goals, why_narrative: "PRs" },
});
console.log("success:", r3.success);
if (!r3.success) console.log(r3.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
```

Run it:

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-intake-validator.mjs
```

Expected output:
```
=== valid case ===
success: true

=== invalid: bad time format ===
success: false
[ 'lifestyle.earliest_session_time: Expected HH:mm' ]

=== invalid: short why_narrative ===
success: false
[ 'goals.why_narrative: Please share a sentence or two on why this goal matters' ]
```

- [ ] **Step 5: Delete the probe script**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-intake-validator.mjs
```

- [ ] **Step 6: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/validation/intakePayload.ts package.json package-lock.json 2>/dev/null
git commit -m "feat(validation): Zod schema for IntakePayload

Runtime validator for athlete_profile_documents.intake_payload jsonb.
Mirrors lib/data/types.ts:IntakePayload exactly. Used by server actions
on form submit to surface field-level errors before insert.

Probe-tested with valid + invalid (bad HH:mm format, short
why_narrative) cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Profile renderer (markdown + summary)

**Files:**
- Create: `lib/coach/profile-renderer.ts`

- [ ] **Step 1: Create the renderer**

Write `lib/coach/profile-renderer.ts`:

```ts
// lib/coach/profile-renderer.ts
//
// Pure functions that turn an IntakePayload into:
//   - renderProfileMarkdown(): the human-readable artifact frozen into
//     athlete_profile_documents.rendered_md at acknowledgment time. Byte-
//     stable for the lifetime of the version (never regenerated).
//   - renderProfileSummary(): the condensed string injected into the coach
//     AI's snapshot prefix on every turn. ~250 tokens, designed for cache
//     density.
//
// No AI in either path. Deterministic transformations only. If you change
// the markdown template later, OLD acknowledged docs still display from
// their stored rendered_md — they don't re-render.

import type { IntakePayload } from "@/lib/data/types";

// ── Public API ───────────────────────────────────────────────────────────────

export function renderProfileMarkdown(
  intake: IntakePayload,
  version: number,
  acknowledgedAt: string | null,
  supersedesVersion: number | null,
): string {
  const ackLine = renderAckLine(acknowledgedAt, supersedesVersion);

  const sections: string[] = [
    `# Athlete Profile — v${version}`,
    ``,
    `*${ackLine}*`,
    ``,
    renderSnapshotSection(intake),
    renderGoalSection(intake),
    renderHealthSection(intake),
    renderTrainingSection(intake),
    renderLifestyleSection(intake),
    renderNutritionSection(intake),
    renderSleepSection(intake),
    `---`,
    ``,
    `*This profile is the foundation for upcoming coaching plans (v2+ adds AI-generated periodization, sleep, and nutrition prescriptions).*`,
  ];

  return sections.join("\n");
}

export function renderProfileSummary(intake: IntakePayload, version: number): string {
  const g = intake.goals;
  const t = intake.training;
  const l = intake.lifestyle;
  const n = intake.nutrition;
  const sr = intake.sleep_recovery;

  const daysAvailable = compactDays(l.days_available);
  const equipmentList = compactEquipment(t.equipment);
  const e1rmCompact = `SQ${fmtN(t.current_e1rm.squat)} BP${fmtN(t.current_e1rm.bench)} DL${fmtN(t.current_e1rm.deadlift)} OHP${fmtN(t.current_e1rm.ohp)}`;
  const why = trimSentences(g.why_narrative, 2);
  const health = compactHealth(intake);
  const alcoholLine =
    n.alcohol_drinks_per_week > 0 ? ` Alcohol ${n.alcohol_drinks_per_week}/wk.` : "";
  const travelLine = l.travel_frequency !== "none" ? ` Travel: ${l.travel_frequency}.` : "";

  return [
    `## Athlete profile (v${version})`,
    ``,
    `Goal: ${g.primary_type} — ${g.primary_metric} ${g.target_value}${g.target_unit} by ${g.target_date}. Why: "${why}".`,
    ``,
    `Trains ${t.sessions_per_week}×/wk (${daysAvailable}, ${l.earliest_session_time}-${l.latest_session_time} window). ${cap(t.training_age)} lifter, ${t.years_lifting}y. Current e1RMs: ${e1rmCompact}.`,
    ``,
    `Equipment: ${equipmentList}.`,
    ``,
    `Health: ${health}.`,
    ``,
    `Nutrition baseline: ${n.current_phase}, ${n.current_kcal} kcal target, ${n.current_macros.protein_g}P/${n.current_macros.carb_g}C/${n.current_macros.fat_g}F. Tracking ${n.tracking_experience}.${alcoholLine}`,
    ``,
    `Sleep baseline: ${sr.avg_sleep_hours}h, window ${sr.typical_bedtime}-${sr.typical_wake_time}. Soreness ${sr.soreness_frequency}.`,
    ``,
    `Job: ${l.job_demands}, stress ${l.stress_self_rating}/5.${travelLine}`,
  ].join("\n");
}

// ── Section helpers ─────────────────────────────────────────────────────────

function renderAckLine(acknowledgedAt: string | null, supersedesVersion: number | null): string {
  if (!acknowledgedAt) return "Draft — not yet acknowledged";
  const dateOnly = acknowledgedAt.slice(0, 10);
  if (supersedesVersion !== null) {
    return `Acknowledged ${dateOnly}, supersedes v${supersedesVersion}`;
  }
  return `Acknowledged ${dateOnly}`;
}

function renderSnapshotSection(intake: IntakePayload): string {
  const t = intake.training;
  const l = intake.lifestyle;
  const equipmentList = compactEquipment(t.equipment);
  const dependents = l.has_dependents
    ? l.dependent_notes
      ? `, dependents (${l.dependent_notes})`
      : ", dependents"
    : "";
  return [
    `## Athlete snapshot`,
    `Trains ${t.sessions_per_week}× per week, typical session ${t.typical_session_minutes} min. Equipment: ${equipmentList}.`,
    `Job: ${l.job_demands}, stress ${l.stress_self_rating}/5${dependents}.`,
    ``,
  ].join("\n");
}

function renderGoalSection(intake: IntakePayload): string {
  const g = intake.goals;
  return [
    `## Goal`,
    `**${cap(g.primary_type.replace("_", " "))}**: ${g.primary_metric} → ${g.target_value}${g.target_unit} by ${g.target_date}.`,
    ``,
    `> ${g.why_narrative}`,
    ``,
  ].join("\n");
}

function renderHealthSection(intake: IntakePayload): string {
  const h = intake.health;
  const lines: string[] = [`## Health context`];
  const conds = listConditions(h.conditions);
  if (conds) lines.push(`Conditions: ${conds}.`);
  if (h.medications.trim()) lines.push(`Medications: ${h.medications}.`);
  if (h.recent_illness_injury.trim()) lines.push(`Recent illness/injury: ${h.recent_illness_injury}.`);
  if (h.active_injuries.length > 0) {
    lines.push(`Active restrictions:`);
    for (const inj of h.active_injuries) {
      lines.push(`- ${inj.joint}: ${inj.restriction}`);
    }
  }
  if (h.allergies.trim()) lines.push(`Allergies: ${h.allergies}.`);
  if (lines.length === 1) lines.push(`No conditions or restrictions reported.`);
  lines.push(``);
  return lines.join("\n");
}

function renderTrainingSection(intake: IntakePayload): string {
  const t = intake.training;
  const lines: string[] = [
    `## Training history & equipment`,
    `${t.years_lifting} years lifting (${t.training_age}).`,
    `Current e1RMs: squat ${fmtN(t.current_e1rm.squat)}, bench ${fmtN(t.current_e1rm.bench)}, deadlift ${fmtN(t.current_e1rm.deadlift)}, OHP ${fmtN(t.current_e1rm.ohp)}.`,
  ];
  if (anyPr(t.best_ever_pr)) {
    lines.push(`Best PRs: squat ${fmtN(t.best_ever_pr.squat)}, bench ${fmtN(t.best_ever_pr.bench)}, deadlift ${fmtN(t.best_ever_pr.deadlift)}, OHP ${fmtN(t.best_ever_pr.ohp)}.`);
  }
  if (t.previous_programs.trim()) lines.push(`Previous programs: ${t.previous_programs}.`);
  if (t.recent_plateaus.trim()) lines.push(`Recent plateaus: ${t.recent_plateaus}.`);
  lines.push(``);
  return lines.join("\n");
}

function renderLifestyleSection(intake: IntakePayload): string {
  const l = intake.lifestyle;
  return [
    `## Lifestyle & schedule`,
    `Days available: ${compactDays(l.days_available)}.`,
    `Session window: ${l.earliest_session_time}–${l.latest_session_time}.`,
    `Commute: ${l.commute_minutes} min.`,
    `Travel: ${l.travel_frequency}.`,
    ``,
  ].join("\n");
}

function renderNutritionSection(intake: IntakePayload): string {
  const n = intake.nutrition;
  const lines: string[] = [
    `## Nutrition baseline`,
    `Current phase: ${n.current_phase}.`,
    `Target: ${n.current_kcal} kcal · ${n.current_macros.protein_g}P / ${n.current_macros.carb_g}C / ${n.current_macros.fat_g}F.`,
    `Tracking: ${n.tracking_experience}.`,
  ];
  if (n.restrictions.trim()) lines.push(`Restrictions: ${n.restrictions}.`);
  lines.push(`Alcohol: ${n.alcohol_drinks_per_week}/wk · Caffeine: ${n.caffeine_mg_per_day} mg/day.`);
  if (n.supplements.trim()) lines.push(`Supplements: ${n.supplements}.`);
  lines.push(``);
  return lines.join("\n");
}

function renderSleepSection(intake: IntakePayload): string {
  const sr = intake.sleep_recovery;
  const lines: string[] = [
    `## Sleep & recovery baseline`,
    `Average ${sr.avg_sleep_hours} hours, window ${sr.typical_bedtime}–${sr.typical_wake_time}.`,
    `Latency ${sr.sleep_latency_minutes} min, awakenings ${sr.awakenings.replace("_", "-")}.`,
    `Soreness frequency: ${sr.soreness_frequency}.`,
  ];
  if (sr.mobility_work.trim()) lines.push(`Mobility work: ${sr.mobility_work}.`);
  lines.push(``);
  return lines.join("\n");
}

// ── Small helpers ───────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function fmtN(n: number | null): string {
  return n === null ? "—" : String(n);
}

function trimSentences(s: string, maxSentences: number): string {
  if (!s.trim()) return "";
  const parts = s.split(/(?<=[.!?])\s+/);
  return parts.slice(0, maxSentences).join(" ").trim();
}

function compactDays(d: IntakePayload["lifestyle"]["days_available"]): string {
  const order: Array<[keyof typeof d, string]> = [
    ["mon", "M"], ["tue", "T"], ["wed", "W"], ["thu", "T"],
    ["fri", "F"], ["sat", "S"], ["sun", "S"],
  ];
  const on = order.filter(([k]) => d[k]).map(([, label]) => label);
  return on.length > 0 ? on.join("") : "(none)";
}

function compactEquipment(e: IntakePayload["training"]["equipment"]): string {
  const items: string[] = [];
  if (e.barbell) items.push("barbell");
  if (e.rack) items.push("rack");
  if (e.bench) items.push("bench");
  if (e.dumbbells) items.push("DBs");
  if (e.cables) items.push("cables");
  if (e.machines) items.push("machines");
  if (e.platform) items.push("platform");
  if (e.ghd) items.push("GHD");
  if (e.sled) items.push("sled");
  if (e.treadmill) items.push("treadmill");
  if (e.rower) items.push("rower");
  if (e.bike) items.push("bike");
  if (e.kettlebells) items.push("KBs");
  if (e.bands) items.push("bands");
  if (e.other.trim()) items.push(e.other.trim());
  return items.length > 0 ? items.join(", ") : "(none specified)";
}

function listConditions(c: IntakePayload["health"]["conditions"]): string {
  const items: string[] = [];
  if (c.cardiac) items.push("cardiac");
  if (c.hypertension) items.push("hypertension");
  if (c.diabetes !== "none") items.push(`diabetes (${c.diabetes})`);
  if (c.autoimmune) items.push("autoimmune");
  for (const s of c.joint_surgeries) {
    items.push(`${s.joint} surgery ${s.year}${s.notes ? ` (${s.notes})` : ""}`);
  }
  if (c.other.trim()) items.push(c.other.trim());
  return items.join(", ");
}

function compactHealth(intake: IntakePayload): string {
  const conds = listConditions(intake.health.conditions);
  const meds = intake.health.medications.trim();
  const restrictions = intake.health.active_injuries.length;
  if (!conds && !meds && restrictions === 0) return "no flagged conditions";
  const parts: string[] = [];
  if (conds) parts.push(conds);
  if (meds) parts.push(`meds: ${meds}`);
  if (restrictions > 0) parts.push(`${restrictions} active restriction${restrictions === 1 ? "" : "s"}`);
  return parts.join("; ");
}

function anyPr(prs: IntakePayload["training"]["best_ever_pr"]): boolean {
  return prs.squat !== null || prs.bench !== null || prs.deadlift !== null || prs.ohp !== null;
}
```

- [ ] **Step 2: Probe the renderer**

Create `scripts/probe-profile-renderer.mjs`:

```js
// scripts/probe-profile-renderer.mjs
import { renderProfileMarkdown, renderProfileSummary } from "../lib/coach/profile-renderer.ts";

const intake = {
  schema_version: 1,
  health: {
    conditions: { cardiac: false, hypertension: false, diabetes: "none",
                  autoimmune: false,
                  joint_surgeries: [{ joint: "left shoulder", year: 2018 }],
                  other: "" },
    medications: "", recent_illness_injury: "",
    active_injuries: [{ joint: "left shoulder", restriction: "no overhead pressing > 60kg" }],
    allergies: "",
  },
  training: {
    years_lifting: 5, training_age: "intermediate", sessions_per_week: 4,
    typical_session_minutes: 75,
    equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                 cables: true, machines: true, platform: false, ghd: false,
                 sled: false, treadmill: true, rower: false, bike: false,
                 kettlebells: false, bands: false, other: "" },
    current_e1rm: { squat: 165, bench: 110, deadlift: 200, ohp: 70 },
    best_ever_pr: { squat: 180, bench: 120, deadlift: 220, ohp: 80 },
    previous_programs: "5/3/1, RP", recent_plateaus: "",
  },
  lifestyle: {
    job_demands: "mixed", commute_minutes: 30, has_dependents: false,
    dependent_notes: "", stress_self_rating: 3,
    days_available: { mon: true, tue: true, wed: false, thu: true,
                      fri: true, sat: true, sun: false },
    earliest_session_time: "06:00", latest_session_time: "21:00",
    travel_frequency: "rare",
  },
  nutrition: {
    current_phase: "recomp", current_kcal: 2650,
    current_macros: { protein_g: 200, carb_g: 280, fat_g: 85 },
    tracking_experience: "consistent", restrictions: "",
    alcohol_drinks_per_week: 2, caffeine_mg_per_day: 200, supplements: "creatine 5g",
  },
  sleep_recovery: {
    avg_sleep_hours: 7.5, typical_bedtime: "23:00", typical_wake_time: "06:30",
    sleep_latency_minutes: 15, awakenings: "1_2",
    mobility_work: "10 min daily", soreness_frequency: "common",
  },
  goals: {
    primary_type: "strength", primary_metric: "deadlift e1RM",
    target_value: 220, target_unit: "kg", target_date: "2026-08-01",
    why_narrative: "Setting up for first powerlifting meet. Want to test myself in competition by end of summer.",
  },
};

console.log("=== Markdown ===\n");
console.log(renderProfileMarkdown(intake, 1, "2026-05-15T08:30:00Z", null));
console.log("\n=== Summary ===\n");
console.log(renderProfileSummary(intake, 1));
```

Run:

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-profile-renderer.mjs
```

Expected:
- Markdown opens with `# Athlete Profile — v1` and includes all sections (Snapshot, Goal, Health context, Training, Lifestyle, Nutrition, Sleep). The Health section shows the shoulder restriction; the Training section includes both current e1RMs and best PRs (since they differ).
- Summary opens with `## Athlete profile (v1)` and is roughly 10–14 lines, dense and information-rich. Goal narrative is trimmed to 1–2 sentences. Equipment shows compact comma-list. e1RMs show as `SQ165 BP110 DL200 OHP70`.

Visually skim both outputs — anything misformatted, missing, or wrong?

- [ ] **Step 3: Delete the probe script**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-profile-renderer.mjs
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/profile-renderer.ts
git commit -m "feat(coach): athlete profile renderer (markdown + summary)

Pure deterministic transformations of IntakePayload into:
  - renderProfileMarkdown: human-readable artifact frozen into rendered_md
    at acknowledgment time, byte-stable for the lifetime of the version
  - renderProfileSummary: ~250-token condensed string for the coach AI's
    cached snapshot prefix

No AI in the rendering path. Old acknowledged docs always display from
their stored rendered_md regardless of future renderer changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Query keys for `athleteProfile`

**Files:**
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Add the key factory**

In `lib/query/keys.ts`, add a new entry to the `queryKeys` object. Insert it after the `blockProgress` block, before the closing `} as const;`:

```ts
  athleteProfile: {
    /** Active acknowledged version for this user (status='active'). */
    active: (userId: string) => ["athlete-profile", userId, "active"] as const,
    /** All non-discarded versions for this user, ordered version desc. */
    history: (userId: string) => ["athlete-profile", userId, "history"] as const,
    /** Current draft, if any (status='draft'). */
    draft: (userId: string) => ["athlete-profile", userId, "draft"] as const,
    /** Single document by id (used by ViewModal for any version). */
    one: (userId: string, id: string) => ["athlete-profile", userId, "one", id] as const,
    /** Wide invalidation prefix — use after any write. */
    all: (userId: string) => ["athlete-profile", userId] as const,
  },
```

- [ ] **Step 2: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/query/keys.ts
git commit -m "feat(query): athleteProfile query keys

Adds active / history / draft / one / all key factories for the
athlete profile cache. Mutations invalidate via the all() prefix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Server + browser fetchers

**Files:**
- Create: `lib/query/fetchers/athleteProfile.ts`

- [ ] **Step 1: Create the fetcher file**

Write `lib/query/fetchers/athleteProfile.ts`:

```ts
// lib/query/fetchers/athleteProfile.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AthleteProfileDocument } from "@/lib/data/types";

const COLS =
  "id, user_id, version, status, intake_payload, plan_payload, rendered_md, acknowledged_at, superseded_at, superseded_by, created_at, updated_at";

// ── Active doc ──────────────────────────────────────────────────────────────

export async function fetchActiveProfileServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

export async function fetchActiveProfileBrowser(
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

// ── History (all non-discarded versions, version desc) ──────────────────────

export async function fetchProfileHistoryServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<AthleteProfileDocument[]> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .neq("status", "discarded")
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AthleteProfileDocument[];
}

export async function fetchProfileHistoryBrowser(
  userId: string,
): Promise<AthleteProfileDocument[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .neq("status", "discarded")
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AthleteProfileDocument[];
}

// ── Draft ───────────────────────────────────────────────────────────────────

export async function fetchDraftProfileServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

export async function fetchDraftProfileBrowser(
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

// ── Single doc by id (used by ViewModal for any version) ────────────────────

export async function fetchProfileByIdServer(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<AthleteProfileDocument | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

export async function fetchProfileByIdBrowser(
  userId: string,
  id: string,
): Promise<AthleteProfileDocument | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/query/fetchers/athleteProfile.ts
git commit -m "feat(query): athlete profile fetchers (server + browser)

Four shapes:
  - active: status='active' singleton (or null)
  - history: all non-discarded versions, desc by version
  - draft: status='draft' singleton (or null)
  - byId: single doc by id (used by ViewModal for any version)

Both server (cookie-bound, RLS via passed SupabaseClient) and browser
(self-constructs the browser client) variants. Both throw on errors so
TanStack Query lights up isError correctly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Client hooks

**Files:**
- Create: `lib/query/hooks/useAthleteProfile.ts`
- Create: `lib/query/hooks/useAthleteProfileHistory.ts`
- Create: `lib/query/hooks/useAthleteProfileDraft.ts`

- [ ] **Step 1: Create `useAthleteProfile.ts`**

Write `lib/query/hooks/useAthleteProfile.ts`:

```ts
// lib/query/hooks/useAthleteProfile.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchActiveProfileBrowser } from "@/lib/query/fetchers/athleteProfile";

/** Active acknowledged athlete profile, or null if none exists. */
export function useAthleteProfile(userId: string) {
  return useQuery({
    queryKey: queryKeys.athleteProfile.active(userId),
    queryFn: () => fetchActiveProfileBrowser(userId),
  });
}
```

- [ ] **Step 2: Create `useAthleteProfileHistory.ts`**

Write `lib/query/hooks/useAthleteProfileHistory.ts`:

```ts
// lib/query/hooks/useAthleteProfileHistory.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileHistoryBrowser } from "@/lib/query/fetchers/athleteProfile";

/** All non-discarded athlete profile versions, version desc. */
export function useAthleteProfileHistory(userId: string) {
  return useQuery({
    queryKey: queryKeys.athleteProfile.history(userId),
    queryFn: () => fetchProfileHistoryBrowser(userId),
  });
}
```

- [ ] **Step 3: Create `useAthleteProfileDraft.ts`**

Write `lib/query/hooks/useAthleteProfileDraft.ts`:

```ts
// lib/query/hooks/useAthleteProfileDraft.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchDraftProfileBrowser } from "@/lib/query/fetchers/athleteProfile";

/** Current open draft, or null if none. At most one per user. */
export function useAthleteProfileDraft(userId: string) {
  return useQuery({
    queryKey: queryKeys.athleteProfile.draft(userId),
    queryFn: () => fetchDraftProfileBrowser(userId),
  });
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/query/hooks/useAthleteProfile.ts lib/query/hooks/useAthleteProfileHistory.ts lib/query/hooks/useAthleteProfileDraft.ts
git commit -m "feat(query): athlete profile hooks

Three TanStack Query hooks:
  - useAthleteProfile: active acknowledged version (or null)
  - useAthleteProfileHistory: all non-discarded versions, desc
  - useAthleteProfileDraft: current draft (or null)

Each calls its matching browser fetcher; server-side prefetch is set
up separately on /profile and /onboarding pages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Pre-fill — `useRecentE1RMs` fetcher + hook

**Files:**
- Create: `lib/query/fetchers/recentE1RMs.ts`
- Create: `lib/query/hooks/useRecentE1RMs.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Add the query key**

In `lib/query/keys.ts`, add inside the `queryKeys` object (after `blockProgress`, before `athleteProfile`):

```ts
  recentE1RMs: {
    one: (userId: string) => ["recent-e1rms", userId] as const,
  },
```

- [ ] **Step 2: Read existing workouts loader to mirror its conventions**

```bash
cd "/Users/abdelouahedelbied/Health app"
cat lib/data/workouts-server.ts | head -60
```

Note the row shape (`exercises` array with `name` + `sets` array of `{ kg, reps, warmup }`). The Epley formula is already used in `lib/coach/snapshot.ts` — reuse the same: `e1RM = kg × (1 + reps / 30)` for `reps ≤ 12`, else null.

- [ ] **Step 3: Create the fetcher**

Write `lib/query/fetchers/recentE1RMs.ts`:

```ts
// lib/query/fetchers/recentE1RMs.ts
//
// Computes top working-set e1RM per primary lift over the last 8 weeks of
// workouts. Used to pre-fill the /onboarding wizard's Training step with
// "current e1RM" values the user can review and confirm.
//
// e1RM formula: Epley — kg × (1 + reps / 30). Null when reps > 12 or for
// duration-based sets. Matches the convention used by lib/coach/tools.ts
// query_workouts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type RecentE1RMs = {
  squat: number | null;
  bench: number | null;
  deadlift: number | null;
  ohp: number | null;
  /** Sessions per week derived from last 4 weeks of workouts.count / 4. */
  sessions_per_week_estimate: number | null;
};

const PRIMARY_LIFT_KEYWORDS: Record<keyof Omit<RecentE1RMs, "sessions_per_week_estimate">, RegExp> = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|press)\b/i,
};

const WORKOUTS_COLS =
  "id, date, exercises (name, sets:exercise_sets (kg, reps, warmup, duration_seconds))";

function epley(kg: number, reps: number): number | null {
  if (reps <= 0 || reps > 12) return null;
  return Math.round(kg * (1 + reps / 30));
}

function eightWeeksAgo(today: string): string {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 56);
  return t.toISOString().slice(0, 10);
}

function fourWeeksAgo(today: string): string {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 28);
  return t.toISOString().slice(0, 10);
}

type WorkoutRow = {
  id: string;
  date: string;
  exercises: Array<{
    name: string;
    sets: Array<{ kg: number | null; reps: number | null; warmup: boolean; duration_seconds: number | null }>;
  }>;
};

function computeFrom(rows: WorkoutRow[], today: string): RecentE1RMs {
  const eight = eightWeeksAgo(today);
  const four = fourWeeksAgo(today);

  const within8w = rows.filter((r) => r.date >= eight);
  const within4w = rows.filter((r) => r.date >= four);

  const out: RecentE1RMs = {
    squat: null, bench: null, deadlift: null, ohp: null,
    sessions_per_week_estimate: null,
  };

  for (const lift of ["squat", "bench", "deadlift", "ohp"] as const) {
    const re = PRIMARY_LIFT_KEYWORDS[lift];
    let best: number | null = null;
    for (const w of within8w) {
      for (const ex of w.exercises ?? []) {
        if (!re.test(ex.name)) continue;
        for (const s of ex.sets ?? []) {
          if (s.warmup) continue;
          if (s.kg === null || s.reps === null) continue;
          const e = epley(s.kg, s.reps);
          if (e !== null && (best === null || e > best)) best = e;
        }
      }
    }
    out[lift] = best;
  }

  if (within4w.length > 0) {
    out.sessions_per_week_estimate = Math.round((within4w.length / 4) * 10) / 10;
  }

  return out;
}

export async function fetchRecentE1RMsServer(
  supabase: SupabaseClient,
  userId: string,
  todayYYYYMMDD: string,
): Promise<RecentE1RMs> {
  const since = eightWeeksAgo(todayYYYYMMDD);
  const { data, error } = await supabase
    .from("workouts")
    .select(WORKOUTS_COLS)
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: false });
  if (error) throw error;
  return computeFrom((data ?? []) as WorkoutRow[], todayYYYYMMDD);
}

export async function fetchRecentE1RMsBrowser(
  userId: string,
  todayYYYYMMDD: string,
): Promise<RecentE1RMs> {
  const supabase = createSupabaseBrowserClient();
  const since = eightWeeksAgo(todayYYYYMMDD);
  const { data, error } = await supabase
    .from("workouts")
    .select(WORKOUTS_COLS)
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: false });
  if (error) throw error;
  return computeFrom((data ?? []) as WorkoutRow[], todayYYYYMMDD);
}
```

- [ ] **Step 4: Create the hook**

Write `lib/query/hooks/useRecentE1RMs.ts`:

```ts
// lib/query/hooks/useRecentE1RMs.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchRecentE1RMsBrowser } from "@/lib/query/fetchers/recentE1RMs";

export function useRecentE1RMs(userId: string, today: string) {
  return useQuery({
    queryKey: queryKeys.recentE1RMs.one(userId),
    queryFn: () => fetchRecentE1RMsBrowser(userId, today),
    staleTime: 5 * 60_000, // 5 min — workouts don't change frequently
  });
}
```

- [ ] **Step 5: Probe with sample data**

Quick sanity check on the Epley regex matching. Create `scripts/probe-e1rm.mjs`:

```js
// scripts/probe-e1rm.mjs
const RE = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|press)\b/i,
};

const cases = [
  ["Back Squat", "squat"],
  ["Squat", "squat"],
  ["Front Squat", "squat"], // matches squat — edge case to flag
  ["Bench Press", "bench"],
  ["Incline Bench Press", "bench"],
  ["Conventional Deadlift", "deadlift"],
  ["Sumo Deadlift", "deadlift"],
  ["Overhead Press", "ohp"],
  ["OHP", "ohp"],
  ["Leg Press", "ohp"], // matches ohp via /press/ — edge case
];

for (const [name, expected] of cases) {
  const matches = Object.entries(RE).filter(([, re]) => re.test(name)).map(([k]) => k);
  console.log(`${name.padEnd(25)} → ${matches.join(", ") || "(none)"} ${matches.includes(expected) ? "✓" : "✗"}`);
}
```

Run:

```bash
cd "/Users/abdelouahedelbied/Health app"
node scripts/probe-e1rm.mjs
```

Expected: most cases match correctly. **Two edge cases** — "Front Squat" matches squat (acceptable; the user can correct in the form), "Leg Press" matches OHP via the `/press/` keyword (problematic but rare for primary-lift detection in a real workout log).

If "Leg Press" false-positive concerns you, tighten the OHP regex by removing the bare `press` alternation: change to `/\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i`. This means generic "Press" won't match OHP — fine, since lifters typically log it as "Overhead Press" or "OHP". Apply the tightening if you choose; either way is acceptable for v1.

- [ ] **Step 6: Delete probe script**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-e1rm.mjs
```

- [ ] **Step 7: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/query/fetchers/recentE1RMs.ts lib/query/hooks/useRecentE1RMs.ts lib/query/keys.ts
git commit -m "feat(query): useRecentE1RMs for onboarding pre-fill

Computes top working-set Epley e1RM per primary lift (squat/bench/
deadlift/ohp) from last 8 weeks of workouts, plus a
sessions_per_week_estimate from last 4 weeks.

Used to pre-fill the /onboarding Training step so the user reviews and
confirms current strength rather than typing it from scratch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Server actions

**Files:**
- Create: `app/onboarding/actions.ts`

- [ ] **Step 1: Create the actions file**

Write `app/onboarding/actions.ts`:

```ts
// app/onboarding/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { IntakePayloadSchema } from "@/lib/validation/intakePayload";
import { renderProfileMarkdown } from "@/lib/coach/profile-renderer";
import type { IntakePayload, AthleteProfileDocument } from "@/lib/data/types";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

async function nextVersionFor(supabase: ReturnType<typeof createSupabaseServerClient> extends Promise<infer T> ? T : never, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select("version")
    .eq("user_id", userId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return ((data?.version as number | undefined) ?? 0) + 1;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type CreateDraftResult =
  | { ok: true; id: string; version: number }
  | { ok: false; error: string; field_errors?: Record<string, string> };

/**
 * Create a new draft from a fully-filled intake payload. Throws if the user
 * already has an open draft (caller should resume or discard first).
 */
export async function createDraftProfile(intake: unknown): Promise<CreateDraftResult> {
  const { supabase, user } = await requireUser();

  const parsed = IntakePayloadSchema.safeParse(intake);
  if (!parsed.success) {
    const field_errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      field_errors[issue.path.join(".")] = issue.message;
    }
    return { ok: false, error: "Validation failed", field_errors };
  }

  const version = await nextVersionFor(supabase, user.id);

  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .insert({
      user_id: user.id,
      version,
      status: "draft",
      intake_payload: parsed.data,
    })
    .select("id, version")
    .single();

  if (error) {
    // Partial unique index on draft would fire if another draft exists.
    if (error.code === "23505") {
      return {
        ok: false,
        error: "You already have a draft in progress. Resume or discard it from /profile first.",
      };
    }
    throw error;
  }

  revalidatePath("/profile");
  revalidatePath("/onboarding");
  return { ok: true, id: data.id as string, version: data.version as number };
}

/**
 * Update an existing draft's intake_payload. Used when user navigates back
 * from review to fix a form field.
 */
export async function updateDraftProfile(
  id: string,
  intake: unknown,
): Promise<CreateDraftResult> {
  const { supabase, user } = await requireUser();

  const parsed = IntakePayloadSchema.safeParse(intake);
  if (!parsed.success) {
    const field_errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      field_errors[issue.path.join(".")] = issue.message;
    }
    return { ok: false, error: "Validation failed", field_errors };
  }

  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .update({
      intake_payload: parsed.data,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "draft")
    .select("id, version")
    .single();

  if (error) throw error;
  if (!data) {
    return { ok: false, error: "Draft not found or already acknowledged." };
  }

  revalidatePath("/profile");
  revalidatePath("/onboarding");
  return { ok: true, id: data.id as string, version: data.version as number };
}

export type AcknowledgeResult =
  | { ok: true; version: number; acknowledged_at: string }
  | { ok: false; error: string };

/**
 * Atomic acknowledge: writes the (possibly user-edited) markdown to
 * rendered_md, flips the draft to active, supersedes any prior active row
 * for this user. One Postgres transaction via an RPC if available; otherwise
 * two updates with the partial unique index defending correctness.
 */
export async function acknowledgeDraft(
  id: string,
  rendered_md: string,
): Promise<AcknowledgeResult> {
  const { supabase, user } = await requireUser();

  // Load the draft we're acknowledging.
  const { data: draft, error: draftErr } = await supabase
    .from("athlete_profile_documents")
    .select("id, version, intake_payload")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "draft")
    .maybeSingle();
  if (draftErr) throw draftErr;
  if (!draft) {
    return { ok: false, error: "Draft not found or already acknowledged." };
  }

  // Find any prior active row.
  const { data: prior, error: priorErr } = await supabase
    .from("athlete_profile_documents")
    .select("id, version")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (priorErr) throw priorErr;

  const now = new Date().toISOString();

  // Step 1: supersede the prior active (if any). Doing this FIRST clears the
  // partial unique index so the draft → active flip won't violate it.
  if (prior) {
    const { error: supErr } = await supabase
      .from("athlete_profile_documents")
      .update({
        status: "superseded",
        superseded_at: now,
        superseded_by: draft.id as string,
        updated_at: now,
      })
      .eq("id", prior.id as string)
      .eq("user_id", user.id);
    if (supErr) {
      // No transaction here — but the partial unique index ensures we never
      // end up with two actives. If this errors, surface the failure and let
      // the user retry; the draft stays a draft.
      throw supErr;
    }
  }

  // Step 2: flip the draft to active with frozen rendered_md.
  const { error: ackErr } = await supabase
    .from("athlete_profile_documents")
    .update({
      status: "active",
      rendered_md,
      acknowledged_at: now,
      updated_at: now,
    })
    .eq("id", draft.id as string)
    .eq("user_id", user.id)
    .eq("status", "draft");
  if (ackErr) {
    // If acknowledge fails AFTER we superseded the prior, attempt rollback.
    if (prior) {
      await supabase
        .from("athlete_profile_documents")
        .update({
          status: "active",
          superseded_at: null,
          superseded_by: null,
          updated_at: now,
        })
        .eq("id", prior.id as string)
        .eq("user_id", user.id);
    }
    throw ackErr;
  }

  revalidatePath("/profile");
  revalidatePath("/coach");
  revalidatePath("/onboarding");
  return { ok: true, version: draft.version as number, acknowledged_at: now };
}

/** Discard a draft (manual abandon). Idempotent: returns ok if already gone. */
export async function discardDraft(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { supabase, user } = await requireUser();

  const { error } = await supabase
    .from("athlete_profile_documents")
    .update({ status: "discarded", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "draft");

  if (error) throw error;

  revalidatePath("/profile");
  revalidatePath("/onboarding");
  return { ok: true };
}

/** Pure helper: render the markdown for the current intake_payload — used by
 *  the Review step on the client to render the auto-rendered draft before
 *  acknowledgment. */
export async function renderDraftMarkdown(
  intake: IntakePayload,
  version: number,
  supersedesVersion: number | null,
): Promise<string> {
  // The renderer is pure; we run it in a server action only because the
  // wizard is a client component and we want the function importable
  // without bundling it into the client. The "use server" file scope
  // ensures only the result crosses the wire.
  return renderProfileMarkdown(intake, version, null, supersedesVersion);
}

/** Read helper used by the wizard to determine what version the next draft
 *  will get and which version (if any) it would supersede. */
export async function getNextVersionContext(): Promise<{
  next_version: number;
  supersedes_version: number | null;
  has_open_draft: boolean;
}> {
  const { supabase, user } = await requireUser();

  const [{ data: maxRow }, { data: activeRow }, { data: draftRow }] = await Promise.all([
    supabase
      .from("athlete_profile_documents")
      .select("version")
      .eq("user_id", user.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("athlete_profile_documents")
      .select("version")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("athlete_profile_documents")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "draft")
      .maybeSingle(),
  ]);

  const next_version = ((maxRow?.version as number | undefined) ?? 0) + 1;
  const supersedes_version = (activeRow?.version as number | undefined) ?? null;
  const has_open_draft = !!draftRow;

  return { next_version, supersedes_version, has_open_draft };
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

If you see a type error on the `nextVersionFor` helper signature (the conditional-type return-extraction is brittle in some TS versions), simplify by removing that helper — it's used only inside `createDraftProfile` and the inline replacement is just two more lines.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add app/onboarding/actions.ts
git commit -m "feat(onboarding): server actions (create / update / ack / discard)

Five server actions for the athlete profile wizard:
  - createDraftProfile(intake): inserts new draft with next version
  - updateDraftProfile(id, intake): updates existing draft on edit
  - acknowledgeDraft(id, rendered_md): atomic draft→active flip with
    prior-active supersede; partial unique index defends correctness
  - discardDraft(id): flips draft → discarded
  - renderDraftMarkdown / getNextVersionContext: server-side helpers
    used by the Review step

Zod validation gates create/update; field-level errors surface back to
the wizard for inline display.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: WizardNav + OnboardingWizard scaffolding + StepHealth

**Files:**
- Create: `components/onboarding/WizardNav.tsx`
- Create: `components/onboarding/OnboardingWizard.tsx`
- Create: `components/onboarding/StepHealth.tsx`

**Note on style:** match the existing app's component conventions (inline styles + `COLOR` constants from `lib/ui/theme.ts`). Confirm the theme exports by reading `lib/ui/theme.ts` once before starting.

- [ ] **Step 1: Create the shared nav component**

Write `components/onboarding/WizardNav.tsx`:

```tsx
"use client";
import { COLOR } from "@/lib/ui/theme";

export function WizardNav({
  step,
  totalSteps,
  onBack,
  onNext,
  nextLabel = "Next",
  nextDisabled = false,
}: {
  step: number;
  totalSteps: number;
  onBack: (() => void) | null;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 24 }}>
      <div style={{ fontSize: 11, color: COLOR.textMuted, textAlign: "center" }}>
        Step {step} of {totalSteps}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onBack ?? undefined}
          disabled={!onBack}
          style={{
            flex: 1,
            padding: "12px 16px",
            background: "transparent",
            border: `1px solid ${COLOR.border}`,
            borderRadius: 10,
            color: COLOR.textMuted,
            fontWeight: 600,
            cursor: onBack ? "pointer" : "not-allowed",
            opacity: onBack ? 1 : 0.4,
          }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          style={{
            flex: 2,
            padding: "12px 16px",
            background: nextDisabled ? COLOR.border : COLOR.accent,
            border: "none",
            borderRadius: 10,
            color: "#fff",
            fontWeight: 700,
            cursor: nextDisabled ? "not-allowed" : "pointer",
          }}
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the wizard orchestrator with default-state factory**

Write `components/onboarding/OnboardingWizard.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IntakePayload, AthleteProfileDocument } from "@/lib/data/types";
import type { RecentE1RMs } from "@/lib/query/fetchers/recentE1RMs";
import type { Profile } from "@/lib/data/types";
import type { DailyLog } from "@/lib/data/types";
import { COLOR } from "@/lib/ui/theme";
import {
  createDraftProfile,
  updateDraftProfile,
} from "@/app/onboarding/actions";
import { StepHealth } from "@/components/onboarding/StepHealth";
import { StepTraining } from "@/components/onboarding/StepTraining";
import { StepLifestyle } from "@/components/onboarding/StepLifestyle";
import { StepNutrition } from "@/components/onboarding/StepNutrition";
import { StepSleep } from "@/components/onboarding/StepSleep";
import { StepGoals } from "@/components/onboarding/StepGoals";
import { ReviewAndAcknowledge } from "@/components/onboarding/ReviewAndAcknowledge";

const TOTAL_STEPS = 6;

export type WizardPrefill = {
  profile: Pick<Profile, "name" | "age" | "height_cm"> | null;
  recentLogs: DailyLog[]; // last 30d for kcal/macro/sleep avgs
  recentE1RMs: RecentE1RMs;
  /** If revising, the prior version's payload to merge as second-precedence
   *  pre-fill (prior > derived > default). */
  priorIntake: IntakePayload | null;
  /** Existing draft (resume) — overrides everything else. */
  existingDraft: AthleteProfileDocument | null;
  nextVersion: number;
  supersedesVersion: number | null;
};

export function OnboardingWizard({ prefill, userId }: { prefill: WizardPrefill; userId: string }) {
  const router = useRouter();
  const [step, setStep] = useState(prefill.existingDraft ? 6 : 1);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [intake, setIntake] = useState<IntakePayload>(() => buildInitialIntake(prefill));
  const [draftId, setDraftId] = useState<string | null>(prefill.existingDraft?.id ?? null);

  function patchIntake<K extends keyof IntakePayload>(key: K, value: IntakePayload[K]) {
    setIntake((prev) => ({ ...prev, [key]: value }));
  }

  function goToReview() {
    setServerError(null);
    setFieldErrors({});
    startTransition(async () => {
      const action = draftId
        ? updateDraftProfile(draftId, intake)
        : createDraftProfile(intake);
      const result = await action;
      if (!result.ok) {
        setServerError(result.error);
        if (result.field_errors) setFieldErrors(result.field_errors);
        return;
      }
      setDraftId(result.id);
      setStep(7); // review
    });
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 16px 32px", color: COLOR.text }}>
      <WizardHeader step={step} totalSteps={TOTAL_STEPS + 1} userId={userId} />
      {serverError && (
        <div
          style={{
            margin: "12px 0",
            padding: "10px 12px",
            background: COLOR.dangerSoft ?? "rgba(220, 60, 60, 0.1)",
            border: `1px solid ${COLOR.danger ?? "#dc3c3c"}`,
            borderRadius: 8,
            color: COLOR.danger ?? "#dc3c3c",
            fontSize: 13,
          }}
        >
          {serverError}
        </div>
      )}

      {step === 1 && (
        <StepHealth
          value={intake.health}
          onChange={(v) => patchIntake("health", v)}
          onNext={() => setStep(2)}
          step={1}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 2 && (
        <StepTraining
          value={intake.training}
          recentE1RMs={prefill.recentE1RMs}
          onChange={(v) => patchIntake("training", v)}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
          step={2}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 3 && (
        <StepLifestyle
          value={intake.lifestyle}
          onChange={(v) => patchIntake("lifestyle", v)}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
          step={3}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 4 && (
        <StepNutrition
          value={intake.nutrition}
          onChange={(v) => patchIntake("nutrition", v)}
          onBack={() => setStep(3)}
          onNext={() => setStep(5)}
          step={4}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 5 && (
        <StepSleep
          value={intake.sleep_recovery}
          onChange={(v) => patchIntake("sleep_recovery", v)}
          onBack={() => setStep(4)}
          onNext={() => setStep(6)}
          step={5}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 6 && (
        <StepGoals
          value={intake.goals}
          onChange={(v) => patchIntake("goals", v)}
          onBack={() => setStep(5)}
          onNext={goToReview}
          nextLabel={isPending ? "Saving…" : "Review profile"}
          nextDisabled={isPending}
          step={6}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 7 && draftId && (
        <ReviewAndAcknowledge
          intake={intake}
          draftId={draftId}
          version={prefill.nextVersion}
          supersedesVersion={prefill.supersedesVersion}
          onBack={() => setStep(6)}
          onAcknowledged={() => router.push("/profile")}
        />
      )}
    </div>
  );
}

function WizardHeader({ step, totalSteps, userId: _userId }: { step: number; totalSteps: number; userId: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
        Athlete profile
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 2 }}>
        Set up your profile
      </h1>
      <ProgressBar pct={Math.min(100, ((step - 1) / totalSteps) * 100)} />
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        marginTop: 8,
        height: 4,
        background: COLOR.border,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div style={{ height: "100%", width: `${pct}%`, background: COLOR.accent, transition: "width .25s" }} />
    </div>
  );
}

function buildInitialIntake(prefill: WizardPrefill): IntakePayload {
  if (prefill.existingDraft) {
    return prefill.existingDraft.intake_payload;
  }

  const prior = prefill.priorIntake;
  const last30 = prefill.recentLogs;
  const avg = (vals: Array<number | null | undefined>) => {
    const xs = vals.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const last7 = last30.slice(-7);
  const kcalAvg = avg(last7.map((l) => l.calories_eaten ?? null));
  const proteinAvg = avg(last7.map((l) => l.protein_g ?? null));
  const carbAvg = avg(last7.map((l) => l.carbs_g ?? null));
  const fatAvg = avg(last7.map((l) => l.fat_g ?? null));
  const sleepAvg = avg(last30.map((l) => l.sleep_hours ?? null));

  // Precedence per spec: prior version > auto-derived > defaults.
  const e = prefill.recentE1RMs;
  const trainingAge: IntakePayload["training"]["training_age"] =
    prior?.training.training_age ??
    (yearsLiftingHeuristic(e) >= 5 ? "intermediate" : "beginner");

  return {
    schema_version: 1,
    health: prior?.health ?? {
      conditions: { cardiac: false, hypertension: false, diabetes: "none",
                    autoimmune: false, joint_surgeries: [], other: "" },
      medications: "", recent_illness_injury: "",
      active_injuries: [], allergies: "",
    },
    training: prior?.training ?? {
      years_lifting: 0, training_age: trainingAge,
      sessions_per_week: e.sessions_per_week_estimate ?? 3,
      typical_session_minutes: 60,
      equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                   cables: true, machines: true, platform: false, ghd: false,
                   sled: false, treadmill: true, rower: false, bike: false,
                   kettlebells: false, bands: false, other: "" },
      current_e1rm: { squat: e.squat, bench: e.bench, deadlift: e.deadlift, ohp: e.ohp },
      best_ever_pr: { squat: null, bench: null, deadlift: null, ohp: null },
      previous_programs: "", recent_plateaus: "",
    },
    lifestyle: prior?.lifestyle ?? {
      job_demands: "mixed", commute_minutes: 0, has_dependents: false,
      dependent_notes: "", stress_self_rating: 3,
      days_available: { mon: true, tue: true, wed: false, thu: true, fri: true, sat: false, sun: false },
      earliest_session_time: "06:00", latest_session_time: "21:00",
      travel_frequency: "none",
    },
    nutrition: prior?.nutrition ?? {
      current_phase: "maintain",
      current_kcal: kcalAvg ? Math.round(kcalAvg) : 2400,
      current_macros: {
        protein_g: proteinAvg ? Math.round(proteinAvg) : 150,
        carb_g: carbAvg ? Math.round(carbAvg) : 250,
        fat_g: fatAvg ? Math.round(fatAvg) : 70,
      },
      tracking_experience: "on_off", restrictions: "",
      alcohol_drinks_per_week: 0, caffeine_mg_per_day: 200, supplements: "",
    },
    sleep_recovery: prior?.sleep_recovery ?? {
      avg_sleep_hours: sleepAvg ? Math.round(sleepAvg * 10) / 10 : 7.5,
      typical_bedtime: "23:00", typical_wake_time: "06:30",
      sleep_latency_minutes: 15, awakenings: "1_2",
      mobility_work: "", soreness_frequency: "rare",
    },
    goals: prior?.goals ?? {
      primary_type: "strength", primary_metric: "deadlift e1RM",
      target_value: 200, target_unit: "kg",
      target_date: ninetyDaysFromToday(),
      why_narrative: "",
    },
  };
}

function yearsLiftingHeuristic(e: RecentE1RMs): number {
  // Crude: if any major lift > 100kg, assume ≥2 years; > 150kg ≥4 years.
  const max = Math.max(e.squat ?? 0, e.bench ?? 0, e.deadlift ?? 0, e.ohp ?? 0);
  if (max >= 150) return 5;
  if (max >= 100) return 2;
  return 0;
}

function ninetyDaysFromToday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 90);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 3: Create `StepHealth.tsx` (exemplar — other steps follow this pattern)**

Write `components/onboarding/StepHealth.tsx`:

```tsx
"use client";
import { COLOR } from "@/lib/ui/theme";
import type { IntakePayload } from "@/lib/data/types";
import { WizardNav } from "@/components/onboarding/WizardNav";

type HealthValue = IntakePayload["health"];

export function StepHealth({
  value,
  onChange,
  onNext,
  step,
  totalSteps,
  fieldErrors,
}: {
  value: HealthValue;
  onChange: (next: HealthValue) => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof HealthValue>(key: K, next: HealthValue[K]) {
    onChange({ ...value, [key]: next });
  }
  function patchConditions<K extends keyof HealthValue["conditions"]>(
    key: K,
    next: HealthValue["conditions"][K],
  ) {
    onChange({ ...value, conditions: { ...value.conditions, [key]: next } });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Health & medical</h2>
      <p style={{ fontSize: 13, color: COLOR.textMuted, marginBottom: 16 }}>
        Informational — used for context, not gating. Nothing here will block you from training.
      </p>

      <Group label="Conditions">
        <Toggle
          label="Cardiac history (afib, arrhythmia, prior MI, etc.)"
          checked={value.conditions.cardiac}
          onChange={(c) => patchConditions("cardiac", c)}
        />
        <Toggle
          label="Hypertension"
          checked={value.conditions.hypertension}
          onChange={(c) => patchConditions("hypertension", c)}
        />
        <Select
          label="Diabetes"
          value={value.conditions.diabetes}
          onChange={(v) => patchConditions("diabetes", v as HealthValue["conditions"]["diabetes"])}
          options={[
            ["none", "None"],
            ["type1", "Type 1"],
            ["type2", "Type 2"],
            ["prediabetic", "Pre-diabetic"],
          ]}
        />
        <Toggle
          label="Autoimmune condition"
          checked={value.conditions.autoimmune}
          onChange={(c) => patchConditions("autoimmune", c)}
        />
        <TextArea
          label="Anything else (free-text, optional)"
          value={value.conditions.other}
          onChange={(v) => patchConditions("other", v)}
          rows={2}
        />
      </Group>

      <Group label="Joint surgeries">
        <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 8 }}>
          One row per surgery (joint, year). Leave empty if none.
        </p>
        <RepeatingSurgery
          rows={value.conditions.joint_surgeries}
          onChange={(rows) => patchConditions("joint_surgeries", rows)}
        />
      </Group>

      <Group label="Active medications (training-relevant)">
        <TextArea
          label="Beta-blockers, stimulants, GLP-1s, etc. (free-text, blank if none)"
          value={value.medications}
          onChange={(v) => patch("medications", v)}
          rows={2}
        />
      </Group>

      <Group label="Recent illness or injury (last 12 months)">
        <TextArea
          label="Free-text (blank if nothing notable)"
          value={value.recent_illness_injury}
          onChange={(v) => patch("recent_illness_injury", v)}
          rows={2}
        />
      </Group>

      <Group label="Active injuries / movement restrictions">
        <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 8 }}>
          One row per restriction (e.g., &quot;left shoulder — no overhead pressing &gt; 60kg&quot;).
        </p>
        <RepeatingRestriction
          rows={value.active_injuries}
          onChange={(rows) => patch("active_injuries", rows)}
        />
      </Group>

      <Group label="Training-relevant allergies">
        <TextArea
          label="Latex/iodine, supplement allergies, etc. (blank if none)"
          value={value.allergies}
          onChange={(v) => patch("allergies", v)}
          rows={2}
        />
      </Group>

      <WizardNav
        step={step}
        totalSteps={totalSteps}
        onBack={null}
        onNext={onNext}
      />
    </section>
  );
}

// ── Field primitives (kept inline; reused by other Step files via copy
//     OR extract to components/onboarding/_fields.tsx if you prefer DRY.) ────

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "none", padding: 0, margin: "16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, color: COLOR.text, paddingBottom: 4 }}>{label}</legend>
      {children}
    </fieldset>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16 }}
      />
      <span style={{ fontSize: 14 }}>{label}</span>
    </label>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<[T, string]>;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        style={{
          padding: "8px 10px",
          background: "transparent",
          border: `1px solid ${COLOR.border}`,
          borderRadius: 8,
          color: COLOR.text,
          fontSize: 14,
        }}
      >
        {options.map(([k, l]) => (
          <option key={k} value={k}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "8px 10px",
          background: "transparent",
          border: `1px solid ${COLOR.border}`,
          borderRadius: 8,
          color: COLOR.text,
          fontSize: 14,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />
    </label>
  );
}

function RepeatingSurgery({
  rows,
  onChange,
}: {
  rows: HealthValue["conditions"]["joint_surgeries"];
  onChange: (rows: HealthValue["conditions"]["joint_surgeries"]) => void;
}) {
  function set(idx: number, patch: Partial<HealthValue["conditions"]["joint_surgeries"][number]>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([...rows, { joint: "", year: new Date().getFullYear(), notes: "" }]);
  }
  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="Joint (e.g., left knee)"
            value={r.joint}
            onChange={(e) => set(i, { joint: e.target.value })}
            style={inputStyle({ flex: 2 })}
          />
          <input
            type="number"
            placeholder="Year"
            value={r.year}
            onChange={(e) => set(i, { year: Number(e.target.value) || 0 })}
            style={inputStyle({ flex: 1 })}
          />
          <button type="button" onClick={() => remove(i)} style={removeBtnStyle()}>×</button>
        </div>
      ))}
      <button type="button" onClick={add} style={addBtnStyle()}>+ Add surgery</button>
    </div>
  );
}

function RepeatingRestriction({
  rows,
  onChange,
}: {
  rows: HealthValue["active_injuries"];
  onChange: (rows: HealthValue["active_injuries"]) => void;
}) {
  function set(idx: number, patch: Partial<HealthValue["active_injuries"][number]>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([...rows, { joint: "", restriction: "" }]);
  }
  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="Joint"
            value={r.joint}
            onChange={(e) => set(i, { joint: e.target.value })}
            style={inputStyle({ flex: 1 })}
          />
          <input
            type="text"
            placeholder="Restriction (free-text)"
            value={r.restriction}
            onChange={(e) => set(i, { restriction: e.target.value })}
            style={inputStyle({ flex: 2 })}
          />
          <button type="button" onClick={() => remove(i)} style={removeBtnStyle()}>×</button>
        </div>
      ))}
      <button type="button" onClick={add} style={addBtnStyle()}>+ Add restriction</button>
    </div>
  );
}

function inputStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    padding: "8px 10px",
    background: "transparent",
    border: `1px solid ${COLOR.border}`,
    borderRadius: 8,
    color: COLOR.text,
    fontSize: 14,
    ...extra,
  };
}

function removeBtnStyle(): React.CSSProperties {
  return {
    padding: "0 12px",
    background: "transparent",
    border: `1px solid ${COLOR.border}`,
    borderRadius: 8,
    color: COLOR.textMuted,
    cursor: "pointer",
  };
}

function addBtnStyle(): React.CSSProperties {
  return {
    padding: "8px 10px",
    background: "transparent",
    border: `1px dashed ${COLOR.border}`,
    borderRadius: 8,
    color: COLOR.textMuted,
    fontSize: 13,
    cursor: "pointer",
  };
}
```

- [ ] **Step 4: Optional refactor — extract field primitives**

If you prefer DRY, move `Group`, `Toggle`, `Select`, `TextArea`, `inputStyle`, `removeBtnStyle`, `addBtnStyle` to a new `components/onboarding/_fields.tsx` and import from each Step. Either approach is acceptable; per-file inline is faster to start, shared file pays off across Steps 2–6.

For the rest of this plan, **assume primitives are extracted into `components/onboarding/_fields.tsx`** so the remaining Step components don't duplicate the primitive code.

If you extract them, write `components/onboarding/_fields.tsx`:

```tsx
"use client";
import type { CSSProperties, ReactNode } from "react";
import { COLOR } from "@/lib/ui/theme";

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: "none", padding: 0, margin: "16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, color: COLOR.text, paddingBottom: 4 }}>{label}</legend>
      {children}
    </fieldset>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16 }} />
      <span style={{ fontSize: 14 }}>{label}</span>
    </label>
  );
}

export function Select<T extends string>({
  label, value, onChange, options,
}: {
  label: string; value: T; onChange: (v: T) => void; options: Array<[T, string]>;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} style={inputStyle()}>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

export function TextField({
  label, value, onChange, type = "text", placeholder, hint, prefilled,
}: {
  label: string; value: string | number; onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "time";
  placeholder?: string; hint?: string; prefilled?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>
        {label}{prefilled && <span style={{ marginLeft: 6, color: COLOR.accent }}>↻ from latest data</span>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle()}
      />
      {hint && <span style={{ fontSize: 11, color: COLOR.textMuted }}>{hint}</span>}
    </label>
  );
}

export function TextArea({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>{label}</span>
      <textarea
        rows={rows} value={value} onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle(), resize: "vertical", fontFamily: "inherit" }}
      />
    </label>
  );
}

export function inputStyle(extra: CSSProperties = {}): CSSProperties {
  return {
    padding: "8px 10px",
    background: "transparent",
    border: `1px solid ${COLOR.border}`,
    borderRadius: 8,
    color: COLOR.text,
    fontSize: 14,
    ...extra,
  };
}

export function addBtnStyle(): CSSProperties {
  return {
    padding: "8px 10px",
    background: "transparent",
    border: `1px dashed ${COLOR.border}`,
    borderRadius: 8,
    color: COLOR.textMuted,
    fontSize: 13,
    cursor: "pointer",
  };
}

export function removeBtnStyle(): CSSProperties {
  return {
    padding: "0 12px",
    background: "transparent",
    border: `1px solid ${COLOR.border}`,
    borderRadius: 8,
    color: COLOR.textMuted,
    cursor: "pointer",
  };
}
```

After extraction, update `StepHealth.tsx` imports to read from `_fields.tsx` and delete the inline primitive definitions.

- [ ] **Step 5: Run typecheck**

This will FAIL because `OnboardingWizard` imports `StepTraining`, `StepLifestyle`, `StepNutrition`, `StepSleep`, `StepGoals`, `ReviewAndAcknowledge` which don't exist yet. That's expected — you'll create them in Tasks 11-14.

For now, comment out those imports + their JSX `{step === N && (...)}` blocks so typecheck passes. Re-enable as you add each Step.

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS after stubbing.

- [ ] **Step 6: Manual smoke (optional, skip if dev server isn't already running)**

The route doesn't exist yet either (Task 15). Skip manual smoke; defer to Task 15 once the page is wired.

- [ ] **Step 7: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/onboarding/WizardNav.tsx components/onboarding/OnboardingWizard.tsx components/onboarding/StepHealth.tsx components/onboarding/_fields.tsx 2>/dev/null || true
git commit -m "feat(onboarding): wizard scaffolding + StepHealth

OnboardingWizard orchestrates 6 form steps + a review screen via local
useState (no global store needed). buildInitialIntake() merges
prior-version > derived-from-data > defaults precedence per spec.

StepHealth captures the informational health screen (PAR-Q+ style with
no gates). Pattern (Group/Toggle/Select/TextArea/Repeating helpers)
extracted to _fields.tsx for reuse by Steps 2-6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: StepTraining + StepLifestyle

**Files:**
- Create: `components/onboarding/StepTraining.tsx`
- Create: `components/onboarding/StepLifestyle.tsx`

- [ ] **Step 1: Create `StepTraining.tsx`**

Write `components/onboarding/StepTraining.tsx`:

```tsx
"use client";
import type { IntakePayload } from "@/lib/data/types";
import type { RecentE1RMs } from "@/lib/query/fetchers/recentE1RMs";
import { Group, Select, TextField, TextArea, Toggle } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["training"];

export function StepTraining({
  value, recentE1RMs, onChange, onBack, onNext, step, totalSteps, fieldErrors: _fe,
}: {
  value: V;
  recentE1RMs: RecentE1RMs;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }
  function patchEq<K extends keyof V["equipment"]>(k: K, v: V["equipment"][K]) {
    onChange({ ...value, equipment: { ...value.equipment, [k]: v } });
  }
  function patchE1RM<K extends keyof V["current_e1rm"]>(k: K, v: V["current_e1rm"][K]) {
    onChange({ ...value, current_e1rm: { ...value.current_e1rm, [k]: v } });
  }
  function patchPR<K extends keyof V["best_ever_pr"]>(k: K, v: V["best_ever_pr"][K]) {
    onChange({ ...value, best_ever_pr: { ...value.best_ever_pr, [k]: v } });
  }
  const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s) || null);

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Training history & equipment</h2>

      <Group label="Background">
        <TextField
          label="Years of consistent lifting"
          type="number"
          value={value.years_lifting}
          onChange={(s) => patch("years_lifting", Number(s) || 0)}
        />
        <Select
          label="Training-age category"
          value={value.training_age}
          onChange={(v) => patch("training_age", v)}
          options={[["beginner", "Beginner"], ["intermediate", "Intermediate"], ["advanced", "Advanced"]]}
        />
        <TextField
          label="Sessions per week"
          type="number"
          value={value.sessions_per_week}
          onChange={(s) => patch("sessions_per_week", Number(s) || 0)}
          prefilled={recentE1RMs.sessions_per_week_estimate !== null}
        />
        <TextField
          label="Typical session length (minutes)"
          type="number"
          value={value.typical_session_minutes}
          onChange={(s) => patch("typical_session_minutes", Number(s) || 0)}
        />
      </Group>

      <Group label="Equipment access">
        {[
          ["barbell", "Barbell"], ["rack", "Squat rack"], ["bench", "Bench"],
          ["dumbbells", "Dumbbells"], ["cables", "Cables"], ["machines", "Machines"],
          ["platform", "Deadlift platform"], ["ghd", "GHD"], ["sled", "Sled"],
          ["treadmill", "Treadmill"], ["rower", "Rower"], ["bike", "Bike"],
          ["kettlebells", "Kettlebells"], ["bands", "Bands"],
        ].map(([k, label]) => (
          <Toggle
            key={k}
            label={label as string}
            checked={value.equipment[k as keyof V["equipment"]] as boolean}
            onChange={(c) => patchEq(k as keyof V["equipment"], c as never)}
          />
        ))}
        <TextArea
          label="Other equipment (free-text)"
          value={value.equipment.other}
          onChange={(v) => patchEq("other", v)}
          rows={1}
        />
      </Group>

      <Group label="Current strength (e1RM)">
        <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 4 }}>
          Pre-filled from recent workouts. Adjust if the auto-detected lifts are wrong.
        </p>
        {(["squat", "bench", "deadlift", "ohp"] as const).map((lift) => (
          <TextField
            key={lift}
            label={`${lift.toUpperCase()} (kg, blank if N/A)`}
            type="number"
            value={value.current_e1rm[lift] ?? ""}
            onChange={(s) => patchE1RM(lift, numOrNull(s))}
            prefilled={recentE1RMs[lift] !== null}
          />
        ))}
      </Group>

      <Group label="Best ever PRs (optional)">
        {(["squat", "bench", "deadlift", "ohp"] as const).map((lift) => (
          <TextField
            key={lift}
            label={`${lift.toUpperCase()} all-time PR (kg, blank if N/A)`}
            type="number"
            value={value.best_ever_pr[lift] ?? ""}
            onChange={(s) => patchPR(lift, numOrNull(s))}
          />
        ))}
      </Group>

      <Group label="History">
        <TextArea
          label="Previous programs run"
          value={value.previous_programs}
          onChange={(v) => patch("previous_programs", v)}
          rows={2}
        />
        <TextArea
          label="Recent plateaus or sticking points"
          value={value.recent_plateaus}
          onChange={(v) => patch("recent_plateaus", v)}
          rows={2}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
```

- [ ] **Step 2: Create `StepLifestyle.tsx`**

Write `components/onboarding/StepLifestyle.tsx`:

```tsx
"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea, Toggle } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["lifestyle"];

export function StepLifestyle({
  value, onChange, onBack, onNext, step, totalSteps, fieldErrors: _fe,
}: {
  value: V;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }
  function patchDay(k: keyof V["days_available"], c: boolean) {
    onChange({ ...value, days_available: { ...value.days_available, [k]: c } });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Lifestyle & schedule</h2>

      <Group label="Work & life">
        <Select
          label="Job demands"
          value={value.job_demands}
          onChange={(v) => patch("job_demands", v)}
          options={[
            ["sedentary", "Sedentary (desk)"],
            ["mixed", "Mixed"],
            ["active", "Active (on feet)"],
            ["labor", "Heavy labor"],
          ]}
        />
        <TextField
          label="Commute (minutes / day total)"
          type="number"
          value={value.commute_minutes}
          onChange={(s) => patch("commute_minutes", Number(s) || 0)}
        />
        <Toggle
          label="I have dependents (kids, caregiving, etc.)"
          checked={value.has_dependents}
          onChange={(c) => patch("has_dependents", c)}
        />
        {value.has_dependents && (
          <TextArea
            label="Notes (optional — ages, schedule constraints)"
            value={value.dependent_notes}
            onChange={(v) => patch("dependent_notes", v)}
            rows={2}
          />
        )}
        <Select
          label="Average stress level (1=low, 5=high)"
          value={String(value.stress_self_rating) as "1" | "2" | "3" | "4" | "5"}
          onChange={(v) => patch("stress_self_rating", Number(v) as V["stress_self_rating"])}
          options={[["1", "1 — Low"], ["2", "2"], ["3", "3 — Moderate"], ["4", "4"], ["5", "5 — High"]]}
        />
      </Group>

      <Group label="Training availability">
        <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 4 }}>
          Which days can you realistically train?
        </p>
        {([["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"],
            ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]] as const).map(([k, label]) => (
          <Toggle key={k} label={label} checked={value.days_available[k]} onChange={(c) => patchDay(k, c)} />
        ))}
        <TextField
          label="Earliest possible session time"
          type="time"
          value={value.earliest_session_time}
          onChange={(s) => patch("earliest_session_time", s)}
        />
        <TextField
          label="Latest possible session time"
          type="time"
          value={value.latest_session_time}
          onChange={(s) => patch("latest_session_time", s)}
        />
      </Group>

      <Group label="Travel">
        <Select
          label="Travel frequency"
          value={value.travel_frequency}
          onChange={(v) => patch("travel_frequency", v)}
          options={[["none", "None"], ["rare", "Rare"], ["monthly", "Monthly"], ["weekly", "Weekly+"]]}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
```

- [ ] **Step 3: Re-enable Step 2 + Step 3 imports in `OnboardingWizard.tsx`**

Uncomment the `StepTraining` and `StepLifestyle` imports + JSX blocks you stubbed in Task 10.

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/onboarding/StepTraining.tsx components/onboarding/StepLifestyle.tsx components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): StepTraining + StepLifestyle

StepTraining: years lifting, training age, frequency + session length,
14-checkbox equipment grid, e1RM per primary lift (pre-filled from
recent workouts), all-time PRs, programs/plateaus free-text.

StepLifestyle: job demands, commute, dependents, stress rating,
days-available checkboxes, session-time window, travel frequency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: StepNutrition + StepSleep

**Files:**
- Create: `components/onboarding/StepNutrition.tsx`
- Create: `components/onboarding/StepSleep.tsx`

- [ ] **Step 1: Create `StepNutrition.tsx`**

Write `components/onboarding/StepNutrition.tsx`:

```tsx
"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["nutrition"];

export function StepNutrition({
  value, onChange, onBack, onNext, step, totalSteps, fieldErrors: _fe,
}: {
  value: V;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }
  function patchM<K extends keyof V["current_macros"]>(k: K, v: V["current_macros"][K]) {
    onChange({ ...value, current_macros: { ...value.current_macros, [k]: v } });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Nutrition baseline</h2>
      <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 12 }}>
        Pre-filled from your last 7 days of Yazio data where available. Tweak as needed.
      </p>

      <Group label="Phase">
        <Select
          label="Current diet phase"
          value={value.current_phase}
          onChange={(v) => patch("current_phase", v)}
          options={[
            ["cut", "Cut"], ["maintain", "Maintain"], ["lean_bulk", "Lean bulk"],
            ["recomp", "Recomp"], ["unsure", "Unsure"],
          ]}
        />
      </Group>

      <Group label="Daily targets">
        <TextField
          label="Calorie target (kcal/day)"
          type="number"
          value={value.current_kcal}
          onChange={(s) => patch("current_kcal", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Protein (g/day)"
          type="number"
          value={value.current_macros.protein_g}
          onChange={(s) => patchM("protein_g", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Carbs (g/day)"
          type="number"
          value={value.current_macros.carb_g}
          onChange={(s) => patchM("carb_g", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Fat (g/day)"
          type="number"
          value={value.current_macros.fat_g}
          onChange={(s) => patchM("fat_g", Number(s) || 0)}
          prefilled
        />
      </Group>

      <Group label="Tracking & restrictions">
        <Select
          label="Tracking experience"
          value={value.tracking_experience}
          onChange={(v) => patch("tracking_experience", v)}
          options={[["none", "None"], ["on_off", "On and off"], ["consistent", "Consistent"]]}
        />
        <TextArea
          label="Dietary restrictions (style + allergies + religious + intolerances)"
          value={value.restrictions}
          onChange={(v) => patch("restrictions", v)}
          rows={3}
        />
      </Group>

      <Group label="Stimulants">
        <TextField
          label="Alcohol (drinks per week)"
          type="number"
          value={value.alcohol_drinks_per_week}
          onChange={(s) => patch("alcohol_drinks_per_week", Number(s) || 0)}
        />
        <TextField
          label="Caffeine (mg per day estimate)"
          type="number"
          value={value.caffeine_mg_per_day}
          onChange={(s) => patch("caffeine_mg_per_day", Number(s) || 0)}
        />
      </Group>

      <Group label="Supplements">
        <TextArea
          label="Free-text — creatine, protein powder, vitamins, etc."
          value={value.supplements}
          onChange={(v) => patch("supplements", v)}
          rows={2}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
```

- [ ] **Step 2: Create `StepSleep.tsx`**

Write `components/onboarding/StepSleep.tsx`:

```tsx
"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["sleep_recovery"];

export function StepSleep({
  value, onChange, onBack, onNext, step, totalSteps, fieldErrors: _fe,
}: {
  value: V;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Sleep & recovery baseline</h2>
      <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 12 }}>
        Pre-filled from your last 30 days of WHOOP data where available.
      </p>

      <Group label="Sleep">
        <TextField
          label="Average sleep hours"
          type="number"
          value={value.avg_sleep_hours}
          onChange={(s) => patch("avg_sleep_hours", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Typical bedtime"
          type="time"
          value={value.typical_bedtime}
          onChange={(s) => patch("typical_bedtime", s)}
        />
        <TextField
          label="Typical wake time"
          type="time"
          value={value.typical_wake_time}
          onChange={(s) => patch("typical_wake_time", s)}
        />
        <TextField
          label="Sleep latency (min — how long to fall asleep)"
          type="number"
          value={value.sleep_latency_minutes}
          onChange={(s) => patch("sleep_latency_minutes", Number(s) || 0)}
        />
        <Select
          label="Awakenings per night"
          value={value.awakenings}
          onChange={(v) => patch("awakenings", v)}
          options={[["none", "None"], ["1_2", "1-2"], ["3_plus", "3+"]]}
        />
      </Group>

      <Group label="Recovery">
        <TextArea
          label="Mobility / flexibility work currently done (free-text)"
          value={value.mobility_work}
          onChange={(v) => patch("mobility_work", v)}
          rows={2}
        />
        <Select
          label="Soreness frequency"
          value={value.soreness_frequency}
          onChange={(v) => patch("soreness_frequency", v)}
          options={[["rare", "Rare"], ["common", "Common"], ["always", "Always"]]}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
```

- [ ] **Step 3: Re-enable Step 4 + Step 5 imports in `OnboardingWizard.tsx`**

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/onboarding/StepNutrition.tsx components/onboarding/StepSleep.tsx components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): StepNutrition + StepSleep

StepNutrition: phase, kcal/macro targets (pre-filled from Yazio),
tracking experience, restrictions, alcohol/caffeine, supplements.

StepSleep: avg hours (pre-filled from WHOOP), typical bed/wake time,
latency, awakenings, mobility work, soreness frequency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: StepGoals (with required why_narrative)

**Files:**
- Create: `components/onboarding/StepGoals.tsx`

- [ ] **Step 1: Create `StepGoals.tsx`**

Write `components/onboarding/StepGoals.tsx`:

```tsx
"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["goals"];

export function StepGoals({
  value, onChange, onBack, onNext, nextLabel, nextDisabled, step, totalSteps, fieldErrors,
}: {
  value: V;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }

  const whyError = fieldErrors["goals.why_narrative"];
  const whyTooShort = value.why_narrative.trim().length < 10;

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Your goal</h2>
      <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 12 }}>
        One primary goal. The &quot;why&quot; matters as much as the metric — say it in your own words.
      </p>

      <Group label="What kind of goal">
        <Select
          label="Primary goal type"
          value={value.primary_type}
          onChange={(v) => patch("primary_type", v)}
          options={[
            ["strength", "Strength"],
            ["body_comp", "Body composition"],
            ["performance", "Performance / endurance"],
            ["health", "Health"],
          ]}
        />
      </Group>

      <Group label="Target">
        <TextField
          label="Primary metric (e.g., &quot;deadlift e1RM&quot;, &quot;body fat %&quot;, &quot;5K time&quot;)"
          type="text"
          value={value.primary_metric}
          onChange={(s) => patch("primary_metric", s)}
        />
        <TextField
          label="Target value"
          type="number"
          value={value.target_value}
          onChange={(s) => patch("target_value", Number(s) || 0)}
        />
        <TextField
          label="Unit (kg, %, min:sec, etc.)"
          type="text"
          value={value.target_unit}
          onChange={(s) => patch("target_unit", s)}
        />
        <TextField
          label="Target date"
          type="date"
          value={value.target_date}
          onChange={(s) => patch("target_date", s)}
        />
      </Group>

      <Group label="Why this goal? What does success look like?">
        <TextArea
          label="(required — at least one sentence)"
          value={value.why_narrative}
          onChange={(v) => patch("why_narrative", v)}
          rows={5}
        />
        {(whyError || (whyTooShort && value.why_narrative.length > 0)) && (
          <span style={{ fontSize: 12, color: "var(--color-danger, #dc3c3c)" }}>
            {whyError ?? "Add a sentence or two — what's behind this goal?"}
          </span>
        )}
      </Group>

      <WizardNav
        step={step}
        totalSteps={totalSteps}
        onBack={onBack}
        onNext={onNext}
        nextLabel={nextLabel ?? "Review profile"}
        nextDisabled={(nextDisabled ?? false) || whyTooShort}
      />
    </section>
  );
}
```

- [ ] **Step 2: Re-enable Step 6 import in `OnboardingWizard.tsx`**

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/onboarding/StepGoals.tsx components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): StepGoals with required why_narrative

Captures primary_type/metric/target_value/unit/target_date. Goes
beyond the typical SMART form with a required why_narrative textarea
(min 10 chars enforced client-side, mirrored by Zod server-side). The
why is what gives the AI context for honest progress framing later.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: ReviewAndAcknowledge with inline edit

**Files:**
- Create: `components/onboarding/ReviewAndAcknowledge.tsx`

- [ ] **Step 1: Create the component**

Write `components/onboarding/ReviewAndAcknowledge.tsx`:

```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import type { IntakePayload } from "@/lib/data/types";
import { renderProfileMarkdown } from "@/lib/coach/profile-renderer";
import { acknowledgeDraft, discardDraft } from "@/app/onboarding/actions";

export function ReviewAndAcknowledge({
  intake,
  draftId,
  version,
  supersedesVersion,
  onBack,
  onAcknowledged,
}: {
  intake: IntakePayload;
  draftId: string;
  version: number;
  supersedesVersion: number | null;
  onBack: () => void;
  onAcknowledged: () => void;
}) {
  const queryClient = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const [autoMd, setAutoMd] = useState("");
  const [editedMd, setEditedMd] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Auto-render whenever the intake changes (deterministic, runs in browser).
  useEffect(() => {
    const md = renderProfileMarkdown(intake, version, null, supersedesVersion);
    setAutoMd(md);
    if (!editMode) setEditedMd(md); // keep edited in sync until user enters edit mode
  }, [intake, version, supersedesVersion, editMode]);

  function resetToAuto() {
    setEditedMd(autoMd);
  }

  function handleAcknowledge() {
    setError(null);
    const finalMd = editMode ? editedMd : autoMd;
    startTransition(async () => {
      const r = await acknowledgeDraft(draftId, finalMd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Invalidate all athleteProfile cache for this user-scope.
      queryClient.invalidateQueries({ queryKey: ["athlete-profile"] });
      onAcknowledged();
    });
  }

  function handleDiscard() {
    if (!confirm("Discard this draft? You can start over from /profile.")) return;
    startTransition(async () => {
      const r = await discardDraft(draftId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["athlete-profile"] });
      onAcknowledged();
    });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Review & acknowledge</h2>
      <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 12 }}>
        This is what your athlete profile v{version} will look like. The text below is what gets frozen
        — once you acknowledge, this version is byte-stable forever and visible in /profile. You can
        edit the markdown directly if anything reads off.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          style={toggleBtnStyle(editMode)}
        >
          {editMode ? "Hide editor" : "Edit draft"}
        </button>
        {editMode && (
          <button type="button" onClick={resetToAuto} style={toggleBtnStyle(false)}>
            Reset to auto-rendered
          </button>
        )}
      </div>

      {!editMode ? (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "rgba(255, 255, 255, 0.03)",
            border: `1px solid ${COLOR.border}`,
            borderRadius: 10,
            padding: 14,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: "DM Mono, ui-monospace, monospace",
            color: COLOR.text,
            maxHeight: 400,
            overflowY: "auto",
          }}
        >{autoMd}</pre>
      ) : (
        <textarea
          value={editedMd}
          onChange={(e) => setEditedMd(e.target.value)}
          rows={20}
          style={{
            width: "100%",
            background: "rgba(255, 255, 255, 0.03)",
            border: `1px solid ${COLOR.border}`,
            borderRadius: 10,
            padding: 14,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: "DM Mono, ui-monospace, monospace",
            color: COLOR.text,
            resize: "vertical",
          }}
        />
      )}

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "rgba(220, 60, 60, 0.1)",
            border: `1px solid ${COLOR.danger ?? "#dc3c3c"}`,
            borderRadius: 8,
            color: COLOR.danger ?? "#dc3c3c",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 24, flexWrap: "wrap" }}>
        <button type="button" onClick={onBack} disabled={isPending} style={secondaryBtnStyle()}>
          Back
        </button>
        <button type="button" onClick={handleDiscard} disabled={isPending} style={dangerBtnStyle()}>
          Discard draft
        </button>
        <button
          type="button"
          onClick={handleAcknowledge}
          disabled={isPending}
          style={primaryBtnStyle(isPending)}
        >
          {isPending ? "Acknowledging…" : "Acknowledge profile"}
        </button>
      </div>
    </section>
  );
}

function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    background: active ? COLOR.accent : "transparent",
    border: `1px solid ${active ? COLOR.accent : COLOR.border}`,
    borderRadius: 8,
    color: active ? "#fff" : COLOR.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function primaryBtnStyle(isPending: boolean): React.CSSProperties {
  return {
    flex: 2,
    minWidth: 200,
    padding: "12px 16px",
    background: isPending ? COLOR.border : COLOR.accent,
    border: "none",
    borderRadius: 10,
    color: "#fff",
    fontWeight: 700,
    cursor: isPending ? "not-allowed" : "pointer",
  };
}

function secondaryBtnStyle(): React.CSSProperties {
  return {
    padding: "12px 16px",
    background: "transparent",
    border: `1px solid ${COLOR.border}`,
    borderRadius: 10,
    color: COLOR.textMuted,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function dangerBtnStyle(): React.CSSProperties {
  return {
    padding: "12px 16px",
    background: "transparent",
    border: `1px solid ${COLOR.danger ?? "#dc3c3c"}`,
    borderRadius: 10,
    color: COLOR.danger ?? "#dc3c3c",
    fontWeight: 600,
    cursor: "pointer",
  };
}
```

- [ ] **Step 2: Re-enable the ReviewAndAcknowledge import in `OnboardingWizard.tsx`**

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

If typecheck flags `COLOR.danger` as not existing on the theme, replace `COLOR.danger ?? "#dc3c3c"` with the literal `"#dc3c3c"` everywhere in this file (and check the theme exports — Phase 1 doesn't add new theme tokens).

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/onboarding/ReviewAndAcknowledge.tsx components/onboarding/OnboardingWizard.tsx
git commit -m "feat(onboarding): ReviewAndAcknowledge with inline edit

Renders the deterministic profile markdown from the current intake_payload
(via lib/coach/profile-renderer in the browser — pure function).
Provides three actions:
  - Edit draft: toggle to a textarea so the user can patch the rendered
    markdown directly before acknowledging (the spec's escape hatch for
    cases where auto-render needs a touch-up the form can't express)
  - Discard draft: flips status='discarded' via server action
  - Acknowledge profile: calls acknowledgeDraft with the (possibly
    edited) markdown, atomic draft→active + supersede prior

After ack, invalidates the athlete-profile cache prefix so /profile
shows the new version on next render.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: `/onboarding` route (page + loading)

**Files:**
- Create: `app/onboarding/page.tsx`
- Create: `app/onboarding/loading.tsx`

- [ ] **Step 1: Create the loading skeleton**

Write `app/onboarding/loading.tsx`:

```tsx
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <div style={{ height: 12, width: 100, background: "rgba(255,255,255,0.05)", borderRadius: 4 }} />
      <div style={{ height: 28, width: "60%", background: "rgba(255,255,255,0.06)", borderRadius: 6, marginTop: 8 }} />
      <div style={{ height: 4, width: "100%", background: "rgba(255,255,255,0.05)", borderRadius: 4, marginTop: 14 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ height: 60, background: "rgba(255,255,255,0.04)", borderRadius: 8 }} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the page**

Write `app/onboarding/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchRecentE1RMsServer } from "@/lib/query/fetchers/recentE1RMs";
import { fetchActiveProfileServer, fetchDraftProfileServer, fetchProfileByIdServer } from "@/lib/query/fetchers/athleteProfile";
import { OnboardingWizard, type WizardPrefill } from "@/components/onboarding/OnboardingWizard";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function OnboardingPage(props: {
  searchParams: Promise<{ revise?: string }>;
}) {
  const { revise } = await props.searchParams;

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = todayInUserTz();

  // 30-day window for nutrition / sleep avgs.
  const thirtyAgo = new Date(`${today}T00:00:00Z`);
  thirtyAgo.setUTCDate(thirtyAgo.getUTCDate() - 30);
  const fromDate = thirtyAgo.toISOString().slice(0, 10);

  const [profile, recentLogs, recentE1RMs, existingDraft, activeDoc, reviseDoc] = await Promise.all([
    fetchProfileServer(supabase, user.id),
    fetchDailyLogsServer(supabase, user.id, fromDate, today),
    fetchRecentE1RMsServer(supabase, user.id, today),
    fetchDraftProfileServer(supabase, user.id),
    fetchActiveProfileServer(supabase, user.id),
    revise ? fetchProfileByIdServer(supabase, user.id, revise) : Promise.resolve(null),
  ]);

  // Determine version + prior intake for pre-fill.
  // Priority: existing draft (resume) wins; else if ?revise=<id> matches a non-discarded version,
  // use that as priorIntake; else if active exists, use active as priorIntake (revision flow).
  const priorIntake =
    existingDraft?.intake_payload ??
    reviseDoc?.intake_payload ??
    activeDoc?.intake_payload ??
    null;

  // next_version = max(version) + 1; supersedes_version = active.version (if any)
  // Quick recompute (no extra round-trip; we have the data)
  const knownVersions = [
    existingDraft?.version,
    reviseDoc?.version,
    activeDoc?.version,
  ].filter((v): v is number => typeof v === "number");
  // Fall back to a max-version query for a fully-clean account or a user with
  // discarded drafts whose versions still count.
  let nextVersion: number;
  if (existingDraft) {
    nextVersion = existingDraft.version;
  } else {
    const { data: maxRow } = await supabase
      .from("athlete_profile_documents")
      .select("version")
      .eq("user_id", user.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    nextVersion = (((maxRow?.version as number | undefined) ?? 0)) + 1;
  }

  const supersedesVersion = activeDoc?.version ?? null;

  const prefill: WizardPrefill = {
    profile: profile ? {
      name: profile.name ?? null,
      age: profile.age ?? null,
      height_cm: profile.height_cm ?? null,
    } : null,
    recentLogs,
    recentE1RMs,
    priorIntake,
    existingDraft,
    nextVersion,
    supersedesVersion,
  };

  return (
    <main style={{ minHeight: "100dvh" }}>
      <OnboardingWizard prefill={prefill} userId={user.id} />
    </main>
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. If `fetchProfileServer` doesn't exist at the expected path, find it via `grep -rn "fetchProfileServer" lib/query/fetchers/` and update the import path. Same for any other server fetcher that's been renamed.

- [ ] **Step 4: Manual smoke**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run dev
```

Visit `http://localhost:3000/onboarding`. Expected:

1. Loading skeleton flashes briefly.
2. Step 1 (Health & medical) renders with: Conditions checklist, joint-surgeries repeating rows, medications/recent illness/restrictions/allergies textareas, and Next button (Back disabled).
3. Click Next → Step 2 (Training) — current e1RMs pre-filled (or empty if no recent workouts), sessions/week pre-filled. ↻ "from latest data" badges visible on pre-filled fields.
4. Continue Next → Steps 3, 4, 5, 6. Step 6's Next button disabled until ≥ 10 chars in why_narrative.
5. Click "Review profile" on Step 6 → server action runs, redirects to Review screen.
6. Review screen shows the deterministic markdown. Toggle "Edit draft" — textarea appears with same content. Click "Reset to auto-rendered" — restored.
7. Click "Acknowledge profile" → success → redirected to /profile.

If any step renders blank or throws, check the browser console + the server logs in the dev terminal. Most likely culprits: a missing import, a Zod field requirement that the default state doesn't satisfy, or a `.tsx` file with a typo in JSX.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add app/onboarding/page.tsx app/onboarding/loading.tsx
git commit -m "feat(onboarding): /onboarding route (page + loading)

Server component gates auth, parallel-fetches pre-fill data (profile +
last 30d logs + recent e1RMs + existing draft + active doc + optional
?revise=<id> doc), assembles WizardPrefill, hands off to the client
OnboardingWizard.

dynamic='force-dynamic' because the page reads per-user state on every
visit; SSR caching would surface stale draft state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: AthleteProfilePanel + ViewModal + History

**Files:**
- Create: `components/profile/AthleteProfilePanel.tsx`
- Create: `components/profile/AthleteProfileViewModal.tsx`
- Create: `components/profile/AthleteProfileHistory.tsx`

- [ ] **Step 1: Create `AthleteProfileViewModal.tsx`**

Write `components/profile/AthleteProfileViewModal.tsx`:

```tsx
"use client";
import { COLOR } from "@/lib/ui/theme";

export function AthleteProfileViewModal({
  rendered_md,
  onClose,
  title,
}: {
  rendered_md: string;
  onClose: () => void;
  title: string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLOR.bg ?? "#0a0a0a",
          border: `1px solid ${COLOR.border}`,
          borderRadius: 14,
          padding: 18,
          maxWidth: 640,
          width: "100%",
          maxHeight: "90dvh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: COLOR.textMuted,
              fontSize: 24,
              lineHeight: 1,
              cursor: "pointer",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontFamily: "DM Mono, ui-monospace, monospace",
            fontSize: 13,
            lineHeight: 1.6,
            color: COLOR.text,
            overflowY: "auto",
            margin: 0,
          }}
        >{rendered_md}</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `AthleteProfileHistory.tsx`**

Write `components/profile/AthleteProfileHistory.tsx`:

```tsx
"use client";
import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import type { AthleteProfileDocument } from "@/lib/data/types";
import { AthleteProfileViewModal } from "@/components/profile/AthleteProfileViewModal";

export function AthleteProfileHistory({ docs }: { docs: AthleteProfileDocument[] }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<AthleteProfileDocument | null>(null);

  // Show only superseded versions (active is shown in the main panel).
  const superseded = docs.filter((d) => d.status === "superseded");

  if (superseded.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: `1px solid ${COLOR.border}`,
          borderRadius: 8,
          padding: "8px 12px",
          color: COLOR.textMuted,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
      >
        {open ? "▾" : "▸"} Version history ({superseded.length})
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {superseded.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setViewing(d)}
              style={{
                background: "transparent",
                border: `1px solid ${COLOR.border}`,
                borderRadius: 8,
                padding: "10px 12px",
                color: COLOR.text,
                fontSize: 13,
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>v{d.version}</span>
              <span style={{ color: COLOR.textMuted, fontSize: 12 }}>
                {d.acknowledged_at?.slice(0, 10) ?? "—"}
              </span>
            </button>
          ))}
        </div>
      )}

      {viewing && viewing.rendered_md && (
        <AthleteProfileViewModal
          rendered_md={viewing.rendered_md}
          title={`Athlete profile v${viewing.version}`}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Create `AthleteProfilePanel.tsx`**

Write `components/profile/AthleteProfilePanel.tsx`:

```tsx
"use client";
import Link from "next/link";
import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { Card } from "@/components/ui/Card";
import type { AthleteProfileDocument } from "@/lib/data/types";
import { AthleteProfileViewModal } from "@/components/profile/AthleteProfileViewModal";
import { AthleteProfileHistory } from "@/components/profile/AthleteProfileHistory";
import { useAthleteProfile } from "@/lib/query/hooks/useAthleteProfile";
import { useAthleteProfileHistory } from "@/lib/query/hooks/useAthleteProfileHistory";
import { useAthleteProfileDraft } from "@/lib/query/hooks/useAthleteProfileDraft";

export function AthleteProfilePanel({ userId }: { userId: string }) {
  const { data: active, isLoading: loadingActive } = useAthleteProfile(userId);
  const { data: history = [] } = useAthleteProfileHistory(userId);
  const { data: draft } = useAthleteProfileDraft(userId);
  const [viewing, setViewing] = useState<AthleteProfileDocument | null>(null);

  if (loadingActive) {
    return <Card style={{ height: 80, background: "rgba(255,255,255,0.04)" }} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {draft && draft.id !== active?.id && (
        <Card variant="compact" style={{ borderColor: COLOR.accent }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Draft in progress</div>
              <div style={{ fontSize: 11, color: COLOR.textMuted }}>
                Started {draft.created_at.slice(0, 10)}
              </div>
            </div>
            <Link
              href={draft.id ? `/onboarding` : "/onboarding"}
              style={{
                padding: "6px 12px",
                background: COLOR.accent,
                color: "#fff",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Resume
            </Link>
          </div>
        </Card>
      )}

      {!active ? (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Set up your athlete profile</div>
            <div style={{ fontSize: 12, color: COLOR.textMuted }}>
              A 6-step intake captures your medical history, equipment, lifestyle, goals, and baselines.
              The coach uses this as durable context on every reply.
            </div>
            <Link
              href="/onboarding"
              style={{
                marginTop: 4,
                padding: "10px 14px",
                background: COLOR.accent,
                color: "#fff",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                textDecoration: "none",
                textAlign: "center",
              }}
            >
              Get started
            </Link>
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                Athlete profile <span style={{ color: COLOR.textMuted, fontWeight: 500 }}>v{active.version}</span>
              </div>
              <div style={{ fontSize: 11, color: COLOR.textMuted }}>
                Acknowledged {active.acknowledged_at?.slice(0, 10) ?? "—"}
              </div>
            </div>

            <div style={{ fontSize: 12, color: COLOR.textMuted }}>
              {summarizeGoal(active)}
            </div>

            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button type="button" onClick={() => setViewing(active)} style={btn("secondary")}>
                View
              </button>
              <Link href={`/onboarding?revise=${active.id}`} style={btn("primary") as React.CSSProperties as never}>
                Revise
              </Link>
            </div>
          </div>
        </Card>
      )}

      {history.length > 1 && <AthleteProfileHistory docs={history} />}

      {viewing && viewing.rendered_md && (
        <AthleteProfileViewModal
          rendered_md={viewing.rendered_md}
          title={`Athlete profile v${viewing.version}`}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function summarizeGoal(d: AthleteProfileDocument): string {
  const g = d.intake_payload.goals;
  return `Goal: ${g.primary_metric} → ${g.target_value}${g.target_unit} by ${g.target_date}`;
}

function btn(variant: "primary" | "secondary"): React.CSSProperties {
  if (variant === "primary") {
    return {
      padding: "8px 12px",
      background: COLOR.accent,
      color: "#fff",
      borderRadius: 8,
      fontSize: 12,
      fontWeight: 700,
      textDecoration: "none",
      border: "none",
      cursor: "pointer",
      display: "inline-block",
    };
  }
  return {
    padding: "8px 12px",
    background: "transparent",
    color: COLOR.text,
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${COLOR.border}`,
    cursor: "pointer",
    textDecoration: "none",
  };
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. If `Card` import path differs, find it via `grep -rn "export.*Card" components/ui/`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/profile/AthleteProfilePanel.tsx components/profile/AthleteProfileViewModal.tsx components/profile/AthleteProfileHistory.tsx
git commit -m "feat(profile): AthleteProfilePanel + ViewModal + History

Three components for the /profile integration:
  - AthleteProfilePanel: top-level — renders 'Set up' CTA when no active
    doc, or active card (View / Revise actions, goal one-liner) when one
    exists. Shows 'Draft in progress' banner if user has an open draft
    that's not the active doc.
  - AthleteProfileViewModal: full-screen modal rendering frozen
    rendered_md as preformatted text. Click backdrop or ✕ to close.
  - AthleteProfileHistory: collapsible list of superseded versions,
    each clickable to open ViewModal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: `/profile` page integration

**Files:**
- Modify: `app/profile/page.tsx`
- Modify: `components/profile/ProfileClient.tsx`

- [ ] **Step 1: Extend `app/profile/page.tsx` to prefetch athlete profile data**

Open `app/profile/page.tsx` and add three prefetches inside the existing `Promise.all`:

```ts
import { fetchActiveProfileServer, fetchProfileHistoryServer, fetchDraftProfileServer } from "@/lib/query/fetchers/athleteProfile";

// ...inside the existing Promise.all([...]) block, append:
queryClient.prefetchQuery({
  queryKey: queryKeys.athleteProfile.active(user.id),
  queryFn: () => fetchActiveProfileServer(supabase, user.id),
}),
queryClient.prefetchQuery({
  queryKey: queryKeys.athleteProfile.history(user.id),
  queryFn: () => fetchProfileHistoryServer(supabase, user.id),
}),
queryClient.prefetchQuery({
  queryKey: queryKeys.athleteProfile.draft(user.id),
  queryFn: () => fetchDraftProfileServer(supabase, user.id),
}),
```

The full updated file should have these three new entries inside the existing `await Promise.all([...])`. No other changes to the page.

- [ ] **Step 2: Insert AthleteProfilePanel into `ProfileClient.tsx`**

Open `components/profile/ProfileClient.tsx`. Add the import:

```ts
import { AthleteProfilePanel } from "@/components/profile/AthleteProfilePanel";
```

Then add a new section between "Profile details" and "Connected sources". Find this block:

```tsx
      <SectionLabel>Connected sources</SectionLabel>
```

And **directly above** it, insert:

```tsx
      <SectionLabel>Coaching plan</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <AthleteProfilePanel userId={userId} />
      </div>

```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run dev
```

Visit `/profile`. Expected:

1. With no active doc: "Coaching plan" section shows a "Set up your athlete profile" card with a "Get started" link.
2. Click "Get started" → navigates to `/onboarding`. Complete the wizard.
3. After acknowledge, redirected back to `/profile`. The "Coaching plan" section now shows the active card (v1, acknowledged today, goal summary, View + Revise buttons).
4. Click View → modal opens with the frozen `rendered_md`.
5. Click Revise → navigates to `/onboarding?revise=<id>`. Form is pre-filled from v1's intake. Change one field, complete the wizard, acknowledge.
6. Back on /profile: shows v2 active. "Version history (1)" toggle appears. Click → v1 listed. Click v1 → modal shows v1's frozen markdown.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add app/profile/page.tsx components/profile/ProfileClient.tsx
git commit -m "feat(profile): wire AthleteProfilePanel into /profile

Prefetches active doc, version history, and any open draft on the
server so AthleteProfilePanel renders synchronously from the cache.
Inserts the new 'Coaching plan' section between 'Profile details' and
'Connected sources' per spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Snapshot integration + system prompts + end-to-end verification

**Files:**
- Modify: `lib/coach/snapshot.ts`
- Modify: `lib/coach/system-prompts.ts`

- [ ] **Step 1: Extend `lib/coach/snapshot.ts` to inject the athlete-profile section**

Open `lib/coach/snapshot.ts`. Add the import:

```ts
import { renderProfileSummary } from "@/lib/coach/profile-renderer";
import type { IntakePayload } from "@/lib/data/types";
```

Inside `buildSnapshot`, after the existing `Promise.all([{ data: profile }, { data: logs }, allWorkouts])` block, add a parallel fetch for the active athlete profile:

```ts
  const { data: athleteProfileRow } = await supabase
    .from("athlete_profile_documents")
    .select("version, intake_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
```

(You can fold this into the existing `Promise.all` for better parallelism. Either is fine.)

Then in the body assembly (the array passed to `[...].join("\n")`), insert the new section **before** the `DAILY LOGS (...)` line:

```ts
  const athleteProfileBlock = athleteProfileRow
    ? `\n${renderProfileSummary(athleteProfileRow.intake_payload as IntakePayload, athleteProfileRow.version as number)}\n`
    : "";

  const body = [
    `ATHLETE: ${p?.name ?? "Athlete"}. GOAL: "${p?.goal ?? "general health"}".`,
    `BASELINES: ${JSON.stringify(p?.whoop_baselines ?? {})}`,
    `TRAINING PLAN: ${JSON.stringify(p?.training_plan ?? {})}`,
    athleteProfileBlock,
    ``,
    `DAILY LOGS (${since} → ${until ?? today}):`,
    logLines || `  (no logs in window)`,
    ``,
    `RECENT WORKOUTS (most recent first):`,
    workoutLines || `  (no workouts)`,
  ].join("\n");
```

- [ ] **Step 2: Update `SCHEMA_EXPLAINER` in `lib/coach/system-prompts.ts`**

Find the `## Snapshot prefix (cached, ~14 days)` paragraph in `SCHEMA_EXPLAINER`. Add a new paragraph after it:

```
## Athlete profile (cached, in snapshot prefix)
When present in your context, this is the athlete's currently-acknowledged profile — medical history, equipment, lifestyle, goal narrative, nutrition + sleep baselines. The athlete explicitly accepted this version. Reference it directly when relevant ("given your shoulder restriction, skip OHP" / "your goal is deadlift e1RM 220 by August"). Don't recite the profile contents back at the athlete; they have it open in /profile. In Phase 2, this section will also include an AI-generated coaching plan with prescribed targets.
```

- [ ] **Step 3: Update `DEFAULT_SYSTEM_PROMPT` in the same file**

Append a new paragraph to `DEFAULT_SYSTEM_PROMPT`:

```
When an "Athlete profile" section exists in your context, treat it as durable context — the user's medical history, equipment, schedule, goal narrative, and baselines are stable across the conversation. Use this context naturally when advising. Don't repeat the profile contents back at the user; they have it open in /profile. If you notice the goal in the profile has clearly drifted from the user's current behavior (target says 220kg deadlift but they're chasing a 5K time), name the drift in one sentence and suggest revising the profile via the Revise button in /profile.
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Manual coach smoke**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run dev
```

With an active athlete profile in place, visit `/coach` and ask: *"What should I focus on this week?"*

Expected: the response naturally references your goal narrative, equipment context, or training-age — without you mentioning them. For example, if your profile says "intermediate, 4x/wk, deadlift focus, no overhead pressing > 60kg," the coach might say *"Given your deadlift focus and ≤60kg overhead restriction, I'd weight this week toward..."* — that's the integration working.

If the response still feels generic and doesn't reference profile context, debug by adding a temporary log in `buildSnapshot` to print the `body` string and verify the `## Athlete profile (...)` section is present.

- [ ] **Step 6: Run the full manual verification checklist from the spec**

Cross-reference [docs/superpowers/specs/2026-05-10-athlete-profile-phase-1-design.md](../specs/2026-05-10-athlete-profile-phase-1-design.md) §"Verification" — work through items 1-11. Issues found here are bugs to fix before merging.

Specifically validate:

1. **Cold start:** /profile shows "Set up" CTA with no rows in the table.
2. **Pre-fill works:** Step 2 has e1RMs filled from workouts; Step 4 has kcal/macros from Yazio; Step 5 has avg sleep from WHOOP.
3. **Validation surfaces field-level errors:** intentionally enter an invalid time format on Step 3 → submit → field error appears (would only surface from server-side Zod since client doesn't pre-validate; if ergonomics suffers add lightweight client validation later).
4. **Edit-before-ack works:** Review screen → Edit draft → modify text → Acknowledge → /profile View shows your edited text (not the auto-rendered).
5. **Revision creates v2:** Revise → edit one field → Acknowledge → v2 active, v1 superseded. SQL spot check: `select id, version, status, superseded_at, superseded_by from athlete_profile_documents where user_id = '<id>' order by version`.
6. **Version history visible:** History toggle on /profile shows v1; clicking opens v1's frozen markdown.
7. **Discard flow:** start a v3 draft, abandon mid-wizard, return to /profile → "Draft in progress" banner. Click into wizard, click "Discard draft" on Review screen → banner gone.
8. **Coach reads profile:** chat smoke from Step 5.
9. **Schema constraints:** attempt to insert two `status='active'` rows for same user via SQL editor → unique violation. Same for two `status='draft'`.
10. **RLS isolation:** sign in as a hypothetical second user (or impersonate via service role) → queries return zero rows for first user's data.
11. **Cache invalidation:** after acknowledging v2, the next `/coach` chat turn references v2 (not v1). Add a temporary log to confirm if uncertain.

- [ ] **Step 7: Update CLAUDE.md "Coach / AI" section**

Open `CLAUDE.md`, find the "Coach / AI" section. Add a new bullet after the existing ones:

```
- **Athlete profile (Phase 1)**: `athlete_profile_documents` is the durable client file — medical history, equipment, lifestyle, goal narrative, nutrition + sleep baselines, all captured via the 6-step `/onboarding` wizard. Acknowledged versions are immutable; revisions create v2/v3/etc. with the prior version superseded. The active version's summary is injected into the coach AI's snapshot prefix via `renderProfileSummary` in [lib/coach/profile-renderer.ts](lib/coach/profile-renderer.ts). Phase 2 will add AI plan generation (prescriptions for sleep/nutrition/strength) on top.
```

- [ ] **Step 8: Final commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/snapshot.ts lib/coach/system-prompts.ts CLAUDE.md
git commit -m "feat(coach): inject athlete profile into snapshot prefix

The active athlete_profile_documents row's intake_payload is condensed
via renderProfileSummary and inserted into the cached snapshot body
between the BASELINES line and DAILY LOGS. Omitted entirely when no
active doc exists — backwards-compatible for users who haven't
onboarded yet.

SCHEMA_EXPLAINER documents the new section. DEFAULT_SYSTEM_PROMPT gets
one paragraph instructing the AI to use the profile context naturally,
not recite it back, and to flag clear plan/reality drift in one
sentence (mild Phase 1 form of drift detection — Phase 3 expands).

End-to-end manually verified per spec §Verification checklist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Push branch and open PR**

```bash
cd "/Users/abdelouahedelbied/Health app"
git push -u origin feat/athlete-profile-phase-1
gh pr create --title "feat: athlete profile Phase 1 (intake + acknowledgment + snapshot integration)" --body "$(cat <<'EOF'
Implements Phase 1 of the Athlete Profile + Coaching Plan feature per
[docs/superpowers/specs/2026-05-10-athlete-profile-phase-1-design.md](docs/superpowers/specs/2026-05-10-athlete-profile-phase-1-design.md).

## What ships
- 6-step `/onboarding` form wizard (health, training, lifestyle, nutrition, sleep, goals) with heavy pre-fill from existing data
- `athlete_profile_documents` table (forward-compatible — Phase 2 columns nullable from day 1)
- Versioned, immutable acknowledgment ceremony with inline edit-before-ack escape hatch
- `/profile` panel: active card + revise + view + version history modal
- Coach AI consumes condensed profile summary via cached snapshot prefix; default-mode replies naturally reference athlete context

## What's deferred
- **Phase 2** (AI plan generation): chat intake mode, propose_plan/commit_plan tools, plan-builder, prescription sections
- **Phase 3** (drift detection + stale nudges): /profile stale badge, setup_block pre-flight, training_blocks FK

## Verification
Manual checklist completed per spec §Verification. No automated test runner in this codebase.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

After completing all 18 tasks, review against the spec:

**1. Spec coverage** — every spec section is covered:
- Schema (§Schema in spec) → Task 1
- Form wizard 6 steps (§Form wizard) → Tasks 10–13
- Pre-fill from existing data (§Pre-fill) → Tasks 8 + 15
- Profile renderer (§Profile renderer) → Task 4
- Acknowledgment flow & state machine (§Acknowledgment flow) → Tasks 9 + 14
- Revision flow (§Revision flow) → Tasks 9 + 14 + 15 (`?revise=<id>` handling)
- AI integration (§AI integration) → Task 18
- UI placement (§UI placement) → Tasks 15 + 16 + 17
- Files to create/modify (§Files) → all 24 created + 5 modified across tasks
- Verification (§Verification) → Task 18 Step 6

**2. Placeholder scan** — none of the writing-plans skill's red-flag patterns are present. Every step has actual code or actual commands. Edge cases (CSS color tokens not on theme, server-fetcher path differences) are handled inline ("if X, fall back to Y") so the implementer never hits an undefined dependency.

**3. Type consistency** — `IntakePayload` shape (Task 2) is used identically across:
- `IntakePayloadSchema` (Task 3, Zod)
- `renderProfileMarkdown` / `renderProfileSummary` (Task 4)
- Server actions (Task 9)
- Wizard step components (Tasks 10–13)
- Review component (Task 14)
- Snapshot integration (Task 18)

`AthleteProfileDocument`, `AthleteProfileStatus`, and `RecentE1RMs` likewise consistent across the dependent tasks.

---

## Phase 1 → Phase 2 design constraints (preserved here for the next planner)

- IntakePayload schema_version: 1 — Phase 2 may bump to 2 after adding chat-elicited slots; provide a migration helper in `lib/coach/profile-renderer.ts` if doing so
- Phase 2's revision flow MUST clear chat-elicited fields (`goal_narrative_chat`, `coaching_preferences`, `free_form_constraints`) when starting a new draft, while form-elicited fields carry forward
- Phase 2's plan-builder is the deterministic skeleton; the AI's `propose_plan` only adjusts/narrates
- Phase 2's per-slot tools are clearer for the AI than dot-path enums (set_goal_narrative, set_directness, set_cadence, etc.)
- `plan_payload` jsonb shape is defined in spec §"Typed shape of plan_payload" — implement that exactly when Phase 2 starts
