"use client";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

/**
 * Dev-only mount for the TanStack Query Devtools. Renders nothing in
 * production — the env check at module level lets webpack tree-shake the
 * import out of production bundles.
 */
export function DevtoolsPanel() {
  if (process.env.NODE_ENV !== "development") return null;
  return <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />;
}
