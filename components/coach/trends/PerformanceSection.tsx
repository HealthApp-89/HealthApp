"use client";

import { useState } from "react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload, TrendWindow } from "@/lib/data/types";
import { SectionSubHeader } from "./SectionSubHeader";
import { WindowToggle } from "./WindowToggle";
import { ChangeBadge } from "./ChangeBadge";

function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}

export function PerformanceSection({
  strength,
  recovery,
}: {
  strength: CoachTrendsPayload["strength"];
  recovery: CoachTrendsPayload["recovery"];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Strength" />
        <SpeakerChip speaker="carter" size="sm" />
      </div>
      {strength.per_lift.map((p) => <LiftCard key={p.lift} per={p} />)}

      <SectionSubHeader label="Recovery" />
      <Card>
        <SectionLabel>SLEEP</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {recovery.sleep.avg_h_4w != null ? `${fmtNum(recovery.sleep.avg_h_4w)}h` : "n/a"} avg · {recovery.sleep.avg_efficiency_pct_4w != null ? `${fmtNum(recovery.sleep.avg_efficiency_pct_4w)} score` : "n/a"}
        </div>
      </Card>
      <Card>
        <SectionLabel>HRV</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {recovery.hrv.avg_4w != null ? fmtNum(recovery.hrv.avg_4w) : "n/a"}
        </div>
        <div style={{ marginTop: 4 }}>
          <ChangeBadge valuePct={recovery.hrv.vs_baseline_pct_4w} label="vs baseline" />
        </div>
      </Card>
      <Card>
        <SectionLabel>RESTING HR</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {recovery.rhr.avg_bpm_4w != null ? `${fmtNum(recovery.rhr.avg_bpm_4w)} bpm` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          Δ4w {recovery.rhr.delta_4w_bpm != null ? `${recovery.rhr.delta_4w_bpm > 0 ? "+" : ""}${fmtNum(recovery.rhr.delta_4w_bpm)} bpm` : "n/a"}
        </div>
      </Card>
    </div>
  );
}

function LiftCard({ per }: { per: CoachTrendsPayload["strength"]["per_lift"][number] }) {
  const [win, setWin] = useState<TrendWindow>("4w");
  const slope = win === "4w" ? per.slope_pct_per_wk_4w : per.slope_pct_per_wk_12w;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionLabel>{shortLift(per.lift)}</SectionLabel>
        <WindowToggle value={win} onChange={setWin} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
        {per.e1rm_kg_now != null ? `${fmtNum(per.e1rm_kg_now)} kg e1RM` : "n/a"}
      </div>
      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
        <ChangeBadge valuePct={slope} label={`/wk · ${win}`} />
        {per.plateau_active && (
          <span style={{ fontSize: 10, color: "#d97706", fontWeight: 700 }}>
            PLATEAU {per.plateau_weeks_flat}w
          </span>
        )}
      </div>
    </Card>
  );
}
