# Client-Cache Refactor (Plan C)

**Date:** 2026-05-07
**Status:** Design approved; implementation plan pending
**Origin:** Tab navigation and within-tab filter changes feel slow (2-4s) even after the loading.tsx + optimistic-tab work landed in `e08ab79`. Skeleton fixes addressed perceived "stuck" lag; this spec addresses the real round-trip latency.

## Problem

Two distinct flavors of slowness remain:

1. **Between-tab navigation** (Today → Trends → Coach): every tap pays full middleware-auth + page-auth + N Supabase queries + RSC stream + hydration. ~2-4s per click.
2. **Within-tab filter changes** (e.g. `/trends` `7D` → `1Y` pill): each pill is a `<Link>` to `?period=ly`, which is a *full server navigation*. The data already lives in browser memory but we re-fetch and re-render every time.

Root cause: every interactive control is modeled as a URL change → server round-trip. Correct mental model for an interactive dashboard with frequent filter changes is: **fetch the user's data once, cache it client-side, do filtering in the browser.**

## Goals

- Make within-tab interactions (range pills, view toggles, exercise drilldowns inside a page) feel **instant** — no network on click.
- Make between-tab navigation feel as fast as possible without sacrificing first-paint speed — keep SSR for initial render, take over with client cache after.
- Establish the pattern that scales to multi-user later (when that work happens) without throwing anything away.

## Non-goals (explicit out-of-scope)

- Multi-user infrastructure: registration, password reset, account UI, per-tenant rate limiting, billing. Separate spec when the multi-user pivot is real.
- Realtime updates via Supabase Realtime subscriptions.
- Service-worker / offline support.
- Rewriting the coach chat streaming flow (works fine today, has its own latency profile).

## Architecture

**Pattern: γ + α — hybrid SSR hydration with direct-Supabase refetches.**

```
First load:
  Server Component fetches initial data (as today)
    → dehydrate(queryClient) into <HydrationBoundary state={...}>
    → Client wrapper rehydrates into TanStack Query's cache
    → First paint stays as fast as today

Subsequent interactions:
  Hooks (useDailyLogs, useWorkouts, etc.) call Supabase directly
    via the existing browser client (lib/supabase/client.ts)
    → RLS enforces per-user scoping (already in place)
    → No Vercel hop, no route handler boilerplate

Writes / Anthropic / cron / webhooks:
  Stay on existing route handlers — unchanged.
```

**Library choice:** TanStack Query. Picked over SWR for cleaner mutation API (`useMutation` + `onMutate` for optimistic updates, which the log/profile/refresh flows benefit from), better SSR hydration story (`<HydrationBoundary>` is cleaner than SWR's `fallback` for a multi-page app), and the devtools panel that pays itself back the first time cache state goes weird. ~13KB gzipped is invisible in an installed PWA.

**Why direct-Supabase for refetches (α) and not route handlers (β):**
- One network hop instead of two (≈50-200ms saved per refetch).
- RLS is already the security boundary; route handlers would just forward the same query with extra ceremony.
- Less code per query (no `app/api/data/*` boilerplate).
- Future multi-user pivot doesn't need this changed — RLS scales.

## Components introduced

```
lib/query/
  queryClient.ts        # Server-only QueryClient factory (per-request)
  keys.ts               # Typed query-key factory (queryKeys.dailyLogs.range(userId, from, to))
  hooks/
    useDailyLogs.ts     # Range query against daily_logs
    useWorkouts.ts      # Workouts + exercises + sets, last 30d default
    useProfile.ts       # profiles row
    useCheckin.ts       # checkin for a given date
    useTokens.ts        # whoop_tokens / withings_tokens metadata
    useInsights.ts      # ai_insights (daily/strength/weekly)
    useRecommendations.ts  # weekly recommendations row
  fetchers/
    daily-logs.ts       # Both server-side (Supabase server client) + client-side (browser client) variants — same shape
    workouts.ts         # Same dual-variant
    [...]               # One per query type

components/providers/
  QueryProvider.tsx     # Root client provider, wraps {children}, instantiates client QueryClient

app/layout.tsx          # Wraps body in <QueryProvider>

components/ui/
  RangePills.tsx        # Adds optional onChange callback for client-state mode (URL-mode kept for back-compat)
```

## Per-page conversion pattern (canonical)

Every converted page follows this shape. Server component does prefetch; client wrapper does interactive rendering.

```tsx
// app/<route>/page.tsx — Server Component (unchanged purpose: gate auth + prefetch)
export default async function Page(props) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, from, to),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, from, to),
    }),
    // ... other prefetches
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PageClient userId={user.id} initialFrom={from} initialTo={to} />
    </HydrationBoundary>
  );
}
```

```tsx
// PageClient.tsx — "use client" — renders page; hooks read from hydrated cache
"use client";
export function PageClient({ userId, initialFrom, initialTo }) {
  const [period, setPeriod] = useState<PeriodPreset>("30d");
  const { data: logs, isLoading } = useDailyLogs(userId, derivedFrom, derivedTo);
  // ...
}
```

```tsx
// lib/query/hooks/useDailyLogs.ts
export function useDailyLogs(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.range(userId, from, to),
    queryFn: () => fetchDailyLogsBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false, // already hydrated from server
  });
}
```

## Trends page — the high-value case

The `/trends` page gets the most aggressive treatment because pill changes are the user's loudest complaint:

- Server component prefetches **1 year** of `daily_logs` once.
- `<RangePills>` becomes a pure client-state control — no URL change, no `<Link>`, just `useState<PeriodPreset>`.
- Period change derives `(from, to)` client-side and slices the same dataset.
- All four pills (`7D` / `30D` / `YTD` / `1Y`) become **instant** — no network at all.
- URL preservation: optional `?period=` param continues to read on first paint for deep-linking, but no longer triggers navigation.

Same treatment applies to `/trends/[metric]` — fetch 1y of the single metric once, slice for `7d`/`30d`/`90d`/`1y` ranges client-side.

## Track decomposition (parallel-agent execution)

Five tracks. T1 must complete before T2 fans out; T3 and T4 can run alongside T2.

### T1 — Foundation (sequential, single agent, ~3-4h)

Establishes the pattern. T2 cannot start until this lands.

- Add `@tanstack/react-query` + `@tanstack/react-query-devtools` to deps.
- `lib/query/queryClient.ts` — server-side per-request factory.
- `lib/query/keys.ts` — typed key factory.
- `lib/query/fetchers/daily-logs.ts` — first dual-variant fetcher (server + client).
- `lib/query/hooks/useDailyLogs.ts` — first hook proving the pattern end-to-end.
- `components/providers/QueryProvider.tsx` — root client provider.
- Wire `<QueryProvider>` into `app/layout.tsx`.
- Convert **`/trends`** as the canonical first conversion (also delivers the highest-visibility win — instant pills).
- Update `CLAUDE.md` § "Architecture" with the new pattern + canonical example.

### T2 — Page conversions (parallel, 5 agents, ~3-4h calendar each)

Each agent owns one page. Agents work in their own worktree to avoid conflicts.

- **T2a:** `app/page.tsx` (Today) — useDailyLogs (selected + previous + 7-day), useProfile, useCheckin, useWorkouts (recent 14d). Most complex; biggest payoff.
- **T2b:** `app/strength/page.tsx` — useWorkouts, useStrengthInsights, useDailyLogs (today only), useCheckin (today). Sub-tab toggling becomes client state where possible.
- **T2c:** `app/coach/page.tsx` — useDailyLogs (last 14d for plan), useInsights, useRecommendations, useCheckin. CoachNav view toggles become client state.
- **T2d:** `app/log/page.tsx` — useProfile, useTokens, useDailyLogs (selected date), useCheckin. Date picker no longer triggers nav.
- **T2e:** `app/profile/page.tsx` — useProfile, useTokens (whoop + withings), useIngestToken, useDailyLogs (last 30d for connection status). Mostly a read-only page; conversion is straightforward.

### T3 — Infra (parallel with T2, single agent, ~2h)

- Pin Vercel function region to Supabase region (`vercel.json` — `"regions": ["fra1"]` if Supabase is in eu-west, `["iad1"]` for us-east-1; confirm via Supabase dashboard before pinning).
- Add server-timing instrumentation: `lib/diagnostics/serverTiming.ts` exposes `time(label, fn)` wrapper. Apply to middleware + page-render + each top-level Supabase query.
- Trim oversized SELECTs — current trends fetches 21 columns, only needs ~10. Audit each prefetch for unused columns.

### T4 — Smoke test suite (parallel with T2 once T1 lands, single agent, ~3-4h)

Required to ship safely with parallel work. Without this, regressions across 5 parallel page conversions are nearly guaranteed.

- `playwright.config.ts` + npm scripts (`test:e2e`, `test:e2e:ui`).
- `tests/auth.spec.ts` — login + redirect on unauthenticated nav.
- `tests/dashboard.spec.ts` — Today loads with hydrated data; metric cards render values.
- `tests/trends.spec.ts` — pill change does NOT trigger network (verifies client-state conversion); chart shape changes correctly.
- `tests/log.spec.ts` — log entry submit + read-back; date picker.
- `tests/strength.spec.ts` — workouts list, exercise drilldown, sub-tab toggle.

CI step: `npm run test:e2e` after `next build`.

### Phase 3 — Integration (sequential, single agent, ~2-3h)

After T1-T4 land:

- TanStack Query Devtools panel mounted dev-only.
- Run smoke suite — fix any regressions.
- Verify server-timing logs show actual improvement (target: <300ms for page renders post-region-pinning).
- Run typecheck across the merged result.

## Cache configuration

- **`staleTime`:** 60s for `daily_logs` (frequent updates from syncs), 5min for `profile`/`tokens` (rarely change), 30s for `checkins`, 5min for `ai_insights` (cron-generated).
- **`refetchOnWindowFocus`:** `true` — when the user returns to the tab, background-refresh stale queries silently.
- **`refetchOnMount`:** `false` for hydrated queries (already populated from server prefetch).
- **`gcTime`:** 5min — drop unused query data from memory after navigation away.
- **Mutations** invalidate by query-key prefix (e.g. log-entry submit invalidates `queryKeys.dailyLogs.all(userId)`).

## Risk register

| Risk | Mitigation |
|---|---|
| **Hydration mismatch** — server prefetched data shape differs from browser fetcher → React hydration warning, content flash | Server + browser fetchers share the same `select` string + same return shape. Smoke tests assert no console errors. |
| **Cache pollution after sign-out** — old user's data lingers if sign-out only redirects | `signOut` handler calls `queryClient.clear()` before redirect. |
| **Direct Supabase from browser leaks data** | RLS already enforces. T4 includes a multi-user RLS smoke test (sign in as User A, attempt to query User B's row, expect empty). |
| **Bundle bloat** | TanStack Query + Devtools = ~13KB gzipped. Devtools tree-shake out of production builds. |
| **Devtools panel ships to production** | Dev-only mount: `process.env.NODE_ENV === "development" && <ReactQueryDevtools />`. |
| **Parallel agents conflict on shared files** (`app/layout.tsx`, `lib/query/keys.ts`) | T1 lands shared files first; T2-T4 only edit their own page + their own hook. Cross-cutting changes flagged in plan. |

## Sequence

```
T1 (sequential)        ████ 3-4h
T2a/b/c/d/e (parallel)      ██████ 3-4h calendar (5 agents)
T3 (parallel with T2)       ████ 2h
T4 (parallel with T2)       ██████ 3-4h
Phase 3 (sequential)              ████ 2-3h
                       └─────────────────────────┘
                              ~9-12h calendar (vs ~12-18h sequential)
```

Realistic: 1 long day or 2 normal-length days for the engineer dispatching the agents. Calendar speedup ~3-4×, not the theoretical 5× because Phase 3 is unavoidable single-thread.

## Success criteria

1. `/trends` pill clicks (`7D` ↔ `1Y`) produce **zero network requests** and feel instant (<50ms perceived).
2. Tab navigation between Today / Trends / Coach / Profile shows hydrated content within 500ms after first load (cache hit), <1.5s on cache miss after region pinning.
3. Smoke suite passes on CI.
4. `npm run typecheck` clean.
5. No regressions on existing user flows (manual QA + smoke tests).

## Open questions for the implementation plan

- Confirm Supabase region (Vercel pinning depends on this).
- Decide whether `app/login/page.tsx` and `app/privacy/page.tsx` need conversion (probably not — they don't fetch user data).
- Decide rollout strategy: single big PR vs 5 page-by-page PRs. Recommend single PR after T1-T4 because the smoke tests want the merged surface.

## Out-of-scope follow-ups (future specs)

- Multi-user infrastructure (registration, billing, account UI).
- Realtime subscriptions (Supabase Realtime → invalidate query keys on data change).
- Service worker / offline mode.
- Edge-runtime page rendering for the static-shell pages.
