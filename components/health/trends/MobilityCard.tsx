// components/health/trends/MobilityCard.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader } from "@/components/health/trends/HrvAutonomicSection";
import { formatDateLabel } from "@/components/health/trends/format";
import { COLOR } from "@/lib/ui/theme";

type Props = { payload: RecoveryIntelligencePayload };

export function MobilityCard({ payload }: Props) {
  const { subjective, derived } = payload;
  // Group 28 days into 4 rows of 7 (Mon→Sun), oldest first.
  // Use the actual weekday of each date.
  const grid: Array<Array<{ date: string; done: boolean } | null>> = [[], [], [], []];
  // Find the Monday on or before subjective[0].date so the grid starts on Mon.
  const first = new Date(`${subjective[0].date}T00:00:00Z`);
  const firstDow = (first.getUTCDay() + 6) % 7; // Mon=0
  // Pad with nulls to start of week.
  for (let i = 0; i < firstDow; i++) grid[0].push(null);
  let row = 0;
  for (const p of subjective) {
    grid[row].push({ date: p.date, done: p.mobility_done });
    if (grid[row].length === 7) { row++; if (row >= 4) break; }
  }
  while (grid[3].length < 7) grid[3].push(null);

  const pct = derived.mobility_completion_pct_28d;
  const tone: "good" | "warn" | "bad" = pct >= 0.7 ? "good" : pct >= 0.4 ? "warn" : "bad";

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Mobility · adherence</h3>
      <Card>
        <CardHeader title="Mobility completion · 28d"
          sub={`Current streak: ${derived.mobility_current_streak_days} days · ${subjective.filter((s) => s.mobility_done).length}/28 done`}
          value={`${Math.round(derived.mobility_completion_pct_28d * 100)}%`} tone={tone} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {grid.map((rowCells, ri) => (
            <div key={ri} style={{ display: "flex", gap: 2, alignItems: "center" }}>
              <div style={{ fontSize: 10, color: COLOR.textMid, width: 60, flexShrink: 0 }}>W{ri + 1}</div>
              {rowCells.map((c, i) => (
                <div
                  key={i}
                  title={c ? `${formatDateLabel(c.date)}: mobility ${c.done ? "done" : "not done"}` : undefined}
                  style={{
                    flex: 1, height: 14, borderRadius: 2,
                    background: c?.done ? "rgba(74,222,128,0.65)" : COLOR.divider,
                    cursor: c ? "pointer" : "default",
                  }}
                />
              ))}
            </div>
          ))}
          <div style={{ display: "flex", gap: 2, marginLeft: 60 }}>
            {["M","T","W","T","F","S","S"].map((d, i) => (
              <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 9, color: COLOR.textMuted }}>{d}</div>
            ))}
          </div>
        </div>
      </Card>
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};
