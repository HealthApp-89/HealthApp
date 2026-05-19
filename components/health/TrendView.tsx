"use client";

import { useMemo, useState } from "react";
import { MetricCard, type MetricDatum } from "@/components/charts/MetricCard";
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

type RangeId = (typeof RANGES)[number]["id"] | "custom";

export function TrendView({
  bodyComp,
  measurements,
  todayIso,
  trendFromIso,
}: {
  bodyComp: HealthTrendPoint[];
  measurements: BodyMeasurement[]; // newest-first
  todayIso: string;
  /** Lower bound of the prefetched body-comp window (12 months before today). */
  trendFromIso: string;
}) {
  const [range, setRange] = useState<RangeId>("1y");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");

  const bounds = useMemo<{ from: string | null; to: string | null }>(() => {
    if (range === "custom") {
      return { from: customFrom || null, to: customTo || null };
    }
    const r = RANGES.find((x) => x.id === range)!;
    if (r.days === 0) return { from: null, to: null };
    const d = new Date(todayIso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - r.days);
    return { from: d.toISOString().slice(0, 10), to: null };
  }, [range, customFrom, customTo, todayIso]);

  const filteredBodyComp = useMemo(
    () =>
      bodyComp.filter(
        (p) =>
          (bounds.from == null || p.date >= bounds.from) &&
          (bounds.to == null || p.date <= bounds.to),
      ),
    [bodyComp, bounds],
  );

  // measurements is newest-first; we need oldest-first for sparklines
  const measAsc = useMemo(() => [...measurements].reverse(), [measurements]);
  const filteredMeas = useMemo(
    () =>
      measAsc.filter(
        (m) =>
          (bounds.from == null || m.measured_on >= bounds.from) &&
          (bounds.to == null || m.measured_on <= bounds.to),
      ),
    [measAsc, bounds],
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
          <button
            type="button"
            onClick={() => {
              if (!customFrom) {
                const d = new Date(todayIso + "T00:00:00Z");
                d.setUTCDate(d.getUTCDate() - 30);
                setCustomFrom(d.toISOString().slice(0, 10));
              }
              if (!customTo) setCustomTo(todayIso);
              setRange("custom");
            }}
            style={{
              padding: "6px 10px",
              fontSize: "11px",
              fontWeight: 700,
              border: "none",
              borderRadius: RADIUS.pill,
              background: range === "custom" ? COLOR.accent : COLOR.surfaceAlt,
              color: range === "custom" ? "#fff" : COLOR.textMid,
              cursor: "pointer",
            }}
          >
            Custom
          </button>
        </div>
      </div>

      {range === "custom" && (
        <div
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <input
            type="date"
            value={customFrom}
            min={trendFromIso}
            max={customTo || todayIso}
            onChange={(e) => setCustomFrom(e.target.value)}
            style={{
              padding: "4px 8px",
              fontSize: "12px",
              border: `1px solid ${COLOR.surfaceAlt}`,
              borderRadius: RADIUS.input,
              background: COLOR.surface,
              color: COLOR.textStrong,
              colorScheme: "dark",
            }}
          />
          <span style={{ fontSize: "11px", color: COLOR.textMuted }}>→</span>
          <input
            type="date"
            value={customTo}
            min={customFrom}
            max={todayIso}
            onChange={(e) => setCustomTo(e.target.value)}
            style={{
              padding: "4px 8px",
              fontSize: "12px",
              border: `1px solid ${COLOR.surfaceAlt}`,
              borderRadius: RADIUS.input,
              background: COLOR.surface,
              color: COLOR.textStrong,
              colorScheme: "dark",
            }}
          />
          <button
            type="button"
            onClick={() => setRange("1y")}
            aria-label="Reset range"
            style={{
              padding: "2px 8px",
              fontSize: "14px",
              lineHeight: 1,
              border: "none",
              borderRadius: RADIUS.pill,
              background: COLOR.surfaceAlt,
              color: COLOR.textMid,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      )}

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
        const series: MetricDatum[] = points.map((p) => ({
          date: p.date,
          value: (p[f.key] as number | null) ?? null,
        }));
        const present = series.filter(
          (p): p is { date: string; value: number } => p.value != null,
        );
        const first = present[0]?.value ?? null;
        const last = present[present.length - 1]?.value ?? null;
        const d = first != null && last != null ? last - first : null;
        const subtitle = d == null
          ? undefined
          : `${d > 0 ? "+" : d < 0 ? "−" : ""}${fmtNum(Math.abs(d))} ${f.unit} since start`;
        return (
          <MetricCard
            key={f.key as string}
            title={f.label}
            value={last}
            unit={f.unit}
            subtitle={subtitle}
            data={series}
            color={f.color}
            type="area"
          />
        );
      })}
    </div>
  );
}

function CircumferenceSparklines({ measurements }: { measurements: BodyMeasurement[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
      {CIRCUMFERENCE_METRICS.map((m) => {
        const series: MetricDatum[] = measurements.map((row) => ({
          date: row.measured_on,
          value: m.read(row),
        }));
        const present = series.filter(
          (p): p is { date: string; value: number } => p.value != null,
        );
        const first = present[0]?.value ?? null;
        const last = present[present.length - 1]?.value ?? null;
        const d = first != null && last != null ? last - first : null;
        const decimals = m.id === "whr" ? 3 : 1;
        const subtitle = d == null
          ? undefined
          : `${d > 0 ? "+" : d < 0 ? "−" : ""}${fmtNum(Math.abs(d), decimals)}${m.unit ? ` ${m.unit}` : ""} since start`;
        return (
          <MetricCard
            key={m.id}
            title={m.label}
            value={last}
            unit={m.unit}
            subtitle={subtitle}
            data={series}
            color={m.color}
            type="area"
          />
        );
      })}
    </div>
  );
}
