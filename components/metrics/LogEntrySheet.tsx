"use client";

import React from "react";
import Link from "next/link";
import { ClipboardList, Dumbbell, Ruler, Utensils, X } from "lucide-react";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * Optional callback for the "Log meal" row. When provided, the row is
   * rendered and tapping it closes this sheet + invokes the callback so the
   * parent can open the MealLoggerSheet. Omitted on screens that don't
   * mount MealLoggerSheet.
   */
  onMealClick?: () => void;
};

/**
 * Bottom sheet launched by the sticky "+ Log entry" button on /metrics.
 * Four entry points: meal (sibling sheet), daily metrics (all daily_logs
 * fields), lift workout, body measurement. The `?log=…` marker on the lift
 * + body links is a hint that sub-pill pages can react to and auto-open the
 * relevant form. Daily metrics lands on the Log sub-pill which is a
 * fully-functional editor.
 */
export function LogEntrySheet({ open, onClose, onMealClick }: Props) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,20,48,0.45)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLOR.bg,
          width: "100%",
          maxWidth: 560,
          padding: 18,
          borderRadius: "20px 20px 0 0",
          paddingBottom: "max(18px, env(safe-area-inset-bottom))",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700 }}>Log entry</div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: COLOR.textMuted,
              cursor: "pointer",
              padding: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {onMealClick && (
            <Row
              icon={<Utensils size={18} aria-hidden="true" />}
              label="Log meal"
              onClick={() => {
                onClose();
                onMealClick();
              }}
            />
          )}
          <Row
            icon={<ClipboardList size={18} aria-hidden="true" />}
            label="Daily metrics"
            href="/metrics?sub=log"
            onClick={onClose}
          />
          <Row
            icon={<Dumbbell size={18} aria-hidden="true" />}
            label="Lift / workout"
            href="/metrics?sub=strength&log=lift"
            onClick={onClose}
          />
          <Row
            icon={<Ruler size={18} aria-hidden="true" />}
            label="Body measurement"
            href="/metrics?sub=body&log=measurement"
            onClick={onClose}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Row variants:
 *   - When `href` is provided → renders a Link (navigation row).
 *   - When `href` is omitted  → renders a button (action-only row, e.g. opens
 *     a sibling sheet like MealLoggerSheet without navigating).
 * Both share identical styling.
 */
function Row({
  icon,
  label,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  onClick: () => void;
}) {
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "14px 16px",
    background: COLOR.surface,
    borderRadius: RADIUS.card,
    textDecoration: "none",
    color: COLOR.textStrong,
    fontSize: 15,
    fontWeight: 600,
  };
  const iconBubble = (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: 10,
        background: COLOR.accentSoft,
        color: COLOR.accent,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon}
    </span>
  );
  if (href) {
    return (
      <Link href={href} onClick={onClick} style={rowStyle}>
        {iconBubble}
        {label}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...rowStyle,
        border: "none",
        width: "100%",
        textAlign: "left",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      {iconBubble}
      {label}
    </button>
  );
}
