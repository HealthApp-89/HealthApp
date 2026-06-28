# Coach Activity Awareness — Design Spec

**Date:** 2026-06-28
**Phase:** 3, follow-up polish for Activity-Aware Planning (#3-B/#3-C, shipped same day)
**Status:** Approved design, ready for implementation plan

---

## Problem

Activity-Aware Planning shipped, but three rough edges remain — and one of them defeats the most intuitive way to use it. The athlete naturally wants to *tell the coach* "I have padel Tuesday," but:

1. **The chat coach is blind to planned activities.** `planned_activities` is read by the prescription engine + the morning brief, but it is NOT injected into the coach snapshot prefix. So Carter/Peter can't see what the athlete declared on the Schedule strip — "I have padel Tuesday" in chat is not understood.
2. **The proposal card doesn't refresh after a strip save.** The `WeekActivityStrip` save doesn't invalidate the proposal-card query, so the athlete must reload the Schedule tab to see the move proposal recompute.
3. **(Acceptable as-is)** Auto-lighten lands when prescriptions recompute (Approve / Sunday), not the instant an activity is added — correct behavior, no change needed beyond #2's live recompute.

## Goal

Make the chat coach **aware** of declared activities and let the athlete **declare one conversationally** ("add padel Tuesday, hard"), while keeping the actual week-rearrange on the existing deliberate Approve card. Fix the strip→card refresh so the proposal recomputes live.

## Scope decision (from brainstorming)

Chat-coach scope = **B (aware + can add)**: the coach sees activities and can write one via a tool, but does NOT apply the week-layout rearrange in chat — that stays on the proposal card (a whole-week change deserves a deliberate confirm, and the surface already exists). Not C (full agent apply-in-chat).

## Non-Goals

- Coach applying/rearranging the week layout in chat (stays on the Approve card).
- Chat tools to delete or edit recurring activities (delete via the strip; recurring stays on `/profile`).
- The detected-"other" strain-floor cleanup (separate follow-up).
- No new AI calls; the snapshot block is deterministic text, the tool is a deterministic write.

---

## Architecture

Three additive changes; everything degrades to today when there are no activities.

### 1. PLANNED ACTIVITIES snapshot block (coach awareness)

`buildSnapshot` ([lib/coach/snapshot.ts](../../../lib/coach/snapshot.ts)) already assembles a `body` array of context blocks (ATHLETE INTELLIGENCE, endurance, etc.) via a `Promise.all`. Add a guarded `loadPlannedActivities(supabase, userId, week, todayIso)` read (from [lib/coach/activity/read-planned.ts](../../../lib/coach/activity/read-planned.ts)) + the recurring pattern, and render a compact block into `body`:

```
## PLANNED ACTIVITIES (self-directed)
- This week: padel Tue (hard), cycling Sat (moderate)
- Recurring: padel — none declared
- Load note: padel loads legs + lower back; competes with heavy lower-body within ~36–48h
```

The "Load note" is derived deterministically from the activity model (`activityRegions` + `recoveryWindowHours`) — no AI. Guarded: a failed read → no block. Absent when no activities (the block is omitted, not rendered empty). "This week" uses the user-tz week (no raw date math; reuse the tz helpers already in snapshot.ts).

Prompt teaching (additive, preserve all existing content): Carter (primary, week-planning lane) + Peter (cross-domain) learn to factor declared activity load into advice AND point the athlete to the action — *"the planner wants to move Legs to Thursday; that proposal's on your Schedule tab, tap Approve"* — rather than improvising loads in prose (consistent with the existing "engine owns the numbers" discipline). All coaches can see the block.

### 2. `add_planned_activity` write tool

A direct-write tool (modeled on Nora's `log_meal_entry` direct-write path, NOT the HMAC propose/commit pattern — adding an activity is declaring a reversible fact, not changing the plan). In `CARTER_TOOLS` + `PETER_TOOLS` ([lib/coach/tools.ts](../../../lib/coach/tools.ts)).

- Input: `{ type: ActivityType, weekday | date (this week), intensity: "light"|"moderate"|"hard" }`. Validate via the existing `PlannedActivitySchema` / activity types.
- Effect: resolve the current week_start (user-tz), require an existing `training_weeks` row (return a clear error if the week isn't set up — same guardrail as the strip's 409), append a `PlannedActivity` (source `"manual"`) to `planned_activities` (merge, no duplicate on same date+type).
- Returns a result the chip renderer surfaces: `{ ok, added: {type, date, intensity} }`. The coach then says in words: "Added — your Schedule tab shows the proposed move; tap Approve."

Wiring (the codebase's known gotchas — bake into the plan):
- Register the executor + a dispatch branch in [lib/coach/chat-stream.ts](../../../lib/coach/chat-stream.ts).
- Add an explicit `modeAllowsTool` allow so it's available in **default** chat mode (not silently blocked by the prefix guard — the documented default-mode gating gotcha).
- Add to `PERSIST_RESULT_TOOLS` so the receipt chip survives a chat reload.
- Render the receipt chip via the existing `renderToolReceiptChip` path in [components/chat/ChatMessage.tsx](../../../components/chat/ChatMessage.tsx).

### 3. Strip → proposal-card live refresh

The `WeekActivityStrip` save ([components/activity/WeekActivityStrip.tsx](../../../components/activity/WeekActivityStrip.tsx)) currently uses a raw fetch + local state and does NOT invalidate the proposal-card query. Add a `queryClient.invalidateQueries({ queryKey: queryKeys.trainingWeeks.one(userId, weekStart) })` on successful save, so the `ActivityLayoutProposalCard` (whose query key extends that prefix) recomputes live — no reload. (The chat `add_planned_activity` path doesn't touch the card directly; when the athlete navigates to `/strength` it fetches fresh, which is sufficient.)

---

## Data Flow

```
Chat: "add padel Tuesday hard"
  → add_planned_activity tool → writes planned_activities (manual) → receipt chip
  → coach: "added; approve the move on your Schedule tab"

Strip add → POST activities → invalidate trainingWeeks.one → proposal card recomputes live

Any coach turn → buildSnapshot → loadPlannedActivities (guarded) → PLANNED ACTIVITIES block in prefix
  → coach reasons about declared activities, points to the Approve card
```

## Graceful Degradation (load-bearing)

No planned activities → the snapshot block is omitted entirely → every coach behaves exactly as today. The tool is additive (absent unless called). The strip invalidation is a no-op when nothing changed. A regression check confirms the block is absent and coach context is unchanged when no activities exist.

## Reuse, don't rebuild

`loadPlannedActivities`, the snapshot `body` injection seam, the activity model (`activityRegions`/`recoveryWindowHours` for the load note), the activities storage/API, the receipt-chip plumbing (`PERSIST_RESULT_TOOLS` + `renderToolReceiptChip`), the proposal card, `queryKeys`. Do not duplicate.

## Testing

- Pure render test for the PLANNED ACTIVITIES block builder (renders declared + recurring + load note; absent when empty).
- `add_planned_activity` executor: valid input writes a `planned_activities` entry (manual, no dup); week-row-required guard returns a clear error; invalid input rejected.
- Strip invalidation verified by build + the user's visual check.
- Keep the 446 tests green; typecheck + `node scripts/audit-timezone-usage.mjs` clean.

## Risks & Mitigations

- **Snapshot block bloats the cached prefix** → keep it to ~3 compact lines; omit when empty.
- **Tool available in wrong mode / chip vanishes on reload** → explicit `modeAllowsTool` allow + `PERSIST_RESULT_TOOLS` (the two documented gotchas), covered in the plan.
- **Coach improvises loads from the activity** → prompt teaches "point to the Approve card / engine owns numbers," consistent with existing discipline.
- **Blocking a coach turn** → the activity read is guarded (failure → no block); never blocks the snapshot.

## Build Order (for the plan)

1. PLANNED ACTIVITIES block builder (pure) + tests; wire the guarded read + block into `buildSnapshot`.
2. Coach-prompt teaching (Carter + Peter; additive).
3. `add_planned_activity` tool + executor + chat-stream wiring (dispatch + modeAllowsTool + PERSIST_RESULT_TOOLS) + receipt chip.
4. Strip → proposal-card invalidation.
5. Graceful regression + final verification.
