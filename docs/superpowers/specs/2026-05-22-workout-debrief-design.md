# Workout debrief — design

**Status:** spec (pre-implementation)
**Date:** 2026-05-22
**Owner:** Coach Carter post-save analysis
**Related:**
[2026-05-22-carter-session-write-tools-design.md](2026-05-22-carter-session-write-tools-design.md) (just-shipped feature; Carter now writes session content),
[2026-05-15-weekly-review-document-design.md](2026-05-15-weekly-review-document-design.md) (the surface-shape pattern: chat-card TL;DR + dedicated page),
[2026-05-20-in-app-workout-logger-design.md](2026-05-20-in-app-workout-logger-design.md) (the trigger surface — `commit_logger_session`),
[2026-05-16-proactive-coach-reach-out-design.md](2026-05-16-proactive-coach-reach-out-design.md) (the pure-templating-into-prose composer pattern).

## 1. Problem

When the athlete finishes a workout and taps Save, the only feedback the app gives is "session committed". No interpretation. The athlete has just done the work — this is the highest-leverage moment for coach feedback (memory is fresh, decisions about next session are mid-formation), and Carter has all the context to deliver it (today's sets, last session's sets for the same lifts, block phase, volume bands, recovery state).

Today Carter responds only on chat turns the athlete initiates. The model is stateless; pure prompt changes cannot make Carter push messages autonomously. We need a server-side trigger plus a new chat-message flow.

## 2. Goals and non-goals

### Goals

- Carter automatically publishes a deep-dive debrief to chat after every committed logger session.
- Debrief is block-aware: it knows the mesocycle phase (accumulate vs deload), the week number, the prescribed RIR, and whether today's volume puts the athlete inside MEV→MAV→MRV bands for the muscles hit.
- Debrief surfaces as both: (a) a chat card in `/coach` (TL;DR + Carter prose + link), (b) a dedicated page at `/coach/sessions/<workout_id>` (full per-lift table, volume bars, autoregulation read, prescription block).
- Numbers come from deterministic composers; only the wrapping narrative is AI-generated. Same posture as morning brief, weekly review, plan-builder.
- Save stays snappy — the debrief is generated asynchronously after the route returns.

### Non-goals

- Cross-week trend analysis. The debrief is single-session-focused; the weekly review and `/coach/trends` already do block-level synthesis.
- AI-generated weight prescriptions. Prescriptions are rule-based (PR → +increment, stall → hold, regression → -2.5kg or deload); Carter's narrative *explains* them, doesn't invent them.
- Debrief on Strong CSV imports. The athlete has moved off CSV and uses the in-app logger exclusively (`profiles.disable_strong_ingest = true` is the going-forward path). If they re-enable CSV ingest, debrief generation does not fire on those rows.
- Debrief on REST / Mobility days. Those don't commit through `commit_logger_session`.
- Retry UI. Failures log silently in v1; if a debrief doesn't appear, the athlete can re-trigger via an explicit chat ask. Retry button is a future iteration.
- Suppression toggle. No `profiles.disable_workout_debrief` flag in v1 (YAGNI; the athlete picked this feature explicitly).

## 3. Trigger architecture

`commit_logger_session` already runs as an atomic 3-table insert via the SECURITY DEFINER RPC ([scripts/audit-logger-write-path.mjs](../../scripts/audit-logger-write-path.mjs), migration 0026). The route handler at
[app/api/logger/session/route.ts](../../app/api/logger/session/route.ts) returns success once the row is committed.

**Pattern:** the route returns success first. The client (`LoggerSheet` save handler) then fires a POST to a new
`/api/coach/workout-debrief` endpoint with the workout id. That endpoint runs the generator and inserts the
`chat_messages` row.

**Why client-triggered, not server `waitUntil`:**
- Vercel serverless functions are killed when the response is sent. `waitUntil` (from `@vercel/functions`) extends the lifetime but adds a runtime dependency and a configuration surface we don't already use elsewhere in the codebase.
- The morning brief, proactive nudge, and weekly review all use **cron** triggers, not `waitUntil`. We follow the established pattern of explicit endpoints instead of relying on extended-runtime promises.
- A client trigger is naturally retry-able from the client. If the network drops between the two requests, the user can re-tap a button or the next page render can detect the missing debrief and re-fire (future iteration).

Client flow:

```
LoggerSheet.onSave():
  1. POST /api/logger/session  → returns 200 OK with { workout_id }
  2. immediately POST /api/coach/workout-debrief { workout_id } (no await on the UI thread)
  3. UI navigates / closes the sheet
  
/api/coach/workout-debrief:
  - auth.getUser() — must be the workout's owner
  - generateWorkoutDebrief({ supabase, userId, workoutId })
  - insert chat_messages row
  - revalidatePath("/coach"), revalidatePath(`/coach/sessions/${workoutId}`)
  - return { ok: true, chat_message_id }
```

If step 2 silently fails (network, function timeout), the chat row simply doesn't appear. No corruption — the workout row is already committed by step 1.

**Idempotency:** the endpoint checks for an existing
`chat_messages` row with `kind='workout_debrief'` and `ui->>'workout_id' = workoutId`. If found, returns the existing id without regenerating. Repeat calls are safe.

## 4. The generator

`lib/coach/session-debrief/index.ts` is the orchestrator:

```ts
export async function generateWorkoutDebrief(opts: {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
}): Promise<{ payload: WorkoutDebriefPayload; tldr: string; narrative_md: string }> {
  // 1. Load this workout + sets (using exercise_id joins).
  // 2. Parallel-fetch context:
  //    - Last session of the same `type` (training_weeks-aware: the type label
  //      may not perfectly match, so we also accept the same `session_type` 
  //      label heuristically).
  //    - Active training_blocks row + week-N (via existing `useBlockProgress` 
  //      logic, called server-side).
  //    - daily_logs for today + yesterday (autoregulation context).
  //    - profiles.whoop_baselines (for HRV interpretation).
  //    - Recent body_measurements (for strength-per-LBM context).
  //    - Volume aggregations for the current week (sum_workouts up to today).
  // 3. Run 4 pure composers (composeLifts, composeVolume, composeAutoregulation, 
  //    composePrescription). Each returns a typed slice of the payload.
  // 4. Assemble the typed `WorkoutDebriefPayload`.
  // 5. Render `tldr` (composer-templated, no AI).
  // 6. Single Sonnet 4.6 call: `narrativePrompt(payload)` returns Markdown.
  // 7. Return { payload, tldr, narrative_md }.
}
```

### Composer responsibilities

- **`compose-lifts.ts`** — for each exercise in today's workout, find the top working set (highest e1RM, warmups excluded). Find the same exercise's top set in the previous session of the same `type`. Compute `delta_e1rm`. Tag as `"PR"` (best e1RM across the last 4 sessions), `"stall"` (within 1% of the last session), `"regression"` (>2% below), or `null` (first time / no prior data). Returns `lifts: Array<{...}>` per the payload shape.
- **`compose-volume.ts`** — for each muscle group hit today (primary + secondary with the secondary_set_factor weighting), sum hard sets across the current week (Monday → today). Compare against the literature-band from [lib/coach/volume-landmarks.ts](../../lib/coach/volume-landmarks.ts). Tag as `"below_mev"`, `"in_mav"`, `"approaching_mrv"`, or `"over_mrv"`. Returns `volume: Array<{...}>`.
- **`compose-autoregulation.ts`** — pulls today + yesterday `daily_logs` (HRV, recovery, sleep_score, sleep_hours, strain). Builds a one-paragraph string interpretation (deterministic templating): e.g. "Recovery 41% (low band relative to 14d baseline of 62%). HRV down 18ms from baseline. Sleep 5.3h. This session was performed with a fatigue debt — expect lower top sets and longer rest needs." Returns `autoregulation: {...}`.
- **`compose-prescription.ts`** — rule-based weight adjustments for the next session of the same type. For each lift:
  - PR + RIR ≤ prescribed → add `increment.step` next session.
  - Stall + RIR > prescribed → hold weight, target prescribed RIR.
  - Stall + RIR ≤ prescribed → consider deload next week (flag, but don't auto-apply — Carter narrative explains).
  - Regression → drop by `increment.step`.
  - Optional note: if the muscle is `over_mrv` per `compose-volume`, prescription adds a `notes: ["Drop volume on <muscle> by 1 set next session"]`.

### Narrative prompt

`lib/coach/session-debrief/narrative-prompt.ts` is the single Sonnet 4.6 call. Input: the assembled `WorkoutDebriefPayload`. Output: Markdown narrative (2-4 short paragraphs).

Posture: Carter voice (direct, technical, numeric). The prompt explicitly instructs:
- Don't restate the table — comment on it. Highlight 1-2 lifts (the PRs, the stalls).
- Cite the block context (week N of M, accumulate or deload).
- Reference the autoregulation interpretation if it explains a result ("the squat dip lines up with HRV 18ms below baseline this morning").
- Close with the prescription block paraphrased in coach voice — one sentence per change.
- Numbers, not vibes. Same numeric-citation rule as `CARTER_BASE`.

## 5. Surface — chat card + dedicated page

### Chat card (`kind='workout_debrief'`)

Rendered inline in `/coach` like other structured cards (`morning_brief`, `weekly_review`, `proactive_nudge`).

- **Eyebrow**: `"{session_type} debrief · {date_short}"` (e.g. "Arms debrief · Fri")
- **TL;DR block** (composer-templated, NOT AI): 2-3 lines like
  ```
  ✓ 2 PRs (Bicep Curl +1.5kg e1RM, Hammer Curl +2.0kg e1RM)
  ⚠ Lateral Raise stalled (same load as last session)
  Recovery: 72% (good band). Volume: biceps in MAV, side delts approaching MRV.
  ```
- **Narrative section**: first paragraph of `narrative_md` (truncated at ~280 chars).
- **CTA**: "Read full debrief →" link to `/coach/sessions/<workout_id>`.

`chat_messages.content` field holds the TL;DR (so it's searchable via the existing chat history).

### Dedicated page — `/coach/sessions/[workout_id]/page.tsx`

Server component. Reads the `chat_messages` row by `ui->>'workout_id' = $1 AND kind = 'workout_debrief' AND user_id = $auth`. RLS-respecting.

Sections (top to bottom):
1. **Header** — session type, date, mesocycle week N of M, accumulate/deload chip.
2. **Per-lift table** — name, top set today (kg × reps), top set last (kg × reps + date), e1RM delta, tag (PR / stall / regression).
3. **Volume vs landmarks** — per-muscle horizontal bar with MEV / MAV-low / MAV-high / MRV markers; today's bar fills based on `sets_this_week`.
4. **Autoregulation read** — paragraph from `compose-autoregulation`.
5. **Coach Carter** — full `narrative_md`, rendered as Markdown.
6. **Prescription block** — bulleted weight changes for next session.

If the user navigates here before the debrief is generated (rare race condition), the page shows a "Carter is still reviewing this session…" placeholder with a polling refresh. v1: just a static message + manual refresh.

## 6. Data shapes

### `WorkoutDebriefPayload` (typed jsonb stored on `chat_messages.ui`)

```ts
type WorkoutDebriefPayload = {
  workout_id: string;
  date: string;                  // YYYY-MM-DD
  session_type: string;

  block: {
    week_num: number | null;
    total_weeks: number | null;
    phase: "accumulate" | "deload" | null;
    rir_target: number | null;
  };

  lifts: Array<{
    name: string;
    top_set_today: { kg: number | null; reps: number | null; e1rm: number | null };
    top_set_last:  { kg: number | null; reps: number | null; e1rm: number | null; date: string | null };
    delta_e1rm: number | null;
    rir_today: number | null;
    tag: "PR" | "stall" | "regression" | null;
  }>;

  volume: Array<{
    muscle: string;
    sets_today: number;
    sets_this_week: number;
    band: { mev: number; mav_low: number; mav_high: number; mrv: number };
    status: "below_mev" | "in_mav" | "approaching_mrv" | "over_mrv";
  }>;

  autoregulation: {
    today_recovery: number | null;
    today_hrv:      number | null;
    today_sleep_hours: number | null;
    today_strain:   number | null;
    interpretation: string;        // deterministic templating
  };

  body_comp: {
    weight_kg:        number | null;
    fat_free_mass_kg: number | null;
    strength_per_lbm: { lift: string; ratio: number; trend: "up" | "flat" | "down" } | null;
  } | null;

  prescription: {
    next_session_date: string | null;
    weight_changes: Array<{ exercise: string; new_kg: number; rationale: string }>;
    notes: string[];
  };

  narrative_md: string;
  tldr: string;
};
```

### `chat_messages` row

| Column | Value |
|---|---|
| `user_id` | the athlete |
| `speaker` | `'carter'` |
| `kind` | `'workout_debrief'` (new, requires migration 0032) |
| `content` | the `tldr` string (searchable) |
| `ui` | the full `WorkoutDebriefPayload` jsonb |
| `tool_calls` | `null` |
| `created_at` | now() |

Persisted index for fast lookup-by-workout: a new partial index `chat_messages_workout_debrief_idx` on
`(user_id, (ui->>'workout_id'))` where `kind = 'workout_debrief'`. Powers the idempotency check on the
`/api/coach/workout-debrief` endpoint.

## 7. Files touched

| Path | Action |
|---|---|
| `supabase/migrations/0032_workout_debrief.sql` | new — widen `chat_messages_kind_check` to include `'workout_debrief'`, add partial index for lookup-by-workout |
| `lib/data/types.ts` | extend `chat_messages.kind` union; add `WorkoutDebriefPayload` type |
| `lib/coach/session-debrief/index.ts` | new — orchestrator |
| `lib/coach/session-debrief/payload.ts` | new — typed payload + utilities |
| `lib/coach/session-debrief/compose-lifts.ts` | new |
| `lib/coach/session-debrief/compose-volume.ts` | new |
| `lib/coach/session-debrief/compose-autoregulation.ts` | new |
| `lib/coach/session-debrief/compose-prescription.ts` | new |
| `lib/coach/session-debrief/narrative-prompt.ts` | new — single Sonnet call |
| `app/api/coach/workout-debrief/route.ts` | new — endpoint that runs the generator and writes the chat row |
| `components/logger/LoggerSheet.tsx` | modify — after `commit_logger_session` succeeds, fire-and-forget POST to `/api/coach/workout-debrief` |
| `components/chat/WorkoutDebriefCard.tsx` | new — chat card UI |
| `components/chat/ChatMessage.tsx` | modify — add render branch for `kind='workout_debrief'` |
| `app/coach/sessions/[workout_id]/page.tsx` | new — full debrief page |
| `components/coach/SessionDebriefView.tsx` | new — the page's render component (per-lift table, volume bars, etc.) |
| `scripts/audit-workout-debrief.mjs` | new — verify: every committed workout in the last N days has either a `chat_messages.kind='workout_debrief'` row or a logged failure (sanity check for the trigger) |

## 8. Edge cases

| Case | Behavior |
|---|---|
| First-ever workout (no last session) | `lifts[].top_set_last` fields are null; tag is `null` (no comparison possible). Narrative says "first <type> session of the block — building the baseline." |
| Workout has zero working sets (only warmups) | Skip debrief generation. Insert no chat row. Return `{ ok: true, skipped: "no_working_sets" }`. |
| User logs a non-standard session type (e.g. "Cardio Mix") not in `SESSION_PLANS` | Composers still run on whatever exercises are in the workout. Volume composer uses muscle attribution from the exercise library; unknown exercises (free-form names from Carter session-write tools) skip volume rollup. Narrative still works on the lift table + autoregulation. |
| No active `training_blocks` row | `block` fields are null. Composer skips the accumulate/deload framing. Narrative still works. |
| User deletes the chat card | Idempotency check uses the partial index; if the row is gone, a future explicit re-trigger (via a future "ask Carter to debrief this session" tool) regenerates. Not an automatic re-fire. |
| Vercel function times out before insert | No chat row. Workout row already committed (separate request). Athlete sees Save succeed but no debrief. No data corruption. v1: log + move on. |
| Generator fails (Anthropic 5xx, composer throws) | Endpoint returns `{ ok: false, error }` to the client; client doesn't surface the error (it's a background request). Failure is logged server-side. |
| Strong CSV ingest (legacy path) | The ingest route does NOT call `/api/coach/workout-debrief`. Only the in-app logger triggers debriefs. |
| Workout edited after save (future feature, not v1) | Out of scope. v1 generates the debrief once at commit time. |

## 9. Verification (per CLAUDE.md — no test suite)

1. `npm run typecheck` clean.
2. Log a session via the in-app logger → after Save returns, within 5-10s a Carter chat row appears at `/coach` with the `workout_debrief` card.
3. Click "Read full debrief →" → `/coach/sessions/<workout_id>` renders the per-lift table, volume bars, autoregulation, narrative, prescription.
4. Re-trigger the endpoint (manually POST with the same workout_id) → returns the existing chat_message_id, no new row.
5. Log a second session of the same type a few days later → that session's debrief shows `top_set_last` referring to the prior session, with correct delta + tag.
6. Edge: a workout with only warmup sets → no debrief row.
7. Audit script: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-workout-debrief.mjs` — confirms every recent committed workout has either a corresponding debrief chat row or was skipped legitimately.

## 10. Future iterations (deferred)

- **Retry UI**: a "Carter didn't review this session — try again" button on the workout row in `/strength?tab=date`.
- **Suppression toggle**: `profiles.disable_workout_debrief`.
- **Per-lift PR celebration**: explicit micro-card highlighting the PR before the full debrief renders.
- **Trend-aware narrative**: pull `/coach/trends` slope data into the prompt for richer multi-session synthesis (currently the weekly review owns that synthesis).
- **Streaming the narrative live**: server-sent events instead of waiting for the full Sonnet response, so the chat card pops as the narrative streams in.
