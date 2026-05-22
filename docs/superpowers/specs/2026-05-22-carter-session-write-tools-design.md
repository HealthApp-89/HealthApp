# Carter session-write tools — design

**Status:** spec (pre-implementation)
**Date:** 2026-05-22
**Owner:** strength specialist (Carter) chat capability
**Related:** [2026-05-20-strength-coaching-process-research.md](2026-05-20-strength-coaching-process-research.md) (methodology, school 2),
[2026-05-20-carter-exercise-library-design.md](2026-05-20-carter-exercise-library-design.md) (the 62-entry catalog Carter reads),
[2026-05-20-in-app-workout-logger-design.md](2026-05-20-in-app-workout-logger-design.md) (logger resolution chain),
[2026-05-19-multi-coach-team-design.md](2026-05-19-multi-coach-team-design.md) (per-specialist tool partitioning).

## 1. Problem

The athlete's `/strength` "Today's session" card renders empty for any session
type without a hard-coded entry in [`SESSION_PLANS`](../../lib/coach/sessionPlans.ts).
The shipped types are Chest, Legs, Back, Mobility — nothing else. When the
athlete's weekly plan has, for example, "Arms" on Wednesday, the card has no
exercises to display and the logger opens empty.

In chat, when the athlete asks Coach Carter to "set today's arms session", he
narrates the exercises but cannot persist them. The defection ("ask Peter")
is correct given his current tools: [`CARTER_TOOLS`](../../lib/coach/tools.ts)
gives him `propose_week_plan` / `commit_week_plan`, which write the **session-type
labels** in `training_weeks.session_plan` (Mon-Sun map) but NOT the exercises
inside each session. Peter has the same gap.

Two write surfaces could in principle carry the exercises:

- `training_weeks.exercise_overrides[<weekday>]` — but the only write path
  ([`/api/training-weeks/[week_start]/exercise-overrides`](../../app/api/training-weeks/%5Bweek_start%5D/exercise-overrides/route.ts))
  is permutation-only: it validates that the submitted names are the exact
  multiset of `SESSION_PLANS[type]`. Since `SESSION_PLANS["Arms"]` is `[]`,
  the route can't accept any list at all for an Arms day.
- `user_session_templates[session_type]` — table exists (migration 0026), but
  there is no chat-tool write path. Only the logger's "Save deviations as my
  default" UI writes it.

Net: the specialist coach has no write capability over his own prescription
artefact. This spec gives him two new HMAC-gated tools and a small rendering
fix so the writes surface on `/strength`.

## 2. Goals and non-goals

### Goals

- Carter (and only Carter) can write the **exercise list** of a session
  type or of a single day, through chat, with athlete approval.
- The two write surfaces honor the team's chosen methodology
  ([school 2](2026-05-20-strength-coaching-process-research.md) — main lifts
  sticky for years, accessories rotate 1–2 per block boundary, within-block
  changes are load-only).
- The `/strength` TodayPlanCard and the logger render the same exercise
  list, so the athlete sees one source of truth.
- New tools follow the existing `propose_*` / `commit_*` HMAC pattern
  ([approval-token.ts](../../lib/coach/approval-token.ts)) — symmetric with
  `propose_week_plan` and `propose_nutrition_targets`.

### Non-goals

- Auto-rotation of accessories at block boundaries. Carter still calls
  `propose_session_template` explicitly when a rotation is due.
- Surfacing template metadata (movement-pattern coverage, primary-muscle
  volume sums) in the preview chip. Future iteration if it proves useful.
- A `/profile` catalog page for browsing/editing templates outside chat.
  The logger's "Save deviations as my default" remains the alternative
  direct path.
- Touching `propose_week_plan` (still owns the session-type labels) or
  the `/exercise-overrides` reorder route (still permutation-only — the
  contract that protects the drag-to-reorder chip).
- Giving Peter the new tools. The user's explicit principle: "specialist
  coach should have control over his specialty." Peter routes/defers.

## 3. The two new tools

Both follow the existing `propose_*` / `commit_*` HMAC pattern. The model
calls `propose_*` to produce a preview + signed token; the athlete sees a
preview chip and taps Approve; the UI POSTs to the existing approval route,
which calls `commit_*` with the token; the executor verifies HMAC and writes.

### Tool A — `propose_session_today` / `commit_session_today`

**Purpose:** patch today's exercises only. Writes
`training_weeks.exercise_overrides[<weekdayLong>] = exercises` for the week
containing today. Tomorrow's same-type session reverts to the template
(no persistence beyond today's slot).

**When Carter uses it (anchored to swap-policy rules):**

- Rule 1 — pain or suspicious tweak: swap a movement to a same-pattern
  alternative with lower stability cost or different joint angle.
- Rule 3 — equipment unavailable: forced swap to the closest pattern match.
- Athlete-driven illness scaling: drop volume / intensity / one accessory.
- Rule 6 — athlete-raised boredom (mid-block, one accessory): one-day taste
  change without rewriting the template.

**Input schema:**

```ts
{
  weekday:    "Monday" | "Tuesday" | ... | "Sunday";   // full name
  exercises:  PlannedExercise[];   // same shape as SESSION_PLANS rows
  rationale:  string;              // 4-400 chars; shown on the chip
}
```

`PlannedExercise` shape from
[lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts):
`{ name, baseKg?, baseReps?, sets?, reps?, warmup?, key?, note?, increment? }`.

**propose returns:** `{ preview, approval_token }` — HMAC-signed envelope
with `action: "session_today"`, `userId`, `payloadHash`.

**commit behavior:**

1. `verifyApprovalToken({ token, userId, action: "session_today" })`. On
   error, return the user-facing message verbatim
   (see [approvalTokenUserMessage](../../lib/coach/approval-token.ts)).
2. Resolve `weekStart` = Monday of today (user_tz: Europe/Paris, matching
   `todayInUserTz`).
3. Load `training_weeks` row by `(user_id, week_start)`.
4. If no row exists: return coach-voice error
   `"No weekly plan committed yet for this week. Tell me 'plan my week' first."`
   The week-plan tool runs the type labels; this tool fills in the inside.
5. Merge: `next_overrides = { ...row.exercise_overrides, [weekday]: exercises }`.
6. Update `exercise_overrides = next_overrides`, bump `updated_at`.
7. `revalidatePath("/")`, `revalidatePath("/metrics")`, `revalidatePath("/strength")`.
8. Return the committed row.

### Tool B — `propose_session_template` / `commit_session_template`

**Purpose:** define the canonical exercise list for a session type
(e.g. what "Arms" contains). Persists across weeks. Writes
`user_session_templates[session_type]`.

**When Carter uses it:**

- First-time setup of a session type (today's gap: the type label exists in
  the week plan but no template exists yet → card empty).
- Swap-policy rule 5 — block-boundary 1–2 accessory rotation. The template
  is the right surface because it changes what the session-type means going
  forward, not just today.

**Input schema:**

```ts
{
  session_type:  string;          // e.g. "Arms", "Push", "Pull"
  exercises:     PlannedExercise[];
  rationale:     string;          // 4-400 chars
}
```

**propose returns:** `{ preview, approval_token }` with
`action: "session_template"`.

**commit behavior:**

1. `verifyApprovalToken({ token, userId, action: "session_template" })`.
2. `supabase.from("user_session_templates").upsert({
     user_id, session_type, exercises, updated_at: now()
   }, { onConflict: "user_id,session_type" })`.
3. `revalidatePath("/")`, `revalidatePath("/metrics")`, `revalidatePath("/strength")`.
4. Return the upserted row.

### Why two tools instead of one with a `persist: boolean` flag

The audience for the two writes is genuinely different:

- Template = "Carter, this is what Arms means going forward."
- Override = "Carter, today only — my elbow is sore."

The athlete's mental model is different, the swap-policy trigger is
different, and the surface that holds the result is different. Collapsing
them into one tool with a flag forces the prompt to teach Carter when to
flip the flag — that's harder to enforce than two named tools each
documented with their own trigger conditions.

### Library-first naming (lives in the prompt, not the schema)

Carter is instructed in `CARTER_BASE` to call `query_exercise_library` or
`get_substitutes` first to pull canonical names from the 62-entry catalog
([lib/coach/exercise-library.ts](../../lib/coach/exercise-library.ts)).
Free-form names are allowed when the library has a genuine gap; Carter must
flag this in the `rationale` so the athlete knows the row will skip
downstream metadata (session-structure tier, get_substitutes lookups).

We deliberately do NOT validate names against the library in the schema.
Validation in the prompt + flag in the rationale = forward progress when
the library has gaps; schema-level validation would block the athlete on
catalog completeness and break "give Carter actual write power over his
specialty."

## 4. Prompt changes — `CARTER_BASE`

Three edits to [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts).

### 4.1 New "Session content" block

Inserted after the existing "Exercise library:" paragraph and before the
swap-policy decision tree:

```
Session content. The week-plan tools write the session-type *labels*
(Mon=Chest, Wed=Arms, ...). They do NOT write the exercises inside each
session. You have two more write tools for session content, both gated by
an Approve chip:

  - propose_session_template / commit_session_template — defines the
    canonical exercise list for a session type (what "Arms" contains).
    Persists across weeks. Use it when:
      * the session type has no exercises set up yet (e.g. the card is
        empty because no template exists);
      * a block boundary triggers the 1-2 accessory rotation (swap-policy
        rule 5). You're changing what the session-type means going forward,
        not patching one day.

  - propose_session_today / commit_session_today — patches TODAY only,
    doesn't persist. Use it for mid-block exceptions in the swap policy:
    pain (rule 1), equipment unavailable (rule 3), illness scaling, or
    athlete-raised boredom (rule 6). Tomorrow's same-type session reverts
    to the template.

Within a block, exercises don't change — only load and rep targets do, and
those are the athlete's job in the logger. You do NOT call a session-write
tool when the athlete asks "what should I lift today" — the answer is
"your standing session; here's the load progression for week N."
```

### 4.2 Append one sentence to the "Exercise library:" paragraph

```
Before calling propose_session_template or propose_session_today, call
query_exercise_library or get_substitutes to pull canonical names. Library
entries carry metadata (movement pattern, primary muscle, joint stress,
microloadability) that session-structure annotation and get_substitutes
depend on downstream. Free-form names are allowed when the library has a
genuine gap — flag this in the rationale so the athlete knows it will skip
downstream metadata.
```

### 4.3 Replace the closing line

The current closing line — `"Suggesting a swap is fine in chat. Actually
changing the week's plan still goes through propose_week_plan /
commit_week_plan — the library is read-only."` — is the line that produced
the "I can't, ask Peter" reply. It becomes:

```
"Suggest" and "do" are the same action for you: when the athlete asks you
to set a session, build a workout, or swap an exercise, you call the
relevant propose_* tool — don't narrate exercises in chat and leave the
athlete to type them in somewhere. The athlete sees a preview chip and
approves; the /strength card and the logger pick up the change
automatically. The exercise library itself is read-only (it is the
catalog), but your prescription artefacts — week labels, session
templates, today overrides — you write.
```

### 4.4 What stays untouched

- The full swap-policy decision tree (rules 1-6, urgency order).
- The main-lift exception paragraph.
- Voice / format / numeric-citation rules.
- Lane boundaries (no nutrition, no body comp, redirect to Peter).
- Peter's prompt — Peter does NOT get the new tools. The specialist owns
  the specialty.

## 5. The one rendering fix that ships with this work

`getEffectiveSessionPlan` ([lib/coach/sessionPlans.ts:87](../../lib/coach/sessionPlans.ts))
reads `exercise_overrides → SESSION_PLANS`. The logger's `resolveSessionPlan`
([lib/logger/resolve-plan.ts](../../lib/logger/resolve-plan.ts)) reads
`exercise_overrides → user_session_templates → SESSION_PLANS`. The
strength card and the logger therefore disagree when a template exists
but no override exists — the logger would show the template, the card
would show empty.

**Fix:** delete `getEffectiveSessionPlan` and switch its two callers
([StrengthClient.tsx:129](../../components/strength/StrengthClient.tsx),
[StrengthCoachClient.tsx](../../components/strength/StrengthCoachClient.tsx))
to call `resolveSessionPlan` directly. One resolver, two consumers, one
source of truth.

`resolveSessionPlan` is async (one Supabase read for the template). Both
strength pages already use the SSR-hydrate pattern from
[lib/query/](../../lib/query/), so promoting the resolver to an
`await` in the server component is in-pattern.

This is a small fix bundled into this spec because Tool B (the template
write) is otherwise invisible on `/strength` until the next time someone
also writes an override.

## 6. Files touched

| File | Change |
|---|---|
| [lib/coach/tools.ts](../../lib/coach/tools.ts) | Add 4 tool schemas (`PROPOSE_SESSION_TODAY_TOOL`, `COMMIT_SESSION_TODAY_TOOL`, `PROPOSE_SESSION_TEMPLATE_TOOL`, `COMMIT_SESSION_TEMPLATE_TOOL`) + 4 executors (`executeProposeSessionToday`, `executeCommitSessionToday`, `executeProposeSessionTemplate`, `executeCommitSessionTemplate`). Extend `CARTER_TOOLS` array. `PETER_TOOLS` unchanged. |
| [lib/coach/approval-token.ts](../../lib/coach/approval-token.ts) | Extend `ApprovalAction` union: `\| "session_today" \| "session_template"`. |
| [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) | Three prompt edits per §4. |
| [lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts) | Delete `getEffectiveSessionPlan` (now redundant). |
| [components/strength/StrengthClient.tsx](../../components/strength/StrengthClient.tsx) | Switch to `resolveSessionPlan`. |
| [components/strength/StrengthCoachClient.tsx](../../components/strength/StrengthCoachClient.tsx) | Switch to `resolveSessionPlan`. |
| [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) | Add 4 dispatch branches alongside the existing `propose_week_plan` / `commit_week_plan` cases (around line 550), mirroring their shape: `await executeProposeSessionTemplate({ supabase, userId, input })` and the 3 siblings. |
| [components/chat/ChatMessage.tsx](../../components/chat/ChatMessage.tsx) | Add two proposal-card branches in the `toolCalls.map` block (around line 242), mirroring the existing `propose_week_plan` and `propose_nutrition_targets` cases. |
| `components/chat/SessionTodayProposalCard.tsx` (new) | Preview card for `propose_session_today` — exercise list table + rationale + Approve. Mirrors `WeekPlanProposalCard` minus the Mon-Sun type grid. |
| `components/chat/SessionTemplateProposalCard.tsx` (new) | Preview card for `propose_session_template`. Same shape, plus the session-type header. |

No DB migration. `training_weeks.exercise_overrides` exists from migration
0022; `user_session_templates` exists from migration 0026.

## 7. Edge cases

| Case | Behavior |
|---|---|
| No `training_weeks` row for current week | Tool A returns coach-voice error: "No weekly plan committed yet for this week. Tell me 'plan my week' first." Tool B works unchanged — templates are week-agnostic. |
| Session-type label changes mid-week (existing swap route) | Existing behavior preserved: [swap route lines 176-199](../../app/api/training-weeks/%5Bweek_start%5D/swap/route.ts) clear `exercise_overrides[weekday]` when a day's session type changes. Tool A doesn't change types, so no interaction. |
| Free-form exercise name (not in library) | Saved as-is. `annotateSession` and `get_substitutes` skip rows without library metadata — pre-existing behavior. Volume rollups still count the set. |
| Token replay | `verifyApprovalToken` checks HMAC + userId + action + payloadHash. Same primitive as `propose_week_plan` — invariants documented at [approval-token.ts](../../lib/coach/approval-token.ts). |
| Block-boundary rotation overlap | `propose_session_template` only writes the template. Load progression on new accessories starts from whatever `baseKg` Carter writes; athlete logs week-1 from there. No interaction with `training_blocks`. |
| Athlete taps Approve twice | Idempotent. Tool B upserts on `(user_id, session_type)`. Tool A upserts the same jsonb slot. Re-commit overwrites with the same payload. |
| Stale token after page refresh | Approval tokens carry no TTL (existing pattern). If the athlete dismisses and re-asks, Carter calls `propose_*` again — fresh token. |
| Athlete edits the logger after override write | Existing logger draft persistence (IndexedDB, 12h TTL) takes over from there. The override is the *starting point*; sets logged via the logger flow through `commit_logger_session` as today. |

## 8. End-to-end flow — today's empty Arms case

```
1. Athlete on /strength sees empty Arms card.
2. Athlete (in /coach): "Carter, set my Arms session."
3. Router → speaker = "carter".
4. Carter:
   a. query_exercise_library({ primary_muscle: ["biceps", "triceps"] })
      → returns canonical names (Barbell Curl, DB Curl, Hammer Curl,
        Preacher Curl, Cable Curl, Triceps Pushdown, etc.)
   b. propose_session_template({
        session_type: "Arms",
        exercises: [
          { name: "Barbell Curl", baseKg: ..., baseReps: 8, sets: 3 },
          { name: "Triceps Pushdown (Cable)", baseKg: ..., baseReps: 12, sets: 3 },
          { name: "Hammer Curl (Dumbbell)", baseKg: ..., baseReps: 10, sets: 3 },
          { name: "Overhead Triceps Extension (Cable)", baseKg: ..., baseReps: 12, sets: 3 },
          ...
        ],
        rationale: "Library-sourced biceps + triceps with stretched-position
                    emphasis; matches your existing equipment. Save as your
                    standing Arms session."
      })
      → returns { preview, approval_token }
5. UI renders ApprovalChip with the preview list + rationale.
6. Athlete taps Approve.
7. POST /api/chat/coach/approve { token }
   → executeCommitSessionTemplate
   → user_session_templates upsert for ("Arms")
   → revalidatePath of /, /metrics, /strength
8. /strength TodayPlanCard renders — resolveSessionPlan now finds the
   template, returns the exercises with source: "user_template".
9. Athlete opens the logger from TodayPlanCard or the morning brief —
   the same exercises pre-load (resolveSessionPlan already reads templates
   per migration 0026's intent).
```

The pain-driven Tool A path is identical in shape; the executor writes
`exercise_overrides[<weekdayLong>]` instead of upserting the template,
and the result is in effect only for today.

## 9. Verification

Per [CLAUDE.md](../../CLAUDE.md): no test suite. Verification = typecheck +
manual exercise in dev.

1. `npm run typecheck` clean.
2. Empty session-type happy path: ask Carter "set my arms session" → tool
   chip renders → tap Approve → `/strength` renders exercises → logger
   pre-loads with `source: "user_template"`.
3. Today-only override happy path: tell Carter "elbow's sore, give me a
   tendon-friendly arms today" → he calls `propose_session_today` (not
   template) → approve → today shows the new list; tomorrow's same-type
   reverts to the template.
4. No-week-plan error path: clear `training_weeks` for current week, try
   Tool A → coach-voice error directs the athlete to `propose_week_plan`.
5. Block-boundary rotation: simulate Carter at week-1 of a new block →
   he proposes `propose_session_template` with 1-2 accessories swapped per
   swap-policy rule 5, mains unchanged.
6. Audit hook (optional): extend
   [scripts/audit-speaker-routing.mjs](../../scripts/audit-speaker-routing.mjs)
   to flag turns where Carter narrates exercises (regex on his outgoing
   text) without a matching `tool_calls` entry for `propose_session_*` —
   regression watch for prompt drift.

## 10. Future iterations (not in scope here)

- Auto-rotate accessories at block boundary (background job that proposes
  for athlete approval).
- Render the template's movement-pattern coverage and primary-muscle
  volume sums on the approval chip.
- `/profile` catalog page to view/edit templates outside chat.
- Carter-driven `baseKg` initialization that pulls from
  `query_workouts` top sets for the rotated-in accessory's pattern peers.
- Same write tools surfaced to Peter at block boundaries (currently
  scoped to Carter per "specialist owns the specialty").
