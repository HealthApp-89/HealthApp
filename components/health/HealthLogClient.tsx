"use client";

import { LogClient } from "@/components/log/LogClient";
import { useCheckins } from "@/lib/query/hooks/useCheckins";
import { useUserToday } from "@/lib/query/hooks/useUserToday";
import { COLOR } from "@/lib/ui/theme";
import type { CheckinRangeRow } from "@/lib/query/fetchers/checkinsRange";
import type { FatigueLevel } from "@/lib/data/types";
import { SymptomLogSection } from "@/components/health/SymptomLogSection";

type Props = {
  userId: string;
  initialDate?: string;
};

export function HealthLogClient({ userId, initialDate }: Props) {
  const today = useUserToday(userId);
  const date = initialDate ?? today;
  if (!date) return null;
  return (
    <>
      <LogClient userId={userId} date={date} />
      <SymptomLogSection userId={userId} />
      <PastIntakesList userId={userId} />
    </>
  );
}

function PastIntakesList({ userId }: { userId: string }) {
  const today = useUserToday(userId);
  if (!today) return null;
  const fromDate = new Date(`${today}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 14);
  const fromIso = fromDate.toISOString().slice(0, 10);

  const { data: checkins } = useCheckins(userId, fromIso, today);

  // "Completed" = past the awaiting_* phases — matches HealthCoachClient's MorningFeelRow filter.
  const completed = (checkins ?? []).filter(
    (c) =>
      c.intake_state != null &&
      c.intake_state !== "pending" &&
      c.intake_state !== "awaiting_feel" &&
      c.intake_state !== "awaiting_sickness_notes" &&
      c.intake_state !== "awaiting_whoop",
  );

  if (completed.length === 0) {
    return (
      <div
        style={{
          padding: "16px",
          fontSize: 12,
          color: COLOR.textMuted,
          fontStyle: "italic",
        }}
      >
        No completed morning intakes in the last 14 days.
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 16px 16px" }}>
      <h2
        style={{
          fontSize: 13,
          color: COLOR.textMid,
          margin: "12px 0 8px 0",
          fontWeight: 600,
        }}
      >
        Recent morning intakes
      </h2>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {completed.map((c) => (
          <li
            key={c.date}
            style={{
              background: COLOR.surfaceAlt,
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 12,
              color: COLOR.textMid,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span
              style={{
                fontWeight: 600,
                color: COLOR.textStrong,
                minWidth: 80,
                flexShrink: 0,
              }}
            >
              {c.date}
            </span>
            <span style={{ flex: 1, textAlign: "right" }}>
              {formatFlags(c)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatFlags(c: CheckinRangeRow): string {
  const parts: string[] = [];
  if (c.sick) parts.push("sick");
  if (c.fatigue && (c.fatigue as FatigueLevel) !== "none")
    parts.push(`fatigue: ${c.fatigue}`);
  if (c.bloating) parts.push("bloating");
  if (c.soreness_areas && c.soreness_areas.length > 0)
    parts.push(`sore: ${c.soreness_areas.length}`);
  return parts.length === 0 ? "clean" : parts.join(" · ");
}
