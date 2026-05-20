"use client";

import { useState } from "react";
import ChatPanel from "@/components/chat/ChatPanel";
import { useMarkThreadSeen } from "@/lib/chat/use-mark-thread-seen";
import { TodayPlanCard } from "@/components/strength/TodayPlanCard";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useRecentE1RMs } from "@/lib/query/hooks/useRecentE1RMs";
import { useBlockProgress, isActiveBlock } from "@/lib/query/hooks/useBlockProgress";
import { buildDailyPlan } from "@/lib/coach/readiness";
import { getEffectiveSessionPlan } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { weekdayInUserTz, todayInUserTz } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { DailyLog, ExerciseOverrides, Weekday } from "@/lib/data/types";

// Map en-US full weekday names to our Weekday keys.
const WEEKDAY_MAP: Record<string, Weekday> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
  Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};

// e1RM lift labels in the strip.
const E1RM_LABELS: Array<{ key: "squat" | "bench" | "deadlift" | "ohp"; label: string }> = [
  { key: "squat", label: "Squat" },
  { key: "bench", label: "Bench" },
  { key: "deadlift", label: "Deadlift" },
  { key: "ohp", label: "OHP" },
];

type Props = { userId: string };

export function StrengthCoachClient({ userId }: Props) {
  useMarkThreadSeen("carter");
  const [swapOpen, setSwapOpen] = useState(false);

  const todayIso = todayInUserTz();
  const currentWeekStart = currentWeekMonday();
  const fullWeekday = weekdayInUserTz();
  const todayWeekdayKey = WEEKDAY_MAP[fullWeekday] as Weekday;

  // ── Data hooks ────────────────────────────────────────────────────────────

  const { data: profile } = useProfile(userId);
  const { data: todayLogRange = [] } = useDailyLogs(userId, todayIso, todayIso);
  const { data: todayCheckin = null } = useCheckin(userId, todayIso);
  const { data: committedWeek = null } = useTrainingWeek(userId, currentWeekStart);
  const { data: e1rms } = useRecentE1RMs(userId, todayIso);
  const { data: blockProgress } = useBlockProgress(userId);

  // ── DailyPlan assembly (mirrored from StrengthClient) ─────────────────────

  const todayLog = (todayLogRange[0] ?? null) as Pick<
    DailyLog,
    "hrv" | "sleep_score" | "recovery"
  > | null;

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

  const committedSessionType = readSessionForDay(committedWeek?.session_plan ?? null, todayWeekdayKey) ?? null;
  const committedRirTarget = committedWeek?.rir_target ?? null;
  const committedPhase = committedWeek?.research_phase ?? null;

  const firstIntensityValue =
    committedWeek?.intensity_modifier
      ? Object.values(committedWeek.intensity_modifier)[0] ?? null
      : null;

  const exerciseOverrides =
    (committedWeek?.exercise_overrides as ExerciseOverrides | null | undefined) ?? null;

  const effectivePlan = committedSessionType
    ? getEffectiveSessionPlan(committedSessionType, fullWeekday, exerciseOverrides)
    : null;

  const dailyPlan = buildDailyPlan(todayLog, feel, hrvBaseline, {
    sessionType: committedSessionType,
    intensityMultiplier: firstIntensityValue,
    ...(effectivePlan && effectivePlan.length > 0
      ? { effectiveExercises: effectivePlan }
      : {}),
  });

  // ── Block / mesocycle info ────────────────────────────────────────────────

  const hasActiveBlock = isActiveBlock(blockProgress);
  const blockData = hasActiveBlock && blockProgress && "block" in blockProgress
    ? blockProgress
    : null;

  const currentWeekNum = blockData?.current_week ?? null;
  const totalWeeks = blockData?.total_weeks ?? null;
  const sessionsDone = blockData?.sessions_done ?? null;
  const sessionsPlanned = blockData?.sessions_planned_to_date ?? null;

  // ── e1RM strip — only show lifts with a recorded e1RM ────────────────────

  const e1rmEntries = e1rms
    ? E1RM_LABELS.filter((l) => e1rms[l.key] !== null)
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 88px)" }}>
      {/* ── Data block ── */}
      <div style={{ flex: "0 0 auto", padding: "8px 16px" }}>
        {/* Today's session card */}
        <TodayPlanCard
          plan={dailyPlan}
          committedFromPlan={committedSessionType !== null}
          rirTarget={committedRirTarget}
          researchPhase={committedPhase}
          weekStart={currentWeekStart}
          weekday={fullWeekday}
          userId={userId}
          weekOverrides={(committedWeek?.exercise_overrides as ExerciseOverrides | null | undefined) ?? null}
        />

        {/* Mesocycle week badge + adherence row */}
        {(currentWeekNum !== null || (sessionsDone !== null && sessionsPlanned !== null)) && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 10,
              padding: "8px 12px",
              background: COLOR.surface,
              borderRadius: 12,
              border: `1px solid ${COLOR.divider}`,
            }}
          >
            {currentWeekNum !== null && totalWeeks !== null ? (
              <div>
                <div style={{ fontSize: 10, color: COLOR.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Mesocycle
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>
                  Week {currentWeekNum} of {totalWeeks}
                </div>
              </div>
            ) : (
              <div />
            )}
            {sessionsDone !== null && sessionsPlanned !== null && sessionsPlanned > 0 && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: COLOR.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Adherence
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>
                  {sessionsDone}/{sessionsPlanned} sessions
                </div>
              </div>
            )}
          </div>
        )}

        {/* e1RM headline strip */}
        {e1rmEntries.length > 0 && e1rms && (
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 10,
              overflowX: "auto",
            }}
          >
            {e1rmEntries.map(({ key, label }) => (
              <div
                key={key}
                style={{
                  flex: "0 0 auto",
                  padding: "8px 14px",
                  background: COLOR.surface,
                  border: `1px solid ${COLOR.divider}`,
                  borderRadius: 12,
                  textAlign: "center",
                  minWidth: 72,
                }}
              >
                <div style={{ fontSize: 10, color: COLOR.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {label}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong }}>
                  {fmtNum(e1rms[key]!)}
                  <span style={{ fontSize: 10, fontWeight: 500, color: COLOR.textMuted, marginLeft: 2 }}>kg</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Day-swap chip — only when there's a committed week with a non-REST session today */}
        {committedWeek && committedSessionType && committedSessionType !== "REST" && (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => setSwapOpen(true)}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: COLOR.surfaceAlt,
                border: `1px solid ${COLOR.divider}`,
                fontSize: 12,
                fontWeight: 600,
                color: COLOR.textMid,
                cursor: "pointer",
              }}
            >
              Swap / change today's session →
            </button>
          </div>
        )}
      </div>

      {/* ── Carter's chat ── */}
      <div
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          minHeight: 320,
          borderTop: `1px solid ${COLOR.divider}`,
          marginTop: 12,
        }}
      >
        <ChatPanel
          userId={userId}
          embedded={true}
          initialKind="coach"
          thread="carter"
        />
      </div>

      {/* DaySwapSheet — rendered portalled when open */}
      {swapOpen && committedWeek && (
        <DaySwapSheet
          userId={userId}
          weekStart={currentWeekStart}
          sourceDay={todayWeekdayKey}
          plan={committedWeek.session_plan}
          onClose={() => setSwapOpen(false)}
        />
      )}
    </div>
  );
}
