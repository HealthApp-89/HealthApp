// lib/chat/sse.ts
//
// Server-side helper: format one SSE event as a string ready to write to
// a ReadableStream. The format is:
//
//     event: <name>\n
//     data: <json>\n
//     \n
//
// Each event MUST end with a blank line (\n\n) — that's the frame boundary
// the client's line-buffer parser splits on.

export type ServerStreamEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { message_id: string; partial?: boolean } }
  | { event: "error"; data: { message: string } };

export function formatSseEvent(e: ServerStreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
