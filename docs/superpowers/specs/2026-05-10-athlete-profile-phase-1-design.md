# Athlete Profile — Phase 1 Design

**Date:** 2026-05-10
**Status:** Approved (implementation plan queued behind health-tab PR merge)
**Owner:** single-user app, Abdelouahed
**Phase:** 1 of 3 — see "Phased decomposition" below

## Problem

The coach AI in this app currently has **no durable client file**. Every conversation starts from raw daily metrics — WHOOP recovery, Withings body comp, Strong workouts, Yazio nutrition — but the AI doesn't know:

- Whether the athlete has a cardiac history, joint surgery, or active injury affecting programming
- What equipment is available, what days the athlete can train, what session length is realistic
- The athlete's stated goal *with the "why"* — not just `profiles.goal` (a single free-text field), but the narrative behind it
- Coaching preferences (directness, cadence, what unprompted actions are welcomed)

The closest current artifact is `profiles.goal` (one free-text string) and `profiles.system_prompt` (style guidance only). There is no "I formally acknowledge this is who I am and what I'm working toward" moment, and no place for the AI to read durable athlete context.

The result: every coach turn is data-rich but context-poor. The AI can recite yesterday's HRV but cannot reason about whether overhead pressing is even appropriate for this athlete.

This spec covers **Phase 1**: a structured intake form that produces an immutable, versioned **Athlete Profile document**, acknowledged by the user, surfaced in `/profile`, and consumed by the coach AI via the cached snapshot prefix. Phase 1 captures *facts and goal narrative* — no AI plan generation, no chat-mode intake, no drift detection. Those land in Phases 2 and 3.

## Goals

1. **Capture a durable Athlete Profile** — medical/health context, training history & equipment, lifestyle & schedule, nutrition baseline, sleep & recovery baseline, and goal-with-narrative — through a 6-step form wizard at `/onboarding`.
2. **Pre-fill aggressively from existing data.** The form is mostly *review and confirm what we already know* (latest weight, current e1RMs, WHOOP averages, Yazio macros, profile identity). Only the gaps the app cannot infer (medical, equipment, lifestyle, free-text goal narrative) require typing from scratch.
3. **Versioned, immutable acknowledgment ceremony.** Each acknowledged profile is frozen markdown with a version number, stored alongside the typed `intake_payload`. Edits create a new version that supersedes the previous; old versions remain viewable in `/profile` as history. The acknowledgment is the contract — once signed, byte-stable forever.
4. **Inline edit-before-acknowledgment escape hatch.** The rendered draft markdown is editable as plain text before the user clicks Acknowledge. Belt-and-suspenders for cases where the auto-rendered text needs a touch-up the form can't express.
5. **Coach AI consumes the profile via the snapshot prefix.** A condensed athlete-profile section is injected into the cached snapshot (alongside WHOOP baselines, training plan, recent logs). The AI naturally references medical context, equipment, goal-with-why in default-mode replies without being explicitly told.
6. **Forward-compatible schema.** The `athlete_profile_documents` table includes `plan_payload` and `rendered_md` columns from Phase 1, both nullable in Phase 1 and populated in Phase 2 when AI plan generation lands. No ALTER required between phases.

## Non-Goals (Phase 1)

These are deliberately deferred to Phases 2 and 3. They are out of scope for the implementation plan that follows this spec.

### Deferred to Phase 2 (AI plan generation)

- **AI-generated coaching plan.** No `propose_plan` / `commit_plan` tools, no plan-builder, no plan-renderer for prescriptions. Phase 1 captures inputs and the athlete profile *facts*; Phase 2 layers the AI-produced periodization, nutrition prescription, sleep prescription, and recovery prescription on top.
- **`intake` chat mode.** No new value on `chat_messages.mode`. No `INTAKE_PROMPT`. No chat-elicited slots (`goal_narrative`, `coaching_preferences.directness`, etc.). In Phase 1, the equivalent context is captured via free-text fields on the form (e.g., the Goals step has a "Why this goal?" textarea).
- **Per-slot intake tools.** `set_goal_narrative`, `set_directness`, `set_cadence` etc. are Phase 2 surface.
- **Plan-builder (deterministic plan skeleton).** A pure `buildDraftPlan(intake, snapshot)` function that produces a plan_payload from intake + existing data, then the AI reviews/adjusts. Phase 2.
- **PlanCard chat UI.** Approve button, rendered plan card in chat, mode auto-flip on commit. Phase 2.
- **Revision-flow chat-field clearing.** When Phase 2 adds chat-elicited fields, revision drafts must clear those slots (force re-elicit) while carrying form-elicited fields forward. Phase 1 has no chat-elicited fields, so nothing to clear; design constraint is documented here for Phase 2.

### Deferred to Phase 3 (drift detection & stale nudges)

- **Drift detection paragraph in `DEFAULT_SYSTEM_PROMPT`.** The AI noticing "active plan says recomp at 2,650 kcal but last 14d Yazio avg is 2,000 kcal" and offering revision in chat.
- **Stale-doc pre-flight in `SETUP_BLOCK_PROMPT`.** The "your plan is from [date], want to refresh first?" beat.
- **`/profile` stale-doc amber badge** at 12 weeks since `acknowledged_at`.
- **`training_blocks.athlete_profile_doc_id` FK.** Correlating blocks to the active plan version. Useful for retrospection ("which plan was active during this block?"), but only meaningful once Phase 2's plan-generation lands.

### Out of scope entirely

- **Multi-user generalization.** Single-user app. Schema and RLS are per-user but no multi-tenancy effort.
- **PAR-Q+ red-flag gating / clinical refusal-to-coach.** Health screen is informational only. The AI uses medical context but never refuses to coach. Documented in spec at Q5 of brainstorming; rationale: liability theater for a single-user personal app.
- **Auto-discard cron for abandoned drafts.** Drafts persist indefinitely until manually discarded. A 30-day TTL cron is a follow-up if needed.
- **Encryption-at-rest beyond Supabase defaults.** RLS + Supabase managed encryption is sufficient for a single-user app with personal medical context.

## Phased decomposition

The full Athlete Profile + Coaching Plan feature was scoped as one design but decomposed into three sequential ship-able phases to manage scope risk and enable real-world iteration.

| Phase | Surface | Ship goal |
|---|---|---|
| **1 (this spec)** | Form wizard, table, profile rendering, snapshot integration | Capture durable athlete facts. AI gets context. Test for 2-3 days. |
| **2** | Chat intake mode, AI plan generation, plan-builder, PlanCard UI, prescription sections | Produce signed coaching plans (sleep + nutrition + strength prescriptions) from the captured intake. |
| **3** | Drift detection, stale nudges, block-end pre-flight, FK correlation | Watchdog layer. Plan stays honest as reality drifts. |

Phase 1 is the foundation. Phases 2 and 3 are written in their own future specs once Phase 1 has been lived with.

## Architecture overview

```
┌─ /onboarding (new route) ─────────────────────────────────────┐
│                                                                │
│   6-step form wizard (client component, useState navigation):  │
│   1. Health & medical                                          │
│   2. Training history & equipment                              │
│   3. Lifestyle & schedule                                      │
│   4. Nutrition baseline                                        │
│   5. Sleep & recovery baseline                                 │
│   6. Goals (with "why" textarea)                               │
│                                                                │
│   Pre-fill from: profiles, daily_logs (last 30d), workouts     │
│                                                                │
│   ↓ submit creates draft row                                   │
│                                                                │
│   Review & Acknowledge step:                                   │
│   - renderProfileMarkdown(intake) → rendered_md (frozen)       │
│   - Inline "Edit draft" textarea (markdown editing)            │
│   - "Acknowledge" button → server action → status='active'     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌─ athlete_profile_documents (new table) ───────────────────────┐
│                                                                │
│   id, user_id, version, status, intake_payload, plan_payload, │
│   rendered_md, acknowledged_at, superseded_at, superseded_by  │
│                                                                │
│   - One active per user (partial unique index)                 │
│   - One draft per user (partial unique index)                  │
│   - plan_payload nullable (Phase 2 fills it)                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────┴─────────────────────┐
        ↓                                           ↓
┌─ /profile panel ──────────┐    ┌─ Coach snapshot prefix ─────┐
│                           │    │                              │
│   - Active card           │    │   ## Athlete profile (v1)    │
│   - View / Revise / Hist. │    │   Identity, equipment,       │
│   - History accordion     │    │   medical, goals,            │
│   - Markdown rendered     │    │   training context           │
│   from rendered_md        │    │                              │
│                           │    │   ~250 tokens, cached ~14d   │
└───────────────────────────┘    └──────────────────────────────┘
```

**Three principles guide the architecture:**

1. **Determinism over AI magic in Phase 1.** Form → typed `intake_payload` → deterministic markdown rendering → user reviews → user signs. No AI in the rendering path. Predictable, testable, no failure modes from model variance.
2. **Forward-compatible schema.** All Phase 2 columns exist as nullable from day 1. No ALTER between phases.
3. **Snapshot-prefix integration.** AI consumption uses the cached prefix (~14d TTL), not per-turn injection. The profile rarely changes; cache hit rate stays high.

## Schema

### `athlete_profile_documents` (new)

```sql
create table public.athlete_profile_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  version         int not null,                    -- 1, 2, 3 ... user-scoped
  status          text not null default 'draft'
    check (status in ('draft', 'active', 'superseded', 'discarded')),
  intake_payload  jsonb not null,                  -- typed form output (see schema below)
  plan_payload    jsonb,                           -- NULL in Phase 1; populated in Phase 2
  rendered_md     text,                            -- frozen profile markdown at ack time
  acknowledged_at timestamptz,                     -- NULL while draft; set on ack
  superseded_at   timestamptz,                     -- NULL until next version supersedes
  superseded_by   uuid references public.athlete_profile_documents on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check ((status = 'draft') = (acknowledged_at is null)),
  check ((status = 'superseded') = (superseded_at is not null)),
  unique (user_id, version)
);

-- At most one active per user
create unique index athlete_profile_documents_one_active_per_user
  on public.athlete_profile_documents (user_id) where status = 'active';

-- At most one draft per user
create unique index athlete_profile_documents_one_draft_per_user
  on public.athlete_profile_documents (user_id) where status = 'draft';

-- Common reads: history list ordered by version desc
create index athlete_profile_documents_user_status_version_idx
  on public.athlete_profile_documents (user_id, status, version desc);

alter table public.athlete_profile_documents enable row level security;

drop policy if exists "athlete_profile_documents self" on public.athlete_profile_documents;
create policy "athlete_profile_documents self"
  on public.athlete_profile_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on column public.athlete_profile_documents.plan_payload is
  'NULL in Phase 1 (intake-only). Phase 2 populates with structured plan from AI generation.';
comment on column public.athlete_profile_documents.rendered_md is
  'Frozen markdown rendered from intake_payload at acknowledgment time (Phase 1) or from intake+plan in Phase 2. Byte-stable for the lifetime of the version.';
comment on column public.athlete_profile_documents.status is
  'Lifecycle: draft (in progress) → active (acknowledged) → superseded (replaced by newer version) | discarded (manually abandoned).';
```

### `intake_payload` jsonb shape (Phase 1)

Typed in `lib/data/types.ts`. Phase 2 will add `goal_narrative_chat`, `coaching_preferences`, and `free_form_constraints` slots populated by the chat mode; those keys are reserved-absent in Phase 1.

```ts
export type IntakePayload = {
  schema_version: 1;
  health: {
    conditions: {
      cardiac: boolean;
      hypertension: boolean;
      diabetes: 'none' | 'type1' | 'type2' | 'prediabetic';
      autoimmune: boolean;
      joint_surgeries: Array<{ joint: string; year: number; notes?: string }>;
      other: string;
    };
    medications: string;                          // free-text, training-relevant
    recent_illness_injury: string;                // free-text, last 12 months
    active_injuries: Array<{ joint: string; restriction: string }>;
    allergies: string;                            // training-relevant only
  };
  training: {
    years_lifting: number;
    training_age: 'beginner' | 'intermediate' | 'advanced';
    sessions_per_week: number;
    typical_session_minutes: number;
    equipment: {
      barbell: boolean; rack: boolean; bench: boolean; dumbbells: boolean;
      cables: boolean; machines: boolean; platform: boolean; ghd: boolean;
      sled: boolean; treadmill: boolean; rower: boolean; bike: boolean;
      kettlebells: boolean; bands: boolean; other: string;
    };
    current_e1rm: { squat: number | null; bench: number | null;
                    deadlift: number | null; ohp: number | null };
    best_ever_pr: { squat: number | null; bench: number | null;
                    deadlift: number | null; ohp: number | null };
    previous_programs: string;                    // free-text
    recent_plateaus: string;                      // free-text
  };
  lifestyle: {
    job_demands: 'sedentary' | 'mixed' | 'active' | 'labor';
    commute_minutes: number;
    has_dependents: boolean;
    dependent_notes: string;                      // free-text, optional
    stress_self_rating: 1 | 2 | 3 | 4 | 5;
    days_available: { mon: boolean; tue: boolean; wed: boolean; thu: boolean;
                      fri: boolean; sat: boolean; sun: boolean };
    earliest_session_time: string;                // "HH:mm"
    latest_session_time: string;                  // "HH:mm"
    travel_frequency: 'none' | 'rare' | 'monthly' | 'weekly';
  };
  nutrition: {
    current_phase: 'cut' | 'maintain' | 'lean_bulk' | 'recomp' | 'unsure';
    current_kcal: number;                         // pre-fill from Yazio 7d avg
    current_macros: { protein_g: number; carb_g: number; fat_g: number };
    tracking_experience: 'none' | 'on_off' | 'consistent';
    restrictions: string;                         // free-text, includes diet style + allergies
    alcohol_drinks_per_week: number;
    caffeine_mg_per_day: number;
    supplements: string;                          // free-text
  };
  sleep_recovery: {
    avg_sleep_hours: number;                      // pre-fill from WHOOP 30d avg
    typical_bedtime: string;                      // "HH:mm"
    typical_wake_time: string;                    // "HH:mm"
    sleep_latency_minutes: number;
    awakenings: 'none' | '1_2' | '3_plus';
    mobility_work: string;                        // free-text
    soreness_frequency: 'rare' | 'common' | 'always';
  };
  goals: {
    primary_type: 'strength' | 'body_comp' | 'performance' | 'health';
    primary_metric: string;                       // e.g., "deadlift e1RM" or "body fat %"
    target_value: number;
    target_unit: string;                          // "kg", "%", "min", etc.
    target_date: string;                          // "YYYY-MM-DD"
    why_narrative: string;                        // free-text — Phase 1's substitute for chat
  };
  // Reserved-absent in Phase 1; Phase 2 will add:
  // goal_narrative_chat?: string;                // chat-elicited expansion
  // coaching_preferences?: { directness, cadence, unprompted_actions };
  // free_form_constraints?: string;
};
```

### Migration: `supabase/migrations/0009_athlete_profile.sql`

Single migration. Apply via `supabase db push` (CLI is linked per CLAUDE.md). The full schema above lives in this single file.

**Migration-numbering note:** if the in-flight health-tab PR introduces a migration that claims `0009`, this spec's migration becomes `0010` and the file is renamed at implementation time. No design impact.

## Form wizard (6 steps)

The wizard lives at `/onboarding`. Server component handles auth gate + reads existing data for pre-fill; client component manages the wizard state.

### Step 1 — Health & medical (informational)

- **Conditions** (multi-checkbox + free-text "other"):
  - Cardiac (afib, arrhythmia, prior MI, etc.)
  - Hypertension
  - Diabetes (radio: none / type 1 / type 2 / prediabetic)
  - Autoimmune
  - Joint surgeries (repeating row: joint dropdown + year input + optional notes)
- **Active medications** (textarea — focus on training-relevant: beta-blockers, stimulants, GLP-1s, etc.)
- **Recent illness / injury (last 12 months)** (textarea)
- **Active injuries / movement restrictions** (repeating row: joint dropdown + restriction textarea — e.g., "left shoulder, no overhead pressing > 60kg")
- **Training-relevant allergies** (textarea)

No gates fire on any answer. Information stored, surfaced to AI, never blocks progression.

### Step 2 — Training history & equipment (heavy pre-fill)

- **Years lifting** (number)
- **Training-age category** (radio: beginner / intermediate / advanced) — auto-suggested from years + e1RMs but user-editable
- **Sessions per week** (number) — pre-filled from last 4 weeks of `workouts` count, /4
- **Typical session length** (minutes, number)
- **Equipment access** (multi-checkbox: barbell, rack, bench, dumbbells, cables, machines, platform, GHD, sled, treadmill, rower, bike, kettlebells, bands, "other" free-text)
- **Current e1RM per primary lift** (squat / bench / deadlift / OHP, kg, optional per lift) — pre-filled from latest top working-set e1RM via `useRecentE1RMs(userId)` hook
- **Best ever PRs** (same shape, optional, no pre-fill)
- **Previous programs run** (textarea — Sheiko, 5/3/1, RP, etc.)
- **Recent plateaus** (textarea)

### Step 3 — Lifestyle & schedule

- **Job demands** (radio: sedentary / mixed / active / labor)
- **Commute (minutes/day total)** (number)
- **Dependents** (boolean + optional notes textarea)
- **Average stress level** (1–5 self-rated, slider)
- **Days available to train** (Mon–Sun multi-checkbox)
- **Earliest possible session time** (time input, HH:mm)
- **Latest possible session time** (time input, HH:mm)
- **Travel frequency** (radio: none / rare / monthly / weekly)

### Step 4 — Nutrition baseline (pre-fill from Yazio)

- **Current diet phase** (radio: cut / maintain / lean bulk / recomp / unsure)
- **Current calorie target (kcal/day)** (number) — pre-filled from `daily_logs.calories_eaten` rolling 7d avg
- **Current macros** (protein g, carb g, fat g — three numbers) — pre-filled from rolling 7d avgs (`protein_g`, `carbs_g`, `fat_g`)
- **Tracking experience** (radio: none / on-and-off / consistent)
- **Dietary restrictions** (textarea — covers diet style + food allergies + intolerances + religious)
- **Alcohol (drinks per week)** (number)
- **Caffeine (mg per day estimate)** (number)
- **Supplements** (textarea)

### Step 5 — Sleep & recovery baseline (pre-fill from WHOOP)

- **Average sleep hours** (number) — pre-filled from `daily_logs.sleep_hours` rolling 30d avg
- **Typical bedtime** (time input HH:mm)
- **Typical wake time** (time input HH:mm)
- **Sleep latency (minutes)** (number)
- **Awakenings** (radio: none / 1-2 / 3+)
- **Mobility / flexibility work currently done** (textarea)
- **Soreness frequency** (radio: rare / common / always)

### Step 6 — Goals

- **Primary goal type** (radio: strength / body composition / performance / health)
- **Primary metric** (text — e.g., "deadlift e1RM", "body fat %", "5K time")
- **Target value** (number)
- **Target unit** (text — kg, %, min:sec, etc.)
- **Target date** (date picker, must be in the future)
- **Why this goal? What does success look like?** (textarea, required, ≥ 1 sentence)

In Phase 1, the `why_narrative` textarea is the entire substitute for Phase 2's chat-elicited goal narrative. The user types as much as they want.

### Review & Acknowledge step (post-submit)

After Step 6 submits:

1. Server action validates the typed payload (Zod schema in `lib/validation/intakePayload.ts`).
2. Server creates a draft row: `status='draft'`, `version = max(version) + 1` for user (or 1 if first), `intake_payload` populated, `plan_payload=null`, `rendered_md=null`.
3. Client redirects to a "Review" view that calls `renderProfileMarkdown(intake_payload, version, dates)` and displays the rendered markdown.
4. **Inline "Edit draft" toggle** swaps the rendered view for a `<textarea>` containing the markdown. User can edit freely. A "Reset to auto-rendered" button restores the deterministic render. Edits are local until acknowledgment.
5. **"Acknowledge profile" button** calls a server action that:
   - Writes the (possibly edited) markdown to `rendered_md`
   - Flips `status` to `active`, sets `acknowledged_at = now()`
   - If a previous `active` exists for this user: sets it to `superseded`, `superseded_at = now()`, `superseded_by = <new id>` (one transaction)
   - Calls `revalidatePath('/profile')` and `revalidatePath('/coach')`
6. Redirects to `/profile`, where the new active doc is now visible.

The acknowledgment is the contract. Once acknowledged, `rendered_md` is byte-frozen for the lifetime of the row.

## Pre-fill from existing data

Pre-fill happens server-side during the initial `/onboarding` page load. The wizard receives a `prefill` prop with all derivable values; user can override any field.

| Source | Fields filled | Hook / fetcher |
|---|---|---|
| `profiles` | `name` (display only), `age` (display only), `height_cm` (display only) | `useProfile(userId)` |
| `daily_logs` last 30d | `nutrition.current_kcal`, `nutrition.current_macros.*`, `sleep_recovery.avg_sleep_hours` | `useDailyLogs(userId, from, today)` (rolling 7d/30d windows aggregated client-side or in fetcher) |
| `workouts` last 8 weeks | `training.current_e1rm.*` (top working-set e1RM per primary lift) | `useRecentE1RMs(userId)` (new) |
| `workouts` last 4 weeks | `training.sessions_per_week` (count / 4) | derived in `useRecentE1RMs` or sibling fetcher |
| `profiles.whoop_baselines` | display-only HRV/RHR for context (not slotted) | `useProfile(userId).whoop_baselines` |

**Pre-fill philosophy:** the form is *review and confirm what we already know*, not type-from-scratch. Most fields show with values pre-populated and a small "↻ from latest data" badge to signal the source. Manual edits stick (the form's controlled state owns the value once user touches it).

**Revision pre-fill (re-running the wizard for v2+):** the wizard reads the prior version's `intake_payload` and applies it on top of the auto-derived pre-fill — i.e., for each field, the precedence is **prior version's stored value > auto-derived from data > empty**. Phase 2 will introduce the rule that *chat-elicited fields clear on revision*, but Phase 1 has none, so all fields carry forward.

## Profile renderer

`lib/coach/profile-renderer.ts` exports two pure functions. No AI in the rendering path; both are deterministic transformations.

```ts
// Used at acknowledgment time. Output is what the user signs.
export function renderProfileMarkdown(
  intake: IntakePayload,
  version: number,
  acknowledgedAt: string | null,
  supersedesVersion: number | null,
): string;

// Used to inject the athlete profile into the coach's snapshot prefix.
// ~200-300 tokens, condensed for AI consumption.
export function renderProfileSummary(intake: IntakePayload, version: number): string;
```

### `renderProfileMarkdown` output structure (Phase 1)

```markdown
# Athlete Profile — v{version}

*Acknowledged YYYY-MM-DD{, supersedes v{n-1}}*

## Athlete snapshot
{name}, {age}, {height_cm} cm. Trains {sessions_per_week}× per week,
typical session {typical_session_minutes} min. Equipment: {summary list}.
Job: {job_demands}, stress {stress_self_rating}/5{, dependents}.

## Goal
**{primary_type}**: {primary_metric} → {target_value}{target_unit} by {target_date}.

> {why_narrative}

## Health context
{conditions list, only if any present}
{medications, if any}
Active injuries / movement restrictions:
{per joint, if any}
{allergies, if any}

## Training history & equipment
{years_lifting} years lifting ({training_age}).
Current e1RMs: squat {x}, bench {x}, deadlift {x}, OHP {x}.
{Best PRs, if differs from current}
Previous programs: {previous_programs}
{Recent plateaus, if any}

## Lifestyle & schedule
Days available: {Mon–Sun list}.
Session window: {earliest}–{latest}.
Commute: {commute_minutes} min.
Travel: {travel_frequency}.

## Nutrition baseline
Current phase: {current_phase}.
Target: {current_kcal} kcal · {protein_g}P / {carb_g}C / {fat_g}F.
Tracking: {tracking_experience}.
{Restrictions, if any}
Alcohol: {alcohol_drinks_per_week}/wk · Caffeine: {caffeine_mg_per_day} mg/day.
{Supplements, if any}

## Sleep & recovery baseline
Average {avg_sleep_hours} hours, window {typical_bedtime}–{typical_wake_time}.
Latency {sleep_latency_minutes} min, awakenings {awakenings}.
Soreness frequency: {soreness_frequency}.
{Mobility work, if any}

---

*This profile is the foundation for upcoming coaching plans (v2+ adds AI-generated periodization, sleep, and nutrition prescriptions).*
```

The `{...}` substitutions are deterministic — no formatting variance, no AI in the loop. Empty optional sections are omitted entirely (e.g., the Allergies line doesn't render if the field is empty).

### `renderProfileSummary` output structure (~250 tokens)

```
## Athlete profile (v{version}, acknowledged {date})

Goal: {primary_type} — {primary_metric} {target_value}{target_unit} by {target_date}. Why: "{why_narrative trimmed to 1-2 sentences}".

Trains {sessions_per_week}×/wk ({days_available short form}, {earliest}-{latest} window). {training_age} lifter, {years_lifting}y. Current e1RMs: SQ{x} BP{x} DL{x} OHP{x}.

Equipment: {compact list, comma-separated}.

Health: {compact compact medical summary if any conditions/meds/injuries; "none" if all clean}.

Nutrition baseline: {current_phase}, {kcal} kcal target, {p/c/f}. Tracking {tracking_experience}.{ Alcohol {drinks/wk}/wk if > 0.}

Sleep baseline: {avg_sleep_hours}h, window {bed}-{wake}. {Soreness frequency.}

Job: {job_demands}, stress {stress_self_rating}/5.{ Travel: {travel_frequency} if not 'none'.}
```

This summary is what the coach AI reads on every turn (cached in the snapshot prefix). It's deliberately information-dense and short so it doesn't bloat the cache.

## Acknowledgment flow & state machine

### State values

`status ∈ { 'draft', 'active', 'superseded', 'discarded' }`

### Transitions

| From | To | Trigger |
|---|---|---|
| `(none)` | `draft` | Form wizard step 6 submits → server action creates row |
| `draft` | `active` | "Acknowledge profile" button → server action transaction |
| `active` | `superseded` | New version's acknowledgment (same transaction as `draft → active` on the new row) |
| `draft` | `discarded` | "Discard draft" button in `/profile` (when draft exists) |

### Constraint enforcement

- `(status = 'draft') = (acknowledged_at is null)` — check constraint
- `(status = 'superseded') = (superseded_at is not null)` — check constraint
- One `active` per user — partial unique index
- One `draft` per user — partial unique index (prevents two open drafts)
- `(user_id, version)` unique — version monotonic per user, enforced in code at insert

### Concurrency edge cases

- **Two open drafts attempted:** the partial unique index throws on insert. The server action catches the violation and surfaces "You have a draft in progress — resume or discard?" with appropriate links.
- **Acknowledge clicked twice fast:** the server action wraps the supersede+ack in one transaction. The second click finds no `draft` row to acknowledge and surfaces "Already acknowledged."
- **Stale browser state after another tab acknowledged:** TanStack Query invalidates `queryKeys.athleteProfile.all(userId)` after any mutation; the React Query cache catches up on next refetch. Worst case: user sees a brief stale UI for one tick.

## Revision flow

User in `/profile` clicks "Revise plan" on the active doc card. Flow:

1. Route to `/onboarding?revise=<active_id>`.
2. Server component reads the active doc's `intake_payload` and merges it with auto-derived pre-fill (prior stored value > auto-derived > empty per field).
3. Wizard renders pre-filled with the prior version's answers. A small "↻ updated from latest data" badge appears on fields where the auto-pre-fill differs from the prior version's stored value (e.g., body weight is now 79kg vs. prior 80kg; user can keep prior or accept update).
4. User edits fields they need to change.
5. Step 6 submit creates a new draft row: `status='draft'`, `version = prior_version + 1`, `intake_payload` populated.
6. Same Review & Acknowledge flow.
7. On Acknowledge: in one transaction, draft → active AND prior active → superseded (with `superseded_by` pointing at the new row).

A user can only have **one draft at a time**. If they have a draft from a previous unfinished session and click "Revise," they're routed to resume that draft instead of starting fresh. (UI: a banner offers "Resume your draft" or "Discard and start over".)

## AI integration

### Snapshot prefix (`lib/coach/snapshot.ts`)

When an active `athlete_profile_documents` row exists for the user, the snapshot prefix gains a new section:

```
## Athlete profile (v{n}, acknowledged {date})

{output of renderProfileSummary(intake, version)}
```

If no active doc exists, the section is omitted entirely. The cache TTL stays at ~14 days (existing); cache invalidates whenever a new doc is acknowledged (existing snapshot invalidation pattern handles this since acknowledgment writes a row).

### `SCHEMA_EXPLAINER` addition (`lib/coach/system-prompts.ts`)

One new paragraph documenting the new section, mirroring the format of existing snapshot-prefix documentation:

> **Athlete profile** — when present in the snapshot, this is durable context the user explicitly acknowledged: medical history, equipment, lifestyle, goal-with-why, nutrition/sleep baselines. Reference it directly when relevant ("given your shoulder restriction, skip OHP" / "your goal is deadlift e1RM 220 by August"). Don't recite it back at the user — they have it open in /profile. In Phase 2, this section will also include an AI-generated coaching plan with prescribed targets.

### `DEFAULT_SYSTEM_PROMPT` addition (`lib/coach/system-prompts.ts`)

One new paragraph appended to the existing default prompt:

> When an "Athlete profile" section exists in your context, treat it as durable context — the user's medical history, equipment, schedule, goal narrative, and baselines are stable across the conversation. Use this context naturally when advising. Don't repeat the profile contents back at the user; they have it open in /profile. If you notice the goal in the profile has clearly drifted from the user's current behavior (target says 220kg deadlift but they're chasing a 5K time), name the drift in one sentence and suggest revising the profile via the Revise button in /profile.

The drift-detection language is intentionally mild in Phase 1 — Phase 3 will expand this with explicit drift-detection rules tied to the AI plan's quantitative targets (kcal, sleep hours, primary lift focus). In Phase 1, drift-detection is best-effort only because the profile contains baselines, not prescribed targets.

## UI placement

### `/onboarding` (new route)

| File | Type | Purpose |
|---|---|---|
| `app/onboarding/page.tsx` | Server component | Auth gate + read pre-fill data + handle `?revise=<id>` query param |
| `app/onboarding/loading.tsx` | Loading skeleton | Tailwind/DM Sans skeleton matching existing `/profile` loading state |
| `app/onboarding/actions.ts` | Server actions | `createDraftProfile(intake)`, `updateDraftProfile(id, intake)`, `acknowledgeDraft(id, edited_md_or_null)`, `discardDraft(id)` |

### `/profile` (existing route, extended)

The new "Coaching plan" section sits between "Profile details" and "Connected sources" in `components/profile/ProfileClient.tsx`:

- **No active doc:** CTA card "Set up your athlete profile" with a brief explainer and a button linking to `/onboarding`.
- **Active doc:** card showing version, acknowledged date, primary goal one-liner, and three actions:
  - **View** — opens a modal showing the full `rendered_md` (markdown rendered with the existing app markdown components — confirm at implementation time that one exists; if not, use a thin wrapper around `react-markdown`)
  - **Revise** — navigates to `/onboarding?revise=<id>`
  - **History** — toggles a collapsible list of superseded versions, each clickable to view its frozen `rendered_md`
- **Existing draft (active or no):** banner "You have a draft in progress" with "Resume" and "Discard" buttons.

Section label uses the existing `SectionLabel` component pattern in `ProfileClient.tsx`. Card style matches the existing app's `Card` component.

### Snapshot prefix integration

`lib/coach/snapshot.ts` (existing — confirm exact filename at implementation time; CLAUDE.md references `lib/coach/snapshot.ts`) gains a new section appended to the prefix builder. No tools change. No mode change. The integration is purely additive.

## Files

### To create

```
supabase/migrations/0009_athlete_profile.sql

app/onboarding/page.tsx
app/onboarding/loading.tsx
app/onboarding/actions.ts

components/onboarding/OnboardingWizard.tsx
components/onboarding/steps/StepHealth.tsx
components/onboarding/steps/StepTraining.tsx
components/onboarding/steps/StepLifestyle.tsx
components/onboarding/steps/StepNutrition.tsx
components/onboarding/steps/StepSleep.tsx
components/onboarding/steps/StepGoals.tsx
components/onboarding/ReviewAndAcknowledge.tsx

components/profile/AthleteProfilePanel.tsx
components/profile/AthleteProfileHistory.tsx
components/profile/AthleteProfileViewModal.tsx

lib/coach/profile-renderer.ts
lib/validation/intakePayload.ts          (Zod schema)
lib/query/fetchers/athleteProfile.ts     (server + browser variants)
lib/query/hooks/useAthleteProfile.ts
lib/query/hooks/useAthleteProfileHistory.ts
lib/query/hooks/useRecentE1RMs.ts
```

### To modify

```
lib/data/types.ts                  (add IntakePayload, AthleteProfileDocument types)
lib/query/keys.ts                  (add athleteProfile keys)
lib/coach/snapshot.ts              (append athlete-profile section when active doc exists)
lib/coach/system-prompts.ts        (extend SCHEMA_EXPLAINER + DEFAULT_SYSTEM_PROMPT)
app/profile/page.tsx               (prefetch active doc + history)
components/profile/ProfileClient.tsx  (render AthleteProfilePanel)
```

### Untouched

- All ingest webhook routes (`app/api/ingest/*`)
- WHOOP / Withings sync paths
- Existing `lib/coach/planning-prompts.ts` (no chat-mode changes in Phase 1)
- Existing `lib/coach/tools.ts` (no new tools in Phase 1)
- All existing chat-related tables and routes
- `training_blocks` / `training_weeks` schemas

## Verification

Phase 1 has no test suite (per CLAUDE.md project conventions); verification is manual + typecheck.

### Build / type checks

- `npm run typecheck` clean (zero errors)
- `npm run build` succeeds

### Manual exercise checklist

1. **Cold start:** sign in to fresh app state with no `athlete_profile_documents` rows. `/profile` shows the "Set up your athlete profile" CTA card.
2. **Create v1:** click CTA → `/onboarding`. Verify pre-fill is populated for: name, age, height (from profiles), kcal/macros (from Yazio rolling 7d), avg sleep hours (from WHOOP rolling 30d), e1RMs per primary lift (from workouts last 8w), sessions/week (from workouts last 4w).
3. **Submit form:** complete all 6 steps. Verify draft row created (`select * from athlete_profile_documents` shows status='draft', version=1).
4. **Edit-before-ack:** on Review step, toggle "Edit draft," modify a sentence in the rendered markdown, click Acknowledge. Verify the modified markdown is what's frozen in `rendered_md` (not the auto-rendered version).
5. **Acknowledge:** verify status flips to 'active', `acknowledged_at` populated, redirect to `/profile`. The "Set up" CTA is replaced by the active-doc card.
6. **View:** click View → modal opens with frozen `rendered_md`.
7. **Coach reads profile:** open `/coach`, ask a default-mode question (e.g., "what should I do today?"). Verify the response naturally references medical context, goal, equipment, etc. without being told to.
8. **Revise → v2:** click Revise → wizard pre-fills with v1's `intake_payload`, refreshed for any data that's changed since (e.g., latest weight). Change one field, complete wizard, acknowledge.
9. **Verify supersede:** `select * from athlete_profile_documents where user_id = '<id>' order by version` shows v1 with status='superseded', superseded_at populated, superseded_by pointing at v2's id; v2 is status='active'.
10. **History panel:** in `/profile`, click History → shows v1 in the list. Click v1 → modal renders v1's frozen `rendered_md`.
11. **Discard flow:** start a third revision, abandon mid-wizard, return to `/profile`. Banner shows "You have a draft in progress." Click Discard. Banner disappears, `select * where status='draft'` returns no rows.

### Schema validation

- Migration is idempotent (rerun via `supabase db push` produces no errors).
- Partial unique indexes work: `insert ... status='active'` twice for same user → unique violation. Same for `status='draft'`.
- RLS: query as user A returns user A's docs only; query as user B can't see them.

### Coach context spot-check

- Inspect a fresh `/coach` request's system prompt (via debug logging or transient console output during testing). Verify the snapshot prefix contains the `## Athlete profile (v{n}, acknowledged {date})` section.
- Verify the section is omitted when no active doc exists.
- Verify cache invalidation: after acknowledging v2, the next coach turn reflects v2's content (not v1's).

### Two-day soak test (per phasing decision)

- Live with Phase 1 for 2-3 days. Note any friction points, missing fields, awkward pre-fills.
- Capture findings as input to Phase 2 spec (chat-mode intake refines what the form alone can't capture).

---

## Implementation handoff

Once this spec is approved by the user and the in-flight health-tab PR has merged, run `writing-plans` with this spec as input to produce the implementation plan. Re-scan the spec at that time for collisions introduced by the health tab (migration number, profile-shell layout, query-hooks duplication).

The implementation plan will sequence the work into discrete tasks: schema/migration → types/Zod → fetchers/hooks → renderer → onboarding wizard → profile panel → snapshot integration → manual verification.
