"use client";
import { useMemo } from "react";
import { COLOR } from "@/lib/ui/theme";
import { Card } from "@/components/ui/Card";
import { useLabAcknowledgments, useAckLabItem } from "@/lib/query/hooks/useLabAcknowledgments";

type LabItem = {
  key: string;
  label: string;
  detail: string;
  category: "baseline" | "6mo" | "quarterly" | "yearly";
};

const ITEMS: LabItem[] = [
  { key: "b12_baseline", label: "B12", detail: "Baseline + 6mo", category: "baseline" },
  { key: "vit_d_baseline", label: "Vitamin D", detail: "Baseline + 6mo", category: "baseline" },
  { key: "magnesium_baseline", label: "Magnesium", detail: "Baseline + 6mo", category: "baseline" },
  { key: "ferritin_baseline", label: "Ferritin", detail: "Baseline + 6mo", category: "baseline" },
  { key: "grip_strength_q", label: "Grip strength", detail: "Quarterly — cheap dynamometer, function decline often precedes mass decline", category: "quarterly" },
  { key: "bone_density_12mo", label: "Bone density (DXA)", detail: "If cut extends >12 months — SELECT trial fracture-risk signal", category: "yearly" },
];

export function LabPromptCard({ userId }: { userId: string }) {
  const { data: acks = {} } = useLabAcknowledgments(userId);
  const ackMut = useAckLabItem(userId);

  const pending = useMemo(
    () => ITEMS.filter((it) => !acks[it.key]),
    [acks],
  );

  if (pending.length === 0) return null;

  return (
    <Card variant="compact" style={{ borderColor: COLOR.accent }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
          Ask your doctor at the next check-up
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted }}>
          Standard GLP-1 monitoring is loose. These checks fill the gap.
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {pending.map((it) => (
            <li key={it.key} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <button
                type="button"
                onClick={() => ackMut.mutate({ key: it.key, ackedOn: new Date().toISOString().slice(0, 10) })}
                disabled={ackMut.isPending}
                style={{
                  background: "transparent",
                  border: `1px solid ${COLOR.divider}`,
                  borderRadius: 4,
                  width: 18, height: 18,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                aria-label={`Mark ${it.label} as acknowledged`}
              />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLOR.textStrong }}>{it.label}</div>
                <div style={{ fontSize: 11, color: COLOR.textMid }}>{it.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
