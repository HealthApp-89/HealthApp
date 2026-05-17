import React from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type Tone = "default" | "alert" | "ok" | "accent";

const TONE_ACCENT_BAR: Record<Tone, string> = {
  default: COLOR.textMuted,
  alert:   COLOR.danger,
  ok:      COLOR.success,
  accent:  COLOR.accent,
};

type RootProps = {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
};

function Root({ tone = "default", children, className }: RootProps) {
  return (
    <div
      className={className}
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.card,
        overflow: "hidden",
        position: "relative",
        borderLeft: `3px solid ${TONE_ACCENT_BAR[tone]}`,
      }}
    >
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: COLOR.textMuted,
        padding: "14px 16px 0",
      }}
    >
      {children}
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 18,
        fontWeight: 700,
        color: COLOR.textStrong,
        padding: "4px 16px 0",
        lineHeight: 1.25,
      }}
    >
      {children}
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "10px 16px 14px" }}>{children}</div>;
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "0 16px 16px",
        justifyContent: "flex-end",
      }}
    >
      {children}
    </div>
  );
}

export const CoachCard = Object.assign(Root, { Eyebrow, Title, Body, Actions });
