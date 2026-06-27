# Data-Aware Plan Generation — Design Spec

**Date:** 2026-06-27
**Phase:** 3, sub-project #3-A (first of three: A data-aware → B endurance pillar → C adaptive re-planning)
**Status:** Approved design, ready for implementation plan

---

## Problem

The AI plan-builder (`lib/coach/plan-builder/`) works end-to-end and is sound — 8 deterministic composers produce every prescription, a single Sonnet call only writes the prose, and the 5-beat chat intake with its 4 sanity-checks is complete. But it **predates the Phase 1 intelligence layer and the Phase 3 #1 responsiveness memory**, and consults neither. It reads only what the athlete *typed* in the intake form (plus raw recent workouts/logs for e1RM and bodyweight).

Result: the plan is **intent-driven, not data-driven**. An athlete can request an aggressive cut and the plan will prescribe it without noticing recent recovery is flagging overreach, protein adherence has been poor, or body-composition is already trending toward muscle loss. And the strength template can prescribe movements the athlete's injury history excludes.

This sub-project makes plan generation consume the intelligence we already built — closing the loop between "the coach understands you" and "your plan reflects that."

## Goal

At plan-generation time, cross-check the athlete's stated intent against what their data shows, using the existing intelligence. Surface strategic conflicts as Accept/Override flags (athlete decides); silently apply the unambiguous mechanical adjustments (constraint-aware exercise selection, identity-favoring, real bodyweight) and show what changed.

## Non-Goals (this sub-project)

- Endurance prescriptions in the plan — **sub-project B**.
- Adaptive re-planning at block close / goal drift — **sub-project C**.
- Auto-tuning the nutrition *deficit math* — strategic nutrition is *flagged*, not silently changed.
- Periodization-by-athlete-level variation, TDEE calibration — separate, lower-impact, out of scope.
- No new UI — flags reuse the existing sanity-check chip flow; adjustments surface in the existing narrative.
- No new AI calls — checks and adjustments are deterministic; the single existing Sonnet narrative call is unchanged (it just receives the recorded adjustments as additional context).

---

## Architecture

The data-awareness lands in exactly **two seams**; everything else in the plan-builder is unchanged.

**1. Flags → extend the existing sanity-check layer.**
`buildPlanPayload` ([lib/coach/plan-builder/index.ts](../../../lib/coach/plan-builder/index.ts)) calls the existing `buildAthleteIntelligence(supabase, userId, tz)` ([lib/coach/intelligence/index.ts](../../../lib/coach/intelligence/index.ts)) once, parallel with its current fetches. A new pure module `lib/coach/plan-builder/plan-intelligence-checks.ts` takes `(stated intent from intake_payload, AthleteIntelligencePayload, responsiveness summary)` and emits new finding objects that merge into the **same** findings list that today carries the 4 sanity-checks ([lib/coach/plan-builder/sanity-check.ts](../../../lib/coach/plan-builder/sanity-check.ts)). They surface through the **same** Beat-1 Accept/Override chip UX — no new UI.

**2. Auto-adjust → feed the composers.**
`compose-strength` ([lib/coach/plan-builder/compose-strength.ts](../../../lib/coach/plan-builder/compose-strength.ts)) receives `constraints` (injuries/exclusions/equipment) + `identity.top_exercises` and applies them silently, recording each substitution. The orchestrator replaces the hardcoded `80` kg bodyweight fallback with real body-comp/recent-weight data.

**Reuse, not rebuild:** all the analysis already exists in `buildAthleteIntelligence` (identity, constraints, recovery_readiness, nutrition_performance, interference, body_comp_direction) + the responsiveness memory. The plan-builder only consumes it.

---

## The Flags (judgment calls → Accept/Override chips)

Each fires ONLY when its data is conclusive (never on establishing baselines or empty history — same no-fabrication discipline as the rest of the system). Each follows the existing sanity-check shape: a finding `type`, a human-readable message, an **Accept** action (applies the proposed softer value), an **Override** action (proceed as stated, recorded via the existing `set_sanity_override` path).

1. **goal_vs_recovery** — stated goal implies high volume/intensity AND `recovery_readiness.status === "warning_overreach"`. Accept → start with a phase-down / reduced opening volume. Override → proceed.

2. **deficit_vs_muscle_loss** — nutrition phase is a cut AND (`nutrition_performance.predicted_muscle_loss_risk === "high"` OR `body_comp_direction.direction === "losing_muscle"`). Accept → soften deficit / raise protein floor. Override → proceed.

3. **target_vs_adherence** — plan sets a protein/kcal target AND `nutrition_performance.protein_status` shows chronic shortfall against targets. Accept → stepped ramp toward the target. Override → commit to full target.

4. **strength_endurance_interference** — plan prescribes high strength volume AND `interference.interference_level` is `mild`/`high`. Accept → trim the conflicting load. Override → proceed.

5. **responsiveness_context** *(enrichment, not standalone)* — when `summarizeResponsiveness` / coach-history has a relevant evaluated outcome, it attaches as evidence to the matching flag above (e.g. "...and the last aggressive cut didn't stick for you"). Empty until the `coach_interventions` data accrues; adds nothing when absent.

Each Accept action needs a deterministic "softer value" the composer can consume (e.g. reduced opening volume %, protein floor bump, stepped-ramp target). These are pure functions of the stated value + the flagged signal.

---

## The Auto-Adjustments (mechanical, no ask — but transparent)

1. **Constraint-aware exercise selection** — `compose-strength` never prescribes a movement on the avoid-list (`constraints.active_injuries`-derived + `constraints.exercise_exclusions`) and respects `constraints.equipment_access`. When the template would include an excluded/unavailable exercise, substitute the closest pattern-matched alternative using the existing exercise library + `get_substitutes` ([lib/coach/](../../../lib/coach/)). Record `{ from, to, reason }` for each swap.

2. **Identity-favoring** — where the template has latitude (accessory choice within a movement pattern), favor lifts in `identity.top_exercises`. Record the choice when it diverges from the default.

3. **Real bodyweight** — orchestrator uses the actual recent weight / `body_comp_direction` data; falls back to the default only when nothing is logged.

**Transparency requirement:** every recorded adjustment is threaded into the narrative prompt so `strength_notes` states what changed and why (e.g. "swapped OHP → landmine press given your shoulder; kept your usual RDL"). Auto ≠ black box. This matches the cite-your-reasoning discipline the coaches already follow. The adjustments record also persists on the `plan_payload` (a small `adjustments: []` field) so the change is durable, not just prose.

---

## Data Flow

```
buildPlanPayload(supabase, userId, tz, intake)
  ├─ Promise.all([ existing fetches..., buildAthleteIntelligence(supabase,userId,tz) ])   // intelligence added, parallel
  ├─ planIntelligenceChecks(intake, intelligence, responsiveness) → flagFindings[]          // pure
  ├─ findings = [...existingSanityChecks, ...flagFindings]                                   // merged → Beat-1 chips
  │     athlete Accept/Override resolves each → resolved values feed composers
  ├─ composeStrength(intake, ..., constraints, identity) → strength + adjustments[]          // auto-adjust + record
  ├─ bodyweight = realRecentWeight ?? body_comp ?? default                                   // real-bodyweight fix
  └─ narrative(skeleton + adjustments) → strength_notes mentions swaps                        // transparency
```

`plan_payload` gains one additive field: `adjustments: { from, to, reason }[]` (the recorded auto-swaps). Everything else in `PlanPayload` is unchanged.

---

## Error Handling & Graceful Degradation (load-bearing)

Intelligence is **purely additive**. If `buildAthleteIntelligence` throws, or returns establishing/empty data, plan generation proceeds **exactly as today** — no flags, no substitutions, no block. The feature can NEVER prevent a plan from being generated.

- `buildAthleteIntelligence` call wrapped so failure → null → checks/adjustments skipped, current behavior.
- Each flag fires only on conclusive data; sparse/establishing → no flag.
- No constraints → no substitution → today's template.
- Responsiveness empty → no enrichment.

---

## Testing

- **Pure fixture tests** (Phase 1 style, vitest) for `plan-intelligence-checks.ts`: each of the 4 flags fires on its trigger condition AND stays silent on (a) clean data, (b) establishing/sparse data. Responsiveness enrichment attaches only when present.
- **Pure fixture tests** for the constraint-aware/identity selection in `compose-strength`: an excluded exercise is substituted + recorded; equipment-unavailable substituted; identity-favored accessory chosen; no-constraints → unchanged template.
- **Regression:** the existing plan-builder behavior is preserved when intelligence is absent (a test with null intelligence produces today's plan). Phase 1 + interventions 265 tests stay green; typecheck + timezone audit clean.

## Risks & Mitigations

- **Over-flagging / nagging** → flags fire only on conclusive data + a bounded set of 4; each is Accept/Override (one tap). Mitigated by the no-thin-data rule.
- **Bad auto-substitution** → reuse the existing, tested exercise-library substitution (`get_substitutes`), pattern-matched; record + surface every swap so the athlete sees and can manually change it.
- **Blocking plan generation** → graceful degradation is the explicit safety rule; a null-intelligence regression test enforces it.

## Build Order (for the plan)

1. `plan-intelligence-checks.ts` pure module + tests (the 4 flags + responsiveness enrichment, consuming the intelligence payload shape).
2. Wire `buildAthleteIntelligence` into `buildPlanPayload` (parallel fetch, graceful-null) + merge flag findings into the sanity-check list.
3. Constraint-aware + identity-favoring selection in `compose-strength` + `adjustments[]` record + tests.
4. Real-bodyweight fix in the orchestrator.
5. Thread `adjustments[]` into the narrative prompt + add the `plan_payload.adjustments` field.
6. Graceful-degradation regression test + final review.
