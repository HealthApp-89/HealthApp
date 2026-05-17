"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { COLOR } from "@/lib/ui/theme";

type Tab = {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
};

const TABS: Tab[] = [
  {
    href: "/coach",
    label: "Chat",
    match: (p) => p === "/coach",
  },
  {
    href: "/coach/progress",
    label: "Progress",
    match: (p) => p === "/coach/progress" || p.startsWith("/coach/progress/"),
  },
  {
    href: "/coach/reviews",
    label: "Reviews",
    // /coach/weeks/[week_start] deep-links count as "Reviews" — those pages
    // are the individual review documents the index links to.
    match: (p) =>
      p === "/coach/reviews" ||
      p.startsWith("/coach/reviews/") ||
      p === "/coach/weeks" ||
      p.startsWith("/coach/weeks/"),
  },
];

/**
 * Route-aware sub-pill row for the Coach tab. Routes between the three
 * top-level Coach surfaces (`/coach`, `/coach/progress`, `/coach/reviews`).
 *
 * Distinct from the in-chat CoachNav (Today / Recent / Tools) which lives
 * inside `CoachClient.tsx` and only shows on the Chat surface.
 */
export function CoachSubNav() {
  const pathname = usePathname();
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        padding: "8px 14px",
        overflowX: "auto",
      }}
    >
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
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
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
