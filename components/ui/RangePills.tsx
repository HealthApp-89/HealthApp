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
  /**
   * If provided, pill clicks call this and DO NOT navigate. URL-mode (the
   * current /trends/[metric] sub-page) leaves this undefined and the
   * underlying <Link> performs a normal client-side navigation.
   */
  onChange?: (id: string) => void;
};

export function RangePills({ options, active, onChange }: RangePillsProps) {
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
          if (onChange) {
            e.preventDefault();
            onChange(opt.id);
          }
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
