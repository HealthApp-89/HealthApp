"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

const TABS = [
  { href: "/",        label: "Today" },
  { href: "/trends",  label: "Trends" },
  { href: "/strength", label: "Strength" },
  { href: "/coach",   label: "Coach" },
  { href: "/profile", label: "Profile" },
];

const SHEET = [
  { kind: "link" as const, label: "Log entry", href: "/log" },
  { kind: "link" as const, label: "Strength",  href: "/strength?view=today" },
  { kind: "upload" as const, label: "Upload Strong CSV", accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link" as const, label: "Manage connections", href: "/profile" },
];

/**
 * Desktop-only top nav. Hidden below md.
 */
export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

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
              style={{
                padding: "6px 12px",
                borderRadius: RADIUS.pill,
                background: active ? COLOR.accentSoft : "transparent",
                color: active ? COLOR.accent : COLOR.textMid,
                fontSize: "13px",
                fontWeight: active ? 700 : 500,
                textDecoration: "none",
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
