"use client";

import {
  MUSCLE_ID,
  MUSCLE_VIEW,
  TARGET_GROUP_FOR_MUSCLE,
  type MuscleId,
} from "@/lib/coach/exercise-muscles";
import type {
  MuscleVolumeSnapshot,
  StrengthMuscleVolume,
} from "@/lib/data/types";
import { COLOR } from "@/lib/ui/theme";

type Status =
  | "no_plan"
  | "below_mev"
  | "in_band"
  | "near_mrv"
  | "over_mrv"
  | "not_targeted";

const STATUS_FILL: Record<Status, string> = {
  no_plan: COLOR.textFaint,
  below_mev: COLOR.warning,
  in_band: COLOR.success,
  near_mrv: COLOR.warningDeep,
  over_mrv: COLOR.danger,
  not_targeted: COLOR.divider,
};

const STATUS_OPACITY: Record<Status, number> = {
  no_plan: 0.6,
  below_mev: 0.8,
  in_band: 0.7,
  near_mrv: 0.85,
  over_mrv: 0.85,
  not_targeted: 0.5,
};

export function MuscleVolumeBodyMap({
  snapshot,
  muscleVolume,
}: {
  snapshot: MuscleVolumeSnapshot;
  muscleVolume: StrengthMuscleVolume | null;
}) {
  const muscleStatuses = computeMuscleStatuses(snapshot, muscleVolume);

  return (
    <div className="flex justify-center gap-2">
      <BodyView side="front" muscleStatuses={muscleStatuses} />
      <BodyView side="back" muscleStatuses={muscleStatuses} />
    </div>
  );
}

function computeMuscleStatuses(
  snapshot: MuscleVolumeSnapshot,
  muscleVolume: StrengthMuscleVolume | null,
): Map<MuscleId, Status> {
  const out = new Map<MuscleId, Status>();
  for (const idValue of Object.values(MUSCLE_ID)) {
    const mid = idValue as MuscleId;
    const group = TARGET_GROUP_FOR_MUSCLE[mid];
    if (!group) {
      out.set(mid, "not_targeted");
      continue;
    }
    if (!muscleVolume) {
      out.set(mid, "no_plan");
      continue;
    }
    const actual = snapshot.rolling_avg_8wk[group];
    const band = muscleVolume.bands[group];
    if (actual < band.mev) out.set(mid, "below_mev");
    else if (actual > band.mrv) out.set(mid, "over_mrv");
    else if (actual > band.mav[1]) out.set(mid, "near_mrv");
    else out.set(mid, "in_band");
  }
  return out;
}

function BodyView({
  side,
  muscleStatuses,
}: {
  side: "front" | "back";
  muscleStatuses: Map<MuscleId, Status>;
}) {
  return (
    <div style={{ position: "relative", width: 180, aspectRatio: "1 / 2" }}>
      <img
        src={`/anatomy/${side}.svg`}
        alt={`${side} body`}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {Array.from(muscleStatuses.entries())
        .filter(([mid]) => MUSCLE_VIEW[mid] === side)
        .map(([mid, status]) => (
          <div
            key={mid}
            style={{
              position: "absolute",
              inset: 0,
              maskImage: `url(/anatomy/main-${mid}.svg)`,
              WebkitMaskImage: `url(/anatomy/main-${mid}.svg)`,
              maskSize: "100% 100%",
              WebkitMaskSize: "100% 100%",
              background: STATUS_FILL[status],
              opacity: STATUS_OPACITY[status],
              pointerEvents: "none",
            }}
            aria-label={`Muscle ${mid}: ${status}`}
          />
        ))}
    </div>
  );
}
