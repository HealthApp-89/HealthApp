import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { WeekStrip } from "@/components/layout/WeekStrip";
import { ReadinessHero } from "@/components/dashboard/ReadinessHero";
import { CoachEntryCard } from "@/components/dashboard/CoachEntryCard";
import { RecentLiftsCard, type RecentSession } from "@/components/dashboard/RecentLiftsCard";
import { MetricCard } from "@/components/charts/MetricCard";
import { ImpactDonut } from "@/components/dashboard/ImpactDonut";
import { WeeklyRollups } from "@/components/dashboard/WeeklyRollups";
import { InstallHint } from "@/components/layout/InstallHint";
import { COLOR, METRIC_COLOR, modeColorLight } from "@/lib/ui/theme";
import { calcReadinessScore } from "@/lib/ui/score";
import { computeImpact } from "@/lib/coach/impact";
import { buildDailyPlan, getIntensityMode } from "@/lib/coach/readiness";
import { todayInUserTz, formatHeaderDate } from "@/lib/time";
import type { DailyLog } from "@/lib/data/types";

// 60s ISR — sync routes call revalidatePath() so new WHOOP/Withings/AH data
// invalidates immediately. Auth gating still works (middleware runs first).
export const revalidate = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const sevenDaysBefore = shiftIso(selectedDate, -7);

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
    { data: last7Rows },
    { data: recentWorkoutsRaw },
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
    // Rolling 7-day window for delta computations (excludes selected day itself)
    supabase
      .from("daily_logs")
      .select("date, hrv, resting_hr, sleep_hours, strain")
      .eq("user_id", user.id)
      .gte("date", sevenDaysBefore)
      .lt("date", selectedDate)
      .order("date", { ascending: false }),
    // Recent workouts — last 14 days, up to 5 rows (we only render 2)
    supabase
      .from("workouts")
      .select(
        `id, date, type,
         exercises(name, position,
           exercise_sets(kg, reps, warmup, set_index))`,
      )
      .eq("user_id", user.id)
      .gte("date", shiftIso(selectedDate, -14))
      .lte("date", selectedDate)
      .order("date", { ascending: false })
      .limit(5),
  ]);

  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const selectedLog = (selectedRow ?? null) as DailyLog | null;
  const prevLog = (prevRow ?? null) as DailyLog | null;
  const hasData = !!selectedLog;

  // Resolve the freshest weight available — selected day's log first, otherwise
  // the most recent prior log with a weight reading.
  const effectiveWeightKg =
    selectedLog?.weight_kg ??
    (typeof latestWeightRow?.weight_kg === "number" ? latestWeightRow.weight_kg : null);

  // Mifflin-St Jeor (male) × 1.55 activity factor.
  const calorieTarget =
    effectiveWeightKg !== null &&
    typeof profile?.age === "number" &&
    typeof profile?.height_cm === "number"
      ? (10 * effectiveWeightKg + 6.25 * profile.height_cm - 5 * profile.age + 5) * 1.55
      : null;

  // Donut readiness: selected day's recovery + load metrics, falling back to prev day
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

  // Track which load fields had to fall back to the prior day.
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

  // buildDailyPlan / getIntensityMode for CoachEntryCard
  const feelInput = checkin
    ? {
        readiness: checkin.readiness ?? null,
        energyLabel: checkin.energy_label ?? null,
        mood: checkin.mood ?? null,
        soreness: checkin.soreness ?? null,
        notes: checkin.feel_notes ?? null,
      }
    : null;
  const dailyPlan = buildDailyPlan(selectedLog, feelInput, hrvBaseline);
  const mode = getIntensityMode(dailyPlan.readiness, feelInput);

  // Delta computations: today vs 7-day rolling average
  const last7 = last7Rows ?? [];
  const hrvAvg = rollingAvg(last7.map((r) => r.hrv));
  const rhrAvg = rollingAvg(last7.map((r) => r.resting_hr));
  const sleepAvg = rollingAvg(last7.map((r) => r.sleep_hours));
  const strainAvg = rollingAvg(last7.map((r) => r.strain));

  const hrvDelta = selectedLog?.hrv != null && hrvAvg != null ? selectedLog.hrv - hrvAvg : null;
  const rhrDelta = selectedLog?.resting_hr != null && rhrAvg != null ? selectedLog.resting_hr - rhrAvg : null;
  const sleepDelta = selectedLog?.sleep_hours != null && sleepAvg != null ? selectedLog.sleep_hours - sleepAvg : null;
  const strainDelta = selectedLog?.strain != null && strainAvg != null ? selectedLog.strain - strainAvg : null;

  // Build RecentSession[] from recent workouts (compute volume from sets)
  type RawWorkout = {
    id: string;
    date: string;
    type: string | null;
    exercises: {
      name: string;
      position: number | null;
      exercise_sets: { kg: number | null; reps: number | null; warmup: boolean; set_index: number }[];
    }[] | null;
  };
  const recentSessions: RecentSession[] = (recentWorkoutsRaw as RawWorkout[] | null ?? []).map((w) => {
    let vol = 0;
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (!s.warmup && s.kg && s.reps) vol += s.kg * s.reps;
      }
    }
    const firstName = (w.exercises ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.name;
    const title = w.type
      ? firstName
        ? `${w.type} · ${firstName}`
        : w.type
      : firstName ?? "Workout";
    return {
      date: formatShortDate(w.date),
      title,
      volumeKg: vol,
    };
  });

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      {/* Page header */}
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
          {(profile?.name ?? user.email ?? "A")[0].toUpperCase()}
        </div>
      </div>

      {isToday && <InstallHint />}

      <WeekStrip selected={selectedDate} today={today} />

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
        <ReadinessHero
          score={score ?? null}
          status={mode.label.replace(/^[^\s]+\s/, "")}
          subtitle={mode.desc}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <MetricCard color={METRIC_COLOR.hrv}        icon="♥" label="HRV"        value={selectedLog?.hrv ?? null}        unit="ms"  delta={hrvDelta}   deltaUnit="ms" />
          <MetricCard color={METRIC_COLOR.resting_hr} icon="♥" label="Resting HR" value={selectedLog?.resting_hr ?? null} unit="bpm" delta={rhrDelta}   deltaUnit="bpm" inverted />
          <MetricCard color={METRIC_COLOR.sleep_hours} icon="☾" label="Sleep"     value={selectedLog?.sleep_hours ?? null} unit="h"  delta={sleepDelta} deltaUnit="h" />
          <MetricCard color={METRIC_COLOR.strain}     icon="⚡" label="Strain"    value={selectedLog?.strain ?? null}                delta={strainDelta} />
        </div>

        {(selectedLog?.weight_kg != null || selectedLog?.body_fat_pct != null) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <MetricCard color={METRIC_COLOR.weight_kg}    icon="⚖" label="Weight"   value={selectedLog?.weight_kg ?? null}    unit="kg" />
            <MetricCard color={METRIC_COLOR.body_fat_pct} icon="%" label="Body Fat" value={selectedLog?.body_fat_pct ?? null} unit="%" />
          </div>
        )}

        {hasData && impact ? (
          <ImpactDonut segments={impact.segments} score={score} />
        ) : null}

        <CoachEntryCard
          headline={mode.desc}
          thumbnailColor={modeColorLight(mode.color)}
          thumbnailGlyph={"▲"}
          meta="Coach · 2 min read"
        />

        <RecentLiftsCard sessions={recentSessions} />

        <Suspense fallback={null}>
          <WeeklyRollups
            userId={user.id}
            today={selectedDate}
            todayHrv={selectedLog?.hrv ?? null}
            todayRhr={selectedLog?.resting_hr ?? null}
            hrvBaseline={hrvBaseline}
          />
        </Suspense>
      </div>
    </div>
  );
}
