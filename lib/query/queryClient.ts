// lib/query/queryClient.ts
import { QueryClient } from "@tanstack/react-query";

/**
 * Per-request server-side QueryClient. NEVER share between requests — each
 * Server Component invocation must mint its own to avoid leaking one user's
 * data into another's prefetch cache.
 *
 * Defaults are tuned for prefetch-then-hydrate: 60s staleTime so the initial
 * dehydrated state isn't immediately considered stale on the client.
 */
export function makeServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: false,
      },
    },
  });
}
