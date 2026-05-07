import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard } from "@/components/charts/MetricCard";
import type { LinePoint } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import type { DailyLog } from "@/lib/data/types";
import {
  resolvePeriod,
  pickGranularity,
  aggregateSeries,
  periodLengthDays,
  type PeriodPreset,
} from "@/lib/ui/period";

export const revalidate = 60;

// Range pills — map to existing PeriodPreset ids so deep links keep working.
const RANGE_OPTIONS = [
  { id: "7d",  label: "7D",   href: "/trends?period=7d"  },
  { id: "30d", label: "30D",  href: "/trends?period=30d" },
  { id: "ytd", label: "YTD",  href: "/trends?period=ytd" },
  { id: "ly",  label: "1Y",   href: "/trends?period=ly"  },
] as const;

const RANGE_LABEL: Partial<Record<PeriodPreset, string>> = {
  "7d":  "7 days",
  "30d": "30 days",
  "ytd": "year to date",
  "ly":  "last year",
};

// Small helpers ---------------------------------------------------------------

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

/** Latest non-null reading in the series. Used for the headline number on the
 *  metric card — the period average is misleading when a single recent
 *  data point is what the user actually wants to glance at. */
function latest(points: LinePoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].y;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Delta: second-half average minus first-half average. */
function halfDelta(points: LinePoint[]): number | null {
  const mid = Math.floor(points.length / 2);
  const w1 = points.slice(0, mid);
  const w2 = points.slice(mid);
  const a1 = avg(w1);
  const a2 = avg(w2);
  if (a1 === null || a2 === null) return null;
  return Math.round((a2 - a1) * 100) / 100;
}

export default async function TrendsPage(props: {
  searchParams: Promise<{
    period?: string;
    start?: string;
    end?: string;
  }>;
}) {
  const sp = await props.searchParams;

  // Default to 30d when no period or an unrecognised period is given.
  const rawPeriod = sp.period ?? "30d";
  const { from, to, preset } = resolvePeriod(rawPeriod as PeriodPreset, sp.start, sp.end);
  const days = periodLengthDays(from, to);
  const granularity = pickGranularity(days);

  // Active pill: prefer the four pill ids; fall back to the preset string.
  const activePill = RANGE_OPTIONS.some((o) => o.id === preset)
    ? preset
    : "30d";
  const rangeLabel = RANGE_LABEL[preset] ?? `${days} days`;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: logsRaw }] = await Promise.all([
    supabase
      .from("daily_logs")
      .select(
        "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, respiratory_rate, notes, source, updated_at",
      )
      .eq("user_id", user.id)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true }),
  ]);

  const sorted = (logsRaw ?? []) as DailyLog[];

  // Aggregate each metric to the picked granularity (day/week/month).
  const aggHRV      = aggregateSeries(sorted, (l) => l.hrv,          granularity);
  const aggRHR      = aggregateSeries(sorted, (l) => l.resting_hr,   granularity);
  const aggSleepH   = aggregateSeries(sorted, (l) => l.sleep_hours,  granularity);
  const aggStrain   = aggregateSeries(sorted, (l) => l.strain,       granularity);
  const aggWeight   = aggregateSeries(sorted, (l) => l.weight_kg,    granularity);
  const aggBodyFat  = aggregateSeries(sorted, (l) => l.body_fat_pct, granularity);

  // LinePoint arrays for sparklines
  const hrvTrend     = toPoints(aggHRV);
  const rhrTrend     = toPoints(aggRHR);
  const sleepTrend   = toPoints(aggSleepH);
  const strainTrend  = toPoints(aggStrain);
  const weightTrend  = toPoints(aggWeight);
  const bfTrend      = toPoints(aggBodyFat);

  // Headline values: most recent non-null reading in the period. Card swaps
  // to the hovered point's value when the user drags across the sparkline.
  const hrvLatest    = latest(hrvTrend);
  const rhrLatest    = latest(rhrTrend);
  const sleepLatest  = latest(sleepTrend);
  const strainLatest = latest(strainTrend);
  const weightLatest = latest(weightTrend);
  const bfLatest     = latest(bfTrend);

  // Deltas: second-half avg minus first-half avg of the current window.
  const hrvDelta    = halfDelta(hrvTrend);
  const rhrDelta    = halfDelta(rhrTrend);
  const sleepDelta  = halfDelta(sleepTrend);
  const strainDelta = halfDelta(strainTrend);
  const weightDelta = halfDelta(weightTrend);
  const bfDelta     = halfDelta(bfTrend);

  return (
    <main style={{ background: COLOR.bg, minHeight: "100dvh" }}>
      <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
        {/* Page header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
          <div>
            <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Last {rangeLabel}</div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px", color: COLOR.textStrong }}>Trends</h1>
          </div>
        </div>

        {/* Range pills */}
        <div style={{ padding: "0 8px 14px" }}>
          <RangePills
            options={RANGE_OPTIONS.map((o) => ({ ...o }))}
            active={activePill}
          />
        </div>

        {/* Compact metric stack */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
          <MetricCard
            color={METRIC_COLOR.hrv}
            metricKey="hrv"
            icon="♥"
            label="HRV"
            value={hrvLatest}
            unit="ms"
            delta={hrvDelta}
            deltaUnit="ms"
            compact
            trend={hrvTrend}
            href="/trends/hrv"
          />
          <MetricCard
            color={METRIC_COLOR.resting_hr}
            metricKey="resting_hr"
            icon="♥"
            label="Resting HR"
            value={rhrLatest}
            unit="bpm"
            delta={rhrDelta}
            deltaUnit="bpm"
            inverted
            compact
            trend={rhrTrend}
            href="/trends/resting_hr"
          />
          <MetricCard
            color={METRIC_COLOR.sleep_hours}
            metricKey="sleep_hours"
            icon="☾"
            label="Sleep"
            value={sleepLatest}
            unit="h"
            delta={sleepDelta}
            deltaUnit="h"
            compact
            trend={sleepTrend}
            href="/trends/sleep_hours"
          />
          <MetricCard
            color={METRIC_COLOR.strain}
            metricKey="strain"
            icon="⚡"
            label="Strain"
            value={strainLatest}
            delta={strainDelta}
            compact
            trend={strainTrend}
            href="/trends/strain"
          />
          <MetricCard
            color={METRIC_COLOR.weight_kg}
            metricKey="weight_kg"
            icon="⚖"
            label="Weight"
            value={weightLatest}
            unit="kg"
            delta={weightDelta}
            deltaUnit="kg"
            compact
            trend={weightTrend}
            href="/trends/weight_kg"
          />
          <MetricCard
            color={METRIC_COLOR.body_fat_pct}
            metricKey="body_fat_pct"
            icon="%"
            label="Body Fat"
            value={bfLatest}
            unit="%"
            delta={bfDelta}
            deltaUnit="%"
            compact
            trend={bfTrend}
            href="/trends/body_fat_pct"
          />
        </div>
      </div>
    </main>
  );
}

