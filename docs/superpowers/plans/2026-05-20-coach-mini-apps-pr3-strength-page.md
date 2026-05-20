# PR 3 — Strength page (coach mini-apps restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/strength` placeholder with the real Coach + Log surfaces. Coach renders today's session + e1RM headline + mesocycle week + adherence + Carter chat thread. Log renders the read-only workout history. Activates the `/metrics?sub=strength` redirect to `/strength?tab=coach`. Also lands the thread-filter infrastructure (ChatPanel `thread` prop + `/api/chat/messages?thread=` filter) that PRs 4-6 reuse.

**Architecture:** Three structural moves. (1) `/api/chat/messages` GET grows a `?thread=` filter and returns the `thread` column. (2) `ChatPanel` grows a `thread?: Speaker` prop that, when set, scopes its history fetch to that thread AND pins the composer's `speaker_override` to that coach — making the page feel like a 1:1 chat with one specialist. (3) `app/strength/page.tsx` swaps from placeholder to a real Server Component that prefetches strength data, hydrates a Client Component that lifts the `TodayPlanCard` + headline metrics from the existing strength sub-pill, and mounts `ChatPanel` with `thread='carter'`. The Log sub-tab gets a separate Client Component reading from `useFullWorkouts`.

The page anatomy (data on top, chat on bottom on the Coach tab; data-entry-only on the Log tab) matches the spec's "Hybrid layout" decision.

**Tech Stack:** Next.js 15 App Router with hybrid SSR-hydrate pattern (see [docs/superpowers/specs/2026-05-07-client-cache-refactor-design.md](../specs/2026-05-07-client-cache-refactor-design.md)), TanStack Query (existing hooks reused), Anthropic SDK (already plumbed via `lib/coach/chat-stream.ts` post-PR 1), TypeScript strict mode.

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md)

**Prior PRs in this arc:**
- [PR 1 — chat thread foundation](2026-05-20-coach-mini-apps-pr1-chat-foundation.md) (merged #98)
- [PR 2 — nav + scaffolding](2026-05-20-coach-mini-apps-pr2-nav-scaffolding.md) (merged #99)

**Suggested branch:** `feat/coach-pr3-strength-page` (cut from `main`).

---

## File Structure

**Modified:**
- `app/api/chat/messages/route.ts` — GET handler accepts `?thread=peter|carter|nora|remi`, filters by it, includes `thread` in the SELECT.
- `lib/chat/types.ts` — `ChatMessage` type gains `thread: Speaker`.
- `components/chat/ChatPanel.tsx` — accepts `thread?: Speaker` prop; threads it into the history fetch and the composer's `speaker_override`.
- `app/strength/page.tsx` — placeholder swapped for a Server Component that gates auth + prefetches.
- `app/metrics/page.tsx` — adds a `?sub=strength` → `/strength?tab=coach` redirect.

**New:**
- `components/strength/StrengthCoachClient.tsx` — the Coach sub-tab body (data block + ChatPanel for Carter).
- `components/strength/StrengthLogClient.tsx` — the Log sub-tab body (workout history table).

**Untouched (deferred):**
- `app/coach/` — chat surface stays alive; PR 6 replaces it with Peter on Metrics.
- `app/metrics/_sub/StrengthSubPill.tsx` — kept until PR 6's broader /metrics cleanup. After this PR's redirect lands, this sub-pill is unreachable via the nav UI but the file stays as the source-of-truth pattern PR 6 will dismantle.

---

## Task 1: Add `thread` filter to GET `/api/chat/messages` + extend `ChatMessage` type

**Files:**
- Modify: `app/api/chat/messages/route.ts`
- Modify: `lib/chat/types.ts`

The GET handler already filters by `user_id` + `kind`. PR 1's migration added `chat_messages.thread`. This task selects the column, exposes it on the returned shape, and optionally filters by `?thread=<value>`.

- [ ] **Step 1: Extend the `ChatMessage` type to include `thread`**

Read `lib/chat/types.ts` to confirm the current `ChatMessage` shape. Add a `thread: Speaker` field (Speaker is imported from `@/lib/data/types` — if it's not already imported there, add the import).

Use Edit to add the field. If the type is defined as:

```ts
export type ChatMessage = {
  id: string;
  role: ChatRole;
  // ... existing fields ...
  speaker: Speaker;
  kind: ChatMessageKind;
  // ...
};
```

Add `thread: Speaker;` adjacent to `speaker`. The order in the type doesn't affect runtime — just place it next to `speaker` for readability.

If `Speaker` isn't already imported in `lib/chat/types.ts`, add `import type { Speaker } from "@/lib/data/types";` at the top.

- [ ] **Step 2: Add `thread` to the SELECT and add the optional filter**

In `app/api/chat/messages/route.ts` GET handler (lines ~35-70), find the supabase query:

```ts
let q = supabase
  .from("chat_messages")
  .select("id, role, content, status, error, model, kind, ui, tool_calls, mode, created_at, updated_at")
  .eq("user_id", user.id)
  .in("kind", kinds)
  .order("created_at", { ascending: false })
  .limit(limit);
```

Replace the SELECT string to include `speaker, thread`:

```ts
let q = supabase
  .from("chat_messages")
  .select("id, role, content, status, error, model, speaker, thread, kind, ui, tool_calls, mode, created_at, updated_at")
  .eq("user_id", user.id)
  .in("kind", kinds)
  .order("created_at", { ascending: false })
  .limit(limit);
```

If `speaker` was already in the SELECT (it's likely there from PR 1 — check), leave that and only add `thread`.

- [ ] **Step 3: Add the `?thread=` filter**

Just below the `kindRaw` parsing (around line 46-54), add a `thread` parse + filter:

```ts
const threadRaw = url.searchParams.get("thread");
const VALID_THREADS = ["peter", "carter", "nora", "remi"] as const;
const thread = VALID_THREADS.includes(threadRaw as typeof VALID_THREADS[number])
  ? (threadRaw as typeof VALID_THREADS[number])
  : null;
```

Then where you call `.in("kind", kinds)`, add the conditional thread filter on the next line:

```ts
let q = supabase
  .from("chat_messages")
  .select("id, role, content, status, error, model, speaker, thread, kind, ui, tool_calls, mode, created_at, updated_at")
  .eq("user_id", user.id)
  .in("kind", kinds)
  .order("created_at", { ascending: false })
  .limit(limit);
if (thread) q = q.eq("thread", thread);
if (before) q = q.lt("created_at", before);
```

The new line sits between the `.limit(limit)` chain end and the existing `if (before)` line.

- [ ] **Step 4: Map the row's `thread` into the returned ChatMessage**

Find where the route assembles the response from raw rows (search for `as ChatRole` or the section that maps `rows` into typed messages). Wherever `speaker: row.speaker as Speaker,` appears, add `thread: row.thread as Speaker,` right next to it. If you can't find this mapping (it might be a direct return of rows with type casting), report — the implementer may need to add the field to the mapping manually.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. TypeScript will surface any consumer of `ChatMessage` that needs an update.

If typecheck fails inside `components/chat/`, `lib/query/`, or other consumers because they need to read `thread`, those are expected — fix them OR if the fix isn't trivial, STOP and report so the controller can decide whether to extend Task 1's scope.

Most consumers will be fine — `thread` is a new optional-feeling field but typed as required. If a consumer constructs a `ChatMessage` literal without `thread`, TS will flag it. The fix is either to add `thread: 'peter'` to the literal (back-compat default) or to make `thread` optional on the type (worse — looses the invariant). Prefer the literal fix.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/messages/route.ts lib/chat/types.ts
git commit -m "feat(chat): add ?thread= filter to GET /api/chat/messages"
```

---

## Task 2: Add `thread` prop to ChatPanel; scope history + composer

**Files:**
- Modify: `components/chat/ChatPanel.tsx`

When `thread` is passed, ChatPanel becomes a 1:1 chat with that coach:
1. History fetch includes `&thread=${thread}` (Task 1's new filter).
2. Composer's `speaker_override` defaults to `thread`, locking the responding coach.
3. The composer picker UI (if it shows) is hidden — the page is the coach's page; switching coaches doesn't make sense here.

- [ ] **Step 1: Add the `thread` prop**

Find the `ChatPanel` props type / function signature in `components/chat/ChatPanel.tsx`. Add a new optional prop:

```ts
type Props = {
  // ... existing props ...
  /** When set, scopes this chat surface to a single coach's thread.
   *  - History GET appends `&thread=${thread}` so only this coach's turns + user
   *    replies on this thread render.
   *  - Composer's speaker_override defaults to `thread`, pinning Carter / Nora /
   *    Remi / Peter as the responder regardless of the router.
   *  - When omitted (legacy /coach surface), behavior is unchanged: history is
   *    unfiltered and the router picks the speaker per turn. */
  thread?: Speaker;
};
```

If `Speaker` is not imported in this file, add `import type { Speaker } from "@/lib/data/types";`.

- [ ] **Step 2: Thread it into the history fetch**

Find the history fetch (around line 300):

```ts
const res = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
```

Replace with:

```ts
const threadQs = thread ? `&thread=${thread}` : "";
const res = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}${threadQs}`);
```

`thread` here refers to the prop. If the component is currently destructuring props, ensure `thread` is added to the destructure list at the top.

- [ ] **Step 3: Default `speaker_override` to `thread`**

Find the composer's send path (search for `speaker_override` — should appear around line 425 per the prior survey). The send call POSTs to `/api/chat/messages` with a body that may include `speaker_override`. Modify the body construction to default `speaker_override` to the prop's `thread` value when set:

If the current code looks like:

```ts
const body = {
  content,
  mode,
  ...(speakerOverride && { speaker_override: speakerOverride }),
};
```

Update to:

```ts
const body = {
  content,
  mode,
  ...((speakerOverride ?? thread) && { speaker_override: speakerOverride ?? thread }),
};
```

Where `speakerOverride` is the local state from the composer picker, and `thread` is the new prop. The prop becomes the default; the picker (if visible) can still override.

- [ ] **Step 4: Hide the composer picker when `thread` is fixed**

Find where the composer picker is rendered (search for `ChatCoachPicker` import / usage). When `thread` is set, the picker shouldn't render — the user is on Carter's page, the implicit answerer is Carter, no ambiguity.

Wrap the picker JSX in a conditional:

```tsx
{!thread && <ChatCoachPicker ... />}
```

If the picker is rendered inside a larger composer footer, ensure the surrounding flex/grid layout still looks sensible without it.

- [ ] **Step 5: Add deps to relevant useEffect**

The history-loading `useEffect` (around line 297) has `[currentMode]` deps. Add `thread` to the deps array — if the prop changes (unlikely in practice but possible if a parent swaps it), history should re-fetch.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "feat(chat): add thread prop to ChatPanel for per-coach surfaces"
```

---

## Task 3: Build `/strength?tab=coach` data block (Coach sub-tab body)

**Files:**
- Create: `components/strength/StrengthCoachClient.tsx`
- Modify: `app/strength/page.tsx` (replace placeholder with a Server Component + Client routing on the tab param)

The placeholder is gone. The Coach sub-tab now renders:
- Today's session card (lifts the existing `TodayPlanCard` + `SessionStructureBanner` pattern from StrengthClient)
- e1RM headline strip (latest values for the lifts in today's session; uses `useRecentE1RMs`)
- Mesocycle week badge ("Week N of M")
- This-week adherence summary (from useTrainingWeek)
- DaySwapSheet entry chip on the session card (lifts existing wiring)
- Below all that: `ChatPanel` with `thread='carter'`, `userId={...}`, `embedded={true}`, `initialKind="coach"`

- [ ] **Step 1: Read the existing strength sub-pill implementation**

```bash
cat app/metrics/_sub/StrengthSubPill.tsx
cat components/strength/StrengthClient.tsx
```

Note specifically:
- What server-side data StrengthSubPill prefetches and hydrates
- How StrengthClient assembles the DailyPlan for TodayPlanCard
- Where `committedFromPlan`, `rirTarget`, `researchPhase`, `weekStart`, `weekday` are derived
- How `DaySwapSheet` is mounted and wired

The goal is to lift this pattern into `StrengthCoachClient.tsx`. Do NOT modify `StrengthSubPill.tsx` or `StrengthClient.tsx` — they stay alive (deferred-cleanup in PR 6).

- [ ] **Step 2: Create the new Client Component**

Create `components/strength/StrengthCoachClient.tsx`. It accepts `userId` as a prop and renders the data block + `ChatPanel`. Roughly:

```tsx
"use client";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { TodayPlanCard } from "@/components/strength/TodayPlanCard";
// ... import the headline/mesocycle/adherence components or build inline ...
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useRecentE1RMs } from "@/lib/query/hooks/useRecentE1RMs";
// ... etc.

type Props = { userId: string };

export function StrengthCoachClient({ userId }: Props) {
  const { data: trainingWeek } = useTrainingWeek(userId);
  const { data: e1rms } = useRecentE1RMs(userId);
  // ... compose the DailyPlan + mesocycle + adherence ...

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 88px)" }}>
      {/* Data block — top */}
      <div style={{ flex: "0 0 auto", padding: "8px 16px" }}>
        {/* TodayPlanCard with computed props */}
        {/* e1RM headline strip */}
        {/* Mesocycle week badge */}
        {/* Adherence summary */}
      </div>

      {/* Chat block — bottom */}
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 320 }}>
        <ChatPanel
          userId={userId}
          embedded={true}
          initialKind="coach"
          thread="carter"
        />
      </div>
    </div>
  );
}
```

The exact shape of the data block requires you to study StrengthClient's logic. The plan is **NOT prescribing a copy-paste** — you must understand the props TodayPlanCard needs and assemble them. If the existing logic in StrengthClient is too tangled to lift cleanly, extract the relevant computation into a shared helper file (e.g., `lib/strength/build-daily-plan.ts`) and import it from both StrengthClient AND StrengthCoachClient. Don't duplicate logic; share it.

If you can't cleanly extract OR you find that StrengthClient's logic depends on data not available via the existing hooks, STOP and report — the plan didn't anticipate a deep refactor.

- [ ] **Step 3: Replace `app/strength/page.tsx`**

The current placeholder uses `useSearchParams` (Client Component). The new version should be a Server Component that gates auth and renders either `StrengthCoachClient` or `StrengthLogClient` based on the `tab` searchParam. Note that the sub-pill row (`SubPillNav`) stays in the page wrapper because both sub-tabs share it.

Pattern:

```tsx
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { StrengthCoachClient } from "@/components/strength/StrengthCoachClient";
import { StrengthLogClient } from "@/components/strength/StrengthLogClient";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default async function StrengthPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam } = await searchParams;
  const tab = tabParam === "log" ? "log" : "coach";

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Strength</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Coach Carter
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" ? (
        <StrengthCoachClient userId={user.id} />
      ) : (
        <StrengthLogClient userId={user.id} />
      )}
    </div>
  );
}
```

The `searchParams` parameter must be `Promise` and `await`-ed (Next.js 15 convention). Check the existing `/metrics` page or other server components for the local convention if unsure.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `StrengthLogClient` doesn't exist yet (Task 5), this will fail with an unknown-module error. Add a temporary stub file with `export function StrengthLogClient() { return null; }` to satisfy typecheck for now. Task 5 fills it in.

- [ ] **Step 5: Smoke locally**

```bash
rm -rf .next
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `/strength`. Expected:
- Header "Strength" / "Coach Carter"
- Sub-pill row Coach (active) | Log
- Below: TodayPlanCard with today's session, e1RM headline, mesocycle badge, adherence
- Below that: ChatPanel — if Carter has prior messages on the carter thread, they appear; if not, the composer is ready

Tap a message: "drop bench to 92.5 today" — Carter responds, no router needed.

Kill dev.

- [ ] **Step 6: Commit**

```bash
git add app/strength/page.tsx components/strength/StrengthCoachClient.tsx [any shared helpers]
git commit -m "feat(strength): build Coach sub-tab with today's session + Carter chat"
```

---

## Task 4: Build `/strength?tab=log` (workout history table)

**Files:**
- Create: `components/strength/StrengthLogClient.tsx`

The Log sub-tab is a read-only list of past workouts sourced from `useFullWorkouts`. Empty state: "Workout log coming soon — Strong CSV import still active. Tap Coach to plan your next session with Carter."

- [ ] **Step 1: Read the existing workout-history rendering**

```bash
cat components/strength/SessionRow.tsx
cat lib/query/hooks/useFullWorkouts.ts
```

Note: `useFullWorkouts` returns processed `WorkoutSession[]`. `SessionRow` renders an individual workout with clickable exercise drilldown.

- [ ] **Step 2: Implement `StrengthLogClient`**

Replace the stub (created in Task 3 Step 4) with the real component:

```tsx
"use client";

import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
import { SessionRow } from "@/components/strength/SessionRow";
import { COLOR } from "@/lib/ui/theme";

type Props = { userId: string };

export function StrengthLogClient({ userId }: Props) {
  const { data: sessions, isLoading } = useFullWorkouts(userId);

  if (isLoading) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center", color: COLOR.textMuted }}>
        Loading…
      </div>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 12px 0" }}>
          Workout log coming soon — Strong CSV import still active. Tap Coach to
          plan your next session with Carter.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 16px" }}>
      {sessions.map((session) => (
        <SessionRow key={session.id} session={session} />
      ))}
    </div>
  );
}
```

Adapt `session.id` to whatever stable key `WorkoutSession` actually exposes (check the type in `lib/data/types.ts` if unclear).

If `SessionRow` requires more props than just `session` (e.g., `onClick` handlers, expanded state), inspect its current usage in `StrengthClient.tsx` to learn the right wiring. Lift only what's needed — keep `StrengthLogClient` lean.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Smoke**

Open `/strength?tab=log`. Expected: list of past workouts from Strong CSV. Tap a row → exercise drilldown (URL gains `?ex=...`). Tapping back → returns to the list.

If no workouts exist in the DB (fresh test user), the empty state shows.

- [ ] **Step 5: Commit**

```bash
git add components/strength/StrengthLogClient.tsx
git commit -m "feat(strength): build Log sub-tab with workout history"
```

---

## Task 5: Redirect `/metrics?sub=strength` → `/strength?tab=coach`

**Files:**
- Modify: `app/metrics/page.tsx`

Users with bookmarks or in-app links pointing at `/metrics?sub=strength` should land on the new home. The Server Component checks the searchParam and redirects.

- [ ] **Step 1: Read the current `/metrics` page**

```bash
cat app/metrics/page.tsx
```

Note: is it a Server Component or Client? Where does it route to the sub-pill?

- [ ] **Step 2: Add the redirect**

At the top of the page's body (after auth gate, before any data fetching), add:

```ts
import { redirect } from "next/navigation";

// ... inside the page function, after auth gate, after awaiting searchParams ...

const { sub } = await searchParams;
if (sub === "strength") {
  redirect("/strength?tab=coach");
}
```

If `searchParams` isn't already awaited, follow the Next.js 15 pattern: `const params = await searchParams;`.

- [ ] **Step 3: Smoke**

Open `/metrics?sub=strength`. Expected: instant redirect to `/strength?tab=coach`. Other sub values (`/metrics?sub=body`, `/metrics?sub=log`, `/metrics?sub=trends`) continue to work unchanged (they redirect in PRs 4-5-6).

- [ ] **Step 4: Commit**

```bash
git add app/metrics/page.tsx
git commit -m "feat(metrics): redirect ?sub=strength to /strength?tab=coach"
```

---

## Task 6: Final typecheck + manual smoke + push

- [ ] **Step 1: Full typecheck from a clean state**

```bash
rm -rf .next
npm run typecheck
```

Expected: PASS with zero errors.

- [ ] **Step 2: End-to-end manual smoke**

```bash
npm run dev &
NEXT_PID=$!
sleep 10
```

In a browser:

1. `/strength` → Coach tab loads with today's session, e1RM, mesocycle, adherence, Carter chat.
2. Send a message: "should I push or back off today?" → Carter responds (no router; chat-stream sees `thread='carter'`).
3. Tap Log pill → workout history list. Tap a row → exercise drilldown.
4. Tap Coach pill → back to data + chat.
5. `/metrics?sub=strength` in the URL bar → instant redirect to `/strength?tab=coach`.
6. `/coach` directly → chat surface still works (unchanged).
7. Open the network panel during step 2 — confirm POST `/api/chat/messages` body includes `speaker_override: 'carter'` and GET includes `thread=carter`.
8. Run a DB query:

   ```bash
   cd "/Users/abdelouahedelbied/Health app"
   supabase db remote query "select role, speaker, thread, substring(content,1,40) as preview, created_at from chat_messages where user_id = (select id from auth.users limit 1) order by created_at desc limit 4;"
   ```

   Expected: the two rows from step 2 (user + assistant) both have `thread='carter'`. Pre-existing Peter/Nora/Remi rows are untouched.

Kill dev.

- [ ] **Step 3: Confirm commit log**

```bash
git log --oneline main..HEAD
```

Expected: ~5-6 commits (plan, 5 tasks). The plan commit is the first; verify it's there.

If the plan commit landed somewhere else (lessons from PR 2), use the same recovery pattern: cherry-pick into the worktree branch, clean up the misplaced source.

- [ ] **Step 4: Report ready for push**

Do NOT push. Report what's ready. Suggested push:

```bash
git push -u origin feat/coach-pr3-strength-page
```

---

## Subsequent PRs

- **PR 4** — Diet page: Coach (macros + body comp + Nora chat) + Log (full `/meal` lift). Adds `/meal` → `/diet?tab=log` redirect, `/metrics?sub=body` → `/diet?tab=coach` redirect; deletes `app/meal/`.
- **PR 5** — Health page: Coach (recovery cluster + Remi chat) + Log (morning intake + symptom log). Adds `/metrics?sub=log` → `/health?tab=log` redirect.
- **PR 6** — Metrics page (Peter): coach trends + weekly review + nudges + Peter chat with specialist-thread context-injection. Deletes `/coach/*`, `/metrics/_sub/*`, `lib/coach/router.ts`, `scripts/audit-speaker-routing.mjs`.
