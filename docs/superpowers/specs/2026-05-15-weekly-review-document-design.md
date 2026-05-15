# Weekly Review Document — Design

**Date:** 2026-05-15
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #1 of the "coach-as-real-coach" arc. The remaining four sub-projects — Daily Coach Loop (#2), Coach Tab UX + tool-discovery shell (#3), Proactive reach-out (#4), Trend layer (#5) — are explicit follow-up specs; none are in this scope. See "Phasing relation" below.

## Problem

The V2 coach pivot (PRs [#65](commit), [#70](commit)) collapsed the legacy `InsightsList` / `RecommendationsList` / `WeeklyReview` panels into the chat surface on the principle that "the coach is conversational." The principle is right; the execution lost the **document**. `WeeklyReview.tsx` was deleted and nothing replaced its function — the coach no longer produces a durable, structured artifact that says "last week happened like this, next week looks like this, here is per-lift load progression with periodization rationale, here is what changes and why."

A real coach reviewing an athlete's week does five things, in order:
1. **Recap last week against plan.** Sessions done vs missed, per-lift performance, sleep/protein/weight aggregates, RIR/form notes.
2. **Cross-check discrepancies.** "Your bench was flat two weeks running. Form, fatigue, or programming?" The coach validates data against athlete feel — reconfirms before prescribing.
3. **Read the trend layer.** Loss rate, strength slope, plateau flags over a 4-week window.
4. **Prescribe next week.** Per-lift sets×reps×load with periodization label (MEV/MAV/MRV/Deload), volume per muscle, schedule, nutrition + sleep + recovery targets.
5. **Narrate the "why".** "You cleared MEV cleanly → MAV. Bench is the exception: 2-week plateau → -2.5kg deload and form reset." This is the coaching voice that connects the structured data to a decision.

The pieces of input data already exist — `training_blocks`, `training_weeks`, `workouts`, `daily_logs`, `checkins`, `body_measurements`, [lib/coach/progress-metrics.ts](../../../lib/coach/progress-metrics.ts), [lib/coach/muscle-volume.ts](../../../lib/coach/muscle-volume.ts), `plan_payload`. What's missing is the **artifact** that synthesizes them and the **flow** that delivers it on Sunday and lets the athlete validate it before committing the next week's plan.

This spec covers the Weekly Review Document: a versioned per-week artifact, auto-drafted Sunday morning via Vercel cron, surfaced as a chat card (delivery moment, mirrors morning-brief pattern) and a full-page document at `/coach/weeks/[week_start]` (reference + interactive validation surface). Six deterministic composers produce the structured payload; one Sonnet 4.6 call narrates the "what changes & why" paragraph. Athlete validates via reconfirm chips, commits via HMAC-signed `commit_weekly_plan` tool. Architecture mirrors `lib/coach/plan-builder/` — AI never fabricates prescriptions, only narrates them.

## Goals

1. **Produce a durable weekly artifact.** Persistent row in a new `weekly_reviews` table, versioned, browsable at `/coach/weeks/[week_start]` for any past or current week. The document is the coach's primary output, not a chat-history side effect.
2. **Auto-deliver Sunday morning.** Vercel cron at 04:00 UTC (≈08:00 GST for the single user) drafts the review and writes a `kind='weekly_review'` chat card. Catch-up cron on Monday 04:00 UTC if Sunday missed.
3. **Deterministic prescription, AI narration.** Six pure composers produce the structured payload (recap, reconfirm chips, trend signals, per-lift prescription, per-muscle volume, targets). One Sonnet 4.6 call produces the §6 "What changes & why" narrative. AI cannot fabricate prescriptions — same constraint as plan-builder.
4. **Interactive reconfirm without gating.** The athlete validates discrepancies via chips on the document page. Answers persist to `weekly_reviews.reconfirm_responses`. Commit is allowed regardless of answer state — unanswered chips simply re-surface in the next week's review as repeated discrepancies.
5. **HMAC-gated commit (plan-builder pattern).** "Commit plan ✓" calls `commit_weekly_plan` which upserts the `training_weeks` row for next Monday from the review's prescription payload. Review row transitions to `status='committed'`.
6. **Action chips double as tool-discovery.** §8 action chips (Commit / Swap a day / Adjust deficit / Regenerate / Discuss in chat) make structured coach tools visible. Partial down-payment on sub-project #3's tool-discovery work.
7. **Idempotent + versioned.** One `draft` row per `(user_id, week_start)`. Regenerate creates `version=2`, supersedes prior draft. Once `committed`, future regenerates create a new `draft` row alongside (commit is sticky on its version).

## Non-Goals

- **Mid-week recap variant.** The Weekly Review is a Sunday artifact only. Mid-week analytical advice ("how's your week going so far") is sub-project #2 (Daily Coach Loop). Out of scope here.
- **Push notification when review is ready.** Sub-project #4 (Proactive reach-out). This spec emits the chat card; user discovers it next time they open the app.
- **Deep trend page.** §4 (Trend Signals) surfaces 4-week aggregates only — a strip of numbers with a "See full trends →" link to a page that does not yet exist. Building that page is sub-project #5.
- **Block transitions.** End-of-block transitions (Week 5 deload → next block setup) go through the existing `setup_block` chat mode. The Week 5 review still wraps the meso but does not propose a new block — the user enters `setup_block` flow separately.
- **Multi-user generalization.** Single-user app. Cron is hardcoded to one user's TZ.
- **Editable review prose.** Athlete validates via reconfirm chips, not by editing §6 narrative directly. To change the narrative, regenerate.
- **Cross-block historical comparison.** Documents are per-week; comparing this block's Week 3 to last block's Week 3 is not in scope. Lives in trend layer (#5).
- **Notification when discrepancies go unanswered for X weeks.** No nag loop. Repeat discrepancies surface naturally in the next review.

## Phasing relation

| Sub-project | What it does | Status |
|---|---|---|
| **#1 Weekly Review Document (this spec)** | Sunday artifact, per-lift prescriptions, reconfirm flow, commit gate | 📝 Designing |
| #2 Daily Coach Loop | Mon kickoff explains the week from this doc; Tue-Sat brief Advice block references it | ⏸ Future spec |
| #3 Coach Tab UX + tool-discovery | Tab layout that surfaces this doc, composer suggestion chips, ask-me surface | ⏸ Future spec |
| #4 Proactive reach-out | Push notifications when this doc is ready, when plateau detected, etc. | ⏸ Future spec |
| #5 Trend layer | `/coach/trends` deep page; feeds richer signals into §4 of future reviews | ⏸ Future spec |

The Weekly Review is the keystone. Sub-projects #2 and #3 reference it in their UX; #5 feeds it deeper trend data. #4 is independent infrastructure.

## Architecture overview

Three flows:

**A. Sunday auto-draft (Vercel cron):**

```
Sunday 04:00 UTC cron hits /api/coach/weekly-review/sync
                  │
                  ▼
Resolve target week_start (last Sunday's Monday, UTC)
                  │
                  ▼
For active user (single-user app):
  Check: review already exists for week_start?
  ├─ yes (any status) → return, done
  └─ no → continue
                  │
                  ▼
Parallel composer fetch (server-side):
   - composeRecap(week_start)
   - composeReconfirm(week_start)            ← consumes recap output
   - composeTrends(today)                     ← 4-week rolling
   - composePrescription(week_start, block)  ← per-lift rules
   - composeVolume(week_start, block)        ← per-muscle MEV/MAV/MRV
   - composeTargets(plan_payload)            ← schedule + macros + sleep
                  │
                  ▼
Assemble WeeklyReviewPayload
                  │
                  ▼
Single Anthropic Sonnet 4.6 call:
   - Input: payload + reconfirm prompts + block goal
   - Output: §6 narrative_md (1 paragraph, ~120-180 words)
                  │
                  ▼
INSERT weekly_reviews (status='draft', version=1, payload, narrative_md)
                  │
                  ▼
INSERT chat_messages (kind='weekly_review', ui=<WeeklyReviewCard>)
                  │
                  ▼
revalidatePath("/coach"), revalidatePath(`/coach/weeks/${week_start}`)
```

**B. User opens the document:**

```
GET /coach/weeks/[week_start]
       │
       ▼
Server component: fetch latest weekly_reviews row for (user, week_start)
       │
       ▼
TanStack Query SSR-hydrate (pattern from CLAUDE.md client-cache rules)
       │
       ▼
Renders 8 sections from payload + narrative_md
       │
       ▼
Reconfirm chips: client-side mutations to PATCH /api/coach/weekly-review/[id]/reconfirm
       │
       ▼
On chip tap, optional single-section narrative re-render (cheap second Anthropic call,
   ~50 tokens out, scoped to §6 only)
```

**C. User commits:**

```
Tap "Commit plan ✓" chip
       │
       ▼
POST /api/coach/weekly-review/[id]/commit
       │
       ▼
Verify HMAC signature on commit payload (COACH_TOOL_SECRET)
       │
       ▼
Begin transaction:
   UPSERT training_weeks (user_id, week_start=next_monday, session_plan, rir_target,
                          weekly_focus, ...) from review.payload.prescription
   UPDATE weekly_reviews SET status='committed', committed_at=now(),
                             committed_training_week_id=<new_id>
End transaction
       │
       ▼
queryClient.invalidateQueries({queryKey: [trainingWeeks, blockProgress, ...]})
       │
       ▼
revalidatePath("/coach"), revalidatePath("/strength")
```

## Data model

New migration: `supabase/migrations/0014_weekly_reviews.sql`.

```sql
create table public.weekly_reviews (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  week_start                  date not null,  -- Monday of the week the review COVERS (recap window)
  next_week_start             date not null,  -- Monday of the week being PRESCRIBED (= week_start + 7)
  version                     int  not null default 1,
  status                      text not null check (status in ('draft','committed','superseded'))
                                                    default 'draft',
  block_id                    uuid references public.training_blocks(id),
  payload                     jsonb not null,                  -- composer outputs
  narrative_md                text  not null,                  -- §6 "what changes & why"
  reconfirm_responses         jsonb not null default '{}'::jsonb,
  committed_at                timestamptz,
  committed_training_week_id  uuid references public.training_weeks(id),
  generated_at                timestamptz not null default now(),
  created_at                  timestamptz not null default now(),
  unique (user_id, week_start, version)
);

create index weekly_reviews_user_week_idx on public.weekly_reviews(user_id, week_start desc);
create index weekly_reviews_status_idx on public.weekly_reviews(user_id, status) where status='draft';

alter table public.weekly_reviews enable row level security;
create policy weekly_reviews_select on public.weekly_reviews
  for select using (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies: all writes go through service-role endpoints.

-- Extend chat_messages.kind union to include 'weekly_review'
-- (kind union currently defined in migration 0011)
alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages
  add constraint chat_messages_kind_check check (
    kind in ('coach','morning_intake','morning_brief','weekly_review')
  );
```

**Payload shape** ([lib/data/types.ts](../../../lib/data/types.ts) gains a `WeeklyReviewPayload` type):

```ts
type WeeklyReviewPayload = {
  schema_version: 1;
  header: {
    week_n: number;             // 1..5 within the block
    total_weeks: number;        // 5 for standard meso
    block_goal_text: string;
    block_phase_now: ResearchPhase;     // mev | mav | mrv | deload
    block_phase_next: ResearchPhase;
    on_pace: boolean | null;
    weeks_remaining: number;
    late: boolean;                 // true if Monday catch-up cron drafted this
  };
  recap: {
    sessions_planned: number;
    sessions_done: number;
    sessions_skipped: Array<{ day: Weekday; type: string }>;
    sessions_swapped: Array<{ day: Weekday; from: string; to: string }>;
    per_lift: Array<{
      lift: string;
      top_set: { weight_kg: number; reps: number; sets: number };
      reps_completed_pct: number | null;   // total reps done / total reps prescribed across working sets
      e1rm_kg: number | null;
      e1rm_delta_kg: number | null;
      e1rm_delta_pct: number | null;
      e1rm_history_3wk: number[];          // last 3 weeks of e1rm for plateau detection
      rir_target_met: boolean | null;
      rir_miss_consecutive: number;        // streak of consecutive weeks with RIR miss ≥2 (for rir_missed_twice)
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
    id: string;                 // stable id used as key in reconfirm_responses
    severity: 'info' | 'warn';
    rule_tag: string;           // 'e1rm_flat_2wk' | 'protein_gap_>10pct' | 'session_skipped' | etc.
    question: string;           // human-readable
    chips: Array<{ value: string; label: string }>; // pre-defined chip options
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
    next_week_start: string;    // 'YYYY-MM-DD'
    phase: ResearchPhase;
    rir_target: number | null;
    session_plan: Record<Weekday, string>;   // matches training_weeks.session_plan shape
    weekly_focus: string | null;
    per_lift: Array<{
      lift: string;
      sets: number;
      reps: number;
      weight_kg: number;
      delta_pct_from_last_week: number | null;
      pr_rebase_applied: boolean;          // composes with rationale_tag — PR rebases baseline even when load is held
      rationale_tag: string;               // see "Per-lift progression rules" section for full tag set
    }>;
  };
  volume: {
    per_muscle: Array<{
      muscle: string;
      last_week_sets: number;
      next_week_sets: number;
      tier: 'mev' | 'mav' | 'mrv';
    }>;
  };
  targets: {
    nutrition: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
    sleep: { hours: number; efficiency_pct: number };
    recovery_focus: string[];
  };
};
```

**Chat card UI shape** (analogous to `MorningBriefCard` in migration 0011):

```ts
type WeeklyReviewCard = {
  schema_version: 1;
  week_start: string;            // recap week Monday
  next_week_start: string;       // prescribed week Monday
  block_phase_now: ResearchPhase;
  block_phase_next: ResearchPhase;
  one_line_summary: string;      // "Wk 3 → Wk 4 · MAV next · 3/4 sessions · +2.5kg across"
  per_lift_preview: Array<{ lift: string; from: string; to: string }>; // 3-4 lifts max
  link_path: string;             // '/coach/weeks/2026-05-11'
  review_id: string;             // FK to weekly_reviews.id (for invalidation after regen)
};
```

`reconfirm_responses` shape:

```ts
type ReconfirmResponses = Record<string, {  // keyed by reconfirm.id
  chip_value: string;
  answered_at: string;          // ISO ts
}>;
```

## Composer architecture

New directory: `lib/coach/weekly-review/`. Mirrors `lib/coach/plan-builder/` structure.

| File | Purpose | Inputs | Output |
|---|---|---|---|
| `index.ts` | Orchestrator: parallel composer fetch + Anthropic call | `userId`, `weekStart`, supabase service-role client | full `{ payload, narrative_md }` |
| `compose-recap.ts` | Last-week sessions, per-lift performance, sleep/nutrition/weight aggregates | week window, user_id | `payload.recap` |
| `compose-reconfirm.ts` | Discrepancy detector → reconfirm prompt list | `payload.recap` + 2-week e1RM history | `payload.reconfirm` |
| `compose-trends.ts` | 4-week rolling: loss rate, strength slope, /LBM slope, plateau flags | 4-week window of daily_logs (Withings-sourced weight) + workouts | `payload.trends` |
| `compose-prescription.ts` | Per-lift next-week loads per phase rules | block, last-week per_lift, form notes, plateau flags | `payload.prescription` |
| `compose-volume.ts` | Per-muscle target sets next week | block phase, last-week volume from existing [lib/coach/muscle-volume.ts](../../../lib/coach/muscle-volume.ts) | `payload.volume` |
| `compose-targets.ts` | Nutrition + sleep + recovery for next week | `plan_payload` or `intake_payload`, GLP-1 mode if any | `payload.targets` |
| `narrative-prompt.ts` | Single Sonnet 4.6 call: structured payload → §6 prose | full payload | `narrative_md` |
| `regenerate-narrative.ts` | Re-runs ONLY the narrative call after reconfirm chip answers | payload + reconfirm_responses | new `narrative_md` |

All composers are pure (`compose-X.ts` exports `composeX(input): output`), receive a Supabase service-role client only if they need to fetch raw data. No side effects. Identical idiom to `lib/coach/plan-builder/compose-*.ts`. Errors throw — callers handle.

Single AI call constraint: the only Anthropic call in the orchestrator is `narrative-prompt.ts`. Sonnet 4.6 because the §6 paragraph quality matters (it's the coach's voice). Estimated tokens: ~800 input (payload + system prompt) + ~250 output. Cost: ~$0.005 per review. Latency: ~3-5s acceptable since cron is async and user opens the doc later. Regeneration narrative-only call: ~600 input + 250 output, ~$0.004.

## Per-lift progression rules (`compose-prescription.ts`)

Deterministic. The athlete's prior-week per-lift performance + the block's current phase determine next week's prescription. Rules below reflect an independent evidence-based coaching review (2026-05-15) — see git history for the prior simpler ruleset.

**Inputs per lift:**
- Last week: sets, reps, top-set weight_kg, per-set rep counts.
- Last 3 weeks of `e1rm_kg` (1RM Epley estimate from existing [lib/strength/e1rm.ts](../../../lib/strength/e1rm.ts) — verify path).
- Cumulative `rir_miss_consecutive` streak (precomputed by recap composer).
- RIR target for the week from `training_weeks.rir_target`.
- RIR achieved per-set if available; else inferred from rep completion vs target.
- Form notes from `workouts.notes` for this lift across the week.
- Body weight loss rate (4-week trailing average from `daily_logs.weight_kg`).
- Sleep average hours (last 7 days from `daily_logs.sleep_hours`).
- HRV flag (last-7-day HRV >1 SD below 30-day baseline, computed in recap).
- **Per-exercise increment config** from `SESSION_PLANS[session_type].find(e => e.key === lift_key).increment` ([lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts)). Shape: `{ step: number; intermediate?: number }`. Used to resolve target loads to physically-loadable weights — see "Increment floor behavior" below.

### Phase mapping (general cadence — when no overrides fire)

| Current phase | Phase next week | Action | Notes |
|---|---|---|---|
| MEV (Week 1) | MAV (Week 2) | Load step per lift table below | If cleared cleanly (RIR target met + no form notes) |
| MAV (Weeks 2–3) | MAV (Wk 3) or MRV (Wk 4) | Load step per lift table below | Advance to MRV if both prior weeks cleared |
| MRV (Week 4) | Deload (Week 5) | **Hold top-set load; +1 set OR −1 rep target** (volume drives at MRV, not load) | Auto-trigger; phase advance not optional |
| Deload (Week 5) | Block-end | **−10 to −15% load AND −40 to −50% sets** (both knobs) | User enters `setup_block` for next meso |

### Per-lift load-step table (used by phase mapping rows 1–2)

Different lifts progress at different rates — uniform percentages over-load OHP and under-resolve deadlift. Tracks Helms / Nuckols intermediate-trainee data. **The percentages below are TARGETS; the actual prescribed load is the target resolved through `roundToValidWeight()` using each exercise's `increment` config (see "Increment floor behavior" below).**

| Lift | MEV → MAV target | MAV → MRV target | Per-exercise increment (user's current gym) |
|---|---|---|---|
| Squat | +2.5% | +1.5% | `{step: 2.5}` — barbell, 1.25 kg pairs |
| Bench (Decline) | +2.5% | +1.5% | `{step: 2.5}` — barbell |
| Deadlift | +2% | +1% | `{step: 2.5}` — barbell |
| OHP | +1.5% target → in practice cycle through reps before load (see floor behavior) | Hold or +1 rep on top set | `{step: 5}` — smallest non-zero jump = 5 kg = ~16% of typical baseKg |

### Increment floor behavior

Each exercise's smallest physically-loadable jump is encoded in `SESSION_PLANS[session_type].find(e => e.key === lift_key).increment`. Resolution algorithm in `compose-prescription.ts`:

1. **Rule resolution** → `target_delta_pct` (e.g. +2.5% from per-lift table, or +0% / −2.5% / −5% from overrides).
2. **Hard cap** → clamp `target_delta_pct` to `[−4%, +4%]` per Hard guardrail 1.
3. **Target weight** = `last_week_top_set_kg × (1 + clamped_delta_pct)`.
4. **Resolve to loadable value** via [`roundToValidWeight(target, cfg)`](../../../lib/coach/weight-rounding.ts) using the exercise's `increment` config (handles barbell steps + machine pin stacks with intermediate weights, e.g. `{step: 5, intermediate: 2.3}` for a 5 kg pin stack with a 2.3 kg intermediate).
5. **Actual delta** = `(resolved_kg − last_week_kg) / last_week_kg`. If `|actual_delta| > 0.04` → force-hold at `last_week_kg` and suffix `rationale_tag` with `_increment_capped` (the round-up would exceed the 4% cap).
6. **Floor detection** → if `resolved_kg == last_week_kg` and the rule called for a non-zero step → suffix `rationale_tag` with `_increment_floor` so the narrative composer can explain why load held despite a rule calling for an increase.
7. **Otherwise** → prescription is `resolved_kg` with the original `rationale_tag`.

**Consequence for OHP** (and any exercise with a coarse increment relative to baseKg): the rule frequently resolves to hold-with-rep-target-progression rather than load increase. Many weeks the OHP prescription will be "same weight, hit one more rep on top set" — the narrative composer explains this is by design, not stagnation. After ≥3 weeks of clearing reps cleanly at the same load, the next prescription jumps a full `step` (capped at +4% only if the rule would otherwise exceed it — for OHP a 5 kg jump is often the right call even at +16%, which is why this exception is *acknowledged* not *capped*; see open question below).

**Missing increment config** (lift not in `SESSION_PLANS` or no `increment` field) → default to `{step: 2.5}` for barbell-archetype lifts (Squat/Bench/Deadlift/OHP) and `{step: 2}` for dumbbells; log a warning. Plan stage adds explicit `SESSION_PLANS` coverage for any uncovered big-four lift.

### Override rules — priority order (first match wins for the load delta)

`pr_rebase` is **composable** (always applies if a PR fired — sets `pr_rebase_applied=true` and updates the e1RM baseline regardless of which load-delta rule fires). All other rules below are **mutually exclusive load-delta rules**; the first one matched in this priority order produces the prescription.

| Priority | Condition | Effect | rationale_tag |
|---|---|---|---|
| 1 | First week of block (no prior week in this meso for this lift) | Use intake-derived starting loads; bypass phase mapping | `block_start_baseline` |
| 2 | Body-weight loss rate >0.7%/wk over last 2 weeks | Hold load this week (defend, don't grow in a deficit) | `cutting_hold` |
| 3 | Sleep avg <6h over last 7 days OR HRV flag triggered | Hold load this week | `recovery_hold` |
| 4 | e1RM flat (Δ ≤ 1.5%) for 3 consecutive weeks **AND** rep-shift already attempted | Drop to deload weight (−5%), reset phase to MEV for this lift only | `plateau_deload_reset` |
| 5 | e1RM flat (Δ ≤ 1.5%) for 3 consecutive weeks **AND** rep-shift not yet attempted | Hold load; swap rep range (5s↔8s); flag `plateau_rep_shift_attempted=true` on lift state | `plateau_rep_shift` |
| 6 | `rep_completion_pct` <90% on the working sets last week | Drop −2.5% next week | `rep_completion_miss` |
| 7 | RIR missed by ≥2 on top set, **twice in a row** (`rir_miss_consecutive >= 2`) | Hold load; surface a reconfirm chip — do not auto-prescribe further until athlete answers | `rir_missed_twice` |
| 8 | RIR missed by ≥2 on top set, single occurrence | Drop −2.5% next week | `rir_missed` |
| 9 | Any form note for this lift in last week | Hold load (composes with `pr_rebase` if applicable) | `form_hold` |
| (composable) | New PR last week (e1RM all-time high) | Rebase e1RM baseline; set `pr_rebase_applied=true`. Does NOT override the load-delta rule chosen above. | `pr_rebase` |

If no override rule fires (priorities 1–9 all false), the prescription uses the default per-lift step from the lift table above.

### Hard guardrails (apply last, after rule resolution)

1. **±4% weekly load delta cap.** No lift may move >4% in absolute |Δ| from last week's top-set load, regardless of which rule fired. Clamp at ±4% before rounding.
2. **Two consecutive RIR misses force a reconfirm chip** (priority 7 above). The athlete must answer the chip before the system auto-prescribes again on that lift; until answered, the lift's prescription holds at last week's load.
3. **Plateau detection threshold honors Epley noise.** The 1.5% Δ threshold for plateau is set above the ±3–5% week-to-week measurement error of Epley e1RM — picks up real stagnation, not noise.
4. **Block-start always wins.** If `block_start_baseline` and any plateau rule could both apply (e.g. user transitioned blocks but lift carried over), `block_start_baseline` takes precedence.

**Load rounding:** Handled by existing [`lib/coach/weight-rounding.ts`](../../../lib/coach/weight-rounding.ts) using per-exercise `increment` config from [`SESSION_PLANS`](../../../lib/coach/sessionPlans.ts). No hardcoded "1.25 kg" — the user's actual gym setup has heterogeneous increments (barbell 2.5, dumbbells 2, OHP 5, machines with pin stacks like `{step: 5, intermediate: 2.3}`). The morning brief assembler already consumes this — same source of truth.

**Lifts in scope:** The "big four" the athlete progresses through periodization — Deadlift, Squat, Bench, OHP. Accessories progress on rep targets (handled by existing [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts) intensity modifiers), not by load increment. Accessory prescriptions in §5 surface as "sets × reps" only, no load delta.

**Periodization data source:** Reads `training_blocks.research_phase` for current-week phase, computes next-phase by canonical meso shape (MEV → MAV × 2 → MRV → Deload). Migration 0008 already defines `research_phase`; no schema change needed.

**Per-lift state carryover.** Some rules need state that survives between weeks (`plateau_rep_shift_attempted` flag, `rir_miss_consecutive` counter). These are derived per-call by `compose-recap.ts` from the 3-week `e1rm_history_3wk` plus prior `weekly_reviews` rows — no new table needed. Plan stage decides whether to denormalize into a `lift_state` jsonb column on `weekly_reviews` for speed.

## Trigger and generation flow

**Endpoint:** `POST /api/coach/weekly-review/sync` ([app/api/coach/weekly-review/sync/route.ts](../../../app/api/coach/weekly-review/sync/route.ts)).

**Auth:** Bearer token `CRON_SECRET` header. Service-role Supabase client. Existing pattern from `/api/whoop/sync`.

**Cron schedule** in [vercel.json](../../../vercel.json):

```json
{
  "crons": [
    { "path": "/api/coach/weekly-review/sync", "schedule": "0 4 * * 0" },
    { "path": "/api/coach/weekly-review/sync", "schedule": "0 4 * * 1" }
  ]
}
```

- Sunday 04:00 UTC (08:00 GST) → primary delivery
- Monday 04:00 UTC (08:00 GST) → catch-up if Sunday missed

The endpoint is idempotent on `(user_id, week_start)`: if a row already exists for the target week (any version, any status), it returns early. Manual regenerate (below) is the only path to a second version.

**Manual regenerate:**
- `POST /api/coach/weekly-review/[id]/regenerate` — creates a new `version=N+1` row, supersedes the prior `draft` (if any). Re-runs all composers + narrative.
- Triggered from §8 "Regenerate review" chip on the page.
- Also exposed as a coach tool `regenerate_weekly_review` for natural-language invocation in chat (mirrors `regenerate_morning_brief` from PR #55).

**Reconfirm chip tap → single-section re-narrate:**
- `PATCH /api/coach/weekly-review/[id]/reconfirm` body `{ reconfirm_id, chip_value }`.
- Writes to `reconfirm_responses`. Calls `regenerate-narrative.ts` (narrative-only Anthropic call) to refresh §6 prose so it reflects the answer. Bumps an `updated_at` field; does NOT bump `version`.

## Surfaces

### Surface 1 — Chat card (delivery moment)

- `chat_messages.kind='weekly_review'`, `ui` jsonb of shape `WeeklyReviewCard`.
- Renders inline in the chat feed. Compact: header summary + 3-line per-lift preview + "Open full review →" button linking to `/coach/weeks/[week_start]`.
- Lives forever in chat history. Tappable from `/coach` recent tab (the date list).
- New component: `components/chat/WeeklyReviewCard.tsx`. Hooks into existing chat card dispatcher in [components/chat/ChatMessage.tsx](../../../components/chat/ChatMessage.tsx) alongside `MorningBriefCard`.

### Surface 2 — Full document page

- Route: `app/coach/weeks/[week_start]/page.tsx`. Dynamic segment is `YYYY-MM-DD`.
- Server component:
  - Auth gate → `redirect('/login')`.
  - Resolve latest version for `(user, week_start)` via `fetchWeeklyReviewServer`.
  - 404 if no row.
  - SSR-hydrate via `makeServerQueryClient()` and `<HydrationBoundary>` per CLAUDE.md client-cache rules.
- Client component: `components/coach/WeeklyReviewPage.tsx`. Renders 8 sections (§1–§8) from `payload` + `narrative_md`.
- New query key: `queryKeys.weeklyReviews.one(userId, weekStart)`.
- New fetchers (server + browser variants per CLAUDE.md):
  - `lib/query/fetchers/weeklyReview.ts` exports `fetchWeeklyReviewServer` + `fetchWeeklyReviewBrowser`.
- New hook: `lib/query/hooks/useWeeklyReview.ts`.
- Mutations (reconfirm, commit, regenerate) call route handlers and invalidate the relevant query keys.

### Surface 3 — Banner on `/coach`

- Existing `WeekPlanCard` evolves into `WeekReviewCard` (or sibling banner — implementation detail in plan). On any weekday, if a draft review exists for the most recent past Sunday and status is `draft`, surface: "Wk 3 review ready · 2 questions to confirm →" linking to the doc.
- Hides if `status='committed'` and the target week has started. Resurfaces if a new draft generates (e.g. user regenerates mid-week).
- Resolves the "Wed–Sat dead zone" gap that triggered this brainstorm (`PlanWeekCTA` only showed Sun/Mon/Tue, leaving no entry point to the planning artifact for half the week).

## Action chip wiring (§8)

Each chip on the page maps to an existing or new tool. All commit-style mutations use the HMAC pattern from [lib/coach/tools.ts](../../../lib/coach/tools.ts) (`COACH_TOOL_SECRET`).

| Chip | Action | Implementation |
|---|---|---|
| **Commit plan ✓** | UPSERT `training_weeks` for `next_week_start` from `payload.prescription`. Sets review `status='committed'`. | New endpoint `POST /api/coach/weekly-review/[id]/commit` + new tool `commit_weekly_plan` exposed to chat. HMAC-gated. |
| **Swap a day** | Opens existing [DaySwapSheet](../../../components/strength/DaySwapSheet.tsx) parameterized by `next_week_start`. Soft warning: swap on a not-yet-committed week is rare; sheet allows it but tags the review as "modified post-prescription". | Reuse component; new prop `previewMode={true}` if review not yet committed (writes to draft `session_plan` in payload, not to `training_weeks`). |
| **Adjust deficit** | Bottom sheet with ±100 / ±200 kcal buttons. Applies delta to `payload.targets.nutrition.kcal` and recomputes carbs/fat (protein floor preserved per GLP-1-aware rules from [lib/coach/plan-builder/compose-nutrition.ts](../../../lib/coach/plan-builder/compose-nutrition.ts)). Triggers narrative-only re-narrate. | New tool `propose_nutrition_adjustment(review_id, kcal_delta)`. New sheet component `components/coach/AdjustDeficitSheet.tsx`. |
| **Regenerate review** | Calls `POST /api/coach/weekly-review/[id]/regenerate`. New version, supersedes draft. | Endpoint above. |
| **Discuss in chat** | Navigates to `/coach?mode=default&ctx=weekly_review:[week_start]`. Composer pre-fills with context tag (no prefilled message text). Chat AI sees the review payload in the prompt prefix via existing snapshot mechanism. | URL-state only. AI prompt prefix already supports context tags; extend [lib/coach/profile-renderer.ts](../../../lib/coach/profile-renderer.ts) snapshot prefix to inject the active draft review when `ctx=weekly_review:*` is present. |

## Edge cases

- **First week of a block.** No prior week exists in this meso. Recap section renders "Block start — no prior week to recap" placeholder. Prescription uses `block_start_baseline` rationale and intake-derived loads (existing `intake_payload.strength.starting_loads` if present, else fall back to `WEEKLY_SESSIONS` defaults).
- **No active block.** `BlockProgressCard` already surfaces the "set up a block" CTA. The cron endpoint exits early without writing a review when no active block exists (logs but does not error).
- **Missed Sunday cron.** Monday 04:00 UTC catch-up creates the review with a `late=true` flag on `payload.header`. The chat card includes "Late: drafted Monday" in the one-line summary.
- **User regenerates after committing.** Creates a new `draft` row at `version=N+1` alongside the existing `committed` row. The committed `training_weeks` row stays untouched until the user commits the new draft. UI surfaces both: "Current plan: committed Wk 3 → Wk 4 (May 10)" and "New draft (May 12): regenerated".
- **Reconfirm answered then user regenerates.** New version has empty `reconfirm_responses`. The composer re-computes discrepancies from scratch — some prior-resolved discrepancies may persist if conditions still hold (e.g. bench still flat). The prior version's responses remain on the prior row for audit.
- **Week 5 deload review.** Renders normally. §5 prescription is the deload week itself. After deload, the next-week prescription would be the next block's Week 1, but block transitions go through `setup_block` mode — so §5 in a Week 5 review reads "Deload week — entering setup_block flow next Sunday" and the Commit chip is replaced with "Set up next block →".
- **GLP-1 active.** Targets composer reads `plan_payload.nutrition` (GLP-1-mode-aware per existing [lib/coach/plan-builder/compose-nutrition.ts](../../../lib/coach/plan-builder/compose-nutrition.ts)). No special-casing needed in this spec — abstraction already in place.
- **Block goal already hit mid-block.** `header.on_pace` reads true; narrative AI is instructed (in the prompt) to acknowledge but continue with the prescribed phase progression. Block-goal revision is out of scope (user enters `setup_block` to revise).
- **Schedule changed mid-week (swap).** Recap reads from `coalesce(training_weeks.original_session_plan, session_plan)` per migration 0012 invariant. Adherence reflects intent, not realized schedule (matches existing pattern from PR #51).
- **No data for a metric (e.g. weight not measured all week).** Composer outputs `null` for missing fields. Renderer hides null rows. Narrative prompt is instructed to not invent data.

## Out-of-scope follow-ups

These appear in the section list but explicitly do NOT ship here:

- **Mon kickoff brief that explains the week** — sub-project #2.
- **Tue–Sat morning brief Advice block referencing this week's prescription** — sub-project #2.
- **Push notification when review is ready** — sub-project #4.
- **`/coach/trends` deep page** — sub-project #5. §4 of the review surfaces signal-level only.
- **Composer suggestion chips above the chat composer** ("Ask about: yesterday's session / this week's load / sleep trend") — sub-project #3.
- **Inline-editable narrative** — defer. Regenerate is the only way to alter §6.
- **Cross-block historical view** — defer to sub-project #5.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Per-lift rules over-prescribe early (Week 1 MEV → Week 2 +3% feels aggressive for accessories) | Rules apply to big-four only; accessories progress on reps via existing `intensity_modifier`. |
| Sonnet 4.6 §6 prose drifts into prescription (AI invents loads) | Prompt explicitly tells AI: payload is authoritative; do not invent numbers; reference loads by exact value from payload. Prompt-level constraint, plus post-call validation: regex-extract all numbers in `narrative_md`, verify each appears in payload. Fail-fast if mismatch — narrative regenerates once, then errors out. |
| Reconfirm chip answers not persisted on tap (network blip) | Optimistic update + retry with exponential backoff. Chip shows "saving..." then "saved ✓". If retries fail, persist locally to `useState` and surface inline error. |
| Sunday cron runs while user is mid-conversation in `plan_week` mode | Cron checks for an open `plan_week` chat session via a recent `chat_messages` query — if any in last 30 min, skips Sunday run and defers to Monday catch-up. Avoids two concurrent plans-for-next-week flows. |
| Migration 0014 conflicts with concurrent feature work | Reserve number 0014 in this spec. If another spec lands first, renumber in plan stage. |
| Block-transition Week 5 confuses the Commit chip | Commit chip swaps to "Set up next block →" linking to `?mode=setup_block` when current phase = `deload`. |
| Athlete commits, then regrets and wants to revert | Out of scope for v1. Acceptable — the committed `training_weeks` row can be edited mid-week via DaySwapSheet for individual swaps; full revert is a deliberate manual op via SQL or a future feature. |
| AI call cost over time | ~$0.005 per weekly review × 52 weeks = $0.26/yr. Regenerate adds ~$0.004 per call. Negligible. Reconfirm narrative-only re-render is $0.004 — also negligible. |

## Verification

- **Typecheck**: `npm run typecheck` clean after each PR.
- **Manual exercise** on the dev server with seeded data: trigger sync endpoint manually with `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/weekly-review/sync`, verify row created, chat card rendered, page accessible.
- **Idempotency**: Re-run sync endpoint twice — second call returns existing row, no duplicate.
- **Regenerate**: Tap regenerate, verify `version` increments, prior draft transitions to `superseded`.
- **Commit**: Tap commit, verify `training_weeks` row written, `weekly_reviews.status='committed'`, `committed_training_week_id` populated.
- **Reconfirm**: Tap chip, verify `reconfirm_responses[id]` populated, §6 narrative reflects the answer on next render.
- **Edge cases**: Manual test of each scenario in the "Edge cases" section using seeded data for a prior block.
- **Number-formatting compliance**: All numeric displays go through [`fmtNum`](../../../lib/ui/score.ts) per CLAUDE.md convention.

## Open questions deferred to plan stage

1. Exact wording of the §6 narrative system prompt — iterate during implementation with real composer outputs.
2. Whether the banner-on-`/coach` is a new component or an evolution of `WeekPlanCard` — implementation choice.
3. Whether `compose-recap.ts` reads `workouts` directly or via a higher-level `getLastWeekSessions(week_start)` helper — small refactor question for the plan.
4. Exact set of reconfirm rules in `compose-reconfirm.ts` beyond the 4 named here (flat e1RM, protein gap, skipped session, RIR missed) — likely 2–4 more emerge during build.
5. Whether reconfirm chip answers feed back into next week's prescription deterministically (e.g. "Drop Sat" → next-week session_plan omits Saturday) — likely yes for a subset of chips; specific mapping table belongs in the plan, not the spec.
6. **OHP (and other coarse-increment exercises) and the ±4% cap.** Current spec force-holds via `_increment_capped` when the smallest physical jump exceeds 4%. Alternative: allow the jump but surface a reconfirm chip ("OHP would jump 16% next week — confirm?"). The clean rule is probably: after ≥3 weeks of rep-clearance at the same load on a coarse-increment lift, *override* the 4% cap and prescribe the full `step` jump; treat the rep-clearance streak as the safety check. Plan stage settles this with real data from the user's lift history.
