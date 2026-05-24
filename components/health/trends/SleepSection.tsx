// components/health/trends/SleepSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  SLEEP_TARGET_BAND, SLEEP_SCORE_MEANINGFUL, BEDTIME_DRIFT_SD_MINUTES,
} from "@/lib/coach/recovery-intelligence/thresholds";
import { formatDateLabel, formatBedtimeLabel } from "@/components/health/trends/format";

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
        avg7d={
          rolling7[rolling7.length - 1]
        }
      />

      {/* A5: Sleep score vs hours */}
      <ScoreVsHoursCard
        daily={daily.map((d) => ({ date: d.date, score: d.sleep_score, hours: d.sleep_hours }))}
      />

      {/* A6: Sleep architecture mix */}
      <ArchitectureCard arch={sleep_architecture} />

      {/* A7: Bedtime/wake consistency */}
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

function SleepHoursCard({
  daily, rolling, avg7d,
}: {
  daily: Array<{ date: string; hours: number | null }>;
  rolling: Array<number | null>;
  avg7d: number | null;
}) {
  const [lo, hi] = SLEEP_TARGET_BAND;
  const yMax = 10;
  const yScale = (v: number) => 80 - (v / yMax) * 80;
  const tone: "good" | "warn" | "bad" =
    avg7d == null ? "warn" : avg7d >= lo ? "good" : avg7d >= 6 ? "warn" : "bad";

  return (
    <Card>
      <CardHeader title="Sleep hours · 28d"
        sub={`7d avg: ${avg7d != null ? `${fmtNum(avg7d)}h` : "—"} · target ${lo}–${hi}h`}
        value={avg7d != null ? `${fmtNum(avg7d)}h` : "—"} tone={tone} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {/* target band */}
        <rect x="0" y={yScale(hi)} width="360" height={yScale(lo) - yScale(hi)}
          fill={COLOR.success} fillOpacity={0.08} />
        {/* bars */}
        {daily.map((d, i) => {
          if (d.hours == null) return null;
          const x = 2 + i * (360 - 4) / daily.length;
          const w = (360 - 4) / daily.length - 2;
          const h = (d.hours / yMax) * 80;
          const color = d.hours >= lo ? "#7dd3fc" : d.hours >= 6 ? COLOR.warning : COLOR.danger;
          return (
            <rect key={i} x={x} y={80 - h} width={w} height={h} fill={color} style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(d.date)}: ${fmtNum(d.hours)}h`}</title>
            </rect>
          );
        })}
        {/* 7d rolling line */}
        <polyline
          points={rolling
            .map((v, i) => (v == null ? null : `${(i / (rolling.length - 1)) * 360},${yScale(v)}`))
            .filter(Boolean)
            .join(" ")}
          fill="none" stroke={COLOR.accent} strokeWidth={1.5}
        />
        {/* Invisible hover targets for rolling-avg line with native <title> tooltip */}
        {rolling.map((v, i) => {
          if (v == null) return null;
          const x = (i / (rolling.length - 1)) * 360;
          const y = yScale(v);
          return (
            <circle key={`roll-${i}`} cx={x} cy={y} r={7} fill="transparent" stroke="transparent" style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(daily[i].date)}: 7d avg ${fmtNum(v)}h`}</title>
            </circle>
          );
        })}
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "nightly" },
        { color: COLOR.accent, label: "7d rolling" },
        { color: COLOR.success, label: "target band" },
      ]} />
    </Card>
  );
}

function ScoreVsHoursCard({
  daily,
}: { daily: Array<{ date: string; score: number | null; hours: number | null }> }) {
  const yScoreMax = 100;
  const yHoursMax = 10;
  const yS = (v: number) => 80 - (v / yScoreMax) * 80;
  const yH = (v: number) => 80 - (v / yHoursMax) * 80;
  const lastScore = daily[daily.length - 1]?.score ?? null;
  const lastHours = daily[daily.length - 1]?.hours ?? null;
  return (
    <Card>
      <CardHeader title="Sleep score vs hours · 28d"
        sub={`Score ${lastScore != null ? Math.round(lastScore) : "—"} · hours ${lastHours != null ? fmtNum(lastHours) : "—"}`} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        <line x1="0" y1={yS(SLEEP_SCORE_MEANINGFUL)} x2="360" y2={yS(SLEEP_SCORE_MEANINGFUL)}
          stroke={COLOR.warning} strokeWidth={0.5} strokeDasharray="2,3" opacity={0.4} />
        <polyline
          points={daily.map((d, i) => (d.score == null ? null : `${(i / (daily.length - 1)) * 360},${yS(d.score)}`)).filter(Boolean).join(" ")}
          fill="none" stroke={COLOR.warning} strokeWidth={1.5} />
        <polyline
          points={daily.map((d, i) => (d.hours == null ? null : `${(i / (daily.length - 1)) * 360},${yH(d.hours)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
        {/* Invisible hover targets: score points */}
        {daily.map((d, i) => {
          if (d.score == null) return null;
          const x = (i / (daily.length - 1)) * 360;
          const y = yS(d.score);
          return (
            <circle key={`score-${d.date}`} cx={x} cy={y} r={7} fill="transparent" stroke="transparent" style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(d.date)}: score ${Math.round(d.score)}`}</title>
            </circle>
          );
        })}
        {/* Invisible hover targets: hours points */}
        {daily.map((d, i) => {
          if (d.hours == null) return null;
          const x = (i / (daily.length - 1)) * 360;
          const y = yH(d.hours);
          return (
            <circle key={`hours-${d.date}`} cx={x} cy={y} r={7} fill="transparent" stroke="transparent" style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(d.date)}: ${fmtNum(d.hours)}h`}</title>
            </circle>
          );
        })}
      </svg>
      <Legend items={[
        { color: COLOR.warning, label: "score" },
        { color: "#7dd3fc", label: "hours" },
      ]} />
    </Card>
  );
}

function ArchitectureCard({ arch }: { arch: RecoveryIntelligencePayload["sleep_architecture"] }) {
  const yMax = Math.max(...arch.map((a) => a.total_hours ?? 0), 1);
  const yScale = (v: number) => (v / yMax) * 80;
  return (
    <Card>
      <CardHeader title="Sleep architecture mix · 14d"
        sub={archSummary(arch)} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {arch.map((a, i) => {
          const x = 2 + i * (360 - 4) / arch.length;
          const w = (360 - 4) / arch.length - 2;
          const deep = a.deep_hours ?? 0;
          const rem  = a.rem_hours ?? 0;
          const light = a.light_hours ?? 0;
          const yDeep  = 80 - yScale(deep);
          const yRem   = yDeep - yScale(rem);
          const yLight = yRem  - yScale(light);
          return (
            <g key={i} style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(a.date)}: deep ${fmtNum(deep)}h · REM ${fmtNum(rem)}h · light ${fmtNum(light)}h`}</title>
              <rect x={x} y={yDeep}  width={w} height={yScale(deep)}  fill={COLOR.accent} />
              <rect x={x} y={yRem}   width={w} height={yScale(rem)}   fill="#7dd3fc" />
              <rect x={x} y={yLight} width={w} height={yScale(light)} fill="#374151" />
            </g>
          );
        })}
      </svg>
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
