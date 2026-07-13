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
//     blocks, we execute them serially in a for-loop, append tool_result
//     blocks, and re-call .stream(). Parallel emission by the model is fine —
//     our loop iterates them in order.
//   * Cap at 5 individual tool invocations. On the 6th attempt, restart with
//     tool_choice: { type: "none" } so the model HAS to write a final text.
//   * The async generator yields delta + tool_call_start/done + done/error
//     events that map 1:1 to the SSE wire format defined in lib/chat/sse.ts.
//
// userId is injected by the caller from supabase.auth.getUser() — model
// never passes it, executors enforce .eq("user_id", userId) (security
// invariants in lib/coach/tools.ts).

import Anthropic, { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  executeQueryDailyLogs,
  executeQueryWorkouts,
  executeQueryFoodLog,
  executeQueryExerciseLibrary,
  executeGetSubstitutes,
  executeQueryTrainingPlan,
  executeGetAutoregulationSignals,
  executeComputeAdherence,
  executeGetWeekPrescription,
  executeProposeBlock,
  executeCommitBlock,
  executeProposeCloseBlock,
  executeCommitCloseBlock,
  executeProposeWeekPlan,
  executeCommitWeekPlan,
  executeProposeSessionToday,
  executeCommitSessionToday,
  executeProposeSessionTemplate,
  executeCommitSessionTemplate,
  executeProposeNutritionTargets,
  executeCommitNutritionTargets,
  executeApplyGoalTarget,
  executeApplyBedtimeCorrection,
  executeApplyMacrosCorrection,
  executeApplyProteinCorrection,
  executeSetSanityOverride,
  executeResolvePlanFlag,
  executeSetGoalNarrativeChat,
  executeSetDirectness,
  executeSetCadence,
  executeSetChronotype,
  executeSetUnpromptedActions,
  executeSetFreeFormConstraints,
  executeProposePlan,
  executeCommitPlan,
  executeSetGlp1Status,
  executeSetRotationPriorityLift,
  executeApplyRotationOverride,
  executeSetGlp1TaperStarted,
  executeMarkGlp1Discontinued,
  executeMarkMobilityDone,
  executeUnmarkMobilityDone,
  executeRegenerateMorningBrief,
  executeSearchLibrary,
  executePickLibraryItem,
  executeSaveToLibrary,
  executeResolveFoodMacros,
  executeProposeMealLog,
  executeCommitMealLog,
  executeProposeMealSuggestions,
  executeGetStrengthPerLbmTrend,
  executeQueryEnduranceActivities,
  executeProposeEnduranceWeek,
  executeCommitEnduranceWeek,
  executeSetEndurancePhase,
  executeSetEnduranceDiscipline,
  executeSetThresholdHr,
  executeSetFtp,
  executeAddPlannedActivity,
  executeProposeActivityAdjustment,
  executeCommitActivityAdjustment,
  toolsForSpeaker,
  colsForSpeaker,
  type ToolResult,
  type ToolSchema,
} from "@/lib/coach/tools";
import { speakerSystemPromptForMode } from "@/lib/coach/system-prompts";
import { type ChatMode, type Speaker, type ToolCallLog } from "@/lib/data/types";
import type { ContentBlock, RichMessage } from "@/lib/chat/types";

import { CHAT_MODEL as MODEL } from "@/lib/anthropic/models";

const PERSIST_RESULT_TOOLS = new Set([
  "propose_block",
  "commit_block",
  "propose_close_block",
  "commit_close_block",
  "propose_week_plan",
  "commit_week_plan",
  "propose_plan",
  "commit_plan",
  "propose_nutrition_targets",
  "commit_nutrition_targets",
  // Session-write tools (Carter): the preview + approval_token + commit result
  // must persist so the preview/confirmation chips render on chat history
  // reload (see 2026-05-21 Nora re-save loop for the same bug class).
  "propose_session_today",
  "commit_session_today",
  "propose_session_template",
  "commit_session_template",
  // Library + meal-log tools persist their result so the UI can render
  // confirmation chips ("Saved: <name>", "Logged to <slot>") under the
  // assistant bubble. Without this the user couldn't tell that 8×
  // save_to_library actually ran (see 2026-05-21 Nora re-save loop).
  "save_to_library",
  "search_library",
  "pick_library_item",
  "propose_meal_log",
  "commit_meal_log",
  "propose_meal_suggestions",
  // Endurance week proposal + commit (Carter): preview chip + commit
  // confirmation must survive history reload.
  "propose_endurance_week",
  "commit_endurance_week",
  // Activity direct-write: receipt chip must survive history reload so the
  // athlete can see "Added: padel Tue (hard)" on revisit.
  "add_planned_activity",
  // Activity adjustment: preview chip + commit confirmation must survive reload.
  "propose_activity_adjustment",
  "commit_activity_adjustment",
]);
function shouldPersistResult(name: string): boolean {
  return PERSIST_RESULT_TOOLS.has(name);
}
// Cap counts each tool_use block (parallel tool use included), not each round.
// A realistic Nora batch-save in default mode is 2N+2 calls (N search + N save
// + 1 propose_meal_log + 1 commit_meal_log); 25 covers a 12-item meal comfortably
// while still floor-limiting runaway loops on cheap query_* tools.
const MAX_TOOL_INVOCATIONS = 25;
const MAX_TOKENS = 2000;

// Anthropic-managed web search. Pinned to web_search_20250305 (the basic
// version) instead of _20260209. The _20260209 tool engages dynamic
// filtering, which runs *inside* a code-execution container — when client
// tools (save_to_library / propose_meal_log / etc.) are emitted in the same
// turn, the API requires the container_id back on every follow-up request
// and the SDK 0.95.0 plumbing for that is fragile (per Anthropic server-
// tools docs, dynamic filtering is what creates the container; the basic
// version skips that step entirely). For nutrition lookups we don't need
// dynamic filtering — a couple of search hits + the model's reasoning is
// plenty — so the basic version is the right trade.
const WEB_SEARCH_TOOL: Anthropic.Messages.WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
};

// Modes where coaches may search the web. Hidden in intake (Phase 2
// plan-builder is deterministic — no web noise during the wizard).
function webSearchAllowedForMode(mode: ChatMode): boolean {
  return mode === "default" || mode === "plan_week" || mode === "setup_block";
}

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
  /** Mode ritual sections (PLAN_WEEK_PROMPT / SETUP_BLOCK_PROMPT + fetched
   *  block context), pre-joined by the route via buildModeSections. Peter's
   *  systemPrompt already embeds these (buildSystemPrompt); specialist turns
   *  replace systemPrompt with their base prompt, so the mode ritual must be
   *  re-appended here or Carter runs setup_block/plan_week turns blind (the
   *  2026-07-12 "Setup new block does nothing" bug). */
  modeBlock?: string | null;
  /** Which coach voice is producing this turn. Default 'peter' (Head Coach).
   *  Specialists ('carter' | 'nora' | 'remi') get a restricted lane-specific
   *  tool subset via toolsForSpeaker() and a column-filtered query_daily_logs
   *  via colsForSpeaker(). */
  speaker?: Speaker;
  /** Conversation thread this turn belongs to. One of 'peter' | 'carter' |
   *  'nora' | 'remi'. Defaults to opts.speaker (assistant turns are always
   *  in their own speaker's thread). Reserved for PR 6 when the chat surface
   *  no longer routes — the page passes the thread directly and chat-stream
   *  fixes the speaker to it. In PR 1 this is informational; the route still
   *  derives speaker from the router and passes thread = speaker. */
  thread?: "peter" | "carter" | "nora" | "remi";
  /** Pre-built "Recent specialist activity" block from buildPeterContextBlock().
   *  Appended after the base system prompt for Peter turns only. Null/undefined
   *  skips the block (specialist turns, empty specialist threads, or callers
   *  that haven't opted in yet). */
  peterContext?: string | null;
  /** Pre-built "This week's exercises" markdown from
   *  buildThisWeeksExercisesBlock(). Appended after the base system
   *  prompt for Carter turns only. Null/undefined means no training_weeks
   *  row for the current week — fall back to query_exercise_library. */
  carterContext?: string | null;
  /** Pre-built "Today's read" markdown from coach_dashboards.narrative_md.
   *  Appended after the base system prompt for Peter turns only. Null/undefined
   *  means no dashboard row exists yet — falls back to the snapshot context.
   *  Composes alongside peterContext (specialist activity); both blocks coexist. */
  peterDashboardBlock?: string | null;
  /** Pre-built "Eating identity" markdown from renderEatingIdentityBlock().
   *  Appended after the base system prompt for Nora turns only. Null/undefined
   *  means no cache row yet — falls back to the snapshot's nutrition fields. */
  noraIdentityBlock?: string | null;
  /** Athlete-profile draft document id; required for intake-mode tools
   *  (apply_*, set_*, propose_plan, commit_plan). Caller sets this when
   *  serving an /onboarding chat turn. Null/undefined in default/planning modes. */
  draftDocId?: string | null;
  /** Mutable totals; the loop adds each round's finalMsg.usage. Read by the
   *  route after the stream ends to log prompt-cache hit rate. */
  usageSink?: ChatUsageTotals;
};

/** Everything a tool executor closure may reference. `opts` is passed whole so
 *  entries can read the same fields the old if/else branches did. `t0` is the
 *  loop-local start timestamp used by the intake-cluster guard for its early-
 *  exit error result (the only branch that references a loop-local beyond
 *  opts/speaker/input). */
type ToolExecArgs = {
  opts: RunChatStreamOpts;
  speaker: Speaker;
  input: Record<string, unknown>;
  t0: number;
};

/** Returns an intake-cluster executor bound to a specific tool name. */
function makeIntakeTool(
  blockName: string,
): (a: ToolExecArgs) => Promise<ToolResult<unknown>> {
  return async (a: ToolExecArgs): Promise<ToolResult<unknown>> => {
    const { opts, input, t0 } = a;
    const draftDocId = opts.draftDocId ?? "";
    if (draftDocId.length === 0) {
      return {
        ok: false,
        error: { error: "draftDocId required for intake-mode tools" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    if (blockName === "apply_goal_target") {
      return executeApplyGoalTarget({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "apply_bedtime_correction") {
      return executeApplyBedtimeCorrection({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "apply_macros_correction") {
      return executeApplyMacrosCorrection({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "apply_protein_correction") {
      return executeApplyProteinCorrection({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_sanity_override") {
      return executeSetSanityOverride({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "resolve_plan_flag") {
      return executeResolvePlanFlag({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_goal_narrative_chat") {
      return executeSetGoalNarrativeChat({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_directness") {
      return executeSetDirectness({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_cadence") {
      return executeSetCadence({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_chronotype") {
      return executeSetChronotype({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_unprompted_actions") {
      return executeSetUnpromptedActions({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_free_form_constraints") {
      return executeSetFreeFormConstraints({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "set_glp1_status") {
      return executeSetGlp1Status({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else if (blockName === "propose_plan") {
      return executeProposePlan({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    } else {
      // block.name === "commit_plan"
      return executeCommitPlan({
        supabase: opts.sr,
        userId: opts.userId,
        draftDocId,
        input,
      });
    }
  };
}

const TOOL_EXECUTORS: Record<string, (a: ToolExecArgs) => Promise<ToolResult<unknown>>> = {
  query_daily_logs: (a) =>
    executeQueryDailyLogs({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
      // Per-specialist column cluster gating. Peter sees PETER_COLS (all
      // ALLOWED_COLUMNS); specialists see their domain subset. Requested
      // columns outside the cluster surface as a structured error inside
      // executeQueryDailyLogs.
      allowedColumns: colsForSpeaker(a.speaker),
    }),
  query_workouts: (a) =>
    executeQueryWorkouts({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  query_food_log: (a) =>
    executeQueryFoodLog({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  query_exercise_library: (a) =>
    executeQueryExerciseLibrary({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  get_substitutes: (a) =>
    executeGetSubstitutes({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  query_training_plan: (a) =>
    executeQueryTrainingPlan({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  get_autoregulation_signals: (a) =>
    executeGetAutoregulationSignals({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  compute_adherence: (a) =>
    executeComputeAdherence({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  get_week_prescription: (a) =>
    executeGetWeekPrescription({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  get_strength_per_lbm_trend: (a) =>
    executeGetStrengthPerLbmTrend({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_block: (a) =>
    executeProposeBlock({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_block: (a) =>
    executeCommitBlock({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_close_block: (a) =>
    executeProposeCloseBlock({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_close_block: (a) =>
    executeCommitCloseBlock({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_week_plan: (a) =>
    executeProposeWeekPlan({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_week_plan: (a) =>
    executeCommitWeekPlan({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
      chatMessageId: a.opts.assistantMessageId ?? null,
    }),
  propose_activity_adjustment: (a) =>
    executeProposeActivityAdjustment({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_activity_adjustment: (a) =>
    executeCommitActivityAdjustment({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
      chatMessageId: a.opts.assistantMessageId ?? null,
    }),
  propose_session_today: (a) =>
    executeProposeSessionToday({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_session_today: (a) =>
    executeCommitSessionToday({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_session_template: (a) =>
    executeProposeSessionTemplate({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_session_template: (a) =>
    executeCommitSessionTemplate({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_nutrition_targets: (a) =>
    executeProposeNutritionTargets({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  commit_nutrition_targets: (a) =>
    executeCommitNutritionTargets({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  set_glp1_taper_started: (a) =>
    executeSetGlp1TaperStarted({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  set_rotation_priority_lift: (a) =>
    executeSetRotationPriorityLift({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  apply_rotation_override: (a) =>
    executeApplyRotationOverride({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  mark_glp1_discontinued: (a) =>
    executeMarkGlp1Discontinued({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  mark_mobility_done: (a) =>
    executeMarkMobilityDone({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  unmark_mobility_done: (a) =>
    executeUnmarkMobilityDone({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  regenerate_morning_brief: (a) =>
    executeRegenerateMorningBrief({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  search_library: (a) =>
    executeSearchLibrary({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  pick_library_item: (a) =>
    executePickLibraryItem({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  save_to_library: (a) =>
    executeSaveToLibrary({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  resolve_food_macros: (a) =>
    executeResolveFoodMacros({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_meal_log: (a) =>
    executeProposeMealLog({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
      assistantMessageId: a.opts.assistantMessageId ?? null,
    }),
  commit_meal_log: (a) =>
    executeCommitMealLog({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  propose_meal_suggestions: (a) =>
    executeProposeMealSuggestions({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  query_endurance_activities: (a) =>
    executeQueryEnduranceActivities({
      userId: a.opts.userId,
      input: a.input as {
        start_date: string;
        end_date: string;
        sport?: string;
        min_duration_min?: number;
      },
    }),
  propose_endurance_week: (a) =>
    executeProposeEnduranceWeek({
      userId: a.opts.userId,
      input: a.input as { week_start: string; preferred_day?: 0|1|2|3|4|5|6 },
    }),
  commit_endurance_week: (a) =>
    executeCommitEnduranceWeek({
      userId: a.opts.userId,
      input: a.input as { approval_token: string },
    }),
  set_endurance_phase: (a) =>
    executeSetEndurancePhase({
      userId: a.opts.userId,
      input: a.input as {
        phase: "aerobic_base" | "build" | "race_prep" | "taper" | "off_season";
        weekly_volume_target_hours?: number;
      },
    }),
  set_endurance_discipline: (a) =>
    executeSetEnduranceDiscipline({
      userId: a.opts.userId,
      input: a.input as { discipline: "cycling" | "running" | "triathlon" },
    }),
  set_threshold_hr: (a) =>
    executeSetThresholdHr({
      userId: a.opts.userId,
      input: a.input as { bpm: number },
    }),
  set_ftp: (a) =>
    executeSetFtp({
      userId: a.opts.userId,
      input: a.input as { watts: number },
    }),
  add_planned_activity: (a) =>
    executeAddPlannedActivity({
      supabase: a.opts.sr,
      userId: a.opts.userId,
      input: a.input,
    }),
  // Intake-cluster tools: all require draftDocId; share makeIntakeTool factory.
  apply_goal_target: makeIntakeTool("apply_goal_target"),
  apply_bedtime_correction: makeIntakeTool("apply_bedtime_correction"),
  apply_macros_correction: makeIntakeTool("apply_macros_correction"),
  apply_protein_correction: makeIntakeTool("apply_protein_correction"),
  set_sanity_override: makeIntakeTool("set_sanity_override"),
  resolve_plan_flag: makeIntakeTool("resolve_plan_flag"),
  set_goal_narrative_chat: makeIntakeTool("set_goal_narrative_chat"),
  set_directness: makeIntakeTool("set_directness"),
  set_cadence: makeIntakeTool("set_cadence"),
  set_chronotype: makeIntakeTool("set_chronotype"),
  set_unprompted_actions: makeIntakeTool("set_unprompted_actions"),
  set_free_form_constraints: makeIntakeTool("set_free_form_constraints"),
  set_glp1_status: makeIntakeTool("set_glp1_status"),
  propose_plan: makeIntakeTool("propose_plan"),
  commit_plan: makeIntakeTool("commit_plan"),
};

export async function* runChatStream(opts: RunChatStreamOpts): AsyncGenerator<ChatStreamYield> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const speaker: Speaker = opts.speaker ?? "peter";

  // Resolve thread for symmetry with PR 6. In PR 1 it equals speaker; the
  // route does not yet pass thread explicitly, but the helper supports it
  // so subsequent PRs can wire it without touching this file's signature.
  const _thread: Speaker = opts.thread ?? speaker;
  void _thread;

  // maxRetries handles initial-POST 5xx/429 (HTTP-level overloads) with
  // SDK-managed exponential backoff. Mid-stream `event: error` overloads
  // surface through the iterator and are retried separately in the
  // attempt: loop below — the SDK can't restart an in-flight stream.
  const client = new Anthropic({ apiKey, maxRetries: 4 });
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
  const baseSystemText = speaker === "peter"
    ? opts.systemPrompt
    : speakerSystemPromptForMode(speaker, opts.mode ?? "default");
  // Append per-turn extras: Peter dashboard block + specialist activity recap.
  let systemText = baseSystemText;
  // Specialist turns dropped the Peter-targeted systemPrompt above — re-attach
  // the mode ritual (plan_week / setup_block instructions + block context) so
  // e.g. Carter actually runs the 4-beat block setup instead of defaulting to
  // his base behavior. Peter's prompt already contains these sections.
  if (opts.modeBlock && speaker !== "peter") {
    systemText = `${systemText}\n\n---\n\n${opts.modeBlock}`;
  }
  if (opts.peterDashboardBlock && speaker === "peter") {
    systemText = `${systemText}\n\n${opts.peterDashboardBlock}`;
  }
  if (opts.peterContext && speaker === "peter") systemText = `${systemText}\n\n${opts.peterContext}`;
  if (opts.carterContext && speaker === "carter") {
    systemText = `${systemText}\n\n${opts.carterContext}`;
  }
  if (opts.noraIdentityBlock && speaker === "nora") {
    systemText = `${systemText}\n\n${opts.noraIdentityBlock}`;
  }
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
  //     and the active-doc GLP-1 tools are hidden.
  //   default — read tools + set_glp1_taper_started + mark_glp1_discontinued
  //     plus regenerate_morning_brief.
  const modeAllowsTool = (name: string): boolean => {
    // Endurance set_* milestone tools (Carter) — allowed across the active
    // chat modes so Carter can update threshold HR / FTP / phase / discipline
    // mid-conversation. Block in intake (onboarding has its own capture path).
    const isEnduranceMilestone =
      name === "set_endurance_phase" ||
      name === "set_endurance_discipline" ||
      name === "set_threshold_hr" ||
      name === "set_ftp";
    if (opts.mode === "plan_week" || opts.mode === "setup_block") {
      // propose_endurance_week / commit_endurance_week are propose/commit-shaped
      // and follow the same allowance as propose_week_plan in these modes.
      // The 4 set_endurance_* milestone tools are also allowed (the blanket
      // set_* exclusion below skips them via the explicit exemption).
      if (
        name === "propose_endurance_week" ||
        name === "commit_endurance_week" ||
        isEnduranceMilestone
      ) {
        return true;
      }
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
        (name.startsWith("set_") && name !== "set_glp1_taper_started" && !isEnduranceMilestone) ||
        name === "resolve_plan_flag" ||
        name === "propose_plan" ||
        name === "commit_plan"
      );
    }
    // default mode
    // propose_/commit_ tools are blocked by default to prevent accidental plan
    // writes — but a few pairs are explicitly exempted because the athlete
    // legitimately initiates them from chat: nutrition target proposals
    // (Nora/Peter), meal logging (Nora), and same-day session overrides
    // (Carter; long-form template changes still gated to plan_week mode).
    // New propose_/commit_ pairs added for future write features must add
    // their own explicit allows here, or they'll be stripped from the tool
    // list and the model will hallucinate a fake commit in prose — see
    // 2026-05-22 Nora-meal-log silent-fail.
    if (name === "propose_nutrition_targets") return true;
    if (name === "commit_nutrition_targets") return true;
    if (name === "propose_meal_log") return true;
    if (name === "commit_meal_log") return true;
    if (name === "propose_meal_suggestions") return true;
    if (name === "propose_session_today") return true;
    if (name === "commit_session_today") return true;
    if (name === "apply_rotation_override") return true;
    // Close-block tool pair: athlete legitimately initiates from default
    // chat when target is hit early / injury / schedule change. Without
    // these explicit allows the prefix guards below strip them and Peter
    // narrates a fake close in prose with no DB write.
    if (name === "propose_close_block") return true;
    if (name === "commit_close_block") return true;
    // Block setup pair: the natural flow is close-block → discuss target →
    // set up the next block IN THE SAME default-mode conversation (observed
    // live 2026-07-12: PETER_BASE instructs "call propose_block /
    // commit_block" but these were stripped here, so Peter narrated
    // "Done — plan committed" with no DB write and the athlete trained
    // blockless the next morning). Same reasoning as close_block above;
    // the HMAC approve chip still gates the actual commit.
    if (name === "propose_block") return true;
    if (name === "commit_block") return true;
    // Endurance write tools (Carter): athlete legitimately asks for a Z2
    // week or updates threshold HR / FTP from default chat. Without these
    // explicit allows the prefix guards below strip them, the model invents
    // a commit in prose, and no DB write happens.
    if (name === "propose_endurance_week") return true;
    if (name === "commit_endurance_week") return true;
    if (name === "propose_activity_adjustment") return true;
    if (name === "commit_activity_adjustment") return true;
    if (isEnduranceMilestone) return true;
    if (name.startsWith("propose_")) return false;
    if (name.startsWith("commit_")) return false;
    if (name.startsWith("apply_")) return false;
    if (name.startsWith("set_") && name !== "set_glp1_taper_started" && name !== "set_rotation_priority_lift") return false;
    // Intake-only tool: onboarding has its own capture path; block in default
    // mode for consistency (the executor requires a draftDocId only set in
    // intake mode, so there's no data risk, but explicit blocking keeps the
    // tool list honest and avoids confusing the model).
    if (name === "resolve_plan_flag") return false;
    return true;
  };

  const speakerTools = toolsForSpeaker(speaker);
  const toolsForMode: ToolSchema[] = speakerTools.filter((t) => modeAllowsTool(t.name)).slice();
  const mode: ChatMode = opts.mode ?? "default";
  const tools: Anthropic.Messages.Tool[] = [
    ...(toolsForMode as unknown as Anthropic.Messages.Tool[]),
    ...(webSearchAllowedForMode(mode) ? [WEB_SEARCH_TOOL as unknown as Anthropic.Messages.Tool] : []),
  ];

  // Auto-retry budget for mid-stream overloaded_error (the SDK can't retry
  // an in-flight SSE stream). 3 attempts with jittered exponential backoff:
  // ~1s, ~2s, ~4s — covers most transient capacity blips (~7s worst case).
  // Budget spans the whole turn, not per tool-use round, so a sustained
  // outage can't make us retry-storm Anthropic.
  let overloadedRetryBudget = 3;
  let overloadedRetryCount = 0;

  while (true) {
    const forceText = invocations >= MAX_TOOL_INVOCATIONS;

    // Inner attempt loop: drives the auto-retry on overloaded_error. Breaks
    // out on success; returns from the generator on a non-retryable error.
    let stream!: ReturnType<typeof client.messages.stream>;
    attempt: while (true) {
      stream = client.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          tools,
          // Why not disable_parallel_tool_use: Sonnet 4.6 occasionally emits
          // multiple tool_use blocks per round (parallel tool use). Our
          // for-loop below dispatches them serially in order, so parallel
          // emission is safe.
          tool_choice: forceText ? { type: "none" } : { type: "auto" },
          messages: messages as Anthropic.MessageParam[],
        },
        { signal: opts.signal },
      );

      let deltasYielded = 0;
      let caught: unknown = null;

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
            deltasYielded += 1;
            yield { type: "delta", text: ev.delta.text };
          }
          // Other events (input_json_delta, content_block_start, message_stop)
          // are accumulated by the SDK; we read the final assembled message
          // below via finalMessage().
        }
      } catch (e) {
        caught = e;
      }

      if (caught === null) break attempt; // stream completed cleanly

      if (caught instanceof APIUserAbortError) {
        yield { type: "error", message: "aborted" };
        return;
      }

      // Auto-retry overloaded with jittered exponential backoff — but only
      // if no text has reached the client yet, since a second stream would
      // duplicate visible output. Overloaded almost always fails before
      // the first token, so the guard rarely matters in practice.
      // Backoff: ~1s, ~2s, ~4s (base) + up to 30% jitter to avoid
      // synchronizing retry storms with other clients hitting the same
      // capacity window.
      if (
        overloadedRetryBudget > 0 &&
        deltasYielded === 0 &&
        isOverloadedError(caught)
      ) {
        overloadedRetryBudget -= 1;
        const base = 1000 * Math.pow(2, overloadedRetryCount);
        const jitter = base * Math.random() * 0.3;
        overloadedRetryCount += 1;
        await new Promise((r) => setTimeout(r, base + jitter));
        continue attempt;
      }

      yield { type: "error", message: formatStreamError(caught, "stream") };
      return;
    }

    let finalMsg: Anthropic.Message;
    try {
      finalMsg = await stream.finalMessage();
    } catch (e) {
      yield { type: "error", message: formatStreamError(e, "finalize") };
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

    // `pause_turn` fires when a server tool (web_search) ran long and the API
    // paused the turn mid-flight. The Anthropic docs say to push the assistant
    // content back as-is and re-call .stream() to resume; no tool_results to
    // synthesize since the paused work is server-side. Distinct from the
    // client-tool branch below — server-tool resumes don't increment our
    // invocations counter and don't go through the executor switch.
    if (finalMsg.stop_reason === "pause_turn" && toolUseBlocks.length === 0) {
      messages.push({
        role: "assistant",
        content: finalMsg.content as unknown as ContentBlock[],
      });
      continue;
    }

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

    // Execute each tool_use block serially. The model may emit multiple
    // blocks per round (parallel tool use is permitted) — we still dispatch
    // them in order so downstream state writes stay predictable.
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
        const exec = TOOL_EXECUTORS[block.name];
        if (exec) {
          result = await exec({
            opts,
            speaker,
            input: (block.input ?? {}) as Record<string, unknown>,
            t0,
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

function isOverloadedError(e: unknown): boolean {
  if (!(e instanceof APIError)) return false;
  if (e.type === "overloaded_error") return true;
  if (e.status === 529) return true;
  return false;
}

// Build a short, human-readable error string for chat_messages.error. The
// UI renders this field with text-transform: uppercase + 10px tracking
// (components/chat/ChatMessage.tsx:212), so we keep it brief — no JSON
// dumps, no request IDs. Errors here surface to the athlete; the SDK's
// raw `.message` (which embeds the full JSON body for APIError) is too
// noisy for that surface.
function formatStreamError(e: unknown, stage: "stream" | "finalize"): string {
  if (e instanceof APIError) {
    if (e.type === "overloaded_error" || e.status === 529) {
      return "Anthropic overloaded — try again";
    }
    if (e.type === "rate_limit_error" || e.status === 429) {
      return "Rate limit hit — try again in a moment";
    }
    if (e.type === "authentication_error" || e.status === 401) {
      return "Anthropic auth failed";
    }
    if (e.type === "permission_error" || e.status === 403) {
      return "Anthropic denied the request";
    }
    if (e.type === "not_found_error" || e.status === 404) {
      return "Anthropic 404 — model or resource not found";
    }
    if (e.status && e.status >= 500) {
      return "Anthropic server error — try again";
    }
    if (e.type === "invalid_request_error" || e.status === 400) {
      return `Invalid request: ${truncate((e as Error).message ?? "", 100)}`;
    }
    return `Anthropic error (${e.type ?? e.status ?? "unknown"})`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return stage === "finalize"
    ? `Finalize failed: ${truncate(msg, 100)}`
    : `Stream failed: ${truncate(msg, 100)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
