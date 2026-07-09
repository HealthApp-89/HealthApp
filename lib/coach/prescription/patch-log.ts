// lib/coach/prescription/patch-log.ts
//
// Client-safe repatch_log guards for the morning-ladder patch. This module
// imports TYPES ONLY — client components (MorningPatchChip) import from here;
// pulling these from patch-today.ts would drag the server-only import graph
// (prescribe-week → fetchMuscleVolumeServer) into the client bundle.

import type { RepatchLogEntry } from "@/lib/data/types";

/** True when today already has an (applied) morning patch entry. */
export function hasMorningPatchEntry(log: RepatchLogEntry[] | null, todayIso: string): boolean {
  if (!Array.isArray(log)) return false;
  return log.some((e) => e.reason === "morning_checkin" && e.workout_date === todayIso);
}

/** True when today's morning patch has been reverted. */
export function hasMorningRevertEntry(log: RepatchLogEntry[] | null, todayIso: string): boolean {
  if (!Array.isArray(log)) return false;
  return log.some((e) => e.reason === "morning_checkin_revert" && e.workout_date === todayIso);
}
