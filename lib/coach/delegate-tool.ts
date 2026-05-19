// lib/coach/delegate-tool.ts
//
// DELEGATE_TOOL — Peter-only. Routes a question to a specialist coach.
// The orchestrator in lib/coach/chat-stream.ts INTERCEPTS this tool call
// (rather than executing it and feeding a tool_result back to Peter). It
// emits a 'handoff' SSE event, opens a fresh specialist stream with the
// specialist's system prompt + restricted tools, and pipes that stream
// back to the client.
//
// Why intercept rather than execute? Because Peter has no value to add
// after he's identified the right specialist — the specialist is the one
// who should answer. Two roundtrips (Peter → tool → Peter → text) would
// waste tokens and add latency for zero benefit.

export const DELEGATE_TOOL = {
  name: "delegate_to_specialist",
  description: `Route this question to a specialist coach with deeper domain expertise. Use when the user's question is clearly within one specialist's lane:
  - 'carter' for strength training, exercise programming, RPE/RIR, autoregulation, within-week training plan, mobility execution
  - 'nora' for food choices, macros, portion sizes, hydration, GLP-1 phase questions, micronutrient gaps
  - 'remi' for HRV interpretation, sleep quality, recovery interpretation, illness flags
For cross-domain questions ("should I push hard today?", "how is my block going?"), strategic block-level decisions, weekly review interpretation, or goal alignment — answer directly without delegating.

Call this as your FIRST move in the turn if you're going to delegate. Pre-delegation tokens are discarded by the orchestrator; the user sees a chip transition and the specialist's reply.`,
  input_schema: {
    type: "object" as const,
    required: ["specialist"],
    properties: {
      specialist: {
        type: "string",
        enum: ["carter", "nora", "remi"],
        description: "Which specialist owns this question.",
      },
      briefing: {
        type: "string",
        description: "Optional 1-2 sentence note framing the question for the specialist (e.g., 'athlete just finished a deload, asking about next mesocycle' or 'GLP-1 taper started Sunday, asking about protein targets'). Sets the specialist up for a sharper first answer.",
      },
    },
  },
};

export const DELEGATE_TOOL_NAME = "delegate_to_specialist";
