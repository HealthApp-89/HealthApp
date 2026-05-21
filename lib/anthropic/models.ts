// lib/anthropic/models.ts
//
// Central registry of Claude model IDs in use across the app. Every other
// module imports from here so upgrades land in one place — without this,
// bumping Sonnet 4-5 → 4-6 means hunting through 8+ call sites and missing
// at least one.
//
// Named by ROLE, not by model name, so the role's semantics survive a model
// upgrade. E.g. CHAT_MODEL is whatever we're shipping the live tool-using
// coach chat on this week; today that's Sonnet 4-5, tomorrow it might be
// Sonnet 4-6 or Sonnet 5.

/** Tool-using conversational coach (live chat + morning intake LLM tail).
 *  Needs broad capability + function-calling. */
export const CHAT_MODEL = "claude-sonnet-4-6";

/** High-quality narrative wrappers around deterministic skeletons:
 *  weekly review prose, plan-builder plan narrative. No tool use. */
export const NARRATIVE_MODEL = "claude-sonnet-4-6";

/** Single-completion advice + opener generation. Fast + cheap; no tools,
 *  short outputs (≤350 output tokens). */
export const SHORT_FORM_MODEL = "claude-haiku-4-5-20251001";

/** Pre-stream chat routing classifier. Tiny single-token completion (one of
 *  peter/carter/nora/remi). Tool-free, prompt-cached system, 1.2s soft deadline. */
export const ROUTER_MODEL = "claude-haiku-4-5-20251001";

/** Default for the bare `callClaude` helper when no model is specified.
 *  Matches CHAT_MODEL by convention; callers needing a specific role should
 *  import the named constant. */
export const DEFAULT_MODEL = CHAT_MODEL;
