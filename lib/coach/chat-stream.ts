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
  executeProposeNutritionTargets,
  executeCommitNutritionTargets,
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
  toolsForSpeaker,
  colsForSpeaker,
  type ToolResult,
  type ToolSchema,
} from "@/lib/coach/tools";
import { HANDOFF_TOOL_NAME } from "@/lib/coach/handoff-tool";
import { speakerSystemPrompt } from "@/lib/coach/system-prompts";
import { SPEAKERS, type ChatMode, type Speaker, type ToolCallLog } from "@/lib/data/types";
import type { ContentBlock, RichMessage } from "@/lib/chat/types";

import { CHAT_MODEL as MODEL } from "@/lib/anthropic/models";

const PERSIST_RESULT_TOOLS = new Set([
  "propose_block",
  "commit_block",
  "propose_week_plan",
  "commit_week_plan",
  "propose_plan",
  "commit_plan",
  "propose_nutrition_targets",
  "commit_nutrition_targets",
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
  | { type: "error"; message: string }
  /** Any coach called HANDOFF_TOOL. The orchestrator has aborted the current
   *  stream and yields this so the route can persist a hidden system_routing
   *  audit row, swap the assistant stub's speaker, and spawn a fresh stream
   *  with the receiving coach. Mode gating (intake) and depth gating
   *  (handoffDepth >= 1) ensure HANDOFF_TOOL is not in the model's tool set
   *  when handoffs are not allowed. */
  | { type: "handoff"; from: Speaker; to: Speaker; briefing: string | null };

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
  /** Which coach voice is producing this turn. Default 'peter' (Head Coach,
   *  has access to delegate_to_specialist). Specialists ('carter' | 'nora' |
   *  'remi') get a restricted tool subset via toolsForSpeaker() and a column-
   *  filtered query_daily_logs via colsForSpeaker(). The route spawns a
   *  fresh stream with speaker=event.to after seeing a 'handoff' yield. */
  speaker?: Speaker;
  /** Athlete-profile draft document id; required for intake-mode tools
   *  (apply_*, set_*, propose_plan, commit_plan). Caller sets this when
   *  serving an /onboarding chat turn. Null/undefined in default/planning modes. */
  draftDocId?: string | null;
  /** Mutable totals; the loop adds each round's finalMsg.usage. Read by the
   *  route after the stream ends to log prompt-cache hit rate. */
  usageSink?: ChatUsageTotals;
  /** Cap on mid-stream handoffs per user turn. Incremented by the route each
   *  time it re-enters runChatStream after a 'handoff' yield. When >= 1, the
   *  generalized handoff tool is omitted from this stream's tool list so the
   *  current coach has to answer in text or end the turn. Default 0. */
  handoffDepth?: number;
};

export async function* runChatStream(opts: RunChatStreamOpts): AsyncGenerator<ChatStreamYield> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const speaker: Speaker = opts.speaker ?? "peter";

  const client = new Anthropic({ apiKey });
  // The SDK accepts a system prompt as a string OR typed blocks. We use the
  // typed-block form so we can attach cache_control for the prompt-cache.
  //
  // System-prompt composition:
  //   * Caller-provided `opts.systemPrompt` already contains SCHEMA_EXPLAINER
  //     + the user's PETER override / mode addenda (assembled by the route
  //     via buildSystemPrompt). It assumes Peter is talking.
  //   * For specialist turns (carter/nora/remi), discard the Peter-targeted
  //     prompt and use the specialist's base prompt instead. The schema
  //     explainer and snapshot prefix (positions 0 of `messages`) still apply.
  const systemText = speaker === "peter" ? opts.systemPrompt : speakerSystemPrompt(speaker);
  const system = [
    { type: "text" as const, text: systemText, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
  ];

  let invocations = 0;
  // Conversation state — we mutate this each round as the loop appends
  // assistant messages with tool_use blocks and the matching tool_result
  // user-message follow-ups.
  const messages: RichMessage[] = opts.messages.slice();

  // Speaker-aware tool surface. Each specialist exposes a restricted subset
  // (see lib/coach/tools.ts: PETER_TOOLS/CARTER_TOOLS/NORA_TOOLS/REMI_TOOLS).
  // Mode partitioning is then applied on top of the speaker's base subset.
  //
  // Mode rules:
  //   plan_week / setup_block — weekly-planning tools (propose_block,
  //     commit_block, propose_week_plan, commit_week_plan) plus reads; intake
  //     tools (apply_*, set_*, propose_plan, commit_plan) are hidden.
  //     GLP-1 and mobility tools are also hidden.
  //   intake — onboarding wizard chat: 2 read tools (daily_logs + workouts)
  //     + 13 Phase 2 intake tools + set_glp1_status. Weekly-planning tools
  //     and the active-doc GLP-1 tools are hidden. handoff_to is ALWAYS hidden
  //     in intake (single-voice wizard; specialists dormant during onboarding).
  //   default — read tools + set_glp1_taper_started + mark_glp1_discontinued
  //     plus regenerate_morning_brief. handoff_to visible at depth=0.
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
    }
    if (opts.mode === "intake") {
      return (
        name === "query_daily_logs" ||
        name === "query_workouts" ||
        name.startsWith("apply_") ||
        (name.startsWith("set_") && name !== "set_glp1_taper_started") ||
        name === "propose_plan" ||
        name === "commit_plan"
      );
    }
    // default mode
    if (name === "propose_nutrition_targets") return true;
    if (name === "commit_nutrition_targets") return true;
    if (name.startsWith("propose_")) return false;
    if (name.startsWith("commit_")) return false;
    if (name.startsWith("apply_")) return false;
    if (name.startsWith("set_") && name !== "set_glp1_taper_started") return false;
    return true;
  };

  const speakerTools = toolsForSpeaker(speaker);
  const toolsForMode: ToolSchema[] = speakerTools.filter((t) => modeAllowsTool(t.name)).slice();

  while (true) {
    const forceText = invocations >= MAX_TOOL_INVOCATIONS;
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: toolsForMode as unknown as Anthropic.Messages.Tool[],
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
          // Per-specialist column cluster gating. Peter sees PETER_COLS (all
          // ALLOWED_COLUMNS); specialists see their domain subset. Requested
          // columns outside the cluster surface as a structured error inside
          // executeQueryDailyLogs.
          result = await executeQueryDailyLogs({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
            allowedColumns: colsForSpeaker(speaker),
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
        } else if (block.name === "propose_nutrition_targets") {
          result = await executeProposeNutritionTargets({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "commit_nutrition_targets") {
          result = await executeCommitNutritionTargets({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
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
