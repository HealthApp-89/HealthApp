// components/health/trends/BodySignalsSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { SKIN_TEMP_DELTA_C, RR_DELTA_BPM } from "@/lib/coach/recovery-intelligence/thresholds";
import { formatDateLabel } from "@/components/health/trends/format";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

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

// ── A12: Skin temp deviation ──────────────────────────────────────────────

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

  const hasData = daily.some((d) => d.skin_temp_c != null);
  const data = daily.map((d) => ({ date: d.date, temp: d.skin_temp_c }));

  // Y-domain: centre around baseline with ±1.0°C window.
  const mid = baseline ?? (hasData ? daily.find((d) => d.skin_temp_c != null)?.skin_temp_c ?? 36 : 36);
  const yMin = mid - 1.0;
  const yMax = mid + 1.0;

  return (
    <Card>
      <CardHeader title="Skin temp deviation · 28d"
        sub={lastDelta != null && lastDelta >= SKIN_TEMP_DELTA_C
          ? `Last 3 days +${fmtNum(lastDelta)}°C · pre-symptomatic?`
          : "Within personal band"}
        value={lastDelta != null ? `${lastDelta > 0 ? "+" : ""}${fmtNum(lastDelta)}°C` : "—"}
        tone={tone} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[yMin, yMax]} />
            {baseline != null && (
              <>
                <ReferenceArea
                  y1={baseline - 0.3}
                  y2={baseline + 0.3}
                  fill={COLOR.accent}
                  fillOpacity={0.1}
                />
                <ReferenceLine
                  y={baseline}
                  stroke={COLOR.accent}
                  strokeDasharray="3,3"
                  strokeOpacity={0.5}
                  strokeWidth={1}
                />
                <ReferenceLine
                  y={baseline + SKIN_TEMP_DELTA_C}
                  stroke={COLOR.danger}
                  strokeDasharray="2,4"
                  strokeOpacity={0.4}
                  strokeWidth={1}
                />
              </>
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; temp: number | null };
                const delta = baseline != null && p.temp != null ? p.temp - baseline : null;
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.temp != null && (
                      <div style={{ color: "#7dd3fc" }}>{`${fmtNum(p.temp)}°C`}</div>
                    )}
                    {delta != null && (
                      <div style={{ color: COLOR.textMuted }}>
                        {`${delta > 0 ? "+" : ""}${fmtNum(delta)}°C vs baseline`}
                      </div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line
              type="monotone"
              dataKey="temp"
              stroke="#7dd3fc"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: "#7dd3fc", stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Insufficient data
        </div>
      )}
    </Card>
  );
}

// ── A13: Respiratory rate ─────────────────────────────────────────────────

function RespRateCard({
  daily, baseline,
}: { daily: RecoveryIntelligencePayload["daily"]; baseline: number | null }) {
  const last7 = daily.slice(-7).map((d) => d.respiratory_rate).filter((v): v is number => v != null);
  const avg7 = last7.length === 0 ? null : last7.reduce((a, b) => a + b, 0) / last7.length;
  const delta = avg7 != null && baseline != null ? avg7 - baseline : null;
  const tone: "good" | "warn" | "bad" =
    delta == null ? "warn" : delta >= RR_DELTA_BPM ? "warn" : "good";

  const hasData = daily.some((d) => d.respiratory_rate != null);
  const data = daily.map((d) => ({ date: d.date, rr: d.respiratory_rate }));

  const mid = baseline ?? (avg7 ?? 15);
  const yMin = mid - 3;
  const yMax = mid + 3;

  return (
    <Card>
      <CardHeader title="Respiratory rate · 28d"
        sub={`7d avg: ${avg7 != null ? fmtNum(avg7) : "—"} bpm · baseline: ${baseline != null ? fmtNum(baseline) : "—"}`}
        value={delta != null ? `${delta > 0 ? "+" : ""}${fmtNum(delta)}` : "—"} tone={tone} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[yMin, yMax]} />
            {baseline != null && (
              <>
                <ReferenceLine
                  y={baseline}
                  stroke={COLOR.accent}
                  strokeDasharray="3,3"
                  strokeOpacity={0.5}
                  strokeWidth={1}
                />
                <ReferenceLine
                  y={baseline + RR_DELTA_BPM}
                  stroke={COLOR.warning}
                  strokeDasharray="2,4"
                  strokeOpacity={0.4}
                  strokeWidth={1}
                />
              </>
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; rr: number | null };
                const d = baseline != null && p.rr != null ? p.rr - baseline : null;
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.rr != null && (
                      <div style={{ color: "#7dd3fc" }}>{`${fmtNum(p.rr)} bpm`}</div>
                    )}
                    {d != null && (
                      <div style={{ color: COLOR.textMuted }}>
                        {`${d > 0 ? "+" : ""}${fmtNum(d)} vs baseline`}
                      </div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line
              type="monotone"
              dataKey="rr"
              stroke="#7dd3fc"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: "#7dd3fc", stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Insufficient data
        </div>
      )}
    </Card>
  );
}
