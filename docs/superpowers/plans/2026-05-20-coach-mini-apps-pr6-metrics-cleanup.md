# PR 6 — Metrics page (Peter) + cleanup (coach mini-apps restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Peter's real Metrics page (trends + weekly review + nudges + Peter chat with specialist-thread context-injection), lift `/coach/weeks/*` and `/coach/reviews` into `/metrics/weeks/*` and `/metrics/reviews`, then delete the entire legacy `/coach/` route + `/metrics/_sub/` shell + `app/meal/page.tsx` redirect + `lib/coach/router.ts` + the speaker-routing audit script. This is the final PR in the 6-PR restructure arc.

**Architecture:** Four structural moves. (1) New `lib/coach/peter-context.ts` reads the last N user-visible turns from each specialist thread (Carter/Nora/Remi) and formats them as a deterministic context block injected into Peter's snapshot prefix. (2) The new `MetricsClient` is the Hybrid layout (data top, chat bottom) seen on Strength/Diet/Health: coach-trends section pills + headline cards on top, `ChatPanel` with `thread='peter'` on bottom. Weekly review and proactive nudge cards naturally appear inside the chat thread because they're already `chat_messages` rows with appropriate `kind`. (3) `app/metrics/page.tsx` rewrites to a clean Server Component that prefetches Peter's data and renders `MetricsClient` — no more sub-pill switch. The legacy `MetricsShell` + `layout.tsx` + `_sub/` folder are deleted. (4) The chat route at `app/api/chat/messages/route.ts` stops calling `classifyTurn` — every caller now passes `speaker_override` (= `thread`) via the per-coach pages, so the default is just `'peter'`.

**Tech Stack:** Next.js 15 App Router, TanStack Query (existing hooks reused), TypeScript strict mode. No new migrations.

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md)

**Prior PRs in this arc:**
- [PR 1 — chat thread foundation](2026-05-20-coach-mini-apps-pr1-chat-foundation.md) (merged #98)
- [PR 2 — nav + scaffolding](2026-05-20-coach-mini-apps-pr2-nav-scaffolding.md) (merged #99)
- [PR 3 — Strength page](2026-05-20-coach-mini-apps-pr3-strength-page.md) (merged #101)
- [PR 4 — Diet page](2026-05-20-coach-mini-apps-pr4-diet-page.md) (merged #103)
- [PR 5 — Health page](2026-05-20-coach-mini-apps-pr5-health-page.md) (merged #104)

**Suggested branch:** `feat/coach-pr6-metrics-cleanup` (cut from `main`).

---

## File Structure

**New:**
- `lib/coach/peter-context.ts` — fetches last 5 user-visible turns per specialist thread, returns formatted context block.
- `components/metrics/MetricsClient.tsx` — Peter's Metrics page Client Component (trends + Peter chat in Hybrid layout).
- `app/metrics/weeks/[week_start]/page.tsx` — lifted from `/coach/weeks/[week_start]/page.tsx`.
- `app/metrics/reviews/page.tsx` — lifted from `/coach/reviews/page.tsx`.

**Modified:**
- `app/metrics/page.tsx` — rewrite as Server Component that prefetches Peter's data + renders `MetricsClient`. Removes sub-pill switch + all sub-pill redirects (Strength/Body/Log all moved to their own pages by PRs 3-5, no longer need a redirect entry).
- `app/api/chat/messages/route.ts` — drop the `classifyTurn` call + the `system_routing` audit row insert. Speaker comes from request body's `speaker_override`, defaults to `'peter'`.
- `lib/coach/chat-stream.ts` — wire `peter-context.ts` into the snapshot prefix for `thread='peter'` turns.
- `next.config.ts` — add `/coach`, `/coach/:path*` → `/metrics` redirects (so legacy bookmarks land somewhere sensible).

**Deleted:**
- `app/coach/` — entire folder (page, layout, progress, reviews, weeks).
- `app/metrics/_sub/` — entire folder (4 sub-pill components no longer reachable).
- `app/metrics/layout.tsx` — was wrapping MetricsShell with the sub-pill nav; gone.
- `app/metrics/MetricsShell.tsx` — Client shell with SubPillNav + FAB; gone.
- `app/meal/page.tsx` — the redirect-only file from PR 4 (and the surrounding `app/meal/` folder).
- `lib/coach/router.ts` — `classifyTurn` no longer called.
- `scripts/audit-speaker-routing.mjs` — script for auditing the router that no longer exists.

**Explicitly NOT deleted:**
- `components/coach/` — `CoachCard.tsx` and other components are imported by chat-lane cards (`components/chat/WeeklyReviewCard.tsx`, `ProactiveNudgeCard.tsx`, etc.). Stay.
- `components/coach/trends/` — `CoachTrendsView` is reused inside `MetricsClient`. Stays.
- The `kind='morning_brief'` / `kind='weekly_review'` / `kind='proactive_nudge'` chat-row rendering — these surface inside Peter's chat thread on `/metrics` automatically.

---

## Task 1: Build `peter-context.ts` + wire into chat-stream

**Files:**
- Create: `lib/coach/peter-context.ts`
- Modify: `lib/coach/chat-stream.ts`

When the user chats with Peter on `/metrics`, his system prompt should be augmented with a "Recent specialist activity" block — a deterministic templated summary of the last 5 user-visible turns from each of Carter, Nora, and Remi's threads. This makes Peter feel synthetic across the team without needing real-time orchestration.

This is **deterministic templating** — no LLM call. Just SQL + string formatting.

- [ ] **Step 1: Build the helper**

Create `lib/coach/peter-context.ts`:

```ts
// lib/coach/peter-context.ts
//
// Generates the "Recent specialist activity" block injected into Peter's
// system prompt when the user chats with him on /metrics. Pure templating —
// no LLM call, no fabrication risk.
//
// Reads the last 5 user-visible turns from each specialist's thread
// (Carter/Nora/Remi), formats them as bullets the model can ground on
// when answering cross-domain questions.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Speaker } from "@/lib/data/types";

const SPECIALISTS: ReadonlyArray<Exclude<Speaker, "peter" | "user">> = ["carter", "nora", "remi"];
const PER_THREAD_LIMIT = 5;

const SPECIALIST_LABEL: Record<Exclude<Speaker, "peter" | "user">, string> = {
  carter: "Coach Carter (strength)",
  nora: "Nora (nutrition)",
  remi: "Remi (recovery)",
};

type Row = { speaker: string; content: string; created_at: string };

/** Returns the formatted context block, or null if all specialist threads
 *  are empty (skip the block entirely rather than emit "no activity"). */
export async function buildPeterContextBlock(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const sections = await Promise.all(
    SPECIALISTS.map(async (sp) => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("speaker, content, created_at")
        .eq("user_id", userId)
        .eq("thread", sp)
        .in("kind", ["coach", "proactive_nudge"])
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(PER_THREAD_LIMIT);

      if (error || !data || data.length === 0) return null;
      return { speaker: sp, rows: data.reverse() as Row[] };
    }),
  );

  const present = sections.filter((s): s is { speaker: Exclude<Speaker, "peter" | "user">; rows: Row[] } => s !== null);
  if (present.length === 0) return null;

  const lines: string[] = ["# Recent specialist activity\n"];
  for (const section of present) {
    lines.push(`## ${SPECIALIST_LABEL[section.speaker]}`);
    for (const r of section.rows) {
      const date = r.created_at.slice(0, 10);
      const snippet = r.content.replace(/\s+/g, " ").trim().slice(0, 160);
      lines.push(`- ${date}: ${snippet}${snippet.length === 160 ? "…" : ""}`);
    }
    lines.push("");
  }

  lines.push(
    "When answering cross-domain questions, ground in the specialist activity above. If the user asks about a topic a specialist recently discussed, reference that conversation by date. You do not need to repeat the specialists' advice — synthesize across them.",
  );

  return lines.join("\n");
}
```

The 160-char snippet truncation keeps the prompt bounded. Adjust if the actual data has very long or very short messages.

- [ ] **Step 2: Wire into chat-stream**

Read `lib/coach/chat-stream.ts` to find where the system prompt is assembled. Look for where `opts.systemPrompt` is used (around line 184 per PR 1's code — the system text composition).

The cleanest integration: when `opts.speaker === "peter"` AND `opts.thread === "peter"` (or just speaker since they're equal for assistant turns), prepend the peter-context block to the system prompt. The block goes between the existing snapshot prefix and the per-turn header (ephemeral, not cached) — but Peter's snapshot is already cached.

Simplest implementation: pass the pre-fetched context block in `opts` and prepend it to the systemText:

```ts
// In RunChatStreamOpts:
/** Optional pre-fetched peter-context block. Caller (the chat route)
 *  builds it via buildPeterContextBlock when thread === 'peter'. */
peterContext?: string | null;

// In runChatStream body, just below `const systemText = ...`:
const finalSystemText = opts.peterContext
  ? `${systemText}\n\n${opts.peterContext}`
  : systemText;

// Use finalSystemText where systemText was being used (the `system` array).
```

Then in `app/api/chat/messages/route.ts`, when assembling the runChatStream call for a Peter turn, build and pass the context:

```ts
import { buildPeterContextBlock } from "@/lib/coach/peter-context";

// ... before the runChatStream call ...
const peterContext = initialSpeaker === "peter"
  ? await buildPeterContextBlock(sr, user.id)
  : null;

// ... in the runChatStream({...}) call:
peterContext,
```

The cache control on the system prompt block stays — peter-context is moderate-frequency-changing, but stale-by-an-hour is acceptable (the cache TTL is 1h).

If the route already has a more complex system-prompt-building helper (e.g., `buildSystemPrompt`), inject the peter-context there instead. Match the local pattern.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/peter-context.ts lib/coach/chat-stream.ts app/api/chat/messages/route.ts
git commit -m "feat(coach): inject specialist context into Peter's prompt on /metrics"
```

---

## Task 2: Build `MetricsClient`

**Files:**
- Create: `components/metrics/MetricsClient.tsx`

Peter's Metrics page renders the Hybrid layout: trends on top, Peter chat below. Weekly review + proactive nudges appear inside the chat thread naturally (they're `chat_messages` rows with appropriate `kind`).

- [ ] **Step 1: Read existing CoachTrendsView**

```bash
cat components/coach/trends/CoachTrendsView.tsx | head -40
```

Note its props (likely `payload: CoachTrendsPayload`, `section: "performance" | "composition" | "cross"`). Confirm it's a Client Component.

- [ ] **Step 2: Build MetricsClient**

Create `components/metrics/MetricsClient.tsx`:

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CoachTrendsView } from "@/components/coach/trends/CoachTrendsView";
import type { CoachTrendsPayload } from "@/lib/data/types";

type Props = {
  userId: string;
  trends: CoachTrendsPayload | null;
};

export function MetricsClient({ userId, trends }: Props) {
  const params = useSearchParams();
  const sectionParam = params.get("section");
  const section: "performance" | "composition" | "cross" =
    sectionParam === "composition" || sectionParam === "cross"
      ? sectionParam
      : "performance";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 88px)" }}>
      {/* Data block — top: coach trends with section pills */}
      <div style={{ flex: "0 0 auto" }}>
        {trends ? (
          <CoachTrendsView payload={trends} section={section} />
        ) : (
          <div style={{ padding: 16, color: "#888", fontSize: 13 }}>
            Trends data not yet available.
          </div>
        )}
      </div>

      {/* Chat block — bottom: Peter chat (weekly review + nudges appear inline) */}
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 320 }}>
        <ChatPanel
          userId={userId}
          embedded={true}
          initialKind="coach"
          thread="peter"
        />
      </div>
    </div>
  );
}
```

If `CoachTrendsView` has a different prop name (e.g., `data` instead of `payload`), adapt. If it includes its own section-pill rendering, drop the `section` prop and let it self-manage.

If `CoachTrendsPayload` is exported from a different path (e.g., `@/lib/coach/trends/types`), update the import.

If `ChatPanel` is a default export, adapt: `import ChatPanel from "@/components/chat/ChatPanel"`.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/metrics/MetricsClient.tsx
git commit -m "feat(metrics): build MetricsClient with trends + Peter chat"
```

---

## Task 3: Rewrite `app/metrics/page.tsx` + delete the legacy shell

**Files:**
- Modify: `app/metrics/page.tsx`
- Delete: `app/metrics/layout.tsx`
- Delete: `app/metrics/MetricsShell.tsx`

The new `/metrics` is Peter's Metrics page. No more sub-pill nav. The sub-pill redirects (strength/body/log) are no longer needed because the old URLs were already redirected by PRs 3-5 — but to be safe, keep the redirects in place (defense-in-depth for stale URLs).

- [ ] **Step 1: Rewrite `app/metrics/page.tsx`**

Replace the entire file with a Server Component that prefetches Peter's data + renders MetricsClient. Pattern:

```tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchCoachTrendsServer } from "@/lib/query/fetchers/coachTrends";
import { MetricsClient } from "@/components/metrics/MetricsClient";
import { COLOR } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

type SP = {
  searchParams?: Promise<{
    sub?: string;
    section?: string;
    // forwarded redirects for stale URLs:
    ex?: string;
    date?: string;
  }>;
};

export default async function MetricsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};

  // Defense-in-depth redirects for stale URLs. The /coach mini-apps split
  // happened in PRs 3-5; any user with bookmarked /metrics?sub=X still
  // lands on the right new home.
  if (sp.sub === "strength" && !sp.ex) {
    redirect("/strength?tab=coach");
  }
  if (sp.sub === "body") {
    redirect("/diet?tab=coach");
  }
  if (sp.sub === "log") {
    const dateQs = sp.date ? `&date=${encodeURIComponent(sp.date)}` : "";
    redirect(`/health?tab=log${dateQs}`);
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Trends use service-role per the existing /coach/progress pattern.
  const sr = createSupabaseServiceRoleClient();
  const queryClient = makeServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: queryKeys.coachTrends.one(user.id),
    queryFn: () => fetchCoachTrendsServer(sr, user.id),
  });

  const trends = queryClient.getQueryData(queryKeys.coachTrends.one(user.id)) ?? null;

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Metrics</h1>
          <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
            Peter · Head Coach
          </p>
        </header>
        <MetricsClient userId={user.id} trends={trends as Parameters<typeof MetricsClient>[0]["trends"]} />
      </div>
    </HydrationBoundary>
  );
}
```

Adjust:
- The query key and fetcher name to match what `/coach/progress/page.tsx` uses today (the survey confirmed `queryKeys.coachTrends.one(user.id)` + `fetchCoachTrendsServer`).
- The `getQueryData` cast — if there's a cleaner pattern in the codebase, use it.
- If `fetchCoachTrendsServer` takes different args (e.g., `(supabase, userId, today)`), adapt.

- [ ] **Step 2: Delete the layout + shell**

```bash
git rm app/metrics/layout.tsx app/metrics/MetricsShell.tsx
```

After this:
- The `/metrics` route no longer has a layout that wraps the page; Next.js falls back to the parent `app/layout.tsx` (which has the global BottomNav and theme wrapper).
- The `+ Log entry` FAB from MetricsShell is gone — that's intentional, the FAB was tied to the legacy sub-pill view. If a global FAB is desired, it can be added separately on a per-page basis later.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/metrics/page.tsx
git commit -m "feat(metrics): replace sub-pill shell with Peter's Metrics page"
```

---

## Task 4: Create `/metrics/weeks/[week_start]` (lift from `/coach/weeks/[week_start]`)

**Files:**
- Create: `app/metrics/weeks/[week_start]/page.tsx`

The weekly-review detail page moves to `/metrics/weeks/[week_start]`. Lift the content from `app/coach/weeks/[week_start]/page.tsx` mostly verbatim — only the file path changes.

- [ ] **Step 1: Read the existing file**

```bash
cat app/coach/weeks/[week_start]/page.tsx
```

Note its imports, data-fetching pattern, and the `WeeklyReviewPage` component it renders.

- [ ] **Step 2: Create the new file**

Copy the content as-is to `app/metrics/weeks/[week_start]/page.tsx`. Adjust ONLY:
- Any internal links it might generate that point to `/coach/weeks/X` should now point to `/metrics/weeks/X` (search for `/coach/` in the file).
- Imports stay as `@/`-aliased paths.

If `WeeklyReviewPage.tsx` itself has internal links to `/coach/*` URLs (e.g., "back to reviews"), update those to `/metrics/*` — that affects the SHARED component, which is OK because PR 6 deletes /coach entirely.

```bash
mkdir -p "app/metrics/weeks/[week_start]"
cp "app/coach/weeks/[week_start]/page.tsx" "app/metrics/weeks/[week_start]/page.tsx"
```

Then edit any `/coach/` URLs in the copied file.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/metrics/weeks/[week_start]/page.tsx"
git commit -m "feat(metrics): lift weekly review detail page from /coach/weeks"
```

---

## Task 5: Create `/metrics/reviews` (lift from `/coach/reviews`)

**Files:**
- Create: `app/metrics/reviews/page.tsx`

The reviews list moves to `/metrics/reviews`. Same lift pattern as Task 4.

- [ ] **Step 1: Read the existing file**

```bash
cat app/coach/reviews/page.tsx
```

- [ ] **Step 2: Copy and adjust**

```bash
mkdir -p app/metrics/reviews
cp app/coach/reviews/page.tsx app/metrics/reviews/page.tsx
```

In the copied file, change any `/coach/weeks/${week_start}` links to `/metrics/weeks/${week_start}`. Same for any `/coach/` URLs in the surrounding UI.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/metrics/reviews/page.tsx
git commit -m "feat(metrics): lift weekly reviews list from /coach/reviews"
```

---

## Task 6: Add next.config.ts redirects for legacy `/coach/*` URLs

**Files:**
- Modify: `next.config.ts`

Add 308 redirects so any bookmarked or PWA-cached `/coach/*` URL lands on the right new home.

- [ ] **Step 1: Add the redirects**

In `next.config.ts`, find the `async redirects()` block. Add new entries (place above any catch-all rules):

```ts
async redirects() {
  return [
    // Existing entries (trends, log, coach/trends → progress, etc.) stay
    // ...existing entries...

    // PR 6: collapse the entire /coach/* legacy surface into /metrics.
    { source: "/coach",                  destination: "/metrics",                permanent: true },
    { source: "/coach/progress",         destination: "/metrics",                permanent: true },
    { source: "/coach/progress/:path*",  destination: "/metrics",                permanent: true },
    { source: "/coach/reviews",          destination: "/metrics/reviews",        permanent: true },
    { source: "/coach/weeks/:week_start",destination: "/metrics/weeks/:week_start", permanent: true },
  ];
},
```

Also REMOVE the obsolete `/coach/trends` → `/coach/progress` redirect (both targets dying):

Delete:
```ts
{ source: "/coach/trends",        destination: "/coach/progress",       permanent: true },
{ source: "/coach/trends/:path*", destination: "/coach/progress",       permanent: true },
```

Add equivalents that go straight to /metrics:
```ts
{ source: "/coach/trends",        destination: "/metrics",              permanent: true },
{ source: "/coach/trends/:path*", destination: "/metrics",              permanent: true },
```

- [ ] **Step 2: Verify the redirect list**

After your edits, `redirects()` should have entries for:
- /trends → /metrics?sub=trends (existing)
- /trends/:path* → /metrics?sub=trends (existing)
- /log → /metrics?sub=log (existing — but this also dies in PR 6's deletion; leave for now, page-level redirect handles it)
- /coach → /metrics (new)
- /coach/progress → /metrics (new)
- /coach/progress/:path* → /metrics (new)
- /coach/reviews → /metrics/reviews (new)
- /coach/weeks/:week_start → /metrics/weeks/:week_start (new)
- /coach/trends → /metrics (new, replaces old)
- /coach/trends/:path* → /metrics (new, replaces old)

If the old `/trends` redirect points to `/metrics?sub=trends` which no longer exists (sub-pill switch deleted in Task 3), it now goes to a page that ignores the sub param — harmless, but inconsistent. Update to plain `/metrics`:

```ts
{ source: "/trends",        destination: "/metrics", permanent: true },
{ source: "/trends/:path*", destination: "/metrics", permanent: true },
{ source: "/log",           destination: "/metrics", permanent: true },
```

The `?sub=` query is silently dropped on these redirects.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS (next.config.ts is checked).

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git commit -m "feat(nav): add /coach/* redirects to /metrics + tidy old redirects"
```

---

## Task 7: Drop `classifyTurn` from chat route + delete obsolete files

**Files:**
- Modify: `app/api/chat/messages/route.ts`
- Delete: `lib/coach/router.ts`, `scripts/audit-speaker-routing.mjs`
- Delete: `app/coach/` (entire folder)
- Delete: `app/metrics/_sub/` (entire folder)
- Delete: `app/meal/` (entire folder — was a redirect after PR 4)

After PRs 3-5, all chat-streaming requests come from per-coach pages that pass `speaker_override` (= `thread`). The legacy `/coach` page is the last caller that depended on `classifyTurn`. PR 6 deletes `/coach` AND drops `classifyTurn` simultaneously.

- [ ] **Step 1: Update `app/api/chat/messages/route.ts`**

Find the `classifyTurn` call (around lines 313-340 per PR 1's structure). Replace:

```ts
let routerDecision: RouterDecision;
if (effectiveMode === "intake") {
  routerDecision = { speaker: "peter", method: "manual", confidence: 1 };
} else {
  try {
    routerDecision = await classifyTurn({ text: content, mode: effectiveMode, override: overrideSpeaker, abortSignal: req.signal });
  } catch (routeErr) {
    console.error("[chat] classifyTurn threw — falling back to peter", routeErr);
    routerDecision = { speaker: "peter", method: "fallback", confidence: 0.5 };
  }
}
const initialSpeaker: Speaker = routerDecision.speaker;
```

With:

```ts
// Every active chat surface (Strength/Diet/Health/Metrics) passes
// speaker_override = the page's thread. Intake mode is single-voice
// (Peter). No router needed — the speaker is the override or 'peter'.
const initialSpeaker: Speaker = overrideSpeaker ?? "peter";
```

Then delete the imports that are now unused:

```ts
import { classifyTurn, type RouterDecision } from "@/lib/coach/router";
```

Find the `system_routing` audit row insert (around line 352-368). It's now misleading since there's no router to audit. **Delete the entire insert** — it adds noise without value:

```ts
// Delete this entire block:
await sr.from("chat_messages").insert({
  user_id: user.id,
  role: "assistant",
  speaker: initialSpeaker,
  thread: initialSpeaker,
  kind: "system_routing",
  // ...
});
```

`system_routing` rows already in the DB stay (historical audit); we just stop writing new ones.

If any other code in the route references `routerDecision.*`, replace with the equivalent value from `initialSpeaker` / a constant. For example, if the assistant stub update used `routerDecision.method`, that field no longer exists — just hard-code `"manual"` or drop it.

- [ ] **Step 2: Delete the obsolete files**

```bash
git rm lib/coach/router.ts
git rm scripts/audit-speaker-routing.mjs
git rm -r app/coach
git rm -r app/metrics/_sub
git rm -r app/meal
```

- [ ] **Step 3: Confirm nothing imports the deleted modules**

```bash
grep -rn "from \"@/lib/coach/router\"\|from '@/lib/coach/router'\|classifyTurn\|RouterDecision" lib app components 2>/dev/null | grep -v ".next"
```

Expected: no matches. If anything still imports `router.ts`, remove the import + fix the consumer.

```bash
grep -rn "audit-speaker-routing" . 2>/dev/null | grep -v ".next\|node_modules\|.git"
```

Expected: matches only in CLAUDE.md (documentation reference). Update CLAUDE.md if it references the script as if it still exists — change to past tense or remove the bullet.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. Any lingering references to deleted symbols will surface here.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/messages/route.ts
git commit -m "refactor(chat): drop classifyTurn + delete /coach, /metrics/_sub, /meal, router.ts"
```

The `git rm` commands above already staged the deletions, so this single commit captures both the route edit and all deletions.

---

## Task 8: Final typecheck + smoke + push

- [ ] **Step 1: Clean typecheck**

```bash
rm -rf .next
npm run typecheck
```

Expected: PASS with zero errors.

- [ ] **Step 2: End-to-end smoke**

```bash
npm run dev &
NEXT_PID=$!
sleep 10
```

1. `/metrics` → Peter's Metrics page: trends section pills + headline cards + Peter chat at bottom. Send a message → Peter responds (network shows `&thread=peter`, `speaker_override: "peter"`).
2. `/metrics?section=composition` → trends section switches to Composition.
3. `/metrics/reviews` → list of weekly reviews. Tap one → goes to `/metrics/weeks/[week_start]`. Detail renders.
4. Legacy URL tests (redirect chain):
   - `/coach` → 308 → `/metrics`
   - `/coach/progress` → 308 → `/metrics`
   - `/coach/reviews` → 308 → `/metrics/reviews`
   - `/coach/weeks/2026-05-12` → 308 → `/metrics/weeks/2026-05-12`
   - `/meal` → 308 → ??? (the page redirect file is deleted; without it `/meal` returns 404. Add a next.config redirect for `/meal` if needed).
5. Strength/Diet/Health still work — tap each bottom-nav tab and confirm.
6. Peter's chat with specialist context: ask Peter "what's going on across the team" — his response should reference recent Carter/Nora/Remi activity if the threads have content. (If the threads are empty, peter-context.ts emits nothing — fine.)

Kill dev.

If `/meal` needed a redirect after the page-file deletion, add to next.config.ts:

```ts
{ source: "/meal", destination: "/diet?tab=log", permanent: true },
```

And commit:

```bash
git add next.config.ts
git commit -m "feat(nav): add /meal redirect to next.config (page file deleted)"
```

- [ ] **Step 3: Show final commit log**

```bash
git log --oneline main..HEAD
```

Expected: 7-9 commits (plan + 7-8 task commits).

- [ ] **Step 4: Push**

```bash
git push -u origin feat/coach-pr6-metrics-cleanup
```

---

## Completion

After this PR merges, the coach mini-apps restructure is done:
- 6 tabs (Today / Strength / Diet / Health / Metrics / Profile)
- Each specialist has a dedicated page with Coach + Log sub-tabs
- Peter inhabits Metrics with cross-cutting trends + specialist context-injection
- Legacy `/coach`, `/meal`, `/metrics/_sub/*` are gone
- The auto-router (`classifyTurn`) is gone — users pick coach by tab

**Future polish (separate later PRs):**
- Morning intake chat-flow embedded in `/health?tab=log`
- Manual symptom log on `/health?tab=log`
- HRV mini-sparkline graphic on `/health?tab=coach`
- "Unread message" dot on Coach pills (Strength/Diet/Health)
- Morning brief block on `/` (Today) per the original spec
