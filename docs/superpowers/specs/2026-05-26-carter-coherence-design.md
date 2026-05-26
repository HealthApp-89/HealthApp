# Carter coherence — design

**Status:** spec (pre-implementation)
**Date:** 2026-05-26
**Owner:** Coach Carter chat surface + brief/logger integration
**Related:**
[2026-05-22-carter-session-write-tools-design.md](2026-05-22-carter-session-write-tools-design.md) (introduced `propose_session_today` / `propose_session_template`; this spec unblocks them in default chat mode),
[2026-05-22-workout-debrief-design.md](2026-05-22-workout-debrief-design.md) (chose client-triggered debrief; this spec adds the cron backstop that spec called out as a "future iteration"),
[2026-05-20-in-app-workout-logger-design.md](2026-05-20-in-app-workout-logger-design.md) (the logger resolution chain that the brief must mirror),
[2026-05-11-morning-brief-design.md](2026-05-11-morning-brief-design.md) (the frozen `ui` jsonb whose session block we will reconcile at render time),
[2026-05-20-carter-exercise-library-design.md](2026-05-20-carter-exercise-library-design.md) (62-entry library carrying `increment.step` + `pairedDb` that Carter must respect).

## 1. Problem

Four user-reported inconsistencies, surfaced 2026-05-26. All four trace to the same underlying gap: **Carter is disconnected from the training state the athlete sees, cannot act on it from default chat, and his recommendations are not guarded by the exercise library data that exists**.

1. **Stale brief session block.** Today the morning brief's "Today's session" block showed exercises that differed from both `/coach?sub=strength` TodayPlanCard and Carter's chat recommendation. Root cause: the brief snapshots `session.exercises` into `chat_messages.ui` at write time ([app/api/chat/morning/recommendation/route.ts](../../app/api/chat/morning/recommendation/route.ts)). The logger and strength tab re-resolve overrides at view time. Any override committed *after* the brief was written produces a guaranteed divergence with no reconciliation path.

2. **Carter cannot amend the plan from default chat.** Athlete asked Carter to "amend the logger to reflect his recommendation." Carter said he couldn't and asked the athlete to do it manually. Two compounding causes:
   - **No tool exists to edit logged sets/weights after commit.** This is correct — the logger is athlete-owned and the audit trail must not mutate.
   - **`modeAllowsTool` in [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) blanket-blocks `propose_*` / `commit_*` in default mode, with explicit allow-list for `propose_nutrition_targets` / `propose_meal_log` only.** So `propose_session_today` — the tool Carter has *for exactly this case* — is silently stripped from his toolset and he falls back to "do it manually." This is the smoking gun.

3. **Debrief did not auto-trigger.** Athlete logged a workout via the in-app logger; no debrief appeared. The existing path is client-fire-and-forget from [components/logger/LoggerSheet.tsx](../../components/logger/LoggerSheet.tsx); when that fetch is dropped (tab background, sleep, network blip, JS error), the debrief never runs and Carter has no awareness of the workout until the athlete prompts him.

4. **Off-grid weight prescription.** Carter prescribed "17 kg DB" — impossible since paired dumbbells progress in +2 kg per-DB steps (16 → 18). CARTER_BASE *does* state the rule ([lib/coach/system-prompts.ts:60–68](../../lib/coach/system-prompts.ts)). `query_exercise_library` returns `increment.step` + `pairedDb`. Carter either didn't call the tool, didn't ground in the result, or hallucinated against it. No server-side guard rejects out-of-grid weights at proposal time.

## 2. Goals and non-goals

### Goals

- Brief's session block reflects current training-week state. If overrides changed since the brief was written, the *current* plan renders and the divergence is visible to the athlete.
- Carter can propose and commit a same-day session override directly from default chat, with the existing HMAC approval-chip gate. No mode switch required.
- Every logger-sourced workout gets a debrief, even when the client fire-and-forget fails. Idempotent.
- Carter never proposes an off-grid weight when calling `propose_session_today`. Server-side validator rejects out-of-grid loads with a structured tool error → model retries.
- Carter sees today's session + this week's exercises and their increment metadata as part of his snapshot prefix, so the prompt-discipline failure of #4 has a structural fix, not just a stronger prompt.

### Non-goals

- **Editing logged sets/weights post-commit.** That work is scoped by [2026-05-25-edit-logged-workout-design.md](2026-05-25-edit-logged-workout-design.md) (athlete-owned LoggerSheet edit, not a chat tool). Carter writes the *plan*, not the *history*.
- **Unblocking `propose_session_template` / `commit_session_template` in default mode.** Template changes are mesocycle-scale commitments and belong to the deliberate `plan_week` flow. Same-day overrides (which expire at the next override write or sweep) carry less risk and are the right primitive for "Carter, change today's plan."
- **Regenerating the brief.** The brief is a daily ritual artifact; mutating it would break audit. Render-time reconciliation is the correct surface.
- **Auto-correcting off-grid weights in Carter's free-form prose** (e.g., "try 17 kg next week" outside a tool call). Regex-scanning assistant prose is fragile and risks false positives. We accept residual risk and lean on prompt + injected library data.
- **Adding `@vercel/functions` `waitUntil` for the debrief.** [2026-05-22-workout-debrief-design.md](2026-05-22-workout-debrief-design.md) §3 explicitly chose against this; we honor that decision and use a cron backstop instead.
- **Touching Peter's, Nora's, or Remi's mode gating.** This spec is Carter-only.

## 3. Fix 1 — Render-time reconciliation in BriefSessionList

### Behavior

[components/morning/BriefSessionList.tsx](../../components/morning/BriefSessionList.tsx) currently renders `session.exercises` from the frozen `MorningBriefCard.ui` prop. We add a live read of the same override chain that [components/strength/TodayPlanCard.tsx](../../components/strength/TodayPlanCard.tsx) and the logger use ([lib/logger/resolve-plan.ts](../../lib/logger/resolve-plan.ts)):

1. `training_weeks.exercise_overrides[<weekday>]` if non-empty
2. `user_session_templates[<session_type>]` if exists
3. `SESSION_PLANS[<session_type>]` (code default)

If the resolved list **diverges** from the frozen `session.exercises` (multiset comparison by exercise `key`, or by `name` for legacy rows without `key`), the component:

- Renders the **resolved list** (logger truth wins; this is what the athlete will actually train)
- Shows a `<UpdatedSinceBriefChip />` above the list with copy: "Plan updated since this morning" + a small "View original" affordance that expands the frozen list in a collapsible block
- Reuses the React Query hook from TodayPlanCard so the brief and the strength tab share one fetch / one cache entry

The frozen `ui.session.exercises` jsonb is **never overwritten**. Audit trail of "what Peter committed to you this morning" stays intact.

### Edge cases

- **Brief still in `assembling_brief` state when the user opens `/coach`.** Render unchanged — there's no frozen ui yet.
- **No `training_weeks` row for the current week.** No resolution possible; render the frozen list (= `SESSION_PLANS` fallback that the brief already used).
- **Session type *changed* via the swap endpoint after the brief was written** (e.g., brief was Chest, athlete swapped to Back). Brief's session block already carries the *old* type label; the chip copy needs to handle this: "Session type changed to Back this morning." Render the new type's exercises.
- **REST / Mobility day in the brief, athlete swapped in a training session.** Same as above; chip explains.
- **Multiple consecutive overrides within the same day.** Always compare against the *current* state, not intermediate ones. The athlete only cares about now.

### Data shape

Add a `currentSession` field (computed, not persisted) to the props the brief renderer receives:

```ts
type BriefSessionListProps = {
  frozenSession: MorningBriefCard["session"];     // from chat_messages.ui (existing)
  currentSession: {                                // new, resolved at view time
    type: SessionType;
    exercises: PlannedExercise[];
    source: "override" | "template" | "default";
  };
  divergence: { type: boolean; exercises: boolean };  // pre-computed for chip rendering
};
```

The `divergence` discriminator is computed in the parent (the chat card renderer) so the BriefSessionList stays a pure presentational component.

## 4. Fix 2 — Unblock Carter's same-day session writes in default mode

### The gate today

[lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) lines 307–323 — the `default`-mode branch of `modeAllowsTool` blocks all `propose_*` / `commit_*` tools except an explicit allow-list:

```ts
// default mode (lines 307-323, verbatim)
if (name === "propose_nutrition_targets") return true;
if (name === "commit_nutrition_targets") return true;
if (name === "propose_meal_log") return true;
if (name === "commit_meal_log") return true;
if (name.startsWith("propose_")) return false;
if (name.startsWith("commit_")) return false;
// ...
```

The block carries a code comment (lines 308–314) that exactly anticipates the bug the athlete reported:

> "propose_/commit_ tools are blocked by default to prevent accidental plan writes — but a few pairs are explicitly exempted because the athlete legitimately initiates them from chat. **New propose_/commit_ pairs added for future write features must add their own explicit allows here, or they'll be stripped from the tool list and the model will hallucinate a fake commit in prose — see 2026-05-22 Nora-meal-log silent-fail.**"

`propose_session_today` / `commit_session_today` shipped without that allow being added. Carter's tools are silently stripped in `default` mode and he falls back to prose ("do it manually"). This is the smoking gun, and the existing comment confirms it's a known failure mode for this exact pattern.

### The change

Add two `return true` lines to the default-mode allow-list, immediately after the existing `propose_meal_log` / `commit_meal_log` pair (lines 317–318):

```ts
if (name === "propose_session_today") return true;
if (name === "commit_session_today") return true;
```

That's the entire chat-stream change. The propose/commit pair already exists ([2026-05-22-carter-session-write-tools-design.md](2026-05-22-carter-session-write-tools-design.md)), already carries HMAC approval gating, already writes `training_weeks.exercise_overrides[<weekday>]`, and the logger already reads that override on next open.

### PERSIST_RESULT_TOOLS

Already correct. [lib/coach/chat-stream.ts:94–97](../../lib/coach/chat-stream.ts) confirms `propose_session_today`, `commit_session_today`, `propose_session_template`, and `commit_session_template` are all already in the `PERSIST_RESULT_TOOLS` Set. No change needed here.

### CARTER_BASE prompt update

CARTER_BASE today has this line (paraphrased from the audit):
> "Logger scope: exercises don't change — only load and rep targets do, and those are the athlete's job in the logger. Do NOT call a session-write tool when the athlete asks 'what should I lift today.'"

That instruction is partially correct (don't write a session for routine "what today" questions) but is being interpreted too broadly. When the athlete explicitly asks Carter to **change** today's plan (swap an exercise, drop a movement, substitute due to equipment/pain), the right answer is `propose_session_today`, not "do it manually."

Add a short clarification block to CARTER_BASE:

> "When the athlete explicitly asks you to change today's plan — swap an exercise, drop one, substitute due to pain or unavailable equipment — call `propose_session_today` (available in default mode). The athlete sees an approval chip; on tap, the override writes to `training_weeks.exercise_overrides[<today>]` and the logger picks it up on next open. Do NOT tell the athlete to 'do it manually in the logger.' That path is for athlete-initiated saves of their own deviations, not for executing your recommendations."

Keep the existing "don't auto-propose for routine 'what today' questions" rule. The trigger for `propose_session_today` is an **explicit change request** from the athlete, not a status query.

### Tests / audit

The `audit-speaker-routing.mjs` script already exists. Extend it with a check that scans the last N assistant messages for the phrase "manually" / "do it yourself" / "in the logger" in turns where the user message contains "swap" / "change" / "replace" / "drop" + an exercise mention. Output: list of turns Carter should have invoked `propose_session_today` and didn't. This is a heuristic regression detector, not a hard gate.

## 5. Fix 3 — Cron backstop for missed debriefs

### Decision: keep client trigger as primary

[2026-05-22-workout-debrief-design.md](2026-05-22-workout-debrief-design.md) §3 explicitly chose client-triggered over `waitUntil`:
- avoids adding `@vercel/functions` dependency
- matches the cron pattern used by morning brief, proactive nudge, weekly review
- naturally retry-able

We honor that. The new piece is the backstop that spec's §non-goals called out as a "future iteration."

### The cron

New route: `/api/coach/debrief/sweep` ([app/api/coach/debrief/sweep/route.ts](../../app/api/coach/debrief/sweep/route.ts)).

- `CRON_SECRET`-gated (same auth pattern as `/api/whoop/sync` and `/api/coach/dashboard/sync`)
- Vercel cron entry in [vercel.json](../../vercel.json): hourly. Hourly cadence ensures the worst-case latency between "logger commit dropped its debrief fetch" and "debrief appears" is ~1 hour. Daily would be too slow given the athlete's training cadence (post-session debriefs lose value if they arrive next morning).
- Query: every `workouts` row from the last 48 hours where:
  - `source = 'logger'` (i.e., `external_id LIKE 'logger-%'`) — Strong CSV is out of scope per the workout-debrief spec
  - no `chat_messages` row exists with `kind = 'workout_debrief'` and `ui->>'workout_id' = workouts.id`
- For each match: call the same generator the client-triggered route uses (extracted to a shared module if not already). Insert the resulting `chat_messages` row.
- Idempotency: the existence check above is the idempotency guard. If two sweeps race (shouldn't happen with a single cron), the second insert would still need to be guarded — but the existing `/api/coach/workout-debrief` route already checks "is there already a debrief for this workout?" and we reuse that.

48-hour lookback is the slack window: covers a missed sweep + a delayed sync without re-debriefing workouts from a week ago that the athlete has already moved past.

### Server-side trigger improvement (optional, low-risk)

Inside [app/api/logger/session/route.ts](../../app/api/logger/session/route.ts), after `commit_logger_session` succeeds and before the route returns:

```ts
// fire-and-forget; do not await; do not block the response
fetch(`${getAppUrl()}/api/coach/workout-debrief`, {
  method: "POST",
  headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, ... },
  body: JSON.stringify({ workout_id }),
}).catch(() => { /* sweep will pick it up */ });
```

This is a same-region in-process fetch that completes within Vercel's response-already-sent grace period (typically tens of milliseconds before serverless suspend). Not a guarantee — that's why the sweep exists — but a meaningful reliability improvement.

**Trade-off:** introduces an `INTERNAL_TOKEN` env var (or reuses `CRON_SECRET` with a header convention) to allow the server-to-server call without an authenticated user cookie. Acceptable; we already do this for cron routes.

If reviewers prefer to skip the server-side trigger and rely entirely on the cron sweep, we can defer it. The sweep alone is sufficient for correctness; the server-side trigger is purely a latency improvement.

### LoggerSheet client behavior

No change to the existing client-triggered fetch. Belt + suspenders: client fires first (best case → debrief appears within seconds), server-side fires second (covers client failures), cron sweep third (covers both).

## 6. Fix 4 — Carter never proposes off-grid weights

### Layer 1: inject this week's exercises + increments into Carter's snapshot prefix

Today Carter must call `query_exercise_library` to learn `increment.step` and `pairedDb` for any exercise. That's an extra round trip and a discipline failure mode (skip the call → hallucinate).

We compute, for every chat-stream call where the speaker is Carter (or Peter delegating to Carter), the union of exercises in the current `training_weeks.session_plan` resolved through the override chain. For each exercise, we include:

```
- {name}: increment.step = {N} kg, pairedDb = {true|false}, current baseKg = {from user_session_templates or SESSION_PLANS default}
```

This block is appended to Carter's snapshot prefix (after the existing snapshot, before `peterContext`). Token cost: 7 exercises × ~25 tokens ≈ 175 tokens. Acceptable.

The block lives in a new module [lib/coach/carter-context/this-weeks-exercises.ts](../../lib/coach/carter-context/this-weeks-exercises.ts), called from [app/api/chat/messages/route.ts](../../app/api/chat/messages/route.ts) where snapshot assembly happens.

### Layer 2: tighten the prompt to cite the step

Add to CARTER_BASE, in the existing dumbbell-rules block:

> "Before stating any specific weight, cite the increment.step you are rounding to. Example: 'Lateral Raise step is 2 kg per DB, paired — so 16 kg → 18 kg, not 17.' If you cannot see the step in the context block, refuse to propose a number and call `query_exercise_library` first."

This makes hallucinations visible mid-stream: any "17 kg DB" without a preceding "step is 2 kg per DB" citation is obviously wrong on inspection.

### Layer 3: server-side validator on `propose_session_today` payloads

The propose tool's input schema today (per [2026-05-22-carter-session-write-tools-design.md](2026-05-22-carter-session-write-tools-design.md)) accepts `exercises: PlannedExercise[]` with `baseKg?: number`. Today there is no validation that `baseKg` is on-grid for the exercise.

Add validation in the propose executor: for each `exercise` in the payload with a `baseKg`, look up the exercise in the library (by `key` or `name`), get `increment.step` and `pairedDb`, and reject if `baseKg % step !== 0` (with a small tolerance for legacy half-step machines if `increment.intermediate` is set).

On rejection, return a structured tool error like:

```json
{
  "error": "off_grid_weight",
  "exercise": "lateral_raise",
  "proposed": 17,
  "valid_steps": [16, 18, 20, 22],
  "rule": "Paired DB, step 2 kg per DB"
}
```

Anthropic's model loop sees the tool error and retries with a corrected value. No human-in-the-loop needed.

### Layer 4 (deferred): free-form prose

We do not scan Carter's free-form assistant prose for off-grid weights in v1. Regex against `\d+\s*kg` near exercise names produces too many false positives (warmup loads, historical references, hypotheticals). Layers 1–3 catch the structured cases; prose remains a prompt-discipline issue. Revisit if the athlete reports recurrence after layer 1 ships.

## 7. Implementation order

Suggested sequence (each step independently shippable):

1. **Fix 2 (mode gate + prompt clarification)** — smallest diff, biggest user-visible impact. Two lines in `modeAllowsTool`, one paragraph in CARTER_BASE, possibly two entries in `PERSIST_RESULT_TOOLS`.
2. **Fix 4 layer 1 (snapshot injection)** — new module, single integration point, observable in any Carter chat.
3. **Fix 4 layers 2–3 (prompt + validator)** — prompt edit + tool-input validation in the propose executor.
4. **Fix 3 (cron sweep + optional server-side trigger)** — new route, new cron entry, optional route handler addition.
5. **Fix 1 (brief reconciliation)** — component change + React Query hook reuse. Last because it touches the most-used UI surface and benefits from the other fixes being in place (when overrides change, they were probably written by Carter via Fix 2).

## 8. Surfaces touched

| File | Change |
|---|---|
| [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) | Two `return true` lines added to `modeAllowsTool` default-mode allow-list (Fix 2). `PERSIST_RESULT_TOOLS` already correct, no change. |
| [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) | CARTER_BASE clarifications (Fix 2 + Fix 4 layer 2). |
| [lib/coach/carter-context/this-weeks-exercises.ts](../../lib/coach/carter-context/this-weeks-exercises.ts) | New module (Fix 4 layer 1). |
| [app/api/chat/messages/route.ts](../../app/api/chat/messages/route.ts) | Wire `this-weeks-exercises` into snapshot assembly for Carter / Peter-delegating-to-Carter (Fix 4 layer 1). |
| [lib/coach/tools.ts](../../lib/coach/tools.ts) | Add `off_grid_weight` validation in `propose_session_today` executor (Fix 4 layer 3). |
| [app/api/coach/debrief/sweep/route.ts](../../app/api/coach/debrief/sweep/route.ts) | New cron route (Fix 3). |
| [vercel.json](../../vercel.json) | Hourly cron entry for `/api/coach/debrief/sweep` (Fix 3). |
| [app/api/logger/session/route.ts](../../app/api/logger/session/route.ts) | Optional fire-and-forget server-side debrief trigger (Fix 3). |
| [components/morning/BriefSessionList.tsx](../../components/morning/BriefSessionList.tsx) | Render-time reconciliation + `<UpdatedSinceBriefChip />` (Fix 1). |
| [components/chat/MorningBriefCard.tsx](../../components/chat/MorningBriefCard.tsx) (or wherever the brief renderer composes its props) | Compute `currentSession` + `divergence`; pass to BriefSessionList (Fix 1). |
| [scripts/audit-speaker-routing.mjs](../../scripts/audit-speaker-routing.mjs) | Heuristic check for "told the athlete to do it manually" misfires (Fix 2). Optional. |

No database migrations. No schema changes. All fixes operate on existing tables and existing tool primitives.

## 9. What can go wrong

- **Fix 1 (reconciliation) ships before Fix 2 (Carter writes).** Low risk — divergence already exists today (the user reported it). Reconciliation simply makes the truth visible; it doesn't introduce new divergence.
- **Fix 2 unlocks Carter to write overrides users didn't fully understand.** The HMAC approval chip is the safety net — every write goes through explicit user approval. Same gate that protects nutrition-target writes today.
- **Fix 3 cron fires duplicate debriefs.** The idempotency check (look up existing `chat_messages.kind='workout_debrief'` with matching `workout_id`) prevents this. If a race happens, the second insert no-ops.
- **Fix 4 snapshot injection bloats every Carter prompt.** 175 tokens per turn is well within budget; if it ever matters, gate the injection to chat modes where Carter is the active speaker.
- **Fix 4 validator rejects a legitimate proposal** (e.g., a machine with non-standard fractional plates). Catch via the `increment.intermediate` field that already exists on library entries; if a library row is mis-tagged, fix the library row, not the validator.

## 10. Open questions

None at spec-write time. All four fixes have a clear surface, no schema changes, no dependency conflicts, and respect prior architectural decisions in the related specs.
