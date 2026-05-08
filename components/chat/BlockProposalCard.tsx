"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";

export type BlockProposal = {
  goal_text: string;
  primary_lift?: string;
  target_metric?: string;
  target_value?: number;
  target_unit?: string;
  start_date: string;
  end_date: string;
};

export function BlockProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: BlockProposal;
  approvalToken: string;
  onApprove: (token: string) => void;
  onTweak: () => void;
  committed?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  if (committed) {
    return (
      <div style={previewStyle}>
        <div style={{ color: "#16a34a", fontWeight: 700, fontSize: "13px" }}>
          ✓ Block created. Come back Sunday to plan week 1.
        </div>
      </div>
    );
  }

  return (
    <div style={previewStyle}>
      <div
        style={{
          fontSize: "12px",
          color: COLOR.textMuted,
          fontWeight: 700,
          letterSpacing: "0.06em",
        }}
      >
        PROPOSED BLOCK · 5 weeks
      </div>
      <div
        style={{
          marginTop: "8px",
          fontSize: "14px",
          fontWeight: 700,
          color: COLOR.textStrong,
        }}
      >
        {proposal.goal_text}
      </div>
      <div
        style={{
          marginTop: "6px",
          fontSize: "12px",
          color: COLOR.textMuted,
          lineHeight: 1.5,
        }}
      >
        {proposal.start_date} → {proposal.end_date}
        {proposal.primary_lift && ` · primary: ${proposal.primary_lift}`}
        {proposal.target_metric && proposal.target_value != null && (
          ` · target: ${proposal.target_value}${proposal.target_unit ?? "kg"} ${proposal.target_metric}`
        )}
      </div>

      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
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
