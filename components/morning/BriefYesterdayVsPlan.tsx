"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { YesterdayVsPlanBlock } from "@/lib/data/types";

function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}

export function BriefYesterdayVsPlan({ block }: { block: YesterdayVsPlanBlock }) {
  return (
    <Card>
      <SectionLabel>
        YESTERDAY VS PLAN
        {block.swap_applied ? " · SWAPPED" : ""}
      </SectionLabel>
      {!block.session_logged && (
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 6, fontStyle: "italic" }}>
          No session logged yesterday.
        </div>
      )}
      {block.session_logged && block.per_lift.length === 0 && (
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 6 }}>
          No big-four lifts in yesterday's session.
        </div>
      )}
      {block.session_logged && block.per_lift.length > 0 && (
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
              <th style={{ textAlign: "right" }}>PLAN</th>
              <th style={{ textAlign: "right" }}>ACTUAL</th>
              <th style={{ textAlign: "right" }}>REPS %</th>
            </tr>
          </thead>
          <tbody>
            {block.per_lift.map((p) => {
              const planned = `${fmtNum(p.planned.load_kg)}×${p.planned.sets}×${p.planned.reps}`;
              const actual = p.actual
                ? `${fmtNum(p.actual.top_set_load_kg ?? 0)}×${p.actual.sets_done}`
                : "—";
              const repsPct =
                p.reps_completed_pct != null
                  ? `${fmtNum(p.reps_completed_pct * 100)}%`
                  : "—";
              const repsColor =
                p.reps_completed_pct == null
                  ? COLOR.textMuted
                  : p.reps_completed_pct >= 0.9
                  ? "#16a34a"
                  : p.reps_completed_pct >= 0.75
                  ? COLOR.textStrong
                  : "#dc2626";
              return (
                <tr key={p.lift}>
                  <td style={{ color: COLOR.textStrong, padding: "2px 0" }}>{shortLift(p.lift)}</td>
                  <td style={{ textAlign: "right", color: COLOR.textMuted }}>{planned}</td>
                  <td style={{ textAlign: "right", color: COLOR.textStrong }}>{actual}</td>
                  <td style={{ textAlign: "right", color: repsColor }}>{repsPct}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
