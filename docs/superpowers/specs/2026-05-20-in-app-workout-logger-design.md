# In-App Workout Logger — Design

**Date:** 2026-05-20
**Status:** Approved, ready for plan
**Sub-project:** Replaces the Strong CSV ingest as the primary lift-logging surface.

## Motivation

Strong-app CSV ingest is the only path lifts enter the system. That forces:

- A second app at the gym (Strong)
- Manual CSV exports + uploads
- A 24h+ delay between training and the data landing in coach context
- No real-time prescribed-rest enforcement (Strong's rest timers are isolated from Carter's prescribed `rest_seconds`)

Replacing it with a first-class in-app logger collapses those problems and unlocks one capability Strong cannot have: **voice logging of sets**, which keeps eyes on the bar.

## Goals

1. A full Strong-app-replacement logger that is as fast at the gym as Strong is, on the same data shapes the codebase already uses.
2. Voice input for the hot-path action — logging a set's `kg` + `reps` — with the rest timer auto-starting on commit.
3. Reuse, not duplication: the existing prescription resolver (`training_weeks` → `exercise_overrides` → `SESSION_PLANS`) and the existing normalized tables (`workouts/exercises/exercise_sets`).
4. Edit-at-session freedom (add/remove/swap exercises, change prescribed values), with an explicit affordance to persist deviations as the user's new default for that session type.
5. Zero new work for Coach Carter: logger-written sessions land in `workouts` and flow into adherence, weekly review, and trends transparently.

## Non-goals (v1)

- **Voice commands beyond `X kg Y reps`** — no "add set" / "next exercise" / "rest 90 seconds" voice grammar. Buttons handle navigation.
- **Superset linking** — the 🔗 chip in the UI is a v2 placeholder.
- **Background / lock-screen rest timers** — PWA on iOS cannot reliably schedule local notifications. Wake Lock keeps the screen on instead.
- **Plate calculator overlay.**
- **Auto-progression suggestions** — weight bumps stay Carter's domain via weekly review.
- **Profile-level template management UI** — v1 manages `user_session_templates` only from inside the logger sheet (save / reset). A `/profile` template editor is deferred.
- **Sharing templates between users** — single-user app.

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│  /strength TodayPlanCard   ·   morning brief   ·   /metrics?sub=strength  │
│                            │                                                                  │
│                            ▼                                                                  │
│                 [ Start session ] ──────────────►  LoggerSheet (full-screen)                 │
│                                                          │                                    │
│                                                          ▼                                    │
│                                          resolvePlan(user_id, weekday)                        │
│                                                          │                                    │
│   ┌──────────────────────────────────────────────────────┴─────────────────┐                 │
│   │  1. training_weeks.exercise_overrides[weekday]        (per-week, 0022)  │                 │
│   │  2. user_session_templates[session_type]              (NEW — per-user)  │                 │
│   │  3. SESSION_PLANS[session_type]                       (code default)    │                 │
│   └────────────────────────────────────────────────────────────────────────┘                 │
│                                                          │                                    │
│                                                          ▼                                    │
│                                          AnnotatedExercise[] (via annotateSession)           │
│                                                          │                                    │
│                                                          ▼                                    │
│         Set commit  ◄──  Voice (WebSpeech → regex → Haiku) | Manual (kg/reps)               │
│              │                                                                                │
│              ▼                                                                                │
│         IndexedDB draft  ──  Resume on reopen                                                 │
│              │                                                                                │
│              ▼                                                                                │
│         Finish  ──►  commitSession() ──►  workouts + exercises + exercise_sets               │
│                            (external_id = "logger-<uuid>")                                    │
│                            ▼                                                                  │
│                  revalidatePath('/strength', '/')                                             │
└──────────────────────────────────────────────────────────────────┘
```

## Data model

### New table — `user_session_templates`

The persistent per-user override layer. One row per `(user_id, session_type)`.

```sql
create table user_session_templates (
  user_id      uuid not null references auth.users on delete cascade,
  session_type text not null,        -- 'Chest' | 'Back' | 'Legs' | 'Shoulders' | 'Mobility' | …
  exercises    jsonb not null,        -- PlannedExercise[] (same shape as SESSION_PLANS)
  updated_at   timestamptz not null default now(),
  primary key (user_id, session_type)
);

alter table user_session_templates enable row level security;

create policy "Users manage their own session templates"
  on user_session_templates for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

The `exercises` jsonb mirrors the existing `PlannedExercise` TS shape in [lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts): `name`, `warmup?`, `reps?`, `baseKg?`, `baseReps?`, `sets?`, `key?`, `note?`, `increment?`. Adds one optional field:

- `rest_seconds_override?: { min: number; max: number }` — when set, overrides the value `annotateSession` would compute for this exercise's tier. Falls through to the tier-derived prescription when null.

### New column — `exercise_sets.rest_seconds_actual`

```sql
alter table exercise_sets add column rest_seconds_actual int;
```

The rest the user actually took between the previous set's commit and this set's commit, recorded by the logger's rest timer. Distinct from any prescribed value. Nullable because (a) the first set of an exercise has no prior rest, (b) Strong CSV ingest does not provide it, (c) the user may skip the timer.

### Resolution chain — `resolvePlan(user_id, weekday)`

Lives in `lib/coach/resolve-session-plan.ts` (extends the existing `getEffectiveSessionPlan` in [lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts)):

```ts
async function resolvePlan(userId: string, weekday: Weekday): Promise<PlannedExercise[]> {
  const session_type = trainingWeek.session_plan[weekday];  // e.g., 'Chest'
  if (!session_type) return [];

  // 1. This-week per-day override (permutation-only, migration 0022).
  const weekOverride = trainingWeek.exercise_overrides?.[weekdayLong];
  if (weekOverride) return weekOverride;

  // 2. NEW — user's persistent default for this session_type.
  const userTemplate = await fetchUserSessionTemplate(userId, session_type);
  if (userTemplate) return userTemplate.exercises;

  // 3. Code default.
  return SESSION_PLANS[session_type] ?? [];
}
```

`exercise_overrides` (0022) stays permutation-only. The user's full-edit deviations flow only through `user_session_templates`. A separate path keeps the existing weekly-planning swap semantics intact.

### Schema compatibility with existing writes

`workouts/exercises/exercise_sets` shapes are unchanged. Logger writes are indistinguishable in shape from Strong CSV writes — they differ only by `workouts.source = 'logger'` and `external_id` prefix.

## Logger UX

**Surface**: full-screen modal sheet, dark theme. Variant A from the brainstorm session — Strong-faithful table layout. Mockup in [.superpowers/brainstorm/77207-1779280457/content/logger-variants.html](../../.superpowers/brainstorm/77207-1779280457/content/logger-variants.html) (variant A pane).

**Entry points**:
- [components/strength/TodayPlanCard.tsx](../../components/strength/TodayPlanCard.tsx) — "Start session" CTA replaces the read-only header
- [components/morning/BriefSessionList.tsx](../../components/morning/BriefSessionList.tsx) — "Log this session" link beneath the training block
- `/metrics?sub=strength` — same CTA as `/strength` (via the shared `TodayPlanCard` component)

**Header**:
- ‹ back arrow (collapses sheet; draft preserved in IndexedDB)
- Session label: `12:08 · Chest` (elapsed timer + session_type). Timer starts on the first ✓ commit — opening the sheet to glance at the plan does not accumulate session time.
- Green `Finish` button (right)

**Per-exercise card**:
- Title row: exercise name · tier chip (e.g., `T3`) · ⋯ menu (Replace / Reorder / Remove)
- Columns: `Set | Previous | kg | Reps | ✓ | 🎤`
- Set rows:
  - `Set` cell: numeric badge `1`, `2`, `3`… or warmup badge `W` (yellow tint)
  - `Previous`: same exercise's last completed session's actuals for the same set index, greyed (e.g., `60 × 8`). Resolved by `fetchPreviousSet(user_id, exercise_name, set_index, current_draft_id)` — exact-match on `exercises.name` (case-insensitive trim), most recent prior session by `(workouts.date desc, workouts.created_at desc)`, matching `set_index` (warmup sets matched separately). Excludes the current in-progress draft so a same-day second session shows the morning session's values, not its own.
  - `kg` / `Reps`: editable text inputs, tabular numerics, prefilled from `baseKg` / `baseReps` for the prescribed sets
  - `✓`: tap to commit the set → writes to logger draft state → starts rest timer
  - `🎤`: per-row mic. Tap → Web Speech listens → fills `kg` + `Reps` → auto-commits → starts timer
- Rest bar between committed sets: `2:00 ▰▰▰▱▱ 1:14` (prescribed · progress · remaining). Tap to skip or extend ±30s
- `+ Add set (2:00)` button at the bottom of the card, label shows prescribed rest

**Page-level affordances**:
- `+ Add Exercise` at the bottom — opens picker (autocomplete over `EXERCISE_MUSCLES` keys + free text for novel lifts)
- Top-right `Save deviations as my default` button — surfaces only when the *resolved exercise list* differs from the post-edit list (set-actuals differences never trigger it)
- Wake Lock acquired on sheet mount, released on Finish or background

**Variant from screenshot**: matches Strong's column structure exactly (Set / Previous / kg / Reps / ✓). The only additional column is `🎤`. Dark theme replaces Strong's light theme.

## Voice pipeline

**Mechanism**: Web Speech API (`window.SpeechRecognition || window.webkitSpeechRecognition`). On-device, free, ~50ms latency. iOS Safari 14.5+ and Chrome supported. If unsupported, the 🎤 button is hidden and a small tooltip on first-load explains.

**Flow per tap**:

1. Tap 🎤 on a set row → SpeechRecognition starts (`continuous: false, interimResults: true, lang: 'en-US'`)
2. Live transcript shown in the row's input area as a chip overlay
3. On `result` final → parse the transcript
4. Fill `kg` + `Reps` cells → auto-press ✓ → start prescribed rest timer
5. If parser returns null → leave the transcript in a banner above the row with a "type instead" prompt

**Parser** (`lib/logger/parse-voice.ts`):

```ts
type ParsedSet = { kg: number | null; reps: number };

function parseVoiceSet(transcript: string): ParsedSet | null {
  // 1. Normalize: lowercase, replace "kilos|kilogram|kilograms|kilo" → "kg", "pounds|lbs|lb" → "lbs", "reps|rep|times|x" → "reps", strip filler.
  // 2. Try regex patterns in order:
  //    A. /(\d+(?:\.\d+)?)\s*kg\s+(\d+)\s*reps?/        → "60 kg 8 reps"
  //    B. /(\d+(?:\.\d+)?)\s+(\d+)/                       → "60 8" (first = kg, second = reps)
  //    C. /(\d+)\s*reps?\s+(?:at|@)\s+(\d+(?:\.\d+)?)/   → "8 reps at 60"
  //    D. /bodyweight\s+(\d+)\s*reps?/                    → "bodyweight 12 reps" (kg = null)
  // 3. Imperial fallback: if transcript contains "lbs" or "pounds", convert (× 0.453592, round to nearest 0.5).
  // 4. If all regex paths fail, return null → caller invokes Haiku fallback.
}
```

**Haiku fallback** (`lib/logger/parse-voice-llm.ts`):

Triggered only when regex returns null. One Anthropic Haiku 4.5 call with structured output (tool_use forcing `{ kg, reps }` shape). Costs ~$0.0003/call; expected to fire on <5% of utterances after the regex bank is tuned. Same client wiring as [lib/food/parse.ts](../../lib/food/parse.ts).

**Grammar in v1**: weight + reps only. No add-set / next-exercise / rest-control voice commands. Two reasons:
1. The high-frequency action (every set) gets voice; everything else (a few taps per session) stays buttons.
2. Adding a command grammar pulls in intent disambiguation that costs more reliability than it saves.

**Per-row vs per-card mic**: per-row. The user can voice-fix a misread set 3 turns ago without losing the next-set context.

## Edit-at-session & save-as-default

**At-session edits** (no persistence by default):

- ⋯ menu per exercise:
  - **Replace** → picker. Replaces the exercise in the current session's working state.
  - **Reorder** → drag handle on long-press. Reorders only the current session.
  - **Remove** → strikethrough card with undo affordance for 5s.
- Per-set: tap the kg/reps cell to edit any value, tap ✓ to toggle warmup, swipe-left to delete the row.
- `+ Add Set` at the bottom of a card appends one set with the same prescribed values as the last.
- `+ Add Exercise` at the bottom of the sheet inserts a new exercise card after the current one.

All these edits live in the logger's local state and (on every change) the IndexedDB draft. They do NOT touch `user_session_templates` or `training_weeks.exercise_overrides`.

**The Save mechanism**:

The top-right `Save deviations as my default` button surfaces if and only if the *post-edit exercise list* differs from the *resolved* exercise list (compared by name multiset + per-exercise prescribed values, ignoring set-actuals). Set actuals never trigger the button.

Tap → confirm sheet:

```
Save your current Chest day as your new default?
This will be used when you start a Chest day next time.
Coach's original plan stays available — reset anytime.

[ Save as my Chest day ]  [ Cancel ]
```

Confirm → upsert into `user_session_templates(user_id, 'Chest', exercises, now())`. The exercises jsonb mirrors the post-edit state's PlannedExercise[] structure (preserving any per-exercise `rest_seconds_override` if the user changed rest).

**Reset to coach default**:

- From inside the logger sheet: an overflow menu item "Reset to coach default" — deletes the matching `user_session_templates` row and reloads with the code default.
- No `/profile` template management UI in v1.

## Draft persistence

**Why**: Strong-app users expect that closing the app mid-session doesn't lose state. PWA backgrounding on iOS is aggressive; we cannot assume the JS heap survives.

**Mechanism**:

- An IndexedDB store `logger-drafts` keyed by `(user_id, started_at_iso)`.
- Schema: `{ session_type, started_at, exercises: AnnotatedExercise[], sets: ExerciseSetDraft[][], rest_timer_state }`.
- Written on every committed set, every exercise edit, every rest-timer state change.
- On logger sheet mount, query for any draft within the last 12h. If found, show a one-time prompt:

  ```
  Resume Chest session from 12:08?
  Started 14 minutes ago — 2 sets logged.
  [ Resume ]   [ Discard ]
  ```

- Drafts older than 12h are auto-discarded on next mount.
- On Finish, the matching draft is cleared.

**No server-side draft state in v1**. IndexedDB is per-device; switching devices mid-session is not supported.

## Rest timer

- **Source of truth**: `annotateSession` produces `rest_seconds: { min, max }` per exercise based on fatigue tier. Logger displays the `min` value as the countdown default. User-edited overrides (per-exercise) take precedence.
- **Start trigger**: commit-set (✓ tap, voice auto-commit). The rest bar between the just-committed row and the next pending row animates left-to-right.
- **Wake Lock**: acquired on sheet mount via `navigator.wakeLock.request('screen')`. Released on Finish or visibility-hidden.
- **End signal**: at 0 seconds — single `navigator.vibrate(200)` + a short ding (data: URL audio, no asset). User can tap the bar to skip (sets timer to 0, no signal) or extend ±30s.
- **`rest_seconds_actual` capture**: time delta between the prior set's commit timestamp and the next set's commit timestamp. Recorded on the next set's row.

## Finish flow & write path

**Finish tap**:

1. Confirmation sheet renders summary:

   ```
   Chest · 47 min
   8 sets · 1 PR (Decline Bench 60 × 9 → previous 60 × 8)
   Total volume: 4,820 kg
   [ Finish & save ]   [ Back to session ]
   ```

2. Finish & save → `commitSession(payload)` server action.

**`commitSession()`** (`lib/logger/commit-session.ts`, server-only):

- Auth: `createSupabaseServerClient()` (cookie-bound, RLS-respecting). Never uses service role.
- Validation: at most 30 exercises per session, at most 30 sets per exercise (defensive, prevents accidental looping bugs from writing thousands of rows).
- Idempotency: `external_id = "logger-${crypto.randomUUID()}"`. Client generates the uuid on first commit attempt and reuses on retry, so a network-flake retry doesn't duplicate.
- Transaction (Supabase doesn't expose explicit BEGIN; insert via a single Postgres function `commit_logger_session(payload jsonb)` that does the inserts atomically and returns the workout_id):

  ```sql
  create or replace function commit_logger_session(payload jsonb)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    new_workout_id uuid;
  begin
    -- Insert workouts row.
    -- For each exercise in payload->'exercises': insert into exercises.
    -- For each set in exercise->'sets': insert into exercise_sets (with rest_seconds_actual).
    -- Return new workout id.
  end;
  $$;
  ```

  Rationale: matches the `sum_food_entries` / `commit_nutrition_targets` SECURITY DEFINER pattern from migrations 0019 and 0021. RLS still enforced because the function checks `auth.uid() = payload->>'user_id'` at the top.

- On success: server action calls `revalidatePath('/strength')` and `revalidatePath('/')`. Returns `{ workout_id, pr_count, volume_kg }` for the summary card.
- On failure: returns structured error; client keeps the IndexedDB draft and shows a retry button.

**`workouts.source`**: `'logger'`. This is a new distinct value (current values: `'strong'`, `'apple_health'`, etc.). No migration needed — `source` is a free-text column.

## Strong CSV co-existence

- **Ingest path unchanged**: [app/api/ingest/strong/route.ts](../../app/api/ingest/strong/route.ts) stays untouched. Users with historical Strong exports can still upload them.
- **Disjoint `external_id` namespaces**: Strong writes `strong-<date>-<slug>`; logger writes `logger-<uuid>`. Re-imports of either source cannot collide.
- **Profile flag** — new column `profiles.disable_strong_ingest boolean not null default false`. When true, the ingest endpoint returns 403 with a clear message. Mirrors `disable_yazio_ingest` exactly (same UI surface in profile settings).
- **No migration of historical data** — Strong-sourced rows stay in the table as-is. The logger only writes new rows.

## Coach integration

**Zero new work for Carter or the other coaches**:

- `query_workouts` (Carter's tool) reads `workouts` rows. Logger-written sessions appear with `source = 'logger'` instead of `'strong'`. Filter unchanged.
- `compute_adherence` reads `coalesce(training_weeks.original_session_plan, training_weeks.session_plan)` for prescribed sets vs `workouts.exercises[*].exercise_sets[*]` for actuals. Logger-written sets are normal rows.
- Weekly review composers (`lib/coach/weekly-review/compose-recap.ts` etc.) consume the same `workouts` query.
- Trend layer (`lib/coach/trends/strength.ts`) computes e1RM slopes from `exercise_sets`. Unchanged.

**`rest_seconds_actual`** is exposed to future coaching analysis as a new optional column. v1 does not surface it in any UI or LLM context yet — it accumulates.

## Out of scope (v1) — explicit

| Feature | Why deferred |
|---|---|
| Voice commands beyond `X kg Y reps` | Adds intent disambiguation; v1 keeps voice on the hot path only |
| Superset linking (🔗 chip) | Significant data-model + UX work; v2 |
| Background / lock-screen rest timer | PWA on iOS can't reliably schedule local notifications. Wake Lock keeps screen on |
| Plate calculator overlay | Nice-to-have; doesn't change data |
| Auto-progression suggestions | Stays Carter's domain via weekly review |
| `/profile` template management UI | v1 manages user templates inline from logger only (save + reset) |
| Sharing templates between users | Single-user app |
| Server-side draft state / multi-device session resume | IndexedDB only in v1 |

## Open questions (handled, but flagged)

- **Novel exercises (free-text from picker)**: stored as-is in `exercises.name`. No new exercise-catalog table in v1. Future taxonomy work (Carter's exercise library, separate sub-project) will handle dedup/canonicalization.
- **Imperial-unit users**: parser accepts `lbs`/`pounds`, converts to kg with rounding to nearest 0.5kg. UI labels stay `kg`. v1 assumes single-user is metric (consistent with existing `daily_logs` columns).
- **Exercise rename mid-history**: if the user renames "Decline Bench Press" → "Decline Bench" in their template, the Previous column won't find old workouts (exact-match). Acceptable in v1; Carter's exercise library work will introduce canonical exercise ids later.

## Files to create / modify

**New**:
- `supabase/migrations/0026_workout_logger.sql` — `user_session_templates` table + RLS + `exercise_sets.rest_seconds_actual` + `profiles.disable_strong_ingest` + `commit_logger_session` function
- `lib/logger/types.ts` — `ExerciseSetDraft`, `LoggerDraft`, `CommitSessionPayload`
- `lib/logger/resolve-plan.ts` — extends existing resolver with `user_session_templates` step
- `lib/logger/parse-voice.ts` — regex parser
- `lib/logger/parse-voice-llm.ts` — Haiku fallback
- `lib/logger/commit-session.ts` — server action
- `lib/logger/draft-store.ts` — IndexedDB wrapper
- `lib/logger/rest-timer.ts` — countdown + Wake Lock + vibration/audio
- `components/logger/LoggerSheet.tsx` — full-screen modal entry
- `components/logger/ExerciseCard.tsx` — per-exercise table
- `components/logger/SetRow.tsx` — per-set row with mic button
- `components/logger/RestBar.tsx` — countdown bar
- `components/logger/VoiceMicButton.tsx` — Web Speech wrapper
- `components/logger/ExercisePicker.tsx` — replace/add autocomplete
- `components/logger/FinishSummary.tsx` — pre-commit confirmation
- `components/logger/ResumeDraftPrompt.tsx` — on-mount draft check
- `components/logger/SaveAsDefaultDialog.tsx` — save user_session_templates
- `app/api/logger/session/route.ts` — POST commit endpoint (calls `commitSession`)
- `app/api/logger/templates/[session_type]/route.ts` — PUT/DELETE user_session_templates
- `app/api/profile/disable-strong-ingest/route.ts` — toggle endpoint
- `lib/query/fetchers/userSessionTemplates.ts` — server + browser fetchers
- `lib/query/hooks/useUserSessionTemplate.ts` — TanStack hook
- `lib/query/fetchers/previousSet.ts` — Previous column data
- `scripts/audit-logger-write-path.mjs` — end-to-end audit (template resolution → voice parse → commit → workouts row shape)

**Modified**:
- [components/strength/TodayPlanCard.tsx](../../components/strength/TodayPlanCard.tsx) — add "Start session" CTA
- [components/morning/BriefSessionList.tsx](../../components/morning/BriefSessionList.tsx) — add "Log this session" link
- [components/profile/ProfileClient.tsx](../../components/profile/ProfileClient.tsx) — `disable_strong_ingest` toggle (mirror of `disable_yazio_ingest`)
- [app/api/ingest/strong/route.ts](../../app/api/ingest/strong/route.ts) — respect `disable_strong_ingest` flag
- [lib/coach/sessionPlans.ts](../../lib/coach/sessionPlans.ts) — `getEffectiveSessionPlan` calls the new resolver
- [lib/query/keys.ts](../../lib/query/keys.ts) — keys for userSessionTemplates, previousSet
- [lib/data/types.ts](../../lib/data/types.ts) — `UserSessionTemplate`, `ExerciseSetDraft`, extend `ExerciseSetRow` with `rest_seconds_actual`
- [CLAUDE.md](../../CLAUDE.md) — document the new migration 0026 and the logger architecture (new section under "Architecture")

## Acceptance checklist

- [ ] Migration 0025 applies clean against the current DB.
- [ ] Logger sheet opens from `/strength`, `/metrics?sub=strength`, and morning brief.
- [ ] Today's Chest day prescription renders with prescribed sets (kg, reps, rest) and the Previous column populated from last session.
- [ ] Tapping ✓ commits a set and starts the rest timer at the prescribed value.
- [ ] Per-row 🎤 → Web Speech → "60 kg 8 reps" → row fills, ✓ auto-presses, rest timer starts.
- [ ] Per-row 🎤 → "60 8" → row fills (regex form B).
- [ ] Per-row 🎤 → "bodyweight 12 reps" → row fills with kg=null.
- [ ] Per-row 🎤 → an utterance regex can't parse → Haiku fallback produces `{kg, reps}` or shows the typed-instead banner.
- [ ] ⋯ menu Replace/Reorder/Remove edits are local-only until save-as-default is tapped.
- [ ] Save-as-default button surfaces only on exercise-list divergence, not on set-actual divergence.
- [ ] Save-as-default writes `user_session_templates`. Next session load uses the new template.
- [ ] Reset-to-default deletes the `user_session_templates` row and reloads with the code default.
- [ ] Closing the sheet preserves the draft in IndexedDB. Reopening within 12h shows the Resume prompt.
- [ ] Finish → confirmation sheet → commit → `workouts/exercises/exercise_sets` row written with `source = 'logger'` and `external_id = 'logger-<uuid>'`.
- [ ] `rest_seconds_actual` is populated on all sets except the first set of each exercise.
- [ ] `revalidatePath('/strength')` and `revalidatePath('/')` fire on commit; both pages show the new session immediately.
- [ ] Carter's `query_workouts` returns logger-written rows (run `scripts/audit-logger-write-path.mjs`).
- [ ] `profiles.disable_strong_ingest = true` causes `/api/ingest/strong` to return 403.
- [ ] Wake Lock acquired on mount; released on Finish or background.
- [ ] `npm run typecheck` passes.
- [ ] Manual gym test: log a real Chest day with voice + manual entry; confirm the brief and `/strength` reflect it within seconds.
