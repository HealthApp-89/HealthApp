// lib/morning/script.ts
//
// Pure data: the scripted question list for the morning intake. Each entry
// describes one slot — its prompt copy, the chip values it accepts, and how
// it renders. Order matters: nextSlot() in state.ts walks this list and
// returns the first slot whose checkin column is null.
//
// Slot shapes are intentionally narrow — chip values map 1:1 to DB column
// values (e.g. fatigue chips emit 'none' | 'some' | 'heavy', not free text).
// Any new slot here must be paired with a CheckinRow column.

import type { FatigueLevel, SorenessSeverity } from "@/lib/data/types";

export type SlotKey =
  | "readiness"
  | "energy_label"
  | "mood"
  | "soreness_gate"
  | "soreness_areas"
  | "soreness_severity"
  | "fatigue"
  | "bloating";

export type SlotChip = { label: string; value: string | number };

export type SlotDef = {
  key: SlotKey;
  prompt: string;
  chips: SlotChip[];
  multi_select?: boolean;
};

export const SORENESS_AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;

export const SLOTS: SlotDef[] = [
  {
    key: "readiness",
    prompt: "Morning. How does the body feel today?",
    chips: Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: i + 1 })),
  },
  {
    key: "energy_label",
    prompt: "Where's your energy at?",
    chips: [
      { label: "Low",    value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High",   value: "high" },
    ],
  },
  {
    key: "mood",
    prompt: "And the mood?",
    chips: [
      { label: "😔", value: "😔" },
      { label: "😐", value: "😐" },
      { label: "😊", value: "😊" },
      { label: "🔥", value: "🔥" },
    ],
  },
  {
    key: "soreness_gate",
    prompt: "Anything sore?",
    chips: [
      { label: "No",  value: "no" },
      { label: "Yes", value: "yes" },
    ],
  },
  {
    key: "soreness_areas",
    prompt: "Where? (tap all that apply)",
    chips: SORENESS_AREAS.map((a) => ({ label: a[0].toUpperCase() + a.slice(1), value: a })),
    multi_select: true,
  },
  {
    key: "soreness_severity",
    prompt: "How sore — mild or sharp?",
    chips: [
      { label: "Mild",  value: "mild" satisfies SorenessSeverity },
      { label: "Sharp", value: "sharp" satisfies SorenessSeverity },
    ],
  },
  {
    key: "fatigue",
    prompt: "Any leftover fatigue beyond normal?",
    chips: [
      { label: "None",  value: "none" satisfies FatigueLevel },
      { label: "Some",  value: "some" satisfies FatigueLevel },
      { label: "Heavy", value: "heavy" satisfies FatigueLevel },
    ],
  },
  {
    key: "bloating",
    prompt: "Feeling bloated at all?",
    chips: [
      { label: "No",  value: "no" },
      { label: "Yes", value: "yes" },
    ],
  },
];

/** Lookup table for the route handler. */
export const SLOT_BY_KEY: Record<SlotKey, SlotDef> = Object.fromEntries(
  SLOTS.map((s) => [s.key, s]),
) as Record<SlotKey, SlotDef>;

export const STILL_SICK_PROMPT = "Still feeling under the weather?";
export const STILL_SICK_CHIPS: SlotChip[] = [
  { label: "Yes", value: "yes" },
  { label: "No",  value: "no" },
];

export const SICKNESS_NOTES_PROMPT = "Sorry to hear that. What's going on?";

export const REST_DAY_MESSAGE_HEALTHY_TO_SICK =
  "Take it easy today — REST locked in. I'll check back in tomorrow. (Undo via the Log page if needed.)";

export const REST_DAY_MESSAGE_STILL_SICK =
  "REST again today then — hope you bounce back soon.";

export const FREE_TEXT_TAIL_PROMPT =
  "Anything else worth flagging? (or just hit send if you're good)";

export const SYNC_WHOOP_PROMPT =
  "WHOOP hasn't synced yet — usually arrives within 30 min of waking. Tap below to pull it now, or I'll deliver the plan when it lands.";

export const SYNC_WHOOP_FAILED_PROMPT =
  "WHOOP sync still pending. Try again, or skip and I'll give you a feel-only plan from the last 7 days.";
