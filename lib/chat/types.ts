// lib/chat/types.ts
//
// Shared types used by both server and client. Mirror the DB shape.
// Also the canonical home for Anthropic-message wire shapes used by the
// chat path — both lib/anthropic/client.ts (hand-rolled streamer) and
// lib/coach/chat-stream.ts (SDK-based tool loop) import from here.
import type { MorningBriefCard, MorningUI, WeeklyReviewCardUI, ProactiveNudgeCard, WorkoutDebriefPayload } from "@/lib/data/types";

export type ChatRole = "user" | "assistant";
export type ChatStatus = "streaming" | "done" | "error";

// ── Anthropic message-content wire shapes ────────────────────────────────────
export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type ContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "image"; source: { type: "url"; url: string } };

/** Used by both the hand-rolled streamer and the SDK-based tool loop. */
export type RichMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type ChatMessageImage = {
  id: string;
  storage_path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Signed URL minted at GET time, ~24h TTL. */
  signed_url: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatStatus;
  error: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  images: ChatMessageImage[];
  /** Coach persona delivering this message. Default 'peter' for assistant turns;
   *  'user' for user-authored messages. */
  speaker: import("@/lib/data/types").ChatSpeaker;
  /** Thread lane this message belongs to. One of peter|carter|nora|remi.
   *  Matches chat_messages.thread; used for per-coach chat surfaces. */
  thread: import("@/lib/data/types").Speaker;
  /** Default 'coach'. ChatPanel filters its render by this. */
  kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge" | "system_routing" | "workout_debrief" | "meal_log" | "block_outcome";
  /** Chips / rendering hints for morning_intake turns; structured card UI
   *  for morning_brief / weekly_review / proactive_nudge turns. */
  ui: MorningUI | MorningBriefCard | WeeklyReviewCardUI | ProactiveNudgeCard | WorkoutDebriefPayload | null;
  /** Persisted tool-call logs. Populated only for assistant messages that
   *  invoked at least one tool. Non-null only when the server includes the
   *  column in its select (GET /api/chat/messages returns it). */
  tool_calls?: import("@/lib/data/types").ToolCallLog[] | null;
  /** Conversational sub-state within the coach lane. */
  mode?: import("@/lib/data/types").ChatMode;
  /** For kind='meal_log' rows only: the food_log_entries.id this message
   *  belongs to. Populated on insert; used to DELETE the row when the draft
   *  resolves (commit/cancel). NULL on every non-meal_log row. */
  draft_entry_id?: string | null;
};

/** SSE event sent from server to client. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      message_id: string;
      partial?: boolean;
      tool_calls?: import("@/lib/data/types").ToolCallLog[] | null;
    }
  | { type: "error"; message: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number }
  /** Morning brief: deterministic card payload arrives first (advice_md=''),
   *  then "delta" events fill in the advice prose progressively. */
  | { type: "brief_card"; card: import("@/lib/data/types").MorningBriefCard }
  /** Peter delegated to a specialist mid-turn. Triggers a speaker chip swap
   *  on the in-flight assistant stub and a HandoffLine divider in the
   *  thread. Briefing is the prose Peter passed; null in replayed history. */
  | {
      type: "handoff";
      from: import("@/lib/data/types").Speaker;
      to: import("@/lib/data/types").Speaker;
      briefing: string | null;
    };