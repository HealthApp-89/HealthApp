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
  const keyboardLayerRef = useRef<HTMLDivElement | null>(null);
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

  // iOS keyboard handling: focusing an input shrinks the visual viewport
  // while the fixed-positioned sheet stays pinned to layout-bottom, so iOS
  // scrolls the page to keep the input visible. Translate the sheet up by
  // the keyboard's intrusion to keep it docked to the visible viewport.
  //
  // Applied imperatively on a wrapper layer (not via React state) so each
  // visualViewport event doesn't trigger a re-render or animate via the
  // sheet's drag-snap transition — iOS fires resize/scroll on every
  // keystroke (predictive bar, auto-scroll), which otherwise looks like the
  // sheet sliding on each key. Mirrors ChatPanel.tsx.
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;
    const layer = keyboardLayerRef.current;
    if (!layer) return;
    const vv = window.visualViewport;
    const update = () => {
      const intrusion = window.innerHeight - vv.height - vv.offsetTop;
      layer.style.transform = intrusion > 0 ? `translateY(${-intrusion}px)` : "";
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      if (layer) layer.style.transform = "";
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

      {/* Keyboard-offset layer (transform set imperatively on iOS keyboard show) */}
      <div
        ref={keyboardLayerRef}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "560px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Sheet */}
        <div
          ref={sheetRef}
          style={{
            position: "relative",
            width: "100%",
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
          {/* Drag-handle / header region — only this area triggers drag-to-dismiss.
              Touches on the scrollable content below scroll the list without
              fighting a sheet-drag gesture (iOS sheet convention). */}
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            style={{ touchAction: "none" }}
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
            ) : null}
          </div>

          {!title && (
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
    </div>
  );
}
