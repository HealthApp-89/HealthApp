# Coach chat — precision context, tool fetch, editable system prompt

**Status:** design  
**Date:** 2026-05-06  
**Owner:** Abdelouahed (single user)

## Goal

Eliminate approximate answers from the coach chat. The model should always cite concrete numbers from the athlete's data, and when it doesn't have a value in context it should fetch it from Supabase rather than estimate. The system prompt becomes editable from `/profile` so the coaching style can be tuned without a deploy.

## Non-goals

- Per-muscle volume rollups (chest/quads/etc.) — too much lookup-table maintenance for the precision win this release is targeting. The 7-bucket movement-pattern category is the upgrade we ship; per-muscle resolution is a follow-up if needed.
- Output post-processing to flag hedging language ("around", "roughly"). Prompt-only enforcement, with observability so we can verify it's working.
- Extended thinking on chat turns. Latency cost not worth it here; reserve for weekly review.
- Migrating off the hand-rolled `streamClaude` for non-chat paths (reviews, insights). Only the chat path switches to the official SDK.
- Model upgrade to Sonnet 4.6 / 4.7. Tracked separately via the `claude-api` skill.

## Architecture overview

Three layers that compose into every chat turn:

1. **Cached prefix** — stable across turns for ~14 days. Profile, baselines, training plan, last 14 days of `daily_logs`, last 5 workout summaries. Same as today. Marked `cache_control: ephemeral`.
2. **Per-turn ephemeral header** — re-queried at request time. Today + yesterday rows (fresh, not from cache), data-freshness line ("WHOOP last sync 4h ago"), `NOW` timestamp. Not cached.
3. **Tool layer** — Claude calls `query_daily_logs` or `query_workouts` when it needs anything else. Server enforces user scoping, column allowlist, range caps, and a 5-call-per-turn cap.

The system prompt has two parts concatenated server-side:

- **Schema explainer** — non-editable, lives next to `buildSnapshot()`. Documents column names, units, the meaning of "today/yesterday", and the tool contracts. Plumbing, not personality.
- **User prompt** — editable, stored at `profiles.system_prompt`. Coaching style, tone, the no-approximation rule. Defaults to a canonical string when `NULL`.

```
[system]
  schema_explainer (server-owned, never changes per user)
  + user.system_prompt (or default if null)

[messages]
  cached_prefix (14d snapshot, cache_control: ephemeral, ttl 1h)
  ephemeral_header (today + yesterday + freshness, NOT cached)
  ...prior conversation turns...
  current user message
```

## Components

### 1. Editable system prompt

**Schema (migration `0006_chat_settings.sql`):**

```sql
alter table public.profiles add column if not exists system_prompt text;
alter table public.chat_messages add column if not exists tool_calls jsonb;
```

`system_prompt` is `NULL` for users who haven't customized. The route resolves to `coalesce(profile.system_prompt, DEFAULT_SYSTEM_PROMPT)`. `tool_calls` is observability — see §6.

**Default prompt copy (canonical):**

```
You are an elite strength and performance coach having an ongoing chat with this athlete.

Speak in concrete numbers — kg, reps, hours, %, kcal, ms — and cite specific dates from the snapshot or tool results. Never approximate when a value is queryable: if you do not have the data in the snapshot or current conversation, you MUST call query_daily_logs or query_workouts before answering. Saying "around", "roughly", or "about" for any value that could be fetched is a failure.

Reply concisely (2-5 sentences for normal questions; longer only when the athlete asks for analysis). Don't restate data the athlete just gave you. Don't pad with disclaimers.

Numbers extracted from screenshots are less reliable than numbers from the query tools. When both are available, prefer the query.
```

**Settings UI** ([components/profile/ProfileForm.tsx](components/profile/ProfileForm.tsx)):

- New "Coach instructions" section, full-width textarea, ~12 rows.
- Server prefills the textarea with `profile.system_prompt ?? DEFAULT_SYSTEM_PROMPT` so the user always sees the live prompt.
- "Restore default" button (client-side onClick) replaces textarea content with `DEFAULT_SYSTEM_PROMPT`. No DB call until user clicks Save.
- Save flow: if submitted text equals `DEFAULT_SYSTEM_PROMPT` byte-for-byte → write `null` to the column (so future updates to the default propagate); else write the value.
- The default itself lives at `lib/coach/default-system-prompt.ts` exported as a `const`. Single source of truth.

**Cache invalidation guard:** the existing `cache_control` block hashes its content. Skipping NULL-when-equals-default avoids spurious invalidations from cosmetic re-saves.

### 2. Context layer

**Cached prefix — keep as-is.** [lib/coach/snapshot.ts:148-164](lib/coach/snapshot.ts#L148-L164) already builds the 14-day window. No changes to the query or shape; we just re-frame what it is in the prompt header ("Athlete snapshot — stable orientation context. Today's fresh data is in the next block.").

**Per-turn ephemeral header (new):**

A small block built at request time, separate from the cached blob. Built from a fresh query (not the snapshot's cached read) so it picks up data that landed since the cache was warmed.

```
NOW: 2026-05-06 14:32 +02:00 (Wednesday)

TODAY (2026-05-06):
  recovery=72  hrv=58  resting_hr=49  sleep_hours=7.4  sleep_score=82
  strain=null  steps=null  weight_kg=null
  protein_g=null  carbs_g=null  fat_g=null

YESTERDAY (2026-05-05):
  recovery=64  hrv=51  resting_hr=52  sleep_hours=6.8  sleep_score=74
  strain=12.3  steps=8421  weight_kg=82.1
  protein_g=178  carbs_g=240  fat_g=72

DATA FRESHNESS:
  WHOOP last sync: 4h ago (08:12 UTC)
  Withings last weight: yesterday
  Apple Health last steps: yesterday
  Yazio last entry: yesterday
```

`null` is rendered explicitly so the model never silently fills in a number.

**Freshness source — `getSyncFreshness(userId)`:** there's no dedicated `integration_state` table; instead the helper queries `daily_logs` for the most recent date with a non-null value per source-signature column:

- **WHOOP** → `max(date) where hrv is not null` (or `sleep_hours`, equivalent — pick one).
- **Withings** → `max(date) where weight_kg is not null`.
- **Apple Health** → `max(date) where steps is not null`.
- **Yazio** → `max(date) where protein_g is not null`.

This is more accurate than reading `whoop_tokens.updated_at` / `withings_tokens.updated_at`, which churn on token refresh even when no new data has landed. One indexed query per source, run in parallel.

The header is built by a new function `buildEphemeralHeader(userId, tz)` in [lib/coach/snapshot.ts](lib/coach/snapshot.ts), and inserted as the *last* user-message-content block before the new user message — so the cache prefix above it stays cacheable.

### 3. Tool layer

Two tools, defined server-side, executed via a service-role Supabase client scoped to the authenticated `user_id` from the session.

#### `query_daily_logs`

```ts
{
  name: "query_daily_logs",
  description:
    "Fetch the athlete's daily_logs for a date range. Returns one row per day in `raw` mode, or one aggregated row in `avg`/`sum`/`min`/`max` mode. Use this whenever you need numbers older than today/yesterday or outside the orientation snapshot. Respect 90-day cap in raw mode; aggregate mode is uncapped.",
  input_schema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date:   { type: "string", format: "date" },
      columns:    { type: "array", items: { type: "string", enum: ALLOWED_COLUMNS } },
      aggregate:  { type: "string", enum: ["raw", "avg", "sum", "min", "max"], default: "raw" }
    }
  }
}
```

`ALLOWED_COLUMNS` (whitelist; rejects everything else):

```
hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours,
spo2, skin_temp_c, respiratory_rate, strain,
steps, calories, active_calories, distance_km, exercise_min,
weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg,
muscle_mass_kg, bone_mass_kg, hydration_kg,
protein_g, carbs_g, fat_g, calories_eaten,
notes
```

`date` is always included implicitly. `created_at`, `updated_at`, `source`, `user_id` are not exposable.

**Caps:**

- `aggregate = "raw"` → max 90 days. Over → return error `{ error: "raw mode max 90 days; got <n>; switch to aggregate or narrow range" }`.
- `aggregate ≠ "raw"` → uncapped (the result is one row regardless of range).

**Aggregate semantics:** `avg`/`sum`/`min`/`max` ignore nulls. If a column is fully null in the range, return `null` with `{ nulls_only: true }` so the model knows.

#### `query_workouts`

```ts
{
  name: "query_workouts",
  description:
    "Fetch the athlete's strength training history. Default `granularity: summary` returns one row per workout with derived metrics (volume, top sets, e1RM). Set `granularity: sets` for set-by-set detail. `exercise_name` filters to one exercise. Always exclude warmups unless `include_warmups: true`.",
  input_schema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date:    { type: "string", format: "date" },
      end_date:      { type: "string", format: "date" },
      exercise_name: { type: "string" },
      granularity:   { type: "string", enum: ["summary", "sets"], default: "summary" },
      include_warmups: { type: "boolean", default: false }
    }
  }
}
```

`granularity` is **explicit, not auto-inferred from `exercise_name`** (per strength coach review).

**Summary response — one row per workout:**

```ts
{
  date: "2026-05-04",
  type: "Push",                              // workout.type as logged
  duration_min: 62,
  total_volume_kg: 14820,                    // server-computed, working sets only
  working_set_count: 18,
  hard_set_count: 4,                         // sets with failure=true
  top_sets_per_exercise: [
    { exercise_name: "Barbell Bench Press", category: "push",
      kg: 102.5, reps: 5, e1RM: 119.6 },
    { exercise_name: "Overhead Press", category: "push",
      kg: 67.5, reps: 6, e1RM: 81.0 },
    ...
  ]
}
```

**Sets response — one row per set:**

```ts
{
  date: "2026-05-04",
  exercise_name: "Barbell Bench Press",
  category: "push",
  set_index: 3,
  kg: 102.5,
  reps: 5,
  e1RM: 119.6,
  warmup: false,
  failure: false
}
```

**Server-computed derived fields:**

- `e1RM = kg × (1 + reps/30)` (Epley). Only computed for `reps ≤ 12`; above that → `null`.
- `total_volume_kg = sum(kg × reps)` over working sets only.
- `top_set_per_exercise` = the set with the highest `e1RM` for that exercise within that workout (ties broken by higher `kg`).
- `hard_set_count` = sets with `failure = true`. Future enhancement: RIR proxy from rep velocity, not in this release.
- `category` = `EXERCISE_CATEGORY[normalize(exercise_name)] ?? "uncategorized"`.

**Caps:**

- `granularity: "sets"` → max 60 sets per exercise, max 400 sets total. Over → return capped slice + `truncated: { matched_total: 612, returned: 400, hint: "narrow start_date or filter exercise_name" }`.
- `granularity: "summary"` → max 90 workouts. Over → same truncation pattern.

#### Exercise category lookup

New file `lib/coach/exercise-categories.ts`:

```ts
export type ExerciseCategory =
  | "push" | "pull" | "squat" | "hinge"
  | "single-leg" | "core" | "accessory" | "uncategorized";

export const EXERCISE_CATEGORY: Record<string, ExerciseCategory> = {
  // push
  "bench press": "push",
  "incline bench press": "push",
  "overhead press": "push",
  "dip": "push",
  "lateral raise": "push",
  // ... ~80 entries seeded from the actual exercise names in the user's
  //     `exercises` table (see plan task 5)
};

export function categorize(name: string): ExerciseCategory {
  const key = normalize(name); // lowercase, strip parens, collapse whitespace, drop trailing equipment notes
  return EXERCISE_CATEGORY[key] ?? "uncategorized";
}
```

Categorization rule of thumb (documented in the file):

- **push** — chest, shoulder, tricep work (incl. lateral raises, tricep isolation)
- **pull** — back/lat work, rear delts, biceps, face pulls
- **squat** — bilateral knee-dominant (back squat, front squat, leg press, hack squat, machine squat)
- **hinge** — hip-dominant (deadlift, RDL, good morning, hip thrust, glute bridge, swing)
- **single-leg** — unilateral lower (lunge, split squat, step-up, single-leg press, pistol)
- **core** — abs, obliques, anti-extension/anti-rotation
- **accessory** — calves, forearms, neck, grip, anything that doesn't cleanly fit above
- **uncategorized** — fallback; logged for adding to the table next pass

### 4. Tool execution loop

Switch the chat path from the hand-rolled streaming fetch to the official `@anthropic-ai/sdk`. The hand-rolled `lib/anthropic/client.ts` keeps `callClaude`/`streamClaude` (still used by reviews/insights paths) — only the chat route changes.

**New file** `lib/coach/chat-stream.ts`:

```ts
export async function* runChatStream(opts: {
  userId: string;
  systemPrompt: string;        // already concatenated: schema_explainer + user prompt
  messages: AnthropicMessage[];
  signal: AbortSignal;
}): AsyncGenerator<StreamEvent> { ... }
```

Wraps `client.messages.stream()` with a tool loop:

1. Call `messages.stream()` with `tools: [DAILY_LOGS_TOOL, WORKOUTS_TOOL]`.
2. Yield `text_delta` events as they arrive (passed through to the SSE channel — client sees same stream as today).
3. On `tool_use` block: buffer until `content_block_stop`, parse input JSON, execute the tool with `userId` injected, append `{role: "user", content: [{type: "tool_result", ...}]}` to messages, restart `messages.stream()`.
4. Cap at **5 tool calls per turn**. On 6th, restart with `tool_choice: { type: "none" }` to force a final text response.
5. Track every tool call into a `toolCalls: any[]` array; on `done`, persist to `chat_messages.tool_calls` jsonb column for the assistant message.

The route handler [app/api/chat/messages/route.ts](app/api/chat/messages/route.ts) calls `runChatStream` instead of `streamClaude`. Public SSE event shape (`delta` / `done` / `error`) stays the same — client `/coach` page needs no changes.

### 5. Anti-approximation enforcement

Prompt-only, three reinforcing lines:

1. **The default prompt's "MUST call... is a failure" sentence** (above).
2. **Tool descriptions reinforce it** — "Use this whenever you need numbers older than today/yesterday or outside the orientation snapshot."
3. **Schema explainer notes the limit** — "If you cannot find a value in the snapshot or ephemeral header, the only correct action is to call query_daily_logs or query_workouts. Do not estimate."

No output post-processing. We rely on observability (next section) to verify it works in practice.

### 6. Observability

`chat_messages.tool_calls jsonb` column, populated by the tool loop:

```jsonb
[
  { "name": "query_daily_logs", "input": {...}, "ms": 38, "result_rows": 14 },
  { "name": "query_workouts",  "input": {...}, "ms": 62, "result_rows": 9 }
]
```

This unblocks two operations:

- **Sanity check** — over time, are any-tool-call assistant messages decreasing? That would imply the model is back to estimating. Query: `select date_trunc('day', created_at), count(*) filter (where tool_calls is not null) / count(*)::float from chat_messages where role='assistant' group by 1 order by 1`.
- **Promotion candidates** — if `query_daily_logs(this_week)` is called >50% of turns, fold it into the cached prefix.

No UI for this in v1; a SQL query when the question comes up is enough.

## Data flow

```
POST /api/chat/messages
  → load profile (incl. system_prompt)
  → buildSnapshotText()                       [cached, 14d]
  → buildEphemeralHeader(userId, tz)          [fresh query: today + yesterday + freshness]
  → systemPrompt = SCHEMA_EXPLAINER + (profile.system_prompt ?? DEFAULT)
  → runChatStream({ userId, systemPrompt, messages, signal })
       → messages.stream({ tools, system, messages: [snapshot+header+history+new] })
       → on tool_use: execute(toolName, input, { userId, sr })
       → append tool_result, restart stream
       → cap at 5 tool calls, then tool_choice: none
       → yield text deltas → SSE → client
  → on done: persist assistant text + tool_calls jsonb
```

## Schema migration

`supabase/migrations/0006_chat_settings.sql`:

```sql
alter table public.profiles
  add column if not exists system_prompt text;

alter table public.chat_messages
  add column if not exists tool_calls jsonb;

comment on column public.profiles.system_prompt is
  'User-edited coach prompt. NULL = use code default.';
comment on column public.chat_messages.tool_calls is
  'Array of tool calls executed for this assistant message: [{name, input, ms, result_rows}]. NULL on user messages or assistant messages with no tool use.';
```

Mirror in [lib/data/types.ts](lib/data/types.ts).

Apply via `supabase db push`.

## Files affected

**New:**

- `supabase/migrations/0006_chat_settings.sql` — column adds.
- `lib/coach/default-system-prompt.ts` — exports `DEFAULT_SYSTEM_PROMPT`, `SCHEMA_EXPLAINER` constants.
- `lib/coach/chat-stream.ts` — tool-aware streaming wrapper around `@anthropic-ai/sdk`.
- `lib/coach/tools.ts` — tool definitions + executors for `query_daily_logs`, `query_workouts`.
- `lib/coach/exercise-categories.ts` — 7-bucket lookup table + `categorize()`.
- `lib/coach/derived.ts` — pure helpers: `epley(kg, reps)`, `topSet(sets)`, `workingVolume(sets)`.

**Modified:**

- `app/api/chat/messages/route.ts` — replace inline `SYSTEM_PROMPT`, call `buildEphemeralHeader`, switch streaming to `runChatStream`, persist `tool_calls`.
- `lib/coach/snapshot.ts` — add `buildEphemeralHeader` next to existing `buildSnapshotText`. Add `getSyncFreshness` helper.
- `components/profile/ProfileForm.tsx` — add Coach Instructions textarea + Restore Default button.
- `app/profile/actions.ts` — extract `system_prompt`, NULL-when-equals-default check.
- `app/profile/page.tsx` — pass current value (or default) into form.
- `lib/data/types.ts` — add `system_prompt` to Profile, `tool_calls` to ChatMessage.
- `package.json` — add `@anthropic-ai/sdk` if not already a dep.

**Untouched:**

- `lib/anthropic/client.ts` — stays as-is for review/insights paths.
- `lib/coach/{readiness,impact,week,sessionPlans,prompts}.ts` — unrelated.
- `app/coach/page.tsx` — public SSE contract unchanged.

## Testing strategy

No automated test harness in this repo. Manual verification, after each task in the implementation plan:

1. **Migration applies cleanly** — `supabase db push` succeeds; columns visible.
2. **Settings round-trip** — open `/profile`, verify default prompt appears, edit + save, reload, verify persistence; click Restore Default + Save, verify column = NULL in DB.
3. **Snapshot + ephemeral header** — chat about today's recovery, confirm reply uses today's actual number from the freshness block (not from cached snapshot).
4. **`query_daily_logs` tool fire** — ask "what was my hrv 30 days ago?" — confirm via `chat_messages.tool_calls` that `query_daily_logs` was called with the right range.
5. **`query_workouts` summary** — ask "how many lifts last month?" — confirm summary granularity, correct count.
6. **`query_workouts` sets** — ask "show me my last five bench sets" — confirm sets granularity, e1RM in response.
7. **Cap enforcement** — manually craft a `start_date` 200 days back in raw mode — confirm tool returns the cap-error string.
8. **5-call cap** — spam multi-tool questions; confirm loop exits after 5.
9. **No-approximation regression** — ask 10 questions across known historical dates; verify no "around"/"roughly" in replies for queryable values.
10. **Observability** — `select tool_calls from chat_messages where role='assistant' order by created_at desc limit 20` shows reasonable distribution.

## Risks / open considerations

- **e1RM beyond 12 reps** is unreliable. We return `null` rather than a degraded estimate, but this means the model has to reason without it on high-rep work. Acceptable — most strength questions live in 1-12 rep zone; high-rep volume work is better answered by `total_volume_kg` anyway.
- **`uncategorized` fallback** — first time a new exercise is logged, it shows up uncategorized. The implementation plan should include a one-time seed step: query distinct `exercises.name` values from the existing DB and pre-populate `EXERCISE_CATEGORY` so the table covers everything currently logged. Going forward: monitor `tool_calls` for `category: "uncategorized"` results and append to the lookup.
- **Tool latency** — 5 round-trips × ~1-2s each = up to 10s before final stream starts. The cap is the right escape hatch but the typical case (1-2 calls) should still feel responsive. Streaming the model's text-thinking between calls would help; the SDK supports it. Confirm in implementation.
- **System prompt drift** — if the canonical default changes in code and the user has saved a custom one, they don't get the update. Acceptable for n=1 (you can manually click Restore Default after a deploy if you want).
- **Image OCR re-introducing approximation** — covered by the "prefer query when both are available" line in the default prompt, but there's no mechanism to enforce it. Watch for it in practice.
- **`@anthropic-ai/sdk` dependency** — adds a real dep where there was none. Worth it for tool-delta accumulation; reconsider if it bloats the bundle materially (it shouldn't — server-only, tree-shakable).

## Out of scope (explicit)

- Per-muscle volume rollups (chest/quads/etc. with secondary-mover weighting) — phase 2 if needed.
- RIR proxy via rep velocity — needs more data than we have.
- Programmatic exercise classification (LLM-based) — hardcoded table is faster, more predictable, easier to audit.
- Output post-processing for hedging language.
- Migration to Sonnet 4.6/4.7.
- Multi-user / shareable prompts.
- Versioned prompt history / undo.
