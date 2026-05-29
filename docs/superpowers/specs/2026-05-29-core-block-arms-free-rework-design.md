# Core block — arms-free rework

**Date:** 2026-05-29
**Branch:** `feat/nora-suggestion-engine` (or a fresh branch off main — small enough to ship independently)
**Touches:** [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts) (one file)

## Problem

The 2026-05-26 core block (commit `31dd301`) added end-of-session core to Tuesday Chest and Friday Arms with these exercises:

- **Tue Chest:** Hanging Leg Raise, Pallof Press, Side Plank, Forearm Plank
- **Fri Arms:** Cable Crunch, Pallof Press, Ab Wheel Rollout, Side Plank, Forearm Plank

After 6–7 sets of pressing/curling, every one of those leans on already-fatigued arms — hang/grip strength, shoulder stability, forearm support, cable handle holding. The user reports they're effectively unable to execute the block on lift days because arms are dead.

The end-of-session placement rationale was sound: keep core away from Mon (squat) and Thu (deadlift) so the trunk is fresh for spine-loaded days. The exercise *selection* is what fails.

## Goal

Restructure the core block so:
1. Tue/Fri end-of-session exercises are fully arms-free (executable with smoked shoulders/grip/triceps)
2. Arm-dependent core exercises live on a day where arms are fresh AND it doesn't pre-fatigue the trunk for Thu deadlift
3. Volume is appropriate for someone newly adding direct core to their schedule
4. Coverage of all four core dimensions (anti-extension, anti-lateral-flexion, anti-rotation, rectus flexion) is preserved
5. There's a clear progression path so the block can grow without re-deciding what's in it

## Design

### Final lineup

**Tuesday — appended to `SESSION_PLANS["Chest"]` (arms-free, supine):**

| Exercise | Sets × Reps | Dimension | Notes |
|---|---|---|---|
| Dead Bug | 2 × 6/side | Anti-extension | Arms relaxed at sides — no shoulder load; opposite leg lowers; lumbar pressed to floor |

**Friday — appended to `SESSION_PLANS["Arms"]` (arms-free, supine):**

| Exercise | Sets × Reps | Dimension | Notes |
|---|---|---|---|
| Reverse Crunch | 2 × 10 | Rectus flexion (lower) | Arms at sides, knees to chest with no momentum |

**Wednesday — appended to `SESSION_PLANS["Mobility"]` (arms-using, anti-movement only):**

| Exercise | Sets × Reps | Dimension | Notes |
|---|---|---|---|
| Side Plank | 2 × 20s/side | Anti-lateral-flexion | Elbow under shoulder, hips stacked; build to 30s → 45s before adding a second Wed exercise |

**Total: 3 exercises, ~6 working sets/week.**

### Coverage matrix

| Core dimension | Covered by |
|---|---|
| Anti-extension | Dead Bug (Tue) |
| Anti-lateral-flexion | Side Plank (Wed) |
| Rectus flexion | Reverse Crunch (Fri) |
| Obliques / rotation | Indirectly via Dead Bug's contralateral pattern + Side Plank's lateral demand |

### Why Wednesday is safe pre-deadlift

The original Tue/Fri placement was chosen to keep the trunk fresh for Mon squat and Thu deadlift. Adding work to Wed reintroduces that concern for Thu.

The Wed exercise is **Side Plank only** — an isometric anti-lateral-flexion hold. McGill's research opposes repeated **spine flexion under load** pre-deadlift, not anti-movement isometrics. Side Plank actually primes core stiffness, which aids deadlift bracing rather than compromising it. The 2×20s/side volume is also low enough to leave no measurable systemic fatigue 24h out.

### Why these exercises specifically (not the obvious alternatives)

- **Dead Bug over Lying Leg Raise on Tue:** both are arms-free supine, but Dead Bug's contralateral pattern engages obliques as a free secondary, giving wider coverage from one exercise
- **Reverse Crunch over Bicycle Crunch on Fri:** Reverse Crunch is closer to pure lower-rectus and avoids any shoulder/neck involvement; Bicycle Crunch's hand-at-temple position is technically arms-free but cervical-tense after a heavy Arms session
- **Side Plank over Forearm Plank on Wed:** anti-lateral-flexion is the only dimension not already covered by Tue/Fri; Forearm Plank's anti-extension overlaps Dead Bug

### Dropped from the original block (parked, not deleted)

These remain in `SESSION_PLANS` as long as they're not referenced — they're just unwired from the weekly schedule. They become natural progressions:

- **Forearm Plank** → second Wed exercise once Side Plank reaches 45s/side
- **Pallof Press** → third Wed exercise for explicit anti-rotation when Forearm Plank is consolidated
- **Hanging Leg Raise** → advanced lower-rectus once Reverse Crunch is too easy; requires grip recovery, so still belongs on Wed
- **Ab Wheel Rollout** → advanced anti-extension once Dead Bug + Forearm Plank are easy
- **Cable Crunch** → stays dropped; it's the only spine-flexion-under-load exercise in the original block, and it's covered adequately by bodyweight rectus work for a non-competing intermediate

### Progression path

The single principle: **grow Wednesday first**, because that's where the spare capacity sits.

1. **Baseline (this design):** Dead Bug 2×6/side, Reverse Crunch 2×10, Side Plank 2×20s/side
2. **+25% load:** push reps/duration up — Dead Bug 2×8, Reverse Crunch 2×12, Side Plank 2×30s
3. **+second Wed exercise:** add Forearm Plank 2×30s once Side Plank holds 45s clean
4. **+anti-rotation:** add Pallof Press 2×10/side to Wed
5. **+advanced lower-rectus:** swap Reverse Crunch for Hanging Leg Raise (moves Fri → Wed because grip-dependent; Fri becomes Lying Leg Raise or stays empty)
6. **+advanced anti-extension:** add Ab Wheel Rollout to Wed

No need to re-decide at each step — the order is fixed.

## Code changes

**One file: [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts)**

`SESSION_PLANS["Chest"]` — remove last 4 entries (Hanging Leg Raise, Pallof Press, Side Plank, Forearm Plank), append:
```ts
{ name: "Dead Bug", baseReps: 6, sets: 2, key: "dead_bug",
  note: "Per side — arms relaxed at sides, opposite leg lowers, lumbar pressed to floor",
  video_url: "<filled at implementation time>" }
```

`SESSION_PLANS["Arms"]` — remove last 5 entries (Cable Crunch, Pallof Press, Ab Wheel Rollout, Side Plank, Forearm Plank), append:
```ts
{ name: "Reverse Crunch", baseReps: 10, sets: 2, key: "reverse_crunch",
  note: "Supine, arms at sides, knees to chest with no momentum",
  video_url: "<filled at implementation time>" }
```

`SESSION_PLANS["Mobility"]` — append at the very end:
```ts
{ name: "Side Plank", reps: "Hold 20s each side", sets: 2, duration_seconds: 20,
  key: "side_plank",
  note: "Each side — elbow under shoulder, hips stacked; build to 30s, then 45s before adding a second Wed exercise",
  video_url: "https://www.youtube.com/watch?v=1qcsRZhtMyo" }
```

Side Plank reuses the existing URL already in the file (currently attached to the Chest-block Side Plank entry, which gets removed in this PR). Dead Bug and Reverse Crunch URLs are sourced from the same channel set as the 2026-05-26 commit (Athlean-X / Jeff Nippard / Stoppani) at implementation time.

## Files NOT touched

Everything downstream reads from `SESSION_PLANS` via `getEffectiveSessionPlan`'s resolution chain — no other code change is needed:

- [components/morning/BriefSessionList.tsx](../../../components/morning/BriefSessionList.tsx) — renders new entries with ▶ video chip automatically
- [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx) — same
- [lib/logger/resolve-plan.ts](../../../lib/logger/resolve-plan.ts) — falls through to `SESSION_PLANS` for users without overrides; logger picks up the new exercises
- `lib/coach/session-structure/*` — annotates new exercises as tier 4 (finisher) by default since they're at end-of-session. Acceptable; the annotator can be retuned later if it becomes a problem
- Chat tools, weekly review, morning-brief composers, dashboards — all read live workout data, not planned lists

## Active-week consideration

If this Sunday's `training_weeks.session_prescriptions` already prescribed the old block for the current week's Tue/Fri (it almost certainly did — that's how the user noticed), the new SESSION_PLANS won't reach this week until the prescription is cleared. The resolution chain is:

```
session_prescriptions[weekday] → exercise_overrides[weekday] → user_session_templates → SESSION_PLANS
```

One-off SQL on the current week's `training_weeks` row to null out the Tue/Fri prescription entries forces fall-through to the updated `SESSION_PLANS`. Future Sunday plans (next prescription cycle) compose from the new block automatically.

```sql
update training_weeks
set session_prescriptions = session_prescriptions - 'tuesday' - 'friday'
where user_id = '<uuid>' and week_start = date_trunc('week', current_date)::date;
```

Recommended action: include the SQL as a one-line manual step in the implementation plan. The active prescription is the whole reason this design exists; waiting a week for the new block to take effect defeats the purpose.

## Verification

1. `npm run typecheck` passes
2. Open `/strength` — Tue, Wed, Fri session pickers show the three new exercises with ▶ video chips
3. Open the logger on a Tue/Wed/Fri session — new exercises appear; rest/RPE annotations look sane (no missing-key errors from the session-structure annotator)
4. Morning brief on a Tue/Wed/Fri renders without missing-key errors and shows the new exercises in the session block
5. After the one-off SQL, refresh `/strength` for the current week and confirm the active week's Tue/Fri now shows Dead Bug / Reverse Crunch instead of the old block

## Out of scope

- Retuning the session-structure annotator's tier assignment for the new exercises (current tier 4 default is acceptable; revisit only if user-visible behavior degrades)
- Adding a separate `core_block` field to training_weeks or a dedicated UI surface for core (the current "core is just more exercises in the session list" pattern is fine)
- Backfilling video URLs for the other ~30 exercises in `SESSION_PLANS` that don't have one — scope creep
- Programmatic enforcement of "no Cable Crunch within 24h of deadlift" or similar rules — humans owning the schedule is sufficient at single-user scale

## Memory housekeeping (post-merge)

Update the `project_core_block.md` auto-memory file (lives outside this repo, in `~/.claude/projects/-Users-abdelouahedelbied-Health-app/memory/`) to reflect:
- 6 sets/wk baseline (down from ~16)
- Tue/Fri are arms-free supine only; Wed Mobility carries the anti-movement block
- The grow-Wednesday-first progression path is the agreed sequence

So a future session doesn't re-litigate volume or placement.
