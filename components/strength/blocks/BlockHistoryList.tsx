// components/strength/blocks/BlockHistoryList.tsx
"use client";

import { useState } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { BlockRepoRow } from "@/lib/query/fetchers/blocksRepo";
import type { BlockPhaseAtEnd } from "@/lib/data/types";

type PhaseTag = { label: string; bg: string; fg: string };

const PHASE_TAGS: Record<BlockPhaseAtEnd, PhaseTag> = {
  hit_early:      { label: "HIT EARLY",      bg: COLOR.successSoft, fg: COLOR.success },
  hit_on_pace:    { label: "ON PACE",        bg: COLOR.successSoft, fg: COLOR.success },
  off_pace:       { label: "OFF PACE",       bg: COLOR.dangerSoft,  fg: COLOR.dangerDeep },
  underperformed: { label: "UNDERPERFORMED", bg: COLOR.warningSoft, fg: COLOR.warningDeep },
};

type Props = {
  rows: BlockRepoRow[];
};

export function BlockHistoryList({ rows }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fmtDate = (iso: string) => {
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };

  return (
    <div
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        border: `1px solid ${COLOR.divider}`,
        padding: "14px",
        marginBottom: 10,
        boxShadow: SHADOW.card,
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: COLOR.textMuted,
          marginBottom: 2,
        }}
      >
        Block history
      </div>

      {rows.length === 0 && (
        <div style={{ fontSize: 13, color: COLOR.textMuted, marginTop: 10 }}>
          No completed blocks yet.
        </div>
      )}

      {rows.map(({ block, outcome }, i) => {
        const isActive = block.status === "active";
        const isExpanded = expandedId === block.id;

        return (
          <div key={block.id}>
            {i === 0 && (
              <div style={{ borderTop: `1px solid ${COLOR.divider}`, marginTop: 9 }} />
            )}

            {/* Row header */}
            <div
              onClick={() => {
                if (isActive) return;
                setExpandedId(isExpanded ? null : block.id);
              }}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "11px 2px",
                borderTop: i > 0 ? `1px solid ${COLOR.divider}` : undefined,
                fontSize: 12.5,
                cursor: isActive ? "default" : "pointer",
              }}
            >
              <span>
                <span
                  style={{
                    fontWeight: 700,
                    textTransform: "uppercase",
                    fontSize: 12,
                    color: COLOR.textStrong,
                  }}
                >
                  {block.primary_lift ?? "—"}
                </span>
                <span style={{ color: COLOR.textMuted }}>
                  {" · "}
                  {isActive
                    ? `started ${fmtDate(block.start_date)}`
                    : `${fmtDate(block.start_date)} → ${fmtDate(block.end_date)}`}
                </span>
              </span>

              {isActive ? (
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    padding: "3px 9px",
                    borderRadius: RADIUS.full,
                    background: COLOR.accentSoft,
                    color: COLOR.accentDeep,
                  }}
                >
                  ACTIVE
                </span>
              ) : outcome ? (
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    padding: "3px 9px",
                    borderRadius: RADIUS.full,
                    background: PHASE_TAGS[outcome.block_phase_at_end].bg,
                    color: PHASE_TAGS[outcome.block_phase_at_end].fg,
                  }}
                >
                  {PHASE_TAGS[outcome.block_phase_at_end].label}
                  {outcome.target_hit_at_week != null && ` · WK ${outcome.target_hit_at_week}`}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: COLOR.textMuted }}>No outcome</span>
              )}
            </div>

            {/* Expanded content */}
            {isExpanded && outcome && (
              <div
                style={{
                  background: "#fbfbfe",
                  border: `1px solid ${COLOR.divider}`,
                  borderRadius: RADIUS.cardSmall,
                  padding: "11px 12px",
                  marginBottom: 9,
                }}
              >
                {/* Target/reached summary */}
                <div style={{ fontSize: 12, color: COLOR.textMid, lineHeight: 1.5 }}>
                  <span>{fmtDate(block.start_date)} → {fmtDate(block.end_date)}</span>
                  {" · "}
                  target{" "}
                  <strong style={{ color: COLOR.textStrong }}>
                    {outcome.target_value_kg != null
                      ? `${fmtNum(outcome.target_value_kg)} kg`
                      : "—"}
                  </strong>
                  {" "}{block.target_metric === "e1rm" ? "e1RM" : "working weight"}
                  {" → reached "}
                  <strong style={{ color: COLOR.textStrong }}>
                    {outcome.end_working_kg != null
                      ? `${fmtNum(outcome.end_working_kg)} kg`
                      : "—"}
                  </strong>
                  {outcome.lessons.gap_pct != null && (
                    <span>
                      {" "}({outcome.lessons.gap_pct > 0 ? "+" : ""}{fmtNum(outcome.lessons.gap_pct)}%)
                    </span>
                  )}
                </div>

                {/* Narrative paragraph */}
                {outcome.narrative_md && (
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.55,
                      color: COLOR.textMid,
                      background: COLOR.surfaceAlt,
                      borderRadius: 10,
                      padding: "10px 12px",
                      marginTop: 10,
                    }}
                  >
                    {outcome.narrative_md}
                  </div>
                )}

                {/* Secondary chips */}
                {outcome.lessons.secondary_lifts && outcome.lessons.secondary_lifts.length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    {outcome.lessons.secondary_lifts.map((sl) => (
                      <div
                        key={sl.lift}
                        style={{
                          flex: 1,
                          background: COLOR.surfaceAlt,
                          borderRadius: RADIUS.cardSmall,
                          padding: "7px 4px",
                          textAlign: "center",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: COLOR.textStrong,
                          }}
                        >
                          {sl.end_kg != null ? fmtNum(sl.end_kg) : "—"}
                        </div>
                        <div
                          style={{
                            fontSize: 9,
                            color: COLOR.textMuted,
                            textTransform: "uppercase",
                            fontWeight: 600,
                          }}
                        >
                          {sl.lift}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
