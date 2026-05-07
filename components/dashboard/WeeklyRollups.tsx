import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, SectionLabel } from "@/components/ui/Card";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { MonitorTile } from "@/components/dashboard/MonitorTile";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { avg, buildWeekWindow, fmtNum } from "@/lib/ui/score";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
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
    .limit(14);

  const logs: DailyLog[] = (logsRaw ?? []) as DailyLog[];
  const week = buildWeekWindow(logs, today);
  const wSteps = week.rows.map((r) => r?.steps ?? null);
  // The "Calories" card represents nutrition intake (from Yazio), NOT energy
  // burned. The `calories` column is total energy expenditure from Apple
  // Health and lives elsewhere; `calories_eaten` is what the user logged via
  // Yazio→HealthKit and what this card semantically tracks.
  const wCals = week.rows.map((r) => r?.calories_eaten ?? null);
  const wWgt = week.rows.map((r) => r?.weight_kg ?? null);
  const latestWeightRow = logs.find((l) => l.weight_kg !== null);
  const validWts = wWgt.filter((v): v is number => typeof v === "number");
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
            {hasSteps && (
              <Card tint="steps">
                <div className="flex justify-between items-center mb-2.5">
                  <SectionLabel>Steps</SectionLabel>
                  <span className="text-lg font-bold font-mono" style={{ color: METRIC_COLOR.steps }}>
                    {wSteps[6] != null ? wSteps[6]!.toLocaleString() : "—"}
                  </span>
                </div>
                <LineChart
                  data={wSteps.map((y) => ({ y }))}
                  color={METRIC_COLOR.steps}
                  variant="mini"
                  height={40}
                />
                <div className="flex justify-between mt-1.5">
                  {week.labels.map((d, i) => (
                    <span
                      key={i}
                      className="text-[8px] uppercase"
                      style={{ color: d === "Today" ? METRIC_COLOR.steps : COLOR.textFaint }}
                    >
                      {d}
                    </span>
                  ))}
                </div>
                <div className="mt-2.5 flex gap-2">
                  <StatTile label="7-day avg" value={fmtInt(avg(wSteps))} color={METRIC_COLOR.steps} />
                  <StatTile
                    label="Goal"
                    value="8,000"
                    color={(wSteps[6] ?? 0) >= 8000 ? METRIC_COLOR.steps : METRIC_COLOR.calories}
                  />
                  <StatTile
                    label="Best"
                    value={
                      wSteps.filter((v): v is number => typeof v === "number").length
                        ? Math.max(
                            ...wSteps.filter((v): v is number => typeof v === "number"),
                          ).toLocaleString()
                        : "—"
                    }
                    color={METRIC_COLOR.steps}
                  />
                </div>
              </Card>
            )}

            {hasCals && (
              <Card tint="nutrition">
                <div className="flex justify-between items-center mb-2.5">
                  <SectionLabel>Calories</SectionLabel>
                  <span className="text-lg font-bold font-mono" style={{ color: METRIC_COLOR.calories }}>
                    {wCals[6] != null ? wCals[6]!.toLocaleString() : "—"}
                    <span className="text-[10px] font-normal ml-1" style={{ color: COLOR.textFaint }}>kcal</span>
                  </span>
                </div>
                <LineChart
                  data={wCals.map((y) => ({ y }))}
                  color={METRIC_COLOR.calories}
                  variant="mini"
                  height={40}
                />
                <div className="flex justify-between mt-1.5 mb-2.5">
                  {week.labels.map((d, i) => (
                    <span
                      key={i}
                      className="text-[8px] uppercase"
                      style={{ color: d === "Today" ? METRIC_COLOR.calories : COLOR.textFaint }}
                    >
                      {d}
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <StatTile label="7-day avg" value={fmtInt(avg(wCals))} color={METRIC_COLOR.calories} />
                </div>
              </Card>
            )}

            {hasWeight && (
              <Card tint="weight">
                <div className="flex justify-between items-center mb-2.5">
                  <SectionLabel>Weight trend</SectionLabel>
                  <span className="text-lg font-bold font-mono" style={{ color: METRIC_COLOR.weight_kg }}>
                    {latestWeightRow?.weight_kg != null
                      ? `${fmtNum(latestWeightRow.weight_kg)} kg`
                      : "—"}
                  </span>
                </div>
                {validWts.length > 1 && (
                  <>
                    <LineChart
                      data={wWgt.map((y, i) => ({ x: week.dates[i], y }))}
                      color={METRIC_COLOR.weight_kg}
                      variant="mini"
                      height={40}
                      metricKey="weight_kg"
                    />
                    <div className="flex justify-between mt-1.5 mb-2.5">
                      {week.labels.map((d, i) => (
                        <span
                          key={i}
                          className="text-[8px] uppercase"
                          style={{ color: d === "Today" ? METRIC_COLOR.weight_kg : COLOR.textFaint }}
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                <div className="flex gap-2">
                  <StatTile
                    label="Low"
                    value={validWts.length ? `${fmtNum(Math.min(...validWts))} kg` : "—"}
                    color={METRIC_COLOR.weight_kg}
                  />
                  <StatTile
                    label="High"
                    value={validWts.length ? `${fmtNum(Math.max(...validWts))} kg` : "—"}
                    color={METRIC_COLOR.weight_kg}
                  />
                  <StatTile
                    label="7d change"
                    value={
                      validWts.length > 1
                        ? `${validWts[validWts.length - 1] - validWts[0] > 0 ? "+" : ""}${fmtNum(
                            validWts[validWts.length - 1] - validWts[0],
                          )} kg`
                        : "—"
                    }
                    color={
                      validWts.length > 1
                        ? validWts[validWts.length - 1] - validWts[0] < 0
                          ? COLOR.success
                          : validWts[validWts.length - 1] - validWts[0] > 0
                          ? COLOR.danger
                          : COLOR.textMuted
                        : COLOR.textMuted
                    }
                  />
                </div>
              </Card>
            )}
          </div>
        </DashboardSection>
      )}
    </>
  );
}

function StatTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex-1 rounded-lg px-2.5 py-2" style={{ background: COLOR.surfaceAlt }}>
      <div className="text-[9px] uppercase tracking-[0.08em] mb-0.5" style={{ color: COLOR.textFaint }}>{label}</div>
      <div className="text-[15px] font-bold font-mono" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
