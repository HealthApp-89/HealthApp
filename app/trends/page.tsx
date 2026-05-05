import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { LineChart } from "@/components/charts/LineChart";
import { BarChart } from "@/components/charts/BarChart";
import { RecoveryBars } from "@/components/charts/RecoveryBars";
import { MetricCard } from "@/components/charts/MetricCard";
import { TrendsNav } from "@/components/trends/TrendsNav";
import { PeriodSelector } from "@/components/trends/PeriodSelector";
import { loadWorkouts, buildPRs } from "@/lib/data/workouts";
import { avg } from "@/lib/ui/score";
import { fieldColor } from "@/lib/ui/tints";
import type { DailyLog } from "@/lib/data/types";
import {
  resolvePeriod,
  pickGranularity,
  aggregateSeries,
  periodLengthDays,
  type PeriodPreset,
} from "@/lib/ui/period";

export const revalidate = 60;

const HRV_BASELINE = 33;
const RHR_BASELINE = 58;

export default async function TrendsPage(props: {
  searchParams: Promise<{
    section?: string;
    period?: string;
    start?: string;
    end?: string;
  }>;
}) {
  const sp = await props.searchParams;
  const section = ["body", "sleep", "training", "strength", "compare"].includes(sp.section ?? "")
    ? (sp.section as string)
    : "body";

  // Default period = today; "all" if user wants the full backfilled history.
  const { from, to, preset } = resolvePeriod(sp.period as PeriodPreset, sp.start, sp.end);
  const days = periodLengthDays(from, to);
  const granularity = pickGranularity(days);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: tokens }, { data: logsRaw }, workouts] = await Promise.all([
    supabase.from("profiles").select("name").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select(
        "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, respiratory_rate, notes, source, updated_at",
      )
      .eq("user_id", user.id)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true }),
    loadWorkouts(user.id),
  ]);

  const sorted = (logsRaw ?? []) as DailyLog[];

  // Aggregate each metric to the picked granularity (day/week/month).
  const aggHRV = aggregateSeries(sorted, (l) => l.hrv, granularity);
  const aggRHR = aggregateSeries(sorted, (l) => l.resting_hr, granularity);
  const aggRecov = aggregateSeries(sorted, (l) => l.recovery, granularity);
  const aggSleepH = aggregateSeries(sorted, (l) => l.sleep_hours, granularity);
  const aggSleepSc = aggregateSeries(sorted, (l) => l.sleep_score, granularity);
  const aggDeep = aggregateSeries(sorted, (l) => l.deep_sleep_hours, granularity);
  const aggREM = aggregateSeries(sorted, (l) => l.rem_sleep_hours, granularity);
  const aggSteps = aggregateSeries(sorted, (l) => l.steps, granularity);
  const aggCals = aggregateSeries(sorted, (l) => l.calories, granularity);
  const aggStrain = aggregateSeries(sorted, (l) => l.strain, granularity);
  const aggWeight = aggregateSeries(sorted, (l) => l.weight_kg, granularity);

  const lastVal = (s: { value: number | null }[]) => {
    for (let i = s.length - 1; i >= 0; i--) if (s[i].value !== null) return s[i].value;
    return null;
  };
  const avgVal = (s: { value: number | null }[]) => {
    let sum = 0, n = 0;
    for (const p of s) if (p.value !== null && Number.isFinite(p.value)) { sum += p.value; n++; }
    return n > 0 ? sum / n : null;
  };
  // Headline numbers: use the period AVERAGE for biometrics + cumulative metrics so
  // they actually change as the user picks different periods. Weight stays as
  // "latest" because trend matters more than mean for body weight.
  const avgHRV = avgVal(aggHRV);
  const avgRHR = avgVal(aggRHR);
  const avgSleepH = avgVal(aggSleepH);
  const avgSleepSc = avgVal(aggSleepSc);
  const avgSteps = avgVal(aggSteps);
  const avgCalsEaten = avgVal(aggCals);
  const avgStrainVal = avgVal(aggStrain);
  const lastWeight = lastVal(aggWeight);
  const firstWeight = aggWeight.find((p) => p.value !== null)?.value ?? null;

  // Build the dates arrays once per granularity — passed to BarChart for axis + tooltip.
  const datesHRV = aggHRV.map((p) => p.date);
  const datesRHR = aggRHR.map((p) => p.date);
  const datesRecov = aggRecov.map((p) => p.date);
  const datesSleepH = aggSleepH.map((p) => p.date);
  const datesSleepSc = aggSleepSc.map((p) => p.date);
  const datesDeep = aggDeep.map((p) => p.date);
  const datesREM = aggREM.map((p) => p.date);
  const datesSteps = aggSteps.map((p) => p.date);
  const datesCals = aggCals.map((p) => p.date);
  const datesStrain = aggStrain.map((p) => p.date);
  const datesWeight = aggWeight.map((p) => p.date);

  // Filter workouts to the same window for the strength panel.
  const filteredWorkouts = workouts.filter((w) => w.date >= from && w.date <= to);

  // Compare: split the window in half (W1 = first half, W2 = second half).
  const mid = Math.floor(sorted.length / 2);
  const w1 = sorted.slice(0, mid);
  const w2 = sorted.slice(mid);

  const prs = buildPRs(filteredWorkouts);
  const granularityLabel = granularity === "day" ? "daily" : granularity === "week" ? "weekly avg" : "monthly avg";

  const preserve = { section, period: preset, start: from, end: to };

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />

      <div className="px-4 pt-3.5 max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <TrendsNav active={section} preserve={{ period: preset, start: from, end: to }} />
          <PeriodSelector preset={preset} from={from} to={to} preserve={{ section }} />
        </div>

        <div className="text-[10px] uppercase tracking-[0.1em] text-white/30 mb-3 font-mono">
          {from} → {to} · {days} day{days === 1 ? "" : "s"} · {granularityLabel}
          {sorted.length === 0 && <span className="text-white/40 ml-2">· no data in range</span>}
        </div>

        {section === "body" && (
          <div>
            <MetricCard
              title="Body Weight"
              current={lastWeight !== null ? lastWeight.toFixed(1) : null}
              unit="kg"
              delta={
                firstWeight !== null && lastWeight !== null
                  ? Math.round((lastWeight - firstWeight) * 10) / 10
                  : null
              }
              deltaLabel="since start"
              positiveIsGood={false}
              color={fieldColor("weight_kg")!}
            >
              {aggWeight.filter((p) => p.value !== null).length >= 2 && (
                <BarChart
                  data={aggWeight.map((p) => p.value)}
                  dates={datesWeight}
                  color={fieldColor("weight_kg")!}
                  height={60}
                  unit="kg"
                />
              )}
            </MetricCard>

            <MetricCard
              title="Heart Rate Variability"
              current={avgHRV !== null ? Math.round(avgHRV) : null}
              unit="ms avg"
              delta={avgHRV !== null ? Math.round((avgHRV - HRV_BASELINE) * 10) / 10 : null}
              deltaLabel={`vs ${HRV_BASELINE}ms baseline`}
              color={fieldColor("hrv")!}
              note="Baseline 33ms (6mo). Peak 45ms (Oct 2025). Goal: rebuild toward 40ms+."
            >
              <LineChart
                // @ts-expect-error redesign-slice-4
                data={aggHRV.map((p) => p.value)}
                dates={datesHRV}
                color={fieldColor("hrv")!}
                height={64}
                refLine={HRV_BASELINE}
                refLabel={`${HRV_BASELINE}ms avg`}
                unit="ms"
              />
            </MetricCard>

            <MetricCard
              title="Resting Heart Rate"
              current={avgRHR !== null ? Math.round(avgRHR) : null}
              unit="bpm avg"
              delta={avgRHR !== null ? Math.round((avgRHR - RHR_BASELINE) * 10) / 10 : null}
              deltaLabel={`vs ${RHR_BASELINE}bpm baseline`}
              positiveIsGood={false}
              color={fieldColor("resting_hr")!}
            >
              <LineChart
                // @ts-expect-error redesign-slice-4
                data={aggRHR.map((p) => p.value)}
                dates={datesRHR}
                color={fieldColor("resting_hr")!}
                height={64}
                refLine={RHR_BASELINE}
                refLabel={`${RHR_BASELINE}bpm avg`}
                unit="bpm"
              />
            </MetricCard>

            <Card tint="recovery">
              <SectionLabel>Recovery % — {granularityLabel}</SectionLabel>
              <RecoveryBars
                data={aggRecov.map((p) => (p.value !== null ? Math.round(p.value) : null))}
                dates={datesRecov}
              />
              <div className="flex gap-3 mt-2.5">
                {(["🟢 Green ≥67%", "🟡 Yellow 34-66%", "🔴 Red <34%"]).map((l) => (
                  <span key={l} className="text-[10px] text-white/40">
                    {l}
                  </span>
                ))}
              </div>
            </Card>
          </div>
        )}

        {section === "sleep" && (
          <div>
            <MetricCard
              title="Sleep Hours"
              current={avgSleepH !== null ? avgSleepH.toFixed(1) : null}
              unit="hrs avg"
              color={fieldColor("sleep_hours")!}
              note="Target 7.5–9 hrs. Dashed line = 7.5h."
            >
              <BarChart
                data={aggSleepH.map((p) => p.value)}
                dates={datesSleepH}
                color={fieldColor("sleep_hours")!}
                height={60}
                goalLine={7.5}
                unit="hrs"
              />
            </MetricCard>

            <MetricCard
              title="Sleep Score"
              current={avgSleepSc !== null ? Math.round(avgSleepSc) : null}
              unit="/100 avg"
              color={fieldColor("sleep_score")!}
            >
              <LineChart
                // @ts-expect-error redesign-slice-4
                data={aggSleepSc.map((p) => p.value)}
                dates={datesSleepSc}
                color={fieldColor("sleep_score")!}
                height={56}
                refLine={85}
                refLabel="85 optimal"
                unit="/100"
              />
            </MetricCard>

            <Card tint="sleep">
              <SectionLabel>DEEP + REM (hrs)</SectionLabel>
              <div className="flex flex-col gap-2 mt-1">
                <div>
                  <div className="text-[10px] text-white/40 mb-1">Deep</div>
                  <BarChart
                    data={aggDeep.map((p) => p.value)}
                    dates={datesDeep}
                    color={fieldColor("deep_sleep_hours")!}
                    height={36}
                    unit="hrs"
                  />
                </div>
                <div>
                  <div className="text-[10px] text-white/40 mb-1">REM</div>
                  <BarChart
                    data={aggREM.map((p) => p.value)}
                    dates={datesREM}
                    color={fieldColor("rem_sleep_hours")!}
                    height={36}
                    unit="hrs"
                  />
                </div>
              </div>
            </Card>
          </div>
        )}

        {section === "training" && (
          <div>
            <MetricCard
              title="Steps"
              current={avgSteps !== null ? Math.round(avgSteps).toLocaleString() : null}
              unit={granularity === "day" ? "/day avg" : `/${granularity} avg`}
              color={fieldColor("steps")!}
            >
              <BarChart
                data={aggSteps.map((p) => p.value)}
                dates={datesSteps}
                color={fieldColor("steps")!}
                height={60}
                goalLine={granularity === "day" ? 8000 : undefined}
                unit="steps"
              />
            </MetricCard>

            <MetricCard
              title="Calories Eaten"
              current={avgCalsEaten !== null ? Math.round(avgCalsEaten).toLocaleString() : null}
              unit="kcal/day avg"
              color={fieldColor("calories")!}
            >
              <BarChart
                data={aggCals.map((p) => p.value)}
                dates={datesCals}
                color={fieldColor("calories")!}
                height={60}
                unit="kcal"
              />
            </MetricCard>

            <MetricCard
              title="Strain"
              current={avgStrainVal !== null ? avgStrainVal.toFixed(1) : null}
              unit="/21 avg"
              color={fieldColor("strain")!}
            >
              <BarChart
                data={aggStrain.map((p) => p.value)}
                dates={datesStrain}
                color={fieldColor("strain")!}
                height={60}
                goalLine={granularity === "day" ? 14 : undefined}
                unit="/21"
              />
            </MetricCard>
          </div>
        )}

        {section === "strength" && (
          <div>
            <Card tint="nutrition">
              <SectionLabel>🏆 PRs in window · est. 1RM</SectionLabel>
              {prs.length === 0 && (
                <p className="text-xs text-white/30 py-3 text-center">
                  No workouts in this period.
                </p>
              )}
              {prs.slice(0, 12).map((pr) => (
                <div
                  key={pr.name}
                  className="flex justify-between items-center py-2 border-t border-white/[0.04] first:border-t-0"
                >
                  <div>
                    <div className="text-xs text-white/75">{pr.name.split("(")[0].trim()}</div>
                    <div className="text-[10px] text-white/30 mt-px">
                      {pr.kg}kg × {pr.reps} · {pr.date}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[20px] font-bold font-mono" style={{ color: "#ffd60a" }}>
                      {pr.est1rm}
                    </div>
                    <div className="text-[9px] text-white/25">kg 1RM</div>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {section === "compare" && (
          <div>
            <Card>
              <SectionLabel>FIRST HALF vs SECOND HALF · 7-day window split</SectionLabel>
              <CompareRow
                label="HRV"
                w1={avg(w1.map((l) => l.hrv))}
                w2={avg(w2.map((l) => l.hrv))}
                unit="ms"
                positiveIsGood
              />
              <CompareRow
                label="RHR"
                w1={avg(w1.map((l) => l.resting_hr))}
                w2={avg(w2.map((l) => l.resting_hr))}
                unit="bpm"
                positiveIsGood={false}
              />
              <CompareRow
                label="Sleep"
                w1={avg(w1.map((l) => l.sleep_hours))}
                w2={avg(w2.map((l) => l.sleep_hours))}
                unit="hrs"
                positiveIsGood
                fixed={1}
              />
              <CompareRow
                label="Recovery"
                w1={avg(w1.map((l) => l.recovery))}
                w2={avg(w2.map((l) => l.recovery))}
                unit="%"
                positiveIsGood
              />
              <CompareRow
                label="Steps"
                w1={avg(w1.map((l) => l.steps))}
                w2={avg(w2.map((l) => l.steps))}
                unit=""
                positiveIsGood
              />
              <CompareRow
                label="Calories"
                w1={avg(w1.map((l) => l.calories))}
                w2={avg(w2.map((l) => l.calories))}
                unit="kcal"
                positiveIsGood
              />
            </Card>
            <p className="text-[10px] text-white/30 mt-2">
              Splits the selected period in half and averages each metric.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function CompareRow({
  label,
  w1,
  w2,
  unit,
  positiveIsGood,
  fixed = 0,
}: {
  label: string;
  w1: number | null;
  w2: number | null;
  unit: string;
  positiveIsGood: boolean;
  fixed?: number;
}) {
  const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(fixed));
  const diff = w1 !== null && w2 !== null ? w2 - w1 : null;
  const dc =
    diff === null || diff === 0
      ? "rgba(255,255,255,0.3)"
      : positiveIsGood
        ? diff > 0
          ? "#30d158"
          : "#ff453a"
        : diff < 0
          ? "#30d158"
          : "#ff453a";
  const arrow = diff === null || diff === 0 ? "→" : diff > 0 ? "↑" : "↓";
  return (
    <div className="flex justify-between items-center py-2 border-t border-white/[0.04] first:border-t-0">
      <span className="text-[10px] uppercase tracking-[0.08em] text-white/40 w-20">{label}</span>
      <div className="flex gap-3 font-mono text-sm">
        <span className="text-white/60 w-16 text-right">
          {fmt(w1)}
          <span className="text-[10px] text-white/30 ml-0.5">{unit}</span>
        </span>
        <span className="text-white/85 w-16 text-right">
          {fmt(w2)}
          <span className="text-[10px] text-white/30 ml-0.5">{unit}</span>
        </span>
        <span className="w-16 text-right" style={{ color: dc }}>
          {arrow}{" "}
          {diff === null
            ? "—"
            : Math.abs(diff).toFixed(fixed === 0 && Math.abs(diff) >= 100 ? 0 : fixed)}
        </span>
      </div>
    </div>
  );
}
