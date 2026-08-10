import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Countdown timer. Calls onDone exactly once when elapsed ≥ duration_seconds.
 * Returns { remaining_seconds, elapsed_seconds, isRunning, skip, extend }.
 */
export function useRestCountdown(opts: {
  duration_seconds: number;
  started_at: number | null; // ms since epoch; null = not running
  onDone: () => void;
}) {
  const { duration_seconds, started_at, onDone } = opts;
  const [now, setNow] = useState(() => Date.now());
  const doneFiredRef = useRef(false);

  useEffect(() => {
    if (!started_at) return;
    doneFiredRef.current = false;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [started_at]);

  const elapsed_seconds = started_at ? Math.floor((now - started_at) / 1000) : 0;
  const remaining_seconds = Math.max(0, duration_seconds - elapsed_seconds);

  useEffect(() => {
    if (started_at && remaining_seconds === 0 && !doneFiredRef.current) {
      doneFiredRef.current = true;
      onDone();
    }
  }, [started_at, remaining_seconds, onDone]);

  const skip = useCallback(() => {
    doneFiredRef.current = true;
    onDone();
  }, [onDone]);

  return { remaining_seconds, elapsed_seconds, isRunning: !!started_at, skip };
}

/**
 * Acquire a screen Wake Lock on mount; release on unmount or visibility hide.
 * Silent no-op on browsers that don't support it.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> } }).wakeLock;
        if (!wl) return;
        sentinel = await wl.request("screen");
      } catch {
        // Some browsers reject in non-focused tabs; safe to ignore.
      }
    };

    const onVisChange = () => {
      if (document.visibilityState === "visible" && !sentinel && !cancelled) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisChange);
      void sentinel?.release();
      sentinel = null;
    };
  }, [active]);
}

// The rest-done cue lives in lib/logger/audio-cue.ts. It cannot be built at
// fire time: iOS requires the AudioContext to be created inside a user
// gesture, so the logger unlocks it on first tap and timers only replay it.
// Import { fireCue } from "@/lib/logger/audio-cue" at the call site.

// Minimal browser type for WakeLockSentinel.
interface WakeLockSentinel {
  release(): Promise<void>;
}
