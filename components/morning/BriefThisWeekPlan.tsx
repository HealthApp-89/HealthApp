"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { ThisWeekPlanBlock } from "@/lib/data/types";

function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}

export function BriefThisWeekPlan({ plan }: { plan: ThisWeekPlanBlock }) {
  return (
    <Card>
      <SectionLabel>
        THIS WEEK · WK {plan.week_n}/{plan.total_weeks} · {plan.phase_now.toUpperCase()}
        {plan.phase_changed_this_week ? " · NEW PHASE" : ""}
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
            <th style={{ textAlign: "left" }}>LIFT</th>
            <th style={{ textAlign: "right" }}>LOAD</th>
            <th style={{ textAlign: "right" }}>SETS×REPS</th>
            <th style={{ textAlign: "right" }}>RIR</th>
          </tr>
        </thead>
        <tbody>
          {plan.per_lift.map((p) => (
            <tr key={p.lift}>
              <td style={{ color: COLOR.textStrong, padding: "2px 0" }}>{shortLift(p.lift)}</td>
              <td style={{ textAlign: "right", color: COLOR.textStrong }}>
                {fmtNum(p.load_kg)}kg
                {p.delta_from_last_week_pct != null && (
                  <span
                    style={{
                      color:
                        p.delta_from_last_week_pct > 0
                          ? "#16a34a"
                          : p.delta_from_last_week_pct < 0
                          ? "#dc2626"
                          : COLOR.textMuted,
                      fontSize: 9,
                      marginLeft: 4,
                    }}
                  >
                    ({p.delta_from_last_week_pct > 0 ? "+" : ""}
                    {fmtNum(p.delta_from_last_week_pct * 100)}%)
                  </span>
                )}
              </td>
              <td style={{ textAlign: "right", color: COLOR.textMuted }}>
                {p.sets}×{p.reps}
              </td>
              <td style={{ textAlign: "right", color: COLOR.textMuted }}>
                {p.rir_target != null ? p.rir_target : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.volume_summary.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: COLOR.textMuted }}>
          <strong style={{ color: COLOR.textStrong }}>Volume targets:</strong>{" "}
          {plan.volume_summary.map((v) => `${v.muscle} ${v.sets} (${v.tier})`).join(" · ")}
        </div>
      )}
      {plan.weekly_focus && (
        <div style={{ marginTop: 6, fontSize: 11, color: COLOR.textMuted, fontStyle: "italic" }}>
          Focus: {plan.weekly_focus}
        </div>
      )}
    </Card>
  );
}
