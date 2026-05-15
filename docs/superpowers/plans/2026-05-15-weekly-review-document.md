# Weekly Review Document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #1 of the coach-as-real-coach arc — a Sunday auto-drafted weekly review document with last-week recap, interactive reconfirm chips, 4-week trend signals, per-lift periodization-aware prescription, narrative coach voice, and HMAC-gated commit to `training_weeks`.

**Architecture:** Mirrors `lib/coach/plan-builder/` pattern — six deterministic composers produce a structured `WeeklyReviewPayload`; one Sonnet 4.6 call narrates §6 prose. New `weekly_reviews` table (versioned, like `athlete_profile_documents`). Surfaces: chat card (`kind='weekly_review'`) + page at `/coach/weeks/[week_start]`. Vercel cron Sunday 04:00 UTC + Monday catch-up.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + RLS), TanStack Query (hybrid SSR-hydrate), Anthropic SDK (Sonnet 4.6), Tailwind v4, existing [lib/coach/weight-rounding.ts](../../../lib/coach/weight-rounding.ts) for plate-load resolution.

**Spec:** [docs/superpowers/specs/2026-05-15-weekly-review-document-design.md](../specs/2026-05-15-weekly-review-document-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create worktree (optional but recommended)**

  ```bash
  git worktree add -b feat/weekly-review ../health-app-weekly-review main
  cd ../health-app-weekly-review
  npm install
  cp ../Health\ app/.env.local .env.local
  ```

  Continue work in the worktree. Cleanup via `git worktree remove` when shipped.

- [ ] **Pre-flight 2: Verify clean baseline**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0. If it doesn't, stop and fix unrelated breakage before continuing.

---

## File Structure

**New files (28):**

| Path | Purpose |
|---|---|
| `supabase/migrations/0014_weekly_reviews.sql` | Table + chat_messages.kind extension |
| `lib/coach/weekly-review/index.ts` | Orchestrator |
| `lib/coach/weekly-review/phase-mapping.ts` | week_n → MEV/MAV/MRV/Deload helper |
| `lib/coach/weekly-review/compose-recap.ts` | §2 last-week composer |
| `lib/coach/weekly-review/compose-reconfirm.ts` | §3 discrepancy detector |
| `lib/coach/weekly-review/compose-trends.ts` | §4 4-week rolling signals |
| `lib/coach/weekly-review/compose-prescription.ts` | §5 per-lift rules engine |
| `lib/coach/weekly-review/compose-volume.ts` | §5/§7 per-muscle volume targets |
| `lib/coach/weekly-review/compose-targets.ts` | §7 nutrition/sleep/recovery |
| `lib/coach/weekly-review/narrative-prompt.ts` | §6 single Sonnet 4.6 call |
| `lib/coach/weekly-review/regenerate-narrative.ts` | Narrative-only re-render after reconfirm |
| `lib/query/fetchers/weeklyReview.ts` | Server + browser fetcher variants |
| `lib/query/hooks/useWeeklyReview.ts` | Read hook |
| `app/api/coach/weekly-review/sync/route.ts` | Cron endpoint |
| `app/api/coach/weekly-review/[id]/regenerate/route.ts` | Manual regen |
| `app/api/coach/weekly-review/[id]/reconfirm/route.ts` | Chip answers |
| `app/api/coach/weekly-review/[id]/commit/route.ts` | HMAC-gated commit |
| `app/api/coach/weekly-review/[id]/adjust-nutrition/route.ts` | Deficit adjustment |
| `app/coach/weeks/[week_start]/page.tsx` | Server component |
| `app/coach/weeks/[week_start]/loading.tsx` | Skeleton |
| `components/coach/WeeklyReviewPage.tsx` | Page container client component |
| `components/coach/WeeklyReviewHeader.tsx` | §1 |
| `components/coach/WeeklyReviewRecap.tsx` | §2 |
| `components/coach/WeeklyReviewReconfirm.tsx` | §3 interactive chips |
| `components/coach/WeeklyReviewTrends.tsx` | §4 |
| `components/coach/WeeklyReviewPrescription.tsx` | §5 per-lift table |
| `components/coach/WeeklyReviewNarrative.tsx` | §6 prose |
| `components/coach/WeeklyReviewTargets.tsx` | §7 schedule + macros + sleep |
| `components/coach/WeeklyReviewActions.tsx` | §8 chip group |
| `components/coach/AdjustDeficitSheet.tsx` | Bottom sheet for ±kcal |
| `components/coach/WeekReviewBanner.tsx` | Mid-week discoverability on /coach |
| `components/chat/WeeklyReviewCard.tsx` | Chat card render |
| `scripts/audit-weekly-review.mjs` | Manual exercise script |

**Modified files (6):**

| Path | Change |
|---|---|
| `lib/data/types.ts` | Add `WeeklyReviewPayload`, `WeeklyReviewCard`, `ReconfirmResponses`, `WeeklyReviewRow`, extend `ResearchPhase` doc-comment |
| `lib/query/keys.ts` | Add `weeklyReviews` namespace |
| `lib/coach/tools.ts` | Register `commit_weekly_plan`, `regenerate_weekly_review`, `propose_nutrition_adjustment` |
| `components/chat/ChatMessage.tsx` | Dispatch `kind='weekly_review'` to `WeeklyReviewCard` |
| `components/coach/CoachClient.tsx` | Render `WeekReviewBanner` mid-week |
| `vercel.json` | Add Sunday + Monday cron entries |

---

## Slice 1 — Data foundation, types, query infrastructure

Goal: Database row exists, types compile, queries fetch (empty results OK). No domain logic, no UI.

### Task 1.1: Migration 0014 — weekly_reviews table + chat_messages.kind extension

**Files:**
- Create: `supabase/migrations/0014_weekly_reviews.sql`

- [ ] **Step 1: Write the migration**

  Create `supabase/migrations/0014_weekly_reviews.sql`:

  ```sql
  -- 0014_weekly_reviews.sql
  -- Weekly review document — sub-project #1 of the coach-as-real-coach arc.
  -- See docs/superpowers/specs/2026-05-15-weekly-review-document-design.md

  create table public.weekly_reviews (
    id                          uuid primary key default gen_random_uuid(),
    user_id                     uuid not null references auth.users(id) on delete cascade,
    week_start                  date not null,
    next_week_start             date not null,
    version                     int  not null default 1,
    status                      text not null check (status in ('draft','committed','superseded'))
                                                      default 'draft',
    block_id                    uuid references public.training_blocks(id),
    payload                     jsonb not null,
    narrative_md                text  not null,
    reconfirm_responses         jsonb not null default '{}'::jsonb,
    committed_at                timestamptz,
    committed_training_week_id  uuid references public.training_weeks(id),
    generated_at                timestamptz not null default now(),
    updated_at                  timestamptz not null default now(),
    created_at                  timestamptz not null default now(),
    unique (user_id, week_start, version)
  );

  create index weekly_reviews_user_week_idx
    on public.weekly_reviews(user_id, week_start desc);
  create index weekly_reviews_draft_idx
    on public.weekly_reviews(user_id, status)
    where status = 'draft';

  alter table public.weekly_reviews enable row level security;

  create policy weekly_reviews_select on public.weekly_reviews
    for select using (auth.uid() = user_id);
  -- No INSERT/UPDATE/DELETE policies: all writes go through service-role endpoints.

  -- Extend chat_messages.kind union to include 'weekly_review'.
  alter table public.chat_messages
    drop constraint if exists chat_messages_kind_check;
  alter table public.chat_messages
    add constraint chat_messages_kind_check check (
      kind in ('message','morning_intake','morning_brief','weekly_review')
    );
  ```

- [ ] **Step 2: Apply via Supabase CLI**

  ```bash
  supabase db push
  ```

  If prompted about migration history mismatch, run:

  ```bash
  supabase migration list
  # if 0014 shows local-only but you've already inserted manually, run:
  supabase migration repair --status applied 0014
  ```

- [ ] **Step 3: Verify the table exists**

  ```bash
  supabase db remote-execute "select column_name, data_type from information_schema.columns where table_name='weekly_reviews' order by ordinal_position;"
  ```

  Expected: lists 14 columns matching the migration.

- [ ] **Step 4: Verify the kind constraint accepts weekly_review**

  ```bash
  supabase db remote-execute "select pg_get_constraintdef(oid) from pg_constraint where conname='chat_messages_kind_check';"
  ```

  Expected: `CHECK (kind = ANY (ARRAY['message'::text, 'morning_intake'::text, 'morning_brief'::text, 'weekly_review'::text]))`.

- [ ] **Step 5: Commit**

  ```bash
  git add supabase/migrations/0014_weekly_reviews.sql
  git commit -m "feat(db): add weekly_reviews table + extend chat_messages.kind"
  ```

### Task 1.2: Types in lib/data/types.ts

**Files:**
- Modify: `lib/data/types.ts` (append after morning-brief types around line 690)

- [ ] **Step 1: Add the new types**

  Open `lib/data/types.ts`. Find the section right after `MorningBriefTonight` (around line 689). Append:

  ```ts
  // ── Weekly review (0014_weekly_reviews) ─────────────────────────────────────

  export type WeeklyPhase = "mev" | "mav" | "mrv" | "deload";

  /** Rationale tag for a per-lift prescription. Composable suffixes
   *  `_increment_floor` / `_increment_capped` may be appended by
   *  `compose-prescription.ts` when physical loading constraints force
   *  a hold despite a non-zero target step. */
  export type PrescriptionRationaleTag =
    | "block_start_baseline"
    | "cutting_hold"
    | "recovery_hold"
    | "plateau_deload_reset"
    | "plateau_rep_shift"
    | "rep_completion_miss"
    | "rir_missed_twice"
    | "rir_missed"
    | "form_hold"
    | "mev_to_mav_clearance"
    | "mav_to_mav_step"
    | "mav_to_mrv_advance"
    | "mrv_volume_drive"
    | "deload_load_volume_cut"
    | string;  // open for `_increment_floor` / `_increment_capped` suffixes

  export type WeeklyReviewPayload = {
    schema_version: 1;
    header: {
      week_n: number;
      total_weeks: number;
      block_goal_text: string;
      block_phase_now: WeeklyPhase;
      block_phase_next: WeeklyPhase;
      on_pace: boolean | null;
      weeks_remaining: number;
      late: boolean;
    };
    recap: {
      sessions_planned: number;
      sessions_done: number;
      sessions_skipped: Array<{ day: string; type: string }>;
      sessions_swapped: Array<{ day: string; from: string; to: string }>;
      per_lift: Array<{
        lift: string;
        top_set: { weight_kg: number; reps: number; sets: number };
        reps_completed_pct: number | null;
        e1rm_kg: number | null;
        e1rm_delta_kg: number | null;
        e1rm_delta_pct: number | null;
        e1rm_history_3wk: number[];
        rir_target_met: boolean | null;
        rir_miss_consecutive: number;
        form_notes: string[];
      }>;
      sleep: { avg_h: number | null; avg_efficiency_pct: number | null };
      nutrition: {
        kcal_avg: number | null; kcal_target: number | null;
        protein_avg_g: number | null; protein_target_g: number | null;
      };
      weight: { start_kg: number | null; end_kg: number | null; delta_kg: number | null };
    };
    reconfirm: Array<{
      id: string;
      severity: "info" | "warn";
      rule_tag: string;
      question: string;
      chips: Array<{ value: string; label: string }>;
    }>;
    trends: {
      window_weeks: 4;
      weight_loss_kg_per_week: number | null;
      loss_rate_in_target_band: boolean | null;
      strength_slope_pct_per_week: number | null;
      lbm_slope_pct_per_week: number | null;
      plateau_flags: Array<{ lift: string; weeks_flat: number }>;
    };
    prescription: {
      next_week_start: string;
      phase: WeeklyPhase;
      rir_target: number | null;
      session_plan: Record<string, string>;
      weekly_focus: string | null;
      per_lift: Array<{
        lift: string;
        sets: number;
        reps: number;
        weight_kg: number;
        delta_pct_from_last_week: number | null;
        pr_rebase_applied: boolean;
        rationale_tag: PrescriptionRationaleTag;
      }>;
    };
    volume: {
      per_muscle: Array<{
        muscle: string;
        last_week_sets: number;
        next_week_sets: number;
        tier: "mev" | "mav" | "mrv";
      }>;
    };
    targets: {
      nutrition: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
      sleep: { hours: number; efficiency_pct: number };
      recovery_focus: string[];
    };
  };

  export type WeeklyReviewCardUI = {
    schema_version: 1;
    week_start: string;
    next_week_start: string;
    block_phase_now: WeeklyPhase;
    block_phase_next: WeeklyPhase;
    one_line_summary: string;
    per_lift_preview: Array<{ lift: string; from: string; to: string }>;
    link_path: string;
    review_id: string;
  };

  export type ReconfirmResponse = { chip_value: string; answered_at: string };
  export type ReconfirmResponses = Record<string, ReconfirmResponse>;

  export type WeeklyReviewStatus = "draft" | "committed" | "superseded";

  export type WeeklyReviewRow = {
    id: string;
    user_id: string;
    week_start: string;
    next_week_start: string;
    version: number;
    status: WeeklyReviewStatus;
    block_id: string | null;
    payload: WeeklyReviewPayload;
    narrative_md: string;
    reconfirm_responses: ReconfirmResponses;
    committed_at: string | null;
    committed_training_week_id: string | null;
    generated_at: string;
    updated_at: string;
    created_at: string;
  };
  ```

- [ ] **Step 2: Verify typecheck passes**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0.

- [ ] **Step 3: Commit**

  ```bash
  git add lib/data/types.ts
  git commit -m "feat(types): add WeeklyReviewPayload + row types"
  ```

### Task 1.3: Query keys namespace

**Files:**
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Inspect existing pattern**

  Open `lib/query/keys.ts`. Find an existing namespace like `trainingWeeks` to use as the pattern reference.

- [ ] **Step 2: Add weeklyReviews namespace**

  After the last namespace definition, add:

  ```ts
  weeklyReviews: {
    all: (userId: string) => ["weeklyReviews", userId] as const,
    one: (userId: string, weekStart: string) =>
      ["weeklyReviews", userId, weekStart] as const,
  },
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add lib/query/keys.ts
  git commit -m "feat(query): add weeklyReviews query keys namespace"
  ```

### Task 1.4: Fetchers (server + browser variants)

**Files:**
- Create: `lib/query/fetchers/weeklyReview.ts`

- [ ] **Step 1: Inspect canonical pattern**

  Open `lib/query/fetchers/dailyLogs.ts` (cited in CLAUDE.md as canonical). Skim 30 lines to confirm the server+browser variant shape — both throw on error, both select the same columns.

- [ ] **Step 2: Write the fetcher**

  Create `lib/query/fetchers/weeklyReview.ts`:

  ```ts
  // lib/query/fetchers/weeklyReview.ts
  //
  // Server + browser variants. Both throw on Supabase errors so TanStack
  // Query's `isError` lights up correctly.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import { createSupabaseBrowserClient } from "@/lib/supabase/client";
  import type { WeeklyReviewRow } from "@/lib/data/types";

  const SELECT_COLUMNS = `
    id, user_id, week_start, next_week_start, version, status, block_id,
    payload, narrative_md, reconfirm_responses,
    committed_at, committed_training_week_id,
    generated_at, updated_at, created_at
  `;

  /** Latest version for (user_id, week_start). Returns null if no row. */
  export async function fetchWeeklyReviewServer(
    supabase: SupabaseClient,
    userId: string,
    weekStart: string
  ): Promise<WeeklyReviewRow | null> {
    const { data, error } = await supabase
      .from("weekly_reviews")
      .select(SELECT_COLUMNS)
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as WeeklyReviewRow | null) ?? null;
  }

  export async function fetchWeeklyReviewBrowser(
    userId: string,
    weekStart: string
  ): Promise<WeeklyReviewRow | null> {
    const supabase = createSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("weekly_reviews")
      .select(SELECT_COLUMNS)
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as WeeklyReviewRow | null) ?? null;
  }
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add lib/query/fetchers/weeklyReview.ts
  git commit -m "feat(query): weekly-review fetcher (server + browser variants)"
  ```

### Task 1.5: Read hook

**Files:**
- Create: `lib/query/hooks/useWeeklyReview.ts`

- [ ] **Step 1: Write the hook**

  Create `lib/query/hooks/useWeeklyReview.ts`:

  ```ts
  "use client";

  import { useQuery } from "@tanstack/react-query";
  import { queryKeys } from "@/lib/query/keys";
  import { fetchWeeklyReviewBrowser } from "@/lib/query/fetchers/weeklyReview";

  export function useWeeklyReview(userId: string, weekStart: string) {
    return useQuery({
      queryKey: queryKeys.weeklyReviews.one(userId, weekStart),
      queryFn: () => fetchWeeklyReviewBrowser(userId, weekStart),
    });
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit + open Slice-1 PR**

  ```bash
  git add lib/query/hooks/useWeeklyReview.ts
  git commit -m "feat(query): useWeeklyReview hook"
  git push -u origin feat/weekly-review
  gh pr create --title "feat(coach): weekly-review data foundation (Slice 1/6)" \
    --body "First slice of the weekly-review document. Adds migration 0014, types, query keys, fetcher, hook. No domain logic, no UI."
  ```

---

## Slice 2 — Composers (six deterministic, plus phase-mapping helper)

Goal: All six composer files exist as pure functions. Audit script exercises each. No orchestrator, no AI, no DB writes.

### Task 2.1: Phase-mapping helper

**Files:**
- Create: `lib/coach/weekly-review/phase-mapping.ts`

Context: existing `ResearchPhase` is binary (`"accumulate" | "deload"`). The weekly review needs the four-state MEV/MAV/MRV/Deload derived from week-within-block. This helper centralises that derivation.

- [ ] **Step 1: Write the helper**

  Create `lib/coach/weekly-review/phase-mapping.ts`:

  ```ts
  // lib/coach/weekly-review/phase-mapping.ts
  //
  // Map (week_n, total_weeks, training_blocks.research_phase) → WeeklyPhase.
  // Canonical 5-week meso: MEV (Wk1) → MAV (Wk2-3) → MRV (Wk4) → Deload (Wk5).
  // For non-5-week blocks, MRV is week (total-1), Deload is week total when
  // research_phase != 'deload'; if research_phase = 'deload' the whole block
  // is a deload (rare).

  import type { ResearchPhase, WeeklyPhase } from "@/lib/data/types";

  export function weeklyPhaseFor(
    weekN: number,
    totalWeeks: number,
    researchPhase: ResearchPhase
  ): WeeklyPhase {
    if (researchPhase === "deload") return "deload";
    if (weekN <= 1) return "mev";
    if (weekN >= totalWeeks) return "deload";
    if (weekN === totalWeeks - 1) return "mrv";
    return "mav";
  }

  export function nextWeeklyPhaseFor(
    currentWeekN: number,
    totalWeeks: number,
    researchPhase: ResearchPhase
  ): WeeklyPhase {
    return weeklyPhaseFor(currentWeekN + 1, totalWeeks, researchPhase);
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 2.2: compose-recap.ts

**Files:**
- Create: `lib/coach/weekly-review/compose-recap.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/weekly-review/compose-recap.ts`:

  ```ts
  // lib/coach/weekly-review/compose-recap.ts
  //
  // §2 of the weekly review. Pure: takes raw row data, returns the recap
  // shape from WeeklyReviewPayload.recap.
  //
  // Inputs include 3 weeks of e1rm history (for plateau rules in
  // compose-prescription), per-set rep counts (for rep-completion rule),
  // and the prior weekly_reviews row (for rir_miss_consecutive streak).

  import type { SupabaseClient } from "@supabase/supabase-js";
  import { epley } from "@/lib/coach/derived";
  import type { WeeklyReviewPayload, WeeklyReviewRow } from "@/lib/data/types";

  type RecapOutput = WeeklyReviewPayload["recap"];

  type WorkoutRow = {
    id: string;
    day: string;
    type: string;
    notes: string | null;
    sets: Array<{
      exercise: string;
      kg: number | null;
      reps: number | null;
      warmup: boolean;
      target_reps?: number | null;
    }>;
  };

  const BIG_FOUR = ["Squat (Barbell)", "Deadlift (Barbell)", "Decline Bench Press (Barbell)", "Overhead Press (Barbell)"];

  export async function composeRecap(args: {
    supabase: SupabaseClient;
    userId: string;
    weekStart: string;        // Monday YYYY-MM-DD
    plannedSessions: Record<string, string>;   // from training_weeks.session_plan
    priorReview: WeeklyReviewRow | null;       // last week's review for rir streak carry
  }): Promise<RecapOutput> {
    const { supabase, userId, weekStart, plannedSessions, priorReview } = args;

    // Window: weekStart (Mon) → +6 days (Sun)
    const weekEnd = addDays(weekStart, 6);

    // Fetch workouts in window
    const { data: workouts, error: wErr } = await supabase
      .from("workouts")
      .select("id, day, type, notes, sets")
      .eq("user_id", userId)
      .gte("day", weekStart)
      .lte("day", weekEnd)
      .order("day", { ascending: true });
    if (wErr) throw wErr;

    // Sleep + nutrition + weight from daily_logs
    const { data: logs, error: lErr } = await supabase
      .from("daily_logs")
      .select("day, sleep_hours, sleep_efficiency, calories_eaten, protein_g, weight_kg")
      .eq("user_id", userId)
      .gte("day", weekStart)
      .lte("day", weekEnd)
      .order("day", { ascending: true });
    if (lErr) throw lErr;

    // 3-week e1rm history per big-four lift — go back 14 days before weekStart
    const histStart = addDays(weekStart, -14);
    const { data: histWorkouts, error: hErr } = await supabase
      .from("workouts")
      .select("day, type, sets")
      .eq("user_id", userId)
      .gte("day", histStart)
      .lt("day", weekStart);
    if (hErr) throw hErr;

    // Sessions
    const sessionsDone = (workouts ?? []).length;
    const sessionsPlanned = Object.values(plannedSessions).filter(
      (s) => s && s.toUpperCase() !== "REST"
    ).length;
    const sessionsSkipped: RecapOutput["sessions_skipped"] = [];
    const doneDays = new Set((workouts ?? []).map((w) => w.day));
    for (const [day, type] of Object.entries(plannedSessions)) {
      if (!type || type.toUpperCase() === "REST") continue;
      const date = dayNameToDate(day, weekStart);
      if (!doneDays.has(date)) sessionsSkipped.push({ day, type });
    }

    // Swapped: requires training_weeks.original_session_plan (migration 0012).
    // Pulled by caller if applicable; pass empty here, orchestrator merges.
    const sessionsSwapped: RecapOutput["sessions_swapped"] = [];

    // Per-lift performance (big four only)
    const perLift = BIG_FOUR.map((lift) => buildPerLift(
      lift,
      workouts ?? [],
      histWorkouts ?? [],
      priorReview
    )).filter((row) => row.top_set.weight_kg > 0 || row.top_set.reps > 0);

    // Aggregates
    const sleepValues = (logs ?? []).filter((l) => l.sleep_hours != null);
    const sleep = {
      avg_h: avg(sleepValues.map((l) => l.sleep_hours as number)),
      avg_efficiency_pct: avg(
        (logs ?? []).filter((l) => l.sleep_efficiency != null).map((l) => l.sleep_efficiency as number)
      ),
    };

    const kcalValues = (logs ?? []).filter((l) => l.calories_eaten != null);
    const proteinValues = (logs ?? []).filter((l) => l.protein_g != null);
    const nutrition = {
      kcal_avg: avg(kcalValues.map((l) => l.calories_eaten as number)),
      kcal_target: null,                                 // orchestrator fills from targets composer
      protein_avg_g: avg(proteinValues.map((l) => l.protein_g as number)),
      protein_target_g: null,                            // orchestrator fills
    };

    const weights = (logs ?? []).filter((l) => l.weight_kg != null);
    const weight = {
      start_kg: weights[0]?.weight_kg ?? null,
      end_kg: weights[weights.length - 1]?.weight_kg ?? null,
      delta_kg: weights.length >= 2
        ? (weights[weights.length - 1].weight_kg as number) - (weights[0].weight_kg as number)
        : null,
    };

    return {
      sessions_planned: sessionsPlanned,
      sessions_done: sessionsDone,
      sessions_skipped: sessionsSkipped,
      sessions_swapped: sessionsSwapped,
      per_lift: perLift,
      sleep,
      nutrition,
      weight,
    };
  }

  // ── helpers (private) ─────────────────────────────────────────────────────

  function avg(xs: number[]): number | null {
    if (xs.length === 0) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  function addDays(yyyyMmDd: string, days: number): string {
    const d = new Date(yyyyMmDd + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  const WEEKDAY_OFFSET: Record<string, number> = {
    Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3,
    Friday: 4, Saturday: 5, Sunday: 6,
  };

  function dayNameToDate(day: string, weekStart: string): string {
    const offset = WEEKDAY_OFFSET[day] ?? 0;
    return addDays(weekStart, offset);
  }

  function buildPerLift(
    lift: string,
    weekWorkouts: WorkoutRow[],
    histWorkouts: WorkoutRow[],
    priorReview: WeeklyReviewRow | null
  ): RecapOutput["per_lift"][number] {
    const liftSets = weekWorkouts.flatMap((w) =>
      w.sets.filter((s) => s.exercise === lift && !s.warmup && s.kg && s.reps)
    );

    let topWeight = 0, topReps = 0;
    for (const s of liftSets) {
      if ((s.kg ?? 0) > topWeight) { topWeight = s.kg ?? 0; topReps = s.reps ?? 0; }
    }
    const setsCount = liftSets.length;
    const repsPrescribed = setsCount * (topReps || 1);
    const repsDone = liftSets.reduce((a, s) => a + (s.reps ?? 0), 0);
    const repsCompletedPct = repsPrescribed > 0 ? repsDone / repsPrescribed : null;

    const thisE1rm = epley(topWeight || null, topReps || null);
    const formNotes: string[] = [];
    for (const w of weekWorkouts) {
      if (!w.notes) continue;
      if (w.notes.toLowerCase().includes(lift.split(" ")[0].toLowerCase()))
        formNotes.push(w.notes);
    }

    // 3-wk history: this week + 2 prior weeks
    const history3wk = computeE1rmHistory(lift, weekWorkouts, histWorkouts);

    // rir_miss_consecutive: read from prior review payload if present
    const priorPerLift = priorReview?.payload?.recap?.per_lift?.find((p) => p.lift === lift);
    const priorStreak = priorPerLift?.rir_miss_consecutive ?? 0;
    const thisWeekMissed = false; // orchestrator updates after seeing RIR target met
    const rirMissConsec = thisWeekMissed ? priorStreak + 1 : 0;

    const e1rmDeltaKg = thisE1rm != null && priorPerLift?.e1rm_kg != null
      ? thisE1rm - priorPerLift.e1rm_kg
      : null;
    const e1rmDeltaPct = thisE1rm != null && priorPerLift?.e1rm_kg
      ? e1rmDeltaKg! / priorPerLift.e1rm_kg
      : null;

    return {
      lift,
      top_set: { weight_kg: topWeight, reps: topReps, sets: setsCount },
      reps_completed_pct: repsCompletedPct,
      e1rm_kg: thisE1rm,
      e1rm_delta_kg: e1rmDeltaKg,
      e1rm_delta_pct: e1rmDeltaPct,
      e1rm_history_3wk: history3wk,
      rir_target_met: null,    // orchestrator computes from training_weeks.rir_target vs achieved
      rir_miss_consecutive: rirMissConsec,
      form_notes: formNotes,
    };
  }

  function computeE1rmHistory(
    lift: string,
    weekWorkouts: WorkoutRow[],
    histWorkouts: WorkoutRow[]
  ): number[] {
    const all = [...histWorkouts, ...weekWorkouts];
    const byWeek = new Map<string, number>();
    for (const w of all) {
      const wkKey = mondayOf(w.day);
      const topSet = w.sets
        .filter((s) => s.exercise === lift && !s.warmup && s.kg && s.reps)
        .reduce<{ kg: number; reps: number } | null>(
          (best, s) => {
            const e = epley(s.kg ?? null, s.reps ?? null);
            const bestE = best ? epley(best.kg, best.reps) : null;
            return e != null && (bestE == null || e > bestE) ? { kg: s.kg!, reps: s.reps! } : best;
          },
          null
        );
      const e = topSet ? epley(topSet.kg, topSet.reps) : null;
      if (e != null) byWeek.set(wkKey, e);
    }
    const sorted = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.slice(-3).map(([, e]) => e);
  }

  function mondayOf(yyyyMmDd: string): string {
    const d = new Date(yyyyMmDd + "T12:00:00Z");
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (dow - 1));
    return d.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  If `workouts.sets` shape doesn't match (`Array<{ exercise, kg, reps, warmup, target_reps }>`), check the actual column shape:

  ```bash
  grep -n "sets" supabase/schema.sql | head
  ```

  Adjust the inline `WorkoutRow` type to match. The shape varies between projects; truth is in schema.sql.

### Task 2.3: compose-reconfirm.ts

**Files:**
- Create: `lib/coach/weekly-review/compose-reconfirm.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/weekly-review/compose-reconfirm.ts`:

  ```ts
  // lib/coach/weekly-review/compose-reconfirm.ts
  //
  // §3 of the weekly review. Detects discrepancies and emits chip prompts.
  // Pure: takes the recap output (which already aggregated last week) and
  // returns the reconfirm list. Each rule below has a stable `id` used as
  // a key in reconfirm_responses jsonb on weekly_reviews.

  import type { WeeklyReviewPayload } from "@/lib/data/types";

  type ReconfirmOutput = WeeklyReviewPayload["reconfirm"];
  type Recap = WeeklyReviewPayload["recap"];

  export function composeReconfirm(args: {
    recap: Recap;
    proteinTargetG: number | null;     // from compose-targets (or intake) — orchestrator passes
  }): ReconfirmOutput {
    const out: ReconfirmOutput = [];

    // Rule 1: e1RM flat for 2 weeks on any big-four lift.
    for (const lift of args.recap.per_lift) {
      const hist = lift.e1rm_history_3wk;
      if (hist.length >= 2) {
        const last = hist[hist.length - 1];
        const prev = hist[hist.length - 2];
        if (prev > 0 && Math.abs(last - prev) / prev <= 0.015) {
          out.push({
            id: `e1rm_flat_${lift.lift.replace(/\W+/g, "_")}`,
            severity: "warn",
            rule_tag: "e1rm_flat_2wk",
            question: `${shortLift(lift.lift)} e1RM flat 2 weeks running. Form, fatigue, or programming?`,
            chips: [
              { value: "form", label: "Form" },
              { value: "fatigue", label: "Fatigue" },
              { value: "program", label: "Deload it" },
              { value: "discuss", label: "Explain in chat" },
            ],
          });
        }
      }
    }

    // Rule 2: protein gap > 10% of target.
    if (
      args.proteinTargetG != null &&
      args.recap.nutrition.protein_avg_g != null &&
      args.recap.nutrition.protein_avg_g < args.proteinTargetG * 0.9
    ) {
      const shortfall = Math.round(args.proteinTargetG - args.recap.nutrition.protein_avg_g);
      out.push({
        id: "protein_gap",
        severity: "info",
        rule_tag: "protein_gap_>10pct",
        question: `Protein avg ${Math.round(args.recap.nutrition.protein_avg_g)}g vs ${args.proteinTargetG}g target — ${shortfall}g/day short. What got in the way?`,
        chips: [
          { value: "appetite", label: "Appetite low" },
          { value: "schedule", label: "Schedule" },
          { value: "preference", label: "Foods don't fit" },
          { value: "discuss", label: "Discuss" },
        ],
      });
    }

    // Rule 3: skipped sessions.
    if (args.recap.sessions_skipped.length > 0) {
      const days = args.recap.sessions_skipped.map((s) => s.day).join(", ");
      out.push({
        id: "sessions_skipped",
        severity: args.recap.sessions_skipped.length >= 2 ? "warn" : "info",
        rule_tag: "sessions_skipped",
        question: `Skipped ${days} this week — one-off, or a pattern?`,
        chips: [
          { value: "one_off", label: "One-off" },
          { value: "drop", label: "Drop the slot" },
          { value: "reschedule", label: "Move to another day" },
        ],
      });
    }

    // Rule 4: per-lift rep completion <90% for any big-four lift.
    for (const lift of args.recap.per_lift) {
      if (lift.reps_completed_pct != null && lift.reps_completed_pct < 0.9) {
        out.push({
          id: `rep_completion_${lift.lift.replace(/\W+/g, "_")}`,
          severity: "warn",
          rule_tag: "rep_completion_<90pct",
          question: `${shortLift(lift.lift)} hit ${Math.round(lift.reps_completed_pct * 100)}% of prescribed reps. Loading too heavy, fatigued, or form?`,
          chips: [
            { value: "load", label: "Too heavy" },
            { value: "fatigue", label: "Fatigued" },
            { value: "form", label: "Form" },
            { value: "discuss", label: "Discuss" },
          ],
        });
      }
    }

    return out;
  }

  function shortLift(name: string): string {
    return name.replace(/\s*\([^)]+\)/, "");
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 2.4: compose-trends.ts

**Files:**
- Create: `lib/coach/weekly-review/compose-trends.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/weekly-review/compose-trends.ts`:

  ```ts
  // lib/coach/weekly-review/compose-trends.ts
  //
  // §4 of the weekly review. 4-week rolling signals: loss rate, strength
  // slope (e1RM linear regression on big-four), /LBM slope, plateau flags.
  // Pure-ish: takes a supabase client only for fetching the 4-week window.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { WeeklyReviewPayload } from "@/lib/data/types";
  import { epley } from "@/lib/coach/derived";

  type TrendsOutput = WeeklyReviewPayload["trends"];

  const LOSS_RATE_BAND_KG_PER_WK: [number, number] = [-0.7, -0.2];

  export async function composeTrends(args: {
    supabase: SupabaseClient;
    userId: string;
    weekStart: string;           // Monday of the recap week
  }): Promise<TrendsOutput> {
    const { supabase, userId, weekStart } = args;
    const windowStart = shiftDays(weekStart, -28);
    const windowEnd = shiftDays(weekStart, 6);

    const { data: logs, error: lErr } = await supabase
      .from("daily_logs")
      .select("day, weight_kg, fat_free_mass_kg")
      .eq("user_id", userId)
      .gte("day", windowStart)
      .lte("day", windowEnd)
      .order("day", { ascending: true });
    if (lErr) throw lErr;

    const { data: workouts, error: wErr } = await supabase
      .from("workouts")
      .select("day, type, sets")
      .eq("user_id", userId)
      .gte("day", windowStart)
      .lte("day", windowEnd);
    if (wErr) throw wErr;

    const weights = (logs ?? [])
      .filter((l) => l.weight_kg != null)
      .map((l) => ({ day: l.day, kg: l.weight_kg as number }));
    const lbm = (logs ?? [])
      .filter((l) => l.fat_free_mass_kg != null)
      .map((l) => ({ day: l.day, kg: l.fat_free_mass_kg as number }));

    const weeklyLossRate = computeLinearSlope(
      weights.map((w) => ({ x: dayIndex(w.day, windowStart), y: w.kg }))
    );
    const weightLossKgPerWeek = weeklyLossRate != null ? weeklyLossRate * 7 : null;
    const lossInBand = weightLossKgPerWeek != null
      ? weightLossKgPerWeek >= LOSS_RATE_BAND_KG_PER_WK[0] &&
        weightLossKgPerWeek <= LOSS_RATE_BAND_KG_PER_WK[1]
      : null;

    // Per-lift weekly e1rm peaks → linear regression for strength slope
    const liftWeekly = bucketLiftE1rm(workouts ?? []);
    const allPoints: Array<{ x: number; y: number }> = [];
    for (const series of liftWeekly.values()) {
      for (const p of series) allPoints.push({ x: p.x, y: p.y });
    }
    const strengthSlopePerWeek = computeLinearSlope(allPoints);
    const strengthSlopePctPerWeek = strengthSlopePerWeek != null && allPoints.length > 0
      ? strengthSlopePerWeek / mean(allPoints.map((p) => p.y))
      : null;

    const lbmSlope = computeLinearSlope(
      lbm.map((l) => ({ x: dayIndex(l.day, windowStart), y: l.kg }))
    );
    const lbmSlopePctPerWeek = lbmSlope != null && lbm.length > 0
      ? (lbmSlope * 7) / mean(lbm.map((l) => l.kg))
      : null;

    const plateauFlags: TrendsOutput["plateau_flags"] = [];
    for (const [lift, series] of liftWeekly.entries()) {
      if (series.length < 3) continue;
      const last3 = series.slice(-3).map((p) => p.y);
      const max3 = Math.max(...last3), min3 = Math.min(...last3);
      if (max3 > 0 && (max3 - min3) / max3 <= 0.015) {
        plateauFlags.push({ lift, weeks_flat: series.length });
      }
    }

    return {
      window_weeks: 4,
      weight_loss_kg_per_week: weightLossKgPerWeek,
      loss_rate_in_target_band: lossInBand,
      strength_slope_pct_per_week: strengthSlopePctPerWeek,
      lbm_slope_pct_per_week: lbmSlopePctPerWeek,
      plateau_flags: plateauFlags,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function dayIndex(d: string, base: string): number {
    return Math.round(
      (new Date(d + "T12:00:00Z").getTime() - new Date(base + "T12:00:00Z").getTime()) /
        (24 * 3600 * 1000)
    );
  }

  function computeLinearSlope(points: Array<{ x: number; y: number }>): number | null {
    const n = points.length;
    if (n < 2) return null;
    const meanX = points.reduce((a, p) => a + p.x, 0) / n;
    const meanY = points.reduce((a, p) => a + p.y, 0) / n;
    let num = 0, den = 0;
    for (const p of points) {
      num += (p.x - meanX) * (p.y - meanY);
      den += (p.x - meanX) ** 2;
    }
    if (den === 0) return null;
    return num / den;
  }

  function mean(xs: number[]): number {
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  function bucketLiftE1rm(workouts: Array<{ day: string; sets: Array<{ exercise: string; kg: number | null; reps: number | null; warmup: boolean }> }>):
    Map<string, Array<{ x: number; y: number }>> {
    const byLift = new Map<string, Map<string, number>>();
    for (const w of workouts) {
      for (const s of w.sets) {
        if (s.warmup) continue;
        const e = epley(s.kg ?? null, s.reps ?? null);
        if (e == null) continue;
        const wkKey = mondayOf(w.day);
        if (!byLift.has(s.exercise)) byLift.set(s.exercise, new Map());
        const wkMap = byLift.get(s.exercise)!;
        if ((wkMap.get(wkKey) ?? 0) < e) wkMap.set(wkKey, e);
      }
    }
    const result = new Map<string, Array<{ x: number; y: number }>>();
    for (const [lift, wkMap] of byLift.entries()) {
      const series = [...wkMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([wk, e]) => ({ x: dayIndex(wk, [...wkMap.keys()].sort()[0]), y: e }));
      result.set(lift, series);
    }
    return result;
  }

  function mondayOf(yyyyMmDd: string): string {
    const d = new Date(yyyyMmDd + "T12:00:00Z");
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (dow - 1));
    return d.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 2.5: compose-volume.ts

**Files:**
- Create: `lib/coach/weekly-review/compose-volume.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/weekly-review/compose-volume.ts`:

  ```ts
  // lib/coach/weekly-review/compose-volume.ts
  //
  // Per-muscle next-week volume targets. Reuses existing muscle-volume
  // computation; this composer just shapes the output for the payload.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { WeeklyReviewPayload, WeeklyPhase } from "@/lib/data/types";
  import { computeWeeklyMuscleVolume } from "@/lib/coach/muscle-volume";
  import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";

  type VolumeOutput = WeeklyReviewPayload["volume"];

  export async function composeVolume(args: {
    supabase: SupabaseClient;
    userId: string;
    weekStart: string;
    nextPhase: WeeklyPhase;
  }): Promise<VolumeOutput> {
    const { supabase, userId, weekStart, nextPhase } = args;
    const lastWeekVolume = await computeWeeklyMuscleVolume({
      supabase, userId, weekStart, windowDays: 7,
    });

    const perMuscle = lastWeekVolume.map((row) => {
      const nextTarget = targetSetsForWeek(row.muscle, nextPhase);
      return {
        muscle: row.muscle,
        last_week_sets: row.sets,
        next_week_sets: nextTarget.sets,
        tier: nextTarget.tier,
      };
    });

    return { per_muscle: perMuscle };
  }
  ```

  Note: the helper `targetSetsForWeek` and the input contract for `computeWeeklyMuscleVolume` must match what already exists in `lib/coach/muscle-volume.ts` and `lib/coach/volume-landmarks.ts`. Open both files, confirm signatures, adjust this composer to match if signatures differ.

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 2.6: compose-targets.ts

**Files:**
- Create: `lib/coach/weekly-review/compose-targets.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/weekly-review/compose-targets.ts`:

  ```ts
  // lib/coach/weekly-review/compose-targets.ts
  //
  // §7 targets — nutrition + sleep + recovery for the upcoming week.
  // Reads the active plan_payload.nutrition / plan_payload.sleep if the
  // athlete has a committed plan; falls back to intake_payload.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { WeeklyReviewPayload } from "@/lib/data/types";
  import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";

  type TargetsOutput = WeeklyReviewPayload["targets"];

  export async function composeTargets(args: {
    supabase: SupabaseClient;
    userId: string;
    nextWeekStart: string;
    sessionPlan: Record<string, string>;     // from compose-prescription
  }): Promise<TargetsOutput> {
    const { supabase, userId, sessionPlan } = args;
    const today = await getTodayTargets({ supabase, userId });

    // Recovery focus: derive from session_plan
    const recoveryFocus: string[] = [];
    const hasMobility = Object.values(sessionPlan).some((s) =>
      s.toLowerCase().includes("mobility")
    );
    if (hasMobility) recoveryFocus.push("mobility");
    const trainingDays = Object.values(sessionPlan).filter(
      (s) => s && !s.toLowerCase().includes("rest") && !s.toLowerCase().includes("mobility")
    ).length;
    if (trainingDays >= 4) recoveryFocus.push("soft-tissue post-leg");

    return {
      nutrition: {
        kcal: today.kcal,
        protein_g: today.protein_g,
        carbs_g: today.carbs_g,
        fat_g: today.fat_g,
      },
      sleep: {
        hours: today.sleep_target_hours ?? 7.5,
        efficiency_pct: 87,    // soft default; no per-user target in DB yet
      },
      recovery_focus: recoveryFocus,
    };
  }
  ```

  Note: confirm the exact shape returned by `getTodayTargets`. If it doesn't expose `protein_g`/`carbs_g`/`fat_g` directly, adapt.

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 2.7: compose-prescription.ts (the big one)

**Files:**
- Create: `lib/coach/weekly-review/compose-prescription.ts`

This is the rules engine from the spec. All rules, all override priority, all guardrails, increment-floor behavior.

- [ ] **Step 1: Write the composer**

  Create `lib/coach/weekly-review/compose-prescription.ts`:

  ```ts
  // lib/coach/weekly-review/compose-prescription.ts
  //
  // §5 of the weekly review. Deterministic per-lift load progression with
  // all rule overrides, priority order, and physical-loading guardrails.
  //
  // Full rule semantics defined in:
  //   docs/superpowers/specs/2026-05-15-weekly-review-document-design.md
  //   → "Per-lift progression rules"

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type {
    WeeklyReviewPayload,
    WeeklyPhase,
    PrescriptionRationaleTag,
  } from "@/lib/data/types";
  import { SESSION_PLANS, WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
  import { roundToValidWeight, minNonZeroIncrement } from "@/lib/coach/weight-rounding";

  type PrescriptionOutput = WeeklyReviewPayload["prescription"];

  type LiftRecap = WeeklyReviewPayload["recap"]["per_lift"][number];

  type Inputs = {
    supabase: SupabaseClient;
    userId: string;
    nextWeekStart: string;
    weeklyPhaseCurrent: WeeklyPhase;
    weeklyPhaseNext: WeeklyPhase;
    rirTargetCurrent: number | null;
    rirTargetNext: number | null;
    perLiftRecap: LiftRecap[];
    bodyWeightLossPctPerWk: number | null;     // negative for loss
    sleepAvg7d: number | null;
    hrvFlag: boolean;
    isFirstWeekOfBlock: boolean;
    intakeStartingLoads: Record<string, number> | null;   // from intake_payload if first week
    weeklyFocus: string | null;
  };

  type LiftPlan = WeeklyReviewPayload["prescription"]["per_lift"][number];

  const LIFT_STEP_TABLE: Record<string, { mevToMav: number; mavToMrv: number }> = {
    "Squat (Barbell)":                  { mevToMav: 0.025, mavToMrv: 0.015 },
    "Decline Bench Press (Barbell)":    { mevToMav: 0.025, mavToMrv: 0.015 },
    "Deadlift (Barbell)":               { mevToMav: 0.020, mavToMrv: 0.010 },
    "Overhead Press (Barbell)":         { mevToMav: 0.015, mavToMrv: 0    },  // hold; rep progression
  };

  const HARD_CAP_PCT = 0.04;

  export async function composePrescription(args: Inputs): Promise<PrescriptionOutput> {
    const perLift: LiftPlan[] = [];

    for (const lift of args.perLiftRecap) {
      perLift.push(resolveOneLift(lift, args));
    }

    // Schedule for the next week.
    const sessionPlan = WEEKLY_SESSIONS;   // baseline; could be overridden by user's training_weeks history

    return {
      next_week_start: args.nextWeekStart,
      phase: args.weeklyPhaseNext,
      rir_target: args.rirTargetNext,
      session_plan: sessionPlan,
      weekly_focus: args.weeklyFocus,
      per_lift: perLift,
    };
  }

  // ── per-lift resolution ────────────────────────────────────────────────────

  function resolveOneLift(recap: LiftRecap, args: Inputs): LiftPlan {
    const lift = recap.lift;
    const lastWeight = recap.top_set.weight_kg;
    const lastReps = recap.top_set.reps;
    const sets = recap.top_set.sets;
    const incr = getIncrementConfig(lift);
    const minIncr = minNonZeroIncrement(incr);

    // Compose pr_rebase flag — always evaluated.
    const prRebase = isNewPR(recap);

    // First week of block bypass.
    if (args.isFirstWeekOfBlock) {
      const startKg = args.intakeStartingLoads?.[lift] ?? lastWeight;
      return mkPlan(lift, sets, lastReps, startKg, lastWeight, prRebase, "block_start_baseline");
    }

    // 1. cutting_hold
    if (
      args.bodyWeightLossPctPerWk != null &&
      args.bodyWeightLossPctPerWk < -0.007
    ) {
      return mkPlan(lift, sets, lastReps, lastWeight, lastWeight, prRebase, "cutting_hold");
    }

    // 2. recovery_hold
    if ((args.sleepAvg7d != null && args.sleepAvg7d < 6) || args.hrvFlag) {
      return mkPlan(lift, sets, lastReps, lastWeight, lastWeight, prRebase, "recovery_hold");
    }

    // 3. plateau_deload_reset / 4. plateau_rep_shift
    if (isPlateau(recap)) {
      const repShiftAlready = recap.e1rm_history_3wk.length >= 3
        ? hasRecentRepShift(recap)
        : false;
      if (repShiftAlready) {
        const target = lastWeight * 0.95;
        return mkPlan(lift, sets, lastReps, target, lastWeight, prRebase, "plateau_deload_reset", incr);
      }
      const newReps = swapRepRange(lastReps);
      return mkPlan(lift, sets, newReps, lastWeight, lastWeight, prRebase, "plateau_rep_shift");
    }

    // 5. rep_completion_miss
    if (recap.reps_completed_pct != null && recap.reps_completed_pct < 0.9) {
      const target = lastWeight * (1 - 0.025);
      return mkPlan(lift, sets, lastReps, target, lastWeight, prRebase, "rep_completion_miss", incr);
    }

    // 6. rir_missed_twice
    if (recap.rir_miss_consecutive >= 2) {
      return mkPlan(lift, sets, lastReps, lastWeight, lastWeight, prRebase, "rir_missed_twice");
    }

    // 7. rir_missed
    if (recap.rir_target_met === false) {
      const target = lastWeight * (1 - 0.025);
      return mkPlan(lift, sets, lastReps, target, lastWeight, prRebase, "rir_missed", incr);
    }

    // 8. form_hold
    if (recap.form_notes.length > 0) {
      return mkPlan(lift, sets, lastReps, lastWeight, lastWeight, prRebase, "form_hold");
    }

    // Default: phase-mapped step from per-lift table.
    const step = phaseStepFor(lift, args.weeklyPhaseCurrent, args.weeklyPhaseNext);
    const target = lastWeight * (1 + step);
    const tag: PrescriptionRationaleTag =
      args.weeklyPhaseCurrent === "mev" && args.weeklyPhaseNext === "mav" ? "mev_to_mav_clearance"
      : args.weeklyPhaseCurrent === "mav" && args.weeklyPhaseNext === "mrv" ? "mav_to_mrv_advance"
      : args.weeklyPhaseCurrent === "mav" && args.weeklyPhaseNext === "mav" ? "mav_to_mav_step"
      : args.weeklyPhaseCurrent === "mrv" && args.weeklyPhaseNext === "deload" ? "deload_load_volume_cut"
      : "mev_to_mav_clearance";

    // MRV week → volume drive, not load
    if (args.weeklyPhaseCurrent === "mrv" || step === 0) {
      const bumpedSets = sets + 1;
      return mkPlan(lift, bumpedSets, lastReps, lastWeight, lastWeight, prRebase, "mrv_volume_drive");
    }

    // Deload week
    if (args.weeklyPhaseNext === "deload") {
      const deloadTarget = lastWeight * (1 - 0.125);     // mid-band of -10..-15
      const deloadSets = Math.max(1, Math.round(sets * 0.55));
      return mkPlan(lift, deloadSets, lastReps, deloadTarget, lastWeight, prRebase, "deload_load_volume_cut", incr);
    }

    return mkPlan(lift, sets, lastReps, target, lastWeight, prRebase, tag, incr);
  }

  // ── plan construction with rounding + guardrails ───────────────────────────

  function mkPlan(
    lift: string,
    sets: number,
    reps: number,
    targetKg: number,
    lastKg: number,
    prRebase: boolean,
    rationale: PrescriptionRationaleTag,
    incr?: ReturnType<typeof getIncrementConfig>
  ): LiftPlan {
    const incrCfg = incr ?? getIncrementConfig(lift);

    // Apply ±4% cap on the raw target before rounding.
    const rawDeltaPct = lastKg > 0 ? (targetKg - lastKg) / lastKg : 0;
    const cappedDeltaPct = Math.max(-HARD_CAP_PCT, Math.min(HARD_CAP_PCT, rawDeltaPct));
    const cappedTarget = lastKg * (1 + cappedDeltaPct);

    const resolved = roundToValidWeight(cappedTarget, incrCfg);
    const actualDeltaPct = lastKg > 0 ? (resolved - lastKg) / lastKg : 0;

    let finalKg = resolved;
    let finalTag: PrescriptionRationaleTag = rationale;

    // Post-rounding cap check (handles cases where rounding up jumps a coarse increment past 4%).
    if (Math.abs(actualDeltaPct) > HARD_CAP_PCT) {
      finalKg = lastKg;
      finalTag = `${rationale}_increment_capped`;
    } else if (
      resolved === lastKg &&
      Math.abs(rawDeltaPct) > 0.001 &&
      !["cutting_hold", "recovery_hold", "form_hold", "rir_missed_twice", "mrv_volume_drive", "plateau_rep_shift"].includes(rationale)
    ) {
      finalTag = `${rationale}_increment_floor`;
    }

    return {
      lift,
      sets,
      reps,
      weight_kg: finalKg,
      delta_pct_from_last_week: lastKg > 0 ? (finalKg - lastKg) / lastKg : null,
      pr_rebase_applied: prRebase,
      rationale_tag: finalTag,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function getIncrementConfig(lift: string): { step: number; intermediate?: number } {
    for (const session of Object.values(SESSION_PLANS)) {
      const found = session.find((e) => e.name === lift);
      if (found?.increment) return found.increment;
    }
    if (lift.toLowerCase().includes("(dumbbell)")) return { step: 2 };
    return { step: 2.5 };       // barbell default
  }

  function phaseStepFor(lift: string, current: WeeklyPhase, next: WeeklyPhase): number {
    const t = LIFT_STEP_TABLE[lift];
    if (!t) return 0.015;
    if (current === "mev" && next === "mav") return t.mevToMav;
    if (current === "mav" && next === "mav") return t.mevToMav * 0.6;   // mid-MAV step
    if (current === "mav" && next === "mrv") return t.mavToMrv;
    if (current === "mrv") return 0;     // hold + volume drive
    return 0;
  }

  function isNewPR(recap: LiftRecap): boolean {
    if (recap.e1rm_kg == null || recap.e1rm_history_3wk.length === 0) return false;
    const priorMax = Math.max(...recap.e1rm_history_3wk.slice(0, -1));
    return recap.e1rm_kg > priorMax;
  }

  function isPlateau(recap: LiftRecap): boolean {
    if (recap.e1rm_history_3wk.length < 3) return false;
    const xs = recap.e1rm_history_3wk;
    const max = Math.max(...xs), min = Math.min(...xs);
    return max > 0 && (max - min) / max <= 0.015;
  }

  function hasRecentRepShift(_recap: LiftRecap): boolean {
    // Read from prior weekly_reviews row in orchestrator and inject if needed.
    // For now: conservative default (no shift yet) — orchestrator can override
    // by passing recap with augmented metadata.
    return false;
  }

  function swapRepRange(reps: number): number {
    if (reps <= 5) return 8;
    if (reps <= 8) return 5;
    return 5;
  }
  ```

  Notes:
  - `hasRecentRepShift` is intentionally conservative; the orchestrator can pass an augmented recap with a flag if needed. This avoids coupling the prescription composer to weekly_reviews row history.
  - The MEV→MAV row for OHP is `0.015` target; with `{step: 5}` increment, rounding will land on hold (last weight) in most cases — the `_increment_floor` suffix is set automatically.
  - `WEEKLY_SESSIONS` is the baseline schedule. The orchestrator may override `sessionPlan` if the user has a recent custom schedule on `training_weeks`.

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 2.8: Audit script for composers

**Files:**
- Create: `scripts/audit-weekly-review-composers.mjs`

- [ ] **Step 1: Write the audit script**

  Create `scripts/audit-weekly-review-composers.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/audit-weekly-review-composers.mjs
  //
  // Exercise each composer with the user's most recent completed week and
  // print the output. Run after Slice 2 to verify pure functions produce
  // sane shapes before wiring the orchestrator.
  //
  // Usage:
  //   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  //     scripts/audit-weekly-review-composers.mjs [YYYY-MM-DD]

  import { readFileSync } from "node:fs";
  import { resolve, dirname } from "node:path";
  import { fileURLToPath } from "node:url";
  import { createClient } from "@supabase/supabase-js";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..");

  const env = {};
  for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const today = new Date();
  const dow = today.getUTCDay() || 7;
  const lastMon = new Date(today);
  lastMon.setUTCDate(today.getUTCDate() - (dow - 1) - 7);
  const defaultWeekStart = lastMon.toISOString().slice(0, 10);
  const weekStart = process.argv[2] ?? defaultWeekStart;

  console.log(`\nAuditing composers for week_start=${weekStart}\n`);

  const { data: profile } = await sb
    .from("profiles")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (!profile) {
    console.error("No profile found.");
    process.exit(1);
  }
  const userId = profile.id;

  // ── compose-recap (proxy: hit a temp endpoint if exists, otherwise
  // do a structural inspection of the raw inputs) ────────────────────
  const { data: workouts } = await sb
    .from("workouts")
    .select("id, day, type, sets, notes")
    .eq("user_id", userId)
    .gte("day", weekStart)
    .lte("day", endOfWeek(weekStart));
  console.log(`Workouts in window: ${workouts?.length ?? 0}`);
  for (const w of workouts ?? []) {
    console.log(`  ${w.day} ${w.type}  sets=${w.sets?.length ?? 0}  note?=${!!w.notes}`);
  }

  const { data: logs } = await sb
    .from("daily_logs")
    .select("day, sleep_hours, calories_eaten, protein_g, weight_kg")
    .eq("user_id", userId)
    .gte("day", weekStart)
    .lte("day", endOfWeek(weekStart));
  console.log(`\nDaily logs: ${logs?.length ?? 0}`);
  for (const l of logs ?? []) {
    console.log(`  ${l.day}  sleep=${l.sleep_hours}h  kcal=${l.calories_eaten}  P=${l.protein_g}g  wt=${l.weight_kg}kg`);
  }

  function endOfWeek(mondayYmd) {
    const d = new Date(mondayYmd + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Run the audit**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-weekly-review-composers.mjs
  ```

  Expected: prints last week's workouts + daily-logs summary. Confirms the data the composers will consume is present and shaped correctly. If empty or wrong-shape, fix data first.

- [ ] **Step 3: Commit Slice 2**

  ```bash
  git add lib/coach/weekly-review/ scripts/audit-weekly-review-composers.mjs
  git commit -m "feat(coach): weekly-review composers + phase-mapping helper (Slice 2/6)"
  git push
  gh pr create --title "feat(coach): weekly-review composers (Slice 2/6)" \
    --body "Six pure-function composers (recap, reconfirm, trends, prescription, volume, targets) plus phase-mapping helper. No orchestration yet. Audit script exercises raw inputs."
  ```

---

## Slice 3 — Orchestrator, narrative AI call, sync endpoint, cron

Goal: Sunday cron writes a draft `weekly_reviews` row + a `weekly_review` chat message. Drafts visible via SQL select. No page yet.

### Task 3.1: lib/coach/weekly-review/index.ts (orchestrator)

**Files:**
- Create: `lib/coach/weekly-review/index.ts`

- [ ] **Step 1: Write the orchestrator**

  Create `lib/coach/weekly-review/index.ts`:

  ```ts
  // lib/coach/weekly-review/index.ts
  //
  // Orchestrator: fetch inputs in parallel, call composers, one AI narrative
  // call, return { payload, narrative_md }. No DB writes — caller persists.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { WeeklyReviewPayload, WeeklyReviewRow } from "@/lib/data/types";
  import { composeRecap } from "./compose-recap";
  import { composeReconfirm } from "./compose-reconfirm";
  import { composeTrends } from "./compose-trends";
  import { composePrescription } from "./compose-prescription";
  import { composeVolume } from "./compose-volume";
  import { composeTargets } from "./compose-targets";
  import { renderNarrative } from "./narrative-prompt";
  import { weeklyPhaseFor, nextWeeklyPhaseFor } from "./phase-mapping";

  export async function generateWeeklyReview(args: {
    supabase: SupabaseClient;
    userId: string;
    weekStart: string;
    late: boolean;
  }): Promise<{ payload: WeeklyReviewPayload; narrative_md: string }> {
    const { supabase, userId, weekStart, late } = args;

    // Pull active block + training_week for context
    const { data: block } = await supabase
      .from("training_blocks")
      .select("id, goal_text, total_weeks, research_phase, start_date")
      .eq("user_id", userId)
      .eq("active", true)
      .maybeSingle();

    if (!block) throw new Error("No active training block");

    const weekN = computeWeekN(block.start_date, weekStart);
    const totalWeeks = block.total_weeks ?? 5;
    const weeklyPhaseCurrent = weeklyPhaseFor(weekN, totalWeeks, block.research_phase);
    const weeklyPhaseNext = nextWeeklyPhaseFor(weekN, totalWeeks, block.research_phase);

    const { data: trainingWeek } = await supabase
      .from("training_weeks")
      .select("session_plan, original_session_plan, rir_target, weekly_focus")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();

    const plannedSessions: Record<string, string> = trainingWeek?.original_session_plan
      ?? trainingWeek?.session_plan
      ?? {};

    // Prior week's review (for rir_miss_consecutive carry-over)
    const priorMonday = shiftDays(weekStart, -7);
    const { data: priorReview } = await supabase
      .from("weekly_reviews")
      .select("payload")
      .eq("user_id", userId)
      .eq("week_start", priorMonday)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const [recap, trends, volume] = await Promise.all([
      composeRecap({
        supabase, userId, weekStart, plannedSessions,
        priorReview: priorReview as WeeklyReviewRow | null,
      }),
      composeTrends({ supabase, userId, weekStart }),
      composeVolume({ supabase, userId, weekStart, nextPhase: weeklyPhaseNext }),
    ]);

    // compose-targets needs the next-week session plan from prescription;
    // prescription needs recap. Sequential.
    const targets = await composeTargets({
      supabase, userId, nextWeekStart: shiftDays(weekStart, 7),
      sessionPlan: plannedSessions,
    });

    const prescription = await composePrescription({
      supabase, userId,
      nextWeekStart: shiftDays(weekStart, 7),
      weeklyPhaseCurrent, weeklyPhaseNext,
      rirTargetCurrent: trainingWeek?.rir_target ?? null,
      rirTargetNext: rirForPhase(weeklyPhaseNext),
      perLiftRecap: recap.per_lift,
      bodyWeightLossPctPerWk: deriveLossPct(trends.weight_loss_kg_per_week, recap.weight),
      sleepAvg7d: recap.sleep.avg_h,
      hrvFlag: false,        // v1: sleep-based recovery_hold only. HRV-based hold deferred to a follow-up — leaves an explicit gap when sleep is fine but HRV crashed.
      isFirstWeekOfBlock: weekN === 1,
      intakeStartingLoads: null,  // v1: when null, prescription falls back to last-week weight. First-week-of-block users get block_start_baseline tag with last-week weight; if intake load injection is needed, add it before shipping.
      weeklyFocus: trainingWeek?.weekly_focus ?? null,
    });

    const reconfirm = composeReconfirm({
      recap, proteinTargetG: targets.nutrition.protein_g,
    });

    const onPace = computeOnPace(block, recap);

    const payload: WeeklyReviewPayload = {
      schema_version: 1,
      header: {
        week_n: weekN,
        total_weeks: totalWeeks,
        block_goal_text: block.goal_text,
        block_phase_now: weeklyPhaseCurrent,
        block_phase_next: weeklyPhaseNext,
        on_pace: onPace,
        weeks_remaining: Math.max(0, totalWeeks - weekN),
        late,
      },
      recap,
      reconfirm,
      trends,
      prescription,
      volume,
      targets,
    };

    const narrative_md = await renderNarrative({ payload });
    return { payload, narrative_md };
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function computeWeekN(blockStart: string, weekStart: string): number {
    const ms = new Date(weekStart + "T12:00:00Z").getTime()
             - new Date(blockStart + "T12:00:00Z").getTime();
    return Math.floor(ms / (7 * 24 * 3600 * 1000)) + 1;
  }

  function rirForPhase(phase: "mev" | "mav" | "mrv" | "deload"): number | null {
    if (phase === "mev") return 3;
    if (phase === "mav") return 2;
    if (phase === "mrv") return 1;
    if (phase === "deload") return 4;
    return null;
  }

  function deriveLossPct(
    weeklyDeltaKg: number | null,
    weight: { start_kg: number | null; end_kg: number | null }
  ): number | null {
    if (weeklyDeltaKg == null || weight.start_kg == null || weight.start_kg <= 0) return null;
    return weeklyDeltaKg / weight.start_kg;
  }

  function computeOnPace(
    block: { goal_text: string },
    _recap: WeeklyReviewPayload["recap"]
  ): boolean | null {
    // Heuristic: parse a "<kg>x<reps>" target out of goal_text and compare to
    // current top e1rm. Defer until enough data; return null for now.
    void block;
    return null;
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 3.2: narrative-prompt.ts (single Sonnet 4.6 call)

**Files:**
- Create: `lib/coach/weekly-review/narrative-prompt.ts`

- [ ] **Step 1: Inspect plan-builder narrative for the pattern**

  ```bash
  cat lib/coach/plan-builder/narrative-prompt.ts | head -40
  ```

  Use it as the template (system prompt + payload-to-input + claude call + extract markdown).

- [ ] **Step 2: Write the narrative composer**

  Create `lib/coach/weekly-review/narrative-prompt.ts`:

  ```ts
  // lib/coach/weekly-review/narrative-prompt.ts
  //
  // Single Sonnet 4.6 call. Reads structured payload, returns coach-voice
  // prose (1 paragraph, 120-180 words) explaining "what changes & why".
  // No fabricated numbers — post-call validation regex-checks all numbers
  // in the output appear in the payload.

  import { anthropic } from "@/lib/anthropic/client";
  import type { WeeklyReviewPayload } from "@/lib/data/types";

  const SYSTEM_PROMPT = `You are an experienced strength coach reviewing a client's week. Voice: direct, concise, second person ("you"). Length: 120-180 words, single paragraph, no markdown headings.

RULES:
1. Reference numbers ONLY when they appear in the payload. Never invent loads, percentages, or counts.
2. Lead with the most important per-lift change and its rationale_tag meaning.
3. Acknowledge reconfirm questions if any (but do not answer them — they're for the athlete).
4. Close with a single concrete cue for the upcoming week.
5. No bullet lists, no headers — flowing prose.

The rationale_tag suffixes "_increment_floor" and "_increment_capped" mean the lift held because the smallest physical jump is bigger than the rule's target — explain this naturally without using the suffix term.`;

  export async function renderNarrative(args: {
    payload: WeeklyReviewPayload;
  }): Promise<string> {
    const userMessage = JSON.stringify(args.payload, null, 0);

    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = resp.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");

    validateNoFabricatedNumbers(text, args.payload);
    return text.trim();
  }

  function validateNoFabricatedNumbers(text: string, payload: WeeklyReviewPayload): void {
    const allowed = new Set<string>();
    const collect = (obj: unknown): void => {
      if (obj == null) return;
      if (typeof obj === "number") { allowed.add(String(obj)); allowed.add(String(Math.round(obj))); return; }
      if (typeof obj === "string") return;
      if (Array.isArray(obj)) { obj.forEach(collect); return; }
      if (typeof obj === "object") Object.values(obj).forEach(collect);
    };
    collect(payload);

    const matches = text.match(/\d+(?:\.\d+)?/g) ?? [];
    const fabricated = matches.filter((m) => !allowed.has(m) && !allowed.has(String(Math.round(+m))));
    if (fabricated.length > 0) {
      throw new Error(`Narrative referenced numbers not in payload: ${fabricated.join(", ")}`);
    }
  }
  ```

  Note: the validator is strict — if narration drifts, throw. Caller catches and either regenerates or surfaces a `brief_failed`-style retry path. Tune if false-positives are noisy in production.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 3.3: regenerate-narrative.ts

**Files:**
- Create: `lib/coach/weekly-review/regenerate-narrative.ts`

- [ ] **Step 1: Write the narrative-only regen**

  Create `lib/coach/weekly-review/regenerate-narrative.ts`:

  ```ts
  // lib/coach/weekly-review/regenerate-narrative.ts
  //
  // Re-render §6 prose after reconfirm chip answers, without re-running
  // composers. Cheaper than full regenerate (~$0.004).

  import { anthropic } from "@/lib/anthropic/client";
  import type { WeeklyReviewPayload, ReconfirmResponses } from "@/lib/data/types";

  const SYSTEM_PROMPT = `You are an experienced strength coach. The athlete has just answered one or more of your reconfirm questions. Update the weekly narrative to reflect their answers naturally. Same rules as before: 120-180 words, prose, no fabricated numbers, second person.`;

  export async function regenerateNarrative(args: {
    payload: WeeklyReviewPayload;
    reconfirmResponses: ReconfirmResponses;
  }): Promise<string> {
    const merged = { ...args.payload, _reconfirm_answers: args.reconfirmResponses };
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(merged) }],
    });
    const text = resp.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    return text.trim();
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 3.4: Sync endpoint (the cron entrypoint)

**Files:**
- Create: `app/api/coach/weekly-review/sync/route.ts`

- [ ] **Step 1: Inspect existing cron pattern**

  ```bash
  cat app/api/whoop/sync/route.ts | head -50
  ```

  Note the bearer-token check + service-role client + revalidatePath pattern.

- [ ] **Step 2: Write the sync route**

  Create `app/api/coach/weekly-review/sync/route.ts`:

  ```ts
  // app/api/coach/weekly-review/sync/route.ts
  //
  // Vercel cron entrypoint. Sunday 04:00 UTC + Monday 04:00 UTC (catch-up).
  // Idempotent on (user_id, week_start) — early-return if a row exists.

  import { NextResponse } from "next/server";
  import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import { revalidatePath } from "next/cache";
  import { generateWeeklyReview } from "@/lib/coach/weekly-review";
  import type { WeeklyReviewCardUI } from "@/lib/data/types";

  export const dynamic = "force-dynamic";
  export const maxDuration = 60;

  export async function GET(req: Request) {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const sb = createSupabaseServiceRoleClient();

    // Single-user app: pick the first profile.
    const { data: profile, error: pErr } = await sb
      .from("profiles")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();
    if (pErr || !profile) {
      return NextResponse.json({ error: "no user" }, { status: 404 });
    }
    const userId = profile.id;

    // Target week = previous Monday from "now"
    const today = new Date();
    const dow = today.getUTCDay() || 7;
    const lastMonday = new Date(today);
    lastMonday.setUTCDate(today.getUTCDate() - (dow - 1) - 7);
    const weekStart = lastMonday.toISOString().slice(0, 10);

    // Idempotency: bail if any row exists for this week
    const { data: existing } = await sb
      .from("weekly_reviews")
      .select("id, status")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ ok: true, skipped: "exists", existing_id: existing.id });
    }

    // Check if an active plan_week chat session is in flight (last 30min)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: activePlanWeek } = await sb
      .from("chat_messages")
      .select("id")
      .eq("user_id", userId)
      .eq("mode", "plan_week")
      .gte("created_at", thirtyMinAgo)
      .limit(1);
    if (activePlanWeek && activePlanWeek.length > 0) {
      return NextResponse.json({ ok: true, skipped: "plan_week_active" });
    }

    const isMondayCatchup = (today.getUTCDay() === 1);

    let result;
    try {
      result = await generateWeeklyReview({
        supabase: sb, userId, weekStart, late: isMondayCatchup,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const nextMonday = shiftDays(weekStart, 7);
    const { data: inserted, error: insErr } = await sb
      .from("weekly_reviews")
      .insert({
        user_id: userId,
        week_start: weekStart,
        next_week_start: nextMonday,
        version: 1,
        status: "draft",
        block_id: null,
        payload: result.payload,
        narrative_md: result.narrative_md,
        reconfirm_responses: {},
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      return NextResponse.json({ error: insErr?.message ?? "insert failed" }, { status: 500 });
    }

    const cardUi: WeeklyReviewCardUI = {
      schema_version: 1,
      week_start: weekStart,
      next_week_start: nextMonday,
      block_phase_now: result.payload.header.block_phase_now,
      block_phase_next: result.payload.header.block_phase_next,
      one_line_summary: buildOneLine(result.payload),
      per_lift_preview: result.payload.prescription.per_lift.slice(0, 4).map((p) => ({
        lift: shortLift(p.lift),
        from: lookupLastWeekKg(result.payload, p.lift),
        to: `${p.weight_kg}kg`,
      })),
      link_path: `/coach/weeks/${weekStart}`,
      review_id: inserted.id,
    };

    await sb.from("chat_messages").insert({
      user_id: userId,
      kind: "weekly_review",
      role: "assistant",
      content: cardUi.one_line_summary,
      ui: cardUi,
    });

    revalidatePath("/coach");
    revalidatePath(`/coach/weeks/${weekStart}`);

    return NextResponse.json({ ok: true, review_id: inserted.id });
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  function shortLift(name: string): string {
    return name.replace(/\s*\([^)]+\)/, "");
  }
  function lookupLastWeekKg(payload: import("@/lib/data/types").WeeklyReviewPayload, lift: string): string {
    const row = payload.recap.per_lift.find((p) => p.lift === lift);
    return row ? `${row.top_set.weight_kg}kg` : "—";
  }
  function buildOneLine(p: import("@/lib/data/types").WeeklyReviewPayload): string {
    return `Wk ${p.header.week_n} → Wk ${p.header.week_n + 1} · ${p.header.block_phase_next.toUpperCase()} next · ${p.recap.sessions_done}/${p.recap.sessions_planned} sessions`;
  }
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 3.5: vercel.json cron schedules

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the two cron entries**

  Open `vercel.json`. Locate the `crons` array. Add (preserving existing entries):

  ```json
  { "path": "/api/coach/weekly-review/sync", "schedule": "0 4 * * 0" },
  { "path": "/api/coach/weekly-review/sync", "schedule": "0 4 * * 1" }
  ```

- [ ] **Step 2: Validate JSON**

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"
  ```

  Expected: no output (parsed OK).

### Task 3.6: Manual end-to-end exercise

- [ ] **Step 1: Run dev server**

  ```bash
  npm run dev
  ```

- [ ] **Step 2: Trigger the sync manually**

  In a second terminal, with the dev server running:

  ```bash
  source .env.local
  curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/weekly-review/sync
  ```

  Expected: `{"ok":true,"review_id":"…"}` (or `{"ok":true,"skipped":"exists",…}` on re-run).

- [ ] **Step 3: Inspect the row**

  ```bash
  supabase db remote-execute "select id, week_start, status, version, generated_at, jsonb_pretty(payload->'header') from weekly_reviews order by generated_at desc limit 1;"
  ```

  Expected: a row with sensible header (week_n, block_phase_now/next, etc).

- [ ] **Step 4: Inspect the chat card**

  ```bash
  supabase db remote-execute "select kind, content, jsonb_pretty(ui) from chat_messages where kind='weekly_review' order by created_at desc limit 1;"
  ```

  Expected: a `weekly_review` message with the `WeeklyReviewCardUI` jsonb populated.

- [ ] **Step 5: Re-run for idempotency**

  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/weekly-review/sync
  ```

  Expected: `{"ok":true,"skipped":"exists",…}`.

### Task 3.7: Commit Slice 3

- [ ] **Step 1: Commit**

  ```bash
  git add lib/coach/weekly-review/index.ts \
          lib/coach/weekly-review/narrative-prompt.ts \
          lib/coach/weekly-review/regenerate-narrative.ts \
          app/api/coach/weekly-review/sync/route.ts \
          vercel.json
  git commit -m "feat(coach): weekly-review orchestrator + sync cron (Slice 3/6)"
  git push
  gh pr create --title "feat(coach): weekly-review orchestrator + sync cron (Slice 3/6)" \
    --body "End-to-end draft generation. Sunday 04:00 UTC cron + Monday catch-up. Idempotent on (user_id, week_start). Skips when a plan_week chat is active. Writes weekly_reviews row + weekly_review chat card."
  ```

---

## Slice 4 — Read-only page UI + chat card

Goal: Navigating to `/coach/weeks/2026-05-11` renders the 8-section document from the latest version. Chat card renders inline.

### Task 4.1: app/coach/weeks/[week_start]/page.tsx (server component)

**Files:**
- Create: `app/coach/weeks/[week_start]/page.tsx`
- Create: `app/coach/weeks/[week_start]/loading.tsx`

- [ ] **Step 1: Write the loading state**

  Create `app/coach/weeks/[week_start]/loading.tsx`:

  ```tsx
  export default function Loading() {
    return (
      <div style={{ padding: 16, color: "#888" }}>Loading review…</div>
    );
  }
  ```

- [ ] **Step 2: Write the server page**

  Create `app/coach/weeks/[week_start]/page.tsx`:

  ```tsx
  import { notFound, redirect } from "next/navigation";
  import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { makeServerQueryClient } from "@/lib/query/queryClient";
  import { queryKeys } from "@/lib/query/keys";
  import { fetchWeeklyReviewServer } from "@/lib/query/fetchers/weeklyReview";
  import { WeeklyReviewPage } from "@/components/coach/WeeklyReviewPage";

  export const revalidate = 60;

  export default async function WeeklyReviewRoute(props: {
    params: Promise<{ week_start: string }>;
  }) {
    const { week_start } = await props.params;

    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    const queryClient = makeServerQueryClient();
    const row = await queryClient.fetchQuery({
      queryKey: queryKeys.weeklyReviews.one(user.id, week_start),
      queryFn: () => fetchWeeklyReviewServer(supabase, user.id, week_start),
    });
    if (!row) notFound();

    return (
      <HydrationBoundary state={dehydrate(queryClient)}>
        <WeeklyReviewPage userId={user.id} weekStart={week_start} />
      </HydrationBoundary>
    );
  }
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 4.2: components/coach/WeeklyReviewPage.tsx (container)

**Files:**
- Create: `components/coach/WeeklyReviewPage.tsx`

- [ ] **Step 1: Write the container**

  Create `components/coach/WeeklyReviewPage.tsx`:

  ```tsx
  "use client";

  import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
  import { CHAT, COLOR } from "@/lib/ui/theme";
  import { WeeklyReviewHeader } from "./WeeklyReviewHeader";
  import { WeeklyReviewRecap } from "./WeeklyReviewRecap";
  import { WeeklyReviewReconfirm } from "./WeeklyReviewReconfirm";
  import { WeeklyReviewTrends } from "./WeeklyReviewTrends";
  import { WeeklyReviewPrescription } from "./WeeklyReviewPrescription";
  import { WeeklyReviewNarrative } from "./WeeklyReviewNarrative";
  import { WeeklyReviewTargets } from "./WeeklyReviewTargets";
  import { WeeklyReviewActions } from "./WeeklyReviewActions";

  export function WeeklyReviewPage({
    userId,
    weekStart,
  }: {
    userId: string;
    weekStart: string;
  }) {
    const { data: row } = useWeeklyReview(userId, weekStart);
    if (!row) return null;
    const p = row.payload;

    return (
      <div
        style={{
          maxWidth: CHAT.feedMaxWidth,
          margin: "0 auto",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          color: COLOR.textStrong,
        }}
      >
        <WeeklyReviewHeader header={p.header} />
        <WeeklyReviewRecap recap={p.recap} />
        <WeeklyReviewReconfirm
          reviewId={row.id}
          reconfirm={p.reconfirm}
          responses={row.reconfirm_responses}
        />
        <WeeklyReviewTrends trends={p.trends} />
        <WeeklyReviewPrescription prescription={p.prescription} recap={p.recap} />
        <WeeklyReviewNarrative md={row.narrative_md} />
        <WeeklyReviewTargets targets={p.targets} />
        <WeeklyReviewActions reviewRow={row} />
      </div>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Tasks 4.3-4.10: Section components (§1-§7)

Each section component is a thin presentational component that consumes a slice of `WeeklyReviewPayload`. Pattern is uniform; below shows one fully, then the rest follow same shape.

**Files:**
- Create: `components/coach/WeeklyReviewHeader.tsx` (§1)
- Create: `components/coach/WeeklyReviewRecap.tsx` (§2)
- Create: `components/coach/WeeklyReviewTrends.tsx` (§4)
- Create: `components/coach/WeeklyReviewPrescription.tsx` (§5)
- Create: `components/coach/WeeklyReviewNarrative.tsx` (§6)
- Create: `components/coach/WeeklyReviewTargets.tsx` (§7)

(§3 `Reconfirm` and §8 `Actions` are interactive — built in Slice 5 with a stub here.)

- [ ] **Step 1: Header (§1)**

  Create `components/coach/WeeklyReviewHeader.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { WeeklyReviewPayload } from "@/lib/data/types";

  export function WeeklyReviewHeader({
    header,
  }: {
    header: WeeklyReviewPayload["header"];
  }) {
    return (
      <Card>
        <SectionLabel>
          WEEK {header.week_n} → WEEK {header.week_n + 1}{header.late ? " · LATE" : ""}
        </SectionLabel>
        <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {header.block_goal_text}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {header.block_phase_now.toUpperCase()} → {header.block_phase_next.toUpperCase()} ·
          {" "}{header.on_pace === true ? <span style={{ color: "#16a34a" }}>On pace</span>
            : header.on_pace === false ? <span style={{ color: "#dc2626" }}>Off pace</span>
            : <span>pace unknown</span>}
          {" · "}{header.weeks_remaining} week{header.weeks_remaining === 1 ? "" : "s"} left
        </div>
      </Card>
    );
  }
  ```

- [ ] **Step 2: Recap (§2)**

  Create `components/coach/WeeklyReviewRecap.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { WeeklyReviewPayload } from "@/lib/data/types";

  export function WeeklyReviewRecap({
    recap,
  }: {
    recap: WeeklyReviewPayload["recap"];
  }) {
    const adherence = recap.sessions_planned > 0
      ? Math.round((recap.sessions_done / recap.sessions_planned) * 100)
      : null;

    return (
      <Card>
        <SectionLabel>LAST WEEK RECAP</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>
          {recap.sessions_done}/{recap.sessions_planned} sessions{adherence != null ? ` · ${adherence}%` : ""}
        </div>
        {recap.sessions_skipped.length > 0 && (
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            Skipped: {recap.sessions_skipped.map((s) => `${s.day} (${s.type})`).join(", ")}
          </div>
        )}
        <div style={{ height: 1, background: COLOR.divider, margin: "8px 0" }} />
        <table style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-dm-mono), monospace" }}>
          <tbody>
            {recap.per_lift.map((p) => (
              <tr key={p.lift}>
                <td style={{ color: COLOR.textMuted, width: "40%" }}>{shortName(p.lift)}</td>
                <td style={{ color: COLOR.textStrong }}>
                  {fmtNum(p.top_set.weight_kg)}×{p.top_set.reps}×{p.top_set.sets}
                </td>
                <td style={{ color: p.e1rm_delta_kg && p.e1rm_delta_kg > 0 ? "#16a34a" : COLOR.textMuted, textAlign: "right" }}>
                  {p.e1rm_delta_kg != null
                    ? `e1RM ${p.e1rm_delta_kg > 0 ? "+" : ""}${fmtNum(p.e1rm_delta_kg)}kg`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ height: 1, background: COLOR.divider, margin: "8px 0" }} />
        <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: COLOR.textMuted }}>Sleep</div>
            <div>{recap.sleep.avg_h != null ? `${fmtNum(recap.sleep.avg_h)}h` : "—"}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: COLOR.textMuted }}>Protein</div>
            <div>{recap.nutrition.protein_avg_g != null ? `${fmtNum(recap.nutrition.protein_avg_g)}g` : "—"}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: COLOR.textMuted }}>Weight</div>
            <div>{recap.weight.delta_kg != null ? `${recap.weight.delta_kg > 0 ? "+" : ""}${fmtNum(recap.weight.delta_kg)}kg` : "—"}</div>
          </div>
        </div>
      </Card>
    );
  }

  function shortName(n: string): string { return n.replace(/\s*\([^)]+\)/, ""); }
  ```

- [ ] **Step 3: Reconfirm stub (§3 — interactivity comes in Slice 5)**

  Create `components/coach/WeeklyReviewReconfirm.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { WeeklyReviewPayload, ReconfirmResponses } from "@/lib/data/types";

  export function WeeklyReviewReconfirm({
    reviewId,
    reconfirm,
    responses,
  }: {
    reviewId: string;
    reconfirm: WeeklyReviewPayload["reconfirm"];
    responses: ReconfirmResponses;
  }) {
    if (reconfirm.length === 0) return null;
    void reviewId;
    return (
      <Card>
        <SectionLabel>RECONFIRM ({reconfirm.length})</SectionLabel>
        {reconfirm.map((r) => (
          <div key={r.id} style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ color: COLOR.textStrong, fontWeight: 600 }}>{r.question}</div>
            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
              {r.chips.map((c) => (
                <span
                  key={c.value}
                  style={{
                    background: responses[r.id]?.chip_value === c.value ? COLOR.accent : "#222",
                    color: responses[r.id]?.chip_value === c.value ? "#fff" : COLOR.textStrong,
                    borderRadius: 4, padding: "2px 8px", fontSize: 11,
                  }}
                >
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div style={{ fontSize: 10, color: COLOR.textFaint, marginTop: 8 }}>
          (Interactive chips wire up in Slice 5.)
        </div>
      </Card>
    );
  }
  ```

- [ ] **Step 4: Trends (§4)**

  Create `components/coach/WeeklyReviewTrends.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { WeeklyReviewPayload } from "@/lib/data/types";

  export function WeeklyReviewTrends({
    trends,
  }: {
    trends: WeeklyReviewPayload["trends"];
  }) {
    return (
      <Card>
        <SectionLabel>TREND SIGNALS · 4-WEEK</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8, fontSize: 11 }}>
          <Cell label="Loss rate"
            value={trends.weight_loss_kg_per_week != null
              ? `${fmtNum(trends.weight_loss_kg_per_week)}kg/wk`
              : "—"}
            ok={trends.loss_rate_in_target_band} />
          <Cell label="Strength slope"
            value={trends.strength_slope_pct_per_week != null
              ? `${fmtNum(trends.strength_slope_pct_per_week * 100)}%/wk`
              : "—"} />
          <Cell label="/LBM slope"
            value={trends.lbm_slope_pct_per_week != null
              ? `${fmtNum(trends.lbm_slope_pct_per_week * 100)}%/wk`
              : "—"} />
          <Cell label="Plateaus"
            value={trends.plateau_flags.length > 0
              ? trends.plateau_flags.map((p) => p.lift.replace(/\s*\([^)]+\)/, "")).join(", ")
              : "none"}
            ok={trends.plateau_flags.length === 0 ? true : false} />
        </div>
      </Card>
    );
  }

  function Cell({ label, value, ok }: { label: string; value: string; ok?: boolean | null }) {
    return (
      <div>
        <div style={{ color: COLOR.textMuted }}>{label}</div>
        <div style={{ color: ok === true ? "#16a34a" : ok === false ? "#dc2626" : COLOR.textStrong }}>{value}</div>
      </div>
    );
  }
  ```

- [ ] **Step 5: Prescription (§5)**

  Create `components/coach/WeeklyReviewPrescription.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { WeeklyReviewPayload } from "@/lib/data/types";

  export function WeeklyReviewPrescription({
    prescription,
    recap,
  }: {
    prescription: WeeklyReviewPayload["prescription"];
    recap: WeeklyReviewPayload["recap"];
  }) {
    return (
      <Card>
        <SectionLabel>NEXT WEEK PRESCRIPTION · {prescription.phase.toUpperCase()}</SectionLabel>
        <table style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-dm-mono), monospace", marginTop: 8 }}>
          <thead>
            <tr style={{ color: COLOR.textFaint, fontSize: 9 }}>
              <th style={{ textAlign: "left" }}>LIFT</th>
              <th style={{ textAlign: "right" }}>LAST</th>
              <th style={{ textAlign: "right" }}>NEXT</th>
              <th style={{ textAlign: "right" }}>WHY</th>
            </tr>
          </thead>
          <tbody>
            {prescription.per_lift.map((p) => {
              const last = recap.per_lift.find((r) => r.lift === p.lift)?.top_set;
              return (
                <tr key={p.lift}>
                  <td>{shortName(p.lift)}</td>
                  <td style={{ textAlign: "right", color: COLOR.textMuted }}>
                    {last ? `${fmtNum(last.weight_kg)}×${last.reps}×${last.sets}` : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {fmtNum(p.weight_kg)}×{p.reps}×{p.sets}
                  </td>
                  <td style={{ textAlign: "right", color: COLOR.textFaint }}>
                    {p.rationale_tag.replaceAll("_", " ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    );
  }

  function shortName(n: string): string { return n.replace(/\s*\([^)]+\)/, ""); }
  ```

- [ ] **Step 6: Narrative (§6)**

  Create `components/coach/WeeklyReviewNarrative.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";

  export function WeeklyReviewNarrative({ md }: { md: string }) {
    return (
      <Card>
        <SectionLabel>WHAT CHANGES &amp; WHY</SectionLabel>
        <p style={{ fontSize: 12, color: COLOR.textStrong, lineHeight: 1.6, marginTop: 6, fontStyle: "italic" }}>
          {md}
        </p>
      </Card>
    );
  }
  ```

- [ ] **Step 7: Targets (§7)**

  Create `components/coach/WeeklyReviewTargets.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { WeeklyReviewPayload } from "@/lib/data/types";

  export function WeeklyReviewTargets({
    targets,
  }: {
    targets: WeeklyReviewPayload["targets"];
  }) {
    return (
      <Card>
        <SectionLabel>TARGETS NEXT WEEK</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8, fontSize: 11, color: COLOR.textStrong }}>
          <Pair label="Kcal" v={`${fmtNum(targets.nutrition.kcal)}`} />
          <Pair label="Protein" v={`${fmtNum(targets.nutrition.protein_g)}g`} />
          <Pair label="Carbs" v={`${fmtNum(targets.nutrition.carbs_g)}g`} />
          <Pair label="Fat" v={`${fmtNum(targets.nutrition.fat_g)}g`} />
          <Pair label="Sleep" v={`${fmtNum(targets.sleep.hours)}h @ ${targets.sleep.efficiency_pct}%`} />
          <Pair label="Recovery" v={targets.recovery_focus.join(", ") || "—"} />
        </div>
      </Card>
    );
  }

  function Pair({ label, v }: { label: string; v: string }) {
    return (
      <div>
        <div style={{ color: COLOR.textMuted }}>{label}</div>
        <div>{v}</div>
      </div>
    );
  }
  ```

- [ ] **Step 8: Actions stub (§8 — wires up in Slice 5)**

  Create `components/coach/WeeklyReviewActions.tsx`:

  ```tsx
  "use client";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { WeeklyReviewRow } from "@/lib/data/types";

  export function WeeklyReviewActions({ reviewRow }: { reviewRow: WeeklyReviewRow }) {
    void reviewRow;
    return (
      <Card>
        <SectionLabel>ACTIONS</SectionLabel>
        <div style={{ fontSize: 11, color: COLOR.textFaint, marginTop: 8 }}>
          (Wires up in Slice 5: Commit · Swap a day · Adjust deficit · Regenerate · Discuss in chat.)
        </div>
      </Card>
    );
  }
  ```

- [ ] **Step 9: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 4.11: Chat card component

**Files:**
- Create: `components/chat/WeeklyReviewCard.tsx`
- Modify: `components/chat/ChatMessage.tsx`

- [ ] **Step 1: Write the card component**

  Create `components/chat/WeeklyReviewCard.tsx`:

  ```tsx
  "use client";
  import Link from "next/link";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { WeeklyReviewCardUI } from "@/lib/data/types";

  export function WeeklyReviewCard({ ui }: { ui: WeeklyReviewCardUI }) {
    return (
      <Card>
        <SectionLabel>
          WEEKLY REVIEW · WK · {ui.block_phase_now.toUpperCase()} → {ui.block_phase_next.toUpperCase()}
        </SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>{ui.one_line_summary}</div>
        <div style={{ marginTop: 8, fontSize: 11, fontFamily: "var(--font-dm-mono), monospace", color: COLOR.textMuted }}>
          {ui.per_lift_preview.map((p) => (
            <div key={p.lift}>▸ {p.lift}: {p.from} → {p.to}</div>
          ))}
        </div>
        <Link
          href={ui.link_path}
          style={{
            display: "inline-block", marginTop: 10, padding: "8px 12px",
            background: COLOR.accent, color: "#fff", borderRadius: 9999,
            fontWeight: 700, fontSize: 12, textDecoration: "none",
          }}
        >
          Open full review →
        </Link>
      </Card>
    );
  }
  ```

- [ ] **Step 2: Wire dispatch in ChatMessage.tsx**

  Open `components/chat/ChatMessage.tsx`. Find the dispatcher for `kind === 'morning_brief'`. Add a sibling branch:

  ```tsx
  // Existing branch for morning brief — replicate the pattern for weekly_review:
  if (msg.kind === "weekly_review" && msg.ui) {
    return <WeeklyReviewCard ui={msg.ui as WeeklyReviewCardUI} />;
  }
  ```

  Add the import:

  ```tsx
  import { WeeklyReviewCard } from "@/components/chat/WeeklyReviewCard";
  import type { WeeklyReviewCardUI } from "@/lib/data/types";
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 4.12: Manual verification

- [ ] **Step 1: Run dev server**

  ```bash
  npm run dev
  ```

- [ ] **Step 2: Visit the review page**

  In browser: `http://localhost:3000/coach/weeks/<weekStart>` where `<weekStart>` is the Monday of last week (e.g. `2026-05-04` if the cron from Slice 3 was run).

  Expected: 7 sections render. §3 chips visible but not interactive. §8 shows stub message.

- [ ] **Step 3: Visit /coach and confirm the chat card renders**

  In browser: `http://localhost:3000/coach`. The chat card from the sync run should appear inline.

  Expected: `WeeklyReviewCard` renders with summary, per-lift preview, and "Open full review →" button.

- [ ] **Step 4: Click "Open full review →"**

  Expected: navigates to `/coach/weeks/<weekStart>` and renders the page.

### Task 4.13: Commit Slice 4

- [ ] **Step 1: Commit**

  ```bash
  git add app/coach/weeks components/coach/WeeklyReview*.tsx components/chat/WeeklyReviewCard.tsx components/chat/ChatMessage.tsx
  git commit -m "feat(coach): weekly-review read-only page + chat card (Slice 4/6)"
  git push
  gh pr create --title "feat(coach): weekly-review page + chat card (Slice 4/6)" \
    --body "Renders the 8-section document at /coach/weeks/[week_start]. Chat card dispatches inline. §3 and §8 are stubbed — interactivity in Slice 5."
  ```

---

## Slice 5 — Interactivity: reconfirm chips, commit, regenerate, adjust-nutrition

Goal: All chips wired, all endpoints live, AdjustDeficitSheet works.

### Task 5.1: Reconfirm PATCH endpoint

**Files:**
- Create: `app/api/coach/weekly-review/[id]/reconfirm/route.ts`

- [ ] **Step 1: Write the endpoint**

  Create `app/api/coach/weekly-review/[id]/reconfirm/route.ts`:

  ```ts
  import { NextResponse } from "next/server";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { regenerateNarrative } from "@/lib/coach/weekly-review/regenerate-narrative";

  export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { reconfirm_id, chip_value } = await req.json();
    if (!reconfirm_id || typeof chip_value !== "string") {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }

    const { data: row, error: rErr } = await supabase
      .from("weekly_reviews")
      .select("id, user_id, payload, reconfirm_responses")
      .eq("id", id)
      .single();
    if (rErr || !row || row.user_id !== user.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const updatedResponses = {
      ...(row.reconfirm_responses ?? {}),
      [reconfirm_id]: { chip_value, answered_at: new Date().toISOString() },
    };

    let newNarrative: string | null = null;
    try {
      newNarrative = await regenerateNarrative({
        payload: row.payload,
        reconfirmResponses: updatedResponses,
      });
    } catch {
      // If re-narration fails, keep the old narrative; surface OK with a note.
    }

    const updates: Record<string, unknown> = {
      reconfirm_responses: updatedResponses,
      updated_at: new Date().toISOString(),
    };
    if (newNarrative) updates.narrative_md = newNarrative;

    const { error: uErr } = await supabase
      .from("weekly_reviews")
      .update(updates)
      .eq("id", id);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, reconfirm_responses: updatedResponses, narrative_md: newNarrative });
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 5.2: Wire reconfirm chips in §3

**Files:**
- Modify: `components/coach/WeeklyReviewReconfirm.tsx`

- [ ] **Step 1: Replace the stub with an interactive version**

  Replace the contents of `components/coach/WeeklyReviewReconfirm.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import { useQueryClient } from "@tanstack/react-query";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { queryKeys } from "@/lib/query/keys";
  import type { WeeklyReviewPayload, ReconfirmResponses } from "@/lib/data/types";

  export function WeeklyReviewReconfirm({
    reviewId,
    reconfirm,
    responses,
    userId,
    weekStart,
  }: {
    reviewId: string;
    reconfirm: WeeklyReviewPayload["reconfirm"];
    responses: ReconfirmResponses;
    userId: string;
    weekStart: string;
  }) {
    const queryClient = useQueryClient();
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (reconfirm.length === 0) return null;

    async function answerChip(reconfirmId: string, chipValue: string) {
      setPending(reconfirmId);
      setError(null);
      try {
        const r = await fetch(`/api/coach/weekly-review/${reviewId}/reconfirm`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reconfirm_id: reconfirmId, chip_value: chipValue }),
        });
        if (!r.ok) throw new Error(await r.text());
        await queryClient.invalidateQueries({
          queryKey: queryKeys.weeklyReviews.one(userId, weekStart),
        });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "save failed");
      } finally {
        setPending(null);
      }
    }

    return (
      <Card>
        <SectionLabel>RECONFIRM ({reconfirm.length})</SectionLabel>
        {reconfirm.map((r) => (
          <div key={r.id} style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ color: COLOR.textStrong, fontWeight: 600 }}>{r.question}</div>
            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
              {r.chips.map((c) => {
                const selected = responses[r.id]?.chip_value === c.value;
                const loading = pending === r.id;
                return (
                  <button
                    key={c.value}
                    onClick={() => answerChip(r.id, c.value)}
                    disabled={loading}
                    style={{
                      background: selected ? COLOR.accent : "#222",
                      color: selected ? "#fff" : COLOR.textStrong,
                      border: "none", borderRadius: 4, padding: "4px 10px",
                      fontSize: 11, cursor: loading ? "wait" : "pointer",
                      opacity: loading ? 0.6 : 1,
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {error && (
          <div style={{ fontSize: 10, color: "#dc2626", marginTop: 8 }}>{error}</div>
        )}
      </Card>
    );
  }
  ```

- [ ] **Step 2: Pass new props from WeeklyReviewPage**

  Open `components/coach/WeeklyReviewPage.tsx`. Update the `<WeeklyReviewReconfirm>` invocation:

  ```tsx
  <WeeklyReviewReconfirm
    reviewId={row.id}
    reconfirm={p.reconfirm}
    responses={row.reconfirm_responses}
    userId={userId}
    weekStart={weekStart}
  />
  ```

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 4: Manual exercise**

  ```bash
  npm run dev
  ```

  Open the review page, tap a chip. Expected: chip turns accent-colored, no error appears, refreshing the page persists the selection. §6 narrative may update (cheap second AI call).

### Task 5.3: Commit endpoint (HMAC) + tools registration

**Files:**
- Create: `app/api/coach/weekly-review/[id]/commit/route.ts`
- Modify: `lib/coach/tools.ts`

- [ ] **Step 1: Inspect existing HMAC tool registration pattern**

  ```bash
  grep -n "commit_weekly_plan\|propose_weekly_plan\|approval-token\|verifyApproval" lib/coach/tools.ts | head
  ```

  Note the existing `commit_*` / `propose_*` pair from weekly-planning v1 — model your registration the same way.

- [ ] **Step 2: Write the commit endpoint**

  Create `app/api/coach/weekly-review/[id]/commit/route.ts`:

  ```ts
  import { NextResponse } from "next/server";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { verifyApprovalToken } from "@/lib/coach/approval-token";

  export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { approval_token } = await req.json();
    if (!approval_token || !verifyApprovalToken(approval_token, { reviewId: id, userId: user.id })) {
      return NextResponse.json({ error: "bad approval" }, { status: 403 });
    }

    const { data: row, error: rErr } = await supabase
      .from("weekly_reviews")
      .select("id, user_id, payload, next_week_start, status")
      .eq("id", id)
      .single();
    if (rErr || !row || row.user_id !== user.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (row.status !== "draft") {
      return NextResponse.json({ error: "already committed or superseded" }, { status: 409 });
    }

    const presc = row.payload.prescription;

    const { data: upserted, error: upsertErr } = await supabase
      .from("training_weeks")
      .upsert({
        user_id: user.id,
        week_start: row.next_week_start,
        session_plan: presc.session_plan,
        rir_target: presc.rir_target,
        weekly_focus: presc.weekly_focus,
      }, { onConflict: "user_id,week_start" })
      .select("id")
      .single();
    if (upsertErr || !upserted) {
      return NextResponse.json({ error: upsertErr?.message ?? "upsert failed" }, { status: 500 });
    }

    const { error: updErr } = await supabase
      .from("weekly_reviews")
      .update({
        status: "committed",
        committed_at: new Date().toISOString(),
        committed_training_week_id: upserted.id,
      })
      .eq("id", id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, training_week_id: upserted.id });
  }
  ```

- [ ] **Step 3: Register tools in lib/coach/tools.ts**

  Open `lib/coach/tools.ts`. Find the existing tool registry. Add (preserving format):

  ```ts
  // commit_weekly_plan — HMAC-signed; commits a draft weekly_review's
  // prescription into a training_weeks row.
  {
    name: "commit_weekly_plan",
    description: "Commit the weekly review's prescription into training_weeks for next Monday. Requires HMAC approval token.",
    input_schema: {
      type: "object",
      properties: {
        review_id: { type: "string" },
        approval_token: { type: "string" },
      },
      required: ["review_id", "approval_token"],
    },
  },
  // regenerate_weekly_review — re-run all composers + narrative.
  {
    name: "regenerate_weekly_review",
    description: "Regenerate a weekly review (creates version N+1). No approval needed.",
    input_schema: {
      type: "object",
      properties: { review_id: { type: "string" } },
      required: ["review_id"],
    },
  },
  // propose_nutrition_adjustment — ±kcal delta on a draft review's targets.
  {
    name: "propose_nutrition_adjustment",
    description: "Propose a ±kcal adjustment to the weekly review's nutrition target. Re-narrates §6.",
    input_schema: {
      type: "object",
      properties: {
        review_id: { type: "string" },
        kcal_delta: { type: "number" },
      },
      required: ["review_id", "kcal_delta"],
    },
  },
  ```

- [ ] **Step 4: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 5.4: Regenerate endpoint

**Files:**
- Create: `app/api/coach/weekly-review/[id]/regenerate/route.ts`

- [ ] **Step 1: Write the endpoint**

  Create `app/api/coach/weekly-review/[id]/regenerate/route.ts`:

  ```ts
  import { NextResponse } from "next/server";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import { generateWeeklyReview } from "@/lib/coach/weekly-review";
  import { revalidatePath } from "next/cache";

  export const maxDuration = 60;

  export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const userSupabase = await createSupabaseServerClient();
    const { data: { user } } = await userSupabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const sb = createSupabaseServiceRoleClient();
    const { data: existing } = await sb
      .from("weekly_reviews")
      .select("id, user_id, week_start, version, status")
      .eq("id", id)
      .single();
    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const today = new Date();
    const isMondayCatchup = today.getUTCDay() === 1;
    let result;
    try {
      result = await generateWeeklyReview({
        supabase: sb, userId: user.id, weekStart: existing.week_start, late: isMondayCatchup,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const newVersion = existing.version + 1;
    const nextMonday = shiftDays(existing.week_start, 7);
    const { data: inserted, error: insErr } = await sb
      .from("weekly_reviews")
      .insert({
        user_id: user.id,
        week_start: existing.week_start,
        next_week_start: nextMonday,
        version: newVersion,
        status: "draft",
        payload: result.payload,
        narrative_md: result.narrative_md,
        reconfirm_responses: {},
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      return NextResponse.json({ error: insErr?.message ?? "insert failed" }, { status: 500 });
    }

    if (existing.status === "draft") {
      await sb
        .from("weekly_reviews")
        .update({ status: "superseded" })
        .eq("id", existing.id);
    }

    revalidatePath(`/coach/weeks/${existing.week_start}`);

    return NextResponse.json({ ok: true, new_review_id: inserted.id, version: newVersion });
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  ```

### Task 5.5: Adjust-nutrition endpoint + sheet

**Files:**
- Create: `app/api/coach/weekly-review/[id]/adjust-nutrition/route.ts`
- Create: `components/coach/AdjustDeficitSheet.tsx`

- [ ] **Step 1: Write the endpoint**

  Create `app/api/coach/weekly-review/[id]/adjust-nutrition/route.ts`:

  ```ts
  import { NextResponse } from "next/server";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { regenerateNarrative } from "@/lib/coach/weekly-review/regenerate-narrative";

  export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { kcal_delta } = await req.json();
    if (typeof kcal_delta !== "number" || Math.abs(kcal_delta) > 500) {
      return NextResponse.json({ error: "kcal_delta out of bounds" }, { status: 400 });
    }

    const { data: row, error: rErr } = await supabase
      .from("weekly_reviews")
      .select("id, user_id, payload, reconfirm_responses")
      .eq("id", id)
      .single();
    if (rErr || !row || row.user_id !== user.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const payload = structuredClone(row.payload);
    const newKcal = Math.max(800, payload.targets.nutrition.kcal + kcal_delta);
    const proteinFloor = payload.targets.nutrition.protein_g;
    const fatFloor = payload.targets.nutrition.fat_g;
    const carbsNew = Math.max(0, Math.round((newKcal - proteinFloor * 4 - fatFloor * 9) / 4));
    payload.targets.nutrition.kcal = newKcal;
    payload.targets.nutrition.carbs_g = carbsNew;

    const newNarrative = await regenerateNarrative({
      payload, reconfirmResponses: row.reconfirm_responses,
    });

    const { error: uErr } = await supabase
      .from("weekly_reviews")
      .update({ payload, narrative_md: newNarrative, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, payload, narrative_md: newNarrative });
  }
  ```

- [ ] **Step 2: Write the sheet component**

  Create `components/coach/AdjustDeficitSheet.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import { useQueryClient } from "@tanstack/react-query";
  import { BottomSheet } from "@/components/ui/BottomSheet";
  import { COLOR } from "@/lib/ui/theme";
  import { queryKeys } from "@/lib/query/keys";

  export function AdjustDeficitSheet({
    reviewId,
    userId,
    weekStart,
    onClose,
  }: {
    reviewId: string;
    userId: string;
    weekStart: string;
    onClose: () => void;
  }) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function adjust(delta: number) {
      setBusy(true); setError(null);
      try {
        const r = await fetch(`/api/coach/weekly-review/${reviewId}/adjust-nutrition`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kcal_delta: delta }),
        });
        if (!r.ok) throw new Error(await r.text());
        await queryClient.invalidateQueries({
          queryKey: queryKeys.weeklyReviews.one(userId, weekStart),
        });
        onClose();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setBusy(false);
      }
    }

    return (
      <BottomSheet onClose={onClose} title="Adjust deficit">
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 13, color: COLOR.textMuted, margin: 0 }}>
            Apply a kcal delta to next week's nutrition target. Protein floor preserved; carbs absorb the change.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            {[-200, -100, +100, +200].map((d) => (
              <button
                key={d}
                disabled={busy}
                onClick={() => adjust(d)}
                style={{
                  flex: 1, padding: "10px 0",
                  background: d < 0 ? "#7c2d12" : "#14532d",
                  color: "#fff", border: "none", borderRadius: 8,
                  fontWeight: 700, fontSize: 13, cursor: busy ? "wait" : "pointer",
                }}
              >
                {d > 0 ? `+${d}` : d}
              </button>
            ))}
          </div>
          {error && <div style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>}
        </div>
      </BottomSheet>
    );
  }
  ```

  Note: this assumes a `BottomSheet` primitive from V2 redesign. Verify import path with `grep -rn "export.*BottomSheet" components/ui/`. Adjust path if different.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 5.6: Wire §8 Actions

**Files:**
- Modify: `components/coach/WeeklyReviewActions.tsx`

- [ ] **Step 1: Replace the stub with the wired version**

  Replace the contents of `components/coach/WeeklyReviewActions.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import { useRouter } from "next/navigation";
  import { useQueryClient } from "@tanstack/react-query";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { queryKeys } from "@/lib/query/keys";
  import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
  import { AdjustDeficitSheet } from "@/components/coach/AdjustDeficitSheet";
  import type { WeeklyReviewRow, Weekday } from "@/lib/data/types";

  export function WeeklyReviewActions({ reviewRow }: { reviewRow: WeeklyReviewRow }) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showDaySwap, setShowDaySwap] = useState<Weekday | null>(null);
    const [showAdjust, setShowAdjust] = useState(false);

    const committed = reviewRow.status === "committed";

    async function commit() {
      if (committed) return;
      setBusy(true); setError(null);
      try {
        const tokenRes = await fetch(`/api/coach/approval-token?review_id=${reviewRow.id}`);
        const { token } = await tokenRes.json();
        const r = await fetch(`/api/coach/weekly-review/${reviewRow.id}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approval_token: token }),
        });
        if (!r.ok) throw new Error(await r.text());
        await queryClient.invalidateQueries({
          queryKey: queryKeys.weeklyReviews.one(reviewRow.user_id, reviewRow.week_start),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.trainingWeeks.all(reviewRow.user_id),
        });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "commit failed");
      } finally {
        setBusy(false);
      }
    }

    async function regenerate() {
      setBusy(true); setError(null);
      try {
        const r = await fetch(`/api/coach/weekly-review/${reviewRow.id}/regenerate`, { method: "POST" });
        if (!r.ok) throw new Error(await r.text());
        const { new_review_id } = await r.json();
        await queryClient.invalidateQueries({
          queryKey: queryKeys.weeklyReviews.one(reviewRow.user_id, reviewRow.week_start),
        });
        router.refresh();
        void new_review_id;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "regen failed");
      } finally {
        setBusy(false);
      }
    }

    function discuss() {
      const ctx = `weekly_review:${reviewRow.week_start}`;
      router.push(`/coach?mode=default&ctx=${encodeURIComponent(ctx)}`);
    }

    return (
      <Card>
        <SectionLabel>ACTIONS</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          <ChipButton primary disabled={busy || committed} onClick={commit}>
            {committed ? "Committed ✓" : "Commit plan ✓"}
          </ChipButton>
          <ChipButton disabled={busy} onClick={() => setShowDaySwap("Mon")}>
            Swap a day
          </ChipButton>
          <ChipButton disabled={busy} onClick={() => setShowAdjust(true)}>
            Adjust deficit
          </ChipButton>
          <ChipButton disabled={busy} onClick={regenerate}>
            Regenerate
          </ChipButton>
          <ChipButton disabled={busy} onClick={discuss}>
            Discuss in chat
          </ChipButton>
        </div>
        {error && <div style={{ fontSize: 10, color: "#dc2626", marginTop: 8 }}>{error}</div>}
        {showDaySwap && (
          <DaySwapSheet
            userId={reviewRow.user_id}
            weekStart={reviewRow.next_week_start}
            sourceDay={showDaySwap}
            plan={reviewRow.payload.prescription.session_plan}
            onClose={() => setShowDaySwap(null)}
          />
        )}
        {showAdjust && (
          <AdjustDeficitSheet
            reviewId={reviewRow.id}
            userId={reviewRow.user_id}
            weekStart={reviewRow.week_start}
            onClose={() => setShowAdjust(false)}
          />
        )}
      </Card>
    );
  }

  function ChipButton({
    primary, disabled, onClick, children,
  }: {
    primary?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          background: primary ? COLOR.accent : "#222",
          color: primary ? "#fff" : COLOR.textStrong,
          border: primary ? "none" : "1px solid #444",
          borderRadius: 6, padding: "4px 10px",
          fontSize: 11, fontWeight: primary ? 700 : 500,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {children}
      </button>
    );
  }
  ```

  Notes:
  - Assumes existing `/api/coach/approval-token?review_id=…` endpoint that the chat-stream already uses for `propose_*`/`commit_*` flows. If a generic approval-token issuer endpoint doesn't exist as a GET route, add one in this slice — a 25-line route handler that uses [lib/coach/approval-token.ts](../../../lib/coach/approval-token.ts).
  - `DaySwapSheet` props match the existing component signature.

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 5.7: Manual end-to-end exercise

- [ ] **Step 1: Exercise each chip**

  ```bash
  npm run dev
  ```

  Open the review page. Verify each chip:
  - **Commit ✓** → row status flips to `committed`, `training_weeks` row appears for next Monday.
  - **Swap a day** → DaySwapSheet opens, can swap.
  - **Adjust deficit** → modal opens, ±100 buttons apply delta, page re-renders with updated kcal.
  - **Regenerate** → new version row inserted, prior draft set to `superseded`.
  - **Discuss in chat** → navigates to `/coach?mode=default&ctx=weekly_review:…`.

- [ ] **Step 2: Commit Slice 5**

  ```bash
  git add app/api/coach/weekly-review components/coach lib/coach/tools.ts
  git commit -m "feat(coach): weekly-review interactivity — chips + commit + regenerate (Slice 5/6)"
  git push
  gh pr create --title "feat(coach): weekly-review interactivity (Slice 5/6)" \
    --body "All §3 reconfirm chips wired. All §8 action chips wired (Commit/Swap/Adjust deficit/Regenerate/Discuss). HMAC commit upserts training_weeks. Three new tools registered in chat dispatcher."
  ```

---

## Slice 6 — Banner discoverability on /coach (mid-week findability)

Goal: Mid-week (Wed-Sat), a banner on `/coach` surfaces "Review ready · 2 questions" → `/coach/weeks/<lastMonday>`. Resolves the original "dead zone" complaint.

### Task 6.1: WeekReviewBanner component

**Files:**
- Create: `components/coach/WeekReviewBanner.tsx`

- [ ] **Step 1: Write the banner**

  Create `components/coach/WeekReviewBanner.tsx`:

  ```tsx
  "use client";
  import Link from "next/link";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";

  export function WeekReviewBanner({
    userId,
    weekStart,
  }: {
    userId: string;
    weekStart: string;       // last Monday
  }) {
    const { data: row } = useWeeklyReview(userId, weekStart);
    if (!row) return null;

    const unanswered = row.payload.reconfirm.filter(
      (r) => !row.reconfirm_responses[r.id]
    ).length;
    const committed = row.status === "committed";

    if (committed && unanswered === 0) return null;   // nothing to do

    return (
      <Card>
        <SectionLabel>
          {committed ? "WEEK COMMITTED" : "REVIEW READY"}
        </SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          Wk {row.payload.header.week_n} review
          {unanswered > 0 ? ` · ${unanswered} question${unanswered === 1 ? "" : "s"} to confirm` : ""}
        </div>
        <Link
          href={`/coach/weeks/${weekStart}`}
          style={{
            display: "inline-block", marginTop: 8, padding: "8px 12px",
            background: COLOR.accent, color: "#fff", borderRadius: 9999,
            fontWeight: 700, fontSize: 12, textDecoration: "none",
          }}
        >
          {committed ? "Re-open review →" : "Open review →"}
        </Link>
      </Card>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

### Task 6.2: Wire banner into CoachClient.tsx

**Files:**
- Modify: `components/coach/CoachClient.tsx`

- [ ] **Step 1: Add the banner above the existing PlanWeekCTA/WeekPlanCard slot**

  Open `components/coach/CoachClient.tsx`. Locate the contextual banners block (around the existing `<BlockProgressCard>` / `<PlanWeekCTA>` / `<WeekPlanCard>` group). Compute the "last Monday" for the review banner:

  ```ts
  // near the top of the component, alongside existing date helpers
  const lastMondayForReview = (() => {
    const d = new Date(`${todayDate}T12:00:00Z`);
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (dow - 1) - 7);
    return d.toISOString().slice(0, 10);
  })();
  ```

  Render the banner conditionally — show it on Tue-Sat (the dead-zone window):

  ```tsx
  // Inside the banners <div>, alongside BlockProgressCard:
  {(today !== "Sunday" && today !== "Monday") && (
    <WeekReviewBanner userId={userId} weekStart={lastMondayForReview} />
  )}
  ```

  Add the import at the top of the file:

  ```tsx
  import { WeekReviewBanner } from "@/components/coach/WeekReviewBanner";
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Manual exercise**

  ```bash
  npm run dev
  ```

  Visit `/coach` on a weekday (any day Tue-Sat). Expected: `WeekReviewBanner` appears above the chat. On Sunday/Monday it should not appear (the existing `PlanWeekCTA` covers those days).

### Task 6.3: Final spec coverage check

- [ ] **Step 1: Re-read the spec's Verification section**

  ```bash
  grep -A 20 "## Verification" docs/superpowers/specs/2026-05-15-weekly-review-document-design.md
  ```

  Walk through each item:
  - ✅ Typecheck clean — `npm run typecheck`
  - ✅ Manual cron trigger — done in Slice 3
  - ✅ Idempotency — done in Slice 3
  - ✅ Regenerate version bump — exercise on the review page
  - ✅ Commit writes training_weeks — exercise on the review page
  - ✅ Reconfirm persists + narrative refreshes — exercise on the review page
  - ✅ Edge cases — exercise the relevant ones with seeded data (first-week-of-block, missed Sunday, GLP-1 active)
  - ✅ Number formatting via `fmtNum` — `grep -n "\.toFixed(\|String(.*\\.weight_kg)" components/coach/Weekly*` should return zero hits

- [ ] **Step 2: Commit Slice 6 + open PR**

  ```bash
  git add components/coach/WeekReviewBanner.tsx components/coach/CoachClient.tsx
  git commit -m "feat(coach): weekly-review mid-week discoverability banner (Slice 6/6)"
  git push
  gh pr create --title "feat(coach): mid-week discoverability banner (Slice 6/6)" \
    --body "Closes the loop on the original Wed-Sat dead-zone complaint. WeekReviewBanner surfaces on /coach Tue-Sat showing 'Review ready · N questions to confirm' → links to /coach/weeks/[lastMonday]."
  ```

---

## Self-Review

After the implementer completes Slice 6, run the spec self-review one more time:

- [ ] Re-read [docs/superpowers/specs/2026-05-15-weekly-review-document-design.md](../specs/2026-05-15-weekly-review-document-design.md) — every Goal (1-7) has a corresponding task; every Non-Goal is honoured.
- [ ] Open the dev server, walk the full flow on real data: visit `/coach`, open the review banner, answer a reconfirm chip, regenerate, commit. Each step succeeds without error.
- [ ] Confirm no orphan files (e.g. unused exports) and no leftover `TODO` comments in shipped code.
- [ ] Update [CLAUDE.md](../../../CLAUDE.md) with a one-line entry under "Database migrations" for 0014, mirroring the existing entries for 0011-0013.

When all six slices are merged and verified, this sub-project is done. The remaining four sub-projects (#2 Daily Coach Loop, #3 Coach Tab UX shell, #4 Proactive reach-out, #5 Trend layer) each get their own spec and plan.
