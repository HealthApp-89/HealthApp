# Multi-coach Team Architecture — Design

**Date:** 2026-05-19
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #2 of the "coach team" arc. Builds on sub-project #1 (in-app food logging, shipped 2026-05-18), which lands the rich item-level nutrition data that the Nutrition specialist needs to give meaningful food-choice advice. Restructures the existing single-coach surface (`lib/coach/`) into a 4-coach team led by a Head Coach.

## Problem

The coach today is a single AI persona: an "elite strength and performance coach" defined by `DEFAULT_SYSTEM_PROMPT` in [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts). One prompt, one voice, one Claude call per chat turn. It works, but it has three structural limitations:

1. **The single voice flattens expertise.** Strength programming, nutrition science, and recovery physiology each have their own vocabulary, conventions, and analytical frames. A one-prompt generalist hedges — it can't go deep on RPE/RIR nuance, food-choice trade-offs, or HRV interpretation without inflating the prompt to a point where it loses focus on the user's immediate question.
2. **Tool access is unscoped.** Every tool is exposed to every turn. The model can reach for `query_food_log` mid-strength-discussion and confuse itself, or pull `query_workouts` while answering a recovery question and over-anchor on training volume. Tool partitioning by specialty would give each call a smaller, more focused context.
3. **There's no explicit head-coach role.** Cross-domain synthesis (weekly review, block progression, "should I push hard today?") and within-domain depth are done by the same prompt. A real coaching team has a head coach who owns the holistic picture and specialists who own depth in their lane. The current code structure has the specialist composers (`compose-strength.ts`, `compose-nutrition.ts`, `compose-recovery.ts` in trends; same in weekly review) — but the AI narrator is a single voice that doesn't reflect the specialist split that's already implicit in the deterministic layer.

This spec restructures the coach layer into a 4-coach team:

- **Peter** — Head Coach. Default chat agent and router. Owns all cross-domain surfaces (morning brief narrative, weekly review narrative, proactive nudges synthesis, block progression, plan builder narrative). Named after Peter Attia (longevity + performance medicine) — the head-coach archetype.
- **Coach Carter** — Strength specialist. Existing brand. Owns within-week training plan execution, exercise programming, autoregulation. Restricted to strength/workout tools.
- **Nora** — Nutrition specialist. Owns food-choice advice, macro distribution, GLP-1-aware nutrition, micronutrient analysis. Restricted to nutrition tools (the new `query_food_log` from sub-project #1 is hers).
- **Remi** — Recovery / Sleep specialist. Owns HRV interpretation, sleep architecture, training stress vs recovery balance, illness flags. Restricted to recovery/sleep daily_logs columns.

Routing is via a `delegate_to_specialist` tool exposed only to Peter. He inspects each incoming user message and either answers directly (cross-domain or general) or routes to one specialist. The specialist runs a fresh Claude call with its own prompt + restricted tools, streamed back to the user as the assistant's reply with the specialist's name + chip in the UI.

## Goals

1. **One head coach (Peter), three specialists (Carter, Nora, Remi).** Each with a distinct system prompt, voice, and restricted tool subset. Each tool subset is computed as `(specialist_base_tools ∩ mode_filter)` so existing mode behavior (`default`, `plan_week`, `setup_block`, `intake`) extends cleanly.
2. **Peter is the chat entry point and router.** Every user message hits a Peter stream first. Peter has access to `delegate_to_specialist(specialist, briefing?)`; when he calls it as his first move, the orchestrator intercepts, swaps to the named specialist's prompt + tools, and pipes the specialist's stream back to the user. When Peter doesn't delegate, his own stream is the answer.
3. **Specialists never recursively delegate.** `delegate_to_specialist` is Peter-only. A specialist can call its own data tools and answer, full stop. If a question turns out cross-domain after delegation, the specialist surfaces that in their reply ("this sits between training and nutrition — Peter would have better cross-domain context") — the user can ask Peter directly in a follow-up.
4. **Cross-domain surfaces are Peter's.** Morning brief advice, weekly review narrative, proactive nudges synthesis, coach trends headline, block progression, and plan builder narrative are all narrated by Peter. The deterministic composers underneath each surface are unchanged — they continue producing per-domain structured data, which now gets surfaced in card UI with the relevant specialist's chip.
5. **Chat UI shows the speaker per message.** Each assistant message renders with a small chip (name + role color) above the bubble. Handoff transitions render a single inline line: "Peter → Nora." Existing chat history retroactively shows all old messages as Peter (the previous single coach is structurally the new head coach).
6. **No regression in tool safety.** All existing security invariants (no `user_id` in tool input schemas; `.eq("user_id", userId)` on every executor; closed enum validation; range caps; date round-tripping) carry through. Specialist tool subsets are subsets of the existing `allTools` array — no new executor logic, just new partitioning.

## Non-Goals

- **Multi-agent council.** No parallel specialist calls on cross-domain questions. Peter answers cross-domain queries himself with full tool access. If "should I push today?" needs Nora + Remi input, Peter can issue tool calls to query nutrition + recovery data himself. If the value of a true council becomes clear after living with the routing architecture, it's a follow-on spec.
- **User-chooses-specialist UI.** No "ask Nora directly" button. Peter routes. Users can phrase their question to clearly point at one specialist; he'll route accordingly. The mental model is "you talk to Peter, who brings in the right specialist."
- **Cross-specialist consultation mid-turn.** Specialists never delegate. No "Carter, check with Remi if I'm recovered." If a specialist sees a clear cross-domain dependency, they say so in their reply and the user follows up with Peter.
- **Per-specialist memory.** No private notes per specialist. The athlete profile is shared. The chat history is shared. All specialists see the same context prefix.
- **Renaming/rebranding specialists via settings.** Names locked in code for v1. If a name is wrong (e.g., user wants "Coach Sarah" for nutrition), it's a code edit.
- **Streaming Peter's "thinking" before delegation visibly.** When Peter's first move is `delegate_to_specialist`, his pre-delegation tokens are discarded. The user sees `Peter → Nora` chip transition followed by Nora's stream. No visible thought bubble.
- **Mood / sickness elicitation by specialist voice during intake.** Intake stays Peter-only — onboarding is a head-coach conversation. Specialists stay dormant until the user is past onboarding.
- **Per-specialist editable system prompts.** `profiles.system_prompt` (the existing user-editable coach prompt) becomes Peter's prompt override. The three specialists stay code-defined. If user customization of a specialist becomes desirable, it's a follow-on.
- **Specialist-attributed historical chat messages.** The migration backfills all existing `chat_messages` rows to `speaker = 'peter'`. We do not retroactively re-classify which historical messages should have been Carter / Nora / Remi.
- **Cost optimization via cheaper specialists.** All four coaches use the same `CHAT_MODEL` (currently Sonnet 4.5). No per-specialist model tuning in v1. If a specialist's role turns out to be sufficiently narrow that Haiku 4.5 handles it, that's a future cost-tuning pass.
- **Voice / TTS per coach.** Text chat only. No spoken voices.

## Architecture overview

```
                    User message
                          │
                          ▼
        ┌───────────────────────────────────┐
        │  app/api/chat/messages/route.ts   │
        │  (streaming SSE handler)          │
        └────────────────┬──────────────────┘
                         │
                         ▼
        ┌─────────────────────────────────────┐
        │  Open Peter stream                  │
        │  - prompt: PETER_BASE + profile     │
        │  - tools: PETER_TOOLS ∩ mode_filter │
        │  - includes delegate_to_specialist  │
        └────────────────┬────────────────────┘
                         │
                         ▼
        ┌─────────────────────────────────────┐
        │  Watch for tool_use events          │
        │  - if delegate_to_specialist:       │────────┐
        │      intercept (do NOT relay)       │        │
        │  - else: continue streaming Peter   │        │
        └────────────────┬────────────────────┘        │
                         │                              │
              No delegation                  Delegation invoked
                         │                              │
                         ▼                              ▼
        ┌─────────────────────────────┐  ┌──────────────────────────────────┐
        │  Pipe Peter's stream → client│  │  Emit SSE event:                 │
        │  Persist on end:             │  │    { type: "handoff",            │
        │  chat_messages { speaker:    │  │      from: "peter",              │
        │    'peter' }                 │  │      to: <spec>, briefing? }     │
        └─────────────────────────────┘  └──────────────────┬───────────────┘
                                                            │
                                                            ▼
                                          ┌────────────────────────────────────┐
                                          │  Open <specialist> stream          │
                                          │  - prompt: <SPEC>_BASE + profile   │
                                          │  - tools: <SPEC>_TOOLS ∩ mode_filter│
                                          │  - delegate_to_specialist NOT in   │
                                          │    tools (specialists can't       │
                                          │    recursively delegate)           │
                                          │  - first message includes Peter's  │
                                          │    briefing as a system note       │
                                          └──────────────────┬─────────────────┘
                                                             │
                                                             ▼
                                          ┌─────────────────────────────────┐
                                          │  Pipe specialist stream → client│
                                          │  Persist on end:                │
                                          │  chat_messages { speaker: <spec>}│
                                          └─────────────────────────────────┘
```

Non-chat surfaces (morning brief, weekly review, proactive, trends, plan builder) keep their existing structure. The deterministic composers (specialist-shaped already) produce structured payloads. The narrator call — already a single Claude call per surface — is now explicitly Peter. Card UI gains specialist chips next to per-domain flags.

## The roster

### Peter — Head Coach

**Role:** Default chat agent + router. Cross-domain synthesis. Block-level strategy. Goal-vs-actual reconciliation. The only coach with `delegate_to_specialist`.

**System prompt focus:** Holistic athlete management. Periodization across blocks (not within weeks — that's Carter). "What story do the numbers tell this week?" Goal alignment with the athlete profile. Adaptive context (GLP-1 phase, illness, injuries, life events). When to push and when to pull back, integrating training stimulus + nutrition state + recovery capacity. Named after Peter Attia — longevity-and-performance medicine framing.

**Tools (default mode):** All existing tools EXCEPT specialist-exclusive ones. Specifically includes:
- `query_daily_logs` (full column allowlist)
- `query_workouts`
- `query_food_log` (new in sub-project #1)
- `set_glp1_*`, `mark_glp1_discontinued`
- `mark_mobility_done`, `unmark_mobility_done`
- `regenerate_morning_brief`
- `propose_block` + `commit_block` (block-level planning is his)
- `delegate_to_specialist` (Peter-only)

**Tools (intake mode):** Peter is the ONLY active coach in intake mode. Specialists dormant. `delegate_to_specialist` is NOT exposed in intake mode (no one to delegate to). Tool set = existing intake-mode allowlist (`query_daily_logs`, `query_workouts`, `apply_*`, `set_*` intake-specific tools). Plan-builder commit tools stay Peter's.

**Tools (plan_week / setup_block):** Same as default mode plus the relevant `propose_*` / `commit_*` tools. `delegate_to_specialist` IS exposed here — Peter can hand off mid-planning if the question turns purely strength-tactical.

### Coach Carter — Strength specialist

**Role:** Within-week strength training execution. Exercise programming, RPE/RIR judgment, autoregulation, exercise selection given equipment + injury constraints, mobility recommendations.

**System prompt focus:** Inherits and refines the existing `DEFAULT_SYSTEM_PROMPT`'s strength-coach voice — direct, numeric, concrete-citation-driven. Adds explicit framing as the within-week specialist: "Peter owns block-level decisions and cross-domain synthesis; you own the next session, the next week's training plan, exercise programming, autoregulation."

**Tools:**
- `query_workouts` (full)
- `query_daily_logs` (allowed cols restricted to: `recovery`, `strain`, `sleep_hours`, `sleep_score` — the autoregulation-relevant signals; not nutrition, not body comp)
- `propose_week` + `commit_week`
- `mark_mobility_done`, `unmark_mobility_done`
- The existing schedule-flexibility swap tools (via `/api/training-weeks/[week_start]/swap`)

NOT in Carter's toolset: `query_food_log`, body-comp columns on daily_logs, GLP-1 mode tools, brief regeneration. If the user asks Carter "should I cut more this week?", Carter says "that's Nora + Peter territory — let me bounce this back to Peter" by surfacing the limitation in the reply.

### Nora — Nutrition specialist

**Role:** Food choices, macro distribution, hydration, GLP-1 phase awareness, micronutrient analysis (within USDA data scope), portion calibration based on item-level food log.

**System prompt focus:** Nutrition coaching voice — concrete grams, kcal, ratios; reads item-level food log to give food-choice and portion advice (the capability sub-project #1 unlocked). Aware of the dual-mode nutrition module (GLP-1 active / tapering / classical / steady-state). Explicit framing: "Peter owns the macro-level plan strategy; you own day-to-day food choices, macro coaching, and GLP-1 phase transitions."

**Tools:**
- `query_food_log` (full)
- `query_daily_logs` (allowed cols restricted to nutrition cluster: `calories_eaten`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, plus body comp for context: `weight_kg`, `body_fat_pct`, `fat_free_mass_kg`)
- `set_glp1_status`, `set_glp1_taper_started`, `mark_glp1_discontinued`

NOT in Nora's toolset: `query_workouts`, recovery columns, training plan tools. If asked about training programming, she defers to Carter via reply text.

### Remi — Recovery / Sleep specialist

**Role:** HRV interpretation, sleep architecture analysis, training stress vs recovery balance, illness flags, mobility prescription.

**System prompt focus:** Recovery science voice — HRV trends vs personal baseline, sleep efficiency interpretation, when low recovery signals overtraining vs life stress vs illness vs nutrition gap. Explicit framing: "Peter owns the strategic balance of stress and recovery across blocks; you own day-to-day recovery interpretation and recommendations."

**Tools:**
- `query_daily_logs` (allowed cols restricted to recovery/sleep cluster: `hrv`, `resting_hr`, `recovery`, `sleep_hours`, `sleep_score`, `deep_sleep_hours`, `rem_sleep_hours`, `spo2`, `skin_temp_c`, `respiratory_rate`, `strain`)
- `mark_mobility_done`, `unmark_mobility_done`

NOT in Remi's toolset: `query_workouts` (Remi reads training stress via `strain` on daily_logs, not workout details), nutrition tools, body composition columns.

## The delegation mechanism

### Tool definition (Peter-only)

```ts
export const DELEGATE_TOOL = {
  name: "delegate_to_specialist",
  description: `Route this question to a specialist coach with deeper domain expertise. Use when the user's question is clearly within one specialist's lane:
  - 'carter' for strength training, exercise programming, RPE/RIR, autoregulation, within-week training plan, mobility execution
  - 'nora' for food choices, macros, portion sizes, hydration, GLP-1 phase questions, micronutrient gaps
  - 'remi' for HRV interpretation, sleep quality, recovery interpretation, illness flags
For cross-domain questions ("should I push hard today?", "how is my block going?"), strategic block-level decisions, weekly review interpretation, or goal alignment — answer directly without delegating.`,
  input_schema: {
    type: "object" as const,
    required: ["specialist"],
    properties: {
      specialist: { type: "string", enum: ["carter", "nora", "remi"] },
      briefing: {
        type: "string",
        description: "Optional 1-2 sentence note framing the question for the specialist (e.g., 'athlete just finished a deload, asking about next mesocycle' or 'GLP-1 taper started Sunday, asking about protein targets'). Sets the specialist up to give a sharper first answer."
      }
    }
  }
};
```

### Orchestrator behavior

In `app/api/chat/messages/route.ts` (the streaming SSE handler):

1. **Always open Peter's stream first** with `PETER_BASE + profile_summary + chat_history`. Tools = `PETER_TOOLS ∩ mode_filter`.

2. **Watch the stream for `tool_use` events.** For every tool_use other than `delegate_to_specialist`: relay normally (run the executor, send `tool_result` back to Peter, continue streaming). For `delegate_to_specialist`:
   - **Halt Peter's stream.** Cancel via `AbortController.signal`. Any buffered tokens emitted between stream-start and the delegate tool call are discarded (Peter was about to delegate; pre-delegation tokens are not the user's answer).
   - **Persist Peter's discarded preamble for observability only** — write a row to `chat_messages` with `speaker = 'peter'`, `kind = 'system_routing'`, `content = '[delegated to <specialist>]'`, `tool_calls = [delegate_to_specialist invocation]`. This row is NOT rendered in the chat UI (filtered by kind) but is queryable for debugging.
   - **Emit SSE event:** `{ type: "handoff", from: "peter", to: <specialist>, briefing: <briefing> | null }`. Client uses this to render the chip transition.
   - **Open the specialist stream** with `<SPEC>_BASE + profile_summary + chat_history`, tools = `<SPEC>_TOOLS ∩ mode_filter`. The user message in the new stream is the same original user message; if `briefing` was provided, it's prepended as a system note: `"Peter's briefing: <briefing>\n\n---\n\nUser message:\n<original>"`.
   - **Pipe specialist's stream to client** as the assistant's reply, same SSE event format as a normal stream.
   - **On specialist stream end,** persist `chat_messages { speaker: <specialist>, kind: 'assistant', content: <accumulated_text>, tool_calls: <specialist's tool calls> }`.

3. **If Peter does not delegate** (just answers directly), his stream is the reply. Persist on end with `speaker = 'peter'`.

### Why the discard / observability split

Peter's pre-delegation tokens contain his routing reasoning ("This is clearly a nutrition question — handing to Nora"). Showing them to the user clutters the chat. Discarding them entirely loses the audit trail. The compromise: persist a hidden `kind = 'system_routing'` row that captures the routing decision + tool call, and filter it out of the rendered chat. If routing is ever wrong (Peter sends a strength question to Nora), the row is queryable to debug.

`chat_messages.kind` already exists (added in migration 0007 for morning intake). Adding `'system_routing'` to the check constraint is a minor schema change.

## Chat data model

### Migration 0020 — `chat_messages.speaker`

```sql
-- 0020_coach_team.sql
--
-- Multi-coach team architecture (sub-project #2 of coach-team arc).
-- Adds:
--   - chat_messages.speaker: who authored the message
--   - chat_messages.kind extended with 'system_routing' for hidden audit rows

alter table chat_messages
  add column speaker text not null default 'peter'
  check (speaker in ('peter', 'carter', 'nora', 'remi', 'user'));

-- Extend kind check constraint to include 'system_routing'.
alter table chat_messages
  drop constraint chat_messages_kind_check;
alter table chat_messages
  add constraint chat_messages_kind_check
  check (kind in (
    'assistant', 'user', 'morning_intake', 'morning_brief',
    'weekly_review', 'proactive_nudge', 'system_routing'
  ));

-- Backfill: user messages get 'user'; everything else stays 'peter'.
-- (The default already sets 'peter'; we only need to fix user messages.)
update chat_messages
  set speaker = 'user'
  where role = 'user';

-- Index for filtering visible chat history (excludes system_routing).
create index chat_messages_visible_idx
  on chat_messages (user_id, created_at desc)
  where kind != 'system_routing';
```

Note: existing `chat_messages.role` column (`user` | `assistant`) stays for compatibility with the Anthropic API message format. `speaker` is the orthogonal UI concern (who said it, for chip rendering). The two columns are linked but not redundant: `role = 'assistant' && speaker = 'peter'` vs `role = 'assistant' && speaker = 'carter'`.

### Profile

`profiles.system_prompt` (existing user-editable coach prompt override) is now interpreted as **Peter's** prompt override. When set, it replaces `PETER_BASE` in the prompt assembly. Specialists' base prompts stay code-defined; no user-editable override surface in v1. If per-specialist customization becomes desirable in v2, that gets its own migration.

## Tool partitioning

`lib/coach/tools.ts` exports `allTools` today. The refactor partitions it into role-specific subsets:

```ts
// lib/coach/tools.ts (additions)

import { DELEGATE_TOOL } from "./delegate-tool";

/** Full union — used for codebase-wide reference, not directly served to any coach. */
export const ALL_COACH_TOOLS = [
  DAILY_LOGS_TOOL, WORKOUTS_TOOL, FOOD_LOG_TOOL,
  GLP1_STATUS_TOOL, GLP1_TAPER_STARTED_TOOL, GLP1_DISCONTINUED_TOOL,
  MOBILITY_DONE_TOOL, MOBILITY_UNMARK_TOOL,
  REGENERATE_BRIEF_TOOL,
  PROPOSE_WEEK_TOOL, COMMIT_WEEK_TOOL,
  PROPOSE_BLOCK_TOOL, COMMIT_BLOCK_TOOL,
  PROPOSE_PLAN_TOOL, COMMIT_PLAN_TOOL,
  /* + intake-mode tools */
];

export const PETER_TOOLS = [
  // Everything except the specialist-exclusive cuts (none today; Peter has all).
  ...ALL_COACH_TOOLS,
  DELEGATE_TOOL, // Peter-only
];

export const CARTER_TOOLS = [
  WORKOUTS_TOOL,
  // query_daily_logs but with a column-cluster restriction injected at executor time
  CARTER_DAILY_LOGS_TOOL, // wraps DAILY_LOGS_TOOL with restricted ALLOWED_COLUMNS
  PROPOSE_WEEK_TOOL, COMMIT_WEEK_TOOL,
  MOBILITY_DONE_TOOL, MOBILITY_UNMARK_TOOL,
];

export const NORA_TOOLS = [
  FOOD_LOG_TOOL,
  NORA_DAILY_LOGS_TOOL,
  GLP1_STATUS_TOOL, GLP1_TAPER_STARTED_TOOL, GLP1_DISCONTINUED_TOOL,
];

export const REMI_TOOLS = [
  REMI_DAILY_LOGS_TOOL,
  MOBILITY_DONE_TOOL, MOBILITY_UNMARK_TOOL,
];
```

`CARTER_DAILY_LOGS_TOOL` / `NORA_DAILY_LOGS_TOOL` / `REMI_DAILY_LOGS_TOOL` are thin wrappers around `DAILY_LOGS_TOOL` that override the `columns.items.enum` field to the specialist's column cluster. The executor (`executeQueryDailyLogs`) takes an additional optional `allowed_columns` parameter; when present, it validates the requested columns against the restricted list (rejecting any others as `column_not_in_specialty`). Concretely:

```ts
// In chat-stream.ts dispatch:
case "query_daily_logs":
  return await executeQueryDailyLogs(supabase, userId, input, {
    allowedColumns: speakerColumnRestrictions[currentSpeaker],
  });
```

Where `speakerColumnRestrictions` is a mapping defined alongside the tool partitions:
```ts
const PETER_COLS = ALLOWED_COLUMNS;
const CARTER_COLS = ["recovery", "strain", "sleep_hours", "sleep_score"] as const;
const NORA_COLS = ["calories_eaten", "protein_g", "carbs_g", "fat_g", "fiber_g", "weight_kg", "body_fat_pct", "fat_free_mass_kg"] as const;
const REMI_COLS = ["hrv", "resting_hr", "recovery", "sleep_hours", "sleep_score", "deep_sleep_hours", "rem_sleep_hours", "spo2", "skin_temp_c", "respiratory_rate", "strain"] as const;
```

The same pattern applies if Carter ever queries `query_workouts` with an exercise filter — Carter has full access; Nora and Remi don't get `query_workouts` at all.

## Mode handling

The existing mode partitioning in `chat-stream.ts` filters Peter's tool list by mode (`default` / `plan_week` / `setup_block` / `intake`). The team architecture extends this:

```ts
function toolsForSpeakerAndMode(speaker: Speaker, mode: Mode): Tool[] {
  const speakerBase = speakerToolBase(speaker); // PETER_TOOLS / CARTER_TOOLS / etc.
  return speakerBase.filter((t) => modeAllowsTool(mode, t.name));
}
```

`modeAllowsTool` reuses the existing mode-filter logic from `chat-stream.ts`. The specialist tool list is the intersection of (specialty subset) ∩ (mode-allowed subset).

Special cases:
- **`intake` mode:** Only Peter runs. The orchestrator does NOT include `DELEGATE_TOOL` in Peter's tool list when `mode === 'intake'`. Specialists are dormant. If Peter calls `delegate_to_specialist` despite it being filtered out, the tool dispatch returns `{ error: "delegation_not_available_in_intake_mode" }`. (This shouldn't happen — the tool isn't in the list — but the dispatch layer is defensive.)
- **`plan_week` and `setup_block`:** Delegation IS available. Peter can hand off to Carter mid-planning when the question becomes purely tactical (which exercise to swap, how many sets for a given RPE).
- **`default`:** Delegation available, default tool sets per coach.

## Surface ownership

| Surface | Owner / narrator | Specialist contributions surfaced |
|---|---|---|
| **Chat (default)** | Peter (routes) | Specialist responses when Peter delegates |
| **Morning brief card** | Peter narrates the `advice_md` block | Recovery flags labeled "Remi: HRV -8% vs your 30-day baseline"; nutrition flags labeled "Nora: yesterday's dinner was 60% carbs"; strength flags labeled "Carter: today is heavy squat day (week 3 of mesocycle)" |
| **Weekly review document** | Peter narrates `narrative_md` | §3 trends section: each per-domain row gets the specialist's chip. §6 prescription cells: each cell labeled by who "proposed" it (lift swaps → Carter chip; deficit adjustments → Nora chip; deload week proposals → Remi chip; block transitions → Peter chip) |
| **Proactive nudges** | The specialist who owns the trigger | Plateau detection → Carter's chip + voice. Off-pace cut → Nora's chip. HRV below baseline → Remi's chip. The card template is per-specialist; render-card.ts gains a `speaker` field on each trigger-card output. |
| **Coach Trends page** | Peter (headline picker stays) | Each section (Performance / Composition / Cross) renders with the relevant specialist's chip in the section header: Performance → Carter, Composition → Nora, Cross → Peter |
| **Block progression** | Peter only | Block-level strategy is cross-domain. `propose_block` + `commit_block` tools are Peter's exclusively. Carter still owns `propose_week` + `commit_week`. |
| **Plan builder (athlete profile Phase 2)** | Peter narrates `narrative_md` | The deterministic composers (`compose-strength`, `compose-nutrition`, `compose-sleep`, `compose-recovery`) get explicit specialist attribution in the rendered plan UI |

The deterministic composer outputs are unchanged — they continue to produce per-domain structured payloads. The narrator call is now Peter; the card UI gains specialist chips next to per-domain blocks.

## Streaming + persistence

See "Orchestrator behavior" above. Key data-flow details:

- The SSE event stream gains one new event type:
  ```ts
  type StreamEvent =
    | { type: "delta"; text: string }
    | { type: "done" }
    | { type: "error"; message: string }
    | { type: "handoff"; from: Speaker; to: Speaker; briefing: string | null }; // NEW
  ```
- Client (`hooks/useChatStream.ts` or wherever chat receives SSE) handles `handoff` by:
  - Closing the current assistant message bubble (the discarded Peter preamble is not persisted as a visible message).
  - Rendering a small inline handoff line: `Peter → Nora` with chip colors and the briefing as a small italic note if present.
  - Opening a new assistant message bubble with the destination speaker's chip.
- Persistence: on stream end, persist exactly ONE visible message per stream (either Peter's direct answer or the specialist's answer). Hidden routing-audit rows (`kind = 'system_routing'`) are persisted separately and not rendered.
- **Token cost note:** Delegation costs ~1.5x a normal turn (Peter's prompt + brief preamble before tool call ≈ 0.5x of a full reply; specialist's full reply ≈ 1x). Acceptable for the value of specialist depth. Most direct-answer Peter turns are 1x cost.

## UI changes

### `components/chat/ChatThread.tsx` + `ChatMessage.tsx`

Each assistant message renders:

```
┌─────────────────────────────┐
│  [Nora chip] Nora           │  ← speaker chip + name
│  ─────────────────────────  │
│  Yesterday's dinner was…    │  ← message content
└─────────────────────────────┘
```

Speaker chip colors (from `lib/ui/theme.ts` — extend `COLOR` const):
- Peter: neutral steel (`#7a8499` or similar — calls back to the "head coach" overseeing tone)
- Carter: red (`#ef4444` or existing strength brand)
- Nora: green (`#10b981` — nutrition / growth)
- Remi: blue/teal (`#06b6d4` — recovery / calm)

Handoff line (rendered between messages when speaker changes within one turn):

```
┌─────────────────────────────────────────┐
│   • • • Peter → Nora • • •              │
│   (Optional: "Athlete just started      │
│   a GLP-1 taper, asking about protein") │
└─────────────────────────────────────────┘
```

Subtle, italicized, smaller than a normal message. Only renders when `previousMessage.speaker !== currentMessage.speaker` AND `currentMessage.speaker !== 'user'`.

### `components/chat/ChatComposer.tsx`

No change. Composer is always addressed to Peter (the user types, Peter receives). Optional polish: placeholder text becomes "Ask Peter…" instead of "Ask coach…".

### Morning brief card (`components/morning/MorningBriefCard.tsx`)

The card already has named blocks (Yesterday recap, Today readiness, Today session, Macros, Advice, Sleep). Each block gains a small specialist chip in the header:
- Yesterday recap → Peter
- Today readiness band → Remi (recovery interpretation)
- Today session → Carter (training plan)
- Macros → Nora
- Advice (narrative) → Peter (synthesizer)
- Sleep target → Remi

The Advice block is the only narratively AI-generated block; that stays Peter's voice.

### Weekly review (`components/coach/WeeklyReviewPage.tsx` or equivalent)

§3 trends section: each per-domain row gains its specialist chip.
§6 prescription cells: each row labeled by who "proposed" it.
§7 narrative: voiced by Peter (unchanged underlying call, just rebranded).

### Proactive nudge cards (`components/chat/ProactiveNudgeCard.tsx`)

Card chip + body voice matches the specialist who owns the trigger. The card template adds a small "from <Specialist>" label in the header.

### Coach trends page (`app/coach/trends/page.tsx`)

Each section header gains the relevant specialist's chip.

## Deliverables

- `supabase/migrations/0020_coach_team.sql` — `chat_messages.speaker` column + constraint + index + `system_routing` kind + `profiles.speaker_prompt_overrides` placeholder + backfill.
- `lib/coach/system-prompts.ts` — replace `DEFAULT_SYSTEM_PROMPT` with `PETER_BASE`, `CARTER_BASE`, `NORA_BASE`, `REMI_BASE`. Keep `SCHEMA_EXPLAINER` shared. `normalizePromptForCompare` continues to work on `profiles.system_prompt` (now Peter's override).
- `lib/coach/delegate-tool.ts` — `DELEGATE_TOOL` schema, Peter-only.
- `lib/coach/tools.ts` — partition `allTools` into `PETER_TOOLS`, `CARTER_TOOLS`, `NORA_TOOLS`, `REMI_TOOLS`. Add `CARTER_DAILY_LOGS_TOOL`, `NORA_DAILY_LOGS_TOOL`, `REMI_DAILY_LOGS_TOOL` (thin column-restricted wrappers). Extend `executeQueryDailyLogs` to accept `allowedColumns` parameter.
- `lib/coach/speakers.ts` — `Speaker` type, color constants, display names, prompt + tool lookup helpers.
- `lib/coach/chat-stream.ts` — orchestrator changes: open Peter stream first, intercept `delegate_to_specialist`, emit `handoff` SSE event, open specialist stream, pipe to client.
- `app/api/chat/messages/route.ts` — wire the handoff event into the SSE proxy; persist messages with `speaker` column populated; persist hidden `system_routing` audit rows.
- `lib/data/types.ts` — `Speaker` type alias re-exported; `ChatMessage.speaker` field added; `StreamEvent` union extended with `handoff` variant; `kind` union extended with `'system_routing'`.
- `components/chat/ChatThread.tsx` + new `components/chat/SpeakerChip.tsx` + new `components/chat/HandoffLine.tsx`.
- `lib/ui/theme.ts` — extend `COLOR` with `peter`, `carter`, `nora`, `remi`.
- All non-chat surface components (`MorningBriefCard.tsx`, weekly review page, `ProactiveNudgeCard.tsx`, coach trends page) gain specialist chip rendering for per-domain blocks.
- `lib/coach/proactive/render-card.ts` — gain `speaker` field on rendered card payloads (plateau → carter, off-pace → nora, hrv → remi).
- `lib/coach/weekly-review/compose-prescription.ts` (or wherever cells are built) — tag each cell with `proposed_by_speaker` for UI attribution.
- Audit script: `scripts/audit-speaker-routing.mjs` — read-only audit that for the last N chat messages, reports the speaker distribution and flags any obvious mis-routings (Carter answering nutrition questions, Nora answering training questions) via keyword heuristics. Useful for tuning Peter's routing prompt.
- CLAUDE.md update — new sub-section "Multi-coach team architecture" under the Coach / AI section; new migration listed.

## Environment / config

No new env vars. Same `ANTHROPIC_API_KEY`, same `CHAT_MODEL`. Routing happens via tool-use, no separate classifier.

## Open items deferred to implementation plan

- **Peter's routing prompt tuning.** The exact phrasing in `PETER_BASE` that nudges Peter toward delegating in clear-domain cases vs answering directly. Likely requires 20-30 sample messages tested in dev to calibrate. Start with the system prompt sketched here; refine during the first week of use.
- **Chip color exact hex values.** The four colors named are illustrative; final hex picks happen during implementation alongside the existing `lib/ui/theme.ts:COLOR` palette to ensure they read well on the dark theme.
- **Handoff line copy.** "Peter → Nora" with optional briefing italics is the sketch. Implementer may tweak based on visual feel during build.
- **Whether to surface the briefing to the user at all.** Showing briefings adds transparency ("I'm asking Nora about this because…") but adds visual noise. v1 starts with briefings shown; if noisy, hide them and reserve for the system_routing audit log only.
- **Migration of existing `profiles.system_prompt` semantics.** The current default IS `DEFAULT_SYSTEM_PROMPT`. The migration to Peter's new prompt means the `normalizePromptForCompare` check (which decides whether to write NULL on save) needs to compare against `PETER_BASE` going forward. Implementation should ensure: if a user has previously saved a customized `system_prompt`, that customization remains visible in /profile and applied as Peter's prompt override. If they had not customized (i.e., NULL or normalized-equal-to-default), they remain on the new `PETER_BASE`.
- **What to do if specialist returns "this is out of my lane" reply.** v1: just show the reply as-is. v2 could auto-route back to Peter with the specialist's reply as briefing. Defer.
- **Pricing observability.** Track per-speaker token usage in the existing usage logs (if any) so we can see the cost distribution across coaches after a week of use.

## Future specs that build on this

- **Multi-agent council** — parallel specialist calls + Peter synthesis for cross-domain questions. Worth specing if routing-only feels too sequential after living with it.
- **User-chooses-specialist UI** — explicit "ask Nora" button in chat composer. Worth specing if Peter's routing is unreliable enough that users want to override it.
- **Per-specialist system prompt overrides** — UI in /profile to edit each specialist's base prompt. Lands with its own migration when speced.
- **Sub-project #3 (next of the coach-team arc)** — TBD based on what feels limiting after the team architecture lives for a few weeks. Candidate: Peter's block-progression intelligence becoming more proactive (auto-proposing block transitions when the data calls for it).
