import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { LineChart } from "@/components/charts/LineChart";
import { BarChart } from "@/components/charts/BarChart";
import { RecoveryBars } from "@/components/charts/RecoveryBars";
import { MetricCard } from "@/components/charts/MetricCard";
import { TrendsNav } from "@/components/trends/TrendsNav";
import { loadWorkouts, buildPRs } from "@/lib/data/workouts";
import { avg } from "@/lib/ui/score";
import type { DailyLog } from "@/lib/data/types";

export const dynamic = "force-dynamic";

const HRV_BASELINE = 33;
const RHR_BASELINE = 58;

export default async function TrendsPage(props: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section: rawSection } = await props.searchParams;
  const section = ["body", "sleep", "training", "strength", "compare"].includes(rawSection ?? "")
    ? (rawSection as string)
    : "body";

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
      .order("date", { ascending: true }),
    loadWorkouts(user.id),
  ]);

  const sorted = (logsRaw ?? []) as DailyLog[];

  const allHRV = sorted.map((l) => l.hrv);
  const allRHR = sorted.map((l) => l.resting_hr);
  const allSleep = sorted.map((l) => l.sleep_hours);
  const allSleepSc = sorted.map((l) => l.sleep_score);
  const allDeep = sorted.map((l) => l.deep_sleep_hours);
  const allREM = sorted.map((l) => l.rem_sleep_hours);
  const allSteps = sorted.map((l) => l.steps);
  const allCals = sorted.map((l) => l.calories);
  const allRecovery = sorted.map((l) => l.recovery);

  const weightPoints = sorted.filter((l) => l.weight_kg !== null) as (DailyLog & { weight_kg: number })[];
  const lastWeight = weightPoints[weightPoints.length - 1]?.weight_kg ?? null;
  const firstWeight = weightPoints[0]?.weight_kg ?? null;
  const lastHRV = lastVal(allHRV);
  const lastRHR = lastVal(allRHR);
  const lastSleep = lastVal(allSleep);

  // Two-week split for compare: last 7 days = w2, prior 7 = w1
  const w2 = sorted.slice(-7);
  const w1 = sorted.slice(-14, -7);

  const prs = buildPRs(workouts);

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />

      <div className="px-4 pt-3.5 max-w-3xl mx-auto">
        <TrendsNav active={section} />

        {section === "body" && (
          <div>
            <MetricCard
              title="Body Weight"
              current={lastWeight}
              unit="kg"
              delta={
                firstWeight !== null && lastWeight !== null
                  ? Math.round((lastWeight - firstWeight) * 10) / 10
                  : null
              }
              deltaLabel="since start"
              positiveIsGood={false}
              color="#fbbf24"
            >
              {weightPoints.length >= 2 && (
                <BarChart
                  data={sorted.map((l) => l.weight_kg)}
                  color="#fbbf24"
                  height={60}
                />
              )}
            </MetricCard>

            <MetricCard
              title="Heart Rate Variability"
              current={lastHRV}
              unit="ms"
              delta={lastHRV !== null ? Math.round((lastHRV - HRV_BASELINE) * 10) / 10 : null}
              deltaLabel={`vs ${HRV_BASELINE}ms avg`}
              color="#00f5c4"
              note="Baseline 33ms (6mo). Peak 45ms (Oct 2025). Goal: rebuild toward 40ms+."
            >
              <LineChart data={allHRV} color="#00f5c4" height={64} refLine={HRV_BASELINE} refLabel={`${HRV_BASELINE}ms avg`} />
            </MetricCard>

            <MetricCard
              title="Resting Heart Rate"
              current={lastRHR}
              unit="bpm"
              delta={lastRHR !== null ? Math.round((lastRHR - RHR_BASELINE) * 10) / 10 : null}
              deltaLabel={`vs ${RHR_BASELINE}bpm avg`}
              positiveIsGood={false}
              color="#f87171"
            >
              <LineChart data={allRHR} color="#f87171" height={64} refLine={RHR_BASELINE} refLabel={`${RHR_BASELINE}bpm avg`} />
            </MetricCard>

            <Card>
              <SectionLabel>Recovery % — All Days</SectionLabel>
              <RecoveryBars data={allRecovery} />
              <div className="flex gap-3 mt-2.5">
                {(["🟢 Green ≥67%", "🟡 Yellow 34-66%", "🔴 Red <34%"]).map((l) => (
                  <span key={l} className="text-[10px] text-white/40">{l}</span>
                ))}
              </div>
            </Card>
          </div>
        )}

        {section === "sleep" && (
          <div>
            <MetricCard
              title="Sleep Hours"
              current={lastSleep?.toFixed(1) ?? null}
              unit="hrs"
              color="#a29bfe"
              note="Target 7.5–9 hrs. Dashed line = 7.5h."
            >
              <BarChart data={allSleep} color="#a29bfe" height={60} goalLine={7.5} />
            </MetricCard>

            <MetricCard title="Sleep Score" current={lastVal(allSleepSc)} unit="/100" color="#a29bfe">
              <LineChart data={allSleepSc} color="#a29bfe" height={56} refLine={85} refLabel="85 optimal" />
            </MetricCard>

            <Card>
              <SectionLabel>DEEP + REM (hrs)</SectionLabel>
              <div className="flex flex-col gap-2 mt-1">
                <div>
                  <div className="text-[10px] text-white/40 mb-1">Deep</div>
                  <BarChart data={allDeep} color="#4fc3f7" height={36} />
                </div>
                <div>
                  <div className="text-[10px] text-white/40 mb-1">REM</div>
                  <BarChart data={allREM} color="#7c6af7" height={36} />
                </div>
              </div>
            </Card>
          </div>
        )}

        {section === "training" && (
          <div>
            <MetricCard
              title="Steps"
              current={lastVal(allSteps)?.toLocaleString() ?? null}
              unit="/day"
              color="#00f5c4"
            >
              <BarChart data={allSteps} color="#00f5c4" height={60} goalLine={8000} />
            </MetricCard>

            <MetricCard
              title="Calories Eaten"
              current={lastVal(allCals)?.toLocaleString() ?? null}
              unit="kcal"
              color="#ffd93d"
            >
              <BarChart data={allCals} color="#ffd93d" height={60} />
            </MetricCard>

            <MetricCard
              title="Strain"
              current={lastVal(sorted.map((l) => l.strain)) ?? null}
              unit="/21"
              color="#ff9f43"
            >
              <BarChart data={sorted.map((l) => l.strain)} color="#ff9f43" height={60} goalLine={14} />
            </MetricCard>
          </div>
        )}

        {section === "strength" && (
          <div>
            <Card>
              <SectionLabel>🏆 PRs by est. 1RM</SectionLabel>
              {prs.length === 0 && (
                <p className="text-xs text-white/30 py-3 text-center">No workouts logged yet.</p>
              )}
              {prs.slice(0, 12).map((pr) => (
                <div key={pr.name} className="flex justify-between items-center py-2 border-t border-white/[0.04] first:border-t-0">
                  <div>
                    <div className="text-xs text-white/75">{pr.name.split("(")[0].trim()}</div>
                    <div className="text-[10px] text-white/30 mt-px">
                      {pr.kg}kg × {pr.reps} · {pr.date}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[20px] font-bold font-mono" style={{ color: "#ffd93d" }}>
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
              <SectionLabel>WEEK 1 vs WEEK 2 · 7-DAY AVG</SectionLabel>
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
          </div>
        )}
      </div>
    </main>
  );
}

function lastVal(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined) return arr[i] as number;
  }
  return null;
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
          ? "#4ade80"
          : "#f87171"
        : diff < 0
          ? "#4ade80"
          : "#f87171";
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
