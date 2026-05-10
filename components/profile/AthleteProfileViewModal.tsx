"use client";
import { COLOR } from "@/lib/ui/theme";

export function AthleteProfileViewModal({
  rendered_md,
  onClose,
  title,
}: {
  rendered_md: string;
  onClose: () => void;
  title: string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 14,
          padding: 18,
          maxWidth: 640,
          width: "100%",
          maxHeight: "90dvh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: COLOR.textMuted,
              fontSize: 24,
              lineHeight: 1,
              cursor: "pointer",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontFamily: "DM Mono, ui-monospace, monospace",
            fontSize: 13,
            lineHeight: 1.6,
            color: COLOR.textStrong,
            overflowY: "auto",
            margin: 0,
          }}
        >{rendered_md}</pre>
      </div>
    </div>
  );
}
