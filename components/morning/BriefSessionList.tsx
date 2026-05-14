"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefCard, MorningBriefExercise } from "@/lib/data/types";

export function BriefSessionList({
  session,
  isSwapped,
  liveType,
}: {
  session: MorningBriefCard["session"];
  isSwapped: boolean;
  liveType: string | null;
}) {
  const { exercises, volume_gaps } = session;

  if (exercises.length === 0) {
    return (
      <div>
        <div style={{ fontSize: 13, color: COLOR.textMuted, fontStyle: "italic" }}>
          No exercises planned for this session type.
        </div>
        {volume_gaps && volume_gaps.length > 0 && (
          <VolumeGapsBanner gaps={volume_gaps} />
        )}
      </div>
    );
  }
  return (
    <div>
      <div
        style={{
          background: COLOR.surfaceAlt,
          borderRadius: 10,
          overflow: "hidden",
          opacity: isSwapped ? 0.4 : 1,
          transition: "opacity 0.2s",
        }}
      >
        {exercises.map((e, i) => (
          <div
            key={`${e.name}-${i}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 12px",
              borderTop: i === 0 ? "none" : `1px solid ${COLOR.divider}`,
              gap: 8,
            }}
            aria-label={ariaForExercise(e)}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: COLOR.textStrong,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {e.name}
              </div>
              {e.note && (
                <div style={{ fontSize: 11, color: COLOR.textFaint, fontStyle: "italic" }}>
                  {e.note}
                </div>
              )}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                flexShrink: 0,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
                {e.kg !== null ? `${e.kg} kg` : "BW"}
              </div>
              <div style={{ fontSize: 11, color: COLOR.textMuted, lineHeight: 1.2 }}>
                {e.sets} × {e.reps}
              </div>
            </div>
          </div>
        ))}
      </div>
      {volume_gaps && volume_gaps.length > 0 && (
        <VolumeGapsBanner gaps={volume_gaps} />
      )}
      {isSwapped && (
        <p
          style={{
            marginTop: "8px",
            fontSize: "12px",
            color: COLOR.textMuted,
            fontStyle: "italic",
          }}
        >
          Swapped to {liveType} —{" "}
          <a href="/strength" style={{ color: COLOR.accent }}>
            see /strength
          </a>{" "}
          for the new session.
        </p>
      )}
    </div>
  );
}

function VolumeGapsBanner({
  gaps,
}: {
  gaps: NonNullable<MorningBriefCard["session"]["volume_gaps"]>;
}) {
  const gapText = gaps
    .map(
      (g) =>
        `${g.group} (${g.actual}/wk vs ${g.target} ${g.label === "below_mev" ? "MEV" : "MRV"})`,
    )
    .join(", ");
  return (
    <div
      role="note"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: COLOR.warningSoft,
        border: `1px solid ${COLOR.warning}`,
        borderRadius: 8,
        fontSize: 13,
        color: COLOR.warningDeep,
      }}
    >
      ⚠ <strong>Volume gaps:</strong> {gapText}{" "}
      <span style={{ fontStyle: "italic" }}>— coach details below.</span>
    </div>
  );
}

function ariaForExercise(e: MorningBriefExercise): string {
  const weight = e.kg !== null ? `${e.kg} kilograms` : "bodyweight";
  return `${e.name}, ${weight}, ${e.sets} sets of ${e.reps} reps`;
}
