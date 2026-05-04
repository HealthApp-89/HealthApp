// components/chat/sseClient.ts
//
// POST a JSON body and consume an SSE stream. Uses fetch + ReadableStream —
// EventSource doesn't support POST. Parses SSE frames with an accumulating
// line buffer (frames separated by \n\n; each frame can have multiple lines
// including "event:" and "data:").

import type { ChatStreamEvent } from "@/lib/chat/types";

export type SseConsumerOptions = {
  signal?: AbortSignal;
};

export async function* postSse(
  url: string,
  body: unknown,
  opts: SseConsumerOptions = {},
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    let reason = `http_${res.status}`;
    try {
      const json = (await res.json()) as { reason?: string };
      if (json.reason) reason = json.reason;
    } catch {
      // ignore
    }
    yield { type: "error", message: reason };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let eventName = "";
      let dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!dataLine) continue;
      try {
        const data = JSON.parse(dataLine);
        if (eventName === "delta") {
          yield { type: "delta", text: data.text as string };
        } else if (eventName === "done") {
          yield {
            type: "done",
            message_id: data.message_id as string,
            partial: data.partial as boolean | undefined,
          };
        } else if (eventName === "error") {
          yield { type: "error", message: data.message as string };
        }
      } catch {
        // Malformed; skip.
      }
    }
  }
}
