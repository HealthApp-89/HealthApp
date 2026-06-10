"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { WeekScheduleAccordion, type WeekDayEntry } from "@/components/strength/WeekScheduleAccordion";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
import { useUserSessionTemplates } from "@/lib/query/hooks/useUserSessionTemplates";
import { currentWeekMonday } from "@/lib/coach/week";
import { getEffectiveSessionPlan, WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { todayInUserTz } from "@/lib/time";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { COLOR } from "@/lib/ui/theme";
import type { DayClass } from "@/components/strength/ScheduleDayRow";
import type { Weekday, SessionPlan } from "@/lib/data/types";

const WEEKDAY_ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LONG: Record<Weekday, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtWeekHeader(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00Z");
  const end = new Date(weekStart + "T12:00:00Z");
  end.setUTCDate(start.getUTCDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${start.toLocaleDateString("en-US", opts)} → ${end.toLocaleDateString("en-US", opts)}`;
}

type Props = { userId: string };

export function StrengthScheduleClient({ userId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "UTC";
  const todayIso = todayInUserTz(new Date(), tz);
  const defaultMonday = currentWeekMonday(new Date(), tz);

  const weekParam = searchParams.get("week");
  const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)
    ? weekParam
    : defaultMonday;

  const { data: trainingWeek = null, isLoading: tweekLoading } = useTrainingWeek(userId, weekStart);
  const { data: workouts = [], isLoading: workoutsLoading } = useFullWorkouts(userId);
  const { data: templatesMap = {}, isLoading: templatesLoading } = useUserSessionTemplates(userId);

  // Cap navigation: 8 weeks back, 1 forward.
  const minWeek = addDays(defaultMonday, -7 * 8);
  const maxWeek = addDays(defaultMonday, 7);

  const days = useMemo<WeekDayEntry[]>(() => {
    const sessionPlan: SessionPlan = (trainingWeek?.session_plan ?? {}) as SessionPlan;
    const overrides = trainingWeek?.exercise_overrides ?? null;
    const prescriptions = trainingWeek?.session_prescriptions ?? null;

    const loggedDates = new Set(workouts.map((w) => w.date));

    return WEEKDAY_ORDER.map<WeekDayEntry>((wd, i) => {
      const date = addDays(weekStart, i);
      const weekdayLong = WEEKDAY_LONG[wd];
      // session_plan jsonb may use either short ("Mon") or full ("Monday") keys
      // depending on the writer (Carter uses full names, schema spec says short).
      // readSessionForDay handles both forms; a raw `sessionPlan[wd]` lookup
      // misses full-name keys and falls back to WEEKLY_SESSIONS, which surfaced
      // as "Monday: Legs" in the schedule view despite a committed Mon→Chest swap.
      const sessionType =
        readSessionForDay(sessionPlan as Record<string, string>, wd) ??
        WEEKLY_SESSIONS[weekdayLong] ??
        "REST";

      const userTemplate = templatesMap[sessionType]?.exercises ?? null;
      const exercises = sessionType === "REST"
        ? []
        : getEffectiveSessionPlan(sessionType, weekdayLong, prescriptions, overrides, userTemplate);

      const isToday = date === todayIso;
      const isPast = date < todayIso;
      const isLogged = loggedDates.has(date);

      let dayClass: DayClass;
      if (sessionType === "REST") dayClass = "rest";
      else if (isToday) dayClass = "today";
      else if (isPast && isLogged) dayClass = "past_logged";
      else if (isPast) dayClass = "past_unlogged";
      else dayClass = "future";

      return {
        weekdayShort: wd,
        weekdayLong,
        date,
        sessionType,
        exercises,
        dayClass,
      };
    });
  }, [trainingWeek, workouts, templatesMap, weekStart, todayIso]);

  const hasCommittedWeek = trainingWeek !== null;
  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const prevDisabled = prevWeek < minWeek;
  const nextDisabled = nextWeek > maxWeek;

  function goTo(week: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("week", week);
    router.replace(`/strength?${params.toString()}`);
  }

  const isLoading = tweekLoading || workoutsLoading || templatesLoading;

  return (
    <div style={{ padding: "8px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Week navigator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 14,
          padding: "10px 12px",
        }}
      >
        <button
          type="button"
          onClick={() => goTo(prevWeek)}
          disabled={prevDisabled}
          aria-label="Previous week"
          style={{
            padding: "6px 10px",
            borderRadius: 9999,
            border: `1px solid ${COLOR.divider}`,
            background: COLOR.surfaceAlt,
            color: prevDisabled ? COLOR.textFaint : COLOR.textMid,
            fontSize: 13,
            fontWeight: 600,
            cursor: prevDisabled ? "default" : "pointer",
            opacity: prevDisabled ? 0.4 : 1,
          }}
        >
          ‹
        </button>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <span
            style={{
              fontSize: 10,
              color: COLOR.textMuted,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Week of
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>
            {fmtWeekHeader(weekStart)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => goTo(nextWeek)}
          disabled={nextDisabled}
          aria-label="Next week"
          style={{
            padding: "6px 10px",
            borderRadius: 9999,
            border: `1px solid ${COLOR.divider}`,
            background: COLOR.surfaceAlt,
            color: nextDisabled ? COLOR.textFaint : COLOR.textMid,
            fontSize: 13,
            fontWeight: 600,
            cursor: nextDisabled ? "default" : "pointer",
            opacity: nextDisabled ? 0.4 : 1,
          }}
        >
          ›
        </button>
      </div>

      {/* Default-plan banner */}
      {!isLoading && !hasCommittedWeek && (
        <Card>
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.textStrong }}>
              Default plan
            </span>
            <a
              href={`/strength?tab=coach&mode=plan_week&week=${weekStart}`}
              style={{ fontSize: 12, color: COLOR.accent, textDecoration: "none" }}
            >
              Plan this week with Coach →
            </a>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div style={{ padding: "24px 0", textAlign: "center", color: COLOR.textMuted }}>
          Loading…
        </div>
      ) : (
        <WeekScheduleAccordion
          userId={userId}
          weekStart={weekStart}
          days={days}
          weekOverrides={trainingWeek?.exercise_overrides ?? null}
          weekPrescriptions={trainingWeek?.session_prescriptions ?? null}
          sessionPlan={(trainingWeek?.session_plan ?? {}) as SessionPlan}
        />
      )}
    </div>
  );
}
