"use client";

import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";
import type {
  MuscleVolumeBand,
  MuscleVolumeSnapshot,
  TargetedMuscleGroup,
  VolumeRampRecipe,
} from "@/lib/data/types";
import { COLOR } from "@/lib/ui/theme";

export function MuscleVolumeRow({
  group,
  snapshot,
  band,
  rampRecipe,
  currentBlockWeek,
  mode,
  onSelect,
}: {
  group: TargetedMuscleGroup;
  snapshot: MuscleVolumeSnapshot;
  band: MuscleVolumeBand | null;
  rampRecipe: VolumeRampRecipe | null;
  currentBlockWeek: number | null;
  mode: "avg_8wk" | "week_to_date";
  onSelect: () => void;
}) {
  const actual =
    mode === "avg_8wk"
      ? snapshot.rolling_avg_8wk[group]
      : snapshot.current_week_to_date[group];

  const trackMax =
    band !== null
      ? Math.max(band.mrv * 1.1, actual * 1.1)
      : Math.max(actual * 1.5, 10);

  const thisWeekTarget =
    band !== null && rampRecipe !== null && currentBlockWeek !== null
      ? targetSetsForWeek(band, rampRecipe, currentBlockWeek)
      : null;

  const status = band
    ? actual < band.mev
      ? "below MEV"
      : actual > band.mrv
        ? "over MRV"
        : actual > band.mav[1]
          ? "near MRV"
          : "in band"
    : "no plan";

  const sparkValues = snapshot.weekly_history.map((w) => w.volumes[group]);
  const sparkMax = Math.max(1, ...sparkValues);

  const topContribs = snapshot.top_exercises_per_muscle[group] ?? [];

  return (
    <button
      onClick={onSelect}
      className="w-full text-left p-3 rounded-lg cursor-pointer"
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        color: COLOR.textStrong,
      }}
    >
      <div className="flex justify-between items-center mb-2">
        <strong>{group}</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{status}</span>
      </div>

      <Track actual={actual} band={band} trackMax={trackMax} />

      <div className="flex justify-between mt-1.5" style={{ fontSize: 12, opacity: 0.7 }}>
        <span>
          {mode === "avg_8wk" ? "8wk avg" : "This week"}: {actual} sets/wk
        </span>
        {thisWeekTarget !== null && (
          <span>
            Target wk {currentBlockWeek}/5: {thisWeekTarget}
          </span>
        )}
      </div>

      <Sparkline values={sparkValues} max={sparkMax} />

      {topContribs.length > 0 && (
        <div className="mt-1.5" style={{ fontSize: 11, opacity: 0.7 }}>
          Top: {topContribs.map((e) => `${e.name} (${e.sets})`).join(" · ")}
        </div>
      )}
    </button>
  );
}

function Track({
  actual,
  band,
  trackMax,
}: {
  actual: number;
  band: { mev: number; mav: [number, number]; mrv: number } | null;
  trackMax: number;
}) {
  const pct = (v: number) => `${Math.min(100, (v / trackMax) * 100)}%`;
  return (
    <div
      style={{
        position: "relative",
        height: 18,
        background: COLOR.surfaceAlt,
        borderRadius: 4,
      }}
    >
      {band !== null && (
        <>
          <div
            style={{
              position: "absolute",
              left: pct(band.mav[0]),
              width: `calc(${pct(band.mav[1])} - ${pct(band.mav[0])})`,
              top: 0,
              bottom: 0,
              background: COLOR.successSoft,
              opacity: 1,
            }}
          />
          <Marker left={pct(band.mev)} color={COLOR.textMuted} label={`MEV ${band.mev}`} />
          <Marker left={pct(band.mav[0])} color={COLOR.success} label={`MAV lower ${band.mav[0]}`} />
          <Marker left={pct(band.mav[1])} color={COLOR.success} label={`MAV upper ${band.mav[1]}`} />
          <Marker left={pct(band.mrv)} color={COLOR.danger} label={`MRV ${band.mrv}`} />
        </>
      )}
      <div
        style={{
          position: "absolute",
          left: `calc(${pct(actual)} - 6px)`,
          top: 3,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: COLOR.textStrong,
        }}
        aria-label={`Actual ${actual}`}
      />
    </div>
  );
}

function Marker({ left, color, label }: { left: string; color: string; label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top: 0,
        bottom: 0,
        width: 1,
        background: color,
      }}
      aria-label={label}
    />
  );
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  const W = 120;
  const H = 24;
  const step = W / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${H - (v / max) * H}`);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="mt-1.5"
      aria-label={`8-week history sparkline; latest ${values[values.length - 1] ?? 0}`}
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={COLOR.textMuted}
        strokeWidth={1.5}
      />
    </svg>
  );
}
