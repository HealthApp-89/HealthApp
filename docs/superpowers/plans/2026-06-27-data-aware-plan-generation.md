# Data-Aware Plan Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI plan-builder consume the Phase 1 intelligence + responsiveness memory — flagging strategic conflicts for the athlete to resolve, and silently applying constraint/identity-aware exercise adjustments — while degrading to today's behavior whenever the data isn't there.

**Architecture:** A new pure `plan-intelligence-checks.ts` turns the `AthleteIntelligencePayload` + responsiveness summary into new `SanityFinding` union members that merge into the existing sanity-check findings list (Beat-1 chips + propose-gate). A single generic `resolve_plan_flag` tool records Accept/Override into `intake.plan_flag_resolutions`; accepted flags apply a deterministic softer value to the composer inputs in `buildPlanPayload`. `compose-strength` gains constraint-aware + identity-favoring exercise selection, recording each swap into a new additive `plan_payload.adjustments[]` field surfaced in the narrative. Intelligence is purely additive — any failure/sparse data → today's plan, unchanged.

**Tech Stack:** TypeScript (strict), Zod, vitest (node env), Supabase (read-only here). No new AI calls.

## Global Constraints

- Pure functions for all check/selection logic (no Supabase calls inside them); `buildPlanPayload` + the intake context builder do the I/O and pass data in. Mirrors `lib/coach/intelligence/` composers.
- **Graceful degradation is load-bearing:** if `buildAthleteIntelligence` throws or returns establishing/empty data, plan generation proceeds EXACTLY as today — no flags, no substitutions, no block. A null-intelligence regression test enforces this.
- Flags fire ONLY on conclusive data (never establishing baselines / empty history) — same no-fabrication discipline as Phase 1.
- Reuse, don't rebuild: consume `buildAthleteIntelligence(supabase, userId, tz)` ([lib/coach/intelligence/index.ts](../../../lib/coach/intelligence/index.ts)) and `summarizeResponsiveness` ([lib/coach/interventions/responsiveness.ts](../../../lib/coach/interventions/responsiveness.ts)) — do not re-query primaries.
- `SanityFinding` is a discriminated union by `type` in [lib/data/types.ts:693](../../../lib/data/types.ts) — extend it; the existing chip UX renders by `type`.
- No new AI calls. The single existing Sonnet narrative call ([lib/coach/plan-builder/narrative-prompt.ts](../../../lib/coach/plan-builder/narrative-prompt.ts)) is unchanged except it receives the recorded `adjustments[]` as extra context.
- The 265 Phase-1/interventions tests stay green; typecheck + `node scripts/audit-timezone-usage.mjs` clean.
- Commits per task: `feat: plan-data-aware: <thing>` / `test: ...`.
- Watch the worktree-stranding gotcha: every commit must land on the working branch (a feature branch off main), not a stray `worktree-agent-*`.

---

## File Structure

**New:**
- `lib/coach/plan-builder/plan-intelligence-checks.ts` — pure: `(intake, intelligence, responsiveness) → SanityFinding[]` (the 4 flags + enrichment)
- `lib/coach/plan-builder/apply-flag-resolutions.ts` — pure: `(composerInputs, intake.plan_flag_resolutions) → adjustedComposerInputs` (accepted flags' softer values)
- `lib/coach/plan-builder/constraint-aware-exercises.ts` — pure: `(plannedExercises, constraints, identity) → { exercises, adjustments[] }`
- `lib/coach/plan-builder/__tests__/plan-intelligence-checks.test.ts`
- `lib/coach/plan-builder/__tests__/constraint-aware-exercises.test.ts`
- `lib/coach/plan-builder/__tests__/graceful-degradation.test.ts`

**Modified:**
- `lib/data/types.ts` — add 4 `SanityFinding` members; add `intake.plan_flag_resolutions`; add `PlanPayload.adjustments`
- `lib/coach/plan-builder/index.ts` — fetch `buildAthleteIntelligence` (graceful-null), merge flags, apply resolutions, real-bodyweight, thread adjustments
- `lib/coach/plan-builder/compose-strength.ts` — call constraint-aware selection, return adjustments
- `lib/coach/planning-prompts.ts` (~441) — surface intelligence flags in the Beat-1 `sanity_findings` context
- `lib/coach/tools.ts` — add `resolve_plan_flag` tool; `executeProposePlan` gate already rejects on non-empty `sanity_findings` (flags ride that gate)
- `lib/coach/plan-builder/narrative-prompt.ts` — accept `adjustments[]`, mention in `strength_notes`

---

## Task 1: Types + Pure Intelligence Checks

**Files:**
- Modify: `lib/data/types.ts`
- Create: `lib/coach/plan-builder/plan-intelligence-checks.ts`
- Test: `lib/coach/plan-builder/__tests__/plan-intelligence-checks.test.ts`

**Interfaces:**
- Produces: `planIntelligenceChecks(args): SanityFinding[]` where
  `args = { intake: IntakePayload, intelligence: AthleteIntelligencePayload | null, responsiveness: ResponsivenessSummary | null }`.
  Returns `[]` when `intelligence` is null (graceful) or no flag's data is conclusive.

- [ ] **Step 1: Add the 4 SanityFinding members + resolution field**

In `lib/data/types.ts`, extend the `SanityFinding` union (after the existing members) with:

```typescript
  | {
      type: "goal_vs_recovery";
      recovery_status: "warning_overreach";
      proposed_opening_volume_pct: number;   // e.g. 0.8 = open 20% lighter
      rationale: string;
      responsiveness_note?: string;          // enrichment, optional
    }
  | {
      type: "deficit_vs_muscle_loss";
      muscle_loss_risk: "high";
      body_comp_direction: "losing_muscle" | "neutral" | "losing_fat" | "gaining_muscle" | "unknown";
      proposed_protein_floor_g_per_kg: number;
      rationale: string;
      responsiveness_note?: string;
    }
  | {
      type: "target_vs_adherence";
      target_field: "protein_g" | "kcal";
      recent_avg_g_per_kg: number;
      target_g_per_kg: number;
      proposed_ramp_weeks: number;
      rationale: string;
      responsiveness_note?: string;
    }
  | {
      type: "strength_endurance_interference";
      interference_level: "mild" | "high";
      proposed_strength_volume_pct: number;  // e.g. 0.9 = trim 10%
      rationale: string;
      responsiveness_note?: string;
    };
```

Add to the `IntakePayload` type a resolutions map (next to `sanity_overrides`):

```typescript
  /** Athlete decisions on data-aware plan flags. Missing = unresolved (blocks
   *  propose, like an unaddressed sanity finding). "accept" applies the flag's
   *  proposed softer value in buildPlanPayload; "override" proceeds as stated. */
  plan_flag_resolutions?: Partial<Record<
    "goal_vs_recovery" | "deficit_vs_muscle_loss" | "target_vs_adherence" | "strength_endurance_interference",
    "accept" | "override"
  >>;
```

Add to `PlanPayload` an additive adjustments field:

```typescript
  /** Auto-applied mechanical adjustments (constraint/identity-driven exercise
   *  swaps), surfaced for transparency. Empty when none applied. */
  adjustments?: { from: string; to: string; reason: string }[];
```

- [ ] **Step 2: Write failing tests for the 4 flags**

Create `lib/coach/plan-builder/__tests__/plan-intelligence-checks.test.ts`. Build a `makeIntelligence(overrides)` fixture (the `AthleteIntelligencePayload` shape — recovery_readiness/nutrition_performance/interference/body_comp_direction/constraints/identity). Cases:
- `goal_vs_recovery` fires when recovery_readiness.status==="warning_overreach" AND intake goal implies high volume; silent when recovery is "recovering_well".
- `deficit_vs_muscle_loss` fires when intake nutrition phase is a cut AND (muscle_loss_risk==="high" OR body_comp==="losing_muscle"); silent otherwise.
- `target_vs_adherence` fires when protein_status indicates chronic shortfall vs the stated/plan target; silent when adherent.
- `strength_endurance_interference` fires when interference_level is mild/high; silent when "none".
- `intelligence: null` → `[]` (graceful).
- establishing/sparse data (e.g. recovery_readiness with low confidence / status not conclusive) → no flag.
- a resolved flag (present in `intake.plan_flag_resolutions`) is NOT re-emitted (already addressed).
- responsiveness summary present → matching flag gets `responsiveness_note`; absent → no note, flag still fires.

- [ ] **Step 3: Run to verify fail.**

Run: `npx vitest run lib/coach/plan-builder/__tests__/plan-intelligence-checks.test.ts` → FAIL.

- [ ] **Step 4: Implement `plan-intelligence-checks.ts`**

Pure module. Each check is a small function returning `SanityFinding | null`; `planIntelligenceChecks` collects the non-null. Guard each on (a) `intelligence` non-null, (b) the relevant sub-field being conclusive (not establishing/unknown), (c) the flag not already in `intake.plan_flag_resolutions`. Compute the deterministic `proposed_*` softer values (e.g. `proposed_opening_volume_pct = 0.8`, `proposed_protein_floor_g_per_kg = max(stated, 1.8)`, `proposed_ramp_weeks = 3`, `proposed_strength_volume_pct = level==="high" ? 0.85 : 0.9`). Attach `responsiveness_note` from the responsiveness summary when a relevant outcome exists. Document each threshold inline.

- [ ] **Step 5: Run to verify pass + typecheck.**

- [ ] **Step 6: Commit**

```bash
git add lib/data/types.ts lib/coach/plan-builder/plan-intelligence-checks.ts lib/coach/plan-builder/__tests__/plan-intelligence-checks.test.ts
git commit -m "feat: plan-data-aware: intelligence-driven plan flags (pure) + types"
```

---

## Task 2: Wire Intelligence into buildPlanPayload + Beat-1 + resolve tool

**Files:**
- Modify: `lib/coach/plan-builder/index.ts`
- Create: `lib/coach/plan-builder/apply-flag-resolutions.ts` + test
- Modify: `lib/coach/planning-prompts.ts` (~441)
- Modify: `lib/coach/tools.ts` (`resolve_plan_flag` tool; verify the `executeProposePlan` gate)

**Interfaces:**
- Consumes: `planIntelligenceChecks` (Task 1), `buildAthleteIntelligence`, `summarizeResponsiveness`.
- Produces: `applyFlagResolutions(inputs, resolutions): adjustedInputs` (pure — applies accepted flags' softer values to the strength-volume multiplier + nutrition deficit/protein inputs); `resolve_plan_flag` chat tool writing `intake.plan_flag_resolutions`.

- [ ] **Step 1: Graceful intelligence fetch in buildPlanPayload**

In `index.ts`, add `buildAthleteIntelligence(supabase, userId, tz)` to the existing `Promise.all` BUT wrapped so its failure can't break the build: fetch it as `buildAthleteIntelligence(...).catch(() => null)` and likewise load the responsiveness summary (from the same `coach_interventions` rows or `summarizeResponsiveness`) guarded. Result types: `intelligence: AthleteIntelligencePayload | null`, `responsiveness: ResponsivenessSummary | null`.

- [ ] **Step 2: Merge flags into sanity_findings**

After computing `sanityFindings = runSanityChecks(...)`, append: `const flagFindings = planIntelligenceChecks({ intake, intelligence, responsiveness }); const allFindings = [...sanityFindings, ...flagFindings];` and return `sanity_findings: allFindings`. The existing `executeProposePlan` gate ([tools.ts:3942](../../../lib/coach/tools.ts)) already rejects when `sanity_findings.length > 0`, so flags ride that gate automatically — no gate change needed (verify it does).

- [ ] **Step 3: Apply accepted resolutions to composer inputs**

Create `apply-flag-resolutions.ts` (pure): given the composer inputs (strength volume scalar, nutrition deficit/protein inputs) + `intake.plan_flag_resolutions`, for each `"accept"`ed flag apply its softer value (goal_vs_recovery → multiply opening strength volume by `proposed_opening_volume_pct`; interference → multiply by `proposed_strength_volume_pct`; deficit_vs_muscle_loss → raise protein floor; target_vs_adherence → set a ramp flag the nutrition composer reads). `"override"` → no change. Call it in `index.ts` before invoking the composers. Test the pure function (accepted → adjusted; override → unchanged; absent → unchanged).

- [ ] **Step 4: Surface flags in Beat-1 intake context**

In `planning-prompts.ts` (~441), where `runSanityChecks` builds the `sanity_findings` context block: also fetch intelligence (guarded, same graceful-null) + call `planIntelligenceChecks`, and include the flag findings in the same `### sanity_findings` block so they surface as Beat-1 chips. (If this builder lacks supabase/userId/tz, thread them in — they're available in the caller.) Accept double-fetch with buildPlanPayload as acceptable (both guarded, parallel) — note it.

- [ ] **Step 5: Add the `resolve_plan_flag` tool**

In `tools.ts`, add one generic intake tool `resolve_plan_flag({ flag_type, decision })` that writes `intake.plan_flag_resolutions[flag_type] = decision` on the draft `athlete_profile_documents` row (mirror how the existing `set_sanity_override` / `apply_*` tools persist intake edits). Register it in the intake-mode tool set. The intake prompt already instructs the coach to surface findings + call the apply/override tools; add a one-line note that data-aware flags use `resolve_plan_flag`.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck`; `npx vitest run lib/coach/plan-builder/`; `npx vitest run lib/coach/intelligence/ lib/coach/interventions/` (265 green); `node scripts/audit-timezone-usage.mjs`.

```bash
git add lib/coach/plan-builder/index.ts lib/coach/plan-builder/apply-flag-resolutions.ts lib/coach/plan-builder/__tests__/apply-flag-resolutions.test.ts lib/coach/planning-prompts.ts lib/coach/tools.ts
git commit -m "feat: plan-data-aware: wire intelligence flags into intake + propose gate + resolve tool"
```

---

## Task 3: Constraint-Aware + Identity-Favoring Exercise Selection

**Files:**
- Create: `lib/coach/plan-builder/constraint-aware-exercises.ts`
- Test: `lib/coach/plan-builder/__tests__/constraint-aware-exercises.test.ts`
- Modify: `lib/coach/plan-builder/compose-strength.ts`

**Interfaces:**
- Produces: `applyConstraintAwareSelection(args): { exercises: PlannedExercise[]; adjustments: { from: string; to: string; reason: string }[] }` where `args = { exercises, constraints: ConstraintPayload, identity: IdentityPayload, getSubstitute }`.

- [ ] **Step 1: Write failing tests.** Cases: an exercise on `constraints.exercise_exclusions` (or injury-derived avoid list) is replaced by a pattern-matched substitute, with `{from,to,reason}` recorded; an equipment-unavailable exercise (per `constraints.equipment_access`) is substituted; an accessory with latitude is chosen from `identity.top_exercises` when available, recorded; no constraints + no identity → exercises unchanged, `adjustments: []`. Pure function — pass a stub `getSubstitute(name, {excludeJoint?, equipment?}) → name` so the test is deterministic (the real one wraps the existing exercise library / `get_substitutes`).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `constraint-aware-exercises.ts`** (pure). For each planned exercise: if excluded/injury-conflicting/equipment-unavailable, call `getSubstitute` and record the swap; else if it's a latitude accessory and an identity top-exercise fits the pattern, prefer it and record. Return adjusted exercises + adjustments. Reuse the existing exercise-library substitution helper (check `lib/coach/` for `get_substitutes` / the exercise library API) as the real `getSubstitute`; do not reinvent matching.

- [ ] **Step 4: Call it from `compose-strength.ts`.** `composeStrengthTemplate` gains optional `constraints?: ConstraintPayload` + `identity?: IdentityPayload` params (optional → graceful when intelligence absent). When present, run `applyConstraintAwareSelection` on the planned exercises and return the `adjustments` alongside the strength payload (thread them out so `buildPlanPayload` can put them on `plan_payload.adjustments`). When absent → today's behavior, `adjustments: []`.

- [ ] **Step 5: Run to verify pass + typecheck.**

- [ ] **Step 6: Commit**

```bash
git add lib/coach/plan-builder/constraint-aware-exercises.ts lib/coach/plan-builder/__tests__/constraint-aware-exercises.test.ts lib/coach/plan-builder/compose-strength.ts
git commit -m "feat: plan-data-aware: constraint-aware + identity-favoring exercise selection"
```

---

## Task 4: Real-Bodyweight Fix

**Files:**
- Modify: `lib/coach/plan-builder/index.ts`

- [ ] **Step 1: Replace the hardcoded fallback.** At `index.ts` (`const bodyweightForComposers = currentBodyweight ?? 80;`), prefer the real signal chain: `currentBodyweight ?? body_comp_recent_weight ?? <default>`, where `body_comp_recent_weight` comes from the intelligence body-comp data when present. Keep a final numeric default only when genuinely nothing is logged, and log when the default is used. Do NOT change behavior when a real weight exists.

- [ ] **Step 2: Verify + commit.** `npm run typecheck`; `npx vitest run lib/coach/plan-builder/`.

```bash
git add lib/coach/plan-builder/index.ts
git commit -m "feat: plan-data-aware: use real bodyweight before hardcoded fallback"
```

---

## Task 5: Thread Adjustments into Narrative + Plan Payload

**Files:**
- Modify: `lib/coach/plan-builder/index.ts`
- Modify: `lib/coach/plan-builder/narrative-prompt.ts`

- [ ] **Step 1: Put adjustments on the plan_payload.** In `index.ts`, set `plan_payload.adjustments = strengthAdjustments` (from Task 3). Empty array when none.

- [ ] **Step 2: Feed adjustments to the narrative.** Pass `adjustments` into `generatePlanNarrative` ([narrative-prompt.ts](../../../lib/coach/plan-builder/narrative-prompt.ts)); extend the system prompt so `strength_notes` states the swaps and why (e.g. "swapped OHP → landmine press given your shoulder") — observed-only, cite the recorded reason; say nothing when `adjustments` is empty. Keep the "DO NOT REPRODUCE NUMBERS" rule intact; this only adds the swap narration.

- [ ] **Step 3: Verify + commit.** `npm run typecheck`; `npx vitest run lib/coach/plan-builder/`; `npm run build`.

```bash
git add lib/coach/plan-builder/index.ts lib/coach/plan-builder/narrative-prompt.ts
git commit -m "feat: plan-data-aware: surface auto-adjustments in plan payload + narrative"
```

---

## Task 6: Graceful-Degradation Regression + Final Verification

**Files:**
- Create: `lib/coach/plan-builder/__tests__/graceful-degradation.test.ts`

- [ ] **Step 1: Write the regression test.** Prove the load-bearing safety rule with pure-function level coverage: `planIntelligenceChecks({ intake, intelligence: null, responsiveness: null })` → `[]`; `applyConstraintAwareSelection` with empty constraints + undefined identity → exercises unchanged, `adjustments: []`; `applyFlagResolutions` with empty resolutions → inputs unchanged. Assert that with all intelligence absent, the plan-shaping inputs are byte-identical to the no-intelligence baseline (today's behavior).

- [ ] **Step 2: Run the full gates.** `npm run typecheck`; `npx vitest run lib/` (report total — the prior 265 + new); `node scripts/audit-timezone-usage.mjs`; `npm run build`.

- [ ] **Step 3: Commit.**

```bash
git add lib/coach/plan-builder/__tests__/graceful-degradation.test.ts
git commit -m "test: plan-data-aware: graceful-degradation regression (intelligence-absent = today's plan)"
```

---

## Specification Coverage Checklist

- [x] Consume `buildAthleteIntelligence` + responsiveness (no re-query) → Task 2
- [x] 4 flags as SanityFinding members, conclusive-data-only → Task 1
- [x] Flags merge into existing sanity-check list (Beat-1 chips + propose gate) → Task 2
- [x] Accept applies softer value; Override proceeds (via `resolve_plan_flag` + `apply-flag-resolutions`) → Tasks 1,2
- [x] Responsiveness enrichment attaches when present → Task 1
- [x] Constraint-aware + identity-favoring exercise selection, recorded → Task 3
- [x] Real-bodyweight fix → Task 4
- [x] `plan_payload.adjustments[]` additive field + narrative transparency → Tasks 1,5
- [x] Graceful degradation (intelligence absent → today's plan) → Task 2 (guards) + Task 6 (regression)
- [x] No new AI calls; pure + fixture-tested; 265 tests green → all tasks

## Notes for Execution

- Tasks are sequential (1→2→3→5; 4 independent; 6 last). Each ends testable.
- Reuse: `buildAthleteIntelligence`, `summarizeResponsiveness`, the existing exercise-library `get_substitutes`. Don't reinvent.
- Optional composer params (`constraints?`, `identity?`) keep `compose-strength` graceful when intelligence is absent — this is how today's behavior is preserved.
- The flags ride the EXISTING propose-gate (`sanity_findings.length > 0` rejects) — confirm, don't add a parallel gate.
- This sub-project must not touch `lib/coach/intelligence/**` or `lib/coach/interventions/**` (consume only). If a change seems to need editing those, stop and flag it.
