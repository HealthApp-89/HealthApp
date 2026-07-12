"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

/** Shape of executeProposeCloseBlock's result.preview. would_be_outcome is
 *  the prospective block_outcomes payload (no id/timestamps yet); typed
 *  loosely here because the card renders defensively field-by-field. */
export type CloseBlockProposal = {
  blockId: string;
  primary_lift?: string | null;
  target_value?: number | null;
  reason: string;
  would_be_outcome?: {
    block_phase_at_end?: string;
    end_working_kg?: number | null;
    target_hit_at_week?: number | null;
    recommended_next_focus?: string | null;
    recommended_target_value_kg?: number | null;
  };
};

export function CloseBlockProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: CloseBlockProposal;
  approvalToken: string;
  onApprove: (token: string) => void;
  onTweak: () => void;
  committed?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  if (committed) {
    return (
      <div style={previewStyle}>
        <div
          style={{
            color: COLOR.success,
            fontWeight: 700,
            fontSize: "13px",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Check size={14} strokeWidth={3} aria-hidden="true" />
          Block closed. Ready to set up the next one.
        </div>
      </div>
    );
  }

  const o = proposal.would_be_outcome;

  return (
    <div style={previewStyle}>
      <div
        style={{
          fontSize: "12px",
          color: COLOR.textMuted,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        CLOSE BLOCK{proposal.primary_lift ? ` · ${proposal.primary_lift}` : ""}
      </div>
      <div
        style={{
          marginTop: "8px",
          fontSize: "14px",
          fontWeight: 700,
          color: COLOR.textStrong,
        }}
      >
        {proposal.reason}
      </div>
      <div
        style={{
          marginTop: "6px",
          fontSize: "12px",
          color: COLOR.textMuted,
          lineHeight: 1.5,
        }}
      >
        {proposal.target_value != null && `Target ${fmtNum(proposal.target_value)} kg`}
        {o?.end_working_kg != null && ` · reached ${fmtNum(o.end_working_kg)} kg`}
        {o?.target_hit_at_week != null && ` (week ${o.target_hit_at_week})`}
        {o?.block_phase_at_end && ` · ${o.block_phase_at_end.replace(/_/g, " ")}`}
        {o?.recommended_next_focus && (
          <>
            <br />
            Next up: {o.recommended_next_focus}
            {o.recommended_target_value_kg != null &&
              ` · suggested target ${fmtNum(o.recommended_target_value_kg)} kg`}
          </>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" }}>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onApprove(approvalToken);
          }}
          style={btnPrimary}
        >
          Approve close
        </button>
        <button onClick={onTweak} style={btnSecondary}>
          Tweak in chat
        </button>
      </div>
    </div>
  );
}

const previewStyle: React.CSSProperties = {
  background: COLOR.surfaceAlt,
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "12px",
  padding: "12px 14px",
  marginTop: "8px",
};
const btnPrimary: React.CSSProperties = {
  flex: 1,
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
  flex: 1,
  padding: "8px 12px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px",
  background: COLOR.surface,
  color: COLOR.textStrong,
  fontWeight: 600,
  fontSize: "12px",
  cursor: "pointer",
};
