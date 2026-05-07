// lib/coach/chat-stream.ts
//
// Tool-aware Anthropic streaming for the chat coach.
//
// The hand-rolled streamClaude in lib/anthropic/client.ts doesn't process
// input_json_delta events (lib/anthropic/client.ts:183 explicitly drops them),
// so it can't accumulate tool_use blocks. We use the official SDK here
// because client.messages.stream() handles delta accumulation for us via
// finalMessage().
//
// Loop invariants:
//   * After each .stream() ends, if the final message contains tool_use
//     blocks, we execute them serially (disable_parallel_tool_use: true keeps
//     this deterministic), append tool_result blocks, and re-call .stream().
//   * Cap at 5 individual tool invocations. On the 6th attempt, restart with
//     tool_choice: { type: "none" } so the model HAS to write a final text.
//   * The async generator yields delta + tool_call_start/done + done/error
//     events that map 1:1 to the SSE wire format defined in lib/chat/sse.ts.
//
// userId is injected by the caller from supabase.auth.getUser() — model
// never passes it, executors enforce .eq("user_id", userId) (security
// invariants in lib/coach/tools.ts).

import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  executeQueryDailyLogs,
  executeQueryWorkouts,
  type ToolResult,
} from "@/lib/coach/tools";
import type { ToolCallLog } from "@/lib/data/types";
import type { ContentBlock, RichMessage } from "@/lib/chat/types";

const MODEL = "claude-sonnet-4-5";
const MAX_TOOL_INVOCATIONS = 5;
const MAX_TOKENS = 2000;

export type ChatStreamYield =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number }
  | { type: "done" }
  | { type: "error"; message: string };

export type RunChatStreamOpts = {
  userId: string;
  /** Already concatenated: SCHEMA_EXPLAINER + (user prompt or default). */
  systemPrompt: string;
  /** The full message history including cached snapshot prefix + ephemeral
   *  header + new user turn. The route assembles this. */
  messages: RichMessage[];
  /** AbortSignal from the request. Threaded into the SDK so cancelling
   *  closes the underlying HTTP connection. */
  signal: AbortSignal;
  /** Service-role client for tool execution. */
  sr: SupabaseClient;
  /** Mutable array; the loop pushes a ToolCallLog for each invocation so
   *  the route can persist it in its `finally` block. */
  toolCallSink: ToolCallLog[];
};

export async function* runChatStream(opts: RunChatStreamOpts): AsyncGenerator<ChatStreamYield> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const client = new Anthropic({ apiKey });
  // The SDK accepts a system prompt as a string OR typed blocks. We use the
  // typed-block form so we can attach cache_control for the prompt-cache.
  const system = [
    { type: "text" as const, text: opts.systemPrompt, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
  ];

  let invocations = 0;
  // Conversation state — we mutate this each round as the loop appends
  // assistant messages with tool_use blocks and the matching tool_result
  // user-message follow-ups.
  const messages: RichMessage[] = opts.messages.slice();

  while (true) {
    const forceText = invocations >= MAX_TOOL_INVOCATIONS;
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: [DAILY_LOGS_TOOL, WORKOUTS_TOOL],
        tool_choice: forceText ? { type: "none" } : { type: "auto" },
        disable_parallel_tool_use: true,
        messages: messages as Anthropic.MessageParam[],
      },
      { signal: opts.signal },
    );

    // Pipe deltas to the caller as they arrive.
    try {
      for await (const ev of stream) {
        if (opts.signal.aborted) {
          yield { type: "error", message: "aborted" };
          return;
        }
        if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta" &&
          typeof ev.delta.text === "string"
        ) {
          yield { type: "delta", text: ev.delta.text };
        }
        // Other events (input_json_delta, content_block_start, message_stop)
        // are accumulated by the SDK; we read the final assembled message
        // below via finalMessage().
      }
    } catch (e) {
      if (e instanceof APIUserAbortError) {
        yield { type: "error", message: "aborted" };
        return;
      }
      const msg = (e as Error).message ?? "stream_error";
      yield { type: "error", message: `anthropic_stream: ${msg}` };
      return;
    }

    let finalMsg: Anthropic.Message;
    try {
      finalMsg = await stream.finalMessage();
    } catch (e) {
      yield { type: "error", message: `anthropic_finalize: ${(e as Error).message}` };
      return;
    }

    // Identify any tool_use blocks the model emitted in this round.
    const toolUseBlocks = finalMsg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // No tool calls → we're done.
    if (toolUseBlocks.length === 0 || forceText) {
      yield { type: "done" };
      return;
    }

    // Append the assistant message verbatim (it has both text and tool_use
    // blocks) — required so subsequent rounds reference the right tool_use_id.
    messages.push({
      role: "assistant",
      content: finalMsg.content as unknown as ContentBlock[],
    });

    // Execute each tool_use block serially. disable_parallel_tool_use is
    // already set, so this loop sees at most one block per round in practice.
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      invocations++;
      yield {
        type: "tool_call_start",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };

      const t0 = Date.now();
      let result: ToolResult<unknown>;
      try {
        if (block.name === "query_daily_logs") {
          result = await executeQueryDailyLogs({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "query_workouts") {
          result = await executeQueryWorkouts({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else {
          result = {
            ok: false,
            error: { error: `unknown_tool: ${block.name}` },
            meta: { ms: Date.now() - t0, range_days: 0 },
          };
        }
      } catch (e) {
        result = {
          ok: false,
          error: { error: `executor_threw: ${(e as Error).message}` },
          meta: { ms: Date.now() - t0, range_days: 0 },
        };
      }
      const elapsed = Date.now() - t0;

      // Persist into the sink so the route's finally block writes it.
      opts.toolCallSink.push({
        name: block.name as ToolCallLog["name"],
        input: (block.input ?? {}) as Record<string, unknown>,
        ms: elapsed,
        result_rows: result.ok ? result.meta.result_rows : 0,
        range_days: result.meta.range_days,
        truncated: result.ok ? result.meta.truncated : false,
        error: result.ok ? null : result.error.error,
      });

      yield { type: "tool_call_done", id: block.id, ok: result.ok, ms: elapsed };

      // Convert to tool_result block for the next round.
      const content = result.ok ? result.data : result.error;
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(content),
        is_error: !result.ok,
      });
    }

    // Append all tool_results as a single user message — Anthropic requires
    // them in one user turn between assistant tool_use and the next assistant
    // turn.
    messages.push({
      role: "user",
      content: toolResultBlocks as unknown as ContentBlock[],
    });
    // Loop back; next stream() call will see the tool_result and either
    // call another tool or emit the final text.
  }
}
