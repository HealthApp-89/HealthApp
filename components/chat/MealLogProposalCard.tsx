"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type MealLogProposalItem = {
  name: string;
  qty_g: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  source: "db" | "llm";
  db_ref: { source: string; canonical_id: string } | null;
  confidence: "high" | "medium" | "low" | null;
  library_item_id: string | null;
};

export type MealLogProposal = {
  items: MealLogProposalItem[];
  meal_slot: "breakfast" | "lunch" | "dinner" | "snack";
  eaten_at: string;
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
};

const SLOT_LABEL: Record<MealLogProposal["meal_slot"], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

function sourceBadge(item: MealLogProposalItem): string {
  if (item.library_item_id) return "library";
  if (item.db_ref?.source === "usda") return "USDA";
  if (item.db_ref?.source === "openfoodfacts") return "OFF";
  if (item.db_ref?.source) return item.db_ref.source;
  return "est."; // LLM fallback
}

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
  padding: "8px 12px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px",
  background: COLOR.surface,
  color: COLOR.textStrong,
  fontWeight: 600,
  fontSize: "12px",
  cursor: "pointer",
};

export function MealLogProposalCard({
  proposal,
  approvalToken,
  onApprove,
  onTweak,
  committed,
}: {
  proposal: MealLogProposal;
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
              Logged to {SLOT_LABEL[proposal.meal_slot]}
            </span>
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            {fmtNum(proposal.totals.kcal)} kcal · {fmtNum(proposal.totals.protein_g)}P / {fmtNum(proposal.totals.carbs_g)}C / {fmtNum(proposal.totals.fat_g)}F
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>Log to {SLOT_LABEL[proposal.meal_slot]}</CoachCard.Eyebrow>
      <CoachCard.Body>
        <div>
          {proposal.items.map((it, idx) => (
            <div
              key={`${it.name}-${idx}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "4px 0",
                fontSize: 12,
                color: COLOR.textStrong,
                borderBottom:
                  idx < proposal.items.length - 1
                    ? `1px solid ${COLOR.divider}`
                    : "none",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.name}
                </div>
                <div style={{ fontSize: 10, color: COLOR.textFaint, marginTop: 2 }}>
                  {fmtNum(it.qty_g)}g · {sourceBadge(it)}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: COLOR.textMuted,
                  textAlign: "right",
                  whiteSpace: "nowrap",
                }}
              >
                {fmtNum(it.kcal)} kcal
                <div style={{ fontSize: 10, color: COLOR.textFaint }}>
                  {fmtNum(it.protein_g)}P / {fmtNum(it.carbs_g)}C / {fmtNum(it.fat_g)}F
                </div>
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: `1px solid ${COLOR.divider}`,
            fontSize: 12,
            color: COLOR.textStrong,
            fontWeight: 600,
          }}
        >
          Total: {fmtNum(proposal.totals.kcal)} kcal · {fmtNum(proposal.totals.protein_g)}P /{" "}
          {fmtNum(proposal.totals.carbs_g)}C / {fmtNum(proposal.totals.fat_g)}F
        </div>
      </CoachCard.Body>

      <CoachCard.Actions>
        <button
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            onApprove(approvalToken);
          }}
          style={{ ...btnPrimary, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
        >
          {busy ? "Logging…" : "Approve"}
        </button>
        <button onClick={onTweak} style={btnSecondary}>
          Tweak
        </button>
      </CoachCard.Actions>
    </CoachCard>
  );
}
