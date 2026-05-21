// components/chat/SpeakerChip.tsx
//
// Small pill rendered above each assistant message bubble identifying the
// speaker (Peter / Carter / Nora / Remi). Sourced from the SPEAKER_DISPLAY +
// SPEAKER_COLOR registry in lib/coach/speakers.ts so colors and labels stay
// in lockstep with handoff lines and the broader speaker UI.
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
  const px =
    size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full border ${color.bg} ${color.fg} ${color.border} ${px} uppercase tracking-wider`}
    >
      {display.name}
    </span>
  );
}
