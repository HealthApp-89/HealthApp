// components/dashboard/TodayClient.tsx
"use client";

import { Suspense, type ReactNode } from "react";
import { WeekStrip } from "@/components/layout/WeekStrip";
import { ReadinessHero } from "@/components/dashboard/ReadinessHero";
import { CoachEntryCard } from "@/components/dashboard/CoachEntryCard";
import { RecentLiftsCard, type RecentSession } from "@/components/dashboard/RecentLiftsCard";
import { MetricCard } from "@/components/charts/MetricCard";
import { ImpactDonut } from "@/components/dashboard/ImpactDonut";
import { InstallHint } from "@/components/layout/InstallHint";
import { COLOR, METRIC_COLOR, modeColorLight } from "@/lib/ui/theme";
import { calcReadinessScore } from "@/lib/ui/score";
import { computeImpact } from "@/lib/coach/impact";
import { buildDailyPlan, getIntensityMode } from "@/lib/coach/readiness";
import { formatHeaderDate } from "@/lib/time";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useLatestWeight } from "@/lib/query/hooks/useLatestWeight";
import { useLast7 } from "@/lib/query/hooks/useLast7";
import { useWorkouts } from "@/lib/query/hooks/useWorkouts";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import type { DailyLog } from "@/lib/data/types";

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function rollingAvg(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === "number" && !isNaN(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][dt.getUTCDay()];
  return `${day} ${dt.getUTCDate()}`;
}

export function TodayClient({
  userId,
  userEmail,
  selectedDate,
  today,
  isToday,
  weeklyRollups,
}: {
  userId: string;
  userEmail: string | null;
  selectedDate: string;
  today: string;
  isToday: boolean;
  /** Pre-rendered WeeklyRollups node from the Server Component parent.
   *  WeeklyRollups is async and uses next/headers — it can't be imported
   *  into a Client Component, so the parent passes it as a child node. */
  weeklyRollups: ReactNode;
}) {
  const selectedYesterday = shiftIso(selectedDate, -1);
  const sevenDaysBefore = shiftIso(selectedDate, -7);
  const fourteenBefore = shiftIso(selectedDate, -14);

  // All queries hit hydrated cache on first render — instant.
  const { data: profile } = useProfile(userId);
  const { data: selectedLogRange = [] } = useDailyLogs(userId, selectedDate, selectedDate);
  const { data: prevLogRange = [] } = useDailyLogs(userId, selectedYesterday, selectedYesterday);
  const { data: checkin = null } = useCheckin(userId, selectedDate);
  const { data: latestWeightRow = null } = useLatestWeight(userId, selectedDate);
  const { data: last7Rows = [] } = useLast7(userId, selectedDate, sevenDaysBefore);
  const { data: recentWorkoutsRaw = [] } = useWorkouts(userId, fourteenBefore, selectedDate, 5);

  const selectedLog = (selectedLogRange[0] ?? null) as DailyLog | null;
  const prevLog = (prevLogRange[0] ?? null) as DailyLog | null;
  const hasData = !!selectedLog;

  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const effectiveWeightKg =
    selectedLog?.weight_kg ??
    (typeof latestWeightRow?.weight_kg === "number" ? latestWeightRow.weight_kg : null);

  const calorieTarget =
    effectiveWeightKg !== null &&
    typeof profile?.age === "number" &&
    typeof profile?.height_cm === "number"
      ? (10 * effectiveWeightKg + 6.25 * profile.height_cm - 5 * profile.age + 5) * 1.55
      : null;

  // Donut: today's recovery + YESTERDAY's load/intake (per feedback memory).
  const scoreLog: DailyLog | null = selectedLog
    ? {
        ...selectedLog,
        steps: prevLog?.steps ?? null,
        strain: prevLog?.strain ?? null,
        calories_eaten: prevLog?.calories_eaten ?? null,
        protein_g: prevLog?.protein_g ?? null,
        carbs_g: prevLog?.carbs_g ?? null,
      }
    : null;

  const fellBackToPrior = new Set<string>();
  if (prevLog) {
    if (prevLog.steps != null) fellBackToPrior.add("steps");
    if (prevLog.strain != null) fellBackToPrior.add("strain");
    if (prevLog.calories_eaten != null) fellBackToPrior.add("calories");
    if (prevLog.protein_g != null) fellBackToPrior.add("protein");
    if (prevLog.carbs_g != null) fellBackToPrior.add("carbs");
  }

  const score = calcReadinessScore({
    log: scoreLog,
    checkin: checkin ?? null,
    hrvBaseline,
    weightKg: effectiveWeightKg,
    calorieTarget,
  });

  const rawImpact = hasData
    ? computeImpact(scoreLog, hrvBaseline, effectiveWeightKg, calorieTarget)
    : null;
  const impact = rawImpact
    ? {
        ...rawImpact,
        segments: rawImpact.segments.map((s) =>
          fellBackToPrior.has(s.key) && s.value !== null
            ? { ...s, reason: `yest. — ${s.reason}` }
            : s,
        ),
      }
    : null;

  const feelInput = checkin
    ? {
        readiness: checkin.readiness ?? null,
        energyLabel: checkin.energy_label ?? null,
        mood: checkin.mood ?? null,
        soreness: checkin.soreness ?? null,
        notes: checkin.feel_notes ?? null,
        sick: checkin.sick ?? false,
        fatigue: checkin.fatigue ?? null,
        sorenessAreas: checkin.soreness_areas ?? null,
        sorenessSeverity: checkin.soreness_severity ?? null,
      }
    : null;
  const dailyPlan = buildDailyPlan(selectedLog, feelInput, hrvBaseline);
  const mode = getIntensityMode(dailyPlan.readiness, feelInput);

  const hrvAvg    = rollingAvg(last7Rows.map((r) => r.hrv));
  const rhrAvg    = rollingAvg(last7Rows.map((r) => r.resting_hr));
  const sleepAvg  = rollingAvg(last7Rows.map((r) => r.sleep_hours));
  const strainAvg = rollingAvg(last7Rows.map((r) => r.strain));
  const hrvDelta    = selectedLog?.hrv != null && hrvAvg != null ? selectedLog.hrv - hrvAvg : null;
  const rhrDelta    = selectedLog?.resting_hr != null && rhrAvg != null ? selectedLog.resting_hr - rhrAvg : null;
  const sleepDelta  = selectedLog?.sleep_hours != null && sleepAvg != null ? selectedLog.sleep_hours - sleepAvg : null;
  const strainDelta = selectedLog?.strain != null && strainAvg != null ? selectedLog.strain - strainAvg : null;

  const recentSessions: RecentSession[] = recentWorkoutsRaw.map((w) => {
    let vol = 0;
    let bwReps = 0;
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue;
        if (s.kg && s.reps) vol += s.kg * s.reps;
        else if (!s.kg && s.reps) bwReps += s.reps;
      }
    }
    const firstName = (w.exercises ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.name;
    const title = w.type ? (firstName ? `${w.type} · ${firstName}` : w.type) : firstName ?? "Workout";
    return { date: formatShortDate(w.date), title, volumeKg: vol, bwReps };
  });

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>{formatHeaderDate()}</div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Today</h1>
        </div>
        <div
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLOR.accent}, ${COLOR.accentDeep})`,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "14px",
            fontWeight: 700,
          }}
        >
          {(profile?.name ?? userEmail ?? "A")[0].toUpperCase()}
        </div>
      </div>

      {isToday && <InstallHint />}

      <WeekStrip selected={selectedDate} today={today} />

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
        <ReadinessHero score={score ?? null} status={mode.label.replace(/^[^\s]+\s/, "")} subtitle={mode.desc} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <MetricCard color={METRIC_COLOR.hrv}        icon="♥" label="HRV"        value={selectedLog?.hrv ?? null}        unit="ms"  delta={hrvDelta}    deltaUnit="ms" />
          <MetricCard color={METRIC_COLOR.resting_hr} icon="♥" label="Resting HR" value={selectedLog?.resting_hr ?? null} unit="bpm" delta={rhrDelta}    deltaUnit="bpm" inverted />
          <MetricCard color={METRIC_COLOR.sleep_hours} icon="☾" label="Sleep"     value={selectedLog?.sleep_hours ?? null} unit="h"  delta={sleepDelta}  deltaUnit="h" />
          <MetricCard color={METRIC_COLOR.strain}     icon="⚡" label="Strain"    value={selectedLog?.strain ?? null}                delta={strainDelta} />
        </div>

        {(selectedLog?.weight_kg != null || selectedLog?.body_fat_pct != null) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <MetricCard color={METRIC_COLOR.weight_kg}    icon="⚖" label="Weight"   value={selectedLog?.weight_kg ?? null}    unit="kg" />
            <MetricCard color={METRIC_COLOR.body_fat_pct} icon="%" label="Body Fat" value={selectedLog?.body_fat_pct ?? null} unit="%" />
          </div>
        )}

        {hasData && impact ? <ImpactDonut segments={impact.segments} score={score} /> : null}

        <CoachEntryCard headline={mode.desc} thumbnailColor={modeColorLight(mode.color)} thumbnailGlyph={"▲"} meta="Coach · 2 min read" />

        <RecentLiftsCard sessions={recentSessions} />

        <Suspense fallback={null}>{weeklyRollups}</Suspense>
      </div>
    </div>
  );
}
