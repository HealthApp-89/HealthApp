"use client";

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { COLOR, RADIUS, GRADIENT } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { MorningBriefCard as MorningBriefCardData, MorningBriefHydration, Weekday } from "@/lib/data/types";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { BriefRecapStats } from "@/components/morning/BriefRecapStats";
import { BriefSessionList } from "@/components/morning/BriefSessionList";
import { BriefRestActions } from "@/components/morning/BriefRestActions";
import { BriefMacrosGrid } from "@/components/morning/BriefMacrosGrid";
import { BriefAdvice } from "@/components/morning/BriefAdvice";
import { BriefTonight } from "@/components/morning/BriefTonight";
import { BriefCoachSuggestion } from "@/components/morning/BriefCoachSuggestion";
import { BriefThisWeekPlan } from "@/components/morning/BriefThisWeekPlan";
import { BriefYesterdayVsPlan } from "@/components/morning/BriefYesterdayVsPlan";
import { EnduranceBriefBlock } from "@/components/morning/EnduranceBriefBlock";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";
import { useProfile } from "@/lib/query/hooks/useProfile";

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
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "UTC";
  const today = useMemo(() => todayInUserTz(new Date(), tz), [tz]);
  const weekStart = useMemo(() => weekStartOfInline(today), [today]);
  const fullWeekday = useMemo(() => weekdayInUserTz(new Date(`${today}T12:00:00Z`), tz), [today, tz]);
  const sourceDay = useMemo<Weekday>(() => {
    return FULL_TO_SHORT_INLINE[fullWeekday] ?? "Mon";
  }, [fullWeekday]);
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
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: "100%",
      }}
      aria-label="Today's morning brief"
    >
      <BriefHero card={card} />
      {card.whoop_missing ? (
        <div
          style={{
            background: COLOR.warningSoft,
            color: COLOR.warningDeep,
            padding: "8px 16px",
            fontSize: 12,
            fontWeight: 600,
            borderBottom: `1px solid ${COLOR.divider}`,
          }}
        >
          WHOOP hasn't synced yet — readiness is pending. Tap sync to compute it.
        </div>
      ) : null}
      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <SectionLabel>Yesterday</SectionLabel>
          <SpeakerChip speaker="peter" size="sm" />
        </div>
        <BriefRecapStats recap={card.recap} />
        <Divider />
        {/* Non-rest variants (training, kickoff, analytical) share the
            session-list rendering; rest gets its own branch below. Kickoff
            and analytical render their structured blocks (BriefThisWeekPlan
            / BriefYesterdayVsPlan) in addition to the session list. Future
            non-rest variants inherit the session-list path by default. */}
        {card.variant !== "rest" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <SectionLabel>
                Today ·{" "}
                <span style={{ textDecoration: isSwapped ? "line-through" : "none" }}>
                  {card.session.type}
                </span>
                {card.session.start_time ? ` · ${card.session.start_time}` : null}
              </SectionLabel>
              <SpeakerChip speaker="carter" size="sm" />
            </div>
            <BriefSessionList
              session={card.session}
              isSwapped={isSwapped}
              liveType={liveType ?? null}
              thisWeekPlan={card.this_week_plan}
              weekStart={weekStart}
              weekday={fullWeekday}
              userId={userId}
              weekOverrides={(liveWeek?.exercise_overrides as import("@/lib/data/types").ExerciseOverrides | null | undefined) ?? null}
              weekPrescriptions={(liveWeek?.session_prescriptions as import("@/lib/data/types").SessionPrescriptions | null | undefined) ?? null}
              weekRirTarget={liveWeek?.rir_target ?? null}
              manualEdits={(liveWeek?.manual_session_edits as import("@/lib/data/types").ManualSessionEdits | null | undefined) ?? null}
            />
            {card.variant === "kickoff" && card.this_week_plan && (
              <BriefThisWeekPlan plan={card.this_week_plan} />
            )}
            {card.variant === "analytical" && card.yesterday_vs_plan && (
              <BriefYesterdayVsPlan block={card.yesterday_vs_plan} />
            )}
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <SectionLabel>Today · REST</SectionLabel>
              <SpeakerChip speaker="carter" size="sm" />
            </div>
            <BriefRestActions bedtime={card.tonight.bedtime_target} />
          </>
        )}
        {card.endurance && (
          <>
            <Divider />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <SectionLabel>Endurance today</SectionLabel>
              <SpeakerChip speaker="carter" size="sm" />
            </div>
            <EnduranceBriefBlock data={card.endurance} />
          </>
        )}
        {card.hydration && (
          <>
            <Divider />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <SectionLabel>Hydration today</SectionLabel>
              <SpeakerChip speaker="nora" size="sm" />
            </div>
            <BriefHydration hydration={card.hydration} />
          </>
        )}
        <Divider />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <SectionLabel>Macros today</SectionLabel>
          <SpeakerChip speaker="nora" size="sm" />
        </div>
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
      </div>
    </article>
  );
}

function BriefHydration({ hydration }: { hydration: MorningBriefHydration }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <div
          style={{
            background: COLOR.accentSoft,
            borderRadius: RADIUS.pill,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
          aria-label={`Water: ${fmtNum(hydration.water_ml)} ml`}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
            {fmtNum(hydration.water_ml)} ml
          </div>
          <div style={{ fontSize: 11, color: COLOR.accentDeep, fontWeight: 600 }}>Water</div>
        </div>
        <div
          style={{
            background: COLOR.accentSoft,
            borderRadius: RADIUS.pill,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
          aria-label={`Sodium: ${fmtNum(hydration.sodium_mg)} mg`}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
            {fmtNum(hydration.sodium_mg)} mg
          </div>
          <div style={{ fontSize: 11, color: COLOR.accentDeep, fontWeight: 600 }}>Sodium</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: COLOR.textMuted, fontStyle: "italic" }}>
        {hydration.note}
      </div>
    </div>
  );
}

const BAND_LABEL: Record<"low" | "moderate" | "high", string> = {
  low:      "Action",
  moderate: "Watch",
  high:     "Good",
};

const BAND_GRADIENT: Record<"low" | "moderate" | "high", string> = {
  low: GRADIENT.heroDanger,
  moderate: GRADIENT.heroAmber,
  high: GRADIENT.heroSuccess,
};

function BriefHero({ card }: { card: MorningBriefCardData }) {
  const todayLabel = formatHeaderDate(card.recap.yesterday_date);
  const heroGradient = BAND_GRADIENT[card.readiness.band];
  const bandLabel = BAND_LABEL[card.readiness.band];
  return (
    <div
      style={{
        background: heroGradient,
        color: "#fff",
        padding: "18px 20px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            opacity: 0.85,
          }}
        >
          {`Today's brief · ${todayLabel}`}
        </div>
        <SpeakerChip speaker="remi" size="sm" />
      </div>
      <div
        style={{
          fontSize: 44,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          marginTop: 6,
        }}
      >
        {card.readiness.score !== null ? fmtNum(card.readiness.score) : "—"}
        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: 0,
            marginLeft: 6,
            opacity: 0.75,
          }}
        >
          {card.readiness.score !== null ? "/100" : null}
        </span>
      </div>
      {card.readiness.feel !== null ? (
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8, marginTop: 4 }}>
          You felt: {fmtNum(card.readiness.feel)}/10
        </div>
      ) : null}
      <div
        style={{
          display: "inline-block",
          marginTop: 10,
          background: "rgba(255,255,255,0.22)",
          padding: "3px 10px",
          borderRadius: 9999,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        Readiness · {bandLabel}
      </div>
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
