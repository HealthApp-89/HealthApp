"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { BIG_FOUR_SET } from "@/lib/coach/big-four";
import { JargonPill } from "@/components/coach/JargonPill";
import type { MorningBriefCard, MorningBriefExercise, ExerciseOverrides } from "@/lib/data/types";
import type { SessionStructure } from "@/lib/coach/session-structure";
import { SessionStructureBanner } from "@/components/strength/SessionStructureBanner";
import { LoggerSheet } from "@/components/logger/LoggerSheet";
import { MorningPatchChip } from "@/components/morning/MorningPatchChip";
import { useExistingLoggerDraft } from "@/lib/logger/use-existing-draft";
import { useUserToday } from "@/lib/query/hooks/useUserToday";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";

function fmtRestRange(r: { min: number; max: number }): string {
  if (r.min >= 60 && r.max >= 90 && r.min % 60 === 0 && r.max % 60 === 0) {
    return `${r.min / 60}–${r.max / 60} min`;
  }
  return `${r.min}–${r.max} s`;
}

function findAnnotation(
  structure: SessionStructure | null | undefined,
  name: string,
): SessionStructure["exercises"][number] | null {
  if (!structure) return null;
  return structure.exercises.find((e) => e.name === name) ?? null;
}

function sameExerciseNameSet(
  briefExercises: { name: string }[],
  planned: PlannedExercise[],
): boolean {
  if (briefExercises.length !== planned.length) return false;
  const briefSet = briefExercises.map((e) => e.name.toLowerCase().trim()).sort().join("|");
  const planSet = planned.map((p) => p.name.toLowerCase().trim()).sort().join("|");
  return briefSet === planSet;
}

function resolveLiveExercises(args: {
  weekOverrides: ExerciseOverrides | null;
  weekday: string;
  sessionType: string;
}): PlannedExercise[] {
  const override = args.weekOverrides?.[args.weekday];
  if (override && override.length > 0) return override;
  return SESSION_PLANS[args.sessionType] ?? [];
}

export function BriefSessionList({
  session,
  isSwapped,
  liveType,
  thisWeekPlan,
  weekStart,
  weekday,
  userId,
  weekOverrides,
  weekPrescriptions,
  weekRirTarget,
  manualEdits,
}: {
  session: MorningBriefCard["session"];
  isSwapped: boolean;
  liveType: string | null;
  thisWeekPlan?: MorningBriefCard["this_week_plan"];
  weekStart: string;
  weekday: string;
  userId: string;
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions?: import("@/lib/data/types").SessionPrescriptions | null;
  weekRirTarget?: number | null;
  /** Athlete's week-scope manual edit layer — LoggerSheet must receive it so
   *  schedule edits reach the logger's resolved plan. */
  manualEdits?: import("@/lib/data/types").ManualSessionEdits | null;
}) {
  const { exercises, volume_gaps } = session;
  const [loggerOpen, setLoggerOpen] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const loggerSessionType = liveType ?? session.type;
  const hasDraft = useExistingLoggerDraft(userId, loggerSessionType, draftEpoch);
  const today = useUserToday(userId);
  const liveExercises = resolveLiveExercises({
    weekOverrides,
    weekday,
    sessionType: loggerSessionType,
  });
  const exercisesDiverged =
    !isSwapped &&
    liveExercises.length > 0 &&
    !sameExerciseNameSet(session.exercises, liveExercises.filter((p) => !p.warmup));

  if (exercises.length === 0) {
    return (
      <div>
        <div style={{ fontSize: 13, color: COLOR.textMuted, fontStyle: "italic" }}>
          No exercises planned for this session type.
        </div>
        {volume_gaps && volume_gaps.length > 0 && (
          <VolumeGapsBanner gaps={volume_gaps} />
        )}
      </div>
    );
  }
  return (
    <div>
      {session.structure && session.structure.warnings.length > 0 && (
        <SessionStructureBanner
          structure={session.structure}
          weekStart={weekStart}
          weekday={weekday}
          userId={userId}
        />
      )}
      <MorningPatchChip userId={userId} />
      <div
        style={{
          background: COLOR.surfaceAlt,
          borderRadius: 10,
          overflow: "hidden",
          opacity: isSwapped || exercisesDiverged ? 0.4 : 1,
          transition: "opacity 0.2s",
        }}
      >
        {exercises.map((e, i) => {
          const planEntry =
            BIG_FOUR_SET.has(e.name) && thisWeekPlan
              ? thisWeekPlan.per_lift.find((p) => p.lift === e.name)
              : undefined;
          return (
            <div
              key={`${e.name}-${i}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 12px",
                borderTop: i === 0 ? "none" : `1px solid ${COLOR.divider}`,
                gap: 8,
              }}
              aria-label={ariaForExercise(e)}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: COLOR.textStrong,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.name}
                  {e.video_url && (
                    <a
                      href={e.video_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(ev) => ev.stopPropagation()}
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        fontWeight: 500,
                        color: COLOR.accent,
                        textDecoration: "none",
                      }}
                    >
                      ▶ video
                    </a>
                  )}
                </div>
                {e.note && (
                  <div style={{ fontSize: 11, color: COLOR.textFaint, fontStyle: "italic" }}>
                    {e.note}
                  </div>
                )}
                {(() => {
                  const ann = findAnnotation(session.structure, e.name);
                  if (!ann?.cue) return null;
                  return (
                    <div
                      style={{
                        fontSize: 11,
                        color: COLOR.warningDeep,
                        fontStyle: "italic",
                        marginTop: 2,
                      }}
                    >
                      ⚠ {ann.cue}
                    </div>
                  );
                })()}
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  flexShrink: 0,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
                  {e.kg !== null ? `${e.kg} kg` : "BW"}
                </div>
                <div style={{ fontSize: 11, color: COLOR.textMuted, lineHeight: 1.2 }}>
                  {e.sets} × {e.reps}
                </div>
                {planEntry && planEntry.rir_target != null && findAnnotation(session.structure, e.name)?.rir == null && (
                  <div
                    style={{
                      fontSize: 10,
                      color: COLOR.textFaint,
                      lineHeight: 1.2,
                      fontFamily: "var(--font-dm-mono), monospace",
                      marginTop: 1,
                    }}
                  >
                    <JargonPill termKey="rir">
                      RIR {planEntry.rir_target}
                    </JargonPill>
                  </div>
                )}
                {(() => {
                  const ann = findAnnotation(session.structure, e.name);
                  if (!ann) return null;
                  return (
                    <div
                      style={{
                        fontSize: 10,
                        color: COLOR.textFaint,
                        lineHeight: 1.2,
                        fontFamily: "var(--font-dm-mono), monospace",
                        marginTop: 1,
                      }}
                      aria-label={`Rest ${fmtRestRange(ann.rest_seconds)}, ${ann.rpe_target}`}
                    >
                      {fmtRestRange(ann.rest_seconds)} · {ann.rpe_target.replace(/across sets, top set .*/, "").trim()}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
      {exercisesDiverged && (
        <p
          style={{
            marginTop: "8px",
            fontSize: "12px",
            color: COLOR.textMuted,
            fontStyle: "italic",
          }}
        >
          Plan updated since this morning —{" "}
          <a href="/strength" style={{ color: COLOR.accent }}>
            see /strength
          </a>{" "}
          for the current session.
        </p>
      )}
      {volume_gaps && volume_gaps.length > 0 && (
        <VolumeGapsBanner gaps={volume_gaps} />
      )}
      {isSwapped && (
        <p
          style={{
            marginTop: "8px",
            fontSize: "12px",
            color: COLOR.textMuted,
            fontStyle: "italic",
          }}
        >
          Swapped to {liveType} —{" "}
          <a href="/strength" style={{ color: COLOR.accent }}>
            see /strength
          </a>{" "}
          for the new session.
        </p>
      )}
      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => setLoggerOpen(true)}
          style={{
            background: "transparent",
            border: "none",
            color: "#60a5fa",
            fontSize: 12,
            textDecoration: "underline",
            textUnderlineOffset: 2,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {hasDraft ? "Resume this session" : "Log this session"}
        </button>
        <a
          href="/health?tab=log"
          style={{
            color: "#60a5fa",
            fontSize: 12,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          Log day data
        </a>
      </div>
      {loggerOpen && today && (
        <LoggerSheet
          userId={userId}
          sessionType={loggerSessionType}
          date={today}
          weekdayLong={weekday}
          weekOverrides={weekOverrides}
          weekPrescriptions={weekPrescriptions ?? null}
          manualEdits={manualEdits ?? null}
          weekRirTarget={weekRirTarget ?? null}
          onClose={() => { setLoggerOpen(false); setDraftEpoch((e) => e + 1); }}
        />
      )}
    </div>
  );
}

function VolumeGapsBanner({
  gaps,
}: {
  gaps: NonNullable<MorningBriefCard["session"]["volume_gaps"]>;
}) {
  return (
    <div
      role="note"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: COLOR.warningSoft,
        border: `1px solid ${COLOR.warning}`,
        borderRadius: 8,
        fontSize: 13,
        color: COLOR.warningDeep,
      }}
    >
      ⚠ <strong>Volume gaps:</strong>{" "}
      {gaps.map((g, idx) => {
        const tierKey = g.label === "below_mev" ? "mev" : "mrv";
        const tierLabel = g.label === "below_mev" ? "MEV" : "MRV";
        return (
          <span key={g.group}>
            {idx > 0 && ", "}
            {g.group} ({g.actual}/wk vs {g.target}{" "}
            <JargonPill termKey={tierKey}>{tierLabel}</JargonPill>
            )
          </span>
        );
      })}{" "}
      <span style={{ fontStyle: "italic" }}>— coach details below.</span>
    </div>
  );
}

function ariaForExercise(e: MorningBriefExercise): string {
  const weight = e.kg !== null ? `${e.kg} kilograms` : "bodyweight";
  return `${e.name}, ${weight}, ${e.sets} sets of ${e.reps} reps`;
}
