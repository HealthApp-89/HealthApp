"use client";

import { useState } from "react";
import { Dumbbell } from "lucide-react";
import type { DailyPlan } from "@/lib/coach/readiness";
import type { ExerciseOverrides, SessionPrescriptions } from "@/lib/data/types";
import { Card } from "@/components/ui/Card";
import { RADIUS, modeColorLight } from "@/lib/ui/theme";
import { SessionStructureBanner } from "@/components/strength/SessionStructureBanner";
import { LoggerSheet } from "@/components/logger/LoggerSheet";
import { useExistingLoggerDraft } from "@/lib/logger/use-existing-draft";
import { useUserToday } from "@/lib/query/hooks/useUserToday";

function fmtRestRange(r: { min: number; max: number }): string {
  if (r.min >= 60 && r.max >= 90 && r.min % 60 === 0 && r.max % 60 === 0) {
    return `${r.min / 60}–${r.max / 60} min`;
  }
  return `${r.min}–${r.max} s`;
}

type Props = {
  plan: DailyPlan;
  committedFromPlan?: boolean;
  rirTarget?: number | null;
  researchPhase?: "accumulate" | "deload" | null;
  weekStart: string;
  weekday: string;
  userId: string;
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions?: SessionPrescriptions | null;
};

/** Light-theme session plan card for the strength page.
 *  Shows session type, mode intensity, description, and full exercise list. */
export function TodayPlanCard({ plan, committedFromPlan, rirTarget, researchPhase, weekStart, weekday, userId, weekOverrides, weekPrescriptions }: Props) {
  const accent = modeColorLight(plan.mode.color);
  const [loggerOpen, setLoggerOpen] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const canStartSession = plan.sessionType !== "REST";
  const hasDraft = useExistingLoggerDraft(userId, plan.sessionType, draftEpoch);
  const today = useUserToday(userId);

  // Pill text: prefer committed plan info if present.
  const pillText = committedFromPlan
    ? [
        researchPhase ? researchPhase.toUpperCase() : null,
        rirTarget != null ? `RIR ${rirTarget}` : null,
      ].filter(Boolean).join(" · ")
    : "DEFAULT — PLAN ON COACH ↗";
  const pillIsLink = !committedFromPlan;

  return (
    <>
    <Card
      background={accent}
      shadow={`0 12px 24px -8px ${accent}55`}
      style={{ color: "#fff", borderRadius: RADIUS.cardHero, padding: "16px 18px" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div
            style={{
              fontSize: "10px",
              opacity: 0.85,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Today&apos;s session
          </div>
          <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "2px" }}>
            {plan.sessionType === "REST" ? (
              "Rest day"
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Dumbbell size={14} aria-hidden="true" />
                {plan.sessionType}
              </span>
            )}
          </div>
        </div>
        {pillIsLink ? (
          <a
            href="/strength?tab=coach&mode=plan_week"
            style={{
              fontSize: "10px",
              padding: "4px 8px",
              background: "rgba(255,255,255,0.18)",
              borderRadius: "9999px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "#fff",
              textDecoration: "none",
            }}
          >
            {pillText}
          </a>
        ) : (
          <span
            style={{
              fontSize: "10px",
              padding: "4px 8px",
              background: "rgba(255,255,255,0.18)",
              borderRadius: "9999px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {pillText}
          </span>
        )}
      </div>
      <p style={{ fontSize: "12px", opacity: 0.85, marginTop: "8px", lineHeight: 1.4 }}>
        {plan.mode.desc}
      </p>

      {plan.structure && plan.structure.warnings.length > 0 && (
        <SessionStructureBanner
          structure={plan.structure}
          weekStart={weekStart}
          weekday={weekday}
          userId={userId}
        />
      )}

      {plan.sessionType !== "REST" && plan.exercises.length > 0 && (
        <div style={{ marginTop: "12px" }}>
          {plan.exercises.map((ex) => {
            const ann = plan.structure?.exercises.find((a) => a.name === ex.name) ?? null;
            return (
              <div
                key={ex.name}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "6px 0",
                  borderTop: "1px solid rgba(255,255,255,0.18)",
                  fontSize: "12px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.85 }}>
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
                          color: "#fff",
                          opacity: 0.7,
                          textDecoration: "underline",
                        }}
                      >
                        ▶ video
                      </a>
                    )}
                  </span>
                  <span data-tnum style={{ fontWeight: 600, opacity: 0.95 }}>
                    {ex.target}
                  </span>
                </div>
                {ann && (
                  <div
                    style={{
                      fontSize: 10,
                      opacity: 0.7,
                      fontFamily: "var(--font-dm-mono), monospace",
                      marginTop: 2,
                    }}
                  >
                    {fmtRestRange(ann.rest_seconds)} · {ann.rpe_target}
                  </div>
                )}
                {ann?.cue && (
                  <div
                    style={{
                      fontSize: 11,
                      fontStyle: "italic",
                      marginTop: 2,
                      opacity: 0.85,
                    }}
                  >
                    ⚠ {ann.cue}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canStartSession && (
        <button
          onClick={() => setLoggerOpen(true)}
          style={{
            width: "100%",
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            background: "#fff",
            color: "#0a0a0a",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {hasDraft ? "Resume session" : "Start session"}
        </button>
      )}
    </Card>
    {loggerOpen && today && (
      <LoggerSheet
        userId={userId}
        sessionType={plan.sessionType}
        date={today}
        weekdayLong={weekday}
        weekOverrides={weekOverrides}
        weekPrescriptions={weekPrescriptions ?? null}
        onClose={() => { setLoggerOpen(false); setDraftEpoch((e) => e + 1); }}
      />
    )}
    </>
  );
}
