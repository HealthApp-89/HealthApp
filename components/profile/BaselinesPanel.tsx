"use client";

import { useState } from "react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { StatusRow } from "@/components/ui/StatusRow";
import { COLOR } from "@/lib/ui/theme";
import type { Profile, Rolling30dBaselines, MetricBaseline } from "@/lib/data/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  profile: Pick<Profile, "whoop_baselines"> | null;
};

const STATUS_GLYPH: Record<MetricBaseline["status"], string> = {
  establishing: "…",
  partial: "●",
  stable: "✓",
};

const STATUS_COLOR: Record<MetricBaseline["status"], string> = {
  establishing: COLOR.textFaint,
  partial: COLOR.warning,
  stable: COLOR.success,
};

function MetricRow({ label, unit, m }: { label: string; unit: string; m: MetricBaseline | undefined }) {
  if (!m) {
    return <StatusRow label={label} value={<span style={{ color: COLOR.textFaint }}>—</span>} />;
  }
  return (
    <StatusRow
      label={label}
      value={
        <span style={{ fontFamily: "monospace", color: COLOR.textStrong }}>
          {m.mean == null ? "—" : `${fmtNum(m.mean)} ± ${fmtNum(m.sd ?? 0)}`}{" "}
          <span style={{ color: COLOR.textFaint, fontSize: "11px" }}>{unit}</span>
          {"  "}
          <span style={{ color: STATUS_COLOR[m.status], fontSize: "11px" }}>
            {m.days}/30 {STATUS_GLYPH[m.status]}
          </span>
        </span>
      }
    />
  );
}

export function BaselinesPanel({ profile }: Props) {
  const wb = (profile?.whoop_baselines as { rolling_30d?: Rolling30dBaselines } & Record<string, unknown> | null) ?? null;
  const r = wb?.rolling_30d ?? null;
  const [showHistorical, setShowHistorical] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [recalibrateError, setRecalibrateError] = useState<string | null>(null);

  async function onRecalibrate() {
    setRecalibrating(true);
    setRecalibrateError(null);
    try {
      const res = await fetch("/api/profile/baselines/recalibrate", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Hard refresh — the profile query cache is keyed elsewhere; full reload
      // is simpler than threading invalidation here.
      window.location.reload();
    } catch (e) {
      setRecalibrateError(e instanceof Error ? e.message : String(e));
      setRecalibrating(false);
    }
  }

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionLabel>ROLLING 30-DAY BASELINES</SectionLabel>
        <button
          onClick={onRecalibrate}
          disabled={recalibrating}
          style={{
            fontSize: "11px",
            color: COLOR.textFaint,
            background: "none",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: "6px",
            padding: "4px 8px",
            cursor: recalibrating ? "default" : "pointer",
          }}
        >
          {recalibrating ? "Recalibrating…" : "Recalibrate now"}
        </button>
      </div>
      <div style={{ fontSize: "10px", color: COLOR.textFaint, marginBottom: "8px" }}>
        {r ? `Updated ${r.computed_at.slice(0, 16).replace("T", " ")} UTC` : "Awaiting first cron run"}
        {recalibrateError ? ` · error: ${recalibrateError}` : ""}
      </div>
      <div style={{ borderRadius: "12px", overflow: "hidden", border: `1px solid ${COLOR.divider}` }}>
        <MetricRow label="HRV" unit="ms" m={r?.hrv} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Resting HR" unit="bpm" m={r?.rhr} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Recovery score" unit="%" m={r?.recovery} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Sleep performance" unit="%" m={r?.sleep_performance} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Respiratory rate" unit="rpm" m={r?.resp_rate} />
      </div>

      <button
        onClick={() => setShowHistorical((v) => !v)}
        style={{
          marginTop: "16px",
          background: "none",
          border: "none",
          color: COLOR.textFaint,
          fontSize: "11px",
          cursor: "pointer",
          textAlign: "left" as const,
          padding: 0,
        }}
      >
        {showHistorical ? "▾" : "▸"} Historical anchors (biographical context)
      </button>
      {showHistorical && wb ? (
        <pre style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "8px", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(
            Object.fromEntries(Object.entries(wb).filter(([k]) => k !== "rolling_30d")),
            null,
            2,
          )}
        </pre>
      ) : null}
    </Card>
  );
}
