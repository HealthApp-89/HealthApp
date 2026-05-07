"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type Tab = { href: string; label: string; icon: string; match: (p: string) => boolean };

const TABS: Tab[] = [
  { href: "/",        label: "Today",   icon: "⌂",  match: (p) => p === "/" },
  { href: "/trends",  label: "Trends",  icon: "📈", match: (p) => p.startsWith("/trends") },
  // Slot left empty for the FAB (rendered separately by <Fab />)
  { href: "/coach",   label: "Coach",   icon: "💬", match: (p) => p.startsWith("/coach") },
  { href: "/profile", label: "Profile", icon: "👤", match: (p) => p.startsWith("/profile") },
];

/**
 * Mobile-only bottom nav. Hides at md and above (desktop uses TopNav).
 * Reserves a center gap for the floating <Fab />.
 */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      // `flex` activates the row layout on mobile; `md:hidden` cascades after
      // it (ordered later in Tailwind's compiled CSS) so desktop ≥768px gets
      // `display: none`. Do NOT add `display: "flex"` to the inline style —
      // inline beats `md:hidden`'s class rule and the nav stays visible on
      // desktop, hovering over content with no `--nav-h` reservation behind it.
      className="flex md:hidden"
      style={{
        position: "fixed",
        left: "8px",
        right: "8px",
        bottom: "calc(env(safe-area-inset-bottom) + 8px)",
        background: COLOR.surface,
        borderRadius: "22px",
        padding: "8px 0",
        justifyContent: "space-around",
        alignItems: "flex-start",
        boxShadow: SHADOW.bottomNav,
        zIndex: 40,
      }}
    >
      {TABS.slice(0, 2).map((t) => (
        <TabButton key={t.href} tab={t} active={t.match(pathname)} />
      ))}
      {/* Spacer for the FAB */}
      <div style={{ width: "56px", flexShrink: 0 }} aria-hidden="true" />
      {TABS.slice(2).map((t) => (
        <TabButton key={t.href} tab={t} active={t.match(pathname)} />
      ))}
    </nav>
  );
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  return (
    <Link
      href={tab.href}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        flex: 1,
        padding: "4px 0",
        textDecoration: "none",
      }}
    >
      <span
        style={{
          width: "32px",
          height: "32px",
          borderRadius: RADIUS.cardSmall,
          background: active ? COLOR.accentSoft : "transparent",
          color: active ? COLOR.accent : COLOR.textMuted,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
        }}
      >
        {tab.icon}
      </span>
      <span style={{ fontSize: "9px", fontWeight: 600, color: active ? COLOR.accent : COLOR.textMuted }}>
        {tab.label}
      </span>
    </Link>
  );
}
