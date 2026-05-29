# Core block — arms-free rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Tue/Fri/Wed core block in `SESSION_PLANS` so the lift-day exercises are fully arms-free and arm-dependent work moves to Wed Mobility — fixing the "can't execute after smoked arms" problem the user hit on 2026-05-29.

**Architecture:** One-file edit (`lib/coach/sessionPlans.ts`) to three top-level entries (`Chest`, `Arms`, `Mobility`). Downstream surfaces (brief, strength card, logger, session-structure annotator) read through the existing `getEffectiveSessionPlan` resolution chain — no changes needed. One-off SQL clears the current week's `training_weeks.session_prescriptions` so the new block applies immediately rather than waiting for next Sunday's planning.

**Tech Stack:** TypeScript (strict), Next.js 15, Supabase (SQL Editor for the one-off), no test suite — verification is `npm run typecheck` plus visual smoke through `/strength`, `/coach` morning brief, and the logger sheet.

**Spec:** [docs/superpowers/specs/2026-05-29-core-block-arms-free-rework-design.md](../specs/2026-05-29-core-block-arms-free-rework-design.md)

---

## File Structure

- **Modify:** `lib/coach/sessionPlans.ts` — three edits to `SESSION_PLANS` (Chest trim+add, Arms trim+add, Mobility append)
- **Manual SQL:** one statement on `training_weeks` in Supabase Dashboard → SQL Editor
- **Modify (out-of-repo):** `~/.claude/projects/-Users-abdelouahedelbied-Health-app/memory/project_core_block.md` — auto-memory refresh

No new files. No downstream code changes. No migration.

---

## Task 1: Source video URLs for Dead Bug and Reverse Crunch

The spec defers URL selection to implementation. The existing block pulls tutorials from Athlean-X, Jeff Nippard, and Stoppani channels — match that pattern. Side Plank URL gets reused from the existing entry being removed.

**Files:** none yet — this is a research step that produces two URLs used in Task 2.

- [ ] **Step 1: Search for a Dead Bug tutorial**

Run a WebSearch query for `Athlean-X Dead Bug exercise tutorial site:youtube.com` (or Jeff Nippard / Jim Stoppani if Athlean's version isn't a clean form-cue video). Pick a single, focused tutorial — not a "best ab exercises ranked" compilation. Capture the URL.

- [ ] **Step 2: Search for a Reverse Crunch tutorial**

Same approach — `Athlean-X Reverse Crunch site:youtube.com`. The chosen video should explicitly cover the supine arms-at-sides form with no-momentum execution.

- [ ] **Step 3: Confirm both URLs resolve**

Run WebFetch on each URL (just to verify it returns a YouTube watch page, not a 404 / removed video). If either fails, swap to a backup from the same channel set.

- [ ] **Step 4: Hold both URLs for Task 2**

No file change in this task. Carry both URLs forward to the next task as concrete values to paste into the code edits.

---

## Task 2: Edit `SESSION_PLANS["Chest"]` — drop 4 arm-dependent core exercises, add Dead Bug

**Files:**
- Modify: `lib/coach/sessionPlans.ts` (Chest block, current lines 47-50 removed; new Dead Bug appended)

- [ ] **Step 1: Read the current Chest block**

Run: Read `lib/coach/sessionPlans.ts` lines 38-51.
Expected: confirm the last 4 entries are Hanging Leg Raise, Pallof Press (Cable), Side Plank, Forearm Plank — matching the spec's "remove these" list. If the entries don't match, STOP and re-read; do not proceed with stale assumptions.

- [ ] **Step 2: Remove the 4 trailing entries**

Use Edit to remove these 4 lines (preserving the closing `]` of the Chest array, which sits one line below):

```ts
    { name: "Hanging Leg Raise", baseReps: 10, sets: 3, key: "hanging_leg_raise", video_url: "https://www.youtube.com/watch?v=Pr1ieGZ5atk" },
    { name: "Pallof Press (Cable)", baseKg: 14, baseReps: 10, sets: 2, key: "pallof_press", note: "Per side", increment: { step: 2.5 }, video_url: "https://www.youtube.com/watch?v=dBAmQ9bx3JA" },
    { name: "Side Plank", reps: "Hold 30s each side", sets: 2, duration_seconds: 30, key: "side_plank", note: "Each side — elbow under shoulder, hips stacked, top arm to ceiling or on opposite delt", video_url: "https://www.youtube.com/watch?v=1qcsRZhtMyo" },
    { name: "Forearm Plank", reps: "Hold 45s×2", sets: 2, duration_seconds: 45, key: "forearm_plank", note: "Elbows under shoulders, glutes squeezed, ribs down", video_url: "https://www.youtube.com/watch?v=BjGVnfGk6j8" },
```

- [ ] **Step 3: Add Dead Bug as the new last Chest entry**

Insert immediately before the Chest array's closing `],` (after the Triceps Pushdown entry):

```ts
    { name: "Dead Bug", baseReps: 6, sets: 2, key: "dead_bug", note: "Per side — arms relaxed at sides, opposite leg lowers, lumbar pressed to floor", video_url: "<DEAD_BUG_URL_FROM_TASK_1>" },
```

Replace `<DEAD_BUG_URL_FROM_TASK_1>` with the URL captured in Task 1, Step 1.

- [ ] **Step 4: Eyeball the resulting Chest block**

Re-read `lib/coach/sessionPlans.ts` lines 38-50. Expected order:
1. Push Up
2. Decline Bench Press (Barbell)
3. Overhead Press (Barbell)
4. Incline Bench Press (Dumbbell)
5. Chest Fly
6. Lateral Raise (Dumbbell)
7. Triceps Pushdown (Cable)
8. Dead Bug ← new

8 entries total. No syntax errors visible.

---

## Task 3: Edit `SESSION_PLANS["Arms"]` — drop 5 arm-dependent core exercises, add Reverse Crunch

**Files:**
- Modify: `lib/coach/sessionPlans.ts` (Arms block, current lines 79-83 removed; new Reverse Crunch appended)

- [ ] **Step 1: Read the current Arms block**

Run: Read `lib/coach/sessionPlans.ts` lines 69-84.
Expected: confirm the last 5 entries are Cable Crunch, Pallof Press (Cable), Ab Wheel Rollout, Side Plank, Forearm Plank. If the entries don't match, STOP and re-read.

- [ ] **Step 2: Remove the 5 trailing entries**

Use Edit to remove these 5 lines (preserving the closing `]` of the Arms array):

```ts
    { name: "Cable Crunch", baseKg: 25, baseReps: 12, sets: 3, key: "cable_crunch", increment: { step: 2.5 }, video_url: "https://www.youtube.com/watch?v=36HK6uPM_PQ" },
    { name: "Pallof Press (Cable)", baseKg: 14, baseReps: 10, sets: 2, key: "pallof_press", note: "Per side", increment: { step: 2.5 }, video_url: "https://www.youtube.com/watch?v=dBAmQ9bx3JA" },
    { name: "Ab Wheel Rollout", baseReps: 8, sets: 2, key: "ab_wheel", note: "Kneeling — progress range slowly", video_url: "https://www.youtube.com/watch?v=PK4n7qJpOhM" },
    { name: "Side Plank", reps: "Hold 30s each side", sets: 2, duration_seconds: 30, key: "side_plank", note: "Each side — elbow under shoulder, hips stacked, top arm to ceiling or on opposite delt", video_url: "https://www.youtube.com/watch?v=1qcsRZhtMyo" },
    { name: "Forearm Plank", reps: "Hold 45s×2", sets: 2, duration_seconds: 45, key: "forearm_plank", note: "Elbows under shoulders, glutes squeezed, ribs down", video_url: "https://www.youtube.com/watch?v=BjGVnfGk6j8" },
```

- [ ] **Step 3: Add Reverse Crunch as the new last Arms entry**

Insert immediately before the Arms array's closing `],` (after the Rear Delt Fly entry):

```ts
    { name: "Reverse Crunch", baseReps: 10, sets: 2, key: "reverse_crunch", note: "Supine, arms at sides, knees to chest with no momentum", video_url: "<REVERSE_CRUNCH_URL_FROM_TASK_1>" },
```

Replace `<REVERSE_CRUNCH_URL_FROM_TASK_1>` with the URL captured in Task 1, Step 2.

- [ ] **Step 4: Eyeball the resulting Arms block**

Re-read `lib/coach/sessionPlans.ts` around the Arms block. Expected order:
1. Arnold Press (Dumbbell)
2. Bicep Curl (Dumbbell)
3. Front Raise (Dumbbell)
4. Hammer Curl (Dumbbell)
5. Lateral Raise (Dumbbell)
6. Triceps Pushdown (Cable - Straight Bar)
7. Cable External Rotation
8. Cable Internal Rotation
9. Rear Delt Fly
10. Reverse Crunch ← new

10 entries total. No syntax errors visible.

---

## Task 4: Edit `SESSION_PLANS["Mobility"]` — append Side Plank as the only Wed core addition

**Files:**
- Modify: `lib/coach/sessionPlans.ts` (Mobility block, new Side Plank appended after Glute Bridge)

- [ ] **Step 1: Read the current Mobility block**

Run: Read `lib/coach/sessionPlans.ts` lines 85-99.
Expected: confirm the last entry is Glute Bridge. If not, STOP and re-read.

- [ ] **Step 2: Append Side Plank at the end of the Mobility array**

Insert immediately before the Mobility array's closing `],` (after the Glute Bridge entry):

```ts
    { name: "Side Plank", reps: "Hold 20s each side", sets: 2, duration_seconds: 20, key: "side_plank", note: "Each side — elbow under shoulder, hips stacked; build to 30s, then 45s before adding a second Wed exercise", video_url: "https://www.youtube.com/watch?v=1qcsRZhtMyo" },
```

The URL is reused verbatim from the Side Plank entry that was removed in Tasks 2 and 3 — same Athlean tutorial, no need to re-source.

- [ ] **Step 3: Eyeball the resulting Mobility block**

Re-read `lib/coach/sessionPlans.ts` around the Mobility block. Expected final entry: Side Plank, after Glute Bridge. 13 entries total in Mobility.

---

## Task 5: Typecheck + visual smoke

**Files:** none modified — this is verification only.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with no errors. If a syntax error in `sessionPlans.ts` surfaces, fix it before proceeding.

- [ ] **Step 2: Start the dev server**

Run: `npm run dev` (in background or separate terminal). Wait for "Ready" on http://localhost:3000.

- [ ] **Step 3: Smoke /strength**

Open http://localhost:3000/strength in a browser. The strength tab shows today's session. If today is Tue/Wed/Fri, verify:
- Tue → last exercise is **Dead Bug**, with ▶ video chip
- Wed → last exercise is **Side Plank**, with ▶ video chip
- Fri → last exercise is **Reverse Crunch**, with ▶ video chip

If today is Mon/Thu/Sat/Sun, the strength card shows that day's session — pick one of Tue/Wed/Fri via the weekday picker (if available) or temporarily switch the system clock for the test. The point is to confirm rendering, not to wait three days.

- [ ] **Step 4: Smoke the logger sheet**

Open the logger via the "Start session" CTA on `/strength`. Confirm the new exercise appears in the session list with the right name and `baseReps`/`sets` values. Confirm no "missing key" errors in the browser console from the session-structure annotator (it'll mark the new exercises tier 4 by default — that's expected).

- [ ] **Step 5: Smoke the morning brief**

Open `/coach` (or wherever the morning brief renders). The brief's session block should show the updated exercise list. If the brief was assembled before today's code change and its `ui` jsonb is frozen, it'll still show the old block — that's expected and gets resolved naturally on the next morning's brief assembly. Note this in the commit message if so.

- [ ] **Step 6: Stop the dev server**

Kill the `npm run dev` process.

---

## Task 6: Commit

**Files:**
- Stage: `lib/coach/sessionPlans.ts`

- [ ] **Step 1: Verify only one file is staged**

Run: `git status`
Expected: `lib/coach/sessionPlans.ts` modified, no other unintended changes staged. (Other modified files on the branch — DraftReview.tsx, FoodSearchPicker.tsx, BottomSheet.tsx — belong to the Nora suggestion engine arc and should NOT be included in this commit.)

- [ ] **Step 2: Stage only the sessionPlans file**

Run: `git add lib/coach/sessionPlans.ts`

- [ ] **Step 3: Commit with a descriptive message**

Run:

```bash
git commit -m "$(cat <<'EOF'
feat(plans): rework core block to be arms-free on lift days

Drops Hanging Leg Raise / Pallof Press / Side Plank / Forearm Plank
from Tue Chest (arms-fatigued after pressing — couldn't execute) and
swaps in Dead Bug 2x6/side. Drops Cable Crunch / Pallof Press / Ab
Wheel / Side Plank / Forearm Plank from Fri Arms and swaps in Reverse
Crunch 2x10. Moves a single anti-lateral-flexion isometric (Side Plank
2x20s/side) to Wed Mobility — safe pre-deadlift since McGill's
concern is repeated spine flexion under load, not anti-movement work.

6 sets/wk baseline (was ~16); progression path is to grow Wed first.

Spec: docs/superpowers/specs/2026-05-29-core-block-arms-free-rework-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify the commit landed**

Run: `git log --oneline -1`
Expected: the new commit at HEAD with the message above.

---

## Task 7: Clear the current week's `session_prescriptions` so the new block applies this week

The active week's `training_weeks.session_prescriptions` was composed before today's edit and still references the old core block. Without this step, the new SESSION_PLANS won't reach the user until next Sunday's planning cycle.

**Files:** none. Manual SQL on Supabase Dashboard → SQL Editor.

- [ ] **Step 1: Look up the current week_start**

In Supabase Dashboard → SQL Editor, run a quick check:

```sql
select user_id, week_start, jsonb_object_keys(session_prescriptions) as weekdays
from training_weeks
where user_id = '<paste user_id here>'
order by week_start desc
limit 1;
```

Replace `<paste user_id here>` with the user's UUID (from `/profile` or a recent `daily_logs` row). Expected result: one row showing the current week_start and a list of weekday keys including at least `tuesday` and `friday`.

If no row exists for the current week, skip the rest of this task — there's nothing to clear, and next Sunday's plan will compose from the new SESSION_PLANS naturally.

- [ ] **Step 2: Apply the clearing SQL**

Run:

```sql
update training_weeks
set session_prescriptions = session_prescriptions - 'tuesday' - 'friday'
where user_id = '<paste user_id here>'
  and week_start = '<paste week_start from Step 1>';
```

Expected: one row affected.

- [ ] **Step 3: Verify the prescription is cleared**

Run:

```sql
select session_prescriptions ? 'tuesday' as has_tue,
       session_prescriptions ? 'friday' as has_fri
from training_weeks
where user_id = '<paste user_id here>'
  and week_start = '<paste week_start>';
```

Expected: `has_tue = false`, `has_fri = false`. Other weekday keys (Mon/Wed/Thu) should be untouched.

- [ ] **Step 4: Smoke /strength one more time**

Open http://localhost:3000/strength. For Tue/Fri (use weekday picker if needed), the displayed exercise list should now match the new SESSION_PLANS — Dead Bug ends Tue, Reverse Crunch ends Fri. If they still show the old block, the resolution chain still has an `exercise_overrides` or `user_session_templates` entry overriding SESSION_PLANS — investigate via:

```sql
select exercise_overrides from training_weeks where user_id = '<uuid>' and week_start = '<week_start>';
select * from user_session_templates where user_id = '<uuid>';
```

and clear the offending row(s) the same way.

---

## Task 8: Update the auto-memory file

The existing `project_core_block.md` memory documents the 2026-05-26 state of the core block and will mislead future sessions. Refresh it.

**Files:**
- Modify (out-of-repo): `~/.claude/projects/-Users-abdelouahedelbied-Health-app/memory/project_core_block.md`

- [ ] **Step 1: Open the memory file**

Path: `/Users/abdelouahedelbied/.claude/projects/-Users-abdelouahedelbied-Health-app/memory/project_core_block.md`

- [ ] **Step 2: Replace the body with the post-rework state**

Keep the frontmatter (name, description, metadata). Replace the body (everything after the closing `---`) with:

```markdown
**Current state (2026-05-29 rework — see [spec](../../../Health%20app/docs/superpowers/specs/2026-05-29-core-block-arms-free-rework-design.md)):**

Tue/Fri end-of-session core is arms-free supine only — Dead Bug 2×6/side (Tue), Reverse Crunch 2×10 (Fri). The reason: arms get smoked by pressing/curling and the original block (planks / Pallof Press / hanging leg raise / ab wheel) all leaned on already-fatigued grip and shoulder stability, leaving the block effectively unexecutable.

Wed Mobility carries the arm-using anti-movement work — Side Plank 2×20s/side only, for now. Wed is safe pre-Thu deadlift because McGill's concern is repeated spine flexion under load, not anti-movement isometrics.

**Total volume:** 6 sets/wk (down from ~16). Baseline for someone newly adding direct core.

**Progression path (grow Wednesday first):**
1. Push reps/duration: Dead Bug 2×8, Reverse Crunch 2×12, Side Plank 2×30s
2. Add Forearm Plank 2×30s to Wed once Side Plank holds 45s clean
3. Add Pallof Press 2×10/side to Wed (explicit anti-rotation)
4. Swap Reverse Crunch → Hanging Leg Raise (grip-dependent → goes Wed; Fri can stay empty or take Lying Leg Raise)
5. Add Ab Wheel Rollout to Wed

**Parked exercises (still in SESSION_PLANS-adjacent code lineage but unwired from the schedule):** Forearm Plank, Pallof Press (Cable), Hanging Leg Raise, Ab Wheel Rollout, Bicycle Crunch, Lying Leg Raise. Cable Crunch is fully dropped — it's the only spine-flexion-under-load entry and was the riskiest pre-deadlift.

**How to apply:** If future asks revisit core volume, placement, or "what comes next" — refer to the progression path above. Don't re-litigate. If a future ask asks to add core back to Tue or Fri, the constraint is *arms-free supine* — anything else has to go to Wed.
```

- [ ] **Step 3: Confirm the memory file saved**

Re-read the file. Verify the frontmatter is intact and the body reflects the new state.

---

## Self-Review

**Spec coverage** — every section of the spec maps to a task:
- "Final lineup" (Tue Dead Bug, Fri Reverse Crunch, Wed Side Plank) → Tasks 2, 3, 4
- "Code changes" (single file, three edits) → Tasks 2, 3, 4
- "Files NOT touched" → confirmed by Tasks 5's smoke (no downstream surprises)
- "Active-week consideration" + SQL example → Task 7
- "Verification" (typecheck + /strength + logger + morning brief) → Task 5
- "Memory housekeeping" → Task 8
- Video URL sourcing (deferred in spec) → Task 1

**Placeholder scan** — none of the "TBD / TODO / implement later" patterns. The two `<DEAD_BUG_URL_FROM_TASK_1>` and `<REVERSE_CRUNCH_URL_FROM_TASK_1>` markers are intentional cross-task references with explicit substitution instructions, not unresolved placeholders.

**Type consistency** — `Dead Bug` uses key `dead_bug`, `Reverse Crunch` uses key `reverse_crunch`, `Side Plank` reuses key `side_plank` (consistent across Tue/Wed; the Mobility entry has the same key as the Chest entry that was just deleted — fine because `key` is unique per session, not globally). `video_url` and `duration_seconds` are existing fields on `PlannedExercise` from migration / commit 31dd301 — no type changes.

**Scope check** — single PR, single file, ~10 minute manual implementation including the SQL step. Right size; no decomposition needed.
