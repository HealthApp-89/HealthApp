// components/health/trends/WellnessSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR, SHADOW, METRIC_COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { formatDateLabel } from "@/components/health/trends/format";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

type Props = { payload: RecoveryIntelligencePayload };
type Daily = RecoveryIntelligencePayload["daily"];

// Garmin Body Battery + Stress — 28d. Both are 0-100 all-day scales, so no
// personal baseline band (unlike skin temp / resp rate); the raw level is the
// signal. Section only renders when Garmin has populated at least one day.
export function WellnessSection({ payload }: Props) {
  const { daily } = payload;
  const hasAny = daily.some(
    (d) => d.body_battery_peak != null || d.stress_avg != null,
  );
  if (!hasAny) return null;

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Body Battery &amp; Stress · Garmin</h3>
      <BodyBatteryCard daily={daily} />
      <StressCard daily={daily} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

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

function lastNonNull<T>(daily: Daily, pick: (d: Daily[number]) => T | null): T | null {
  for (let i = daily.length - 1; i >= 0; i--) {
    const v = pick(daily[i]);
    if (v != null) return v;
  }
  return null;
}

// ── Body Battery (0-100; higher = more charged) ───────────────────────────
function BodyBatteryCard({ daily }: { daily: Daily }) {
  const peak = lastNonNull(daily, (d) => d.body_battery_peak);
  const low = lastNonNull(daily, (d) => d.body_battery_low);
  const tone: "good" | "warn" | "bad" =
    peak == null ? "warn" : peak >= 60 ? "good" : peak >= 40 ? "warn" : "bad";
  const hasData = daily.some((d) => d.body_battery_peak != null);
  const data = daily.map((d) => ({ date: d.date, peak: d.body_battery_peak, low: d.body_battery_low }));

  return (
    <Card>
      <CardHeader title="Body Battery · 28d"
        sub={low != null ? `latest drains to ${fmtNum(low)}` : "peak charge per day"}
        value={peak != null ? fmtNum(peak) : "—"} tone={tone} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[0, 100]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; peak: number | null; low: number | null };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.peak != null && <div style={{ color: METRIC_COLOR.body_battery }}>{`peak ${fmtNum(p.peak)}`}</div>}
                    {p.low != null && <div style={{ color: COLOR.textMuted }}>{`low ${fmtNum(p.low)}`}</div>}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line type="monotone" dataKey="peak" stroke={METRIC_COLOR.body_battery}
              strokeWidth={1.5} dot={false}
              activeDot={{ r: 4, fill: METRIC_COLOR.body_battery, stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={emptyBox}>Insufficient data</div>
      )}
    </Card>
  );
}

// ── Stress (0-100; lower = calmer) ────────────────────────────────────────
function StressCard({ daily }: { daily: Daily }) {
  const avg = lastNonNull(daily, (d) => d.stress_avg);
  const qual = lastNonNull(daily, (d) => d.stress_qualifier);
  const tone: "good" | "warn" | "bad" =
    avg == null ? "warn" : avg <= 33 ? "good" : avg <= 50 ? "warn" : "bad";
  const hasData = daily.some((d) => d.stress_avg != null);
  const data = daily.map((d) => ({ date: d.date, stress: d.stress_avg, qual: d.stress_qualifier }));

  return (
    <Card>
      <CardHeader title="Stress · 28d"
        sub={qual ? `latest: ${qual.toLowerCase()}` : "all-day average"}
        value={avg != null ? fmtNum(avg) : "—"} tone={tone} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[0, 100]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; stress: number | null; qual: string | null };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.stress != null && <div style={{ color: METRIC_COLOR.stress }}>{`stress ${fmtNum(p.stress)}`}</div>}
                    {p.qual && <div style={{ color: COLOR.textMuted }}>{p.qual.toLowerCase()}</div>}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line type="monotone" dataKey="stress" stroke={METRIC_COLOR.stress}
              strokeWidth={1.5} dot={false}
              activeDot={{ r: 4, fill: METRIC_COLOR.stress, stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={emptyBox}>Insufficient data</div>
      )}
    </Card>
  );
}

const emptyBox: React.CSSProperties = {
  height: 90, display: "flex", alignItems: "center",
  justifyContent: "center", color: COLOR.textMuted, fontSize: 12,
};
