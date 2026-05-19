"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type NutritionTargetsProposal = {
  kcal: number;
  macro_ratios: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios:  { breakfast: number; lunch: number; dinner: number; snacks: number };
  rationale: string;
};

export function NutritionTargetsProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: NutritionTargetsProposal;
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
              Targets applied
            </span>
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  const pct = (n: number) => Math.round(n * 100);
  const proteinG = Math.round((proposal.kcal * proposal.macro_ratios.protein_pct) / 4);
  const carbsG   = Math.round((proposal.kcal * proposal.macro_ratios.carbs_pct)   / 4);
  const fatG     = Math.round((proposal.kcal * proposal.macro_ratios.fat_pct)     / 9);

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>Proposed Targets</CoachCard.Eyebrow>
      <CoachCard.Body>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Row label="Daily kcal" value={fmtNum(proposal.kcal)} />
          <Row
            label="Macros"
            value={`${pct(proposal.macro_ratios.protein_pct)}% P · ${pct(proposal.macro_ratios.carbs_pct)}% C · ${pct(proposal.macro_ratios.fat_pct)}% F`}
            sub={`${fmtNum(proteinG)} P · ${fmtNum(carbsG)} C · ${fmtNum(fatG)} F (g)`}
          />
          <Row
            label="Meal split"
            value={`${pct(proposal.meal_ratios.breakfast)} / ${pct(proposal.meal_ratios.lunch)} / ${pct(proposal.meal_ratios.dinner)} / ${pct(proposal.meal_ratios.snacks)}`}
            sub="B / L / D / S"
          />
          {proposal.rationale && (
            <p
              style={{
                marginTop: 6,
                fontSize: 11,
                color: COLOR.textFaint,
                lineHeight: 1.4,
                fontStyle: "italic",
              }}
            >
              Why: {proposal.rationale}
            </p>
          )}
        </div>
      </CoachCard.Body>
      <CoachCard.Actions>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onApprove(approvalToken);
          }}
          style={{ ...btnPrimary, flex: 1, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
        >
          {busy ? "Applying…" : "Apply targets"}
        </button>
        <button
          type="button"
          onClick={onTweak}
          style={{ ...btnSecondary, flex: 1 }}
        >
          Tweak
        </button>
      </CoachCard.Actions>
    </CoachCard>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: COLOR.textMuted,
        }}
      >
        {label}
      </span>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: COLOR.textMuted }}>{sub}</div>}
      </div>
    </div>
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
