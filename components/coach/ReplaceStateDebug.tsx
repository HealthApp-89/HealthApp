'use client';

/**
 * Temporary debug helper. Monkey-patches window.history.replaceState at
 * module-load (synchronous, before any React render) and logs the stack
 * of every caller. Mounted on /coach to diagnose the "SecurityError:
 * Attempt to use history.replaceState() more than 100 times per 10
 * seconds" loop reported 2026-05-25. REMOVE once diagnosed.
 *
 * Patch happens at import time (top-level if), not inside useEffect, so
 * it catches calls that fire during hydration before effects run.
 */

declare global {
  interface Window {
    __replaceStateDebugInstalled?: boolean;
  }
}

if (typeof window !== 'undefined' && !window.__replaceStateDebugInstalled) {
  window.__replaceStateDebugInstalled = true;
  const original = window.history.replaceState.bind(window.history);
  let count = 0;
  const start = Date.now();
  window.history.replaceState = function patched(
    ...args: Parameters<typeof original>
  ) {
    count++;
    if (count <= 8 || count % 10 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      // eslint-disable-next-line no-console
      console.warn(
        `[replaceState-debug] #${count} +${elapsed}s url=${String(args[2] ?? '')}`,
      );
      // eslint-disable-next-line no-console
      console.trace(`[replaceState-debug] stack #${count}`);
    }
    return original(...args);
  };
}

export function ReplaceStateDebug() {
  return null;
}
