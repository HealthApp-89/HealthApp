// lib/query/fetchers/create-fetcher.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Collapses the server/browser fetcher pair pattern. The server variant is
 * the query function itself (caller supplies the cookie-bound SSR client);
 * the browser variant self-constructs the browser client and delegates.
 * Both variants therefore share ONE query body — the select string and
 * error handling can no longer drift between them.
 *
 * Both variants throw on Supabase errors (the query body must `throw error`)
 * so TanStack Query lights up `isError` — same contract as before.
 */
export function createFetcher<Args extends unknown[], T>(
  queryFn: (supabase: SupabaseClient, ...args: Args) => Promise<T>,
): {
  server: (supabase: SupabaseClient, ...args: Args) => Promise<T>;
  browser: (...args: Args) => Promise<T>;
} {
  return {
    server: queryFn,
    browser: (...args: Args) => queryFn(createSupabaseBrowserClient(), ...args),
  };
}
