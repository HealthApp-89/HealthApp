"use client";

import { useState } from "react";
import { useMuscleVolume } from "@/lib/query/hooks/useMuscleVolume";
import { useAthleteProfile } from "@/lib/query/hooks/useAthleteProfile";
import { TARGETED_MUSCLE_GROUPS, type TargetedMuscleGroup } from "@/lib/data/types";
import type { MuscleVolumeSnapshot, StrengthMuscleVolume } from "@/lib/data/types";
import { MuscleVolumeBodyMap } from "./MuscleVolumeBodyMap";
import { MuscleVolumeRow } from "./MuscleVolumeRow";
import { MuscleContributorDrawer } from "./MuscleContributorDrawer";

export function ByMuscleView({
  userId,
  todayIso,
}: {
  userId: string;
  todayIso: string;
}) {
  const [mode, setMode] = useState<"avg_8wk" | "week_to_date">("avg_8wk");
  const [drawerMuscle, setDrawerMuscle] = useState<TargetedMuscleGroup | null>(null);

  const {
    data: snapshot,
    isLoading: snapLoading,
    isError: snapError,
  } = useMuscleVolume(userId, todayIso);

  const { data: profile } = useAthleteProfile(userId);
  const activePlan = profile?.plan_payload ?? null;
  const muscleVolume: StrengthMuscleVolume | null =
    activePlan?.strength?.muscle_volume ?? null;

  // currentBlockWeek: would normally come from training_blocks; for v1 we
  // pass null and the row falls back — future PR can thread an active-block hook.
  const currentBlockWeek: number | null = null;

  if (snapError) {
    return (
      <div role="alert" style={{ padding: 16 }}>
        Failed to load muscle volume. Refresh to retry.
      </div>
    );
  }
  if (snapLoading || !snapshot) {
    return <div style={{ padding: 16 }}>Loading muscle volume…</div>;
  }

  const sortedMuscles = [...TARGETED_MUSCLE_GROUPS].sort(
    (a, b) =>
      rankMuscle(a, snapshot, muscleVolume) -
      rankMuscle(b, snapshot, muscleVolume),
  );

  return (
    <div>
      {muscleVolume === null && (
        <div
          role="status"
          style={{
            padding: 12,
            background: "var(--mc-surface, #1f2937)",
            border: "1px solid var(--mc-border, #374151)",
            borderRadius: 8,
            marginBottom: 12,
            color: "var(--mc-text, #e5e7eb)",
          }}
        >
          Volume targets not yet prescribed. Per-muscle bands need an active
          plan with muscle_volume.{" "}
          <a href="/onboarding" style={{ color: "var(--mc-link, #60a5fa)" }}>
            Generate plan
          </a>{" "}
          or{" "}
          <a href="/profile" style={{ color: "var(--mc-link, #60a5fa)" }}>
            regenerate existing plan
          </a>
          .
        </div>
      )}

      <MuscleVolumeBodyMap snapshot={snapshot} muscleVolume={muscleVolume} />

      <div className="flex gap-2 my-4">
        <ModeButton active={mode === "avg_8wk"} onClick={() => setMode("avg_8wk")}>
          8wk avg
        </ModeButton>
        <ModeButton
          active={mode === "week_to_date"}
          onClick={() => setMode("week_to_date")}
        >
          Week to date
        </ModeButton>
      </div>

      <div className="flex flex-col gap-3">
        {sortedMuscles.map((g) => (
          <MuscleVolumeRow
            key={g}
            group={g}
            snapshot={snapshot}
            band={muscleVolume?.bands[g] ?? null}
            rampRecipe={muscleVolume?.ramp_recipe ?? null}
            currentBlockWeek={currentBlockWeek}
            mode={mode}
            onSelect={() => setDrawerMuscle(g)}
          />
        ))}
      </div>

      <NonTargetedFooter />

      {drawerMuscle && (
        <MuscleContributorDrawer
          group={drawerMuscle}
          snapshot={snapshot}
          onClose={() => setDrawerMuscle(null)}
        />
      )}
    </div>
  );
}

function rankMuscle(
  g: TargetedMuscleGroup,
  snapshot: MuscleVolumeSnapshot,
  muscleVolume: StrengthMuscleVolume | null,
): number {
  if (!muscleVolume) return 1; // no plan — neutral ordering
  const actual = snapshot.rolling_avg_8wk[g];
  const band = muscleVolume.bands[g];
  if (actual < band.mev) return 0;
  if (actual > band.mrv) return 1;
  if (actual > band.mav[1]) return 2;
  return 3;
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "6px 12px",
        background: active ? "var(--mc-tab-active, #374151)" : "transparent",
        color: "var(--mc-text, #e5e7eb)",
        border: "1px solid var(--mc-border, #374151)",
        borderRadius: 6,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function NonTargetedFooter() {
  return (
    <details style={{ marginTop: 24, opacity: 0.7 }}>
      <summary style={{ cursor: "pointer", fontSize: 13 }}>
        6 muscles tracked but not targeted (compound work covers them)
      </summary>
      <div style={{ padding: 12, fontSize: 12 }}>
        FrontDelts / Serratus / Abs / Obliques / Brachialis / Soleus — these
        muscles get stimulus from compound lifts but lack literature-grade
        MEV/MAV/MRV consensus. No prescription is generated; volume is implied
        from your bench / OHP / row / squat / deadlift work.
      </div>
    </details>
  );
}
