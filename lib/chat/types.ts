// lib/chat/types.ts
//
// Shared types used by both server and client. Mirror the DB shape.

export type ChatRole = "user" | "assistant";
export type ChatStatus = "streaming" | "done" | "error";

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
  | { type: "error"; message: string };
