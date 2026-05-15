"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { CIRCUMFERENCE_METRICS } from "@/lib/charts/circumferenceChartConfig";
import type { HealthTrendPoint } from "@/lib/query/fetchers/healthTrend";
import type { BodyMeasurement } from "@/lib/data/types";

const RANGES = [
  { id: "1w",  label: "1W",  days: 7 },
  { id: "1m",  label: "1M",  days: 30 },
  { id: "3m",  label: "3M",  days: 90 },
  { id: "6m",  label: "6M",  days: 180 },
  { id: "1y",  label: "1Y",  days: 365 },
  { id: "all", label: "All", days: 0 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

export function TrendView({
  bodyComp,
  measurements,
  todayIso,
}: {
  bodyComp: HealthTrendPoint[];
  measurements: BodyMeasurement[]; // newest-first
  todayIso: string;
}) {
  const [range, setRange] = useState<RangeId>("1y");

  const cutoff = useMemo(() => {
    const r = RANGES.find((x) => x.id === range)!;
    if (r.days === 0) return null;
    const d = new Date(todayIso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - r.days);
    return d.toISOString().slice(0, 10);
  }, [range, todayIso]);

  const filteredBodyComp = useMemo(
    () => (cutoff ? bodyComp.filter((p) => p.date >= cutoff) : bodyComp),
    [bodyComp, cutoff],
  );

  // measurements is newest-first; we need oldest-first for sparklines
  const measAsc = useMemo(() => [...measurements].reverse(), [measurements]);
  const filteredMeas = useMemo(
    () => (cutoff ? measAsc.filter((m) => m.measured_on >= cutoff) : measAsc),
    [measAsc, cutoff],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Range
        </span>
        <div style={{ display: "flex", gap: "6px" }}>
          {RANGES.map((r) => {
            const active = r.id === range;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setRange(r.id)}
                style={{
                  padding: "6px 10px",
                  fontSize: "11px",
                  fontWeight: 700,
                  border: "none",
                  borderRadius: RADIUS.pill,
                  background: active ? COLOR.accent : COLOR.surfaceAlt,
                  color: active ? "#fff" : COLOR.textMid,
                  cursor: "pointer",
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <BodyCompTrendCards points={filteredBodyComp} />

      <CircumferenceSparklines measurements={filteredMeas} />
    </div>
  );
}

function BodyCompTrendCards({ points }: { points: HealthTrendPoint[] }) {
  const FIELDS: { key: keyof HealthTrendPoint; label: string; unit: string; color: string }[] = [
    { key: "weight_kg",        label: "Weight",    unit: "kg", color: "#4f5dff" },
    { key: "body_fat_pct",     label: "Body fat",  unit: "%",  color: "#ef4444" },
    { key: "fat_free_mass_kg", label: "Lean mass", unit: "kg", color: "#14b870" },
    { key: "muscle_mass_kg",   label: "Muscle",    unit: "kg", color: "#3b82f6" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
      {FIELDS.map((f) => {
        const series = points
          .map((p) => ({ x: p.date, y: (p[f.key] as number | null) ?? null }))
          .filter((p) => p.y != null) as { x: string; y: number }[];
        const first = series[0]?.y ?? null;
        const last = series[series.length - 1]?.y ?? null;
        const d = first != null && last != null ? last - first : null;
        return (
          <Card variant="compact" key={f.key as string}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {f.label}
            </div>
            <div data-tnum style={{ fontSize: "18px", fontWeight: 700, color: COLOR.textStrong, marginTop: "4px" }}>
              {fmtNum(last)} <span style={{ fontSize: "11px", color: COLOR.textMuted }}>{f.unit}</span>
            </div>
            <div data-tnum style={{ fontSize: "11px", color: d == null ? COLOR.textFaint : d < 0 ? COLOR.success : COLOR.danger, fontWeight: 600 }}>
              {d == null ? "—" : `${d > 0 ? "+" : ""}${fmtNum(d)}`} since start
            </div>
            <Sparkline series={series} color={f.color} />
          </Card>
        );
      })}
    </div>
  );
}

function CircumferenceSparklines({ measurements }: { measurements: BodyMeasurement[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
      {CIRCUMFERENCE_METRICS.map((m) => {
        const series = measurements
          .map((row) => ({ x: row.measured_on, y: m.read(row) }))
          .filter((p) => p.y != null) as { x: string; y: number }[];
        const first = series[0]?.y ?? null;
        const last = series[series.length - 1]?.y ?? null;
        const d = first != null && last != null ? last - first : null;
        return (
          <Card variant="compact" key={m.id}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {m.label}
            </div>
            <div data-tnum style={{ fontSize: "18px", fontWeight: 700, color: COLOR.textStrong, marginTop: "4px" }}>
              {last == null ? "—" : fmtNum(last, m.id === "whr" ? 3 : 1)}
              {m.unit && <span style={{ fontSize: "11px", color: COLOR.textMuted, marginLeft: "4px" }}>{m.unit}</span>}
            </div>
            <div data-tnum style={{ fontSize: "11px", color: d == null ? COLOR.textFaint : d < 0 ? COLOR.success : COLOR.danger, fontWeight: 600 }}>
              {d == null ? "—" : `${d > 0 ? "+" : ""}${fmtNum(d, m.id === "whr" ? 3 : 1)}`} since start
            </div>
            <Sparkline series={series} color={m.color} />
          </Card>
        );
      })}
    </div>
  );
}

/** Minimal SVG sparkline — avoids depending on /trends' chart primitives
 *  (their range pills and interpolation aren't needed at this resolution). */
function Sparkline({ series, color }: { series: { x: string; y: number }[]; color: string }) {
  if (series.length < 2) {
    return (
      <div style={{ height: "32px", display: "flex", alignItems: "center", fontSize: "10px", color: COLOR.textFaint }}>
        Need ≥ 2 points
      </div>
    );
  }
  const values = series.map((p) => p.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const W = 120;
  const H = 32;
  const range = max - min || 1;
  const pts = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * W;
      const y = H - ((p.y - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ marginTop: "6px", display: "block" }}>
      <polyline fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" points={pts} />
      {series.map((_, i) => {
        const x = (i / (series.length - 1)) * W;
        const y = H - ((series[i].y - min) / range) * H;
        return <circle key={i} cx={x} cy={y} r={1.6} fill={color} />;
      })}
    </svg>
  );
}
