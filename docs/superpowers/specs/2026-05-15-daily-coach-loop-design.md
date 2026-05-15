# Daily Coach Loop — Design

**Date:** 2026-05-15
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #2 of the "coach-as-real-coach" arc. Builds on sub-project #1 (Weekly Review Document, shipped 2026-05-15) by feeding the just-committed weekly review's prescription into the morning brief's daily Advice block. The remaining three sub-projects — Coach Tab UX + tool-discovery (#3), Proactive reach-out (#4), Trend layer (#5) — are deferred.

## Problem

The morning brief's Advice block (`lib/morning/brief/advice-prompt.ts`, single Haiku 4.5 call, shipped earlier in the V2 effort) produces a daily prose paragraph grounded in pre-computed flags (readiness band, GLP-1 status, missed protein, sleep efficiency, sick flag, alcohol low-readiness, active injuries). What it does **not** see:

- The just-committed week's per-lift prescription (deadlift 87.5×6×3 RIR 2, squat 92.5×8×3 RIR 2, etc. — sitting in `training_weeks.session_plan` since Sub-project #1's commit flow).
- The active block's periodization phase (MEV / MAV / MRV / Deload) and week number.
- Yesterday's per-set rep completion vs target.
- Yesterday's session-level adherence (did the user hit prescribed sets×reps, or fall short?).
- The weekly review's narrative rationale ("MAV phase begins this week — bench held due to form notes").

The result is a brief that says "trained yesterday, sleep was fine, eat your protein" instead of "yesterday's squat was 2 reps short on the top set — fatigue, not load — today's deadlift is your MAV bump, push for a clean 6."

A real coach reading the same data would tie the day to the week's prescription, name the periodization phase in plain language, and connect yesterday's signals to today's action. None of that happens today.

This spec covers the Daily Coach Loop: extending the morning brief to fire one adaptive card per day — a **kickoff variant on Monday** (anchors the week's targets, explains phase transitions) and an **analytical variant on Tue–Sat** (yesterday's per-lift performance + today's specific prescription, framed by phase). Same `chat_messages.kind='morning_brief'` row, same single Haiku call, evolved `ui` jsonb with a `variant` discriminator. Teaching tone baked into the AI prompt: jargon (MEV/MAV/MRV/RIR/e1RM/efficiency) defined in plain English on first use each day, phase transitions explained when they happen. Two new UI section components (`BriefThisWeekPlan`, `BriefYesterdayVsPlan`) and one extension to `BriefSessionList`. No new data tables, no new API endpoints, no push notifications.

## Goals

1. **Make the daily Advice grounded in numbers.** The Advice prompt sees this-week's prescription, yesterday's per-set performance, the active phase. On Tue–Sat the prose references specific loads ("push 87.5 × 6 on deadlift today"); on Mon it names the phase and explains what it asks of the athlete.
2. **Single adaptive `morning_brief` card per day.** No new chat card kinds. `ui` jsonb gains a `variant: 'kickoff' | 'analytical' | 'rest'` discriminator. Mon ⇒ `kickoff`, Tue–Sat (training) ⇒ `analytical`, Tue–Sat (rest) ⇒ `rest` (existing behavior).
3. **One Anthropic call per brief.** Stay with Haiku 4.5 (~$0.0005/day). The cost and latency profile of the brief does not change. The fabricated-number validator from `lib/morning/brief/advice-prompt.ts` continues to apply.
4. **Teacher tone in the prompt.** Two new system-prompt rules:
   - **Always-define-jargon-on-first-use:** define MEV / MAV / MRV / RIR / deload / e1RM / efficiency in 5–10 words of plain English the first time they appear in any single turn.
   - **Phase-transition-explainer:** when `block_phase_next !== block_phase_now`, open the kickoff with a 1-sentence plain-language explanation of the new phase. Triggered on Mon when the prior week's review committed a phase change.
   The same always-define rule is retrofit to Sub-project #1's `narrative-prompt.ts` as a small follow-up (~5 lines of system prompt).
5. **New structured layer on Tue–Sat.** Two new ui fields and two new components:
   - `yesterday_vs_plan` field + `BriefYesterdayVsPlan.tsx` — per-lift table of planned (load × sets × reps) vs actual + rep-completion %.
   - `BriefSessionList.tsx` extension — display per-lift load + RIR target for big-four lifts inline with the existing exercise list.
6. **New kickoff layer on Monday.** One new ui field and one new component:
   - `this_week_plan` field + `BriefThisWeekPlan.tsx` — phase banner, per-lift week-loads mini-table, per-muscle volume targets summary, weekly_focus excerpt from the committed weekly review.
   The block replaces `BriefYesterdayVsPlan` on Monday (one block kind per day in that slot).
7. **Graceful degradation when prerequisites are missing.** If no committed week, no committed weekly review, or no logged workout yesterday, the brief falls back to the existing generic Advice — but logs a warning so the gap is observable. The card never breaks.
8. **No new mutations.** Brief generation is read-only against `training_weeks`, `weekly_reviews`, `workouts`, `daily_logs`, `checkins`, `athlete_profile_documents`. Insert is unchanged (same `chat_messages` row).

## Non-Goals

- **Post-workout debrief.** When the user logs a workout in the evening, no separate "session debrief" card fires. Yesterday's session is reviewed in tomorrow morning's brief, not in real time. Defer to a future spec if usage shows demand.
- **Live mid-day updates.** The brief is generated once at morning intake time and stays in the chat history. Not re-rendered as data arrives later in the day.
- **Push notifications.** Sub-project #4 territory. The morning intake bot trigger remains the only path to a fresh brief.
- **Tooltips / glossary popovers.** Tap-to-explain on phase labels, RIR pills, etc. — that's UI work, belongs to Sub-project #3 (Coach Tab UX shell + tool-discovery). The teaching in this spec is purely *contextual via prose*.
- **Restructuring the existing brief shape.** No removal of `BriefRecapStats` / `BriefMacrosGrid` / `BriefTonight` / `BriefAdvice`. The new blocks are additive.
- **Per-set rep tracking from accessory lifts.** `BriefYesterdayVsPlan` covers only the big-four (Squat / Deadlift / Decline Bench / OHP). Accessories progress on rep targets and are out of scope for the per-lift analysis layer.
- **Block transitions in the kickoff.** End-of-block (Week 5 → next block) goes through the existing `setup_block` chat mode. The Monday brief in a deload week renders the deload phase as the upcoming week; block-end orchestration is Sub-project #1's `setup_block` flow.
- **Manual brief regeneration.** Once the brief is delivered, it's final for the day. Existing `regenerate_morning_brief` tool (from earlier work) remains the only retry path; no new regeneration affordance for the new variants.
- **Multi-user generalization.** Single-user app.

## Architecture overview

Pipelined inside the existing morning intake flow. When the bot writes the final intake answer (existing pattern from Sub-project Morning Brief), the assembler picks the variant based on `weekdayInUserTz()`:

```
                User finishes morning intake (existing flow)
                                    │
                                    ▼
                  assembler.ts: pick variant
                                    │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
           Monday               Tue–Sat                 Rest day
        (training)             (training)
              │                    │                    │
              ▼                    ▼                    ▼
        variant='kickoff'    variant='analytical'    variant='rest'
              │                    │                    │
              ▼                    ▼                    ▼
   getThisWeekPrescription   buildYesterdayVsPlan      (unchanged)
   (new helper)              (new composer)
              │                    │                    │
              └────────────────────┴────────────────────┘
                                    │
                                    ▼
                    advice-prompt.ts (rewrite):
                    - kickoff branch: cite this_week_plan
                    - analytical branch: cite yesterday_vs_plan + today
                    - rest branch: unchanged
                    - teacher-tone rules apply to all branches
                                    │
                                    ▼
                    Single Haiku 4.5 call → narrative_md
                                    │
                                    ▼
                    Validate-no-fabricated-numbers (existing)
                                    │
                                    ▼
              Insert chat_messages row with:
                kind='morning_brief'
                ui={ variant, recap, readiness, session, macros,
                     advice, tonight,
                     this_week_plan?, yesterday_vs_plan? }
```

The five `lib/morning/brief/` files that change:

| File | Change |
|---|---|
| `data-sources.ts` | + new export `getThisWeekPrescription(supabase, userId)`: reads the current week's `training_weeks` row and the latest `committed` `weekly_reviews` row for that `week_start`. Returns null on either miss. |
| `yesterday-vs-plan.ts` (new) | Pure composer. Inputs: yesterday's `workouts` row + yesterday's planned `training_weeks.session_plan` entry. Output: `Array<{ lift, planned, actual, reps_completed_pct, rir_target_met }>` for big-four lifts. |
| `assembler.ts` | Pick variant by weekday. Populate `this_week_plan` (Mon) or `yesterday_vs_plan` (Tue–Sat) into the ui. Pass the variant + payload into advice-prompt. |
| `advice-prompt.ts` | Branch on variant. Two new system-prompt rules (jargon-define + phase-explainer). Fabricated-number validator continues. |
| `flags.ts` | + new derived flag `phase_transition_this_week: boolean` (true when `block_phase_now !== block_phase_next` per the active weekly_review's payload header). Used by the kickoff prompt branch. |

UI changes (three components in `components/morning/`):

| File | Change |
|---|---|
| `BriefThisWeekPlan.tsx` (new) | Renders kickoff block: phase pill, per-lift mini-table (4 rows × this-week-load × RIR), per-muscle volume strip, weekly_focus excerpt. |
| `BriefYesterdayVsPlan.tsx` (new) | Renders Tue–Sat block: per-lift table of planned vs actual + rep-completion %. |
| `BriefSessionList.tsx` | Extend existing block: show per-lift load + RIR for big-four lifts inline with the exercise list (small UI extension, ~10 lines). |
| `MorningBriefCard.tsx` | Dispatcher: render `BriefThisWeekPlan` if `variant==='kickoff'`, `BriefYesterdayVsPlan` if `variant==='analytical'` and `yesterday_vs_plan` populated. Other blocks unchanged. |

## Data model

**No new tables. No migration.** Brief generation reads from existing tables only.

**Extended `MorningBriefCard` type** (in `lib/data/types.ts`, extending the existing shape from migration 0011):

```ts
export type MorningBriefVariant = "training" | "rest" | "kickoff" | "analytical";
// "training" is the legacy variant (back-compat); "kickoff" and "analytical"
// are the new sub-project-#2 variants. "rest" is unchanged.

export type ThisWeekPlanBlock = {
  schema_version: 1;
  week_n: number;
  total_weeks: number;
  phase_now: WeeklyPhase;      // 'mev' | 'mav' | 'mrv' | 'deload'
  phase_changed_this_week: boolean;
  per_lift: Array<{
    lift: string;              // "Deadlift (Barbell)" — matches SESSION_PLANS keys
    load_kg: number;
    sets: number;
    reps: number;
    rir_target: number | null;
    delta_from_last_week_pct: number | null;
  }>;
  volume_summary: Array<{
    muscle: string;
    sets: number;
    tier: "mev" | "mav" | "mrv";
  }>;
  weekly_focus: string | null;     // from the committed weekly review
};

export type YesterdayVsPlanBlock = {
  schema_version: 1;
  per_lift: Array<{
    lift: string;
    planned: { load_kg: number; sets: number; reps: number; rir_target: number | null };
    actual: { top_set_load_kg: number | null; sets_done: number; total_reps_done: number } | null;
    reps_completed_pct: number | null;  // null when no logged workout
    rir_target_met: boolean | null;
  }>;
  session_logged: boolean;          // false when no workouts row for yesterday
  swap_applied: boolean;            // true when yesterday's session was a swap from original_session_plan
};

// MorningBriefCard ui shape (extends the existing) — both new blocks optional
export type MorningBriefCard = {
  schema_version: 1;
  variant: MorningBriefVariant;
  recap: MorningBriefRecap;
  readiness: MorningBriefReadiness;
  session: MorningBriefSession | null;           // existing — kept for the training-day list
  macros: MorningBriefMacros;
  advice_md: string;
  tonight: MorningBriefTonight;
  this_week_plan?: ThisWeekPlanBlock | null;     // populated when variant='kickoff'
  yesterday_vs_plan?: YesterdayVsPlanBlock | null;  // populated when variant='analytical'
};
```

**Back-compat note:** existing brief rows have `variant: 'training' | 'rest'` and no `this_week_plan` / `yesterday_vs_plan`. The dispatcher in `MorningBriefCard.tsx` handles all four variants explicitly; the legacy `'training'` variant renders without the new blocks (matches today's behavior).

## AI prompt design

Single Haiku 4.5 call per brief. The system prompt branches on `variant`. Common tone rules applied across all variants:

**Common system prompt — teacher tone (new):**

```
TONE & TEACHING RULES (applies to every reply):
1. Second person, conversational. "You" not "the athlete".
2. On first mention in this reply, define jargon in 5-10 words of plain English:
   - MEV → "the minimum weekly sets that drive growth"
   - MAV → "the productive volume range"
   - MRV → "your weekly recovery ceiling"
   - RIR → "reps you could still do at the same weight"
   - deload → "a lighter week to absorb the training"
   - e1RM → "estimated one-rep max from your top set"
   - efficiency (sleep) → "time actually asleep ÷ time in bed"
   If a term appears again later in the same reply, don't re-define.
3. Prefer everyday language. Don't write "myofibrillar hypertrophy" when "muscle growth" works.
4. Explain why a concept matters when it drives a decision today. Skip the textbook tone.
```

**Kickoff branch (Mon):**

```
You're writing the Monday morning kickoff. This week's plan is below.

If phase_changed_this_week is true: open with one sentence explaining what the new phase asks of the athlete.

Cover in 100-150 words of prose:
- The phase and what it means (1 sentence if changed; brief mention if unchanged).
- Today's session focus (today's biggest lift + its prescribed load).
- The volume context (1 sentence on per-muscle targets if notable).
- Nutrition + sleep anchors (1 sentence each).

Never invent numbers. Reference exact values from the payload.
```

**Analytical branch (Tue–Sat):**

```
You're writing a Tue-Sat brief. Yesterday's session debrief and today's prescription are below.

Cover in 80-130 words of prose:
- Yesterday's per-lift performance (rep completion, any RIR miss). 1-2 sentences.
- Today's prescribed lift(s) with exact loads. 1-2 sentences.
- One adaptive cue (form, fatigue, nutrition gap) — pick the most actionable.

Never invent numbers. Reference exact values from the payload.
```

**Rest branch:** unchanged from current behavior.

Validator (`validateNoFabricatedNumbers`) continues to fire on all branches. The ±1 integer tolerance + float-strictness from Sub-project #1's Slice 5 fix-up applies.

## Retrofit to Sub-project #1's narrative-prompt

Small follow-up (committed alongside this work, ~5 lines): append the always-define-jargon rule from above to `lib/coach/weekly-review/narrative-prompt.ts` system prompt. The weekly review's §6 narrative will then also define MEV/MAV/RIR etc. on first use, matching the daily coach's teacher tone. No data shape changes.

## Edge cases

- **No committed week** (e.g. user hasn't run Sunday's review yet, or the review failed). `getThisWeekPrescription` returns null. Variant falls back to `'training'` (legacy) — same shape as today. Log a warning so the gap is observable; user-visible behavior is the existing generic Advice.
- **No logged workout yesterday** (Tue–Sat). `YesterdayVsPlanBlock.session_logged = false`. Block renders a small "no logged session yesterday" annotation; per_lift entries have `actual: null` and `reps_completed_pct: null`. Advice prompt acknowledges this and pivots to today-prescription-only framing.
- **Session swapped mid-week.** Yesterday's planned session reads from `coalesce(original_session_plan, session_plan)` per migration 0012's invariant. `YesterdayVsPlanBlock.swap_applied: true` is set when the swap happened. The block shows the *original* prescribed session (the commitment); the actual reads from the logged workout regardless of which day type was lifted.
- **Phase transition on Monday.** Kickoff prompt opens with the explainer sentence. The `phase_transition_this_week` flag is computed in `flags.ts` by comparing the most recent committed weekly_review's `payload.header.block_phase_now` to the *previous* committed review's `payload.header.block_phase_now`. Null-safe if either is missing — false in that case.
- **Block-start week** (week_n = 1). Phase is MEV. `phase_changed_this_week` is true (treat first-ever week as a transition). Kickoff explainer fires with "MEV phase opens this block — minimum effective volume, the floor your muscles need to keep growing."
- **Deload week** (week_n = totalWeeks). Phase is `deload`. Kickoff explainer: "Deload week — a lighter pass to absorb the last four weeks. Lifts drop 10-15% and volume cuts roughly in half. Recovery is the work."
- **No active block** (rare, single-user). Brief generation skips both kickoff and analytical paths and falls back to `'training'` legacy variant. Logged as a warning. The morning intake bot still completes normally.
- **GLP-1 active.** Existing GLP-1-aware flags (`has_glp1`, dose-aware protein floor) continue to apply to the advice prompt. Kickoff explainer doesn't change wording for GLP-1; the dose-aware nutrition guidance is layered in via the existing `compose-nutrition.ts` path that targets feeds.
- **Race with cron-triggered weekly_review write.** Monday's brief reads the latest committed weekly_review. If the user hasn't run the Sunday review by Monday intake time, the most recent committed review is from last Sunday (the prior week's). Kickoff still works — uses *that* review's `block_phase_next` as today's `block_phase_now`. Documented as the canonical interpretation; no special-casing.
- **Validator throws on real Sonnet/Haiku output** (the Sub-project #1 Slice-5 risk). Same retry pattern as the weekly review: throw → caller surfaces `brief_failed`. Existing `regenerate_morning_brief` tool can retry.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Haiku 4.5 doesn't follow the teacher-tone rules (defines too aggressively, every term every time) | System prompt explicitly says "first mention in this reply" — Haiku follows scoped instructions well. Soak-time tuning: if over-definition happens, tighten the prompt to "only when introducing the term to today's plan." |
| Phase-explainer fires on weeks where the user already knows the phase | Bound by `phase_changed_this_week` flag. Within MAV → MAV (mid-block), no explainer; only on phase transitions. |
| Brief becomes too long and loses skimmability | Kickoff capped at 150 words, analytical at 130 words. Validator only catches fabrication, not length — soft enforcement via prompt. Plan stage adds a length sanity-check that re-runs the prompt with a tighter cap if output > 180 words. |
| `getThisWeekPrescription` is slow (two DB reads) | Both queries are single-row by indexed keys. Combined latency < 50ms. Cached in the brief assembler's parallel-fetch step. |
| Yesterday's workout log arrives after morning intake (Strong CSV uploaded later in the day) | Accepted limitation. Brief is morning-time. If the user wants real-time debrief after upload, that's the post-workout debrief feature (out of scope here). |
| Kickoff content overlaps with Sunday's weekly review | Acceptable — the kickoff is *anchoring*, not re-explaining. Word count keeps it tight (150 words vs the weekly review's 180+ narrative). The structured blocks reference the review's data without repeating its prose. |
| The `'training'` legacy variant lingers in production rows | All existing rows stay readable via the dispatcher's explicit `'training'` branch (renders without new blocks). No backfill needed. |
| Retrofit to Sub-project #1's narrative-prompt breaks committed review consistency | The retrofit is additive (new system-prompt clause); existing committed narratives stay valid. New regenerates will use the teacher tone going forward. Acceptable drift. |

## Verification

- **Typecheck:** `npm run typecheck` clean after each PR.
- **Manual exercise** on the dev server:
  - Trigger morning intake on a Monday with the dev fixture (block aligned via Sub-project #1 state). Confirm `BriefThisWeekPlan` renders with the kickoff block and the Advice prose includes phase-explainer when applicable.
  - Trigger morning intake on a Tue–Sat day after logging a workout yesterday. Confirm `BriefYesterdayVsPlan` renders with planned vs actual per-lift table and Advice prose references yesterday's specific reps + today's load.
  - Trigger morning intake on a Tue–Sat day with NO logged workout yesterday. Confirm graceful degradation: block shows "no logged session yesterday" annotation, advice pivots to today-prescription-only.
- **Edge case audit:** session swap (run the audit-strain-2026 pattern with a swap injected); phase transition (Week 1 vs Week 2 vs deload week); GLP-1 active.
- **AI prose audit:** generate 5 briefs across different days, verify the teacher-tone rules fire (jargon defined on first mention, phase explainer fires only on transitions, prose stays under word cap).
- **Number-formatting compliance:** all numeric displays go through `fmtNum()` per CLAUDE.md.

## Open questions deferred to plan stage

1. Exact wording of the kickoff + analytical system prompts — iterate during implementation with real Haiku outputs.
2. Whether `BriefSessionList.tsx`'s big-four extension should show RIR inline or only on tap (UI polish — implementation choice).
3. Length-sanity-check fallback: re-run the prompt with a tighter cap, or just truncate? — plan-stage call.
4. Phase-transition explainer copy — single hand-curated sentence template vs let the model write it. Lean toward "let the model" with the prompt rule, but evaluate during soak.
5. Whether the retrofit to `narrative-prompt.ts` ships as part of Sub-project #2 or a separate tiny PR. Lean toward bundling it (matches the tone discipline).
