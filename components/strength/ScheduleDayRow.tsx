"use client";

import { useState } from "react";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ExerciseOverrides, ManualSessionEdits, SessionPlan, SessionPrescriptions, Weekday } from "@/lib/data/types";
import { LoggerSheet } from "@/components/logger/LoggerSheet";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import { DayEditSheet } from "@/components/strength/schedule/DayEditSheet";
import { useExistingLoggerDraft } from "@/lib/logger/use-existing-draft";
import { COLOR } from "@/lib/ui/theme";
import { CircleDot, CheckCircle2, XCircle, Clock, Minus, Pencil } from "lucide-react";

/** Date-class discriminator — controls which footer CTAs render. */
export type DayClass = "today" | "past_logged" | "past_unlogged" | "future" | "rest";

type Props = {
  userId: string;
  weekStart: string;
  weekdayShort: Weekday;
  weekdayLong: string;
  date: string;
  sessionType: string;
  exercises: PlannedExercise[];
  /** Engine-resolved plan WITHOUT the manual-edit layer (DayEditSheet baseline). */
  baselineExercises: PlannedExercise[];
  dayClass: DayClass;
  isExpanded: boolean;
  onToggle: () => void;
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions: SessionPrescriptions | null;
  weekRirTarget?: number | null;
  weekManualEdits: ManualSessionEdits | null;
  sessionPlan: SessionPlan;
  /** Current week with a committed row — gates the Edit affordance. */
  canEdit: boolean;
  activeBlockId: string | null;
};

const WEEKDAY_LABEL: Record<Weekday, string> = {
  Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun",
};

function dayOfMonth(iso: string): number {
  return new Date(iso + "T12:00:00Z").getUTCDate();
}

function formatTarget(ex: PlannedExercise): string {
  if (ex.baseKg != null) {
    const reps = ex.baseReps ?? 8;
    const sets = ex.sets ?? 3;
    return `${ex.baseKg}kg × ${reps} × ${sets}`;
  }
  return ex.reps ?? "—";
}

export function ScheduleDayRow({
  userId,
  weekStart,
  weekdayShort,
  weekdayLong,
  date,
  sessionType,
  exercises,
  baselineExercises,
  dayClass,
  isExpanded,
  onToggle,
  weekOverrides,
  weekPrescriptions,
  weekRirTarget,
  weekManualEdits,
  sessionPlan,
  canEdit,
  activeBlockId,
}: Props) {
  const [loggerOpen, setLoggerOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const hasDraft = useExistingLoggerDraft(userId, sessionType, draftEpoch);

  const isRest = dayClass === "rest";
  const showEdit = canEdit && !isRest && exercises.length > 0;

  const pillLabel =
    dayClass === "today"          ? "Today" :
    dayClass === "past_logged"    ? "Logged" :
    dayClass === "past_unlogged"  ? "Not logged" :
    dayClass === "future"         ? "Upcoming" :
    isRest                        ? "Rest" :
    sessionType;
  const pillBg =
    dayClass === "today"          ? COLOR.warning :
    dayClass === "past_logged"    ? COLOR.success :
    dayClass === "past_unlogged"  ? COLOR.danger :
    dayClass === "future"         ? COLOR.accent :
    isRest                        ? COLOR.textMuted :
    COLOR.accent;

  const PillIcon =
    dayClass === "today"          ? CircleDot :
    dayClass === "past_logged"    ? CheckCircle2 :
    dayClass === "past_unlogged"  ? XCircle :
    dayClass === "future"         ? Clock :
    isRest                        ? Minus :
    null;

  const showFooterToday = dayClass === "today" && !isRest;
  const showFooterFuture = dayClass === "future" && !isRest;
  const showFooterPastLogged = dayClass === "past_logged";
  const showFooterPastUnlogged = dayClass === "past_unlogged" && !isRest;

  return (
    <>
      <div
        style={{
          background: COLOR.surface,
          border: `1px solid ${isExpanded ? COLOR.textStrong : COLOR.divider}`,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: isExpanded ? "0 2px 8px rgba(20,30,80,0.05)" : "none",
        }}
      >
        <button
          type="button"
          onClick={isRest ? undefined : onToggle}
          disabled={isRest}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            background: "transparent",
            border: "none",
            cursor: isRest ? "default" : "pointer",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minWidth: 44 }}>
            <span
              style={{
                fontSize: 10,
                color: COLOR.textMuted,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {WEEKDAY_LABEL[weekdayShort]}
            </span>
            <span style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong }}>
              {dayOfMonth(date)}
            </span>
          </div>

          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: COLOR.textStrong }}>
            {isRest ? "Rest day" : sessionType}
          </span>

          <span
            style={{
              padding: "3px 9px",
              background: pillBg,
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              borderRadius: 9999,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {PillIcon && <PillIcon size={10} aria-hidden="true" />}
            {pillLabel}
          </span>

          {!isRest && (
            <span
              aria-hidden="true"
              style={{
                color: COLOR.textMuted,
                fontSize: 12,
                width: 12,
                textAlign: "center",
              }}
            >
              {isExpanded ? "▼" : "▶"}
            </span>
          )}
        </button>

        {isExpanded && !isRest && (
          <div style={{ padding: "0 14px 14px 70px", borderTop: `1px solid ${COLOR.divider}` }}>
            {exercises.length === 0 ? (
              <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "10px 0 0 0" }}>
                No prescribed exercises.
              </p>
            ) : (
              <ul
                style={{
                  margin: "8px 0 0 0",
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {exercises.map((ex) => (
                  <li
                    key={ex.name}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 0",
                      borderTop: `1px solid ${COLOR.divider}`,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: COLOR.textMid }}>
                      {ex.name.split("(")[0].trim()}
                      {ex.video_url && (
                        <a
                          href={ex.video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            color: COLOR.accent,
                            textDecoration: "underline",
                          }}
                        >
                          ▶ video
                        </a>
                      )}
                    </span>
                    <span
                      data-tnum
                      style={{
                        fontFamily: "var(--font-dm-mono), monospace",
                        fontWeight: 600,
                        color: COLOR.textStrong,
                      }}
                    >
                      {formatTarget(ex)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {(showFooterToday || showFooterFuture || showEdit) && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                {showFooterToday && (
                  <button
                    type="button"
                    onClick={() => setLoggerOpen(true)}
                    style={{
                      flex: 1,
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "none",
                      background: COLOR.textStrong,
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {hasDraft ? "Resume session" : "Start session"}
                  </button>
                )}
                {(showFooterToday || showFooterFuture) && (
                  <button
                    type="button"
                    onClick={() => setSwapOpen(true)}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 9999,
                      background: COLOR.surfaceAlt,
                      border: `1px solid ${COLOR.divider}`,
                      fontSize: 12,
                      fontWeight: 600,
                      color: COLOR.textMid,
                      cursor: "pointer",
                    }}
                  >
                    Swap day
                  </button>
                )}
                {showEdit && (
                  <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    aria-label={`Edit ${weekdayLong} plan`}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 9999,
                      background: COLOR.surfaceAlt,
                      border: `1px solid ${COLOR.divider}`,
                      fontSize: 12,
                      fontWeight: 600,
                      color: COLOR.textMid,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <Pencil size={11} aria-hidden="true" />
                    Edit
                  </button>
                )}
              </div>
            )}

            {showFooterPastLogged && (
              <a
                href={`/strength?tab=date&date=${date}`}
                style={{
                  display: "inline-block",
                  marginTop: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  color: COLOR.accent,
                  textDecoration: "none",
                }}
              >
                View logged session →
              </a>
            )}

            {showFooterPastUnlogged && (
              <p
                style={{
                  margin: "12px 0 0 0",
                  fontSize: 11,
                  color: COLOR.textFaint,
                  fontStyle: "italic",
                }}
              >
                Not logged.
              </p>
            )}
          </div>
        )}
      </div>

      {loggerOpen && (
        <LoggerSheet
          userId={userId}
          sessionType={sessionType}
          date={date}
          weekdayLong={weekdayLong}
          weekOverrides={weekOverrides}
          weekPrescriptions={weekPrescriptions}
          manualEdits={weekManualEdits}
          weekRirTarget={weekRirTarget ?? null}
          onClose={() => {
            setLoggerOpen(false);
            setDraftEpoch((e) => e + 1);
          }}
        />
      )}

      {swapOpen && (
        <DaySwapSheet
          userId={userId}
          weekStart={weekStart}
          sourceDay={weekdayShort}
          plan={sessionPlan}
          onClose={() => setSwapOpen(false)}
        />
      )}

      {editOpen && (
        <DayEditSheet
          userId={userId}
          weekStart={weekStart}
          weekdayLong={weekdayLong}
          sessionType={sessionType}
          baseline={baselineExercises}
          current={exercises}
          activeBlockId={activeBlockId}
          onClose={() => setEditOpen(false)}
        />
      )}
    </>
  );
}
