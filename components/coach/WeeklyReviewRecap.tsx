"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { WeeklyReviewPayload } from "@/lib/data/types";

export function WeeklyReviewRecap({
  recap,
}: {
  recap: WeeklyReviewPayload["recap"];
}) {
  const adherence =
    recap.sessions_planned > 0
      ? Math.round((recap.sessions_done / recap.sessions_planned) * 100)
      : null;

  return (
    <Card>
      <SectionLabel>LAST WEEK RECAP</SectionLabel>
      <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>
        {recap.sessions_done}/{recap.sessions_planned} sessions
        {adherence != null ? ` · ${adherence}%` : ""}
      </div>
      {recap.sessions_skipped.length > 0 && (
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          Skipped:{" "}
          {recap.sessions_skipped.map((s) => `${s.day} (${s.type})`).join(", ")}
        </div>
      )}
      {(recap.sessions_injury_excused ?? []).length > 0 && (
        <div style={{ fontSize: 11, color: "#b45309", marginTop: 4 }}>
          Injury excused:{" "}
          {(recap.sessions_injury_excused ?? [])
            .map((s) => `${s.day} — skipped (${s.area} injury)`)
            .join(", ")}
        </div>
      )}
      <div
        style={{
          height: 1,
          background: COLOR.divider,
          margin: "8px 0",
        }}
      />
      <table
        style={{
          width: "100%",
          fontSize: 11,
          fontFamily: "var(--font-dm-mono), monospace",
          borderCollapse: "collapse",
        }}
      >
        <tbody>
          {recap.per_lift.map((p) => (
            <tr key={p.lift}>
              <td style={{ color: COLOR.textMuted, width: "40%", padding: "2px 0" }}>
                {shortName(p.lift)}
              </td>
              <td style={{ color: COLOR.textStrong, padding: "2px 0" }}>
                {fmtNum(p.top_set.weight_kg)}×{p.top_set.reps}×{p.top_set.sets}
              </td>
              <td
                style={{
                  color:
                    p.e1rm_delta_kg && p.e1rm_delta_kg > 0
                      ? COLOR.success
                      : COLOR.textMuted,
                  textAlign: "right",
                  padding: "2px 0",
                }}
              >
                {p.e1rm_delta_kg != null
                  ? `e1RM ${p.e1rm_delta_kg > 0 ? "+" : ""}${fmtNum(p.e1rm_delta_kg)}kg`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        style={{ height: 1, background: COLOR.divider, margin: "8px 0" }}
      />
      <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: COLOR.textMuted }}>Sleep</div>
          <div>
            {recap.sleep.avg_h != null ? `${fmtNum(recap.sleep.avg_h)}h` : "—"}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: COLOR.textMuted }}>Protein</div>
          <div>
            {recap.nutrition.protein_avg_g != null
              ? `${fmtNum(recap.nutrition.protein_avg_g)}g`
              : "—"}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: COLOR.textMuted }}>Weight</div>
          <div>
            {recap.weight.delta_kg != null
              ? `${recap.weight.delta_kg > 0 ? "+" : ""}${fmtNum(recap.weight.delta_kg)}kg`
              : "—"}
          </div>
        </div>
      </div>
    </Card>
  );
}

function shortName(n: string): string {
  return n.replace(/\s*\([^)]+\)/, "");
}
