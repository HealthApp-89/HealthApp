# Charts Revamp + Layout Chrome Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the chart visual revamp (comparison line, point markers, y-axis labels, gap interpolation, richer fill) and the bottom-bar overlay fix (remove `ChatBubble`, expose "Ask coach" via FAB sheet, bump body padding via `--nav-h` CSS var).

**Architecture:** All changes happen on branch `redesign/v1`. The chart work threads through one core component (`LineChart.tsx`), two new helpers (`interpolateGaps`, `getComparisonSeries`), one new wrapper (`DetailChartCard`), and a per-metric config map. The layout work is three small touches (CSS var, `FabGate` server component, `Fab` sheet entry). Layout cleanup ships first so chart redesign is visually verifiable on the bottom of every page.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript strict, Tailwind v4 (PostCSS, `@theme` block in `globals.css`), Supabase. **No test suite** — verification is `npm run typecheck` after each change + manual viewport smoke for UI tasks. Pure logic (`interpolateGaps`) gets an ad-hoc `node` verification script that lives in `lib/charts/__verify__/` and is committed alongside.

**Spec:** [docs/superpowers/specs/2026-05-06-charts-revamp-and-layout-cleanup-design.md](../specs/2026-05-06-charts-revamp-and-layout-cleanup-design.md)

---

## File Map

**Create (new files):**
- `lib/charts/metricChartConfig.ts` — per-metric `InterpolateConfig` map
- `lib/charts/interpolate.ts` — `interpolateGaps(series, cfg)` pure helper
- `lib/charts/__verify__/interpolate.mjs` — node-runnable verification script
- `lib/charts/comparisonSeries.ts` — server-side prior-period fetcher
- `components/charts/DetailChartCard.tsx` — chrome wrapper (title + legend + range pills + LineChart)
- `components/layout/FabGate.tsx` — server component, auth-gates `<Fab />`

**Modify:**
- `app/globals.css` — add `--nav-h` declaration in `:root`
- `app/layout.tsx` — body padding via `var(--nav-h)`; swap `ChatBubbleGate` for `FabGate`; drop standalone `<Fab />` import
- `components/layout/Fab.tsx` — add `"chat"` sheet kind, mount `ChatPanel` from inside `Fab`
- `components/charts/LineChart.tsx` — new props (`comparison`, `yAxisLabels`, `pointMarkers`, `metricKey`); 3-stop gradient; gridlines; HTML y-axis labels; comparison line; per-segment dashed/solid; markers per point; `(est.)` tooltip; comparison value in tooltip; pre-pass through `interpolateGaps`
- `components/charts/MetricCard.tsx` — accept and thread `metricKey?: DailyLogKey`
- `app/trends/page.tsx` — pass `metricKey` to each `MetricCard`
- `app/trends/[metric]/page.tsx` — replace inline `<Card><LineChart/></Card>` + standalone `RangePills` with `<DetailChartCard>`; call `getComparisonSeries`
- `components/dashboard/WeeklyRollups.tsx` — thread date strings into the weight sparkline's `LinePoint[]`

**Delete:**
- `components/chat/ChatBubble.tsx`
- `components/chat/ChatBubbleGate.tsx`

---

## Task 1: Layout chrome — `--nav-h` CSS var + body padding

**Files:**
- Modify: `app/globals.css` (after the closing brace of `@theme`)
- Modify: `app/layout.tsx:54` (the `<body>` className)

- [ ] **Step 1: Add `--nav-h` to globals.css**

Open [app/globals.css](app/globals.css). Insert this block immediately after the `@theme { ... }` block (around line 43):

```css
/* Bottom-nav reservation. Mobile only — desktop uses TopNav and needs no
   bottom space. Math: nav offset 8px + nav rendered height ~70px + 14px
   breathing = 92px. Owned alongside components/layout/BottomNav.tsx —
   if you change BottomNav padding/icon size, update this. */
:root {
  --nav-h: 92px;
}
@media (min-width: 768px) {
  :root { --nav-h: 0px; }
}
```

- [ ] **Step 2: Swap body padding in app/layout.tsx**

Replace line 54 of [app/layout.tsx](app/layout.tsx). Old:

```tsx
<body className="min-h-[100dvh] bg-bg pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+76px)] md:pb-[env(safe-area-inset-bottom)]">
```

New (the `md:` override falls out of the responsive `--nav-h` redefinition, so we can drop it):

```tsx
<body className="min-h-[100dvh] bg-bg pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+var(--nav-h))]">
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean exit (no new errors).

- [ ] **Step 4: Smoke check the layout**

Run: `npm run dev` (in another terminal if needed). Open the dev URL on a mobile-sized viewport (DevTools → iPhone 14 preset works). Confirm:
- The bottom nav still renders.
- Page content scrolls **above** the nav (last card has visible breathing room above the nav top edge — was clipping by ~2-4px before).
- Resize to ≥ 768px → bottom nav vanishes, no extra dead space at the bottom.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css app/layout.tsx
git commit -m "fix(layout): reserve nav height via --nav-h CSS var (76→92px)

Bumps body bottom-padding from 76px to 92px to match the nav's actual
rendered footprint (8px offset + ~70px content + 14px breathing). The
old reservation was ~2-4px short, clipping the last few pixels of every
page beneath the bottom nav.

Centralizes the value as :root --nav-h so future BottomNav changes
have a single source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `FabGate` + thread "Ask coach" through the FAB sheet

**Files:**
- Create: `components/layout/FabGate.tsx`
- Modify: `components/layout/Fab.tsx` (the `Fab` and `FabSheet` components, plus the `SheetItem` union)
- Modify: `app/layout.tsx` (replace `ChatBubbleGate` with `FabGate`)
- Delete: `components/chat/ChatBubble.tsx`, `components/chat/ChatBubbleGate.tsx`

- [ ] **Step 1: Create `components/layout/FabGate.tsx`**

```tsx
// components/layout/FabGate.tsx
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Fab } from "./Fab";

/**
 * Server component — gates the floating action button behind auth so
 * unauthenticated routes (/login, /privacy) don't render a "+" button
 * to nowhere. Replaces the per-bubble ChatBubbleGate that was here for
 * the same reason; coach is now reachable as a sheet item inside Fab.
 */
export async function FabGate() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return <Fab />;
}
```

- [ ] **Step 2: Extend `Fab.tsx` with the `"chat"` sheet kind**

Open [components/layout/Fab.tsx](components/layout/Fab.tsx). Replace the entire file with:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel"), {
  ssr: false,
  loading: () => null,
});

type SheetItem =
  | { kind: "link";   label: string; icon: string; href: string }
  | { kind: "upload"; label: string; icon: string; accept: string; endpoint: string }
  | { kind: "chat";   label: string; icon: string };

const ITEMS: SheetItem[] = [
  { kind: "link",   label: "Log entry",          icon: "✎",  href: "/log" },
  { kind: "chat",   label: "Ask coach",          icon: "💬" },
  { kind: "link",   label: "Strength",           icon: "💪", href: "/strength?view=today" },
  { kind: "upload", label: "Upload Strong CSV",  icon: "⬆",  accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link",   label: "Manage connections", icon: "🔗", href: "/profile" },
];

/**
 * Floating + button (mobile only) + bottom sheet with quick actions.
 * Rendered (via FabGate) in app/layout.tsx so it persists across routes.
 *
 * "Ask coach" mounts ChatPanel inline — the floating ChatBubble used
 * to do this from a separate corner button; consolidated here so the
 * bottom-right of every page isn't permanently occluded.
 */
export function Fab() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Quick actions"
        onClick={() => setSheetOpen(true)}
        className="md:hidden"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "calc(env(safe-area-inset-bottom) + 22px)",
          transform: "translateX(-50%)",
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          background: COLOR.accent,
          color: "#fff",
          fontSize: "26px",
          fontWeight: 300,
          border: "none",
          boxShadow: SHADOW.fab,
          cursor: "pointer",
          zIndex: 41,
        }}
      >
        +
      </button>
      {sheetOpen && (
        <FabSheet
          onClose={() => setSheetOpen(false)}
          onAskCoach={() => {
            setSheetOpen(false);
            setChatOpen(true);
          }}
        />
      )}
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
    </>
  );
}

function FabSheet({
  onClose,
  onAskCoach,
}: {
  onClose: () => void;
  onAskCoach: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onUploadFile(file: File, endpoint: string) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(endpoint, { method: "POST", body: fd });
      if (!res.ok) {
        alert(`Upload failed (${res.status})`);
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(15,20,48,0.4)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "8px",
          right: "8px",
          bottom: "calc(env(safe-area-inset-bottom) + 8px)",
          background: COLOR.surface,
          borderRadius: "22px",
          padding: "10px",
          boxShadow: SHADOW.floating,
        }}
      >
        {ITEMS.map((item) => {
          const inner = (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 14px",
                background: "transparent",
                borderRadius: RADIUS.cardMid,
                cursor: "pointer",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <span
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: RADIUS.cardSmall,
                  background: COLOR.accentSoft,
                  color: COLOR.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "16px",
                }}
              >
                {item.icon}
              </span>
              <span style={{ fontSize: "14px", fontWeight: 600, color: COLOR.textStrong }}>
                {item.label}
              </span>
            </div>
          );
          if (item.kind === "link") {
            return (
              <Link key={item.label} href={item.href} onClick={onClose} style={{ textDecoration: "none" }}>
                {inner}
              </Link>
            );
          }
          if (item.kind === "chat") {
            return (
              <button
                key={item.label}
                type="button"
                onClick={onAskCoach}
                style={{
                  display: "block",
                  width: "100%",
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {inner}
              </button>
            );
          }
          // kind === "upload"
          return (
            <label key={item.label} style={{ display: "block" }}>
              {inner}
              <input
                type="file"
                accept={item.accept}
                disabled={busy}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUploadFile(f, item.endpoint);
                }}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify `ChatPanel` default-exports correctly**

Run: `grep -E '^(export default|export \{)' components/chat/ChatPanel.tsx | head`

Expected: a `export default` line for `ChatPanel`. If it's a named export only, the dynamic import in Step 2 needs `.then(m => m.ChatPanel)` — adjust accordingly. If it's already default, no change.

(If the grep shows `export default function ChatPanel(...)` or `export default ChatPanel`, you're good.)

- [ ] **Step 4: Replace `ChatBubbleGate` with `FabGate` in app/layout.tsx**

Open [app/layout.tsx](app/layout.tsx).

- Remove this import: `import { ChatBubbleGate } from "@/components/chat/ChatBubbleGate";`
- Remove this import: `import { Fab } from "@/components/layout/Fab";`
- Add this import: `import { FabGate } from "@/components/layout/FabGate";`
- In the body JSX, replace `<Fab />` and `<ChatBubbleGate />` with a single `<FabGate />`.

The body block should end up looking like:

```tsx
<TopNav />
<main>{children}</main>
<BottomNav />
<FabGate />
```

- [ ] **Step 5: Delete the obsolete components**

```bash
rm components/chat/ChatBubble.tsx components/chat/ChatBubbleGate.tsx
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean exit. If there's a "Cannot find module ChatBubbleGate" error, double-check the import was fully removed in Step 4.

- [ ] **Step 7: Smoke check the FAB**

Run: `npm run dev`. On the mobile viewport:
- Confirm no purple `💬` bubble in the bottom-right of any authenticated page.
- Tap the central `+` FAB → sheet opens with `Log entry · Ask coach · Strength · Upload Strong CSV · Manage connections`.
- Tap "Ask coach" → sheet closes, ChatPanel opens.
- Close ChatPanel → returns to the page; FAB still there.
- Visit `/login` (sign out first if needed) → no `+` button visible (FabGate hides it for unauthenticated users).

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add components/layout/FabGate.tsx components/layout/Fab.tsx app/layout.tsx
git rm components/chat/ChatBubble.tsx components/chat/ChatBubbleGate.tsx
git commit -m "feat(layout): consolidate chat entry into FAB; add FabGate

- Removes the floating bottom-right purple ChatBubble (was permanently
  occluding the bottom-right ~80x80 of every chart card).
- Adds an 'Ask coach' sheet item in the FAB that opens the same
  ChatPanel — single source of summon-from-anywhere coach access.
- Replaces ChatBubbleGate with FabGate (server component) so the FAB
  itself is auth-gated; fixes a pre-existing minor UX issue where
  /login showed a '+' button to nowhere.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Per-metric chart config (`metricChartConfig.ts`)

**Files:**
- Create: `lib/charts/metricChartConfig.ts`

- [ ] **Step 1: Create the config module**

```ts
// lib/charts/metricChartConfig.ts
import type { DailyLogKey } from "@/lib/ui/colors";

/**
 * Per-metric interpolation behavior. Set per spec D4 / D5:
 *   - continuous physiology (HRV, RHR, recovery, sleep, body comp): interpolate
 *   - accumulators (steps, calories, distance, exercise min, strain): never
 *
 * Fail-closed default — unlisted metrics do NOT interpolate. Adding a new
 * metric requires an explicit decision here; we'd rather show a true gap
 * than silently estimate something we shouldn't.
 */
export type InterpolateConfig = {
  /** When false, interpolate is a no-op for this metric. */
  enabled: boolean;
  /** Inclusive upper bound, in calendar days. Gaps strictly larger remain null. */
  maxGapDays: number;
};

export const DEFAULT_INTERPOLATE: InterpolateConfig = {
  enabled: false,
  maxGapDays: 0,
};

/**
 * Keyed loosely by string (DailyLogKey is a TS-only type and we'd rather
 * not import the full union just for the config table). Lookup is via
 * `getInterpolateConfig` which falls back to DEFAULT_INTERPOLATE.
 */
export const METRIC_CHART_CONFIG: Record<string, InterpolateConfig> = {
  // continuous physiology — 3-day max gap
  hrv:                { enabled: true,  maxGapDays: 3  },
  resting_hr:         { enabled: true,  maxGapDays: 3  },
  recovery:           { enabled: true,  maxGapDays: 3  },
  sleep_hours:        { enabled: true,  maxGapDays: 3  },
  sleep_score:        { enabled: true,  maxGapDays: 3  },
  deep_sleep_hours:   { enabled: true,  maxGapDays: 3  },
  rem_sleep_hours:    { enabled: true,  maxGapDays: 3  },

  // body composition — 14-day max gap (weigh-ins are sparse)
  weight_kg:          { enabled: true,  maxGapDays: 14 },
  body_fat_pct:       { enabled: true,  maxGapDays: 14 },
  fat_mass_kg:        { enabled: true,  maxGapDays: 14 },
  fat_free_mass_kg:   { enabled: true,  maxGapDays: 14 },
  muscle_mass_kg:     { enabled: true,  maxGapDays: 14 },

  // explicit opt-out — accumulators where missing != partial day
  steps:              { enabled: false, maxGapDays: 0 },
  calories:           { enabled: false, maxGapDays: 0 },
  active_calories:    { enabled: false, maxGapDays: 0 },
  distance_km:        { enabled: false, maxGapDays: 0 },
  exercise_min:       { enabled: false, maxGapDays: 0 },
  strain:             { enabled: false, maxGapDays: 0 },

  // Notable fail-closed (NOT in the locked D4 set; opt-in by editing this map):
  //   spo2, skin_temp_c, hydration_kg, bone_mass_kg
};

export function getInterpolateConfig(metricKey: DailyLogKey | string | undefined): InterpolateConfig {
  if (!metricKey) return DEFAULT_INTERPOLATE;
  return METRIC_CHART_CONFIG[metricKey] ?? DEFAULT_INTERPOLATE;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/charts/metricChartConfig.ts
git commit -m "feat(charts): add per-metric interpolation config

Per spec D4: continuous physiology (HRV, RHR, recovery, sleep, body
comp) interpolates with 3- or 14-day max gaps; accumulators (steps,
calories, strain, etc.) never interpolate. Fail-closed default for
unlisted metrics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `interpolateGaps` helper + verification script

**Files:**
- Create: `lib/charts/interpolate.ts`
- Create: `lib/charts/__verify__/interpolate.mjs`

- [ ] **Step 1: Create `lib/charts/interpolate.ts`**

```ts
// lib/charts/interpolate.ts
import type { LinePoint } from "@/components/charts/LineChart";
import type { InterpolateConfig } from "./metricChartConfig";

/**
 * Linear-interpolate null y-values where the gap (consecutive nulls between
 * two known endpoints) is at most `cfg.maxGapDays`. Each filled point is
 * marked `estimated: true` so the renderer can style it as dashed/hollow.
 *
 * Gap length is measured in CALENDAR DAYS from `LinePoint.x` (date string),
 * not array indices — necessary for aggregated views where one bucket may
 * span several days.
 *
 * Fail-closed:
 *   - cfg.enabled === false  → return original series unchanged
 *   - any point lacks `x`    → return original series unchanged
 *   - leading or trailing nulls (no left or right endpoint) → leave null
 *   - gap > maxGapDays       → leave null
 */
export function interpolateGaps(
  series: LinePoint[],
  cfg: InterpolateConfig,
): LinePoint[] {
  if (!cfg.enabled || series.length === 0) return series;
  if (series.some((p) => !p.x || !ISO_DATE.test(p.x))) return series;

  const out = series.map((p) => ({ ...p }));
  let i = 0;
  while (i < out.length) {
    if (out[i].y !== null) {
      i++;
      continue;
    }
    // Find the bounding non-null endpoints.
    let left = i - 1;
    while (left >= 0 && out[left].y === null) left--;
    let right = i;
    while (right < out.length && out[right].y === null) right++;

    if (left < 0 || right >= out.length) {
      // leading or trailing run — bail; cannot interpolate without both ends
      i = right;
      continue;
    }
    const leftDate = parseIso(out[left].x as string);
    const rightDate = parseIso(out[right].x as string);
    const gapDays = Math.round((rightDate - leftDate) / DAY_MS);
    if (gapDays > cfg.maxGapDays) {
      i = right;
      continue;
    }

    const leftY = out[left].y as number;
    const rightY = out[right].y as number;
    for (let k = left + 1; k < right; k++) {
      const t = (parseIso(out[k].x as string) - leftDate) / (rightDate - leftDate);
      out[k] = { ...out[k], y: leftY + t * (rightY - leftY), estimated: true };
    }
    i = right;
  }
  return out;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(iso: string): number {
  return new Date(iso + "T00:00:00Z").getTime();
}
```

- [ ] **Step 2: Add the `estimated` flag to `LinePoint`**

Open [components/charts/LineChart.tsx](components/charts/LineChart.tsx) and modify the `LinePoint` type (around line 7) to add `estimated`:

```ts
export type LinePoint = {
  /** X-axis label (date string, e.g. "2026-04-25"). Optional for `mini`. */
  x?: string;
  /** Numeric value. `null` = no data (gap rendered as a thin dot). */
  y: number | null;
  /** Set by `interpolateGaps` — renderer treats these as dashed/hollow. */
  estimated?: boolean;
};
```

(This is a tiny prep change for the bigger `LineChart` rewrite in Task 5; making the type extension here keeps Task 5 focused on rendering.)

- [ ] **Step 3: Create the verification script**

```js
// lib/charts/__verify__/interpolate.mjs
//
// Quick smoke check for interpolateGaps. Run with:
//   node lib/charts/__verify__/interpolate.mjs
//
// Lives in __verify__ so it's clearly a one-off and not picked up by any
// future test runner. Uses runtime-equivalent JS so we can run it without
// a TypeScript build step.

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const parseIso = (iso) => new Date(iso + "T00:00:00Z").getTime();

function interpolateGaps(series, cfg) {
  if (!cfg.enabled || series.length === 0) return series;
  if (series.some((p) => !p.x || !ISO_DATE.test(p.x))) return series;
  const out = series.map((p) => ({ ...p }));
  let i = 0;
  while (i < out.length) {
    if (out[i].y !== null) { i++; continue; }
    let left = i - 1;
    while (left >= 0 && out[left].y === null) left--;
    let right = i;
    while (right < out.length && out[right].y === null) right++;
    if (left < 0 || right >= out.length) { i = right; continue; }
    const leftDate = parseIso(out[left].x);
    const rightDate = parseIso(out[right].x);
    const gapDays = Math.round((rightDate - leftDate) / DAY_MS);
    if (gapDays > cfg.maxGapDays) { i = right; continue; }
    const leftY = out[left].y;
    const rightY = out[right].y;
    for (let k = left + 1; k < right; k++) {
      const t = (parseIso(out[k].x) - leftDate) / (rightDate - leftDate);
      out[k] = { ...out[k], y: leftY + t * (rightY - leftY), estimated: true };
    }
    i = right;
  }
  return out;
}

// ----- Cases -----
const cases = [
  {
    name: "fills 2-day gap with linear interp",
    input: [
      { x: "2026-04-25", y: 60 },
      { x: "2026-04-26", y: null },
      { x: "2026-04-27", y: null },
      { x: "2026-04-28", y: 66 },
    ],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) =>
      out[1].y === 62 && out[1].estimated === true &&
      out[2].y === 64 && out[2].estimated === true &&
      out[0].estimated === undefined && out[3].estimated === undefined,
  },
  {
    name: "leaves >maxGapDays untouched",
    input: [
      { x: "2026-04-25", y: 60 },
      { x: "2026-04-26", y: null },
      { x: "2026-04-27", y: null },
      { x: "2026-04-28", y: null },
      { x: "2026-04-29", y: null },
      { x: "2026-04-30", y: 66 },
    ],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) =>
      out[1].y === null && out[2].y === null && out[3].y === null && out[4].y === null,
  },
  {
    name: "leaves leading/trailing nulls alone",
    input: [
      { x: "2026-04-25", y: null },
      { x: "2026-04-26", y: 60 },
      { x: "2026-04-27", y: 62 },
      { x: "2026-04-28", y: null },
    ],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) => out[0].y === null && out[3].y === null,
  },
  {
    name: "no-op when disabled",
    input: [
      { x: "2026-04-25", y: 60 },
      { x: "2026-04-26", y: null },
      { x: "2026-04-27", y: 66 },
    ],
    cfg: { enabled: false, maxGapDays: 3 },
    expect: (out) => out[1].y === null,
  },
  {
    name: "no-op when x is missing",
    input: [{ y: 60 }, { y: null }, { y: 66 }],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) => out[1].y === null,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const out = interpolateGaps(c.input, c.cfg);
  const ok = c.expect(out);
  if (ok) {
    console.log(`✓ ${c.name}`);
    passed++;
  } else {
    console.log(`✗ ${c.name}`);
    console.log("  input:  ", JSON.stringify(c.input));
    console.log("  output: ", JSON.stringify(out));
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 4: Run the verification script**

Run: `node lib/charts/__verify__/interpolate.mjs`
Expected output:
```
✓ fills 2-day gap with linear interp
✓ leaves >maxGapDays untouched
✓ leaves leading/trailing nulls alone
✓ no-op when disabled
✓ no-op when x is missing

5 passed, 0 failed
```

If any case fails, fix `interpolate.ts` (the `__verify__/interpolate.mjs` is a copy of the same logic — keep them in sync) and re-run.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/charts/interpolate.ts lib/charts/__verify__/interpolate.mjs components/charts/LineChart.tsx
git commit -m "feat(charts): linear gap interpolation helper

Per spec D2/D3/D5: linear interp between known endpoints when the gap
is at most cfg.maxGapDays calendar days. Estimated points marked with
estimated: true for the renderer to style as dashed/hollow. Fail-closed
on disabled config, missing dates, leading/trailing nulls.

Includes node-runnable verification script alongside (no test framework
configured in this project; this is the closest thing to TDD we get for
pure logic).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `LineChart` rewrite — gradient, gridlines, y-axis labels, comparison line, point markers, dashed segments, est. tooltip

**Files:**
- Modify: `components/charts/LineChart.tsx` (full rewrite of the rendering body)

This is the biggest change in the plan. We're replacing the rendering body of `LineChart.tsx` while preserving its public type (`LineChartProps`) plus the additions agreed in spec §1.

- [ ] **Step 1: Replace `components/charts/LineChart.tsx` entirely**

Open [components/charts/LineChart.tsx](components/charts/LineChart.tsx) and replace the whole file with:

```tsx
"use client";

import { useId, useMemo, useRef, useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { interpolateGaps } from "@/lib/charts/interpolate";
import { getInterpolateConfig } from "@/lib/charts/metricChartConfig";

export type LinePoint = {
  /** X-axis label (date string, e.g. "2026-04-25"). Optional for `mini`. */
  x?: string;
  /** Numeric value. `null` = no data (gap rendered as a thin dot). */
  y: number | null;
  /** Set by `interpolateGaps` — renderer treats these as dashed/hollow. */
  estimated?: boolean;
};

type LineChartProps = {
  data: LinePoint[];
  color: string;
  /** `mini` for compact metric cards; `detail` for /trends/[metric]. */
  variant?: "mini" | "detail";
  /** Override SVG width. Defaults to fluid (100% via viewBox). */
  width?: number;
  /** SVG height in px. Defaults: mini 80, detail 160. */
  height?: number;
  /** Show 4 date x-axis labels under detail charts. */
  xAxisLabels?: [string, string, string, string];
  /** Optional metric key — drives interpolation lookup in metricChartConfig. */
  metricKey?: string;
  /** Detail-only: comparison series (same length & x-alignment as `data`). */
  comparison?: LinePoint[] | null;
  /** Detail-only: render y-axis labels in a 24px left gutter. Default true. */
  yAxisLabels?: boolean;
  /** Detail-only: render filled markers on every real value. Default true. */
  pointMarkers?: boolean;
};

/**
 * Smooth cubic-Bézier line chart with gradient area fill.
 *
 * Smoothing uses horizontal-control approximation (a.k.a. "monotone-x"):
 * for each segment from P0 to P1, control points sit half-way along x at
 * the y of P0 and P1 respectively. Cheap, looks like proper monotone.
 *
 * Y-axis is padded by 12% of the data range so an extreme value never
 * slams into the top/bottom edges.
 *
 * The tooltip + y-axis labels live outside the SVG as HTML overlays so
 * their text isn't horizontally stretched by `preserveAspectRatio="none"`.
 */
export function LineChart({
  data: rawData,
  color,
  variant = "mini",
  width = 280,
  height,
  xAxisLabels,
  metricKey,
  comparison: rawComparison = null,
  yAxisLabels = true,
  pointMarkers = true,
}: LineChartProps) {
  const isDetail = variant === "detail";
  const h = height ?? (isDetail ? 160 : 80);
  const w = width;
  const pad = isDetail ? 12 : 8;
  const gridGutter = isDetail && yAxisLabels ? 24 : 0; // px reserved on the LEFT for y-axis labels
  const gradId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Pre-pass: interpolate gaps where the metric config allows.
  const data = useMemo(() => {
    const cfg = getInterpolateConfig(metricKey);
    return interpolateGaps(rawData, cfg);
  }, [rawData, metricKey]);

  // Comparison line is detail-only and never interpolated (per spec §2).
  const comparison = isDetail ? rawComparison : null;

  const { plot, points, comparisonPoints, valMin, valMax } = useMemo(() => {
    const allYs: number[] = [];
    for (const d of data) if (d.y !== null) allYs.push(d.y);
    if (comparison) for (const d of comparison) if (d.y !== null) allYs.push(d.y);
    if (allYs.length === 0) {
      return { plot: null, points: [], comparisonPoints: [], valMin: 0, valMax: 0 };
    }
    const dataMin = Math.min(...allYs);
    const dataMax = Math.max(...allYs);
    const dataRange = dataMax - dataMin || 1;
    const yPad = dataRange * 0.12;
    const valMin = dataMin - yPad;
    const valMax = dataMax + yPad;
    const range = valMax - valMin;

    const usableW = w - gridGutter;
    const usableH = h - pad * 2;
    const dx = data.length > 1 ? usableW / (data.length - 1) : 0;

    const project = (d: LinePoint, i: number) => {
      const x = gridGutter + i * dx;
      const y =
        d.y === null
          ? h / 2
          : pad + (1 - (d.y - valMin) / range) * usableH;
      return { x, y, raw: d.y, estimated: !!d.estimated };
    };

    const points = data.map(project);
    const comparisonPoints = comparison ? comparison.map(project) : [];

    return { plot: { dx, usableW, usableH }, points, comparisonPoints, valMin, valMax };
  }, [data, comparison, w, h, pad, gridGutter]);

  // Build paths. We split the primary line into "real-only" and
  // "estimated-touching" segments so estimated stretches render dashed
  // while real-data stretches render solid.
  const { realPath, estPath, areaPath } = useMemo(() => {
    if (!plot || points.length === 0) return { realPath: "", estPath: "", areaPath: "" };

    let real = "";
    let est = "";
    let area = "";
    let realStarted = false;
    let estStarted = false;
    let areaStarted = false;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.raw === null) {
        realStarted = false;
        estStarted = false;
        continue;
      }
      if (!areaStarted) {
        area += `M ${p.x} ${p.y}`;
        areaStarted = true;
      } else {
        const prev = points[i - 1];
        if (prev.raw !== null) {
          const cx = (p.x - prev.x) / 2;
          area += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
        } else {
          area += ` M ${p.x} ${p.y}`;
        }
      }
      const prev = points[i - 1];
      const segIsEstimated = p.estimated || (prev && prev.raw !== null && prev.estimated);

      if (segIsEstimated) {
        // estimated segment goes onto the dashed est path
        if (!estStarted) {
          est += `M ${prev?.raw !== null && prev ? prev.x : p.x} ${prev?.raw !== null && prev ? prev.y : p.y}`;
          estStarted = true;
        }
        if (prev && prev.raw !== null) {
          const cx = (p.x - prev.x) / 2;
          est += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
        }
        realStarted = false;
      } else {
        // solid real-data segment
        if (!realStarted) {
          real += `M ${p.x} ${p.y}`;
          realStarted = true;
        } else if (prev && prev.raw !== null) {
          const cx = (p.x - prev.x) / 2;
          real += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
        }
        estStarted = false;
      }
    }
    if (areaStarted) {
      const last = [...points].reverse().find((p) => p.raw !== null);
      const first = points.find((p) => p.raw !== null);
      if (last && first) {
        area += ` L ${last.x} ${h} L ${first.x} ${h} Z`;
      }
    }
    return { realPath: real, estPath: est, areaPath: area };
  }, [plot, points, h]);

  // Comparison line path — solid bezier through non-null points only.
  const comparisonPath = useMemo(() => {
    if (!plot || comparisonPoints.length === 0) return "";
    let out = "";
    let started = false;
    for (let i = 0; i < comparisonPoints.length; i++) {
      const p = comparisonPoints[i];
      if (p.raw === null) {
        started = false;
        continue;
      }
      if (!started) {
        out += `M ${p.x} ${p.y}`;
        started = true;
        continue;
      }
      const prev = comparisonPoints[i - 1];
      if (prev.raw === null) {
        out += ` M ${p.x} ${p.y}`;
        continue;
      }
      const cx = (p.x - prev.x) / 2;
      out += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
    }
    return out;
  }, [plot, comparisonPoints]);

  const lastRealPoint = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].raw !== null && !points[i].estimated) return points[i];
    }
    // fallback to last non-null even if estimated
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].raw !== null) return points[i];
    }
    return null;
  }, [points]);

  // Y-axis label values: 4 evenly-spaced ticks across the padded range.
  const yTickLabels = useMemo(() => {
    if (!isDetail || !yAxisLabels || !plot) return [];
    const r = valMax - valMin;
    return [valMax, valMax - r / 3, valMax - (2 * r) / 3, valMin].map(fmtNum);
  }, [isDetail, yAxisLabels, plot, valMin, valMax]);

  if (!plot || points.every((p) => p.raw === null)) {
    return (
      <div
        style={{
          width: "100%",
          height: h,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: COLOR.textFaint,
          fontSize: "11px",
          fontWeight: 500,
        }}
      >
        No data
      </div>
    );
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const xInSvgUnits = ((e.clientX - rect.left) / rect.width) * w;
    let nearest = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (points[i].raw === null) continue;
      const d = Math.abs(points[i].x - xInSvgUnits);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest >= 0 ? nearest : null);
  };

  const hover = hoverIndex !== null ? points[hoverIndex] : null;
  const hoverComparison =
    comparison && hoverIndex !== null ? comparisonPoints[hoverIndex] : null;
  const hoverDate = hoverIndex !== null ? data[hoverIndex].x : undefined;
  const hoverIsEstimated = hover && hover.estimated;

  // Tooltip CSS-pixel position relative to wrapper.
  const tooltipPos = hover
    ? {
        leftPct: (hover.x / w) * 100,
        topPx: (hover.y / h) * h,
      }
    : null;

  return (
    <div ref={wrapperRef} style={{ width: "100%", position: "relative" }}>
      {/* HTML y-axis labels overlay (detail only). 24px gutter on the left. */}
      {isDetail && yAxisLabels && yTickLabels.length === 4 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: pad,
            bottom: pad,
            width: gridGutter,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-end",
            paddingRight: 4,
            pointerEvents: "none",
          }}
        >
          {yTickLabels.map((lbl, i) => (
            <span
              key={i}
              style={{
                fontSize: "9px",
                fontWeight: 600,
                color: COLOR.textFaint,
                lineHeight: 1,
              }}
            >
              {lbl}
            </span>
          ))}
        </div>
      )}

      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        width="100%"
        height={h}
        style={{ display: "block", touchAction: "none", overflow: "visible" }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={isDetail ? 0.32 : 0.38} />
            <stop offset="60%"  stopColor={color} stopOpacity={isDetail ? 0.08 : 0.10} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Detail-only gridlines aligned with the 4 y-axis ticks. */}
        {isDetail && yAxisLabels && (
          <>
            {[0, 1 / 3, 2 / 3, 1].map((t, i) => {
              const y = pad + t * (h - pad * 2);
              return (
                <line
                  key={i}
                  x1={gridGutter}
                  y1={y}
                  x2={w}
                  y2={y}
                  stroke="#eef0f6"
                  strokeWidth="1"
                />
              );
            })}
          </>
        )}

        {/* Comparison line (detail-only, no fill, no markers). */}
        {comparisonPath && (
          <path
            d={comparisonPath}
            fill="none"
            stroke="#cdd1de"
            strokeWidth={2}
            strokeDasharray="4,3"
            strokeLinecap="round"
          />
        )}

        {/* Primary area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />

        {/* Solid (real) primary line */}
        <path
          d={realPath}
          fill="none"
          stroke={color}
          strokeWidth={isDetail ? 2.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dashed (estimated) primary line */}
        {estPath && (
          <path
            d={estPath}
            fill="none"
            stroke={color}
            strokeWidth={isDetail ? 2.5 : 2}
            strokeDasharray="4,4"
            strokeLinecap="round"
            opacity={0.85}
          />
        )}

        {/* Point markers (detail only). Real = filled white dot, estimated =
            hollow + dashed-stroke dot, last real = emphasized "now" dot. */}
        {isDetail && pointMarkers &&
          points.map((p, i) => {
            if (p.raw === null) return null;
            const isLast = lastRealPoint != null && p === lastRealPoint;
            if (p.estimated) {
              return (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={2}
                  fill="#fff"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="2,1.5"
                />
              );
            }
            return (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={isLast ? 5 : 3}
                fill="#fff"
                stroke={color}
                strokeWidth={isLast ? 2.75 : 2}
              />
            );
          })}

        {/* Mini variant: just the last real point dot. */}
        {!isDetail && lastRealPoint && (
          <circle
            cx={lastRealPoint.x}
            cy={lastRealPoint.y}
            r={3}
            fill="#fff"
            stroke={color}
            strokeWidth={2.5}
          />
        )}

        {/* Hover guide */}
        {hover && hover.raw !== null && (
          <>
            <line
              x1={hover.x}
              y1="0"
              x2={hover.x}
              y2={h}
              stroke={COLOR.textStrong}
              strokeOpacity={0.18}
              strokeDasharray="3,3"
              strokeWidth="1"
            />
            <circle cx={hover.x} cy={hover.y} r={4} fill="#fff" stroke={color} strokeWidth={2.5} />
          </>
        )}
      </svg>

      {/* HTML tooltip overlay */}
      {hover && hover.raw !== null && tooltipPos && (
        <div
          style={{
            position: "absolute",
            left: `${tooltipPos.leftPct}%`,
            top: 0,
            transform: "translate(-50%, -100%)",
            marginTop: "-4px",
            background: COLOR.textStrong,
            color: "#fff",
            padding: "5px 9px",
            borderRadius: "8px",
            fontSize: "11px",
            fontWeight: 700,
            lineHeight: 1.25,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 4px 10px rgba(20,30,80,0.18)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1px",
            zIndex: 5,
          }}
        >
          {hoverDate && (
            <span style={{ fontSize: "9px", fontWeight: 600, color: COLOR.textFaint }}>
              {hoverDate}
            </span>
          )}
          <span data-tnum>
            {fmtNum(hover.raw)}
            {hoverIsEstimated && (
              <span style={{ marginLeft: 4, color: COLOR.textFaint, fontWeight: 500 }}>
                (est.)
              </span>
            )}
          </span>
          {hoverComparison && hoverComparison.raw !== null && (
            <span data-tnum style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 500 }}>
              {fmtNum(hoverComparison.raw)} <span style={{ fontWeight: 400 }}>(prev)</span>
            </span>
          )}
        </div>
      )}

      {variant === "detail" && xAxisLabels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "6px 2px 2px",
            paddingLeft: gridGutter + 2,
            fontSize: "10px",
            color: COLOR.textFaint,
            fontWeight: 500,
          }}
        >
          {xAxisLabels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Smoke check `/trends/[metric]` and `/trends`**

Run: `npm run dev`. With a logged-in mobile viewport:
- Open `/trends` → mini sparklines render (HRV, RHR, Sleep, Strain, Weight, Body Fat). They should look the same as before but with a slightly more saturated fill (3-stop gradient).
- Open `/trends/hrv` → detail chart renders with **point markers at every value, y-axis labels in a left gutter, gridlines, single solid line** (comparison line not yet wired — that's Task 8). Confirm:
  - Y-axis labels are not horizontally stretched.
  - Tapping a point shows the tooltip (no `(prev)` line yet, no `(est.)` unless there happens to be a real gap).
  - X-axis date labels still align below.
- Open `/strength` → existing volume / 1RM mini sparklines still render.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add components/charts/LineChart.tsx
git commit -m "feat(charts): rewrite LineChart with new visual language

- 3-stop gradient fill (richer than the prior 2-stop)
- Detail variant: 4 evenly-spaced y-axis ticks with HTML overlay labels
  (avoiding preserveAspectRatio horizontal stretch), aligned gridlines,
  point markers at every real value, dashed/hollow markers on estimated
  points (per spec D2), tooltip '(est.)' suffix and prior-period value
- Comparison line render path (faint dashed gray, no fill, no markers)
- Pre-pass through interpolateGaps keyed by metricKey prop
- Mini variant largely unchanged (still single last-point dot) but
  inherits the richer fill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Thread `metricKey` through `MetricCard` and `/trends` overview

**Files:**
- Modify: `components/charts/MetricCard.tsx` (add prop, pass it down)
- Modify: `app/trends/page.tsx` (pass `metricKey` to each `MetricCard`)

- [ ] **Step 1: Add `metricKey` prop to `MetricCard`**

Open [components/charts/MetricCard.tsx](components/charts/MetricCard.tsx). At the top of the file (the imports), add:

```ts
import type { DailyLogKey } from "@/lib/ui/colors";
```

In the `MetricCardProps` type (around line 8), add:

```ts
  /** Optional — drives sparkline interpolation lookup. */
  metricKey?: DailyLogKey;
```

In the `MetricCard` function destructure (around line 29), add `metricKey` to the destructured props.

In the inner `<LineChart>` call (around line 134), add `metricKey={metricKey}`:

```tsx
{trend && trend.length > 0 && (
  <div style={{ marginTop: "6px" }}>
    <LineChart data={trend} color={color} variant="mini" metricKey={metricKey} />
  </div>
)}
```

- [ ] **Step 2: Pass `metricKey` from `/trends` overview**

Open [app/trends/page.tsx](app/trends/page.tsx). On each of the six `<MetricCard>` calls (lines 152–222), add the `metricKey` prop matching the metric:

```tsx
<MetricCard color={METRIC_COLOR.hrv}        metricKey="hrv"          icon="♥" label="HRV"        ... />
<MetricCard color={METRIC_COLOR.resting_hr} metricKey="resting_hr"   icon="♥" label="Resting HR" ... />
<MetricCard color={METRIC_COLOR.sleep_hours} metricKey="sleep_hours" icon="☾" label="Sleep"      ... />
<MetricCard color={METRIC_COLOR.strain}     metricKey="strain"       icon="⚡" label="Strain"    ... />
<MetricCard color={METRIC_COLOR.weight_kg}  metricKey="weight_kg"    icon="⚖" label="Weight"    ... />
<MetricCard color={METRIC_COLOR.body_fat_pct} metricKey="body_fat_pct" icon="%" label="Body Fat" ... />
```

(Just inserting the new prop — leave the other props unchanged.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. (`DailyLogKey` is exported from `lib/ui/colors.ts` — see line 7 of the file.)

- [ ] **Step 4: Smoke check interpolation on `/trends`**

Run: `npm run dev`. Open `/trends?period=30d`. If your data has any natural HRV/RHR/Sleep gaps within the past 30 days, the mini sparklines should now interpolate them (visible as smoother continuous lines rather than broken segments). If everything is fully populated you won't notice a difference, which is fine — Task 7 will flush out the visible cue at the detail level.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add components/charts/MetricCard.tsx app/trends/page.tsx
git commit -m "feat(charts): thread metricKey through MetricCard for interpolation

Lets per-metric InterpolateConfig flow into the mini sparkline
LineChart on /trends overview cards. HRV, RHR, sleep, weight,
body fat now interpolate gaps; strain stays gappy by config.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Date pass-through for `WeeklyRollups` weight sparkline

**Files:**
- Modify: `components/dashboard/WeeklyRollups.tsx`

- [ ] **Step 1: Inspect existing date wiring**

Run: `grep -n "wWgt\|week\.dates\|week\.labels" components/dashboard/WeeklyRollups.tsx`

You're looking for where `week.labels` and `wWgt` come from. The `week` object (built earlier in the file) likely already has a `dates` field — if not, we add it.

- [ ] **Step 2: Update the weight sparkline data shape**

In [components/dashboard/WeeklyRollups.tsx:194](components/dashboard/WeeklyRollups.tsx#L194), the LineChart for weight currently looks like:

```tsx
<LineChart
  data={wWgt.map((y) => ({ y }))}
  color={METRIC_COLOR.weight_kg}
  variant="mini"
  height={40}
/>
```

Change it to:

```tsx
<LineChart
  data={wWgt.map((y, i) => ({ x: week.dates?.[i], y }))}
  color={METRIC_COLOR.weight_kg}
  variant="mini"
  height={40}
  metricKey="weight_kg"
/>
```

If the inspection in Step 1 shows that `week` has no `dates` field, locate where `week` is constructed (search for `const week = ` or similar in the file) and add a `dates: string[]` array of ISO date strings, one per day in the rolling 7-day window. The existing `week.labels` array tells you what day each index maps to. Reuse the same source date computation.

(If `week.dates` already exists or can be computed in one line, keep this change small — don't refactor the whole file.)

Leave the steps and calories sparklines unchanged — they're fail-closed in `metricChartConfig` regardless of x.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Smoke check**

Run: `npm run dev`. Open `/`. The weight sparkline in the Last-7-Days section should still render. If you have a 1-2 day weight gap in the past week, it should now interpolate (per `weight_kg` config: `enabled: true, maxGapDays: 14`).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/WeeklyRollups.tsx
git commit -m "feat(dashboard): pass dates to weight sparkline so interp works

Steps and calories stay dateless — they're fail-closed in
metricChartConfig anyway (accumulators don't interpolate).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `comparisonSeries` helper + wire into `/trends/[metric]` via `DetailChartCard`

**Files:**
- Create: `lib/charts/comparisonSeries.ts`
- Create: `components/charts/DetailChartCard.tsx`
- Modify: `app/trends/[metric]/page.tsx`

- [ ] **Step 1: Create `lib/charts/comparisonSeries.ts`**

```ts
// lib/charts/comparisonSeries.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinePoint } from "@/components/charts/LineChart";

const DAY_MS = 86_400_000;

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function isoDaysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00Z").getTime();
  const b = new Date(toIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / DAY_MS) + 1;
}

/**
 * Daily-resolution prior-period series for the /trends/[metric] detail
 * chart. Returns one LinePoint per calendar day in the prior window
 * (gap-preserving — nulls stay null), or null if coverage < 50%.
 *
 * Index alignment: comparison[i] is plotted at the same x-position as
 * data[i] in the current window. Same series length on both sides.
 */
export async function getComparisonSeries(
  supabase: SupabaseClient,
  userId: string,
  metricKey: string,
  fromIso: string,
  toIso: string,
): Promise<LinePoint[] | null> {
  const days = isoDaysBetween(fromIso, toIso);
  const priorTo = shiftIso(fromIso, -1);
  const priorFrom = shiftIso(priorTo, -(days - 1));

  const { data: rows } = await supabase
    .from("daily_logs")
    .select(`date, ${metricKey}`)
    .eq("user_id", userId)
    .gte("date", priorFrom)
    .lte("date", priorTo)
    .order("date", { ascending: true });

  // Index by date so we can produce a dense day-by-day array even if some
  // days are missing rows entirely.
  const byDate = new Map<string, number | null>();
  for (const row of rows ?? []) {
    const r = row as Record<string, unknown>;
    const v = r[metricKey];
    byDate.set(r.date as string, typeof v === "number" ? v : null);
  }

  const out: LinePoint[] = [];
  for (let i = 0; i < days; i++) {
    const dateIso = shiftIso(priorFrom, i);
    const v = byDate.get(dateIso) ?? null;
    out.push({ x: dateIso, y: v });
  }

  // Coverage gate (D11): drop if < 50% of buckets have any data.
  const covered = out.filter((p) => p.y !== null).length;
  if (covered / Math.max(1, out.length) < 0.5) return null;

  return out;
}
```

- [ ] **Step 2: Create `components/charts/DetailChartCard.tsx`**

```tsx
// components/charts/DetailChartCard.tsx
import { Card } from "@/components/ui/Card";
import { RangePills } from "@/components/ui/RangePills";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { COLOR } from "@/lib/ui/theme";
import type { DailyLogKey } from "@/lib/ui/colors";

type RangeOption = { id: string; label: string; href: string };

type Props = {
  /** Title in the top-left of the card chrome. */
  title: string;
  data: LinePoint[];
  comparison: LinePoint[] | null;
  color: string;
  metricKey: DailyLogKey;
  rangeOptions: RangeOption[];
  activeRange: string;
  /** Period descriptor for the legend chip text — e.g. "30 days". */
  periodLabel: string;
  xAxisLabels?: [string, string, string, string];
};

/**
 * Detail chart card chrome. Two rows:
 *   row 1: title + inline legend chips (current / prior period)
 *   row 2: range pills (right-aligned)
 * Two rows because the combined width overflows at 360px viewports.
 */
export function DetailChartCard({
  title,
  data,
  comparison,
  color,
  metricKey,
  rangeOptions,
  activeRange,
  periodLabel,
  xAxisLabels,
}: Props) {
  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: COLOR.textStrong,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {title}
          </span>
          <div style={{ display: "flex", gap: "12px", fontSize: "10px", color: COLOR.textMid, fontWeight: 600 }}>
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: color,
                  marginRight: "5px",
                  verticalAlign: "middle",
                }}
              />
              This {periodLabel}
            </span>
            {comparison && (
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#cdd1de",
                    marginRight: "5px",
                    verticalAlign: "middle",
                  }}
                />
                Prior {periodLabel}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RangePills options={rangeOptions} active={activeRange} />
        </div>
      </div>
      <LineChart
        data={data}
        comparison={comparison}
        color={color}
        variant="detail"
        metricKey={metricKey}
        xAxisLabels={xAxisLabels}
      />
    </Card>
  );
}
```

- [ ] **Step 3: Wire `getComparisonSeries` + `DetailChartCard` into `/trends/[metric]/page.tsx`**

Open [app/trends/[metric]/page.tsx](app/trends/[metric]/page.tsx). Replace the imports section (lines 1–9) with:

```ts
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { DetailChartCard } from "@/components/charts/DetailChartCard";
import type { LinePoint } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { FIELDS, type DailyLogKey } from "@/lib/ui/colors";
import { fmtNum } from "@/lib/ui/score";
import { todayInUserTz } from "@/lib/time";
import { getComparisonSeries } from "@/lib/charts/comparisonSeries";
```

(Note: `RangePills` and `LineChart` are no longer imported here — they're consumed inside `DetailChartCard`.)

Add a `RANGE_LABEL` constant near `RANGE_DAYS`:

```ts
const RANGE_LABEL: Record<string, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "1y": "year",
};
```

After the existing `rows` query (after line 53), call the comparison helper:

```ts
const comparison = await getComparisonSeries(
  supabase,
  user.id,
  key,
  startIso,
  today,
);
```

Then replace the JSX block from `<div style={{ padding: "0 8px 14px" }}><RangePills ... /></div>` through the existing `<Card><LineChart ... /></Card>` (roughly lines 99–107) with a single:

```tsx
<div style={{ padding: "0 8px 12px" }}>
  <DetailChartCard
    title={field.l}
    data={data}
    comparison={comparison}
    color={color}
    metricKey={key}
    rangeOptions={rangeOpts}
    activeRange={range}
    periodLabel={RANGE_LABEL[range] ?? `${days} days`}
    xAxisLabels={labels}
  />
</div>
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. If you get a "Card is unused" warning, remove the `Card` import (we only kept it in the imports as a precaution; the `DetailChartCard` already uses `Card` internally).

Update the imports if needed:

```ts
// drop the now-unused Card import if TS / ESLint flags it
```

- [ ] **Step 5: Smoke check the detail chart**

Run: `npm run dev`. Visit `/trends/hrv`:
- Card chrome shows: HRV title + two legend chips ("This 30 days" with the metric color dot, "Prior 30 days" with a gray dot — assuming you have ≥ 50% prior coverage).
- Range pills are right-aligned below the legend.
- Chart shows TWO lines: current HRV in the metric color (solid line + filled markers), prior 30 days in faint gray dashed.
- Hover a point → tooltip shows current value, with `(prev)` value below if comparison is available.
- Switch range to 7D / 90D / 1Y → comparison line follows.

Try `/trends/weight_kg`:
- If you have ≥ 50% weight coverage in the prior 30 days, comparison line appears.
- If you don't (e.g., weighed in only sporadically), the chart renders single-line and the "Prior" legend chip is suppressed (only the "This" chip shows).

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add lib/charts/comparisonSeries.ts components/charts/DetailChartCard.tsx app/trends/[metric]/page.tsx
git commit -m "feat(trends): comparison line + DetailChartCard chrome

- getComparisonSeries fetches the prior-window daily series for the
  same metric, returns null if coverage < 50% (D11)
- DetailChartCard composes title + legend chips + range pills + chart
  into a single card; range pills move INSIDE the chart card on detail
  pages (vs. the page-level pattern on /trends overview)
- /trends/[metric] page now passes comparison through and uses the
  new wrapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end verification + push

- [ ] **Step 1: Final typecheck**

Run: `npm run typecheck`
Expected: clean exit.

- [ ] **Step 2: Production build sanity check**

Run: `npm run build`
Expected: build succeeds. (Catches any issues that strict TS missed and any client/server boundary mistakes from the FAB / FabGate changes.)

- [ ] **Step 3: Run-through against the spec test plan**

Open the design doc's Test plan section ([2026-05-06-charts-revamp-and-layout-cleanup-design.md](../specs/2026-05-06-charts-revamp-and-layout-cleanup-design.md), lines beginning "## Test plan") and walk through each numbered item with `npm run dev`:

1. `/trends/hrv` — comparison + markers + y-axis labels + legend + range pills ✓
2. Force a 2-day HRV gap via Supabase SQL → dashed segment + hollow markers + `(est.)` tooltip
3. Force a 5-day gap → true gap, no dash
4. Force a 2-day `steps` gap → true gap, no interpolation
5. Pick a metric with sparse prior-period coverage → no comparison line, no second legend chip
6. `/` MetricCards still single-line + last dot, slightly richer fill
7. Scroll any page to the bottom → last card has breathing room above the nav
8. FAB `+` → "Ask coach" → ChatPanel opens; close → returns
9. Resize ≥ 768px → bottom nav hidden, no extra padding

If any check fails, `git stash` your scratch changes, return to the failing task, and re-fix.

- [ ] **Step 4: Push**

```bash
git push origin redesign/v1
```

(Vercel will pick up the branch; for end-to-end verification on a real device, the preview URL is the cleanest path. Cron `/api/whoop/sync` is unaffected by these changes.)

- [ ] **Step 5: Update the redesign-brainstorm memory**

Mark the locked decision #6 in the redesign-brainstorm memory as superseded:

Edit `/Users/abdelouahedelbied/.claude/projects/-Users-abdelouahedelbied-Health-app/memory/project_redesign_brainstorm.md` and append a one-line note in the locked decisions section under #6 saying "→ revised 2026-05-06; see [docs/superpowers/specs/2026-05-06-charts-revamp-and-layout-cleanup-design.md](../../docs/superpowers/specs/2026-05-06-charts-revamp-and-layout-cleanup-design.md)".

(No commit — this is a Claude memory file, not in the repo.)

---

## Self-Review Checklist (run before handoff)

- [x] **Spec coverage:** Every locked decision (D1–D11, F1–F4) maps to a task. D1/D8/D9/D10 and F1–F4 are explicit; D2/D3/D5/D6 are inside Task 5 (LineChart rewrite) + Task 4 (interpolate); D4 is Task 3 (config); D7 + D11 are Task 8 (comparisonSeries + DetailChartCard).
- [x] **Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to Task N" in the plan. Every code step has full code.
- [x] **Type consistency:** `LinePoint` adds `estimated?: boolean` in Task 4 step 2; consumed in Task 5. `InterpolateConfig` defined in Task 3, imported in Task 4. `getInterpolateConfig`, `interpolateGaps`, `getComparisonSeries` signatures consistent across tasks. `DetailChartCard` props match how `/trends/[metric]` passes them in Task 8.
- [x] **No tests where there's no test framework:** Verification is `npm run typecheck` + targeted manual smoke after each task, plus a node-runnable script for the one piece of pure logic. Matches CLAUDE.md's "no test suite" reality.
