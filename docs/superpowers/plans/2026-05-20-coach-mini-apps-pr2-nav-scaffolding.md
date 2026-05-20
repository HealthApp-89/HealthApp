# PR 2 — Nav + scaffolding (coach mini-apps restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the bottom nav to 6 tabs and create placeholder route shells for the three specialist pages. After this PR, the user sees the new app shape; PRs 3-6 fill in each page's real content.

**Architecture:** Two structural moves. (1) `components/layout/BottomNav.tsx` swaps from 5 tabs (Today / Metrics / Meal / Coach / Profile) to 6 tabs (Today / Strength / Diet / Health / Metrics / Profile). (2) New route folders `app/strength/`, `app/diet/`, `app/health/` each contain a page.tsx rendering a Coach | Log sub-tab pill row plus a placeholder block that links to today's functional surface for that domain.

**Deferred from the spec's PR-2 scope**: the redirects (`/coach/*` → `/metrics`, `/meal` → `/diet?tab=log`) and the old-/metrics rename. Doing them in PR 2 would orphan chat, meal-logging, and trends UX for the 4 PRs until the new destinations land. Instead, each destination's PR (3-6) ships the redirect for its slice. The spec explicitly allows this: "Old `/metrics` page renamed to `/metrics-legacy` **or its content moves into new pages incrementally**." Existing `/coach`, `/meal`, and `/metrics?sub=*` URLs stay fully functional in PR 2.

**Tech Stack:** Next.js 15 App Router (Client Components for the sub-tab pill row that reads `searchParams`), TypeScript strict mode, Tailwind v4 + the `lib/ui/theme` constants. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md)

**Prior PR:** [PR 1 — chat thread foundation](2026-05-20-coach-mini-apps-pr1-chat-foundation.md) (merged as PR #98)

**Suggested branch:** `feat/coach-pr2-nav-scaffolding` (cut from `main`).

---

## File Structure

**New:**
- `app/strength/page.tsx` — placeholder page with Coach/Log sub-tabs.
- `app/diet/page.tsx` — placeholder page with Coach/Log sub-tabs.
- `app/health/page.tsx` — placeholder page with Coach/Log sub-tabs.

**Modified:**
- `components/layout/BottomNav.tsx` — `TABS` array swaps from 5 entries (Today / Metrics / Meal / Coach / Profile) to 6 entries (Today / Strength / Diet / Health / Metrics / Profile). Icons updated.

**Untouched (deferred):**
- `app/coach/`, `app/meal/`, `app/metrics/` — all keep current behavior in PR 2.
- `components/layout/SubPillNav.tsx` — reused as-is for the Coach/Log pill row.
- `lib/coach/router.ts`, `app/api/chat/messages/route.ts` — chat routing stays unchanged.

---

## Task 1: Swap bottom nav from 5 tabs to 6 tabs

**Files:**
- Modify: `components/layout/BottomNav.tsx`

The current `TABS` array (around lines 16-22) lists 5 entries. Replace with 6 entries that drop Coach + Meal from the nav and add Strength + Diet + Health. Order matters — left-to-right reflects domain frequency in the user's day (Today, then training, then food, then recovery, then cross-cutting analysis, then settings).

- [ ] **Step 1: Update the icon imports**

In `components/layout/BottomNav.tsx`, find the icon import line (around line 6):

```ts
import { Home, BarChart3, MessageCircle, User, UtensilsCrossed, type LucideProps } from "lucide-react";
```

Replace with:

```ts
import { Home, BarChart3, User, UtensilsCrossed, Dumbbell, HeartPulse, type LucideProps } from "lucide-react";
```

This drops `MessageCircle` (was Coach icon) and adds `Dumbbell` (Strength) + `HeartPulse` (Health). `UtensilsCrossed` is repurposed from Meal to Diet.

- [ ] **Step 2: Update the `TABS` array**

Find the `TABS` array (around line 16):

```ts
const TABS: Tab[] = [
  { href: "/",        label: "Today",   Icon: Home,          match: (p) => p === "/" },
  { href: "/metrics", label: "Metrics", Icon: BarChart3,     match: (p) => p.startsWith("/metrics") },
  { href: "/meal",    label: "Meal",    Icon: UtensilsCrossed, match: (p) => p.startsWith("/meal") },
  { href: "/coach",   label: "Coach",   Icon: MessageCircle, match: (p) => p.startsWith("/coach") },
  { href: "/profile", label: "Profile", Icon: User,          match: (p) => p.startsWith("/profile") },
];
```

Replace with:

```ts
const TABS: Tab[] = [
  { href: "/",         label: "Today",    Icon: Home,            match: (p) => p === "/" },
  { href: "/strength", label: "Strength", Icon: Dumbbell,        match: (p) => p.startsWith("/strength") },
  { href: "/diet",     label: "Diet",     Icon: UtensilsCrossed, match: (p) => p.startsWith("/diet") },
  { href: "/health",   label: "Health",   Icon: HeartPulse,      match: (p) => p.startsWith("/health") },
  { href: "/metrics",  label: "Metrics",  Icon: BarChart3,       match: (p) => p.startsWith("/metrics") },
  { href: "/profile",  label: "Profile",  Icon: User,            match: (p) => p.startsWith("/profile") },
];
```

Keep all other code (`TabButton` component, `handleNavigate` logic, optimistic active-state plumbing) unchanged. The `flex` layout with `flex: 1` per tab will compress evenly across 6 instead of 5 — no layout work needed.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS, zero errors.

- [ ] **Step 4: Smoke locally**

```bash
rm -rf .next   # per project memory: stale layout chunks have bitten this file
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `http://localhost:3000/`. Expected: bottom nav shows 6 tabs in order Today / Strength / Diet / Health / Metrics / Profile. Tapping Strength/Diet/Health gives a 404 (the routes don't exist yet — Tasks 2-4 add them). Tapping Today / Metrics / Profile works as before. Tapping the URL bar to navigate to `/coach` or `/meal` directly still works (those routes still exist, just gone from nav).

Kill the dev server: `kill $NEXT_PID`.

- [ ] **Step 5: Commit**

```bash
git add components/layout/BottomNav.tsx
git commit -m "feat(nav): swap bottom nav to 6 tabs for coach mini-apps"
```

---

## Task 2: Create `/strength` placeholder page

**Files:**
- Create: `app/strength/page.tsx`

The page is a Client Component that reads the `?tab=` search param (default `coach`), renders a Coach | Log pill row using the existing `SubPillNav`, and shows a placeholder block telling the user the page is launching in PR 3 with a link to the current functional surface for that sub-tab.

- [ ] **Step 1: Create the page file**

Create `app/strength/page.tsx` with the exact content below:

```tsx
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default function StrengthPage() {
  const params = useSearchParams();
  const tab = params.get("tab") === "log" ? "log" : "coach";

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Strength</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Coach Carter
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" ? <CoachPlaceholder /> : <LogPlaceholder />}
    </div>
  );
}

function CoachPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Carter and today&apos;s session land here in PR 3.
      </p>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: "0 0 8px 0" }}>
        In the meantime:
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320, margin: "0 auto" }}>
        <Link
          href="/metrics?sub=strength"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          View today&apos;s session →
        </Link>
        <Link
          href="/coach"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Chat with the coach team →
        </Link>
      </div>
    </div>
  );
}

function LogPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Workout history lands here in PR 3 (read-only). Manual entry comes later.
      </p>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: "0 0 8px 0" }}>
        For now: Strong CSV import is unchanged. See past workouts at
      </p>
      <Link
        href="/metrics?sub=strength"
        style={{
          display: "inline-block",
          padding: "12px 16px",
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 10,
          textDecoration: "none",
          color: COLOR.textStrong,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Strength tab on Metrics →
      </Link>
    </div>
  );
}
```

The page uses `"use client"` because `useSearchParams` is a client hook. The placeholder content is minimal, deliberately non-dramatic — it's a transitional state, not a marketing surface.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS, zero errors. The COLOR keys used here (`surface`, `divider`, `textStrong`, `textMid`, `textMuted`) all exist in `lib/ui/theme.ts` as of main. If any have been renamed since, swap to current names.

- [ ] **Step 3: Smoke locally**

```bash
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `http://localhost:3000/strength`. Expected:
- Header reads "Strength" with "Coach Carter" subtitle.
- Pill row shows Coach (active) | Log.
- Below the pills: "Carter and today's session land here in PR 3" + two CTAs.
- Tapping `Log` pill → URL becomes `/strength?tab=log`, content swaps to the Log placeholder.
- Tapping `Coach` pill again → back to default.
- Tapping the CTAs navigates to the linked URLs (`/metrics?sub=strength`, `/coach`).

Kill dev: `kill $NEXT_PID`.

- [ ] **Step 4: Commit**

```bash
git add app/strength/page.tsx
git commit -m "feat(strength): add /strength placeholder with Coach/Log sub-tabs"
```

---

## Task 3: Create `/diet` placeholder page

**Files:**
- Create: `app/diet/page.tsx`

Same shape as Task 2, but for Nora. The Coach placeholder links to `/coach` (where Nora can already be reached via @mention or routing). The Log placeholder links to `/meal` (where meal logging already works in full).

- [ ] **Step 1: Create the page file**

Create `app/diet/page.tsx` with this content (it's a near-copy of `/strength/page.tsx` with different copy and links):

```tsx
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default function DietPage() {
  const params = useSearchParams();
  const tab = params.get("tab") === "log" ? "log" : "coach";

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Diet</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Nora
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" ? <CoachPlaceholder /> : <LogPlaceholder />}
    </div>
  );
}

function CoachPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Nora and today&apos;s macros land here in PR 4.
      </p>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: "0 0 8px 0" }}>
        In the meantime:
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320, margin: "0 auto" }}>
        <Link
          href="/metrics?sub=body"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          View body composition &amp; weight →
        </Link>
        <Link
          href="/coach"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Chat with the coach team →
        </Link>
      </div>
    </div>
  );
}

function LogPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Meal journal moves here in PR 4. The current Meal page still works.
      </p>
      <Link
        href="/meal"
        style={{
          display: "inline-block",
          padding: "12px 16px",
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 10,
          textDecoration: "none",
          color: COLOR.textStrong,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Open meal log →
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + smoke**

```bash
npm run typecheck
```

Expected: PASS.

```bash
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `http://localhost:3000/diet`. Verify the structure matches Task 2's smoke (header, pills, placeholder content, working CTA links). Kill dev.

- [ ] **Step 3: Commit**

```bash
git add app/diet/page.tsx
git commit -m "feat(diet): add /diet placeholder with Coach/Log sub-tabs"
```

---

## Task 4: Create `/health` placeholder page

**Files:**
- Create: `app/health/page.tsx`

Same shape as Tasks 2-3, but for Remi. Coach placeholder links to `/coach`. Log placeholder links to `/metrics?sub=log` (where morning intake currently lives).

- [ ] **Step 1: Create the page file**

Create `app/health/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default function HealthPage() {
  const params = useSearchParams();
  const tab = params.get("tab") === "log" ? "log" : "coach";

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Health</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Remi
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" ? <CoachPlaceholder /> : <LogPlaceholder />}
    </div>
  );
}

function CoachPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Remi and today&apos;s recovery land here in PR 5.
      </p>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: "0 0 8px 0" }}>
        In the meantime:
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320, margin: "0 auto" }}>
        <Link
          href="/metrics"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          View HRV, sleep, recovery →
        </Link>
        <Link
          href="/coach"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Chat with the coach team →
        </Link>
      </div>
    </div>
  );
}

function LogPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Morning intake + symptom log move here in PR 5.
      </p>
      <Link
        href="/metrics?sub=log"
        style={{
          display: "inline-block",
          padding: "12px 16px",
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 10,
          textDecoration: "none",
          color: COLOR.textStrong,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Open morning intake →
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + smoke**

```bash
npm run typecheck
```

```bash
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `http://localhost:3000/health`. Verify structure. Kill dev.

- [ ] **Step 3: Commit**

```bash
git add app/health/page.tsx
git commit -m "feat(health): add /health placeholder with Coach/Log sub-tabs"
```

---

## Task 5: Final typecheck + manual smoke + push

- [ ] **Step 1: Full typecheck from a clean state**

```bash
rm -rf .next
npm run typecheck
```

Expected: PASS with zero errors.

- [ ] **Step 2: Manual end-to-end smoke**

```bash
npm run dev &
NEXT_PID=$!
sleep 10
```

In a browser:

1. Open `http://localhost:3000/`. Confirm 6-tab nav: Today / Strength / Diet / Health / Metrics / Profile.
2. Tap each new tab. For each (`/strength`, `/diet`, `/health`):
   - Coach pill is active by default with the right copy ("Carter / Nora / Remi land here in PR 3 / 4 / 5").
   - Tapping Log pill swaps to the Log placeholder with the right link.
   - Tapping CTAs navigates correctly.
3. Type `/coach` in the URL bar directly. Confirm the chat surface still loads and a message streams back (PR 1's plumbing intact).
4. Type `/meal` directly. Confirm meal logging still works.
5. Confirm Today (`/`) and Metrics (`/metrics`) tabs work unchanged.

Kill dev: `kill $NEXT_PID`.

- [ ] **Step 3: Show final commit log**

```bash
git log --oneline main..HEAD
```

Expected: 4 commits — BottomNav swap, /strength, /diet, /health (one per task; Task 5 is verification-only and doesn't commit).

- [ ] **Step 4: Report ready for push**

Do NOT push. Report what's ready and let the controller / user decide. Suggested push:

```bash
git push -u origin feat/coach-pr2-nav-scaffolding
```

---

## Subsequent PRs (not in this plan)

- **PR 3** — Strength page: Coach (today's session + e1RM + Carter chat) + Log (read-only workout history). Activates the `/metrics?sub=strength` content move into `/strength`.
- **PR 4** — Diet page: Coach (macros + body comp + Nora chat) + Log (full `/meal` lift). Adds `/meal` → `/diet?tab=log` redirect; deletes `app/meal/`.
- **PR 5** — Health page: Coach (recovery cluster + Remi chat) + Log (morning intake + symptom log). Activates `/metrics?sub=log` content move into `/health`.
- **PR 6** — Metrics page: Peter's synthesis (coach trends + weekly review + nudges + Peter chat with specialist context). Activates `/coach/*` → `/metrics` redirects; deletes `app/coach/`, `app/metrics/_sub/*`, `lib/coach/router.ts`, `scripts/audit-speaker-routing.mjs`.
