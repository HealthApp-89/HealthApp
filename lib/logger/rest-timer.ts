import { useEffect } from "react";

// `useRestCountdown` used to live here. Its only consumer was RestBar, the
// per-ExerciseCard rest strip the docked session timer replaced; rest is now
// derived from an absolute anchor in lib/logger/set-timer.ts and ticked by
// SetTimerDock, so the hook went with the component.

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

// Rest-end signalling is visual only. An audio cue was tried and removed: on
// iOS it ducked background music indefinitely and it only fired when the phone
// was already unlocked with the app foregrounded — precisely not the moment it
// was needed. Waking a locked phone needs push infrastructure this app has not
// got, so the dock goes red instead.

// Minimal browser type for WakeLockSentinel.
interface WakeLockSentinel {
  release(): Promise<void>;
}
