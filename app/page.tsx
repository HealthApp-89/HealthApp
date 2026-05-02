import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { MetricBar } from "@/components/ui/MetricBar";
import { SparkLine } from "@/components/ui/SparkLine";
import { MorningCheckIn } from "@/components/dashboard/MorningCheckIn";
import { HeroGauge } from "@/components/dashboard/HeroGauge";
import { MonitorTile } from "@/components/dashboard/MonitorTile";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { FIELDS, scoreColor, scoreLabel } from "@/lib/ui/colors";
import { calcScore, avg, buildWeekWindow, fmtNum } from "@/lib/ui/score";
import { buildDailyPlan } from "@/lib/coach/readiness";
import type { DailyLog } from "@/lib/data/types";

export const dynamic = "force-dynamic";

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

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);

  const [{ data: profile }, { data: tokens }, { data: logsRaw }, { data: checkin }] = await Promise.all([
    supabase.from("profiles").select("name, whoop_baselines").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select(
        "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, notes, source, updated_at",
      )
      .eq("user_id", user.id)
      .order("date", { ascending: false })
      .limit(30),
    supabase
      .from("checkins")
      .select("readiness, energy_label, mood, soreness, feel_notes")
      .eq("user_id", user.id)
      .eq("date", new Date().toISOString().slice(0, 10))
      .maybeSingle(),
  ]);
  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const logs: DailyLog[] = (logsRaw ?? []) as DailyLog[];
  const todayLog = logs.find((l) => l.date === today) ?? null;
  const score = calcScore(todayLog);
  const sc = scoreColor(score);
  const sl = scoreLabel(score);

  const week = buildWeekWindow(logs, today);
  const wSteps = week.rows.map((r) => r?.steps ?? null);
  const wCals = week.rows.map((r) => r?.calories ?? null);
  const wWgt = week.rows.map((r) => r?.weight_kg ?? null);
  const latestWeightRow = logs.find((l) => l.weight_kg !== null);
  const validWts = wWgt.filter((v): v is number => typeof v === "number");

  const hasToday = !!todayLog;
  const hasSteps = wSteps.some((v) => v !== null);
  const hasCals = wCals.some((v) => v !== null);
  const hasWeight = validWts.length > 0;

  const feelInput = checkin
    ? {
        readiness: checkin.readiness,
        energyLabel: checkin.energy_label,
        mood: checkin.mood,
        soreness: checkin.soreness,
        notes: checkin.feel_notes,
      }
    : null;
  const dailyPlan = buildDailyPlan(todayLog, feelInput, hrvBaseline);

  const hrvAvg7 = avg(week.rows.map((r) => r?.hrv ?? null));
  const rhrAvg7 = avg(week.rows.map((r) => r?.resting_hr ?? null));

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={score}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />

      <div className="px-4 pt-3.5 max-w-3xl mx-auto flex flex-col gap-5">
        <MorningCheckIn
          date={today}
          plan={dailyPlan}
          initial={
            checkin
              ? {
                  readiness: checkin.readiness,
                  energy_label: checkin.energy_label,
                  mood: checkin.mood,
                  soreness: checkin.soreness,
                  feel_notes: checkin.feel_notes,
                }
              : null
          }
        />

        {/* HERO — 3 big rings */}
        <DashboardSection
          label="Today"
          trailing={
            score !== null ? (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono"
                style={{
                  background: `${sc}1a`,
                  border: `1px solid ${sc}40`,
                  color: sc,
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: sc, boxShadow: `0 0 6px ${sc}` }}
                />
                {fmtNum(score)} · {sl}
              </span>
            ) : null
          }
        >
          {hasToday ? (
            <div
              className="rounded-[18px] border border-white/[0.06] px-4 py-5"
              style={{
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.025), rgba(255,255,255,0.005))",
              }}
            >
              <div className="grid grid-cols-3 gap-2 sm:gap-4">
                <HeroGauge
                  value={todayLog!.sleep_score}
                  max={100}
                  label="Sleep"
                  unit="score"
                  color="#a29bfe"
                  caption={
                    todayLog!.sleep_hours != null ? `${fmtNum(todayLog!.sleep_hours)} h` : null
                  }
                />
                <HeroGauge
                  value={todayLog!.recovery}
                  max={100}
                  label="Recovery"
                  unit="%"
                  color="#6bcb77"
                  caption={todayLog!.hrv != null ? `HRV ${fmtNum(todayLog!.hrv)} ms` : null}
                />
                <HeroGauge
                  value={todayLog!.strain}
                  max={21}
                  label="Strain"
                  unit="/21"
                  color="#ff9f43"
                  caption={
                    todayLog!.calories != null
                      ? `${todayLog!.calories.toLocaleString()} kcal`
                      : null
                  }
                />
              </div>
            </div>
          ) : (
            <div
              className="rounded-[18px] border border-white/[0.06] bg-white/[0.02] text-center px-4 py-8"
            >
              <div className="text-sm text-white/55 mb-1">No data today</div>
              <div className="text-xs text-white/30 mb-3.5">
                Sync WHOOP or fill the daily log
              </div>
              <Link
                href="/log"
                className="inline-block rounded-[10px] px-[18px] py-2 text-xs font-semibold"
                style={{
                  background: "rgba(0,245,196,0.15)",
                  border: "1px solid #00f5c455",
                  color: "#00f5c4",
                }}
              >
                Log Today →
              </Link>
            </div>
          )}
        </DashboardSection>

        {/* MONITORS */}
        {hasToday && (todayLog!.hrv != null || todayLog!.resting_hr != null) && (
          <DashboardSection label="Monitors">
            <div className="grid grid-cols-2 gap-2.5">
              <MonitorTile
                label="HRV"
                value={todayLog!.hrv}
                unit="ms"
                status={hrvStatus(todayLog!.hrv, hrvBaseline)}
                detail={
                  hrvAvg7 != null
                    ? `7d avg ${fmtNum(hrvAvg7)} · base ${fmtNum(hrvBaseline)}`
                    : `Baseline ${fmtNum(hrvBaseline)} ms`
                }
                accent="#00f5c4"
              />
              <MonitorTile
                label="Resting HR"
                value={todayLog!.resting_hr}
                unit="bpm"
                status={rhrStatus(todayLog!.resting_hr)}
                detail={rhrAvg7 != null ? `7d avg ${fmtNum(rhrAvg7)} bpm` : null}
                accent="#ff6b6b"
              />
            </div>
          </DashboardSection>
        )}

        {/* TODAY'S METRICS */}
        {hasToday && (
          <DashboardSection label="Today's metrics">
            <Card>
              <div className="flex flex-col gap-2.5">
                {FIELDS.filter((f) => todayLog![f.k] != null).map((f) => (
                  <MetricBar
                    key={f.k}
                    label={f.l}
                    value={todayLog![f.k]}
                    unit={f.u}
                    max={f.m}
                    color={f.c}
                  />
                ))}
              </div>
            </Card>
          </DashboardSection>
        )}

        {/* WEEKLY ROLLUPS */}
        {(hasSteps || hasCals || hasWeight) && (
          <DashboardSection label="Last 7 days">
            <div className="flex flex-col gap-3">
              {hasSteps && (
                <Card>
                  <div className="flex justify-between items-center mb-2.5">
                    <SectionLabel>Steps</SectionLabel>
                    <span className="text-lg font-bold font-mono" style={{ color: "#00f5c4" }}>
                      {wSteps[6] != null ? wSteps[6]!.toLocaleString() : "—"}
                    </span>
                  </div>
                  <SparkLine values={wSteps} color="#00f5c4" height={40} chartId="stp7" />
                  <div className="flex justify-between mt-1.5">
                    {week.labels.map((d, i) => (
                      <span
                        key={i}
                        className="text-[8px] uppercase"
                        style={{ color: d === "Today" ? "#00f5c4" : "rgba(255,255,255,0.2)" }}
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <StatTile label="7-day avg" value={fmtInt(avg(wSteps))} color="#00f5c4" />
                    <StatTile
                      label="Goal"
                      value="8,000"
                      color={(wSteps[6] ?? 0) >= 8000 ? "#00f5c4" : "#ffd93d"}
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
                      color="#00f5c4"
                    />
                  </div>
                </Card>
              )}

              {hasCals && (
                <Card>
                  <div className="flex justify-between items-center mb-2.5">
                    <SectionLabel>Calories</SectionLabel>
                    <span className="text-lg font-bold font-mono" style={{ color: "#ffd93d" }}>
                      {wCals[6] != null ? wCals[6]!.toLocaleString() : "—"}
                      <span className="text-[10px] text-white/30 font-normal ml-1">kcal</span>
                    </span>
                  </div>
                  <SparkLine values={wCals} color="#ffd93d" height={40} chartId="cal7" />
                  <div className="flex justify-between mt-1.5 mb-2.5">
                    {week.labels.map((d, i) => (
                      <span
                        key={i}
                        className="text-[8px] uppercase"
                        style={{ color: d === "Today" ? "#ffd93d" : "rgba(255,255,255,0.2)" }}
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <StatTile label="7-day avg" value={fmtInt(avg(wCals))} color="#ffd93d" />
                  </div>
                </Card>
              )}

              {hasWeight && (
                <Card>
                  <div className="flex justify-between items-center mb-2.5">
                    <SectionLabel>Weight trend</SectionLabel>
                    <span className="text-lg font-bold font-mono" style={{ color: "#4fc3f7" }}>
                      {latestWeightRow?.weight_kg != null
                        ? `${fmtNum(latestWeightRow.weight_kg)} kg`
                        : "—"}
                    </span>
                  </div>
                  {validWts.length > 1 && (
                    <>
                      <SparkLine values={wWgt} color="#4fc3f7" height={40} chartId="wgt7" />
                      <div className="flex justify-between mt-1.5 mb-2.5">
                        {week.labels.map((d, i) => (
                          <span
                            key={i}
                            className="text-[8px] uppercase"
                            style={{ color: d === "Today" ? "#4fc3f7" : "rgba(255,255,255,0.2)" }}
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
                      color="#4fc3f7"
                    />
                    <StatTile
                      label="High"
                      value={validWts.length ? `${fmtNum(Math.max(...validWts))} kg` : "—"}
                      color="#4fc3f7"
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
                            ? "#6bcb77"
                            : validWts[validWts.length - 1] - validWts[0] > 0
                            ? "#ff6b6b"
                            : "#888"
                          : "#888"
                      }
                    />
                  </div>
                </Card>
              )}
            </div>
          </DashboardSection>
        )}

        {!hasToday && !hasSteps && !hasCals && !hasWeight && (
          <Card>
            <p className="text-sm text-white/40 text-center py-4">
              No data yet. Connect WHOOP from the chip in the header, or click <em>Sync now</em> if
              already connected.
            </p>
          </Card>
        )}

        <form action="/api/auth/signout" method="post" className="flex justify-end pt-4">
          <button className="text-[10px] text-white/30 hover:text-white" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

function fmtInt(v: number | null): string {
  if (v === null) return "—";
  return Math.round(v).toLocaleString();
}

function StatTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex-1 rounded-lg px-2.5 py-2" style={{ background: "rgba(0,0,0,0.15)" }}>
      <div className="text-[9px] uppercase tracking-[0.08em] text-white/30 mb-0.5">{label}</div>
      <div className="text-[15px] font-bold font-mono" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
