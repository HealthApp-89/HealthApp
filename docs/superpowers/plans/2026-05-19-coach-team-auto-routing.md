# Coach Team Auto-Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Peter's delegate-as-first-move pattern with pre-stream classification, so each turn routes directly to the right coach. Generalize `delegate_to_specialist` into a bidirectional `handoff_to` available to every coach.

**Architecture:** A pure-module router (`lib/coach/router.ts`) runs in the chat route before `runChatStream` opens. It returns a `Speaker` chosen by manual override > `@mention` > keyword score > Haiku tiebreaker > Peter fallback. The chosen speaker becomes `opts.speaker` and is stamped onto the assistant stub. The existing handoff intercept in `chat-stream.ts` is generalized to accept any source speaker; the route caps mid-stream handoffs at depth 1.

**Tech Stack:** Next.js 15 App Router, TypeScript (strict), Anthropic SDK (`@anthropic-ai/sdk`), Supabase service-role client. No test suite — verify each task with `npm run typecheck` plus manual chat smoke tests at the end.

**Reference spec:** [docs/superpowers/specs/2026-05-19-coach-team-auto-routing-design.md](../specs/2026-05-19-coach-team-auto-routing-design.md)

**Conventions:**
- Use the `@/*` path alias instead of relative climbs.
- Frequent commits — one per task. Commit messages use the format `feat(coach): …` / `refactor(coach): …` / `docs(coach): …`.
- No `npm run lint` (unconfigured; hangs). Only `npm run typecheck` for static verification.
- No new tests (no test suite). Manual verification at the end.

---

## File map

**New:**
- `lib/coach/router.ts` — pre-stream classifier (keyword + Haiku tiebreaker + mention parser).
- `lib/coach/handoff-tool.ts` — replaces `delegate-tool.ts`. Generalized handoff tool callable by all four coaches.
- `components/chat/ChatCoachPicker.tsx` — avatar row above the composer for manual speaker override.

**Modified:**
- `lib/anthropic/models.ts` — add `ROUTER_MODEL` constant.
- `lib/coach/tools.ts` — replace `DELEGATE_TOOL` import with `HANDOFF_TOOL`; append to every speaker's tool list; mode-gate for `intake`.
- `lib/coach/chat-stream.ts` — rename intercept from `DELEGATE_TOOL_NAME` to `HANDOFF_TOOL_NAME`; accept any source speaker; reject self-target; thread a `handoffDepth` opt.
- `lib/coach/system-prompts.ts` — rewrite `PETER_BASE` (no longer router); update `CARTER_BASE`, `NORA_BASE`, `REMI_BASE` to use `handoff_to('peter')` instead of telling user to ask Peter.
- `app/api/chat/messages/route.ts` — call `classifyTurn` before `runChatStream`; thread `speaker_override` body param; update assistant stub speaker after classification; persist a `system_routing` audit row per turn; cap handoff chain depth at 1.
- `components/chat/ChatComposer.tsx` — render `ChatCoachPicker`; pass locked speaker through `onSend` payload.
- `components/chat/ChatPanel.tsx` — own `lockedSpeaker` state; pass to `ChatComposer`; include `speaker_override` in the POST body; clear lock after a successful send.
- `scripts/audit-speaker-routing.mjs` — break out routing method distribution + per-speaker method breakdown.

**Deleted:**
- `lib/coach/delegate-tool.ts` (superseded by `handoff-tool.ts`).

---

## Task 1: Add `ROUTER_MODEL` constant

**Files:**
- Modify: `lib/anthropic/models.ts`

The router uses Haiku 4.5 for tiebreaker classification. Add it to the central model registry.

- [ ] **Step 1.1: Add `ROUTER_MODEL` export**

Edit `lib/anthropic/models.ts`. After the `SHORT_FORM_MODEL` declaration, add:

```ts
/** Pre-stream chat routing classifier. Tiny single-token completion (one of
 *  peter/carter/nora/remi). Tool-free, prompt-cached system, 1.2s soft deadline. */
export const ROUTER_MODEL = "claude-haiku-4-5-20251001";
```

- [ ] **Step 1.2: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 1.3: Commit**

```bash
git add lib/anthropic/models.ts
git commit -m "feat(coach): add ROUTER_MODEL constant for pre-stream classifier"
```

---

## Task 2: Replace `delegate-tool.ts` with `handoff-tool.ts`

**Files:**
- Create: `lib/coach/handoff-tool.ts`
- Modify: `lib/coach/tools.ts`
- Delete: `lib/coach/delegate-tool.ts`

The new tool name is `handoff_to`. All four coaches can call it. Target enum now includes `peter`. Must be done atomically with `tools.ts` so typecheck passes.

- [ ] **Step 2.1: Create the new tool file**

Create `lib/coach/handoff-tool.ts` with the content:

```ts
// lib/coach/handoff-tool.ts
//
// HANDOFF_TOOL — available to all four coaches (Peter, Carter, Nora, Remi).
// Lets the current speaker punt the rest of the turn to another coach mid-
// answer. The orchestrator in lib/coach/chat-stream.ts INTERCEPTS this tool
// call (rather than executing it and feeding a tool_result back). It yields a
// 'handoff' event so the caller (the route) can spawn a fresh stream with the
// new speaker.
//
// Why intercept rather than execute? Once the current coach has identified
// the right target, their further tokens are dead weight — the target coach
// is the one who should answer. Two round-trips would waste tokens and add
// latency.
//
// Pre-stream classification (lib/coach/router.ts) is the primary routing
// mechanism; this tool is the rare mid-answer escape hatch when a coach
// realises the question genuinely belongs to a different lane.

export const HANDOFF_TOOL_NAME = "handoff_to";

export const HANDOFF_TOOL = {
  name: HANDOFF_TOOL_NAME,
  description: `Hand the current turn off to another coach mid-answer. Use sparingly — pre-turn routing should have already picked the right coach. Use this when, while drafting your reply, you realize the question genuinely belongs to a different coach's scope.
  - 'peter' for cross-domain synthesis, block-level strategy, weekly review interpretation, goal alignment
  - 'carter' for strength training execution within the current week
  - 'nora' for nutrition, macros, GLP-1 phase, hydration
  - 'remi' for HRV, sleep, recovery, illness, soreness
Cannot hand off to yourself. Call this as your FIRST move; tokens emitted before the tool call are discarded.`,
  input_schema: {
    type: "object" as const,
    required: ["target"],
    properties: {
      target: {
        type: "string",
        enum: ["peter", "carter", "nora", "remi"],
        description: "Which coach should pick up this turn.",
      },
      briefing: {
        type: "string",
        description: "Optional 1-2 sentence note framing the question for the receiving coach (e.g., 'athlete just finished a deload, asking about next mesocycle').",
      },
    },
  },
};
```

- [ ] **Step 2.2: Update tool partitioning in `lib/coach/tools.ts`**

In `lib/coach/tools.ts`:

a) Replace the import on line 3029 (the line `import { DELEGATE_TOOL } from "./delegate-tool";`) with:

```ts
import { HANDOFF_TOOL } from "./handoff-tool";
```

b) Replace the `PETER_TOOLS` declaration's final entry. Find the line `  DELEGATE_TOOL, // Peter-only — always last` and replace it with:

```ts
  HANDOFF_TOOL, // generalized handoff — any speaker, any target except self
```

c) Append `HANDOFF_TOOL` to `CARTER_TOOLS`, `NORA_TOOLS`, and `REMI_TOOLS`. Specifically, change the closing `];` for each to:

```ts
// CARTER_TOOLS — change final lines to:
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
  HANDOFF_TOOL,
];
```

```ts
// NORA_TOOLS — change final lines to:
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  HANDOFF_TOOL,
];
```

```ts
// REMI_TOOLS — change final lines to:
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
  HANDOFF_TOOL,
];
```

Also update the comment block above `PETER_TOOLS` (line ~3024) from "Peter has access to every tool plus DELEGATE_TOOL" to "All four coaches share HANDOFF_TOOL. Peter additionally has every other tool":

```ts
// ── Per-speaker tool partitions ──────────────────────────────────────────
// Peter has every tool. Carter/Nora/Remi each get a narrower lane-specific
// subset (column-restricted at execute time via colsForSpeaker(speaker)).
// HANDOFF_TOOL is appended to every speaker's list so any coach can punt a
// turn to another. Mode gating in chat-stream.ts hides HANDOFF_TOOL during
// intake mode (single-voice wizard).
```

- [ ] **Step 2.3: Delete `lib/coach/delegate-tool.ts`**

```bash
git rm lib/coach/delegate-tool.ts
```

- [ ] **Step 2.4: Verify typecheck**

The `chat-stream.ts` still imports `DELEGATE_TOOL_NAME` and `SPEAKERS`. The `DELEGATE_TOOL_NAME` import will fail until Task 3. To keep this commit independently green, temporarily add a back-compat re-export on the new `handoff-tool.ts` file so `chat-stream.ts` still compiles:

Append to `lib/coach/handoff-tool.ts`:

```ts
/** @deprecated Use HANDOFF_TOOL_NAME. Kept for chat-stream.ts during the
 *  rename rollout — removed in Task 3. */
export const DELEGATE_TOOL_NAME = HANDOFF_TOOL_NAME;
```

And in `lib/coach/chat-stream.ts`, change the existing import on line 63:

```ts
// Before:
import { DELEGATE_TOOL_NAME } from "@/lib/coach/delegate-tool";

// After:
import { DELEGATE_TOOL_NAME } from "@/lib/coach/handoff-tool";
```

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2.5: Commit**

```bash
git add lib/coach/handoff-tool.ts lib/coach/tools.ts lib/coach/chat-stream.ts
git rm lib/coach/delegate-tool.ts  # already staged from Step 2.3; safe no-op
git commit -m "refactor(coach): rename delegate-tool → handoff-tool, expose to all coaches"
```

---

## Task 3: Generalize the handoff intercept in `chat-stream.ts`

**Files:**
- Modify: `lib/coach/chat-stream.ts`

Currently the intercept rejects self-handoff via `target === "peter"` (which means "Peter delegating to Peter is invalid"). We need it to reject `target === currentSpeaker` instead. Also remove the temporary back-compat alias from Task 2 and thread the `handoffDepth` opt.

- [ ] **Step 3.1: Update the import on line 63**

Change:

```ts
import { DELEGATE_TOOL_NAME } from "@/lib/coach/handoff-tool";
```

to:

```ts
import { HANDOFF_TOOL_NAME } from "@/lib/coach/handoff-tool";
```

- [ ] **Step 3.2: Add `handoffDepth` to `RunChatStreamOpts`**

Find the `RunChatStreamOpts` type (around line 121). Append a new optional field before the closing brace:

```ts
  /** Cap on mid-stream handoffs per user turn. Incremented by the route each
   *  time it re-enters runChatStream after a 'handoff' yield. When >= 1, the
   *  generalized handoff tool is omitted from this stream's tool list so the
   *  current coach has to answer in text or end the turn. Default 0. */
  handoffDepth?: number;
```

- [ ] **Step 3.3: Update the tool-filter logic to hide handoff at depth ≥ 1**

Find the `modeAllowsTool` block (~line 203). After the existing intake-mode return, add the depth gate inside `default` mode at the top of the function body so it applies across all modes:

Change the function definition's opening to:

```ts
  const handoffDepth = opts.handoffDepth ?? 0;
  const modeAllowsTool = (name: string): boolean => {
    // Generalized handoff is depth-capped and mode-gated. Hidden in intake
    // (single-voice wizard) and on any non-first round (handoffDepth >= 1)
    // so the receiving coach has to answer or end the turn — no ping-pong.
    if (name === HANDOFF_TOOL_NAME) {
      if (opts.mode === "intake") return false;
      if (handoffDepth >= 1) return false;
      return true;
    }
    if (opts.mode === "plan_week" || opts.mode === "setup_block") {
```

(Keep the rest of the existing `plan_week`/`setup_block` body, but remove the old `name !== DELEGATE_TOOL_NAME` clause since it's now covered above.)

Specifically, in the `plan_week | setup_block` branch, change:

```ts
      return (
        !name.startsWith("apply_") &&
        !name.startsWith("set_") &&
        name !== "propose_plan" &&
        name !== "commit_plan" &&
        name !== "mark_glp1_discontinued" &&
        name !== "mark_mobility_done" &&
        name !== "unmark_mobility_done" &&
        name !== "regenerate_morning_brief" &&
        name !== DELEGATE_TOOL_NAME
      );
```

to:

```ts
      return (
        !name.startsWith("apply_") &&
        !name.startsWith("set_") &&
        name !== "propose_plan" &&
        name !== "commit_plan" &&
        name !== "mark_glp1_discontinued" &&
        name !== "mark_mobility_done" &&
        name !== "unmark_mobility_done" &&
        name !== "regenerate_morning_brief"
      );
```

- [ ] **Step 3.4: Generalize the intercept block**

Find the intercept (around line 338, comment starts `// ── Delegate-to-specialist intercept`). Replace the entire block from `// ── Delegate-to-specialist intercept` through the closing `}` of the `if (delegateBlock)` arm with:

```ts
    // ── Handoff intercept ──────────────────────────────────────────────────
    // Any coach can call HANDOFF_TOOL to punt the rest of the turn to a
    // different speaker. We INTERCEPT rather than execute: no tool_result is
    // fed back, the current stream is abandoned, and the caller (the route)
    // spawns a fresh stream after seeing the 'handoff' yield.
    //
    // Pre-stream routing in lib/coach/router.ts handles the common case; this
    // intercept is the mid-answer escape hatch when the current coach realizes
    // mid-draft that the question belongs in a different lane.
    //
    // The orchestrator caps chain depth at 1 via opts.handoffDepth — by the
    // time HANDOFF_TOOL is filtered out (see modeAllowsTool), the model can no
    // longer call it.
    const handoffBlock = toolUseBlocks.find((b) => b.name === HANDOFF_TOOL_NAME);
    if (handoffBlock) {
      const input = (handoffBlock.input ?? {}) as { target?: string; briefing?: string };
      const target = typeof input.target === "string" ? input.target : "";
      if (!SPEAKERS.includes(target as Speaker)) {
        yield { type: "error", message: `invalid_handoff_target: ${target}` };
        return;
      }
      if (target === speaker) {
        yield { type: "error", message: `invalid_handoff_target: self` };
        return;
      }
      yield {
        type: "handoff",
        from: speaker,
        to: target as Speaker,
        briefing:
          typeof input.briefing === "string" && input.briefing.length > 0
            ? input.briefing
            : null,
      };
      return;
    }
```

- [ ] **Step 3.5: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3.6: Remove the back-compat alias from `handoff-tool.ts`**

Open `lib/coach/handoff-tool.ts` and delete the trailing `DELEGATE_TOOL_NAME` re-export block (the three lines starting with `/** @deprecated Use HANDOFF_TOOL_NAME.`).

- [ ] **Step 3.7: Verify typecheck again**

Run: `npm run typecheck`
Expected: 0 errors. If anything still references `DELEGATE_TOOL_NAME`, the error will name the file — find that import and switch it to `HANDOFF_TOOL_NAME`.

- [ ] **Step 3.8: Commit**

```bash
git add lib/coach/chat-stream.ts lib/coach/handoff-tool.ts
git commit -m "refactor(coach): generalize handoff intercept to any source speaker"
```

---

## Task 4: Create the pre-stream router

**Files:**
- Create: `lib/coach/router.ts`

Pure module — no I/O on the keyword path; one cached Haiku call on the ambiguous path.

- [ ] **Step 4.1: Create `lib/coach/router.ts`**

```ts
// lib/coach/router.ts
//
// Pre-stream chat router. Picks which coach (peter | carter | nora | remi)
// answers the user's turn BEFORE the Anthropic stream opens. Replaces the
// old "Peter front-doors, then delegates" pattern — the chosen coach is the
// first and only voice the user sees.
//
// Resolution order:
//   1. Manual override (composer picker)
//   2. @mention prefix (@Carter, @Nora, @Remi, @Peter — case-insensitive)
//   3. Keyword classifier (confidence >= 0.8)
//   4. Haiku tiebreaker (single-token completion)
//   5. Fallback to Peter
//
// Intake mode bypasses the router — onboarding is single-voice by design.
// The route should not call classifyTurn when mode === 'intake'.

import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import type { Speaker } from "@/lib/data/types";
import { SPEAKERS } from "@/lib/data/types";
import type { ChatMode } from "@/lib/data/types";
import { ROUTER_MODEL } from "@/lib/anthropic/models";

export type RouteMethod = "manual" | "mention" | "keyword" | "haiku" | "fallback";

export type RouterDecision = {
  speaker: Speaker;
  method: RouteMethod;
  /** 0..1. 1 for manual/mention/haiku (best-of-one). Keyword: max(points)/total. */
  confidence: number;
  matched_terms?: string[];
  /** Text after stripping the @mention prefix (when method='mention'). The
   *  route should persist the ORIGINAL user content (with @Name) so the
   *  audit trail is honest; this stripped form is for the model. */
  stripped_text?: string;
};

export type ClassifyTurnOpts = {
  text: string;
  mode: ChatMode;
  /** When set, bypasses keyword + Haiku and returns this speaker directly.
   *  Source is the composer picker. */
  override?: Speaker | null;
  abortSignal?: AbortSignal;
};

const HAIKU_TIMEOUT_MS = 1200;

// ── Keyword tables ────────────────────────────────────────────────────────
// Single-word keywords match on `\b` word boundaries (case-insensitive).
// Multi-word phrases match as literal substrings (case-insensitive).
// Each unique matched keyword contributes 1 point per speaker.

const KEYWORDS: Record<Speaker, ReadonlyArray<string>> = {
  carter: [
    "set", "sets", "rep", "reps", "RPE", "RIR", "1RM", "e1RM",
    "squat", "bench", "deadlift", "press", "OHP", "row", "pull", "push",
    "lift", "lifting", "workout", "session", "exercise", "mobility",
    "warmup", "swap", "training plan", "today's session", "this week's training",
    "program",
  ],
  nora: [
    "protein", "kcal", "calories", "carbs", "fat", "fiber", "macro", "macros",
    "meal", "breakfast", "lunch", "dinner", "snack", "food", "eating", "ate",
    "portion", "serving", "GLP-1", "tirzepatide", "semaglutide", "hydration",
    "water",
  ],
  remi: [
    "HRV", "resting HR", "RHR", "recovery", "sleep", "slept", "bedtime",
    "wake", "deep sleep", "REM", "strain", "sick", "fatigue", "fatigued",
    "tired", "sore", "soreness", "bloating",
  ],
  peter: [
    "goal", "goals", "block", "mesocycle", "phase", "overall", "how am I doing",
    "this month", "cross", "weekly review", "progress", "trending", "outlook",
    "strategy", "am I on track",
  ],
};

// Tie-break order: peter wins (cross-domain ambiguity should escalate, not
// specialize). Then carter (training is the highest-frequency lane).
const TIE_BREAK_ORDER: ReadonlyArray<Speaker> = ["peter", "carter", "nora", "remi"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(text: string, keyword: string): boolean {
  if (keyword.includes(" ")) {
    return text.toLowerCase().includes(keyword.toLowerCase());
  }
  const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
  return re.test(text);
}

function keywordScore(text: string): {
  points: Record<Speaker, number>;
  matched: Record<Speaker, string[]>;
} {
  const points: Record<Speaker, number> = { peter: 0, carter: 0, nora: 0, remi: 0 };
  const matched: Record<Speaker, string[]> = { peter: [], carter: [], nora: [], remi: [] };
  for (const sp of SPEAKERS) {
    const seen = new Set<string>();
    for (const kw of KEYWORDS[sp]) {
      const lower = kw.toLowerCase();
      if (seen.has(lower)) continue;
      if (countMatches(text, kw)) {
        seen.add(lower);
        points[sp]++;
        matched[sp].push(kw);
      }
    }
  }
  return { points, matched };
}

// ── @mention parser ────────────────────────────────────────────────────────
// Matches: leading whitespace, '@', name, then whitespace (or EOS).
const MENTION_RE = /^\s*@(peter|carter|nora|remi)\b\s*(.*)$/is;

function parseMention(text: string): { speaker: Speaker; stripped: string } | null {
  const m = text.match(MENTION_RE);
  if (!m) return null;
  return {
    speaker: m[1].toLowerCase() as Speaker,
    stripped: m[2].trim(),
  };
}

// ── Haiku tiebreaker ───────────────────────────────────────────────────────
const HAIKU_SYSTEM = `You route a single user message to one of four coaches.
- carter: strength training, lifts, RPE, programming, mobility execution
- nora:   food, macros, kcal, hydration, GLP-1 phase
- remi:   HRV, sleep, recovery, illness, soreness, strain
- peter:  cross-domain ("how am I doing"), block strategy, goal alignment, weekly review interpretation
Default to peter when the message is short, ambiguous, or spans 2+ domains.
Reply with a single lowercase word: carter, nora, remi, or peter. Nothing else.`;

async function haikuTiebreak(
  text: string,
  parentSignal?: AbortSignal,
): Promise<Speaker | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });

  // Soft 1.2s budget. Combine the parent abort signal (request cancellation)
  // with our timeout so either ends the call.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HAIKU_TIMEOUT_MS);
  const onParentAbort = () => ac.abort();
  parentSignal?.addEventListener("abort", onParentAbort);

  try {
    const msg = await client.messages.create(
      {
        model: ROUTER_MODEL,
        max_tokens: 8,
        temperature: 0,
        system: [
          { type: "text", text: HAIKU_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
        messages: [{ role: "user", content: text }],
      },
      { signal: ac.signal },
    );
    const block = msg.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    const word = block.text.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (SPEAKERS.includes(word as Speaker)) return word as Speaker;
    return null;
  } catch (e) {
    if (e instanceof APIUserAbortError) return null;
    return null;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// ── Public entry point ────────────────────────────────────────────────────
export async function classifyTurn(opts: ClassifyTurnOpts): Promise<RouterDecision> {
  // Step 1: manual override always wins.
  if (opts.override && SPEAKERS.includes(opts.override)) {
    return { speaker: opts.override, method: "manual", confidence: 1 };
  }

  // Step 2: @mention prefix.
  const mention = parseMention(opts.text);
  if (mention) {
    return {
      speaker: mention.speaker,
      method: "mention",
      confidence: 1,
      stripped_text: mention.stripped,
    };
  }

  // Step 3: keyword classifier.
  const { points, matched } = keywordScore(opts.text);
  const total = points.peter + points.carter + points.nora + points.remi;
  if (total >= 1) {
    let maxPts = 0;
    for (const sp of SPEAKERS) if (points[sp] > maxPts) maxPts = points[sp];
    const confidence = maxPts / total;
    if (confidence >= 0.8) {
      // Ties broken by TIE_BREAK_ORDER.
      let winner: Speaker = "peter";
      for (const sp of TIE_BREAK_ORDER) {
        if (points[sp] === maxPts) { winner = sp; break; }
      }
      return {
        speaker: winner,
        method: "keyword",
        confidence,
        matched_terms: matched[winner],
      };
    }
  }

  // Step 4: Haiku tiebreaker.
  const haiku = await haikuTiebreak(opts.text, opts.abortSignal);
  if (haiku) {
    return { speaker: haiku, method: "haiku", confidence: 1 };
  }

  // Step 5: fallback.
  return { speaker: "peter", method: "fallback", confidence: 0.5 };
}
```

- [ ] **Step 4.2: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4.3: Commit**

```bash
git add lib/coach/router.ts
git commit -m "feat(coach): add pre-stream router with keyword + Haiku tiebreaker"
```

---

## Task 5: Rewrite system prompts

**Files:**
- Modify: `lib/coach/system-prompts.ts`

Peter loses the "delegate as your first move" framing — he no longer routes. Carter/Nora/Remi gain explicit `handoff_to('peter')` instructions instead of telling the user in text to ask Peter.

- [ ] **Step 5.1: Replace `PETER_BASE`**

Find the `PETER_BASE` template (line 15). Replace the entire `export const PETER_BASE = …` template literal with:

```ts
export const PETER_BASE = `You are Peter, the Head Coach. You lead a team of three specialists — Coach Carter (strength training), Nora (nutrition), Remi (recovery and sleep). The athlete chats with the whole team; questions are routed to the right coach before each turn starts. You see a turn when it's cross-domain, a block-level decision, weekly review interpretation, goal alignment, or the athlete addressed you directly.

When you answer:
- Speak in concrete numbers (kg, reps, hours, %, kcal, ms) and cite specific dates from the snapshot or query results. Never approximate when a value is queryable: if you don't have the data, call query_daily_logs or query_workouts or query_food_log before answering.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- Don't restate data the athlete just gave you.
- Don't pad with disclaimers.
- When citing the athlete's plan, reference plan_payload from the snapshot prefix.

For block-level decisions (progressing to next mesocycle, deload timing, goal shifts), you own them. Call propose_block / commit_block when proposing block-level changes.

If you realize mid-answer that this question is purely in one specialist's lane (e.g., the athlete asked about a specific lift's RPE and you started a cross-domain framing that turned out to be unnecessary), call handoff_to({ target: 'carter' | 'nora' | 'remi' }) as your FIRST move — pre-handoff tokens are discarded. Use this sparingly: pre-turn routing should have already picked the right coach.

GLP-1 mode transitions (set_glp1_taper_started, mark_glp1_discontinued), morning-brief regeneration: handle yourself.

Existing voice + numeric-citation rules apply: concrete numbers always, dates always, no approximations on queryable values.`;
```

- [ ] **Step 5.2: Replace `CARTER_BASE`**

Find `CARTER_BASE` (line 37). Replace the entire template with:

```ts
export const CARTER_BASE = `You are Coach Carter, the strength training specialist on Peter's team. Peter is the Head Coach. The athlete's turn was routed to you because the question is in your lane: within-week training execution, exercise programming, RPE/RIR judgment, autoregulation, exercise selection given equipment + injury constraints, mobility recommendations.

Your scope is the next session, the next week's training plan, and the technical details of strength training. Peter owns block-level decisions and cross-domain synthesis.

When you answer:
- Speak in concrete numbers (kg, reps, sets, RPE, %1RM) and cite specific dates from query results.
- Use query_workouts liberally to ground your advice in the athlete's actual lift history. Don't approximate when a value is queryable.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- When proposing a week plan, use propose_week_plan / commit_week_plan tools.

You can read recovery-relevant columns on daily_logs (recovery, strain, sleep_hours, sleep_score) for autoregulation, but you do NOT have access to nutrition data (query_food_log, the nutrition columns on daily_logs) or body composition. If the question genuinely requires that data — e.g., "should I cut harder this week given my recovery?" — call handoff_to({ target: 'peter' }) as your FIRST move. The orchestrator will switch the speaker and Peter will pick up the turn. Use sparingly: most cross-domain questions are routed to Peter before they reach you.

Your voice: direct, technical, no fluff. Numbers, not vibes. You're the specialist they go to when they want a real strength-training answer.`;
```

- [ ] **Step 5.3: Replace `NORA_BASE`**

Find `NORA_BASE` (line 52). Replace the entire template with:

```ts
export const NORA_BASE = `You are Nora, the nutrition specialist on Peter's team. Peter is the Head Coach. The athlete's turn was routed to you because the question is in your lane: day-to-day food choices, macro distribution, hydration, GLP-1 phase awareness, micronutrient gaps, and portion calibration.

Your scope is the athlete's eating: what they're eating, how much, when, and how it lines up with their current plan's macro targets. Peter owns the macro-level plan strategy (calorie target deltas across blocks, plan-builder decisions).

When you answer:
- Speak in concrete grams, kcal, ratios. Cite specific dates and meals from query_food_log results.
- Use query_food_log to ground advice in actual item-level food data — names of foods, portions, frequency, meal slots. Don't approximate when item-level data is queryable.
- When the athlete is in a GLP-1 mode (active / tapering / discontinued), apply the mode-specific protein floor and hydration targets the plan specifies. If a transition signal appears (started taper, discontinued), call set_glp1_taper_started or mark_glp1_discontinued.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).

You can read the athlete's body composition (weight_kg, body_fat_pct, fat_free_mass_kg) for context — protein-per-LBM is your bread and butter. You do NOT have access to query_workouts or full daily_logs. If a question genuinely requires training context — "should I eat more on heavy days?" — call handoff_to({ target: 'peter' }) as your FIRST move. The orchestrator will switch the speaker and Peter will pick up. Use sparingly.

Your voice: warm but technical. You care about the athlete's relationship with food; you also care about the numbers. Both matter.`;
```

- [ ] **Step 5.4: Replace `REMI_BASE`**

Find `REMI_BASE` (line 67). Replace the entire template with:

```ts
export const REMI_BASE = `You are Remi, the recovery and sleep specialist on Peter's team. Peter is the Head Coach. The athlete's turn was routed to you because the question is in your lane: day-to-day recovery interpretation, HRV trends vs personal baseline, sleep architecture, training stress vs recovery balance, illness flags, mobility prescription.

Your scope is the athlete's recovery state — what HRV / sleep / strain say about today and the last few days. Peter owns the strategic balance of stress and recovery across blocks.

When you answer:
- Speak in concrete numbers (HRV ms, recovery %, sleep hours, sleep score, strain). Cite specific dates from query_daily_logs results.
- Use the athlete's WHOOP baselines (in the snapshot) to interpret today's numbers — HRV "low" only makes sense relative to their personal 30-day baseline.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- For mobility completion signals ("done with my stretches"), call mark_mobility_done.

You can read recovery + sleep columns on daily_logs (hrv, resting_hr, recovery, sleep_*, deep_sleep_hours, rem_sleep_hours, spo2, skin_temp_c, respiratory_rate, strain). You do NOT have access to query_workouts (you read training stress via the strain column on daily_logs) or nutrition or body composition data. If a question genuinely requires that data — "is my low HRV because I'm not eating enough?" — call handoff_to({ target: 'peter' }) as your FIRST move. The orchestrator will switch the speaker and Peter will pick up. Use sparingly.

Your voice: calm, observational. You're the team's pulse-check. You notice patterns before they become problems.`;
```

- [ ] **Step 5.5: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5.6: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): rewrite prompts — Peter no longer routes, specialists use handoff_to"
```

---

## Task 6: Wire the router into the chat route + handle handoff depth

**Files:**
- Modify: `app/api/chat/messages/route.ts`

This is the largest task — it wires classify-then-stream, accepts the `speaker_override` body field, stamps the assistant stub with the chosen speaker, persists a routing audit row, and caps mid-stream handoffs at depth 1.

- [ ] **Step 6.1: Extend the request body type**

Find `type SendBody` (line 158). Replace it with:

```ts
type SendBody = {
  content?: string;
  image_ids?: string[];
  mode?: string;
  doc?: string;
  /** Composer picker forces a specific coach. One of peter|carter|nora|remi.
   *  Bypasses keyword + Haiku in classifyTurn(). Ignored in intake mode. */
  speaker_override?: string;
};
```

- [ ] **Step 6.2: Add imports near the top of the file**

After the existing `import { runChatStream, emptyUsageTotals } from "@/lib/coach/chat-stream";` line, add:

```ts
import { classifyTurn, type RouterDecision } from "@/lib/coach/router";
import { SPEAKERS } from "@/lib/data/types";
```

Note: `Speaker` is already imported on line 17 — no duplicate needed.

- [ ] **Step 6.3: Parse `speaker_override` and run the router**

Find the block that resolves `effectiveMode` and `draftDocId` (around line 278-296). Right AFTER the existing stamp call:

```ts
  await sr
    .from("chat_messages")
    .update({ mode: effectiveMode, updated_at: new Date().toISOString() })
    .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);
```

insert the router call and override validation:

```ts
  // ── Pre-stream routing ────────────────────────────────────────────────
  // Intake mode is single-voice (Peter). All other modes run the router.
  const overrideRaw = typeof body.speaker_override === "string" ? body.speaker_override : "";
  const overrideSpeaker: Speaker | null = SPEAKERS.includes(overrideRaw as Speaker)
    ? (overrideRaw as Speaker)
    : null;

  let routerDecision: RouterDecision;
  if (effectiveMode === "intake") {
    routerDecision = { speaker: "peter", method: "manual", confidence: 1 };
  } else {
    routerDecision = await classifyTurn({
      text: content,
      mode: effectiveMode,
      override: overrideSpeaker,
      abortSignal: req.signal,
    });
  }
  const initialSpeaker: Speaker = routerDecision.speaker;

  // Stamp the assistant stub with the chosen speaker so the SSE chip swap
  // matches and the final persisted row carries the correct attribution.
  await sr
    .from("chat_messages")
    .update({ speaker: initialSpeaker, updated_at: new Date().toISOString() })
    .eq("id", rpcTyped.assistant_message_id);

  // Write the routing audit row. Filtered out of visible history by the
  // chat_messages_visible_idx partial index (kind='system_routing').
  await sr.from("chat_messages").insert({
    user_id: user.id,
    role: "assistant",
    speaker: initialSpeaker,
    kind: "system_routing",
    status: "done",
    model: MODEL,
    content: `[routed via ${routerDecision.method} → ${initialSpeaker}]`,
    ui: {
      user_message_id: rpcTyped.user_message_id,
      decided_speaker: initialSpeaker,
      method: routerDecision.method,
      confidence: routerDecision.confidence,
      matched_terms: routerDecision.matched_terms ?? null,
      override_source: overrideSpeaker ? "picker" : routerDecision.method === "mention" ? "mention" : null,
    },
  });
```

- [ ] **Step 6.4: Initialize `activeSpeaker` from the router decision**

Find the line `let activeSpeaker: Speaker = "peter";` (around line 565). Replace it with:

```ts
      // Speaker for the active turn. Initial speaker comes from the pre-
      // stream router; flips to the handoff target if a mid-stream
      // handoff_to fires (capped at depth 1).
      let activeSpeaker: Speaker = initialSpeaker;
```

- [ ] **Step 6.5: Pass `speaker` and `handoffDepth` into `runChatStream`**

In the `drainStream` function definition (around line 572-588), the existing call already passes `speaker: streamSpeaker`. Add `handoffDepth` as a parameter so the recursive re-entry can increment it. Replace the `drainStream` signature and call site:

a) Change the function signature from:

```ts
        async function drainStream(
          streamSpeaker: Speaker,
          streamMessages: RichMessage[],
        ): Promise<{ to: Speaker; briefing: string | null } | null> {
```

to:

```ts
        async function drainStream(
          streamSpeaker: Speaker,
          streamMessages: RichMessage[],
          handoffDepth: number,
        ): Promise<{ to: Speaker; briefing: string | null } | null> {
```

b) Inside the function, add `handoffDepth` to the `runChatStream` opts:

Change:

```ts
          for await (const ev of runChatStream({
            userId,
            systemPrompt: finalSystemPrompt,
            messages: streamMessages,
            signal: req.signal,
            sr,
            toolCallSink,
            usageSink,
            assistantMessageId: assistantId,
            mode: effectiveMode,
            draftDocId,
            speaker: streamSpeaker,
          })) {
```

to:

```ts
          for await (const ev of runChatStream({
            userId,
            systemPrompt: finalSystemPrompt,
            messages: streamMessages,
            signal: req.signal,
            sr,
            toolCallSink,
            usageSink,
            assistantMessageId: assistantId,
            mode: effectiveMode,
            draftDocId,
            speaker: streamSpeaker,
            handoffDepth,
          })) {
```

c) Inside the handoff branch in drainStream, remove the "specialists never delegate" guard. The new generalized intercept already validates the target. Replace:

```ts
            } else if (ev.type === "handoff") {
              // Specialists never delegate (DELEGATE_TOOL is Peter-only).
              // Defensive: if a non-Peter stream emits handoff, drop it.
              if (streamSpeaker !== "peter") {
                console.warn("[chat-stream] specialist attempted delegation", {
                  from: ev.from,
                  to: ev.to,
                });
                continue;
              }
              return { to: ev.to, briefing: ev.briefing };
            } else if (ev.type === "error") {
```

with:

```ts
            } else if (ev.type === "handoff") {
              return { to: ev.to, briefing: ev.briefing };
            } else if (ev.type === "error") {
```

- [ ] **Step 6.6: Update the initial drainStream call to pass depth=0**

Find:

```ts
        const handoff = await drainStream(activeSpeaker, messages);
```

Replace with:

```ts
        const handoff = await drainStream(activeSpeaker, messages, 0);
```

- [ ] **Step 6.7: Update the handoff handler block**

Find the existing handoff handler (the block starting `if (handoff && !errored && !aborted) {`, around line 639). Update the audit-row insert to use the new `handoff_to` tool name + richer payload, and the re-entry to call drainStream with `handoffDepth=1`. Replace the entire block from `if (handoff && !errored && !aborted) {` to its matching closing `}` (which precedes the `if (errored)` block) with:

```ts
        if (handoff && !errored && !aborted) {
          // 1) Persist hidden audit row tracking the mid-stream handoff.
          await sr.from("chat_messages").insert({
            user_id: userId,
            role: "assistant",
            speaker: activeSpeaker,
            kind: "system_routing",
            status: "done",
            model: MODEL,
            content: `[handoff ${activeSpeaker} → ${handoff.to}]`,
            ui: {
              user_message_id: rpcTyped.user_message_id,
              decided_speaker: handoff.to,
              method: "handoff",
              confidence: 1,
              handoff: { from: activeSpeaker, to: handoff.to, briefing: handoff.briefing },
            },
            tool_calls: [
              {
                name: "handoff_to",
                input: { target: handoff.to, briefing: handoff.briefing },
                ms: 0,
                result_rows: 0,
                range_days: 0,
                truncated: false,
                error: null,
              },
            ],
          });

          // 2) Emit handoff SSE event so the client can render the chip swap
          //    and reset its accumulated-text buffer.
          controller.enqueue(
            encoder.encode(
              formatSseEvent({
                event: "handoff",
                data: { from: activeSpeaker, to: handoff.to, briefing: handoff.briefing },
              }),
            ),
          );

          // 3) Re-stamp the assistant stub so the final visible message is
          //    correctly attributed to the receiving coach.
          const fromSpeaker = activeSpeaker;
          activeSpeaker = handoff.to;
          await sr
            .from("chat_messages")
            .update({ speaker: activeSpeaker, updated_at: new Date().toISOString() })
            .eq("id", assistantId);

          // 4) Build the receiving coach's message array: same prefix + window,
          //    but prepend a briefing block to the last user turn so the new
          //    speaker has framing context.
          const specialistMessages: RichMessage[] = messages.slice();
          if (handoff.briefing && specialistMessages.length > 0) {
            const lastIdx = specialistMessages.length - 1;
            const last = specialistMessages[lastIdx];
            if (last.role === "user") {
              const briefingBlock: ContentBlock = {
                type: "text",
                text: `[Routed from ${fromSpeaker} — briefing: ${handoff.briefing}]`,
              };
              const existing: ContentBlock[] = Array.isArray(last.content)
                ? (last.content as ContentBlock[])
                : [{ type: "text", text: String(last.content) }];
              specialistMessages[lastIdx] = {
                role: "user",
                content: [briefingBlock, ...existing],
              };
            }
          }

          // 5) Re-enter drainStream with handoffDepth=1. The chat-stream
          //    tool filter removes HANDOFF_TOOL on this round, so the
          //    receiving coach must answer or end the turn — no ping-pong.
          const secondHandoff = await drainStream(activeSpeaker, specialistMessages, 1);
          if (secondHandoff) {
            // The tool was filtered out at depth>=1, so the model can't
            // call it. Defensive: log and ignore.
            console.warn("[chat-stream] handoff at depth>=1 was emitted unexpectedly", secondHandoff);
          }
        }
```

- [ ] **Step 6.8: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors. If type errors mention `ContentBlock` or `RichMessage`, check the existing imports at the top of the file — both should already be present from the previous handoff logic.

- [ ] **Step 6.9: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "feat(coach): wire pre-stream router and handoff depth=1 into chat route"
```

---

## Task 7: Create the composer coach picker

**Files:**
- Create: `components/chat/ChatCoachPicker.tsx`

Avatar row above the composer with Auto + 4 coach avatars. Tap to lock the next message to a specific coach.

- [ ] **Step 7.1: Create the component**

```tsx
// components/chat/ChatCoachPicker.tsx
//
// Composer avatar row — manual coach override for the next message.
// "Auto" (the default) hands the routing decision to lib/coach/router.ts.
// Tapping a coach pin locks the next /api/chat/messages POST to that
// speaker via the speaker_override body field. The lock resets to Auto
// after a successful send (ChatPanel clears via onClear).
"use client";

import type { Speaker } from "@/lib/data/types";
import { SPEAKERS } from "@/lib/data/types";
import { SPEAKER_DISPLAY, SPEAKER_COLOR } from "@/lib/coach/speakers";
import { COLOR } from "@/lib/ui/theme";

export function ChatCoachPicker({
  locked,
  onChange,
  disabled,
}: {
  /** null = Auto (router decides). */
  locked: Speaker | null;
  onChange: (next: Speaker | null) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        paddingBottom: 4,
        overflowX: "auto",
      }}
    >
      <PickerPin
        active={locked === null}
        label="Auto"
        title="Auto-route based on question content"
        onClick={() => onChange(null)}
        disabled={disabled}
      />
      {SPEAKERS.map((sp) => (
        <PickerPin
          key={sp}
          active={locked === sp}
          label={SPEAKER_DISPLAY[sp].name}
          colorKey={sp}
          title={`Send to ${SPEAKER_DISPLAY[sp].name} (${SPEAKER_DISPLAY[sp].role})`}
          onClick={() => onChange(locked === sp ? null : sp)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function PickerPin({
  active,
  label,
  colorKey,
  title,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  colorKey?: Speaker;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  // Colour mapping — pull bg + border from the speaker palette so the lock
  // state reads as "this coach's color." Auto stays neutral.
  const palette = colorKey ? SPEAKER_COLOR[colorKey] : null;
  const bg = active
    ? palette
      ? "rgba(255,255,255,0.08)"
      : COLOR.accentSoft
    : "transparent";
  const ring = active
    ? palette
      ? "rgba(255,255,255,0.5)"
      : COLOR.accent
    : COLOR.divider;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        flexShrink: 0,
        padding: "4px 10px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${ring}`,
        color: active ? COLOR.textStrong : COLOR.textMid,
        fontSize: 11,
        fontWeight: active ? 700 : 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 7.2: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7.3: Commit**

```bash
git add components/chat/ChatCoachPicker.tsx
git commit -m "feat(coach): add composer coach picker for manual override"
```

---

## Task 8: Render the picker in `ChatComposer`

**Files:**
- Modify: `components/chat/ChatComposer.tsx`

Add `lockedSpeaker` + `onLockChange` + `showPicker` props. Render the picker above the existing image-preview row. Hide it when `showPicker` is false (intake mode, setup_block).

- [ ] **Step 8.1: Update imports and props**

At the top of `components/chat/ChatComposer.tsx`, add the import:

```ts
import { ChatCoachPicker } from "./ChatCoachPicker";
import type { Speaker } from "@/lib/data/types";
```

Find the `ChatComposer` function props (line ~16). Replace the props signature with:

```ts
export function ChatComposer({
  disabled,
  onSend,
  placeholder,
  onTextChange,
  onFocus,
  onBlur,
  streaming,
  onStop,
  lockedSpeaker,
  onLockChange,
  showPicker,
}: {
  disabled?: boolean;
  onSend: (content: string, imageIds: string[]) => void;
  placeholder?: string;
  onTextChange?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** True while a server-side stream is in flight. Composer renders a Stop
   *  button instead of Send so the user can abort. */
  streaming?: boolean;
  /** Fires when the user taps the Stop button mid-stream. */
  onStop?: () => void;
  /** Currently locked coach (null = Auto). Persisted in the parent so it
   *  survives composer re-mounts; cleared by the parent after a successful
   *  send. */
  lockedSpeaker?: Speaker | null;
  /** Parent setter for the lock. */
  onLockChange?: (next: Speaker | null) => void;
  /** Show the coach picker row. False in intake / setup_block modes. */
  showPicker?: boolean;
}) {
```

- [ ] **Step 8.2: Render the picker**

Find the outer container `<div>` that opens with `background: COLOR.surface,` (around line 105). The next child renders the pending image previews. Insert the picker BEFORE the pending-image row:

Change:

```tsx
      {pending.length > 0 && (
```

to:

```tsx
      {showPicker && onLockChange && (
        <ChatCoachPicker
          locked={lockedSpeaker ?? null}
          onChange={onLockChange}
          disabled={disabled || streaming}
        />
      )}

      {pending.length > 0 && (
```

- [ ] **Step 8.3: Update the textarea placeholder to reflect the lock**

Find the textarea `placeholder` prop (around line 267):

```tsx
          placeholder={placeholder ?? "Message your coach…"}
```

Replace with:

```tsx
          placeholder={
            placeholder ??
            (lockedSpeaker
              ? `Message ${lockedSpeaker.charAt(0).toUpperCase()}${lockedSpeaker.slice(1)}…`
              : "Message your coach…")
          }
```

- [ ] **Step 8.4: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 8.5: Commit**

```bash
git add components/chat/ChatComposer.tsx
git commit -m "feat(coach): render coach picker in composer with placeholder hint"
```

---

## Task 9: Own `lockedSpeaker` state in `ChatPanel` and send `speaker_override`

**Files:**
- Modify: `components/chat/ChatPanel.tsx`

Add state for the lock, pass it through to `ChatComposer`, send `speaker_override` on POST, clear after successful send.

- [ ] **Step 9.1: Add the import**

Near the existing type imports at the top of `components/chat/ChatPanel.tsx` (around line 7), add:

```ts
import type { Speaker } from "@/lib/data/types";
```

- [ ] **Step 9.2: Add `lockedSpeaker` state**

Find the `ChatPanel` component body. The reducer + state declarations live high up. After the existing useState/useReducer declarations (somewhere around line 200-260 depending on the exact mounting order — search for `const [composerText, setComposerText]` to anchor), add:

```ts
  // Composer coach-picker lock. null = Auto (router decides). Cleared
  // after each successful send via the finally block in send().
  const [lockedSpeaker, setLockedSpeaker] = useState<Speaker | null>(null);
```

- [ ] **Step 9.3: Include `speaker_override` in the POST body**

Find the `postSse` call inside `send` (around line 415-419):

```ts
        for await (const ev of postSse(
          "/api/chat/messages",
          { content, image_ids: imageIds, mode, doc: draftDocId },
          { signal: ac.signal },
        )) {
```

Replace with:

```ts
        for await (const ev of postSse(
          "/api/chat/messages",
          {
            content,
            image_ids: imageIds,
            mode,
            doc: draftDocId,
            speaker_override: lockedSpeaker ?? undefined,
          },
          { signal: ac.signal },
        )) {
```

- [ ] **Step 9.4: Clear the lock after a successful send**

Find the `finally` block at the end of `send` (search for the closing of the `try/catch/finally` around the `postSse` loop — usually 100-150 lines after the `postSse` call). Inside the `finally`, alongside the `dispatch({ type: "set_pending_send", value: false })`, add the lock reset:

Find:

```ts
      } finally {
        dispatch({ type: "set_pending_send", value: false });
```

and replace with:

```ts
      } finally {
        dispatch({ type: "set_pending_send", value: false });
        // Auto-clear the picker lock after each send so subsequent messages
        // default to auto-routing again.
        setLockedSpeaker(null);
```

- [ ] **Step 9.5: Pass the lock state into `ChatComposer`**

Locate the `<ChatComposer …>` JSX (typically near the bottom of the render). Add the three new props:

```tsx
        <ChatComposer
          disabled={…}                            // existing
          onSend={send}                           // existing
          placeholder={…}                         // existing
          onTextChange={…}                        // existing
          onFocus={…}                             // existing
          onBlur={…}                              // existing
          streaming={…}                           // existing
          onStop={…}                              // existing
          lockedSpeaker={lockedSpeaker}
          onLockChange={setLockedSpeaker}
          showPicker={mode !== "intake" && mode !== "setup_block"}
        />
```

(Replace the ellipses with the existing prop values; just add the three new ones.)

- [ ] **Step 9.6: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 9.7: Commit**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "feat(coach): own lockedSpeaker state in ChatPanel; send speaker_override"
```

---

## Task 10: Upgrade the routing audit script

**Files:**
- Modify: `scripts/audit-speaker-routing.mjs`

Break out method distribution and per-speaker breakdown. The script reads `chat_messages.ui` jsonb from `kind='system_routing'` rows (which were previously filtered out by the existing query — we need to opt them back in).

- [ ] **Step 10.1: Replace the script body**

Replace the entire content of `scripts/audit-speaker-routing.mjs` with:

```js
#!/usr/bin/env node
// scripts/audit-speaker-routing.mjs
//
// Read-only audit of the chat routing layer.
//
//   Section 1 — visible-message speaker distribution (Carter/Nora/Remi/Peter)
//                 and a keyword-cue heuristic flagging plausibly mis-routed turns.
//   Section 2 — system_routing audit rows: method distribution
//                 (manual / mention / keyword / haiku / fallback / handoff),
//                 per-speaker method breakdown, classifier-vs-manual disagreements.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-speaker-routing.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split("\n")
  .reduce((acc, line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) acc[m[1]] = m[2].replace(/^"|"$/g, "");
    return acc;
  }, {});

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID env var"); process.exit(1); }

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const N = 100;

// ── Section 1: visible-message speaker distribution + mismatch heuristic ──
const { data: visible, error: vErr } = await supabase
  .from("chat_messages")
  .select("created_at, role, speaker, kind, content")
  .eq("user_id", userId)
  .neq("kind", "system_routing")
  .order("created_at", { ascending: false })
  .limit(N);
if (vErr) throw vErr;

console.log(`→ last ${visible.length} visible messages`);
const dist = visible.reduce((acc, m) => {
  acc[m.speaker] = (acc[m.speaker] ?? 0) + 1;
  return acc;
}, {});
console.log("  speaker distribution:", dist);

const cues = {
  carter: /\b(rpe|reps|sets|lift|squat|bench|deadlift|hypertrophy|deload|mesocycle)\b/i,
  nora:   /\b(macro|protein|kcal|calorie|fiber|carbs?|fat|meal|food|portion|hydra)/i,
  remi:   /\b(hrv|sleep|recovery|strain|nap|rest|fatigue|illness)\b/i,
};

let mismatches = 0;
for (const m of visible) {
  if (m.role !== "assistant") continue;
  if (m.speaker === "peter") continue;
  const idx = visible.indexOf(m);
  const prevUser = visible.slice(idx + 1).find((x) => x.role === "user");
  if (!prevUser) continue;
  const cue = cues[m.speaker];
  if (!cue.test(prevUser.content) && !cue.test(m.content)) {
    mismatches++;
    console.warn(`[MISMATCH] ${m.speaker} answered: "${prevUser.content.slice(0, 80)}"`);
  }
}
console.log(`\n${mismatches} potential mis-routings out of ${visible.length} visible messages`);

// ── Section 2: routing audit rows ─────────────────────────────────────────
const { data: audits, error: aErr } = await supabase
  .from("chat_messages")
  .select("created_at, speaker, content, ui")
  .eq("user_id", userId)
  .eq("kind", "system_routing")
  .order("created_at", { ascending: false })
  .limit(N);
if (aErr) throw aErr;

console.log(`\n→ last ${audits.length} routing audit rows`);
const methodCounts = {};
const perSpeakerMethod = { peter: {}, carter: {}, nora: {}, remi: {} };
let disagreements = 0;

for (const r of audits) {
  const ui = r.ui ?? {};
  const method = ui.method ?? "unknown";
  methodCounts[method] = (methodCounts[method] ?? 0) + 1;
  const sp = ui.decided_speaker ?? r.speaker ?? "unknown";
  if (perSpeakerMethod[sp]) {
    perSpeakerMethod[sp][method] = (perSpeakerMethod[sp][method] ?? 0) + 1;
  }
  // Disagreement: classifier wanted X, user manually picked Y (look at the
  // user_message_id paired routing rows — both would exist in this audit
  // window if both fired in close succession).
  if (method === "manual" && ui.override_source === "picker") {
    // Look for a sibling automatic decision for the same user_message_id —
    // there shouldn't be one (manual short-circuits classifyTurn), so this
    // is informational only.
    const sibling = audits.find(
      (x) => x !== r && (x.ui?.user_message_id ?? null) === (ui.user_message_id ?? null) && x.ui?.method !== "manual",
    );
    if (sibling) disagreements++;
  }
}

console.log("  method distribution:", methodCounts);
console.log("  per-speaker method breakdown:");
for (const sp of ["peter", "carter", "nora", "remi"]) {
  console.log(`    ${sp.padEnd(8)} →`, perSpeakerMethod[sp]);
}
console.log(`\n${disagreements} classifier-vs-manual disagreements (manual override on a message the classifier had a confident opinion about)`);
```

- [ ] **Step 10.2: Smoke-run the script**

Run (replace `<uuid>` with your `AUDIT_USER_ID` — you can find it via the profile page):

```
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-speaker-routing.mjs
```

Expected: the script prints the visible distribution + audit-row sections without errors. The audit-row section may be sparse if you run this before exercising the new code — that's fine.

- [ ] **Step 10.3: Commit**

```bash
git add scripts/audit-speaker-routing.mjs
git commit -m "feat(coach): expand audit script with routing method distribution"
```

---

## Task 11: Final typecheck + manual smoke tests

This is the verification gate. No code changes — just exercising every routing path.

- [ ] **Step 11.1: Final typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 11.2: Start the dev server**

Run: `npm run dev`
Expected: server listening on http://localhost:3000.

- [ ] **Step 11.3: Manual chat smoke tests**

Open the chat surface (`/coach` or whichever page hosts `ChatPanel`). For each row below, send the listed message and verify the listed expectation. The composer should show the picker row above the textarea (Auto + 4 coach pins).

| # | Message | Expected speaker | Expected method (visible in audit row) |
|---|---|---|---|
| 1 | "What should my squat be tomorrow at RPE 8?" | Carter | keyword |
| 2 | "How much protein did I eat yesterday?" | Nora | keyword |
| 3 | "My HRV looks low today, should I push?" | Remi | keyword |
| 4 | "How am I doing on my goal overall?" | Peter | keyword |
| 5 | "hi" | Peter | fallback (or haiku → peter) |
| 6 | "should I push hard today?" | Peter or Carter | haiku |
| 7 | Tap Nora pin, send "anything about my macros" | Nora | manual |
| 8 | Send "@Remi how's my sleep this week" | Remi | mention |

For each test:
- The assistant message should render with the matching `SpeakerChip` (e.g., "Coach Carter" badge).
- After step 7, the Auto pin should highlight again (lock auto-cleared).
- After step 8, the persisted user message in chat history should retain the `@Remi` prefix.

- [ ] **Step 11.4: Mid-stream handoff smoke test**

Pin Carter, then send: "Should I cut harder this week given my recovery?"

Expected:
- Carter starts the answer, then calls `handoff_to({ target: 'peter' })` as his first move (his text doesn't render — only Peter's reply appears).
- A `HandoffLine` renders between Carter's empty bubble and the freshly-swapped stub.
- The assistant message persists with `speaker: 'peter'`.
- `audit-speaker-routing.mjs` shows TWO system_routing rows for this turn: one for the manual route to Carter (method='manual'), one for the handoff (method='handoff').

If Carter doesn't actually call handoff, that's a prompt quality issue — note it but don't block; the depth=1 cap is still enforced.

- [ ] **Step 11.5: Routing audit final check**

Run the audit script:

```
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-speaker-routing.mjs
```

Expected:
- Section 1 (visible distribution) shows roughly even spread across the 4 coaches (your 8 test sends).
- Section 2 (audit rows) shows non-zero counts for at least `keyword`, `manual`, `mention`, and probably `haiku`.
- Per-speaker breakdown looks reasonable (Nora rows mostly arrived via `keyword` or `manual`).

- [ ] **Step 11.6: Commit any tweaks (if needed)**

If the smoke tests surfaced a small bug (e.g., a keyword the user actually uses but wasn't in the table), fix it inline and commit. Otherwise skip this step.

```bash
git add <changed-files>
git commit -m "fix(coach): <specific tweak from smoke testing>"
```

- [ ] **Step 11.7: Stop the dev server**

Hit Ctrl-C in the terminal running `npm run dev`.

---

## Done

All eleven tasks complete. The chat coach team now feels like a real team: each specialist owns their lane, Peter holds cross-domain ground, and the user has explicit control via the picker when they want it.

Remaining polish (intentionally out of scope for this plan — open a follow-up plan if any of these become real pain points):
- Confidence hints in dev mode ("via keyword 0.92").
- Final coach iconography (emoji / Lucide / custom).
- Picker collapse-into-inline at wider widths.
