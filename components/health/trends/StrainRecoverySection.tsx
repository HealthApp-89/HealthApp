// components/health/trends/StrainRecoverySection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  STRAIN_HIGH_AVG_7D, RECOVERY_LOW_AVG_7D,
} from "@/lib/coach/recovery-intelligence/thresholds";
import { formatDateLabel } from "@/components/health/trends/format";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  Cell,
} from "recharts";

type Props = { payload: RecoveryIntelligencePayload };

export function StrainRecoverySection({ payload }: Props) {
  const { daily, weekly, derived } = payload;

  // Reduce weekly array to last 4 weeks for A8.
  const last4Weeks = weekly.slice(-4);

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Strain × Recovery balance</h3>

      {/* A8 */}
      <RecoveryDistributionCard weeks={last4Weeks} />

      {/* A9 */}
      <StrainRecoveryCard daily={daily} derived={derived} />

      {/* A10: day-of-week strain bars (4w avg) */}
      <DayOfWeekStrainCard daily={daily} />

      {/* A11: scatter strain[t-1] vs recovery[t] */}
      <PostStrainScatterCard daily={daily} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

// ── Shared tooltip box ────────────────────────────────────────────────────

function TooltipBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: COLOR.surface,
      border: `1px solid ${COLOR.divider}`,
      borderRadius: 8,
      padding: "6px 10px",
      fontSize: 11,
      boxShadow: SHADOW.card,
      pointerEvents: "none",
    }}>
      {children}
    </div>
  );
}

// ── A8: Recovery distribution ─────────────────────────────────────────────

function RecoveryDistributionCard({
  weeks,
}: { weeks: RecoveryIntelligencePayload["weekly"] }) {
  const totals = weeks.reduce(
    (acc, w) => ({
      low:  acc.low  + w.recovery_low_days,
      ok:   acc.ok   + w.recovery_ok_days,
      high: acc.high + w.recovery_high_days,
    }),
    { low: 0, ok: 0, high: 0 },
  );
  const total = totals.low + totals.ok + totals.high;
  const greenPct = total === 0 ? 0 : Math.round((totals.high / total) * 100);
  const tone: "good" | "warn" | "bad" =
    greenPct >= 50 ? "good" : greenPct >= 25 ? "warn" : "bad";
  const hasData = weeks.some(
    (w) => w.recovery_low_days + w.recovery_ok_days + w.recovery_high_days > 0,
  );

  const data = weeks.map((w) => ({
    week_start: w.week_start,
    high: w.recovery_high_days,
    ok: w.recovery_ok_days,
    low: w.recovery_low_days,
  }));

  return (
    <Card>
      <CardHeader title="Recovery distribution · 28d"
        sub={`${totals.low} red · ${totals.ok} yellow · ${totals.high} green`}
        value={`${greenPct}%`} tone={tone} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="25%">
            <XAxis dataKey="week_start" hide />
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as {
                  week_start: string;
                  high: number;
                  ok: number;
                  low: number;
                };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>
                      {`Week of ${formatDateLabel(p.week_start)}`}
                    </div>
                    <div style={{ color: COLOR.success }}>{`high: ${p.high}d`}</div>
                    <div style={{ color: COLOR.warning }}>{`ok: ${p.ok}d`}</div>
                    <div style={{ color: COLOR.danger }}>{`low: ${p.low}d`}</div>
                  </TooltipBox>
                );
              }}
              cursor={{ fill: COLOR.surfaceAlt, fillOpacity: 0.4 }}
            />
            <Bar dataKey="high" stackId="a" fill={COLOR.success} isAnimationActive={false} />
            <Bar dataKey="ok" stackId="a" fill={COLOR.warning} isAnimationActive={false} />
            <Bar dataKey="low" stackId="a" fill={COLOR.danger} isAnimationActive={false} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Insufficient data
        </div>
      )}
      <Legend items={[
        { color: COLOR.success, label: "high (≥67)" },
        { color: COLOR.warning, label: "ok (34–66)" },
        { color: COLOR.danger, label: "low (<34)" },
      ]} />
    </Card>
  );
}

// ── A9: Strain × Recovery dual-line ──────────────────────────────────────

function StrainRecoveryCard({
  daily, derived,
}: {
  daily: RecoveryIntelligencePayload["daily"];
  derived: RecoveryIntelligencePayload["derived"];
}) {
  const overreach =
    derived.strain_avg_7d != null && derived.recovery_avg_7d != null &&
    derived.strain_avg_7d >= STRAIN_HIGH_AVG_7D && derived.recovery_avg_7d < RECOVERY_LOW_AVG_7D;
  const hasData = daily.some((d) => d.strain != null || d.recovery != null);

  // Normalise both axes to [0,1] for a shared y-axis.
  const data = daily.map((d) => ({
    date: d.date,
    strain: d.strain,
    recovery: d.recovery,
    strainNorm: d.strain != null ? d.strain / 21 : null,
    recovNorm: d.recovery != null ? d.recovery / 100 : null,
  }));

  // Overreach band starts at index where the condition triggers (last 7 days).
  const overreachStartIdx = Math.max(0, data.length - 7);
  const overreachStartDate = overreach ? data[overreachStartIdx]?.date : null;
  const overreachEndDate = overreach ? data[data.length - 1]?.date : null;

  return (
    <Card>
      <CardHeader title="Strain × Recovery · 28d"
        sub={`7d strain ${derived.strain_avg_7d != null ? fmtNum(derived.strain_avg_7d) : "—"} · recovery ${derived.recovery_avg_7d != null ? `${fmtNum(derived.recovery_avg_7d)}%` : "—"}`}
        value={overreach ? "⚠ overreach risk" : "balanced"} tone={overreach ? "bad" : "good"} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[0, 1]} />
            {overreach && overreachStartDate && overreachEndDate && (
              <ReferenceArea
                x1={overreachStartDate}
                x2={overreachEndDate}
                fill={COLOR.danger}
                fillOpacity={0.06}
              />
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as {
                  date: string;
                  strain: number | null;
                  recovery: number | null;
                };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.strain != null && (
                      <div style={{ color: COLOR.warning }}>{`strain ${fmtNum(p.strain)}`}</div>
                    )}
                    {p.recovery != null && (
                      <div style={{ color: COLOR.success }}>{`recovery ${fmtNum(p.recovery)}%`}</div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line
              type="monotone"
              dataKey="strainNorm"
              stroke={COLOR.warning}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: COLOR.warning, stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="recovNorm"
              stroke={COLOR.success}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: COLOR.success, stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Insufficient data
        </div>
      )}
      <Legend items={[
        { color: COLOR.warning, label: "strain" },
        { color: COLOR.success, label: "recovery" },
        { color: COLOR.danger, label: "overreach band" },
      ]} />
    </Card>
  );
}

// ── A10: Day-of-week strain ───────────────────────────────────────────────

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function DayOfWeekStrainCard({
  daily,
}: {
  daily: RecoveryIntelligencePayload["daily"];
}) {
  const buckets = [0, 1, 2, 3, 4, 5, 6].map(() => ({ sum: 0, n: 0 }));
  for (const d of daily) {
    if (d.strain == null) continue;
    const dow = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
    buckets[dow].sum += d.strain;
    buckets[dow].n   += 1;
  }
  const data = buckets.map((b, i) => ({
    dow: DOW_LABELS[i],
    avg: b.n === 0 ? 0 : b.sum / b.n,
  }));
  const top2 = [...data].sort((a, b) => b.avg - a.avg).slice(0, 2).map((x) => x.dow);
  const hasData = data.some((d) => d.avg > 0);

  return (
    <Card>
      <CardHeader title="Day-of-week strain · 4w avg"
        sub={top2.length && hasData ? `${top2.join(" & ")} are your heavy days` : "Insufficient data"} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 16, left: 0 }} barCategoryGap="20%">
            <XAxis
              dataKey="dow"
              tick={{ fill: COLOR.textMuted, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { dow: string; avg: number };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{p.dow}</div>
                    <div style={{ color: COLOR.warning }}>{`avg strain ${fmtNum(p.avg)}`}</div>
                  </TooltipBox>
                );
              }}
              cursor={{ fill: COLOR.surfaceAlt, fillOpacity: 0.4 }}
            />
            <Bar dataKey="avg" isAnimationActive={false} radius={[4, 4, 0, 0]}>
              {data.map((entry) => {
                const color =
                  entry.avg >= 15 ? COLOR.danger
                    : entry.avg >= 10 ? COLOR.warning
                    : COLOR.textMid;
                return <Cell key={entry.dow} fill={color} />;
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Insufficient data
        </div>
      )}
    </Card>
  );
}

// ── A11: Post-strain scatter ──────────────────────────────────────────────

function PostStrainScatterCard({
  daily,
}: { daily: RecoveryIntelligencePayload["daily"] }) {
  // Pairs: (yesterday_strain, today_recovery).
  const pairs: Array<{ x: number; y: number; date: string }> = [];
  for (let i = 1; i < daily.length; i++) {
    const xs = daily[i - 1].strain;
    const ys = daily[i].recovery;
    if (xs != null && ys != null) pairs.push({ x: xs, y: ys, date: daily[i].date });
  }

  // OLS for trend line.
  let slope = 0, intercept = 0;
  if (pairs.length >= 3) {
    const n = pairs.length;
    const xMean = pairs.reduce((a, p) => a + p.x, 0) / n;
    const yMean = pairs.reduce((a, p) => a + p.y, 0) / n;
    const num = pairs.reduce((a, p) => a + (p.x - xMean) * (p.y - yMean), 0);
    const den = pairs.reduce((a, p) => a + (p.x - xMean) ** 2, 0);
    slope = den === 0 ? 0 : num / den;
    intercept = yMean - slope * xMean;
  }

  // Build OLS line as two points for Recharts Line in a ComposedChart.
  const olsLine =
    pairs.length >= 3
      ? [
          { x: 0, ols: intercept },
          { x: 21, ols: slope * 21 + intercept },
        ]
      : [];

  return (
    <Card>
      <CardHeader title="Strain → next-day recovery · 28d"
        sub={pairs.length >= 3 ? `${fmtNum(slope)} pts recovery per +1 strain` : "Need more data"} />
      {pairs.length >= 3 ? (
        <ResponsiveContainer width="100%" height={110}>
          <ScatterChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 21]}
              tick={{ fill: COLOR.textMuted, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              label={{ value: "strain", position: "insideBottomRight", offset: -4, fontSize: 9, fill: COLOR.textMuted }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[0, 100]}
              tick={{ fill: COLOR.textMuted, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              label={{ value: "recov %", angle: -90, position: "insideTopLeft", offset: 4, fontSize: 9, fill: COLOR.textMuted }}
            />
            <ZAxis range={[30, 30]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { x: number; y: number; date: string };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    <div style={{ color: COLOR.warning }}>{`strain ${fmtNum(p.x)}`}</div>
                    <div style={{ color: COLOR.success }}>{`recovery ${fmtNum(p.y)}%`}</div>
                  </TooltipBox>
                );
              }}
              cursor={{ strokeDasharray: "3,3" }}
            />
            {/* OLS trend line rendered as a separate Scatter to avoid ComposedChart complexity */}
            <Scatter data={pairs} fill="#7dd3fc" isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Need more data
        </div>
      )}
    </Card>
  );
}
