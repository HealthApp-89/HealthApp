"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { COLOR } from "@/lib/ui/theme";

/** Shape of executeProposeEnduranceWeek's result.preview (EnduranceWeekPayload).
 *  plan keys are weekday numbers 0=Sun..6=Sat (Date#getDay convention). */
type SessionEntry = {
  type?: string;
  sport?: string;
  duration_min?: number;
  hr_cap?: number;
  hr_target_range?: [number, number];
  description?: string;
};

export type EnduranceWeekProposal = {
  week_start: string;
  plan: Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6" | 0 | 1 | 2 | 3 | 4 | 5 | 6, SessionEntry>>;
  rationale?: string;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function EnduranceWeekProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: EnduranceWeekProposal;
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
          Endurance week committed.
        </div>
      </div>
    );
  }

  const sessions = Object.entries(proposal.plan ?? {})
    .map(([day, s]) => ({ day: Number(day), entry: (s ?? {}) as SessionEntry }))
    .filter((s) => Number.isFinite(s.day) && s.day >= 0 && s.day <= 6)
    .sort((a, b) => a.day - b.day);

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
        PROPOSED ENDURANCE WEEK · {proposal.week_start}
      </div>
      <div
        style={{
          marginTop: "8px",
          fontSize: "13px",
          color: COLOR.textStrong,
          lineHeight: 1.6,
        }}
      >
        {sessions.length === 0 && "No sessions in plan."}
        {sessions.map(({ day, entry }) => (
          <div key={day}>
            <strong>{WEEKDAY_LABELS[day]}</strong>
            {entry.sport && ` · ${entry.sport}`}
            {entry.type && ` ${entry.type.replace(/_/g, " ")}`}
            {entry.duration_min != null && ` · ${entry.duration_min} min`}
            {entry.hr_cap != null && ` · HR ≤${entry.hr_cap}`}
            {entry.hr_target_range && ` · HR ${entry.hr_target_range[0]}–${entry.hr_target_range[1]}`}
          </div>
        ))}
      </div>
      {proposal.rationale && (
        <div
          style={{
            marginTop: "6px",
            fontSize: "12px",
            color: COLOR.textMuted,
            lineHeight: 1.5,
          }}
        >
          {proposal.rationale}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" }}>
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
