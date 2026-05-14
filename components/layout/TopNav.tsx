"use client";

import { useState, useTransition, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

// The morning auto-pop trigger and the ChatPanel mount both live in the
// Fab component (single owner). Desktop "Ask coach" dispatches the
// existing "open-chat" event into Fab — it works at all viewports
// because Fab's plumbing isn't gated by responsive classes, while
// TopNav's <header> is `hidden md:flex` (a previous duplicate
// MorningTrigger here mounted ChatPanel into that hidden header,
// which made the morning intake invisible on mobile portrait).

const TABS = [
  { href: "/",        label: "Today" },
  { href: "/trends",  label: "Trends" },
  { href: "/strength", label: "Strength" },
  { href: "/coach",   label: "Coach" },
  { href: "/profile", label: "Profile" },
];

type SheetItem =
  | { kind: "link";   label: string; href: string }
  | { kind: "chat";   label: string }
  | { kind: "upload"; label: string; accept: string; endpoint: string };

const SHEET: SheetItem[] = [
  { kind: "link",   label: "Log entry", href: "/log" },
  { kind: "chat",   label: "Ask coach" },
  { kind: "link",   label: "Strength",  href: "/strength?view=today" },
  { kind: "link",   label: "Body",      href: "/health" },
  { kind: "upload", label: "Upload Strong CSV", accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link",   label: "Manage connections", href: "/profile" },
];

/**
 * Desktop-only top nav. Hidden below md.
 */
export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Optimistic active-tab state. See BottomNav for the rationale — `pathname`
  // doesn't update until navigation completes, so without this the active
  // pill stays on the previous tab for the entire server round-trip.
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const optimisticPath = isPending && pendingHref ? pendingHref : pathname;
  const isActive = (href: string) =>
    href === "/" ? optimisticPath === "/" : optimisticPath.startsWith(href);

  function handleTabClick(e: MouseEvent<HTMLAnchorElement>, href: string) {
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

  async function onUpload(file: File, endpoint: string) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(endpoint, { method: "POST", body: fd });
      if (!res.ok) {
        alert(`Upload failed (${res.status})`);
        return;
      }
      // Invalidate client-side caches that depend on workout data. Uses a
      // predicate so we don't need userId at this layer — matches any
      // muscleVolume or workouts query key regardless of user.
      // Pairs with the existing IngestPanel invalidation (PR #73) so the
      // strength tab refreshes consistently whether uploaded via top-nav,
      // FAB, or /profile.
      queryClient.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "muscleVolume" || q.queryKey[0] === "workouts",
      });
      router.refresh();
      setMenuOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <header
      className="hidden md:flex"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        background: COLOR.surface,
        boxShadow: SHADOW.card,
        padding: "10px 24px",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <span style={{ fontSize: "15px", fontWeight: 700, color: COLOR.textStrong, marginRight: "16px" }}>
        Apex Health
      </span>
      <nav style={{ display: "flex", gap: "4px", flex: 1 }}>
        {TABS.map((t) => {
          const active = isActive(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              onClick={(e) => handleTabClick(e, t.href)}
              style={{
                padding: "6px 12px",
                borderRadius: RADIUS.pill,
                background: active ? COLOR.accentSoft : "transparent",
                color: active ? COLOR.accent : COLOR.textMid,
                fontSize: "13px",
                fontWeight: active ? 700 : 500,
                textDecoration: "none",
                transition: "background 120ms ease, color 120ms ease",
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: RADIUS.pill,
            fontSize: "13px",
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: SHADOW.heroAccent,
          }}
        >
          + New
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 8px)",
              background: COLOR.surface,
              boxShadow: SHADOW.floating,
              borderRadius: RADIUS.cardMid,
              padding: "6px",
              minWidth: "220px",
              zIndex: 60,
            }}
          >
            {SHEET.map((item) => {
              const baseStyle = {
                display: "block",
                padding: "8px 12px",
                fontSize: "13px",
                fontWeight: 500,
                color: COLOR.textStrong,
                textDecoration: "none",
                borderRadius: RADIUS.chip,
                cursor: "pointer",
                opacity: busy ? 0.5 : 1,
              };
              if (item.kind === "link") {
                return (
                  <Link key={item.label} href={item.href} onClick={() => setMenuOpen(false)} style={baseStyle}>
                    {item.label}
                  </Link>
                );
              }
              if (item.kind === "chat") {
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      // Hand off to Fab's single ChatPanel owner via the
                      // existing custom event (no mode → "default" coach).
                      window.dispatchEvent(new CustomEvent("open-chat"));
                    }}
                    style={{
                      ...baseStyle,
                      width: "100%",
                      background: "none",
                      border: "none",
                      textAlign: "left",
                    }}
                  >
                    {item.label}
                  </button>
                );
              }
              return (
                <label key={item.label} style={baseStyle}>
                  {item.label}
                  <input
                    type="file"
                    accept={item.accept}
                    disabled={busy}
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onUpload(f, item.endpoint);
                    }}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </header>
  );
}
