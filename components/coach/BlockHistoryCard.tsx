"use client";

import type { BlockTrajectoryPayload, BlockPhaseAtEnd } from "@/lib/data/types";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Props = { payload: BlockTrajectoryPayload };

const PHASE_COLOR: Record<BlockPhaseAtEnd, string> = {
  hit_early:      COLOR.success,
  hit_on_pace:    COLOR.success,
  off_pace:       COLOR.danger,
  underperformed: COLOR.warning,
};

function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}

export function BlockHistoryCard({ payload }: Props) {
  return (
    <Card id="block-history" style={{ marginTop: 4 }}>
      <SectionLabel>BLOCK HISTORY</SectionLabel>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: COLOR.textStrong,
          marginTop: 4,
          marginBottom: 10,
        }}
      >
        Macrocycle view
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {payload.per_lift.map((line) => (
          <div key={line.lift} style={{ fontSize: 12, color: COLOR.textMid }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontWeight: 600, textTransform: "capitalize", color: COLOR.textStrong }}>
                {shortLift(line.lift)}
              </span>
              <span>
                {line.long_term_progression_kg_per_year != null
                  ? `+${fmtNum(line.long_term_progression_kg_per_year)} kg/yr`
                  : "tbd"}
                {" · "}
                <span style={{ color: COLOR.textFaint }}>
                  {line.target_calibration_trend === "insufficient_data"
                    ? "—"
                    : `calibration ${line.target_calibration_trend}`}
                </span>
              </span>
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
              {line.blocks.length === 0 ? (
                <span style={{ color: COLOR.textFaint, fontSize: 11 }}>never focused</span>
              ) : (
                line.blocks.map((b) => (
                  <span
                    key={b.block_id}
                    title={`${b.window.start_date} → ${b.window.end_date} · target ${b.target_kg ?? "n/a"} · end ${b.end_working_kg ?? "n/a"}`}
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      background: PHASE_COLOR[b.block_phase_at_end] ?? COLOR.textMuted,
                    }}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: `1px solid ${COLOR.divider}`,
          fontSize: 12,
          color: COLOR.textMid,
        }}
      >
        Rotation adherence:{" "}
        <strong style={{ color: COLOR.textStrong }}>
          {fmtNum(payload.rotation_adherence.adherence_pct)}%
        </strong>
        {payload.rotation_adherence.deviations.length > 0 && (
          <span style={{ color: COLOR.textFaint }}>
            {" "}
            ({payload.rotation_adherence.deviations.length} deviation
            {payload.rotation_adherence.deviations.length === 1 ? "" : "s"})
          </span>
        )}
        {" · "}Next focus due:{" "}
        <strong style={{ textTransform: "capitalize", color: COLOR.textStrong }}>
          {payload.next_focus_due ?? "—"}
        </strong>
      </div>
    </Card>
  );
}
