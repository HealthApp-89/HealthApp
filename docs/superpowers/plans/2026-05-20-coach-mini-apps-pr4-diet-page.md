# PR 4 — Diet page (coach mini-apps restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/diet` placeholder with the real Coach + Log surfaces. Coach renders today's macros + per-meal-slot cards + body composition + GLP-1 status pill + Nora chat thread. Log lifts the entire `/meal` experience wholesale. Activates the `/meal` → `/diet?tab=log` and `/metrics?sub=body` → `/diet?tab=coach` redirects.

**Architecture:** Three structural moves. (1) `MealJournalClient` relocates from `app/meal/` to `components/meal/` so both `/diet?tab=log` and the legacy `/meal` route (now a redirect) share one source-of-truth — though in practice only Diet uses it. (2) `app/diet/page.tsx` swaps from placeholder Client Component to a real Server Component that gates auth, prefetches Coach-tab OR Log-tab data, hydrates, and renders the appropriate Client. (3) `app/meal/page.tsx` becomes a redirect; `app/metrics/page.tsx` grows a second conditional redirect for `?sub=body` (preserving the existing `?sub=strength` redirect pattern shipped in PR 3).

The page anatomy matches PR 3's pattern: Coach tab is data-on-top + chat-on-bottom (Hybrid layout); Log tab is data-entry-only (no chat). When Nora has a pending message, the spec calls for a small "comment" dot on the Coach pill — this requires unread-message infrastructure that **does not yet exist in the codebase**. PR 4 ships without the dot (the chat thread still loads correctly when the user lands on Coach). The unread indicator can be added in a later phase.

**Tech Stack:** Next.js 15 App Router with hybrid SSR-hydrate pattern, TanStack Query (existing hooks reused), TypeScript strict mode. The thread-filtering infrastructure (PR 3's `ChatPanel.thread` prop + `?thread=` GET filter) is reused as-is.

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md)

**Prior PRs in this arc:**
- [PR 1 — chat thread foundation](2026-05-20-coach-mini-apps-pr1-chat-foundation.md) (merged #98)
- [PR 2 — nav + scaffolding](2026-05-20-coach-mini-apps-pr2-nav-scaffolding.md) (merged #99)
- [PR 3 — Strength page](2026-05-20-coach-mini-apps-pr3-strength-page.md) (merged #101)

**Suggested branch:** `feat/coach-pr4-diet-page` (cut from `main`).

---

## File Structure

**New:**
- `components/meal/MealJournalClient.tsx` — moved from `app/meal/MealJournalClient.tsx` (rename only).
- `components/diet/DietCoachClient.tsx` — Coach sub-tab body: data block + Nora chat.
- `components/diet/DietLogClient.tsx` — Log sub-tab body: thin wrapper around the moved `MealJournalClient`.
- `components/diet/Glp1StatusPill.tsx` — small badge reading `plan_payload.nutrition.glp1` from active plan; shows when GLP-1 mode is active/tapering.

**Modified:**
- `app/diet/page.tsx` — placeholder swapped for a real Server Component (auth gate, per-tab prefetch, hydrate, render).
- `app/meal/page.tsx` — becomes a redirect to `/diet?tab=log` (preserves `?date=` if present).
- `app/metrics/page.tsx` — adds `?sub=body` redirect to `/diet?tab=coach`, mirroring the existing `?sub=strength` redirect.

**Deleted via the move (Task 1):**
- `app/meal/MealJournalClient.tsx` — relocated to `components/meal/MealJournalClient.tsx`.

**Untouched (deferred):**
- `app/coach/` — chat surface stays alive; PR 6 replaces it.
- `app/metrics/_sub/BodySubPill.tsx` — kept until PR 6's broader /metrics cleanup. After this PR's redirect lands, the sub-pill is unreachable via the new nav but the file stays as the source-of-truth pattern PR 6 will dismantle.
- The unread-message dot on the Coach pill (deferred — needs new infrastructure).

---

## Task 1: Move `MealJournalClient` from `app/meal/` to `components/meal/`

**Files:**
- Delete: `app/meal/MealJournalClient.tsx`
- Create: `components/meal/MealJournalClient.tsx` (same content, new path)
- Modify: `app/meal/page.tsx` (import path update)

Pure relocation. The file becomes a reusable Client Component that both the old `/meal` route (briefly, before it becomes a redirect) and the new `/diet?tab=log` route can import.

- [ ] **Step 1: Read the current file content**

```bash
cat app/meal/MealJournalClient.tsx | head -10
```

Confirm the file's `"use client"` directive and the export shape (likely `export default function MealJournalClient(...)` or `export function MealJournalClient(...)`).

- [ ] **Step 2: Move the file**

Use `git mv`:

```bash
git mv app/meal/MealJournalClient.tsx components/meal/MealJournalClient.tsx
```

Git tracks this as a rename, preserving history.

- [ ] **Step 3: Update the import in `app/meal/page.tsx`**

In `app/meal/page.tsx`, find the import of `MealJournalClient`. The old import probably looks like:

```ts
import { MealJournalClient } from "./MealJournalClient";
// OR
import MealJournalClient from "./MealJournalClient";
```

Update to the new absolute path:

```ts
import { MealJournalClient } from "@/components/meal/MealJournalClient";
// OR (preserving default-export form if that's the original):
import MealJournalClient from "@/components/meal/MealJournalClient";
```

Match the original import style exactly. If unsure which form the original uses, run `grep -n "MealJournalClient" components/meal/MealJournalClient.tsx | head -3` to see the export form (named vs default).

- [ ] **Step 4: Confirm no other files import the old path**

```bash
grep -rn "app/meal/MealJournalClient\|from \"./MealJournalClient\"" app components lib 2>/dev/null
```

Expected: no matches. If anything still references the old path, update those imports too.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/meal/page.tsx components/meal/MealJournalClient.tsx
git commit -m "refactor(meal): move MealJournalClient to components/meal/"
```

---

## Task 2: Create the GLP-1 status pill

**Files:**
- Create: `components/diet/Glp1StatusPill.tsx`

Small badge component. Reads the user's active plan via `useActivePlan` (or whatever hook is canonical — check `lib/query/hooks/` for plan-related hooks) and renders a chip when `plan.nutrition.glp1.mode` is `active` or `tapering`. Renders nothing when GLP-1 is inactive or no plan exists.

- [ ] **Step 1: Check for an active-plan hook**

```bash
ls lib/query/hooks/ | grep -i "plan\|profile\|glp1"
grep -rn "plan_payload\|nutrition\.glp1" lib/query/ 2>/dev/null | head -10
```

Find the hook or fetcher that reads the user's active athlete profile document with its `plan_payload`. If a hook exists (e.g., `useActiveProfileDocument` or `usePlanPayload`), use it. If not, find the fetcher for the same data and read its shape from `lib/data/types.ts` (the `AthleteProfileDocument` type likely has `plan_payload: PlanPayload | null` with `PlanPayload.nutrition.glp1?: {...}`).

If you can't find a clean hook, fall back to reading `profiles` directly via Supabase client (avoid this if a hook exists — the survey suggested `useTodayTargets` already encapsulates plan resolution, but you may need raw plan data here).

- [ ] **Step 2: Build the pill**

Create `components/diet/Glp1StatusPill.tsx`:

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
// import { useActivePlan } from "@/lib/query/hooks/<whatever>";  // adjust to actual hook

type Props = { userId: string };

export function Glp1StatusPill({ userId }: Props) {
  // const { data: plan } = useActivePlan(userId);
  // const glp1 = plan?.nutrition?.glp1;
  // if (!glp1 || glp1.mode === "discontinued" || glp1.mode === "classical") return null;

  // Placeholder until you wire the hook:
  return null;
  // Real render:
  // const label = glp1.mode === "active"
  //   ? `GLP-1 active${glp1.drug ? ` (${glp1.drug})` : ""}`
  //   : `GLP-1 tapering`;
  // const color = glp1.mode === "active" ? COLOR.accent : COLOR.warning;
  // return (
  //   <span style={{
  //     display: "inline-flex",
  //     alignItems: "center",
  //     padding: "2px 8px",
  //     borderRadius: 999,
  //     background: COLOR.accentSoft,
  //     color: COLOR.accentDeep ?? color,
  //     fontSize: 10,
  //     fontWeight: 700,
  //     letterSpacing: 0.3,
  //   }}>
  //     {label}
  //   </span>
  // );
}
```

Replace the commented-out parts with the real hook and the real type narrowing. The `glp1` type is documented in the spec under "Coach / AI → GLP-1-aware nutrition" — its mode values are `glp1_active | glp1_tapering | classical | steady_state` per `resolveMode` in `lib/morning/brief/get-today-targets.ts`. Confirm the exact mode strings by reading that file before writing the conditionals.

If the GLP-1 data shape is different from what the spec suggests, adapt the component to render correctly for what's actually there.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/diet/Glp1StatusPill.tsx
git commit -m "feat(diet): add Glp1StatusPill component"
```

---

## Task 3: Build `DietCoachClient` (Coach sub-tab body)

**Files:**
- Create: `components/diet/DietCoachClient.tsx`

The Coach sub-tab renders:
- Header line: today's date + total kcal logged vs target + GLP-1 status pill
- Macro strip: P / C / F / Fiber gram totals vs targets (use existing `useTodayTargets` for the targets, `useFoodEntries` for today's logged values)
- Per-meal-slot summary cards (Breakfast/Lunch/Dinner/Snack) — lift `MealSlotCard`/`MealSlotEmptyCard` from existing usage
- Body composition strip — lift `BodyCompCard` from `components/health/BodyCompCard.tsx`
- ChatPanel scoped to Nora

- [ ] **Step 1: Read the existing meal-slot rendering**

```bash
cat app/meal/page.tsx | head -60
cat components/meal/MealSlotCard.tsx | head -40
cat components/meal/MealSlotEmptyCard.tsx | head -40
```

Note:
- What props do `MealSlotCard` and `MealSlotEmptyCard` take? (Probably `slot`, `entries`, `target`, etc.)
- How are entries grouped by slot? (Likely a `groupBy` or `Object.entries(entriesBySlot)` pattern in `MealJournalClient`.)
- Where does `targetsForAllSlots()` live? (`lib/food/meal-targets.ts` per the survey.)

- [ ] **Step 2: Read BodyCompCard**

```bash
cat components/health/BodyCompCard.tsx | head -30
```

Note its props (likely `userId` or already-fetched body comp data) and its output. Confirm it's usable standalone.

- [ ] **Step 3: Compose DietCoachClient**

Create `components/diet/DietCoachClient.tsx`:

```tsx
"use client";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { BodyCompCard } from "@/components/health/BodyCompCard";
import { MealSlotCard } from "@/components/meal/MealSlotCard";
import { MealSlotEmptyCard } from "@/components/meal/MealSlotEmptyCard";
import { Glp1StatusPill } from "@/components/diet/Glp1StatusPill";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import type { MealSlot } from "@/lib/data/types";

const SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

type Props = { userId: string };

export function DietCoachClient({ userId }: Props) {
  const today = todayInUserTz();
  const { data: targets } = useTodayTargets(userId);
  const { data: entries } = useFoodEntries(userId, today, today);

  // Group entries by slot
  const entriesBySlot: Record<MealSlot, typeof entries[number][]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snack: [],
  };
  for (const e of entries ?? []) {
    if (SLOTS.includes(e.meal_slot)) {
      entriesBySlot[e.meal_slot].push(e);
    }
  }

  // Compute slot kcal targets from the day's total target
  const slotTargets = targets ? targetsForAllSlots(targets) : null;

  // Compute totals for the macro strip
  const logged = (entries ?? []).reduce(
    (acc, e) => ({
      kcal: acc.kcal + (e.kcal ?? 0),
      p: acc.p + (e.protein_g ?? 0),
      c: acc.c + (e.carbs_g ?? 0),
      f: acc.f + (e.fat_g ?? 0),
      fiber: acc.fiber + (e.fiber_g ?? 0),
    }),
    { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 },
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 88px)" }}>
      {/* Data block — top */}
      <div style={{ flex: "0 0 auto", padding: "8px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Header line: kcal + GLP-1 pill */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 13, color: COLOR.textMid }}>
            {logged.kcal} / {targets?.kcal ?? "—"} kcal
          </div>
          <Glp1StatusPill userId={userId} />
        </div>

        {/* Macro strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
          <MacroTile label="P g" value={Math.round(logged.p)} target={targets?.protein_g} />
          <MacroTile label="C g" value={Math.round(logged.c)} target={targets?.carbs_g} />
          <MacroTile label="F g" value={Math.round(logged.f)} target={targets?.fat_g} />
          <MacroTile label="Fiber g" value={Math.round(logged.fiber)} target={targets?.fiber_g} />
        </div>

        {/* Per-slot cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {SLOTS.map((slot) => {
            const slotEntries = entriesBySlot[slot];
            const slotTarget = slotTargets?.[slot]?.kcal;
            return slotEntries.length === 0 ? (
              <MealSlotEmptyCard key={slot} slot={slot} target={slotTarget} /* + other required props */ />
            ) : (
              <MealSlotCard key={slot} slot={slot} entries={slotEntries} target={slotTarget} /* + other required props */ />
            );
          })}
        </div>

        {/* Body composition strip */}
        <BodyCompCard userId={userId} />
      </div>

      {/* Chat block — bottom */}
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 320 }}>
        <ChatPanel
          userId={userId}
          embedded={true}
          initialKind="coach"
          thread="nora"
        />
      </div>
    </div>
  );
}

function MacroTile({ label, value, target }: { label: string; value: number; target?: number | null }) {
  return (
    <div style={{ background: COLOR.surfaceAlt, padding: "8px 10px", borderRadius: 6, textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 9, color: COLOR.textMuted, marginTop: 2 }}>
        {label} {target != null ? `(${Math.round(target)})` : ""}
      </div>
    </div>
  );
}
```

**Critical**: the exact props on `MealSlotCard` / `MealSlotEmptyCard` come from those components' actual signatures. Read them in Step 1 and pass the correct props. If they need `onLogClick` / `onEditEntry` handlers, the Coach tab can either:
- Provide no-op handlers (the slot cards become read-only on the Coach tab) — simplest
- Open the same sheets the Log tab uses — more complex; defer to a follow-up

For PR 4 v1, **read-only slot cards on Coach are fine**. Logging happens on the Log tab via the existing flow. If the empty-state CTA on the slot card says "+ Log meal", that CTA can navigate to `?tab=log` instead of opening a sheet inline. If lifting that gracefully is too much, just render the card with a static label and accept the deferred CTA.

Same for `BodyCompCard` — if it has measurement-edit affordances, those can be no-ops on the Coach tab; the user can edit via `/profile` or `/metrics?sub=body&...` until PR 6 cleanup.

- [ ] **Step 4: Handle the case where `targetsForAllSlots` doesn't exist or has a different signature**

The survey claimed `targetsForAllSlots()` lives in `lib/food/meal-targets.ts`. Confirm by reading that file before relying on it. If the function has a different signature (e.g., takes the kcal value rather than the targets object), adapt the call site.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `useTodayTargets` returns a shape with different field names (e.g., `kcal_target` instead of `kcal`), adapt your destructuring.

- [ ] **Step 6: Commit**

```bash
git add components/diet/DietCoachClient.tsx
git commit -m "feat(diet): build Coach sub-tab with macros + body comp + Nora chat"
```

---

## Task 4: Build `DietLogClient` + update `app/diet/page.tsx` to Server Component

**Files:**
- Create: `components/diet/DietLogClient.tsx`
- Modify: `app/diet/page.tsx`

`DietLogClient` is a thin wrapper that mounts `MealJournalClient` from its new location (`components/meal/MealJournalClient.tsx`). The wrapper exists so the Server Component import path is uniform (Coach + Log clients both under `components/diet/`).

`app/diet/page.tsx` swaps from the PR 2 placeholder Client Component to a Server Component that prefetches per-tab and hydrates.

- [ ] **Step 1: Create DietLogClient**

Create `components/diet/DietLogClient.tsx`:

```tsx
"use client";

import { MealJournalClient } from "@/components/meal/MealJournalClient";

type Props = {
  userId: string;
  initialDate?: string;
};

export function DietLogClient({ userId, initialDate }: Props) {
  return <MealJournalClient userId={userId} initialDate={initialDate} />;
}
```

Adjust to match `MealJournalClient`'s actual prop signature. The survey said it manages `loggerOpen`, `editing`, `historyPickerOpen` state internally — so the wrapper passes through only `userId` and the `date` from URL.

If `MealJournalClient` is a default-export, adjust the import:

```tsx
import MealJournalClient from "@/components/meal/MealJournalClient";
```

If `MealJournalClient` is heavyweight and the wrapper adds no value, you can skip this file and have `app/diet/page.tsx` import `MealJournalClient` directly. The wrapper exists for symmetry (Coach + Log both at `components/diet/`); skip it if symmetry isn't worth the indirection.

- [ ] **Step 2: Rewrite `app/diet/page.tsx`**

The current placeholder is a Client Component using `useSearchParams`. Replace with a Server Component that gates auth, awaits searchParams, and per-tab prefetches + hydrates.

For Coach tab: prefetch the same data as today's macros/body-comp surfaces. For Log tab: prefetch the same data as `/meal/page.tsx` currently does (food entries + today's targets).

Read `app/meal/page.tsx` to copy its prefetch pattern:

```bash
cat app/meal/page.tsx
```

Then write `app/diet/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { DietCoachClient } from "@/components/diet/DietCoachClient";
import { DietLogClient } from "@/components/diet/DietLogClient";
import { COLOR } from "@/lib/ui/theme";
// ... add the prefetcher imports matching the existing /meal page pattern ...

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default async function DietPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam, date: dateParam } = await searchParams;
  const tab = tabParam === "log" ? "log" : "coach";

  // Prefetch per tab. The two tabs read mostly the same data (food entries +
  // today's targets) but the Coach tab also reads body composition.
  const queryClient = makeServerQueryClient();
  await Promise.all([
    // Replicate /meal's prefetches when tab=log:
    // - foodEntries (today + last 7 days for history picker), todayTargets
    // Replicate the Coach-relevant prefetches when tab=coach:
    // - foodEntries (today), todayTargets, bodyMeasurements latest
    // Adjust based on actual hook query keys.
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Diet</h1>
          <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
            Nora
          </p>
        </header>
        <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
        {tab === "coach" ? (
          <DietCoachClient userId={user.id} />
        ) : (
          <DietLogClient userId={user.id} initialDate={dateParam} />
        )}
      </div>
    </HydrationBoundary>
  );
}
```

Match the prefetch pattern used by the existing `/meal/page.tsx` exactly — the easiest reliable path is to copy its `await Promise.all([...])` block verbatim into the new page's Log-tab prefetch, and add body-comp prefetch for the Coach-tab branch.

If you can't cleanly split the prefetch by tab without code duplication, prefetch the union (food entries + targets + body comp + 7 day history for picker) on both tabs. The cost of the extra fetches is negligible and the code is cleaner.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Smoke (optional)**

```bash
rm -rf .next
npm run dev &
NEXT_PID=$!
sleep 10
```

Open `/diet`. Expected:
- Header "Diet" / "Nora"
- Coach (active) / Log pills
- Macros + slot cards + body comp + Nora chat
- Tap Log → meal journal renders identically to current `/meal`

Kill dev.

- [ ] **Step 5: Commit**

```bash
git add components/diet/DietLogClient.tsx app/diet/page.tsx
git commit -m "feat(diet): wire DietLogClient + real Server Component page.tsx"
```

---

## Task 5: Redirect `/meal` → `/diet?tab=log`

**Files:**
- Modify: `app/meal/page.tsx`

`app/meal/page.tsx` becomes a redirect. The whole page content is gone — just an auth gate + redirect. Preserve `?date=YYYY-MM-DD` if present.

- [ ] **Step 1: Replace `app/meal/page.tsx` with a redirect**

The current file probably prefetches foodEntries + targets and renders MealJournalClient. After the redirect, none of that runs. Replace the entire file content with:

```tsx
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function MealRedirect({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { date } = await searchParams;
  const dateQs = date ? `&date=${encodeURIComponent(date)}` : "";
  redirect(`/diet?tab=log${dateQs}`);
}
```

The auth gate runs first (consistent with the rest of the app) so unauthenticated users hit `/login`. Authenticated users get redirected to `/diet?tab=log[&date=...]`.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Smoke (optional)**

```bash
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `/meal` directly → instant redirect to `/diet?tab=log`. Open `/meal?date=2026-05-15` → redirect to `/diet?tab=log&date=2026-05-15`. Kill dev.

- [ ] **Step 4: Commit**

```bash
git add app/meal/page.tsx
git commit -m "feat(meal): redirect /meal to /diet?tab=log"
```

---

## Task 6: Redirect `/metrics?sub=body` → `/diet?tab=coach`

**Files:**
- Modify: `app/metrics/page.tsx`

Mirror the `?sub=strength` redirect from PR 3.

- [ ] **Step 1: Add the redirect**

In `app/metrics/page.tsx`, locate the existing PR 3 redirect for `?sub=strength`:

```ts
if (sub === "strength" && !sp.ex) {
  redirect("/strength?tab=coach");
}
```

Just below, add:

```ts
if (sub === "body") {
  redirect("/diet?tab=coach");
}
```

There's no `?ex=` equivalent to preserve for the body sub-pill (body comp doesn't have a deep-link drilldown), so the redirect is unconditional on the `sub=body` match.

- [ ] **Step 2: Typecheck + smoke**

```bash
npm run typecheck
```

Expected: PASS.

Smoke: `/metrics?sub=body` → instant redirect to `/diet?tab=coach`.

- [ ] **Step 3: Commit**

```bash
git add app/metrics/page.tsx
git commit -m "feat(metrics): redirect ?sub=body to /diet?tab=coach"
```

---

## Task 7: Final typecheck + smoke + push

- [ ] **Step 1: Clean typecheck**

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

1. `/diet` → Coach tab: macros + slot cards + body comp + Nora chat. Send a message → Nora responds (network panel shows `&thread=nora` and `speaker_override: "nora"`).
2. Tap Log pill → meal journal renders. Log a meal → entry appears in the journal.
3. Tap Coach pill → back to data + chat.
4. `/meal` → instant redirect to `/diet?tab=log`.
5. `/meal?date=2026-05-15` → redirect preserves date.
6. `/metrics?sub=body` → instant redirect to `/diet?tab=coach`.
7. `/metrics?sub=strength` → still redirects to `/strength?tab=coach` (PR 3 behavior unchanged).
8. `/coach` direct → chat surface still works.

Kill dev.

- [ ] **Step 3: Show final commit log**

```bash
git log --oneline main..HEAD
```

Expected: ~7-8 commits (plan + 6 tasks).

- [ ] **Step 4: Report ready for push**

Push command:

```bash
git push -u origin feat/coach-pr4-diet-page
```

---

## Subsequent PRs

- **PR 5** — Health page: Coach (recovery cluster + Remi chat) + Log (morning intake + symptom log). Adds `/metrics?sub=log` → `/health?tab=log` redirect.
- **PR 6** — Metrics page (Peter): coach trends + weekly review + nudges + Peter chat with specialist-thread context-injection. Deletes `/coach/*`, `/metrics/_sub/*`, `lib/coach/router.ts`, `scripts/audit-speaker-routing.mjs`, and the now-redirect-only `app/meal/page.tsx`.
