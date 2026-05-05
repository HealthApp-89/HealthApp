"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type SheetItem =
  | { kind: "link";   label: string; icon: string; href: string }
  | { kind: "upload"; label: string; icon: string; accept: string; endpoint: string };

const ITEMS: SheetItem[] = [
  { kind: "link",   label: "Log entry",          icon: "✎", href: "/log" },
  { kind: "link",   label: "Strength",           icon: "💪", href: "/strength?view=today" },
  { kind: "upload", label: "Upload Strong CSV",  icon: "⬆", accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link",   label: "Manage connections", icon: "🔗", href: "/profile" },
];

/**
 * Floating + button (mobile only) + bottom sheet with quick actions.
 * Rendered in app/layout.tsx so it persists across routes.
 */
export function Fab() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Quick actions"
        onClick={() => setOpen(true)}
        className="md:hidden"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "calc(env(safe-area-inset-bottom) + 22px)",
          transform: "translateX(-50%)",
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          background: COLOR.accent,
          color: "#fff",
          fontSize: "26px",
          fontWeight: 300,
          border: "none",
          boxShadow: SHADOW.fab,
          cursor: "pointer",
          zIndex: 41,
        }}
      >
        +
      </button>
      {open && <FabSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function FabSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onUploadFile(file: File, endpoint: string) {
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
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(15,20,48,0.4)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "8px",
          right: "8px",
          bottom: "calc(env(safe-area-inset-bottom) + 8px)",
          background: COLOR.surface,
          borderRadius: "22px",
          padding: "10px",
          boxShadow: SHADOW.floating,
        }}
      >
        {ITEMS.map((item) => {
          const inner = (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 14px",
                background: "transparent",
                borderRadius: RADIUS.cardMid,
                cursor: "pointer",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <span
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: RADIUS.cardSmall,
                  background: COLOR.accentSoft,
                  color: COLOR.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "16px",
                }}
              >
                {item.icon}
              </span>
              <span style={{ fontSize: "14px", fontWeight: 600, color: COLOR.textStrong }}>
                {item.label}
              </span>
            </div>
          );
          if (item.kind === "link") {
            return (
              <Link key={item.label} href={item.href} onClick={onClose} style={{ textDecoration: "none" }}>
                {inner}
              </Link>
            );
          }
          return (
            <label key={item.label} style={{ display: "block" }}>
              {inner}
              <input
                type="file"
                accept={item.accept}
                disabled={busy}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUploadFile(f, item.endpoint);
                }}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
