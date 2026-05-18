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
  FOOD_LOG_TOOL,
  TRAINING_PLAN_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  PROPOSE_BLOCK_TOOL,
  COMMIT_BLOCK_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  APPLY_GOAL_TARGET_TOOL,
  APPLY_BEDTIME_CORRECTION_TOOL,
  APPLY_MACROS_CORRECTION_TOOL,
  APPLY_PROTEIN_CORRECTION_TOOL,
  SET_SANITY_OVERRIDE_TOOL,
  SET_GOAL_NARRATIVE_CHAT_TOOL,
  SET_DIRECTNESS_TOOL,
  SET_CADENCE_TOOL,
  SET_CHRONOTYPE_TOOL,
  SET_UNPROMPTED_ACTIONS_TOOL,
  SET_FREE_FORM_CONSTRAINTS_TOOL,
  PROPOSE_PLAN_TOOL,
  COMMIT_PLAN_TOOL,
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  MARK_MOBILITY_DONE_TOOL,
  UNMARK_MOBILITY_DONE_TOOL,
  REGENERATE_MORNING_BRIEF_TOOL,
  executeQueryDailyLogs,
  executeQueryWorkouts,
  executeQueryFoodLog,
  executeQueryTrainingPlan,
  executeGetAutoregulationSignals,
  executeComputeAdherence,
  executeProposeBlock,
  executeCommitBlock,
  executeProposeWeekPlan,
  executeCommitWeekPlan,
  executeApplyGoalTarget,
  executeApplyBedtimeCorrection,
  executeApplyMacrosCorrection,
  executeApplyProteinCorrection,
  executeSetSanityOverride,
  executeSetGoalNarrativeChat,
  executeSetDirectness,
  executeSetCadence,
  executeSetChronotype,
  executeSetUnpromptedActions,
  executeSetFreeFormConstraints,
  executeProposePlan,
  executeCommitPlan,
  executeSetGlp1Status,
  executeSetGlp1TaperStarted,
  executeMarkGlp1Discontinued,
  executeMarkMobilityDone,
  executeUnmarkMobilityDone,
  executeRegenerateMorningBrief,
  type ToolResult,
} from "@/lib/coach/tools";
import type { ChatMode, ToolCallLog } from "@/lib/data/types";
import type { ContentBlock, RichMessage } from "@/lib/chat/types";

import { CHAT_MODEL as MODEL } from "@/lib/anthropic/models";

const PERSIST_RESULT_TOOLS = new Set([
  "propose_block",
  "commit_block",
  "propose_week_plan",
  "commit_week_plan",
  "propose_plan",
  "commit_plan",
]);
function shouldPersistResult(name: string): boolean {
  return PERSIST_RESULT_TOOLS.has(name);
}
const MAX_TOOL_INVOCATIONS = 5;
const MAX_TOKENS = 2000;

export type ChatStreamYield =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number }
  | { type: "done" }
  | { type: "error"; message: string };

/** Cumulative Anthropic API token usage across all rounds of a chat turn.
 *  Read by the route's finally block for structured logging — lets us track
 *  prompt-cache hit rate, input/output tokens, and per-turn cost without
 *  blocking the stream itself. */
export type ChatUsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  rounds: number;
};

export function emptyUsageTotals(): ChatUsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    rounds: 0,
  };
}

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
  /** The assistant stub message id, used by commit_week_plan to populate
   *  training_weeks.chat_message_id for traceability. */
  assistantMessageId?: string | null;
  /** Chat mode — controls which tools are exposed to the model.
   *  Default mode hides propose_ and commit_ tools to prevent accidental plan writes. */
  mode?: ChatMode;
  /** Athlete-profile draft document id; required for intake-mode tools
   *  (apply_*, set_*, propose_plan, commit_plan). Caller sets this when
   *  serving an /onboarding chat turn. Null/undefined in default/planning modes. */
  draftDocId?: string | null;
  /** Mutable totals; the loop adds each round's finalMsg.usage. Read by the
   *  route after the stream ends to log prompt-cache hit rate. */
  usageSink?: ChatUsageTotals;
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

  const allTools = [
    DAILY_LOGS_TOOL,
    WORKOUTS_TOOL,
    FOOD_LOG_TOOL,
    TRAINING_PLAN_TOOL,
    AUTOREGULATION_TOOL,
    ADHERENCE_TOOL,
    PROPOSE_BLOCK_TOOL,
    COMMIT_BLOCK_TOOL,
    PROPOSE_WEEK_PLAN_TOOL,
    COMMIT_WEEK_PLAN_TOOL,
    APPLY_GOAL_TARGET_TOOL,
    APPLY_BEDTIME_CORRECTION_TOOL,
    APPLY_MACROS_CORRECTION_TOOL,
    APPLY_PROTEIN_CORRECTION_TOOL,
    SET_SANITY_OVERRIDE_TOOL,
    SET_GOAL_NARRATIVE_CHAT_TOOL,
    SET_DIRECTNESS_TOOL,
    SET_CADENCE_TOOL,
    SET_CHRONOTYPE_TOOL,
    SET_UNPROMPTED_ACTIONS_TOOL,
    SET_FREE_FORM_CONSTRAINTS_TOOL,
    PROPOSE_PLAN_TOOL,
    COMMIT_PLAN_TOOL,
    SET_GLP1_STATUS_TOOL,
    SET_GLP1_TAPER_STARTED_TOOL,
    MARK_GLP1_DISCONTINUED_TOOL,
    MARK_MOBILITY_DONE_TOOL,
    UNMARK_MOBILITY_DONE_TOOL,
    REGENERATE_MORNING_BRIEF_TOOL,
  ];

  // Mode-scoped tool partitioning:
  //   plan_week / setup_block — weekly-planning tools (propose_block,
  //     commit_block, propose_week_plan, commit_week_plan) plus reads; intake
  //     tools (apply_*, set_*, propose_plan, commit_plan) are hidden.
  //     GLP-1 and mobility tools are also hidden (mark_glp1_discontinued,
  //     mark_mobility_done, unmark_mobility_done don't start with "set_"
  //     so must be excluded explicitly).
  //   intake — onboarding wizard chat: 2 read tools (daily_logs + workouts)
  //     + 13 Phase 2 intake tools + set_glp1_status. Weekly-planning tools
  //     and the active-doc GLP-1 tools are hidden.
  //   default — read tools + set_glp1_taper_started + mark_glp1_discontinued
  //     (milestone tools that mutate the active plan during normal coach
  //     chat). All other propose_/commit_/apply_/set_ are still hidden.
  let toolsForMode: typeof allTools;
  if (opts.mode === "plan_week" || opts.mode === "setup_block") {
    toolsForMode = allTools.filter(
      (t) =>
        !t.name.startsWith("apply_") &&
        !t.name.startsWith("set_") &&
        t.name !== "propose_plan" &&
        t.name !== "commit_plan" &&
        t.name !== "mark_glp1_discontinued" &&
        t.name !== "mark_mobility_done" &&
        t.name !== "unmark_mobility_done" &&
        t.name !== "regenerate_morning_brief",
    );
  } else if (opts.mode === "intake") {
    toolsForMode = allTools.filter(
      (t) =>
        t.name === "query_daily_logs" ||
        t.name === "query_workouts" ||
        t.name.startsWith("apply_") ||
        (t.name.startsWith("set_") && t.name !== "set_glp1_taper_started") ||
        t.name === "propose_plan" ||
        t.name === "commit_plan",
    );
  } else {
    // default mode — coach lane normal chat. Surfaces the milestone-style
    // active-plan mutators (set_glp1_taper_started, mark_glp1_discontinued)
    // plus regenerate_morning_brief for the user-challenges-brief flow.
    toolsForMode = allTools.filter(
      (t) =>
        !t.name.startsWith("propose_") &&
        !t.name.startsWith("commit_") &&
        !t.name.startsWith("apply_") &&
        (
          !t.name.startsWith("set_") ||
          t.name === "set_glp1_taper_started"
        ),
    );
  }

  while (true) {
    const forceText = invocations >= MAX_TOOL_INVOCATIONS;
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: toolsForMode,
        // disable_parallel_tool_use lives INSIDE tool_choice (Auto/Any/Tool
        // variants only — ToolChoiceNone has no tools to parallelize).
        tool_choice: forceText
          ? { type: "none" }
          : { type: "auto", disable_parallel_tool_use: true },
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

    // Accumulate usage. Anthropic returns cache_read_input_tokens +
    // cache_creation_input_tokens when prompt caching is in play; both can be
    // 0 or missing on cache-cold turns.
    if (opts.usageSink) {
      const u = finalMsg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      opts.usageSink.input_tokens += u.input_tokens ?? 0;
      opts.usageSink.output_tokens += u.output_tokens ?? 0;
      opts.usageSink.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
      opts.usageSink.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      opts.usageSink.rounds += 1;
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
        } else if (block.name === "query_food_log") {
          result = await executeQueryFoodLog({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "query_training_plan") {
          result = await executeQueryTrainingPlan({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "get_autoregulation_signals") {
          result = await executeGetAutoregulationSignals({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "compute_adherence") {
          result = await executeComputeAdherence({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "propose_block") {
          result = await executeProposeBlock({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "commit_block") {
          result = await executeCommitBlock({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "propose_week_plan") {
          result = await executeProposeWeekPlan({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "commit_week_plan") {
          result = await executeCommitWeekPlan({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
            chatMessageId: opts.assistantMessageId ?? null,
          });
        } else if (block.name === "set_glp1_taper_started") {
          result = await executeSetGlp1TaperStarted({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "mark_glp1_discontinued") {
          result = await executeMarkGlp1Discontinued({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "mark_mobility_done") {
          result = await executeMarkMobilityDone({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "unmark_mobility_done") {
          result = await executeUnmarkMobilityDone({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "regenerate_morning_brief") {
          result = await executeRegenerateMorningBrief({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (
          block.name === "apply_goal_target" ||
          block.name === "apply_bedtime_correction" ||
          block.name === "apply_macros_correction" ||
          block.name === "apply_protein_correction" ||
          block.name === "set_sanity_override" ||
          block.name === "set_goal_narrative_chat" ||
          block.name === "set_directness" ||
          block.name === "set_cadence" ||
          block.name === "set_chronotype" ||
          block.name === "set_unprompted_actions" ||
          block.name === "set_free_form_constraints" ||
          block.name === "set_glp1_status" ||
          block.name === "propose_plan" ||
          block.name === "commit_plan"
        ) {
          // All Phase 2 intake-mode tools (including set_glp1_status) require
          // a draft document id.
          const draftDocId = opts.draftDocId ?? "";
          if (draftDocId.length === 0) {
            result = {
              ok: false,
              error: { error: "draftDocId required for intake-mode tools" },
              meta: { ms: Date.now() - t0, range_days: 0 },
            };
          } else if (block.name === "apply_goal_target") {
            result = await executeApplyGoalTarget({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "apply_bedtime_correction") {
            result = await executeApplyBedtimeCorrection({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "apply_macros_correction") {
            result = await executeApplyMacrosCorrection({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "apply_protein_correction") {
            result = await executeApplyProteinCorrection({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_sanity_override") {
            result = await executeSetSanityOverride({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_goal_narrative_chat") {
            result = await executeSetGoalNarrativeChat({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_directness") {
            result = await executeSetDirectness({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_cadence") {
            result = await executeSetCadence({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_chronotype") {
            result = await executeSetChronotype({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_unprompted_actions") {
            result = await executeSetUnpromptedActions({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_free_form_constraints") {
            result = await executeSetFreeFormConstraints({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "set_glp1_status") {
            result = await executeSetGlp1Status({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else if (block.name === "propose_plan") {
            result = await executeProposePlan({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          } else {
            // block.name === "commit_plan"
            result = await executeCommitPlan({
              supabase: opts.sr,
              userId: opts.userId,
              draftDocId,
              input: block.input,
            });
          }
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
        result: shouldPersistResult(block.name) && result.ok ? result.data : undefined,
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
