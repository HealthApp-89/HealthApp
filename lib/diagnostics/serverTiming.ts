// lib/diagnostics/serverTiming.ts

/**
 * Lightweight server-side timing wrapper. Wrap any async block to log its
 * duration in dev. Used to attribute end-to-end render latency to specific
 * boundaries (auth check, prefetch fan-out, individual queries) so we can
 * diagnose slowdowns without an external APM.
 *
 * In production this is a no-op — measurement adds <1ms but the log calls
 * pollute Vercel's runtime logs at scale. If you need per-request timing in
 * prod, layer Server-Timing response headers on top (App Router doesn't
 * expose response headers from RSC, so that's a route-handler concern).
 *
 * Usage:
 *   const data = await time("db.daily_logs", () => fetchDailyLogsServer(...));
 */
const isDev = process.env.NODE_ENV === "development";

export async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isDev) return fn();
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms = performance.now() - t0;
    console.log(`[timing] ${label}: ${ms.toFixed(1)}ms`);
    return result;
  } catch (err) {
    const ms = performance.now() - t0;
    console.log(`[timing] ${label}: ${ms.toFixed(1)}ms (errored)`);
    throw err;
  }
}
