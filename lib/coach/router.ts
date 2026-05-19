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
