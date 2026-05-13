# Mobility session logging via chat

**Date:** 2026-05-13
**Branch target:** `feat/mobility-chat-logging`
**Status:** spec — approved, advancing to plan

---

## What we're building

A two-tool chat affordance that lets the user confirm a completed mobility session in coach chat. The coach calls `mark_mobility_done` on phrases like "done mobility" / "finished my mobility" / "did it"; it inserts a single row into the existing `workouts` table (`type='Mobility'`, no `exercise_sets`). Adherence already matches on `workouts.type`, so the session counts as `as_planned` (or `swapped` if it was swapped) without any change to adherence math. Strain comes from WHOOP the next morning, untouched.

A companion `unmark_mobility_done` tool deletes the chat-inserted row if the user retracts.

## Why this exists

The Strong app can't meaningfully log mobility — its data model is `exercise × set × weight × reps`, and the mobility session (8 breathing/CARs/positional drills in [lib/coach/sessionPlans.ts:54](lib/coach/sessionPlans.ts#L54)) has none of those. Today, when the user does their Wednesday mobility, no `workouts` row is created, so [adherence.ts:127](lib/coach/adherence.ts#L127) sees nothing for that day and marks it `missed`. The Sunday recap then misreports.

WHOOP picks up the heart-rate signal of the session regardless and writes `daily_logs.strain` the next morning. So the missing link is purely "did you do the session, yes/no" — a one-tool gap.

## Scope

In:
- Mobility sessions only.
- Chat as the single confirmation surface.
- `today` as the default date; arbitrary `date <= today` allowed when the user explicitly says so ("I did mobility yesterday").

Out (deferred — not part of this spec):
- Other non-Strong session types (cardio, walks, yoga, swimming, tennis). Per discussion, those will likely come via Garmin in a future app; not worth designing speculative plumbing now.
- One-tap "mark done" chips on the morning brief card or strength-tab today-plan card. Trivial to add later once the tool exists; out of scope for v1.
- Mobility-session notes/rating UI in chat. The tool accepts an optional `notes` field for future use; the coach won't prompt for it.
- Backdating beyond explicit user request. No artificial date-window cap.

## Tools

Two new write tools in [lib/coach/tools.ts](lib/coach/tools.ts), following the existing `mark_glp1_discontinued` / `set_glp1_taper_started` write-tool pattern (single-step, no HMAC approval token — these are low-stakes, fully reversible).

### `mark_mobility_done`

```ts
// Schema
{
  name: "mark_mobility_done",
  description:
    "User confirmation that a mobility session is complete (today by default; pass `date` for explicit backdates the user mentions). Inserts a workouts row with type='Mobility' and source='chat' so adherence sees the session. Idempotent on (user_id, external_id) where external_id = `chat-mobility-${date}`. Call when the user signals completion (e.g., 'done', 'finished mobility', 'did my session'). Do NOT call without an explicit completion signal.",
  input_schema: {
    type: "object",
    required: [],
    properties: {
      date:  { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD in user's local TZ. Defaults to today." },
      notes: { type: ["string", "null"], maxLength: 280 },
    },
  },
}
```

Executor logic:

1. Resolve `date`: default to today in user TZ via [todayInUserTz() in lib/time.ts:83](lib/time.ts#L83).
2. Validate `date <= todayInUserTz()`. Reject future dates with a tool error.
3. Build `external_id = "chat-mobility-${date}"`.
4. Upsert into `workouts` using the existing partial-unique index `workouts_user_external_id_idx` on `(user_id, external_id)` ([0003_integrations.sql:35](supabase/migrations/0003_integrations.sql#L35)):
   ```sql
   on conflict (user_id, external_id) where external_id is not null do update set
     type   = excluded.type,
     notes  = excluded.notes,
     source = excluded.source
   ```
   To populate `was_already_done`, do a `select id from workouts where user_id = $1 and external_id = $2` *before* the upsert and compare.
5. Return `{ ok: true, date, was_already_done: boolean }`. `was_already_done` is true when the row already existed before this call.

Side effects: none beyond the row insert. No `revalidatePath` — the strength tab and brief are server-rendered with short ISR and the next visit will see the row; coach chat is the consumption path here, not page-render.

### `unmark_mobility_done`

```ts
{
  name: "unmark_mobility_done",
  description:
    "User retracts a previous mobility confirmation ('actually didn't do it', 'scratch that'). Deletes the chat-inserted workouts row for the given date. NEVER deletes Strong CSV imports — guarded by source='chat' filter. Returns removed=false if nothing was deleted.",
  input_schema: {
    type: "object",
    required: [],
    properties: {
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD in user's local TZ. Defaults to today." },
    },
  },
}
```

Executor logic:

1. Resolve `date` (default today).
2. `delete from workouts where user_id = $1 and external_id = $2 and source = 'chat'`. The `source = 'chat'` predicate is the safety guard — a Strong CSV import that happened to share an external_id cannot be touched.
3. Return `{ ok: true, removed: boolean }`. `removed` is true when a row was deleted.

## Wiring

### Dispatch in [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts)

Two additions:

1. Import the new tool schemas at the top of the file alongside `MARK_GLP1_DISCONTINUED_TOOL` etc.
2. Add them to the `allTools` array (around line 184).
3. Add `else if (block.name === "mark_mobility_done") { … }` and `else if (block.name === "unmark_mobility_done") { … }` to the tool-dispatch chain (around line 322+) calling new executors `executeMarkMobilityDone` / `executeUnmarkMobilityDone`.

### Mode filtering in [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts)

Both tools should be available in **default mode only** (the normal coach chat lane).

- **default mode**: the existing filter (`!startsWith("propose_") && !startsWith("commit_") && !startsWith("apply_") && (!startsWith("set_") || name === "set_glp1_taper_started")`) already lets `mark_*` / `unmark_*` through. ✓
- **plan_week / setup_block**: extend the existing exclusion list (currently excludes `mark_glp1_discontinued`) to also exclude `mark_mobility_done` and `unmark_mobility_done`. Planning-mode chat shouldn't be marking sessions done.
- **intake**: the existing whitelist doesn't include these. ✓ no change.

### Prompt nudge in [lib/coach/prompts.ts](lib/coach/prompts.ts)

Add a short directive to the default-mode coach system prompt:

> When the user signals they've completed today's mobility session (phrases like "done", "finished mobility", "did my session"), call `mark_mobility_done`. If they retract ("actually didn't", "scratch that"), call `unmark_mobility_done`. Don't prompt for notes — accept the completion at face value.

Keep it terse — the tool descriptions carry most of the behavioral spec; the prompt only needs to make sure the model recognizes informal completion phrasing.

## Data shape

No schema changes. The `workouts` table already supports this row shape:

```sql
-- public.workouts (existing)
id          uuid primary key
user_id     uuid not null
date        date not null
type        text       -- 'Mobility'
duration_min int       -- null
notes       text       -- null or user-mentioned
source      text       -- 'chat'
external_id text       -- 'chat-mobility-YYYY-MM-DD'  (unique on (user_id, external_id))
created_at  timestamptz
```

No `exercise_sets` rows are inserted. The volume math in [adherence.ts:227](lib/coach/adherence.ts#L227) (`bucketVolume`) iterates `exercises[].exercise_sets[]` — a workout with no exercises contributes zero volume, which is correct (mobility produces no muscle-group volume).

## Adherence behavior — no code change, verified by inspection

The existing [matches() in adherence.ts:41](lib/coach/adherence.ts#L41) does a substring match. With `planned='Mobility'` and `actual='Mobility'`, the function returns true on the dedicated mobility branch (line 48). So a chat-confirmed mobility on a planned-mobility day → `status='as_planned'`. A chat-confirmed mobility on a day swapped *to* mobility → `status='swapped'` via the `swapped_to && matches(swapped_to, a)` branch. A chat-confirmed mobility off-plan (e.g., extra mobility on a planned-REST day) → counted in `sessions_done` but not in `sessions_on_plan`, which is the correct read.

## Strong CSV interaction

- Strong's `external_id` namespace is `strong-${date}-${slug}` (see [app/api/ingest/strong/route.ts:193](app/api/ingest/strong/route.ts#L193)). Chat's namespace is `chat-mobility-${date}`. No upsert collision is possible.
- Edge case: user chat-confirms mobility, then later uploads a Strong CSV with a workout named "Mobility" for the same date. Both rows persist (distinct external_ids). [adherence.ts:139](lib/coach/adherence.ts#L139) takes the first-seen workout per day; behavior is correct (any Mobility row counts). Not worth eviction logic — this is a near-zero-frequency path.

## Files touched

- [lib/coach/tools.ts](lib/coach/tools.ts) — add `MARK_MOBILITY_DONE_TOOL`, `UNMARK_MOBILITY_DONE_TOOL` schemas + `executeMarkMobilityDone`, `executeUnmarkMobilityDone` executors. ~120 lines following existing pattern.
- [lib/coach/chat-stream.ts](lib/coach/chat-stream.ts) — import the two new schemas, add to `allTools`, extend `plan_week`/`setup_block` filter exclusions, add two `else if` branches to the dispatch.
- [lib/coach/prompts.ts](lib/coach/prompts.ts) — append the directive to the default-mode system prompt.

No migrations. No type changes outside `tools.ts`. No UI changes.

## Testing (manual — no test harness in repo)

1. `npm run typecheck` clean.
2. In the chat coach:
   - Say "done with my mobility" → coach calls `mark_mobility_done` → verify row in `workouts` with `type='Mobility'`, `source='chat'`, today's date, `external_id='chat-mobility-<today>'`.
   - Say "done mobility" again → tool returns `was_already_done: true`, no duplicate row.
   - Say "actually I didn't do it" → coach calls `unmark_mobility_done` → row gone.
   - On Sunday, check the recap: a chat-confirmed Wednesday mobility should appear in `adherence.days` as `status='as_planned'`.
3. In **plan_week** mode, the tool should not appear in the available tool list (the model can't call it).
4. Negative: passing a future date should reject with a clear tool error.

## Open questions

None. All design decisions resolved.
