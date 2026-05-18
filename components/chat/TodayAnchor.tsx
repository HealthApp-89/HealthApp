"use client";

import React from "react";
import Link from "next/link";
import { AlertTriangle, ChevronRight, RefreshCw } from "lucide-react";
import { COLOR, RADIUS } from "@/lib/ui/theme";

export type AnchorBrief = {
  /** Short label for today's session (e.g. "Push Day", "Legs", "REST"). */
  sessionLabel: string | null;
  /** Subjective readiness score from checkins.readiness (1-10). null when
   *  the brief hasn't been delivered yet or the score is unavailable. */
  readinessScore: number | null;
  /** One-line summary of the top exercises ("Squat 100kg · Bench 80kg"). */
  summaryLine: string | null;
  /** Protein floor for the day (g). null when the active plan/intake doesn't
   *  define one or no brief has been delivered. */
  proteinFloor_g: number | null;
};

type Props = {
  /** When the user's intake state for today is one of these, the anchor adapts: */
  intakeState:
    | "brief_delivered"
    | "brief_failed"
    | "assembling_brief"
    | "awaiting"
    | "missing"
    | null;
  brief: AnchorBrief | null;
  onTapBrief?: () => void;
  /** Tapping the "Morning check-in pending" pill calls this. When undefined,
   *  the pill renders as a non-interactive div. */
  onStartIntake?: () => void;
};

/**
 * TodayAnchor — sticky card pinned above the chat thread on /coach. Surfaces
 * the current session, readiness band, and protein floor so the athlete sees
 * today's plan even after scrolling far back in chat history.
 *
 * State-aware:
 * - brief_failed → red-bordered retry chip that deep-links `?retry=brief`
 *   (Slice 3 deleted BriefStateChip from the dashboard; this restores the
 *   recovery surface on /coach).
 * - assembling_brief → muted "Assembling today's brief…" placeholder.
 * - missing/awaiting → faint "Morning check-in pending" hint.
 * - brief_delivered → full happy-path card.
 */
export function TodayAnchor({ intakeState, brief, onTapBrief, onStartIntake }: Props) {
  // brief_failed → retry chip variant
  if (intakeState === "brief_failed") {
    return (
      <Link
        href="/coach?retry=brief"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderLeft: `3px solid ${COLOR.danger}`,
          borderRadius: RADIUS.card,
          padding: "10px 12px",
          margin: "8px 12px 12px",
          textDecoration: "none",
          color: COLOR.textStrong,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <AlertTriangle size={16} color={COLOR.danger} aria-hidden="true" />
        <span style={{ flex: 1 }}>Today&rsquo;s brief failed &mdash; tap to retry</span>
        <RefreshCw size={14} aria-hidden="true" />
      </Link>
    );
  }

  // assembling → in-progress
  if (intakeState === "assembling_brief") {
    return (
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: RADIUS.card,
          padding: "10px 12px",
          margin: "8px 12px 12px",
          fontSize: 12,
          color: COLOR.textMuted,
        }}
      >
        Assembling today&rsquo;s brief&hellip;
      </div>
    );
  }

  // No brief yet (missing or awaiting). Interactive when the parent provides
  // an onStartIntake callback (drops the user into morning intake kind);
  // otherwise informational only.
  if (!brief || brief.sessionLabel == null) {
    const baseStyle: React.CSSProperties = {
      position: "sticky",
      top: 0,
      zIndex: 5,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: COLOR.surface,
      border: `1px solid ${COLOR.divider}`,
      borderRadius: RADIUS.card,
      padding: "10px 12px",
      margin: "8px 12px 12px",
      color: COLOR.textMuted,
      fontSize: 12,
    };
    if (onStartIntake) {
      return (
        <button
          type="button"
          onClick={onStartIntake}
          style={{ ...baseStyle, width: "calc(100% - 24px)", border: `1px solid ${COLOR.divider}`, cursor: "pointer", textAlign: "left", font: "inherit" }}
        >
          <span>Morning check-in pending</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      );
    }
    return <div style={baseStyle}>Morning check-in pending</div>;
  }

  // Happy path — brief_delivered with content
  const hasContent = brief.sessionLabel != null || brief.readinessScore != null;
  return (
    <div
      onClick={onTapBrief}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        padding: "10px 12px",
        margin: "8px 12px 12px",
        cursor: onTapBrief ? "pointer" : "default",
        boxShadow: "0 1px 2px rgba(15,20,48,0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: COLOR.accent,
          }}
        >
          Today
        </span>
        {brief.readinessScore != null && (
          <span style={{ fontSize: 13, fontWeight: 700, color: COLOR.accent }}>
            {brief.readinessScore}{" "}
            <span
              style={{
                fontSize: 9,
                color: COLOR.textMuted,
                fontWeight: 600,
              }}
            >
              / 10
            </span>
          </span>
        )}
      </div>
      {hasContent ? (
        <>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginTop: 4,
              color: COLOR.textStrong,
            }}
          >
            {brief.sessionLabel ?? "—"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: COLOR.textMuted,
              marginTop: 2,
            }}
          >
            {brief.summaryLine ?? ""}
            {brief.proteinFloor_g != null && (
              <>
                {brief.summaryLine ? " · " : ""}
                <strong style={{ color: COLOR.textStrong }}>
                  P {brief.proteinFloor_g}g floor
                </strong>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
