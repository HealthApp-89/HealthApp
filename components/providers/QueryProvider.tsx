// components/providers/QueryProvider.tsx
"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DevtoolsPanel } from "./DevtoolsPanel";

/**
 * Root client provider. Mounted in app/layout.tsx; wraps the entire tree so
 * any Client Component can call `useQuery`/`useMutation`.
 *
 * The QueryClient is held in state (NOT a module-level singleton) so each
 * mount in React's strict-mode double-render gets its own instance. This is
 * the documented Next 15 pattern — see TanStack Query SSR docs.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            refetchOnMount: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      {children}
      <DevtoolsPanel />
    </QueryClientProvider>
  );
}
