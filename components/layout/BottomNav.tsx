"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState, useTransition, type ComponentType, type MouseEvent } from "react";
import { Home, BarChart3, MessageCircle, User, type LucideProps } from "lucide-react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type Tab = {
  href: string;
  label: string;
  Icon: ComponentType<LucideProps>;
  match: (p: string) => boolean;
};

const TABS: Tab[] = [
  { href: "/",        label: "Today",   Icon: Home,          match: (p) => p === "/" },
  { href: "/metrics", label: "Metrics", Icon: BarChart3,     match: (p) => p.startsWith("/metrics") },
  { href: "/coach",   label: "Coach",   Icon: MessageCircle, match: (p) => p.startsWith("/coach") },
  { href: "/profile", label: "Profile", Icon: User,          match: (p) => p.startsWith("/profile") },
];

/**
 * Mobile-only bottom nav. Hides at md and above (desktop uses TopNav).
 *
 * Optimistic active state — the tab the user just tapped flips to "active"
 * immediately (before the new page finishes loading) so taps feel instant.
 * Without this, `usePathname()` only updates *after* navigation completes,
 * leaving the visual indicator stuck on the previous tab for the duration
 * of the server round-trip. Pairs with the per-route loading.tsx skeletons,
 * which give the *content area* the same instant feedback.
 */
export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // While a navigation is in flight, treat the user's tapped tab as active
  // *even if* `pathname` hasn't caught up. Once the transition resolves,
  // `pathname` reflects the new URL and we can drop pendingHref — but we
  // keep it for one extra tick to avoid a flicker if React batches awkwardly.
  const optimisticPath = isPending && pendingHref ? pendingHref : pathname;

  function handleNavigate(e: MouseEvent<HTMLAnchorElement>, href: string) {
    // Respect modifier-clicks / middle-clicks so "open in new tab" still works.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (href === pathname) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    setPendingHref(href);
    startTransition(() => {
      router.push(href);
    });
  }

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
      {TABS.map((t) => (
        <TabButton
          key={t.href}
          tab={t}
          active={t.match(optimisticPath)}
          onNavigate={handleNavigate}
        />
      ))}
    </nav>
  );
}

function TabButton({
  tab,
  active,
  onNavigate,
}: {
  tab: Tab;
  active: boolean;
  onNavigate: (e: MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  return (
    <Link
      href={tab.href}
      onClick={(e) => onNavigate(e, tab.href)}
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
          // Smooth out the optimistic-active flip so it doesn't feel like a
          // hard cut. 120ms matches the "tactile but not laggy" sweet spot.
          transition: "background 120ms ease, color 120ms ease",
        }}
      >
        <tab.Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span
        style={{
          fontSize: "9px",
          fontWeight: 600,
          color: active ? COLOR.accent : COLOR.textMuted,
          transition: "color 120ms ease",
        }}
      >
        {tab.label}
      </span>
    </Link>
  );
}
