"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { COLOR, GRADIENT } from "@/lib/ui/theme";
import { useLabAcknowledgments, useAckLabItem } from "@/lib/query/hooks/useLabAcknowledgments";

type LabItem = {
  key: string;
  label: string;
  detail: string;
};

const ITEMS: LabItem[] = [
  { key: "b12_baseline",       label: "B12",                detail: "Baseline + 6mo" },
  { key: "vit_d_baseline",     label: "Vitamin D",          detail: "Baseline + 6mo" },
  { key: "magnesium_baseline", label: "Magnesium",          detail: "Baseline + 6mo" },
  { key: "ferritin_baseline",  label: "Ferritin",           detail: "Baseline + 6mo" },
  { key: "grip_strength_q",    label: "Grip strength",      detail: "Quarterly — function decline precedes mass decline" },
  { key: "bone_density_12mo",  label: "Bone density (DXA)", detail: "If cut extends >12 months" },
];

export function LabPromptCard({ userId }: { userId: string }) {
  const { data: acks = {} } = useLabAcknowledgments(userId);
  const ackMut = useAckLabItem(userId);

  const pendingCount = useMemo(
    () => ITEMS.filter((it) => !acks[it.key]).length,
    [acks],
  );

  if (pendingCount === 0) return null;

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {/* Hero amber band */}
      <div
        style={{
          background: GRADIENT.heroAmber,
          color: "#fff",
          padding: "14px 16px",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            opacity: 0.9,
          }}
        >
          Lab check-ups
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
          Ask your doctor at the next check-up
        </div>
        <div style={{ fontSize: 12, opacity: 0.9, marginTop: 6, lineHeight: 1.4 }}>
          Standard GLP-1 monitoring is loose. These checks fill the gap.
        </div>
      </div>

      {/* Item rows */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {ITEMS.map((it) => {
          const ackedOn = acks[it.key];
          const acked = !!ackedOn;
          return (
            <li
              key={it.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                borderTop: `1px solid ${COLOR.divider}`,
                opacity: acked ? 0.5 : 1,
                transition: "opacity 150ms ease-out",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (acked || ackMut.isPending) return;
                  ackMut.mutate({ key: it.key, ackedOn: new Date().toISOString().slice(0, 10) });
                }}
                disabled={ackMut.isPending}
                aria-label={acked ? `${it.label} acknowledged` : `Mark ${it.label} as acknowledged`}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: `1.5px solid ${acked ? COLOR.success : COLOR.divider}`,
                  background: acked ? COLOR.success : "transparent",
                  color: "#fff",
                  cursor: acked ? "default" : "pointer",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                {acked ? <Check size={14} strokeWidth={3} /> : null}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>
                  {it.label}
                </div>
                <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2, lineHeight: 1.4 }}>
                  {it.detail}
                </div>
              </div>
              {acked && ackedOn ? (
                <div
                  style={{
                    fontSize: 10,
                    color: COLOR.success,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {ackedOn}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
