# Coach Team — Auto-Routing (no front-door Peter)

**Status:** spec
**Date:** 2026-05-19
**Owner:** Abdelouahed
**Supersedes (partially):** [2026-05-19-multi-coach-team-design.md](2026-05-19-multi-coach-team-design.md) — the multi-coach team architecture stays, the *routing* changes.

## Motivation

Sub-project #2 introduced the four-coach team (Peter, Carter, Nora, Remi) with Peter as the chat default and `delegate_to_specialist` as the routing mechanism. In practice, even though the speaker chip swaps mid-turn, the chat *feels* like "Peter's chat with guests" — Peter is always the first speaker, his pre-delegation tokens are discarded, and the user never sees a specialist begin a turn on their own.

The goal here is to make the chat feel like a real team: Carter / Nora / Remi own in-domain answers immediately, Peter is reserved for cross-domain synthesis, weekly review, and block-level decisions. The user retains explicit control via a coach picker / `@mention` when they want a specific voice.

## Non-goals

- Multi-tab UI (separate threads per coach). Rejected: fragments shared context, forces the user to do classification, ~3-4× implementation surface.
- Multi-coach answers ("ask the team" composite responses). Out of scope for v1; revisit later.
- Per-coach unread badges, per-coach history filters. Single thread, single read marker.
- Push-notification routing changes. Notifications continue to render the speaker recorded on the message.
- Onboarding modal. Discovery via the composer avatar row + speaker chips is enough.

## Architecture

Pre-stream classification replaces Peter's front-door role. The route picks the speaker **before** opening the Anthropic stream, so the chosen coach is the first and only voice the user sees for that turn (unless a mid-stream `handoff_to` fires, which is rare).

```
user message
   │
   ▼
[Manual override?]  ──yes──▶  use override speaker
   │ no
   ▼
[Keyword classifier]  ──confidence ≥ 0.8──▶  use classifier speaker
   │ confidence < 0.8
   ▼
[Haiku tiebreaker]  ──▶  use Haiku speaker (fallback: peter)
   │
   ▼
runChatStream({ speaker })
   │
   ▼
(rare) handoff_to(target) emitted mid-stream
   │
   ▼
route persists system_routing row, spawns fresh runChatStream({ speaker: target })
```

### Where the change lives

- **New:** `lib/coach/router.ts` — pure module exporting `classifyTurn(text, options) → RouterDecision`. No I/O on the keyword path; one cached Haiku call on the ambiguous path.
- **Modified:** [app/api/chat/route.ts](../../../app/api/chat/route.ts) — calls `classifyTurn` before `runChatStream`, passes the resulting `speaker` into `opts.speaker`.
- **Modified:** [lib/coach/chat-stream.ts](../../../lib/coach/chat-stream.ts) — generalize the existing handoff intercept so any speaker (not just Peter) can emit it. Rename the tool name constant.
- **Renamed:** [lib/coach/delegate-tool.ts](../../../lib/coach/delegate-tool.ts) → `handoff-tool.ts`. Tool name changes from `delegate_to_specialist` to `handoff_to`. Now in every coach's tool set.
- **Modified:** [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) — rewrite Peter's prompt (no longer router), update Carter/Nora/Remi prompts (call `handoff_to('peter')` instead of telling user to ask Peter).
- **Modified:** [lib/coach/tools.ts](../../../lib/coach/tools.ts) — `toolsForSpeaker` includes `handoff_to` for all four speakers.
- **New UI:** `components/chat/ChatCoachPicker.tsx` — avatar row above the composer with Auto + 4 coach avatars; tap locks the next message.
- **Modified UI:** [components/chat/ChatComposer.tsx](../../../components/chat/ChatComposer.tsx) — renders the picker; sends the lock state to the API as a query param or body field.
- **Modified UI:** [components/chat/ChatPanel.tsx](../../../components/chat/ChatPanel.tsx) — owns the lock state, clears it after a successful send.
- **Modified:** [scripts/audit-speaker-routing.mjs](../../../scripts/audit-speaker-routing.mjs) — break out auto-route / manual / mention / handoff distributions.

## 1. Router

### Signature

```ts
// lib/coach/router.ts
import type { Speaker } from "@/lib/data/types";
import type { ChatMode } from "@/lib/data/types";

export type RouteMethod = "manual" | "mention" | "keyword" | "haiku" | "fallback";

export type RouterDecision = {
  speaker: Speaker;
  method: RouteMethod;
  confidence: number; // 0..1; 1 for manual/mention; keyword score for keyword; 1 for haiku (best-of-one)
  matched_terms?: string[]; // populated on keyword path for telemetry
};

export type ClassifyTurnOpts = {
  text: string;
  mode: ChatMode;
  override?: Speaker | null; // user clicked a picker avatar
  abortSignal?: AbortSignal;
};

export async function classifyTurn(opts: ClassifyTurnOpts): Promise<RouterDecision>;
```

### Step 1 — manual override

If `opts.override` is set, return `{ speaker: override, method: 'manual', confidence: 1 }` immediately. No keyword pass, no LLM.

### Step 2 — `@mention` parse

If `opts.text` starts with `@Peter|@Carter|@Nora|@Remi` (case-insensitive, optional trailing whitespace, possibly followed by the rest of the message), strip the mention and return `{ speaker, method: 'mention', confidence: 1 }`. The stripped text is the value the API ends up sending to the model. The original (with `@Name`) is what the route persists to `chat_messages.content` so the audit trail is honest.

### Step 3 — keyword classifier

Pure deterministic. Each speaker has a curated keyword list. Single-word keywords match case-insensitively on `\b` word boundaries. Multi-word keywords (`"this week's training"`, `"how am I doing"`) match as literal substrings, case-insensitively. Each *unique* matched keyword contributes 1 point — duplicates of the same keyword in the message do not stack.

| Speaker | Keywords (examples; full list in `KEYWORDS` constant) |
|---|---|
| **Carter** | `set`, `sets`, `rep`, `reps`, `RPE`, `RIR`, `1RM`, `e1RM`, `squat`, `bench`, `deadlift`, `press`, `OHP`, `row`, `pull`, `push`, `lift`, `lifting`, `workout`, `session`, `exercise`, `mobility`, `warmup`, `swap`, `today's session`, `this week's training`, `program` |
| **Nora** | `protein`, `kcal`, `calories`, `carbs`, `fat`, `fiber`, `macro`, `macros`, `meal`, `breakfast`, `lunch`, `dinner`, `snack`, `food`, `eating`, `ate`, `portion`, `serving`, `GLP-1`, `tirzepatide`, `semaglutide`, `hydration`, `water` |
| **Remi** | `HRV`, `resting HR`, `RHR`, `recovery`, `sleep`, `slept`, `bedtime`, `wake`, `deep sleep`, `REM`, `strain`, `sick`, `fatigue`, `fatigued`, `tired`, `sore`, `soreness`, `bloating` |
| **Peter** | `goal`, `goals`, `block`, `mesocycle`, `phase`, `overall`, `how am I doing`, `this month`, `cross`, `weekly review`, `progress`, `trending`, `outlook`, `strategy`, `plan` (alone, not "training plan"), `am I on track` |

Score normalization:

```
points[s] = count of unique matched keywords for speaker s
total = sum(points)
if total == 0: confidence = 0
else: confidence = max(points) / total
winner = argmax(points); ties broken by priority order: peter, carter, nora, remi
                                                       (peter wins ties because cross-domain
                                                        ambiguity should escalate, not specialize)
```

Return `{ speaker: winner, method: 'keyword', confidence, matched_terms }` only when `confidence ≥ 0.8` AND `total ≥ 1`. Below threshold or zero matches → fall through to Step 4.

### Step 4 — Haiku tiebreaker

Single Haiku 4.5 call. System prompt is constant (cacheable), user message is just the athlete's turn text. Output a single token from `{peter, carter, nora, remi}`.

```ts
const SYSTEM = `You route a single user message to one of four coaches.
- carter: strength training, lifts, RPE, programming, mobility execution
- nora:   food, macros, kcal, hydration, GLP-1 phase
- remi:   HRV, sleep, recovery, illness, soreness, strain
- peter:  cross-domain ("how am I doing"), block strategy, goal alignment, weekly review interpretation
Default to peter when the message is short, ambiguous, or spans 2+ domains.
Reply with a single lowercase word: carter, nora, remi, or peter. Nothing else.`;
```

- `max_tokens: 8`, `temperature: 0`
- 1.2s budget; on timeout / parse failure → `{ speaker: 'peter', method: 'fallback', confidence: 0.5 }`.
- Prompt-cache the system block (5-minute TTL is fine — chat usage is bursty).
- Model: `claude-haiku-4-5-20251001` (re-use `lib/anthropic/models.ts`; add `ROUTER_MODEL` constant).

Return `{ speaker, method: 'haiku', confidence: 1 }` on success.

### Step 5 — Mode gates

- `mode = 'intake'` → router is **bypassed**. Intake stays on Peter (existing behavior; the wizard is single-voice by design). The classifier is not called.
- `mode = 'plan_week' | 'setup_block'` → router runs normally. Weekly-planning tools are only on Peter's surface today, but routing into Carter for a "what should I do Wednesday" question is fine — Carter sees the mode but only has read tools (no propose_/commit_ for weekly planning), so he'll defer via `handoff_to('peter')` if the user asks him to commit.
- Default mode → router runs.

### Cost / latency

Expectation: keyword pass resolves ~80% of turns (chat data leans heavily into single-domain questions). Haiku tiebreaker hits ~20% with ~200-400ms added latency. Cost per Haiku call at the time of writing: ~$0.0002 input + ~$0.0001 output, negligible.

## 2. UI — composer coach picker

New component `components/chat/ChatCoachPicker.tsx`:

```
┌─────────────────────────────────────────────┐
│  ◌ Auto   👤 Peter   💪 Carter   🥗 Nora   😴 Remi  │   ← row above composer
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ Message Peter…                              │   ← composer (placeholder updates when locked)
└─────────────────────────────────────────────┘
```

- Auto is the default selection (visually distinct: empty circle + "Auto" label).
- Tapping a coach avatar sets `lockedSpeaker = speaker`. The composer placeholder updates to `Message <Name>…` and a small chip below the row shows "→ <Name>".
- Send fires the API with `speaker_override` in the body. The route forwards it to `classifyTurn` as `opts.override`.
- After a successful send, `lockedSpeaker` resets to `null` (auto). Visual: brief 200ms highlight on the Auto button so the user sees it snap back.
- Power-user fallback: typing `@Nora ` (or any of the four) at the start of the message also forces the route. Handled inside `classifyTurn`'s mention parse; no special composer logic needed.

The avatar visuals reuse the coach color tokens from [components/chat/SpeakerChip.tsx](../../../components/chat/SpeakerChip.tsx). Avatars are 32px circles with the coach's emoji or initials (placeholder — final iconography is out of scope here, can be polished later).

The picker is hidden in `intake` mode (single-voice wizard) and `setup_block` mode (Peter-only territory for block decisions). Visible in `default` and `plan_week`.

## 3. Mid-stream handoffs — generalized `handoff_to`

### Tool definition

Replace [lib/coach/delegate-tool.ts](../../../lib/coach/delegate-tool.ts) with `lib/coach/handoff-tool.ts`:

```ts
export const HANDOFF_TOOL_NAME = "handoff_to";

export const HANDOFF_TOOL = {
  name: HANDOFF_TOOL_NAME,
  description: `Hand the current turn off to another coach mid-answer. Use sparingly — most routing happens before the turn starts. Use this when, while drafting your reply, you realize the question genuinely belongs to a different coach's scope.
  - 'peter' for cross-domain synthesis, block-level strategy, weekly review interpretation, goal alignment
  - 'carter' for strength training execution within the current week
  - 'nora' for nutrition, macros, GLP-1 phase, hydration
  - 'remi' for HRV, sleep, recovery, illness, soreness
Cannot hand off to yourself. Call this as your FIRST move; tokens emitted before the tool call are discarded.`,
  input_schema: {
    type: "object" as const,
    required: ["target"],
    properties: {
      target: { type: "string", enum: ["peter", "carter", "nora", "remi"] },
      briefing: { type: "string", description: "Optional 1-2 sentence note framing the question for the receiving coach." },
    },
  },
};
```

### Tool partitioning change

In [lib/coach/tools.ts](../../../lib/coach/tools.ts), `toolsForSpeaker(speaker)` now appends `HANDOFF_TOOL` to **every** speaker's tool list (subject to mode gating — see below). Today the tool is Peter-only; new behavior is that all four can call it.

The intercept logic in `chat-stream.ts` already short-circuits the loop on any handoff, regardless of speaker, and yields `{ type: 'handoff', from: speaker, to: target, briefing }`. The route consumes the yield and spawns a fresh `runChatStream({ speaker: target })`.

### Mode gating

- `default` mode → `handoff_to` available on all speakers.
- `plan_week` mode → `handoff_to` available on all speakers (so Carter can hand to Peter for commit).
- `setup_block` mode → `handoff_to` available on all speakers. The picker is hidden in this mode, but the auto-classifier or an `@mention` can still route a specialist in; if that happens, the specialist needs `handoff_to('peter')` so they're not stuck telling the user in plain text to re-ask Peter.
- `intake` mode → `handoff_to` is hidden everywhere. Wizard is single-voice.

### Guard rails inside chat-stream

- Reject `target === speaker` with `{ type: 'error', message: 'invalid_handoff_target: self' }`.
- Reject `target` not in `SPEAKERS` (same as today).
- Cap handoff chain depth at **1** per turn (i.e., at most one handoff; the second speaker must answer in text or end the turn). Prevents infinite ping-pong if prompts misbehave. Tracked in `runChatStream` via a new `handoffDepth` opt (default 0, incremented by the route each time it re-enters after a `handoff` yield).

## 4. Prompt rewrites

### Peter — new framing

Drop "DELEGATE clearly-in-domain questions to the right specialist via the delegate_to_specialist tool" and the "delegate as your FIRST move" paragraph. Replace with:

> You are Peter, the Head Coach. You lead a team of three specialists — Carter (strength), Nora (nutrition), Remi (recovery and sleep). The athlete chats with the whole team; questions are routed to the right coach before the turn starts. **You see a turn when it's a cross-domain question, a block-level decision, weekly review interpretation, goal alignment, or the athlete addressed you directly.**
>
> When you answer:
> - Concrete numbers, specific dates, cite the snapshot or query results.
> - Reply concisely (2-5 sentences; longer for analysis).
> - Don't restate data the athlete just gave you, don't pad with disclaimers.
>
> Block-level decisions (next mesocycle, deload timing, goal shifts) are yours — call `propose_block` / `commit_block` when appropriate.
>
> If you realize mid-answer that this question is purely in one specialist's lane, call `handoff_to(target)` as your first move (pre-handoff tokens are discarded). Use this sparingly — pre-turn routing should have already picked the right coach.
>
> GLP-1 mode transitions, morning-brief regeneration: handle yourself.

### Carter / Nora / Remi — drop the "ask Peter" text

Replace each one's current "If a question requires cross-domain context, defer to Peter for cross-domain framing" with:

> When a question genuinely needs cross-domain framing (e.g., "is my low HRV because I'm not eating enough?"), call `handoff_to('peter')` as your first move — the orchestrator will switch the speaker and Peter will pick up the turn. Use sparingly: most cross-domain questions are routed to Peter before they reach you.

Tool partitioning rules (what columns Carter sees vs Nora vs Remi) are unchanged.

## 5. Audit trail

`chat_messages.kind = 'system_routing'` rows persist for every turn that has a non-trivial routing decision. Schema unchanged (the `ui` jsonb is free-form). New payload shape:

```ts
type RoutingAudit = {
  user_message_id: string;
  decided_speaker: Speaker;
  method: RouteMethod;
  confidence: number;
  matched_terms?: string[];
  override_source?: 'picker' | 'mention';
  handoff?: { from: Speaker; to: Speaker; briefing: string | null };
};
```

One row per turn. If a `handoff_to` fires mid-stream, write a **second** routing row with `handoff: { from, to, briefing }` and `method: 'haiku' | 'keyword' | …` carried forward (or `method: 'manual'` if the original was a manual route — the handoff is still the speaker's decision).

The existing `chat_messages_visible_idx` partial index filters routing rows out of history reads, so chat rendering is unaffected.

[scripts/audit-speaker-routing.mjs](../../../scripts/audit-speaker-routing.mjs) gets:

- Distribution of `method` values (manual / mention / keyword / haiku / fallback) across the last N turns.
- Per-speaker breakdown of what method routed to them.
- Cross-check: any messages where the keyword classifier was overruled by a manual pick → flag as "classifier disagreement"; these are the training signal for tuning keyword lists.

## 6. Data model

**No migration.** Everything reuses:
- `chat_messages.speaker` (added in `0024_coach_team.sql`).
- `chat_messages.kind = 'system_routing'` (already in the kind allowlist).
- `chat_messages.ui` jsonb (free-form; new audit fields slot in).

## 7. Error handling

| Failure | Behavior |
|---|---|
| Haiku tiebreaker times out (>1.2s) | Fall back to `{ speaker: 'peter', method: 'fallback', confidence: 0.5 }`. Logged at info level. |
| Haiku returns garbage (not one of the four names) | Same fallback. |
| Anthropic outage on Haiku call | Same fallback. Chat continues; only routing quality degrades. |
| Manual override speaker not in `SPEAKERS` | Reject the request with 400 before classify runs. |
| `@mention` matches but malformed | Treat as no mention; fall through to keyword. |
| Mid-stream handoff target invalid | Return `{ type: 'error', message: 'invalid_handoff_target' }`. The route ends the turn cleanly with the partial assistant message. |
| Handoff chain depth exceeded (>2) | Same error pattern. Audit row persists for both handoffs that did fire. |

The chat surface degrades gracefully: every classifier failure mode lands on Peter, who can answer any question.

## 8. Testing

No automated tests (no test suite in the repo). Verification plan:

1. **Manual chat smoke tests** for each routing path:
   - Pure strength question → Carter responds first, speaker chip = Carter.
   - Pure nutrition question → Nora.
   - Pure recovery question → Remi.
   - Cross-domain question ("am I on track for my goal?") → Peter.
   - Short greeting ("hi") → Peter (fallback).
   - Ambiguous question ("should I push hard today?") → Haiku decides; verify either Carter or Peter is plausible.
   - Manual override via picker → forces selected coach regardless of content.
   - `@Nora how much protein` → Nora.
   - Mid-stream handoff: send a clearly cross-domain question to Carter via picker → expect Carter to call `handoff_to('peter')` and Peter to take over with a HandoffLine.

2. **Audit script smoke**:
   ```
   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-speaker-routing.mjs
   ```
   Expect to see method distribution, no obvious mis-routings on a 24h sample.

3. **Type check**: `npm run typecheck` must pass.

4. **Build check**: `npm run build` must succeed.

## 9. Rollout

Code-only change. Single PR after the plan executes. No feature flag (single-user app). The user (Abdelouahed) is the only test population and can revert by checking out main if anything feels worse.

## 10. Open questions

None blocking. Polishing decisions deferred:
- Final coach iconography (emoji vs Lucide icon vs custom illustration).
- Whether the picker collapses into a single avatar when there's enough screen width for it to sit inline with the composer.
- Whether to surface the classifier's confidence in dev mode (e.g., a small "via keyword 0.92" hint) for tuning visibility.

## 11. Surfaces that stay Peter-narrated (per user requirement)

These are unaffected by this spec and continue to use Peter's voice:
- Weekly review narrative ([lib/coach/weekly-review/](../../../lib/coach/weekly-review/))
- Morning-brief advice block ([lib/morning/brief/](../../../lib/morning/brief/))
- Proactive nudges card prose ([lib/coach/proactive/render-card.ts](../../../lib/coach/proactive/render-card.ts))
- Plan-builder narrative ([lib/coach/plan-builder/narrative-prompt.ts](../../../lib/coach/plan-builder/narrative-prompt.ts))

The user-editable `profiles.system_prompt` remains Peter's prompt override; the three specialist prompts stay code-defined.
