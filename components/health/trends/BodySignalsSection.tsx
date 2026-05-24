// components/health/trends/BodySignalsSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { SKIN_TEMP_DELTA_C, RR_DELTA_BPM } from "@/lib/coach/recovery-intelligence/thresholds";

type Props = { payload: RecoveryIntelligencePayload };

export function BodySignalsSection({ payload }: Props) {
  const { daily, baselines } = payload;
  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Body signals · early warning</h3>
      <SkinTempCard daily={daily} baseline={baselines.skin_temp_baseline_c} />
      <RespRateCard daily={daily} baseline={baselines.respiratory_rate_baseline_bpm} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

function SkinTempCard({
  daily, baseline,
}: { daily: RecoveryIntelligencePayload["daily"]; baseline: number | null }) {
  const lastDelta = (() => {
    if (baseline == null) return null;
    const recent3 = daily.slice(-3).map((d) => d.skin_temp_c).filter((v): v is number => v != null);
    if (recent3.length === 0) return null;
    return recent3.reduce((a, b) => a + b, 0) / recent3.length - baseline;
  })();
  const tone: "good" | "warn" | "bad" =
    lastDelta == null ? "warn" : lastDelta >= SKIN_TEMP_DELTA_C ? "bad" : lastDelta >= 0.3 ? "warn" : "good";

  const yScale = (v: number) => 40 - ((v - (baseline ?? v)) / 1.5) * 40;
  return (
    <Card>
      <CardHeader title="Skin temp deviation · 28d"
        sub={lastDelta != null && lastDelta >= SKIN_TEMP_DELTA_C ? `Last 3 days +${fmtNum(lastDelta)}°C · pre-symptomatic?` : "Within personal band"}
        value={lastDelta != null ? `${lastDelta > 0 ? "+" : ""}${fmtNum(lastDelta)}°C` : "—"} tone={tone} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <>
            <rect x="0" y={yScale(baseline + 0.3)} width="360" height={yScale(baseline - 0.3) - yScale(baseline + 0.3)}
              fill={COLOR.accent} fillOpacity={0.1} />
            <line x1="0" y1={yScale(baseline)} x2="360" y2={yScale(baseline)}
              stroke={COLOR.accent} strokeDasharray="3,3" opacity={0.5} />
            <line x1="0" y1={yScale(baseline + SKIN_TEMP_DELTA_C)} x2="360" y2={yScale(baseline + SKIN_TEMP_DELTA_C)}
              stroke={COLOR.danger} strokeDasharray="2,4" opacity={0.4} />
          </>
        )}
        <polyline
          points={daily.map((d, i) => (d.skin_temp_c == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.skin_temp_c)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
    </Card>
  );
}

function RespRateCard({
  daily, baseline,
}: { daily: RecoveryIntelligencePayload["daily"]; baseline: number | null }) {
  const last7 = daily.slice(-7).map((d) => d.respiratory_rate).filter((v): v is number => v != null);
  const avg7 = last7.length === 0 ? null : last7.reduce((a, b) => a + b, 0) / last7.length;
  const delta = avg7 != null && baseline != null ? avg7 - baseline : null;
  const tone: "good" | "warn" | "bad" =
    delta == null ? "warn" : delta >= RR_DELTA_BPM ? "warn" : "good";
  const yScale = (v: number) => 40 - ((v - (baseline ?? v)) / 3) * 30;
  return (
    <Card>
      <CardHeader title="Respiratory rate · 28d"
        sub={`7d avg: ${avg7 != null ? fmtNum(avg7) : "—"} bpm · baseline: ${baseline != null ? fmtNum(baseline) : "—"}`}
        value={delta != null ? `${delta > 0 ? "+" : ""}${fmtNum(delta)}` : "—"} tone={tone} />
      <svg viewBox="0 0 360 70" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <>
            <line x1="0" y1={yScale(baseline)} x2="360" y2={yScale(baseline)}
              stroke={COLOR.accent} strokeDasharray="3,3" opacity={0.5} />
            <line x1="0" y1={yScale(baseline + RR_DELTA_BPM)} x2="360" y2={yScale(baseline + RR_DELTA_BPM)}
              stroke={COLOR.warning} strokeDasharray="2,4" opacity={0.4} />
          </>
        )}
        <polyline
          points={daily.map((d, i) => (d.respiratory_rate == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.respiratory_rate)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
    </Card>
  );
}
