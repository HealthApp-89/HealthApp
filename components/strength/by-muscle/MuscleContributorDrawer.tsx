"use client";

import type { MuscleVolumeSnapshot, TargetedMuscleGroup } from "@/lib/data/types";

export function MuscleContributorDrawer({
  group,
  snapshot,
  onClose,
}: {
  group: TargetedMuscleGroup;
  snapshot: MuscleVolumeSnapshot;
  onClose: () => void;
}) {
  const contribs = snapshot.top_exercises_per_muscle[group] ?? [];
  // The 8wk muscle total: rolling_avg_8wk is sets/wk; × 8 reconstructs the
  // 8-week absolute total (in same primary-1.0 + secondary-0.5 units as
  // top_exercises_per_muscle, since both flow through the same counting).
  // Using this denominator means percentages reflect the true share of the
  // muscle's volume — including contributions from exercises that didn't
  // make the top-3 cut. Top-3 sums of 100% would be misleading otherwise.
  const groupTotal8wk = snapshot.rolling_avg_8wk[group] * 8;

  return (
    <div
      role="dialog"
      aria-label={`${group} volume contributors`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxHeight: "70vh",
          overflowY: "auto",
          background: "var(--mc-surface, #1f2937)",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: 24,
          color: "var(--mc-text, #e5e7eb)",
        }}
      >
        <div className="flex justify-between mb-4">
          <h2 style={{ margin: 0 }}>{group}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              fontSize: 24,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        <p style={{ opacity: 0.7, marginBottom: 16 }}>
          Top exercise contributors over the last 8 weeks. Counted by working
          sets per the {snapshot.rolling_avg_8wk[group]} sets/wk rolling avg.
        </p>

        {contribs.length === 0 && (
          <p>No exercises mapped to {group} in the last 8 weeks.</p>
        )}

        {contribs.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 0" }}>Exercise</th>
                <th style={{ textAlign: "right", padding: "8px 0" }}>Sets (8wk)</th>
                <th style={{ textAlign: "right", padding: "8px 0" }}>% of {group}</th>
              </tr>
            </thead>
            <tbody>
              {contribs.map((c) => (
                <tr key={c.name}>
                  <td style={{ padding: "6px 0" }}>{c.name}</td>
                  <td style={{ textAlign: "right" }}>{c.sets}</td>
                  <td style={{ textAlign: "right" }}>
                    {groupTotal8wk > 0 ? `${Math.round((c.sets / groupTotal8wk) * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
