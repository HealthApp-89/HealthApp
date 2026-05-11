# Morning Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the end of every morning intake, replace the existing free-text coach recommendation with a structured "brief card" containing yesterday's recap, today's readiness band, today's session details (exercises × weights × reps), macro targets, AI-generated eating/coaching advice, and tonight's sleep target.

**Architecture:** Deterministic templated rendering for structured data (recap stats, session list, macros, tonight); single Anthropic Haiku 4.5 call (~$0.0005/morning) for the prose "Advice" block. Coaching adaptations (GLP-1 hunger cues, alcohol, injuries, sleep efficiency, missed protein) are pre-computed as 5 typed flags in TS code, not in the AI prompt. State machine extends `0007_morning_intake.sql` with `assembling_brief`, `brief_delivered`, `brief_failed`. Strict 1-per-day idempotency via `checkins.intake_state`. REST day renders recovery-focus variant. Replaces the existing SSE-streaming `recommendation/route.ts` with a JSON-returning structured-brief route. ChatPanel routes `kind='morning_brief'` messages to a new structured card component.

**Tech Stack:** Next.js 15 App Router, Supabase (RLS-respecting server client), TanStack Query for client cache, Anthropic via existing `lib/anthropic/client.ts` wrapper (Haiku 4.5), no new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-11-morning-brief-design.md](../specs/2026-05-11-morning-brief-design.md)

**Verification posture:** This codebase has no test runner (per CLAUDE.md). Each task ends with `npm run typecheck` plus targeted manual checks. Pure modules (`flags.ts`, `assembler.ts`, `advice-prompt.ts`) are exercised via one-shot probe scripts (`scripts/probe-*.mjs`) that print known-input/known-output pairs for visual confirmation; scripts are deleted after verification (not committed) since the codebase has no `tests/` directory.

**Migration number:** `0011_morning_brief.sql` — sequential after `0010_athlete_profile.sql`.

**Branching:** Implementer creates `feat/morning-brief` from `main` after merging the spec docs branch (`docs/morning-brief-spec`). Commits land on `feat/morning-brief` per task.

---

## Spec-vs-actual reconciliation

The spec's "Route handler integration" section says to modify `app/api/chat/morning/intake/route.ts`. **This is wrong.** The pre-implementation audit found:

- `intake/route.ts` is the slot-filling state machine endpoint (chip answer writes, sick declarations, free-text tail). It does NOT generate the post-intake AI output.
- `recommendation/route.ts` is what generates the post-intake AI output — currently writes a free-text coach message via SSE streaming and transitions `intake_state` to `'delivered'`. This is the route the brief replaces.

The plan implements the spec's intent (post-intake structured brief) by modifying `recommendation/route.ts`, not `intake/route.ts`. The spec doc itself stays unchanged; the route name shift is a pre-implementation correction documented here.

**Sick-path handling** (not addressed in spec, decision documented here): when `checkins.sick = true`, the brief renders in `variant: 'rest'` with a sick-specific advice block (templated, no Anthropic call). This mirrors the existing recommendation route's sick-path behavior (currently writes a templated REST message). Cost: ~$0 on sick days, same as today.

**SSE → JSON response shape**: the existing recommendation route uses SSE for streaming text deltas. The brief is a structured output, not streaming text — the route shifts to a single JSON response with the new message ID + full `MorningBriefCard` payload. ChatPanel's call site changes from `postSse(...)` (delta-append loop) to `fetch(...).json()` (single add-to-state). Documented in Task 9 and Task 13.

---

## File Structure

**New files (15):**
- `supabase/migrations/0011_morning_brief.sql` — state-machine + kind enum widening
- `lib/morning/brief/get-today-targets.ts` — Phase-1/Phase-2 abstraction for macros + sleep target
- `lib/morning/brief/flags.ts` — `computeAdviceFlags()` (5 day-1 flags)
- `lib/morning/brief/data-sources.ts` — `fetchBriefInputs()` (parallel reads)
- `lib/morning/brief/assembler.ts` — `assembleBriefExceptAdvice()` (pure)
- `lib/morning/brief/advice-prompt.ts` — `generateAdvice()` (single Haiku call)
- `lib/morning/brief/index.ts` — `buildMorningBrief()` orchestrator
- `app/api/chat/morning/retry-brief/route.ts` — POST endpoint for retry path
- `components/morning/MorningBriefCard.tsx` — parent card component
- `components/morning/BriefRecapStats.tsx` — 4-stat grid (yesterday recap)
- `components/morning/BriefSessionList.tsx` — exercise rows (training variant)
- `components/morning/BriefRestActions.tsx` — recovery-focus block (rest variant)
- `components/morning/BriefMacrosGrid.tsx` — 2×2 grid
- `components/morning/BriefAdvice.tsx` — markdown prose block
- `components/morning/BriefTonight.tsx` — bottom strip one-liner

**Modified files (4):**
- `lib/data/types.ts` — add `MorningBriefCard`, `MorningBriefVariant`, `MorningBriefExercise`, `MorningBriefRecap`, `MorningBriefMacros`, `MorningBriefReadiness`, `MorningBriefTonight`, `AdviceFlags`; widen `IntakeState` to include `'assembling_brief' | 'brief_delivered' | 'brief_failed'`; add `'morning_brief'` to `ChatMessageRow.kind` enum
- `app/api/chat/morning/recommendation/route.ts` — replace SSE free-text recommendation with structured brief generation; JSON response (not SSE)
- `components/chat/ChatPanel.tsx` — call site shifts from `postSse` to `fetch` for recommendation; add render branch for `kind='morning_brief'` messages routing to `<MorningBriefCard>`
- `CLAUDE.md` — add migration 0011 entry + Coach/AI section bullet documenting the morning brief flow

**Env additions:** none (uses existing `ANTHROPIC_API_KEY`).

**Files NOT touched:**
- `lib/morning/script.ts` (slot definitions unchanged; brief is a new state after the existing slots)
- `lib/morning/state.ts` (extends naturally without shape change)
- `lib/coach/snapshot.ts` (brief has its own data sources)
- `lib/coach/sessionPlans.ts` (consumed read-only)
- `athlete_profile_documents` schema (read-only consumer via `get-today-targets`)
- Weekly planning code (`training_weeks`, `training_blocks` consumed read-only)

---

## Task index (14 tasks)

- Task 1: DB migration `0011_morning_brief.sql` + CLAUDE.md entry
- Task 2: TypeScript types — `MorningBrief*` family + `AdviceFlags` + widen `IntakeState` + widen `ChatMessageRow.kind`
- Task 3: `get-today-targets.ts` (Phase-1 implementation, Phase-2 abstraction in place)
- Task 4: `flags.ts` + probe script
- Task 5: `assembler.ts` (composes everything except `advice_md`) + probe script
- Task 6: `data-sources.ts` (parallel fetcher)
- Task 7: `advice-prompt.ts` (single Haiku call) + probe script
- Task 8: `index.ts` orchestrator
- Task 9: Replace `recommendation/route.ts` with brief-generating route + create `retry-brief/route.ts`
- Task 10: `MorningBriefCard` parent component (variant routing, header, readiness pill, tonight strip)
- Task 11: Sub-components: `BriefRecapStats`, `BriefSessionList`, `BriefRestActions`
- Task 12: Sub-components: `BriefMacrosGrid`, `BriefAdvice`, `BriefTonight`
- Task 13: `ChatPanel` integration (SSE → JSON call site shift + render branch for `kind='morning_brief'`)
- Task 14: End-to-end manual smoke + CLAUDE.md Coach/AI bullet polish

---

### Task 1: DB migration — `0011_morning_brief.sql`

**Files:**
- Create: `supabase/migrations/0011_morning_brief.sql`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/0011_morning_brief.sql`:

```sql
-- 0011_morning_brief.sql — morning brief
--
-- Extends the morning intake state machine with assembling_brief,
-- brief_delivered, brief_failed. Adds 'morning_brief' to chat_messages.kind.
-- The brief itself is a single chat_messages row with kind='morning_brief'
-- and a structured ui jsonb payload of shape MorningBriefCard.

-- ── checkins.intake_state: add new states ────────────────────────────────────
alter table public.checkins
  drop constraint if exists checkins_intake_state_check;

alter table public.checkins
  add constraint checkins_intake_state_check
  check (intake_state in (
    'pending',
    'awaiting_feel',
    'awaiting_sickness_notes',
    'awaiting_whoop',
    'delivered',           -- legacy: existing rows from pre-brief era stay here
    'assembling_brief',    -- transient: AI generation in flight
    'brief_delivered',     -- terminal: brief successfully written
    'brief_failed'         -- recoverable: AI failed; user can retry
  ));

-- ── chat_messages.kind: add 'morning_brief' ──────────────────────────────────
alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check
  check (kind in ('coach', 'morning_intake', 'morning_brief'));

-- ── Comments ─────────────────────────────────────────────────────────────────
comment on column public.chat_messages.kind is
  'Message variant: coach (default chat), morning_intake (slot-filling chips), morning_brief (post-intake daily plan card).';

comment on column public.checkins.intake_state is
  'Morning intake state machine: pending → awaiting_feel → [awaiting_sickness_notes] → awaiting_whoop → delivered → assembling_brief → brief_delivered (or brief_failed on AI failure). delivered is kept as a state for backwards compatibility with rows written before the brief feature.';
```

- [ ] **Step 2: Apply the migration**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected: a single migration applies (the two ALTER TABLE statements). Idempotent — re-running is safe.

- [ ] **Step 3: Verify schema applied**

Verify the new states are present in the constraint:

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db query --linked "select conname, pg_get_constraintdef(c.oid) from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'checkins' and c.conname = 'checkins_intake_state_check';"
```

Expected: shows the new constraint including `'assembling_brief'`, `'brief_delivered'`, `'brief_failed'`.

Verify the chat_messages kind constraint:

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db query --linked "select conname, pg_get_constraintdef(c.oid) from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'chat_messages' and c.conname = 'chat_messages_kind_check';"
```

Expected: shows the new constraint including `'morning_brief'`.

- [ ] **Step 4: Add migration entry to CLAUDE.md**

Open `CLAUDE.md`, find the "Database migrations" section. Add the entry after the highest-numbered entry (currently `9.` for `0010_athlete_profile.sql`). Use the next available list number (likely `10.`):

```
10. [supabase/migrations/0011_morning_brief.sql](supabase/migrations/0011_morning_brief.sql) — extends morning-intake state machine with `assembling_brief` / `brief_delivered` / `brief_failed`; adds `'morning_brief'` to `chat_messages.kind` for the post-intake daily plan card.
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add supabase/migrations/0011_morning_brief.sql CLAUDE.md
git commit -m "feat(db): morning brief state machine + kind enum (0011)

Extends checkins.intake_state with assembling_brief, brief_delivered,
brief_failed for the morning brief flow. Adds 'morning_brief' to
chat_messages.kind for the structured post-intake card. Migration is
fully additive (alter check constraints only) and idempotent.

delivered state is preserved for backwards compatibility with existing
rows written before the brief feature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TypeScript types

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Widen `IntakeState` union**

In `lib/data/types.ts`, find the existing `IntakeState` type and replace it:

```ts
export type IntakeState =
  | "pending"
  | "awaiting_feel"
  | "awaiting_sickness_notes"
  | "awaiting_whoop"
  | "delivered"
  | "assembling_brief"
  | "brief_delivered"
  | "brief_failed";
```

- [ ] **Step 2: Widen `ChatMessageRow.kind` union**

In `lib/data/types.ts`, find `ChatMessageRow` (around line 74). Update its `kind` field. The existing type allows `'coach' | 'morning_intake' | 'free_text'`; add `'morning_brief'`:

```ts
// In ChatMessageRow:
kind: "coach" | "morning_intake" | "free_text" | "morning_brief";
```

(Verify the exact existing union before editing — match it and append `'morning_brief'`.)

- [ ] **Step 3: Append morning-brief type family at end of file**

Append to the end of `lib/data/types.ts`:

```ts
// ── Morning brief (extends 0007_morning_intake via 0011_morning_brief) ───────

export type MorningBriefVariant = "training" | "rest";

export type MorningBriefExercise = {
  name: string;            // "Squat (Barbell)"
  sets: number;            // 3
  reps: number;            // 6
  kg: number | null;       // 62.5 for prescribed lifts; null for bodyweight/duration
  note?: string;           // "Do BEFORE Incline DB" or undefined
};

export type MorningBriefRecap = {
  yesterday_date: string;                // "YYYY-MM-DD"
  sleep_hours: number | null;
  kcal_actual: number | null;
  kcal_target: number;
  protein_actual_g: number | null;
  protein_target_g: number;
  trained_yesterday: string | null;      // "Legs" | "REST" | null
  top_e1rm_yesterday: { lift: string; kg: number } | null;
};

export type MorningBriefMacros = {
  kcal_target: number;
  protein_target_g: number;
  carb_target_g: number;
  fat_target_g: number;
};

export type MorningBriefReadiness = {
  score: number | null;                       // 1-10 from checkins.readiness
  hrv: number | null;                         // from daily_logs[today].hrv
  recovery: number | null;                    // 0-100 from daily_logs[today].recovery
  band: "low" | "moderate" | "high";          // derived from score + hrv vs baselines
};

export type MorningBriefTonight = {
  sleep_target_hours: number;
  bedtime_target: string;                     // "HH:mm"
};

export type MorningBriefCard = {
  variant: MorningBriefVariant;
  readiness: MorningBriefReadiness;
  recap: MorningBriefRecap;
  session: {
    type: string;                             // "Legs" | "Chest" | "Back" | "Mobility" | "REST"
    start_time: string | null;                // "13:00" for training; null for rest
    exercises: MorningBriefExercise[];        // empty for rest
  };
  macros: MorningBriefMacros;
  advice_md: string;                          // AI-generated 2-4 sentences markdown
  tonight: MorningBriefTonight;
};

/** Computed deterministically by lib/morning/brief/flags.ts. Passed to the
 *  AI prompt as named booleans so coaching logic stays in versioned TS code,
 *  not in a prompt string. Each flag is one threshold check or regex match. */
export type AdviceFlags = {
  has_glp1: boolean;
  alcohol_low_readiness_warning: boolean;
  has_active_injuries: boolean;
  poor_sleep_efficiency: boolean;
  missed_protein_yesterday: boolean;
};
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. The new types are additive; the union widenings on `IntakeState` and `ChatMessageRow.kind` accept supersets of the existing values so no consumer breaks.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/data/types.ts
git commit -m "feat(types): morning brief types + IntakeState/kind widening

Adds MorningBriefCard family (variant, recap, session, macros, readiness,
tonight, exercise) and AdviceFlags. Widens IntakeState to include
assembling_brief / brief_delivered / brief_failed. Widens
ChatMessageRow.kind to include morning_brief.

Mirrors the 0011_morning_brief.sql schema. Types are additive; existing
consumers unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `get-today-targets.ts` (Phase-1/Phase-2 abstraction)

**Files:**
- Create: `lib/morning/brief/get-today-targets.ts`

- [ ] **Step 1: Create the file**

Write `lib/morning/brief/get-today-targets.ts`:

```ts
// lib/morning/brief/get-today-targets.ts
//
// Phase-1/Phase-2 abstraction for daily targets. Insulates the brief
// renderer from where the macros / sleep target come from.
//
// Phase 1: reads from athlete_profile_documents.intake_payload (current
//   self-reported targets the user set during /onboarding).
// Phase 2: will swap to plan_payload.nutrition / plan_payload.sleep
//   (AI-generated prescribed targets).
//
// The function signature is stable across phases. Brief consumers don't
// know which source is feeding them.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntakePayload } from "@/lib/data/types";

export type TodayTargets = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  bedtime: string;             // "HH:mm"
  sleep_hours_target: number;
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
};

/** Returns null when the user has no active athlete_profile_documents row
 *  (i.e., they haven't completed Phase 1 onboarding yet). Callers should
 *  degrade gracefully — the brief still renders with placeholder macros. */
export async function getTodayTargets(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const payload = data.intake_payload as IntakePayload;
  return {
    kcal: payload.nutrition.current_kcal,
    protein_g: payload.nutrition.current_macros.protein_g,
    carb_g: payload.nutrition.current_macros.carb_g,
    fat_g: payload.nutrition.current_macros.fat_g,
    bedtime: payload.sleep_recovery.typical_bedtime,
    sleep_hours_target: payload.sleep_recovery.avg_sleep_hours,
    phase: payload.nutrition.current_phase,
  };
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
git add lib/morning/brief/get-today-targets.ts
git commit -m "feat(morning/brief): get-today-targets Phase-1 implementation

Reads kcal / macros / bedtime / sleep target / phase from
athlete_profile_documents.intake_payload (Phase 1 source of truth).
Returns null when no active doc exists — callers degrade to placeholders.

Phase 2 will swap the source to plan_payload.nutrition / plan_payload.sleep
without changing the function signature or any brief consumers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `flags.ts` + probe

**Files:**
- Create: `lib/morning/brief/flags.ts`
- Test: `scripts/probe-brief-flags.mjs` (deleted after running)

- [ ] **Step 1: Create `flags.ts`**

Write `lib/morning/brief/flags.ts`:

```ts
// lib/morning/brief/flags.ts
//
// Deterministic flag computation for the morning brief AI advice prompt.
// Each flag is one threshold check or regex match against the inputs.
// Adding a new flag in v1.1 is two lines: one here (compute) + one in
// advice-prompt.ts (describe when AI mentions it).

import type {
  AdviceFlags,
  AthleteProfileDocument,
  MorningBriefCard,
} from "@/lib/data/types";

/** Matches GLP-1 + brand-name variants. Case-insensitive, word-boundaries
 *  on the abbreviation so "GLPNotADrug" doesn't fire. */
const GLP1_REGEX = /\b(glp[-\s]?1|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|saxenda)\b/i;

export type FlagInputs = {
  activeProfile: AthleteProfileDocument | null;
  /** A partially-assembled card — needs readiness.band and recap.protein_actual_g
   *  + macros.protein_target_g; doesn't need advice_md. */
  card: Omit<MorningBriefCard, "advice_md">;
};

export function computeAdviceFlags(inputs: FlagInputs): AdviceFlags {
  const meds = inputs.activeProfile?.intake_payload.health.medications ?? "";
  const drinks = inputs.activeProfile?.intake_payload.nutrition.alcohol_drinks_per_week ?? 0;
  const injuries = inputs.activeProfile?.intake_payload.health.active_injuries ?? [];
  const bedtime = inputs.activeProfile?.intake_payload.sleep_recovery.typical_bedtime;
  const wakeTime = inputs.activeProfile?.intake_payload.sleep_recovery.typical_wake_time;
  const avgSleep = inputs.activeProfile?.intake_payload.sleep_recovery.avg_sleep_hours ?? 0;

  const timeInBed = computeTimeInBed(bedtime, wakeTime);
  const poor_sleep_efficiency =
    timeInBed !== null && avgSleep > 0 && timeInBed - avgSleep > 1;

  const proteinTarget = inputs.card.macros.protein_target_g;
  const proteinActual = inputs.card.recap.protein_actual_g;
  const missed_protein_yesterday =
    proteinActual !== null && proteinTarget > 0 && proteinActual < proteinTarget * 0.9;

  return {
    has_glp1: GLP1_REGEX.test(meds),
    alcohol_low_readiness_warning: drinks > 0 && inputs.card.readiness.band === "low",
    has_active_injuries: injuries.length > 0,
    poor_sleep_efficiency,
    missed_protein_yesterday,
  };
}

/** Returns time in bed in hours, accounting for crossing midnight.
 *  Returns null if either timestamp is missing or malformed. */
function computeTimeInBed(
  bedtime: string | undefined,
  wakeTime: string | undefined,
): number | null {
  if (!bedtime || !wakeTime) return null;
  const bParts = bedtime.split(":");
  const wParts = wakeTime.split(":");
  if (bParts.length !== 2 || wParts.length !== 2) return null;
  const bh = Number(bParts[0]);
  const bm = Number(bParts[1]);
  const wh = Number(wParts[0]);
  const wm = Number(wParts[1]);
  if ([bh, bm, wh, wm].some((n) => !Number.isFinite(n))) return null;
  let minutesInBed = (wh * 60 + wm) - (bh * 60 + bm);
  if (minutesInBed < 0) minutesInBed += 24 * 60; // crossed midnight
  return minutesInBed / 60;
}
```

- [ ] **Step 2: Create probe script**

Write `scripts/probe-brief-flags.mjs`:

```js
// scripts/probe-brief-flags.mjs
import { computeAdviceFlags } from "../lib/morning/brief/flags.ts";

function profile(overrides) {
  return {
    id: "test", user_id: "test", version: 1, status: "active",
    plan_payload: null, rendered_md: null, acknowledged_at: "2026-05-10T00:00:00Z",
    superseded_at: null, superseded_by: null,
    created_at: "2026-05-10T00:00:00Z", updated_at: "2026-05-10T00:00:00Z",
    intake_payload: {
      schema_version: 1,
      health: {
        conditions: { cardiac: false, hypertension: false, diabetes: "none",
                      autoimmune: false, joint_surgeries: [], other: "" },
        medications: "", recent_illness_injury: "",
        active_injuries: [], allergies: "",
        ...overrides.health,
      },
      training: {
        years_lifting: 5, training_age: "intermediate", sessions_per_week: 4,
        typical_session_minutes: 60,
        equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                     cables: true, machines: true, platform: true, ghd: false,
                     sled: false, treadmill: true, rower: false, bike: false,
                     kettlebells: false, bands: false, other: "" },
        current_e1rm: { squat: 100, bench: 80, deadlift: 120, ohp: 50 },
        best_ever_pr: { squat: null, bench: null, deadlift: null, ohp: null },
        previous_programs: "", recent_plateaus: "",
      },
      lifestyle: {
        job_demands: "mixed", commute_minutes: 0, has_dependents: false,
        dependent_notes: "", stress_self_rating: 3,
        days_available: { mon: true, tue: true, wed: false, thu: true,
                          fri: true, sat: false, sun: false },
        earliest_session_time: "06:00", latest_session_time: "21:00",
        travel_frequency: "none",
      },
      nutrition: {
        current_phase: "cut", current_kcal: 2085,
        current_macros: { protein_g: 168, carb_g: 145, fat_g: 87 },
        tracking_experience: "consistent", restrictions: "",
        alcohol_drinks_per_week: 0, caffeine_mg_per_day: 200, supplements: "",
        ...overrides.nutrition,
      },
      sleep_recovery: {
        avg_sleep_hours: 7,
        typical_bedtime: "23:00", typical_wake_time: "06:30",
        sleep_latency_minutes: 15, awakenings: "1_2",
        mobility_work: "", soreness_frequency: "rare",
        ...overrides.sleep_recovery,
      },
      goals: {
        primary_type: "strength", primary_metric: "deadlift e1RM",
        target_value: 150, target_unit: "kg", target_date: "2026-08-01",
        why_narrative: "powerlifting meet",
      },
    },
  };
}

function partialCard(readinessBand, proteinActual, proteinTarget) {
  return {
    variant: "training",
    readiness: { score: 7, hrv: 40, recovery: 60, band: readinessBand },
    recap: {
      yesterday_date: "2026-05-10", sleep_hours: 7,
      kcal_actual: 2000, kcal_target: 2085,
      protein_actual_g: proteinActual, protein_target_g: proteinTarget,
      trained_yesterday: "Legs", top_e1rm_yesterday: null,
    },
    session: { type: "Legs", start_time: "13:00", exercises: [] },
    macros: { kcal_target: 2085, protein_target_g: proteinTarget, carb_target_g: 145, fat_target_g: 87 },
    tonight: { sleep_target_hours: 7.5, bedtime_target: "23:00" },
  };
}

const cases = [
  {
    label: "GLP-1 user",
    inputs: {
      activeProfile: profile({ health: { medications: "GLP-1 2.5mg once per week" } }),
      card: partialCard("moderate", 175, 168),
    },
    expected: { has_glp1: true },
  },
  {
    label: "alcohol + low readiness",
    inputs: {
      activeProfile: profile({ nutrition: { alcohol_drinks_per_week: 3 } }),
      card: partialCard("low", 175, 168),
    },
    expected: { alcohol_low_readiness_warning: true },
  },
  {
    label: "alcohol but high readiness (should NOT fire)",
    inputs: {
      activeProfile: profile({ nutrition: { alcohol_drinks_per_week: 3 } }),
      card: partialCard("high", 175, 168),
    },
    expected: { alcohol_low_readiness_warning: false },
  },
  {
    label: "active injury",
    inputs: {
      activeProfile: profile({
        health: { active_injuries: [{ joint: "shoulder", restriction: "no overhead > 60kg" }] },
      }),
      card: partialCard("moderate", 175, 168),
    },
    expected: { has_active_injuries: true },
  },
  {
    label: "poor sleep efficiency (21:30 bed / 06:30 wake = 9h in bed, 7h sleep)",
    inputs: {
      activeProfile: profile({
        sleep_recovery: { avg_sleep_hours: 7, typical_bedtime: "21:30", typical_wake_time: "06:30" },
      }),
      card: partialCard("moderate", 175, 168),
    },
    expected: { poor_sleep_efficiency: true },
  },
  {
    label: "good sleep efficiency (gap < 1h)",
    inputs: {
      activeProfile: profile({
        sleep_recovery: { avg_sleep_hours: 7.5, typical_bedtime: "23:00", typical_wake_time: "06:30" },
      }),
      card: partialCard("moderate", 175, 168),
    },
    expected: { poor_sleep_efficiency: false },
  },
  {
    label: "missed protein yesterday (140 vs 170 target)",
    inputs: {
      activeProfile: profile({}),
      card: partialCard("moderate", 140, 170),
    },
    expected: { missed_protein_yesterday: true },
  },
  {
    label: "hit protein yesterday (175 vs 168 target)",
    inputs: {
      activeProfile: profile({}),
      card: partialCard("moderate", 175, 168),
    },
    expected: { missed_protein_yesterday: false },
  },
  {
    label: "no active profile (all flags false)",
    inputs: {
      activeProfile: null,
      card: partialCard("moderate", null, 0),
    },
    expected: {
      has_glp1: false, alcohol_low_readiness_warning: false,
      has_active_injuries: false, poor_sleep_efficiency: false,
      missed_protein_yesterday: false,
    },
  },
];

for (const c of cases) {
  const result = computeAdviceFlags(c.inputs);
  const pass = Object.entries(c.expected).every(([k, v]) => result[k] === v);
  console.log(`${pass ? "✓" : "✗"} ${c.label}`);
  if (!pass) {
    console.log("  expected:", c.expected);
    console.log("  actual:  ", result);
  }
}
```

- [ ] **Step 3: Run the probe**

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-brief-flags.mjs
```

Expected output (9 cases, all pass):
```
✓ GLP-1 user
✓ alcohol + low readiness
✓ alcohol but high readiness (should NOT fire)
✓ active injury
✓ poor sleep efficiency (21:30 bed / 06:30 wake = 9h in bed, 7h sleep)
✓ good sleep efficiency (gap < 1h)
✓ missed protein yesterday (140 vs 170 target)
✓ hit protein yesterday (175 vs 168 target)
✓ no active profile (all flags false)
```

- [ ] **Step 4: Delete the probe script**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-brief-flags.mjs
```

- [ ] **Step 5: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/morning/brief/flags.ts
git commit -m "feat(morning/brief): computeAdviceFlags (5 day-1 flags)

Five deterministic flags consumed by the AI advice prompt:
  - has_glp1: regex match on medications (GLP-1, Ozempic, Wegovy, etc.)
  - alcohol_low_readiness_warning: drinks > 0 AND band === 'low'
  - has_active_injuries: any injury entry in intake_payload.health.active_injuries
  - poor_sleep_efficiency: (wake - bedtime) - avg_sleep_hours > 1h
    (handles cross-midnight bedtimes; returns null if either time missing)
  - missed_protein_yesterday: actual < target * 0.9 (gated on actual non-null)

Probe-tested with 9 cases (positive + negative for each flag plus no-profile
degraded path).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `assembler.ts` (pure, composes everything except advice_md)

**Files:**
- Create: `lib/morning/brief/assembler.ts`
- Test: `scripts/probe-brief-assembler.mjs` (deleted after running)

- [ ] **Step 1: Create `assembler.ts`**

Write `lib/morning/brief/assembler.ts`:

```ts
// lib/morning/brief/assembler.ts
//
// Pure composition of the brief card from raw inputs. Produces everything
// except advice_md (that comes from the AI call in advice-prompt.ts).
// No I/O, fully deterministic, unit-testable in isolation.

import type {
  MorningBriefCard,
  MorningBriefExercise,
  MorningBriefVariant,
  MorningBriefRecap,
  MorningBriefMacros,
  MorningBriefReadiness,
  MorningBriefTonight,
  CheckinRow,
  DailyLog,
  IntensityModifier,
  PrimaryLift,
  AthleteProfileDocument,
} from "@/lib/data/types";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

/** Yesterday's workout summary — pre-aggregated by the data source. */
export type YesterdayWorkoutSummary = {
  type: string | null;                         // "Legs" | "REST" | null
  top_e1rm: { lift: string; kg: number } | null;
};

/** WHOOP baselines from profiles.whoop_baselines. Shape may include other
 *  fields; we read only the SWC band fields here. */
export type WhoopBaselineForBand = {
  hrv_swc_low?: number | null;
  hrv_swc_high?: number | null;
};

export type BriefInputs = {
  today: string;                               // "YYYY-MM-DD"
  yesterday: string;                           // "YYYY-MM-DD"
  sessionType: string;                         // "Legs" | "Chest" | ... | "REST"
  sessionStartTime: string | null;             // "13:00" for training; null for rest
  intensityModifier: IntensityModifier;        // {} when no active block
  primaryLift: PrimaryLift | null;             // active block's primary lift if any
  todayTargets: TodayTargets | null;           // null when no active athlete profile
  yesterdayLog: DailyLog | null;
  yesterdayWorkout: YesterdayWorkoutSummary | null;
  todayCheckin: CheckinRow | null;
  todayLog: DailyLog | null;                   // for HRV / recovery
  whoopBaselines: WhoopBaselineForBand | null;
  activeProfile: AthleteProfileDocument | null;
};

export function assembleBriefExceptAdvice(
  inputs: BriefInputs,
): Omit<MorningBriefCard, "advice_md"> {
  const variant: MorningBriefVariant = pickVariant(inputs.sessionType);

  return {
    variant,
    readiness: composeReadiness(inputs),
    recap: composeRecap(inputs),
    session: composeSession(variant, inputs),
    macros: composeMacros(inputs),
    tonight: composeTonight(inputs),
  };
}

function pickVariant(sessionType: string): MorningBriefVariant {
  return sessionType === "REST" ? "rest" : "training";
}

function composeReadiness(inputs: BriefInputs): MorningBriefReadiness {
  const score = inputs.todayCheckin?.readiness ?? null;
  const hrv = inputs.todayLog?.hrv ?? null;
  const recovery = inputs.todayLog?.recovery ?? null;
  return {
    score,
    hrv,
    recovery,
    band: deriveReadinessBand(score, hrv, inputs.whoopBaselines),
  };
}

/** Two-signal triangulation. Mirrors the convention in
 *  lib/coach/autoregulation.ts — surface, never auto-apply. */
function deriveReadinessBand(
  score: number | null,
  hrv: number | null,
  baselines: WhoopBaselineForBand | null,
): "low" | "moderate" | "high" {
  if (score === null) return "moderate";
  const hrvLow = baselines?.hrv_swc_low ?? null;
  const hrvHigh = baselines?.hrv_swc_high ?? null;
  if (score <= 5 || (hrv !== null && hrvLow !== null && hrv < hrvLow)) {
    return "low";
  }
  if (score >= 8 && (hrv === null || hrvHigh === null || hrv >= hrvHigh)) {
    return "high";
  }
  return "moderate";
}

function composeRecap(inputs: BriefInputs): MorningBriefRecap {
  const t = inputs.todayTargets;
  return {
    yesterday_date: inputs.yesterday,
    sleep_hours: inputs.yesterdayLog?.sleep_hours ?? null,
    kcal_actual: inputs.yesterdayLog?.calories_eaten ?? null,
    kcal_target: t?.kcal ?? 0,
    protein_actual_g: inputs.yesterdayLog?.protein_g ?? null,
    protein_target_g: t?.protein_g ?? 0,
    trained_yesterday: inputs.yesterdayWorkout?.type ?? null,
    top_e1rm_yesterday: inputs.yesterdayWorkout?.top_e1rm ?? null,
  };
}

function composeMacros(inputs: BriefInputs): MorningBriefMacros {
  const t = inputs.todayTargets;
  return {
    kcal_target: t?.kcal ?? 0,
    protein_target_g: t?.protein_g ?? 0,
    carb_target_g: t?.carb_g ?? 0,
    fat_target_g: t?.fat_g ?? 0,
  };
}

function composeTonight(inputs: BriefInputs): MorningBriefTonight {
  const t = inputs.todayTargets;
  return {
    sleep_target_hours: t?.sleep_hours_target ?? 7.5,
    bedtime_target: t?.bedtime ?? "22:30",
  };
}

function composeSession(
  variant: MorningBriefVariant,
  inputs: BriefInputs,
): { type: string; start_time: string | null; exercises: MorningBriefExercise[] } {
  if (variant === "rest") {
    return {
      type: inputs.sessionType,
      start_time: null,
      exercises: [],
    };
  }
  return {
    type: inputs.sessionType,
    start_time: inputs.sessionStartTime ?? "13:00", // default 1pm per spec
    exercises: composeExercises(
      inputs.sessionType,
      inputs.intensityModifier,
      inputs.primaryLift,
    ),
  };
}

function composeExercises(
  sessionType: string,
  modifier: IntensityModifier,
  primaryLift: PrimaryLift | null,
): MorningBriefExercise[] {
  const plan: PlannedExercise[] = SESSION_PLANS[sessionType] ?? [];
  return plan
    .filter((p) => !p.warmup)
    .map((p): MorningBriefExercise => {
      const liftFromKey = inferLiftFromKey(p.key);
      const liftModifier =
        liftFromKey !== null && liftFromKey === primaryLift
          ? (modifier[liftFromKey] ?? 1.0)
          : 1.0;
      const scaledKg =
        p.baseKg != null ? Math.round(p.baseKg * liftModifier * 2) / 2 : null;
      const result: MorningBriefExercise = {
        name: p.name,
        sets: p.sets ?? 3,
        reps: p.baseReps ?? 8,
        kg: scaledKg,
      };
      if (p.note) result.note = p.note;
      return result;
    });
}

/** Maps SESSION_PLANS exercise.key strings to the canonical PrimaryLift enum.
 *  Only the four primary lifts get intensity-modifier scaling; everything else
 *  uses baseKg as-is. */
function inferLiftFromKey(key: string | undefined): PrimaryLift | null {
  if (!key) return null;
  if (key === "squat") return "squat";
  if (key === "decline_bench" || key === "incline_db" || key === "bench") return "bench";
  if (key === "deadlift") return "deadlift";
  if (key === "ohp") return "ohp";
  return null;
}
```

- [ ] **Step 2: Verify `IntensityModifier` + `PrimaryLift` exports in `lib/data/types.ts`**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "export type (IntensityModifier|PrimaryLift)" lib/data/types.ts
```

Expected: both types exported (added in `0008_weekly_planning` work). If either is missing, find equivalent named exports (likely `IntensityModifier = Partial<Record<PrimaryLift, number>>` and `PrimaryLift = "squat" | "bench" | "deadlift" | "ohp"`).

- [ ] **Step 3: Create probe script**

Write `scripts/probe-brief-assembler.mjs`:

```js
// scripts/probe-brief-assembler.mjs
import { assembleBriefExceptAdvice } from "../lib/morning/brief/assembler.ts";

const baseTargets = {
  kcal: 2085, protein_g: 168, carb_g: 145, fat_g: 87,
  bedtime: "21:30", sleep_hours_target: 7.5, phase: "cut",
};

const yesterdayLog = {
  date: "2026-05-10", sleep_hours: 7.2, calories_eaten: 2100,
  protein_g: 175, hrv: 42, recovery: 65, weight_kg: 79.4,
  // Other DailyLog fields omitted for probe brevity — types are loose enough
};

const todayCheckin = {
  user_id: "test", date: "2026-05-11", readiness: 7,
  energy_label: "medium", mood: "😊", sick: false,
  fatigue: "none", bloating: false, soreness_areas: null, soreness_severity: null,
  intake_state: "delivered", sickness_notes: null, feel_notes: null, soreness: null,
  created_at: "2026-05-11T07:00:00Z", updated_at: "2026-05-11T07:00:00Z",
};

const todayLog = {
  date: "2026-05-11", hrv: 38, recovery: 58, sleep_hours: 7.0,
};

const whoopBaselines = { hrv_swc_low: 30, hrv_swc_high: 50 };

// ── Training-variant test ──────────────────────────────────────────────────
const trainingCard = assembleBriefExceptAdvice({
  today: "2026-05-11",
  yesterday: "2026-05-10",
  sessionType: "Legs",
  sessionStartTime: "13:00",
  intensityModifier: { squat: 0.95 },
  primaryLift: "squat",
  todayTargets: baseTargets,
  yesterdayLog,
  yesterdayWorkout: { type: "Back", top_e1rm: { lift: "deadlift", kg: 102 } },
  todayCheckin,
  todayLog,
  whoopBaselines,
  activeProfile: null,
});

console.log("=== Training variant ===");
console.log("Variant:", trainingCard.variant);
console.log("Readiness band:", trainingCard.readiness.band);
console.log("Recap (yesterday):", JSON.stringify(trainingCard.recap, null, 2));
console.log("Session type:", trainingCard.session.type);
console.log("Session start:", trainingCard.session.start_time);
console.log("Exercises:");
for (const e of trainingCard.session.exercises) {
  console.log(`  ${e.name}: ${e.kg ?? "—"} kg × ${e.sets} × ${e.reps}${e.note ? ` (${e.note})` : ""}`);
}
console.log("Macros:", JSON.stringify(trainingCard.macros, null, 2));
console.log("Tonight:", JSON.stringify(trainingCard.tonight, null, 2));

// Verify squat is scaled: SESSION_PLANS.Legs[0] is { name: "Squat (Barbell)", baseKg: 62.5, ... }
// With modifier squat=0.95: expected scaledKg = 62.5 * 0.95 = 59.375 → rounds to 59.5
const squat = trainingCard.session.exercises.find((e) => e.name === "Squat (Barbell)");
console.log(`\n>>> Squat scaled: ${squat?.kg} (expected ~59.5 from 62.5 × 0.95)`);

// ── Rest-variant test ───────────────────────────────────────────────────────
const restCard = assembleBriefExceptAdvice({
  today: "2026-05-11",
  yesterday: "2026-05-10",
  sessionType: "REST",
  sessionStartTime: null,
  intensityModifier: {},
  primaryLift: null,
  todayTargets: baseTargets,
  yesterdayLog,
  yesterdayWorkout: null,
  todayCheckin,
  todayLog,
  whoopBaselines,
  activeProfile: null,
});

console.log("\n=== Rest variant ===");
console.log("Variant:", restCard.variant);
console.log("Session type:", restCard.session.type);
console.log("Session start:", restCard.session.start_time);
console.log("Exercises (should be empty):", restCard.session.exercises);

// ── Low-readiness band test ─────────────────────────────────────────────────
const lowBandCard = assembleBriefExceptAdvice({
  today: "2026-05-11",
  yesterday: "2026-05-10",
  sessionType: "Legs",
  sessionStartTime: "13:00",
  intensityModifier: {},
  primaryLift: null,
  todayTargets: baseTargets,
  yesterdayLog,
  yesterdayWorkout: null,
  todayCheckin: { ...todayCheckin, readiness: 4 },
  todayLog: { ...todayLog, hrv: 25 }, // below baseline.hrv_swc_low
  whoopBaselines,
  activeProfile: null,
});

console.log("\n=== Low readiness ===");
console.log("Score:", lowBandCard.readiness.score, "HRV:", lowBandCard.readiness.hrv);
console.log("Band:", lowBandCard.readiness.band, "(expected 'low')");

// ── No-targets degraded test ────────────────────────────────────────────────
const noTargetsCard = assembleBriefExceptAdvice({
  today: "2026-05-11",
  yesterday: "2026-05-10",
  sessionType: "Legs",
  sessionStartTime: "13:00",
  intensityModifier: {},
  primaryLift: null,
  todayTargets: null, // no active athlete profile
  yesterdayLog,
  yesterdayWorkout: null,
  todayCheckin,
  todayLog,
  whoopBaselines,
  activeProfile: null,
});

console.log("\n=== No targets (no active athlete profile) ===");
console.log("Macros:", JSON.stringify(noTargetsCard.macros, null, 2));
console.log("Tonight:", JSON.stringify(noTargetsCard.tonight, null, 2));
console.log(">>> Expected: macros all zeros, tonight has fallback bedtime '22:30' + 7.5h");
```

- [ ] **Step 4: Run the probe**

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-brief-assembler.mjs
```

Expected output (visually verify):

1. **Training variant:** Squat (Barbell) shows kg ≈ 59.5 (62.5 × 0.95). Other exercises show their baseKg unmodified (no squat-modifier matching). Exercises array has 7 entries (Legs has 7 non-warmup exercises in SESSION_PLANS).
2. **Rest variant:** `session.type === "REST"`, `session.start_time === null`, `session.exercises === []`.
3. **Low readiness:** band is `"low"` (score 4 ≤ 5 AND hrv 25 < baseline 30).
4. **No targets:** macros all 0, tonight uses fallback bedtime "22:30" and 7.5h.

If squat scaling is off, double-check `inferLiftFromKey()` matches `"squat"` correctly (SESSION_PLANS.Legs has `key: "squat"` on the first entry).

- [ ] **Step 5: Delete the probe script**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-brief-assembler.mjs
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
git add lib/morning/brief/assembler.ts
git commit -m "feat(morning/brief): assembler — pure composition of brief card

assembleBriefExceptAdvice() composes everything except advice_md from
raw BriefInputs. No I/O. Pure deterministic transformations.

Variants: training (session.exercises populated from SESSION_PLANS with
intensity_modifier × baseKg scaling for primary lift) vs rest
(session.exercises empty).

Readiness band: two-signal triangulation against WHOOP baselines
(score ≤5 OR hrv below SWC low → 'low'; score ≥8 AND hrv at/above SWC
high → 'high'; else 'moderate'). Mirrors existing autoregulation
convention.

Probe-tested with 4 cases: training/rest variants, low-readiness band,
no-targets degraded path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `data-sources.ts` (parallel fetcher)

**Files:**
- Create: `lib/morning/brief/data-sources.ts`

- [ ] **Step 1: Verify Epley logic + regex used in `useRecentE1RMs`**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -B 1 -A 10 "PRIMARY_LIFT_KEYWORDS\|epley" lib/query/fetchers/recentE1RMs.ts | head -40
```

The yesterday-workout aggregation in data-sources.ts mirrors this same regex + Epley formula. Confirm shape before implementing.

- [ ] **Step 2: Verify `weekdayInUserTz` export shape**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "weekdayInUserTz|todayInUserTz" lib/time.ts | head -5
```

`weekdayInUserTz()` returns one of `"Monday" | "Tuesday" | ...`. We need the same shape to index `WEEKLY_SESSIONS`.

- [ ] **Step 3: Create `data-sources.ts`**

Write `lib/morning/brief/data-sources.ts`:

```ts
// lib/morning/brief/data-sources.ts
//
// Parallel data fetcher for the morning brief. Single Promise.all over
// 6 reads — kept tight so the brief generation pipeline stays under ~200ms
// before the AI call.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AthleteProfileDocument,
  CheckinRow,
  DailyLog,
  IntensityModifier,
  PrimaryLift,
  Profile,
  TrainingBlock,
  TrainingWeek,
  Weekday,
} from "@/lib/data/types";
import { WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import { weekdayInUserTz } from "@/lib/time";
import { getTodayTargets, type TodayTargets } from "@/lib/morning/brief/get-today-targets";
import type { BriefInputs, YesterdayWorkoutSummary, WhoopBaselineForBand } from "@/lib/morning/brief/assembler";

const PRIMARY_LIFT_REGEX: Record<PrimaryLift, RegExp> = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
};

function epley(kg: number, reps: number): number | null {
  if (reps <= 0 || reps > 12) return null;
  return Math.round(kg * (1 + reps / 30));
}

function inferLiftFromName(name: string): PrimaryLift | null {
  for (const lift of ["squat", "bench", "deadlift", "ohp"] as const) {
    if (PRIMARY_LIFT_REGEX[lift].test(name)) return lift;
  }
  return null;
}

/** Maps a Date object to the keys used in WEEKLY_SESSIONS ("Monday".."Sunday").
 *  weekdayInUserTz returns the same shape. */
function weeklySessionKey(today: string): string {
  return weekdayInUserTz(new Date(`${today}T12:00:00Z`));
}

/** Maps "Monday".."Sunday" → "mon".."sun" for training_weeks.session_plan
 *  jsonb keys (per 0008_weekly_planning convention). */
function sessionPlanKey(weekday: string): Weekday {
  const map: Record<string, Weekday> = {
    Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
    Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
  };
  return map[weekday] ?? "Mon";
}

function yesterdayOf(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function fetchBriefInputs(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<BriefInputs> {
  const yesterday = yesterdayOf(today);
  const weeklyKey = weeklySessionKey(today);  // "Monday".."Sunday"
  const sessionKey = sessionPlanKey(weeklyKey); // "Mon".."Sun"

  // Parallel reads (Promise.all):
  // 1. Active training_blocks (for primary_lift)
  // 2. Training_week containing today (for session_plan + intensity_modifier)
  // 3. Today's targets (via athlete_profile_documents abstraction)
  // 4. Yesterday's daily_log
  // 5. Yesterday's workouts
  // 6. Today's checkin
  // 7. Today's daily_log
  // 8. Profile (for whoop_baselines)
  // 9. Active athlete_profile_document (for flags input)
  const [
    activeBlockRes,
    trainingWeekRes,
    todayTargets,
    yesterdayLogRes,
    yesterdayWorkoutsRes,
    todayCheckinRes,
    todayLogRes,
    profileRes,
    activeAthleteProfileRes,
  ] = await Promise.all([
    supabase
      .from("training_blocks")
      .select("id, primary_lift")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("training_weeks")
      .select("session_plan, intensity_modifier, week_start")
      .eq("user_id", userId)
      .lte("week_start", today)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getTodayTargets(supabase, userId),
    supabase
      .from("daily_logs")
      .select("*")
      .eq("user_id", userId)
      .eq("date", yesterday)
      .maybeSingle(),
    supabase
      .from("workouts")
      .select("id, type, exercises (name, sets:exercise_sets (kg, reps, warmup))")
      .eq("user_id", userId)
      .eq("date", yesterday),
    supabase
      .from("checkins")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .maybeSingle(),
    supabase
      .from("profiles")
      .select("whoop_baselines")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("athlete_profile_documents")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
  ]);

  // Throw on any read error (consistent with codebase fetcher pattern).
  for (const r of [
    activeBlockRes, trainingWeekRes, yesterdayLogRes, yesterdayWorkoutsRes,
    todayCheckinRes, todayLogRes, profileRes, activeAthleteProfileRes,
  ]) {
    if (r.error) throw r.error;
  }

  // Resolve session type with training_weeks → WEEKLY_SESSIONS fallback.
  const activeBlock = activeBlockRes.data as Pick<TrainingBlock, "id" | "primary_lift"> | null;
  const trainingWeek = trainingWeekRes.data as Pick<TrainingWeek, "session_plan" | "intensity_modifier" | "week_start"> | null;
  let sessionType: string;
  let intensityModifier: IntensityModifier = {};
  if (trainingWeek && isWeekStartCoveringToday(trainingWeek.week_start, today)) {
    const sessionPlan = (trainingWeek.session_plan ?? {}) as Record<Weekday, string>;
    sessionType = sessionPlan[sessionKey] ?? WEEKLY_SESSIONS[weeklyKey] ?? "REST";
    intensityModifier = (trainingWeek.intensity_modifier ?? {}) as IntensityModifier;
  } else {
    sessionType = WEEKLY_SESSIONS[weeklyKey] ?? "REST";
  }

  // Aggregate yesterday's workouts into a YesterdayWorkoutSummary.
  const yesterdayWorkout = aggregateYesterdayWorkout(yesterdayWorkoutsRes.data as Array<{
    id: string;
    type: string | null;
    exercises: Array<{ name: string; sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
  }> | null);

  return {
    today,
    yesterday,
    sessionType,
    sessionStartTime: sessionType === "REST" ? null : "13:00", // spec-locked default; configurable in v1.1
    intensityModifier,
    primaryLift: activeBlock?.primary_lift ?? null,
    todayTargets,
    yesterdayLog: yesterdayLogRes.data as DailyLog | null,
    yesterdayWorkout,
    todayCheckin: todayCheckinRes.data as CheckinRow | null,
    todayLog: todayLogRes.data as DailyLog | null,
    whoopBaselines: (profileRes.data as { whoop_baselines?: WhoopBaselineForBand } | null)?.whoop_baselines ?? null,
    activeProfile: activeAthleteProfileRes.data as AthleteProfileDocument | null,
  };
}

/** A training_week's week_start covers today if today is in [week_start, week_start + 6d]. */
function isWeekStartCoveringToday(weekStart: string, today: string): boolean {
  const ws = new Date(`${weekStart}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const diffDays = Math.round((t - ws) / 86_400_000);
  return diffDays >= 0 && diffDays <= 6;
}

function aggregateYesterdayWorkout(
  workouts: Array<{
    id: string;
    type: string | null;
    exercises: Array<{ name: string; sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
  }> | null,
): YesterdayWorkoutSummary | null {
  if (!workouts || workouts.length === 0) return null;
  // Single workout per day expected; take the first.
  const w = workouts[0];
  let topE1rm: { lift: string; kg: number } | null = null;
  for (const ex of w.exercises ?? []) {
    const lift = inferLiftFromName(ex.name);
    if (!lift) continue;
    for (const s of ex.sets ?? []) {
      if (s.warmup) continue;
      if (s.kg === null || s.reps === null) continue;
      const e1rm = epley(s.kg, s.reps);
      if (e1rm !== null && (topE1rm === null || e1rm > topE1rm.kg)) {
        topE1rm = { lift, kg: e1rm };
      }
    }
  }
  return {
    type: w.type,
    top_e1rm: topE1rm,
  };
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. If `Weekday` type isn't exported from `lib/data/types.ts`, find the equivalent in the weekly-planning types (likely declared inline somewhere) and import it or declare locally.

If typecheck complains about `weekdayInUserTz` signature (expects no arg or different arg shape), adapt the `weeklySessionKey()` helper accordingly.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/morning/brief/data-sources.ts
git commit -m "feat(morning/brief): data-sources parallel fetcher

fetchBriefInputs runs 9 reads in parallel: active training_block,
training_week-covering-today, today's targets, yesterday's daily_log,
yesterday's workouts, today's checkin, today's daily_log, profile
baselines, active athlete profile document.

Aggregates yesterday's workouts into a top Epley e1RM across primary
lifts (squat/bench/deadlift/ohp via word-boundary regex). Resolves
today's session via training_weeks.session_plan with WEEKLY_SESSIONS
fallback.

Throws on any Supabase error per the codebase's fetcher convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `advice-prompt.ts` (single Haiku call) + probe

**Files:**
- Create: `lib/morning/brief/advice-prompt.ts`
- Test: `scripts/probe-brief-advice.mjs` (deleted after running)

- [ ] **Step 1: Verify `lib/anthropic/client.ts` API**

```bash
cd "/Users/abdelouahedelbied/Health app"
cat lib/anthropic/client.ts
```

Confirm: exports `callClaude(messages, opts)` with `opts.model`, `opts.system`, `opts.maxTokens`, `opts.temperature`. Returns a string (joined assistant text content).

- [ ] **Step 2: Create `advice-prompt.ts`**

Write `lib/morning/brief/advice-prompt.ts`:

```ts
// lib/morning/brief/advice-prompt.ts
//
// Single Anthropic Haiku 4.5 call producing the prose Advice block of the
// brief. No tool use; single completion; ~$0.0005 per call.

import { callClaude } from "@/lib/anthropic/client";
import type {
  AdviceFlags,
  AthleteProfileDocument,
  MorningBriefCard,
} from "@/lib/data/types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 350;
const TEMPERATURE = 0.4;

export type AdviceContext = {
  activeProfile: AthleteProfileDocument | null;
  /** Card without advice_md — used as the data context the AI references. */
  card: Omit<MorningBriefCard, "advice_md">;
  flags: AdviceFlags;
};

/** Throws on Anthropic failures (rate limit, network, malformed). Orchestrator
 *  catches and transitions state to brief_failed. */
export async function generateAdvice(ctx: AdviceContext): Promise<string> {
  const system = buildSystemPrompt(ctx);
  const userMessage = "Write today's Advice block per the instructions.";
  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    { model: MODEL, system, maxTokens: MAX_TOKENS, temperature: TEMPERATURE },
  );
  return result.trim();
}

function buildSystemPrompt(ctx: AdviceContext): string {
  const profile = ctx.activeProfile?.intake_payload;
  const goal = profile?.goals;
  const meds = profile?.health.medications?.trim() ?? "";
  const injuries = profile?.health.active_injuries ?? [];

  const athleteContext: string[] = [];
  if (goal) {
    athleteContext.push(
      `Goal: ${goal.primary_metric} → ${goal.target_value}${goal.target_unit} by ${goal.target_date}.`,
    );
    if (goal.why_narrative.trim()) {
      athleteContext.push(`Goal narrative: "${goal.why_narrative.trim()}".`);
    }
  }
  if (profile?.nutrition.current_phase) {
    athleteContext.push(`Phase: ${profile.nutrition.current_phase}.`);
  }
  if (meds) athleteContext.push(`Medications: ${meds}.`);
  if (injuries.length > 0) {
    athleteContext.push("Restrictions:");
    for (const i of injuries) {
      athleteContext.push(`  - ${i.joint}: ${i.restriction}`);
    }
  }

  const dataBlock = buildDataBlock(ctx.card);
  const flagsBlock = buildFlagsBlock(ctx.flags);

  return `You are this athlete's coach delivering today's morning brief — the catch-up after the morning intake.

## Athlete context

${athleteContext.length > 0 ? athleteContext.join("\n") : "(no profile data available)"}

## Today's data

${dataBlock}

## Flags

${flagsBlock}

## Your task

Write the Advice block of today's brief. 2-4 sentences. Markdown allowed for bold/italic only.

Cover (in this order, but only what's relevant):
1. ONE coaching observation tying readiness to today's session. If poor_sleep_efficiency is true, probe the sleep gap ("you're in bed X hours but sleeping Y — push bedtime earlier / address latency").
2. Eating timing anchored to the session start (training days): pre-workout (~90 min before) + post (within 90 min after). Include ONE specific food example per window.
3. Hydration one-liner.

Conditional rules:
- If has_glp1 is true: in the eating section, note that hunger cues may be blunted; suggest setting a reminder for the pre-workout meal rather than "eat when hungry".
- If alcohol_low_readiness_warning is true: mention pushing protein earlier in the day to compensate for overnight protein-synthesis suppression.
- If has_active_injuries is true: note "modify per restriction" on relevant exercises rather than the prescribed weight.
- If missed_protein_yesterday is true: open the eating section with a brief "yesterday's protein came in short — let's hit it cleanly today" before the timing.
- Rest day variant: skip pre/post-workout entirely. Focus on protein distribution across 4 meals + sleep prep. Mobility / steps mention if relevant.

Style:
- Direct but warm. Default balanced tone (Phase 2 will surface specific directness preference).
- Reference numbers from the data block above; never invent values.
- Default protein examples: chicken, greek yogurt, eggs, salmon. Default carbs: rice, oats, sweet potato, banana.
- Do not restate data the card already shows above the advice block. Build on the data, don't recite it.

Output ONLY the advice text. No headers, no preamble.`;
}

function buildDataBlock(card: Omit<MorningBriefCard, "advice_md">): string {
  const lines: string[] = [];
  lines.push(`- Variant: ${card.variant}`);
  if (card.variant === "training") {
    lines.push(`- Session: ${card.session.type} at ${card.session.start_time ?? "unscheduled"}`);
  } else {
    lines.push("- Session: REST");
  }
  const r = card.readiness;
  lines.push(
    `- Readiness band: ${r.band} (score ${r.score ?? "n/a"}/10, HRV ${r.hrv ?? "n/a"}, recovery ${r.recovery ?? "n/a"})`,
  );
  const m = card.macros;
  lines.push(
    `- Macros target today: ${m.kcal_target} kcal, ${m.protein_target_g}g protein / ${m.carb_target_g}g carb / ${m.fat_target_g}g fat`,
  );
  const recap = card.recap;
  const recapParts: string[] = [];
  if (recap.sleep_hours !== null) recapParts.push(`slept ${recap.sleep_hours}h`);
  if (recap.kcal_actual !== null) recapParts.push(`ate ${recap.kcal_actual} kcal (target ${recap.kcal_target})`);
  if (recap.protein_actual_g !== null)
    recapParts.push(`${recap.protein_actual_g}g protein (target ${recap.protein_target_g}g)`);
  if (recap.trained_yesterday) recapParts.push(`trained ${recap.trained_yesterday}`);
  if (recap.top_e1rm_yesterday)
    recapParts.push(`top e1RM ${recap.top_e1rm_yesterday.lift} ${recap.top_e1rm_yesterday.kg}kg`);
  if (recapParts.length > 0) {
    lines.push(`- Recap: yesterday ${recapParts.join(", ")}`);
  } else {
    lines.push(`- Recap: yesterday — no data available`);
  }
  return lines.join("\n");
}

function buildFlagsBlock(flags: AdviceFlags): string {
  return Object.entries(flags)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}
```

- [ ] **Step 3: Create probe script (runs ONE real Anthropic call)**

Write `scripts/probe-brief-advice.mjs`:

```js
// scripts/probe-brief-advice.mjs
//
// One-shot probe against the live Anthropic API. Costs ~$0.0005 per run.
// Verifies the prompt produces sensible advice for the specific
// scenario where the user has GLP-1 + poor sleep efficiency (matches
// the live test user, Abdelouahed).

import "dotenv/config";
import { generateAdvice } from "../lib/morning/brief/advice-prompt.ts";

const activeProfile = {
  id: "test", user_id: "test", version: 1, status: "active",
  plan_payload: null, rendered_md: null, acknowledged_at: "2026-05-10T00:00:00Z",
  superseded_at: null, superseded_by: null,
  created_at: "2026-05-10T00:00:00Z", updated_at: "2026-05-10T00:00:00Z",
  intake_payload: {
    schema_version: 1,
    health: {
      conditions: { cardiac: false, hypertension: false, diabetes: "none",
                    autoimmune: false, joint_surgeries: [], other: "" },
      medications: "GLP-1 2.5mg once per week", recent_illness_injury: "",
      active_injuries: [], allergies: "",
    },
    training: {
      years_lifting: 5, training_age: "intermediate", sessions_per_week: 4,
      typical_session_minutes: 60,
      equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                   cables: true, machines: true, platform: true, ghd: false,
                   sled: false, treadmill: true, rower: false, bike: false,
                   kettlebells: false, bands: false, other: "" },
      current_e1rm: { squat: 93, bench: 84, deadlift: 102, ohp: 38 },
      best_ever_pr: { squat: 96, bench: null, deadlift: 110, ohp: null },
      previous_programs: "", recent_plateaus: "",
    },
    lifestyle: {
      job_demands: "mixed", commute_minutes: 0, has_dependents: false,
      dependent_notes: "", stress_self_rating: 3,
      days_available: { mon: true, tue: true, wed: true, thu: true,
                        fri: true, sat: false, sun: false },
      earliest_session_time: "06:00", latest_session_time: "21:00",
      travel_frequency: "rare",
    },
    nutrition: {
      current_phase: "cut", current_kcal: 2085,
      current_macros: { protein_g: 168, carb_g: 145, fat_g: 87 },
      tracking_experience: "consistent", restrictions: "",
      alcohol_drinks_per_week: 0, caffeine_mg_per_day: 200, supplements: "creatine 5g",
    },
    sleep_recovery: {
      avg_sleep_hours: 7, typical_bedtime: "21:30", typical_wake_time: "06:30",
      sleep_latency_minutes: 15, awakenings: "1_2",
      mobility_work: "", soreness_frequency: "common",
    },
    goals: {
      primary_type: "strength", primary_metric: "deadlift e1RM",
      target_value: 100, target_unit: "kg", target_date: "2026-08-08",
      why_narrative: "This compound movement will give the strength I need to progress in other areas",
    },
  },
};

const card = {
  variant: "training",
  readiness: { score: 7, hrv: 38, recovery: 58, band: "moderate" },
  recap: {
    yesterday_date: "2026-05-10", sleep_hours: 7.2,
    kcal_actual: 2100, kcal_target: 2085,
    protein_actual_g: 175, protein_target_g: 168,
    trained_yesterday: "Back", top_e1rm_yesterday: { lift: "deadlift", kg: 102 },
  },
  session: {
    type: "Legs", start_time: "13:00",
    exercises: [
      { name: "Squat (Barbell)", sets: 3, reps: 6, kg: 62.5 },
      { name: "Leg Press", sets: 3, reps: 12, kg: 85 },
    ],
  },
  macros: { kcal_target: 2085, protein_target_g: 168, carb_target_g: 145, fat_target_g: 87 },
  tonight: { sleep_target_hours: 7.5, bedtime_target: "21:30" },
};

const flags = {
  has_glp1: true,
  alcohol_low_readiness_warning: false,
  has_active_injuries: false,
  poor_sleep_efficiency: true, // 9h in bed, 7h sleep — gap > 1h
  missed_protein_yesterday: false,
};

console.log("=== Calling Haiku 4.5 with the live prompt ===");
console.log("(This costs ~$0.0005 and takes ~1-2 seconds.)\n");

const advice = await generateAdvice({ activeProfile, card, flags });

console.log("=== Generated advice ===\n");
console.log(advice);
console.log("\n=== Verification checklist ===");
console.log(`- Mentions hunger reminder / GLP-1 (flag fired): look for "reminder" or "GLP" or "hunger"`);
console.log(`- Probes sleep gap (poor_sleep_efficiency fired): look for "9h" or "7h" or "bedtime" or "in bed"`);
console.log(`- 2-4 sentences: count sentences`);
console.log(`- Anchored to 1pm session: look for "13:00" or "1pm" or "11:30" pre-workout window`);
console.log(`- No invented numbers: cross-check any kg/g/kcal against the data block above`);
```

- [ ] **Step 4: Run the probe**

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-brief-advice.mjs
```

Expected output: 2-4 sentences of coach-voiced advice. Visually verify:
- Mentions the GLP-1 hunger-reminder cue (e.g., "set a reminder", "GLP-1", "don't wait for hunger")
- Probes the sleep efficiency gap (9h in bed vs 7h slept — flag fired)
- Eating timing references 13:00 / 1pm or specific 11:30 pre-workout window
- Cites specific food examples (greek yogurt, chicken, rice, etc.)
- All numbers can be traced to the data block (no hallucination)

If the output is off in tone (too clinical / too verbose / forgets a flag), iterate on the prompt instructions in `advice-prompt.ts` before committing.

- [ ] **Step 5: Delete the probe script**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-brief-advice.mjs
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
git add lib/morning/brief/advice-prompt.ts
git commit -m "feat(morning/brief): generateAdvice — single Haiku 4.5 call

generateAdvice() composes the system prompt from athlete context (goal,
phase, meds, injuries from intake_payload) + data block (variant,
session, readiness band, macros, recap) + flags (named booleans), then
calls callClaude() with claude-haiku-4-5, max 350 tokens, temp 0.4.

Conditional instructions in the prompt key off the flags by name:
has_glp1 → hunger reminder cue, alcohol_low_readiness_warning → push
protein early, has_active_injuries → modify per restriction,
missed_protein_yesterday → open with the gap, poor_sleep_efficiency →
probe the sleep gap.

Probe-tested against the live API with the actual user profile (GLP-1
+ sleep efficiency flag). ~\$0.0005 per call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `index.ts` orchestrator

**Files:**
- Create: `lib/morning/brief/index.ts`

- [ ] **Step 1: Create the orchestrator**

Write `lib/morning/brief/index.ts`:

```ts
// lib/morning/brief/index.ts
//
// Orchestrator for the morning brief pipeline:
//   1. Fetch inputs in parallel (data-sources)
//   2. Assemble the structured card except advice_md (pure)
//   3. Compute advice flags (pure)
//   4. Single Haiku call for advice_md
//   5. Return the complete MorningBriefCard
//
// Single entry point called by the route handler.

import type { SupabaseClient } from "@supabase/supabase-js";
import { todayInUserTz } from "@/lib/time";
import type { MorningBriefCard } from "@/lib/data/types";
import { fetchBriefInputs } from "@/lib/morning/brief/data-sources";
import { assembleBriefExceptAdvice } from "@/lib/morning/brief/assembler";
import { computeAdviceFlags } from "@/lib/morning/brief/flags";
import { generateAdvice } from "@/lib/morning/brief/advice-prompt";

export async function buildMorningBrief(
  supabase: SupabaseClient,
  userId: string,
): Promise<MorningBriefCard> {
  const today = todayInUserTz();
  const inputs = await fetchBriefInputs(supabase, userId, today);
  const partial = assembleBriefExceptAdvice(inputs);
  const flags = computeAdviceFlags({
    activeProfile: inputs.activeProfile,
    card: partial,
  });
  const advice_md = await generateAdvice({
    activeProfile: inputs.activeProfile,
    card: partial,
    flags,
  });
  return { ...partial, advice_md };
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
git add lib/morning/brief/index.ts
git commit -m "feat(morning/brief): orchestrator (buildMorningBrief)

Single entry point: fetch inputs → assemble except advice → compute
flags → generate advice → return full card. Wraps the four pure modules
+ one AI call into the public API the route handler consumes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Replace `recommendation/route.ts` + create `retry-brief/route.ts`

**Files:**
- Modify: `app/api/chat/morning/recommendation/route.ts` (replace SSE free-text with structured brief)
- Create: `app/api/chat/morning/retry-brief/route.ts`

- [ ] **Step 1: Read the existing recommendation route carefully**

```bash
cd "/Users/abdelouahedelbied/Health app"
cat app/api/chat/morning/recommendation/route.ts
```

Note the existing patterns:
- Uses `createSupabaseServiceRoleClient()` for the writes (bypasses RLS for the assistant message insert).
- 401 → unauthorized.
- 409 → `no_row` or `already_delivered`.
- 425 → `awaiting_whoop` (no WHOOP data yet AND no `skip_whoop` body flag).
- Sick path → templated REST message, no AI.
- Healthy path → Claude streams the recommendation via SSE.

The brief replaces ALL of these output paths. Status codes are preserved (401 / 409 / 425) but the success response shape changes from SSE deltas to a single JSON `{ ok: true, message: { id, kind: 'morning_brief', ui: MorningBriefCard, content: string } }`.

- [ ] **Step 2: Replace `recommendation/route.ts` contents**

Overwrite `app/api/chat/morning/recommendation/route.ts`:

```ts
// app/api/chat/morning/recommendation/route.ts
//
// POST: deliver today's structured morning brief as the next assistant
// message in the morning_intake thread. Replaces the prior free-text
// recommendation (which streamed via SSE) with a single JSON response
// containing a kind='morning_brief' message and its structured ui jsonb
// payload (MorningBriefCard).
//
// Body: {} | {skip_whoop: true}
// Status codes preserved from the prior implementation:
//   401 unauthorized
//   409 no_row | already_delivered
//   425 awaiting_whoop (only when no skip_whoop and WHOOP data missing)
//   500 brief_failed (AI generation failed — state transitions, client retries)
//   200 success — JSON body { ok: true, message }

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import type { CheckinRow, DailyLog, MorningBriefCard } from "@/lib/data/types";
import { buildMorningBrief } from "@/lib/morning/brief";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { skip_whoop?: boolean };
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  // Fetch today's checkin row
  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  }

  // Idempotency: brief already delivered for today
  if (row.intake_state === "brief_delivered") {
    const existing = await loadExistingBriefMessage(sr, user.id, today);
    if (existing) {
      return NextResponse.json({ ok: false, reason: "already_delivered", message: existing }, { status: 409 });
    }
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Concurrency: another request is in flight
  if (row.intake_state === "assembling_brief") {
    return NextResponse.json({ ok: false, reason: "assembling" }, { status: 409 });
  }

  // WHOOP gating: same as legacy behaviour
  const { data: log } = await sr
    .from("daily_logs")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<DailyLog>();
  if (!body.skip_whoop && (!log || log.recovery == null)) {
    if (row.intake_state !== "awaiting_whoop") {
      await sr.from("checkins").upsert(
        { user_id: user.id, date: today, intake_state: "awaiting_whoop" },
        { onConflict: "user_id,date" },
      );
    }
    return NextResponse.json({ ok: false, reason: "awaiting_whoop" }, { status: 425 });
  }

  // Pipeline: transition to assembling, generate, write, transition to delivered
  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "assembling_brief" },
    { onConflict: "user_id,date" },
  );

  let card: MorningBriefCard;
  try {
    card = await buildMorningBrief(sr, user.id);
  } catch (err) {
    console.error("[morning brief] AI generation failed", err);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "brief_failed" }, { status: 500 });
  }

  // Write the assistant message
  const contentSummary = composeContentFallback(card);
  const { data: inserted, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: user.id,
      role: "assistant",
      kind: "morning_brief",
      content: contentSummary,
      ui: card,
    })
    .select("id, role, kind, content, ui, created_at")
    .single();
  if (insertErr || !inserted) {
    console.error("[morning brief] insert failed", insertErr);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 });
  }

  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "brief_delivered" },
    { onConflict: "user_id,date" },
  );

  return NextResponse.json({ ok: true, message: inserted });
}

async function loadExistingBriefMessage(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  today: string,
) {
  const { data } = await sr
    .from("chat_messages")
    .select("id, role, kind, content, ui, created_at")
    .eq("user_id", userId)
    .eq("kind", "morning_brief")
    .gte("created_at", `${today}T00:00:00Z`)
    .lte("created_at", `${today}T23:59:59Z`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Plain-text fallback for `chat_messages.content`. Renders in chat history
 *  lists / clients that don't know how to consume `kind='morning_brief'`. */
function composeContentFallback(card: MorningBriefCard): string {
  const sessionLine = card.variant === "training"
    ? `Today: ${card.session.type} at ${card.session.start_time}`
    : "Today: REST";
  return `Morning brief — ${sessionLine}. Readiness ${card.readiness.band}. Tap to view the full card.`;
}
```

- [ ] **Step 3: Create `retry-brief/route.ts`**

Write `app/api/chat/morning/retry-brief/route.ts`:

```ts
// app/api/chat/morning/retry-brief/route.ts
//
// POST: retry the morning brief generation. Only valid when
// checkins.intake_state === 'brief_failed' for today.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import type { CheckinRow, MorningBriefCard } from "@/lib/data/types";
import { buildMorningBrief } from "@/lib/morning/brief";

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  const { data: row } = await sr
    .from("checkins")
    .select("intake_state")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<Pick<CheckinRow, "intake_state">>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  }
  if (row.intake_state !== "brief_failed") {
    return NextResponse.json({ ok: false, reason: "not_in_retry_state" }, { status: 409 });
  }

  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "assembling_brief" },
    { onConflict: "user_id,date" },
  );

  let card: MorningBriefCard;
  try {
    card = await buildMorningBrief(sr, user.id);
  } catch (err) {
    console.error("[morning brief retry] AI generation failed", err);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "brief_failed" }, { status: 500 });
  }

  const contentSummary = composeContentFallback(card);
  const { data: inserted, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: user.id,
      role: "assistant",
      kind: "morning_brief",
      content: contentSummary,
      ui: card,
    })
    .select("id, role, kind, content, ui, created_at")
    .single();
  if (insertErr || !inserted) {
    console.error("[morning brief retry] insert failed", insertErr);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 });
  }

  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "brief_delivered" },
    { onConflict: "user_id,date" },
  );

  return NextResponse.json({ ok: true, message: inserted });
}

function composeContentFallback(card: MorningBriefCard): string {
  const sessionLine = card.variant === "training"
    ? `Today: ${card.session.type} at ${card.session.start_time}`
    : "Today: REST";
  return `Morning brief — ${sessionLine}. Readiness ${card.readiness.band}. Tap to view the full card.`;
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. Note: the old recommendation route imported `formatSseEvent` from `@/lib/chat/sse` — that import is removed in the new version. If typecheck complains about unused imports or unreachable code, clean up accordingly.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add app/api/chat/morning/recommendation/route.ts app/api/chat/morning/retry-brief/route.ts
git commit -m "feat(morning/brief): replace recommendation route, add retry-brief

recommendation/route.ts no longer streams a free-text coach message via
SSE. Instead it:
  1. Validates the intake state (preserves legacy 401/409/425 codes)
  2. Transitions to 'assembling_brief'
  3. Calls buildMorningBrief() (pure data + single Haiku call)
  4. Writes a single chat_messages row with kind='morning_brief' and
     the MorningBriefCard payload in ui jsonb
  5. Transitions to 'brief_delivered'
  6. Returns JSON { ok: true, message }

On AI failure: transitions to 'brief_failed', returns 500. Client
surfaces a retry chip; retry-brief/route.ts handles the user-triggered
retry path (only valid when intake_state === 'brief_failed').

Plain-text content fallback ('Morning brief — Today: Legs at 13:00...')
is written to chat_messages.content for clients that don't render the
structured ui payload.

Idempotency: returns 409 'already_delivered' when state is
'brief_delivered'; returns 409 'assembling' when another request is in
flight.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `MorningBriefCard` parent component (variant routing, header, readiness pill, tonight strip)

**Files:**
- Create: `components/morning/MorningBriefCard.tsx`

- [ ] **Step 1: Verify theme tokens used in Phase 1 work**

From Phase 1's COLOR audit: real exports are `textStrong / textMid / textMuted / textFaint / divider / surface / surfaceAlt / accent / accentSoft / accentDeep / danger / dangerSoft / success / successSoft / warning / warningSoft / bg`. No `COLOR.text` or `COLOR.border` (use `textStrong` and `divider` instead).

- [ ] **Step 2: Create the parent component**

Write `components/morning/MorningBriefCard.tsx`:

```tsx
"use client";

import type { CSSProperties } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { MorningBriefCard as MorningBriefCardData } from "@/lib/data/types";
import { BriefRecapStats } from "@/components/morning/BriefRecapStats";
import { BriefSessionList } from "@/components/morning/BriefSessionList";
import { BriefRestActions } from "@/components/morning/BriefRestActions";
import { BriefMacrosGrid } from "@/components/morning/BriefMacrosGrid";
import { BriefAdvice } from "@/components/morning/BriefAdvice";
import { BriefTonight } from "@/components/morning/BriefTonight";

export function MorningBriefCard({ card }: { card: MorningBriefCardData }) {
  return (
    <article
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        width: "100%",
        maxWidth: "100%",
      }}
      aria-label="Today's morning brief"
    >
      <BriefHeader card={card} />
      <Divider />
      <SectionLabel>Yesterday</SectionLabel>
      <BriefRecapStats recap={card.recap} />
      <Divider />
      {card.variant === "training" ? (
        <>
          <SectionLabel>
            Today · {card.session.type}
            {card.session.start_time ? ` · ${card.session.start_time}` : null}
          </SectionLabel>
          <BriefSessionList exercises={card.session.exercises} />
        </>
      ) : (
        <>
          <SectionLabel>Today · REST</SectionLabel>
          <BriefRestActions bedtime={card.tonight.bedtime_target} />
        </>
      )}
      <Divider />
      <SectionLabel>Macros today</SectionLabel>
      <BriefMacrosGrid macros={card.macros} />
      <Divider />
      <BriefAdvice md={card.advice_md} />
      <Divider />
      <BriefTonight tonight={card.tonight} />
    </article>
  );
}

function BriefHeader({ card }: { card: MorningBriefCardData }) {
  const date = formatHeaderDate(card.recap.yesterday_date); // shows today, derived from yesterday + 1
  return (
    <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
            {date}
          </div>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: COLOR.textStrong,
              margin: "2px 0 0",
            }}
          >
            Today's brief
          </h2>
        </div>
        <ReadinessPill band={card.readiness.band} score={card.readiness.score} />
      </div>
    </header>
  );
}

function ReadinessPill({
  band,
  score,
}: {
  band: "low" | "moderate" | "high";
  score: number | null;
}) {
  const styles: Record<typeof band, { bg: string; fg: string; label: string }> = {
    low: { bg: COLOR.dangerSoft, fg: COLOR.danger, label: "Low" },
    moderate: { bg: COLOR.warningSoft, fg: COLOR.warning, label: "Moderate" },
    high: { bg: COLOR.successSoft, fg: COLOR.success, label: "High" },
  };
  const s = styles[band];
  return (
    <div
      style={{
        background: s.bg,
        color: s.fg,
        borderRadius: 999,
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
      aria-label={`Readiness ${s.label}${score !== null ? ` score ${score} of 10` : ""}`}
    >
      Readiness · {s.label}{score !== null ? ` · ${score}/10` : ""}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: COLOR.textMuted,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div style={{ borderTop: `1px solid ${COLOR.divider}` } as CSSProperties} />
  );
}

function formatHeaderDate(yesterdayISO: string): string {
  // Compute today from yesterday + 1, format as "Sunday May 11"
  const y = new Date(`${yesterdayISO}T00:00:00Z`);
  const t = new Date(y.getTime() + 86_400_000);
  return t.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
```

- [ ] **Step 3: Run typecheck**

Will FAIL because the sub-components don't exist yet. That's expected — Tasks 11-12 create them. To keep typecheck green between tasks, stub the sub-components with empty exports.

Create stub files (one-line `export function` declarations that return `null`):

```bash
cd "/Users/abdelouahedelbied/Health app"
mkdir -p components/morning
for f in BriefRecapStats BriefSessionList BriefRestActions BriefMacrosGrid BriefAdvice BriefTonight; do
  cat > "components/morning/${f}.tsx" <<EOF
"use client";
export function ${f}(_props: any) { return null; }
EOF
done
```

(These stubs are temporary scaffolding — Tasks 11 and 12 replace them with real implementations.)

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS (stubs accept any props; parent compiles).

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/morning/MorningBriefCard.tsx components/morning/BriefRecapStats.tsx components/morning/BriefSessionList.tsx components/morning/BriefRestActions.tsx components/morning/BriefMacrosGrid.tsx components/morning/BriefAdvice.tsx components/morning/BriefTonight.tsx
git commit -m "feat(morning/brief): MorningBriefCard parent + sub-component stubs

Parent card component renders header (date + 'Today's brief' label +
band-colored readiness pill), then routes between training and rest
variants for the Today block. Composes Recap, Session/Rest, Macros,
Advice, Tonight sub-components inline with dividers.

Header date is computed from recap.yesterday_date + 1 (since the card
naturally has yesterday's date but the user reads it 'today').

Sub-components are temporarily stubbed as no-op exports — Tasks 11 and
12 replace them with real implementations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Sub-components — `BriefRecapStats`, `BriefSessionList`, `BriefRestActions`

**Files:**
- Modify: `components/morning/BriefRecapStats.tsx` (replace stub)
- Modify: `components/morning/BriefSessionList.tsx` (replace stub)
- Modify: `components/morning/BriefRestActions.tsx` (replace stub)

- [ ] **Step 1: Implement `BriefRecapStats.tsx`**

Overwrite `components/morning/BriefRecapStats.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefRecap } from "@/lib/data/types";

export function BriefRecapStats({ recap }: { recap: MorningBriefRecap }) {
  const stats: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "Sleep",
      value: recap.sleep_hours !== null ? `${recap.sleep_hours}h` : "—",
    },
    {
      label: "Kcal",
      value: recap.kcal_actual !== null ? `${recap.kcal_actual}` : "—",
      sub: recap.kcal_target > 0 ? `/${recap.kcal_target}` : undefined,
    },
    {
      label: "Protein",
      value:
        recap.protein_actual_g !== null
          ? `${recap.protein_actual_g}g`
          : "—",
      sub: recap.protein_target_g > 0 ? `/${recap.protein_target_g}g` : undefined,
    },
    {
      label: "Trained",
      value: recap.trained_yesterday ?? "—",
      sub: recap.top_e1rm_yesterday
        ? `${recap.top_e1rm_yesterday.lift} ${recap.top_e1rm_yesterday.kg}`
        : undefined,
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 8,
      }}
    >
      {stats.map((s) => (
        <div
          key={s.label}
          style={{
            background: COLOR.surfaceAlt,
            borderRadius: 10,
            padding: "10px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            alignItems: "flex-start",
          }}
          aria-label={`${s.label}: ${s.value}${s.sub ? ` ${s.sub}` : ""}`}
        >
          <div style={{ fontSize: 10, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {s.label}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
            {s.value}
          </div>
          {s.sub && (
            <div style={{ fontSize: 11, color: COLOR.textFaint, lineHeight: 1.2 }}>
              {s.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `BriefSessionList.tsx`**

Overwrite `components/morning/BriefSessionList.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefExercise } from "@/lib/data/types";

export function BriefSessionList({ exercises }: { exercises: MorningBriefExercise[] }) {
  if (exercises.length === 0) {
    return (
      <div style={{ fontSize: 13, color: COLOR.textMuted, fontStyle: "italic" }}>
        No exercises planned for this session type.
      </div>
    );
  }
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {exercises.map((e, i) => (
        <div
          key={`${e.name}-${i}`}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 12px",
            borderTop: i === 0 ? "none" : `1px solid ${COLOR.divider}`,
            gap: 8,
          }}
          aria-label={ariaForExercise(e)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: COLOR.textStrong,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {e.name}
            </div>
            {e.note && (
              <div style={{ fontSize: 11, color: COLOR.textFaint, fontStyle: "italic" }}>
                {e.note}
              </div>
            )}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
              {e.kg !== null ? `${e.kg} kg` : "BW"}
            </div>
            <div style={{ fontSize: 11, color: COLOR.textMuted, lineHeight: 1.2 }}>
              {e.sets} × {e.reps}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ariaForExercise(e: MorningBriefExercise): string {
  const weight = e.kg !== null ? `${e.kg} kilograms` : "bodyweight";
  return `${e.name}, ${weight}, ${e.sets} sets of ${e.reps} reps`;
}
```

- [ ] **Step 3: Implement `BriefRestActions.tsx`**

Overwrite `components/morning/BriefRestActions.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";

export function BriefRestActions({ bedtime }: { bedtime: string }) {
  const items = [
    "15 min full-body mobility",
    "8k steps / 60 min walk",
    `Sleep priority — bed by ${bedtime}`,
  ];
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>
        Recovery focus:
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, color: COLOR.textMid, fontSize: 13, lineHeight: 1.6 }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
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
git add components/morning/BriefRecapStats.tsx components/morning/BriefSessionList.tsx components/morning/BriefRestActions.tsx
git commit -m "feat(morning/brief): RecapStats + SessionList + RestActions sub-components

BriefRecapStats: 4-column grid (Sleep / Kcal / Protein / Trained) on
surfaceAlt background, value bold above sub-line (target or top-e1rm
context), aria-label for screen readers.

BriefSessionList: exercise rows in surfaceAlt container, name + optional
note on the left, weight + sets×reps on the right. Falls back to 'BW'
when kg is null (bodyweight or duration-based).

BriefRestActions: rest-variant content — 3 hardcoded items (mobility,
steps, sleep priority with bedtime). Static for v1; data-driven content
deferred.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Sub-components — `BriefMacrosGrid`, `BriefAdvice`, `BriefTonight`

**Files:**
- Modify: `components/morning/BriefMacrosGrid.tsx` (replace stub)
- Modify: `components/morning/BriefAdvice.tsx` (replace stub)
- Modify: `components/morning/BriefTonight.tsx` (replace stub)

- [ ] **Step 1: Implement `BriefMacrosGrid.tsx`**

Overwrite `components/morning/BriefMacrosGrid.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefMacros } from "@/lib/data/types";

export function BriefMacrosGrid({ macros }: { macros: MorningBriefMacros }) {
  const cells: Array<{ label: string; value: string }> = [
    { label: "Calories", value: `${macros.kcal_target} kcal` },
    { label: "Protein", value: `${macros.protein_target_g}g` },
    { label: "Carb", value: `${macros.carb_target_g}g` },
    { label: "Fat", value: `${macros.fat_target_g}g` },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            background: COLOR.accentSoft,
            borderRadius: 10,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
          aria-label={`${c.label}: ${c.value}`}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
            {c.value}
          </div>
          <div style={{ fontSize: 11, color: COLOR.accentDeep, fontWeight: 600 }}>
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `BriefAdvice.tsx`**

Overwrite `components/morning/BriefAdvice.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";

/** Renders the AI-generated advice prose. The output is constrained to
 *  bold/italic markdown by the prompt — we render it as plain text with
 *  CSS-only emphasis interpretation. Keep this simple: no full markdown
 *  parser, no link rendering. If the prose contains malformed markdown
 *  the user just sees the raw chars — acceptable for v1 since the prompt
 *  caps complexity. */
export function BriefAdvice({ md }: { md: string }) {
  return (
    <div
      style={{
        background: COLOR.accentSoft,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: COLOR.accentDeep,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        Coach
      </div>
      <div
        style={{
          fontSize: 14,
          color: COLOR.textStrong,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
        }}
        dangerouslySetInnerHTML={{ __html: lightMarkdown(md) }}
      />
    </div>
  );
}

/** Minimal markdown subset: **bold** and *italic*. Everything else is
 *  passed through as plain text. HTML-escapes the input first so
 *  user-supplied content cannot inject markup. */
function lightMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}
```

- [ ] **Step 3: Implement `BriefTonight.tsx`**

Overwrite `components/morning/BriefTonight.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefTonight } from "@/lib/data/types";

export function BriefTonight({ tonight }: { tonight: MorningBriefTonight }) {
  // Wake target = bedtime + sleep_target_hours, formatted as HH:mm
  const wakeTarget = addHoursToHHmm(tonight.bedtime_target, tonight.sleep_target_hours);
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: 10,
        padding: "10px 12px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
      aria-label={`Tonight target: bed by ${tonight.bedtime_target}, wake by ${wakeTarget}, ${tonight.sleep_target_hours} hours`}
    >
      <div style={{ fontSize: 11, color: COLOR.textMuted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Tonight
      </div>
      <div style={{ fontSize: 13, color: COLOR.textMid }}>
        {tonight.bedtime_target} → {wakeTarget} ({tonight.sleep_target_hours}h target)
      </div>
    </div>
  );
}

function addHoursToHHmm(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "—";
  const totalMinutes = (h * 60 + m + Math.round(hours * 60)) % (24 * 60);
  const wh = Math.floor(totalMinutes / 60);
  const wm = totalMinutes % 60;
  return `${String(wh).padStart(2, "0")}:${String(wm).padStart(2, "0")}`;
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
git add components/morning/BriefMacrosGrid.tsx components/morning/BriefAdvice.tsx components/morning/BriefTonight.tsx
git commit -m "feat(morning/brief): MacrosGrid + Advice + Tonight sub-components

BriefMacrosGrid: 2x2 grid on accentSoft background — value bold above
small accentDeep label.

BriefAdvice: AI-generated prose block on accentSoft background with
'Coach' header label. Minimal markdown rendering — supports **bold**
and *italic* only. HTML-escapes input first so prose can't inject
markup; everything else passes through as plain text.

BriefTonight: bottom strip showing bedtime → computed wake time
(bedtime + sleep_target_hours, modulo 24h for crossing midnight) +
hours target. Static one-liner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: `ChatPanel` integration

**Files:**
- Modify: `components/chat/ChatPanel.tsx`

The existing recommendation call uses `postSse(...)` with delta-append loop. The new endpoint returns JSON. The recommendation route still has the same URL (`/api/chat/morning/recommendation`) so the call site change is minimal: switch from `postSse` to `fetch`, parse JSON, add the returned message to local state directly.

Plus: route messages where `kind === 'morning_brief'` to `<MorningBriefCard>` in the render loop.

- [ ] **Step 1: Locate the existing call site**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -n "morning/recommendation\|postSse" components/chat/ChatPanel.tsx | head -10
```

Note line numbers for:
- The `postSse` call to `/api/chat/morning/recommendation`
- The reducer/dispatch logic for `append_delta`, `replace_id`, `finalize_assistant`

These are the surfaces that change.

- [ ] **Step 2: Replace the SSE call with a JSON fetch**

In `components/chat/ChatPanel.tsx`, find the block that looks like:

```tsx
for await (const ev of postSse("/api/chat/morning/recommendation", body)) {
  if (ev.type === "delta") {
    dispatch({ type: "append_delta", id: tempId, text: ev.text });
  } else if (ev.type === "done") {
    dispatch({ type: "replace_id", tempId, serverId: ev.message_id });
    dispatch({ type: "finalize_assistant", id: ev.message_id, status: "done" });
  } else if (ev.type === "error") {
    // ...existing error handling
  }
}
```

Replace it with a JSON fetch:

```tsx
const res = await fetch("/api/chat/morning/recommendation", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (res.status === 425) {
  // awaiting_whoop — client parks and retries when WHOOP data arrives.
  // Existing logic for this status is preserved; the only behavioural change
  // is that we no longer have a streaming bubble to remove.
  parkedSilently = true;
  dispatch({ type: "remove_id", id: tempId });
  return;
}

if (!res.ok) {
  const json = await res.json().catch(() => ({} as { reason?: string }));
  const reason = (json as { reason?: string }).reason ?? "unknown";

  // 409 'already_delivered' with a message payload: render the existing brief
  if (reason === "already_delivered" && (json as { message?: unknown }).message) {
    dispatch({ type: "remove_id", id: tempId });
    dispatch({
      type: "add_message",
      message: (json as { message: ChatMessage }).message,
    });
    return;
  }

  // 500 'brief_failed' — surface retry chip; remove the placeholder bubble
  if (reason === "brief_failed") {
    dispatch({ type: "remove_id", id: tempId });
    // The retry chip is rendered by the morning intake polling layer when
    // intake_state === 'brief_failed' (existing chip-rendering pattern).
    // No additional client-side state needed here.
    return;
  }

  // Other failures: surface a generic error bubble (existing pattern)
  dispatch({ type: "finalize_assistant", id: tempId, status: "error" });
  return;
}

const json = (await res.json()) as { ok: true; message: ChatMessage };
dispatch({ type: "remove_id", id: tempId });
dispatch({ type: "add_message", message: json.message });
```

Note: this assumes `ChatMessage` type is in scope (likely imported from `lib/chat/types.ts` or `lib/data/types.ts`). And it assumes a reducer action `add_message` exists or needs to be added. Check the existing reducer:

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -n "reducer\|type: \"" components/chat/ChatPanel.tsx | head -30
```

If `add_message` doesn't exist as a reducer action, add it (one case in the reducer that appends a fully-formed message to state).

If `remove_id` doesn't exist either, add it (one case that filters out the temp placeholder by id).

These reducer additions are surgical; preserve existing actions intact.

- [ ] **Step 3: Add render branch for `kind='morning_brief'`**

In the messages-rendering loop in `ChatPanel.tsx`, before the existing `<ChatBubble>` render path, add:

```tsx
if (m.kind === "morning_brief") {
  return (
    <MorningBriefCard
      key={m.id}
      card={m.ui as MorningBriefCard}
    />
  );
}
```

(`MorningBriefCard` is the type from `lib/data/types.ts`. The component import is `MorningBriefCard` from `@/components/morning/MorningBriefCard` — same name, different shape. Alias one on import if needed:

```tsx
import { MorningBriefCard as MorningBriefCardComponent } from "@/components/morning/MorningBriefCard";
import type { MorningBriefCard } from "@/lib/data/types";
```

Then render as `<MorningBriefCardComponent card={m.ui as MorningBriefCard} />`.)

- [ ] **Step 4: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add components/chat/ChatPanel.tsx
git commit -m "feat(chat): integrate morning brief — JSON fetch + card render

ChatPanel's call to /api/chat/morning/recommendation switches from SSE
(postSse + delta-append loop) to a single fetch + JSON response. The
new endpoint returns the full assistant message in one shot (no
streaming) since the brief is structured, not prose.

Status handling preserves the legacy 425 awaiting_whoop park-and-retry
flow. Adds branches for:
  - 409 already_delivered with message payload → render the existing brief
  - 500 brief_failed → remove placeholder; retry chip surfaces via the
    existing morning intake polling layer when intake_state='brief_failed'
  - 200 ok → add the returned message to local state directly

Render loop routes kind='morning_brief' messages to <MorningBriefCard>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: End-to-end manual smoke + CLAUDE.md polish

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Coach/AI bullet to CLAUDE.md**

Open `CLAUDE.md`, find the "Coach / AI" section. Add a new bullet at the end:

```
- **Morning brief (post-intake daily card)**: at the end of the morning intake state machine, a single structured chat card (`chat_messages.kind = 'morning_brief'`, structured `ui` jsonb of shape `MorningBriefCard`) is written by [app/api/chat/morning/recommendation/route.ts](app/api/chat/morning/recommendation/route.ts). The card has 5-7 blocks: yesterday recap, today's readiness band, today's session details (training variant) or recovery focus (rest variant), macros target, AI-generated coach advice, tonight's sleep target. The Advice block is the only AI-generated content — single Anthropic Haiku 4.5 call via [lib/morning/brief/index.ts](lib/morning/brief/index.ts). Pre-computed flags in [lib/morning/brief/flags.ts](lib/morning/brief/flags.ts) carry adaptive coaching context (GLP-1, alcohol, injuries, sleep efficiency, missed protein) into the prompt. State machine extends 0007 with `assembling_brief` → `brief_delivered` (or `brief_failed` on retry). Idempotent: one brief per user per day; retry via [app/api/chat/morning/retry-brief/route.ts](app/api/chat/morning/retry-brief/route.ts) when `intake_state = 'brief_failed'`. Phase-2-compatible via [lib/morning/brief/get-today-targets.ts](lib/morning/brief/get-today-targets.ts) abstraction (Phase 1 reads `intake_payload.nutrition`; Phase 2 will swap to `plan_payload.nutrition` without touching the brief).
```

- [ ] **Step 2: Build production bundle (catches non-typecheck issues)**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run build 2>&1 | tail -20
```

Expected: build succeeds. Look for any error messages in the output (warnings are OK).

- [ ] **Step 3: Manual end-to-end smoke — happy path**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run dev
```

Open the app in a browser. Walk through the happy path:

1. **Cold start.** Visit the app on a morning where you haven't completed intake. Bot opens to `awaiting_feel`.
2. **Complete intake.** Tap chips through: readiness → energy → mood → soreness gate → (soreness areas + severity if applicable) → fatigue → bloating.
3. **Brief renders.** Within ~3 seconds of the bloating tap, a new assistant message appears in the chat. Verify visually:
   - **Header**: today's weekday + month + day, "Today's brief" title, readiness pill colored by band (green/amber/red for high/moderate/low) with score
   - **Yesterday block**: 4-column grid (Sleep / Kcal / Protein / Trained). Each cell shows value with target sub-line where applicable.
   - **Today block**: If training day: session type + start time, exercise list (name + weight + sets×reps + optional note). If REST: "Recovery focus:" list (3 items).
   - **Macros grid**: 2×2, kcal / protein / carb / fat targets.
   - **Coach block**: AI-generated 2-4 sentences. Mentions GLP-1 hunger reminder + sleep efficiency gap (for the test user). Anchored to 1pm session time.
   - **Tonight strip**: bedtime → wake time + hours target.

- [ ] **Step 4: Manual smoke — DB state verification**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db query --linked "select intake_state from checkins where date = current_date::text order by created_at desc limit 1;"
```

Expected: `intake_state = 'brief_delivered'`.

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db query --linked "select kind, content, jsonb_pretty(ui) as ui from chat_messages where kind = 'morning_brief' and created_at >= current_date::text order by created_at desc limit 1;"
```

Expected:
- `kind = 'morning_brief'`
- `content` is the plain-text fallback ("Morning brief — Today: Legs at 13:00. Readiness moderate. Tap to view the full card.")
- `ui` is the pretty-printed `MorningBriefCard` jsonb with all blocks populated

- [ ] **Step 5: Manual smoke — idempotency**

Close the chat, reopen it. Verify:
- The brief card remains in the chat scroll (rendered from `chat_messages` history).
- No new brief was generated (no duplicate cards, no new `chat_messages` row).

Trigger another intake submission attempt (e.g., POST to `/api/chat/morning/recommendation` manually via DevTools). Expected response: `409 { ok: false, reason: 'already_delivered', message: {...} }`.

- [ ] **Step 6: Manual smoke — REST day variant**

Temporarily switch today's session type to REST. Easiest path: insert/update a `training_weeks` row for the current week-start so today's weekday maps to `"REST"`. Alternatively, find today's `daily_logs` row and edit `WEEKLY_SESSIONS` in `lib/coach/sessionPlans.ts` to make today's weekday "REST", then restart dev server.

Repeat the intake flow. Verify:
- Today block shows "Today · REST" header with the 3-item recovery focus list (mobility / steps / sleep priority).
- Session block has no exercise list.
- Macros, Advice, Tonight blocks still render normally.
- Advice prose adapts: "spread protein across 4 meals" or similar rest-day language; no pre/post-workout timing.

- [ ] **Step 7: Manual smoke — AI failure / retry path**

Temporarily set `ANTHROPIC_API_KEY=invalid` in `.env.local`, restart `npm run dev`.

Repeat the intake flow. Verify:
- No `morning_brief` message appears in chat after the bloating tap.
- DB state: `select intake_state from checkins where date = current_date::text` → returns `'brief_failed'`.
- Client UI: the morning intake bot's polling layer detects the failure state and renders a retry chip turn — one chip labeled "Try again".

Restore `ANTHROPIC_API_KEY`, restart dev. Tap "Try again" chip. Verify:
- POST goes to `/api/chat/morning/retry-brief`.
- Brief renders correctly.
- DB state advances to `'brief_delivered'`.

(Note: if the retry chip turn isn't surfacing from the existing morning bot UI layer, that's a separate UX gap to address. The retry-brief endpoint itself works; the chip plumbing is the existing `kind='morning_intake'` + `ui.chips` pattern. If the chip doesn't auto-appear, the user can hit `/api/chat/morning/retry-brief` manually via DevTools for v1 validation; the chip surfacing is a follow-up if needed.)

- [ ] **Step 8: Cross-feature smoke — coach reads the brief**

After the brief is in chat history, open `/coach` (regular coach chat, not morning bot). Ask: "What did you tell me to eat this morning?"

Verify the coach response references the specific content of today's brief (pre-workout window, protein target, etc.). The brief is in `chat_messages` with `kind='morning_brief'`; the default-mode coach pulls thread history as usual.

- [ ] **Step 9: Final commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add CLAUDE.md
git commit -m "docs(coach): document morning brief flow in CLAUDE.md

End-to-end manually verified per the spec checklist:
  - Happy path: intake completes → structured brief renders within ~3s
  - DB state: intake_state advances to brief_delivered; chat_messages
    has a kind='morning_brief' row with structured ui payload
  - Idempotency: reopening chat doesn't regenerate; 409 'already_delivered'
    on duplicate POST attempts
  - REST variant: rest-day card replaces session block with recovery
    focus list; advice adapts (protein distribution + sleep prep)
  - Failure path: AI failure → state goes to brief_failed; retry endpoint
    transitions back through assembling_brief → brief_delivered
  - Cross-feature: regular /coach chat can reference the brief's content
    via chat history

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Push branch and open PR**

```bash
cd "/Users/abdelouahedelbied/Health app"
git push -u origin feat/morning-brief
gh pr create --title "feat: morning brief (post-intake daily plan card)" --body "$(cat <<'EOF'
Implements the Morning Brief feature per [docs/superpowers/specs/2026-05-11-morning-brief-design.md](docs/superpowers/specs/2026-05-11-morning-brief-design.md).

## What ships
- 5-7 block structured brief card rendered at the end of every morning intake
- Yesterday recap + today's readiness band + today's session (training variant) or recovery focus (rest variant) + macros target + AI-generated coach advice + tonight's sleep target
- Single Anthropic Haiku 4.5 call per brief (~\$0.0005/morning); everything else is deterministic
- 5 pre-computed adaptive coaching flags in TS code (GLP-1, alcohol, injuries, sleep efficiency, missed protein)
- State machine: assembling_brief → brief_delivered (or brief_failed → retry)
- Strict 1-per-day idempotency via checkins.intake_state
- REST day variant with recovery-focus content
- Forward-compatible with Phase 2 via get-today-targets abstraction

## Replaces
The existing `recommendation/route.ts` which streamed a free-text coach message via SSE. New route returns a single JSON response with the structured `kind='morning_brief'` message.

## Schema
Migration `0011_morning_brief.sql` — additive only (widens two CHECK constraints).

## Verification
Manual end-to-end smoke completed per spec checklist. No automated test runner in this codebase.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

After completing all 14 tasks, review against the spec:

**1. Spec coverage** — every section of the spec is implemented:
- Schema (§Schema in spec) → Task 1
- TypeScript types (§Types) → Task 2
- `get-today-targets` Phase-1 abstraction → Task 3
- 5 day-1 adaptive flags → Task 4
- Pure assembler with training/rest variants + readiness band → Task 5
- Parallel data sources → Task 6
- Haiku-driven advice prompt → Task 7
- Orchestrator → Task 8
- Route handler (replace recommendation + new retry-brief) → Task 9
- UI card parent + 6 sub-components → Tasks 10-12
- ChatPanel integration (SSE → JSON + render routing) → Task 13
- CLAUDE.md docs + end-to-end smoke → Task 14

**2. Placeholder scan** — none of the writing-plans red-flag patterns are present. Every step has actual code or commands.

**3. Type consistency** — `MorningBriefCard` shape, `AdviceFlags` shape, `BriefInputs` shape, all match across:
- Task 2 (type definitions)
- Task 4 (flags) — `AdviceFlags`
- Task 5 (assembler) — `BriefInputs`, `MorningBriefCard` minus `advice_md`
- Task 6 (data-sources) — `BriefInputs`
- Task 7 (advice-prompt) — `AdviceContext`, `MorningBriefCard` minus `advice_md`
- Task 8 (orchestrator) — full `MorningBriefCard`
- Task 9 (route) — `MorningBriefCard`
- Tasks 10-12 (UI components) — consume `MorningBriefCard` sub-shapes

---

## Phase 2 → Morning Brief integration when Phase 2 lands

When Phase 2 ships AI plan generation:

- `get-today-targets.ts` swaps its query from `athlete_profile_documents.intake_payload.nutrition` to `athlete_profile_documents.plan_payload.nutrition` (and `.sleep` for `bedtime` / `sleep_hours_target`).
- The brief consumer signature is stable — no other file changes.
- Bonus: the AI advice prompt's `Athlete context` block gains the prescribed-vs-self-reported distinction. The morning brief becomes "your plan says 2,400 kcal but you've been averaging 1,950 — let's stay on plan today" tier of coaching context.

Estimated effort to swap when Phase 2 lands: ~30 lines of code in `get-today-targets.ts`, ~30 lines of prompt-context plumbing in `advice-prompt.ts`. No UI changes.
