import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { InstallHint } from "@/components/layout/InstallHint";
import { Card } from "@/components/ui/Card";
import { MetricBar } from "@/components/ui/MetricBar";
import { MorningCheckIn } from "@/components/dashboard/MorningCheckIn";
import { ImpactDonut } from "@/components/dashboard/ImpactDonut";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { WeeklyRollups } from "@/components/dashboard/WeeklyRollups";
import { SkeletonCard } from "@/components/dashboard/SkeletonCard";
import { FIELDS } from "@/lib/ui/colors";
import { calcScore } from "@/lib/ui/score";
import { buildDailyPlan } from "@/lib/coach/readiness";
import { computeImpact } from "@/lib/coach/impact";
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
  const [
    { data: profile },
    { data: tokens },
    { data: todayRow },
    { data: checkin },
    { data: latestWeightRow },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, age, height_cm, whoop_baselines")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select(
        "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, notes, source, updated_at",
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
    supabase
      .from("daily_logs")
      .select("weight_kg, date")
      .eq("user_id", user.id)
      .lte("date", today)
      .not("weight_kg", "is", null)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const todayLog = (todayRow ?? null) as DailyLog | null;
  const score = calcScore(todayLog);
  const hasToday = !!todayLog;

  // Resolve the freshest weight available — today's log first, otherwise the
  // most recent prior log with a weight reading. Used as the protein-target
  // denominator and as the BMR weight input.
  const effectiveWeightKg =
    todayLog?.weight_kg ??
    (typeof latestWeightRow?.weight_kg === "number" ? latestWeightRow.weight_kg : null);

  // Mifflin-St Jeor (male) × 1.55 activity factor. Returns null if any input is
  // missing — the calorie segment falls back to "target unknown" in that case.
  // TODO: read sex from profile once a column exists; hardcoded male for now.
  const calorieTarget =
    effectiveWeightKg !== null &&
    typeof profile?.age === "number" &&
    typeof profile?.height_cm === "number"
      ? (10 * effectiveWeightKg + 6.25 * profile.height_cm - 5 * profile.age + 5) * 1.55
      : null;

  const impact = hasToday
    ? computeImpact(todayLog, hrvBaseline, effectiveWeightKg, calorieTarget)
    : null;

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

        {/* HERO — impact donut: per-metric +/- contribution to today's readiness */}
        <DashboardSection
          label="Today"
          trailing={
            hasToday && impact ? (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono text-[10px]"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "rgba(255,255,255,0.6)",
                }}
              >
                <span style={{ color: "#6bcb77" }}>+{impact.positiveCount}</span>
                <span className="text-white/25">·</span>
                <span style={{ color: "#ff6b6b" }}>−{impact.negativeCount}</span>
              </span>
            ) : null
          }
        >
          {hasToday && impact ? (
            <div
              className="rounded-[18px] border border-white/[0.06] px-4 py-5 flex justify-center"
              style={{
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.025), rgba(255,255,255,0.005))",
              }}
            >
              <ImpactDonut segments={impact.segments} score={score} />
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
