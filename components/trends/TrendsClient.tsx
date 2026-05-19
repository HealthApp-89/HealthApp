// components/trends/TrendsClient.tsx
"use client";

import { useState, useMemo } from "react";
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard, type MetricDatum } from "@/components/charts/MetricCard";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { useDailyLogsTrend } from "@/lib/query/hooks/useDailyLogsTrend";
import {
  resolvePeriod,
  pickGranularity,
  aggregateSeries,
  periodLengthDays,
  type PeriodPreset,
} from "@/lib/ui/period";

const RANGE_OPTIONS = [
  { id: "7d",  label: "7D",   href: "#" },
  { id: "30d", label: "30D",  href: "#" },
  { id: "ytd", label: "YTD",  href: "#" },
  { id: "ly",  label: "1Y",   href: "#" },
] as const;

const RANGE_LABEL: Partial<Record<PeriodPreset, string>> = {
  "7d":  "7 days",
  "30d": "30 days",
  "ytd": "year to date",
  "ly":  "last year",
};

function avg(points: MetricDatum[]): number | null {
  let sum = 0, n = 0;
  for (const p of points) {
    if (p.value !== null && Number.isFinite(p.value)) { sum += p.value; n++; }
  }
  return n > 0 ? sum / n : null;
}

function latest(points: MetricDatum[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].value;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function halfDelta(points: MetricDatum[]): number | null {
  const mid = Math.floor(points.length / 2);
  const a1 = avg(points.slice(0, mid));
  const a2 = avg(points.slice(mid));
  if (a1 === null || a2 === null) return null;
  return Math.round((a2 - a1) * 100) / 100;
}

function deltaSubtitle(delta: number | null, unit: string, periodLabel: string): string | undefined {
  if (delta == null) return undefined;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const abs  = Math.abs(delta);
  return `${sign}${fmtNum(abs)}${unit ? ` ${unit}` : ""} over ${periodLabel}`;
}

export function TrendsClient({
  userId,
  initialFrom,
  initialTo,
  initialPeriod,
}: {
  userId: string;
  initialFrom: string; // 1y window we prefetched
  initialTo: string;
  initialPeriod: PeriodPreset;
}) {
  const [period, setPeriod] = useState<PeriodPreset>(initialPeriod);

  // Always read the same wide-window narrow key from cache — already
  // hydrated by server. Narrow projection (date + 6 charted metrics only)
  // is ~70% smaller than the full DailyLog payload.
  const { data: allLogs = [] } = useDailyLogsTrend(userId, initialFrom, initialTo);

  // Derive the active window from `period` and slice client-side.
  const { from, to } = useMemo(
    () => resolvePeriod(period, undefined, undefined),
    [period],
  );
  const sliced = useMemo(
    () => allLogs.filter((l) => l.date >= from && l.date <= to),
    [allLogs, from, to],
  );
  const days = periodLengthDays(from, to);
  const granularity = pickGranularity(days);
  const rangeLabel = RANGE_LABEL[period] ?? `${days} days`;

  const hrvTrend:    MetricDatum[] = aggregateSeries(sliced, (l) => l.hrv,          granularity);
  const rhrTrend:    MetricDatum[] = aggregateSeries(sliced, (l) => l.resting_hr,   granularity);
  const sleepTrend:  MetricDatum[] = aggregateSeries(sliced, (l) => l.sleep_hours,  granularity);
  const strainTrend: MetricDatum[] = aggregateSeries(sliced, (l) => l.strain,       granularity);
  const weightTrend: MetricDatum[] = aggregateSeries(sliced, (l) => l.weight_kg,    granularity);
  const bfTrend:     MetricDatum[] = aggregateSeries(sliced, (l) => l.body_fat_pct, granularity);

  return (
    <main style={{ background: COLOR.bg, minHeight: "100dvh" }}>
      <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
          <div>
            <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Last {rangeLabel}</div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px", color: COLOR.textStrong }}>Trends</h1>
          </div>
        </div>

        <div style={{ padding: "0 8px 14px" }}>
          <RangePills
            options={RANGE_OPTIONS.map((o) => ({ ...o }))}
            active={period}
            onChange={(id) => setPeriod(id as PeriodPreset)}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
          <MetricCard title="HRV"        value={latest(hrvTrend)}    unit="ms"  subtitle={deltaSubtitle(halfDelta(hrvTrend),    "ms",  rangeLabel)} data={hrvTrend}    color={METRIC_COLOR.hrv}          type="area" />
          <MetricCard title="Resting HR" value={latest(rhrTrend)}    unit="bpm" subtitle={deltaSubtitle(halfDelta(rhrTrend),    "bpm", rangeLabel)} data={rhrTrend}    color={METRIC_COLOR.resting_hr}   type="area" />
          <MetricCard title="Sleep"      value={latest(sleepTrend)}  unit="h"   subtitle={deltaSubtitle(halfDelta(sleepTrend),  "h",   rangeLabel)} data={sleepTrend}  color={METRIC_COLOR.sleep_hours}  type="area" />
          <MetricCard title="Strain"     value={latest(strainTrend)}            subtitle={deltaSubtitle(halfDelta(strainTrend), "",    rangeLabel)} data={strainTrend} color={METRIC_COLOR.strain}       type="area" />
          <MetricCard title="Weight"     value={latest(weightTrend)} unit="kg"  subtitle={deltaSubtitle(halfDelta(weightTrend), "kg",  rangeLabel)} data={weightTrend} color={METRIC_COLOR.weight_kg}    type="area" />
          <MetricCard title="Body Fat"   value={latest(bfTrend)}     unit="%"   subtitle={deltaSubtitle(halfDelta(bfTrend),     "%",   rangeLabel)} data={bfTrend}     color={METRIC_COLOR.body_fat_pct} type="area" />
        </div>
      </div>
    </main>
  );
}
