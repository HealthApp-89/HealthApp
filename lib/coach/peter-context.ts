// lib/coach/peter-context.ts
//
// Generates the "Recent specialist activity" block injected into Peter's
// system prompt when the user chats with him on /metrics. Pure templating —
// no LLM call, no fabrication risk.
//
// Reads the last 5 user-visible turns from each specialist's thread
// (Carter/Nora/Remi), formats them as bullets the model can ground on
// when answering cross-domain questions.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Speaker } from "@/lib/data/types";

const SPECIALISTS: ReadonlyArray<Exclude<Speaker, "peter" | "user">> = ["carter", "nora", "remi"];
const PER_THREAD_LIMIT = 5;

const SPECIALIST_LABEL: Record<Exclude<Speaker, "peter" | "user">, string> = {
  carter: "Coach Carter (strength)",
  nora: "Nora (nutrition)",
  remi: "Remi (recovery)",
};

type Row = { speaker: string; content: string; created_at: string };

/** Returns the formatted context block, or null if all specialist threads
 *  are empty (skip the block entirely rather than emit "no activity"). */
export async function buildPeterContextBlock(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const sections = await Promise.all(
    SPECIALISTS.map(async (sp) => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("speaker, content, created_at")
        .eq("user_id", userId)
        .eq("thread", sp)
        .in("kind", ["coach", "proactive_nudge"])
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(PER_THREAD_LIMIT);

      if (error || !data || data.length === 0) return null;
      return { speaker: sp, rows: data.reverse() as Row[] };
    }),
  );

  const present = sections.filter(
    (s): s is { speaker: Exclude<Speaker, "peter" | "user">; rows: Row[] } => s !== null,
  );
  if (present.length === 0) return null;

  const lines: string[] = ["# Recent specialist activity\n"];
  for (const section of present) {
    lines.push(`## ${SPECIALIST_LABEL[section.speaker]}`);
    for (const r of section.rows) {
      const date = r.created_at.slice(0, 10);
      const snippet = r.content.replace(/\s+/g, " ").trim().slice(0, 160);
      lines.push(`- ${date}: ${snippet}${snippet.length === 160 ? "…" : ""}`);
    }
    lines.push("");
  }

  lines.push(
    "When answering cross-domain questions, ground in the specialist activity above. If the user asks about a topic a specialist recently discussed, reference that conversation by date. You do not need to repeat the specialists' advice — synthesize across them.",
  );

  return lines.join("\n");
}
