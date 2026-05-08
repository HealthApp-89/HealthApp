"use client";

import { LogForm } from "@/components/log/LogForm";
import { WeekStrip } from "@/components/layout/WeekStrip";
import { MetricCard } from "@/components/charts/MetricCard";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { formatHeaderDate, todayInUserTz } from "@/lib/time";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import type { DailyLog } from "@/lib/data/types";

export function LogClient({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  const { data: logRange = [] } = useDailyLogs(userId, date, date);
  const { data: checkin = null } = useCheckin(userId, date);
  const log = (logRange[0] ?? null) as DailyLog | null;

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
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>
            {formatHeaderDate()}
          </div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginTop: "2px",
              color: COLOR.textStrong,
            }}
          >
            Log
          </h1>
        </div>
      </div>

      <WeekStrip selected={date} today={todayInUserTz()} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "10px",
          padding: "0 8px 14px",
        }}
      >
        <MetricCard
          color={METRIC_COLOR.steps}
          icon="👣"
          label="Steps"
          value={log?.steps ?? null}
          compact
        />
        <MetricCard
          color={METRIC_COLOR.calories}
          icon="🍴"
          label="Calories"
          value={log?.calories_eaten ?? null}
          unit="kcal"
          compact
        />
      </div>

      <div style={{ padding: "0 8px" }}>
        <LogForm
          date={date}
          initialLog={log as Partial<DailyLog> | null}
          initialCheckin={
            checkin
              ? {
                  readiness: checkin.readiness,
                  energy_label: checkin.energy_label,
                  mood: checkin.mood,
                  soreness: checkin.soreness,
                  feel_notes: checkin.feel_notes,
                  sick: checkin.sick,
                  sickness_notes: checkin.sickness_notes,
                  fatigue: checkin.fatigue,
                  bloating: checkin.bloating,
                  soreness_areas: checkin.soreness_areas,
                  soreness_severity: checkin.soreness_severity,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
