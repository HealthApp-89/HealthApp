"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { EditSessionButton } from "@/components/logger/EditSessionButton";
import { RestartSessionButton } from "@/components/logger/RestartSessionButton";
import { queryKeys } from "@/lib/query/keys";
import { fmtNum } from "@/lib/ui/score";
import { COLOR } from "@/lib/ui/theme";
import type { TodaySessionWorkout } from "@/lib/query/fetchers/todaySession";

type Tone = "onAccent" | "onSurface";

type Props = {
  userId: string;
  date: string;
  workout: TodaySessionWorkout;
  /** "onAccent" (default) is the original white-on-color styling, built for
   *  TodayPlanCard's white-on-accent hero card — byte-for-byte unchanged
   *  behaviour, so existing call sites need no change. "onSurface" is
   *  dark-on-white, using COLOR tokens, for surfaces like BriefSessionList's
   *  plain white card where the "onAccent" white text/borders would be
   *  unreadable. */
  tone?: Tone;
};

/** Tailwind can't resolve arbitrary-value classes built from a runtime
 *  template string (its content scanner needs the literal characters in
 *  source), so the "onSurface" hex values below are copied from
 *  COLOR.textStrong / COLOR.divider in lib/ui/theme.ts rather than
 *  interpolated. Keep them in sync if those tokens ever change. */
const EDIT_BUTTON_CLASS: Record<Tone, string> = {
  onAccent: "text-[12px] font-semibold text-white px-2.5 py-1.5 rounded-lg border border-white/35",
  onSurface: "text-[12px] font-semibold text-[#0f1430] px-2.5 py-1.5 rounded-lg border border-[#e8eaf3]",
};

/** Completion line + Modify/Restart, rendered on top of either the
 *  white-on-accent session hero card (TodayPlanCard) or a plain white card
 *  (BriefSessionList) via the `tone` prop. Modify reuses the existing
 *  EditSessionButton hydration path — there is no second edit mechanism. */
export function SessionDoneBar({ userId, date, workout, tone = "onAccent" }: Props) {
  const qc = useQueryClient();
  const router = useRouter();
  const eligible = workout.source === "logger";
  const onSurface = tone === "onSurface";

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
    <div
      style={{
        marginTop: 12,
        borderTop: `1px solid ${onSurface ? COLOR.divider : "rgba(255,255,255,0.18)"}`,
        paddingTop: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          color: onSurface ? COLOR.textStrong : undefined,
        }}
      >
        <Check size={14} aria-hidden="true" />
        <span>
          {workout.type ?? "Session"} logged
          {bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <a
          href={`/coach/sessions/${workout.id}`}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: onSurface ? COLOR.accent : "#fff",
            textDecoration: "underline",
          }}
        >
          Read debrief →
        </a>
        <div style={{ flex: 1 }} />
        <EditSessionButton
          workoutId={workout.id}
          eligible={eligible}
          label="Modify"
          className={EDIT_BUTTON_CLASS[tone]}
        />
        {eligible && <RestartSessionButton workoutId={workout.id} onDone={refresh} tone={tone} />}
      </div>
    </div>
  );
}
