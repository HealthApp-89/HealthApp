"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type RangeOption = {
  /** Stable id used in URLs (`30d`, `today`, etc.). */
  id: string;
  /** Display label (`30D`, `Today`). */
  label: string;
  /** href the pill links to. */
  href: string;
};

type RangePillsProps = {
  options: RangeOption[];
  /** Currently active option id. */
  active: string;
  /** Optional callback when a pill is tapped (e.g. for optimistic updates). */
  onSelect?: (id: string) => void;
};

export function RangePills({ options, active, onSelect }: RangePillsProps) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: "6px",
      }}
    >
      {options.map((opt) => {
        const isActive = opt.id === active;
        const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          onSelect?.(opt.id);
        };
        return (
          <Link
            key={opt.id}
            href={opt.href}
            scroll={false}
            onClick={onClick}
            role="tab"
            aria-selected={isActive}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              fontSize: "12px",
              fontWeight: 600,
              color: isActive ? "#fff" : COLOR.textMuted,
              background: isActive ? COLOR.accent : COLOR.surface,
              borderRadius: RADIUS.pill,
              boxShadow: isActive ? SHADOW.heroAccent : SHADOW.card,
              textDecoration: "none",
              letterSpacing: "0.02em",
              transition: "background 120ms, color 120ms",
            }}
          >
            {opt.label}
          </Link>
        );
      })}
    </div>
  );
}
