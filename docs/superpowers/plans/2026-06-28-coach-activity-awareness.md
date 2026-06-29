# Coach Activity Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat coach aware of declared activities (snapshot block), let the athlete add one conversationally (`add_planned_activity` tool), and refresh the proposal card live after a strip save.

**Architecture:** A guarded `loadPlannedActivities` read feeds a compact PLANNED ACTIVITIES block into the coach snapshot prefix; Carter/Peter prompts learn to cite it and point to the Approve card. A direct-write `add_planned_activity` tool (modeled on the existing direct-write tools, not HMAC) appends to `training_weeks.planned_activities` and surfaces a receipt chip. The `WeekActivityStrip` save invalidates the training-week query so the proposal card recomputes live. All additive — no activities ⇒ no block, coaches behave exactly as today.

**Tech Stack:** TypeScript (strict), Zod, vitest (node env), Supabase, Next.js, TanStack Query. No new AI calls.

## Global Constraints

- Pure block-builder (no I/O); the snapshot orchestrator does the guarded read. Mirrors the existing block builders in `snapshot.ts`.
- **Graceful degradation (load-bearing):** no planned activities → the PLANNED ACTIVITIES block is OMITTED → every coach's context is byte-identical to today. The activity read is guarded (failure → no block, never blocks the snapshot). A regression test enforces this.
- Timezone: "this week" via the user-tz helpers already in `snapshot.ts` (no raw `new Date().toISOString().slice(0,10)`). `node scripts/audit-timezone-usage.mjs` is a gate.
- Direct-write tool (declaring a reversible fact), NOT HMAC propose/commit. Requires an existing `training_weeks` row (clear error otherwise — same guardrail as the strip's 409).
- Two documented wiring gotchas: new tool needs a `chat-stream` dispatch branch + correct `modeAllowsTool` behavior (allowed in default chat, not blocked); receipt chip needs a `PERSIST_RESULT_TOOLS` entry + a `renderToolReceiptChip` branch (else the chip vanishes on reload).
- Reuse: `loadPlannedActivities` (`lib/coach/activity/read-planned.ts`), the activity model (`activityRegions`/`recoveryWindowHours`), the snapshot `body` seam, the receipt-chip plumbing, the proposal card, `queryKeys`. Don't duplicate. Don't edit the pure activity modules' internals (consume only).
- Keep the 446 tests green; typecheck clean.
- Commits per task: `feat: coach-activity: <thing>`. Watch worktree-stranding — commits land on the feature branch.

---

## File Structure

**New:**
- `lib/coach/activity/render-activities-block.ts` — pure `renderPlannedActivitiesBlock(activities, recurring): string | null`
- `lib/coach/activity/__tests__/render-activities-block.test.ts`

**Modified:**
- `lib/coach/snapshot.ts` — guarded `loadPlannedActivities` read + block into `body`
- `lib/coach/system-prompts.ts` — Carter + Peter teaching (additive)
- `lib/coach/tools.ts` — `add_planned_activity` schema + executor; add to `CARTER_TOOLS` + `PETER_TOOLS`
- `lib/coach/chat-stream.ts` — dispatch branch + `PERSIST_RESULT_TOOLS` entry + `modeAllowsTool` confirmation
- `components/chat/ChatMessage.tsx` — `renderToolReceiptChip` branch for `add_planned_activity`
- `components/activity/WeekActivityStrip.tsx` — invalidate `trainingWeeks.one` on save

---

## Task 1: Coach Awareness — PLANNED ACTIVITIES block + prompt

**Files:**
- Create: `lib/coach/activity/render-activities-block.ts`
- Test: `lib/coach/activity/__tests__/render-activities-block.test.ts`
- Modify: `lib/coach/snapshot.ts`, `lib/coach/system-prompts.ts`

**Interfaces:**
- Produces: `renderPlannedActivitiesBlock(activities: PlannedActivity[], recurring: RecurringActivity[]): string | null` — returns the block text, or `null` when there are no activities (so the caller omits it).

- [ ] **Step 1: Write the failing test** — `render-activities-block.test.ts`:

```typescript
import { expect, test } from "vitest";
import { renderPlannedActivitiesBlock } from "../render-activities-block";

test("renders this-week activities + a deterministic load note", () => {
  const block = renderPlannedActivitiesBlock(
    [
      { date: "2026-06-30", type: "padel", intensity_estimate: "hard", source: "manual" },
      { date: "2026-07-04", type: "cycling", intensity_estimate: "moderate", source: "detected" },
    ],
    [],
  );
  expect(block).not.toBeNull();
  expect(block).toContain("PLANNED ACTIVITIES");
  expect(block!.toLowerCase()).toContain("padel");
  expect(block!.toLowerCase()).toContain("legs"); // load note cites regions from the model
});

test("returns null when no activities (block omitted)", () => {
  expect(renderPlannedActivitiesBlock([], [])).toBeNull();
});

test("includes recurring patterns when present", () => {
  const block = renderPlannedActivitiesBlock([], [{ type: "padel", weekdays: [2, 4], typical_intensity: "moderate" }]);
  expect(block).not.toBeNull();
  expect(block!.toLowerCase()).toContain("recurring");
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `render-activities-block.ts`** (pure). Render a compact block: a "This week" line listing each activity as `<type> <weekday> (<intensity>)`, a "Recurring" line when `recurring` non-empty, and a one-line "Load note" derived from `activityRegions(type)` for the activities present (e.g. "padel loads legs + lower back; competes with heavy lower-body within ~36-48h" — use `recoveryWindowHours` for the hour range). Return `null` when `activities` AND `recurring` are both empty. Use the existing weekday-name mapping (short or long) for display; pure, no I/O.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Wire into `buildSnapshot`** (`lib/coach/snapshot.ts`): add a guarded `loadPlannedActivities(supabase, userId, currentWeek, todayIso).catch(() => [])` (resolve the current-week `training_weeks` row + recurring from profile — read how the existing reads fetch the week; if the week row isn't readily in scope, fetch it guarded) into the existing `Promise.all`, then `const activitiesBlock = renderPlannedActivitiesBlock(plannedActivities, recurringActivities);` and push it into the `body` array (near the endurance / intelligence blocks) ONLY when non-null. "This week" uses the user-tz week (reuse the tz/today already computed in buildSnapshot). Guarded so a failure → no block.

- [ ] **Step 6: Prompt teaching** (`lib/coach/system-prompts.ts`, additive — preserve all existing content): add a short section to CARTER_BASE (primary) + PETER_BASE (cross-domain) teaching them to read the `## PLANNED ACTIVITIES` block, factor declared activity load into advice, and POINT the athlete to the Schedule-tab proposal card for the actual week-rearrange ("the planner's move proposal is on your Schedule tab — tap Approve") rather than improvising loads in prose (consistent with the existing engine-owns-the-numbers rule). Gate on the block being present. Confirm `grep -c "Confidentiality"` unchanged.

- [ ] **Step 7: Verify + commit.**

Run: `npm run typecheck`; `npx vitest run lib/coach/`; `node scripts/audit-timezone-usage.mjs`; `npm run build`.

```bash
git add lib/coach/activity/render-activities-block.ts lib/coach/activity/__tests__/render-activities-block.test.ts lib/coach/snapshot.ts lib/coach/system-prompts.ts
git commit -m "feat: coach-activity: PLANNED ACTIVITIES snapshot block + Carter/Peter teaching"
```

---

## Task 2: `add_planned_activity` tool + chat wiring + receipt chip

**Files:**
- Modify: `lib/coach/tools.ts`, `lib/coach/chat-stream.ts`, `components/chat/ChatMessage.tsx`

**Interfaces:**
- Produces: tool `add_planned_activity({ type, weekday, intensity })` + `executeAddPlannedActivity(opts)` returning `{ ok: true, added: { type, date, intensity } }` or `{ ok: false, error }`.

- [ ] **Step 1: Tool schema + executor** in `tools.ts`. Schema: `add_planned_activity` with input `{ type: ActivityType, weekday: 0-6 (this week), intensity: "light"|"moderate"|"hard" }`, description making clear it records a self-directed activity for THIS week and that the actual plan rearrange is approved on the Schedule tab. Executor `executeAddPlannedActivity({ supabase, userId, input, todayIso/tz })`: resolve the current week_start (user-tz, Monday-keyed — reuse the existing helper), require an existing `training_weeks` row (return `{ ok:false, error:"no_training_week", ... }` if absent — same as the strip's 409), resolve the weekday→date in that week, append a `PlannedActivity` (source `"manual"`, validated via `PlannedActivitySchema`) to `planned_activities` (merge, no dup on date+type), UPDATE the row. Return `{ ok:true, added }`.

- [ ] **Step 2: Register in tool sets** — add the schema to `CARTER_TOOLS` and `PETER_TOOLS`.

- [ ] **Step 3: chat-stream wiring** (`lib/coach/chat-stream.ts`): (a) import + add a dispatch branch calling `executeAddPlannedActivity`; (b) add `"add_planned_activity"` to `PERSIST_RESULT_TOOLS`; (c) confirm `modeAllowsTool` allows it in default/plan_week (it's not a `set_`/`apply_`/`propose_`/`commit_` prefix, so it falls through to allowed — verify by reading the function; if the fall-through doesn't cover it, add an explicit allow). It should NOT be available in intake mode (activities aren't onboarding).

- [ ] **Step 4: Receipt chip** (`components/chat/ChatMessage.tsx`): add a branch in `renderToolReceiptChip` for `add_planned_activity` rendering e.g. "Added: padel Tue (hard)" from the persisted result.

- [ ] **Step 5: Verify + commit.**

Run: `npm run typecheck`; `npx vitest run lib/coach/`; `npm run build`.

```bash
git add lib/coach/tools.ts lib/coach/chat-stream.ts components/chat/ChatMessage.tsx
git commit -m "feat: coach-activity: add_planned_activity direct-write tool + receipt chip"
```

---

## Task 3: Strip → Proposal-Card Live Refresh

**Files:**
- Modify: `components/activity/WeekActivityStrip.tsx`

- [ ] **Step 1:** In `WeekActivityStrip`, after a successful save (POST to the activities API), call `queryClient.invalidateQueries({ queryKey: queryKeys.trainingWeeks.one(userId, weekStart) })` so the `ActivityLayoutProposalCard` (whose query key extends that prefix) and the week data recompute live. Use `useQueryClient()` from TanStack. If `userId`/`weekStart` aren't already props, thread them (the strip already has weekStart; pass userId from the parent `StrengthScheduleClient`). Also invalidate on a successful delete.

- [ ] **Step 2: Verify + commit.**

Run: `npm run typecheck`; `npm run build`; `npx vitest run lib/` (446 — UI change shouldn't affect).

```bash
git add components/activity/WeekActivityStrip.tsx components/strength/StrengthScheduleClient.tsx
git commit -m "feat: coach-activity: invalidate proposal card on activity strip save (live refresh)"
```

---

## Task 4: Graceful Regression + Final Verification

**Files:**
- Modify: `lib/coach/activity/__tests__/render-activities-block.test.ts` (or a small graceful test)

- [ ] **Step 1:** Assert the load-bearing rule at the unit level: `renderPlannedActivitiesBlock([], [])` returns `null` (block omitted) — already covered in Task 1; add an explicit "graceful" test name asserting that with no activities the builder yields null so the snapshot omits it (coach context unchanged). If feasible, add a focused assertion that `buildSnapshot` body does not contain "PLANNED ACTIVITIES" when there are no activities (or document that the null-return + conditional push is the mechanism, covered by the builder test).

- [ ] **Step 2: Final gates.** `npm run typecheck`; `npx vitest run lib/` (report total); `node scripts/audit-timezone-usage.mjs`; `npm run build`. Confirm `grep -c "Confidentiality" lib/coach/system-prompts.ts` unchanged and all 4 coach bases still exported.

- [ ] **Step 3: Commit.**

```bash
git add lib/coach/activity/__tests__/
git commit -m "test: coach-activity: graceful regression (no activities = block omitted, coach context unchanged)"
```

---

## Specification Coverage Checklist

- [x] PLANNED ACTIVITIES snapshot block (declared + recurring + deterministic load note, absent when empty) → Task 1
- [x] Carter + Peter prompt teaching (cite + point to Approve card; additive) → Task 1
- [x] `add_planned_activity` direct-write tool (week-row-required, manual source) → Task 2
- [x] chat-stream wiring (dispatch + PERSIST_RESULT_TOOLS + modeAllowsTool default-allow) + receipt chip → Task 2
- [x] Strip → proposal-card live refresh → Task 3
- [x] Graceful (no activities → block omitted, coaches unchanged) → Tasks 1, 4
- [x] No new AI calls; reuse loadPlannedActivities/model/seam/chip/card; tz-safe → all tasks

## Notes for Execution

- Tasks sequential (1→2→3→4). Each ends testable.
- Don't edit the pure activity modules' internals (consume `loadPlannedActivities`, `activityRegions`, `recoveryWindowHours`). Don't edit `lib/coach/intelligence` / `lib/coach/interventions`.
- The rearrange stays on the Approve card — `add_planned_activity` only declares the activity; it never moves the week.
- UI tasks (3) verify by build + the user's visual check; the block builder + tool carry the test weight.
