// lib/chat/types.ts
//
// Shared types used by both server and client. Mirror the DB shape.
// Also the canonical home for Anthropic-message wire shapes used by the
// chat path — both lib/anthropic/client.ts (hand-rolled streamer) and
// lib/coach/chat-stream.ts (SDK-based tool loop) import from here.

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
};

/** SSE event sent from server to client. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; message_id: string; partial?: boolean }
  | { type: "error"; message: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_call_done"; id: string; ok: boolean; ms: number };