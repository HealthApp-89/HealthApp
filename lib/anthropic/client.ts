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
