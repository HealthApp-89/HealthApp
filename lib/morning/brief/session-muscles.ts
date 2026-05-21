// lib/morning/brief/session-muscles.ts
//
// Maps each SESSION_PLANS session type to the muscle-group keys it taxes,
// using the same vocabulary as SORENESS_AREAS in lib/morning/script.ts
// (chest, back, legs, shoulders, arms, core). Used by pickCoachSuggestion
// to detect when the user's reported soreness overlaps today's session.
//
// "Arms" is intentionally coarse (chest day for triceps via pushdowns,
// back day for biceps via pulldowns/rows). Mobility and REST have no
// targeted muscles — they're recovery sessions and never trigger a swap
// recommendation regardless of soreness.

export const SESSION_MUSCLE_MAP: Record<string, readonly string[]> = {
  Chest: ["chest", "shoulders", "arms"],
  Back: ["back", "arms"],
  Legs: ["legs"],
  Mobility: [],
  REST: [],
};

/** Case-insensitive overlap check. Returns the matching area names from
 *  `sorenessAreas` (preserving caller's casing) for use in the user-visible
 *  `detail` string. Empty array = no overlap. */
export function muscleOverlap(
  sorenessAreas: string[] | null,
  sessionType: string,
): string[] {
  if (!sorenessAreas || sorenessAreas.length === 0) return [];
  const targets = SESSION_MUSCLE_MAP[sessionType];
  if (!targets || targets.length === 0) return [];
  const targetSet = new Set(targets.map((t) => t.toLowerCase()));
  return sorenessAreas.filter((a) => targetSet.has(a.toLowerCase()));
}
