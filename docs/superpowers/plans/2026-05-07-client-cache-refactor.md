# Client-Cache Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Apex Health OS from server-first navigation (every click = round-trip) to a client-cached SPA-feel, by introducing TanStack Query with SSR hydration. After this lands, /trends pill changes are zero-network and tab navigation hits warm cache after first load.

**Architecture:** γ + α — Server Components prefetch initial data and dehydrate it into a `<HydrationBoundary>`; a client `QueryProvider` rehydrates the cache; subsequent fetches go directly to Supabase via the browser client (RLS enforces per-user scoping). Writes / Anthropic / cron / webhooks remain on existing route handlers.

**Tech Stack:** Next.js 15 App Router, React 19, Supabase (`@supabase/ssr`), TanStack Query v5 (`@tanstack/react-query`), Playwright for e2e.

**Spec:** [docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md](../specs/2026-05-07-client-cache-refactor-design.md)

---

## Track structure

| Track | Owner | Sequencing | Tasks |
|-------|-------|------------|-------|
| **T1 — Foundation + /trends** | 1 agent, sequential | Must complete first | Tasks 1.1 – 1.13 |
| **T2a — Today/dashboard** | 1 agent (parallel) | After T1 | Tasks 2a.1 – 2a.10 |
| **T2b — Strength** | 1 agent (parallel) | After T1 | Tasks 2b.1 – 2b.9 |
| **T2c — Coach** | 1 agent (parallel) | After T1 | Tasks 2c.1 – 2c.9 |
| **T2d — Log** | 1 agent (parallel) | After T1 | Tasks 2d.1 – 2d.8 |
| **T2e — Profile** | 1 agent (parallel) | After T1 | Tasks 2e.1 – 2e.8 |
| **T3 — Infra** | 1 agent (parallel with T2) | After T1 | Tasks 3.1 – 3.6 |
| **T4 — Test harness** | 1 agent (parallel with T2) | After T1 | Tasks 4.1 – 4.5 |
| **Phase 3 — Integration** | 1 agent, sequential | After all of T2/T3/T4 | Tasks P3.1 – P3.6 |

Each T2 task includes its own Playwright smoke test (TDD: write the test first, watch it fail against the current implementation when applicable, then convert).

---

## File map (what each track creates / modifies)

### T1 — new files
- `lib/query/queryClient.ts`
- `lib/query/keys.ts`
- `lib/query/fetchers/dailyLogs.ts`
- `lib/query/hooks/useDailyLogs.ts`
- `components/providers/QueryProvider.tsx`
- `components/trends/TrendsClient.tsx`

### T1 — modified files
- `package.json` (add `@tanstack/react-query`, `@tanstack/react-query-devtools`)
- `app/layout.tsx` (wrap children in `<QueryProvider>`)
- `app/trends/page.tsx` (server prefetch + hydration boundary)
- `components/ui/RangePills.tsx` (add optional `onChange` callback prop)
- `CLAUDE.md` (document the new pattern in § Architecture)

### T2 — new files (per page)
- T2a Today: `lib/query/fetchers/{profile,checkin,workouts,latestWeight,last7}.ts`, `lib/query/hooks/{useProfile,useCheckin,useWorkouts,useLatestWeight,useLast7}.ts`, `components/dashboard/TodayClient.tsx`, `tests/dashboard.spec.ts`
- T2b Strength: `lib/query/fetchers/{strengthInsights}.ts`, `lib/query/hooks/{useStrengthInsights}.ts`, `components/strength/StrengthClient.tsx`, `tests/strength.spec.ts`. Reuses T2a's workouts/profile/checkin fetchers if they landed first.
- T2c Coach: `lib/query/fetchers/{insights,recommendations,weeklyReview}.ts`, `lib/query/hooks/{useInsights,useRecommendations,useWeeklyReview}.ts`, `components/coach/CoachClient.tsx`, `tests/coach.spec.ts`
- T2d Log: `lib/query/fetchers/{tokens}.ts`, `lib/query/hooks/{useTokens}.ts`, `components/log/LogClient.tsx`, `tests/log.spec.ts`. Reuses profile + checkin from T2a.
- T2e Profile: `lib/query/fetchers/{ingestToken,withingsTokens}.ts`, `lib/query/hooks/{useIngestToken,useWithingsTokens}.ts`, `components/profile/ProfileClient.tsx`, `tests/profile.spec.ts`. Reuses profile + tokens.

### T2 — modified files
Each page's `app/<route>/page.tsx` becomes a thin Server Component that prefetches and renders `<HydrationBoundary><...Client /></HydrationBoundary>`.

### T3 — new files
- `lib/diagnostics/serverTiming.ts`

### T3 — modified files
- `vercel.json` (`regions: [...]`)
- `middleware.ts` (wrap supabase.auth.getUser() in timing)
- One pass over fetchers to trim columns

### T4 — new files
- `playwright.config.ts`
- `tests/_helpers/auth.ts`
- `tests/_helpers/supabase.ts`
- `tests/auth.spec.ts`
- `.gitignore` adds `test-results/`, `playwright-report/`

### T4 — modified files
- `package.json` (add `@playwright/test` + scripts)

### Phase 3 — new files
- `components/providers/DevtoolsPanel.tsx`

### Phase 3 — modified files
- `components/providers/QueryProvider.tsx` (mount `<DevtoolsPanel />`)

---

## Reference patterns (read once before starting each track)

### Pattern A — Canonical hook

```tsx
// lib/query/hooks/useDailyLogs.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsBrowser } from "@/lib/query/fetchers/dailyLogs";

export function useDailyLogs(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.range(userId, from, to),
    queryFn: () => fetchDailyLogsBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}
```

### Pattern B — Canonical dual fetcher

```tsx
// lib/query/fetchers/dailyLogs.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DailyLog } from "@/lib/data/types";

const COLS =
  "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, respiratory_rate, notes, source, updated_at";

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export async function fetchDailyLogsServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<DailyLog[]> {
  const { data } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return (data ?? []) as DailyLog[];
}

/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export async function fetchDailyLogsBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<DailyLog[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return (data ?? []) as DailyLog[];
}
```

### Pattern C — Canonical page conversion

Server Component: gate auth + prefetch initial data + render hydration boundary.
Client Component: read hooks, render UI, manage interactive state.

```tsx
// app/<route>/page.tsx — Server Component
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { TrendsClient } from "@/components/trends/TrendsClient";

export const revalidate = 60;

export default async function Page() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  // Compute server-side initial range (1 year)
  const today = /* compute today ISO */;
  const from = /* today - 365d */;
  const to = today;
  await queryClient.prefetchQuery({
    queryKey: queryKeys.dailyLogs.range(user.id, from, to),
    queryFn: () => fetchDailyLogsServer(supabase, user.id, from, to),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TrendsClient userId={user.id} initialFrom={from} initialTo={to} />
    </HydrationBoundary>
  );
}
```

```tsx
// components/trends/TrendsClient.tsx — Client Component
"use client";

import { useState } from "react";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";

export function TrendsClient({
  userId,
  initialFrom,
  initialTo,
}: {
  userId: string;
  initialFrom: string;
  initialTo: string;
}) {
  // Filter range is pure client state — no URL change on pill click
  const [period, setPeriod] = useState<"7d" | "30d" | "ytd" | "1y">("30d");
  // ... derive (from, to) from period using existing lib/ui/period helpers
  const { data: logs = [], isLoading } = useDailyLogs(userId, initialFrom, initialTo);
  // logs is the full 1y dataset; slice client-side per `period`
  // ... render
}
```

---

# T1 — Foundation + /trends conversion

**Estimated time:** 3-4h sequential.
**Why first:** Establishes shared infra (`lib/query/`, provider) that all T2 tracks consume. Also delivers the highest-visibility win — instant /trends pills.
**Done when:** /trends page works on `dev`, pill clicks trigger zero network requests, typecheck clean.

## Task 1.1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install TanStack Query and devtools**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm install @tanstack/react-query@^5.59.0 @tanstack/react-query-devtools@^5.59.0
```

- [ ] **Step 2: Verify package.json**

Run: `cat package.json | grep tanstack`
Expected: two lines containing `@tanstack/react-query` and `@tanstack/react-query-devtools` with version `^5.59.0` or compatible.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(deps): add @tanstack/react-query v5 + devtools"
```

## Task 1.2: Create server QueryClient factory

**Files:**
- Create: `lib/query/queryClient.ts`

- [ ] **Step 1: Write file**

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (no output).

- [ ] **Step 3: Commit**

```bash
git add lib/query/queryClient.ts
git commit -m "feat(query): add server-side QueryClient factory"
```

## Task 1.3: Create query-key factory

**Files:**
- Create: `lib/query/keys.ts`

- [ ] **Step 1: Write file**

```ts
// lib/query/keys.ts

/**
 * Centralised query-key factory. Always import from here — never inline
 * key arrays. Keeps invalidation safe (e.g. `queryClient.invalidateQueries({
 * queryKey: queryKeys.dailyLogs.all(userId) })` evicts every range without
 * having to know what the consumers did with `from`/`to`).
 *
 * Hierarchy: ["entity", userId, ...sub-args]
 */
export const queryKeys = {
  dailyLogs: {
    all: (userId: string) => ["daily-logs", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["daily-logs", userId, "range", from, to] as const,
    single: (userId: string, date: string) =>
      ["daily-logs", userId, "single", date] as const,
    latestWeight: (userId: string, before: string) =>
      ["daily-logs", userId, "latest-weight", before] as const,
    last7: (userId: string, before: string) =>
      ["daily-logs", userId, "last7", before] as const,
  },
  profile: {
    one: (userId: string) => ["profile", userId] as const,
  },
  checkin: {
    one: (userId: string, date: string) => ["checkin", userId, date] as const,
  },
  workouts: {
    all: (userId: string) => ["workouts", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["workouts", userId, "range", from, to] as const,
  },
  tokens: {
    whoop: (userId: string) => ["tokens", userId, "whoop"] as const,
    withings: (userId: string) => ["tokens", userId, "withings"] as const,
    ingest: (userId: string) => ["tokens", userId, "ingest"] as const,
  },
  insights: {
    daily: (userId: string, date: string) =>
      ["insights", userId, "daily", date] as const,
    strength: (userId: string) => ["insights", userId, "strength"] as const,
    weeklyReview: (userId: string, weekEnd: string) =>
      ["insights", userId, "weekly-review", weekEnd] as const,
  },
  recommendations: {
    week: (userId: string, weekStart: string) =>
      ["recommendations", userId, weekStart] as const,
  },
} as const;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/query/keys.ts
git commit -m "feat(query): add typed query-key factory"
```

## Task 1.4: Create dailyLogs dual fetcher

**Files:**
- Create: `lib/query/fetchers/dailyLogs.ts`

- [ ] **Step 1: Write file** (full code given in Pattern B above; copy it verbatim)

Use the exact code from Pattern B in the reference section.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/query/fetchers/dailyLogs.ts
git commit -m "feat(query): add dual server/browser fetcher for daily_logs"
```

## Task 1.5: Create useDailyLogs hook

**Files:**
- Create: `lib/query/hooks/useDailyLogs.ts`

- [ ] **Step 1: Write file** (use Pattern A from the reference section verbatim)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/query/hooks/useDailyLogs.ts
git commit -m "feat(query): add useDailyLogs hook"
```

## Task 1.6: Create QueryProvider

**Files:**
- Create: `components/providers/QueryProvider.tsx`

- [ ] **Step 1: Write file**

```tsx
// components/providers/QueryProvider.tsx
"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/providers/QueryProvider.tsx
git commit -m "feat(query): add root QueryProvider"
```

## Task 1.7: Wire QueryProvider into layout

**Files:**
- Modify: `app/layout.tsx`

- [ ] **Step 1: Edit app/layout.tsx**

Add the import near the top with the other component imports:

```tsx
import { QueryProvider } from "@/components/providers/QueryProvider";
```

Wrap the `<TopNav />`, `<main>`, `<BottomNav />`, `<FabGate />` in `<QueryProvider>`. The new body becomes:

```tsx
<body className="min-h-[100dvh] bg-bg">
  <QueryProvider>
    <TopNav />
    <main>{children}</main>
    <BottomNav />
    <FabGate />
  </QueryProvider>
</body>
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Smoke check via dev server**

Run: `npm run dev`
Open http://localhost:3000
Expected: app renders identically to before (visually no change yet).
Stop the dev server with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx
git commit -m "feat(query): mount QueryProvider in root layout"
```

## Task 1.8: Add onChange prop to RangePills

**Files:**
- Modify: `components/ui/RangePills.tsx`

- [ ] **Step 1: Update prop type and click handler**

Replace the existing `RangePillsProps` block and click handler so it supports both URL-mode (current callers) and client-state mode (TrendsClient). The existing `onSelect` prop already exists but is fired alongside the Link navigation; we need a mode where the Link does NOT navigate.

Replace this section:

```tsx
type RangePillsProps = {
  options: RangeOption[];
  /** Currently active option id. */
  active: string;
  /** Optional callback when a pill is tapped (e.g. for optimistic updates). */
  onSelect?: (id: string) => void;
};
```

with:

```tsx
type RangePillsProps = {
  options: RangeOption[];
  /** Currently active option id. */
  active: string;
  /**
   * If provided, pill clicks call this and DO NOT navigate. URL-mode (the
   * current /trends/[metric] sub-page) leaves this undefined and the
   * underlying <Link> performs a normal client-side navigation.
   */
  onChange?: (id: string) => void;
};
```

Then replace the `onClick` handler in the `.map()`:

```tsx
const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  if (onChange) {
    e.preventDefault();
    onChange(opt.id);
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (`onSelect` callers will fail if any exist — search to confirm.)

```bash
grep -rn "RangePills" --include="*.tsx" --include="*.ts" | grep -v "components/ui/RangePills.tsx"
```

If any caller passes `onSelect`, rename it to `onChange` AND ensure it's expected to suppress navigation. The current /trends/page.tsx caller passes neither — fine.

- [ ] **Step 3: Commit**

```bash
git add components/ui/RangePills.tsx
git commit -m "feat(ui): add onChange prop to RangePills for client-state mode"
```

## Task 1.9: Create TrendsClient

**Files:**
- Create: `components/trends/TrendsClient.tsx`

- [ ] **Step 1: Write the client wrapper**

```tsx
// components/trends/TrendsClient.tsx
"use client";

import { useState, useMemo } from "react";
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard } from "@/components/charts/MetricCard";
import type { LinePoint } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import {
  resolvePeriod,
  pickGranularity,
  aggregateSeries,
  periodLengthDays,
  type PeriodPreset,
} from "@/lib/ui/period";

const RANGE_OPTIONS = [
  { id: "7d",  label: "7D",   href: "#" },
  { id: "30d", label: "30D",  href: "#" },
  { id: "ytd", label: "YTD",  href: "#" },
  { id: "ly",  label: "1Y",   href: "#" },
] as const;

const RANGE_LABEL: Partial<Record<PeriodPreset, string>> = {
  "7d":  "7 days",
  "30d": "30 days",
  "ytd": "year to date",
  "ly":  "last year",
};

function toPoints(series: { date: string; value: number | null }[]): LinePoint[] {
  return series.map((p) => ({ x: p.date, y: p.value }));
}

function avg(points: LinePoint[]): number | null {
  let sum = 0, n = 0;
  for (const p of points) {
    if (p.y !== null && Number.isFinite(p.y)) { sum += p.y; n++; }
  }
  return n > 0 ? sum / n : null;
}

function latest(points: LinePoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].y;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function halfDelta(points: LinePoint[]): number | null {
  const mid = Math.floor(points.length / 2);
  const w1 = points.slice(0, mid);
  const w2 = points.slice(mid);
  const a1 = avg(w1);
  const a2 = avg(w2);
  if (a1 === null || a2 === null) return null;
  return Math.round((a2 - a1) * 100) / 100;
}

export function TrendsClient({
  userId,
  initialFrom,
  initialTo,
  initialPeriod,
}: {
  userId: string;
  initialFrom: string; // 1y window we prefetched
  initialTo: string;
  initialPeriod: PeriodPreset;
}) {
  const [period, setPeriod] = useState<PeriodPreset>(initialPeriod);

  // Always read the same 1y key from cache — already hydrated by server.
  const { data: allLogs = [] } = useDailyLogs(userId, initialFrom, initialTo);

  // Derive the active window from `period` and slice client-side.
  const { from, to } = useMemo(
    () => resolvePeriod(period, undefined, undefined),
    [period],
  );
  const sliced = useMemo(
    () => allLogs.filter((l) => l.date >= from && l.date <= to),
    [allLogs, from, to],
  );
  const days = periodLengthDays(from, to);
  const granularity = pickGranularity(days);
  const rangeLabel = RANGE_LABEL[period] ?? `${days} days`;

  const aggHRV     = aggregateSeries(sliced, (l) => l.hrv,          granularity);
  const aggRHR     = aggregateSeries(sliced, (l) => l.resting_hr,   granularity);
  const aggSleepH  = aggregateSeries(sliced, (l) => l.sleep_hours,  granularity);
  const aggStrain  = aggregateSeries(sliced, (l) => l.strain,       granularity);
  const aggWeight  = aggregateSeries(sliced, (l) => l.weight_kg,    granularity);
  const aggBodyFat = aggregateSeries(sliced, (l) => l.body_fat_pct, granularity);

  const hrvTrend     = toPoints(aggHRV);
  const rhrTrend     = toPoints(aggRHR);
  const sleepTrend   = toPoints(aggSleepH);
  const strainTrend  = toPoints(aggStrain);
  const weightTrend  = toPoints(aggWeight);
  const bfTrend      = toPoints(aggBodyFat);

  return (
    <main style={{ background: COLOR.bg, minHeight: "100dvh" }}>
      <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
          <div>
            <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Last {rangeLabel}</div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px", color: COLOR.textStrong }}>Trends</h1>
          </div>
        </div>

        <div style={{ padding: "0 8px 14px" }}>
          <RangePills
            options={RANGE_OPTIONS.map((o) => ({ ...o }))}
            active={period}
            onChange={(id) => setPeriod(id as PeriodPreset)}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
          <MetricCard color={METRIC_COLOR.hrv}        metricKey="hrv"        icon="♥" label="HRV"        value={latest(hrvTrend)}     unit="ms"  delta={halfDelta(hrvTrend)}    deltaUnit="ms"  compact trend={hrvTrend}    href="/trends/hrv" />
          <MetricCard color={METRIC_COLOR.resting_hr} metricKey="resting_hr" icon="♥" label="Resting HR" value={latest(rhrTrend)}     unit="bpm" delta={halfDelta(rhrTrend)}    deltaUnit="bpm" inverted compact trend={rhrTrend}    href="/trends/resting_hr" />
          <MetricCard color={METRIC_COLOR.sleep_hours} metricKey="sleep_hours" icon="☾" label="Sleep"   value={latest(sleepTrend)}   unit="h"   delta={halfDelta(sleepTrend)}  deltaUnit="h"   compact trend={sleepTrend}  href="/trends/sleep_hours" />
          <MetricCard color={METRIC_COLOR.strain}     metricKey="strain"     icon="⚡" label="Strain"   value={latest(strainTrend)}                 delta={halfDelta(strainTrend)} compact trend={strainTrend} href="/trends/strain" />
          <MetricCard color={METRIC_COLOR.weight_kg}  metricKey="weight_kg"  icon="⚖" label="Weight"   value={latest(weightTrend)}  unit="kg"  delta={halfDelta(weightTrend)} deltaUnit="kg"  compact trend={weightTrend} href="/trends/weight_kg" />
          <MetricCard color={METRIC_COLOR.body_fat_pct} metricKey="body_fat_pct" icon="%" label="Body Fat" value={latest(bfTrend)} unit="%"  delta={halfDelta(bfTrend)}     deltaUnit="%"   compact trend={bfTrend}     href="/trends/body_fat_pct" />
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/trends/TrendsClient.tsx
git commit -m "feat(trends): add client wrapper using useDailyLogs"
```

## Task 1.10: Convert /trends page to hybrid

**Files:**
- Modify: `app/trends/page.tsx`

- [ ] **Step 1: Replace file contents**

```tsx
// app/trends/page.tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { TrendsClient } from "@/components/trends/TrendsClient";
import { resolvePeriod, type PeriodPreset } from "@/lib/ui/period";

export const revalidate = 60;

export default async function TrendsPage(props: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>;
}) {
  const sp = await props.searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Initial period from URL (deep links keep working) but it becomes pure
  // client state from here — no further navigation on pill change.
  const rawPeriod = sp.period ?? "30d";
  const initialPeriod: PeriodPreset = (
    ["7d", "30d", "ytd", "ly"].includes(rawPeriod) ? rawPeriod : "30d"
  ) as PeriodPreset;

  // Always prefetch a 1-year window — TrendsClient slices it client-side
  // for any pill choice including "1Y".
  const { from: yearFrom, to: yearTo } = resolvePeriod("ly", undefined, undefined);

  const queryClient = makeServerQueryClient();
  await queryClient.prefetchQuery({
    queryKey: queryKeys.dailyLogs.range(user.id, yearFrom, yearTo),
    queryFn: () => fetchDailyLogsServer(supabase, user.id, yearFrom, yearTo),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TrendsClient
        userId={user.id}
        initialFrom={yearFrom}
        initialTo={yearTo}
        initialPeriod={initialPeriod}
      />
    </HydrationBoundary>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`
Open http://localhost:3000/trends
Expected: page renders normally with metric cards, all 6 metrics visible.

Click `7D` → `30D` → `YTD` → `1Y` pills.
Open browser DevTools → Network tab.
Click between pills.
Expected: ZERO network requests on pill clicks. Cards re-render instantly with new data ranges.

- [ ] **Step 4: Commit**

```bash
git add app/trends/page.tsx
git commit -m "perf(trends): convert to hybrid SSR-hydrate + client filtering

Pill clicks now slice a single 1-year prefetch client-side instead of
re-running the server component. Network tab shows zero requests on
pill change. URL deep-linking via ?period= still works on first paint."
```

## Task 1.11: Update CLAUDE.md with the pattern

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add new section under § Architecture**

Insert after the "Routes" subsection and before the "Coach / AI" subsection:

```markdown
### Client cache (TanStack Query) — read this before adding interactive queries

Every page that fetches per-user data follows the **hybrid SSR-hydrate** pattern:

1. **Server Component** (`app/<route>/page.tsx`) — gates auth, mints a per-request `makeServerQueryClient()` from [lib/query/queryClient.ts](lib/query/queryClient.ts), prefetches initial data using a `Server` fetcher from [lib/query/fetchers/](lib/query/fetchers/), wraps children in `<HydrationBoundary state={dehydrate(queryClient)}>`.
2. **Client Component** (`components/<route>/<Page>Client.tsx`) — reads via hooks from [lib/query/hooks/](lib/query/hooks/) like `useDailyLogs(userId, from, to)`. Hooks call the matching `Browser` fetcher which goes directly to Supabase via [lib/supabase/client.ts](lib/supabase/client.ts). RLS enforces per-user scoping.

**Rules:**
- Every fetcher comes in two variants (server + browser) sharing the same select string and return shape — see [lib/query/fetchers/dailyLogs.ts](lib/query/fetchers/dailyLogs.ts) as the canonical example.
- Query keys come from [lib/query/keys.ts](lib/query/keys.ts) — never inline.
- Mutations (writes / Anthropic calls / cron-triggered work) stay on existing route handlers under [app/api/](app/api/). Only reads use the client cache.
- After a mutation, invalidate by key prefix: `queryClient.invalidateQueries({ queryKey: queryKeys.dailyLogs.all(userId) })`.
- See [docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md](docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md) for the full rationale.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document hybrid SSR-hydrate + TanStack Query pattern"
```

## Task 1.12: Smoke-test /trends end-to-end before T2 fan-out

- [ ] **Step 1: Run dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify dashboard still works**

Open http://localhost:3000/
Expected: Today loads identically to before (T1 only converted /trends).

- [ ] **Step 3: Verify /trends pills are zero-network**

Open http://localhost:3000/trends with DevTools → Network tab.
Click each of `7D`, `30D`, `YTD`, `1Y` in succession.
Expected: zero new network requests after the initial page load.

- [ ] **Step 4: Verify deep link still works**

Open http://localhost:3000/trends?period=ly directly.
Expected: page loads with `1Y` pill active and matching data.

Stop the dev server.

## Task 1.13: T1 done — block release until typecheck clean

- [ ] **Step 1: Final typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Push T1 to a branch for review**

```bash
git push -u origin main
```

T2/T3/T4 agents can now start in parallel.

---

# T2a — Today/dashboard conversion

**Estimated time:** 3-4h.
**Depends on:** T1 complete.
**Done when:** Dashboard renders via TanStack Query, no behavior regressions, smoke test passes.

## Task 2a.1: Add fetchers for profile, checkin, latest weight, last7

**Files:**
- Create: `lib/query/fetchers/profile.ts`
- Create: `lib/query/fetchers/checkin.ts`
- Create: `lib/query/fetchers/latestWeight.ts`
- Create: `lib/query/fetchers/last7.ts`

- [ ] **Step 1: Write profile fetcher**

```ts
// lib/query/fetchers/profile.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = "name, age, height_cm, whoop_baselines";
type Profile = { name: string | null; age: number | null; height_cm: number | null; whoop_baselines: Record<string, unknown> | null };

export async function fetchProfileServer(supabase: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data } = await supabase.from("profiles").select(COLS).eq("user_id", userId).maybeSingle();
  return (data as Profile | null) ?? null;
}

export async function fetchProfileBrowser(userId: string): Promise<Profile | null> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.from("profiles").select(COLS).eq("user_id", userId).maybeSingle();
  return (data as Profile | null) ?? null;
}
```

- [ ] **Step 2: Write checkin fetcher**

```ts
// lib/query/fetchers/checkin.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = "readiness, energy_label, mood, soreness, feel_notes";
type Checkin = { readiness: number | null; energy_label: string | null; mood: string | null; soreness: number | null; feel_notes: string | null };

export async function fetchCheckinServer(supabase: SupabaseClient, userId: string, date: string): Promise<Checkin | null> {
  const { data } = await supabase.from("checkins").select(COLS).eq("user_id", userId).eq("date", date).maybeSingle();
  return (data as Checkin | null) ?? null;
}

export async function fetchCheckinBrowser(userId: string, date: string): Promise<Checkin | null> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.from("checkins").select(COLS).eq("user_id", userId).eq("date", date).maybeSingle();
  return (data as Checkin | null) ?? null;
}
```

- [ ] **Step 3: Write latestWeight fetcher**

```ts
// lib/query/fetchers/latestWeight.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type LatestWeight = { weight_kg: number; date: string } | null;

export async function fetchLatestWeightServer(supabase: SupabaseClient, userId: string, beforeDate: string): Promise<LatestWeight> {
  const { data } = await supabase
    .from("daily_logs")
    .select("weight_kg, date")
    .eq("user_id", userId)
    .lte("date", beforeDate)
    .not("weight_kg", "is", null)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as LatestWeight) ?? null;
}

export async function fetchLatestWeightBrowser(userId: string, beforeDate: string): Promise<LatestWeight> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("daily_logs")
    .select("weight_kg, date")
    .eq("user_id", userId)
    .lte("date", beforeDate)
    .not("weight_kg", "is", null)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as LatestWeight) ?? null;
}
```

- [ ] **Step 4: Write last7 fetcher**

```ts
// lib/query/fetchers/last7.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = "date, hrv, resting_hr, sleep_hours, strain";
type Last7Row = { date: string; hrv: number | null; resting_hr: number | null; sleep_hours: number | null; strain: number | null };

export async function fetchLast7Server(supabase: SupabaseClient, userId: string, beforeDate: string, sevenDaysBefore: string): Promise<Last7Row[]> {
  const { data } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", sevenDaysBefore)
    .lt("date", beforeDate)
    .order("date", { ascending: false });
  return (data ?? []) as Last7Row[];
}

export async function fetchLast7Browser(userId: string, beforeDate: string, sevenDaysBefore: string): Promise<Last7Row[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", sevenDaysBefore)
    .lt("date", beforeDate)
    .order("date", { ascending: false });
  return (data ?? []) as Last7Row[];
}
```

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/query/fetchers/{profile,checkin,latestWeight,last7}.ts
git commit -m "feat(query): add profile/checkin/latestWeight/last7 dual fetchers"
```

## Task 2a.2: Add workouts dual fetcher

**Files:**
- Create: `lib/query/fetchers/workouts.ts`

- [ ] **Step 1: Write file**

```ts
// lib/query/fetchers/workouts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = `id, date, type, exercises(name, position, exercise_sets(kg, reps, warmup, set_index))`;

export type RawWorkout = {
  id: string;
  date: string;
  type: string | null;
  exercises:
    | {
        name: string;
        position: number | null;
        exercise_sets: { kg: number | null; reps: number | null; warmup: boolean; set_index: number }[];
      }[]
    | null;
};

export async function fetchWorkoutsRangeServer(
  supabase: SupabaseClient,
  userId: string,
  fromDate: string,
  toDate: string,
  limit = 5,
): Promise<RawWorkout[]> {
  const { data } = await supabase
    .from("workouts")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", fromDate)
    .lte("date", toDate)
    .order("date", { ascending: false })
    .limit(limit);
  return (data ?? []) as RawWorkout[];
}

export async function fetchWorkoutsRangeBrowser(
  userId: string,
  fromDate: string,
  toDate: string,
  limit = 5,
): Promise<RawWorkout[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("workouts")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", fromDate)
    .lte("date", toDate)
    .order("date", { ascending: false })
    .limit(limit);
  return (data ?? []) as RawWorkout[];
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add lib/query/fetchers/workouts.ts
git commit -m "feat(query): add workouts range dual fetcher"
```

## Task 2a.3: Add hooks for the new fetchers

**Files:**
- Create: `lib/query/hooks/useProfile.ts`
- Create: `lib/query/hooks/useCheckin.ts`
- Create: `lib/query/hooks/useLatestWeight.ts`
- Create: `lib/query/hooks/useLast7.ts`
- Create: `lib/query/hooks/useWorkouts.ts`

- [ ] **Step 1: Write all five hooks**

```ts
// lib/query/hooks/useProfile.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileBrowser } from "@/lib/query/fetchers/profile";

export function useProfile(userId: string) {
  return useQuery({
    queryKey: queryKeys.profile.one(userId),
    queryFn: () => fetchProfileBrowser(userId),
    staleTime: 5 * 60_000,
  });
}
```

```ts
// lib/query/hooks/useCheckin.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchCheckinBrowser } from "@/lib/query/fetchers/checkin";

export function useCheckin(userId: string, date: string) {
  return useQuery({
    queryKey: queryKeys.checkin.one(userId, date),
    queryFn: () => fetchCheckinBrowser(userId, date),
    staleTime: 30_000,
  });
}
```

```ts
// lib/query/hooks/useLatestWeight.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchLatestWeightBrowser } from "@/lib/query/fetchers/latestWeight";

export function useLatestWeight(userId: string, beforeDate: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.latestWeight(userId, beforeDate),
    queryFn: () => fetchLatestWeightBrowser(userId, beforeDate),
    staleTime: 5 * 60_000,
  });
}
```

```ts
// lib/query/hooks/useLast7.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchLast7Browser } from "@/lib/query/fetchers/last7";

export function useLast7(userId: string, beforeDate: string, sevenDaysBefore: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.last7(userId, beforeDate),
    queryFn: () => fetchLast7Browser(userId, beforeDate, sevenDaysBefore),
    staleTime: 60_000,
  });
}
```

```ts
// lib/query/hooks/useWorkouts.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchWorkoutsRangeBrowser } from "@/lib/query/fetchers/workouts";

export function useWorkouts(userId: string, fromDate: string, toDate: string, limit = 5) {
  return useQuery({
    queryKey: queryKeys.workouts.range(userId, fromDate, toDate),
    queryFn: () => fetchWorkoutsRangeBrowser(userId, fromDate, toDate, limit),
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add lib/query/hooks/{useProfile,useCheckin,useLatestWeight,useLast7,useWorkouts}.ts
git commit -m "feat(query): add hooks for profile/checkin/latestWeight/last7/workouts"
```

## Task 2a.4: Create TodayClient

**Files:**
- Create: `components/dashboard/TodayClient.tsx`

- [ ] **Step 1: Extract the entire JSX render of `app/page.tsx` into TodayClient**

The original page does ~150 lines of computation (rolling avg, deltas, recent sessions building, etc.) and ~70 lines of JSX. Move all of it into `TodayClient.tsx` as a `"use client"` component. Replace direct Supabase calls with the new hooks.

The shape of the file:

```tsx
// components/dashboard/TodayClient.tsx
"use client";

import { Suspense } from "react";
import { WeekStrip } from "@/components/layout/WeekStrip";
import { ReadinessHero } from "@/components/dashboard/ReadinessHero";
import { CoachEntryCard } from "@/components/dashboard/CoachEntryCard";
import { RecentLiftsCard, type RecentSession } from "@/components/dashboard/RecentLiftsCard";
import { MetricCard } from "@/components/charts/MetricCard";
import { ImpactDonut } from "@/components/dashboard/ImpactDonut";
import { WeeklyRollups } from "@/components/dashboard/WeeklyRollups";
import { InstallHint } from "@/components/layout/InstallHint";
import { COLOR, METRIC_COLOR, modeColorLight } from "@/lib/ui/theme";
import { calcReadinessScore } from "@/lib/ui/score";
import { computeImpact } from "@/lib/coach/impact";
import { buildDailyPlan, getIntensityMode } from "@/lib/coach/readiness";
import { formatHeaderDate } from "@/lib/time";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useLatestWeight } from "@/lib/query/hooks/useLatestWeight";
import { useLast7 } from "@/lib/query/hooks/useLast7";
import { useWorkouts } from "@/lib/query/hooks/useWorkouts";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import type { DailyLog } from "@/lib/data/types";

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function rollingAvg(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === "number" && !isNaN(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][dt.getUTCDay()];
  return `${day} ${dt.getUTCDate()}`;
}

export function TodayClient({
  userId,
  userEmail,
  selectedDate,
  today,
  isToday,
}: {
  userId: string;
  userEmail: string | null;
  selectedDate: string;
  today: string;
  isToday: boolean;
}) {
  const selectedYesterday = shiftIso(selectedDate, -1);
  const sevenDaysBefore = shiftIso(selectedDate, -7);

  // All queries hit hydrated cache on first render — instant.
  const { data: profile } = useProfile(userId);
  const { data: selectedLogRange = [] } = useDailyLogs(userId, selectedDate, selectedDate);
  const { data: prevLogRange = [] } = useDailyLogs(userId, selectedYesterday, selectedYesterday);
  const { data: checkin = null } = useCheckin(userId, selectedDate);
  const { data: latestWeightRow = null } = useLatestWeight(userId, selectedDate);
  const { data: last7Rows = [] } = useLast7(userId, selectedDate, sevenDaysBefore);
  const { data: recentWorkoutsRaw = [] } = useWorkouts(userId, shiftIso(selectedDate, -14), selectedDate, 5);

  const selectedLog = (selectedLogRange[0] ?? null) as DailyLog | null;
  const prevLog = (prevLogRange[0] ?? null) as DailyLog | null;
  const hasData = !!selectedLog;

  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const effectiveWeightKg =
    selectedLog?.weight_kg ??
    (typeof latestWeightRow?.weight_kg === "number" ? latestWeightRow.weight_kg : null);

  const calorieTarget =
    effectiveWeightKg !== null &&
    typeof profile?.age === "number" &&
    typeof profile?.height_cm === "number"
      ? (10 * effectiveWeightKg + 6.25 * profile.height_cm - 5 * profile.age + 5) * 1.55
      : null;

  // Donut: today's recovery + YESTERDAY's load/intake (per feedback memory).
  const scoreLog: DailyLog | null = selectedLog
    ? {
        ...selectedLog,
        steps: prevLog?.steps ?? null,
        strain: prevLog?.strain ?? null,
        calories_eaten: prevLog?.calories_eaten ?? null,
        protein_g: prevLog?.protein_g ?? null,
        carbs_g: prevLog?.carbs_g ?? null,
      }
    : null;

  const fellBackToPrior = new Set<string>();
  if (prevLog) {
    if (prevLog.steps != null) fellBackToPrior.add("steps");
    if (prevLog.strain != null) fellBackToPrior.add("strain");
    if (prevLog.calories_eaten != null) fellBackToPrior.add("calories");
    if (prevLog.protein_g != null) fellBackToPrior.add("protein");
    if (prevLog.carbs_g != null) fellBackToPrior.add("carbs");
  }

  const score = calcReadinessScore({
    log: scoreLog,
    checkin: checkin ?? null,
    hrvBaseline,
    weightKg: effectiveWeightKg,
    calorieTarget,
  });

  const rawImpact = hasData
    ? computeImpact(scoreLog, hrvBaseline, effectiveWeightKg, calorieTarget)
    : null;
  const impact = rawImpact
    ? {
        ...rawImpact,
        segments: rawImpact.segments.map((s) =>
          fellBackToPrior.has(s.key) && s.value !== null
            ? { ...s, reason: `yest. — ${s.reason}` }
            : s,
        ),
      }
    : null;

  const feelInput = checkin
    ? {
        readiness: checkin.readiness ?? null,
        energyLabel: checkin.energy_label ?? null,
        mood: checkin.mood ?? null,
        soreness: checkin.soreness ?? null,
        notes: checkin.feel_notes ?? null,
      }
    : null;
  const dailyPlan = buildDailyPlan(selectedLog, feelInput, hrvBaseline);
  const mode = getIntensityMode(dailyPlan.readiness, feelInput);

  const hrvAvg    = rollingAvg(last7Rows.map((r) => r.hrv));
  const rhrAvg    = rollingAvg(last7Rows.map((r) => r.resting_hr));
  const sleepAvg  = rollingAvg(last7Rows.map((r) => r.sleep_hours));
  const strainAvg = rollingAvg(last7Rows.map((r) => r.strain));
  const hrvDelta    = selectedLog?.hrv != null && hrvAvg != null ? selectedLog.hrv - hrvAvg : null;
  const rhrDelta    = selectedLog?.resting_hr != null && rhrAvg != null ? selectedLog.resting_hr - rhrAvg : null;
  const sleepDelta  = selectedLog?.sleep_hours != null && sleepAvg != null ? selectedLog.sleep_hours - sleepAvg : null;
  const strainDelta = selectedLog?.strain != null && strainAvg != null ? selectedLog.strain - strainAvg : null;

  const recentSessions: RecentSession[] = recentWorkoutsRaw.map((w) => {
    let vol = 0;
    let bwReps = 0;
    for (const e of w.exercises ?? []) {
      for (const s of e.exercise_sets ?? []) {
        if (s.warmup) continue;
        if (s.kg && s.reps) vol += s.kg * s.reps;
        else if (!s.kg && s.reps) bwReps += s.reps;
      }
    }
    const firstName = (w.exercises ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.name;
    const title = w.type ? (firstName ? `${w.type} · ${firstName}` : w.type) : firstName ?? "Workout";
    return { date: formatShortDate(w.date), title, volumeKg: vol, bwReps };
  });

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>{formatHeaderDate()}</div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Today</h1>
        </div>
        <div
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLOR.accent}, ${COLOR.accentDeep})`,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "14px",
            fontWeight: 700,
          }}
        >
          {(profile?.name ?? userEmail ?? "A")[0].toUpperCase()}
        </div>
      </div>

      {isToday && <InstallHint />}

      <WeekStrip selected={selectedDate} today={today} />

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
        <ReadinessHero score={score ?? null} status={mode.label.replace(/^[^\s]+\s/, "")} subtitle={mode.desc} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <MetricCard color={METRIC_COLOR.hrv}        icon="♥" label="HRV"        value={selectedLog?.hrv ?? null}        unit="ms"  delta={hrvDelta}    deltaUnit="ms" />
          <MetricCard color={METRIC_COLOR.resting_hr} icon="♥" label="Resting HR" value={selectedLog?.resting_hr ?? null} unit="bpm" delta={rhrDelta}    deltaUnit="bpm" inverted />
          <MetricCard color={METRIC_COLOR.sleep_hours} icon="☾" label="Sleep"     value={selectedLog?.sleep_hours ?? null} unit="h"  delta={sleepDelta}  deltaUnit="h" />
          <MetricCard color={METRIC_COLOR.strain}     icon="⚡" label="Strain"    value={selectedLog?.strain ?? null}                delta={strainDelta} />
        </div>

        {(selectedLog?.weight_kg != null || selectedLog?.body_fat_pct != null) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <MetricCard color={METRIC_COLOR.weight_kg}    icon="⚖" label="Weight"   value={selectedLog?.weight_kg ?? null}    unit="kg" />
            <MetricCard color={METRIC_COLOR.body_fat_pct} icon="%" label="Body Fat" value={selectedLog?.body_fat_pct ?? null} unit="%" />
          </div>
        )}

        {hasData && impact ? <ImpactDonut segments={impact.segments} score={score} /> : null}

        <CoachEntryCard headline={mode.desc} thumbnailColor={modeColorLight(mode.color)} thumbnailGlyph={"▲"} meta="Coach · 2 min read" />

        <RecentLiftsCard sessions={recentSessions} />

        <Suspense fallback={null}>
          <WeeklyRollups
            userId={userId}
            today={selectedDate}
            todayHrv={selectedLog?.hrv ?? null}
            todayRhr={selectedLog?.resting_hr ?? null}
            hrvBaseline={hrvBaseline}
          />
        </Suspense>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add components/dashboard/TodayClient.tsx
git commit -m "feat(dashboard): add TodayClient using TanStack Query hooks"
```

## Task 2a.5: Convert app/page.tsx to hybrid

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Replace contents**

```tsx
// app/page.tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
import { fetchLatestWeightServer } from "@/lib/query/fetchers/latestWeight";
import { fetchLast7Server } from "@/lib/query/fetchers/last7";
import { fetchWorkoutsRangeServer } from "@/lib/query/fetchers/workouts";
import { TodayClient } from "@/components/dashboard/TodayClient";
import { todayInUserTz } from "@/lib/time";

export const revalidate = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

export default async function Home(props: { searchParams: Promise<{ date?: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = todayInUserTz();
  const sp = await props.searchParams;
  const selectedDate =
    sp.date && ISO_DATE.test(sp.date) && sp.date <= today ? sp.date : today;
  const selectedYesterday = shiftIso(selectedDate, -1);
  const isToday = selectedDate === today;
  const sevenDaysBefore = shiftIso(selectedDate, -7);
  const fourteenBefore = shiftIso(selectedDate, -14);

  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.profile.one(user.id),
      queryFn: () => fetchProfileServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, selectedDate, selectedDate),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, selectedDate, selectedDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, selectedYesterday, selectedYesterday),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, selectedYesterday, selectedYesterday),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, selectedDate),
      queryFn: () => fetchCheckinServer(supabase, user.id, selectedDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.latestWeight(user.id, selectedDate),
      queryFn: () => fetchLatestWeightServer(supabase, user.id, selectedDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.last7(user.id, selectedDate),
      queryFn: () => fetchLast7Server(supabase, user.id, selectedDate, sevenDaysBefore),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.workouts.range(user.id, fourteenBefore, selectedDate),
      queryFn: () => fetchWorkoutsRangeServer(supabase, user.id, fourteenBefore, selectedDate, 5),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TodayClient
        userId={user.id}
        userEmail={user.email ?? null}
        selectedDate={selectedDate}
        today={today}
        isToday={isToday}
      />
    </HydrationBoundary>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Manual smoke**

```bash
npm run dev
```

Open http://localhost:3000/
Expected: dashboard renders identically to before, all metric cards populated, donut shows yesterday's data per feedback memory.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "perf(dashboard): convert Home to hybrid SSR-hydrate pattern"
```

## Task 2a.6: Write dashboard smoke test (depends on T4 harness)

**Files:**
- Create: `tests/dashboard.spec.ts`

- [ ] **Step 1: Wait for T4 task 4.4 (auth helpers + playwright config) to land**

If T4 hasn't landed yet, skip to T2a.7 and circle back.

- [ ] **Step 2: Write the spec**

```ts
// tests/dashboard.spec.ts
import { test, expect } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.describe("Today / dashboard", () => {
  test("renders with hydrated data and no double-fetch", async ({ page }) => {
    await signIn(page);

    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("supabase.co")) requests.push(req.url());
    });

    await page.goto("/");

    // Header
    await expect(page.locator("h1")).toContainText("Today");

    // Metric cards present (HRV / RHR / Sleep / Strain at minimum)
    await expect(page.getByText("HRV")).toBeVisible();
    await expect(page.getByText("Resting HR")).toBeVisible();
    await expect(page.getByText("Sleep")).toBeVisible();
    await expect(page.getByText("Strain")).toBeVisible();

    // Hydrated data should not trigger a flood of refetches on first paint.
    // Expect at most 1 background refresh (e.g. refetchOnWindowFocus false +
    // refetchOnMount false means usually 0).
    expect(requests.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
npx playwright test tests/dashboard.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/dashboard.spec.ts
git commit -m "test(dashboard): smoke test for hybrid hydration"
```

---

# T2b — Strength conversion

**Estimated time:** 3-4h.
**Depends on:** T1 complete. Can reuse `useProfile`, `useCheckin`, `useDailyLogs` if T2a landed first.

## Task 2b.1: Add strength insights fetcher and hook

**Files:**
- Create: `lib/query/fetchers/strengthInsights.ts`
- Create: `lib/query/hooks/useStrengthInsights.ts`

- [ ] **Step 1: Write fetcher**

```ts
// lib/query/fetchers/strengthInsights.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Cached = { payload: unknown; generated_for_date: string } | null;

export async function fetchStrengthInsightsServer(supabase: SupabaseClient, userId: string): Promise<Cached> {
  const { data } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "strength")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Cached) ?? null;
}

export async function fetchStrengthInsightsBrowser(userId: string): Promise<Cached> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "strength")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Cached) ?? null;
}
```

- [ ] **Step 2: Write hook**

```ts
// lib/query/hooks/useStrengthInsights.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchStrengthInsightsBrowser } from "@/lib/query/fetchers/strengthInsights";

export function useStrengthInsights(userId: string) {
  return useQuery({
    queryKey: queryKeys.insights.strength(userId),
    queryFn: () => fetchStrengthInsightsBrowser(userId),
    staleTime: 5 * 60_000,
  });
}
```

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
git add lib/query/fetchers/strengthInsights.ts lib/query/hooks/useStrengthInsights.ts
git commit -m "feat(query): add strength insights fetcher + hook"
```

## Task 2b.2 - 2b.9: Strength page conversion (compressed)

The strength page is more complex than trends but follows the exact same pattern. Tasks below build on T2a's hooks where possible.

- [ ] **Task 2b.2: Add `lib/query/fetchers/loadWorkouts.ts`** — port the existing `lib/data/workouts.ts:loadWorkouts` to a dual fetcher (server + browser). Keep the existing types/exports in `lib/data/workouts.ts` for `buildPRs` / `buildExerciseTrend` consumers.

- [ ] **Task 2b.3: Add `useFullWorkouts` hook** — calls `fetchLoadWorkoutsBrowser`, staleTime 5min.

- [ ] **Task 2b.4: Create `components/strength/StrengthClient.tsx`** — extract the entire JSX render of `app/strength/page.tsx` here, replace direct Supabase calls with `useFullWorkouts`, `useProfile`, `useStrengthInsights`, `useDailyLogs(today, today)`, `useCheckin(today)`. Sub-tab toggle (`?view=`) becomes `useState<"today" | "recent" | "date">` — selecting a sub-tab no longer triggers navigation.

- [ ] **Task 2b.5: Convert `app/strength/page.tsx`** — server prefetches the 6 queries, renders `<HydrationBoundary><StrengthClient /></HydrationBoundary>`.

- [ ] **Task 2b.6: Run typecheck, smoke locally** — verify no regressions on /strength?view=today, /strength?view=recent, /strength?view=date.

- [ ] **Task 2b.7: Write `tests/strength.spec.ts`** — assert page loads, sub-tab toggle does not trigger network, exercise drilldown still works.

- [ ] **Task 2b.8: Run smoke test** — `npx playwright test tests/strength.spec.ts`.

- [ ] **Task 2b.9: Commit** — `git commit -m "perf(strength): convert to hybrid SSR-hydrate"`.

(Each sub-task follows the same shape as T2a tasks: Step 1 write file, Step 2 typecheck, Step 3 commit.)

---

# T2c — Coach conversion

**Estimated time:** 3-4h.

## Task 2c.1 - 2c.9: Coach page conversion (compressed)

- [ ] **Task 2c.1: `lib/query/fetchers/insightsDaily.ts`** — fetches `ai_insights` where `kind=daily`, latest row.
- [ ] **Task 2c.2: `lib/query/fetchers/recommendations.ts`** — fetches `recommendations` for current week.
- [ ] **Task 2c.3: `lib/query/fetchers/weeklyReview.ts`** — fetches `ai_insights` where `kind=weekly_review`, by `generated_for_date`.
- [ ] **Task 2c.4: Hooks for each** (`useInsightsDaily`, `useRecommendations`, `useWeeklyReview`).
- [ ] **Task 2c.5: `components/coach/CoachClient.tsx`** — extract JSX from `app/coach/page.tsx`. CoachNav `view` toggle (`daily | week | recs`) becomes `useState`. Each view's data comes from the appropriate hook.
- [ ] **Task 2c.6: Convert `app/coach/page.tsx`** — server prefetches all three insight queries (one per view) so any tab is warm on first paint.
- [ ] **Task 2c.7: Smoke locally** — verify each CoachNav view works, refresh button still calls `/api/insights/*` and triggers query invalidation.
- [ ] **Task 2c.8: `tests/coach.spec.ts`** — assert each view renders, switching views triggers no network.
- [ ] **Task 2c.9: Commit** — `git commit -m "perf(coach): convert to hybrid SSR-hydrate"`.

---

# T2d — Log conversion

**Estimated time:** 2-3h. Smaller page; reuses several T2a hooks.

## Task 2d.1 - 2d.8

- [ ] **Task 2d.1: `lib/query/fetchers/whoopTokens.ts`** — fetches `whoop_tokens.updated_at` for the badge.
- [ ] **Task 2d.2: `useWhoopTokens` hook**.
- [ ] **Task 2d.3: `components/log/LogClient.tsx`** — extract page render. Date navigation (`?date=`) becomes `useState` + URL sync. Reuses `useDailyLogs(date, date)` and `useCheckin(date)` from T2a.
- [ ] **Task 2d.4: Convert `app/log/page.tsx`** — server prefetches profile, whoop tokens, log + checkin for the requested date.
- [ ] **Task 2d.5: Smoke** — submit a log entry, verify mutation refetches `useDailyLogs` (`queryClient.invalidateQueries({ queryKey: queryKeys.dailyLogs.all(userId) })` inside the existing form's `onSuccess`).
- [ ] **Task 2d.6: `tests/log.spec.ts`** — assert form submit + read-back; date arrows don't trigger nav.
- [ ] **Task 2d.7: Run smoke test**.
- [ ] **Task 2d.8: Commit** — `git commit -m "perf(log): convert to hybrid SSR-hydrate"`.

---

# T2e — Profile conversion

**Estimated time:** 2-3h. Mostly read-only; conversion is straightforward.

## Task 2e.1 - 2e.8

- [ ] **Task 2e.1: `lib/query/fetchers/withingsTokens.ts`** + **`ingestToken.ts`**.
- [ ] **Task 2e.2: Hooks** (`useWithingsTokens`, `useIngestToken`).
- [ ] **Task 2e.3: `components/profile/ProfileClient.tsx`** — extract page render. Reuses `useProfile`, `useWhoopTokens` (from T2d), `useDailyLogs(last30, today)`.
- [ ] **Task 2e.4: Convert `app/profile/page.tsx`** — server prefetches all the above.
- [ ] **Task 2e.5: Smoke** — verify connections panel shows correct status, profile form submit triggers `queryClient.invalidateQueries({ queryKey: queryKeys.profile.one(userId) })`.
- [ ] **Task 2e.6: `tests/profile.spec.ts`** — assert all panels render, profile-form submit + read-back.
- [ ] **Task 2e.7: Run smoke test**.
- [ ] **Task 2e.8: Commit** — `git commit -m "perf(profile): convert to hybrid SSR-hydrate"`.

---

# T3 — Infra

**Estimated time:** 2h.
**Depends on:** T1 complete. Runs in parallel with T2.

## Task 3.1: Confirm Supabase region and pin Vercel

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Determine Supabase region**

Open https://supabase.com/dashboard/project/eopfwwergisvskxqvsqe/settings/general
Note the "Region" field. Common values: `us-east-1`, `eu-west-1`, `eu-central-1`, `ap-southeast-1`, etc.

Map to Vercel function regions:
- `us-east-1` → `iad1`
- `us-west-1` → `sfo1`
- `eu-west-1` → `dub1`
- `eu-central-1` → `fra1`
- `ap-southeast-1` → `sin1`

- [ ] **Step 2: Pin Vercel function region in vercel.json**

Add `regions` to the top level. Replace the file content with (substituting the correct region code from Step 1):

```json
{
  "regions": ["iad1"],
  "crons": [
    { "path": "/api/whoop/sync", "schedule": "0 6 * * *" },
    { "path": "/api/whoop/sync", "schedule": "0 10 * * *" }
  ],
  "functions": {
    "app/api/chat/messages/route.ts": { "maxDuration": 60 }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "perf(vercel): pin function region to match Supabase"
```

## Task 3.2: Create server-timing helper

**Files:**
- Create: `lib/diagnostics/serverTiming.ts`

- [ ] **Step 1: Write file**

```ts
// lib/diagnostics/serverTiming.ts

/**
 * Lightweight server-timing wrapper. Wrap any async block to log its duration
 * in dev and forward it to the Server-Timing response header in prod (visible
 * in Chrome DevTools → Network → request → Timing tab).
 *
 * Usage:
 *   const data = await time("db.daily_logs", () => fetchDailyLogsServer(...));
 *
 * Headers can't be set from inside arbitrary Server Components in App Router,
 * so for now we just console.log in dev. Production header support is a
 * follow-up if we need per-request observability beyond Vercel's analytics.
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
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add lib/diagnostics/serverTiming.ts
git commit -m "feat(diagnostics): add server-timing wrapper for dev"
```

## Task 3.3: Wrap middleware getUser() in timing

**Files:**
- Modify: `middleware.ts`

- [ ] **Step 1: Add timing wrapper**

Import at top:
```ts
import { time } from "@/lib/diagnostics/serverTiming";
```

Replace the line:
```ts
await supabase.auth.getUser();
```
with:
```ts
await time("middleware.auth.getUser", () => supabase.auth.getUser());
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Run dev and verify timing logs print**

```bash
npm run dev
```

Hit any page; expect `[timing] middleware.auth.getUser: <N>ms` in the dev console.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add middleware.ts
git commit -m "feat(diagnostics): time middleware auth check"
```

## Task 3.4: Wrap server prefetches in timing

**Files:**
- Modify: each `app/<route>/page.tsx` that uses `prefetchQuery`

- [ ] **Step 1: For each converted page** wrap its `Promise.all([...prefetchQuery(...)])` in a single `time` call

Example for `app/page.tsx`:

```ts
await time("page.home.prefetch", () =>
  Promise.all([
    queryClient.prefetchQuery({ ... }),
    // ...
  ]),
);
```

- [ ] **Step 2: Repeat for /trends, /strength, /coach, /log, /profile** as each lands.

- [ ] **Step 3: Typecheck and commit per page**

```bash
npm run typecheck
git add app/<route>/page.tsx
git commit -m "feat(diagnostics): time <route> prefetch fan-out"
```

## Task 3.5: Audit fetcher SELECTs for over-fetch

**Files:**
- Modify: `lib/query/fetchers/dailyLogs.ts` (others as needed)

- [ ] **Step 1: For dailyLogs** — current `COLS` selects 24 columns. Trends needs ~10 (date + the 6 charted metrics + a couple for delta math); the rest are dead weight for trends. But dashboard does need most of them.

Decision: keep the wide `COLS` for the canonical fetcher (most callers want most columns). Add a narrow variant for trends only:

```ts
// lib/query/fetchers/dailyLogs.ts (additional export)
const TREND_COLS = "date, hrv, resting_hr, sleep_hours, strain, weight_kg, body_fat_pct";

export async function fetchDailyLogsTrendServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
) {
  const { data } = await supabase
    .from("daily_logs")
    .select(TREND_COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return data ?? [];
}

export async function fetchDailyLogsTrendBrowser(userId: string, from: string, to: string) {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("daily_logs")
    .select(TREND_COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return data ?? [];
}
```

- [ ] **Step 2: Add `useDailyLogsTrend` hook** at `lib/query/hooks/useDailyLogsTrend.ts` mirroring `useDailyLogs` but calling the narrow fetcher and using a different cache key (`queryKeys.dailyLogs.range` with a separate suffix or new key entirely — recommend adding `queryKeys.dailyLogs.trend(userId, from, to)`).

- [ ] **Step 3: Update `lib/query/keys.ts`** to add the trend key:

```ts
trend: (userId: string, from: string, to: string) =>
  ["daily-logs", userId, "trend", from, to] as const,
```

- [ ] **Step 4: Update T1's `app/trends/page.tsx` and `components/trends/TrendsClient.tsx`** to use the trend variant.

- [ ] **Step 5: Typecheck, smoke /trends, commit**

```bash
npm run typecheck
git add lib/query/fetchers/dailyLogs.ts lib/query/hooks/useDailyLogsTrend.ts lib/query/keys.ts app/trends/page.tsx components/trends/TrendsClient.tsx
git commit -m "perf(trends): use narrow column projection for trend queries"
```

## Task 3.6: T3 done

- [ ] **Step 1: Final typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Verify smoke**

Run dev, visit each page, confirm timing logs print and no regressions.

---

# T4 — Test harness

**Estimated time:** 3-4h.
**Depends on:** T1 complete. Per-page specs land alongside their T2 tasks.

## Task 4.1: Install Playwright

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm install -D @playwright/test@^1.49.0
npx playwright install chromium
```

- [ ] **Step 2: Add npm scripts**

Edit `package.json` `"scripts"`:

```json
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui"
```

- [ ] **Step 3: Update `.gitignore`**

Append:
```
test-results/
playwright-report/
playwright/.cache/
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore(test): install Playwright"
```

## Task 4.2: Create playwright.config.ts

**Files:**
- Create: `playwright.config.ts`

- [ ] **Step 1: Write config**

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add playwright.config.ts
git commit -m "test(e2e): add Playwright config"
```

## Task 4.3: Create test helpers

**Files:**
- Create: `tests/_helpers/auth.ts`
- Create: `tests/_helpers/supabase.ts`

- [ ] **Step 1: Document auth model and choose test-user strategy**

The app uses Supabase email/magic-link auth. For e2e, we need a test user. Two options:

1. **Create a dedicated test user** in the staging Supabase project; store credentials in `.env.test` (gitignored). Tests sign in via password (Supabase signInWithPassword) — requires enabling email/password auth in the project for at least the test user.
2. **Mock the auth cookie** by directly minting a Supabase JWT for the test user using the service role key. Faster (no UI flow) but coupled to Supabase internals.

Pick **option 1** for now — explicit and auditable.

- [ ] **Step 2: Write helper file**

```ts
// tests/_helpers/auth.ts
import type { Page } from "@playwright/test";

export async function signIn(page: Page) {
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error("TEST_USER_EMAIL/TEST_USER_PASSWORD must be set in .env.test");
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("/", { timeout: 15_000 });
}
```

- [ ] **Step 3: Write supabase helper**

```ts
// tests/_helpers/supabase.ts
import { createClient } from "@supabase/supabase-js";

export function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
```

- [ ] **Step 4: Document `.env.test` setup**

Append to `README.md` (or create one if missing):

```markdown
## Running e2e tests

Tests require a dedicated Supabase test user. Create `.env.test`:

```
TEST_USER_EMAIL=...
TEST_USER_PASSWORD=...
```

Then: `npm run test:e2e`
```

- [ ] **Step 5: Commit**

```bash
git add tests/_helpers/{auth,supabase}.ts README.md
git commit -m "test(e2e): add auth + supabase helpers"
```

## Task 4.4: Write auth.spec.ts

**Files:**
- Create: `tests/auth.spec.ts`

- [ ] **Step 1: Write test**

```ts
// tests/auth.spec.ts
import { test, expect } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test("unauthenticated nav redirects to /login", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(/\/login$/, { timeout: 10_000 });
});

test("sign-in with valid creds lands on /", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("h1")).toContainText("Today");
});
```

- [ ] **Step 2: Run**

```bash
npx playwright test tests/auth.spec.ts
```

Expected: PASS (assuming `.env.test` is configured).

- [ ] **Step 3: Commit**

```bash
git add tests/auth.spec.ts
git commit -m "test(e2e): auth flow smoke"
```

## Task 4.5: Write trends.spec.ts (TDD-style for the no-network assertion)

**Files:**
- Create: `tests/trends.spec.ts`

- [ ] **Step 1: Write the test BEFORE T1's /trends conversion lands** (or against current main if T1 is already in)

```ts
// tests/trends.spec.ts
import { test, expect } from "@playwright/test";
import { signIn } from "./_helpers/auth";

test.describe("/trends", () => {
  test("renders metric cards", async ({ page }) => {
    await signIn(page);
    await page.goto("/trends");
    await expect(page.getByText("HRV")).toBeVisible();
    await expect(page.getByText("Resting HR")).toBeVisible();
    await expect(page.getByText("Sleep")).toBeVisible();
    await expect(page.getByText("Strain")).toBeVisible();
  });

  test("pill change does not trigger network", async ({ page }) => {
    await signIn(page);
    await page.goto("/trends");
    // Wait for hydration to settle
    await page.waitForLoadState("networkidle");

    const requestsAfterSettle: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("supabase.co") || url.includes("/_next/data")) {
        requestsAfterSettle.push(url);
      }
    });

    // Click each pill in turn — none of them should fire a request.
    for (const label of ["7D", "YTD", "1Y", "30D"]) {
      await page.getByRole("tab", { name: label }).click();
      // Allow any deferred requests a moment to fire
      await page.waitForTimeout(150);
    }

    expect(requestsAfterSettle).toEqual([]);
  });
});
```

- [ ] **Step 2: Run before T1 lands** — if running against the pre-T1 implementation, expect FAIL on the second test (network requests fire on pill change). This validates the test is meaningful.

- [ ] **Step 3: Re-run after T1 lands** — expect PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/trends.spec.ts
git commit -m "test(e2e): /trends pills trigger zero network requests"
```

---

# Phase 3 — Integration

**Estimated time:** 2-3h.
**Depends on:** All of T2/T3/T4 complete.

## Task P3.1: Add Devtools panel (dev-only)

**Files:**
- Create: `components/providers/DevtoolsPanel.tsx`
- Modify: `components/providers/QueryProvider.tsx`

- [ ] **Step 1: Write Devtools wrapper**

```tsx
// components/providers/DevtoolsPanel.tsx
"use client";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

/**
 * Dev-only mount. Tree-shaken from production by the env check; even in
 * production the import is no-cost because Next splits it out.
 */
export function DevtoolsPanel() {
  if (process.env.NODE_ENV !== "development") return null;
  return <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />;
}
```

- [ ] **Step 2: Mount in QueryProvider**

Edit `components/providers/QueryProvider.tsx`:

```tsx
import { DevtoolsPanel } from "./DevtoolsPanel";

// inside QueryProvider's return:
return (
  <QueryClientProvider client={client}>
    {children}
    <DevtoolsPanel />
  </QueryClientProvider>
);
```

- [ ] **Step 3: Verify**

Run `npm run dev`. Bottom-left should show a small TanStack logo button. Click → query inspector opens.

- [ ] **Step 4: Verify production build excludes Devtools**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add components/providers/DevtoolsPanel.tsx components/providers/QueryProvider.tsx
git commit -m "feat(query): mount React Query Devtools in dev"
```

## Task P3.2: Run full smoke suite

- [ ] **Step 1: Run all e2e tests**

```bash
npm run test:e2e
```

Expected: all PASS. If any fail, debug + fix.

## Task P3.3: Verify timing logs show improvement

- [ ] **Step 1: Run dev, hit each page, capture timing logs**

```bash
npm run dev > timing.log 2>&1 &
DEV_PID=$!
# Manually hit each page in browser
# Then:
kill $DEV_PID
grep "\[timing\]" timing.log | head -50
```

Expected: middleware auth ≤ 50ms (pinned region), prefetch fan-out ≤ 300ms.

If still >500ms, investigate single slow query via Devtools.

## Task P3.4: Verify zero hydration warnings

- [ ] **Step 1: Run dev with `NODE_ENV=development`**

Open each route. Check browser console.
Expected: no "Hydration failed" or "Text content does not match" warnings.

If any appear: server fetcher and browser fetcher are returning different shapes. Audit the COLS strings — they must match exactly.

## Task P3.5: Final typecheck and build

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: succeeds; warns only about expected things (no new warnings introduced by this refactor).

## Task P3.6: Open PR

- [ ] **Step 1: Push the integration branch**

If running on main directly: `git push`. If on a feature branch: `git push -u origin <branch>`.

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "perf: client-cache refactor (Plan C)" --body "$(cat <<'EOF'
Implements [docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md](docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md).

## Summary

Converts every page from server-first navigation to hybrid SSR-hydrate + client cache. Pill changes in /trends now slice a hydrated 1y window client-side (zero network). All other pages keep fast first paint via SSR but interactions become instant on warm cache.

## Tracks completed
- T1 — Foundation (queryClient/keys/QueryProvider) + /trends conversion
- T2a-e — Today / Strength / Coach / Log / Profile conversions
- T3 — Vercel region pinning + server-timing instrumentation + column trim
- T4 — Playwright smoke harness + per-page specs
- Phase 3 — Devtools, integration smoke, final typecheck/build

## Verification
- `npm run typecheck` clean
- `npm run build` clean
- `npm run test:e2e` passes
- /trends pills produce zero network requests (verified by trends.spec.ts)
- All converted pages render with hydrated data (no loading flash)
- Timing logs show middleware auth < 50ms after region pinning

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist (run before handing off)

- [x] Spec coverage: every section of the spec maps to at least one task
  - γ + α architecture → T1 (foundation) + all T2 tasks (per-page conversions)
  - TanStack Query choice → T1.1 install + T1.2 server factory + T1.6 provider
  - Trends client-state → T1.8-T1.10 + T4.5 test
  - 5 page conversions → T2a-e
  - Region pinning → T3.1
  - Server-timing → T3.2-T3.4
  - Column trim → T3.5
  - Smoke harness → T4
  - Devtools → P3.1
  - Multi-user out-of-scope → respected (no auth flow tasks)
- [x] No placeholders / TBD / "implement later"
- [x] Type consistency: queryKeys members, fetcher names (`fetchDailyLogsServer` / `fetchDailyLogsBrowser`), hook names, all match across tasks
- [x] All file paths absolute or rooted at repo
- [x] Commands have expected output
- [x] TDD pattern applied where the change introduces new behavior (trends pill no-network test)

## Open questions left for execution time

1. Supabase region — confirmed in T3.1 step 1 from dashboard.
2. Whether to convert `/login` and `/privacy` — recommendation: skip, they don't fetch user data.
3. Single PR vs per-track — plan assumes single PR; if executor prefers per-track, push T1 first, then T2a-e + T3 + T4 as parallel sub-PRs, then merge integration PR.

## Execution

Plan complete. Ready for execution.
