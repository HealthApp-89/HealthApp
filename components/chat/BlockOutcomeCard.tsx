// components/chat/BlockOutcomeCard.tsx
"use client";

import Link from "next/link";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { BlockOutcome, BlockPhaseAtEnd, PrimaryLift } from "@/lib/data/types";

type Props = {
  outcome: BlockOutcome;
};

type PhaseTag = { label: string; bg: string; fg: string };

const PHASE_TAGS: Record<BlockPhaseAtEnd, PhaseTag> = {
  hit_early:      { label: "HIT EARLY",      bg: COLOR.successSoft, fg: COLOR.success },
  hit_on_pace:    { label: "ON PACE",        bg: COLOR.successSoft, fg: COLOR.success },
  off_pace:       { label: "OFF PACE",       bg: COLOR.dangerSoft,  fg: COLOR.dangerDeep },
  underperformed: { label: "UNDERPERFORMED", bg: COLOR.warningSoft, fg: COLOR.warningDeep },
};

const PHASE_TONE: Record<BlockPhaseAtEnd, "ok" | "alert" | "accent"> = {
  hit_early: "ok",
  hit_on_pace: "ok",
  off_pace: "alert",
  underperformed: "accent",
};

function liftLabel(lift: PrimaryLift | null): string {
  if (!lift) return "—";
  return lift.toUpperCase();
}

export function BlockOutcomeCard({ outcome }: Props) {
  const tag = PHASE_TAGS[outcome.block_phase_at_end];
  const tone = PHASE_TONE[outcome.block_phase_at_end];
  const lessons = outcome.lessons;

  const recommendedFocus = outcome.recommended_next_focus;
  const recommendedTarget = outcome.recommended_target_value_kg;

  const startHref =
    recommendedFocus != null
      ? `/strength?tab=blocks&prefill_focus=${recommendedFocus}${
          recommendedTarget != null ? `&prefill_target=${recommendedTarget}` : ""
        }`
      : "/strength?tab=blocks";

  return (
    <div style={{ padding: "6px 12px" }}>
      <CoachCard tone={tone}>
        <CoachCard.Eyebrow>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              justifyContent: "space-between",
            }}
          >
            <span>BLOCK COMPLETE</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.06em",
                padding: "3px 8px",
                background: tag.bg,
                color: tag.fg,
                borderRadius: 9999,
              }}
            >
              {tag.label}
            </span>
          </span>
        </CoachCard.Eyebrow>

        <CoachCard.Title>
          <span style={{ textTransform: "capitalize" }}>
            {outcome.primary_lift} focus
          </span>
        </CoachCard.Title>

        <CoachCard.Body>
          <div
            style={{
              fontSize: 13,
              color: COLOR.textMid,
              lineHeight: 1.5,
            }}
          >
            Target:{" "}
            <strong style={{ color: COLOR.textStrong }}>
              {outcome.target_value_kg != null
                ? `${fmtNum(outcome.target_value_kg)} kg`
                : "—"}
            </strong>
            {" · "}
            Reached:{" "}
            <strong style={{ color: COLOR.textStrong }}>
              {outcome.end_working_kg != null
                ? `${fmtNum(outcome.end_working_kg)} kg`
                : "—"}
            </strong>
            {lessons.observed_step_kg_per_wk != null && (
              <>
                {" · "}
                Observed step:{" "}
                <strong style={{ color: COLOR.textStrong }}>
                  +{fmtNum(lessons.observed_step_kg_per_wk)} kg/wk
                </strong>
              </>
            )}
          </div>

          {lessons.calibration_note && (
            <div
              style={{
                marginTop: 10,
                fontSize: 13,
                color: COLOR.textMid,
                fontStyle: "italic",
                lineHeight: 1.5,
              }}
            >
              {lessons.calibration_note}
            </div>
          )}

          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${COLOR.divider}`,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: COLOR.textMuted,
              }}
            >
              NEXT BLOCK RECOMMENDATION
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 14,
                fontWeight: 600,
                color: COLOR.textStrong,
              }}
            >
              <span style={{ textTransform: "capitalize" }}>
                {recommendedFocus ?? "—"} focus
              </span>
              {recommendedTarget != null && (
                <span style={{ color: COLOR.textMid, fontWeight: 500 }}>
                  {" · target "}
                  {fmtNum(recommendedTarget)} kg
                </span>
              )}
            </div>
          </div>
        </CoachCard.Body>

        <CoachCard.Actions>
          <div style={{ display: "flex", gap: 8, width: "100%", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Link
                href={startHref}
                style={{
                  flex: 1,
                  textAlign: "center",
                  padding: "10px 14px",
                  borderRadius: 9999,
                  background: COLOR.accent,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                Start{recommendedFocus ? ` ${liftLabel(recommendedFocus)}` : ""} block
              </Link>
              <Link
                href="/strength?tab=blocks"
                style={{
                  flex: 1,
                  textAlign: "center",
                  padding: "10px 14px",
                  borderRadius: 9999,
                  background: COLOR.surfaceAlt,
                  color: COLOR.textMid,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                  border: `1px solid ${COLOR.divider}`,
                }}
              >
                Different priority
              </Link>
            </div>
            <Link
              href="/coach/trends?section=performance#block-history"
              style={{
                alignSelf: "flex-end",
                fontSize: 11,
                color: COLOR.textMuted,
                textDecoration: "underline",
              }}
            >
              View full block history →
            </Link>
          </div>
        </CoachCard.Actions>
      </CoachCard>
    </div>
  );
}
