"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefExercise } from "@/lib/data/types";

export function BriefSessionList({ exercises }: { exercises: MorningBriefExercise[] }) {
  if (exercises.length === 0) {
    return (
      <div style={{ fontSize: 13, color: COLOR.textMuted, fontStyle: "italic" }}>
        No exercises planned for this session type.
      </div>
    );
  }
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: 10,
        overflow: "hidden",
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
  );
}

function ariaForExercise(e: MorningBriefExercise): string {
  const weight = e.kg !== null ? `${e.kg} kilograms` : "bodyweight";
  return `${e.name}, ${weight}, ${e.sets} sets of ${e.reps} reps`;
}
