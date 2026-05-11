"use client";

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { MorningBriefCard as MorningBriefCardData, Weekday } from "@/lib/data/types";
import { BriefRecapStats } from "@/components/morning/BriefRecapStats";
import { BriefSessionList } from "@/components/morning/BriefSessionList";
import { BriefRestActions } from "@/components/morning/BriefRestActions";
import { BriefMacrosGrid } from "@/components/morning/BriefMacrosGrid";
import { BriefAdvice } from "@/components/morning/BriefAdvice";
import { BriefTonight } from "@/components/morning/BriefTonight";
import { BriefCoachSuggestion } from "@/components/morning/BriefCoachSuggestion";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";

const FULL_TO_SHORT_INLINE: Record<string, Weekday> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

function weekStartOfInline(today: string): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function MorningBriefCard({
  userId,
  card,
}: {
  userId: string;
  card: MorningBriefCardData;
}) {
  const today = useMemo(() => todayInUserTz(), []);
  const weekStart = useMemo(() => weekStartOfInline(today), [today]);
  const sourceDay = useMemo<Weekday>(() => {
    const full = weekdayInUserTz(new Date(`${today}T12:00:00Z`));
    return FULL_TO_SHORT_INLINE[full] ?? "Mon";
  }, [today]);
  const { data: liveWeek } = useTrainingWeek(userId, weekStart);
  const liveType =
    liveWeek && readSessionForDay(liveWeek.session_plan as Record<string, string>, sourceDay);
  const isSwapped = !!liveType && liveType !== card.session.type;

  return (
    <article
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        width: "100%",
        maxWidth: "100%",
      }}
      aria-label="Today's morning brief"
    >
      <BriefHeader card={card} />
      <Divider />
      <SectionLabel>Yesterday</SectionLabel>
      <BriefRecapStats recap={card.recap} />
      <Divider />
      {card.variant === "training" ? (
        <>
          <SectionLabel>
            Today ·{" "}
            <span style={{ textDecoration: isSwapped ? "line-through" : "none" }}>
              {card.session.type}
            </span>
            {card.session.start_time ? ` · ${card.session.start_time}` : null}
          </SectionLabel>
          <BriefSessionList
            session={card.session}
            isSwapped={isSwapped}
            liveType={liveType ?? null}
          />
        </>
      ) : (
        <>
          <SectionLabel>Today · REST</SectionLabel>
          <BriefRestActions bedtime={card.tonight.bedtime_target} />
        </>
      )}
      <Divider />
      <SectionLabel>Macros today</SectionLabel>
      <BriefMacrosGrid macros={card.macros} />
      <Divider />
      <BriefAdvice md={card.advice_md} />
      <Divider />
      <BriefTonight tonight={card.tonight} />
      {card.coach_suggestion && (
        <BriefCoachSuggestion
          userId={userId}
          briefSessionType={card.session.type}
          suggestion={card.coach_suggestion}
        />
      )}
    </article>
  );
}

function BriefHeader({ card }: { card: MorningBriefCardData }) {
  const date = formatHeaderDate(card.recap.yesterday_date); // shows today, derived from yesterday + 1
  return (
    <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
            {date}
          </div>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: COLOR.textStrong,
              margin: "2px 0 0",
            }}
          >
            Today&apos;s brief
          </h2>
        </div>
        <ReadinessPill band={card.readiness.band} score={card.readiness.score} />
      </div>
    </header>
  );
}

function ReadinessPill({
  band,
  score,
}: {
  band: "low" | "moderate" | "high";
  score: number | null;
}) {
  const styles: Record<typeof band, { bg: string; fg: string; label: string }> = {
    low: { bg: COLOR.dangerSoft, fg: COLOR.danger, label: "Low" },
    moderate: { bg: COLOR.warningSoft, fg: COLOR.warning, label: "Moderate" },
    high: { bg: COLOR.successSoft, fg: COLOR.success, label: "High" },
  };
  const s = styles[band];
  return (
    <div
      style={{
        background: s.bg,
        color: s.fg,
        borderRadius: 999,
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
      aria-label={`Readiness ${s.label}${score !== null ? ` score ${score} of 10` : ""}`}
    >
      Readiness · {s.label}{score !== null ? ` · ${score}/10` : ""}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: COLOR.textMuted,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div style={{ borderTop: `1px solid ${COLOR.divider}` } as CSSProperties} />
  );
}

function formatHeaderDate(yesterdayISO: string): string {
  // Compute today from yesterday + 1, format as "Sunday May 11"
  const y = new Date(`${yesterdayISO}T00:00:00Z`);
  const t = new Date(y.getTime() + 86_400_000);
  return t.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
