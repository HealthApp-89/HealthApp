"use client";

import { useEffect, useState } from "react";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type {
  ExerciseOverrides,
  SessionPlan,
  SessionPrescriptions,
  Weekday,
} from "@/lib/data/types";
import { ScheduleDayRow, type DayClass } from "@/components/strength/ScheduleDayRow";

export type WeekDayEntry = {
  weekdayShort: Weekday;
  weekdayLong: string;
  date: string;
  sessionType: string;
  exercises: PlannedExercise[];
  dayClass: DayClass;
};

type Props = {
  userId: string;
  weekStart: string;
  days: WeekDayEntry[];
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions: SessionPrescriptions | null;
  sessionPlan: SessionPlan;
};

export function WeekScheduleAccordion({
  userId,
  weekStart,
  days,
  weekOverrides,
  weekPrescriptions,
  sessionPlan,
}: Props) {
  const [expanded, setExpanded] = useState<Set<Weekday>>(new Set());

  // Auto-expand today on first paint of a given week (re-keyed by weekStart).
  useEffect(() => {
    const today = days.find((d) => d.dayClass === "today");
    setExpanded(new Set(today ? [today.weekdayShort] : []));
  }, [weekStart, days]);

  function toggle(day: Weekday) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {days.map((d) => (
        <ScheduleDayRow
          key={d.weekdayShort}
          userId={userId}
          weekStart={weekStart}
          weekdayShort={d.weekdayShort}
          weekdayLong={d.weekdayLong}
          date={d.date}
          sessionType={d.sessionType}
          exercises={d.exercises}
          dayClass={d.dayClass}
          isExpanded={expanded.has(d.weekdayShort)}
          onToggle={() => toggle(d.weekdayShort)}
          weekOverrides={weekOverrides}
          weekPrescriptions={weekPrescriptions}
          sessionPlan={sessionPlan}
        />
      ))}
    </div>
  );
}
