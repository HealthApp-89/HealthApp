"use client";
import { COLOR } from "@/lib/ui/theme";

export function WizardNav({
  step,
  totalSteps,
  onBack,
  onNext,
  nextLabel = "Next",
  nextDisabled = false,
}: {
  step: number;
  totalSteps: number;
  onBack: (() => void) | null;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 24 }}>
      <div style={{ fontSize: 11, color: COLOR.textMuted, textAlign: "center" }}>
        Step {step} of {totalSteps}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onBack ?? undefined}
          disabled={!onBack}
          style={{
            flex: 1,
            padding: "12px 16px",
            background: "transparent",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            color: COLOR.textMuted,
            fontWeight: 600,
            cursor: onBack ? "pointer" : "not-allowed",
            opacity: onBack ? 1 : 0.4,
          }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          style={{
            flex: 2,
            padding: "12px 16px",
            background: nextDisabled ? COLOR.divider : COLOR.accent,
            border: "none",
            borderRadius: 10,
            color: "#fff",
            fontWeight: 700,
            cursor: nextDisabled ? "not-allowed" : "pointer",
          }}
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
