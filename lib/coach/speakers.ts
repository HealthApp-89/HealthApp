// lib/coach/speakers.ts
//
// Speaker registry: display names, colors, system-prompt + tool-list lookups.
// One source of truth for the 4-coach team. Importers should never inline
// speaker-related literals.

import type { Speaker, ChatSpeaker } from "@/lib/data/types";

export const SPEAKER_DISPLAY: Record<Speaker, { name: string; role: string }> = {
  peter:  { name: "Peter",         role: "Head Coach" },
  carter: { name: "Coach Carter",  role: "Strength" },
  nora:   { name: "Nora",          role: "Nutrition" },
  remi:   { name: "Remi",          role: "Recovery" },
};

/** Background + text + border colors for the speaker chip rendered next to
 *  each assistant message. Picked to read on the dark theme. */
export const SPEAKER_COLOR: Record<Speaker, { bg: string; fg: string; border: string }> = {
  peter:  { bg: "bg-zinc-800",  fg: "text-zinc-100",   border: "border-zinc-600" },
  carter: { bg: "bg-red-950",   fg: "text-red-200",    border: "border-red-700" },
  nora:   { bg: "bg-emerald-950", fg: "text-emerald-200", border: "border-emerald-700" },
  remi:   { bg: "bg-cyan-950",  fg: "text-cyan-200",   border: "border-cyan-700" },
};

/** Display label for a speaker — e.g., "Peter · Head Coach". */
export function speakerLabel(s: Speaker): string {
  const d = SPEAKER_DISPLAY[s];
  return `${d.name} · ${d.role}`;
}

/** Short label (just the name). */
export function speakerName(s: Speaker): string {
  return SPEAKER_DISPLAY[s].name;
}

/** True when the speaker is one of the assistant coaches (vs the user). */
export function isCoachSpeaker(s: ChatSpeaker): s is Speaker {
  return s !== "user";
}
