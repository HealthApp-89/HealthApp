import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MetricCard, type MetricDatum } from "@/components/charts/MetricCard";
import { MonitorTile } from "@/components/dashboard/MonitorTile";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { avg, buildWeekWindow, fmtNum } from "@/lib/ui/score";
import { METRIC_COLOR } from "@/lib/ui/theme";
import type { DailyLog } from "@/lib/data/types";

type Status = "ok" | "watch" | "alert" | "muted";

function hrvStatus(v: number | null, baseline: number): Status {
  if (v === null) return "muted";
  if (v >= baseline * 0.95) return "ok";
  if (v >= baseline * 0.8) return "watch";
  return "alert";
}

function rhrStatus(v: number | null): Status {
  if (v === null) return "muted";
  if (v <= 60) return "ok";
  if (v <= 70) return "watch";
  return "alert";
}

function fmtInt(v: number | null): string {
  if (v === null) return "—";
  return Math.round(v).toLocaleString();
}

type Props = {
  userId: string;
  today: string;
  todayHrv: number | null;
  todayRhr: number | null;
  hrvBaseline: number;
};

/** Renders the Monitors row + the Last-7-days rollup cards. Lives in a
 *  separate Suspense boundary so the heavier daily_logs window query
 *  doesn't block first paint of the hero / today's metrics above it. */
export async function WeeklyRollups({ userId, today, todayHrv, todayRhr, hrvBaseline }: Props) {
  const supabase = await createSupabaseServerClient();
  const { data: logsRaw } = await supabase
    .from("daily_logs")
    .select(
      "user_id, date, hrv, resting_hr, steps, calories_eaten, weight_kg, source, updated_at",
    )
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .limit(28);

  const logs: DailyLog[] = (logsRaw ?? []) as DailyLog[];
  const week = buildWeekWindow(logs, today);
  const wSteps = week.rows.map((r) => r?.steps ?? null);
  // The "Calories" card represents nutrition intake (from Yazio), NOT energy
  // burned. The `calories` column is total energy expenditure from Apple
  // Health and lives elsewhere; `calories_eaten` is what the user logged via
  // Yazio→HealthKit and what this card semantically tracks.
  const wCals = week.rows.map((r) => r?.calories_eaten ?? null);

  // Weight uses a 28-day rolling window (not the 7-day buildWeekWindow shared
  // by Steps/Calories). Withings sync is sparse — a 7-day chart often shows a
  // single point. 4 weeks gives the trend a real shape.
  const weightDates28: string[] = [];
  const todayDt = new Date(today + "T00:00:00Z");
  for (let i = 27; i >= 0; i--) {
    const d = new Date(todayDt);
    d.setUTCDate(d.getUTCDate() - i);
    weightDates28.push(d.toISOString().slice(0, 10));
  }
  const byDate = new Map(logs.map((l) => [l.date, l] as const));
  const wWgt28 = weightDates28.map((d) => byDate.get(d)?.weight_kg ?? null);
  const latestWeightRow = logs.find((l) => l.weight_kg !== null);
  const validWts = wWgt28.filter((v): v is number => typeof v === "number");
  const hasSteps = wSteps.some((v) => v !== null);
  const hasCals = wCals.some((v) => v !== null);
  const hasWeight = validWts.length > 0;
  const hrvAvg7 = avg(week.rows.map((r) => r?.hrv ?? null));
  const rhrAvg7 = avg(week.rows.map((r) => r?.resting_hr ?? null));

  const showMonitors = todayHrv != null || todayRhr != null;

  return (
    <>
      {/* MONITORS — current value with 7-day context */}
      {showMonitors && (
        <DashboardSection label="Monitors">
          <div className="grid grid-cols-2 gap-2.5">
            <MonitorTile
              label="HRV"
              value={todayHrv}
              unit="ms"
              status={hrvStatus(todayHrv, hrvBaseline)}
              detail={
                hrvAvg7 != null
                  ? `7d avg ${fmtNum(hrvAvg7)} · base ${fmtNum(hrvBaseline)}`
                  : `Baseline ${fmtNum(hrvBaseline)} ms`
              }
              accent={METRIC_COLOR.hrv}
            />
            <MonitorTile
              label="Resting HR"
              value={todayRhr}
              unit="bpm"
              status={rhrStatus(todayRhr)}
              detail={rhrAvg7 != null ? `7d avg ${fmtNum(rhrAvg7)} bpm` : null}
              accent={METRIC_COLOR.resting_hr}
            />
          </div>
        </DashboardSection>
      )}

      {/* WEEKLY ROLLUPS */}
      {(hasSteps || hasCals || hasWeight) && (
        <DashboardSection label="Last 7 days">
          <div className="flex flex-col gap-3">
            {hasSteps && (() => {
              const data: MetricDatum[] = week.dates.map((d, i) => ({ date: d, value: wSteps[i] }));
              const stepsAvg = avg(wSteps);
              const stepsBest = wSteps
                .filter((v): v is number => typeof v === "number")
                .reduce((m, v) => Math.max(m, v), -Infinity);
              const subtitle = [
                stepsAvg != null ? `7-day avg ${fmtInt(stepsAvg)}` : null,
                Number.isFinite(stepsBest) ? `best ${stepsBest.toLocaleString()}` : null,
              ].filter(Boolean).join(" · ") || undefined;
              return (
                <MetricCard
                  title="Steps"
                  value={wSteps[6] ?? null}
                  subtitle={subtitle}
                  data={data}
                  color={METRIC_COLOR.steps}
                  type="bar"
                />
              );
            })()}

            {hasCals && (() => {
              const data: MetricDatum[] = week.dates.map((d, i) => ({ date: d, value: wCals[i] }));
              const calsAvg = avg(wCals);
              return (
                <MetricCard
                  title="Calories"
                  value={wCals[6] ?? null}
                  unit="kcal"
                  subtitle={calsAvg != null ? `7-day avg ${fmtInt(calsAvg)}` : undefined}
                  data={data}
                  color={METRIC_COLOR.calories}
                  type="bar"
                />
              );
            })()}

            {hasWeight && (() => {
              const data: MetricDatum[] = weightDates28.map((d, i) => ({ date: d, value: wWgt28[i] }));
              const change =
                validWts.length > 1
                  ? validWts[validWts.length - 1] - validWts[0]
                  : null;
              const subtitle = [
                validWts.length
                  ? `${fmtNum(Math.min(...validWts))}–${fmtNum(Math.max(...validWts))} kg`
                  : null,
                change != null
                  ? `${change > 0 ? "+" : change < 0 ? "−" : ""}${fmtNum(Math.abs(change))} kg over 28d`
                  : null,
              ].filter(Boolean).join(" · ") || undefined;
              return (
                <MetricCard
                  title="Weight trend"
                  value={latestWeightRow?.weight_kg ?? null}
                  unit="kg"
                  subtitle={subtitle}
                  data={data}
                  color={METRIC_COLOR.weight_kg}
                  type="area"
                />
              );
            })()}
          </div>
        </DashboardSection>
      )}
    </>
  );
}
