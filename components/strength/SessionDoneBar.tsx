"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { EditSessionButton } from "@/components/logger/EditSessionButton";
import { RestartSessionButton } from "@/components/logger/RestartSessionButton";
import { queryKeys } from "@/lib/query/keys";
import { fmtNum } from "@/lib/ui/score";
import type { TodaySessionWorkout } from "@/lib/query/fetchers/todaySession";

type Props = {
  userId: string;
  date: string;
  workout: TodaySessionWorkout;
};

/** Completion line + Modify/Restart, rendered on top of the white-on-accent
 *  session cards. Modify reuses the existing EditSessionButton hydration
 *  path — there is no second edit mechanism. */
export function SessionDoneBar({ userId, date, workout }: Props) {
  const qc = useQueryClient();
  const router = useRouter();
  const eligible = workout.source === "logger";

  function refresh() {
    qc.invalidateQueries({ queryKey: queryKeys.todaySession.one(userId, date) });
    qc.invalidateQueries({ queryKey: queryKeys.workouts.all(userId) });
    router.refresh();
  }

  const bits = [
    workout.duration_min != null ? `${fmtNum(workout.duration_min)} min` : null,
    workout.exercise_count > 0
      ? `${workout.exercise_count} exercise${workout.exercise_count === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <Check size={14} aria-hidden="true" />
        <span>
          {workout.type ?? "Session"} logged
          {bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <a
          href={`/coach/sessions/${workout.id}`}
          style={{ fontSize: 12, fontWeight: 600, color: "#fff", textDecoration: "underline" }}
        >
          Read debrief →
        </a>
        <div style={{ flex: 1 }} />
        <EditSessionButton
          workoutId={workout.id}
          eligible={eligible}
          label="Modify"
          className="text-[12px] font-semibold text-white px-2.5 py-1.5 rounded-lg border border-white/35"
        />
        {eligible && <RestartSessionButton workoutId={workout.id} onDone={refresh} />}
      </div>
    </div>
  );
}
