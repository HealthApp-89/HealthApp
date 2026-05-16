// lib/coach/fabrication-check.ts
//
// Post-stream observability pass: extract numerics from an assistant chat
// turn and flag any that don't appear in the model's provable sources
// (snapshot prefix, tool_call results, recent window messages, the user's
// latest message, or a small whitelist of calendar/conversational integers).
//
// Non-blocking by design. The weekly-review narrative has a similar but
// HARD validator (throws on fabrication, regenerates); chat is too
// open-ended for that — the model might cite a number from the rolling
// window or the user's last message, both of which it legitimately has
// in context. Instead we log flagged numbers in the chat_turn structured
// log so we can audit fabrication rate weekly and decide whether to
// tighten the system prompt, sample-flag specific tools, etc.

import type { ToolCallLog } from "@/lib/data/types";

/** Allowed: integers ≤ 31. These are calendar days, small set counts,
 *  "next 3 weeks" filler, etc. */
const SMALL_INT_TOLERANCE = 31;

/** Extract every numeric literal from a string (integer or decimal). */
function extractNumbers(s: string): string[] {
  if (!s) return [];
  return s.match(/\d+(?:\.\d+)?/g) ?? [];
}

function addNumberWithTolerance(set: Set<string>, raw: string): void {
  set.add(raw);
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  // Integer ±1 tolerance accounts for natural-language rounding ("172.99" → "173").
  const rounded = Math.round(n);
  set.add(String(rounded));
  set.add(String(rounded - 1));
  set.add(String(rounded + 1));
  // Also accept the one-decimal form (e.g. 4 → 4.0) and trimmed form.
  set.add(n.toFixed(1));
  set.add(String(n));
}

function collectFromObject(obj: unknown, out: Set<string>): void {
  if (obj == null) return;
  if (typeof obj === "number") {
    addNumberWithTolerance(out, String(obj));
    return;
  }
  if (typeof obj === "string") {
    for (const m of extractNumbers(obj)) addNumberWithTolerance(out, m);
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) collectFromObject(v, out);
    return;
  }
  if (typeof obj === "object") {
    for (const v of Object.values(obj)) collectFromObject(v, out);
  }
}

export type FabricationSources = {
  /** Full snapshot prefix text (profile + 14d daily_logs + workouts). */
  snapshot: string;
  /** Tool execution logs from the turn. Inputs + results both contribute. */
  toolCalls: ToolCallLog[];
  /** Texts of recent window messages and the user's new turn. */
  recentMessageTexts: string[];
};

/** Returns the numeric literals from `assistantText` that are NOT present
 *  in any source, after ±1 integer tolerance and a ≤31 small-int allow. */
export function findFabricatedNumbers(
  assistantText: string,
  sources: FabricationSources,
): string[] {
  const allowed = new Set<string>();

  // Snapshot — pull numerics from the raw text.
  for (const m of extractNumbers(sources.snapshot)) addNumberWithTolerance(allowed, m);

  // Tool calls — both input args and results may carry numerics the model
  // legitimately surfaced. Result is `unknown` when persisted; we walk.
  for (const t of sources.toolCalls) {
    collectFromObject(t.input, allowed);
    collectFromObject(t.result, allowed);
  }

  // Recent messages (window + user's new turn).
  for (const text of sources.recentMessageTexts) {
    for (const m of extractNumbers(text)) addNumberWithTolerance(allowed, m);
  }

  const found = extractNumbers(assistantText);
  const flagged: string[] = [];
  for (const m of found) {
    if (allowed.has(m)) continue;
    const n = Number(m);
    if (!Number.isFinite(n)) continue;
    // Small integers always pass — calendar days, "3 sets", "2 weeks".
    if (Number.isInteger(n) && n <= SMALL_INT_TOLERANCE) continue;
    if (Number.isInteger(n)) {
      const r = Math.round(n);
      if (allowed.has(String(r)) || allowed.has(String(r - 1)) || allowed.has(String(r + 1))) continue;
    }
    flagged.push(m);
  }
  return flagged;
}
