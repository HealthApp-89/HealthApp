import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { Gauge } from "@/components/ui/Gauge";
import { MetricBar } from "@/components/ui/MetricBar";
import { SparkLine } from "@/components/ui/SparkLine";
import { MorningCheckIn } from "@/components/dashboard/MorningCheckIn";
import { FIELDS, scoreColor, scoreLabel } from "@/lib/ui/colors";
import { calcScore, avg, buildWeekWindow } from "@/lib/ui/score";
import { buildDailyPlan } from "@/lib/coach/readiness";
import type { DailyLog } from "@/lib/data/types";

export const dynamic = "force-dynamic";

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

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={score}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />

      <div className="px-4 pt-3.5 max-w-3xl mx-auto flex flex-col gap-3.5">
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

        {/* TODAY'S STATUS */}
        <div
          className="rounded-2xl p-4 px-4"
          style={{
            background: hasToday
              ? `linear-gradient(135deg, ${sc}12, rgba(79,195,247,0.05))`
              : "rgba(255,255,255,0.02)",
            border: `1px solid ${hasToday ? sc + "22" : "rgba(255,255,255,0.07)"}`,
          }}
        >
          {hasToday ? (
            <div>
              <SectionLabel>TODAY&apos;S STATUS</SectionLabel>
              <div className="flex justify-between items-center flex-wrap gap-3">
                <div>
                  <div className="text-[56px] font-bold font-mono leading-none" style={{ color: sc }}>
                    {score ?? "—"}
                  </div>
                  <div className="text-[11px] text-white/35 mt-1">Readiness · {sl}</div>
                </div>
                <div className="flex gap-3 flex-wrap">
                  {todayLog!.hrv != null && (
                    <Gauge value={todayLog!.hrv} max={100} color="#00f5c4" label="HRV" sub="ms" />
                  )}
                  {todayLog!.resting_hr != null && (
                    <Gauge value={todayLog!.resting_hr} max={90} color="#ff6b6b" label="RHR" sub="bpm" />
                  )}
                  {todayLog!.sleep_score != null && (
                    <Gauge value={todayLog!.sleep_score} max={100} color="#a29bfe" label="Sleep" sub="score" />
                  )}
                  {todayLog!.recovery != null && (
                    <Gauge value={todayLog!.recovery} max={100} color="#6bcb77" label="Recov" sub="%" />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-5">
              <div className="text-[28px] mb-2">📋</div>
              <div className="text-sm text-white/50 mb-1.5">No data today</div>
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
        </div>

        {/* TODAY'S METRICS */}
        {hasToday && (
          <Card>
            <div className="flex flex-col gap-2.5">
              <SectionLabel>TODAY&apos;S METRICS</SectionLabel>
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
        )}

        {/* STEPS · 7 DAYS */}
        {hasSteps && (
          <Card>
            <div className="flex justify-between items-center mb-2.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">🦶 STEPS · 7 DAYS</span>
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
              <StatTile label="7-DAY AVG" value={fmt(avg(wSteps))} color="#00f5c4" />
              <StatTile
                label="GOAL"
                value="8,000"
                color={(wSteps[6] ?? 0) >= 8000 ? "#00f5c4" : "#ffd93d"}
              />
              <StatTile
                label="BEST"
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

        {/* CALORIES · 7 DAYS */}
        {hasCals && (
          <Card>
            <div className="flex justify-between items-center mb-2.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">🍽 CALORIES · 7 DAYS</span>
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
              <StatTile label="7-DAY AVG" value={fmt(avg(wCals))} color="#ffd93d" />
            </div>
          </Card>
        )}

        {/* WEIGHT TREND */}
        {hasWeight && (
          <Card>
            <div className="flex justify-between items-center mb-2.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">⚖ WEIGHT TREND</span>
              <span className="text-lg font-bold font-mono" style={{ color: "#4fc3f7" }}>
                {latestWeightRow ? `${latestWeightRow.weight_kg} kg` : "—"}
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
                label="LOW"
                value={validWts.length ? `${Math.min(...validWts)} kg` : "—"}
                color="#4fc3f7"
              />
              <StatTile
                label="HIGH"
                value={validWts.length ? `${Math.max(...validWts)} kg` : "—"}
                color="#4fc3f7"
              />
              <StatTile
                label="7D CHANGE"
                value={
                  validWts.length > 1
                    ? `${validWts[validWts.length - 1] - validWts[0] > 0 ? "+" : ""}${(
                        validWts[validWts.length - 1] - validWts[0]
                      ).toFixed(1)} kg`
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

function fmt(v: number | null): string {
  if (v === null) return "—";
  return Math.round(v).toLocaleString();
}

function StatTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex-1 rounded-lg px-2.5 py-2" style={{ background: "rgba(0,0,0,0.15)" }}>
      <div className="text-[9px] text-white/30 mb-0.5">{label}</div>
      <div className="text-[15px] font-bold font-mono" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
