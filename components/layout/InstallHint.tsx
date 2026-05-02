"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "apex.install-hint-dismissed";

/** Tiny, dismissible "Add to Home Screen" prompt. Shown only when:
 *   - User is on iPhone/iPad Safari (Android handles install via beforeinstallprompt — out of scope here).
 *   - Not already running standalone (i.e. not launched from the home-screen icon).
 *   - User hasn't dismissed it before.
 *  Renders nothing on SSR — checks navigator after mount to avoid hydration mismatch. */
export function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(STORAGE_KEY) === "1") return;
    const isIOS = /iPhone|iPad/i.test(navigator.userAgent);
    // navigator.standalone is iOS-Safari-only (and not in lib.dom.d.ts).
    const standalone =
      "standalone" in navigator && (navigator as unknown as { standalone: boolean }).standalone;
    if (isIOS && !standalone) setShow(true);
  }, []);

  if (!show) return null;

  function dismiss() {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, "1");
    setShow(false);
  }

  return (
    <div
      role="status"
      className="mx-4 mt-2 rounded-[12px] px-3 py-2 flex items-center justify-between gap-3 text-[11px]"
      style={{
        background: "rgba(0,245,196,0.08)",
        border: "1px solid rgba(0,245,196,0.25)",
        color: "rgba(255,255,255,0.85)",
      }}
    >
      <span>
        Tap <span className="font-semibold">Share → Add to Home Screen</span> for the full app.
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install hint"
        className="text-white/45 hover:text-white px-1"
      >
        ✕
      </button>
    </div>
  );
}
