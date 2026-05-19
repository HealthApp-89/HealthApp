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
