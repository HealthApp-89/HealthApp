"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { WeeklyReviewPayload } from "@/lib/data/types";

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
                  }}
                >
                  {p.rationale_tag.replaceAll("_", " ")}
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
