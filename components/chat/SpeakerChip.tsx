// components/chat/SpeakerChip.tsx
//
// Pill rendered above each assistant message bubble identifying the speaker
// (Peter / Carter / Nora / Remi). sm = name-only pill for inline use;
// md = name · role format for the chat thread header.
// Sourced from SPEAKER_DISPLAY + SPEAKER_COLOR in lib/coach/speakers.ts —
// one source of truth for colors, names, and roles.
"use client";

import { SPEAKER_DISPLAY, SPEAKER_COLOR } from "@/lib/coach/speakers";
import type { Speaker } from "@/lib/data/types";

export function SpeakerChip({
  speaker,
  size = "sm",
}: {
  speaker: Speaker;
  size?: "sm" | "md";
}) {
  const display = SPEAKER_DISPLAY[speaker];
  const color = SPEAKER_COLOR[speaker];
  // Defensive: a value outside the registry (stale chat_messages row,
  // SSE event with a transient stub speaker, mis-cast from `unknown`)
  // used to throw `undefined is not an object (evaluating 'o.bg')` and
  // tear down the whole chat thread on /diet + /strength (2026-05-22).
  // Fail soft, log so we can find the caller.
  if (!display || !color) {
    if (typeof window !== "undefined") {
      console.warn("[SpeakerChip] unknown speaker:", speaker);
    }
    return null;
  }

  if (size === "md") {
    // md: name + role for chat-thread header — scannable when scrolling history
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border ${color.bg} ${color.fg} ${color.border}`}
        style={{ padding: "4px 12px", fontSize: 12, fontWeight: 700, letterSpacing: "0.02em" }}
      >
        <span>{display.name}</span>
        <span style={{ opacity: 0.45, fontWeight: 400 }}>·</span>
        <span style={{ opacity: 0.7, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>{display.role}</span>
      </span>
    );
  }

  // sm: name-only pill, slightly more legible than before
  return (
    <span
      className={`inline-flex items-center rounded-full border ${color.bg} ${color.fg} ${color.border} uppercase tracking-wider`}
      style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700 }}
    >
      {display.name}
    </span>
  );
}
