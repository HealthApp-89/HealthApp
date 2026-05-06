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

1. **Cached prefix** — stable across turns for ~14 days. Profile, baselines, training plan, last 14 days of `daily_logs`, last 5 workout summaries. Same as today. Marked `cache_control: ephemeral, ttl: 1h`.
2. **Per-turn ephemeral header** — re-queried at request time. Today + yesterday rows (fresh, not from cache), data-freshness line, `NOW` timestamp. Not cached.
3. **Tool layer** — Claude calls `query_daily_logs` or `query_workouts` when it needs anything else. Server enforces user scoping, column allowlist, range caps, and a 5-invocation-per-turn cap.

The system prompt has two parts concatenated server-side:

- **Schema explainer** — non-editable, lives next to `buildSnapshot()`. Documents column names, units, the meaning of "today/yesterday", the tool contracts, the `uncategorized` and `hard_set_count` caveats. Plumbing, not personality.
- **User prompt** — editable, stored at `profiles.system_prompt`. Coaching style, tone, the no-approximation rule. Defaults to a canonical string when `NULL`.

### Cache breakpoint layout

Two `cache_control` breakpoints, intentionally placed:

```
[system]
  SCHEMA_EXPLAINER (server-owned)
  + (profile.system_prompt ?? DEFAULT_SYSTEM_PROMPT)
  ── cache_control: ephemeral, ttl: 1h ──        (breakpoint #1, system)

[messages]
  cached_prefix block          (14d snapshot)
  ── cache_control: ephemeral, ttl: 1h ──        (breakpoint #2, message)
  ephemeral_header block       (today + yesterday + freshness — NOT cached)
  ...prior conversation turns + tool_use/tool_result chain...
  current user message
```

Tool-loop caching: each tool round-trip re-sends everything above. Without breakpoint #2 the entire conversation history is reprocessed every round (5 rounds × ~30K tokens = real money). With it, every round still gets a hit on the snapshot and conversation history; only the latest user message + accumulated `tool_result` blocks are uncached, which is what we want.

A future optimization is to add a third breakpoint after the most recent `tool_result` so within a single multi-round turn, prior rounds also cache. Anthropic permits up to 4 breakpoints; defer until tool-loop costs warrant it.

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
- Server prefills the textarea with `profile.system_prompt ?? DEFAULT_SYSTEM_PROMPT` so the user always sees the live prompt — including the case where the `profiles` row itself doesn't exist (new account flow). Both `app/profile/page.tsx` (load) and `app/profile/actions.ts` (save) must handle the no-row case explicitly; `saveProfile` already uses `upsert`, but the page-load query needs `.maybeSingle()` plus a fallback to `DEFAULT_SYSTEM_PROMPT`.
- "Restore default" button (client-side onClick) replaces textarea content with `DEFAULT_SYSTEM_PROMPT`. No DB call until user clicks Save.
- Save flow: normalize submitted text (`s.replace(/\r\n/g, "\n").trim()`) and the canonical default the same way. If they match → write `null` to the column so future code-side updates to the default still take effect; else write the normalized value. Byte-for-byte equality is wrong here — pasted-from-clipboard text often round-trips through `\r\n` or trailing-newline drift, which silently disables the NULL guard.
- The default and the schema explainer both live at `lib/coach/system-prompts.ts` exported as `DEFAULT_SYSTEM_PROMPT` and `SCHEMA_EXPLAINER` constants. Single source of truth. Only `DEFAULT_SYSTEM_PROMPT` participates in the NULL-equality check.

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
  WHOOP last write: 6h 18m ago (today)
  Withings last weight: 18h 42m ago (yesterday)
  Apple Health last steps: 21h 03m ago (yesterday)
  Yazio last entry: 22h 51m ago (yesterday)
```

`null` is rendered explicitly so the model never silently fills in a number.

**Freshness source — `getSyncFreshness(userId)`:** there's no dedicated `integration_state` table; instead the helper queries `daily_logs.updated_at` for the most recent row where each source's signature column is non-null. Hours-ago precision (rendered as `Nh Mm ago (today|yesterday|N days ago)`) so the model can tell the difference between data that landed an hour ago and data that landed last night:

```sql
-- one query per source, run in parallel via Promise.all
select updated_at
from daily_logs
where user_id = $1 and hrv is not null      -- WHOOP signature
order by date desc nulls last
limit 1;
```

Source-signature columns:

- **WHOOP** → row with non-null `hrv` (most reliable signature; `sleep_hours` and `recovery` are equivalent).
- **Withings** → row with non-null `weight_kg`.
- **Apple Health** → row with non-null `steps`.
- **Yazio** → row with non-null `protein_g`.

Returning `updated_at` rather than `date` matters because a daily row is partially populated over time — WHOOP arrives ~08:00 UTC, Withings event-driven, Apple Health on the user's manual cadence. Date-granularity hides which source is stale and which just arrived. Reading `whoop_tokens.updated_at` is rejected: it churns on token refresh even when no new data has landed.

The header is built by a new function `buildEphemeralHeader(userId, tz)` in [lib/coach/snapshot.ts](lib/coach/snapshot.ts), and inserted as the *last* user-message-content block before the new user message — so the cache prefix above it stays cacheable.

### 3. Tool layer

Two tools, defined server-side, executed via a service-role Supabase client scoped to the authenticated `user_id` from the session.

**Security invariants — load-bearing, must hold for every executor:**

1. Tool input schemas **never** include `user_id`. The model cannot pass it; the route injects it from `supabase.auth.getUser()`.
2. Every executor's underlying query MUST `.eq("user_id", userId)`, even though the service-role client bypasses RLS — this is the actual scoping mechanism for tools, not RLS.
3. `columns` and `granularity` and `aggregate` inputs are validated against closed enums (`ALLOWED_COLUMNS`, etc.) **before** the query is constructed. Rejected input → tool returns `{ error: "..." }` as `tool_result` with `is_error: true`.
4. `start_date` / `end_date` are parsed with `new Date(...)` and re-formatted to `YYYY-MM-DD` before going into a query — never interpolated raw.
5. Range caps are enforced before the query runs, not after.

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
hrv, resting_hr, recovery,
sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours,
spo2, skin_temp_c, respiratory_rate, strain,
steps, calories, active_calories, distance_km, exercise_min,
weight_kg, body_fat_pct,
fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg, hydration_kg,
protein_g, carbs_g, fat_g, calories_eaten,
notes
```

Cross-checked against [lib/data/types.ts](lib/data/types.ts) `DailyLog` and [supabase/schema.sql](supabase/schema.sql) + later migrations. `date` is always included implicitly. `created_at`, `updated_at`, `source`, `user_id` are not exposable.

**Caps:**

- `aggregate = "raw"` → max 90 days. Over → return `{ error: "raw mode max 90 days; got <n>; switch to aggregate or narrow range" }` as `tool_result` with `is_error: true`.
- `aggregate ≠ "raw"` → uncapped (the result is one row regardless of range).

**Aggregate semantics:** `avg`/`sum`/`min`/`max` ignore nulls (Postgres default). The response **must** carry per-column null-coverage so the model can tell a real total from a partial one. Shape:

```ts
{
  range: { start_date, end_date, days: 30 },
  values: { protein_g: 4360, calories: 58200, hrv: 56.2, ... },
  non_null_count: { protein_g: 22, calories: 28, hrv: 30, ... },
  null_count: { protein_g: 8, calories: 2, hrv: 0, ... }
}
```

Without `non_null_count`, `sum(protein_g)` over a month with 8 untracked days silently looks like a complete month total. The model should mention sparse coverage when `null_count > 0`. The schema explainer reinforces this rule.

#### `query_workouts`

```ts
{
  name: "query_workouts",
  description:
    "Fetch the athlete's strength training history. `granularity: 'summary'` returns one row per workout with derived metrics (volume, top sets, e1RM); `granularity: 'sets'` returns set-by-set detail; `granularity: 'by_week'` and `'by_month'` return per-period rollups (volume + per-category set counts). `exercise_name` filters to one exercise. Warmup sets are always excluded.",
  input_schema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date:    { type: "string", format: "date" },
      end_date:      { type: "string", format: "date" },
      exercise_name: { type: "string" },
      granularity:   {
        type: "string",
        enum: ["summary", "sets", "by_week", "by_month"],
        default: "summary"
      }
    }
  }
}
```

`granularity` is **explicit, not auto-inferred from `exercise_name`** (per strength coach review). `include_warmups` was considered and dropped: warmup sets are flagged with `warmup: true` in `exercise_sets`; volume / e1RM / top-set / hard-set counts always exclude them. There is no current use case for surfacing warmups in the tool output. If one emerges, add the flag back as a follow-up.

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
// load-bearing: kg+reps (most sets) and duration_seconds (planks/holds/carries) are
// mutually exclusive. Always emit all four fields; consumer reads by shape.
{
  date: "2026-05-04",
  exercise_name: "Barbell Bench Press",
  category: "push",
  set_index: 3,
  kg: 102.5,                   // null for duration-based sets
  reps: 5,                     // null for duration-based sets
  duration_seconds: null,      // populated for planks/holds/carries
  e1RM: 119.6,                 // null when kg/reps null OR reps > 12
  failure: false
}
```

For duration-based sets (e.g. plank, farmer's carry, dead hang) the row carries `duration_seconds` instead of `kg`/`reps`; `e1RM` is `null` for these — there is no rep-based 1RM equivalent.

**By-week / by-month response — one row per period:**

```ts
{
  period_start: "2026-04-27",       // Monday of week, or first of month
  period_end:   "2026-05-03",
  workout_count: 4,
  total_volume_kg: 48230,            // sum across all working sets in period
  set_counts_by_category: {
    push: 22, pull: 18, squat: 0, hinge: 6,
    "single-leg": 0, core: 4, accessory: 8, uncategorized: 0
  },
  top_set_per_exercise: [             // best set in the period across the included exercises
    { exercise_name, category, kg, reps, e1RM, date }
  ]
}
```

This mode is uncapped (one row per week/month is naturally bounded). It's the mode the model should reach for on "show me last year of training" / "monthly volume trend" type questions.

**Server-computed derived fields (apply across all granularities):**

- `e1RM = kg × (1 + reps/30)` (Epley). Computed only when `kg != null AND reps != null AND reps <= 12`; otherwise `null`.
- `total_volume_kg = sum(kg × reps)` over working sets only (warmups excluded). Duration-based sets contribute zero.
- `top_set_per_exercise` = the set with the highest `e1RM` for that exercise within that workout (ties broken by higher `kg`). For duration-based exercises with no `e1RM`, fall back to the longest `duration_seconds`.
- `hard_set_count` = sets with `failure = true`. **Sparse data** — manually flagged in Strong, often unset; the schema explainer warns the model not to infer training intensity from this alone.
- `category` = `EXERCISE_CATEGORY[normalize(exercise_name)] ?? "uncategorized"`.

**Caps:**

- `granularity: "sets"` → max 60 sets per exercise, max 400 sets total. Over → return capped slice + `truncated: { matched_total: 612, returned: 400, hint: "narrow start_date or filter exercise_name" }`.
- `granularity: "summary"` → max 90 workouts. Over → same truncation pattern + hint to switch to `by_week`/`by_month`.
- `granularity: "by_week" | "by_month"` → uncapped.

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
  return EXERCISE_CATEGORY[normalize(name)] ?? "uncategorized";
}

// Defined precisely so it doesn't drift:
//   1. lowercase
//   2. strip parenthesized segments (typically equipment: "(Barbell)", "(Cable)", "(Machine)")
//   3. collapse whitespace
//   4. trim
// Lookup-only normalization — `top_set_per_exercise` and `sets` rows always emit
// the *original* `exercise_name`, never the normalized key. Otherwise barbell-bench
// and dumbbell-bench would collide in summaries.
export function normalize(s: string): string {
  return s.toLowerCase()
          .replace(/\s*\(.*?\)\s*/g, " ")
          .replace(/\s+/g, " ")
          .trim();
}
```

**Seeding the table** — operationalized in the implementation plan as a one-shot bootstrap:

1. Implementation runs `select distinct lower(name) as name from exercises where workout_id in (select id from workouts where user_id = $1) order by 1` against the user's actual data.
2. The agent generates the TS literal mapping every distinct exercise to one of the 7 buckets, applying the rules below.
3. The user audits the generated literal as a single review step before merging.

This avoids hand-writing 80 entries blindly and ensures coverage matches what's actually been logged.

Categorization rule of thumb (documented in the file):

- **push** — chest, shoulder, tricep work (incl. lateral raises, tricep isolation)
- **pull** — back/lat work, rear delts, biceps, face pulls
- **squat** — bilateral knee-dominant (back squat, front squat, leg press, hack squat, machine squat)
- **hinge** — hip-dominant (deadlift, RDL, good morning, hip thrust, glute bridge, swing)
- **single-leg** — unilateral lower (lunge, split squat, step-up, single-leg press, pistol)
- **core** — abs, obliques, anti-extension/anti-rotation
- **accessory** — calves, forearms, neck, grip, anything that doesn't cleanly fit above
- **uncategorized** — fallback; logged for adding to the table next pass

#### Tool error surfacing

Errors from a tool executor (Supabase 500, validation rejection from the security invariants, range-cap exceeded) are returned as `tool_result` content with `is_error: true` and a JSON body `{ "error": "<short reason>", "hint?: "..." }`. The model sees these and can retry with adjusted parameters or apologize concretely ("I tried to fetch 200 days at raw granularity but the cap is 90; let me retry with a monthly aggregate").

The SSE stream only emits a top-level `error` event when the **Anthropic call itself** fails (network, 5xx, abort). Tool execution failures are part of the conversation, not a turn-level abort.

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

1. Call `messages.stream()` with `tools: [DAILY_LOGS_TOOL, WORKOUTS_TOOL]` and `disable_parallel_tool_use: true`. Serial loop — keeps reasoning auditable, avoids race conditions on the service-role client, simplifies the cap.
2. Yield text deltas as `delta` events on the SSE channel (matches today's wire shape — see "SSE protocol additions" below).
3. On `tool_use` block: buffer `input_json_delta` events until `content_block_stop`, parse the assembled JSON, validate against the security invariants, execute the tool with `userId` injected, append `{role: "user", content: [{type: "tool_result", tool_use_id, content, is_error?}]}` to messages, then restart `messages.stream()` with the new messages array.
4. **Cap at 5 individual tool invocations per turn** (not 5 round-trips — `disable_parallel_tool_use` makes them the same number, but the cap is on invocations to be unambiguous). On the 6th attempt, the loop restarts with `tool_choice: { type: "none" }` to force a final text-only response.
5. Track every tool call into a `toolCalls: ToolCallLog[]` array. **Persist in the existing `finally` block** at the end of the route ([app/api/chat/messages/route.ts:346-356](app/api/chat/messages/route.ts#L346-L356)) alongside `content`/`status`/`error`, so partial failures and client aborts still record what was attempted. Persisting only on `done` would lose the diagnostic record on every error path — the opposite of what observability is for.

#### SSE protocol additions

The current SSE event union ([lib/chat/sse.ts:14-16](lib/chat/sse.ts#L14-L16), [lib/chat/types.ts:33-35](lib/chat/types.ts#L33-L35)) is `delta | done | error`. The tool loop introduces dead air during tool execution that the client today renders as a continuing typing indicator — which is a small lie. Add two events to the protocol now, even if the UI defers consuming them, so we don't have a breaking SSE change later:

- `tool_call_start` → `{ name: string; input: object; id: string }`
- `tool_call_done`  → `{ id: string; ok: boolean; ms: number }`

The route emits these around each tool execution. The client SSE parser ([components/chat/sseClient.ts](components/chat/sseClient.ts)) and consumer ([components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx)) initially ignore them — no UI change in v1. UI affordance ("checking your training history…") is a follow-up; defining the protocol now is cheap-now/expensive-later.

The route handler [app/api/chat/messages/route.ts](app/api/chat/messages/route.ts) calls `runChatStream` instead of `streamClaude`.

### 5. Anti-approximation enforcement

Prompt-only, multiple reinforcing places:

1. **The default prompt's "MUST call... is a failure" sentence** (above).
2. **Tool descriptions reinforce it** — "Use this whenever you need numbers older than today/yesterday or outside the orientation snapshot."
3. **Schema explainer notes the limit** — "If you cannot find a value in the snapshot or ephemeral header, the only correct action is to call query_daily_logs or query_workouts. Do not estimate."
4. **Schema explainer warns about derived-data caveats** so the model doesn't lie based on noisy fields:
   - `category: "uncategorized"` is a **missing-data flag, not a category** — when filtering or rolling up by category, exclude or report these separately. Do not infer the category.
   - `hard_set_count` counts only sets manually flagged `failure: true` in Strong. It's **sparse, often unset** — do not infer training intensity from it alone; pair with rep counts, top-set e1RM, and athlete self-report.
   - Aggregate `non_null_count` is the truth about coverage. If `non_null_count < days_in_range`, mention the gap rather than presenting the aggregate as a complete total.
   - Numbers extracted from screenshots are less reliable than tool-fetched numbers; prefer the tool when both are available.

No output post-processing. We rely on observability (next section) to verify it works in practice.

### 6. Observability

`chat_messages.tool_calls jsonb` column, populated by the tool loop. Persisted in the `finally` block alongside `content`/`status`/`error` so partial failures and aborts still record diagnostics.

```jsonb
[
  {
    "name": "query_daily_logs",
    "input": { "start_date": "2026-04-06", "end_date": "2026-05-06", "aggregate": "avg" },
    "ms": 38,
    "result_rows": 1,
    "range_days": 30,
    "truncated": false,
    "error": null
  },
  {
    "name": "query_workouts",
    "input": { "start_date": "2026-01-01", "end_date": "2026-05-06", "granularity": "by_week" },
    "ms": 62,
    "result_rows": 18,
    "range_days": 125,
    "truncated": false,
    "error": null
  }
]
```

`truncated`, `range_days`, and `error` are diagnostic fields the model never sees — they're for the human inspecting the row later.

The column is useful for ad-hoc inspection — was the model fetching when it should have, what was the slowest tool call last week, how often did `range_days` exceed 90 (suggesting we under-sized the snapshot). No UI in v1, a SQL query when the question comes up is enough.

## Data flow

```
POST /api/chat/messages
  → auth → userId
  → load profile via .maybeSingle() (incl. system_prompt — may be null or row missing)
  → buildSnapshotText()                       [reuses today's cached snapshot, 14d]
  → buildEphemeralHeader(userId, tz)          [fresh query: today + yesterday + freshness]
  → systemPrompt = SCHEMA_EXPLAINER + (profile?.system_prompt ?? DEFAULT_SYSTEM_PROMPT)
  → runChatStream({ userId, systemPrompt, messages, signal })
       messages composed as:
           [{ role:'user', content:[
               { type:'text', text: snapshot,           cache_control:{ type:'ephemeral', ttl:'1h' } },
               { type:'text', text: ephemeralHeader  }, // not cached
               ...history,
               { type:'text', text: newUserContent   }
             ]}]
       → messages.stream({ tools, tool_choice:'auto', disable_parallel_tool_use:true,
                           system: systemPrompt, messages })
       → emit SSE 'delta' for text, 'tool_call_start'/'tool_call_done' around each tool exec
       → on tool_use:
            validate(input)
            execute(toolName, input, { userId, sr })   // is_error tool_result on failure
            append { role:'user', content:[{type:'tool_result', ...}] }
            restart messages.stream(...) (new round-trip; cache prefix still hits)
       → cap at 5 invocations; on 6th, restart with tool_choice:'none'
       → yield text deltas → SSE → client
  → finally: persist accumulated text + tool_calls jsonb (success OR error OR abort)
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
  'Array of tool calls executed for this assistant message: [{name, input, ms, result_rows, range_days, truncated, error}]. NULL on user messages or assistant messages with no tool use.';
```

Mirror in [lib/data/types.ts](lib/data/types.ts).

**Apply path — Supabase Dashboard → SQL Editor**, matching the convention used for migrations 0002–0005 (per CLAUDE.md). The `supabase` CLI link state lives in `~/.supabase/` (not the repo) and migrations 0002–0005 were applied via the Dashboard, so a fresh `supabase db push` would either fail on un-linked state or churn on stale local migration history. Save the CLI integration for a follow-up clean-up; for this migration, paste the SQL into the Dashboard.

## Files affected

**New:**

- `supabase/migrations/0006_chat_settings.sql` — column adds.
- `lib/coach/system-prompts.ts` — exports `DEFAULT_SYSTEM_PROMPT` and `SCHEMA_EXPLAINER` constants. Single source of truth.
- `lib/coach/chat-stream.ts` — tool-aware streaming wrapper around `@anthropic-ai/sdk`.
- `lib/coach/tools.ts` — tool definitions + executors for `query_daily_logs`, `query_workouts`. Enforces security invariants (§3) before every query.
- `lib/coach/exercise-categories.ts` — 7-bucket lookup table + `categorize()` + `normalize()`.
- `lib/coach/derived.ts` — pure helpers: `epley(kg, reps)`, `topSet(sets)`, `workingVolume(sets)`, `weeklyBuckets(sets, range)`, `monthlyBuckets(sets, range)`.

**Modified:**

- `app/api/chat/messages/route.ts` — replace inline `SYSTEM_PROMPT`, call `buildEphemeralHeader`, switch streaming to `runChatStream`, persist `tool_calls` in the `finally` block.
- `lib/coach/snapshot.ts` — add `buildEphemeralHeader` next to existing `buildSnapshotText`. Add `getSyncFreshness` helper (returns `{ source, last_write_at, last_write_label }` per source).
- `lib/chat/types.ts` + `lib/chat/sse.ts` — extend `ChatStreamEvent` union with `tool_call_start` / `tool_call_done` variants and add corresponding parser/formatter cases.
- `components/chat/sseClient.ts` — accept the new event types in the parser (no-op handlers in v1).
- `components/profile/ProfileForm.tsx` — add Coach Instructions textarea + Restore Default button.
- `app/profile/actions.ts` — extract `system_prompt`, normalize then NULL-when-equals-default check.
- `app/profile/page.tsx` — load `system_prompt` via `.maybeSingle()`, fall back to `DEFAULT_SYSTEM_PROMPT` when row missing or column null.
- `lib/data/types.ts` — add `system_prompt` to Profile, `tool_calls` to ChatMessage.
- `package.json` — add `@anthropic-ai/sdk` if not already a dep.

**Untouched:**

- `lib/anthropic/client.ts` — stays as-is for review/insights paths.
- `lib/coach/{readiness,impact,week,sessionPlans,prompts}.ts` — unrelated.
- `app/coach/page.tsx` and `components/chat/ChatPanel.tsx` — public SSE contract unchanged for `delta`/`done`/`error`; new event types ignored in v1.

## Testing strategy

No automated test harness in this repo. Manual verification, after each task in the implementation plan:

1. **Migration applies cleanly** — paste `0006_chat_settings.sql` into Supabase Dashboard SQL Editor, run, confirm both columns visible in `profiles` and `chat_messages`.
2. **Settings round-trip — happy path** — open `/profile`, verify default prompt appears in textarea, edit + save, reload, verify persistence.
3. **Settings round-trip — Restore Default** — click Restore Default, save unchanged, query DB and confirm `system_prompt IS NULL`.
4. **Settings round-trip — line-ending drift** — paste the default with `\r\n` line endings (e.g. via a Windows clipboard simulation), save, confirm column is `NULL` (normalization holds).
5. **No profile row** — DELETE from `profiles WHERE user_id = ...`, reload `/profile`, confirm form renders with default; save, confirm `INSERT` happens cleanly.
6. **Snapshot + ephemeral header** — chat about today's recovery, confirm reply cites today's actual number from the freshness block (not from cached snapshot). Confirm freshness line shows hours-ago precision.
7. **`query_daily_logs` raw fire** — ask "what was my hrv 30 days ago?" — confirm via `chat_messages.tool_calls` that `query_daily_logs` was called with the right range.
8. **`query_daily_logs` aggregate with sparse data** — ask "average protein over last 30 days" — confirm response includes `non_null_count` and the model's reply mentions sparse coverage if any.
9. **`query_workouts` summary** — ask "how many lifts last month?" — confirm summary granularity, correct count.
10. **`query_workouts` sets** — ask "show me my last five bench sets" — confirm sets granularity, e1RM in response, original `exercise_name` (not normalized).
11. **`query_workouts` by_week** — ask "show me weekly volume the last 3 months" — confirm by_week granularity, per-category set counts, no truncation.
12. **`query_workouts` duration-based** — ask about plank or carry history — confirm `duration_seconds` populated, `kg`/`reps`/`e1RM` null.
13. **Range cap enforcement** — manually craft a `start_date` 200 days back in raw mode (force via debug message) — confirm tool returns `is_error: true` `tool_result` and the model retries with aggregate or narrower range, instead of failing the turn.
14. **5-invocation cap** — ask a question that would chain many lookups; confirm loop exits after 5 with a final text response.
15. **Tool-error recovery** — temporarily break a tool (e.g. throw inside the executor); confirm SSE does NOT emit `error`, the model receives `is_error: true` content, and either retries or apologizes concretely.
16. **Persistence on abort** — start a chat that triggers tool calls, abort the request mid-stream; confirm `chat_messages.tool_calls` still has the rows attempted before the abort.
17. **Cache hit on second turn** — send a turn, send another short turn ~30s later; confirm Anthropic response shows `cache_read_input_tokens > 0` for the snapshot prefix block (use route-side logging to verify).
18. **Security invariants** — attempt a tool call (via debug message) that includes `user_id` in `input` (sanity test that the executor ignores it / rejects the schema). Confirm `.eq("user_id", userId)` from session is what scopes the result.
19. **No-approximation regression** — ask 10 questions across known historical dates; verify no "around"/"roughly" in replies for queryable values.
20. **Observability** — `select tool_calls from chat_messages where role='assistant' order by created_at desc limit 20` shows reasonable distribution and includes `truncated`/`range_days`/`error` fields.

## Risks / open considerations

- **e1RM beyond 12 reps** is unreliable. We return `null` rather than a degraded estimate, but this means the model has to reason without it on high-rep work. Acceptable — most strength questions live in 1-12 rep zone; high-rep volume work is better answered by `total_volume_kg` anyway.
- **`uncategorized` fallback** — first time a new exercise is logged, it shows up uncategorized. The implementation plan includes the one-time seed (see "Seeding the table" above): query distinct `exercises.name` values, generate the literal, user audits before merge. Going forward: monitor `tool_calls` for category-uncategorized results and append to the lookup.
- **Tool latency** — 5 round-trips × ~1-2s each = up to 10s before final stream starts. The cap is the right escape hatch but the typical case (1-2 calls) should still feel responsive. The SDK streams model text between tool calls (no extra plumbing required) which masks some of it. Watch for runaways and lower the cap to 3 if observability shows the model burning through 5+ on simple questions.
- **Cache hit on tool rounds is partial.** Breakpoint #1 (system) and #2 (snapshot prefix) cache across the entire turn including tool rounds. The conversation history + accumulated tool_use/tool_result chain inside a single turn is **not** cached. Acceptable for now; if tool-loop costs become noticeable, add a third breakpoint at the latest tool_result block. Anthropic supports up to 4 breakpoints.
- **System prompt drift** — if the canonical default changes in code and the user has saved a customized prompt that differs, they don't get the update. Click Restore Default after a deploy to refresh, or `update profiles set system_prompt = null where user_id = ...` from SQL. Acceptable for n=1.
- **Image OCR re-introducing approximation** — covered by the "prefer query when both are available" line in the default prompt, but there's no mechanism to enforce it. Watch for it in practice.
- **`@anthropic-ai/sdk` dependency** — adds a real dep where there was none. Worth it for tool-delta accumulation; reconsider if it bloats the bundle materially (it shouldn't — server-only, tree-shakable).
- **Schema-explainer drift.** If a column meaning changes (e.g. the source-of-truth rule for `steps`), the explainer must be updated alongside the code or the model will explain the wrong thing in chat. Add a comment in `lib/coach/system-prompts.ts` cross-referencing CLAUDE.md's "Data sources & precedence" section.

## Out of scope (explicit)

- Per-muscle volume rollups (chest/quads/etc. with secondary-mover weighting) — phase 2 if needed.
- RIR proxy via rep velocity — needs more data than we have.
- Programmatic exercise classification (LLM-based) — hardcoded table is faster, more predictable, easier to audit.
- Output post-processing for hedging language.
- Migration to Sonnet 4.6/4.7.
- Multi-user / shareable prompts.
- Versioned prompt history / undo.
