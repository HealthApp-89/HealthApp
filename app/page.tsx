import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { InstallHint } from "@/components/layout/InstallHint";
import { Card } from "@/components/ui/Card";
import { MetricBar } from "@/components/ui/MetricBar";
import { ImpactDonut } from "@/components/dashboard/ImpactDonut";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { DashboardDatePager } from "@/components/dashboard/DashboardDatePager";
import { WeeklyRollups } from "@/components/dashboard/WeeklyRollups";
import { SkeletonCard } from "@/components/dashboard/SkeletonCard";
import { FIELDS } from "@/lib/ui/colors";
import { calcReadinessScore } from "@/lib/ui/score";
import { computeImpact } from "@/lib/coach/impact";
import type { DailyLog } from "@/lib/data/types";
import { todayInUserTz } from "@/lib/time";

// 60s ISR — sync routes call revalidatePath() so new WHOOP/Withings/AH data
// invalidates immediately. Auth gating still works (middleware runs first).
export const revalidate = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function dateLabel(selected: string, today: string): string {
  if (selected === today) return "Today";
  if (selected === shiftIso(today, -1)) return "Yesterday";
  return new Date(selected + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export default async function Home(props: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = todayInUserTz();
  const sp = await props.searchParams;
  // Validate the date query param: ISO YYYY-MM-DD and not in the future. Anything
  // bogus falls back to today, so a hand-edited URL can't break the page.
  const selectedDate =
    sp.date && ISO_DATE.test(sp.date) && sp.date <= today ? sp.date : today;
  const selectedYesterday = shiftIso(selectedDate, -1);
  const isToday = selectedDate === today;

  const DAILY_LOG_COLS =
    "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, notes, source, updated_at";

  // Fast queries only — these gate first paint. The 14-day window for the
  // weekly rollups loads inside <Suspense> below so it doesn't block the hero.
  const [
    { data: profile },
    { data: tokens },
    { data: selectedRow },
    { data: prevRow },
    { data: checkin },
    { data: latestWeightRow },
    { data: earliestRow },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, age, height_cm, whoop_baselines")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select(DAILY_LOG_COLS)
      .eq("user_id", user.id)
      .eq("date", selectedDate)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select(DAILY_LOG_COLS)
      .eq("user_id", user.id)
      .eq("date", selectedYesterday)
      .maybeSingle(),
    supabase
      .from("checkins")
      .select("readiness, energy_label, mood, soreness, feel_notes")
      .eq("user_id", user.id)
      .eq("date", selectedDate)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("weight_kg, date")
      .eq("user_id", user.id)
      .lte("date", selectedDate)
      .not("weight_kg", "is", null)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Earliest log date — caps the date pager's prev button.
    supabase
      .from("daily_logs")
      .select("date")
      .eq("user_id", user.id)
      .order("date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const selectedLog = (selectedRow ?? null) as DailyLog | null;
  const prevLog = (prevRow ?? null) as DailyLog | null;
  const hasData = !!selectedLog;
  const minDate = (earliestRow?.date as string | undefined) ?? null;

  // Resolve the freshest weight available — selected day's log first, otherwise
  // the most recent prior log with a weight reading. Used as the protein-target
  // denominator and as the BMR weight input.
  const effectiveWeightKg =
    selectedLog?.weight_kg ??
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

  // Donut readiness reflects: selected day's recovery (HRV / RHR / sleep / deep
  // sleep / morning check-in) PLUS load metrics (steps, strain, calories,
  // protein, carbs). For load: prefer the selected day's value when present —
  // a workout already logged today should count toward today's strain. Fall
  // back to the prior day only when the selected day has no value yet (e.g.
  // 9am, no movement logged), so the donut still reflects how you feel rather
  // than a blank.
  const scoreLog: DailyLog | null = selectedLog
    ? {
        ...selectedLog,
        steps: selectedLog.steps ?? prevLog?.steps ?? null,
        strain: selectedLog.strain ?? prevLog?.strain ?? null,
        calories_eaten: selectedLog.calories_eaten ?? prevLog?.calories_eaten ?? null,
        protein_g: selectedLog.protein_g ?? prevLog?.protein_g ?? null,
        carbs_g: selectedLog.carbs_g ?? prevLog?.carbs_g ?? null,
      }
    : null;

  // Track which load fields had to fall back to the prior day. Used to drive
  // the "yest. —" prefix in the donut chip reason line so the source of each
  // value is honest.
  const fellBackToPrior = new Set<string>();
  if (selectedLog) {
    if (selectedLog.steps == null && prevLog?.steps != null) fellBackToPrior.add("steps");
    if (selectedLog.strain == null && prevLog?.strain != null) fellBackToPrior.add("strain");
    if (selectedLog.calories_eaten == null && prevLog?.calories_eaten != null)
      fellBackToPrior.add("calories");
    if (selectedLog.protein_g == null && prevLog?.protein_g != null)
      fellBackToPrior.add("protein");
    if (selectedLog.carbs_g == null && prevLog?.carbs_g != null) fellBackToPrior.add("carbs");
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
  // Prefix only the segments whose value actually fell back to the prior day,
  // so a strength session logged today shows as today's strain (no "yest." tag)
  // but a still-blank steps count for the morning falls back and is labeled.
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

  const sectionLabel = dateLabel(selectedDate, today);

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={score}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />
      {isToday && <InstallHint />}

      <div className="px-4 pt-3.5 max-w-3xl mx-auto flex flex-col gap-5">
        <DashboardDatePager
          selectedDate={selectedDate}
          today={today}
          minDate={minDate}
        />

        {/* HERO — impact donut: per-metric +/- contribution to selected day's readiness */}
        <DashboardSection
          label={sectionLabel}
          trailing={
            hasData && impact ? (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono text-[10px]"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "rgba(255,255,255,0.6)",
                }}
              >
                <span style={{ color: "#30d158" }}>+{impact.positiveCount}</span>
                <span className="text-white/25">·</span>
                <span style={{ color: "#ff453a" }}>−{impact.negativeCount}</span>
              </span>
            ) : null
          }
        >
          {hasData && impact ? (
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
              <div className="text-sm text-white/55 mb-1">
                No data {isToday ? "today" : `for ${sectionLabel.toLowerCase()}`}
              </div>
              <div className="text-xs text-white/30 mb-3.5">
                {isToday
                  ? "Sync WHOOP or fill the daily log"
                  : "Nothing was logged on this day"}
              </div>
              <Link
                href={isToday ? "/log" : `/log?date=${selectedDate}`}
                className="inline-block rounded-[10px] px-[18px] py-2 text-xs font-semibold"
                style={{
                  background: "rgba(10,132,255,0.15)",
                  border: "1px solid #0a84ff55",
                  color: "#0a84ff",
                }}
              >
                Log {isToday ? "Today" : sectionLabel} →
              </Link>
            </div>
          )}
        </DashboardSection>

        {/* SELECTED DAY'S METRICS — renders synchronously from the small day-row query */}
        {hasData && (
          <DashboardSection label={`${sectionLabel}'s metrics`}>
            <Card>
              <div className="flex flex-col gap-2.5">
                {FIELDS.filter((f) => selectedLog![f.k] != null).map((f) => (
                  <MetricBar
                    key={f.k}
                    label={f.l}
                    value={selectedLog![f.k]}
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
            today={selectedDate}
            todayHrv={selectedLog?.hrv ?? null}
            todayRhr={selectedLog?.resting_hr ?? null}
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
