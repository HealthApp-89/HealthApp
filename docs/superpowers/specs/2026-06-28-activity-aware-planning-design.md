# Activity-Aware Planning & Adaptation — Design Spec

**Date:** 2026-06-28
**Phase:** 3, sub-projects #3-B (proactive) + #3-C (reactive), combined — they share one foundation and ship as one phased build.
**Status:** Approved design, ready for implementation plan

---

## Problem

The training plan is blind to the athlete's **self-directed activities** — padel, running, cycling — and the fatigue/soreness they create. These aren't coach-prescribed; they're life. But they impose real training cost: padel hammers legs + lower back + shoulders; running is high-impact leg load; cycling is leg load with low eccentric damage. Today:
- Nothing lets the athlete say "I play padel Tuesday" so the week can be planned around it.
- Soreness IS captured (morning intake `soreness_areas`/`soreness_severity`) and partly used (the brief's all-or-nothing swap-to-mobility), but never reaches the prescription engine or per-exercise tuning.
- Strava captures padel/running/cycling but lumps racquet sports into a generic "other" and only rolls load into a daily total; the plan can't reason about *which* muscles an activity hit or *how hard*.

Result: heavy legs can land the day after a hard padel match (worse session, injury risk to the lumbar spine), and the plan has no graded way to respond when the athlete shows up sore.

## Goal

Make the weekly plan **activity-aware**, two ways:
- **Proactive (#3-B):** know the athlete's upcoming activities and arrange the strength week around them (separation-first), so interfering loads don't stack.
- **Reactive (#3-C):** when soreness or recent activity load actually conflicts with today's session, adapt with a *graded* autoregulation ladder, not all-or-nothing.

Both rest on one new **activity load-profile model** and learn from outcomes via the #3-#1 responsiveness memory.

## Research basis (why this shape)

- **Interference effect / concurrent training** (Hickson; Wilson et al. 2012 meta; Schumann/Coffey-Hawley reviews): competing endurance/impact work blunts strength adaptation, worst when (a) same muscle group, (b) sessions close in time, (c) high eccentric/impact modality (running/padel > cycling), (d) high volume. Practical consensus: **≥~24–48h separation between hard same-region stressors**; if same day, quality strength first.
- **DOMS time-course:** eccentric/intermittent damage peaks ~24–72h with reduced force/power/ROM; training a still-damaged muscle hurts quality and raises injury risk (lumbar especially, stacking axial load).
- **Autoregulation** (RIR/RPE-, velocity-, HRV-, readiness-guided): adjusting load/volume to daily readiness matches or beats fixed plans for strength while reducing overreach/injury. Preferred lever escalation: **load → volume → exercise swap → session swap.**
- **Weekly load management** (Foster monotony; acute:chronic ratio): stacking hard stressors back-to-back drives injury/illness risk; spread and alternate hard/easy.
- *Caveat:* the absolute interference magnitude for a recreational lifter is modest/manageable; the **scheduling + autoregulation principles are the settled part**, and intensity-scaling (a social hit ≠ a match) is essential — activities are never "high cost by design," only "high cost when done hard."

---

## Foundation (shared by #3-B and #3-C)

### Activity load-profile model — `lib/coach/activity/` (pure)

Two separable parts, because magnitude is intensity-driven but the movement pattern is not:

- **Regions (intrinsic, fixed per activity):** which muscle areas the pattern loads.
  - padel → legs + lower_back + shoulders
  - running → legs + impact
  - cycling → quads (low eccentric)
  - swim / other → varies (low–moderate, default conservative)
- **Magnitude + recovery window (computed from intensity):** `light → low cost / short window (~12–24h)` … `hard → high cost / long window (~36–48h)`. The recovery window is a function of intensity, never hardcoded.

The model exposes pure helpers: `activityRegions(type)`, `recoveryWindowHours(type, intensity)`, and `regionOverlap(activityRegions, sessionRegions)` (the overlap math both A and B use). Unknown type → neutral profile (no regions, zero window) → no action.

### Planned activities — capture into one normalized list

One shape: `{ date, type, intensity_estimate: "light"|"moderate"|"hard", source: "recurring"|"manual"|"detected" }`. Three sources:
- **Recurring** — a pattern on `profiles` ("padel Tue+Thu evening, typical intensity moderate"), materialized into each upcoming week.
- **Per-week manual** — a quick add to a specific week ("this Saturday: long ride, hard").
- **Auto-detected** — read at planning/brief time from `endurance_activities` (sport + TSS → type + intensity) and WHOOP `daily_logs.strain` spikes; merged with the declared list (declared wins on the same date+type).

**Storage:** `training_weeks.planned_activities jsonb` (mirrors the existing `endurance_session_plan` column) holds declared/materialized items; detected items are merged read-time, not stored. Recurring pattern lives on `profiles`. Row shapes mirrored in `lib/data/types.ts`.

**Capture UI (lightweight, no new top-level page):** a "this week's activities" strip on the week/strength view (quick add + intensity chips); the recurring pattern set once on `/profile`.

---

## #3-B — Proactive sequencing (`prescribeWeek` + swap engine)

The Sunday `prescribeWeek` (and mid-week swaps) reads the week's normalized activity list + the model and arranges the strength week:

1. **Conflict detection (both directions):** for each activity, find heavy strength sessions loading *overlapping regions* within the activity's recovery window — checking the day *before* (pre-fatigue) and *after* (training damaged tissue). Padel Tuesday flags adjacent heavy-legs Monday and Wednesday; ignores a push day.
2. **Resolution ladder — separation first:**
   - **(1) Move** the heavy lower-body session to open the recovery window, if `lifestyle.days_available` allows. Preferred (separation > lightening).
   - **(2) Lighten** — if the week can't be rearranged, trim volume/load on the overlapping region or shift emphasis to non-overlapping muscles.
   - **(3) Flag** — if unresolvable, surface with rationale via the #3-A Accept/Override chip mechanism.
3. **Magnitude-gated:** does *less* for light activities (social padel ~12h → likely no change; competitive match ~48h → strong separation; cycling vs legs → minimal). Prevents nagging over casual sessions.
4. **Priority-block aware:** if the current block's focus *is* the conflicting region (e.g. a leg block), separation matters more (protect the key adaptation), and frequent hard conflicting activity becomes a strategic flag ("your padel is competing with your leg block"). Non-priority overlap is sequenced quietly.
5. **Output:** a proposed week layout with plain rationale ("Moved Legs → Thursday — padel Tue + Fri"). Whole-week change → **propose-then-confirm** (reuses the weekly-review commit + the existing `/api/training-weeks/[week_start]/swap` engine, which already recomputes `session_prescriptions`). The planner picks the research-preferred resolution; the athlete can adjust.

---

## #3-C — Reactive autoregulation ladder (morning brief + session annotation)

Each morning, the reactive engine reads today's intake (sore regions, severity, fatigue), recent actual activity (auto-detected intensity + planned list), and today's planned session regions, then selects a rung by **severity × activity intensity**:

- **Mild overlap → load down** (RIR shave / ~5–10% on affected lifts).
- **Moderate → volume down** (cut 1–2 sets on overlapping movements).
- **High → swap the exercise** to a non-overlapping / less-axial pattern (sore lower back → deadlift → supported/machine variant), reusing `get_substitutes` with the sore region excluded.
- **Severe → swap the day** (sharp soreness on today's primary region, or a hard activity still inside its recovery window) — the existing swap-to-mobility / day swap.

This **replaces the blunt `pickCoachSuggestion`** (currently top-rung only) with the full ladder, surfaces as the morning-brief suggestion chip (Accept/adjust), and threads sore-region context into `annotateSession` so the session card itself shows reduced targets — not just a separate suggestion.

**Closes the loop with #3-#1:** each reactive adjustment is logged as a `coach_interventions` intervention (the existing table), so the #3-#1 swap-outcome evaluator measures whether the adjustment actually resolved the soreness. Over weeks the responsiveness memory learns *this athlete's* recovery pattern and tunes how aggressively to autoregulate.

---

## Graceful Degradation (load-bearing, same rule as #3-A)

Activity-awareness is purely additive. With **no planned activities and no soreness**, the Sunday plan and the morning brief produce output **byte-identical to today**. Unknown activity type → neutral profile → no action. Strava/WHOOP absent → fall back to declared intensity + morning soreness only. Nothing here can block plan generation or the brief. A regression test enforces the byte-identical-when-absent property.

## Reuse, don't rebuild

`prescribeWeek`, the `/api/training-weeks/[week_start]/swap` engine, `pickCoachSuggestion` (morning brief assembler), `annotateSession` (session-structure), `get_substitutes` / exercise library, the recovery-intelligence subjective series (soreness aggregation), and the #3-#1 `coach_interventions` evaluator. Consume the Phase 1 interference checker's signal where useful. Do not duplicate.

## Testing

- Pure fixture tests: the activity model (regions, intensity→recovery, overlap), the conflict-detection + resolution ladder (move/lighten/flag, both-direction, magnitude-gated, priority-aware), the reactive rung-selection (severity×intensity → correct rung).
- Graceful-degradation regression: no activities + no soreness ⇒ plan + brief output byte-identical to pre-feature.
- Keep the existing plan-builder / intelligence / interventions suites green; typecheck + timezone audit clean.

## Risks & Mitigations

- **Over-rearranging the week / nagging** → magnitude gating + propose-then-confirm + flags fire only on conclusive conflict.
- **Wrong auto-detected intensity** → declared intensity wins; detection is a fallback; reactive ladder is also gated by *actual* morning soreness, not just detected load.
- **Blocking the plan/brief** → graceful degradation is explicit + regression-tested.
- **Padel mis-modeled as fixed-high** → intensity drives magnitude; the region set is the only fixed part.

## Build Order (phased, for the plan)

1. **Foundation:** activity model (`lib/coach/activity/`, pure) + types + `training_weeks.planned_activities` + recurring-pattern profile field (migration). Tests.
2. **Capture:** recurring pattern on `/profile`; per-week strip on the week/strength view; auto-detect merge (read endurance_activities + strain). Normalized read helper.
3. **#3-B proactive:** conflict-detection + resolution ladder in `prescribeWeek`; propose-then-confirm wiring through the swap engine + weekly review; magnitude + priority gating.
4. **#3-C reactive:** graded ladder replacing `pickCoachSuggestion` top-rung; thread sore-region context into `annotateSession`/prescriptions; log adjustments as `coach_interventions`.
5. **Graceful-degradation regression + final review.**
