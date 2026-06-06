# Week Schedule sub-tab — Design

**Date:** 2026-06-06
**Status:** Draft, pending implementation

## Problem

The Strength section currently has four sub-pills: **Coach**, **By date**, **By muscle**, **Log**. Of these, only the Coach tab (via `TodayPlanCard`) renders the prescribed plan — and only for *today*. To see what is prescribed on Tuesday or Thursday, the athlete must open Carter's chat and ask, or navigate to `/strength?tab=coach` and wait for the calendar to roll forward.

There is no single surface that answers the natural question: **"what's on the menu this week, and what am I doing each day?"**

## Goal

Add a Schedule surface that renders the whole week's prescription at a glance, with per-day inline expansion to show the prescribed exercise list (sets × reps × kg). The surface is plan-shaped (reads `training_weeks.session_prescriptions` and friends) and complements the existing log-shaped `By date` tab without duplicating it.

## Non-goals

- **No exercise reorder from Schedule.** Reorder already lives on `/coach` chat + morning brief. We don't duplicate it here.
- **No exercise-level edit / "mark complete".** The Logger is the writer of `workouts` / `exercise_sets`.
- **No analytics overlay** (volume per day, adherence ring, etc.). That's the By muscle tab and the Coach trends surface.
- **No swap from past days.** Mirrors `DaySwapSheet`'s existing constraint.
- **No sub-pill notification badge.** The sub-pill itself is the discoverability surface.

## Information architecture

### Sub-pill placement

The new pill `Schedule` is inserted between Coach and By date. Final order:

**Coach → Schedule → By date → By muscle → Log**

Rationale (independent IA review, see brainstorm transcript): the app's architecture is organized around a *plan vs log* axis. Plan-shaped surfaces: Coach (chat + TodayPlanCard), the new Schedule. Log-shaped surfaces: By date (`SessionTable` of logged workouts), By muscle (volume from `workouts`), Log (manual write). Embedding the Schedule view inside By date would cross that axis — the same surface would answer both "what am I supposed to do Thursday?" (`session_prescriptions`) and "what did I actually do last Thursday?" (`workouts`). Two different data sources, two different failure modes ("no plan" vs "no logged session"), one confused screen. A dedicated sub-pill keeps the boundary clean and gives the prescribed-week view a natural home for future extensions.

### URL

- `/strength?tab=schedule` — defaults to current week.
- `/strength?tab=schedule&week=YYYY-MM-DD` — Monday-keyed; lets the rest of the app deep-link to a specific week.

## Week scope and navigation

- **Default**: the current week (`currentWeekMonday()` from [lib/coach/week.ts](lib/coach/week.ts)).
- **Header** renders `‹ Mon Jun 8 → Sun Jun 14 ›` with prev/next chevrons.
- **Prev enabled** when either a `training_weeks` row exists for `week_start - 7d` OR any `workouts` row falls in that prior-week range. Lets the athlete browse historical weeks even when no plan was committed.
- **Next enabled** only when a `training_weeks` row exists for `week_start + 7d` (post-Sunday-cron writes next week's prescription).
- **Range cap**: 8 weeks back, 1 week forward. Past that, the prescription engine's adherence and trend math stops being load-bearing for the schedule view.

## Day row — collapsed state

Each of the seven rows shows:

```
[Mon  8]  Legs                          [Logged]   ▶
[Tue  9]  Chest                         [Chest]    ▶
[Wed 10]  Mobility                      [Mobility] ▼   ← expanded
[Thu 11]  Back                          [Back]     ▶
[Fri 12]  Arms · Today                  [Today]    ▶
[Sat 13]  Rest day                      [Rest]
[Sun 14]  Rest day                      [Rest]
```

- **Left**: weekday short label (`Mon`) + day-of-month number.
- **Centre**: session-type label (`Legs`, `Chest`, …); when the row's date is today, suffix ` · Today` for redundancy with the right-edge pill.
- **Right**: status pill — selected in priority order:
  1. `Today` (warm accent) when the row's date equals `todayInUserTz()`
  2. `Logged` (green) when ≥1 `workouts` row exists for that date
  3. Session-type pill coloured via `modeColorLight(mode.color)` (existing helper used by `TodayPlanCard`)
  4. `Rest` (muted) when the day's session type is REST
- **Chevron** `▶` collapsed, `▼` expanded. REST rows have no chevron and are not expandable.

## Day row — expanded state

For non-REST rows, the expanded body renders the prescribed exercise list:

```
  Squat                            100 kg × 8 × 4   ▶ video
  RDL                               80 kg × 10 × 3   ▶ video
  Hip Thrust (Machine)              90 kg × 10 × 3
  Leg Press                        160 kg × 12 × 3
  …

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
  Today · ready to lift
  [ Start session ]   [ Swap day ]
```

### Exercise list

- One row per `PlannedExercise`: name on the left, prescribed target right-aligned monospace (`kg × reps × sets` for a prescription with load; `reps × sets` for bodyweight; `Hold 60s × 2` for duration-based).
- Optional `▶ video` link follows the name (existing `PlannedExercise.video_url` field).
- Source of truth: `getEffectiveSessionPlan(sessionType, weekday, sessionPrescriptions, exerciseOverrides, userTemplate)` from [lib/coach/sessionPlans.ts](lib/coach/sessionPlans.ts) — same chain `TodayPlanCard` and the Logger both call.

### Footer CTAs vary by date class

- **Today** (date === today, non-REST): `Start session` button opens `LoggerSheet` (same wiring as `TodayPlanCard`), plus `Swap day` chip opens `DaySwapSheet`.
- **Past + logged** (date < today, ≥1 workouts row): `View logged session →` link to `/strength?tab=date&date=YYYY-MM-DD`.
- **Past + not logged** (date < today, no workouts row, non-REST): muted "Not logged" note. No CTA.
- **Future, this week or next week** (date > today, non-REST): read-only target list + `Swap day` chip. No `Start session`.
- **REST**: row stays collapsed; no expansion.

### Multi-expand

Multiple rows may be open simultaneously. Tapping a row toggles only its own state. On first paint, today auto-expands; all other rows start collapsed.

## Empty / no-plan states

- **No `training_weeks` row for selected week** (e.g. a historical week where no plan was committed, or before the Sunday cron ran): render the static `SESSION_PLANS` mapping via `WEEKLY_SESSIONS[weekday]` so the surface is never blank, and show a banner:
  > Default plan — plan this week with Coach ↗
  > (link → `/strength?tab=coach&mode=plan_week&week=<week_start>`)
- **No prescription for a specific day** but week is committed: `getEffectiveSessionPlan` falls through `exercise_overrides → user_session_templates → SESSION_PLANS`. No special UI; just renders whatever the chain returns.
- **No exercises at all** (unknown session type, no overrides, no template, no static plan): expanded body shows the muted line `No prescribed exercises.`

## Data layer

### Hooks reused

- `useTrainingWeek(userId, weekStart)` — returns the row with `session_plan`, `session_prescriptions`, `exercise_overrides`, `rir_target`, `research_phase`.
- `useFullWorkouts(userId)` — already fetched on `/strength?tab=date`; we filter client-side to the visible 7-day window to compute the `Logged` pill.

### Hook added

- `useUserSessionTemplates(userId)` in [lib/query/hooks/useUserSessionTemplates.ts](lib/query/hooks/useUserSessionTemplates.ts) — fetches ALL `user_session_templates` rows for the user keyed by `session_type`. The schedule renders up to five distinct session types per week; per-row single-key fetches via the existing `useUserSessionTemplate` would be wasteful and cause week navigation to fan out N queries. The single-key hook stays for `TodayPlanCard` and `LoggerSheet`.

### Fetchers added

- [lib/query/fetchers/userSessionTemplates.ts](lib/query/fetchers/userSessionTemplates.ts) — server + browser variants returning `Record<string, UserSessionTemplate>` keyed by `session_type`. Throws on Supabase error. Matches the canonical fetcher pattern documented in CLAUDE.md.

### Query key added

- `queryKeys.userSessionTemplates.all(userId)` in [lib/query/keys.ts](lib/query/keys.ts).

## Files touched

### New

- `components/strength/StrengthScheduleClient.tsx` — top-level container. Owns `weekStart` URL state, fetches `useTrainingWeek` + `useFullWorkouts` + `useUserSessionTemplates`, renders header navigator + accordion.
- `components/strength/WeekScheduleAccordion.tsx` — the 7-row list. Owns the per-row expand/collapse state (`Set<Weekday>`). Today is auto-added on first paint.
- `components/strength/ScheduleDayRow.tsx` — single day row. Renders collapsed (weekday + session label + status pill + chevron) and expanded (exercise list + footer CTAs) states. Reads the date-class discriminator (`today | past_logged | past_unlogged | future | rest`) from props and renders the right footer.
- `lib/query/fetchers/userSessionTemplates.ts` (server + browser variants).
- `lib/query/hooks/useUserSessionTemplates.ts`.

### Modified

- `app/strength/page.tsx` — add `schedule` to the `Tab` union and `SUB_TABS` array (between `coach` and `date`); render `<StrengthScheduleClient userId={user.id} />`.
- `lib/query/keys.ts` — add `userSessionTemplates`.

### Untouched

- `lib/coach/sessionPlans.ts` — `getEffectiveSessionPlan` already takes optional `userTemplate`; no change.
- `components/strength/StrengthCoachClient.tsx` — keeps using single-key `useUserSessionTemplate(...)`; no change.
- `components/strength/DaySwapSheet.tsx` — reused as-is by the per-day `Swap day` chip.
- `components/logger/LoggerSheet.tsx` — reused as-is by the Today row's `Start session` button.

## Test plan

- **Type-check** clean (`npm run typecheck`).
- **Manual smoke** at `/strength?tab=schedule`:
  - Default load: current week, today auto-expanded showing prescribed exercises.
  - Prev/next chevrons enable/disable correctly at boundaries.
  - Logged days show the green `Logged` pill; tapping into the row shows `View logged session →` linking to the correct `?tab=date&date=…`.
  - Today row shows `Start session`; opening it launches `LoggerSheet`.
  - Future day's `Swap day` chip opens `DaySwapSheet` and the post-swap state reflects in the row's session-type label after the mutation invalidates `useTrainingWeek`.
  - REST rows stay collapsed and unclickable.
  - Empty-state banner shows when navigating to a week with no `training_weeks` row.

## Open questions

None at design time. Sub-decisions inside the chosen path (exact pill colours, animation timing, swap-chip placement vs full button) are owned at implementation and don't gate this spec.
