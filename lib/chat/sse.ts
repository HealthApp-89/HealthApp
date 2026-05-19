// lib/chat/sse.ts
//
// Server-side helper: format one SSE event as a string ready to write to
// a ReadableStream. Format:
//
//     event: <name>\n
//     data: <json>\n
//     \n
//
// Each event MUST end with a blank line (\n\n) — that's the frame boundary
// the client's line-buffer parser splits on.

import type { Speaker } from "@/lib/data/types";

export type ServerStreamEvent =
  | { event: "delta"; data: { text: string } }
  | {
      event: "done";
      data: {
        message_id: string;
        partial?: boolean;
        /** Persisted tool-call audit log for this assistant turn (mirrors
         *  chat_messages.tool_calls). Lets the client patch the message
         *  in-place without a follow-up GET /api/chat/messages refetch. */
        tool_calls?: import("@/lib/data/types").ToolCallLog[] | null;
      };
    }
  | { event: "error"; data: { message: string } }
  | { event: "tool_call_start"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { event: "tool_call_done"; data: { id: string; ok: boolean; ms: number } }
  /** Morning brief: emitted once after deterministic card assembly, before
   *  advice prose streams via "delta" events. */
  | { event: "brief_card"; data: { card: import("@/lib/data/types").MorningBriefCard } }
  /** A coach called handoff_to mid-answer. Emitted between the current
   *  speaker's stream ending and the receiving coach's stream starting; the
   *  client uses this to swap the in-flight speaker chip and render a
   *  HandoffLine divider. Briefing prose surfaces inline here, but is
   *  dropped from persisted history (replays pass briefing=null). */
  | { event: "handoff"; data: { from: Speaker; to: Speaker; briefing: string | null } };

export function formatSseEvent(e: ServerStreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}