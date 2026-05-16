"use client";

import { useState } from "react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type { CoachTrendsPayload, CrossInsight, TrendWindow } from "@/lib/data/types";
import { WindowToggle } from "./WindowToggle";
import { ScatterChart } from "./ScatterChart";

export function CrossSection({ insights }: { insights: CoachTrendsPayload["cross_insights"] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <PairCard pair="nutrition_x_weight" title="Nutrition × Weight" insights={insights} />
      <PairCard pair="volume_x_recovery" title="Volume × Recovery" insights={insights} />
    </div>
  );
}

function PairCard({
  pair,
  title,
  insights,
}: {
  pair: CrossInsight["pair"];
  title: string;
  insights: CrossInsight[];
}) {
  const [win, setWin] = useState<TrendWindow>("4w");
  const [chartOpen, setChartOpen] = useState(false);
  const insight = insights.find((c) => c.pair === pair && c.window === win);

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionLabel>{title}</SectionLabel>
        <WindowToggle value={win} onChange={setWin} />
      </div>
      {insight ? (
        <>
          <p style={{ fontSize: 12, color: COLOR.textStrong, marginTop: 8, lineHeight: 1.5 }}>
            {insight.insight_md}
          </p>
          <button
            type="button"
            onClick={() => setChartOpen((v) => !v)}
            style={{
              marginTop: 8,
              background: "transparent",
              border: "none",
              color: COLOR.accent,
              fontSize: 11,
              padding: 0,
              cursor: "pointer",
            }}
          >
            {chartOpen ? "Hide chart ↑" : "Open chart →"}
          </button>
          {chartOpen && (
            <div style={{ marginTop: 8 }}>
              <ScatterChart
                points={insight.points}
                slope={insight.slope}
                intercept={insight.intercept}
              />
            </div>
          )}
        </>
      ) : (
        <p style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 6 }}>
          Not enough data yet for this window ({win}). Need at least {win === "4w" ? "4" : "8"} weeks of paired data.
        </p>
      )}
    </Card>
  );
}
