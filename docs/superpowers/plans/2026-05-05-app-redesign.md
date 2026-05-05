# Apex Health — full app visual redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current dark, dense UI with a soft, light, type-led visual system inspired by consumer-wellness apps (Apple Fitness lineage). New design tokens, new component primitives, new navigation chrome (4 bottom tabs + center FAB on mobile, top tab bar on desktop). Same routes, same backend, same data flows.

**Architecture:** A new `lib/ui/theme.ts` defines the design tokens (color, radius, shadow, per-metric color palette, intensity-mode color mapping). New primitives live under `components/ui/` and `components/layout/`. Per-page restyles compose those primitives. Backend, sync routes, RLS, schema, integration merges, `lib/coach/*`, `lib/time.ts`, `lib/data/types.ts`, `lib/anthropic/*` are untouched. The work is sliced so each slice is independently shippable.

**Tech Stack:** Next.js 15 (App Router) · Tailwind v4 (PostCSS, no `tailwind.config.ts` — inline `@theme`) · TypeScript (strict) · DM Sans / DM Mono via `next/font/google` · hand-rolled SVG charts (no Recharts/Visx) · Supabase (untouched).

**Spec:** [docs/superpowers/specs/2026-05-05-app-redesign-design.md](../specs/2026-05-05-app-redesign-design.md)

**Project verification policy:** Per [CLAUDE.md](../../../CLAUDE.md), there is no test suite. Verification at every task is `npm run typecheck` + a defined manual check (open the affected page in `npm run dev` and exercise it). The `lint` script was dropped from the project on 2026-05-05 (commit `57e68f3`), so do not run `npm run lint` — it no longer exists. Do not introduce a test runner; do not write `*.test.ts` files unless explicitly requested.

---

## File map

### Create

- [lib/ui/theme.ts](../../../lib/ui/theme.ts) — design tokens (COLOR, RADIUS, SHADOW, METRIC_COLOR, modeColorLight) — ~100 lines
- [components/ui/Card.tsx](../../../components/ui/Card.tsx) — *rewrite* of existing file — Card primitive with `variant: 'standard' | 'compact' | 'nested'` — ~50 lines
- [components/ui/Pill.tsx](../../../components/ui/Pill.tsx) — generic pill (status / category) — ~40 lines
- [components/ui/StatusRow.tsx](../../../components/ui/StatusRow.tsx) — settings-row primitive — ~50 lines
- [components/ui/RangePills.tsx](../../../components/ui/RangePills.tsx) — generalized range/view pill row — ~70 lines
- [components/charts/LineChart.tsx](../../../components/charts/LineChart.tsx) — *rewrite* of existing file — smooth gradient line chart with `mini` / `detail` variants — ~190 lines
- [components/charts/MetricCard.tsx](../../../components/charts/MetricCard.tsx) — *rewrite* of existing file — icon + label + big value + delta + optional mini chart — ~110 lines
- [components/layout/WeekStrip.tsx](../../../components/layout/WeekStrip.tsx) — 7-day picker — ~75 lines
- [components/layout/BottomNav.tsx](../../../components/layout/BottomNav.tsx) — mobile bottom tab bar with FAB cut-out — ~90 lines
- [components/layout/Fab.tsx](../../../components/layout/Fab.tsx) — center FAB button + sheet container — ~120 lines
- [components/layout/TopNav.tsx](../../../components/layout/TopNav.tsx) — *rewrite* concept of TabNav — desktop top nav with `+ New` button — ~95 lines
- [components/dashboard/ReadinessHero.tsx](../../../components/dashboard/ReadinessHero.tsx) — solid blue readiness hero card — ~75 lines
- [components/dashboard/CoachEntryCard.tsx](../../../components/dashboard/CoachEntryCard.tsx) — coach card with thumbnail + headline — ~55 lines
- [components/dashboard/RecentLiftsCard.tsx](../../../components/dashboard/RecentLiftsCard.tsx) — 2-row preview of recent strength sessions — ~80 lines
- [components/profile/IntegrationRow.tsx](../../../components/profile/IntegrationRow.tsx) — connected-source row — ~70 lines
- [app/trends/[metric]/page.tsx](../../../app/trends/[metric]/page.tsx) — single-metric detail view — ~140 lines

### Modify

- [package.json](../../../package.json) — DM Sans needs weight `700` and `800`
- [app/globals.css](../../../app/globals.css) — light-theme base styles, Tailwind v4 `@theme` tokens
- [app/layout.tsx](../../../app/layout.tsx) — light theme color, additional font weights, mount `BottomNav` + `Fab`
- [lib/ui/colors.ts](../../../lib/ui/colors.ts) — switch `FIELDS[].c` and helpers to light-theme palette; export `METRIC_COLOR` map
- [components/layout/Header.tsx](../../../components/layout/Header.tsx) — drop `TabNav` import + render; light-theme palette
- [components/log/LogForm.tsx](../../../components/log/LogForm.tsx) — restyle in soft-light; structure preserved
- [components/dashboard/ImpactDonut.tsx](../../../components/dashboard/ImpactDonut.tsx) — light-theme palette only; logic unchanged
- [components/dashboard/WeeklyRollups.tsx](../../../components/dashboard/WeeklyRollups.tsx) — re-skin as `Card` + `LineChart` mini stack
- [components/coach/CoachNav.tsx](../../../components/coach/CoachNav.tsx) — restyle as `RangePills`-shaped row
- [components/coach/InsightsList.tsx](../../../components/coach/InsightsList.tsx) — restyle in `Card` + `Pill`
- [components/coach/RecommendationsList.tsx](../../../components/coach/RecommendationsList.tsx) — restyle in `Card` + `Pill`
- [components/coach/WeeklyReview.tsx](../../../components/coach/WeeklyReview.tsx) — restyle in `Card` + `Pill`
- [components/coach/RefreshButton.tsx](../../../components/coach/RefreshButton.tsx) — light-theme button
- [components/strength/StrengthNav.tsx](../../../components/strength/StrengthNav.tsx) — switch to `RangePills` shape
- [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx) — light-theme + `modeColorLight()` mapping
- [components/strength/SessionTable.tsx](../../../components/strength/SessionTable.tsx) — light-theme rows
- [components/strength/SessionRow.tsx](../../../components/strength/SessionRow.tsx) — light-theme
- [components/strength/PRList.tsx](../../../components/strength/PRList.tsx) — light-theme; uses new `Card` nested
- [components/strength/ExerciseTrendCard.tsx](../../../components/strength/ExerciseTrendCard.tsx) — uses new `LineChart`
- [components/strength/VolumeTrendCard.tsx](../../../components/strength/VolumeTrendCard.tsx) — uses new `LineChart`; volume hero variant
- [components/strength/DateNavigator.tsx](../../../components/strength/DateNavigator.tsx) — light-theme
- [components/strength/CoachCards.tsx](../../../components/strength/CoachCards.tsx) — light-theme
- [components/profile/ProfileForm.tsx](../../../components/profile/ProfileForm.tsx) — light-theme
- [components/profile/ConnectionsPanel.tsx](../../../components/profile/ConnectionsPanel.tsx) — composed of `IntegrationRow`
- [components/profile/BaselinesPanel.tsx](../../../components/profile/BaselinesPanel.tsx) — composed of `StatusRow`
- [components/profile/IngestPanel.tsx](../../../components/profile/IngestPanel.tsx) — composed of `StatusRow`
- [components/profile/BackfillButton.tsx](../../../components/profile/BackfillButton.tsx) — light-theme button
- [components/trends/PeriodSelector.tsx](../../../components/trends/PeriodSelector.tsx) — replaced by usage of `RangePills`; file deleted (see below)
- [app/page.tsx](../../../app/page.tsx) — new dashboard layout
- [app/log/page.tsx](../../../app/log/page.tsx) — drop `Header`; new layout shell
- [app/trends/page.tsx](../../../app/trends/page.tsx) — compact-card stack + `RangePills`
- [app/strength/page.tsx](../../../app/strength/page.tsx) — restyle shell only; sub-views unchanged in routing
- [app/coach/page.tsx](../../../app/coach/page.tsx) — restyle shell only
- [app/profile/page.tsx](../../../app/profile/page.tsx) — sectioned layout
- [app/login/page.tsx](../../../app/login/page.tsx) — light-theme card
- [app/privacy/page.tsx](../../../app/privacy/page.tsx) — light-theme prose

### Delete

- [components/layout/TabNav.tsx](../../../components/layout/TabNav.tsx) — replaced by `BottomNav` + `TopNav`
- [components/dashboard/DashboardDatePager.tsx](../../../components/dashboard/DashboardDatePager.tsx) — replaced by `WeekStrip`
- [components/ui/MetricBar.tsx](../../../components/ui/MetricBar.tsx) — superseded by `MetricCard` grid
- [components/ui/PrioBox.tsx](../../../components/ui/PrioBox.tsx) — superseded by `Card` + `Pill`
- [components/ui/Gauge.tsx](../../../components/ui/Gauge.tsx) — readiness uses `ReadinessHero` + `ImpactDonut`
- [components/ui/SparkLine.tsx](../../../components/ui/SparkLine.tsx) — superseded by `LineChart` mini
- [components/charts/BarChart.tsx](../../../components/charts/BarChart.tsx) — confirm no callers, then delete
- [components/charts/RecoveryBars.tsx](../../../components/charts/RecoveryBars.tsx) — confirm no callers, then delete
- [components/dashboard/MonitorTile.tsx](../../../components/dashboard/MonitorTile.tsx) — confirm no callers, then delete
- [components/dashboard/DashboardSection.tsx](../../../components/dashboard/DashboardSection.tsx) — confirm no callers, then delete
- [components/dashboard/SkeletonCard.tsx](../../../components/dashboard/SkeletonCard.tsx) — confirm callers, replace with new card skeleton if used
- [components/trends/PeriodSelector.tsx](../../../components/trends/PeriodSelector.tsx) — replaced by `RangePills`

---

# Slice 1 — Tokens + base components

This slice builds the foundation: design tokens and the component primitives every page composes. No page changes yet. A throwaway `/dev/tokens` ghost page lets you preview every primitive in isolation.

## Task 1: Add DM Sans weights 700 and 800

**Files:**
- Modify: [app/layout.tsx](../../../app/layout.tsx)

The redesign uses `font-weight: 700` for headings and `800` for big numbers. Currently only 300/400/500/600 are loaded.

- [ ] **Step 1: Add weights to the DM Sans font import**

Edit [app/layout.tsx](../../../app/layout.tsx) lines 7–12:

```tsx
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-dm-sans",
});
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/layout.tsx
git commit -m "chore(layout): load DM Sans weights 700 + 800 for redesign"
```

## Task 2: Add `lib/ui/theme.ts` with design tokens

**Files:**
- Create: [lib/ui/theme.ts](../../../lib/ui/theme.ts)

The single source of truth for the new visual language. Pure constants + one tiny mapping function. No React imports.

- [ ] **Step 1: Create the file**

Write [lib/ui/theme.ts](../../../lib/ui/theme.ts):

```ts
// Design tokens for the soft-light redesign.
// All colors light-theme calibrated. Kept as plain constants so they can be
// imported by both server and client components without bundler tax.

import type { DailyLogKey } from "./colors";

export const COLOR = {
  // Surfaces
  bg:         "#f1f2f6",  // page background — soft off-white-blue
  surface:    "#ffffff",  // cards, nav bar
  surfaceAlt: "#f5f6fa",  // input fields, inactive pills, sub-rows

  // Content
  textStrong: "#0f1430",  // primary text, big numbers
  textMid:    "#4a4d62",  // body text
  textMuted:  "#7a7e95",  // labels, secondary text
  textFaint:  "#9094a8",  // helper text, axis labels

  // Accent
  accent:     "#4f5dff",
  accentSoft: "#e7eaff",
  accentDeep: "#3a47e8",

  // Semantic
  success:     "#14b870",
  successSoft: "#d1fae5",
  warning:     "#f59e0b",
  warningSoft: "#fef3c7",
  danger:      "#ef4444",
  dangerSoft:  "#fee2e2",

  divider:    "#e8eaf3",
} as const;

export const RADIUS = {
  chip:      "6px",
  pill:      "10px",
  input:     "10px",
  cardSmall: "14px",  // sub-cards nested inside sections
  cardMid:   "16px",  // compact cards (/trends, /strength compact metric stack)
  card:      "20px",  // standard cards (dashboard, /log)
  cardHero:  "24px",  // readiness, /strength volume hero
  full:      "9999px",
} as const;

export const SHADOW = {
  card:       "0 2px 8px rgba(20,30,80,0.05)",
  cardHover:  "0 4px 12px rgba(20,30,80,0.08)",
  heroAccent: "0 12px 28px -8px rgba(79,93,255,0.4)",
  heroAmber:  "0 12px 24px -8px rgba(180,83,9,0.4)",
  bottomNav:  "0 4px 14px rgba(20,30,80,0.08)",
  fab:        "0 8px 20px -4px rgba(79,93,255,0.5)",
  floating:   "0 30px 60px -20px rgba(20,30,80,0.18)",
} as const;

// Per-metric line/icon colors. Light-theme calibrated.
// Keys must mirror DailyLogKey union from lib/ui/colors.ts.
export const METRIC_COLOR: Record<DailyLogKey, string> = {
  hrv:              "#e11d48", // rose
  resting_hr:       "#f97316", // orange
  spo2:             "#06b6d4", // cyan
  skin_temp_c:      "#ea580c", // orange-deep
  sleep_hours:      "#4f5dff", // indigo (= accent)
  sleep_score:      "#4f5dff",
  deep_sleep_hours: "#2563eb", // blue
  rem_sleep_hours:  "#a855f7", // violet
  strain:           "#b45309", // amber
  steps:            "#14b870", // emerald
  calories:         "#ca8a04", // mustard
  weight_kg:        "#8b5cf6", // purple
  body_fat_pct:     "#ea580c", // orange-deep
};

/**
 * Map an existing IntensityMode.color (dark-theme calibrated) to its
 * light-theme equivalent. Pure function — keeps lib/coach/readiness.ts
 * untouched so coach logic stays a pure module.
 */
export function modeColorLight(hex: string): string {
  switch (hex) {
    case "#30d158": return COLOR.success;       // ⚡ PUSH HARD
    case "#86efac": return "#34d399";           // 🟢 FULL SESSION
    case "#ffd60a": return COLOR.warning;       // 🟡 MODERATE
    case "#ff453a": return COLOR.danger;        // 🔴 LIGHT / RECOVERY
    case "#6b7280": return COLOR.textMuted;     // ⚫ REST DAY
    default:        return COLOR.accent;        // unknown — fall back to accent
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean (the `DailyLogKey` import resolves; everything else is plain values).

- [ ] **Step 3: Commit**

```bash
git add lib/ui/theme.ts
git commit -m "feat(ui): add lib/ui/theme.ts design tokens for redesign"
```

## Task 3: Update `lib/ui/colors.ts` to light-theme palette

**Files:**
- Modify: [lib/ui/colors.ts](../../../lib/ui/colors.ts)

Replace dark-theme metric colors and the `scoreColor` band with light-theme values. Keep the `FIELDS` order, keys, units, and max values exactly the same — only `c` (color) changes.

- [ ] **Step 1: Replace `FIELDS[].c` and `scoreColor` / `priorityColor` values**

Edit [lib/ui/colors.ts](../../../lib/ui/colors.ts) — replace lines 1–73 (everything in the file) with:

```ts
// Color palette and field metadata — light-theme calibrated.
// For per-metric chart colors, lib/ui/theme.ts:METRIC_COLOR is the canonical
// source. The `c` values here mirror it for backward compatibility with any
// caller still reading FIELDS[].c directly.

import { COLOR, METRIC_COLOR } from "./theme";

export const WCOLORS: Record<string, string> = {
  Chest:      "#f97316",  // orange
  Back:       "#4f5dff",  // indigo (accent)
  Legs:       "#14b870",  // emerald
  Shoulders:  "#a855f7",  // violet
  Arms:       "#ef4444",  // red
  "Full Body":"#06b6d4",  // cyan
  Cardio:     "#ca8a04",  // mustard
  Mobility:   "#0ea5e9",  // sky
  Other:      "#9094a8",  // muted
};

export type DailyLogKey =
  | "hrv"
  | "resting_hr"
  | "spo2"
  | "skin_temp_c"
  | "sleep_hours"
  | "sleep_score"
  | "deep_sleep_hours"
  | "rem_sleep_hours"
  | "strain"
  | "steps"
  | "calories"
  | "weight_kg"
  | "body_fat_pct";

export type FieldMeta = {
  k: DailyLogKey;
  l: string;  // label
  u: string;  // unit
  m: number;  // max for bar normalisation
  c: string;  // color (mirrors METRIC_COLOR[k])
};

export const FIELDS: FieldMeta[] = [
  { k: "hrv",              l: "HRV",         u: "ms",   m: 120,   c: METRIC_COLOR.hrv },
  { k: "resting_hr",       l: "Resting HR",  u: "bpm",  m: 90,    c: METRIC_COLOR.resting_hr },
  { k: "spo2",             l: "SpO2",        u: "%",    m: 100,   c: METRIC_COLOR.spo2 },
  { k: "skin_temp_c",      l: "Skin Temp",   u: "C",    m: 38,    c: METRIC_COLOR.skin_temp_c },
  { k: "sleep_hours",      l: "Sleep",       u: "hrs",  m: 10,    c: METRIC_COLOR.sleep_hours },
  { k: "sleep_score",      l: "Sleep Score", u: "/100", m: 100,   c: METRIC_COLOR.sleep_score },
  { k: "deep_sleep_hours", l: "Deep Sleep",  u: "hrs",  m: 4,     c: METRIC_COLOR.deep_sleep_hours },
  { k: "rem_sleep_hours",  l: "REM Sleep",   u: "hrs",  m: 4,     c: METRIC_COLOR.rem_sleep_hours },
  { k: "strain",           l: "Strain",      u: "/21",  m: 21,    c: METRIC_COLOR.strain },
  { k: "steps",            l: "Steps",       u: "",     m: 15000, c: METRIC_COLOR.steps },
  { k: "calories",         l: "Calories",    u: "kcal", m: 4000,  c: METRIC_COLOR.calories },
  { k: "weight_kg",        l: "Weight",      u: "kg",   m: 150,   c: METRIC_COLOR.weight_kg },
  { k: "body_fat_pct",     l: "Body Fat",    u: "%",    m: 40,    c: METRIC_COLOR.body_fat_pct },
];

export function scoreColor(v: number | null | undefined): string {
  if (!v) return COLOR.textMuted;
  if (v >= 80) return COLOR.success;
  if (v >= 60) return COLOR.warning;
  return COLOR.danger;
}

export function scoreLabel(v: number | null | undefined): string {
  if (!v) return "No data";
  if (v >= 80) return "Optimal";
  if (v >= 60) return "Moderate";
  return "Poor";
}

export function priorityColor(level: "high" | "medium" | "low" | string): string {
  if (level === "high")   return COLOR.danger;
  if (level === "medium") return COLOR.warning;
  if (level === "low")    return COLOR.success;
  return COLOR.textMuted;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/ui/colors.ts
git commit -m "refactor(ui/colors): switch to light-theme palette via METRIC_COLOR"
```

## Task 4: Convert `app/globals.css` to light theme + Tailwind v4 `@theme`

**Files:**
- Modify: [app/globals.css](../../../app/globals.css)

Light page bg, dark text, body type from DM Sans. Tailwind v4 inline tokens make the COLOR map available as utility classes (`bg-surface`, `text-strong`, etc.) without a config file.

- [ ] **Step 1: Read the existing file**

Run: `cat "app/globals.css"`
Note the current `@import "tailwindcss"` line and any base styles. Whatever exists should be replaced wholesale — the theme is changing.

- [ ] **Step 2: Replace the file contents**

Write [app/globals.css](../../../app/globals.css):

```css
@import "tailwindcss";

@theme {
  /* Surfaces */
  --color-bg:          #f1f2f6;
  --color-surface:     #ffffff;
  --color-surface-alt: #f5f6fa;

  /* Content */
  --color-strong:      #0f1430;
  --color-mid:         #4a4d62;
  --color-muted:       #7a7e95;
  --color-faint:       #9094a8;

  /* Accent */
  --color-accent:      #4f5dff;
  --color-accent-soft: #e7eaff;
  --color-accent-deep: #3a47e8;

  /* Semantic */
  --color-success:      #14b870;
  --color-success-soft: #d1fae5;
  --color-warning:      #f59e0b;
  --color-warning-soft: #fef3c7;
  --color-danger:       #ef4444;
  --color-danger-soft:  #fee2e2;

  --color-divider:      #e8eaf3;

  /* Radii */
  --radius-chip:       6px;
  --radius-pill:       10px;
  --radius-input:      10px;
  --radius-card-sm:    14px;
  --radius-card-mid:   16px;
  --radius-card:       20px;
  --radius-card-hero:  24px;

  /* Fonts */
  --font-sans: var(--font-dm-sans), system-ui, -apple-system, sans-serif;
  --font-mono: var(--font-dm-mono), ui-monospace, monospace;
}

html {
  background: var(--color-bg);
  color: var(--color-strong);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  background: var(--color-bg);
}

/* Tabular numerics for any element with .tnum or [data-tnum] */
.tnum, [data-tnum] {
  font-feature-settings: "tnum" 1;
  font-variant-numeric: tabular-nums;
}

/* Hide scrollbars on horizontal-scroll utility containers (week strip,
   sub-tab pill rows). Visual cleanliness; scroll still works. */
.scrollbar-none::-webkit-scrollbar { display: none; }
.scrollbar-none { scrollbar-width: none; }
```

- [ ] **Step 3: Update `themeColor` in app/layout.tsx**

Edit [app/layout.tsx](../../../app/layout.tsx) line 41:

```tsx
  themeColor: "#f1f2f6",
```

(was `"#080e1a"`).

- [ ] **Step 4: Update body classes for new safe-area policy**

The existing body in `app/layout.tsx` reserves `+48px` at the bottom for the old top tab nav area. The new bottom nav is `~70px` tall. Edit line 47:

```tsx
      <body className="min-h-[100dvh] bg-bg pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+76px)] md:pb-[env(safe-area-inset-bottom)]">
```

The `md:` variant zeroes the bottom inset on desktop where the bottom nav doesn't render.

- [ ] **Step 5: Verify the dev server boots and the page background is light**

Run: `npm run dev`
Open http://localhost:3000 in a browser. The page should render on a light off-white background (you'll be redirected to `/login` if not signed in — login page is still dark; that's fine for now). Stop the dev server.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/globals.css app/layout.tsx
git commit -m "feat(ui): light-theme base styles via Tailwind v4 @theme"
```

## Task 5: Build `Card` primitive

**Files:**
- Modify: [components/ui/Card.tsx](../../../components/ui/Card.tsx) (rewrite)

A polymorphic Card: `standard` (radius 20, shadow card), `compact` (radius 16, less padding), `nested` (radius 14, lower shadow — for sub-cards inside section containers).

- [ ] **Step 1: Replace the file contents**

Write [components/ui/Card.tsx](../../../components/ui/Card.tsx):

```tsx
import type { ReactNode, HTMLAttributes } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type CardVariant = "standard" | "compact" | "nested";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  /** Override the surface color (e.g. accent-tinted hero cards). */
  background?: string;
  /** Override the shadow (e.g. hero accent shadow). */
  shadow?: string;
  children: ReactNode;
};

const VARIANT_RADIUS: Record<CardVariant, string> = {
  standard: RADIUS.card,
  compact:  RADIUS.cardMid,
  nested:   RADIUS.cardSmall,
};

const VARIANT_PADDING: Record<CardVariant, string> = {
  standard: "16px",
  compact:  "12px 14px",
  nested:   "12px 14px",
};

export function Card({
  variant = "standard",
  background,
  shadow,
  style,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      {...rest}
      style={{
        background: background ?? COLOR.surface,
        borderRadius: VARIANT_RADIUS[variant],
        padding: VARIANT_PADDING[variant],
        boxShadow: shadow ?? SHADOW.card,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

(Existing callers of the old `Card` will continue to work because the component still default-exports nothing structurally incompatible — props are additive. Any caller passing a `className` will still get it via `...rest`.)

- [ ] **Step 3: Commit**

```bash
git add components/ui/Card.tsx
git commit -m "feat(ui): rewrite Card primitive with variant prop"
```

## Task 6: Build `Pill` primitive

**Files:**
- Create: [components/ui/Pill.tsx](../../../components/ui/Pill.tsx)

Generic small pill — used for "Primed", "PR · 140 kg", category chips, status indicators.

- [ ] **Step 1: Create the file**

Write [components/ui/Pill.tsx](../../../components/ui/Pill.tsx):

```tsx
import type { ReactNode } from "react";
import { COLOR } from "@/lib/ui/theme";

type PillTone = "accent" | "success" | "warning" | "danger" | "neutral";

type PillProps = {
  tone?: PillTone;
  children: ReactNode;
  /** Optional left-side glyph or emoji. */
  leading?: ReactNode;
};

const TONE_BG: Record<PillTone, string> = {
  accent:  COLOR.accentSoft,
  success: COLOR.successSoft,
  warning: COLOR.warningSoft,
  danger:  COLOR.dangerSoft,
  neutral: COLOR.surfaceAlt,
};

const TONE_FG: Record<PillTone, string> = {
  accent:  COLOR.accent,
  success: COLOR.success,
  warning: COLOR.warning,
  danger:  COLOR.danger,
  neutral: COLOR.textMid,
};

export function Pill({ tone = "neutral", children, leading }: PillProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 8px",
        borderRadius: "9999px",
        background: TONE_BG[tone],
        color: TONE_FG[tone],
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.02em",
      }}
    >
      {leading ? <span style={{ fontSize: "10px" }}>{leading}</span> : null}
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/ui/Pill.tsx
git commit -m "feat(ui): add Pill primitive (accent/success/warning/danger/neutral)"
```

## Task 7: Build `StatusRow` primitive

**Files:**
- Create: [components/ui/StatusRow.tsx](../../../components/ui/StatusRow.tsx)

Settings row: left label, right value-or-control, optional chevron, optional click handler. Used in `/profile` baselines + ingest tokens + account sections.

- [ ] **Step 1: Create the file**

Write [components/ui/StatusRow.tsx](../../../components/ui/StatusRow.tsx):

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { COLOR } from "@/lib/ui/theme";

type StatusRowProps = {
  label: string;
  value?: ReactNode;
  /** When true, render the label in danger color. Used for "Sign out". */
  danger?: boolean;
  /** When set, the row is a link to this href. */
  href?: string;
  /** When set (and no href), the row is a button. */
  onClick?: () => void;
  /** Show a trailing chevron. Default true when href or onClick is set. */
  chevron?: boolean;
};

export function StatusRow({
  label,
  value,
  danger,
  href,
  onClick,
  chevron,
}: StatusRowProps) {
  const showChevron = chevron ?? Boolean(href || onClick);

  const inner = (
    <>
      <span
        style={{
          fontSize: "13px",
          fontWeight: 500,
          color: danger ? COLOR.danger : COLOR.textStrong,
        }}
      >
        {label}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "12px",
          color: COLOR.textMuted,
          fontWeight: 500,
        }}
      >
        {value}
        {showChevron && <span style={{ fontSize: "16px", color: COLOR.textFaint }}>›</span>}
      </span>
    </>
  );

  const baseStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "13px 16px",
    background: COLOR.surface,
    width: "100%",
    border: "none",
    textAlign: "left" as const,
    cursor: href || onClick ? "pointer" : "default",
  };

  if (href) {
    return (
      <Link href={href} style={baseStyle}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button onClick={onClick} style={baseStyle}>
        {inner}
      </button>
    );
  }
  return <div style={baseStyle}>{inner}</div>;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/ui/StatusRow.tsx
git commit -m "feat(ui): add StatusRow primitive (settings row)"
```

## Task 8: Build `RangePills` primitive

**Files:**
- Create: [components/ui/RangePills.tsx](../../../components/ui/RangePills.tsx)

Generalized 4-up pill row. Drives both /trends ranges and /strength sub-views — the visual is identical, only the label set differs.

- [ ] **Step 1: Create the file**

Write [components/ui/RangePills.tsx](../../../components/ui/RangePills.tsx):

```tsx
"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type RangeOption = {
  /** Stable id used in URLs (`30d`, `today`, etc.). */
  id: string;
  /** Display label (`30D`, `Today`). */
  label: string;
  /** href the pill links to. */
  href: string;
};

type RangePillsProps = {
  options: RangeOption[];
  /** Currently active option id. */
  active: string;
  /** Optional callback when a pill is tapped (e.g. for optimistic updates). */
  onSelect?: (id: string) => void;
};

export function RangePills({ options, active, onSelect }: RangePillsProps) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: "6px",
      }}
    >
      {options.map((opt) => {
        const isActive = opt.id === active;
        const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          onSelect?.(opt.id);
        };
        return (
          <Link
            key={opt.id}
            href={opt.href}
            scroll={false}
            onClick={onClick}
            role="tab"
            aria-selected={isActive}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              fontSize: "12px",
              fontWeight: 600,
              color: isActive ? "#fff" : COLOR.textMuted,
              background: isActive ? COLOR.accent : COLOR.surface,
              borderRadius: RADIUS.pill,
              boxShadow: isActive ? SHADOW.heroAccent : SHADOW.card,
              textDecoration: "none",
              letterSpacing: "0.02em",
              transition: "background 120ms, color 120ms",
            }}
          >
            {opt.label}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/ui/RangePills.tsx
git commit -m "feat(ui): add RangePills primitive for /trends and /strength sub-nav"
```

## Task 9: Build `LineChart` (smooth gradient)

**Files:**
- Modify: [components/charts/LineChart.tsx](../../../components/charts/LineChart.tsx) (rewrite)

Hand-rolled SVG. Two preset variants: `mini` (no axes, no gridlines, ~80px tall) and `detail` (3 dashed reference lines, 4 date labels, ~140px tall, hover tooltip). Gradient area + smooth cubic Bézier path + last-point dot.

- [ ] **Step 1: Read the existing file to understand current callers**

Run: `cat "components/charts/LineChart.tsx"`

The existing API will be replaced; this task is a rewrite. Existing callers will be updated in Slice 4.

- [ ] **Step 2: Replace the file contents**

Write [components/charts/LineChart.tsx](../../../components/charts/LineChart.tsx):

```tsx
"use client";

import { useId, useMemo, useState } from "react";
import { COLOR } from "@/lib/ui/theme";

export type LinePoint = {
  /** X-axis label (date string, e.g. "2026-04-25"). Optional for `mini`. */
  x?: string;
  /** Numeric value. `null` = no data (gap rendered as a thin dot). */
  y: number | null;
};

type LineChartProps = {
  data: LinePoint[];
  color: string;
  /** `mini` for compact metric cards; `detail` for /trends/[metric]. */
  variant?: "mini" | "detail";
  /** Override SVG width. Defaults to fluid (100% via viewBox). */
  width?: number;
  /** SVG height in px. Defaults: mini 80, detail 140. */
  height?: number;
  /** Show 4 date x-axis labels under detail charts. */
  xAxisLabels?: [string, string, string, string];
};

/**
 * Smooth cubic-Bézier line chart with gradient area fill.
 * Smoothing uses horizontal-control approximation (a.k.a. "monotone-x"):
 * for each segment from P0 to P1, control points sit half-way along x at
 * the y of P0 and P1 respectively. Cheap, looks like proper monotone.
 */
export function LineChart({
  data,
  color,
  variant = "mini",
  width = 280,
  height,
  xAxisLabels,
}: LineChartProps) {
  const h = height ?? (variant === "mini" ? 80 : 140);
  const w = width;
  const pad = variant === "mini" ? 6 : 10;
  const gradId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { linePath, areaPath, points, valMin, valMax } = useMemo(() => {
    const present = data.filter((d): d is LinePoint & { y: number } => d.y !== null);
    if (present.length === 0) {
      return { linePath: "", areaPath: "", points: [], valMin: 0, valMax: 1 };
    }
    const ys = present.map((d) => d.y);
    const valMin = Math.min(...ys);
    const valMax = Math.max(...ys);
    const range = valMax - valMin || 1;

    const usableW = w;
    const usableH = h - pad * 2;
    const dx = data.length > 1 ? usableW / (data.length - 1) : 0;

    const points: { x: number; y: number; raw: number | null }[] = data.map((d, i) => {
      const x = i * dx;
      const y =
        d.y === null
          ? h / 2 // skipped during path build
          : pad + (1 - (d.y - valMin) / range) * usableH;
      return { x, y, raw: d.y };
    });

    // Build cubic-Bezier path skipping null gaps.
    let line = "";
    let area = "";
    let started = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.raw === null) {
        started = false;
        continue;
      }
      if (!started) {
        line += `M ${p.x} ${p.y}`;
        area += `M ${p.x} ${p.y}`;
        started = true;
        continue;
      }
      const prev = points[i - 1];
      // horizontal-control bezier
      const cx = (p.x - prev.x) / 2;
      line += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
      area += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
    }
    if (started) {
      const last = [...points].reverse().find((p) => p.raw !== null);
      if (last) {
        const first = points.find((p) => p.raw !== null)!;
        area += ` L ${last.x} ${h} L ${first.x} ${h} Z`;
      }
    }

    return { linePath: line, areaPath: area, points, valMin, valMax };
  }, [data, h, w, pad]);

  const lastPoint = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].raw !== null) return points[i];
    }
    return null;
  }, [points]);

  if (linePath === "") {
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
    if (variant !== "detail") return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * w;
    let nearest = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (points[i].raw === null) continue;
      const d = Math.abs(points[i].x - x);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest >= 0 ? nearest : null);
  };

  const hover = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        width="100%"
        height={h}
        style={{ display: "block", touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={variant === "detail" ? 0.28 : 0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {variant === "detail" && (
          <>
            <line x1="0" y1={h * 0.25} x2={w} y2={h * 0.25} stroke={COLOR.divider} strokeDasharray="2,3" strokeWidth="1" />
            <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke={COLOR.divider} strokeDasharray="2,3" strokeWidth="1" />
            <line x1="0" y1={h * 0.75} x2={w} y2={h * 0.75} stroke={COLOR.divider} strokeDasharray="2,3" strokeWidth="1" />
          </>
        )}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={variant === "detail" ? 2.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {lastPoint && (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={variant === "detail" ? 4 : 3}
            fill="#fff"
            stroke={color}
            strokeWidth={2.5}
          />
        )}

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
            <circle cx={hover.x} cy={hover.y} r={5} fill="#fff" stroke={color} strokeWidth={2.5} />
            <g transform={`translate(${Math.min(Math.max(hover.x - 46, 4), w - 96)}, 4)`}>
              <rect width="92" height="34" rx="8" fill={COLOR.textStrong} />
              <text x="46" y="14" textAnchor="middle" fontSize="9" fill={COLOR.textFaint} fontWeight="600">
                {data[hoverIndex!].x ?? ""}
              </text>
              <text x="46" y="27" textAnchor="middle" fontSize="13" fill="#fff" fontWeight="700">
                {hover.raw}
              </text>
            </g>
          </>
        )}
      </svg>

      {variant === "detail" && xAxisLabels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "6px 2px 2px",
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

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean. (Existing callers will be updated in Slice 4 — they currently fail; that's OK because the slice is in-flight.)

If existing callers cause typecheck failures, the build would break. To unblock, **temporarily** add `// @ts-expect-error redesign-slice-4` above each broken caller; they'll be fixed properly in Slice 4. Use this only when typecheck blocks; if your typecheck is clean, do nothing.

- [ ] **Step 4: Commit**

```bash
git add components/charts/LineChart.tsx
git commit -m "feat(charts): rewrite LineChart with smooth bezier + gradient area"
```

## Task 10: Build `MetricCard`

**Files:**
- Modify: [components/charts/MetricCard.tsx](../../../components/charts/MetricCard.tsx) (rewrite)

Used in dashboard 2×2 grid, /trends compact stack, /log already-logged-today chips. Composes `Card` + `LineChart` mini.

- [ ] **Step 1: Replace the file contents**

Write [components/charts/MetricCard.tsx](../../../components/charts/MetricCard.tsx):

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type MetricCardProps = {
  /** Per-metric color from METRIC_COLOR. Tints the icon chip and chart line. */
  color: string;
  /** Glyph or emoji rendered inside the icon chip. */
  icon: ReactNode;
  label: string;
  value: number | string | null;
  unit?: string;
  /** Numeric delta vs prior; sign drives color. */
  delta?: number | null;
  deltaUnit?: string;
  /** Reverse semantic — for resting HR, lower is better. Affects delta color. */
  inverted?: boolean;
  /** Compact card variant (16px radius, tighter). */
  compact?: boolean;
  /** Optional sparkline. Renders a `mini` LineChart below value. */
  trend?: LinePoint[];
  /** Optional href — wraps in a Link with chevron affordance. */
  href?: string;
};

export function MetricCard({
  color,
  icon,
  label,
  value,
  unit,
  delta,
  deltaUnit,
  inverted,
  compact,
  trend,
  href,
}: MetricCardProps) {
  const goodWhenPositive = !inverted;
  const deltaColor =
    delta == null
      ? COLOR.textFaint
      : delta === 0
      ? COLOR.textFaint
      : (delta > 0) === goodWhenPositive
      ? COLOR.success
      : COLOR.danger;

  const valueDisplay =
    value == null
      ? "—"
      : typeof value === "number"
      ? fmtNum(value)
      : value;

  const inner = (
    <Card variant={compact ? "compact" : "standard"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            style={{
              width: compact ? "24px" : "28px",
              height: compact ? "24px" : "28px",
              borderRadius: compact ? "7px" : "8px",
              background: hexToBgChip(color),
              color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: compact ? "12px" : "14px",
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
          <span
            style={{
              fontSize: compact ? "12px" : "11px",
              fontWeight: 600,
              color: COLOR.textMid,
              letterSpacing: "0.02em",
            }}
          >
            {label}
          </span>
        </div>
        {delta != null && (
          <span
            data-tnum
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: deltaColor,
            }}
          >
            {delta > 0 ? "+" : ""}
            {fmtNum(delta)}
            {deltaUnit ? ` ${deltaUnit}` : ""}
          </span>
        )}
      </div>

      <div
        data-tnum
        style={{
          fontSize: compact ? "20px" : "24px",
          fontWeight: 800,
          letterSpacing: "-0.02em",
          marginTop: "4px",
          color: COLOR.textStrong,
        }}
      >
        {valueDisplay}
        {unit ? (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 500,
              color: COLOR.textFaint,
              marginLeft: "4px",
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>

      {trend && trend.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          <LineChart data={trend} color={color} variant="mini" />
        </div>
      )}
    </Card>
  );

  if (href) {
    return (
      <Link href={href} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
        {inner}
      </Link>
    );
  }
  return inner;
}

/**
 * Lighten a #rrggbb to a soft chip background. Linearly mixes 18% color into
 * white. Ad-hoc but keeps the chip in the same hue family as the icon.
 */
function hexToBgChip(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#f5f6fa";
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const blend = 0.82; // 82% white, 18% color
  const mix = (v: number) => Math.round(v * (1 - blend) + 255 * blend);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean. Same caveat as Task 9 — if existing callers break, mark with `// @ts-expect-error redesign-slice-3-or-4`.

- [ ] **Step 3: Commit**

```bash
git add components/charts/MetricCard.tsx
git commit -m "feat(charts): rewrite MetricCard with icon chip + delta + optional sparkline"
```

## Task 11: Smoke-test primitives via a `/dev/tokens` ghost page

**Files:**
- Create: `app/dev/tokens/page.tsx` (will be deleted before Slice 1 ships)

A throwaway page that renders every primitive in isolation so you can confirm the visual language matches the spec before composing pages.

- [ ] **Step 1: Create the file**

Write `app/dev/tokens/page.tsx`:

```tsx
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { StatusRow } from "@/components/ui/StatusRow";
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard } from "@/components/charts/MetricCard";
import { LineChart } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

export default function TokensPage() {
  const sample = [55, 58, 62, 51, 49, 53, 60, 65, 68, 62, 70, 67].map((y, i) => ({
    x: `D${i + 1}`,
    y,
  }));

  return (
    <main style={{ padding: "24px", maxWidth: "640px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "28px", fontWeight: 800, marginBottom: "16px" }}>Token preview</h1>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>Cards</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <Card>Standard card</Card>
        <Card variant="compact">Compact card</Card>
        <Card variant="nested">Nested card</Card>
      </div>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>Pills</h2>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Pill tone="accent">Accent</Pill>
        <Pill tone="success" leading="▲">Primed</Pill>
        <Pill tone="warning">Moderate</Pill>
        <Pill tone="danger">Recover</Pill>
        <Pill tone="neutral">Neutral</Pill>
      </div>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>StatusRow</h2>
      <Card variant="compact" style={{ padding: 0 }}>
        <StatusRow label="HRV baseline" value="58 ms" href="#" />
        <StatusRow label="Target weight" value="80 kg" href="#" />
        <StatusRow label="Sign out" danger href="#" />
      </Card>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>RangePills</h2>
      <RangePills
        active="30d"
        options={[
          { id: "7d",  label: "7D",  href: "#7d" },
          { id: "30d", label: "30D", href: "#30d" },
          { id: "90d", label: "90D", href: "#90d" },
          { id: "1y",  label: "1Y",  href: "#1y" },
        ]}
      />

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>MetricCard</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <MetricCard color={METRIC_COLOR.hrv}        icon="♥"  label="HRV"        value={68}  unit="ms"  delta={12}   deltaUnit="ms" />
        <MetricCard color={METRIC_COLOR.resting_hr} icon="♥"  label="Resting HR" value={52}  unit="bpm" delta={-3}   deltaUnit="bpm" inverted />
        <MetricCard color={METRIC_COLOR.sleep_hours} icon="☾" label="Sleep"     value={7.8} unit="h"   delta={0.4}  deltaUnit="h" compact trend={sample} />
        <MetricCard color={METRIC_COLOR.strain}     icon="⚡" label="Strain"    value={14.2}            delta={2.1} compact />
      </div>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>LineChart detail</h2>
      <Card>
        <LineChart
          data={sample}
          color={METRIC_COLOR.hrv}
          variant="detail"
          xAxisLabels={["Apr 5", "Apr 15", "Apr 25", "May 5"]}
        />
      </Card>
    </main>
  );
}
```

- [ ] **Step 2: Boot dev and visit `/dev/tokens`**

Run: `npm run dev`
Open http://localhost:3000/dev/tokens (no auth gating because the page does no auth check).

Visually verify:
- All three card variants render with progressively smaller radii
- Five pill tones look distinct
- StatusRow rows render with chevrons; "Sign out" is red
- RangePills shows `30D` as active solid blue
- Four metric cards render; the sleep card has a sparkline
- The detail line chart shows gradient + smooth line + 3 dashed gridlines + 4 date labels

Stop the dev server when satisfied.

- [ ] **Step 3: Commit (the page stays for now — deleted at end of Slice 5)**

```bash
git add app/dev
git commit -m "chore(dev): add /dev/tokens ghost page for primitive preview"
```

---

# Slice 2 — Navigation chrome

Build the new nav shell. After this slice, every existing page will render with a new bottom nav and FAB on mobile, and a top nav on desktop. Per-page restyles come in Slices 3–5.

## Task 12: Build `WeekStrip`

**Files:**
- Create: [components/layout/WeekStrip.tsx](../../../components/layout/WeekStrip.tsx)

7-day picker. Today's slot highlighted with `accentSoft`. Tapping a day navigates to `?date=YYYY-MM-DD` on the current path.

- [ ] **Step 1: Create the file**

Write [components/layout/WeekStrip.tsx](../../../components/layout/WeekStrip.tsx):

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type WeekStripProps = {
  /** ISO date "YYYY-MM-DD" — the day currently selected. */
  selected: string;
  /** ISO date "YYYY-MM-DD" — today in the user's tz (drives the highlight). */
  today: string;
};

const DAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export function WeekStrip({ selected, today }: WeekStripProps) {
  const pathname = usePathname();
  // Anchor week on Monday = ISO weekday. Slot 0 = Monday of the week that
  // contains `selected`. Compute purely from string parsing — no Date math
  // for the date itself; we only use Date for the weekday lookup.
  const [y, m, d] = selected.split("-").map(Number);
  const sel = new Date(Date.UTC(y, m - 1, d));
  const isoDow = (sel.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun

  const days = Array.from({ length: 7 }, (_, i) => {
    const offset = i - isoDow;
    const dt = new Date(Date.UTC(y, m - 1, d + offset));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    const iso = `${yy}-${mm}-${dd}`;
    return {
      iso,
      day: dt.getUTCDate(),
      label: DAY_LABELS[(dt.getUTCDay() + 0) % 7],
      isToday: iso === today,
      isSelected: iso === selected,
    };
  });

  return (
    <div style={{ display: "flex", gap: "6px", padding: "0 8px 14px" }}>
      {days.map((d) => {
        const isAccent = d.isSelected || (!days.some((x) => x.isSelected) && d.isToday);
        const href = `${pathname}?date=${d.iso}`;
        return (
          <Link
            key={d.iso}
            href={href}
            scroll={false}
            style={{
              flex: 1,
              textAlign: "center",
              background: isAccent ? COLOR.accentSoft : COLOR.surface,
              borderRadius: RADIUS.cardSmall,
              padding: "10px 0 12px",
              boxShadow: SHADOW.card,
              textDecoration: "none",
            }}
          >
            <div
              style={{
                fontSize: "10px",
                fontWeight: 600,
                color: isAccent ? COLOR.accent : COLOR.textFaint,
                letterSpacing: "0.08em",
              }}
            >
              {d.label}
            </div>
            <div
              data-tnum
              style={{
                fontSize: "18px",
                fontWeight: 700,
                color: isAccent ? COLOR.accent : COLOR.textStrong,
                marginTop: "4px",
              }}
            >
              {d.day}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/layout/WeekStrip.tsx
git commit -m "feat(layout): add WeekStrip 7-day picker"
```

## Task 13: Build `BottomNav` + `Fab` + `FabSheet`

**Files:**
- Create: [components/layout/BottomNav.tsx](../../../components/layout/BottomNav.tsx)
- Create: [components/layout/Fab.tsx](../../../components/layout/Fab.tsx)

Two files because `Fab` includes both the floating button and the action sheet, while `BottomNav` is the bar itself with a notch for the FAB.

- [ ] **Step 1: Create `BottomNav.tsx`**

Write [components/layout/BottomNav.tsx](../../../components/layout/BottomNav.tsx):

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type Tab = { href: string; label: string; icon: string; match: (p: string) => boolean };

const TABS: Tab[] = [
  { href: "/",        label: "Today",   icon: "⌂",  match: (p) => p === "/" },
  { href: "/trends",  label: "Trends",  icon: "📈", match: (p) => p.startsWith("/trends") },
  // Slot left empty for the FAB (rendered separately by <Fab />)
  { href: "/coach",   label: "Coach",   icon: "💬", match: (p) => p.startsWith("/coach") },
  { href: "/profile", label: "Profile", icon: "👤", match: (p) => p.startsWith("/profile") },
];

/**
 * Mobile-only bottom nav. Hides at md and above (desktop uses TopNav).
 * Reserves a center gap for the floating <Fab />.
 */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className="md:hidden"
      style={{
        position: "fixed",
        left: "8px",
        right: "8px",
        bottom: "calc(env(safe-area-inset-bottom) + 8px)",
        background: COLOR.surface,
        borderRadius: "22px",
        padding: "8px 0",
        display: "flex",
        justifyContent: "space-around",
        alignItems: "flex-start",
        boxShadow: SHADOW.bottomNav,
        zIndex: 40,
      }}
    >
      {TABS.slice(0, 2).map((t) => (
        <TabButton key={t.href} tab={t} active={t.match(pathname)} />
      ))}
      {/* Spacer for the FAB */}
      <div style={{ width: "56px", flexShrink: 0 }} aria-hidden="true" />
      {TABS.slice(2).map((t) => (
        <TabButton key={t.href} tab={t} active={t.match(pathname)} />
      ))}
    </nav>
  );
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  return (
    <Link
      href={tab.href}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        flex: 1,
        padding: "4px 0",
        textDecoration: "none",
      }}
    >
      <span
        style={{
          width: "32px",
          height: "32px",
          borderRadius: RADIUS.cardSmall,
          background: active ? COLOR.accentSoft : "transparent",
          color: active ? COLOR.accent : COLOR.textMuted,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
        }}
      >
        {tab.icon}
      </span>
      <span style={{ fontSize: "9px", fontWeight: 600, color: active ? COLOR.accent : COLOR.textMuted }}>
        {tab.label}
      </span>
    </Link>
  );
}
```

- [ ] **Step 2: Create `Fab.tsx`**

Write [components/layout/Fab.tsx](../../../components/layout/Fab.tsx):

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type SheetItem =
  | { kind: "link";   label: string; icon: string; href: string }
  | { kind: "upload"; label: string; icon: string; accept: string; endpoint: string };

const ITEMS: SheetItem[] = [
  { kind: "link",   label: "Log entry",          icon: "✎", href: "/log" },
  { kind: "link",   label: "Strength",           icon: "💪", href: "/strength?view=today" },
  { kind: "upload", label: "Upload Strong CSV",  icon: "⬆", accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link",   label: "Manage connections", icon: "🔗", href: "/profile" },
];

/**
 * Floating + button (mobile only) + bottom sheet with quick actions.
 * Rendered in app/layout.tsx so it persists across routes.
 */
export function Fab() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Quick actions"
        onClick={() => setOpen(true)}
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
      {open && <FabSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function FabSheet({ onClose }: { onClose: () => void }) {
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

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/layout/BottomNav.tsx components/layout/Fab.tsx
git commit -m "feat(layout): add BottomNav + Fab with bottom-sheet quick actions"
```

## Task 14: Build `TopNav` (desktop)

**Files:**
- Create: [components/layout/TopNav.tsx](../../../components/layout/TopNav.tsx)

Desktop-only horizontal tab strip with a `+ New` button on the right that opens the same `FabSheet` as a popover anchored to the button.

- [ ] **Step 1: Create the file**

Write [components/layout/TopNav.tsx](../../../components/layout/TopNav.tsx):

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

const TABS = [
  { href: "/",        label: "Today" },
  { href: "/trends",  label: "Trends" },
  { href: "/strength", label: "Strength" },
  { href: "/coach",   label: "Coach" },
  { href: "/profile", label: "Profile" },
];

const SHEET = [
  { kind: "link" as const, label: "Log entry", href: "/log" },
  { kind: "link" as const, label: "Strength",  href: "/strength?view=today" },
  { kind: "upload" as const, label: "Upload Strong CSV", accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link" as const, label: "Manage connections", href: "/profile" },
];

/**
 * Desktop-only top nav. Hidden below md.
 */
export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  async function onUpload(file: File, endpoint: string) {
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
      setMenuOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <header
      className="hidden md:flex"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        background: COLOR.surface,
        boxShadow: SHADOW.card,
        padding: "10px 24px",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <span style={{ fontSize: "15px", fontWeight: 700, color: COLOR.textStrong, marginRight: "16px" }}>
        Apex Health
      </span>
      <nav style={{ display: "flex", gap: "4px", flex: 1 }}>
        {TABS.map((t) => {
          const active = isActive(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              style={{
                padding: "6px 12px",
                borderRadius: RADIUS.pill,
                background: active ? COLOR.accentSoft : "transparent",
                color: active ? COLOR.accent : COLOR.textMid,
                fontSize: "13px",
                fontWeight: active ? 700 : 500,
                textDecoration: "none",
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: RADIUS.pill,
            fontSize: "13px",
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: SHADOW.heroAccent,
          }}
        >
          + New
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 8px)",
              background: COLOR.surface,
              boxShadow: SHADOW.floating,
              borderRadius: RADIUS.cardMid,
              padding: "6px",
              minWidth: "220px",
              zIndex: 60,
            }}
          >
            {SHEET.map((item) => {
              const baseStyle = {
                display: "block",
                padding: "8px 12px",
                fontSize: "13px",
                fontWeight: 500,
                color: COLOR.textStrong,
                textDecoration: "none",
                borderRadius: RADIUS.chip,
                cursor: "pointer",
                opacity: busy ? 0.5 : 1,
              };
              if (item.kind === "link") {
                return (
                  <Link key={item.label} href={item.href} onClick={() => setMenuOpen(false)} style={baseStyle}>
                    {item.label}
                  </Link>
                );
              }
              return (
                <label key={item.label} style={baseStyle}>
                  {item.label}
                  <input
                    type="file"
                    accept={item.accept}
                    disabled={busy}
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onUpload(f, item.endpoint);
                    }}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/layout/TopNav.tsx
git commit -m "feat(layout): add TopNav for desktop with + New popover"
```

## Task 15: Wire `TopNav` + `BottomNav` + `Fab` into root layout; delete old `TabNav`

**Files:**
- Modify: [app/layout.tsx](../../../app/layout.tsx)
- Modify: [components/layout/Header.tsx](../../../components/layout/Header.tsx)
- Delete: [components/layout/TabNav.tsx](../../../components/layout/TabNav.tsx)

The `Header` component currently embeds `TabNav` (line 60). After this slice the bottom/top navs are persistent in the root layout, so `Header.tsx` keeps the date/score chrome but drops the tab strip.

- [ ] **Step 1: Read the current Header**

Run: `cat "components/layout/Header.tsx"`

- [ ] **Step 2: Edit `Header.tsx` to drop the TabNav import and render**

Remove line 2 (`import { TabNav } from "./TabNav";`) and the `<TabNav />` render around line 60. Leave the rest of the Header intact for now — its visual restyling happens in Slice 3 once we know what each page wants on top.

- [ ] **Step 3: Mount the new navs in `app/layout.tsx`**

Edit [app/layout.tsx](../../../app/layout.tsx). Add imports near the top:

```tsx
import { BottomNav } from "@/components/layout/BottomNav";
import { Fab } from "@/components/layout/Fab";
import { TopNav } from "@/components/layout/TopNav";
```

Replace the body return (currently just `{children}`) with:

```tsx
      <body className="min-h-[100dvh] bg-bg pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+76px)] md:pb-[env(safe-area-inset-bottom)]">
        <TopNav />
        <main>{children}</main>
        <BottomNav />
        <Fab />
      </body>
```

- [ ] **Step 4: Delete `TabNav.tsx`**

```bash
rm components/layout/TabNav.tsx
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Smoke-test the navigation**

Run: `npm run dev`. Open http://localhost:3000 in:
- A mobile-shaped viewport (Chrome DevTools → toggle device, e.g. iPhone 14): bottom nav visible at the bottom with 4 tabs + center FAB. Top nav hidden.
- A desktop viewport (≥768px): top nav visible. Bottom nav and FAB hidden.
- Tap each tab and verify routing.
- Tap the FAB → bottom sheet opens with 4 actions. Tap backdrop → closes.

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add app/layout.tsx components/layout/Header.tsx
git rm components/layout/TabNav.tsx
git commit -m "feat(layout): mount BottomNav + Fab + TopNav; remove old TabNav"
```

---

# Slice 3 — Dashboard `/`, `/log`, `/profile`

These three pages get their full new layouts. After this slice the home, log, and profile experiences match the spec.

## Task 16: Build `ReadinessHero`

**Files:**
- Create: [components/dashboard/ReadinessHero.tsx](../../../components/dashboard/ReadinessHero.tsx)

Solid blue card with the readiness number as the visual anchor. Replaces the donut as the hero.

- [ ] **Step 1: Create the file**

Write [components/dashboard/ReadinessHero.tsx](../../../components/dashboard/ReadinessHero.tsx):

```tsx
import { Card } from "@/components/ui/Card";
import { COLOR, SHADOW, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type ReadinessHeroProps = {
  /** 0–100, or null when no data. */
  score: number | null;
  /** Status label e.g. "Primed", "Ready", "Take it easy". */
  status: string;
  /** One-line plain-English subtitle. */
  subtitle: string;
};

export function ReadinessHero({ score, status, subtitle }: ReadinessHeroProps) {
  return (
    <Card
      background={COLOR.accent}
      shadow={SHADOW.heroAccent}
      style={{
        color: "#fff",
        borderRadius: RADIUS.cardHero,
        padding: "18px 20px 20px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: "12px", fontWeight: 600, opacity: 0.85, letterSpacing: "0.02em" }}>
          Readiness
        </span>
        <span
          style={{
            fontSize: "10px",
            fontWeight: 700,
            padding: "4px 8px",
            background: "rgba(255,255,255,0.18)",
            borderRadius: "9999px",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {status}
        </span>
      </div>
      <div
        data-tnum
        style={{
          fontSize: "56px",
          fontWeight: 800,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          marginTop: "6px",
        }}
      >
        {score == null ? "—" : fmtNum(score)}
        {score != null && (
          <span style={{ fontSize: "20px", fontWeight: 600, opacity: 0.7, marginLeft: "4px" }}>/100</span>
        )}
      </div>
      <p style={{ fontSize: "12px", opacity: 0.85, marginTop: "8px", lineHeight: 1.4 }}>{subtitle}</p>
    </Card>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/ReadinessHero.tsx
git commit -m "feat(dashboard): add ReadinessHero — blue card with big readiness number"
```

## Task 17: Build `CoachEntryCard` and `RecentLiftsCard`

**Files:**
- Create: [components/dashboard/CoachEntryCard.tsx](../../../components/dashboard/CoachEntryCard.tsx)
- Create: [components/dashboard/RecentLiftsCard.tsx](../../../components/dashboard/RecentLiftsCard.tsx)

Two on-dashboard entry points to longer-lived destinations.

- [ ] **Step 1: Create `CoachEntryCard.tsx`**

Write [components/dashboard/CoachEntryCard.tsx](../../../components/dashboard/CoachEntryCard.tsx):

```tsx
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

type CoachEntryCardProps = {
  /** Today's plan headline (e.g. "Lift heavy — squat day, RPE ≤ 8"). */
  headline: string;
  /** Background color of the thumbnail (mode color or accent). */
  thumbnailColor: string;
  /** Glyph rendered in the thumbnail. */
  thumbnailGlyph: string;
  /** Read-time label or context (e.g. "Coach · 2 min read"). */
  meta: string;
};

export function CoachEntryCard({ headline, thumbnailColor, thumbnailGlyph, meta }: CoachEntryCardProps) {
  return (
    <Link href="/coach" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "14px",
              background: `linear-gradient(135deg, ${thumbnailColor} 0%, ${darken(thumbnailColor)} 100%)`,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: "22px",
            }}
          >
            {thumbnailGlyph}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "11px", color: COLOR.textMuted, fontWeight: 600 }}>Today's plan</div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: COLOR.textStrong,
                marginTop: "2px",
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {headline}
            </div>
            <div style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "4px" }}>{meta}</div>
          </div>
          <span style={{ color: COLOR.textFaint, fontSize: "20px" }}>›</span>
        </div>
      </Card>
    </Link>
  );
}

/** Crude darken — drops each channel by 30. Sufficient for a 2-stop gradient. */
function darken(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = (h: string) => Math.max(0, parseInt(h, 16) - 30).toString(16).padStart(2, "0");
  return `#${c(m[1])}${c(m[2])}${c(m[3])}`;
}
```

- [ ] **Step 2: Create `RecentLiftsCard.tsx`**

Write [components/dashboard/RecentLiftsCard.tsx](../../../components/dashboard/RecentLiftsCard.tsx):

```tsx
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type RecentSession = {
  date: string;       // e.g. "MON 4"
  title: string;      // e.g. "Lower body · Squat"
  volumeKg: number;
};

type RecentLiftsCardProps = {
  sessions: RecentSession[]; // pass at most 2; renders nothing if empty
};

export function RecentLiftsCard({ sessions }: RecentLiftsCardProps) {
  return (
    <Link href="/strength?view=recent" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Recent lifts
          </span>
          <span style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600 }}>View all ›</span>
        </div>
        {sessions.length === 0 ? (
          <p style={{ fontSize: "13px", color: COLOR.textFaint, padding: "8px 0" }}>
            No recent sessions in the last 14 days.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {sessions.slice(0, 2).map((s) => (
              <div
                key={s.date}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}` }}
              >
                <div>
                  <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.06em" }}>{s.date}</div>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: COLOR.textStrong, marginTop: "2px" }}>{s.title}</div>
                </div>
                <div data-tnum style={{ fontSize: "12px", color: COLOR.accent, fontWeight: 600 }}>
                  {fmtNum(s.volumeKg)} kg
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Link>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/CoachEntryCard.tsx components/dashboard/RecentLiftsCard.tsx
git commit -m "feat(dashboard): add CoachEntryCard + RecentLiftsCard primitives"
```

## Task 18: Restyle `ImpactDonut` and `WeeklyRollups` for light theme

**Files:**
- Modify: [components/dashboard/ImpactDonut.tsx](../../../components/dashboard/ImpactDonut.tsx)
- Modify: [components/dashboard/WeeklyRollups.tsx](../../../components/dashboard/WeeklyRollups.tsx)

Logic untouched — only colors and surrounds.

- [ ] **Step 1: Read current `ImpactDonut.tsx`**

Run: `cat "components/dashboard/ImpactDonut.tsx"`

Identify every dark-theme color (white/40, rgba(255,255,255,...), `#0a84ff`, etc.) and the surrounding container styles.

- [ ] **Step 2: Replace the surrounding container with `<Card>` and swap colors**

Concretely:

- Replace any outer `<div className="rounded-... bg-...">`-style wrapper with `<Card>` from `@/components/ui/Card`.
- Replace `text-white/40` → inline `style={{ color: COLOR.textMuted }}` (or use Tailwind class `text-muted`).
- Replace `text-white` (primary text) → `COLOR.textStrong`.
- Replace `bg-white/5` (sub-surface) → `COLOR.surfaceAlt`.
- Replace `rgba(255,255,255,0.07-0.10)` borders → `COLOR.divider`.
- Replace any Apple-dark accent (`#0a84ff`) → `COLOR.accent`.
- For the donut SVG itself, use `METRIC_COLOR` and `COLOR.divider` for the track ring instead of dark backdrop.

Import at top: `import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";` and `import { Card } from "@/components/ui/Card";`.

- [ ] **Step 3: Same treatment for `WeeklyRollups.tsx`**

Run: `cat "components/dashboard/WeeklyRollups.tsx"` first, then apply the same color-swap rules. Replace any inline `<svg>` sparkline with the new `LineChart` component (`variant="mini"`, `color={METRIC_COLOR.<key>}`).

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Smoke-test on `/`**

Run: `npm run dev`. Open `/` (sign in if prompted). The donut should render on a white card with light-theme colors. The weekly rollups section should show the new line charts. Visual check only — no functional change.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/ImpactDonut.tsx components/dashboard/WeeklyRollups.tsx
git commit -m "refactor(dashboard): restyle ImpactDonut + WeeklyRollups in light theme"
```

## Task 19: Apply new layout to `app/page.tsx` (dashboard)

**Files:**
- Modify: [app/page.tsx](../../../app/page.tsx)
- Delete: [components/dashboard/DashboardDatePager.tsx](../../../components/dashboard/DashboardDatePager.tsx)

Replace `DashboardDatePager` with `WeekStrip`. Replace the donut-as-hero with `ReadinessHero` + `ImpactDonut` below. Add `MetricCard` 2×2 grid. Add `CoachEntryCard` and `RecentLiftsCard`. Keep `WeeklyRollups`.

- [ ] **Step 1: Read the current dashboard**

Run: `cat "app/page.tsx"`. Note current data fetches and the existing layout structure — you'll keep all the data fetches and only change rendering.

- [ ] **Step 2: Update imports and layout**

Edit [app/page.tsx](../../../app/page.tsx). Remove the `DashboardDatePager` import; remove the `Header` if currently rendered (no — keep Header for now, just the page-title section). Add new imports:

```tsx
import { WeekStrip } from "@/components/layout/WeekStrip";
import { ReadinessHero } from "@/components/dashboard/ReadinessHero";
import { CoachEntryCard } from "@/components/dashboard/CoachEntryCard";
import { RecentLiftsCard, type RecentSession } from "@/components/dashboard/RecentLiftsCard";
import { MetricCard } from "@/components/charts/MetricCard";
import { COLOR, METRIC_COLOR, modeColorLight } from "@/lib/ui/theme";
import { todayInUserTz, formatHeaderDate } from "@/lib/time";
```

- [ ] **Step 3: Compute `today` and selected `date` and the recent-lifts preview**

In the page body (after auth and after data fetches), where you currently set `today`:

```tsx
const today = todayInUserTz();
const selectedDate = /* existing logic that resolves ?date or today */;
```

For the recent-lifts preview, add a Supabase query alongside the existing `Promise.all`:

```tsx
// inside the existing Promise.all destructuring:
const [/* existing rows */, { data: recentWorkouts }] = await Promise.all([
  // ... existing queries ...
  supabase
    .from("workouts")
    .select("date, name, total_volume_kg")
    .eq("user_id", user.id)
    .gte("date", /* iso date 14 days ago — compute via Date math from selectedDate */)
    .order("date", { ascending: false })
    .limit(2),
]);
```

If your repo uses a different table or column names for workouts, substitute. Read `lib/data/types.ts` first if uncertain. The shape passed to `<RecentLiftsCard>` is `RecentSession[]` — map the rows accordingly:

```tsx
const recentSessions: RecentSession[] = (recentWorkouts ?? []).map((w) => ({
  date: formatShortDate(w.date),  // "MON 4" — define a small helper inline below
  title: w.name,
  volumeKg: w.total_volume_kg ?? 0,
}));
```

`formatShortDate(iso)`: small helper inside the file:

```tsx
function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = ["SUN","MON","TUE","WED","THU","FRI","SAT"][dt.getUTCDay()];
  return `${day} ${dt.getUTCDate()}`;
}
```

- [ ] **Step 4: Replace the page render with the new layout**

Replace the existing JSX inside the page's `return (...)` with:

```tsx
return (
  <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
    {/* Page header */}
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
        {(profile?.name ?? user.email ?? "A")[0].toUpperCase()}
      </div>
    </div>

    <WeekStrip selected={selectedDate} today={today} />

    <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
      <ReadinessHero
        score={readiness?.score ?? null}
        status={mode.label.replace(/^[^\s]+\s/, "")}
        subtitle={mode.desc}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <MetricCard color={METRIC_COLOR.hrv}        icon="♥" label="HRV"        value={log?.hrv ?? null}        unit="ms"  delta={hrvDelta}  deltaUnit="ms" />
        <MetricCard color={METRIC_COLOR.resting_hr} icon="♥" label="Resting HR" value={log?.resting_hr ?? null} unit="bpm" delta={rhrDelta}  deltaUnit="bpm" inverted />
        <MetricCard color={METRIC_COLOR.sleep_hours} icon="☾" label="Sleep"     value={log?.sleep_hours ?? null} unit="h"   delta={sleepDelta} deltaUnit="h" />
        <MetricCard color={METRIC_COLOR.strain}     icon="⚡" label="Strain"    value={log?.strain ?? null}                  delta={strainDelta} />
      </div>

      {/* Optional body-comp row */}
      {(log?.weight_kg != null || log?.body_fat_pct != null) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <MetricCard color={METRIC_COLOR.weight_kg}    icon="⚖" label="Weight"   value={log?.weight_kg ?? null}    unit="kg" />
          <MetricCard color={METRIC_COLOR.body_fat_pct} icon="%" label="Body Fat" value={log?.body_fat_pct ?? null} unit="%" />
        </div>
      )}

      {/* Impact donut as the explanation card */}
      <ImpactDonut /* existing props */ />

      <CoachEntryCard
        headline={mode.desc}
        thumbnailColor={modeColorLight(mode.color)}
        thumbnailGlyph={"▲"}
        meta="Coach · 2 min read"
      />

      <RecentLiftsCard sessions={recentSessions} />

      {/* Existing weekly rollups */}
      <Suspense fallback={null}>
        <WeeklyRollups /* existing props */ />
      </Suspense>
    </div>
  </div>
);
```

The deltas (`hrvDelta`, etc.) are computed alongside the existing `log` fetch. If your codebase already computes these for `MetricBar`, reuse the same values. If not, compute as `currentValue - rolling7dAvg`; place the helper near the data fetch.

- [ ] **Step 5: Delete `DashboardDatePager.tsx`**

```bash
rm components/dashboard/DashboardDatePager.tsx
```

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: clean. (If callers of `DashboardDatePager` exist outside this page, the typecheck will tell you — there shouldn't be any since it's purely a `app/page.tsx` widget.)

- [ ] **Step 7: Smoke-test the dashboard**

Run: `npm run dev`. Open `/`. Verify:
- Page header with "Today" + date subtitle + avatar circle
- Week strip with today highlighted; tapping a past day routes to `?date=`
- Readiness hero (blue card) with score
- 2×2 metric grid; deltas color-coded
- Impact donut card below
- Coach entry card with mode color
- Recent lifts card (or "No recent sessions" if none in last 14d)
- Weekly rollups at the bottom

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx
git rm components/dashboard/DashboardDatePager.tsx
git commit -m "feat(dashboard): apply soft-light layout — WeekStrip, hero, metric grid"
```

## Task 20: Restyle `LogForm` and apply new `/log` layout

**Files:**
- Modify: [components/log/LogForm.tsx](../../../components/log/LogForm.tsx)
- Modify: [app/log/page.tsx](../../../app/log/page.tsx)

The `/log` page already uses `LogForm` for both the morning check-in and the manual numeric grid. Restyle in soft-light. Add the WeekStrip and the already-logged-today summary.

- [ ] **Step 1: Read both files**

```bash
cat components/log/LogForm.tsx
cat app/log/page.tsx
```

Identify the form sections: Recovery / Sleep / Training / Nutrition (numeric inputs) and the morning check-in (readiness 1–10, energy/mood/soreness/notes).

- [ ] **Step 2: Restyle `LogForm.tsx` — color swap and primitive composition**

Apply the same color-swap rules as Task 18 (text-white → textStrong, bg-white/5 → surfaceAlt, border whites → divider, accent #0a84ff → COLOR.accent). Wrap each section (Recovery / Sleep / Training / Nutrition / Morning check-in) in a `<Card>`. The numeric input grids retain their structure. The 1–10 readiness button row becomes a 10-up grid of square buttons:

```tsx
<div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "4px" }}>
  {READINESS_NUMS.map((n) => (
    <button
      key={n}
      type="button"
      onClick={() => setFeel((f) => ({ ...f, readiness: n }))}
      style={{
        aspectRatio: "1",
        background: feel.readiness === n ? COLOR.accent : COLOR.surfaceAlt,
        color: feel.readiness === n ? "#fff" : COLOR.textMuted,
        borderRadius: "7px",
        border: "none",
        fontSize: "11px",
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {n}
    </button>
  ))}
</div>
```

The Energy and Mood pickers become 1-row pill grids (similar pattern). The save button:

```tsx
<button
  type="submit"
  disabled={pending}
  style={{
    width: "100%",
    marginTop: "12px",
    padding: "11px",
    background: COLOR.accent,
    color: "#fff",
    border: "none",
    borderRadius: "12px",
    fontSize: "13px",
    fontWeight: 700,
    boxShadow: SHADOW.heroAccent,
    opacity: pending ? 0.5 : 1,
    cursor: pending ? "default" : "pointer",
  }}
>
  {pending ? "Saving…" : "Save check-in"}
</button>
```

Inputs use `border-radius: 10px`, `background: COLOR.surfaceAlt`, `border: none`, `padding: 10px 12px`.

- [ ] **Step 3: Update `app/log/page.tsx` to add page header + WeekStrip + already-logged chips**

Edit [app/log/page.tsx](../../../app/log/page.tsx). Replace the page render with:

```tsx
return (
  <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
      <div>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>{formatHeaderDate()}</div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Log</h1>
      </div>
    </div>

    <WeekStrip selected={date} today={todayInUserTz()} />

    {/* Already-logged today chips — read-only summary of integration data */}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", padding: "0 8px 14px" }}>
      <MetricCard color={METRIC_COLOR.steps}    icon="👣" label="Steps"    value={log?.steps ?? null}    compact />
      <MetricCard color={METRIC_COLOR.calories} icon="🍴" label="Calories" value={log?.calories ?? null} unit="kcal" compact />
    </div>

    <div style={{ padding: "0 8px" }}>
      <LogForm date={date} initialLog={(log ?? null) as Partial<DailyLog> | null} initialCheckin={/* existing */} />
    </div>
  </div>
);
```

Drop the `<Header />` render from `/log` (the page-title row above replaces the existing header chrome). If the rest of the app still depends on `Header` for some chrome (e.g., name/avatar), only drop it from this page — leave the import on other pages until they're individually updated.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Smoke-test `/log`**

Run: `npm run dev`. Open `/log`. Verify:
- Page header (Log + date)
- Week strip
- Two compact already-logged chips (Steps, Calories)
- Form with sections (Recovery / Sleep / Training / Nutrition / Morning check-in) all on white cards with the new color palette
- 1–10 readiness grid renders square buttons
- Energy / Mood pickers
- Save button is full-width blue
- Saving the form still updates the dashboard score (round-trip)

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add components/log/LogForm.tsx app/log/page.tsx
git commit -m "feat(log): apply soft-light layout — WeekStrip, already-logged chips, restyled form"
```

## Task 21: Build `IntegrationRow` and restyle profile panels

**Files:**
- Create: [components/profile/IntegrationRow.tsx](../../../components/profile/IntegrationRow.tsx)
- Modify: [components/profile/ConnectionsPanel.tsx](../../../components/profile/ConnectionsPanel.tsx)
- Modify: [components/profile/BaselinesPanel.tsx](../../../components/profile/BaselinesPanel.tsx)
- Modify: [components/profile/IngestPanel.tsx](../../../components/profile/IngestPanel.tsx)
- Modify: [components/profile/ProfileForm.tsx](../../../components/profile/ProfileForm.tsx)
- Modify: [components/profile/BackfillButton.tsx](../../../components/profile/BackfillButton.tsx)

- [ ] **Step 1: Create `IntegrationRow.tsx`**

Write [components/profile/IntegrationRow.tsx](../../../components/profile/IntegrationRow.tsx):

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

type IntegrationRowProps = {
  /** Brand background color for the chip. */
  brandColor: string;
  /** Brand foreground (text on the chip). */
  brandFg?: string;
  /** Chip content — usually the brand initial. */
  chip: ReactNode;
  name: string;
  /** Status text — e.g. "Connected · synced 8 min ago". */
  status: string;
  /** Status dot color — `success` for OK, `muted` for off, etc. */
  statusTone?: "success" | "muted" | "danger";
  /** CTA label — defaults to "Manage". */
  ctaLabel?: string;
  /** Where the CTA routes. */
  ctaHref: string;
};

const TONE_DOT: Record<"success" | "muted" | "danger", string> = {
  success: COLOR.success,
  muted:   COLOR.textFaint,
  danger:  COLOR.danger,
};

export function IntegrationRow({
  brandColor,
  brandFg = "#fff",
  chip,
  name,
  status,
  statusTone = "success",
  ctaLabel = "Manage",
  ctaHref,
}: IntegrationRowProps) {
  return (
    <Card variant="compact" style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px" }}>
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "10px",
          background: brandColor,
          color: brandFg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {chip}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: COLOR.textStrong }}>{name}</div>
        <div style={{ fontSize: "11px", color: COLOR.textMuted, marginTop: "1px" }}>
          <span style={{ color: TONE_DOT[statusTone], fontWeight: 600 }}>● </span>
          {status}
        </div>
      </div>
      <Link href={ctaHref} style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 700, textDecoration: "none" }}>
        {ctaLabel} ›
      </Link>
    </Card>
  );
}
```

- [ ] **Step 2: Restyle `ConnectionsPanel.tsx` to use `IntegrationRow`**

Read the current file: `cat "components/profile/ConnectionsPanel.tsx"`. Replace each per-source row with `<IntegrationRow ... />`. Brand colors:

```tsx
// WHOOP
brandColor: "#1a1a1a", brandFg: "#16ff7a"
// Withings
brandColor: "#00aef0", brandFg: "#fff"
// Apple Health
brandColor: COLOR.surfaceAlt, brandFg: COLOR.textStrong
// Yazio
brandColor: "#ffe4e6", brandFg: "#e11d48"
// Strong
brandColor: COLOR.warningSoft, brandFg: "#b45309"
```

- [ ] **Step 3: Restyle `BaselinesPanel.tsx`, `IngestPanel.tsx`, `ProfileForm.tsx`, `BackfillButton.tsx`**

For each: read the file, swap dark-theme colors for light-theme equivalents using the same rule set as Task 18, replace inline custom rows with `<StatusRow>` where they match the settings-row pattern, replace any `<button>` with the inline accent-button style from Task 20 step 2 (full-width primary button).

Imports to add: `import { COLOR } from "@/lib/ui/theme";` and `import { StatusRow } from "@/components/ui/StatusRow";` where applicable.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/profile
git commit -m "refactor(profile): light-theme restyle — IntegrationRow + StatusRow"
```

## Task 22: Apply new `/profile` layout

**Files:**
- Modify: [app/profile/page.tsx](../../../app/profile/page.tsx)

Sectioned vertical stack: user card → connected sources → baselines → ingest tokens → account.

- [ ] **Step 1: Read the current profile page**

Run: `cat "app/profile/page.tsx"`. Note the existing data fetches and sub-components.

- [ ] **Step 2: Replace the page render with the new layout**

Outline (the actual JSX depends on which subcomponents the current page composes — preserve those, just rearrange + add chrome):

```tsx
return (
  <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
    {/* Header */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
      <div>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Account & integrations</div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Profile</h1>
      </div>
      <span style={{ fontSize: "18px", color: COLOR.textMuted }}>⚙</span>
    </div>

    {/* User card */}
    <div style={{ padding: "0 8px 14px" }}>
      <Card style={{ display: "flex", gap: "14px", alignItems: "center" }}>
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLOR.accent}, ${COLOR.accentDeep})`,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "22px",
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {(profile?.name ?? user.email ?? "A")[0].toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "16px", fontWeight: 700 }}>{profile?.name ?? "—"}</div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "2px" }}>{user.email}</div>
        </div>
        <span style={{ fontSize: "18px", color: COLOR.textFaint }}>›</span>
      </Card>
    </div>

    {/* Connected sources */}
    <SectionLabel>Connected sources</SectionLabel>
    <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "6px" }}>
      <ConnectionsPanel /* existing props */ />
    </div>

    {/* Baselines */}
    <SectionLabel>Baselines</SectionLabel>
    <div style={{ padding: "0 8px 14px" }}>
      <BaselinesPanel /* existing props */ />
    </div>

    {/* Ingest tokens */}
    <SectionLabel>Ingest tokens</SectionLabel>
    <div style={{ padding: "0 8px 14px" }}>
      <IngestPanel /* existing props */ />
    </div>

    {/* Account */}
    <SectionLabel>Account</SectionLabel>
    <div style={{ padding: "0 8px 14px" }}>
      <Card variant="compact" style={{ padding: 0 }}>
        <StatusRow label="Privacy & data" href="/privacy" />
        <StatusRow label="Sign out" danger onClick={/* existing sign-out handler */} />
      </Card>
    </div>
  </div>
);

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "11px", color: COLOR.textMuted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "10px 16px 6px" }}>
      {children}
    </div>
  );
}
```

The sign-out handler currently lives in either `app/api/auth/signout/route.ts` (POST) or as a server-action button — check the existing page and reuse the existing handler. If the existing pattern is a `<form action="/api/auth/signout">`, render that inside the StatusRow's children instead.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Smoke-test `/profile`**

Run: `npm run dev`. Open `/profile`. Verify:
- Page header (Profile + Account & integrations)
- User card (avatar + name + email + chevron)
- "Connected sources" section with brand-colored integration rows
- "Baselines" rows
- "Ingest tokens" rows
- "Account" with Privacy & data link and Sign out (red label)
- Sign out actually signs you out (round-trip preserved)

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/profile/page.tsx
git commit -m "feat(profile): apply soft-light sectioned layout"
```

## Task 23: Slice 3 verification

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Manual sweep of /, /log, /profile**

Run: `npm run dev`. Visit each page on mobile viewport and desktop viewport. Verify no regressions, all interactive elements work, navigation between pages works through both bottom nav (mobile) and top nav (desktop).

- [ ] **Step 3: Tag the slice**

```bash
git tag -a slice-3-done -m "Slice 3 complete: dashboard, /log, /profile redesigned"
```

---

# Slice 4 — `/trends` + `/strength`

## Task 24: Restyle `/trends` page

**Files:**
- Modify: [app/trends/page.tsx](../../../app/trends/page.tsx)
- Delete: [components/trends/PeriodSelector.tsx](../../../components/trends/PeriodSelector.tsx)

Replace the dark layout with header → `RangePills` → compact `MetricCard` stack. Each card is a link to `/trends/[metric]`.

- [ ] **Step 1: Read the current page**

Run: `cat "app/trends/page.tsx"` and `cat "components/trends/PeriodSelector.tsx"`. Note how the period selector currently encodes ranges and which fields are charted.

- [ ] **Step 2: Replace the layout**

```tsx
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard } from "@/components/charts/MetricCard";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

// inside the component:
const range = sp.range ?? "30d";
const rangeOpts = [
  { id: "7d",  label: "7D",  href: "/trends?range=7d"  },
  { id: "30d", label: "30D", href: "/trends?range=30d" },
  { id: "90d", label: "90D", href: "/trends?range=90d" },
  { id: "1y",  label: "1Y",  href: "/trends?range=1y"  },
];

// Shape per-metric trend data into LinePoint[] using existing query results:
// const hrvTrend = rows.map((r) => ({ x: r.date, y: r.hrv }));
// const rhrTrend = rows.map((r) => ({ x: r.date, y: r.resting_hr }));
// ...etc per FIELDS the page already loads.

return (
  <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
      <div>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Last {/* range label */}</div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Trends</h1>
      </div>
    </div>

    <div style={{ padding: "0 8px 14px" }}>
      <RangePills options={rangeOpts} active={range} />
    </div>

    <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "0 8px" }}>
      <MetricCard color={METRIC_COLOR.hrv}              icon="♥" label="HRV"        value={hrvAvg}    unit="ms"   delta={hrvDelta}    deltaUnit="ms"  compact trend={hrvTrend}    href="/trends/hrv" />
      <MetricCard color={METRIC_COLOR.resting_hr}        icon="♥" label="Resting HR" value={rhrAvg}    unit="bpm"  delta={rhrDelta}    deltaUnit="bpm" inverted compact trend={rhrTrend} href="/trends/resting_hr" />
      <MetricCard color={METRIC_COLOR.sleep_hours}       icon="☾" label="Sleep"     value={sleepAvg}  unit="h"    delta={sleepDelta}  deltaUnit="h"   compact trend={sleepTrend}  href="/trends/sleep_hours" />
      <MetricCard color={METRIC_COLOR.strain}            icon="⚡" label="Strain"   value={strainAvg}              delta={strainDelta}                compact trend={strainTrend} href="/trends/strain" />
      <MetricCard color={METRIC_COLOR.weight_kg}         icon="⚖" label="Weight"    value={weightAvg} unit="kg"   delta={weightDelta} deltaUnit="kg"  compact trend={weightTrend} href="/trends/weight_kg" />
      <MetricCard color={METRIC_COLOR.body_fat_pct}      icon="%" label="Body Fat"  value={bfAvg}     unit="%"    delta={bfDelta}     deltaUnit="%"   compact trend={bfTrend}     href="/trends/body_fat_pct" />
    </div>
  </div>
);
```

The averages and deltas are computed from the same query the existing page runs — locate that compute and reuse it. Skip metric cards whose data array is all-null (the user has no data for that metric).

- [ ] **Step 3: Delete `PeriodSelector.tsx`**

```bash
rm components/trends/PeriodSelector.tsx
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Smoke-test `/trends`**

Run: `npm run dev`. Open `/trends`. Verify:
- Header + range pills
- 6 compact metric cards stacked
- Each card has a sparkline
- Tapping any card routes to `/trends/<metric>` (which 404s for now — fix in Task 25)
- Tapping a range pill updates `?range=` and re-renders

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add app/trends/page.tsx
git rm components/trends/PeriodSelector.tsx
git commit -m "feat(trends): compact-card stack + RangePills"
```

## Task 25: Build `/trends/[metric]` detail page

**Files:**
- Create: [app/trends/[metric]/page.tsx](../../../app/trends/[metric]/page.tsx)

Single-metric drill-down: hero value + delta-vs-prior, full `RangePills`, `LineChart` detail, Min/Avg/Max stats, optional insight card.

- [ ] **Step 1: Create the file**

Write [app/trends/[metric]/page.tsx](../../../app/trends/[metric]/page.tsx):

```tsx
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { RangePills } from "@/components/ui/RangePills";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { FIELDS, type DailyLogKey } from "@/lib/ui/colors";
import { fmtNum } from "@/lib/ui/score";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";
export const revalidate = 60;

const VALID_KEYS: ReadonlySet<DailyLogKey> = new Set(FIELDS.map((f) => f.k));

type MetricPageProps = {
  params: Promise<{ metric: string }>;
  searchParams: Promise<{ range?: string }>;
};

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

export default async function MetricDetail(props: MetricPageProps) {
  const { metric } = await props.params;
  const sp = await props.searchParams;
  if (!VALID_KEYS.has(metric as DailyLogKey)) notFound();
  const key = metric as DailyLogKey;

  const range = sp.range && RANGE_DAYS[sp.range] ? sp.range : "30d";
  const days = RANGE_DAYS[range];

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Load `days` of daily logs.
  const today = todayInUserTz();
  const startIso = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - days + 1));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  })();

  const { data: rows } = await supabase
    .from("daily_logs")
    .select(`date, ${key}`)
    .eq("user_id", user.id)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  const field = FIELDS.find((f) => f.k === key)!;
  const data: LinePoint[] = (rows ?? []).map((r) => ({ x: (r as Record<string, unknown>).date as string, y: ((r as Record<string, unknown>)[key] as number | null) ?? null }));
  const present = data.map((d) => d.y).filter((v): v is number => v !== null);

  const min = present.length ? Math.min(...present) : null;
  const max = present.length ? Math.max(...present) : null;
  const avg = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;

  const rangeOpts = [
    { id: "7d",  label: "7D",  href: `/trends/${metric}?range=7d`  },
    { id: "30d", label: "30D", href: `/trends/${metric}?range=30d` },
    { id: "90d", label: "90D", href: `/trends/${metric}?range=90d` },
    { id: "1y",  label: "1Y",  href: `/trends/${metric}?range=1y`  },
  ];

  // Compute 4 evenly-spaced x-axis date labels.
  const labels: [string, string, string, string] | undefined = data.length >= 4
    ? [
        shortDate(data[0].x ?? ""),
        shortDate(data[Math.floor(data.length / 3)].x ?? ""),
        shortDate(data[Math.floor((2 * data.length) / 3)].x ?? ""),
        shortDate(data[data.length - 1].x ?? ""),
      ]
    : undefined;

  const color = METRIC_COLOR[key];

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "4px 12px 14px" }}>
        <a href="/trends" style={{ fontSize: "20px", color: COLOR.accent, textDecoration: "none" }}>‹</a>
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Trends</div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, letterSpacing: "-0.02em" }}>{field.l}</h1>
        </div>
      </div>

      <div style={{ padding: "0 16px 14px" }}>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 600 }}>{days}-day average</div>
        <div data-tnum style={{ fontSize: "56px", fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1, marginTop: "4px" }}>
          {avg == null ? "—" : fmtNum(avg)}
          {avg != null && <span style={{ fontSize: "22px", fontWeight: 600, color: COLOR.textFaint, marginLeft: "4px" }}>{field.u}</span>}
        </div>
      </div>

      <div style={{ padding: "0 8px 14px" }}>
        <RangePills options={rangeOpts} active={range} />
      </div>

      <div style={{ padding: "0 8px 12px" }}>
        <Card>
          <LineChart data={data} color={color} variant="detail" xAxisLabels={labels} />
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", padding: "0 8px 14px" }}>
        <Card variant="compact">
          <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>MIN</div>
          <div data-tnum style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{min == null ? "—" : fmtNum(min)}{min != null && <span style={{ fontSize: "11px", color: COLOR.textFaint, fontWeight: 500, marginLeft: "2px" }}>{field.u}</span>}</div>
        </Card>
        <Card variant="compact">
          <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>AVG</div>
          <div data-tnum style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{avg == null ? "—" : fmtNum(avg)}{avg != null && <span style={{ fontSize: "11px", color: COLOR.textFaint, fontWeight: 500, marginLeft: "2px" }}>{field.u}</span>}</div>
        </Card>
        <Card variant="compact">
          <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>MAX</div>
          <div data-tnum style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{max == null ? "—" : fmtNum(max)}{max != null && <span style={{ fontSize: "11px", color: COLOR.textFaint, fontWeight: 500, marginLeft: "2px" }}>{field.u}</span>}</div>
        </Card>
      </div>
    </div>
  );
}

function shortDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[+m - 1]} ${+d}`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Smoke-test the detail view**

Run: `npm run dev`. From `/trends`, tap the HRV card. Verify:
- Back arrow + page title "Heart Rate Variability"
- Big average number with unit
- 4 range pills (30D active)
- Detail line chart with gridlines
- 3-up Min/Avg/Max stats grid
- Hovering or tapping the chart shows the tooltip

Visit `/trends/bogus` and confirm 404.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add app/trends/\[metric\]
git commit -m "feat(trends): add /trends/[metric] detail page"
```

## Task 26: Restyle `StrengthNav` to `RangePills` shape

**Files:**
- Modify: [components/strength/StrengthNav.tsx](../../../components/strength/StrengthNav.tsx)

The 3-view sub-nav (Today / Recent / By date) keeps its routing but takes the new pill row visuals.

- [ ] **Step 1: Replace the file contents with a `RangePills`-driven version**

Write [components/strength/StrengthNav.tsx](../../../components/strength/StrengthNav.tsx):

```tsx
"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today",  label: "Today",   href: "/strength?view=today"  },
  { id: "recent", label: "Recent",  href: "/strength"             },
  { id: "date",   label: "By date", href: "/strength?view=date"   },
] as const;

type View = (typeof VIEWS)[number]["id"];

export function StrengthNav({ active }: { active: View }) {
  return <RangePills options={VIEWS as unknown as { id: string; label: string; href: string }[]} active={active} />;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/strength/StrengthNav.tsx
git commit -m "refactor(strength): switch StrengthNav to RangePills shape"
```

## Task 27: Restyle `TodayPlanCard` with `modeColorLight`

**Files:**
- Modify: [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx)

Apply light theme. Use `modeColorLight(mode.color)` to derive the card background. No `slice(0,6)` cap (preserved from cleanup).

- [ ] **Step 1: Read the current file**

Run: `cat "components/strength/TodayPlanCard.tsx"`. Confirm it currently uses `mode.color` directly (dark hex from `getIntensityMode`) for backgrounds and accent.

- [ ] **Step 2: Apply the color mapping and light-theme surrounds**

Add imports:

```tsx
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { COLOR, RADIUS, SHADOW, modeColorLight } from "@/lib/ui/theme";
```

Replace the existing card surface — wherever the current implementation does `style={{ background: mode.color }}` or similar — with:

```tsx
const accent = modeColorLight(mode.color);

return (
  <Card
    background={accent}
    shadow={`0 12px 24px -8px ${accent}55`}
    style={{ color: "#fff", borderRadius: RADIUS.cardHero, padding: "16px 18px" }}
  >
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
      <div>
        <div style={{ fontSize: "10px", opacity: 0.85, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>
          Today's session
        </div>
        <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "2px" }}>
          {plan.sessionType === "REST" ? "Rest day" : `💪 ${plan.sessionType}`}
        </div>
      </div>
      <span style={{ fontSize: "10px", padding: "4px 8px", background: "rgba(255,255,255,0.18)", borderRadius: "9999px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
        {plan.mode.label.replace(/^[^\s]+\s/, "")}
      </span>
    </div>
    <p style={{ fontSize: "12px", opacity: 0.85, marginTop: "8px", lineHeight: 1.4 }}>{plan.mode.desc}</p>

    {plan.sessionType !== "REST" && plan.exercises.length > 0 && (
      <div style={{ marginTop: "12px" }}>
        {plan.exercises.map((ex) => (
          <div
            key={ex.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 0",
              borderTop: "1px solid rgba(255,255,255,0.18)",
              fontSize: "12px",
            }}
          >
            <span style={{ opacity: 0.85 }}>{ex.name.split("(")[0].trim()}</span>
            <span data-tnum style={{ fontWeight: 600, opacity: 0.95 }}>{ex.target}</span>
          </div>
        ))}
      </div>
    )}
  </Card>
);
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Smoke-test on `/strength?view=today`**

Run: `npm run dev`. Open `/strength?view=today`. Verify the card uses the light-mapped mode color, lists all planned exercises (count matches `plan.exercises.length`), no Save button or form.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add components/strength/TodayPlanCard.tsx
git commit -m "refactor(strength): light-theme TodayPlanCard via modeColorLight"
```

## Task 28: Restyle remaining strength components

**Files:**
- Modify: [components/strength/SessionTable.tsx](../../../components/strength/SessionTable.tsx)
- Modify: [components/strength/SessionRow.tsx](../../../components/strength/SessionRow.tsx)
- Modify: [components/strength/PRList.tsx](../../../components/strength/PRList.tsx)
- Modify: [components/strength/ExerciseTrendCard.tsx](../../../components/strength/ExerciseTrendCard.tsx)
- Modify: [components/strength/VolumeTrendCard.tsx](../../../components/strength/VolumeTrendCard.tsx)
- Modify: [components/strength/DateNavigator.tsx](../../../components/strength/DateNavigator.tsx)
- Modify: [components/strength/CoachCards.tsx](../../../components/strength/CoachCards.tsx)

Apply the standard color-swap rules from Task 18 to each. Replace any use of the old `LineChart` props with the new API (data: LinePoint[], color, variant).

`PRList` items should be `<Card variant="nested">` with a `<Pill tone="warning">` for "PR · 140 kg".

`VolumeTrendCard` becomes a hero variant with the amber-orange gradient — set `background: 'linear-gradient(135deg, #b45309 0%, #f97316 100%)'`, `color: '#fff'`, `shadow: SHADOW.heroAmber`. Big volume number, meta row, ↑ delta pill in white-on-translucent.

- [ ] **Step 1: Read each file in turn and apply edits**

For each component above:
1. `cat "<path>"` to see the current dark-theme styles.
2. Replace dark-theme color references with light-theme tokens (Task 18 rules).
3. Wrap in `<Card>` where currently using bare `<div className="rounded-...">`.
4. For any `LineChart` caller, update the call signature to `<LineChart data={...} color={...} variant="mini" />` (or `"detail"`).

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Smoke-test all three /strength views**

Run: `npm run dev`. Visit:
- `/strength?view=today` — TodayPlanCard
- `/strength` (recent view) — volume hero, top-lift PR cards with sparklines, recent session rows
- `/strength?view=date` — date navigator + session detail table

Verify all render in light theme with no broken layouts.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add components/strength
git commit -m "refactor(strength): light-theme restyle across SessionTable, PRList, trend cards, navigators"
```

## Task 29: Restyle `app/strength/page.tsx` shell

**Files:**
- Modify: [app/strength/page.tsx](../../../app/strength/page.tsx)

The routing logic (Today / Recent / By date) is preserved. Only the page chrome changes.

- [ ] **Step 1: Read the current page**

Run: `cat "app/strength/page.tsx"`.

- [ ] **Step 2: Replace the page chrome with the new header + sub-nav layout**

Inside the page render, wrap whatever it currently returns in:

```tsx
return (
  <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
      <div>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>{subtitleByView(activeView)}</div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Strength</h1>
      </div>
    </div>

    <div style={{ padding: "0 8px 14px" }}>
      <StrengthNav active={activeView} />
    </div>

    <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Existing per-view content goes here unchanged */}
    </div>
  </div>
);

function subtitleByView(v: string): string {
  if (v === "today")  return "Today's plan";
  if (v === "date")   return "Pick a date";
  return "Last 30 days";
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Smoke-test all three views again**

Run: `npm run dev`. Verify each `/strength` view renders with the new shell.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/strength/page.tsx
git commit -m "feat(strength): apply soft-light shell with new header + sub-nav"
```

## Task 30: Slice 4 verification + delete superseded chart components

**Files:**
- Delete: [components/ui/MetricBar.tsx](../../../components/ui/MetricBar.tsx)
- Delete: [components/ui/PrioBox.tsx](../../../components/ui/PrioBox.tsx)
- Delete: [components/ui/Gauge.tsx](../../../components/ui/Gauge.tsx)
- Delete: [components/ui/SparkLine.tsx](../../../components/ui/SparkLine.tsx)
- Delete: [components/charts/BarChart.tsx](../../../components/charts/BarChart.tsx)
- Delete: [components/charts/RecoveryBars.tsx](../../../components/charts/RecoveryBars.tsx)
- Delete: [components/dashboard/MonitorTile.tsx](../../../components/dashboard/MonitorTile.tsx)
- Delete: [components/dashboard/DashboardSection.tsx](../../../components/dashboard/DashboardSection.tsx)
- Delete: [components/dashboard/SkeletonCard.tsx](../../../components/dashboard/SkeletonCard.tsx)

Confirm each is unused, then delete.

- [ ] **Step 1: Confirm no callers**

For each candidate, run:

```bash
grep -r "from \"@/components/ui/MetricBar\"" app components || echo "no callers"
grep -r "from \"@/components/ui/PrioBox\"" app components || echo "no callers"
grep -r "from \"@/components/ui/Gauge\"" app components || echo "no callers"
grep -r "from \"@/components/ui/SparkLine\"" app components || echo "no callers"
grep -r "from \"@/components/charts/BarChart\"" app components || echo "no callers"
grep -r "from \"@/components/charts/RecoveryBars\"" app components || echo "no callers"
grep -r "from \"@/components/dashboard/MonitorTile\"" app components || echo "no callers"
grep -r "from \"@/components/dashboard/DashboardSection\"" app components || echo "no callers"
grep -r "from \"@/components/dashboard/SkeletonCard\"" app components || echo "no callers"
```

If any has callers, leave that file alone for now; only delete files with zero references.

- [ ] **Step 2: Delete the orphans**

```bash
git rm components/ui/MetricBar.tsx components/ui/PrioBox.tsx components/ui/Gauge.tsx components/ui/SparkLine.tsx \
       components/charts/BarChart.tsx components/charts/RecoveryBars.tsx \
       components/dashboard/MonitorTile.tsx components/dashboard/DashboardSection.tsx components/dashboard/SkeletonCard.tsx
```

(Skip any file your grep showed as still in use.)

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Tag the slice**

```bash
git commit -m "chore: remove superseded primitives (MetricBar, PrioBox, Gauge, SparkLine, BarChart, etc.)"
git tag -a slice-4-done -m "Slice 4 complete: /trends + /strength redesigned"
```

---

# Slice 5 — `/coach`, `/login`, `/privacy`, cleanup

## Task 31: Restyle `/coach` and its sub-components

**Files:**
- Modify: [components/coach/CoachNav.tsx](../../../components/coach/CoachNav.tsx)
- Modify: [components/coach/InsightsList.tsx](../../../components/coach/InsightsList.tsx)
- Modify: [components/coach/RecommendationsList.tsx](../../../components/coach/RecommendationsList.tsx)
- Modify: [components/coach/WeeklyReview.tsx](../../../components/coach/WeeklyReview.tsx)
- Modify: [components/coach/RefreshButton.tsx](../../../components/coach/RefreshButton.tsx)
- Modify: [app/coach/page.tsx](../../../app/coach/page.tsx)

When chat coach lands later (per `2026-05-04-chat-coach-design.md`), this page becomes the chat. For now it's the existing insights/recommendations stack — restyled.

- [ ] **Step 1: Convert `CoachNav` to `RangePills` shape**

Replace [components/coach/CoachNav.tsx](../../../components/coach/CoachNav.tsx) following the same pattern as Task 26 (StrengthNav → RangePills). Tabs: Today, Recommendations, Weekly, Strength.

- [ ] **Step 2: Restyle each list component**

For `InsightsList`, `RecommendationsList`, `WeeklyReview`: read each, swap dark-theme colors for light-theme tokens. Wrap each insight/recommendation in `<Card variant="compact">`. Use `<Pill tone="...">` for any priority indicator (high → danger, medium → warning, low → success).

`RefreshButton` becomes a styled `<button>` with `background: COLOR.surface, border: 1px solid divider, color: COLOR.accent` (secondary action style).

- [ ] **Step 3: Apply new `app/coach/page.tsx` chrome**

Mirror the strength page shell:

```tsx
return (
  <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
      <div>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>{formatHeaderDate()}</div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Coach</h1>
      </div>
    </div>

    <div style={{ padding: "0 8px 14px" }}>
      <CoachNav active={activeView} />
    </div>

    <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Existing per-view content unchanged */}
    </div>
  </div>
);
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Smoke-test `/coach`**

Run: `npm run dev`. Open `/coach`. Verify:
- Page header
- Pill-style tabs (Today / Recommendations / Weekly / Strength)
- Each tab's content renders on light cards with priority pills

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add components/coach app/coach/page.tsx
git commit -m "refactor(coach): light-theme restyle of insights/recommendations stack"
```

## Task 32: Restyle `/login` and `/privacy`

**Files:**
- Modify: [app/login/page.tsx](../../../app/login/page.tsx)
- Modify: [app/privacy/page.tsx](../../../app/privacy/page.tsx)

Re-skin only — no structural changes.

- [ ] **Step 1: `/login`**

Read [app/login/page.tsx](../../../app/login/page.tsx). Replace the dark surrounding with a centered `<Card>` (`maxWidth: 360px`, centered horizontally). Update form colors with the rule set. Magic-link/password buttons become full-width primary buttons (Task 20 step 2 style).

- [ ] **Step 2: `/privacy`**

Read [app/privacy/page.tsx](../../../app/privacy/page.tsx). Wrap in `<div style={{ maxWidth: "640px", margin: "0 auto", padding: "16px" }}>`. Remove dark prose styles. Set body `color: COLOR.textMid`, headings `color: COLOR.textStrong`. The page is plain prose.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Smoke-test both pages**

Run: `npm run dev`. Open `/login` (sign out first) — confirm light card. Open `/privacy` — confirm light prose.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/login/page.tsx app/privacy/page.tsx
git commit -m "feat(login,privacy): light-theme restyle"
```

## Task 33: Restyle `Header.tsx` or remove it

**Files:**
- Modify or Delete: [components/layout/Header.tsx](../../../components/layout/Header.tsx)

After Slices 3–4–5, every page renders its own header inline. The standalone `Header` component is likely unused.

- [ ] **Step 1: Search for callers**

```bash
grep -r "from \"@/components/layout/Header\"" app components
```

- [ ] **Step 2: If no callers, delete the file**

```bash
git rm components/layout/Header.tsx
```

If callers remain, restyle that header in light theme (color-swap rules) and leave it.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A components/layout
git commit -m "chore(layout): remove unused Header component (or restyle if callers remain)"
```

## Task 34: Delete the `/dev/tokens` ghost page

**Files:**
- Delete: `app/dev/tokens/page.tsx`
- Delete: `app/dev/` (if empty)

- [ ] **Step 1: Remove the dev page**

```bash
rm -rf app/dev
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add -A app/dev
git commit -m "chore: remove /dev/tokens preview page"
```

## Task 35: Final verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: production build succeeds with no TypeScript or Next.js errors.

- [ ] **Step 3: `fmtNum()` discipline check**

Per CLAUDE.md, every visible number must flow through `fmtNum()`. Sweep the new code:

```bash
grep -rn "\.toFixed(\|String(.*\b" app components | grep -v "fmtNum\|node_modules" | head -30
```

For each hit, decide: does this render to the user? If yes, refactor through `fmtNum`. If no (logging, internal computation), leave it.

- [ ] **Step 4: Manual page sweep**

Run: `npm run dev`. Visit each route on both mobile (DevTools mobile viewport) and desktop (≥768px):

| Route | Mobile check | Desktop check |
|---|---|---|
| `/` | Bottom nav, FAB, hero, metric grid, donut, coach card, recent lifts, weekly rollups | Top nav, 2-col layout |
| `/log` | Week strip, already-logged chips, restyled form, save round-trip | 2-col layout |
| `/trends` | Compact stack, range pills, sparklines, metric link → detail | 2-col grid |
| `/trends/hrv` (and friends) | Detail chart, hover tooltip, min/avg/max | Wider chart |
| `/strength?view=today` | TodayPlanCard with mapped color, full exercise list | Centered max-width |
| `/strength` (recent) | Volume hero, PR cards, recent rows | Same |
| `/strength?view=date` | Date navigator, session detail | Same |
| `/coach` | Pill tabs, list cards | Same |
| `/profile` | User card, integrations, baselines, ingest, account, sign out | Same |
| `/login` | Light card centered | Same |
| `/privacy` | Light prose | Same |

- [ ] **Step 5: PWA tz check**

```bash
USER_TIMEZONE=America/Los_Angeles npm run dev
```

Open `/`. The week strip "today" highlight and date subtitle should reflect the override (LA today), not Dubai.

- [ ] **Step 6: Tag the redesign**

```bash
git tag -a redesign-v1 -m "Apex Health redesign v1 — soft-light visual system shipped"
```

The tag is local — push when ready.

---

## Wrap-up

After Task 35, the redesign is done. The repo:
- Uses light theme across all 6 main routes + 2 minor routes
- Uses the new `lib/ui/theme.ts` tokens everywhere
- Uses `BottomNav` + `Fab` on mobile and `TopNav` on desktop
- Uses `WeekStrip`, `RangePills`, the new `Card`/`Pill`/`StatusRow` primitives, and the new `LineChart` + `MetricCard`
- No longer ships `TabNav`, `DashboardDatePager`, `MetricBar`, `PrioBox`, `Gauge`, `SparkLine`, `BarChart`, `RecoveryBars`, `MonitorTile`, `DashboardSection`, `SkeletonCard`, `MorningCheckIn` (already gone), or the dev `/dev/tokens` preview
- Backend, schema, sync routes, RLS, integration merges, coach pure functions, `lib/time.ts`, `lib/data/types.ts`, `lib/anthropic/*` are unchanged

When the chat coach V1 plan (`docs/superpowers/plans/2026-05-04-chat-coach.md`) executes after this, the chat surface inherits the soft-light language from the `/coach` shell laid down in Task 31, with no rework required.
