# Morning Brief — Design

**Date:** 2026-05-11
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** First half of the "consume the coaching plan" pair. The second half — Phase 2 (AI plan generation) — is deferred to a future spec after a 2-3 day soak of this feature.

## Problem

The morning intake bot ([lib/morning/script.ts](../../../lib/morning/script.ts), migration [0007_morning_intake.sql](../../../supabase/migrations/0007_morning_intake.sql)) captures structured signal from the athlete every morning — readiness, energy, mood, soreness, fatigue, bloating, sickness — and ends in a terminal `delivered` state. But nothing happens after `delivered`. The user closes the chat with their feel signals captured and no actionable output for the day.

A real coach reviewing this data would do something specific: catch up on yesterday, read today's readiness, lay out the day's plan with weights and reps, prescribe macros, and tell the athlete what to eat and when. None of that happens today, even though the data to produce all of it is already in the database:

- **Today's session** — from [training_weeks.session_plan](../../../supabase/migrations/0008_weekly_planning.sql) (or fallback `WEEKLY_SESSIONS` in [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts))
- **Exercise prescriptions** — from `SESSION_PLANS[type]` with `intensity_modifier` × `current e1RM` scaling already implemented for [TodayPlanCard](../../../components/strength/TodayPlanCard.tsx)
- **Macros** — from [athlete_profile_documents.intake_payload.nutrition](../../../docs/superpowers/specs/2026-05-10-athlete-profile-phase-1-design.md)
- **Yesterday's recap** — `daily_logs[yesterday]` + `workouts[yesterday]`
- **Readiness** — `checkins[today]` (just captured) + `daily_logs[today]` (HRV)

This spec covers the **Morning Brief** feature: at the end of every morning intake, the bot writes a single structured chat card containing yesterday's recap, today's readiness analysis, today's session details, macro targets, AI-generated eating-and-advice prose, and tonight's sleep target. The card renders inline in the chat as the final turn of the morning ritual.

## Goals

1. **Close the morning intake loop.** After the intake captures feel signals, immediately surface a structured "today's brief" card as the next chat turn — no user tap to fetch, no separate route.
2. **Coach-voiced, data-anchored.** Deterministic rendering for structured data (session list, macros, recap stats); AI-generated prose only for the "Advice" block (readiness interpretation + eating timing + adaptive coaching cues).
3. **Single AI call per brief.** Anthropic Haiku 4.5, ~300 input + ~250 output tokens, ~2s latency, ~$0.0005 per morning. No tool use, no multi-turn.
4. **Adaptive coaching via pre-computed flags.** Five day-1 flags (`has_glp1`, `alcohol_low_readiness_warning`, `has_active_injuries`, `poor_sleep_efficiency`, `missed_protein_yesterday`) computed deterministically in the assembler and passed into the AI prompt as named booleans. Logic lives in versioned TS code, not in a prompt string.
5. **REST day variant.** Brief renders every day, including rest days. Rest variant replaces the exercise list with a recovery-focus block (mobility / steps / sleep priority); macros, advice, and tonight blocks still apply.
6. **Strict 1-per-day.** Idempotent. The brief is delivered exactly once per user per day, gated by `checkins.intake_state` transitions. No manual regenerate in v1.
7. **Forward-compatible with Phase 2.** All references to "current targets" (macros, sleep target) go through `lib/morning/brief/get-today-targets.ts` — Phase 1 reads `intake_payload.nutrition`; Phase 2 will swap to `plan_payload.nutrition` without touching the brief renderer.
8. **Graceful failure with explicit retry.** If the AI call fails, the brief is NOT written. State transitions to `brief_failed` and the morning bot's UI layer surfaces a retry chip. User taps → re-run pipeline. No partial brief written, no silent degradation.

## Non-Goals

- **Manual brief regeneration.** Once `brief_delivered`, the brief is final for the day. No "give me a different version" affordance.
- **Conversational continuation after the brief.** The brief is one-shot output. Follow-up questions go to `/coach` (regular chat, different mode), not back into the morning intake bot.
- **Concrete plan modifications based on readiness.** Readiness *shapes the tone* of the advice but never auto-modifies the prescribed weights. Matches existing autoregulation convention from weekly planning v1 ("The user decides — never auto-applied").
- **Yesterday recap depth beyond 4 stats.** The recap shows sleep / kcal-actual-vs-target / protein-actual-vs-target / training-type-with-top-e1rm. No HRV trend, no body-weight movement, no per-exercise breakdown. Defer to soak findings.
- **Full meal plan structure.** Advice block prescribes pre-workout + post-workout windows (training days) or 4-meal protein distribution (rest days). Not breakfast/snack/lunch/snack/dinner.
- **Hydration tracking.** Brief mentions hydration as a one-liner; no input field, no tracking. Defer.
- **Athlete profile schema changes.** The brief is read-only against the existing `athlete_profile_documents` shape from Phase 1.
- **Multi-user generalization.** Single-user app.

## Phasing relation

This feature is the consumer half of the "produce the plan + consume the plan" pair:

| Phase | What it does | Status |
|---|---|---|
| Athlete Profile Phase 1 (shipped 2026-05-10) | Captures durable athlete facts via 6-step onboarding wizard; intake_payload as source of truth for current macros / sleep / equipment / medical / goal | ✅ Live in production |
| **Morning Brief (this spec)** | Daily structured card at end of intake reading intake_payload + workouts + training_weeks + checkins | 📝 Designing |
| Athlete Profile Phase 2 | AI plan generation: chat intake mode, propose_plan / commit_plan, plan-builder, prescribed targets | ⏸ Deferred to post-soak |
| Athlete Profile Phase 3 | Drift detection, stale nudges, training_blocks FK correlation | ⏸ Deferred |

The Morning Brief consumes Phase 1 directly. When Phase 2 lands, the `get-today-targets.ts` abstraction swaps its source from `intake_payload.nutrition` to `plan_payload.nutrition` — ~30 lines of refactor, no other brief code changes.

## Architecture overview

Pipelined within the existing morning intake request flow. When the bot writes the final intake answer (bloating), the same request continues:

```
                   User taps last intake chip (bloating answer)
                                     │
                                     ▼
                   Write bloating answer to checkins
                                     │
                                     ▼
                   Transition intake_state: awaiting_whoop → delivered
                                     │
                                     ▼
              Check: brief already delivered today?
              ├─ yes (state='brief_delivered') → return existing brief, done
              └─ no → continue pipeline
                                     │
                                     ▼
                   Transition: delivered → assembling_brief
                                     │
                  ┌──────────────────┴──────────────────┐
                  ▼                                     ▼
            Parallel data fetch                    Parallel data fetch
            ───────────────────                    ───────────────────
            training_weeks active                  daily_logs[yesterday]
            SESSION_PLANS[type]                    workouts[yesterday]
            athlete_profile_documents              checkins[today]
            current e1RMs from intake              daily_logs[today]
                  │                                     │
                  └──────────────────┬──────────────────┘
                                     │
                                     ▼
                   Deterministic assembly (lib/morning/brief/assembler.ts)
                   - Compute session list with scaled weights
                   - Compute macros target + yesterday actual
                   - Compose recap stats
                   - Pick variant: training | rest
                   - Compute AdviceFlags
                                     │
                                     ▼
                   AI advice call (lib/morning/brief/advice-prompt.ts)
                   - Haiku 4.5, single completion, 350 max tokens
                   - Input: athlete context + data block + flags
                   - Output: advice_md (2-4 sentence prose)
                                     │
                       ┌─────────────┴─────────────┐
                       ▼                           ▼
                   AI succeeded               AI failed
                       │                           │
                       ▼                           ▼
              Compose final              Transition state:
              MorningBriefCard           assembling_brief → brief_failed
                       │                           │
                       ▼                           ▼
              Write chat_messages         Return failure to client
              (kind='morning_brief',     (client UI surfaces retry chip)
              ui.brief_card payload)
                       │
                       ▼
              Transition state:
              assembling_brief → brief_delivered
                       │
                       ▼
              Return success to client
              (brief + final intake message rendered)
```

Three principles guide the design:

1. **Deterministic data, AI narrative.** Structured data (session, macros, recap, readiness, tonight) renders from templates and computed values. AI generates only the `advice_md` prose block (2-4 sentences).
2. **One AI call per brief.** Not multi-turn, not tool-driven. ~$0.0005 per morning, ~2s latency.
3. **Forward-compat via abstraction.** `get-today-targets.ts` insulates the brief from where macros come from. Phase 1 → `intake_payload`. Phase 2 → `plan_payload`. Brief consumer doesn't know.

## Schema

### Migration `0011_morning_brief.sql` (new file)

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

No new tables, no new columns. The brief itself lives entirely inside `chat_messages.ui` jsonb.

### TypeScript types (added to `lib/data/types.ts`)

```ts
// ── Morning brief (extends 0007_morning_intake) ──────────────────────────────

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
  sleep_hours: number | null;            // from daily_logs[yesterday].sleep_hours
  kcal_actual: number | null;            // from daily_logs[yesterday].calories_eaten
  kcal_target: number;                   // from intake_payload.nutrition.current_kcal
  protein_actual_g: number | null;       // from daily_logs[yesterday].protein_g
  protein_target_g: number;              // from intake_payload.nutrition.current_macros.protein_g
  trained_yesterday: string | null;      // "Legs" | "REST" | null if no data
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
  sleep_target_hours: number;                 // from intake_payload.sleep_recovery.avg_sleep_hours
  bedtime_target: string;                     // "HH:mm" from intake_payload.sleep_recovery.typical_bedtime
};

export type MorningBriefCard = {
  variant: MorningBriefVariant;
  readiness: MorningBriefReadiness;
  recap: MorningBriefRecap;
  session: {
    type: string;                             // "Legs" | "Chest" | "Back" | "Mobility" | "REST"
    start_time: string | null;                // "13:00" for training days; null for rest
    exercises: MorningBriefExercise[];        // empty array for rest days
  };
  macros: MorningBriefMacros;
  advice_md: string;                          // AI-generated, 2-4 sentences markdown
  tonight: MorningBriefTonight;
};

/** Computed deterministically by lib/morning/brief/flags.ts. Passed to the
 *  AI prompt as named booleans so coaching logic stays in versioned TS code,
 *  not in a prompt string. Each flag is one threshold check or regex match. */
export type AdviceFlags = {
  has_glp1: boolean;                          // medications matches GLP-1 / brand-name regex
  alcohol_low_readiness_warning: boolean;     // alcohol_drinks_per_week > 0 AND band === 'low'
  has_active_injuries: boolean;               // intake_payload.health.active_injuries.length > 0
  poor_sleep_efficiency: boolean;             // (wake - bedtime) - avg_sleep_hours > 1h
  missed_protein_yesterday: boolean;          // yesterday.protein_g < target.protein_g * 0.9
};
```

## Module layout

All new code lives under `lib/morning/brief/` (new directory):

```
lib/morning/brief/
  index.ts                 // orchestrator: buildMorningBrief()
  data-sources.ts          // fetchBriefInputs() — single Promise.all over 5 reads
  assembler.ts             // pure: composes MorningBriefCard except advice_md
  flags.ts                 // computeAdviceFlags() — 5 day-1 flags
  advice-prompt.ts         // generateAdvice() — single Anthropic Haiku call
  get-today-targets.ts     // Phase-1/Phase-2 abstraction for macros + sleep target
```

The orchestrator is the only entry point. Everything else is unit-testable in isolation (pure functions or single-purpose modules).

### `data-sources.ts`

Exports `fetchBriefInputs(supabase, userId, today)` returning a typed `BriefInputs` object. Internally runs five parallel reads via `Promise.all`:

1. **Today's session** — `training_weeks` row for the active block + today's weekday (`session_plan[weekday]`). If no active training_weeks row, fall back to `WEEKLY_SESSIONS[weekday]` from `lib/coach/sessionPlans.ts`. Also pulls `intensity_modifier` (jsonb).
2. **Active training_blocks** — for `primary_lift` (needed to apply `intensity_modifier`).
3. **Today's targets** — via `getTodayTargets(supabase, userId)` from `get-today-targets.ts`. Returns `{ kcal, protein_g, carb_g, fat_g, bedtime, sleep_hours_target }`. Phase 1: reads `intake_payload.nutrition` + `intake_payload.sleep_recovery` from active doc.
4. **Yesterday's recap** — `daily_logs` for yesterday (sleep_hours, calories_eaten, protein_g, hrv) + `workouts` for yesterday (aggregated: type + top Epley e1RM across primary-lift exercises matching the same regex as `lib/query/fetchers/recentE1RMs.ts`).
5. **Today's readiness inputs** — `checkins[today]` (the row just filled — readiness 1-10, fatigue, etc.) + `daily_logs[today]` (HRV, recovery if WHOOP synced overnight) + `profiles.whoop_baselines` for band derivation.

### `assembler.ts`

Pure function. No I/O. Exports `assembleBriefExceptAdvice(inputs: BriefInputs): Omit<MorningBriefCard, 'advice_md'>`.

**Session list composition (training variant):**

```ts
function composeSession(
  type: string,
  modifier: IntensityModifier,
  primaryLift: PrimaryLift | null,
  currentE1RMs: { squat: number | null; bench: number | null; deadlift: number | null; ohp: number | null },
): MorningBriefExercise[] {
  const plan = SESSION_PLANS[type] ?? [];
  return plan
    .filter((p) => !p.warmup)
    .map((p) => {
      const lift = inferLiftFromKey(p.key); // 'squat' | 'bench' | 'deadlift' | 'ohp' | null
      const liftModifier = lift && lift === primaryLift ? (modifier[lift] ?? 1.0) : 1.0;
      const scaledKg = p.baseKg != null ? Math.round(p.baseKg * liftModifier * 2) / 2 : null;
      return {
        name: p.name,
        sets: p.sets ?? 3,
        reps: p.baseReps ?? 8,
        kg: scaledKg,
        note: p.note,
      };
    });
}
```

Where reasonable, extract any shared scaling logic with `TodayPlanCard` into a single helper to avoid duplication (verify location at implementation; `lib/coach/scaling.ts` is the likely home).

**Readiness band derivation:**

```ts
function deriveReadinessBand(
  score: number | null,
  hrv: number | null,
  baselines: WhoopBaselines | null,
): "low" | "moderate" | "high" {
  if (score === null) return "moderate";
  const hrvLow = baselines?.hrv_swc_low ?? null;
  const hrvHigh = baselines?.hrv_swc_high ?? null;
  if (score <= 5 || (hrv !== null && hrvLow !== null && hrv < hrvLow)) return "low";
  if (score >= 8 && (hrv === null || hrvHigh === null || hrv >= hrvHigh)) return "high";
  return "moderate";
}
```

Two-signal triangulation matching the autoregulation convention from `lib/coach/autoregulation.ts`.

**Variant selection:**

```ts
function pickVariant(sessionType: string): MorningBriefVariant {
  return sessionType === "REST" ? "rest" : "training";
}
```

**Other composition functions:** `composeRecap()`, `composeMacros()`, `composeTonight()` — straightforward field mapping with null-handling.

### `flags.ts`

Pure function. Exports `computeAdviceFlags(inputs: BriefInputs, card: Omit<MorningBriefCard, 'advice_md'>): AdviceFlags`.

```ts
const GLP1_REGEX = /\b(glp[-\s]?1|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|saxenda)\b/i;

export function computeAdviceFlags(inputs: BriefInputs, card: Omit<MorningBriefCard, 'advice_md'>): AdviceFlags {
  const meds = inputs.activeProfile?.intake_payload.health.medications ?? "";
  const drinks = inputs.activeProfile?.intake_payload.nutrition.alcohol_drinks_per_week ?? 0;
  const injuries = inputs.activeProfile?.intake_payload.health.active_injuries ?? [];
  const bedtime = inputs.activeProfile?.intake_payload.sleep_recovery.typical_bedtime;
  const wakeTime = inputs.activeProfile?.intake_payload.sleep_recovery.typical_wake_time;
  const avgSleep = inputs.activeProfile?.intake_payload.sleep_recovery.avg_sleep_hours ?? 0;

  const timeInBed = computeTimeInBed(bedtime, wakeTime); // hours, accounting for crossing midnight
  const poor_sleep_efficiency = timeInBed !== null && timeInBed - avgSleep > 1;

  const proteinTarget = card.macros.protein_target_g;
  const proteinActual = card.recap.protein_actual_g;
  const missed_protein_yesterday = proteinActual !== null && proteinTarget > 0 && proteinActual < proteinTarget * 0.9;

  return {
    has_glp1: GLP1_REGEX.test(meds),
    alcohol_low_readiness_warning: drinks > 0 && card.readiness.band === "low",
    has_active_injuries: injuries.length > 0,
    poor_sleep_efficiency,
    missed_protein_yesterday,
  };
}

function computeTimeInBed(bedtime: string | undefined, wakeTime: string | undefined): number | null {
  if (!bedtime || !wakeTime) return null;
  const [bh, bm] = bedtime.split(":").map(Number);
  const [wh, wm] = wakeTime.split(":").map(Number);
  let minutesInBed = (wh * 60 + wm) - (bh * 60 + bm);
  if (minutesInBed < 0) minutesInBed += 24 * 60; // crossed midnight
  return minutesInBed / 60;
}
```

**Adding a new flag in v1.1 is two lines:** one in `computeAdviceFlags` to set the boolean, one in the prompt instructions to describe when the AI should mention it.

### `advice-prompt.ts`

Exports `generateAdvice(inputs: BriefInputs, card: Omit<MorningBriefCard, 'advice_md'>, flags: AdviceFlags): Promise<string>`.

**Model:** `claude-haiku-4-5-20251001`.
**Max tokens:** 350.
**Temperature:** 0.4.
**No tool use.**

**Prompt structure (composed inline):**

```
You are this athlete's coach delivering today's morning brief — the catch-up after the morning intake.

## Athlete context

{Athlete's name if present}.
Goal: {primary_metric} → {target_value}{target_unit} by {target_date}.
Goal narrative: "{why_narrative}".
Phase: {current_phase}.
{If medications non-empty: "Medications: {medications}".}
{If active_injuries non-empty: list them as "Restriction: {joint} — {restriction}" lines.}

## Today's data

- Variant: {training|rest}
- Session: {Legs|Chest|...|REST} {at 13:00 if training}
- Readiness band: {low|moderate|high} (score {N}/10, HRV {H}, recovery {R})
- Macros target today: {kcal} kcal, {P}g protein / {C}g carb / {F}g fat
- Recap: yesterday slept {H}h, ate {kcal_actual} kcal (target {kcal_target}), {protein_actual}g protein (target {protein_target}g), trained {type}{, top e1RM {lift} {kg}kg}

## Flags

- has_glp1: {true|false}
- alcohol_low_readiness_warning: {true|false}
- has_active_injuries: {true|false}
- poor_sleep_efficiency: {true|false}
- missed_protein_yesterday: {true|false}

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
- Direct but warm. The athlete picked balanced tone (Phase 2 will surface specific directness preference; for Phase 1 default = balanced).
- Reference numbers from the data block above; never invent values.
- Default protein examples: chicken, greek yogurt, eggs, salmon. Default carbs: rice, oats, sweet potato, banana.
- Do not restate data the card already shows (no "your readiness is 68" — the card shows that). Build *on* the data.

Output ONLY the advice text. No headers, no preamble.
```

**Failure handling:** if the Anthropic call throws (rate limit, network, malformed response), `generateAdvice()` throws. The orchestrator catches and surfaces failure.

### `get-today-targets.ts`

Exports `getTodayTargets(supabase, userId): Promise<TodayTargets | null>`.

Phase 1 implementation:

```ts
export type TodayTargets = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  bedtime: string;             // "HH:mm"
  sleep_hours_target: number;
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
};

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

Phase 2 will change the source to `plan_payload.nutrition` / `plan_payload.sleep`. The function signature is stable — brief consumers don't notice the swap.

### `index.ts` (orchestrator)

```ts
export async function buildMorningBrief(
  supabase: SupabaseClient,
  userId: string,
): Promise<MorningBriefCard> {
  const today = todayInUserTz();
  const inputs = await fetchBriefInputs(supabase, userId, today);
  const partial = assembleBriefExceptAdvice(inputs);
  const flags = computeAdviceFlags(inputs, partial);
  const advice_md = await generateAdvice(inputs, partial, flags);
  return { ...partial, advice_md };
}
```

That's the single entry point the route handler calls.

## State machine

Extends the existing morning intake state machine. Transitions:

```
[existing]
pending → awaiting_feel → [awaiting_sickness_notes] → awaiting_whoop → delivered

[new pipelined transitions, automatic, same request]
delivered → assembling_brief
  ├─ AI succeeds → brief_delivered  (terminal)
  └─ AI fails    → brief_failed     (recoverable)

[new retry transition, user-triggered]
brief_failed → assembling_brief
  ├─ AI succeeds → brief_delivered
  └─ AI fails    → brief_failed (loops; user can keep retrying)
```

**Idempotency gate** (entry to `assembling_brief` from either path):

| Current state | Action |
|---|---|
| `brief_delivered` | No-op; return existing brief message id |
| `assembling_brief` | Return early; a previous request is in flight |
| `brief_failed` | Proceed (retry path) |
| `delivered` | Proceed (initial path) |
| Anything else | Reject; intake not yet complete |

Strict 1-per-day enforced via the `checkins (user_id, date)` row's `intake_state`. No partial unique index on `chat_messages` needed.

## Failure handling

**AI call fails (rate limit, timeout, malformed response, parsing error):**

- NO `chat_messages` row is written.
- `intake_state` transitions: `assembling_brief → brief_failed`.
- The route handler returns a structured error response to the client.
- The morning bot's existing UI layer (which polls / re-fetches state) detects `brief_failed` and renders a retry chip turn: one chip labeled "Try again", caption "I had trouble generating today's brief. Tap to retry."
- The retry chip reuses the existing `kind='morning_intake'` + `ui.chips` rendering pattern — no new component needed.

**Retry endpoint:** `app/api/chat/morning/retry-brief/route.ts` (POST, no body).

- Guard: requires `checkins.intake_state = 'brief_failed'` for today's row. If state is anything else, return 409.
- Transitions to `assembling_brief`, calls `buildMorningBrief()`, transitions to `brief_delivered` or back to `brief_failed`.
- Same idempotency rules apply.

**Profile not set up (`active = null`):**

- `getTodayTargets()` returns `null`.
- Assembler falls back: macros block shows "no targets set up — complete /onboarding". Tonight block shows "aim 7-8h" placeholder.
- Brief still renders; the missing-prerequisite is surfaced inline.

**Training week not set up (no active block / no training_weeks row):**

- Session falls back to `WEEKLY_SESSIONS[weekday]` from `lib/coach/sessionPlans.ts` (existing behavior matching `TodayPlanCard`).

**Yesterday's data sparse (no Yazio yesterday, no workout yesterday):**

- Recap shows `null` for missing values; renderer displays "—" in the corresponding stat tile.
- Brief still renders.

## UI

The brief renders as a structured card inside `ChatPanel.tsx` when the message's `kind === 'morning_brief'`. The card is wider than a normal chat bubble (full chat width minus standard padding) and has no bubble tail. The card itself is the message content; no extra wrapper text.

### Card sections (training variant)

```
┌─────────────────────────────────────────────┐
│  {Weekday Month Day} · Today's brief         │  ← Header
│  ── Readiness: {N} · {Band} ──               │  ← Readiness pill, band-colored
├─────────────────────────────────────────────┤
│  Yesterday                                    │  ← Recap block, 4-stat grid
│  ┌────────┬────────┬────────┬─────────┐    │
│  │ Sleep  │ Kcal   │ Protein│ Trained │    │
│  │ {H}h   │ {A}    │ {A}g   │ {Type}  │    │
│  │        │/{T}    │/{T}g   │ {Top}   │    │
│  └────────┴────────┴────────┴─────────┘    │
├─────────────────────────────────────────────┤
│  Today · {Session} · {start_time}            │  ← Session block header
│  ┌──────────────────────────────────┐       │
│  │ {Exercise name}      {kg} kg     │       │  ← One row per exercise
│  │ {sets} sets × {reps} reps        │       │
│  ├──────────────────────────────────┤       │
│  │ ...                              │       │
│  └──────────────────────────────────┘       │
│  *{caption if non-default intensity modifier}│  ← optional caption
├─────────────────────────────────────────────┤
│  Macros today                                 │  ← Macros 2×2 grid
│  ┌──────────────┬──────────────┐            │
│  │ {kcal} kcal  │ {P}g protein │            │
│  ├──────────────┼──────────────┤            │
│  │ {C}g carb    │ {F}g fat     │            │
│  └──────────────┴──────────────┘            │
├─────────────────────────────────────────────┤
│  Coach                                        │  ← Advice block
│  {advice_md rendered as prose}                │
├─────────────────────────────────────────────┤
│  Tonight: {bedtime} → {wake} ({hours}h)       │  ← Tonight one-liner
└─────────────────────────────────────────────┘
```

### Card sections (rest variant)

Same as training variant, except the **Session block** is replaced with a Recovery Focus list:

```
Today · REST

Recovery focus:
• 15 min full-body mobility
• 8k steps / 60 min walk
• Sleep priority — bed by {bedtime}
```

(These three items are static for v1; not data-driven.)

### Visual treatments

Uses existing `COLOR` tokens from `lib/ui/theme.ts`:

- **Header** — `textMuted` for date prefix, `textStrong` semibold for "Today's brief"
- **Readiness pill** — band-colored: `successSoft` background + `success` text for "high", `warningSoft` + `warning` for "moderate", `dangerSoft` + `danger` for "low"
- **Sub-section headers** — small caps, `textMuted`, semibold
- **Stat grids** — `surfaceAlt` background, 4 columns on wide, 2 columns on narrow phone widths; value bold in `textStrong` above, label below in `textMuted`
- **Exercise list rows** — separated by `divider`; exercise name left in `textStrong`, weight + sets/reps right-aligned in `textMid`
- **Macros grid** — 2×2, `accentSoft` background, value bold, label small below
- **Advice block** — `accentSoft` background, rounded, line-height 1.6; "Coach" header label
- **Tonight one-liner** — bottom strip with `surfaceAlt`; single line in `textMuted`
- **Caption ("*modifier applied...")** — `textFaint`, italic, small

### Accessibility

- All numerical values include `aria-label` for screen readers ("Squat Barbell, 62 point 5 kilograms, 3 sets of 6 reps")
- Readiness band is conveyed in text, not only color
- Tappable areas (only the retry chip in the failure path) comply with 44pt minimum

## Route handler integration

### `app/api/chat/morning/intake/route.ts` (modify existing)

Today, this endpoint handles morning intake chip submissions. We extend it: when the bloating slot is filled (the last existing slot), pipeline the brief generation in the same request.

Pseudocode:

```ts
// Existing flow: write the bloating answer, transition awaiting_whoop → delivered
const updated = await writeAnswer(supabase, userId, today, "bloating", value);

// New: check idempotency, then pipeline
if (updated.intake_state === "delivered") {
  // Initial entry to brief pipeline
  const existing = await findExistingBrief(supabase, userId, today);
  if (existing) {
    // Idempotency: already delivered earlier — return existing
    return Response.json({ messages: [updated, existing] });
  }

  await transitionState(supabase, userId, today, "assembling_brief");

  try {
    const card = await buildMorningBrief(supabase, userId);
    const briefMessage = await writeBriefMessage(supabase, userId, card);
    await transitionState(supabase, userId, today, "brief_delivered");
    return Response.json({ messages: [updated, briefMessage] });
  } catch (err) {
    await transitionState(supabase, userId, today, "brief_failed");
    console.error("[morning brief] AI generation failed", err);
    return Response.json({ messages: [updated], brief_status: "failed" });
  }
}
```

### `app/api/chat/morning/retry-brief/route.ts` (new file)

```ts
export async function POST() {
  const { supabase, user } = await requireUser();
  const today = todayInUserTz();

  const { data: checkin } = await supabase
    .from("checkins")
    .select("intake_state")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle();

  if (checkin?.intake_state !== "brief_failed") {
    return new Response("Not in retry state", { status: 409 });
  }

  await transitionState(supabase, user.id, today, "assembling_brief");

  try {
    const card = await buildMorningBrief(supabase, user.id);
    const briefMessage = await writeBriefMessage(supabase, user.id, card);
    await transitionState(supabase, user.id, today, "brief_delivered");
    return Response.json({ message: briefMessage });
  } catch (err) {
    await transitionState(supabase, user.id, today, "brief_failed");
    console.error("[morning brief retry] AI generation failed", err);
    return Response.json({ brief_status: "failed" }, { status: 500 });
  }
}
```

### `components/chat/ChatPanel.tsx` (modify existing)

Add a render branch for `message.kind === 'morning_brief'`:

```tsx
{messages.map((m) => {
  if (m.kind === "morning_brief") {
    return <MorningBriefCard key={m.id} card={m.ui as MorningBriefCard} />;
  }
  if (m.kind === "morning_intake") {
    return <MorningIntakeMessage key={m.id} message={m} />;
  }
  return <ChatBubble key={m.id} message={m} />;
})}
```

When `intake_state === 'brief_failed'`, the existing morning bot UI surfaces a chip turn with one option labeled "Try again" that POSTs to `/api/chat/morning/retry-brief`. The retry chip uses the existing `kind='morning_intake'` + `ui.chips` rendering — no new component.

## Files

### New files (13)

```
supabase/migrations/0011_morning_brief.sql

lib/morning/brief/data-sources.ts
lib/morning/brief/assembler.ts
lib/morning/brief/flags.ts
lib/morning/brief/advice-prompt.ts
lib/morning/brief/get-today-targets.ts
lib/morning/brief/index.ts

app/api/chat/morning/retry-brief/route.ts

components/morning/MorningBriefCard.tsx
components/morning/BriefRecapStats.tsx
components/morning/BriefSessionList.tsx
components/morning/BriefRestActions.tsx
components/morning/BriefMacrosGrid.tsx
components/morning/BriefAdvice.tsx
components/morning/BriefTonight.tsx
```

### Modified files (4)

```
lib/data/types.ts                          // add MorningBrief* types + AdviceFlags
app/api/chat/morning/intake/route.ts        // pipeline brief generation after final slot
components/chat/ChatPanel.tsx              // route kind='morning_brief' to MorningBriefCard
CLAUDE.md                                  // add migration 0011 entry + Coach/AI bullet
```

### Untouched

- `lib/morning/script.ts` (slot definitions unchanged; brief is new state after existing slots)
- `lib/morning/state.ts` (extends naturally; no shape change)
- `lib/coach/snapshot.ts` (brief has its own data sources)
- Athlete profile schema (read-only consumer)
- Strength tab / weekly planning code (`training_weeks` consumed read-only)

## Verification

This codebase has no test runner (per CLAUDE.md). Verification is `npm run typecheck` + targeted probe scripts (deleted after running) + manual exercise.

### Probe scripts (created → run → deleted, not committed)

1. **`scripts/probe-brief-flags.mjs`** — exercises `computeAdviceFlags()` against five test fixtures, one per flag. Expected output:
   - GLP-1 user → `has_glp1: true`
   - Alcohol + low readiness → `alcohol_low_readiness_warning: true`
   - Active injury → `has_active_injuries: true`
   - Bedtime 21:30 / wake 06:30 / avg 7h → `poor_sleep_efficiency: true`
   - Yesterday protein 140g vs target 170g → `missed_protein_yesterday: true`

2. **`scripts/probe-brief-assembler.mjs`** — exercises `assembleBriefExceptAdvice()` with sample inputs:
   - Training-variant card: session list correctly scaled with intensity_modifier × current e1RM
   - Rest-variant card: `session.exercises` is empty, `session.type = "REST"`
   - Recap: `_actual` / `_target` pairs correctly placed
   - Tonight: bedtime + sleep_hours_target pulled from intake_payload

3. **`scripts/probe-brief-advice.mjs`** — runs `generateAdvice()` once against the live user (Abdelouahed, who has `has_glp1: true` + `poor_sleep_efficiency: true`). Visually inspects:
   - Advice mentions hunger reminder (GLP-1 clause fired)
   - Advice probes the sleep gap (poor_sleep_efficiency clause fired)
   - 2-4 sentences, anchored to 1pm
   - No invented values
   - Cost: ~1 Haiku call, ~$0.0005

### Build / type checks

- `npm run typecheck` clean (zero errors)
- `npm run build` succeeds

### Manual smoke

After full implementation, walk through:

1. **Cold start.** Open chat in the morning. Bot starts with `awaiting_feel`.
2. **Complete intake.** Tap chips through readiness → energy → mood → soreness → fatigue → bloating.
3. **Brief renders.** Within ~3s of the last chip tap, a new assistant message appears with `kind='morning_brief'` and structured `ui.brief_card`. Verify:
   - Header shows today's date + readiness pill matching the band color
   - Yesterday recap 4-stat grid populated (sleep, kcal vs target, protein vs target, training)
   - Today's session block shows exercises with correct scaled weights (cross-check against `/strength` TodayPlanCard)
   - Macros 2×2 grid shows targets from `intake_payload.nutrition`
   - Advice block: 2-4 sentences mentioning GLP-1 hunger reminder + sleep efficiency gap (for the test user)
   - Tonight one-liner: bedtime + hours target
4. **DB state.** `select intake_state from checkins where date = today` returns `'brief_delivered'`. `select kind, ui from chat_messages where user_id = ? and date_trunc('day', created_at) = today order by created_at desc limit 1` returns `kind='morning_brief'` with structured `ui` payload matching `MorningBriefCard` shape.
5. **Idempotency.** Close and reopen chat. No second brief appended; existing brief remains.
6. **REST variant.** On a Saturday (or by temporarily setting today's session to REST), verify brief renders rest-variant layout: Session block replaced with "Recovery focus" list; macros + advice + tonight blocks still present.
7. **Failure path.** Temporarily set `ANTHROPIC_API_KEY=invalid`. Complete intake. Verify:
   - No `morning_brief` message in `chat_messages`
   - `checkins.intake_state = 'brief_failed'`
   - Morning bot UI surfaces a retry chip turn ("Try again")
   - Restore valid API key; tap retry; brief renders correctly; state advances to `brief_delivered`
8. **Cross-feature smoke.** Open `/coach` (regular chat, not morning). Ask: "What did you tell me to eat this morning?" — coach reads the brief from chat history and references it. (The brief is in `chat_messages`; default-mode coach pulls history as usual.)

### Cost verification

Track Anthropic usage for one week after rollout. Expected: ~$0.005-0.010/week (7 mornings × $0.001 avg). If significantly higher, investigate retry storms or prompt bloat.

## Implementation handoff

Once this spec is approved, run `/writing-plans` with this spec as input to produce the task-by-task implementation plan.

Estimated scope: ~12-14 tasks (smaller than Phase 1's 18 because no new chat mode, no per-slot tools, no wizard, no `/profile` integration):

1. Migration `0011` + CLAUDE.md entry
2. TypeScript types
3. `get-today-targets.ts` (Phase-1 implementation)
4. `flags.ts` + probe script
5. `assembler.ts` + probe script
6. `data-sources.ts`
7. `advice-prompt.ts` + probe script
8. `index.ts` orchestrator
9. Route handler integration (`intake/route.ts` + new `retry-brief/route.ts`)
10. `MorningBriefCard` parent component
11. Sub-components: `BriefRecapStats`, `BriefSessionList` (training), `BriefRestActions` (rest), `BriefMacrosGrid`, `BriefAdvice`, `BriefTonight`
12. `ChatPanel` routing extension
13. End-to-end manual smoke + CLAUDE.md polish

After Morning Brief ships and 2-3 days of soak data accumulate, the Phase 2 (Athlete Profile AI plan generation) spec writes against the soak findings — particularly which form fields the soak reveals should have been chat questions, and which prescribed-vs-self-reported gaps make the macros block in this brief unreliable.
