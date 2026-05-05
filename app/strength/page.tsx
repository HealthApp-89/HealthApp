import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { SessionRow } from "@/components/strength/SessionRow";
import { ExerciseTrendCard } from "@/components/strength/ExerciseTrendCard";
import { PRList } from "@/components/strength/PRList";
import { VolumeTrendCard } from "@/components/strength/VolumeTrendCard";
import { SessionTable } from "@/components/strength/SessionTable";
import { StrengthNav } from "@/components/strength/StrengthNav";
import { DateNavigator } from "@/components/strength/DateNavigator";
import { loadWorkouts, buildPRs, buildExerciseTrend } from "@/lib/data/workouts";
import { CoachCards } from "@/components/strength/CoachCards";
import { RefreshButton } from "@/components/coach/RefreshButton";
import { todayInUserTz } from "@/lib/time";
import { TodayPlanCard } from "@/components/strength/TodayPlanCard";
import { buildDailyPlan } from "@/lib/coach/readiness";
import type { DailyLog } from "@/lib/data/types";

export const revalidate = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function StrengthPage(props: {
  searchParams: Promise<{ ex?: string; view?: string; date?: string }>;
}) {
  const { ex: selectedExercise, view, date: rawDate } = await props.searchParams;
  const activeView: "today" | "recent" | "date" =
    view === "today" ? "today" : view === "date" ? "date" : "recent";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const todayIso = todayInUserTz();
  const [
    { data: profile },
    { data: tokens },
    workouts,
    { data: cached },
    { data: todayLog },
    { data: todayCheckin },
  ] = await Promise.all([
    supabase.from("profiles").select("name, whoop_baselines").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    loadWorkouts(user.id),
    supabase
      .from("ai_insights")
      .select("payload, generated_for_date")
      .eq("user_id", user.id)
      .eq("kind", "strength")
      .order("generated_for_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("hrv, sleep_score, recovery")
      .eq("user_id", user.id)
      .eq("date", todayIso)
      .maybeSingle(),
    supabase
      .from("checkins")
      .select("readiness, energy_label, mood, soreness, feel_notes")
      .eq("user_id", user.id)
      .eq("date", todayIso)
      .maybeSingle(),
  ]);
  const strengthCoach = (cached?.payload ?? null) as Parameters<typeof CoachCards>[0]["payload"] | null;

  const prs = buildPRs(workouts);
  const trend = selectedExercise ? buildExerciseTrend(workouts, selectedExercise) : [];
  const latestWorkout = workouts[0]?.date ?? todayIso;
  const earliestWorkout = workouts[workouts.length - 1]?.date ?? todayIso;
  const selectedDate =
    rawDate && ISO_DATE.test(rawDate) && rawDate <= todayIso ? rawDate : latestWorkout;
  const sessionsOnDate = workouts.filter((w) => w.date === selectedDate);

  const hrvBaseline = (profile?.whoop_baselines as { hrv?: number } | null)?.hrv;
  const feel = todayCheckin
    ? {
        readiness: todayCheckin.readiness,
        energyLabel: todayCheckin.energy_label,
        mood: todayCheckin.mood,
        soreness: todayCheckin.soreness,
        notes: todayCheckin.feel_notes,
      }
    : null;
  const dailyPlan = buildDailyPlan(
    (todayLog as Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null) ?? null,
    feel,
    hrvBaseline,
  );

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />

      <div className="px-4 pt-3.5 max-w-3xl mx-auto flex flex-col gap-3.5">
        <StrengthNav active={activeView} />

        {activeView === "today" ? (
          <TodayPlanCard plan={dailyPlan} />
        ) : !workouts.length ? (
          <Card>
            <div className="text-center py-12">
              <div className="text-3xl mb-3">💪</div>
              <div className="text-sm text-white/40 mb-2">No workouts logged yet</div>
              <div className="text-xs text-white/25 leading-relaxed">
                Manual entry coming in Stage 4. Strong-app screenshot ingest planned.
              </div>
            </div>
          </Card>
        ) : activeView === "date" ? (
          <>
            <DateNavigator date={selectedDate} min={earliestWorkout} max={todayIso} />

            {sessionsOnDate.length === 0 ? (
              <Card>
                <div className="text-center py-10">
                  <div className="text-sm text-white/45">No workouts logged on {selectedDate}</div>
                  <div className="text-[11px] text-white/25 mt-1">
                    Pick another date — your earliest is {earliestWorkout}.
                  </div>
                </div>
              </Card>
            ) : (
              sessionsOnDate.map((s) => <SessionTable key={s.id} session={s} />)
            )}
          </>
        ) : (
          <>
            <Card tint="strain">
              <SectionLabel>RECENT SESSIONS · tap exercise to see trend</SectionLabel>
              {workouts.slice(0, 5).map((w, i, arr) => (
                <SessionRow
                  key={w.id}
                  session={w}
                  selectedExercise={selectedExercise}
                  isLast={i === arr.length - 1}
                />
              ))}
            </Card>

            {selectedExercise && <ExerciseTrendCard name={selectedExercise} points={trend} />}

            <PRList prs={prs} />

            <VolumeTrendCard workouts={workouts} />

            <div className="flex justify-end">
              <RefreshButton
                endpoint="/api/insights/strength"
                label={strengthCoach ? "Refresh strength coach" : "Run strength coach"}
              />
            </div>

            {strengthCoach && <CoachCards payload={strengthCoach} />}
          </>
        )}
      </div>
    </main>
  );
}
