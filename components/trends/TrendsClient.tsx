// components/trends/TrendsClient.tsx
"use client";

import { useState, useMemo } from "react";
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard } from "@/components/charts/MetricCard";
import type { LinePoint } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
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

function toPoints(series: { date: string; value: number | null }[]): LinePoint[] {
  return series.map((p) => ({ x: p.date, y: p.value }));
}

function avg(points: LinePoint[]): number | null {
  let sum = 0, n = 0;
  for (const p of points) {
    if (p.y !== null && Number.isFinite(p.y)) { sum += p.y; n++; }
  }
  return n > 0 ? sum / n : null;
}

function latest(points: LinePoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].y;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function halfDelta(points: LinePoint[]): number | null {
  const mid = Math.floor(points.length / 2);
  const w1 = points.slice(0, mid);
  const w2 = points.slice(mid);
  const a1 = avg(w1);
  const a2 = avg(w2);
  if (a1 === null || a2 === null) return null;
  return Math.round((a2 - a1) * 100) / 100;
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

  // Always read the same 1y key from cache — already hydrated by server.
  const { data: allLogs = [] } = useDailyLogs(userId, initialFrom, initialTo);

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

  const aggHRV     = aggregateSeries(sliced, (l) => l.hrv,          granularity);
  const aggRHR     = aggregateSeries(sliced, (l) => l.resting_hr,   granularity);
  const aggSleepH  = aggregateSeries(sliced, (l) => l.sleep_hours,  granularity);
  const aggStrain  = aggregateSeries(sliced, (l) => l.strain,       granularity);
  const aggWeight  = aggregateSeries(sliced, (l) => l.weight_kg,    granularity);
  const aggBodyFat = aggregateSeries(sliced, (l) => l.body_fat_pct, granularity);

  const hrvTrend     = toPoints(aggHRV);
  const rhrTrend     = toPoints(aggRHR);
  const sleepTrend   = toPoints(aggSleepH);
  const strainTrend  = toPoints(aggStrain);
  const weightTrend  = toPoints(aggWeight);
  const bfTrend      = toPoints(aggBodyFat);

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
          <MetricCard color={METRIC_COLOR.hrv}        metricKey="hrv"        icon="♥" label="HRV"        value={latest(hrvTrend)}     unit="ms"  delta={halfDelta(hrvTrend)}    deltaUnit="ms"  compact trend={hrvTrend}    href="/trends/hrv" />
          <MetricCard color={METRIC_COLOR.resting_hr} metricKey="resting_hr" icon="♥" label="Resting HR" value={latest(rhrTrend)}     unit="bpm" delta={halfDelta(rhrTrend)}    deltaUnit="bpm" inverted compact trend={rhrTrend}    href="/trends/resting_hr" />
          <MetricCard color={METRIC_COLOR.sleep_hours} metricKey="sleep_hours" icon="☾" label="Sleep"   value={latest(sleepTrend)}   unit="h"   delta={halfDelta(sleepTrend)}  deltaUnit="h"   compact trend={sleepTrend}  href="/trends/sleep_hours" />
          <MetricCard color={METRIC_COLOR.strain}     metricKey="strain"     icon="⚡" label="Strain"   value={latest(strainTrend)}                 delta={halfDelta(strainTrend)} compact trend={strainTrend} href="/trends/strain" />
          <MetricCard color={METRIC_COLOR.weight_kg}  metricKey="weight_kg"  icon="⚖" label="Weight"   value={latest(weightTrend)}  unit="kg"  delta={halfDelta(weightTrend)} deltaUnit="kg"  compact trend={weightTrend} href="/trends/weight_kg" />
          <MetricCard color={METRIC_COLOR.body_fat_pct} metricKey="body_fat_pct" icon="%" label="Body Fat" value={latest(bfTrend)} unit="%"  delta={halfDelta(bfTrend)}     deltaUnit="%"   compact trend={bfTrend}     href="/trends/body_fat_pct" />
        </div>
      </div>
    </main>
  );
}
