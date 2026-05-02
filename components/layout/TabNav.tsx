"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: { href: string; label: string }[] = [
  { href: "/", label: "dashboard" },
  { href: "/log", label: "log" },
  { href: "/trends", label: "trends" },
  { href: "/strength", label: "💪 strength" },
  { href: "/coach", label: "coach" },
  { href: "/profile", label: "profile" },
];

export function TabNav() {
  const pathname = usePathname();
  return (
    <div className="flex overflow-x-auto -mb-px scrollbar-none">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            prefetch={true}
            className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.08em] whitespace-nowrap flex-shrink-0 transition-colors"
            style={{
              color: active ? "#0a84ff" : "rgba(255,255,255,0.3)",
              borderBottom: active ? "2px solid #0a84ff" : "2px solid transparent",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
