"use client";

import { useState } from "react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import type { Weekday } from "@/lib/data/types";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type WeekProposal = {
  week_start: string;
  session_plan: Record<string, string>;
  weekly_focus?: string;
  intensity_modifier?: Record<string, number>;
  rir_target?: number;
  research_phase?: "accumulate" | "deload";
  rationale?: string;
};

export function WeekPlanProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: WeekProposal;
  approvalToken: string;
  onApprove: (token: string) => void;
  onTweak: () => void;
  committed?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  if (committed) {
    return (
      <CoachCard tone="ok">
        <CoachCard.Body>
          <div style={{ color: "#16a34a", fontWeight: 700, fontSize: 13 }}>
            ✓ Plan committed for {proposal.week_start}
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>Proposed Plan · {proposal.week_start}</CoachCard.Eyebrow>
      <CoachCard.Body>
        <div>
          {ORDER.map((d) => {
            const t = readSessionForDay(proposal.session_plan, d) ?? "—";
            const isRest = t.toLowerCase().includes("rest") || t === "—";
            return (
              <div
                key={d}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "3px 0",
                  fontSize: "12px",
                  color: isRest ? COLOR.textFaint : COLOR.textStrong,
                  fontStyle: isRest ? "italic" : "normal",
                }}
              >
                <span style={{ width: "44px", fontWeight: 600 }}>{d}</span>
                <span style={{ flex: 1 }}>{t}</span>
                {proposal.rir_target !== undefined && !isRest && (
                  <span style={{ color: COLOR.textMuted }}>RIR {proposal.rir_target}</span>
                )}
              </div>
            );
          })}
        </div>

        {proposal.weekly_focus && (
          <p
            style={{
              fontSize: "12px",
              color: COLOR.textMuted,
              marginTop: "10px",
              lineHeight: 1.4,
            }}
          >
            <strong style={{ color: COLOR.textStrong }}>Focus:</strong> {proposal.weekly_focus}
          </p>
        )}
        {proposal.rationale && (
          <p
            style={{
              fontSize: "11px",
              color: COLOR.textFaint,
              marginTop: "4px",
              lineHeight: 1.4,
              fontStyle: "italic",
            }}
          >
            Why: {proposal.rationale}
          </p>
        )}
      </CoachCard.Body>

      <CoachCard.Actions>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onApprove(approvalToken);
          }}
          style={btnPrimary}
        >
          Approve
        </button>
        <button onClick={onTweak} style={btnSecondary}>
          Tweak in chat
        </button>
      </CoachCard.Actions>
    </CoachCard>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: "8px 12px",
  border: "none",
  borderRadius: "9999px",
  background: COLOR.accent,
  color: "#fff",
  fontWeight: 700,
  fontSize: "12px",
  cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px",
  background: COLOR.surface,
  color: COLOR.textStrong,
  fontWeight: 600,
  fontSize: "12px",
  cursor: "pointer",
};
