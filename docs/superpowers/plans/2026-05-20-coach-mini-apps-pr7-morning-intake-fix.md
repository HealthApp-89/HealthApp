# PR 7 — Morning intake regression fix (coach mini-apps follow-up)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore morning intake reachability after PR 6 deleted its only host. The intake state-machine + API routes are intact; what's missing is (a) a UI that auto-pops when the user hasn't completed today's intake and (b) a manual entry point from the Health page.

**Background:** PR 6 deleted `app/coach/` entirely, which contained `CoachClient.tsx` — the only file that mounted `MorningTrigger`. `MorningTrigger` is the invisible client component that queries today + yesterday checkins and decides whether to auto-open the intake chat. Without it mounted, the daily intake silently never fires. The intake API (`/api/chat/morning/intake`), the state machine (`migration 0007 + 0011`), and the ChatPanel's `morning_intake` mode all still work — they just have no UI surface.

**Architecture:** Three structural moves.
1. New `components/morning/MorningIntakeHost.tsx` — Client Component that owns `MorningTrigger` + an overlay `ChatPanel` with `initialKind="morning_intake"`. Manages open/close state. When `MorningTrigger` decides intake should fire, the overlay opens automatically. Closing dismisses for the session.
2. `app/page.tsx` (Today) renders `MorningIntakeHost` as an invisible mount. Today is where users land first thing in the morning, so auto-pop happens organically.
3. `HealthCoachClient`'s "Morning intake not yet completed today" hint becomes a tappable button that opens the intake overlay — manual escape hatch when the user dismissed the auto-pop or is on Health without visiting Today.
4. `HealthLogClient` gets an intake-history section below the LogForm — list of past `checkins` rows with their flags (sick / fatigue / soreness / bloating).

No new fetchers needed. `useCheckin` (single day) already exists; the history view reuses it across a date range OR adds a new `useCheckins(userId, from, to)` hook if a range hook doesn't exist.

**Tech Stack:** Next.js 15 App Router, TanStack Query (existing hooks reused), TypeScript strict mode. No new migrations.

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md) (deferred-polish section)

**Prior PRs in this arc:**
- [PR 1 — chat thread foundation](2026-05-20-coach-mini-apps-pr1-chat-foundation.md) (merged #98)
- [PR 6 — Metrics page (Peter) + cleanup](2026-05-20-coach-mini-apps-pr6-metrics-cleanup.md) (merged #105) — the one that introduced the regression

**Suggested branch:** `feat/coach-pr7-morning-intake-fix` (cut from `main`).

---

## File Structure

**New:**
- `components/morning/MorningIntakeHost.tsx` — owns `MorningTrigger` + overlay `ChatPanel(initialKind="morning_intake")`. Exposes a `startIntake()` prop callback so other components (e.g., the Health/Coach hint button) can trigger it imperatively via a window event or a shared ref.

**Modified:**
- `app/page.tsx` (Today) — mount `MorningIntakeHost` at the bottom of the page (invisible until intake fires).
- `components/health/HealthCoachClient.tsx` — convert the "Morning intake not yet completed today" hint into a `<button>` that dispatches a custom event the host listens for (or navigates to `/?intake=open`).
- `components/health/HealthLogClient.tsx` — add a `PastIntakesList` section below the existing `LogClient` render.

**No deletions.**

---

## Task 1: Build `MorningIntakeHost`

**Files:**
- Create: `components/morning/MorningIntakeHost.tsx`

The host owns `MorningTrigger` + the overlay `ChatPanel`. State machine:
- `closed` (initial)
- `open` (`MorningTrigger` decided to fire, or user manually triggered)
- User can close the overlay (X button on ChatPanel's overlay header)

The overlay `ChatPanel` runs with `embedded={false}` so it shows the full overlay chrome (close button, header). `initialKind="morning_intake"`.

Manual trigger: expose via a custom DOM event so other surfaces (Health/Coach button) can fire it without prop-drilling. Pattern: `window.dispatchEvent(new CustomEvent("open-morning-intake"))` → host listens via `useEffect`.

- [ ] **Step 1: Confirm ChatPanel's overlay close path works**

Read `components/chat/ChatPanel.tsx` to find the overlay close handler. It probably accepts an `onClose` prop. Confirm.

```bash
grep -n "onClose\|embedded" components/chat/ChatPanel.tsx | head -10
```

If `onClose` is the close callback, use it. If the overlay closes via internal state without a parent callback, you may need to extend ChatPanel slightly — but try not to. The simplest path: ChatPanel calls `onClose` and the host sets state to closed.

- [ ] **Step 2: Build the host**

Create `components/morning/MorningIntakeHost.tsx`:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { MorningTrigger } from "@/components/morning/MorningTrigger";

// ChatPanel is dynamic-imported to avoid SSR cost on the Today page when
// intake isn't fired. The overlay is invisible until `open` becomes true.
const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel").then((m) => m.ChatPanel ?? m.default), {
  ssr: false,
});

const EVENT_NAME = "open-morning-intake";

/** Globally-dispatchable trigger so the Health/Coach hint button (and any
 *  future call site) can open the overlay without prop-drilling. */
export function openMorningIntake() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  }
}

type Props = { userId: string };

export function MorningIntakeHost({ userId }: Props) {
  const [open, setOpen] = useState(false);

  // External trigger
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(EVENT_NAME, onOpen);
    return () => window.removeEventListener(EVENT_NAME, onOpen);
  }, []);

  return (
    <>
      <MorningTrigger userId={userId} onShouldOpen={() => setOpen(true)} />
      {open && (
        <ChatPanel
          userId={userId}
          initialKind="morning_intake"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
```

Adapt:
- The import of `ChatPanel` — if it's a default export (recent PRs confirmed it is), use `dynamic(() => import("@/components/chat/ChatPanel"), { ssr: false })`. If named, use `.then((m) => m.ChatPanel)`.
- `MorningTrigger`'s actual prop name for the open callback (probably `onShouldOpen` per the file we read earlier).
- If `ChatPanel`'s overlay mode requires more props (e.g., `mode="default"`), pass them.

The `openMorningIntake()` exported helper is what HealthCoachClient calls to programmatically trigger the overlay.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/morning/MorningIntakeHost.tsx
git commit -m "feat(morning): MorningIntakeHost wires MorningTrigger + overlay ChatPanel"
```

---

## Task 2: Mount `MorningIntakeHost` on the Today page

**Files:**
- Modify: `app/page.tsx`

The Today page is the user's daily landing. Mounting the host here ensures the auto-pop fires when they open the app first thing.

- [ ] **Step 1: Read `app/page.tsx`**

```bash
cat app/page.tsx
```

Note its structure — Server Component fetching `userId`, rendering a Client wrapper.

- [ ] **Step 2: Add the mount**

Inside the Today page's render, add `<MorningIntakeHost userId={user.id} />` somewhere in the JSX. It's an invisible component (no visible chrome until intake fires), so position doesn't matter visually — but conventionally place it at the end of the page body so it renders last in the DOM.

If `app/page.tsx` is a Server Component, the import works as-is (MorningIntakeHost is a Client Component, Server Components can render Client Components fine).

Pattern:

```tsx
import { MorningIntakeHost } from "@/components/morning/MorningIntakeHost";

// ... inside the render, at the end of the JSX ...
<MorningIntakeHost userId={user.id} />
```

- [ ] **Step 3: Smoke (optional)**

```bash
rm -rf .next
npm run dev &
NEXT_PID=$!
sleep 8
```

Open `/`. Confirm:
- The Today page renders normally
- If you haven't done today's intake, the overlay should auto-pop within a second or two (MorningTrigger's effect runs on mount)
- If you have done today's intake, no overlay (per MorningTrigger's `decideIntakeAction` logic)
- Closing the overlay (X button) returns to Today

Kill dev. If you can't browser-test, typecheck-only is fine.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat(today): mount MorningIntakeHost for daily intake auto-pop"
```

---

## Task 3: Make Health/Coach's intake hint a tappable button

**Files:**
- Modify: `components/health/HealthCoachClient.tsx`

The existing `MorningFeelRow` component (inside `HealthCoachClient`) shows "Morning intake not yet completed today." when the checkin is missing. Convert it to a button that triggers the overlay via `openMorningIntake()`.

- [ ] **Step 1: Locate the existing hint**

```bash
grep -n "Morning intake not yet completed\|MorningFeelRow" components/health/HealthCoachClient.tsx
```

You'll find the `MorningFeelRow` helper (defined inline at the bottom of the file). Its no-checkin branch renders the italic text.

- [ ] **Step 2: Convert to a button**

Replace the italic-text rendering with a button. Update the import at the top:

```tsx
import { openMorningIntake } from "@/components/morning/MorningIntakeHost";
```

In `MorningFeelRow`, the no-checkin branch:

```tsx
if (!checkin || checkin.intake_state == null || checkin.intake_state === "awaiting_response") {
  return (
    <button
      onClick={openMorningIntake}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: COLOR.surfaceAlt,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: 6,
        padding: "10px 12px",
        fontSize: 12,
        color: COLOR.textMid,
        cursor: "pointer",
      }}
    >
      <span style={{ fontWeight: 600, color: COLOR.textStrong }}>Start morning intake →</span>
      <span style={{ marginLeft: 6 }}>not yet completed today</span>
    </button>
  );
}
```

If `MorningFeelRow` uses different field-name semantics for the "incomplete" check, preserve them — just replace the hint visual with the button.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/health/HealthCoachClient.tsx
git commit -m "feat(health): make 'Start morning intake' tappable on Coach tab"
```

---

## Task 4: Add intake history to Health/Log

**Files:**
- Modify: `components/health/HealthLogClient.tsx`
- Possibly create: `lib/query/hooks/useCheckins.ts` (range hook) — only if no range hook exists

Show the user the last 14 days of completed intakes below the `LogClient` render. Each row: date + intake flags (sick / fatigue / bloating / soreness) + status.

- [ ] **Step 1: Check whether a range hook exists**

```bash
grep -n "useCheckins\|fetchCheckinsRange" lib/query/hooks/ lib/query/fetchers/ 2>/dev/null | head
```

If `useCheckins(userId, from, to)` exists, use it.

If only `useCheckin(userId, date)` exists (single day), you have two options:
- **Option A** (preferred): create a small `useCheckins(userId, from, to)` hook + `fetchCheckinsRangeBrowser` + `fetchCheckinsRangeServer` fetcher trio, following the patterns of other range hooks like `useDailyLogs`.
- **Option B**: call `useCheckin` in a loop (14 individual queries). Works but wasteful.

Prefer A. Look at `lib/query/hooks/useDailyLogs.ts` for the template; copy its shape with the table changed to `checkins`.

If the range hook is non-trivial to add and would expand this task too much, FALL BACK to a server-side prefetch in `app/health/page.tsx` that fetches 14 days of checkins directly via supabase, and pass them as a prop to `HealthLogClient`. That's simpler and doesn't require a new hook.

- [ ] **Step 2: Read the current `HealthLogClient`**

```bash
cat components/health/HealthLogClient.tsx
```

It's a thin wrapper around `LogClient`. Add a `<PastIntakesList userId={userId} />` below the LogClient render, OR below an inline divider.

- [ ] **Step 3: Build `PastIntakesList`**

Inline inside `HealthLogClient.tsx`:

```tsx
// At the top of the file:
import { useCheckins } from "@/lib/query/hooks/useCheckins"; // or use the prop path

// New helper component below the existing export:
function PastIntakesList({ userId }: { userId: string }) {
  // Adapt to whatever shape you settled on in Step 1
  const today = todayInUserTz();
  const fromDate = new Date(`${today}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 14);
  const fromIso = fromDate.toISOString().slice(0, 10);
  const { data: checkins } = useCheckins(userId, fromIso, today);

  const completed = (checkins ?? [])
    .filter((c) => c.intake_state && c.intake_state !== "awaiting_response")
    .sort((a, b) => b.date.localeCompare(a.date));

  if (completed.length === 0) {
    return (
      <div style={{ padding: "16px", fontSize: 12, color: COLOR.textMuted, fontStyle: "italic" }}>
        No completed morning intakes in the last 14 days.
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 16px" }}>
      <h2 style={{ fontSize: 13, color: COLOR.textMid, margin: "12px 0 8px 0", fontWeight: 600 }}>
        Recent morning intakes
      </h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {completed.map((c) => (
          <li
            key={c.date}
            style={{
              background: COLOR.surfaceAlt,
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 12,
              color: COLOR.textMid,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span style={{ fontWeight: 600, color: COLOR.textStrong, minWidth: 80 }}>{c.date}</span>
            <span style={{ flex: 1, textAlign: "right" }}>{formatFlags(c)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatFlags(c: {
  sick?: boolean | null;
  fatigue?: string | null;
  bloating?: boolean | null;
  soreness_areas?: string[] | null;
}): string {
  const parts: string[] = [];
  if (c.sick) parts.push("sick");
  if (c.fatigue && c.fatigue !== "none") parts.push(`fatigue: ${c.fatigue}`);
  if (c.bloating) parts.push("bloating");
  if (c.soreness_areas && c.soreness_areas.length > 0) parts.push(`sore: ${c.soreness_areas.length}`);
  return parts.length === 0 ? "clean" : parts.join(" · ");
}
```

Adapt the row rendering to match real `Checkin` field names (per Task 3 of PR 5, `sick` is boolean, `fatigue` is a string-like, etc.).

If you went with the server-side-prefetch fallback (no new hook), pass `intakes` as a prop instead of calling `useCheckins`.

- [ ] **Step 4: Mount it in HealthLogClient**

Update the `HealthLogClient` to render `<PastIntakesList userId={userId} />` below the `<LogClient ... />`:

```tsx
export function HealthLogClient({ userId, initialDate }: Props) {
  const date = initialDate ?? todayInUserTz();
  return (
    <>
      <LogClient userId={userId} date={date} />
      <PastIntakesList userId={userId} />
    </>
  );
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
```

Expected: PASS.

```bash
git add components/health/HealthLogClient.tsx [any new hook/fetcher files]
git commit -m "feat(health): show recent morning intakes on Log tab"
```

---

## Task 5: Final verification + push + PR

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

1. `/` (Today) → if today's intake isn't done, overlay should auto-pop after a beat. Close it.
2. `/health` Coach tab → if intake isn't complete, the "Start morning intake →" button shows. Tap it → overlay opens (via the custom event).
3. Complete the intake by sending a message in the overlay. The overlay finalizes the intake state.
4. `/health?tab=log` → "Recent morning intakes" list shows today's completed intake. Past 14 days show too.
5. `/health` Coach tab again → "Start morning intake" button is replaced by the clean-feel / flag summary (because checkin.intake_state is now `brief_delivered` or similar).

Kill dev.

- [ ] **Step 3: Final commit log**

```bash
git log --oneline main..HEAD
```

Expected: 5 commits (plan + 4 task commits).

- [ ] **Step 4: Push**

```bash
git push -u origin feat/coach-pr7-morning-intake-fix
```

---

## What's NOT in this PR (deferred polish, still on the list)

- Morning brief block on `/` (Today) per the original spec
- Manual symptom log (free-text + tagged) on Health/Log
- HRV mini-sparkline graphic on Health/Coach
- Unread-message dots on Coach pills (Strength/Diet/Health)

Each of these is its own follow-up PR.
