"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  workoutId: string;
  /** Called after a successful unwind so the caller can invalidate. */
  onDone: () => void;
};

/** Full unwind of a session saved by mistake. Confirmation names every
 *  consequence — this deletes sets, the debrief, and rewrites the rest of
 *  the week's prescribed loads.
 *
 *  The dialog is portalled to document.body: LoggerSheet-adjacent surfaces
 *  sit in fixed z-40 stacking contexts, and BottomNav is also body-level
 *  z-40 and renders after <main>, so an un-portalled child at equal z loses
 *  the DOM-order tie and is painted over. This repo has hit that three
 *  times (ReorderDialog, DayEditSheet, SetTimerDock). */
export function RestartSessionButton({ workoutId, onDone }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function restart() {
    setBusy(true);
    try {
      const res = await fetch(`/api/logger/session/${workoutId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { reason?: string } | null;
        alert(`Couldn't restart: ${body?.reason ?? "unknown error"}`);
        return;
      }
      setConfirming(false);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setConfirming(true)}
        style={{
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.35)",
          background: "transparent",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Restart
      </button>

      {confirming &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm restart session"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              style={{
                background: COLOR.surface,
                borderRadius: RADIUS.card,
                padding: 20,
                maxWidth: 380,
                width: "100%",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: COLOR.textStrong }}>
                Restart this session?
              </div>
              <p style={{ fontSize: 13, color: COLOR.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                Deletes the logged session and every set in it, removes its debrief,
                and recomputes the rest of this week&apos;s prescribed loads as if it
                never happened. This can&apos;t be undone.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: `1px solid ${COLOR.divider}`,
                    background: "transparent",
                    color: COLOR.textStrong,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={restart}
                  disabled={busy}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: COLOR.danger,
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? "Restarting…" : "Restart"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
