"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel"), {
  ssr: false,
  loading: () => null,
});

type SheetItem =
  | { kind: "link";   label: string; icon: string; href: string }
  | { kind: "upload"; label: string; icon: string; accept: string; endpoint: string }
  | { kind: "chat";   label: string; icon: string };

const ITEMS: SheetItem[] = [
  { kind: "link",   label: "Log entry",          icon: "✎",  href: "/log" },
  { kind: "chat",   label: "Ask coach",          icon: "💬" },
  { kind: "link",   label: "Strength",           icon: "💪", href: "/strength?view=today" },
  { kind: "upload", label: "Upload Strong CSV",  icon: "⬆",  accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link",   label: "Manage connections", icon: "🔗", href: "/profile" },
];

/**
 * Floating + button (mobile only) + bottom sheet with quick actions.
 * Rendered (via FabGate) in app/layout.tsx so it persists across routes.
 *
 * "Ask coach" mounts ChatPanel inline — the floating ChatBubble used
 * to do this from a separate corner button; consolidated here so the
 * bottom-right of every page isn't permanently occluded.
 */
export function Fab() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Quick actions"
        onClick={() => setSheetOpen(true)}
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
      {sheetOpen && (
        <FabSheet
          onClose={() => setSheetOpen(false)}
          onAskCoach={() => {
            setSheetOpen(false);
            setChatOpen(true);
          }}
        />
      )}
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
    </>
  );
}

function FabSheet({
  onClose,
  onAskCoach,
}: {
  onClose: () => void;
  onAskCoach: () => void;
}) {
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
          if (item.kind === "chat") {
            return (
              <button
                key={item.label}
                type="button"
                onClick={onAskCoach}
                style={{
                  display: "block",
                  width: "100%",
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {inner}
              </button>
            );
          }
          // kind === "upload"
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
