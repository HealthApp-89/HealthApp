# In-App Workout Logger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Strong CSV ingest as the primary lift-logging path with a first-class in-session logger — Strong-faithful table layout, per-set voice entry (Web Speech → regex → Haiku fallback), Wake Lock rest timer, IndexedDB draft persistence, "save deviations as my default" affordance backed by a new `user_session_templates` table. Carter sees logger-written sessions transparently through existing `workouts/exercises/exercise_sets`.

**Architecture:** Extends the existing prescription resolver with a per-user template layer (`training_weeks.exercise_overrides` → `user_session_templates` → `SESSION_PLANS`). Writes go through a SECURITY DEFINER Postgres function for atomic 3-table inserts. Voice is browser-native (Web Speech API) — server-side transcription stays a future option. The LoggerSheet is a full-screen modal opened from `/strength`, the morning brief, and `/metrics?sub=strength`.

**Tech Stack:** Next.js 15 App Router, Supabase Postgres (migrations applied via `supabase db push`), Anthropic Haiku 4.5 for parser fallback, Web Speech API + Wake Lock API + Vibration API on the browser, IndexedDB via the `idb` package, TanStack Query for cache, Tailwind v4 + DM Sans. **This repo has no test suite** — verification at every task is `npm run typecheck` plus a focused manual smoke. Pure functions get tiny Node CLI verification scripts.

**Spec:** [docs/superpowers/specs/2026-05-20-in-app-workout-logger-design.md](../specs/2026-05-20-in-app-workout-logger-design.md)

**Suggested branch:** `feat/workout-logger` (cut from `main`).

---

## File Structure

**New:**
- `supabase/migrations/0026_workout_logger.sql` — `user_session_templates` table + RLS + `exercise_sets.rest_seconds_actual` + `profiles.disable_strong_ingest` + `commit_logger_session(payload jsonb)` SECURITY DEFINER function.
- `lib/logger/types.ts` — `ExerciseSetDraft`, `LoggerDraft`, `CommitSessionPayload`, `UserSessionTemplate` shapes.
- `lib/logger/resolve-plan.ts` — async resolver: `training_weeks.exercise_overrides` → `user_session_templates` → `SESSION_PLANS`.
- `lib/logger/parse-voice.ts` — regex parser (`{ kg, reps } | null`).
- `lib/logger/parse-voice-llm.ts` — Haiku 4.5 fallback when regex returns null.
- `lib/logger/draft-store.ts` — IndexedDB read/write/clear/list (via `idb`).
- `lib/logger/rest-timer.ts` — countdown hook + Wake Lock acquire/release + vibration/audio cue.
- `lib/logger/commit-session.ts` — server action calling `commit_logger_session(...)` with the auth-bound client.
- `app/api/logger/session/route.ts` — POST endpoint that invokes the server action.
- `app/api/logger/templates/[session_type]/route.ts` — PUT (upsert) + DELETE for `user_session_templates`.
- `app/api/profile/disable-strong-ingest/route.ts` — POST toggle.
- `lib/query/fetchers/userSessionTemplates.ts` — server + browser fetchers (one template by session_type).
- `lib/query/fetchers/previousSet.ts` — server + browser fetchers for the Previous column.
- `lib/query/hooks/useUserSessionTemplate.ts` + `useResolvedSessionPlan.ts` + `usePreviousSet.ts`.
- `components/logger/LoggerSheet.tsx` — root modal sheet.
- `components/logger/ExerciseCard.tsx` — per-exercise table card.
- `components/logger/SetRow.tsx` — per-set table row with mic.
- `components/logger/RestBar.tsx` — inter-set countdown bar.
- `components/logger/VoiceMicButton.tsx` — Web Speech wrapper.
- `components/logger/ExercisePicker.tsx` — autocomplete sheet (EXERCISE_MUSCLES + free text).
- `components/logger/FinishSummary.tsx` — pre-commit confirmation.
- `components/logger/ResumeDraftPrompt.tsx` — on-mount draft check.
- `components/logger/SaveAsDefaultDialog.tsx` — confirm upsert into `user_session_templates`.
- `scripts/parse-voice-smoke.mjs` — CLI verification for the regex parser (no test framework needed).
- `scripts/audit-logger-write-path.mjs` — end-to-end audit (template resolution → voice parse → commit → workouts row shape).

**Modified:**
- `lib/data/types.ts` — `UserSessionTemplate` row shape; extend `ExerciseSetRow` with `rest_seconds_actual`; `Profile` gets `disable_strong_ingest`.
- `lib/query/keys.ts` — keys for `userSessionTemplates`, `previousSet`, `resolvedSessionPlan`.
- `components/strength/TodayPlanCard.tsx` — add "Start session" CTA.
- `components/morning/BriefSessionList.tsx` — add "Log this session" link.
- `components/profile/ProfileClient.tsx` — `disable_strong_ingest` toggle (mirror of `disable_yazio_ingest`).
- `app/api/ingest/strong/route.ts` — respect `disable_strong_ingest` flag (return 403 when true).
- `package.json` — add `idb` dependency.
- `CLAUDE.md` — document migration 0026 + the logger architecture under "Architecture".

---

## Task 1: Migration 0026 — schema + RPC

**Files:**
- Create: `supabase/migrations/0026_workout_logger.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 0026_workout_logger.sql
--
-- In-app workout logger. Adds:
--   - user_session_templates: per-user persistent "save deviations as my default"
--     layer between training_weeks.exercise_overrides (per-week) and SESSION_PLANS
--     (code default).
--   - exercise_sets.rest_seconds_actual: actual rest taken between commits.
--   - profiles.disable_strong_ingest: opt-out flag mirroring disable_yazio_ingest.
--   - commit_logger_session(jsonb): SECURITY DEFINER atomic 3-table insert.
--
-- See CLAUDE.md "Architecture" section after this migration applies.

-- ── user_session_templates ─────────────────────────────────────────────────
create table user_session_templates (
  user_id      uuid not null references auth.users on delete cascade,
  session_type text not null,
  exercises    jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, session_type)
);

alter table user_session_templates enable row level security;

create policy "Users manage their own session templates"
  on user_session_templates for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── exercise_sets.rest_seconds_actual ──────────────────────────────────────
alter table exercise_sets add column rest_seconds_actual int;

-- ── profiles.disable_strong_ingest ─────────────────────────────────────────
alter table profiles add column disable_strong_ingest boolean not null default false;

-- ── commit_logger_session(payload jsonb) ───────────────────────────────────
--
-- Atomic 3-table insert: workouts + exercises + exercise_sets.
-- Payload shape:
--   {
--     "user_id": "<uuid>",
--     "external_id": "logger-<uuid>",
--     "date": "YYYY-MM-DD",
--     "type": "Chest",
--     "duration_min": 47,
--     "exercises": [
--       {
--         "name": "Decline Bench Press",
--         "position": 0,
--         "sets": [
--           { "set_index": 0, "kg": 40, "reps": 10, "warmup": true,
--             "failure": false, "rest_seconds_actual": null },
--           ...
--         ]
--       },
--       ...
--     ]
--   }
--
-- Returns the new workouts.id.
create or replace function commit_logger_session(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payload_user_id uuid;
  new_workout_id  uuid;
  ex              jsonb;
  st              jsonb;
  new_exercise_id uuid;
begin
  payload_user_id := (payload->>'user_id')::uuid;

  -- Defence: caller must match the authenticated user.
  if auth.uid() is null or auth.uid() <> payload_user_id then
    raise exception 'commit_logger_session: auth.uid() mismatch';
  end if;

  -- Defensive shape checks.
  if jsonb_array_length(payload->'exercises') > 30 then
    raise exception 'commit_logger_session: too many exercises (>30)';
  end if;

  -- workouts row.
  insert into workouts (
    user_id, external_id, date, type, duration_min, source, created_at
  ) values (
    payload_user_id,
    payload->>'external_id',
    (payload->>'date')::date,
    payload->>'type',
    nullif(payload->>'duration_min', '')::int,
    'logger',
    now()
  )
  on conflict (user_id, external_id) do update
    set type = excluded.type,
        duration_min = excluded.duration_min
  returning id into new_workout_id;

  -- Clear any pre-existing exercises for this workout (idempotent retry).
  delete from exercises where workout_id = new_workout_id;

  -- Exercises + sets.
  for ex in select * from jsonb_array_elements(payload->'exercises') loop
    if jsonb_array_length(ex->'sets') > 30 then
      raise exception 'commit_logger_session: too many sets for one exercise (>30)';
    end if;

    insert into exercises (workout_id, name, position)
    values (
      new_workout_id,
      ex->>'name',
      (ex->>'position')::int
    )
    returning id into new_exercise_id;

    for st in select * from jsonb_array_elements(ex->'sets') loop
      insert into exercise_sets (
        exercise_id, set_index, kg, reps, duration_seconds, warmup, failure,
        rest_seconds_actual
      ) values (
        new_exercise_id,
        (st->>'set_index')::int,
        nullif(st->>'kg', '')::numeric,
        nullif(st->>'reps', '')::int,
        nullif(st->>'duration_seconds', '')::int,
        coalesce((st->>'warmup')::boolean, false),
        coalesce((st->>'failure')::boolean, false),
        nullif(st->>'rest_seconds_actual', '')::int
      );
    end loop;
  end loop;

  return new_workout_id;
end;
$$;

revoke all on function commit_logger_session(jsonb) from public;
grant execute on function commit_logger_session(jsonb) to authenticated;
```

- [ ] **Step 2: Apply via Supabase CLI**

Run: `supabase db push`
Expected: `Applying migration 0026_workout_logger.sql ... OK`

If `db push` reports the migration as already applied (shouldn't, but just in case), repair: `supabase migration repair --status applied 0026`.

- [ ] **Step 3: Smoke-check via SQL**

Run in Supabase SQL editor:
```sql
select column_name from information_schema.columns
  where table_name = 'exercise_sets' and column_name = 'rest_seconds_actual';
-- → 1 row

select column_name from information_schema.columns
  where table_name = 'profiles' and column_name = 'disable_strong_ingest';
-- → 1 row

select tablename from pg_tables where tablename = 'user_session_templates';
-- → 1 row

select proname from pg_proc where proname = 'commit_logger_session';
-- → 1 row
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0026_workout_logger.sql
git commit -m "feat(logger): migration 0026 — user_session_templates + commit RPC"
```

---

## Task 2: Type definitions

**Files:**
- Modify: `lib/data/types.ts`
- Create: `lib/logger/types.ts`

- [ ] **Step 1: Extend `lib/data/types.ts`**

Find the existing `ExerciseSetRow` type and add the new column. Find the existing `Profile` type and add the new column. Add a new `UserSessionTemplate` row type near the other Supabase row types.

```ts
// In the existing ExerciseSetRow type, add:
//   rest_seconds_actual: number | null;

// In the existing Profile type, add:
//   disable_strong_ingest: boolean;

// Add a new row type:
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type UserSessionTemplate = {
  user_id: string;
  session_type: string;
  exercises: PlannedExercise[];
  updated_at: string;
};
```

(Use Edit to insert into the existing type definitions — don't create duplicates.)

- [ ] **Step 2: Create `lib/logger/types.ts`**

```ts
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

/**
 * In-flight set during a logger session, before commit.
 * `committed_at` is set when the user taps ✓; null while pending.
 */
export type ExerciseSetDraft = {
  set_index: number;
  kg: number | null;
  reps: number | null;
  warmup: boolean;
  failure: boolean;
  committed_at: string | null; // ISO timestamp on ✓
};

/**
 * In-flight exercise in a logger session. `exercises[i].sets` may include
 * uncommitted rows.
 */
export type ExerciseDraft = {
  name: string;
  position: number;
  /** Snapshot of the prescribed plan for this exercise (for "did it diverge?" check). */
  prescribed: PlannedExercise;
  sets: ExerciseSetDraft[];
};

export type LoggerDraft = {
  user_id: string;
  session_type: string;
  date: string;           // YYYY-MM-DD
  started_at: string;     // ISO timestamp on first ✓ commit
  updated_at: string;     // ISO timestamp on every change
  exercises: ExerciseDraft[];
  /** Resolved-plan exercise list at sheet open, for divergence detection. */
  resolved_plan: PlannedExercise[];
  /** Client-generated UUID; reused across commit retries for idempotency. */
  external_id: string;
};

/**
 * Wire shape sent to /api/logger/session.
 */
export type CommitSessionPayload = {
  user_id: string;
  external_id: string;
  date: string;
  type: string;
  duration_min: number | null;
  exercises: {
    name: string;
    position: number;
    sets: {
      set_index: number;
      kg: number | null;
      reps: number | null;
      duration_seconds: number | null;
      warmup: boolean;
      failure: boolean;
      rest_seconds_actual: number | null;
    }[];
  }[];
};
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add lib/data/types.ts lib/logger/types.ts
git commit -m "feat(logger): type shapes — drafts, commit payload, UserSessionTemplate"
```

---

## Task 3: Async plan resolver

**Files:**
- Create: `lib/logger/resolve-plan.ts`

The existing synchronous [getEffectiveSessionPlan](../../lib/coach/sessionPlans.ts) takes (session_type, weekday, overrides) and resolves the two-layer chain. The new resolver is async because it must fetch `user_session_templates` from the DB. It composes: training_weeks → user_session_templates → SESSION_PLANS.

- [ ] **Step 1: Create `lib/logger/resolve-plan.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ExerciseOverrides } from "@/lib/data/types";

/**
 * Resolution chain at logger open:
 *   1. training_weeks.exercise_overrides[weekdayLong]  (permutation-only)
 *   2. user_session_templates[session_type]            (per-user persistent)
 *   3. SESSION_PLANS[session_type]                     (code default)
 *
 * Pass null `weekOverrides` if no committed training_week exists for the date.
 *
 * `weekdayLong` is the full weekday name ("Monday", "Tuesday", ...) — matches
 * how exercise_overrides is keyed (see migration 0022).
 */
export async function resolveSessionPlan(args: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
  weekdayLong: string;
  weekOverrides: ExerciseOverrides | null;
}): Promise<{
  exercises: PlannedExercise[];
  source: "week_override" | "user_template" | "code_default";
}> {
  const { supabase, userId, sessionType, weekdayLong, weekOverrides } = args;

  const weekOverride = weekOverrides?.[weekdayLong];
  if (weekOverride && weekOverride.length > 0) {
    return { exercises: weekOverride, source: "week_override" };
  }

  const { data, error } = await supabase
    .from("user_session_templates")
    .select("exercises")
    .eq("user_id", userId)
    .eq("session_type", sessionType)
    .maybeSingle();

  if (error) throw error;

  if (data?.exercises && Array.isArray(data.exercises) && data.exercises.length > 0) {
    return { exercises: data.exercises as PlannedExercise[], source: "user_template" };
  }

  return {
    exercises: SESSION_PLANS[sessionType] ?? [],
    source: "code_default",
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/logger/resolve-plan.ts
git commit -m "feat(logger): async resolver (week override → user template → code default)"
```

---

## Task 4: Voice parser — regex + LLM fallback

**Files:**
- Create: `lib/logger/parse-voice.ts`
- Create: `lib/logger/parse-voice-llm.ts`
- Create: `scripts/parse-voice-smoke.mjs`

- [ ] **Step 1: Create `lib/logger/parse-voice.ts`**

```ts
export type ParsedSet = { kg: number | null; reps: number };

/**
 * Normalize and parse a voice transcript into { kg, reps }.
 * Returns null if no pattern matches — caller falls back to LLM.
 *
 * Examples that parse:
 *   "60 kg 8 reps"          → { kg: 60, reps: 8 }
 *   "60 8"                  → { kg: 60, reps: 8 }
 *   "bodyweight 12 reps"    → { kg: null, reps: 12 }
 *   "8 reps at 60"          → { kg: 60, reps: 8 }
 *   "sixty kilos eight reps" → null (word-form numbers handled by LLM)
 *   "135 lbs 5 reps"        → { kg: 61.5, reps: 5 } (rounded to nearest 0.5)
 */
export function parseVoiceSet(transcript: string): ParsedSet | null {
  // 1. Normalize.
  let t = transcript.toLowerCase().trim();
  // Collapse whitespace.
  t = t.replace(/\s+/g, " ");
  // Unit aliases.
  t = t.replace(/\bkilograms?\b|\bkilos?\b|\bkilo\b/g, "kg");
  t = t.replace(/\bpounds?\b|\blbs?\b|\blb\b/g, "lbs");
  // Rep aliases.
  t = t.replace(/\btimes\b/g, "reps");
  t = t.replace(/\brep\b/g, "reps");
  // Strip leading filler.
  t = t.replace(/^(uh|um|okay|ok|so|like)\s+/g, "");

  const lbsToKg = (lbs: number) => Math.round(lbs * 0.453592 * 2) / 2;

  // Pattern A: "<weight> kg <reps> reps?"
  // Pattern A-lbs: "<weight> lbs <reps> reps?"
  let m = t.match(/(\d+(?:\.\d+)?)\s*kg\s+(\d+)\s*(?:reps?)?/);
  if (m) return { kg: parseFloat(m[1]), reps: parseInt(m[2], 10) };
  m = t.match(/(\d+(?:\.\d+)?)\s*lbs\s+(\d+)\s*(?:reps?)?/);
  if (m) return { kg: lbsToKg(parseFloat(m[1])), reps: parseInt(m[2], 10) };

  // Pattern B: "<reps> reps at <weight>"
  m = t.match(/(\d+)\s*reps?\s+(?:at|@)\s+(\d+(?:\.\d+)?)\s*(kg|lbs)?/);
  if (m) {
    const weight = parseFloat(m[2]);
    const isLbs = m[3] === "lbs";
    return { kg: isLbs ? lbsToKg(weight) : weight, reps: parseInt(m[1], 10) };
  }

  // Pattern C: "bodyweight <reps> reps?"
  m = t.match(/bodyweight\s+(\d+)\s*(?:reps?)?/);
  if (m) return { kg: null, reps: parseInt(m[1], 10) };

  // Pattern D: bare "<weight> <reps>" — two numbers separated by whitespace.
  m = t.match(/^(\d+(?:\.\d+)?)\s+(\d+)$/);
  if (m) return { kg: parseFloat(m[1]), reps: parseInt(m[2], 10) };

  return null;
}
```

- [ ] **Step 2: Create `lib/logger/parse-voice-llm.ts`**

```ts
import { getAnthropicClient } from "@/lib/anthropic/client";
import { MODEL_HAIKU_4_5 } from "@/lib/anthropic/models";
import type { ParsedSet } from "@/lib/logger/parse-voice";

/**
 * Haiku 4.5 fallback when the regex parser returns null.
 * Forces structured output via a single tool_use turn.
 */
export async function parseVoiceSetLLM(transcript: string): Promise<ParsedSet | null> {
  const client = getAnthropicClient();

  const res = await client.messages.create({
    model: MODEL_HAIKU_4_5,
    max_tokens: 100,
    tools: [
      {
        name: "record_set",
        description: "Record the set's weight (kg) and reps from the user's spoken phrase.",
        input_schema: {
          type: "object",
          properties: {
            kg: {
              type: ["number", "null"],
              description: "Weight in kilograms. null for bodyweight movements.",
            },
            reps: { type: "integer", description: "Number of reps performed.", minimum: 1, maximum: 100 },
          },
          required: ["kg", "reps"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_set" },
    messages: [
      {
        role: "user",
        content: `Parse this voice phrase from a weightlifter logging a set: "${transcript}". Convert pounds to kilograms (round to nearest 0.5 kg) if mentioned. Return null kg for bodyweight movements.`,
      },
    ],
  });

  const tu = res.content.find((b) => b.type === "tool_use");
  if (!tu || tu.type !== "tool_use") return null;
  const input = tu.input as { kg: number | null; reps: number };
  if (typeof input.reps !== "number" || input.reps < 1) return null;
  return { kg: input.kg, reps: input.reps };
}
```

- [ ] **Step 3: Create `scripts/parse-voice-smoke.mjs`**

```js
// Run: node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/parse-voice-smoke.mjs
//
// No test framework — just assertion smoke. Prints PASS/FAIL per case.

import { parseVoiceSet } from "@/lib/logger/parse-voice";

const cases = [
  ["60 kg 8 reps", { kg: 60, reps: 8 }],
  ["60 8", { kg: 60, reps: 8 }],
  ["sixty 8", null], // word-form: regex skips, LLM handles
  ["bodyweight 12 reps", { kg: null, reps: 12 }],
  ["8 reps at 60", { kg: 60, reps: 8 }],
  ["135 lbs 5 reps", { kg: 61.5, reps: 5 }],
  ["100 kilos 6", { kg: 100, reps: 6 }],
  ["nothing here", null],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const got = parseVoiceSet(input);
  const eq = JSON.stringify(got) === JSON.stringify(expected);
  if (eq) {
    pass++;
    console.log(`PASS: "${input}" → ${JSON.stringify(got)}`);
  } else {
    fail++;
    console.log(`FAIL: "${input}" → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 4: Run the smoke**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types scripts/parse-voice-smoke.mjs`
Expected: `8/8 pass`. If any FAIL line appears, adjust regex in `parse-voice.ts` and re-run.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/logger/parse-voice.ts lib/logger/parse-voice-llm.ts scripts/parse-voice-smoke.mjs
git commit -m "feat(logger): voice parser (regex + Haiku fallback) with smoke script"
```

---

## Task 5: IndexedDB draft store

**Files:**
- Modify: `package.json`
- Create: `lib/logger/draft-store.ts`

- [ ] **Step 1: Add `idb` dependency**

Run: `npm install idb`
Expected: `idb` appears in `package.json` dependencies.

- [ ] **Step 2: Create `lib/logger/draft-store.ts`**

```ts
import { openDB, type IDBPDatabase } from "idb";
import type { LoggerDraft } from "@/lib/logger/types";

const DB_NAME = "apex-logger";
const DB_VERSION = 1;
const STORE = "drafts";
const MAX_AGE_HOURS = 12;

interface Schema {
  drafts: { key: string; value: LoggerDraft };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

function key(userId: string, sessionType: string) {
  return `${userId}:${sessionType}`;
}

export async function saveDraft(draft: LoggerDraft): Promise<void> {
  const db = await getDB();
  await db.put(STORE, draft, key(draft.user_id, draft.session_type));
}

export async function loadDraft(
  userId: string,
  sessionType: string,
): Promise<LoggerDraft | null> {
  const db = await getDB();
  const draft = (await db.get(STORE, key(userId, sessionType))) as LoggerDraft | undefined;
  if (!draft) return null;

  // Discard if older than MAX_AGE_HOURS.
  const ageMs = Date.now() - new Date(draft.updated_at).getTime();
  if (ageMs > MAX_AGE_HOURS * 3600 * 1000) {
    await db.delete(STORE, key(userId, sessionType));
    return null;
  }

  return draft;
}

export async function clearDraft(userId: string, sessionType: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, key(userId, sessionType));
}

export async function listDrafts(userId: string): Promise<LoggerDraft[]> {
  const db = await getDB();
  const all = (await db.getAll(STORE)) as LoggerDraft[];
  return all.filter((d) => d.user_id === userId);
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json lib/logger/draft-store.ts
git commit -m "feat(logger): IndexedDB draft store (12h TTL)"
```

---

## Task 6: Rest timer hook + Wake Lock

**Files:**
- Create: `lib/logger/rest-timer.ts`

- [ ] **Step 1: Create `lib/logger/rest-timer.ts`**

```ts
import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Countdown timer. Calls onDone exactly once when elapsed ≥ duration_seconds.
 * Returns { remaining_seconds, elapsed_seconds, isRunning, skip, extend }.
 */
export function useRestCountdown(opts: {
  duration_seconds: number;
  started_at: number | null; // ms since epoch; null = not running
  onDone: () => void;
}) {
  const { duration_seconds, started_at, onDone } = opts;
  const [now, setNow] = useState(() => Date.now());
  const doneFiredRef = useRef(false);

  useEffect(() => {
    if (!started_at) return;
    doneFiredRef.current = false;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [started_at]);

  const elapsed_seconds = started_at ? Math.floor((now - started_at) / 1000) : 0;
  const remaining_seconds = Math.max(0, duration_seconds - elapsed_seconds);

  useEffect(() => {
    if (started_at && remaining_seconds === 0 && !doneFiredRef.current) {
      doneFiredRef.current = true;
      onDone();
    }
  }, [started_at, remaining_seconds, onDone]);

  const skip = useCallback(() => {
    doneFiredRef.current = true;
    onDone();
  }, [onDone]);

  return { remaining_seconds, elapsed_seconds, isRunning: !!started_at, skip };
}

/**
 * Acquire a screen Wake Lock on mount; release on unmount or visibility hide.
 * Silent no-op on browsers that don't support it.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> } }).wakeLock;
        if (!wl) return;
        sentinel = await wl.request("screen");
      } catch {
        // Some browsers reject in non-focused tabs; safe to ignore.
      }
    };

    const onVisChange = () => {
      if (document.visibilityState === "visible" && !sentinel && !cancelled) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisChange);
      void sentinel?.release();
      sentinel = null;
    };
  }, [active]);
}

/**
 * Fire a 200ms vibration + short bleep on rest-timer completion.
 */
export function fireRestDoneCue() {
  try {
    if ("vibrate" in navigator) navigator.vibrate(200);
  } catch {}
  try {
    const ctx = new (window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    setTimeout(() => ctx.close(), 500);
  } catch {}
}

// Minimal browser type for WakeLockSentinel.
interface WakeLockSentinel {
  release(): Promise<void>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/logger/rest-timer.ts
git commit -m "feat(logger): rest countdown hook + Wake Lock + vibrate/audio cue"
```

---

## Task 7: Commit server action + API route

**Files:**
- Create: `lib/logger/commit-session.ts`
- Create: `app/api/logger/session/route.ts`

- [ ] **Step 1: Create `lib/logger/commit-session.ts`**

```ts
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { CommitSessionPayload } from "@/lib/logger/types";

/**
 * Server action: calls commit_logger_session(payload) RPC, then revalidates
 * the surfaces that show today's lifts.
 */
export async function commitSession(payload: CommitSessionPayload): Promise<{
  workout_id: string;
}> {
  const supabase = await createSupabaseServerClient();

  // Auth check — the RPC also enforces, but failing fast here gives a better error.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Not authenticated");
  if (user.id !== payload.user_id) throw new Error("user_id mismatch");

  // Defensive: at most 30 exercises, at most 30 sets per exercise (also enforced in RPC).
  if (payload.exercises.length > 30) {
    throw new Error("Too many exercises in one session (max 30)");
  }
  for (const ex of payload.exercises) {
    if (ex.sets.length > 30) {
      throw new Error(`Too many sets for ${ex.name} (max 30)`);
    }
  }

  const { data, error } = await supabase.rpc("commit_logger_session", {
    payload: payload as unknown as Record<string, unknown>,
  });

  if (error) throw error;
  if (typeof data !== "string") throw new Error("commit_logger_session returned unexpected shape");

  revalidatePath("/strength");
  revalidatePath("/");
  revalidatePath("/metrics");

  return { workout_id: data };
}
```

- [ ] **Step 2: Create `app/api/logger/session/route.ts`**

```ts
import { NextResponse } from "next/server";
import { commitSession } from "@/lib/logger/commit-session";
import type { CommitSessionPayload } from "@/lib/logger/types";

export async function POST(req: Request) {
  let payload: CommitSessionPayload;
  try {
    payload = (await req.json()) as CommitSessionPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !payload.user_id ||
    !payload.external_id ||
    !payload.date ||
    !payload.type ||
    !Array.isArray(payload.exercises)
  ) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const result = await commitSession(payload);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("authenticated") || msg.includes("mismatch") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/logger/commit-session.ts app/api/logger/session/route.ts
git commit -m "feat(logger): commitSession server action + POST /api/logger/session"
```

---

## Task 8: Template CRUD + fetchers + hooks

**Files:**
- Create: `app/api/logger/templates/[session_type]/route.ts`
- Create: `lib/query/fetchers/userSessionTemplates.ts`
- Create: `lib/query/fetchers/previousSet.ts`
- Create: `lib/query/hooks/useUserSessionTemplate.ts`
- Create: `lib/query/hooks/usePreviousSet.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Create the template CRUD route**

`app/api/logger/templates/[session_type]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

type Ctx = { params: Promise<{ session_type: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const { session_type } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { exercises: PlannedExercise[] };
  try {
    body = (await req.json()) as { exercises: PlannedExercise[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.exercises) || body.exercises.length === 0) {
    return NextResponse.json({ error: "exercises must be a non-empty array" }, { status: 400 });
  }

  const { error } = await supabase
    .from("user_session_templates")
    .upsert(
      {
        user_id: user.id,
        session_type,
        exercises: body.exercises,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,session_type" },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { session_type } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { error } = await supabase
    .from("user_session_templates")
    .delete()
    .eq("user_id", user.id)
    .eq("session_type", session_type);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Create the userSessionTemplates fetchers**

`lib/query/fetchers/userSessionTemplates.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { UserSessionTemplate } from "@/lib/data/types";

const SELECT = "user_id, session_type, exercises, updated_at";

async function fetchOne(
  supabase: SupabaseClient,
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const { data, error } = await supabase
    .from("user_session_templates")
    .select(SELECT)
    .eq("user_id", userId)
    .eq("session_type", sessionType)
    .maybeSingle();
  if (error) throw error;
  return (data as UserSessionTemplate | null) ?? null;
}

export async function fetchUserSessionTemplateServer(
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const supabase = await createSupabaseServerClient();
  return fetchOne(supabase, userId, sessionType);
}

export async function fetchUserSessionTemplateBrowser(
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const supabase = createSupabaseBrowserClient();
  return fetchOne(supabase, userId, sessionType);
}
```

- [ ] **Step 3: Create the previousSet fetcher**

`lib/query/fetchers/previousSet.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type PreviousSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean;
  workout_date: string;
};

/**
 * Last completed set for this exercise (exact-match by name, case-insensitive trim)
 * at the given set_index, excluding the in-progress draft workout if any.
 *
 * Returns null if no prior workout matches.
 */
async function fetchOne(
  supabase: SupabaseClient,
  args: {
    userId: string;
    exerciseName: string;
    setIndex: number;
    excludeWorkoutExternalId: string | null;
  },
): Promise<PreviousSet | null> {
  const trimmed = args.exerciseName.trim();

  // Two-step query: most recent workouts → matching exercises → matching sets.
  // Limit at every step keeps the round trip cheap.
  let workoutsQ = supabase
    .from("workouts")
    .select("id, date, external_id, exercises!inner(id, name, exercise_sets!inner(set_index, kg, reps, warmup))")
    .eq("user_id", args.userId)
    .ilike("exercises.name", trimmed)
    .eq("exercises.exercise_sets.set_index", args.setIndex)
    .order("date", { ascending: false })
    .limit(5);

  if (args.excludeWorkoutExternalId) {
    workoutsQ = workoutsQ.neq("external_id", args.excludeWorkoutExternalId);
  }

  const { data, error } = await workoutsQ;
  if (error) throw error;

  for (const w of data ?? []) {
    const ex = (w.exercises as Array<{ exercise_sets: Array<{ set_index: number; kg: number | null; reps: number | null; warmup: boolean }> }>)?.[0];
    const set = ex?.exercise_sets?.[0];
    if (set) {
      return {
        kg: set.kg,
        reps: set.reps,
        warmup: set.warmup,
        workout_date: w.date as string,
      };
    }
  }

  return null;
}

export async function fetchPreviousSetServer(args: Parameters<typeof fetchOne>[1]) {
  const supabase = await createSupabaseServerClient();
  return fetchOne(supabase, args);
}

export async function fetchPreviousSetBrowser(args: Parameters<typeof fetchOne>[1]) {
  const supabase = createSupabaseBrowserClient();
  return fetchOne(supabase, args);
}
```

- [ ] **Step 4: Add the query keys**

Open `lib/query/keys.ts`. Add to the existing `queryKeys` const:

```ts
userSessionTemplates: {
  all: (userId: string) => ["userSessionTemplates", userId] as const,
  one: (userId: string, sessionType: string) =>
    ["userSessionTemplates", userId, sessionType] as const,
},
previousSet: {
  one: (userId: string, exerciseName: string, setIndex: number) =>
    ["previousSet", userId, exerciseName.trim().toLowerCase(), setIndex] as const,
},
```

- [ ] **Step 5: Create the hooks**

`lib/query/hooks/useUserSessionTemplate.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchUserSessionTemplateBrowser } from "@/lib/query/fetchers/userSessionTemplates";

export function useUserSessionTemplate(userId: string, sessionType: string) {
  return useQuery({
    queryKey: queryKeys.userSessionTemplates.one(userId, sessionType),
    queryFn: () => fetchUserSessionTemplateBrowser(userId, sessionType),
    enabled: !!userId && !!sessionType,
  });
}
```

`lib/query/hooks/usePreviousSet.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchPreviousSetBrowser } from "@/lib/query/fetchers/previousSet";

export function usePreviousSet(args: {
  userId: string;
  exerciseName: string;
  setIndex: number;
  excludeWorkoutExternalId: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.previousSet.one(args.userId, args.exerciseName, args.setIndex),
    queryFn: () =>
      fetchPreviousSetBrowser({
        userId: args.userId,
        exerciseName: args.exerciseName,
        setIndex: args.setIndex,
        excludeWorkoutExternalId: args.excludeWorkoutExternalId,
      }),
    enabled: (args.enabled ?? true) && !!args.userId && !!args.exerciseName,
    staleTime: 60_000,
  });
}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/logger/templates lib/query/fetchers/userSessionTemplates.ts \
  lib/query/fetchers/previousSet.ts lib/query/hooks/useUserSessionTemplate.ts \
  lib/query/hooks/usePreviousSet.ts lib/query/keys.ts
git commit -m "feat(logger): template CRUD route + fetchers + hooks + keys"
```

---

## Task 9: Atomic components — VoiceMicButton, RestBar, SetRow

**Files:**
- Create: `components/logger/VoiceMicButton.tsx`
- Create: `components/logger/RestBar.tsx`
- Create: `components/logger/SetRow.tsx`

- [ ] **Step 1: Create `components/logger/VoiceMicButton.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseVoiceSet, type ParsedSet } from "@/lib/logger/parse-voice";

type Props = {
  onParsed: (set: ParsedSet) => void;
  onUnparsed: (transcript: string) => void;
  disabled?: boolean;
};

// Browser Web Speech types — not in lib.dom.d.ts. Minimal shape.
type SpeechRecognitionLike = EventTarget & {
  start: () => void;
  stop: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceMicButton({ onParsed, onUnparsed, disabled }: Props) {
  const [active, setActive] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = !!getSpeechRecognition();

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch {}
    setActive(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      const parsed = parseVoiceSet(transcript);
      if (parsed) onParsed(parsed);
      else onUnparsed(transcript);
    };
    rec.onend = () => setActive(false);
    rec.onerror = () => setActive(false);
    recRef.current = rec;
    setActive(true);
    rec.start();
  }, [onParsed, onUnparsed]);

  useEffect(() => () => stop(), [stop]);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={active ? stop : start}
      disabled={disabled}
      aria-label={active ? "Stop voice input" : "Voice input"}
      className={`w-6 h-6 rounded-md flex items-center justify-center text-[11px] transition-colors ${
        active
          ? "bg-red-500 text-white animate-pulse"
          : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
      }`}
    >
      🎤
    </button>
  );
}
```

- [ ] **Step 2: Create `components/logger/RestBar.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { useRestCountdown, fireRestDoneCue } from "@/lib/logger/rest-timer";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  duration_seconds: number;
  started_at: number | null;
  onDone: () => void;
  onSkip: () => void;
};

export function RestBar({ duration_seconds, started_at, onDone, onSkip }: Props) {
  const { remaining_seconds, elapsed_seconds, isRunning } = useRestCountdown({
    duration_seconds,
    started_at,
    onDone: () => { fireRestDoneCue(); onDone(); },
  });

  // Component cleanup — no-op currently, kept for future safety.
  useEffect(() => () => {}, []);

  if (!isRunning) return null;

  const pct = Math.min(100, (elapsed_seconds / duration_seconds) * 100);
  const mins = Math.floor(remaining_seconds / 60);
  const secs = remaining_seconds % 60;
  const label = `${mins}:${secs.toString().padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2 py-1 px-1 text-blue-400 text-[10px]">
      <span className="font-medium font-mono">{fmtNum(duration_seconds / 60)}:00</span>
      <button
        type="button"
        onClick={onSkip}
        aria-label="Skip rest"
        className="flex-1 h-[3px] bg-blue-500/15 rounded-full overflow-hidden"
      >
        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${pct}%` }} />
      </button>
      <span className="font-mono tabular-nums">{label}</span>
    </div>
  );
}
```

- [ ] **Step 3: Create `components/logger/SetRow.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { usePreviousSet } from "@/lib/query/hooks/usePreviousSet";
import { VoiceMicButton } from "@/components/logger/VoiceMicButton";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  userId: string;
  exerciseName: string;
  excludeWorkoutExternalId: string | null;
  set: ExerciseSetDraft;
  isActive: boolean;
  onChange: (patch: Partial<ExerciseSetDraft>) => void;
  onCommit: () => void;
  onUncommit: () => void;
  onUnparsedVoice: (transcript: string) => void;
};

export function SetRow({
  userId, exerciseName, excludeWorkoutExternalId, set,
  isActive, onChange, onCommit, onUncommit, onUnparsedVoice,
}: Props) {
  const [draftKg, setDraftKg] = useState<string>(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useState<string>(set.reps !== null ? String(set.reps) : "");

  const prev = usePreviousSet({
    userId,
    exerciseName,
    setIndex: set.set_index,
    excludeWorkoutExternalId,
    enabled: !set.committed_at,
  });

  const committed = !!set.committed_at;
  const setLabel = set.warmup ? "W" : String(set.set_index + 1);
  const setBadgeClass = set.warmup
    ? "bg-yellow-500/15 text-yellow-300"
    : "bg-zinc-800 text-zinc-200";

  return (
    <tr>
      <td className="py-1">
        <button
          type="button"
          onClick={() => onChange({ warmup: !set.warmup })}
          className={`w-6 h-6 rounded-md text-[11px] font-semibold ${setBadgeClass}`}
          aria-label={set.warmup ? "Mark as working set" : "Mark as warmup"}
        >
          {setLabel}
        </button>
      </td>
      <td className="py-1 text-[10.5px] text-zinc-600">
        {prev.data ? `${fmtNum(prev.data.kg ?? 0) || "BW"} × ${prev.data.reps ?? "—"}` : "—"}
      </td>
      <td className="py-1">
        <input
          inputMode="decimal"
          value={draftKg}
          onChange={(e) => { setDraftKg(e.target.value); }}
          onBlur={() => {
            const n = draftKg === "" ? null : parseFloat(draftKg);
            onChange({ kg: Number.isFinite(n as number) ? (n as number) : null });
          }}
          disabled={committed}
          className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-10 text-center text-[12px] font-medium font-mono tabular-nums ${
            committed ? "text-green-400 bg-green-500/10" : "text-zinc-100"
          }`}
        />
      </td>
      <td className="py-1">
        <input
          inputMode="numeric"
          value={draftReps}
          onChange={(e) => { setDraftReps(e.target.value); }}
          onBlur={() => {
            const n = draftReps === "" ? null : parseInt(draftReps, 10);
            onChange({ reps: Number.isFinite(n as number) ? (n as number) : null });
          }}
          disabled={committed}
          className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-10 text-center text-[12px] font-medium font-mono tabular-nums ${
            committed ? "text-green-400 bg-green-500/10" : "text-zinc-100"
          }`}
        />
      </td>
      <td className="py-1">
        <button
          type="button"
          onClick={committed ? onUncommit : onCommit}
          disabled={!committed && (set.kg === null && !set.warmup) || (!committed && set.reps === null)}
          className={`w-6 h-6 rounded-md flex items-center justify-center text-[12px] ${
            committed
              ? "bg-green-500 text-green-950"
              : isActive
                ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                : "bg-zinc-800 text-zinc-500"
          }`}
          aria-label={committed ? "Uncommit set" : "Commit set"}
        >
          {committed ? "✓" : "○"}
        </button>
      </td>
      <td className="py-1">
        <VoiceMicButton
          disabled={committed}
          onParsed={(p) => {
            setDraftKg(p.kg !== null ? String(p.kg) : "");
            setDraftReps(String(p.reps));
            onChange({ kg: p.kg, reps: p.reps });
            onCommit();
          }}
          onUnparsed={onUnparsedVoice}
        />
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/logger/VoiceMicButton.tsx components/logger/RestBar.tsx components/logger/SetRow.tsx
git commit -m "feat(logger): atomic components — mic, rest bar, set row"
```

---

## Task 10: Composite components — ExerciseCard, ExercisePicker, dialogs

**Files:**
- Create: `components/logger/ExerciseCard.tsx`
- Create: `components/logger/ExercisePicker.tsx`
- Create: `components/logger/ResumeDraftPrompt.tsx`
- Create: `components/logger/SaveAsDefaultDialog.tsx`
- Create: `components/logger/FinishSummary.tsx`

- [ ] **Step 1: Create `components/logger/ExerciseCard.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";
import { SetRow } from "@/components/logger/SetRow";
import { RestBar } from "@/components/logger/RestBar";
import { annotateSession } from "@/lib/coach/session-structure/annotate";

type Props = {
  userId: string;
  externalId: string;
  exercise: ExerciseDraft;
  exerciseIndex: number;
  allExercises: ExerciseDraft[];
  /** Mutate exercise's sets/name; caller persists the new draft. */
  onChange: (next: ExerciseDraft) => void;
  onReplace: () => void;
  onRemove: () => void;
};

export function ExerciseCard({
  userId, externalId, exercise, exerciseIndex, allExercises, onChange, onReplace, onRemove,
}: Props) {
  // Tier + rest prescription from session-structure annotation.
  const annotated = useMemo(() => {
    const list = allExercises.map((e) => e.prescribed);
    const s = annotateSession(list);
    return s.exercises[exerciseIndex];
  }, [allExercises, exerciseIndex]);

  const prescribedRestMin = annotated?.rest_seconds.min ?? 120;
  const [activeRestStartedAt, setActiveRestStartedAt] = useState<number | null>(null);
  const [activeRestSeconds, setActiveRestSeconds] = useState<number>(prescribedRestMin);
  const [restAfterSetIndex, setRestAfterSetIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unparsedBanner, setUnparsedBanner] = useState<string | null>(null);

  function commitSet(setIndex: number) {
    const nowIso = new Date().toISOString();
    const now = Date.now();
    const nextSets = exercise.sets.map((s, i) => {
      if (i !== setIndex) return s;
      return { ...s, committed_at: nowIso };
    });

    // rest_seconds_actual on the NEXT pending set is captured at its own commit time.
    onChange({ ...exercise, sets: nextSets });
    setRestAfterSetIndex(setIndex);
    setActiveRestSeconds(prescribedRestMin);
    setActiveRestStartedAt(now);
  }

  function uncommitSet(setIndex: number) {
    const nextSets = exercise.sets.map((s, i) =>
      i === setIndex ? { ...s, committed_at: null } : s,
    );
    onChange({ ...exercise, sets: nextSets });
  }

  function patchSet(setIndex: number, patch: Partial<ExerciseSetDraft>) {
    const nextSets = exercise.sets.map((s, i) => (i === setIndex ? { ...s, ...patch } : s));
    onChange({ ...exercise, sets: nextSets });
  }

  function addSet() {
    const last = exercise.sets[exercise.sets.length - 1];
    const next: ExerciseSetDraft = {
      set_index: exercise.sets.length,
      kg: last?.kg ?? exercise.prescribed.baseKg ?? null,
      reps: null,
      warmup: false,
      failure: false,
      committed_at: null,
    };
    onChange({ ...exercise, sets: [...exercise.sets, next] });
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold text-zinc-50">{exercise.name}</h4>
        <div className="flex gap-1.5 items-center relative">
          {annotated && (
            <span className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded uppercase tracking-wider">
              T{annotated.fatigue_tier} · RPE {annotated.rpe_target}
            </span>
          )}
          <button onClick={() => setMenuOpen((v) => !v)} className="text-zinc-500 text-base" aria-label="Exercise menu">⋯</button>
          {menuOpen && (
            <div className="absolute right-0 top-6 bg-zinc-800 border border-zinc-700 rounded-lg p-1 text-xs z-10 min-w-[140px]">
              <button onClick={() => { setMenuOpen(false); onReplace(); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded">Replace</button>
              <button onClick={() => { setMenuOpen(false); onRemove(); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-red-400">Remove</button>
            </div>
          )}
        </div>
      </div>

      {unparsedBanner && (
        <div className="text-[11px] text-amber-400 bg-amber-500/10 rounded px-2 py-1 mb-2">
          Heard "{unparsedBanner}" — type it instead?
          <button onClick={() => setUnparsedBanner(null)} className="ml-2 text-amber-300 underline">dismiss</button>
        </div>
      )}

      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-zinc-500 text-[10px]">
            <th className="text-left font-normal py-1">Set</th>
            <th className="text-left font-normal py-1">Previous</th>
            <th className="text-left font-normal py-1">kg</th>
            <th className="text-left font-normal py-1">Reps</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {exercise.sets.map((s, i) => (
            <>
              <SetRow
                key={i}
                userId={userId}
                exerciseName={exercise.name}
                excludeWorkoutExternalId={externalId}
                set={s}
                isActive={!s.committed_at && exercise.sets.findIndex((x) => !x.committed_at) === i}
                onChange={(patch) => patchSet(i, patch)}
                onCommit={() => commitSet(i)}
                onUncommit={() => uncommitSet(i)}
                onUnparsedVoice={setUnparsedBanner}
              />
              {restAfterSetIndex === i && (
                <tr><td colSpan={6}>
                  <RestBar
                    duration_seconds={activeRestSeconds}
                    started_at={activeRestStartedAt}
                    onDone={() => { /* visual cue only — bar stays until next set commit */ }}
                    onSkip={() => { setActiveRestStartedAt(null); setRestAfterSetIndex(null); }}
                  />
                </td></tr>
              )}
            </>
          ))}
        </tbody>
      </table>

      <button
        type="button"
        onClick={addSet}
        className="bg-zinc-800 text-zinc-300 border-none w-full py-2 rounded-lg text-[11px] mt-1"
      >
        + Add set ({Math.floor(prescribedRestMin / 60)}:{(prescribedRestMin % 60).toString().padStart(2, "0")})
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create `components/logger/ExercisePicker.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import { EXERCISE_MUSCLES } from "@/lib/coach/exercise-muscles";

type Props = {
  onPick: (name: string) => void;
  onClose: () => void;
};

export function ExercisePicker({ onPick, onClose }: Props) {
  const [q, setQ] = useState("");

  const candidates = useMemo(() => {
    const all = Object.keys(EXERCISE_MUSCLES);
    if (!q.trim()) return all.slice(0, 30);
    const lower = q.trim().toLowerCase();
    return all.filter((n) => n.toLowerCase().includes(lower)).slice(0, 30);
  }, [q]);

  const showFreeText = q.trim().length > 0 &&
    !candidates.some((n) => n.toLowerCase() === q.trim().toLowerCase());

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end z-50">
      <div className="bg-zinc-950 border-t border-zinc-800 rounded-t-2xl w-full max-h-[80vh] flex flex-col">
        <div className="p-3 border-b border-zinc-800">
          <input
            autoFocus
            placeholder="Search exercises…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100"
          />
        </div>
        <div className="overflow-y-auto flex-1">
          {showFreeText && (
            <button
              onClick={() => onPick(q.trim())}
              className="w-full text-left px-3 py-2.5 text-sm text-blue-400 border-b border-zinc-800 hover:bg-zinc-900"
            >
              Use "{q.trim()}" (new exercise)
            </button>
          )}
          {candidates.map((name) => (
            <button
              key={name}
              onClick={() => onPick(name)}
              className="w-full text-left px-3 py-2.5 text-sm text-zinc-200 hover:bg-zinc-900 border-b border-zinc-900"
            >
              {name}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="p-3 text-center text-zinc-500 text-sm border-t border-zinc-800">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `components/logger/ResumeDraftPrompt.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import type { LoggerDraft } from "@/lib/logger/types";

type Props = {
  draft: LoggerDraft;
  onResume: () => void;
  onDiscard: () => void;
};

export function ResumeDraftPrompt({ draft, onResume, onDiscard }: Props) {
  const [committedCount, setCommittedCount] = useState(0);
  const [ageMin, setAgeMin] = useState(0);

  useEffect(() => {
    let n = 0;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (s.committed_at) n++;
      }
    }
    setCommittedCount(n);
    setAgeMin(Math.max(1, Math.round((Date.now() - new Date(draft.updated_at).getTime()) / 60000)));
  }, [draft]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-1">Resume {draft.session_type} session?</h3>
        <p className="text-sm text-zinc-400 mb-4">Started {ageMin} minutes ago — {committedCount} {committedCount === 1 ? "set" : "sets"} logged.</p>
        <div className="flex gap-2">
          <button onClick={onResume} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium">Resume</button>
          <button onClick={onDiscard} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Discard</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `components/logger/SaveAsDefaultDialog.tsx`**

```tsx
"use client";

type Props = {
  sessionType: string;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
};

export function SaveAsDefaultDialog({ sessionType, onConfirm, onCancel, saving }: Props) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-2">Save your {sessionType} day as your default?</h3>
        <p className="text-sm text-zinc-400 mb-4">
          This will be used the next time you start a {sessionType} session.
          Coach's original plan stays available — reset anytime.
        </p>
        <div className="flex gap-2">
          <button onClick={onConfirm} disabled={saving} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : `Save as my ${sessionType} day`}
          </button>
          <button onClick={onCancel} disabled={saving} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `components/logger/FinishSummary.tsx`**

```tsx
"use client";

import type { LoggerDraft } from "@/lib/logger/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  draft: LoggerDraft;
  durationMin: number;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
};

export function FinishSummary({ draft, durationMin, onConfirm, onCancel, saving }: Props) {
  let totalSets = 0;
  let totalVolume = 0;
  for (const ex of draft.exercises) {
    for (const s of ex.sets) {
      if (s.committed_at && s.kg !== null && s.reps !== null) {
        totalSets++;
        totalVolume += s.kg * s.reps;
      }
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-3">{draft.session_type} · {Math.round(durationMin)} min</h3>
        <ul className="text-sm text-zinc-300 space-y-1 mb-4">
          <li>{draft.exercises.length} {draft.exercises.length === 1 ? "exercise" : "exercises"}</li>
          <li>{totalSets} {totalSets === 1 ? "set" : "sets"}</li>
          <li>Total volume: {fmtNum(totalVolume)} kg</li>
        </ul>
        <div className="flex gap-2">
          <button onClick={onConfirm} disabled={saving} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Finish & save"}
          </button>
          <button onClick={onCancel} disabled={saving} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Back</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/logger/ExerciseCard.tsx components/logger/ExercisePicker.tsx \
  components/logger/ResumeDraftPrompt.tsx components/logger/SaveAsDefaultDialog.tsx \
  components/logger/FinishSummary.tsx
git commit -m "feat(logger): composite components — exercise card, picker, dialogs"
```

---

## Task 11: LoggerSheet root composition

**Files:**
- Create: `components/logger/LoggerSheet.tsx`

The root component composes everything: resolves the plan, owns the draft state, mirrors to IndexedDB, handles Wake Lock, computes "exercise-list divergence" for the Save button, and gates the commit POST.

- [ ] **Step 1: Create `components/logger/LoggerSheet.tsx`**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { LoggerDraft, ExerciseDraft, CommitSessionPayload } from "@/lib/logger/types";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadDraft, saveDraft, clearDraft } from "@/lib/logger/draft-store";
import { useWakeLock } from "@/lib/logger/rest-timer";
import { ExerciseCard } from "@/components/logger/ExerciseCard";
import { ExercisePicker } from "@/components/logger/ExercisePicker";
import { ResumeDraftPrompt } from "@/components/logger/ResumeDraftPrompt";
import { SaveAsDefaultDialog } from "@/components/logger/SaveAsDefaultDialog";
import { FinishSummary } from "@/components/logger/FinishSummary";
import { queryKeys } from "@/lib/query/keys";

type Props = {
  userId: string;
  sessionType: string;
  date: string;            // YYYY-MM-DD
  weekdayLong: string;     // "Monday"
  weekOverrides: Record<string, PlannedExercise[]> | null;
  onClose: () => void;
};

function makeDraftFromPlan(args: {
  userId: string;
  sessionType: string;
  date: string;
  plan: PlannedExercise[];
}): LoggerDraft {
  const externalId = `logger-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const exercises: ExerciseDraft[] = args.plan.map((p, i) => ({
    name: p.name,
    position: i,
    prescribed: p,
    sets: Array.from({ length: p.sets ?? 1 }, (_unused, j) => ({
      set_index: j,
      kg: p.baseKg ?? null,
      reps: null,
      warmup: !!p.warmup && j === 0,
      failure: false,
      committed_at: null,
    })),
  }));
  return {
    user_id: args.userId,
    session_type: args.sessionType,
    date: args.date,
    started_at: nowIso, // overwritten on first ✓
    updated_at: nowIso,
    exercises,
    resolved_plan: args.plan,
    external_id: externalId,
  };
}

function hasFirstCommit(draft: LoggerDraft) {
  for (const ex of draft.exercises) {
    for (const s of ex.sets) {
      if (s.committed_at) return true;
    }
  }
  return false;
}

function exerciseListDiverged(draft: LoggerDraft): boolean {
  const resolvedNames = draft.resolved_plan.map((e) => e.name).sort();
  const currentNames = draft.exercises.map((e) => e.name).sort();
  if (resolvedNames.length !== currentNames.length) return true;
  for (let i = 0; i < resolvedNames.length; i++) {
    if (resolvedNames[i] !== currentNames[i]) return true;
  }
  // Also count: prescribed set count differences imply structural divergence.
  for (let i = 0; i < draft.exercises.length; i++) {
    const cur = draft.exercises[i];
    const original = draft.resolved_plan.find((p) => p.name === cur.name);
    if (!original) return true;
    if ((original.sets ?? 1) !== cur.sets.length) return true;
  }
  return false;
}

export function LoggerSheet(props: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [draft, setDraft] = useState<LoggerDraft | null>(null);
  const [resumePrompt, setResumePrompt] = useState<LoggerDraft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"add" | { replace_index: number }>("add");
  const [saveDefaultOpen, setSaveDefaultOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useWakeLock(!!draft);

  // 1) Mount: load existing draft or build from resolved plan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await loadDraft(props.userId, props.sessionType);
      if (cancelled) return;
      if (existing && hasFirstCommit(existing)) {
        setResumePrompt(existing);
        return;
      }
      const resolved = await resolveSessionPlan({
        supabase,
        userId: props.userId,
        sessionType: props.sessionType,
        weekdayLong: props.weekdayLong,
        weekOverrides: props.weekOverrides ?? null,
      });
      const fresh = makeDraftFromPlan({
        userId: props.userId,
        sessionType: props.sessionType,
        date: props.date,
        plan: resolved.exercises,
      });
      setDraft(fresh);
    })().catch((e) => console.error("LoggerSheet mount failed", e));
    return () => { cancelled = true; };
  }, [props.userId, props.sessionType, props.date, props.weekdayLong, props.weekOverrides, supabase]);

  // 2) Mirror to IndexedDB on every change.
  useEffect(() => {
    if (!draft) return;
    const updated = { ...draft, updated_at: new Date().toISOString() };
    void saveDraft(updated);
  }, [draft]);

  // 3) Tick clock for elapsed.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startedAt = useMemo(() => {
    if (!draft) return null;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (s.committed_at) return new Date(s.committed_at).getTime();
      }
    }
    return null;
  }, [draft]);

  const elapsedMs = startedAt ? now - startedAt : 0;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
  const elapsedLabel = `${elapsedMin}:${elapsedSec.toString().padStart(2, "0")}`;

  if (resumePrompt && !draft) {
    return (
      <ResumeDraftPrompt
        draft={resumePrompt}
        onResume={() => { setDraft(resumePrompt); setResumePrompt(null); }}
        onDiscard={async () => {
          await clearDraft(props.userId, props.sessionType);
          setResumePrompt(null);
          // Re-mount path: build fresh.
          const resolved = await resolveSessionPlan({
            supabase, userId: props.userId, sessionType: props.sessionType,
            weekdayLong: props.weekdayLong, weekOverrides: props.weekOverrides ?? null,
          });
          setDraft(makeDraftFromPlan({
            userId: props.userId, sessionType: props.sessionType,
            date: props.date, plan: resolved.exercises,
          }));
        }}
      />
    );
  }

  if (!draft) {
    return <div className="fixed inset-0 bg-black/90 flex items-center justify-center text-zinc-500">Loading…</div>;
  }

  const diverged = exerciseListDiverged(draft);

  async function commitNow() {
    if (!draft) return;
    setCommitting(true);
    const payload: CommitSessionPayload = {
      user_id: draft.user_id,
      external_id: draft.external_id,
      date: draft.date,
      type: draft.session_type,
      duration_min: startedAt ? Math.round((Date.now() - startedAt) / 60000) : null,
      exercises: draft.exercises.map((ex, i) => ({
        name: ex.name,
        position: i,
        sets: ex.sets
          .filter((s) => s.committed_at)
          .map((s, sIdx, arr) => {
            const prev = arr[sIdx - 1];
            const restActual = prev?.committed_at && s.committed_at
              ? Math.round(
                  (new Date(s.committed_at).getTime() - new Date(prev.committed_at).getTime()) / 1000,
                )
              : null;
            return {
              set_index: s.set_index,
              kg: s.kg,
              reps: s.reps,
              duration_seconds: null,
              warmup: s.warmup,
              failure: s.failure,
              rest_seconds_actual: restActual,
            };
          }),
      })),
    };

    const res = await fetch("/api/logger/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      setCommitting(false);
      alert("Commit failed — your draft is preserved. Try Finish again.");
      return;
    }

    await clearDraft(draft.user_id, draft.session_type);
    qc.invalidateQueries({ queryKey: ["workouts"] });
    router.refresh();
    props.onClose();
  }

  async function saveAsDefault() {
    if (!draft) return;
    setSavingTemplate(true);
    const exercises = draft.exercises.map((e) => ({ ...e.prescribed, name: e.name, sets: e.sets.length }));
    const res = await fetch(`/api/logger/templates/${encodeURIComponent(draft.session_type)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exercises }),
    });
    setSavingTemplate(false);
    setSaveDefaultOpen(false);
    if (!res.ok) {
      alert("Save failed — try again.");
      return;
    }
    qc.invalidateQueries({
      queryKey: queryKeys.userSessionTemplates.one(draft.user_id, draft.session_type),
    });
  }

  return (
    <div className="fixed inset-0 bg-black z-40 flex flex-col">
      <div className="flex items-center justify-between p-3 border-b border-zinc-900 pt-[env(safe-area-inset-top)]">
        <button onClick={props.onClose} className="text-zinc-400 text-lg" aria-label="Close logger">‹</button>
        <div className="text-zinc-300 text-sm flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span>
          <span className="font-mono tabular-nums">{startedAt ? elapsedLabel : "0:00"}</span>
          <span>· {draft.session_type}</span>
        </div>
        <button onClick={() => setFinishOpen(true)} className="bg-green-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">
          Finish
        </button>
      </div>

      <div className="overflow-y-auto p-3 pb-32 flex-1">
        {diverged && (
          <button
            onClick={() => setSaveDefaultOpen(true)}
            className="w-full bg-blue-500/10 border border-blue-500/30 text-blue-400 rounded-lg py-2 text-xs mb-3"
          >
            Save deviations as my {draft.session_type} default
          </button>
        )}

        {draft.exercises.map((ex, i) => (
          <ExerciseCard
            key={`${ex.name}-${i}`}
            userId={draft.user_id}
            externalId={draft.external_id}
            exercise={ex}
            exerciseIndex={i}
            allExercises={draft.exercises}
            onChange={(next) => setDraft({ ...draft, exercises: draft.exercises.map((e, j) => j === i ? next : e) })}
            onReplace={() => { setPickerMode({ replace_index: i }); setPickerOpen(true); }}
            onRemove={() => setDraft({ ...draft, exercises: draft.exercises.filter((_, j) => j !== i) })}
          />
        ))}

        <button
          onClick={() => { setPickerMode("add"); setPickerOpen(true); }}
          className="bg-transparent text-zinc-500 border border-dashed border-zinc-800 w-full py-3 rounded-lg text-sm"
        >
          + Add exercise
        </button>
      </div>

      {pickerOpen && (
        <ExercisePicker
          onClose={() => setPickerOpen(false)}
          onPick={(name) => {
            if (pickerMode === "add") {
              const newEx: ExerciseDraft = {
                name,
                position: draft.exercises.length,
                prescribed: { name, sets: 3, baseReps: 10 },
                sets: Array.from({ length: 3 }, (_x, j) => ({
                  set_index: j, kg: null, reps: null, warmup: false, failure: false, committed_at: null,
                })),
              };
              setDraft({ ...draft, exercises: [...draft.exercises, newEx] });
            } else {
              const idx = pickerMode.replace_index;
              setDraft({
                ...draft,
                exercises: draft.exercises.map((e, j) => j === idx ? { ...e, name } : e),
              });
            }
            setPickerOpen(false);
          }}
        />
      )}

      {saveDefaultOpen && (
        <SaveAsDefaultDialog
          sessionType={draft.session_type}
          saving={savingTemplate}
          onConfirm={saveAsDefault}
          onCancel={() => setSaveDefaultOpen(false)}
        />
      )}

      {finishOpen && (
        <FinishSummary
          draft={draft}
          durationMin={startedAt ? (Date.now() - startedAt) / 60000 : 0}
          saving={committing}
          onConfirm={commitNow}
          onCancel={() => setFinishOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

Run `npm run dev`. Open http://localhost:3000. You can't yet reach the LoggerSheet (no entry point) — but the typecheck pass plus a clean dev-server start indicates no compile errors. Defer real UI testing to after Task 12 wires it up.

- [ ] **Step 4: Commit**

```bash
git add components/logger/LoggerSheet.tsx
git commit -m "feat(logger): LoggerSheet root — draft, divergence, commit, save-default"
```

---

## Task 12: Integration — TodayPlanCard + BriefSessionList CTAs

**Files:**
- Modify: `components/strength/TodayPlanCard.tsx`
- Modify: `components/morning/BriefSessionList.tsx`

The CTAs open the LoggerSheet. State of "open/closed" lives in the calling component.

- [ ] **Step 1: Inspect `TodayPlanCard.tsx`**

Run: `head -80 components/strength/TodayPlanCard.tsx` to find the props it already receives. You need: `userId`, `sessionType`, `date`, `weekdayLong`, `weekOverrides`. If any aren't passed in, add them as new props (and pass them from the parent — chain back to `StrengthClient.tsx`).

- [ ] **Step 2: Add the LoggerSheet mount + CTA to `TodayPlanCard.tsx`**

Inside the component (top of the function body):

```tsx
const [loggerOpen, setLoggerOpen] = useState(false);
```

Find the existing header/footer area in the card. Add the button (matching the existing button styles in the file):

```tsx
<button
  onClick={() => setLoggerOpen(true)}
  className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
>
  Start session
</button>
```

At the bottom of the JSX return (after the closing tag of the main card div):

```tsx
{loggerOpen && (
  <LoggerSheet
    userId={userId}
    sessionType={sessionType}
    date={date}
    weekdayLong={weekdayLong}
    weekOverrides={weekOverrides}
    onClose={() => setLoggerOpen(false)}
  />
)}
```

Add the import at the top:

```tsx
import { LoggerSheet } from "@/components/logger/LoggerSheet";
```

If `useState` isn't already imported, add it: `import { useState } from "react";`.

- [ ] **Step 3: Inspect `BriefSessionList.tsx`**

Run: `head -60 components/morning/BriefSessionList.tsx`. Decide where in the existing layout the "Log this session" link goes (typically below the session detail list, before the next block). The same `userId / sessionType / date / weekdayLong / weekOverrides` props are needed; if missing, thread them in.

- [ ] **Step 4: Add the CTA + mount to `BriefSessionList.tsx`**

Same pattern as Step 2 — `useState` + button + conditional `<LoggerSheet />`. Button styling can be quieter (link-style) since the brief is information-first:

```tsx
<button
  onClick={() => setLoggerOpen(true)}
  className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 mt-2"
>
  Log this session
</button>
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Manual smoke**

Run `npm run dev`. Open http://localhost:3000/strength. Tap "Start session". Confirm:
- Sheet opens full-screen, dark, with today's prescribed exercises listed
- Tapping ✓ on a row marks it green, starts the rest bar
- 🎤 button is visible (Web Speech available); tap and say "60 kg 8 reps" — fills + commits + starts timer
- Closing the sheet preserves state — reopening prompts "Resume?"
- Editing an exercise (Replace via ⋯ menu) shows the divergence Save button

Capture any issues; fix inline before commit.

- [ ] **Step 7: Commit**

```bash
git add components/strength/TodayPlanCard.tsx components/morning/BriefSessionList.tsx
git commit -m "feat(logger): wire Start-session CTAs into TodayPlanCard + BriefSessionList"
```

---

## Task 13: Strong ingest opt-out + profile flag

**Files:**
- Create: `app/api/profile/disable-strong-ingest/route.ts`
- Modify: `app/api/ingest/strong/route.ts`
- Modify: `components/profile/ProfileClient.tsx`

- [ ] **Step 1: Create the toggle endpoint**

`app/api/profile/disable-strong-ingest/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { disable_strong_ingest: boolean };
  try {
    body = (await req.json()) as { disable_strong_ingest: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.disable_strong_ingest !== "boolean") {
    return NextResponse.json({ error: "disable_strong_ingest must be boolean" }, { status: 400 });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ disable_strong_ingest: body.disable_strong_ingest })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Enforce the flag in `app/api/ingest/strong/route.ts`**

Open the file. Near the top after token auth resolves the `user_id`, add:

```ts
const supabase = createSupabaseServiceRoleClient();
const { data: profile, error: profileError } = await supabase
  .from("profiles")
  .select("disable_strong_ingest")
  .eq("user_id", user_id)
  .maybeSingle();
if (profileError) {
  return NextResponse.json({ error: profileError.message }, { status: 500 });
}
if (profile?.disable_strong_ingest) {
  return NextResponse.json(
    { error: "Strong CSV ingest is disabled for this user. Use the in-app logger." },
    { status: 403 },
  );
}
```

(Adapt to where the existing route resolves `user_id` — find the spot with `const user_id = ...` and insert right after.)

- [ ] **Step 3: Add the toggle to ProfileClient.tsx**

Open `components/profile/ProfileClient.tsx`. Find the existing `disable_yazio_ingest` toggle (which is the model). Mirror it for `disable_strong_ingest`:

```tsx
<section className="mb-6">
  <h3 className="text-sm font-semibold text-zinc-200 mb-1">Strong CSV ingest</h3>
  <p className="text-xs text-zinc-500 mb-2">
    Disable to use the in-app workout logger as the only lift source.
  </p>
  <label className="flex items-center gap-2 text-sm text-zinc-300">
    <input
      type="checkbox"
      checked={disableStrong}
      onChange={async (e) => {
        const next = e.target.checked;
        setDisableStrong(next);
        await fetch("/api/profile/disable-strong-ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disable_strong_ingest: next }),
        });
      }}
    />
    Disable Strong CSV ingest
  </label>
</section>
```

Add `const [disableStrong, setDisableStrong] = useState(profile.disable_strong_ingest ?? false);` near the other state declarations at the top of the component (locate by analogy with the existing `disable_yazio_ingest` state).

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

In `/profile`, toggle the new switch. Confirm it persists across reload. Hit `/api/ingest/strong` with a dummy CSV (or the existing iOS Shortcut) — should return 403.

- [ ] **Step 6: Commit**

```bash
git add app/api/profile/disable-strong-ingest/route.ts app/api/ingest/strong/route.ts components/profile/ProfileClient.tsx
git commit -m "feat(logger): profile flag + Strong ingest opt-out enforcement"
```

---

## Task 14: Audit script + CLAUDE.md + final verification

**Files:**
- Create: `scripts/audit-logger-write-path.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the audit script**

`scripts/audit-logger-write-path.mjs`:

```js
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-logger-write-path.mjs
//
// End-to-end audit:
//  - Counts logger-sourced workouts in the last 30 days.
//  - Verifies every logger workout has at least one exercise + one set.
//  - Verifies external_id starts with "logger-".
//  - Surfaces any rows where rest_seconds_actual is populated.
//  - Lists user_session_templates rows for the user.

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const since = new Date();
since.setDate(since.getDate() - 30);
const sinceIso = since.toISOString().slice(0, 10);

const { data: workouts, error } = await supabase
  .from("workouts")
  .select("id, date, type, external_id, source, exercises(name, exercise_sets(kg, reps, rest_seconds_actual))")
  .eq("user_id", userId)
  .eq("source", "logger")
  .gte("date", sinceIso)
  .order("date", { ascending: false });

if (error) {
  console.error("Query failed:", error);
  process.exit(1);
}

console.log(`Found ${workouts?.length ?? 0} logger-sourced workouts in last 30 days\n`);

let badExternalIds = 0;
let emptyWorkouts = 0;
let restActualPopulatedRows = 0;
for (const w of workouts ?? []) {
  if (!w.external_id?.startsWith("logger-")) badExternalIds++;
  if (!w.exercises?.length) { emptyWorkouts++; continue; }
  for (const ex of w.exercises) {
    for (const s of ex.exercise_sets ?? []) {
      if (s.rest_seconds_actual != null) restActualPopulatedRows++;
    }
  }
  console.log(`  ${w.date} · ${w.type} · ${w.exercises.length} exercise${w.exercises.length === 1 ? "" : "s"} · ${w.external_id}`);
}

console.log("\n— Invariants —");
console.log(`  bad external_id prefix: ${badExternalIds}`);
console.log(`  empty workouts (0 exercises): ${emptyWorkouts}`);
console.log(`  sets with rest_seconds_actual populated: ${restActualPopulatedRows}`);

const { data: templates } = await supabase
  .from("user_session_templates")
  .select("session_type, updated_at, exercises")
  .eq("user_id", userId);

console.log(`\n— user_session_templates (${templates?.length ?? 0}) —`);
for (const t of templates ?? []) {
  console.log(`  ${t.session_type} · ${(t.exercises ?? []).length} exercises · updated ${t.updated_at}`);
}

if (badExternalIds > 0 || emptyWorkouts > 0) {
  console.error("\nFAIL: invariants violated");
  process.exit(1);
}
console.log("\nOK");
```

- [ ] **Step 2: Run the audit (after at least one manual logger commit)**

After completing one full logger session via the UI:

Run: `AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-logger-write-path.mjs`
Expected:
- Lists your logger session(s)
- `bad external_id prefix: 0`
- `empty workouts: 0`
- `OK` at the end

- [ ] **Step 3: Update CLAUDE.md**

Find the migrations list in `CLAUDE.md` and add the new entry (after 0024):

```
25. [supabase/migrations/0026_workout_logger.sql](supabase/migrations/0026_workout_logger.sql) — adds `user_session_templates` (per-user persistent "save deviations as my default" layer keyed `(user_id, session_type)`), `exercise_sets.rest_seconds_actual` (actual rest taken between commits), `profiles.disable_strong_ingest` (mirror of `disable_yazio_ingest`), and `commit_logger_session(payload jsonb)` SECURITY DEFINER function for atomic 3-table inserts.
```

Then add a new section under "Architecture" → "Data sources & precedence" → after the "In-app food logging" paragraph, add:

```
- **In-app workout logger** ([components/logger/](components/logger/), [lib/logger/](lib/logger/), tables `workouts/exercises/exercise_sets`) — owns lift logging going forward. Replaces Strong CSV ingest as the primary path. Resolution chain at logger open: `training_weeks.exercise_overrides[weekday]` → `user_session_templates[session_type]` → `SESSION_PLANS[session_type]` (via [lib/logger/resolve-plan.ts](lib/logger/resolve-plan.ts)). Logger writes via [/api/logger/session](app/api/logger/session/route.ts) → `commit_logger_session(payload jsonb)` RPC for atomic 3-table insert. `external_id = 'logger-<uuid>'` (disjoint from Strong's `strong-<date>-<slug>`). Voice entry per set row: Web Speech API → [lib/logger/parse-voice.ts](lib/logger/parse-voice.ts) regex → [lib/logger/parse-voice-llm.ts](lib/logger/parse-voice-llm.ts) Haiku 4.5 fallback. Draft state mirrors to IndexedDB (12h TTL) via [lib/logger/draft-store.ts](lib/logger/draft-store.ts); resume prompt on reopen. Wake Lock API keeps screen on. Rest bar between sets is prescribed via session-structure annotation; actual elapsed captured into `exercise_sets.rest_seconds_actual`. Spec: [docs/superpowers/specs/2026-05-20-in-app-workout-logger-design.md](docs/superpowers/specs/2026-05-20-in-app-workout-logger-design.md). Audit: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-logger-write-path.mjs`.
```

Find the "Strong" bullet under "Data sources & precedence" and prepend a deprecation note:

```
- **Strong CSV** ([app/api/ingest/strong/route.ts](app/api/ingest/strong/route.ts)) — historical ingest path; superseded by the in-app workout logger as of migration 0026. Retained for backfills; users can disable via `profiles.disable_strong_ingest`. Idempotent on `(user_id, external_id)` with `strong-<date>-<slug>` prefix (disjoint from logger's `logger-<uuid>`).
```

- [ ] **Step 4: Final typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

Final smoke checklist (run through one full pass):

1. Open `/strength`, tap **Start session** → LoggerSheet opens with today's prescribed plan
2. Tap ✓ on the first set → rest bar starts at the prescribed value
3. Tap 🎤 on a pending row → say "60 kg 8 reps" → fills, commits, starts timer
4. Tap 🎤 on a pending row → say something garbled → unparsed banner shows + Haiku fallback fills via API (network tab shows POST to Anthropic-routed endpoint)
5. ⋯ menu → Replace → picker → choose a different exercise → divergence banner appears
6. Tap **Save deviations as my Chest default** → confirm dialog → toggle persists across logger reopen (close + reopen, see the new exercise)
7. Close sheet mid-session → reopen → "Resume Chest session?" prompt → Resume preserves committed sets
8. Tap **Finish** → summary sheet → Finish & save → returns to `/strength` → new workout visible
9. Confirm `rest_seconds_actual` is populated on second-and-later sets:
   ```sql
   select count(*) from exercise_sets s
   join exercises e on e.id = s.exercise_id
   join workouts w on w.id = e.workout_id
   where w.source = 'logger' and s.rest_seconds_actual is not null;
   ```
10. In `/profile`, toggle **Disable Strong CSV ingest** → confirm `/api/ingest/strong` returns 403

Commit:

```bash
git add scripts/audit-logger-write-path.mjs CLAUDE.md
git commit -m "feat(logger): audit script + CLAUDE.md docs"
```

Push the branch and open a PR.

---

## Self-review notes (post-write)

- **Spec coverage:** every section of the spec has a task — migration (T1), types (T2), resolver (T3), voice (T4), draft (T5), rest timer (T6), commit (T7), template CRUD (T8), components (T9-T11), integration (T12), Strong opt-out (T13), audit + docs (T14).
- **Placeholder scan:** clean. No TBDs, no "add appropriate error handling" — concrete code at every step.
- **Type consistency:** `LoggerDraft`, `ExerciseDraft`, `ExerciseSetDraft`, `CommitSessionPayload` are defined in T2 and referenced consistently in T5, T7, T11. `PreviousSet` defined in T8 and consumed in T9. `commit_logger_session` RPC signature in T1 matches the payload built in T11.
