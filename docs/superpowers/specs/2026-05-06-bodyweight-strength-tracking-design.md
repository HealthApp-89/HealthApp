# Bodyweight Strength Tracking

**Date:** 2026-05-06
**Status:** Approved, ready for implementation plan

## Problem

Strong CSV exports record bodyweight sets (push-ups, dips, unweighted pull-ups, back extensions, etc.) with `Weight = 0`. Today the strength tab silently drops these sets:

- [lib/data/workouts.ts:110](lib/data/workouts.ts#L110) — `buildPRs` filter `if (s.warmup || !s.kg || !s.reps) continue` excludes 0-weight sets, so push-ups never appear in 🏆 PERSONAL RECORDS.
- [lib/data/workouts.ts:129](lib/data/workouts.ts#L129) — `buildExerciseTrend` filter `s.kg && s.reps` excludes 0-weight sets, so tapping a bodyweight exercise yields an empty trend.
- [components/strength/SessionTable.tsx:46-50](components/strength/SessionTable.tsx#L46-L50) — same filter for the per-exercise "top set" and "kg vol" labels; bodyweight sets render as "0" in the Weight column.
- [lib/coach/snapshot.ts:101-104](lib/coach/snapshot.ts#L101-L104) — coach snapshot's top-set picker filters bodyweight out, so the AI sees just `"Push Up"` instead of `"Push Up BW×20"`.
- [app/page.tsx:237-256](app/page.tsx#L237-L256) + [components/dashboard/RecentLiftsCard.tsx](components/dashboard/RecentLiftsCard.tsx) — dashboard "Recent lifts" card shows "0 kg" for all-bodyweight sessions.
- [app/api/ingest/strong/route.ts:160](app/api/ingest/strong/route.ts#L160) — CSV path stores `kg=0` literally; the text-share parser at [lib/strong-text.ts:73,87](lib/strong-text.ts#L73) stores `kg=null`. Inconsistent at the storage layer.

User goal: **for any set with 0 weight, treat it as bodyweight, track reps, and show improvement in total reps over time.**

## Decisions

| # | Decision | Notes |
|---|----------|-------|
| 1 | **Set classification is per-set.** A set with `kg` falsy (`null` or `0`) is bodyweight; a set with `kg > 0` is weighted. The same exercise can have both kinds of sets in the same session. | Per user: "if 2 sets are 11×0kg and the next set is 9×10kg, this means 2 bodyweight and 1 weighted". |
| 2 | **Exercise classification is history-wide.** An exercise is "weighted" if any working set in the user's history has `kg > 0`. Otherwise it's "bodyweight". This drives PR + trend semantics. | Mixed exercises behave like weighted exercises for PR/trend (1RM-based); bodyweight sets in those sessions are still rendered "BW" in the log. |
| 3 | **PRs.** Weighted exercises: highest est. 1RM working set (today's behavior). Bodyweight exercises: session with the highest total reps across working sets. The PR row shows `"60 reps total · YYYY-MM-DD"` with a `"60 reps"` badge. Caption "best total reps" replaces "est. 1RM". | Sort: weighted by 1RM desc, bodyweight after by total-reps desc — different units, single sort doesn't make sense. |
| 4 | **Trend chart.** Weighted exercises: line of best-set est. 1RM per session (today's behavior). Bodyweight exercises: line of total reps per session; tiles show `BEST SET (max reps in one set, latest session)` and `TOTAL REPS (latest session sum)`. | The user's headline metric is total reps; best-set reps is the secondary stat. |
| 5 | **Session log display.** Bodyweight sets render `"BW"` in the Weight column (not `"0"` or `"—"`). The est-1RM column stays `"—"`. The per-exercise summary line shows `"top 22 reps · 60 reps total"` for bodyweight exercises (vs. `"top 100×5 · 500 kg vol"` for weighted). The session header shows `"N reps total"` instead of `"X.Xk kg vol"` when the entire session is bodyweight; mixed sessions keep kg vol (weighted dominates). | |
| 6 | **Storage.** No DB migration. Read paths classify with `!s.kg` (treats `null` and `0` identically). Strong CSV ingest normalizes `kg=0 → null` for new imports so the CSV path matches the text-share path. Old `kg=0` rows still classify correctly via `!s.kg`. | Avoids a migration; the implicit signal is sufficient. |
| 7 | **Coach insights prompt.** Tag bodyweight sets in the compact JSON sent to Claude with `bw: true`. Add one line to the prompt: *"Sets with `bw: true` are bodyweight. Track progress in reps, not kg."* The `next_target` schema example gains a bodyweight variant: `"<kg> × <reps>×<sets>" or "<reps>×<sets>" for bodyweight, or "Skip" / specific cue`. | |
| 8 | **Coach snapshot top-set.** When an exercise's session has weighted sets, pick the heaviest as today (`"Bench Press 100×5"`). When a session has only bodyweight sets, pick the set with the most reps and render `"Push Up BW×20"`. | |
| 9 | **Dashboard recent-lifts card.** Compute `bwReps` (sum of working bodyweight reps) per session alongside `vol`. Extend `RecentSession` to `{ date, title, volumeKg, bwReps }`. Card renders `"{vol} kg"` if `volumeKg > 0`, else `"{bwReps} reps"`. | |
| 10 | **`est1rm`, weighted-volume calc, dashboard weekly volume — unchanged.** `est1rm(0, n)` already returns 0; weighted volume already excludes bodyweight sets (kg×reps = 0). | |

## Architecture

Approach chosen: **read-time classification, no schema changes.** Alternatives rejected:
- Storage migration adding `bodyweight: boolean` column — overkill given the implicit `!s.kg` signal.
- Faking `kg=1` (or user bodyweight) for bodyweight sets — preserves existing 1RM math but loses the distinction and contradicts user goal of tracking total reps.

### Data layer ([lib/data/workouts.ts](lib/data/workouts.ts))

**Types:**

```ts
type WorkoutExercise = {
  name: string;
  position: number;
  kind: "weighted" | "bodyweight"; // NEW — history-wide classification
  sets: WorkoutSet[];
};

type WorkoutSession = {
  // ... existing fields
  vol: number;     // weighted-only (kg × reps), unchanged
  bwReps: number;  // NEW: sum of reps across bodyweight working sets
  sets: number;    // working set count, unchanged
};

type PR =
  | { name: string; kind: "weighted"; kg: number; reps: number; est1rm: number; date: string }
  | { name: string; kind: "bodyweight"; totalReps: number; bestSetReps: number; date: string };

type ExerciseTrendPoint =
  | { date: string; kind: "weighted"; kg: number; reps: number; est1rm: number }
  | { date: string; kind: "bodyweight"; totalReps: number; bestSetReps: number };
```

**`loadWorkouts` algorithm:**

1. Fetch workouts/exercises/sets as today.
2. First pass over all sets: build `Set<string>` of exercise names that have at least one working set with `s.kg > 0`. Call this `weightedNames`.
3. Second pass: for each exercise, set `kind = weightedNames.has(name) ? "weighted" : "bodyweight"`. For each session, sum `vol` (kg × reps over weighted working sets) and `bwReps` (reps over bodyweight working sets).

**`buildPRs` (dispatch on exercise kind):**
- Weighted: today's logic — track highest est. 1RM working set per exercise. Iterating newest-first with strictly-greater comparison preserves "newest wins on ties" (already the behavior).
- Bodyweight: per session, sum reps across bodyweight working sets and find the max reps across single sets. Track the session with the highest `totalReps`. Iterate newest-first with strictly-greater comparison so ties resolve to the newest session (mirrors weighted). Return `{ kind: "bodyweight", totalReps, bestSetReps, date }`.

Output sorted: weighted PRs first by `est1rm desc`, then bodyweight PRs by `totalReps desc`.

**`buildExerciseTrend` (dispatch on the queried exercise's kind):**
- Weighted: today's logic — best-est-1RM working set per session, sessions with no weighted set skipped.
- Bodyweight: one point per session = `{ date, kind: "bodyweight", totalReps, bestSetReps }`.

### Ingest ([app/api/ingest/strong/route.ts](app/api/ingest/strong/route.ts))

Single change in the CSV path (~line 160):

```ts
// Before:
weightKg: iWeight >= 0 ? num(row[iWeight]) : null,

// After:
weightKg: iWeight >= 0 ? (num(row[iWeight]) || null) : null,
//                       └─ 0 (and NaN-coerced-to-null) become null
```

The text-share path already returns `kg=null` for bodyweight, so it stays as-is.

### UI

**SessionTable ([components/strength/SessionTable.tsx](components/strength/SessionTable.tsx)):**
- Per set, `s.kg` falsy → render `"BW"` in the Weight column (replaces the `s.kg != null ? fmtNum(s.kg) : "—"` ternary). Cardio rows (kg/reps both null, duration_seconds set) keep `"—"`.
- Per-exercise summary line — branch on `e.kind`:
  - Weighted: `"top {topKg}×{topReps} · {exVol} kg vol"` (today).
  - Bodyweight: compute `topReps = max(reps across bodyweight working sets)` and `bwExReps = sum(reps across bodyweight working sets)`. Render `"top {topReps} reps · {bwExReps} reps total"`.
- Session header — branch on `session.vol > 0`:
  - Weighted-only or mixed (`vol > 0`): keep `"X.Xk kg vol"`.
  - All-bodyweight (`vol === 0 && bwReps > 0`): render `"{bwReps} reps total"`.

**PRList ([components/strength/PRList.tsx](components/strength/PRList.tsx)):**
- Render based on `pr.kind`:
  - Weighted (today): `"{kg}kg × {reps} · {date}"` line + `"{est1rm} kg 1RM"` Pill (warning tone) + caption "est. 1RM".
  - Bodyweight: `"{totalReps} reps total · {date}"` line + `"{totalReps} reps"` Pill (warning tone) + caption "best total reps".

**ExerciseTrendCard ([components/strength/ExerciseTrendCard.tsx](components/strength/ExerciseTrendCard.tsx)):**
- Branch on the first point's `kind` (all points in a trend share the kind).
- Weighted (today): mini chart of `est1rm`, per-date labels show `est1rm`, tiles `BEST SET ({kg}kg × {reps})` / `EST. 1RM ({est1rm} kg)`.
- Bodyweight: mini chart of `totalReps`, per-date labels show `totalReps`, tiles `BEST SET ({bestSetReps} reps)` / `TOTAL REPS ({totalReps})`.

### Coach + dashboard

**Strength insights ([app/api/insights/strength/route.ts](app/api/insights/strength/route.ts)):**
- In the per-exercise compact JSON: include `bw: !s.kg` on each set. Don't strip the `bw` flag in the prompt example.
- Update prompt user-text: add the line *"Sets with `bw: true` are bodyweight; track progress in reps, not kg."* Update the schema example for `next_target` to: `"<kg> × <reps>×<sets>" or "<reps>×<sets>" for bodyweight, or "Skip" / specific cue`.

**Coach snapshot ([lib/coach/snapshot.ts:100-105](lib/coach/snapshot.ts#L100-L105)):**
- For each top-set selection per exercise:
  - If exercise has any working set with `s.kg > 0` in this session: pick the heaviest (today) → `"{name} {kg}×{reps}"`.
  - Else (bodyweight only): pick the working set with the most reps → `"{name} BW×{reps}"`.

**Dashboard ([app/page.tsx:237-256](app/page.tsx#L237-L256)):**
- When mapping `recentWorkoutsRaw` → `RecentSession`, compute `bwReps` alongside `vol` (mirror the loop already there).
- Extend `RecentSession` type ([components/dashboard/RecentLiftsCard.tsx:6-10](components/dashboard/RecentLiftsCard.tsx#L6-L10)): `{ date, title, volumeKg, bwReps }`.
- In `RecentLiftsCard`, render `"{fmtNum(volumeKg)} kg"` if `volumeKg > 0`, else `"{bwReps} reps"`.

## Edge cases

- **Cardio rows** (kg=null, reps=null, duration_seconds set): existing `isCardio` branch in SessionTable continues to render `"{seconds}s"`. The new bodyweight check (`!s.kg`) would also fire here, but `s.reps` is null so they're not bodyweight working sets — they neither count toward `bwReps` nor get a `"BW"` label. Make the BW label condition `!s.kg && s.reps != null`.
- **Warmup bodyweight sets**: excluded from `bwReps`, PRs, and trend (same rule as warmup weighted sets). They still render `"BW"` in the Weight column with the existing dim opacity.
- **Exercise with one warmup-only weighted set, all working sets bodyweight**: the history-wide classification scans **working** sets only (`!s.warmup && s.kg > 0`). Otherwise a single warmup row would flip an exercise to "weighted" and hide it from bodyweight PRs.
- **Empty exercises**: an exercise with no working sets — `kind` defaults to `"bodyweight"` but it produces no PR and no trend point. Falls out naturally.
- **est. 1RM stays 0** for bodyweight sets via the existing `if (!kg || !reps) return 0` guard. No change needed.

## Out of scope

- Manual entry UI for strength sessions (mentioned in the existing empty-state copy as "Stage 4").
- Adding bodyweight reps to the dashboard weekly volume rollup — keep that as a kg-only metric.
- Changing the readiness/score math.
- Migrating existing `kg=0` rows to `kg=null` in the database.

## Files touched

- [lib/data/workouts.ts](lib/data/workouts.ts) — types, `loadWorkouts`, `buildPRs`, `buildExerciseTrend`.
- [app/api/ingest/strong/route.ts](app/api/ingest/strong/route.ts) — normalize `kg=0 → null` in CSV path.
- [components/strength/SessionTable.tsx](components/strength/SessionTable.tsx) — `"BW"` label, per-exercise summary, session header.
- [components/strength/PRList.tsx](components/strength/PRList.tsx) — bodyweight row variant.
- [components/strength/ExerciseTrendCard.tsx](components/strength/ExerciseTrendCard.tsx) — bodyweight trend variant.
- [app/api/insights/strength/route.ts](app/api/insights/strength/route.ts) — `bw` flag in JSON, prompt update.
- [lib/coach/snapshot.ts](lib/coach/snapshot.ts) — bodyweight top-set picker.
- [app/page.tsx](app/page.tsx) — compute `bwReps` for `recentSessions`.
- [components/dashboard/RecentLiftsCard.tsx](components/dashboard/RecentLiftsCard.tsx) — `RecentSession` type + reps fallback in render.

## Verification

- `npm run typecheck` clean (strict).
- Manual: import a Strong CSV with at least one bodyweight exercise (e.g., Push Up 3×20, Back Extension 3×10) and one weighted exercise. Verify:
  - 🏆 PERSONAL RECORDS shows the bodyweight exercise with "60 reps total" badge.
  - Tapping the bodyweight exercise renders a trend chart with total-reps line.
  - Session log renders "BW" in the Weight column for each bodyweight set.
  - All-bodyweight session header reads "N reps total" instead of "0.0k kg vol".
  - Dashboard "Recent lifts" card shows "N reps" for an all-bodyweight day, "X kg" for weighted/mixed.
  - `/api/insights/strength` POST runs without error and the AI response references reps for bodyweight exercises.
