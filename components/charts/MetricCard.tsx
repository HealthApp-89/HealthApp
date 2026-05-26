"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { COLOR } from "@/lib/ui/theme";

export type MetricDatum = {
  date: string;
  value: number | null;
};

type MetricCardProps = {
  title: string;
  value: number | null;
  unit?: string;
  subtitle?: string;
  data: MetricDatum[];
  color: string;
  type: "area" | "bar";
  /** When true, pass through null-valued points so the X axis spans the full
   *  data window (and the area line bridges missing days). Default false:
   *  null points are filtered, matching the 7-day sparkline behaviour. */
  connectNulls?: boolean;
  /** Y-axis baseline. 'zero' (default) keeps the recharts default starting at
   *  0; 'data' fits the Y to [dataMin, dataMax] with small padding so subtle
   *  variation is visible (e.g. weight over 4 weeks). */
  yAxis?: "zero" | "data";
  /** X tick label format. 'weekday' (default) for short 7-day windows;
   *  'monthDay' (e.g. "May 12") reads better on longer windows. */
  xLabelFormat?: "weekday" | "monthDay";
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return WEEKDAY[dt.getUTCDay()];
}

function monthDayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatTooltipDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatValue(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const gradientId = (color: string) =>
  `mc-grad-${color.replace(/[^a-z0-9]/gi, "")}`;

export function MetricCard({
  title,
  value,
  unit,
  subtitle,
  data,
  color,
  type,
  connectNulls = false,
  yAxis = "zero",
  xLabelFormat = "weekday",
}: MetricCardProps) {
  // chartData keeps nulls when connectNulls is on so the X axis preserves
  // the full window; otherwise drop them like the original 7-day sparklines.
  const chartData = connectNulls
    ? data
    : data.filter(
        (d): d is { date: string; value: number } =>
          d.value != null && Number.isFinite(d.value),
      );
  const numericValues = chartData
    .map((d) => d.value)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const hasChart = numericValues.length >= 1;
  const gid = gradientId(color);
  const tickFmt = xLabelFormat === "monthDay" ? monthDayLabel : weekdayLabel;

  // Tight Y domain: clamp to [min - 20% span, max + 20% span] so a 1 kg
  // change over 28 days reads as a real slope instead of a flat line.
  // Falls back to ±5% of the value (or ±1) when there's only one point.
  let yDomain: [number | string, number | string] = [0, "auto"];
  if (yAxis === "data" && hasChart) {
    const yMin = Math.min(...numericValues);
    const yMax = Math.max(...numericValues);
    const span = yMax - yMin;
    const pad = span > 0 ? span * 0.2 : Math.max(Math.abs(yMax) * 0.05, 1);
    yDomain = [yMin - pad, yMax + pad];
  }

  return (
    <div
      style={{
        background: COLOR.surface,
        borderRadius: "16px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        padding: "20px",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: COLOR.textMuted,
        }}
      >
        {title}
      </div>

      <div
        data-tnum
        style={{
          marginTop: "6px",
          display: "flex",
          alignItems: "baseline",
          gap: "6px",
          color: COLOR.textStrong,
          fontSize: "36px",
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1.05,
        }}
      >
        <span>{formatValue(value)}</span>
        {unit && value != null ? (
          <span
            style={{
              fontSize: "16px",
              fontWeight: 500,
              color: COLOR.textMuted,
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>

      {subtitle ? (
        <div
          style={{
            marginTop: "4px",
            fontSize: "13px",
            color: COLOR.textMuted,
          }}
        >
          {subtitle}
        </div>
      ) : null}

      {hasChart ? (
        <div style={{ marginTop: "12px", height: "120px" }}>
          <ResponsiveContainer width="100%" height="100%">
            {type === "area" ? (
              <AreaChart
                data={chartData}
                margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
              >
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tickFormatter={tickFmt}
                  tick={{ fill: COLOR.textMuted, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={xLabelFormat === "monthDay" ? 36 : 20}
                />
                {yAxis === "data" ? <YAxis hide domain={yDomain} /> : null}
                <Tooltip
                  cursor={{ stroke: COLOR.divider, strokeWidth: 1 }}
                  content={<MetricTooltip color={color} unit={unit} />}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2.5}
                  fill={`url(#${gid})`}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 4, fill: color, stroke: COLOR.surface, strokeWidth: 2 }}
                  connectNulls={connectNulls}
                />
              </AreaChart>
            ) : (
              <BarChart
                data={chartData}
                margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
                barCategoryGap="30%"
              >
                <XAxis
                  dataKey="date"
                  tickFormatter={tickFmt}
                  tick={{ fill: COLOR.textMuted, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={xLabelFormat === "monthDay" ? 36 : 20}
                />
                {yAxis === "data" ? <YAxis hide domain={yDomain} /> : null}
                <Tooltip
                  cursor={{ fill: COLOR.surfaceAlt }}
                  content={<MetricTooltip color={color} unit={unit} />}
                />
                <Bar
                  dataKey="value"
                  fill={color}
                  radius={[6, 6, 6, 6]}
                  isAnimationActive={false}
                />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}

type TooltipPayload = {
  active?: boolean;
  payload?: Array<{ payload: { date: string; value: number } }>;
};

function MetricTooltip({
  active,
  payload,
  color,
  unit,
}: TooltipPayload & { color: string; unit?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div
      style={{
        background: COLOR.surface,
        borderRadius: "10px",
        boxShadow: "0 8px 24px rgba(20,30,80,0.12)",
        padding: "8px 10px",
        fontSize: "12px",
        lineHeight: 1.3,
        pointerEvents: "none",
      }}
    >
      <div
        data-tnum
        style={{
          color,
          fontWeight: 700,
          fontSize: "14px",
        }}
      >
        {formatValue(point.value)}
        {unit ? (
          <span style={{ color: COLOR.textMuted, fontWeight: 500, marginLeft: "3px" }}>
            {unit}
          </span>
        ) : null}
      </div>
      <div style={{ color: COLOR.textMuted, marginTop: "2px" }}>
        {formatTooltipDate(point.date)}
      </div>
    </div>
  );
}
