"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { JargonPill } from "@/components/coach/JargonPill";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { stripPrescriptionSuffix } from "@/lib/coach/glossary";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { WeeklyReviewPayload, Speaker, PrescriptionRationaleTag } from "@/lib/data/types";

/**
 * Map prescription rationale tags to the coach specialist who proposed it.
 * - Lift swaps / set-rep adjustments → Carter
 * - Deficit / macro adjustments → Nora
 * - Deload / sleep recommendations → Remi
 * - Block transitions / strategic shifts → Peter
 */
function getRationaleTagSpeaker(tag: PrescriptionRationaleTag): Speaker {
  const cleanTag = tag.replace(/_increment_floor|_increment_capped$/, "");

  // Carter: lifting mechanics, rep completions, RIR issues, MEV/MAV/MRV
  // progression (v1) AND the BlockPhase execution tags (v2).
  if (
    cleanTag === "cutting_hold" ||
    cleanTag === "recovery_hold" ||
    cleanTag === "rep_completion_miss" ||
    cleanTag === "rir_missed_twice" ||
    cleanTag === "rir_missed" ||
    cleanTag === "form_hold" ||
    cleanTag === "mev_to_mav_clearance" ||
    cleanTag === "mav_to_mav_step" ||
    cleanTag === "mav_to_mrv_advance" ||
    cleanTag === "mrv_volume_drive" ||
    cleanTag === "plateau_rep_shift" ||
    cleanTag === "pre_target_step" ||
    cleanTag === "pre_target_hold" ||
    cleanTag === "off_pace_hold"
  ) {
    return "carter";
  }

  // Peter: block structure, periodization, major phase transitions.
  if (
    cleanTag === "block_start_baseline" ||
    cleanTag === "plateau_deload_reset" ||
    cleanTag === "deload_load_volume_cut" ||
    cleanTag === "consolidation_hold_progress_reps" || // block-level "we hit target" verdict
    cleanTag === "deload_floor"                        // block-level "week 5" verdict
  ) {
    return "peter";
  }

  return "peter";
}

export function WeeklyReviewPrescription({
  prescription,
  recap,
}: {
  prescription: WeeklyReviewPayload["prescription"];
  recap: WeeklyReviewPayload["recap"];
}) {
  return (
    <Card>
      <SectionLabel>
        NEXT WEEK PRESCRIPTION · {prescription.phase.toUpperCase()}
      </SectionLabel>
      <table
        style={{
          width: "100%",
          fontSize: 11,
          fontFamily: "var(--font-dm-mono), monospace",
          marginTop: 8,
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr style={{ color: COLOR.textFaint, fontSize: 9 }}>
            <th style={{ textAlign: "left", padding: "2px 0" }}>LIFT</th>
            <th style={{ textAlign: "right", padding: "2px 0" }}>LAST</th>
            <th style={{ textAlign: "right", padding: "2px 0" }}>NEXT</th>
            <th style={{ textAlign: "right", padding: "2px 0" }}>WHY</th>
          </tr>
        </thead>
        <tbody>
          {prescription.per_lift.map((p) => {
            const last = recap.per_lift.find((r) => r.lift === p.lift)?.top_set;
            const speaker = getRationaleTagSpeaker(p.rationale_tag);
            return (
              <tr key={p.lift}>
                <td style={{ padding: "2px 0" }}>{shortName(p.lift)}</td>
                <td
                  style={{
                    textAlign: "right",
                    color: COLOR.textMuted,
                    padding: "2px 0",
                  }}
                >
                  {last ? `${fmtNum(last.weight_kg)}×${last.reps}×${last.sets}` : "—"}
                </td>
                <td style={{ textAlign: "right", padding: "2px 0" }}>
                  {fmtNum(p.weight_kg)}×{p.reps}×{p.sets}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    color: COLOR.textFaint,
                    padding: "2px 0",
                    display: "flex",
                    gap: 4,
                    alignItems: "center",
                    justifyContent: "flex-end",
                  }}
                >
                  <JargonPill termKey={stripPrescriptionSuffix(p.rationale_tag)}>
                    {p.rationale_tag.replaceAll("_", " ")}
                  </JargonPill>
                  <SpeakerChip speaker={speaker} size="sm" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function shortName(n: string): string {
  return n.replace(/\s*\([^)]+\)/, "");
}
