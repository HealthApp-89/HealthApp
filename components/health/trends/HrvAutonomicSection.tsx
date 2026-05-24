// components/health/trends/HrvAutonomicSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { formatDateLabel } from "@/components/health/trends/format";

type Props = { payload: RecoveryIntelligencePayload };

export function HrvAutonomicSection({ payload }: Props) {
  const { daily, weekly, baselines, derived } = payload;

  return (
    <section style={{ padding: 16 }}>
      <h3 style={sectionTitle}>HRV &amp; autonomic state</h3>

      {/* A1: HRV vs baseline · 28d daily */}
      <HrvVsBaselineCard
        daily={daily.map((d) => ({ date: d.date, hrv: d.hrv }))}
        baseline={baselines.hrv_mean}
        hrvSd={baselines.hrv_sd}
        avg7d={derived.hrv_avg_7d}
        vsBaselinePct={derived.hrv_vs_baseline_pct_7d}
      />

      {/* A2: RHR vs baseline · 28d daily */}
      <RhrVsBaselineCard
        daily={daily.map((d) => ({ date: d.date, rhr: d.resting_hr }))}
        baseline={baselines.resting_hr_mean}
        avg7d={derived.rhr_avg_7d}
        deltaBpm={derived.rhr_vs_baseline_bpm_7d}
      />

      {/* A3: HRV weekly avg · 12w */}
      <HrvWeeklyCard weekly={weekly} baseline={baselines.hrv_mean} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: COLOR.textMuted,
  margin: "0 0 10px 0",
};

// — Card implementations: each renders the equivalent SVG from the mockup. —

function HrvVsBaselineCard({
  daily, baseline, hrvSd, avg7d, vsBaselinePct,
}: {
  daily: Array<{ date: string; hrv: number | null }>;
  baseline: number | null;
  hrvSd: number | null;
  avg7d: number | null;
  vsBaselinePct: number | null;
}) {
  // Trend-line polyline. Map y so baseline is centered, ±SD is a band.
  // Use a simple linear scale: take min/max from daily HRV with a 10% pad.
  const hrvs = daily.map((d) => d.hrv).filter((h): h is number => h != null);
  const yMin = (Math.min(...hrvs, baseline ?? 0)) * 0.9;
  const yMax = (Math.max(...hrvs, baseline ?? 0)) * 1.1;
  const yScale = (v: number) => 80 - ((v - yMin) / (yMax - yMin)) * 80;

  const points = daily
    .map((d, i) => (d.hrv == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.hrv)}`))
    .filter(Boolean)
    .join(" ");

  const pctRounded = vsBaselinePct == null ? null : Math.round(vsBaselinePct * 100);
  const valueClass: "good" | "warn" | "bad" =
    pctRounded == null ? "warn" : pctRounded < -7 ? "bad" : pctRounded < -3 ? "warn" : "good";

  return (
    <Card>
      <CardHeader
        title="HRV vs baseline · 28d"
        sub={baseline != null && avg7d != null
          ? `7d avg: ${fmtNum(avg7d)} ms · baseline: ${fmtNum(baseline)} ms`
          : "Insufficient data"}
        value={pctRounded != null ? `${pctRounded > 0 ? "+" : ""}${pctRounded}%` : "—"}
        tone={valueClass}
      />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && hrvSd != null && (
          <rect
            x="0" y={yScale(baseline + hrvSd)} width="360"
            height={yScale(baseline - hrvSd) - yScale(baseline + hrvSd)}
            fill={COLOR.accent} fillOpacity={0.08}
          />
        )}
        {baseline != null && (
          <line x1="0" y1={yScale(baseline)} x2="360" y2={yScale(baseline)}
            stroke={COLOR.accent} strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
        )}
        {/* "#7dd3fc" = cyan info color; migrate to COLOR.info when token is added */}
        <polyline points={points} fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
        {/* Invisible hover targets — one circle per day with native <title> tooltip */}
        {daily.map((d, i) => {
          if (d.hrv == null) return null;
          const x = (i / (daily.length - 1)) * 360;
          const y = yScale(d.hrv);
          return (
            <circle key={d.date} cx={x} cy={y} r={7} fill="transparent" stroke="transparent" style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(d.date)}: ${fmtNum(d.hrv)} ms`}</title>
            </circle>
          );
        })}
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "HRV daily" },
        { color: COLOR.accent, label: "baseline ±1 SD" },
      ]} />
    </Card>
  );
}

function RhrVsBaselineCard({
  daily, baseline, avg7d, deltaBpm,
}: {
  daily: Array<{ date: string; rhr: number | null }>;
  baseline: number | null;
  avg7d: number | null;
  deltaBpm: number | null;
}) {
  const vals = daily.map((d) => d.rhr).filter((v): v is number => v != null);
  const yMin = Math.min(...vals, baseline ?? 0) - 3;
  const yMax = Math.max(...vals, baseline ?? 0) + 3;
  const yScale = (v: number) => 80 - ((v - yMin) / (yMax - yMin)) * 80;

  const points = daily
    .map((d, i) => (d.rhr == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.rhr)}`))
    .filter(Boolean)
    .join(" ");

  const tone: "good" | "warn" | "bad" =
    deltaBpm == null ? "warn" : deltaBpm >= 5 ? "bad" : deltaBpm >= 3 ? "warn" : "good";

  return (
    <Card>
      <CardHeader
        title="RHR vs baseline · 28d"
        sub={baseline != null && avg7d != null
          ? `7d avg: ${fmtNum(avg7d)} bpm · baseline: ${fmtNum(baseline)} bpm`
          : "Insufficient data"}
        value={deltaBpm != null ? `${deltaBpm > 0 ? "+" : ""}${fmtNum(deltaBpm)} bpm` : "—"}
        tone={tone}
      />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <>
            <line x1="0" y1={yScale(baseline)}     x2="360" y2={yScale(baseline)}
              stroke={COLOR.accent} strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
            <line x1="0" y1={yScale(baseline + 5)} x2="360" y2={yScale(baseline + 5)}
              stroke={COLOR.danger} strokeWidth={1} strokeDasharray="2,4" opacity={0.4} />
          </>
        )}
        {/* "#7dd3fc" = cyan info color; migrate to COLOR.info when token is added */}
        <polyline points={points} fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
        {/* Invisible hover targets with native <title> tooltip */}
        {daily.map((d, i) => {
          if (d.rhr == null) return null;
          const x = (i / (daily.length - 1)) * 360;
          const y = yScale(d.rhr);
          return (
            <circle key={d.date} cx={x} cy={y} r={7} fill="transparent" stroke="transparent" style={{ cursor: "pointer" }}>
              <title>{`${formatDateLabel(d.date)}: ${fmtNum(d.rhr)} bpm`}</title>
            </circle>
          );
        })}
      </svg>
      <Legend items={[
        { color: COLOR.accent, label: "baseline" },
        { color: COLOR.danger, label: "+5 bpm alert" },
      ]} />
    </Card>
  );
}

function HrvWeeklyCard({
  weekly, baseline,
}: {
  weekly: RecoveryIntelligencePayload["weekly"];
  baseline: number | null;
}) {
  const vals = weekly.map((w) => w.hrv_avg).filter((v): v is number => v != null);
  if (vals.length === 0) {
    return (
      <Card>
        <CardHeader title="HRV weekly avg · 12w" sub="Insufficient data" value="—" tone="warn" />
      </Card>
    );
  }
  const yMax = Math.max(...vals, baseline ?? 0) * 1.1;
  const barH = (v: number | null) => (v == null ? 0 : (v / yMax) * 70);

  const recentTrendingDown =
    baseline != null
      ? weekly.slice(-3).every((w) => w.hrv_avg != null && w.hrv_avg < baseline * 0.97)
      : false;

  return (
    <Card>
      <CardHeader
        title="HRV weekly avg · 12w"
        sub={recentTrendingDown ? "Trending down 3 weeks" : ""}
        value={vals[vals.length - 1] != null ? `${fmtNum(vals[vals.length - 1])}` : "—"}
        tone={recentTrendingDown ? "warn" : "good"}
      />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <line x1="0" y1={80 - (baseline / yMax) * 70} x2="360" y2={80 - (baseline / yMax) * 70}
            stroke={COLOR.accent} strokeDasharray="3,3" opacity={0.5} />
        )}
        {weekly.map((w, i) => {
          const h = barH(w.hrv_avg);
          const x = 4 + i * 30;
          const isRecent = i >= weekly.length - 3 && recentTrendingDown;
          return (
            <rect key={w.week_start}
              x={x} y={80 - h} width={22} height={h}
              fill={isRecent ? COLOR.warning : "#7dd3fc"}
              style={{ cursor: "pointer" }}>
              <title>{w.hrv_avg != null ? `Week of ${formatDateLabel(w.week_start)}: ${fmtNum(w.hrv_avg)} ms` : `Week of ${formatDateLabel(w.week_start)}: —`}</title>
            </rect>
          );
        })}
      </svg>
    </Card>
  );
}

// ── Shared card primitives (used by every section) ──────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: COLOR.surface,
      border: `1px solid ${COLOR.divider}`,
      borderRadius: 12, padding: 14, marginBottom: 10,
    }}>{children}</div>
  );
}

function CardHeader({
  title, sub, value, tone,
}: { title: string; sub?: string; value?: string; tone?: "good" | "warn" | "bad" }) {
  const toneColor = tone === "good" ? COLOR.success : tone === "bad" ? COLOR.danger : COLOR.warning;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
      <div>
        {/* COLOR.text does not exist in theme.ts — using COLOR.textStrong (primary text token) */}
        <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: COLOR.textMuted }}>{sub}</div>}
      </div>
      {value && (
        <div style={{ fontSize: 18, fontWeight: 700, color: toneColor }}>{value}</div>
      )}
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div style={{ display: "flex", gap: 12, fontSize: 10, color: COLOR.textMuted, marginTop: 6, flexWrap: "wrap" }}>
      {items.map((it) => (
        <span key={it.label}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: it.color, verticalAlign: "middle", marginRight: 4 }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export { Card, CardHeader, Legend };
