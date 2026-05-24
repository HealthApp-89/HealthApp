// components/health/trends/HrvAutonomicSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { formatDateLabel } from "@/components/health/trends/format";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  Cell,
} from "recharts";

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

// ── Shared tooltip style ───────────────────────────────────────────────────

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

// ── A1: HRV vs baseline ───────────────────────────────────────────────────

function HrvVsBaselineCard({
  daily, baseline, hrvSd, avg7d, vsBaselinePct,
}: {
  daily: Array<{ date: string; hrv: number | null }>;
  baseline: number | null;
  hrvSd: number | null;
  avg7d: number | null;
  vsBaselinePct: number | null;
}) {
  const data = daily.map((d) => ({ date: d.date, hrv: d.hrv }));
  const hasData = data.some((d) => d.hrv != null);

  const pctRounded = vsBaselinePct == null ? null : Math.round(vsBaselinePct * 100);
  const valueClass: "good" | "warn" | "bad" =
    pctRounded == null ? "warn" : pctRounded < -7 ? "bad" : pctRounded < -3 ? "warn" : "good";

  const sdHi = baseline != null && hrvSd != null ? baseline + hrvSd : null;
  const sdLo = baseline != null && hrvSd != null ? baseline - hrvSd : null;

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
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={["auto", "auto"]} />
            {sdHi != null && sdLo != null && (
              <ReferenceArea y1={sdLo} y2={sdHi} fill={COLOR.accent} fillOpacity={0.08} />
            )}
            {baseline != null && (
              <ReferenceLine
                y={baseline}
                stroke={COLOR.accent}
                strokeDasharray="3,3"
                strokeOpacity={0.5}
                strokeWidth={1}
              />
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; hrv: number | null };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    <div style={{ color: "#7dd3fc" }}>{p.hrv != null ? `${fmtNum(p.hrv)} ms` : "—"}</div>
                    {baseline != null && p.hrv != null && (
                      <div style={{ color: COLOR.textMuted }}>
                        {`baseline ${fmtNum(baseline)} ms`}
                      </div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line
              type="monotone"
              dataKey="hrv"
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
      <Legend items={[
        { color: "#7dd3fc", label: "HRV daily" },
        { color: COLOR.accent, label: "baseline ±1 SD" },
      ]} />
    </Card>
  );
}

// ── A2: RHR vs baseline ───────────────────────────────────────────────────

function RhrVsBaselineCard({
  daily, baseline, avg7d, deltaBpm,
}: {
  daily: Array<{ date: string; rhr: number | null }>;
  baseline: number | null;
  avg7d: number | null;
  deltaBpm: number | null;
}) {
  const data = daily.map((d) => ({ date: d.date, rhr: d.rhr }));
  const hasData = data.some((d) => d.rhr != null);

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
      {hasData ? (
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={["auto", "auto"]} />
            {baseline != null && (
              <ReferenceLine
                y={baseline}
                stroke={COLOR.accent}
                strokeDasharray="3,3"
                strokeOpacity={0.5}
                strokeWidth={1}
              />
            )}
            {baseline != null && (
              <ReferenceLine
                y={baseline + 5}
                stroke={COLOR.danger}
                strokeDasharray="2,4"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { date: string; rhr: number | null };
                return (
                  <TooltipBox>
                    <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                    <div style={{ color: "#7dd3fc" }}>{p.rhr != null ? `${fmtNum(p.rhr)} bpm` : "—"}</div>
                    {baseline != null && p.rhr != null && (
                      <div style={{ color: COLOR.textMuted }}>{`baseline ${fmtNum(baseline)} bpm`}</div>
                    )}
                  </TooltipBox>
                );
              }}
              cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
            />
            <Line
              type="monotone"
              dataKey="rhr"
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
      <Legend items={[
        { color: COLOR.accent, label: "baseline" },
        { color: COLOR.danger, label: "+5 bpm alert" },
      ]} />
    </Card>
  );
}

// ── A3: HRV weekly avg ────────────────────────────────────────────────────

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

  const recentTrendingDown =
    baseline != null
      ? weekly.slice(-3).every((w) => w.hrv_avg != null && w.hrv_avg < baseline * 0.97)
      : false;

  const data = weekly.map((w) => ({ week_start: w.week_start, hrv_avg: w.hrv_avg }));

  return (
    <Card>
      <CardHeader
        title="HRV weekly avg · 12w"
        sub={recentTrendingDown ? "Trending down 3 weeks" : ""}
        value={vals[vals.length - 1] != null ? `${fmtNum(vals[vals.length - 1])}` : "—"}
        tone={recentTrendingDown ? "warn" : "good"}
      />
      <ResponsiveContainer width="100%" height={90}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="25%">
          <XAxis dataKey="week_start" hide />
          <YAxis hide domain={[0, "auto"]} />
          {baseline != null && (
            <ReferenceLine
              y={baseline}
              stroke={COLOR.accent}
              strokeDasharray="3,3"
              strokeOpacity={0.5}
            />
          )}
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { week_start: string; hrv_avg: number | null };
              return (
                <TooltipBox>
                  <div style={{ fontWeight: 600, color: COLOR.textStrong }}>
                    {`Week of ${formatDateLabel(p.week_start)}`}
                  </div>
                  <div style={{ color: "#7dd3fc" }}>
                    {p.hrv_avg != null ? `${fmtNum(p.hrv_avg)} ms` : "—"}
                  </div>
                </TooltipBox>
              );
            }}
            cursor={{ fill: COLOR.surfaceAlt }}
          />
          <Bar dataKey="hrv_avg" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((entry, i) => {
              const isRecent = i >= data.length - 3 && recentTrendingDown;
              return <Cell key={entry.week_start} fill={isRecent ? COLOR.warning : "#7dd3fc"} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
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
