'use client';

import { useEffect } from 'react';

/**
 * Temporary debug helper. Monkey-patches window.history.replaceState to log
 * every caller's stack to the console. Mounted on /coach to diagnose the
 * "SecurityError: Attempt to use history.replaceState() more than 100 times
 * per 10 seconds" loop reported 2026-05-25. REMOVE once diagnosed.
 */
export function ReplaceStateDebug() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const original = window.history.replaceState;
    let count = 0;
    const start = Date.now();
    window.history.replaceState = function patched(...args: Parameters<typeof original>) {
      count++;
      // Log first 5 calls with full stack, then every 10th to avoid spamming.
      if (count <= 5 || count % 10 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        console.warn(
          `[replaceState-debug] call #${count} at +${elapsed}s | url=${String(args[2] ?? '')}`,
          new Error('stack-trace').stack,
        );
      }
      return original.apply(window.history, args);
    };
    return () => {
      window.history.replaceState = original;
    };
  }, []);
  return null;
}
