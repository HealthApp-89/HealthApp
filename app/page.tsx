import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { InstallHint } from "@/components/layout/InstallHint";
import { Card } from "@/components/ui/Card";
import { MetricBar } from "@/components/ui/MetricBar";
import { MorningCheckIn } from "@/components/dashboard/MorningCheckIn";
import { HeroGauge } from "@/components/dashboard/HeroGauge";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { WeeklyRollups } from "@/components/dashboard/WeeklyRollups";
import { SkeletonCard } from "@/components/dashboard/SkeletonCard";
import { FIELDS, scoreColor, scoreLabel } from "@/lib/ui/colors";
import { calcScore, fmtNum } from "@/lib/ui/score";
import { buildDailyPlan } from "@/lib/coach/readiness";
import type { DailyLog } from "@/lib/data/types";

// 60s ISR — sync routes call revalidatePath() so new WHOOP/Withings/AH data
// invalidates immediately. Auth gating still works (middleware runs first).
export const revalidate = 60;

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);

  // Fast queries only — these gate first paint. The 14-day window for the
  // weekly rollups loads inside <Suspense> below so it doesn't block the hero.
  const [{ data: profile }, { data: tokens }, { data: todayRow }, { data: checkin }] =
    await Promise.all([
      supabase.from("profiles").select("name, whoop_baselines").eq("user_id", user.id).maybeSingle(),
      supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
      supabase
        .from("daily_logs")
        .select(
          "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, notes, source, updated_at",
        )
        .eq("user_id", user.id)
        .eq("date", today)
        .maybeSingle(),
      supabase
        .from("checkins")
        .select("readiness, energy_label, mood, soreness, feel_notes")
        .eq("user_id", user.id)
        .eq("date", today)
        .maybeSingle(),
    ]);

  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const todayLog = (todayRow ?? null) as DailyLog | null;
  const score = calcScore(todayLog);
  const sc = scoreColor(score);
  const sl = scoreLabel(score);
  const hasToday = !!todayLog;

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
      <InstallHint />

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
            <div className="rounded-[18px] border border-white/[0.06] bg-white/[0.02] text-center px-4 py-8">
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

        {/* TODAY'S METRICS — renders synchronously from the small today-row query */}
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

        {/* MONITORS + WEEKLY ROLLUPS — heavier 14-day query, streamed in */}
        <Suspense fallback={<SkeletonCard height={420} label="Monitors · last 7 days" />}>
          <WeeklyRollups
            userId={user.id}
            today={today}
            todayHrv={todayLog?.hrv ?? null}
            todayRhr={todayLog?.resting_hr ?? null}
            hrvBaseline={hrvBaseline}
          />
        </Suspense>

        <form action="/api/auth/signout" method="post" className="flex justify-end pt-4">
          <button className="text-[10px] text-white/30 hover:text-white" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
