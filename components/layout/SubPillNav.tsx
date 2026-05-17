"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { COLOR } from "@/lib/ui/theme";

type Pill = { key: string; label: string };

type Props = {
  pills: Pill[];
  paramName?: string;
  defaultKey?: string;
};

/**
 * Shared sub-pill row for nested route surfaces (/metrics, /coach).
 * Renders a horizontally scrollable list of pills that mutate a single
 * search param (default: `sub`). Active pill is determined by the current
 * URL param so it survives back/forward and deep links.
 */
export function SubPillNav({ pills, paramName = "sub", defaultKey }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(paramName) ?? defaultKey ?? pills[0]?.key;

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        padding: "8px 14px",
        overflowX: "auto",
      }}
    >
      {pills.map((p) => {
        const active = p.key === current;
        const params = new URLSearchParams(searchParams.toString());
        params.set(paramName, p.key);
        return (
          <Link
            key={p.key}
            href={`${pathname}?${params.toString()}`}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              background: active ? COLOR.accent : COLOR.surface,
              color: active ? "white" : COLOR.textMid,
              border: active ? `1px solid ${COLOR.accent}` : `1px solid ${COLOR.divider}`,
              fontSize: 12,
              fontWeight: 600,
              textDecoration: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
            aria-current={active ? "page" : undefined}
          >
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}
