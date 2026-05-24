// components/health/trends/SleepSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  SLEEP_TARGET_BAND, SLEEP_SCORE_MEANINGFUL, BEDTIME_DRIFT_SD_MINUTES,
} from "@/lib/coach/recovery-intelligence/thresholds";
import { formatDateLabel, formatBedtimeLabel } from "@/components/health/trends/format";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
  Cell,
} from "recharts";

type Props = { payload: RecoveryIntelligencePayload };

export function SleepSection({ payload }: Props) {
  const { daily, sleep_architecture, bedtime, derived } = payload;

  // 7d rolling sleep_hours average for A4 line overlay.
  const rolling7 = daily.map((d, i, arr) => {
    const slice = arr.slice(Math.max(0, i - 6), i + 1).map((x) => x.sleep_hours).filter((v): v is number => v != null);
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Sleep architecture &amp; consistency</h3>

      {/* A4: Sleep hours bars + 7d rolling avg */}
      <SleepHoursCard
        daily={daily.map((d) => ({ date: d.date, hours: d.sleep_hours }))}
        rolling={rolling7}
        avg7d={rolling7[rolling7.length - 1]}
      />

      {/* A5: Sleep score vs hours */}
      <ScoreVsHoursCard
        daily={daily.map((d) => ({ date: d.date, score: d.sleep_score, hours: d.sleep_hours }))}
      />

      {/* A6: Sleep architecture mix */}
      <ArchitectureCard arch={sleep_architecture} />

      {/* A7: Bedtime/wake consistency — kept as inline SVG dot-plot (spatial layout) */}
      <BedtimeCard
        bedtime={bedtime}
        meanMinutes={derived.bedtime_mean_minutes}
        sdMinutes={derived.bedtime_sd_minutes}
      />
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

// ── A4: Sleep hours ───────────────────────────────────────────────────────

function SleepHoursCard({
  daily, rolling, avg7d,
}: {
  daily: Array<{ date: string; hours: number | null }>;
  rolling: Array<number | null>;
  avg7d: number | null;
}) {
  const [lo, hi] = SLEEP_TARGET_BAND;
  const hasData = daily.some((d) => d.hours != null);
  const tone: "good" | "warn" | "bad" =
    avg7d == null ? "warn" : avg7d >= lo ? "good" : avg7d >= 6 ? "warn" : "bad";

  // Merge rolling avg into bar data for ComposedChart.
  const data = daily.map((d, i) => ({
    date: d.date,
    hours: d.hours,
    rolling: rolling[i],
  }));

  return (
    <Card>
      <CardHeader title="Sleep hours · 28d"
        sub={`7d avg: ${avg7d != null ? `${fmtNum(avg7d)}h` : "—"} · target ${lo}–${hi}h`}
        value={avg7d != null ? `${fmtNum(avg7d)}h` : "—"} tone={tone} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[0, 10]} />
            <ReferenceArea y1={lo} y2={hi} fill={COLOR.success} fillOpacity={0.08} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; hours: number | null; rolling: number | null };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.hours != null && (
                      <div style={{ color: "#7dd3fc" }}>{`${fmtNum(p.hours)}h nightly`}</div>
                    )}
                    {p.rolling != null && (
                      <div style={{ color: COLOR.accent }}>{`${fmtNum(p.rolling)}h 7d avg`}</div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ fill: COLOR.surfaceAlt, fillOpacity: 0.4 }}
            />
            <Bar dataKey="hours" isAnimationActive={false} radius={[3, 3, 0, 0]}>
              {data.map((entry) => {
                const color =
                  entry.hours == null ? "transparent"
                    : entry.hours >= lo ? "#7dd3fc"
                    : entry.hours >= 6 ? COLOR.warning
                    : COLOR.danger;
                return <Cell key={entry.date} fill={color} />;
              })}
            </Bar>
            <Line
              type="monotone"
              dataKey="rolling"
              stroke={COLOR.accent}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: COLOR.accent, stroke: COLOR.surface, strokeWidth: 2 }}
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
        { color: "#7dd3fc", label: "nightly" },
        { color: COLOR.accent, label: "7d rolling" },
        { color: COLOR.success, label: "target band" },
      ]} />
    </Card>
  );
}

// ── A5: Sleep score vs hours ──────────────────────────────────────────────

function ScoreVsHoursCard({
  daily,
}: { daily: Array<{ date: string; score: number | null; hours: number | null }> }) {
  const hasData = daily.some((d) => d.score != null || d.hours != null);
  const lastScore = daily[daily.length - 1]?.score ?? null;
  const lastHours = daily[daily.length - 1]?.hours ?? null;

  // Two y-axes: score normalised to 0-100, hours to 0-10.
  // We normalise both to the same [0,1] space for display on a single YAxis.
  const data = daily.map((d) => ({
    date: d.date,
    score: d.score,
    hours: d.hours,
    scoreNorm: d.score != null ? d.score / 100 : null,
    hoursNorm: d.hours != null ? d.hours / 10 : null,
  }));

  return (
    <Card>
      <CardHeader title="Sleep score vs hours · 28d"
        sub={`Score ${lastScore != null ? Math.round(lastScore) : "—"} · hours ${lastHours != null ? fmtNum(lastHours) : "—"}`} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[0, 1]} />
            <ReferenceLine
              y={SLEEP_SCORE_MEANINGFUL / 100}
              stroke={COLOR.warning}
              strokeWidth={0.5}
              strokeDasharray="2,3"
              strokeOpacity={0.4}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as {
                  date: string;
                  score: number | null;
                  hours: number | null;
                };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    {p.score != null && (
                      <div style={{ color: COLOR.warning }}>{`score ${Math.round(p.score)}`}</div>
                    )}
                    {p.hours != null && (
                      <div style={{ color: "#7dd3fc" }}>{`${fmtNum(p.hours)}h`}</div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line
              type="monotone"
              dataKey="scoreNorm"
              stroke={COLOR.warning}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: COLOR.warning, stroke: COLOR.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="hoursNorm"
              stroke="#7dd3fc"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4, fill: "#7dd3fc", stroke: COLOR.surface, strokeWidth: 2 }}
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
        { color: COLOR.warning, label: "score" },
        { color: "#7dd3fc", label: "hours" },
      ]} />
    </Card>
  );
}

// ── A6: Sleep architecture ────────────────────────────────────────────────

function ArchitectureCard({ arch }: { arch: RecoveryIntelligencePayload["sleep_architecture"] }) {
  const hasData = arch.some((a) => (a.total_hours ?? 0) > 0);

  const data = arch.map((a) => ({
    date: a.date,
    deep: a.deep_hours ?? 0,
    rem: a.rem_hours ?? 0,
    light: a.light_hours ?? 0,
    total: a.total_hours ?? 0,
  }));

  return (
    <Card>
      <CardHeader title="Sleep architecture mix · 14d"
        sub={archSummary(arch)} />
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%" stackOffset="none">
            <XAxis dataKey="date" hide />
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as {
                  date: string;
                  deep: number;
                  rem: number;
                  light: number;
                };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    <div style={{ color: COLOR.accent }}>{`deep ${fmtNum(p.deep)}h`}</div>
                    <div style={{ color: "#7dd3fc" }}>{`REM ${fmtNum(p.rem)}h`}</div>
                    <div style={{ color: COLOR.textMid }}>{`light ${fmtNum(p.light)}h`}</div>
                  </TooltipBox>
                );
              }}
              cursor={{ fill: COLOR.surfaceAlt, fillOpacity: 0.4 }}
            />
            <Bar dataKey="deep" stackId="a" fill={COLOR.accent} isAnimationActive={false} />
            <Bar dataKey="rem" stackId="a" fill="#7dd3fc" isAnimationActive={false} />
            <Bar dataKey="light" stackId="a" fill="#374151" isAnimationActive={false} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textMuted, fontSize: 12 }}>
          Insufficient data
        </div>
      )}
      <Legend items={[
        { color: COLOR.accent, label: "deep" },
        { color: "#7dd3fc", label: "REM" },
        { color: "#374151", label: "light" },
      ]} />
    </Card>
  );
}

function archSummary(arch: RecoveryIntelligencePayload["sleep_architecture"]): string {
  const totalDeep = arch.reduce((a, b) => a + (b.deep_hours ?? 0), 0);
  const totalRem  = arch.reduce((a, b) => a + (b.rem_hours ?? 0), 0);
  const totalSum  = arch.reduce((a, b) => a + (b.total_hours ?? 0), 0);
  if (totalSum === 0) return "Insufficient data";
  const dP = Math.round((totalDeep / totalSum) * 100);
  const rP = Math.round((totalRem  / totalSum) * 100);
  const lP = 100 - dP - rP;
  return `Deep ${dP}% · REM ${rP}% · Light ${lP}%`;
}

// ── A7: Bedtime/wake consistency — kept as-is (spatial dot plot) ──────────

function BedtimeCard({
  bedtime, meanMinutes, sdMinutes,
}: {
  bedtime: RecoveryIntelligencePayload["bedtime"];
  meanMinutes: number | null;
  sdMinutes: number | null;
}) {
  // y-axis: 0 = 18:00, 720 = 06:00, 1080 = 12:00 next day. Use 18:00–10:00 range = 0–960.
  const yMax = 960;
  const yScale = (m: number) => (m / yMax) * 110;
  const isDrifting = sdMinutes != null && sdMinutes >= BEDTIME_DRIFT_SD_MINUTES;
  return (
    <Card>
      <CardHeader title="Bedtime / wake consistency · 28d"
        sub={`Bedtime SD: ${sdMinutes != null ? Math.round(sdMinutes) : "—"} min · wake variability is tighter`}
        value={isDrifting ? "drift" : "ok"} tone={isDrifting ? "warn" : "good"} />
      <svg viewBox="0 0 360 110" preserveAspectRatio="none" style={{ width: "100%" }}>
        {meanMinutes != null && (
          <line x1="0" y1={yScale(meanMinutes)} x2="360" y2={yScale(meanMinutes)}
            stroke={COLOR.accent} strokeDasharray="2,3" opacity={0.3} />
        )}
        {bedtime.map((p, i) => {
          const x = (i / (bedtime.length - 1)) * 360;
          return (
            <g key={p.date}>
              {p.bedtime_minutes_after_18 != null && (
                <circle cx={x} cy={yScale(p.bedtime_minutes_after_18)} r={2.5} fill="#7dd3fc" style={{ cursor: "pointer" }}>
                  <title>{`${formatDateLabel(p.date)}: bedtime ${formatBedtimeLabel(p.bedtime_minutes_after_18)}`}</title>
                </circle>
              )}
              {p.wake_minutes_after_18 != null && (
                <circle cx={x} cy={yScale(p.wake_minutes_after_18)} r={2.5} fill={COLOR.accent} style={{ cursor: "pointer" }}>
                  <title>{`${formatDateLabel(p.date)}: wake ${formatBedtimeLabel(p.wake_minutes_after_18)}`}</title>
                </circle>
              )}
            </g>
          );
        })}
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "bedtime" },
        { color: COLOR.accent, label: "wake" },
      ]} />
    </Card>
  );
}
