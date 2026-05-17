"use client";

import React from "react";
import Link from "next/link";
import { Dumbbell, Apple, Ruler, X } from "lucide-react";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Bottom sheet launched by the sticky "+ Log entry" button on /metrics.
 * Houses three quick-log entry points (lift, meal, body measurement);
 * each link carries a `?log=…` marker that sub-pill pages can react to
 * and auto-open the relevant form. Wiring the auto-open is downstream
 * of Slice 7; the marker just has to exist.
 */
export function LogEntrySheet({ open, onClose }: Props) {
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
          <Row
            icon={<Dumbbell size={18} aria-hidden="true" />}
            label="Lift / workout"
            href="/metrics?sub=strength&log=lift"
            onClick={onClose}
          />
          <Row
            icon={<Apple size={18} aria-hidden="true" />}
            label="Meal"
            href="/metrics?sub=trends&log=meal"
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

function Row({
  icon,
  label,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  href: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      style={{
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
      }}
    >
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
      {label}
    </Link>
  );
}
