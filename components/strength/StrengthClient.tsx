"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR } from "@/lib/ui/theme";
import { Card, SectionLabel } from "@/components/ui/Card";
import { SessionRow } from "@/components/strength/SessionRow";
import { ExerciseTrendCard } from "@/components/strength/ExerciseTrendCard";
import { PRList } from "@/components/strength/PRList";
import { VolumeTrendCard } from "@/components/strength/VolumeTrendCard";
import { SessionTable } from "@/components/strength/SessionTable";
import { StrengthNav } from "@/components/strength/StrengthNav";
import { DateNavigator } from "@/components/strength/DateNavigator";
import { CoachCards } from "@/components/strength/CoachCards";
import { RefreshButton } from "@/components/coach/RefreshButton";
import { TodayPlanCard } from "@/components/strength/TodayPlanCard";
import { buildPRs, buildExerciseTrend } from "@/lib/data/workouts";
import { buildDailyPlan } from "@/lib/coach/readiness";
import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
import { useStrengthInsights } from "@/lib/query/hooks/useStrengthInsights";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { weekdayInUserTz } from "@/lib/time";
import { queryKeys } from "@/lib/query/keys";
import type { DailyLog, Weekday } from "@/lib/data/types";

type View = "today" | "recent" | "date";

function subtitleByView(v: View): string {
  if (v === "today") return "Today's plan";
  if (v === "date") return "Pick a date";
  return "Last 30 days";
}

export function StrengthClient({
  userId,
  todayIso,
  currentWeekStart,
  initialView,
  initialDate,
  selectedExercise,
}: {
  userId: string;
  todayIso: string;
  currentWeekStart: string;
  initialView: View;
  /** Initial date for date-view mode. If null, falls back to latest workout. */
  initialDate: string | null;
  /** Exercise drilldown — still URL-driven via SessionRow. */
  selectedExercise: string | undefined;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  // View + date are pure client state — toggling them does not trigger a
  // server round-trip. Exercise drilldown stays URL-driven (SessionRow uses
  // <Link>) because the user-flow includes back-button + share-link.
  const [activeView, setActiveView] = useState<View>(initialView);
  const [pickedDate, setPickedDate] = useState<string | null>(initialDate);

  // All hydrated from the prefetched cache.
  const { data: profile } = useProfile(userId);
  const { data: workouts = [] } = useFullWorkouts(userId);
  const { data: cached } = useStrengthInsights(userId);
  const { data: todayLogRange = [] } = useDailyLogs(userId, todayIso, todayIso);
  const { data: todayCheckin = null } = useCheckin(userId, todayIso);

  const todayLog = (todayLogRange[0] ?? null) as Pick<
    DailyLog,
    "hrv" | "sleep_score" | "recovery"
  > | null;
  const strengthCoach = (cached?.payload ?? null) as
    | Parameters<typeof CoachCards>[0]["payload"]
    | null;

  const prs = buildPRs(workouts);
  const trend = selectedExercise ? buildExerciseTrend(workouts, selectedExercise) : [];
  const latestWorkout = workouts[0]?.date ?? todayIso;
  const earliestWorkout = workouts[workouts.length - 1]?.date ?? todayIso;
  const selectedDate = pickedDate ?? latestWorkout;
  const sessionsOnDate = workouts.filter((w) => w.date === selectedDate);

  const hrvBaseline = (profile?.whoop_baselines as { hrv?: number } | null)?.hrv;
  const feel = todayCheckin
    ? {
        readiness: todayCheckin.readiness,
        energyLabel: todayCheckin.energy_label,
        mood: todayCheckin.mood,
        soreness: todayCheckin.soreness,
        notes: todayCheckin.feel_notes,
        sick: todayCheckin.sick ?? false,
        fatigue: todayCheckin.fatigue ?? null,
        sorenessAreas: todayCheckin.soreness_areas ?? null,
        sorenessSeverity: todayCheckin.soreness_severity ?? null,
      }
    : null;

  const { data: committedWeek = null } = useTrainingWeek(userId, currentWeekStart);

  // Map en-US weekday names ("Monday" etc) to our Weekday keys ("Mon" | "Tue" | ...)
  const WEEKDAY_MAP: Record<string, Weekday> = {
    Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
    Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
  };
  const todayWeekdayKey = WEEKDAY_MAP[weekdayInUserTz()];
  const committedSessionType = committedWeek?.session_plan?.[todayWeekdayKey] ?? null;
  const committedRirTarget   = committedWeek?.rir_target ?? null;
  const committedPhase       = committedWeek?.research_phase ?? null;

  // Pick the first key in committed intensity_modifier that has a value;
  // for v1 each block has a single primary_lift so there's at most one entry.
  const firstIntensityValue =
    committedWeek?.intensity_modifier
      ? Object.values(committedWeek.intensity_modifier)[0] ?? null
      : null;
  const dailyPlan = buildDailyPlan(todayLog, feel, hrvBaseline, {
    sessionType: committedSessionType,
    intensityMultiplier: firstIntensityValue,
  });

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px 12px 14px",
        }}
      >
        <div>
          <div
            style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}
          >
            {subtitleByView(activeView)}
          </div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginTop: "2px",
            }}
          >
            Strength
          </h1>
        </div>
      </div>

      <div style={{ padding: "0 8px 14px" }}>
        <StrengthNav active={activeView} onChange={setActiveView} />
      </div>

      <div
        style={{
          padding: "0 8px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        {activeView === "today" ? (
          <TodayPlanCard
            plan={dailyPlan}
            committedFromPlan={committedSessionType !== null}
            rirTarget={committedRirTarget}
            researchPhase={committedPhase}
          />
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
            <DateNavigator
              date={selectedDate}
              min={earliestWorkout}
              max={todayIso}
              onChange={setPickedDate}
            />

            {sessionsOnDate.length === 0 ? (
              <Card>
                <div className="text-center py-10">
                  <div className="text-sm text-white/45">
                    No workouts logged on {selectedDate}
                  </div>
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

            {selectedExercise && (
              <ExerciseTrendCard name={selectedExercise} points={trend} />
            )}

            <PRList prs={prs} />

            <VolumeTrendCard workouts={workouts} />

            <div className="flex justify-end">
              <RefreshButton
                endpoint="/api/insights/strength"
                label={strengthCoach ? "Refresh strength coach" : "Run strength coach"}
                onSuccess={() => {
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.insights.strength(userId),
                  });
                  // Also nudge the server tree in case other server-rendered
                  // bits depend on the new insight (none currently, but cheap
                  // insurance).
                  router.refresh();
                }}
              />
            </div>

            {strengthCoach && <CoachCards payload={strengthCoach} />}
          </>
        )}
      </div>
    </div>
  );
}
