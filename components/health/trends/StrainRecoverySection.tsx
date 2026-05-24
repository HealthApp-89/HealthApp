// components/health/trends/StrainRecoverySection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  STRAIN_HIGH_AVG_7D, RECOVERY_LOW_AVG_7D,
} from "@/lib/coach/recovery-intelligence/thresholds";

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

      {/* A10: day-of-week strain bars (12w) */}
      <DayOfWeekStrainCard daily={daily} weekly={weekly} />

      {/* A11: scatter strain[t-1] vs recovery[t] */}
      <PostStrainScatterCard daily={daily} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

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

  return (
    <Card>
      <CardHeader title="Recovery distribution · 28d"
        sub={`${totals.low} red · ${totals.ok} yellow · ${totals.high} green`}
        value={`${greenPct}%`} tone={tone} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {weeks.map((w, i) => {
          const x = 20 + i * 80;
          const tot = w.recovery_low_days + w.recovery_ok_days + w.recovery_high_days;
          if (tot === 0) return null;
          const hHigh = (w.recovery_high_days / tot) * 80;
          const hOk   = (w.recovery_ok_days   / tot) * 80;
          const hLow  = (w.recovery_low_days  / tot) * 80;
          return (
            <g key={w.week_start}>
              <rect x={x} y={0}              width={60} height={hHigh} fill={COLOR.success} />
              <rect x={x} y={hHigh}          width={60} height={hOk}   fill={COLOR.warning} />
              <rect x={x} y={hHigh + hOk}    width={60} height={hLow}  fill={COLOR.danger} />
            </g>
          );
        })}
      </svg>
      <Legend items={[
        { color: COLOR.success, label: "high (≥67)" },
        { color: COLOR.warning, label: "ok (34–66)" },
        { color: COLOR.danger, label: "low (<34)" },
      ]} />
    </Card>
  );
}

function StrainRecoveryCard({
  daily, derived,
}: {
  daily: RecoveryIntelligencePayload["daily"];
  derived: RecoveryIntelligencePayload["derived"];
}) {
  const overreach =
    derived.strain_avg_7d != null && derived.recovery_avg_7d != null &&
    derived.strain_avg_7d >= STRAIN_HIGH_AVG_7D && derived.recovery_avg_7d < RECOVERY_LOW_AVG_7D;
  const yScaleStrain = (v: number) => 80 - (v / 21) * 80;
  const yScaleRecov  = (v: number) => 80 - (v / 100) * 80;
  return (
    <Card>
      <CardHeader title="Strain × Recovery · 28d"
        sub={`7d strain ${derived.strain_avg_7d != null ? fmtNum(derived.strain_avg_7d) : "—"} · recovery ${derived.recovery_avg_7d != null ? `${Math.round(derived.recovery_avg_7d)}%` : "—"}`}
        value={overreach ? "⚠ overreach risk" : "balanced"} tone={overreach ? "bad" : "good"} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {overreach && <rect x="240" y="0" width="120" height="80" fill={COLOR.danger} fillOpacity={0.06} />}
        <polyline
          points={daily.map((d, i) => (d.strain == null ? null : `${(i / (daily.length - 1)) * 360},${yScaleStrain(d.strain)}`)).filter(Boolean).join(" ")}
          fill="none" stroke={COLOR.warning} strokeWidth={1.5} />
        <polyline
          points={daily.map((d, i) => (d.recovery == null ? null : `${(i / (daily.length - 1)) * 360},${yScaleRecov(d.recovery)}`)).filter(Boolean).join(" ")}
          fill="none" stroke={COLOR.success} strokeWidth={1.5} />
      </svg>
      <Legend items={[
        { color: COLOR.warning, label: "strain" },
        { color: COLOR.success, label: "recovery" },
        { color: COLOR.danger, label: "overreach band" },
      ]} />
    </Card>
  );
}

function DayOfWeekStrainCard({
  daily, weekly,
}: {
  daily: RecoveryIntelligencePayload["daily"];
  weekly: RecoveryIntelligencePayload["weekly"];
}) {
  // We only have 28d in `daily`; for 12w day-of-week we need the broader query.
  // For v1, derive from `daily` (last 28 days, ~4 weeks). Real 12w would require
  // adding a 12w daily series to the payload — deferred per spec scope (v2).
  const buckets = [0,0,0,0,0,0,0].map(() => ({ sum: 0, n: 0 }));
  for (const d of daily) {
    if (d.strain == null) continue;
    const dow = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
    buckets[dow].sum += d.strain;
    buckets[dow].n   += 1;
  }
  const avgs = buckets.map((b) => (b.n === 0 ? 0 : b.sum / b.n));
  const yMax = Math.max(...avgs, 1);
  const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const top2 = [...avgs.map((v, i) => ({ v, i }))].sort((a, b) => b.v - a.v).slice(0, 2).map((x) => labels[x.i]);
  return (
    <Card>
      <CardHeader title="Day-of-week strain · 4w avg"
        sub={top2.length ? `${top2.join(" & ")} are your heavy days` : "Insufficient data"} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {avgs.map((v, i) => {
          const x = 10 + i * 50;
          const h = (v / yMax) * 70;
          const color = v >= 15 ? COLOR.danger : v >= 10 ? COLOR.warning : COLOR.textMid;
          return (
            <g key={i}>
              <rect x={x} y={80 - h} width={40} height={h} fill={color} />
              <text x={x + 20} y={78} fontSize={9} fill={COLOR.textMuted} textAnchor="middle">{labels[i]}</text>
            </g>
          );
        })}
      </svg>
    </Card>
  );
}

function PostStrainScatterCard({
  daily,
}: { daily: RecoveryIntelligencePayload["daily"] }) {
  // Pairs: (yesterday_strain, today_recovery).
  const pairs: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < daily.length; i++) {
    const xs = daily[i - 1].strain;
    const ys = daily[i].recovery;
    if (xs != null && ys != null) pairs.push({ x: xs, y: ys });
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

  const xScale = (x: number) => 30 + (x / 21) * 320;
  const yScale = (y: number) => 92 - (y / 100) * 80;

  return (
    <Card>
      <CardHeader title="Strain → next-day recovery · 28d"
        sub={pairs.length >= 3 ? `${fmtNum(slope)} pts recovery per +1 strain` : "Need more data"} />
      <svg viewBox="0 0 360 110" preserveAspectRatio="none" style={{ width: "100%" }}>
        <text x="2" y="14" fontSize={9} fill={COLOR.textMuted}>recov %</text>
        <text x="320" y="105" fontSize={9} fill={COLOR.textMuted}>strain</text>
        {pairs.length >= 3 && (
          <line x1={xScale(0)} y1={yScale(intercept)} x2={xScale(21)} y2={yScale(slope * 21 + intercept)}
            stroke={COLOR.accent} strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
        )}
        {pairs.map((p, i) => (
          <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r={3} fill="#7dd3fc" />
        ))}
      </svg>
    </Card>
  );
}
