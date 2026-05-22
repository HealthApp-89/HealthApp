"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type SessionTemplateProposal = {
  session_type: string;
  exercises: PlannedExercise[];
  rationale: string;
};

export function SessionTemplateProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: SessionTemplateProposal;
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
          <div style={{ color: COLOR.success, fontWeight: 700, fontSize: 13 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Check size={14} strokeWidth={3} />
              {proposal.session_type} template saved
            </span>
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>
        {proposal.session_type} template · saves as your default
      </CoachCard.Eyebrow>
      <CoachCard.Body>
        <div>
          {proposal.exercises.map((ex, idx) => {
            const target = formatTarget(ex);
            return (
              <div
                key={`${ex.name}-${idx}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "3px 0",
                  fontSize: "12px",
                  color: COLOR.textStrong,
                }}
              >
                <span style={{ flex: 1 }}>{ex.name}</span>
                {target && (
                  <span style={{ color: COLOR.textMuted, marginLeft: 8 }}>{target}</span>
                )}
              </div>
            );
          })}
        </div>

        {proposal.rationale && (
          <p
            style={{
              fontSize: "11px",
              color: COLOR.textFaint,
              marginTop: "8px",
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
          style={{ ...btnPrimary, flex: 1 }}
        >
          Approve
        </button>
        <button onClick={onTweak} style={{ ...btnSecondary, flex: 1 }}>
          Tweak in chat
        </button>
      </CoachCard.Actions>
    </CoachCard>
  );
}

function formatTarget(ex: PlannedExercise): string {
  if (ex.reps) return ex.reps;
  const parts: string[] = [];
  if (ex.baseKg !== undefined) parts.push(`${ex.baseKg}kg`);
  if (ex.baseReps !== undefined && ex.sets !== undefined) {
    parts.push(`${ex.baseReps}×${ex.sets}`);
  } else if (ex.baseReps !== undefined) {
    parts.push(`${ex.baseReps} reps`);
  } else if (ex.sets !== undefined) {
    parts.push(`${ex.sets} sets`);
  }
  return parts.join(" · ");
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
