// lib/morning/script.ts
//
// Pure data: copy constants for the morning intake bot.
// The sequential slot list (SLOTS, SLOT_BY_KEY, SlotDef, SlotKey) has been
// retired in favour of the one-tap card. Remaining exports: sickness flow,
// still-sick gate, sync-recovery parking, and the card prompt.

export type SlotChip = { label: string; value: string | number };

export const SORENESS_AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;

export const MORNING_FORM_PROMPT = "Morning. How are you today?";

export const STILL_SICK_RECOVERED_PREFIX = "Good to hear. ";

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

export const SYNC_RECOVERY_PROMPT =
  "Garmin hasn't synced last night's recovery yet. Sync your watch in Garmin Connect and run the collector, then tap Recheck — or skip and I'll build a feel-only plan from the last 7 days.";

export const SYNC_RECOVERY_FAILED_PROMPT =
  "Still no recovery data. Recheck again, or skip and I'll give you a feel-only plan.";
