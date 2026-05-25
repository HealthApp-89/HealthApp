"use client";

import { useRouter } from "next/navigation";
import { LogForm } from "@/components/log/LogForm";
import { COLOR } from "@/lib/ui/theme";
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
  const router = useRouter();
  const { data: logRange = [] } = useDailyLogs(userId, date, date);
  const { data: checkin = null } = useCheckin(userId, date);
  const log = (logRange[0] ?? null) as DailyLog | null;
  const today = todayInUserTz();
  const isToday = date === today;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px 12px 14px",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
            {isToday ? formatHeaderDate() : date}
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginTop: 2,
              color: COLOR.textStrong,
            }}
          >
            Daily metrics
          </h1>
        </div>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => {
            const next = e.target.value;
            if (!next) return;
            router.push(`/health?tab=log&date=${next}`);
          }}
          aria-label="Select date"
          style={{
            background: COLOR.surface,
            color: COLOR.textStrong,
            border: "none",
            borderRadius: 10,
            padding: "8px 10px",
            fontSize: 14,
            fontWeight: 600,
            colorScheme: "dark",
          }}
        />
      </div>

      <div style={{ padding: "0 8px" }}>
        <LogForm
          key={date}
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
