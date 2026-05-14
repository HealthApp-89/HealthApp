"use client";

import { useEffect, useRef, useState } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

/**
 * Reusable bottom-sheet primitive.
 *
 * - Renders a portal-like overlay (`position: fixed`) — caller is responsible
 *   for mounting only when `open` is true (or letting BottomSheet hide itself
 *   via the `open` prop; both work).
 * - 60% viewport height by default; not snap-up to 90% yet (deferred until a
 *   consumer needs it — YAGNI).
 * - Dismiss: backdrop tap, X button, or vertical swipe-down past 80px on
 *   touch devices. No keyboard escape yet (would need a focus trap to be
 *   useful — out of scope).
 */
export function BottomSheet({
  open,
  onClose,
  children,
  /** Optional title rendered in the sheet header. */
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragOffsetRef = useRef(0);
  const touchStartY = useRef<number | null>(null);

  // Body scroll lock while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function onTouchStart(e: React.TouchEvent) {
    touchStartY.current = e.touches[0].clientY;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (touchStartY.current === null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0) {
      dragOffsetRef.current = dy;
      setDragOffset(dy);
    }
  }
  function onTouchEnd() {
    if (dragOffsetRef.current > 80) onClose();
    dragOffsetRef.current = 0;
    setDragOffset(0);
    touchStartY.current = null;
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? "Bottom sheet"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(15,20,48,0.4)",
          backdropFilter: "blur(2px)",
        }}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "560px",
          maxHeight: "60vh",
          background: COLOR.surface,
          borderTopLeftRadius: RADIUS.cardHero,
          borderTopRightRadius: RADIUS.cardHero,
          boxShadow: SHADOW.floating,
          paddingBottom: "env(safe-area-inset-bottom)",
          transform: `translateY(${dragOffset}px)`,
          transition: dragOffset === 0 ? "transform 200ms ease-out" : "none",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Drag handle */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            paddingTop: "8px",
            paddingBottom: title ? "4px" : "8px",
          }}
        >
          <div
            style={{
              width: "36px",
              height: "4px",
              borderRadius: "9999px",
              background: COLOR.divider,
            }}
          />
        </div>

        {/* Header (optional title + close) */}
        {title ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 16px 12px",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong }}>
              {title}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                fontSize: 20,
                color: COLOR.textMuted,
                cursor: "pointer",
                lineHeight: 1,
                padding: "4px 8px",
              }}
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              position: "absolute",
              top: "10px",
              right: "12px",
              background: "transparent",
              border: "none",
              fontSize: 20,
              color: COLOR.textMuted,
              cursor: "pointer",
              padding: "4px 8px",
              lineHeight: 1,
              zIndex: 1,
            }}
          >
            ×
          </button>
        )}

        {/* Content (scrollable) */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
