"use client";

import { useState } from "react";
import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
import { DateNavigator } from "@/components/strength/DateNavigator";
import { SessionTable } from "@/components/strength/SessionTable";
import { Card } from "@/components/ui/Card";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

type Props = { userId: string };

export function StrengthByDateClient({ userId }: Props) {
  const todayIso = todayInUserTz();
  const { data: workouts = [], isLoading } = useFullWorkouts(userId);
  const [pickedDate, setPickedDate] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center", color: COLOR.textMuted }}>
        Loading…
      </div>
    );
  }

  if (!workouts.length) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <p style={{ fontSize: 14, color: COLOR.textMuted, margin: 0 }}>
          No workouts logged yet.
        </p>
      </div>
    );
  }

  const latestWorkout = workouts[0]?.date ?? todayIso;
  const earliestWorkout = workouts[workouts.length - 1]?.date ?? todayIso;
  const selectedDate = pickedDate ?? latestWorkout;
  const sessionsOnDate = workouts.filter((w) => w.date === selectedDate);

  return (
    <div
      style={{
        padding: "8px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <DateNavigator
        date={selectedDate}
        min={earliestWorkout}
        max={todayIso}
        onChange={setPickedDate}
      />

      {sessionsOnDate.length === 0 ? (
        <Card>
          <div className="text-center py-10">
            <div className="text-sm" style={{ color: COLOR.textMuted }}>
              No workouts logged on {selectedDate}
            </div>
            <div className="text-[11px] mt-1" style={{ color: COLOR.textFaint }}>
              Pick another date — your earliest is {earliestWorkout}.
            </div>
          </div>
        </Card>
      ) : (
        sessionsOnDate.map((s) => <SessionTable key={s.id} session={s} />)
      )}
    </div>
  );
}
