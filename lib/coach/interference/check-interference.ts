// lib/coach/interference/check-interference.ts — strength↔endurance autoregulation.
// Phase 1: light rule. Returns 'none' for Z2 base at <5h/wk (always, in current phase).
// Phase 2: formal rules for build/race_prep phases.

import type { EnduranceProfile } from "@/lib/coach/endurance/types";

export type InterferenceAdjustment = {
  adjustment: "none" | "reduce_15pct" | "reduce_30pct";
  rationale: string;
};

export function strengthVolumeAdjustment(
  profile: EnduranceProfile | null,
  endurance7dHours: number,
): InterferenceAdjustment {
  if (!profile) {
    return { adjustment: "none", rationale: "No endurance profile configured." };
  }
  if (profile.phase === "aerobic_base" && endurance7dHours < 5) {
    return { adjustment: "none", rationale: "Z2 base volume too low to cause interference." };
  }
  if (profile.phase === "build" && endurance7dHours > 8) {
    return { adjustment: "reduce_15pct", rationale: "Build-phase endurance volume causing measurable interference." };
  }
  if (profile.phase === "race_prep" && endurance7dHours > 10) {
    return { adjustment: "reduce_30pct", rationale: "Race-prep volume — strength maintenance only." };
  }
  return { adjustment: "none", rationale: "" };
}
