// components/health/trends/SubjectiveSection.tsx
"use client";
import type { RecoveryIntelligencePayload, SubjectivePoint } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { formatDateLabel } from "@/components/health/trends/format";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { RECURRING_SORENESS_OCCURRENCES, RECURRING_SORENESS_WINDOW_DAYS } from "@/lib/coach/recovery-intelligence/thresholds";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
} from "recharts";

const AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;

type Props = { payload: RecoveryIntelligencePayload };

export function SubjectiveSection({ payload }: Props) {
  const { subjective, daily } = payload;
  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Subjective signals · from checkins</h3>
      <SorenessHeatmapCard subjective={subjective} />
      <FatigueTimelineCard subjective={subjective} />
      <SubjVsObjCard daily={daily} subjective={subjective} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

// ── A14: Soreness heatmap — kept as grid (spatial layout) ─────────────────

function SorenessHeatmapCard({ subjective }: { subjective: SubjectivePoint[] }) {
  // Recurring detection over last 14d for the subtitle.
  const last14 = subjective.slice(-RECURRING_SORENESS_WINDOW_DAYS);
  const counts: Record<string, number> = {};
  for (const p of last14) for (const a of p.soreness_areas) counts[a] = (counts[a] ?? 0) + 1;
  const recurring = Object.entries(counts)
    .filter(([, c]) => c >= RECURRING_SORENESS_OCCURRENCES)
    .map(([a, c]) => `${a} (${c})`);

  return (
    <Card>
      <CardHeader title="Soreness heat-map · 28d"
        sub={recurring.length ? `Recurring: ${recurring.join(", ")} of last ${RECURRING_SORENESS_WINDOW_DAYS} days` : "No recurring areas"} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {AREAS.map((area) => (
          <div key={area} style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <div style={{ fontSize: 10, color: COLOR.textMid, width: 60, flexShrink: 0 }}>{area}</div>
            {subjective.map((p) => {
              const has = p.soreness_areas.includes(area);
              const bg = !has ? COLOR.divider
                : p.soreness_severity === "sharp" ? COLOR.dangerSoft
                : COLOR.warningSoft;
              const sev = !has ? "no soreness" : p.soreness_severity === "sharp" ? "sharp" : "mild";
              return (
                <div
                  key={p.date}
                  title={`${formatDateLabel(p.date)}: ${area} — ${sev}`}
                  style={{ flex: 1, height: 14, borderRadius: 2, background: bg, cursor: "pointer" }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <Legend items={[
        { color: COLOR.warningSoft, label: "mild" },
        { color: COLOR.dangerSoft, label: "sharp" },
      ]} />
    </Card>
  );
}

// ── A15: Fatigue × sickness timeline — kept as-is (spatial grid) ─────────

function FatigueTimelineCard({ subjective }: { subjective: SubjectivePoint[] }) {
  const heavyCount = subjective.slice(-7).filter((s) => s.fatigue === "heavy").length;
  const sickStreak = (() => {
    let s = 0;
    for (let i = subjective.length - 1; i >= 0; i--) {
      if (subjective[i].sick) s++; else break;
    }
    return s;
  })();

  return (
    <Card>
      <CardHeader title="Fatigue × sickness · 28d"
        sub={`${heavyCount} heavy in 7d${sickStreak > 0 ? ` · current sick streak ${sickStreak}d` : ""}`} />
      <div style={{ display: "flex", gap: 2 }}>
        {subjective.map((p) => {
          const bg =
            p.fatigue === "heavy" ? COLOR.dangerSoft :
            p.fatigue === "some"  ? COLOR.warningSoft :
            COLOR.divider;
          const tier = p.fatigue ?? "none";
          const sickPart = p.sick ? " · sick" : "";
          return (
            <div
              key={p.date}
              title={`${formatDateLabel(p.date)}: fatigue ${tier}${sickPart}`}
              style={{ flex: 1, height: 22, borderRadius: 2, background: bg, position: "relative", cursor: "pointer" }}
            >
              {p.sick && (
                <div style={{ position: "absolute", bottom: -3, left: "50%", transform: "translateX(-50%)",
                  width: 6, height: 6, background: COLOR.danger, borderRadius: "50%" }} />
              )}
            </div>
          );
        })}
      </div>
      <Legend items={[
        { color: COLOR.divider, label: "none" },
        { color: COLOR.warningSoft, label: "some" },
        { color: COLOR.dangerSoft, label: "heavy" },
        { color: COLOR.danger, label: "sick" },
      ]} />
    </Card>
  );
}

// ── A16: Subjective vs objective — Recharts ComposedChart ─────────────────

function SubjVsObjCard({
  daily, subjective,
}: { daily: RecoveryIntelligencePayload["daily"]; subjective: SubjectivePoint[] }) {
  const hrvs = daily.map((d) => d.hrv).filter((v): v is number => v != null);
  if (hrvs.length === 0) {
    return <Card><CardHeader title="Subjective vs objective · 28d" sub="Insufficient data" /></Card>;
  }

  const hrvMin = Math.min(...hrvs) * 0.95;
  const hrvMax = Math.max(...hrvs) * 1.05;

  // Normalise HRV to [0,1] for shared y-axis.
  // Scatter y: map fatigue tier to fixed positions (none=0.1, some=0.3, heavy=0.5).
  const subjectiveByDate = new Map(subjective.map((s) => [s.date, s]));

  const data = daily.map((d) => {
    const sub = subjectiveByDate.get(d.date);
    const fatigueY =
      sub?.fatigue === "heavy" ? 0.5
        : sub?.fatigue === "some" ? 0.3
        : sub?.fatigue != null ? 0.1
        : null;
    return {
      date: d.date,
      hrv: d.hrv,
      // Normalise HRV to [0,1] domain for shared axis.
      hrvNorm: d.hrv != null ? (d.hrv - hrvMin) / (hrvMax - hrvMin) : null,
      fatigueY,
      fatigue: sub?.fatigue ?? null,
    };
  });

  return (
    <Card>
      <CardHeader title="Subjective vs objective · 28d"
        sub="HRV trend overlaid with reported fatigue tier" />
      <ResponsiveContainer width="100%" height={90}>
        <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey="date" hide />
          <YAxis hide domain={[0, 1]} />
          <ZAxis range={[20, 80]} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as {
                date: string;
                hrv: number | null;
                fatigue: string | null;
              };
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
                  <div style={{ fontWeight: 600, color: COLOR.textStrong }}>{formatDateLabel(p.date)}</div>
                  {p.hrv != null && (
                    <div style={{ color: "#7dd3fc" }}>{`HRV ${fmtNum(p.hrv)} ms`}</div>
                  )}
                  {p.fatigue != null && (
                    <div style={{ color: COLOR.danger }}>{`fatigue: ${p.fatigue}`}</div>
                  )}
                </div>
              );
            }}
            cursor={{ stroke: COLOR.accent, strokeDasharray: "3,3", strokeOpacity: 0.4 }}
          />
          <Line
            type="monotone"
            dataKey="hrvNorm"
            stroke="#7dd3fc"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 4, fill: "#7dd3fc", stroke: COLOR.surface, strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Scatter
            dataKey="fatigueY"
            fill={COLOR.danger}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <Legend items={[
        { color: "#7dd3fc", label: "HRV" },
        { color: COLOR.danger, label: "fatigue (dot height = tier)" },
      ]} />
    </Card>
  );
}
