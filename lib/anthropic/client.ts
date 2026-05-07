// Thin Anthropic Messages API wrapper — no SDK, just fetch.
// Returns the assistant text content joined; callers JSON-parse if they want.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

export type Message = { role: "user" | "assistant"; content: string };

export type CallOptions = {
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Mark the system prompt as a cacheable prefix to lower repeated-call cost. */
  cacheSystem?: boolean;
};

export async function callClaude(messages: Message[], opts: CallOptions = {}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (and Vercel env) and redeploy.",
    );
  }
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 1200,
    messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.system) {
    body.system = opts.cacheSystem
      ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
      : opts.system;
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
    .join("");
}

/** Strips ```json fences and parses to T. Throws if not valid JSON. */
export function parseClaudeJson<T>(raw: string): T {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in response");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

// ── Streaming + multimodal ────────────────────────────────────────────────────
// Used by the chat surface. Separate from `callClaude` so the JSON-shaped
// insights paths stay simple.
//
// CacheControl / ContentBlock / RichMessage live in `lib/chat/types.ts` —
// the canonical home shared with `lib/coach/chat-stream.ts`. Re-exported
// here so existing import paths keep working.

export type { CacheControl, ContentBlock, RichMessage } from "@/lib/chat/types";
import type { CacheControl, RichMessage } from "@/lib/chat/types";

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type StreamOptions = {
  model?: string;
  /** System prompt as a single string OR typed blocks (for cache_control). */
  system?: string | { type: "text"; text: string; cache_control?: CacheControl }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

/**
 * Stream a Claude response. Yields delta events as they arrive, then `done`
 * at clean end, or `error` on failure. The signal is forwarded to fetch so
 * cancelling actually closes the underlying HTTP connection.
 *
 * Anthropic's SSE format is:
 *     event: content_block_delta
 *     data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}
 *
 * Frames are separated by \n\n. We accumulate into a buffer and only process
 * complete frames (avoids the "delta split across reads" bug).
 */
export async function* streamClaude(
  messages: RichMessage[],
  opts: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set" };
    return;
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? "claude-sonnet-4-5",
    max_tokens: opts.maxTokens ?? 2000,
    stream: true,
    messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.system) body.system = opts.system;

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Defensive: prompt caching is now GA on most API versions; this header
        // is a no-op when caching is GA but enables it on older versions.
        "anthropic-beta": "prompt-caching-2024-07-31",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    yield { type: "error", message: `fetch failed: ${(e as Error).message}` };
    return;
  }

  if (!res.ok || !res.body) {
    const errText = res.body ? await res.text() : `HTTP ${res.status}`;
    yield { type: "error", message: `Anthropic ${res.status}: ${errText.slice(0, 500)}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Process complete frames separated by \n\n.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        // Each frame has lines like "event: <name>" and "data: <json>".
        let eventName = "";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
        }
        if (!dataLine) continue;
        if (eventName === "content_block_delta") {
          try {
            const parsed = JSON.parse(dataLine) as {
              delta?: { type?: string; text?: string };
            };
            if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
              yield { type: "delta", text: parsed.delta.text };
            }
            // Other delta types (thinking_delta, input_json_delta) are ignored.
          } catch {
            // Malformed event line; skip.
          }
        } else if (eventName === "message_stop") {
          // Anthropic signals end of stream — let the read-loop conclude.
        } else if (eventName === "error") {
          try {
            const parsed = JSON.parse(dataLine) as { error?: { message?: string } };
            yield {
              type: "error",
              message: parsed.error?.message ?? "anthropic_stream_error",
            };
            return;
          } catch {
            yield { type: "error", message: "anthropic_stream_error" };
            return;
          }
        }
      }
    }
    yield { type: "done" };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      yield { type: "error", message: "aborted" };
      return;
    }
    yield { type: "error", message: `stream read failed: ${(e as Error).message}` };
  }
}
