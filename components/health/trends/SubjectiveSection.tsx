// components/health/trends/SubjectiveSection.tsx
"use client";
import type { RecoveryIntelligencePayload, SubjectivePoint } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { RECURRING_SORENESS_OCCURRENCES, RECURRING_SORENESS_WINDOW_DAYS } from "@/lib/coach/recovery-intelligence/thresholds";

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
              // Light-theme substitutions:
              // "#1a1a1a" (dark empty cell) → COLOR.divider (#e8eaf3)
              // "rgba(248,113,113,0.7)" (sharp, dark red tint) → COLOR.dangerSoft (#fee2e2)
              // "rgba(250,204,21,0.45)" (mild, dark amber tint) → COLOR.warningSoft (#fef3c7)
              const bg = !has ? COLOR.divider
                : p.soreness_severity === "sharp" ? COLOR.dangerSoft
                : COLOR.warningSoft;
              return <div key={p.date} style={{ flex: 1, height: 14, borderRadius: 2, background: bg }} />;
            })}
          </div>
        ))}
      </div>
      {/* Legend dots use the same substituted colors so they match the cells */}
      <Legend items={[
        { color: COLOR.warningSoft, label: "mild" },
        { color: COLOR.dangerSoft, label: "sharp" },
      ]} />
    </Card>
  );
}

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
          // Light-theme substitutions:
          // "#7f1d1d" (heavy, dark red) → COLOR.dangerSoft (#fee2e2)
          // "#422006" (some, dark amber) → COLOR.warningSoft (#fef3c7)
          // "#1f2937" (none, dark slate) → COLOR.divider (#e8eaf3)
          const bg =
            p.fatigue === "heavy" ? COLOR.dangerSoft :
            p.fatigue === "some"  ? COLOR.warningSoft :
            COLOR.divider;
          return (
            <div key={p.date} style={{ flex: 1, height: 22, borderRadius: 2, background: bg, position: "relative" }}>
              {p.sick && (
                <div style={{ position: "absolute", bottom: -3, left: "50%", transform: "translateX(-50%)",
                  width: 6, height: 6, background: COLOR.danger, borderRadius: "50%" }} />
              )}
            </div>
          );
        })}
      </div>
      {/* Legend dots use the same substituted colors so they match the cells */}
      <Legend items={[
        { color: COLOR.divider, label: "none" },
        { color: COLOR.warningSoft, label: "some" },
        { color: COLOR.dangerSoft, label: "heavy" },
        { color: COLOR.danger, label: "sick" },
      ]} />
    </Card>
  );
}

function SubjVsObjCard({
  daily, subjective,
}: { daily: RecoveryIntelligencePayload["daily"]; subjective: SubjectivePoint[] }) {
  // Both arrays are 28d, same dates.
  const yHrv = (v: number, min: number, max: number) => 80 - ((v - min) / (max - min)) * 80;
  const hrvs = daily.map((d) => d.hrv).filter((v): v is number => v != null);
  if (hrvs.length === 0) {
    return <Card><CardHeader title="Subjective vs objective · 28d" sub="Insufficient data" /></Card>;
  }
  const min = Math.min(...hrvs) * 0.95;
  const max = Math.max(...hrvs) * 1.05;
  return (
    <Card>
      <CardHeader title="Subjective vs objective · 28d"
        sub="HRV trend overlaid with reported fatigue tier" />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {/* "#7dd3fc" cyan HRV line — kept as-is, reads fine on white */}
        <polyline
          points={daily.map((d, i) => (d.hrv == null ? null : `${(i / (daily.length - 1)) * 360},${yHrv(d.hrv, min, max)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
        {subjective.map((s, i) => {
          if (s.fatigue == null) return null;
          const r = s.fatigue === "heavy" ? 5 : s.fatigue === "some" ? 3 : 2;
          return <circle key={s.date} cx={(i / (subjective.length - 1)) * 360} cy={72} r={r} fill={COLOR.danger} />;
        })}
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "HRV" },
        { color: COLOR.danger, label: "fatigue (size = tier)" },
      ]} />
    </Card>
  );
}
