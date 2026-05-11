# Athlete Profile — Phase 2 Design (AI Plan Generation)

**Date:** 2026-05-11
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Phase:** 2 of 3 — builds on Phase 1 (intake + acknowledged profile + snapshot integration, shipped 2026-05-10)

## Problem

Phase 1 captured a durable Athlete Profile via a 6-step form wizard, surfaced it in `/profile`, and injected a condensed summary into the coach AI's snapshot prefix. But the profile is **input only**: the user's stated baselines (current macros, sleep avg, training maxes) become the AI's reference frame. There are no **prescribed targets** — only descriptions of current state.

Today's morning brief demonstrates this gap concretely. The brief renders the user's current macros (2085 kcal, 168g protein) but treats them as "your target" because that's all `intake_payload.nutrition` holds. A real coaching plan doesn't just describe what the athlete is doing — it prescribes what they should do, with reasoning anchored in their goal, body composition, training history, and constraints.

The 2-3 day soak of Phase 1 also surfaced a critical failure mode: the user's v1 goal target was set at 100kg deadlift e1RM, but their current e1RM is 102kg. The form passed validation; the AI snapshot prefix carries the contradiction as fact. A real coach would catch this on the intake call and propose a sensible target. Phase 1 has no mechanism for this — the goal is whatever the user typed.

This spec covers **Phase 2**: a structured chat-driven intake conversation that augments the form-captured intake with deepened narrative, coaching preferences, and chronotype; a deterministic plan-builder that produces typed prescriptions across nutrition, sleep, periodization, strength template, recovery, and coaching agreement; and an AI narrative pass that wraps the prescriptions in coach voice. The output is `plan_payload` jsonb populating the existing `athlete_profile_documents` column. The morning brief swaps its source from `intake_payload.nutrition` to `plan_payload.nutrition` when an active plan exists.

## Goals

1. **Catch goal contradictions at the start.** A deterministic sanity-check beat runs before any chat narrative, against the form-captured intake. Four checks: goal-target-vs-current, sleep efficiency gap, macros gap vs actual intake, and protein-floor adequacy (for cuts). Each finding surfaces in chat with a proposed correction + Override chip.
2. **Run a 5-beat chat intake.** Sanity check → deepen goal narrative → deepen medical/restrictions → elicit coaching style + chronotype → catch-any. ~10-15 turns total. Per-slot tools write back to `intake_payload`.
3. **Generate a typed `plan_payload` deterministically.** The plan-builder is a pure function over `intake_payload` + body composition + recent e1RMs + active training block. AI's role is narrative wrapping (goal narrative, strength notes, nutrition notes), not numeric prescription.
4. **Cover nutrition, sleep, periodization, strength template, recovery, coaching agreement.** Eight typed plan sub-objects. Strength is template-only (sessions/wk, day pattern, weekly volume targets, progression rule); per-block weights stay in `training_blocks` / `training_weeks`. Per-muscle-group volume tracking, diet break / reverse dieting, and biomarker integration are explicit non-goals for v1.
5. **Forward-compatible morning brief consumption.** Phase 1 designed `lib/morning/brief/get-today-targets.ts` as the abstraction point. Phase 2's only change to the morning brief code: that function reads `plan_payload.nutrition` first, falls back to `intake_payload.nutrition` only when no plan exists. ~10 line patch as part of the Phase 2 work.
6. **Pre-Phase-2 v1 transition.** The user already has a v1 doc (acknowledged 2026-05-10). `/profile` surfaces a "Generate your coaching plan" CTA when `active.plan_payload === null`. Clicking opens `/coach?mode=intake&doc=<id>` and runs the full intake against the existing v1 intake. After acknowledgment, v1 → superseded, v2 (with plan_payload) → active.
7. **Cost discipline.** Sonnet 4.6 throughout. Total cost per acknowledged plan ceremony (chat + propose_plan + 1-2 revisions): ~$0.05-0.07. Annual cost if revising every 8 weeks: ~$0.30/year.

## Non-Goals

### Deferred to Phase 3 (drift detection layer)

- Drift detection paragraph in `DEFAULT_SYSTEM_PROMPT` (already a soft hook from Phase 1; Phase 3 adds quantitative gates)
- `/profile` amber stale-doc badge at 12 weeks since acknowledgment
- `setup_block` pre-flight nudge when active plan is more than 1 block old
- `training_blocks.athlete_profile_doc_id` FK correlation

### Tier 2 (deferred per soak findings — covered by Section 2's expert review)

- **Per-muscle-group volume tracking (MEV/MAV/MRV).** Phase 2 tracks volume per primary lift. A real strength coach would track per muscle group (quads, hams, chest, back, shoulders, arms, calves). Adding this requires either a richer SESSION_PLANS structure with per-exercise muscle tags or a dedicated volume-tracking system. Defer to v2.1.
- **Diet break / reverse dieting phase-of-phases.** Real RD prescriptions for >8-week cuts include 1-2 week maintenance breaks every 8-12 weeks and gradual reverse dieting at cut end. The plan_payload currently represents a single steady-state phase. Real long-term coaching is a phase sequence. Defer to v2.1 or v3.
- **Biomarker integration in plan_payload.** No HR-trend, HRV-baseline, body-composition-trajectory targets prescribed in the plan. The morning brief consumes these for daily readiness, but plan_payload doesn't define thresholds.
- **Goal decomposition.** Real coaches break goals into outcome / process / leading indicators. Phase 2 captures outcome only.
- **Adaptive caloric drift logic.** Plans should adjust as the user adapts (e.g., drop 100kcal every 4 stalled cut weeks). Phase 2's plan_payload is static between revisions.
- **Session-type flexibility.** The `template_session_types` enum (`Chest | Legs | Back | Mobility | REST`) is inherited from the prototype. Modern programming uses PPL, U/L, full body, specialization splits. Defer to v3.
- **Nap protocols / sleep banking.** Power-nap windows, pre-competition sleep extension, recovery-sleep targets after high-strain days.
- **Lab work integration slot.** Testosterone, vitamin D, ferritin, etc. Out of scope.
- **Micronutrient layer beyond hydration / fiber / sodium.** Phase 2 prescribes only hydration target. Real RD plans prescribe full micronutrient targets.

### Out of scope entirely

- Multi-user generalization. Single-user app.
- New chat mode for default coach acknowledging no-plan-yet state — handled with one paragraph in `SCHEMA_EXPLAINER`, not a mode change.
- DB migration. All Phase 2 schema is jsonb additions on existing nullable columns (`plan_payload`, `rendered_md`) created in Phase 1's migration `0010_athlete_profile.sql`.

## Phase 1 → Phase 2 transition

The user has a v1 active doc with `plan_payload = null` (Phase 1 ships intake only). Day 1 after Phase 2 ships:

1. **/profile shows the CTA.** `AthleteProfilePanel.tsx` gains a conditional render: if `active.plan_payload === null`, surface a "Generate your coaching plan" card alongside the existing v1 summary. Card explains: "Phase 1 captured your profile. Phase 2 turns it into a coaching plan with prescribed targets the AI references daily." CTA links to `/coach?mode=intake&doc=<activeId>`.
2. **Default coach (regular /coach chat) acknowledges the gap.** New paragraph added to `SCHEMA_EXPLAINER`: "If the user has an active athlete profile but `plan_payload` is null, mention they can generate the plan via /profile when conversation naturally permits. Never auto-redirect; never lecture."
3. **Intake chat runs against existing v1 intake.** Beat 1 sanity check fires immediately on the user's v1 fields. For the test user specifically:
   - Goal contradiction fires (target 100 < current 102). Coach proposes ~115kg by Aug 8 (current × (1 + months_to_target × 4% per month)). Chip: "Use proposed target" or "Keep mine (override)".
   - Sleep efficiency fires (21:30 bedtime + 06:30 wake = 9h in bed, 7h slept = 78% efficiency). Coach proposes bedtime 23:00. Chip: "Use suggested bedtime" or "Override".
   - Macros gap doesn't fire (user is at 2085 ± 5% of target).
   - Protein floor doesn't fire (168g / 103.5kg BW = 1.62g/kg, just above the 1.6 floor — user's doctor's clinical minimum). Plan-builder prescribes **166g** for the cut (1.6 g/kg × 103.5kg) — matches user's current intake within 2g. No actionable delta.
4. **Beats 2-5 capture chat-elicited slots.** Goal narrative deepened, GLP-1 follow-up, coaching style + chronotype + unprompted-action preferences, catch-any. All written to `intake_payload` in place — the existing draft row.

   The current v1 row is `status='active'`. To run intake chat against it, we need to either:
   - **Open as a fresh draft** (new row, version = v1.version + 1, intake_payload starts as copy of v1's, chat-elicited fields cleared)
   - **Mutate v1 in place** (no new row until propose_plan)

   We take the **fresh-draft** approach. Consistent with revision flow. v1 stays active until v2 commits. Allows abandon-mid-chat without breaking v1.
5. **propose_plan runs.** Plan-builder produces full `plan_payload`. PlanCard renders. User approves.
6. **commit_plan atomic transaction:** v2 draft → active, v1 active → superseded.
7. **Morning brief uses plan_payload from next day forward.** `get-today-targets()` reads `plan_payload.nutrition` first, falls back to `intake_payload.nutrition` if null. Ten-line patch.

## Architecture overview

```
Pre-Phase-2: user has v1 active, plan_payload = null
                              │
                              ▼
            /profile shows "Generate plan" CTA
                              │
                              ▼
              /coach?mode=intake&doc=<draftId>
            (creates a fresh draft row from v1 intake)
                              │
                              ▼
        ┌────────── 5-beat chat (mode='intake') ────────────┐
        │                                                    │
        │  Beat 1: SANITY CHECK (deterministic + AI surface) │
        │    Server runs runSanityChecks(intake) →           │
        │      [goalContradiction, sleepEfficiency,          │
        │       macrosGap, proteinFloor]                     │
        │    For each finding: surface with chip; user picks │
        │    Accept → apply_*(...) writes correction         │
        │    Override → set_sanity_override(...)             │
        │                                                    │
        │  Beat 2: DEEPEN goal narrative                     │
        │    1-2 turns probing the "why"                     │
        │    set_goal_narrative_chat(text)                   │
        │                                                    │
        │  Beat 3: DEEPEN medical/restrictions               │
        │    Probe flagged medications + injuries            │
        │    set_free_form_constraints(text)                 │
        │                                                    │
        │  Beat 4: ELICIT style + chronotype                 │
        │    Chip questions:                                 │
        │      directness, cadence, chronotype,              │
        │      unprompted_actions                            │
        │                                                    │
        │  Beat 5: CATCH-ANY                                 │
        │    Free-text "anything else?"                      │
        │    set_free_form_constraints(text) — appended      │
        │                                                    │
        └────────────────────────────────────────────────────┘
                              │
                              ▼
            propose_plan (HMAC-gated, no payload)
                              │
                              ▼
                    Server-side plan-builder
                    ┌─────────────────────┐
                    │ Deterministic skel: │
                    │   composeSnapshot   │
                    │   composeGoal       │
                    │   composePeriodiz   │
                    │   composeStrength   │
                    │   composeNutrition  │
                    │   composeSleep      │
                    │   composeRecovery   │
                    │   composeAgreement  │
                    └─────────────────────┘
                              │
                              ▼
                  AI narrative pass (Sonnet)
                    ┌─────────────────────┐
                    │ generatePlanNarrat: │
                    │   goal_summary      │
                    │   strength_notes    │
                    │   nutrition_notes   │
                    └─────────────────────┘
                              │
                              ▼
                  Compose final plan_payload
                  Write to draft row, regenerate
                    rendered_md (intake + plan)
                  Return approval_token to chat
                              │
                              ▼
                  PlanProposalCard renders
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
            User approves          User chats "tweak X"
                  │                       │
                  ▼                       ▼
        commit_plan(token)         propose_plan again
        Atomic transaction:        (new payload, new token)
          v1 → superseded
          draft → active
        revalidatePath /profile,
        /coach, /onboarding
```

Three core principles:

1. **Deterministic prescription, AI narrative.** Plan-builder is a pure function. Numbers come from data + intake. AI doesn't fabricate prescriptions; it wraps them in coach voice. Predictable, cheap, testable.
2. **Sanity-first chat.** Beat 1 runs before any narrative deepening. No point eliciting goal narrative if the goal target is broken.
3. **Forward-compatible with morning brief.** Single integration point: `get-today-targets.ts` swaps source. Brief renderer doesn't know whether targets come from intake (Phase 1 state) or plan (Phase 2 state).

## Schema

### `IntakePayload` schema_version 2 (additive)

All Phase 1 fields stay. New optional groups populated by chat:

```ts
export type IntakePayload = {
  schema_version: 1 | 2;
  health: { /* Phase 1 — unchanged */ };
  training: { /* Phase 1 — unchanged */ };
  lifestyle: { /* Phase 1 — unchanged */ };
  nutrition: { /* Phase 1 — unchanged */ };
  sleep_recovery: {
    // Phase 1 fields unchanged
    chronotype?: "lark" | "neutral" | "owl";       // NEW — captured in Beat 4 if absent
  };
  goals: { /* Phase 1 — unchanged */ };

  // ── New in Phase 2 (optional; populated by chat) ─────────────────────────
  goal_narrative_chat?: string;
  coaching_preferences?: {
    directness: "blunt" | "balanced" | "softer";
    cadence: "daily" | "weekly" | "on_demand";
    unprompted_actions: Array<
      "suggest_revisions" | "nudge_on_drift" | "flag_macros" | "flag_sleep"
    >;
  };
  free_form_constraints?: string;
  sanity_overrides?: {
    goal_kept_despite_low_target?: boolean;
    sleep_efficiency_acknowledged?: boolean;
    macros_gap_acknowledged?: boolean;
    protein_floor_acknowledged?: boolean;
  };
};
```

Existing Phase 1 readers check `schema_version`. For v1 (schema_version: 1), new fields are absent — readers default to no-narrative / no-preferences / etc. Forward-compatible: v2 payload still satisfies v1 reader because all new fields are optional.

### `plan_payload` typed shape (jsonb)

```ts
export type PlanPayload = {
  schema_version: 1;

  athlete_snapshot: {
    name: string | null;
    age: number | null;
    height_cm: number | null;
    training_age: "beginner" | "intermediate" | "advanced";
    derived_at: string;       // ISO timestamp
  };

  goal: {
    type: "strength" | "body_comp" | "performance" | "health";
    primary_metric: string;
    target_value: number;
    target_unit: string;
    target_date: string;
    narrative_summary: string;          // AI-generated, 2-3 sentences synthesizing form + chat
    feasibility_note: string | null;    // populated when sanity_overrides[*] is true
  };

  periodization: {
    block_length_weeks: number;         // typically 5
    blocks_to_goal_date: number;        // computed from goal.target_date
    deload_cadence_weeks: number;       // typically 5
    rir_arc: Array<{ week: number; rir: number }>;  // [{1,4},{2,3},{3,2},{4,1},{5,deload}]
    rotation_rule: "fixed_split" | "rotate_primary" | "specialization";
  };

  strength: {
    sessions_per_week: number;
    day_pattern: { [weekday: string]: string };       // full names: "Monday":"Legs"
    template_session_types: Array<
      "Chest" | "Legs" | "Back" | "Mobility" | "REST"
    >;
    weekly_volume_targets: {
      [primary_lift: string]: { reps_per_week: number; sets_per_week: number };
    };
    progression_rule: string;           // template phrasing (free-text for v1)
    notes: string | null;               // AI-generated context
  };

  nutrition: {
    phase: "cut" | "maintain" | "lean_bulk" | "recomp";
    kcal_target: number;
    kcal_range: [number, number];       // ±5%
    protein_g_per_kg_bw: number;        // cut: 1.6; maintain: 1.6; bulk: 1.6 (clinical floor at 1.6 g/kg BW for all phases per user's doctor)
    protein_g: number;                  // derived: protein_g_per_kg_bw × current bodyweight at acknowledgment
    carb_g: number;
    fat_g: number;
    training_day_uplift: { kcal: number; carb_g: number } | null;  // optional carb-led pre/post-WO
    refeed_cadence_days: number | null; // 5-7 for cuts; null for maintain/bulk
    refeed_uplift: { kcal: number; carb_g: number } | null;
    hard_rules: {
      alcohol_policy: "none" | "training_day_only" | "weekend_allowed";
      caffeine_cap_mg_per_day: number;
      caffeine_last_dose_hours_before_bed: number;
      tracking_tolerance_missed_days_per_week: number;
    };
    notes: string | null;               // AI-generated context
  };

  sleep: {
    chronotype: "lark" | "neutral" | "owl";
    target_hours_min: number;           // typically 7.5
    target_hours_max: number;           // typically 8.5
    wake_target: string;                // "06:30" — ANCHOR
    bedtime_target: string;             // derived: wake_target − target_hours_max
    efficiency_target: number;          // 0.85 minimum
    latency_target_min: number;         // 20 (max minutes to fall asleep)
    hygiene_rules: {
      caffeine_cutoff_hours_before_bed: number;        // 8-10
      alcohol_cutoff_hours_before_bed: number;         // 3-4
      last_meal_cutoff_hours_before_bed: number;       // 2-3
      screen_cutoff_minutes_before_bed: number;        // 60-90
      intense_exercise_cutoff_hours_before_bed: number; // 3
      morning_light_exposure_minutes: number;           // 5-10
      weekend_consistency_within_minutes: number;       // 60
    };
    concern_triggers: {
      avg_sleep_below_h: number;            // 6.5
      efficiency_below: number;             // 0.80
      latency_above_min: number;            // 30
      consecutive_short_nights: number;     // 2 (in last 4)
    };
  };

  recovery: {
    mobility_minutes_per_week: number;
    deload_triggers: string[];
    reactivity_protocol: string;            // "if today's readiness < 33%: drop intensity 10%"
  };

  coaching_agreement: {
    cadence: "daily" | "weekly" | "on_demand";
    directness: "blunt" | "balanced" | "softer";
    unprompted_actions_allowed: string[];
    re_evaluation_cadence_weeks: number;
  };
};
```

Key constraints:

- **`strength.day_pattern` uses full weekday names** ("Monday", not "Mon"). Matches the live `training_weeks.session_plan` convention. The defensive `readSessionForDay()` helper from PR #44 handles both, but new writes use full names.
- **`nutrition.protein_g` is derived** from `protein_g_per_kg_bw × current_bodyweight` at acknowledgment time. The ratio is the durable contract; raw grams snapshot. Switched from LBM to BW per clinical convention — user's doctor anchors the 1.6 g/kg BW minimum floor.
- **`sleep.wake_target` anchors the sleep window**, bedtime is derived. Matches sleep-medicine practice.
- **`nutrition.refeed_cadence_days` is non-null for cuts.** Plan-builder enforces this; the AI cannot return null for a cut phase.
- **`hard_rules` and `hygiene_rules` are typed structs**, not free-text. Future code can reason about each field; new fields are additive.

### No DB migration

`plan_payload jsonb` and `rendered_md text` are already nullable on `athlete_profile_documents` from Phase 1's migration `0010_athlete_profile.sql`. Phase 2 just populates them. Existing v1 docs (plan_payload null) stay valid.

## Sanity check details

`lib/coach/plan-builder/sanity-check.ts` exports `runSanityChecks(intake: IntakePayload, supporting: { latestE1RMs, latestBodyComp, recentDailyLogs }): SanityFinding[]`.

Four checks, deterministic:

### 1. Goal contradiction

For `goals.primary_type === "strength"`, infer the lift from `goals.primary_metric` (regex match: squat / bench / deadlift / ohp). Compare `goals.target_value` to `training.current_e1rm[<inferred lift>]`.

If `target_value <= current_e1rm`:
- Compute proposed: `current_e1rm × (1 + months_to_target × 0.04)` (4%/mo, conservative intermediate progression rate)
- Round to nearest 2.5kg (plate-loadable)
- Finding shape: `{ type: "goal_contradiction", current: 102, target: 100, proposed: 115, rationale: "current e1RM already exceeds target; proposed = +13% over 13 weeks (~4%/mo)" }`

### 2. Sleep efficiency gap

Compute `time_in_bed = wake - bedtime` (handles cross-midnight). Compare to `avg_sleep_hours`.

If `time_in_bed - avg_sleep_hours > 1` (efficiency < ~89%):
- Compute proposed bedtime: `wake - target_hours_max - 30 minutes` (extra 30 min buffer)
- Finding: `{ type: "sleep_efficiency", current_efficiency: 0.78, proposed_bedtime: "22:30", rationale: "9h in bed, 7h asleep — push bedtime earlier OR address latency separately" }`

### 3. Macros gap

Compute rolling 7d avg of `daily_logs.calories_eaten` and `protein_g` for the past 7 days.

If `|target_kcal - rolling_7d_kcal| / target_kcal > 0.10`:
- Two options surface in chip: "Use my actual intake as target" OR "Hit my stated target (commit to behavior change)"
- Finding: `{ type: "macros_gap", target: 2085, actual_7d: 1820, gap_pct: -13%, options: ["match_actual", "hit_target"], rationale: "you're undershooting target by 13%; we can either lower target to match reality or commit to hitting the stated target" }`

### 4. Protein floor (for cuts)

Floor is **1.6 g/kg bodyweight** across all phases — user's clinical recommendation. Plan-builder prescribes the floor as the target across all phases (cut, maintain, lean_bulk all default to 1.6); sanity check fires only when CURRENT intake falls below the 1.6 floor.

For `nutrition.current_phase === "cut"`:
- Read latest bodyweight from `daily_logs.weight_kg` (most recent non-null)
- Compute `current_protein_per_kg_bw = nutrition.current_macros.protein_g / bodyweight`
- Floor: 1.6 g/kg BW

If `current_protein_per_kg_bw < 1.6`:
- Compute proposed protein_g: `bodyweight × 1.6`
- Adjust fat_g downward to keep kcal stable: `fat_g_delta = -(protein_delta_g × 4) / 9`
- Finding: `{ type: "protein_floor", current: 100, current_per_kg_bw: 1.3, floor: 1.6, proposed: 126, proposed_fat: 73, rationale: "current protein 1.3 g/kg BW is below the 1.6 g/kg clinical floor for cuts" }`

### How findings are handled in chat

Server includes `findings: SanityFinding[]` in the system prompt context for Beat 1.

For each finding, the AI surfaces ONE turn with structured chips:
```ts
ui.chips: [
  { label: "Use proposed target", value: "accept", action: "apply_goal_target", payload: { target_value: 115 } },
  { label: "Keep mine (override)", value: "override", action: "override_finding", payload: { key: "goal_kept_despite_low_target" } },
]
```

Chip taps dispatch to one of the `apply_*` or `set_sanity_override` tools (see §Tools). After all findings have been handled (each has either an `apply_*` write or an override flag), Beat 1 completes and Beat 2 starts.

## Chat flow — 5 beats

### `INTAKE_PROMPT` (composed in `lib/coach/planning-prompts.ts`)

```
## You are running the coaching plan intake

This is a 5-beat structured conversation. ~10-15 turns total.

### Beat 1: SANITY CHECK
Server provides {sanity_findings} in context. For each finding, surface
ONE coach turn with chips. Wait for user response before next finding.

When user taps "Use proposed [X]" → call the apply_* tool with the proposed payload.
When user taps "Override" → call set_sanity_override(key).

Do NOT proceed to Beat 2 until all findings have been handled (each has
either an apply or an override write).

### Beat 2: DEEPEN goal narrative
Read user's form why_narrative. Probe deeper, 1-2 turns:
  Probe 1: "Tell me more about why this matters — what changes when you hit it?"
  Probe 2: "What's the harder version of this goal you secretly want?"

Synthesize 3-5 sentences combining form narrative + chat answers.
Call set_goal_narrative_chat(text).

### Beat 3: DEEPEN medical / restrictions
For each flagged item in intake.health.medications + active_injuries:
- GLP-1: "How long? Goal weight? Hunger affecting training?"
- Active injury (per row): "Walk me through what's off limits beyond what you listed."

Append to set_free_form_constraints(text).

### Beat 4: ELICIT coaching style + chronotype
Three chip turns (rapid):
  Turn 1: "Directness?" [blunt / balanced / softer] → set_directness
  Turn 2: "Check-in cadence?" [daily / weekly / on-demand] → set_cadence
  Turn 3: "Chronotype? When does your body naturally want to wake?"
          [lark / neutral / owl] → set_chronotype
  Turn 4: "Allow unprompted suggestions about:"
          [suggest_revisions / nudge_on_drift / flag_macros / flag_sleep]
          → set_unprompted_actions (multi-chip)

### Beat 5: CATCH-ANY
"Anything else I should know that I haven't asked?"
Free-text response → set_free_form_constraints (appended).

When user signals done (or after 2 turns), call propose_plan with no payload.

### Concision
2-4 sentences per coach turn. Use the user's existing vocabulary.
No lecturing. Match their directness preference once set in Beat 4.

### Tone
Default to balanced before Beat 4 sets the preference.
After Beat 4 acknowledges directness:
  blunt → cut hedges, no compliments without basis, name things plainly
  softer → contextualize, acknowledge effort before push
  balanced → coach-call-on-the-Sunday-call (default)
```

### Mode prompt assembly in `lib/coach/planning-prompts.ts`

Extends the existing `buildSystemPrompt` switch:

```ts
} else if (args.mode === "intake") {
  const intakeCtx = await fetchIntakeContext(args.supabase, args.userId);
  const findings = await runSanityChecks(args.supabase, args.userId, intakeCtx.intake);
  sections.push(INTAKE_PROMPT);
  sections.push(renderIntakeContext(intakeCtx, findings));
}
```

`renderIntakeContext` produces a system-prompt section containing:
- The full intake_payload (for the AI to reference user's stated facts)
- The sanity findings list (so the AI knows what to surface in Beat 1)
- The current draft row's state (which Beats already have writes, so the AI knows where to pick up)

## Tools

Mirrors the existing tool-registration pattern in `lib/coach/tools.ts`. Eleven new tools:

### Beat 1 — Sanity correction (no HMAC; single-field intake writes)

- `apply_goal_target(target_value: number, rationale: string)` — writes `intake.goals.target_value`; appends rationale to `intake.goals.why_narrative`
- `apply_bedtime_correction(typical_bedtime: string)` — writes `intake.sleep_recovery.typical_bedtime`
- `apply_macros_correction(kcal: number, protein_g: number, carb_g: number, fat_g: number)` — writes `intake.nutrition.current_kcal` + `current_macros`
- `apply_protein_correction(protein_g: number, fat_g: number)` — keeps kcal stable, writes adjusted protein + fat
- `set_sanity_override(key: "goal_kept_despite_low_target" | "sleep_efficiency_acknowledged" | "macros_gap_acknowledged" | "protein_floor_acknowledged")` — writes flag to `intake.sanity_overrides`

### Beats 2-5 — Slot setters (no HMAC; single-field intake writes)

- `set_goal_narrative_chat(text: string)` — writes `intake.goal_narrative_chat`
- `set_directness(value: "blunt" | "balanced" | "softer")` — writes `intake.coaching_preferences.directness`
- `set_cadence(value: "daily" | "weekly" | "on_demand")` — writes `intake.coaching_preferences.cadence`
- `set_chronotype(value: "lark" | "neutral" | "owl")` — writes `intake.sleep_recovery.chronotype`
- `set_unprompted_actions(actions: string[])` — writes `intake.coaching_preferences.unprompted_actions`
- `set_free_form_constraints(text: string, mode: "append" | "replace")` — appends or replaces `intake.free_form_constraints`

### End of intake — HMAC-gated

- `propose_plan(/* no payload */)` — server runs plan-builder from current intake state. Validates that all sanity findings have been handled (each has an `apply_*` write OR `sanity_override` flag). If unhandled findings exist, tool returns error → AI surfaces "I still need to address X before generating the plan". Returns `{ approval_token, plan_payload }` on success. Token is `action: "plan"`, payload-hash bound to `plan_payload`.
- `commit_plan(token: string)` — verifies token (HMAC, action='plan', expiry). Atomic transaction:
  - Validate doc is in `status='draft'` and belongs to caller's user
  - Flip prior active (if any) → `superseded`, `superseded_at = now()`, `superseded_by = <draft.id>`
  - Flip draft → `active`, `acknowledged_at = now()`
  - `revalidatePath('/profile')`, `revalidatePath('/coach')`, `revalidatePath('/onboarding')`

### Approval token

`lib/coach/approval-token.ts` already exports `signApprovalToken({userId, action, payload})` and `verifyApprovalToken(...)`. Extend the `action` union from `"block" | "week"` to `"block" | "week" | "plan"`. One-line type change; payload-hash binding handles the rest.

## Plan-builder

`lib/coach/plan-builder/index.ts` exports `buildPlanPayload(supabase, userId, intake)` returning `Promise<PlanPayload>`.

### Composition pipeline

```ts
async function buildPlanPayload(supabase, userId, intake): Promise<PlanPayload> {
  const today = todayInUserTz();

  // Pull supporting data in parallel
  const [latestBodyComp, recentE1RMs, activeBlock] = await Promise.all([
    getLatestBodyComp(supabase, userId),    // {weight_kg, fat_free_mass_kg, body_fat_pct}
    getRecentE1RMsServer(supabase, userId), // existing fetcher from Phase 1
    getActiveBlock(supabase, userId),       // training_blocks row
  ]);

  // Deterministic skeleton — per-section composers
  const athlete_snapshot = composeSnapshot(intake);
  const goal = composeGoal(intake, recentE1RMs);
  const periodization = composePeriodization(intake, goal);
  const strength = composeStrengthTemplate(intake, activeBlock, recentE1RMs);
  const nutrition = composeNutrition(intake, latestBodyComp);
  const sleep = composeSleep(intake);
  const recovery = composeRecovery(intake);
  const coaching_agreement = composeCoachingAgreement(intake);

  // AI narrative pass (single Sonnet call)
  const narrative = await generatePlanNarrative({
    intake,
    skeleton: { goal, strength, nutrition, sleep, recovery, coaching_agreement },
  });

  return {
    schema_version: 1,
    athlete_snapshot,
    goal: { ...goal, narrative_summary: narrative.goal_summary },
    periodization,
    strength: { ...strength, notes: narrative.strength_notes },
    nutrition: { ...nutrition, notes: narrative.nutrition_notes },
    sleep,
    recovery,
    coaching_agreement,
  };
}
```

### Per-section composer guarantees

Each `compose*` is a pure function:

- **`composeSnapshot`** — straight copy from `intake.training`, `intake.lifestyle`, `intake.health` baselines.

- **`composeGoal`** — preserves `target_value` from intake (after Beat 1 corrections). Computes `feasibility_note` from `sanity_overrides` flags (e.g., "User acknowledged target is below current e1RM — proceeding against stated value").

- **`composePeriodization`** — fixed parameters:
  - `block_length_weeks: 5` (research consensus per existing weekly-planning v1)
  - `deload_cadence_weeks: 5`
  - `rir_arc: [{1,4},{2,3},{3,2},{4,1},{5,null /* deload */}]`
  - `rotation_rule: "fixed_split"` (default for v1 — Tier 2 deferral)
  - `blocks_to_goal_date: ceil(days_to_goal / 7 / 5)`

- **`composeStrengthTemplate`** — derives:
  - `sessions_per_week`: from `intake.training.sessions_per_week`
  - `day_pattern`: from `intake.lifestyle.days_available` (matched 1:1 to session types — Mon=Chest, Tue=Legs default, OR carries forward existing training_weeks if active block exists)
  - `template_session_types`: deduplicated values from `day_pattern`
  - `weekly_volume_targets`: derived from intake's `current_e1rm` for primary lifts:
    - Intermediate lifter rule: 60-80 reps/wk per primary lift, 12-18 sets/wk
    - Beginner: 40-60 reps/wk, 8-12 sets/wk
    - Advanced: 80-100 reps/wk, 16-22 sets/wk (informational; not enforced)
  - `progression_rule`: derived template string based on `training_age`:
    - Beginner: "Add 2.5kg primary lifts every session when all reps clean"
    - Intermediate: "Add 2.5kg primary lifts when last set ≥ target RIR + 2 reps for 2 consecutive sessions"
    - Advanced: "Wave loading per block; assess at block end"

- **`composeNutrition`** — derives:
  - `phase`: from `intake.nutrition.current_phase`
  - `kcal_target`: from `intake.nutrition.current_kcal` (after Beat 1 corrections)
  - `kcal_range`: `[target × 0.95, target × 1.05]`
  - `protein_g_per_kg_bw`: phase-dependent — cut: 1.6; maintain: 1.6; lean_bulk: 1.6 (clinical floor 1.6 throughout per user's doctor)
  - `protein_g`: `protein_g_per_kg_bw × bodyweight` (latest `daily_logs.weight_kg`)
  - `carb_g`, `fat_g`: split remaining kcal — phase-dependent ratios:
    - Cut: 40C / 30F (more carbs for training preservation)
    - Maintain: 45C / 25F
    - Lean bulk: 50C / 20F
  - `training_day_uplift`: cut + intermediate or higher training_age → +150kcal carb-led on training days; null otherwise
  - `refeed_cadence_days`: cut → 6; maintain/bulk → null
  - `refeed_uplift`: cut → +500kcal, +100g carbs; null otherwise
  - `hard_rules`:
    - `alcohol_policy`: derived from `intake.nutrition.alcohol_drinks_per_week` — >5/wk → "weekend_allowed"; 0-5 → "training_day_only"; declared 0 → "none"
    - `caffeine_cap_mg_per_day`: from intake or default 400
    - `caffeine_last_dose_hours_before_bed`: 8 (default)
    - `tracking_tolerance_missed_days_per_week`: 1

- **`composeSleep`** — derives:
  - `chronotype`: from `intake.sleep_recovery.chronotype` (Beat 4) or default "neutral"
  - `target_hours_min`: 7.5; `target_hours_max`: 8.5 (default; can be tuned by chronotype later)
  - `wake_target`: from `intake.sleep_recovery.typical_wake_time` (or adjusted in Beat 1 if sleep efficiency fired)
  - `bedtime_target`: `wake_target − target_hours_max` (computed)
  - `efficiency_target`: 0.85
  - `latency_target_min`: 20
  - `hygiene_rules`: defaults per the typed shape (caffeine 8h, alcohol 3h, last meal 2h, screens 60min, exercise 3h, morning light 5min, weekend within 60min)
  - `concern_triggers`: standard thresholds

- **`composeRecovery`** — derives from intake + active block:
  - `mobility_minutes_per_week`: from `intake.sleep_recovery.mobility_work` if specified; default 30
  - `deload_triggers`: same as `lib/coach/autoregulation.ts` defaults (HRV outside SWC, sleep <6h, e1RM drop)
  - `reactivity_protocol`: standard text

- **`composeCoachingAgreement`** — derives from `intake.coaching_preferences` (Beat 4):
  - `cadence`, `directness`, `unprompted_actions_allowed`: 1:1 from intake
  - `re_evaluation_cadence_weeks`: 8 (default) or derived from training_age

### AI narrative prompt (`generatePlanNarrative`)

Single Sonnet 4.6 call. Returns three short narrative fields:

```
SYSTEM: You are writing the narrative wrapping for an athlete's coaching plan.
The deterministic skeleton is in {skeleton}. Your job is THREE short fields:

  goal_summary (2-3 sentences) — synthesize intake.goals + intake.goal_narrative_chat
    into the athlete's voice. Reference the proposed target if Beat 1 corrected it.

  strength_notes (1-2 sentences) — context for the strength prescription.
    Reference the active block, primary lift, sessions/wk. Note if training_age
    bumps the volume targets.

  nutrition_notes (1-2 sentences) — context for the nutrition prescription.
    Reference the phase, refeed cadence (if applicable), GLP-1 (if applicable),
    protein-per-kg-BW choice.

Output JSON: { goal_summary, strength_notes, nutrition_notes }
No markdown. No emoji. Coach voice (direct, anchored in user's narrative).
```

Cost: ~1500 input + 500 output tokens × Sonnet 4.6 ≈ **$0.018** per plan generation.

## Lifecycle

### State transitions (extends Phase 1's lifecycle)

```
[Phase 1 — already shipped]
v1 row: status='active', plan_payload=null, rendered_md=intake-only doc

[Phase 2 — user clicks "Generate plan" CTA on /profile]
new draft row created: copies v1's intake_payload, clears chat-elicited fields,
  status='draft', plan_payload=null, rendered_md=null
URL: /coach?mode=intake&doc=<draft.id>

[5-beat chat — Beat writes via apply_* / set_* tools]
draft.intake_payload mutated in place (still status='draft')
sanity overrides accumulate in intake_payload.sanity_overrides

[propose_plan tool call]
plan-builder runs → draft.plan_payload populated
renderPlanMarkdown(intake, plan, version, dates) → draft.rendered_md populated
status remains 'draft'
returns {approval_token, plan_payload} to chat

[PlanProposalCard rendered, user taps Approve]
chat composes user message "[approve:<token>]"
AI calls commit_plan(token)

[commit_plan executes atomic transaction]
v1 row: status='active' → 'superseded', superseded_at=now(), superseded_by=draft.id
draft row: status='draft' → 'active', acknowledged_at=now()
revalidatePath('/profile'), revalidatePath('/coach'), revalidatePath('/onboarding')
```

No new states needed beyond Phase 1's `draft | active | superseded | discarded`. The plan_payload populating is invisible to the state machine.

### Revision flow (post-Phase-2)

User clicks "Revise plan" on `/profile` (existing Phase 1 action). Same wizard pre-fills with prior intake_payload, **chat-elicited fields cleared**:
- `goal_narrative_chat` → null
- `coaching_preferences` → null
- `free_form_constraints` → null
- `sanity_overrides` → null
- `sleep_recovery.chronotype` is preserved (durable preference)

Form-elicited fields carry forward (health, training, lifestyle, nutrition baseline, sleep baseline, goal targets).

User submits form. Redirected to `/coach?mode=intake&doc=<newDraftId>`. **Full 5-beat chat re-runs.** Sanity check fires again on the new intake state, narrative re-elicited, propose_plan runs from scratch.

**Plan-builder regenerates from scratch.** No carry-forward of `plan_payload` between versions. Predictability over cleverness — plan reflects current intake state, not prior version's prescriptions. Cost: same as initial generation (~$0.05-0.07).

### Pre-Phase-2 v1 transition (covered above; recap)

Day 1 after Phase 2 ships:
- `/profile` shows "Generate plan" CTA when active.plan_payload is null
- Default `/coach` chat acknowledges no-plan state (one paragraph in SCHEMA_EXPLAINER)
- User clicks CTA → 5-beat chat runs against existing v1 intake
- For the test user: goal contradiction fires, sleep efficiency fires
- User acknowledges → v2 active with plan_payload populated, v1 superseded
- Morning brief uses plan_payload from next morning

## UI

### `AthleteProfilePanel.tsx` — extend with "Generate plan" CTA

Conditional render: if `active && active.plan_payload === null`, surface a CTA card:

```
┌─────────────────────────────────────┐
│  Coaching plan                       │
│  ── Phase 1 captured ✓ · Plan to be │
│     generated                       │
├─────────────────────────────────────┤
│  Your profile is set. Now turn it    │
│  into a coaching plan with prescribed│
│  sleep / nutrition / strength targets│
│  the AI references daily.           │
│                                      │
│  Takes ~10 minutes of chat.          │
│                                      │
│  [Generate plan →]                   │
└─────────────────────────────────────┘
```

CTA button links to `/coach?mode=intake&doc=<active.id>` (auto-creates a draft from active intake via a server action triggered on chat init).

When active.plan_payload is populated (post-Phase-2): existing v1 panel renders with View / Revise / History as today, no separate CTA.

### `PlanProposalCard.tsx` — new component

Mirrors `WeekPlanProposalCard.tsx` pattern. Renders the proposed `plan_payload` inline in chat:

```
┌─────────────────────────────────────┐
│  Proposed coaching plan — v2         │
│  ── Supersedes v1 ──                 │
├─────────────────────────────────────┤
│  GOAL                                │
│  Deadlift e1RM → 115kg by Aug 8     │
│  > "Setting up for first powerlifting│
│     meet — this needs honest weight" │
├─────────────────────────────────────┤
│  NUTRITION                           │
│  Cut · 2085 kcal (±5%)               │
│  ▸ 166g protein (1.6g/kg BW,         │
│    at clinical floor)                │
│  ▸ 145g carb · 78g fat               │
│  ▸ Refeed every 6 days (+500 kcal,   │
│    +100g carbs)                      │
│  ▸ Alcohol: training_day_only        │
├─────────────────────────────────────┤
│  SLEEP                               │
│  7.5-8.5h · wake 06:30 → bed 22:30  │
│  ▸ Efficiency target 0.85            │
│  ▸ Caffeine cutoff 8h before bed     │
│  ▸ Last meal 2h before bed           │
├─────────────────────────────────────┤
│  STRENGTH (template)                 │
│  4 sessions/wk · Mon/Tue/Thu/Fri    │
│  Legs / Chest / Back / Mobility      │
│  ▸ Deadlift: 60 reps/wk, 12 sets/wk │
│  ▸ Progression: +2.5kg when last set │
│    ≥ target RIR + 2 reps × 2         │
├─────────────────────────────────────┤
│  ... 4 more sections (collapsed)    │
├─────────────────────────────────────┤
│  [Tweak] [Approve plan →]           │
└─────────────────────────────────────┘
```

Sections expandable; default-collapse below the visible viewport on phone.

"Tweak" button doesn't trigger a tool — it focuses the chat input with a prefilled "I want to change ..." prompt. Coach AI responds with conversational adjustment, may re-call `propose_plan` with corrected intake.

"Approve plan" sends `[approve:<token>]` (existing chip pattern from plan_week / setup_block).

### `ChatPanel.tsx` — extend chip dispatch

New chip actions to handle:
- `apply_goal_target`, `apply_bedtime_correction`, `apply_macros_correction`, `apply_protein_correction` — dispatch to matching server tool
- `override_sanity_finding` — dispatch to `set_sanity_override`
- `accept_plan_proposal` — same as existing `[approve:<token>]` pattern
- `set_directness`, `set_cadence`, `set_chronotype`, `set_unprompted_actions` — dispatch to matching server tool

These extend the existing chip-routing in `ChatPanel`'s reducer. No new architecture.

### Render branch for `message.kind === 'morning_brief'` already exists from morning brief work. No new render branch needed for the proposed-plan card; it's rendered as part of the assistant message bubble when `tool_calls` includes `propose_plan` (mirrors how the existing WeekPlanProposalCard renders for `propose_week_plan`).

## Files

### New (10)

```
lib/coach/plan-builder/index.ts                  // buildPlanPayload orchestrator
lib/coach/plan-builder/sanity-check.ts           // runSanityChecks (4 deterministic checks)
lib/coach/plan-builder/compose-snapshot.ts       // composeSnapshot
lib/coach/plan-builder/compose-goal.ts           // composeGoal
lib/coach/plan-builder/compose-periodization.ts  // composePeriodization
lib/coach/plan-builder/compose-strength.ts       // composeStrengthTemplate
lib/coach/plan-builder/compose-nutrition.ts      // composeNutrition (BW-based protein, refeed logic)
lib/coach/plan-builder/compose-sleep.ts          // composeSleep (wake-anchored, hygiene defaults)
lib/coach/plan-builder/compose-recovery.ts       // composeRecovery
lib/coach/plan-builder/compose-coaching-agreement.ts  // composeCoachingAgreement
lib/coach/plan-builder/narrative-prompt.ts       // generatePlanNarrative (single Sonnet call)

lib/coach/profile-renderer.ts                    // already exists from Phase 1 — extend
                                                 // (NOT new — modified, see below)

components/chat/PlanProposalCard.tsx             // renders proposed plan_payload inline
```

(The 10 file count excludes the modified `profile-renderer.ts` and the existing plan-builder file split, which collapses to one orchestrator + 9 composers.)

### Modified (8)

```
lib/data/types.ts                                // IntakePayload schema_version 2,
                                                 // PlanPayload typed shape, ChatMode extension,
                                                 // SanityFinding type, AdviceFlags unchanged

lib/coach/tools.ts                               // 11 new tool definitions:
                                                 //   apply_goal_target, apply_bedtime_correction,
                                                 //   apply_macros_correction, apply_protein_correction,
                                                 //   set_sanity_override, set_goal_narrative_chat,
                                                 //   set_directness, set_cadence, set_chronotype,
                                                 //   set_unprompted_actions, set_free_form_constraints,
                                                 //   propose_plan, commit_plan

lib/coach/approval-token.ts                      // extend action union to include "plan"

lib/coach/planning-prompts.ts                    // INTAKE_PROMPT + buildSystemPrompt branch

lib/coach/profile-renderer.ts                    // extend renderProfileMarkdown to include
                                                 // plan sections when plan_payload is populated

app/api/chat/messages/route.ts                   // accept mode='intake', persist on messages

components/chat/ChatPanel.tsx                    // route new chip actions

components/profile/AthleteProfilePanel.tsx       // conditional "Generate plan" CTA

lib/morning/brief/get-today-targets.ts           // read plan_payload.nutrition first,
                                                 // fall back to intake_payload.nutrition
                                                 // (Phase-2-compatible swap as designed)
```

### Untouched

- `training_blocks` / `training_weeks` schemas (strength template references them; doesn't modify)
- Phase 1 form wizard (intake form unchanged; chat extends, not replaces)
- Morning brief assembler / advice prompt / sub-components (consume `plan_payload.nutrition` via `get-today-targets()`, no other change)
- Migration `0010_athlete_profile.sql` — plan_payload and rendered_md columns already exist nullable

### Env additions

- `COACH_TOOL_SECRET` (already exists from weekly-planning v1 — same HMAC secret used by `signApprovalToken`)

## Verification

Same posture as Phase 1 + morning brief: no test runner, but probe scripts + manual exercise.

### Probe scripts (created → run → deleted, not committed)

1. **`scripts/probe-sanity-check.mjs`** — exercises `runSanityChecks()` against the live user's v1 intake. Expected findings:
   - `goal_contradiction` fires (target 100 < current 102)
   - `sleep_efficiency` fires (78% efficiency, 9h in bed / 7h sleep)
   - `macros_gap` does NOT fire (within ±5%)
   - `protein_floor` does NOT fire (1.62g/kg BW > 1.6 floor)

2. **`scripts/probe-plan-builder.mjs`** — exercises `buildPlanPayload()` against the user's v1 intake after Beat 1 corrections applied (target = 115kg, bedtime = 22:30). Expected output:
   - `goal.target_value: 115`
   - `nutrition.phase: "cut"`, `kcal_target: 2085`, `protein_g ≈ 166` (1.6g/kg × 103.5kg BW), `refeed_cadence_days: 6`
   - `sleep.wake_target: "06:30"`, `bedtime_target: "22:00"` (06:30 − 8.5h)
   - `strength.sessions_per_week: 4`, `day_pattern: {Mon:"Legs",Tue:"Chest",Thu:"Back",Fri:"Mobility"}`
   - `coaching_agreement.directness: "balanced"` (or whatever was set)

3. **`scripts/probe-narrative-prompt.mjs`** — single Sonnet call against the plan from probe #2. Visually verify narrative is coach-voiced, anchored in numbers, no hallucination. Cost ~$0.018.

### Build / type checks

- `npm run typecheck` clean throughout
- `npm run build` succeeds

### Manual smoke (post-merge)

1. **Pre-Phase-2 transition** — visit /profile, see "Generate plan" CTA card.
2. **Click CTA** → redirected to /coach with intake mode active. Chat opens with Beat 1's first finding.
3. **Beat 1 sanity check** — goal contradiction surfaces first ("you're at 102, target 100 — suggested 115"). Tap "Use proposed target". Verify chat acknowledges + moves to next finding.
4. **Continue Beat 1** — sleep efficiency surfaces. Tap "Use suggested bedtime 22:30". Verify acknowledged.
5. **Beat 2** — coach probes goal narrative deeper. Free-text response. Verify next turn references it.
6. **Beat 3** — GLP-1 follow-up ("how long? goal weight?"). Free-text response.
7. **Beat 4** — chip turns for directness, cadence, chronotype, unprompted_actions.
8. **Beat 5** — "anything else?". Free-text "no, that covers it".
9. **propose_plan fires** — PlanProposalCard renders with 8 sections (Goal, Nutrition, Sleep, Strength template, Recovery, Coaching agreement, Athlete snapshot, Periodization).
10. **Inspect plan visually** — verify:
    - Goal target = 115kg (Beat 1 correction applied)
    - Bedtime = 22:00 or 22:30 (sleep correction applied + chronotype-derived adjustment)
    - Protein = ~166g (1.6g/kg BW, at clinical floor)
    - Refeed cadence = 6 days
    - Strength template = 4 sessions Mon/Tue/Thu/Fri
11. **Tap Approve** → `[approve:<token>]` sent, commit_plan fires, v2 → active.
12. **DB verification**:
    ```sql
    select version, status, jsonb_pretty(plan_payload) is not null as has_plan
    from athlete_profile_documents
    where user_id = '<user_id>'
    order by version desc;
    ```
    Expected: v2 active with plan populated, v1 superseded with plan null.
13. **Next morning's brief** — verify macros block shows `plan_payload.nutrition` values (195g protein, etc.), NOT `intake_payload.nutrition` (168g). Inspect `lib/morning/brief/get-today-targets.ts` log output or DB to confirm.
14. **Revision flow** — click "Revise plan" on /profile. Pre-fill form. Submit. Run intake chat again. Verify chat-elicited fields cleared (Beat 2 re-asks goal narrative, etc.). Verify Beat 1 doesn't re-fire previously-acknowledged overrides (handled by sanity_overrides carrying forward? — actually NO, they clear with chat fields; re-evaluated against new intake).

### Cost verification

Track Anthropic usage for the first acknowledgment ceremony. Expected: ~$0.05-0.07 total (chat + propose_plan + maybe 1 revision).

## Implementation handoff

Once approved, `/writing-plans` produces the task-by-task implementation plan. Estimated scope: ~18-22 tasks. Sequence:

1. Types (IntakePayload v2, PlanPayload, SanityFinding, ChatMode extension)
2. Approval token extension (action union)
3. Per-section composers (Snapshot, Goal, Periodization, Strength, Nutrition, Sleep, Recovery, Coaching Agreement) — split tasks
4. Sanity check (deterministic 4 checks)
5. Plan-builder orchestrator
6. Narrative prompt (Sonnet) + probe
7. Tools (11 new) + executors
8. INTAKE_PROMPT + planning-prompts.ts extension
9. Profile renderer extension (full plan markdown)
10. Chat API mode resolution
11. ChatPanel chip routing + reducer extensions
12. PlanProposalCard component
13. AthleteProfilePanel CTA extension
14. Morning brief `get-today-targets.ts` swap (~10 line patch)
15. End-to-end manual smoke + CLAUDE.md polish

## Phase 2 → Phase 3 design constraints

Phase 3 will add the drift-detection layer. Phase 2 design notes for Phase 3:

- `plan_payload.coaching_agreement.unprompted_actions_allowed` already enumerates the actions Phase 3 may take (`suggest_revisions`, `nudge_on_drift`, `flag_macros`, `flag_sleep`). Phase 3's drift-detection prompt enforces these.
- `plan_payload.concern_triggers` (nested in `sleep`) and `plan_payload.recovery.deload_triggers` are the data Phase 3 reads to fire drift alerts.
- `plan_payload.coaching_agreement.re_evaluation_cadence_weeks` drives Phase 3's stale-doc nudge (default 8 weeks).
- `training_blocks.athlete_profile_doc_id` FK (Phase 3 addition) will correlate blocks to the active plan version for retrospective analysis.
