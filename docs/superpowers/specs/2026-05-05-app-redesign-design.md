# Apex Health — full app visual redesign — design

**Status:** approved (spec)
**Date:** 2026-05-05
**Owner:** Abdelouahed

## Summary

Replace the current dark, dense, "stock dashboard" UI with a soft, light, type-led visual system inspired by consumer-wellness apps (Apple Fitness lineage). Same data, same routes, same backend — new design tokens, new component primitives, new navigation chrome.

Six routes change visually: `/`, `/log`, `/trends`, `/strength`, `/coach`, `/profile`. Two routes get light-theme treatment but no structural change: `/login`, `/privacy`. Backend code (sync, ingest, RLS, schema, integration merges) is untouched.

The redesign ships **before** the chat coach (V1 spec at `2026-05-04-chat-coach-design.md` already approved). When chat coach lands, it inherits the new design language automatically — no rework.

## Goals

1. Modern, premium feel — cards, soft shadows, generous whitespace, bold numerics, smooth gradients
2. Clear visual hierarchy — readiness is the anchor; secondary metrics support it; chrome stays out of the way
3. Easier daily use — primary action (logging) gets prime navigation real estate; date navigation is direct, not paged
4. Charts that read at a glance — smooth gradient lines, color-coded per metric, range pills for time selection
5. Consistent design system — every page composed from the same primitives; adding a new metric or page is mechanical

## Non-goals

- New features, new metrics, new integrations, new database columns
- Backend changes (the sync/ingest/coach modules stay as-is)
- Multi-user or theme-switching support (single-user app, light-only — dark is a future spec if ever needed)
- Native mobile app (this remains a PWA)
- Accessibility audit / WCAG compliance pass (separate spec; this design uses sufficient contrast tokens but doesn't formally certify)
- Animation / motion design system (subtle defaults only; full motion language is a follow-up)

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Light theme.** Switch from current black background to soft off-white-blue. | User explicitly chose this over dark variants of the same aesthetic. |
| 2 | **Apple-Fitness-adjacent aesthetic** — soft cards, blue accent, bold numerics, friendly framing. | User-supplied reference image. Won over Whoop-dense and Linear-minimal alternatives. |
| 3 | **Two card variants.** Standard (dashboard) and Compact (data-dense pages). | Standard wastes space on `/trends` and `/strength`; compact restores density without abandoning the language. |
| 4 | **Smooth gradient line charts** — cubic Bézier curve, gradient area fill, range pills, last-point dot, tap-to-tooltip. | Replaces existing `LineChart` which user called out as the worst-looking element. |
| 5 | **Per-metric chart line color** (not a single accent across all charts). | Free recognition signal — red line = HRV, no need to read the label. Aligns with existing `lib/ui/colors.ts` convention. |
| 6 | **Bottom nav: 4 tabs + center FAB.** Today · Trends · `+` · Coach · Profile. The `+` opens an action sheet (Log entry, Add lift, Connect source). | Logging is the most frequent action — center FAB earns prime real estate. Strength is reached as a sub-page from Today, or via FAB → Add lift. |
| 7 | **Week-strip date picker** on `/`, `/log` (and any tab where day-context matters). | Replaces `DashboardDatePager`. User explicitly liked this from the reference. |
| 8 | **Friendly framing retained** — `Today / Tuesday, May 5` greeting + avatar block on `/`. | Single-user, but the warmth lifts the experience and matches the chosen aesthetic. |
| 9 | **Redesign ships before chat coach.** | Cleaner workstreams, smaller PRs, no rebuild of chat UI. |
| 10 | **Mobile-first, responsive on desktop.** | PWA-installable; primary use is mobile. Desktop gets top nav + wider grids. |
| 11 | **Keep DM Sans / DM Mono.** Already self-hosted; humanist enough to fit the soft direction. | No font swap. Uses `font-feature-settings: 'tnum'` for tabular numerics. |
| 12 | **Accommodate dashboard cleanup** (shipped 2026-05-05) — dashboard has no MorningCheckIn; `/log` carries the form alone; `/strength?view=today` shows the read-only session card. | The redesigned layouts respect the new info architecture, not the pre-cleanup one. |

## Design tokens

All tokens live in a new `lib/ui/theme.ts` (TypeScript constants) and are mirrored in Tailwind's `@theme` directive in `app/globals.css` (Tailwind v4 inline tokens — no `tailwind.config.ts` needed).

### Color

```ts
// lib/ui/theme.ts
export const COLOR = {
  // Surfaces
  bg:        "#f1f2f6",   // page background — soft off-white-blue
  surface:   "#ffffff",   // cards, nav bar
  surfaceAlt:"#f5f6fa",   // input fields, inactive pills, sub-rows

  // Content
  textStrong:"#0f1430",   // primary text, big numbers
  textMid:   "#4a4d62",   // body text
  textMuted: "#7a7e95",   // labels, secondary text
  textFaint: "#9094a8",   // helper text, axis labels

  // Accent
  accent:    "#4f5dff",   // primary actions, links, ring/pills active
  accentSoft:"#e7eaff",   // accent backgrounds (active tab chip, info card)
  accentDeep:"#3a47e8",   // hover/pressed accent

  // Semantic (for deltas, status, alerts)
  success:   "#14b870",
  successSoft:"#d1fae5",
  warning:   "#f59e0b",
  warningSoft:"#fef3c7",
  danger:    "#ef4444",
  dangerSoft:"#fee2e2",

  // Dividers / subtle borders (used sparingly — shadow does most of the lift)
  divider:   "#e8eaf3",
} as const;

// Per-metric colors — light-theme calibrated.
// Replace lib/ui/colors.ts FIELDS[].c values with these. Keys unchanged.
export const METRIC_COLOR: Record<DailyLogKey, string> = {
  hrv:               "#e11d48",  // rose
  resting_hr:        "#f97316",  // orange
  spo2:              "#06b6d4",  // cyan
  skin_temp_c:       "#ea580c",  // orange-deep
  sleep_hours:       "#4f5dff",  // indigo (= accent — sleep is "the brand metric")
  sleep_score:       "#4f5dff",
  deep_sleep_hours:  "#2563eb",  // blue
  rem_sleep_hours:   "#a855f7",  // violet
  strain:            "#b45309",  // amber
  steps:             "#14b870",  // emerald
  calories:          "#ca8a04",  // mustard
  weight_kg:         "#8b5cf6",  // purple
  body_fat_pct:      "#ea580c",  // orange-deep
};
```

The score-band helpers in `lib/ui/colors.ts` (`scoreColor`, `scoreLabel`, `priorityColor`) keep their semantics but switch to light-theme values: `>=80 → success`, `>=60 → warning`, `<60 → danger`.

### Typography

DM Sans (variable) for everything; DM Mono retained as a fallback for any tabular contexts that benefit from monospace (currently rare in the new design — `tnum` features cover most cases).

| Token | Use | Size / weight / tracking |
|---|---|---|
| `display` | Hero numbers (readiness, HRV detail value) | 56–64px, 800, -0.04em |
| `h1` | Page titles ("Trends", "Strength") | 22px, 700, -0.02em |
| `h2` | Section heading inside cards | 16px, 700, -0.01em |
| `body` | Paragraphs, card body | 13px, 400 |
| `body-strong` | Card headlines, lift names | 13–14px, 700 |
| `metric-value` | Card big numbers | 20–24px, 800, -0.02em, `tnum` |
| `metric-label` | "HRV", "Sleep", "Today" | 11–12px, 600, mid color |
| `chip` | Pills, tabs, day-strip days | 9–11px, 600, +0.04em letter-spacing |
| `caption` | Axis labels, helper text | 10–11px, 500, faint color |
| `delta` | "+12 ms", "−3 bpm" | 11px, 700, semantic color, `tnum` |

### Spacing, radii, shadows

```ts
export const RADIUS = {
  chip:      "6px",
  pill:      "10px",
  input:     "10px",
  cardSmall: "14px",  // sub-cards nested inside sections (PR rows, recent-session rows)
  cardMid:   "16px",  // compact cards (/trends, /strength compact metric stack)
  card:      "20px",  // standard cards (dashboard, /log)
  cardHero:  "24px",  // readiness, /strength volume hero
  full:      "9999px",
} as const;

export const SHADOW = {
  card:        "0 2px 8px rgba(20,30,80,0.05)",
  cardHover:   "0 4px 12px rgba(20,30,80,0.08)",
  heroAccent:  "0 12px 28px -8px rgba(79,93,255,0.4)",  // under blue hero
  heroAmber:   "0 12px 24px -8px rgba(180,83,9,0.4)",   // under strength volume hero
  bottomNav:   "0 4px 14px rgba(20,30,80,0.08)",
  fab:         "0 8px 20px -4px rgba(79,93,255,0.5)",
  floating:    "0 30px 60px -20px rgba(20,30,80,0.18)", // page-level lift (modals)
} as const;
```

Spacing follows Tailwind's 4px scale. Common page paddings: `8px` outer (against safe-area), `12px` between cards, `16–18px` inside cards.

## Component primitives

Each primitive lives under `components/ui/`. The current `components/ui/` (`Card`, `MetricBar`, `PrioBox`, `SparkLine`, `Gauge`) gets either rewritten in the new language or deleted.

| Primitive | Replaces / new | Purpose |
|---|---|---|
| `Card` | rewrite of `components/ui/Card.tsx` | White surface, `RADIUS.card` (20px), `SHADOW.card`. Default standard variant; `compact` prop switches to `RADIUS.cardMid` (16px) + 12px padding. `nested` prop (for sub-cards inside sections) switches to `RADIUS.cardSmall` (14px) + lower elevation shadow. |
| `MetricCard` | rewrite of `components/charts/MetricCard.tsx` | Icon chip + label + big value + delta. Optional `mini-chart` prop for compact form. |
| `WeekStrip` | new (`components/layout/WeekStrip.tsx`) | 7-day row with day-name above, big numeral below, today highlighted with `accentSoft` background. Replaces `DashboardDatePager`. Tap any day → updates `?date=YYYY-MM-DD`. |
| `RangePills` | rewrite of `components/trends/PeriodSelector.tsx` | 4-up pill row. Active = solid `accent`. Default options: `7D · 30D · 90D · 1Y` (configurable). |
| `BottomNav` | new (`components/layout/BottomNav.tsx`) | 4-tab bar: Today, Trends, Coach, Profile. Center FAB cut-out for the `+` button. Hidden on `≥md` viewports — replaced by `TopNav` (see below). |
| `Fab` + `FabSheet` | new (`components/layout/Fab.tsx`, `FabSheet.tsx`) | Floating circular `+` button between Trends and Coach tabs. Tap → bottom sheet with these actions:<br>• **Log entry** → `/log` (focuses morning check-in form)<br>• **Strength** → `/strength?view=today`<br>• **Upload Strong CSV** → file-picker that POSTs to `/api/ingest/strong`<br>• **Manage connections** → `/profile`<br>The sheet is dismissable via swipe-down or backdrop tap (existing PWA bottom-sheet pattern). |
| `TopNav` | rewrite of `components/layout/TabNav.tsx` | Desktop-only horizontal tab strip (replaces the current top scroll-strip). Visible at `≥md`. Same 5 destinations as `BottomNav`, no FAB (the `+` action moves into the tab order or onto the page). |
| `LineChart` | rewrite of `components/charts/LineChart.tsx` | Smooth cubic-Bézier path, gradient area fill, last-point dot, optional gridlines, optional tooltip-on-tap. Two preset sizes: `mini` (80px tall, no axes) and `detail` (140px tall, dashed gridlines + 4 date labels). Color = per-metric. |
| `ReadinessHero` | new (`components/dashboard/ReadinessHero.tsx`) | Solid blue card with big readiness number, status pill ("Primed"/"Ready"/"Take it easy"), one-line plain-English subtitle. Replaces `ImpactDonut` as the primary readiness anchor on `/`. (Donut moves to a secondary position — see `/` layout.) |
| `IntegrationRow` | rewrite of rows in `components/profile/ConnectionsPanel.tsx` | Brand chip (square, color-coded per source) + name + live status (`● Connected · synced 8 min ago`) + manage CTA. |
| `StatusRow` | new (`components/ui/StatusRow.tsx`) | Generic settings/baseline row: left label, right value+chevron. Used in `/profile` baselines + account sections. |
| `Pill` | new (`components/ui/Pill.tsx`) | Generic small pill (the "Primed" tag, "PR · 140 kg" badge). Variants: `accent`, `success`, `warning`, `danger`, `neutral`. |

### Deleted in this redesign

- `components/ui/MetricBar.tsx` — bar charts replaced by line charts on /trends; horizontal-bar metric display replaced by `MetricCard` grid.
- `components/ui/PrioBox.tsx` — recommendations get `Card` + `Pill` primitives; no dedicated component needed.
- `components/ui/Gauge.tsx` — readiness ring is `ImpactDonut` (kept) or `ReadinessHero` (preferred new anchor).
- `components/ui/SparkLine.tsx` — superseded by `LineChart` size=`mini`.
- `components/dashboard/DashboardDatePager.tsx` — replaced by `WeekStrip`.
- `components/dashboard/MorningCheckIn.tsx` — already deleted in 2026-05-05 dashboard cleanup.
- `components/charts/BarChart.tsx` — usage is sparse; if any caller remains it ports to `LineChart` mini.

### Kept as-is (logic only — re-skinned where they render)

- `components/dashboard/ImpactDonut.tsx` — moved below `ReadinessHero` as the impact-decomposition view ("what's pulling readiness up/down today"). Logic unchanged.
- `components/dashboard/WeeklyRollups.tsx` — re-skinned as `Card` + `LineChart` mini stack.
- `components/coach/{InsightsList,RecommendationsList,WeeklyReview,RefreshButton}.tsx` — kept until chat coach lands. Re-skinned in soft-light. CoachNav restyled.
- `components/strength/{TodayPlanCard,SessionTable,ExerciseTrendCard,VolumeTrendCard,PRList,DateNavigator,StrengthNav}.tsx` — kept; restyled in soft-light. `StrengthNav` becomes `RangePills`-style.
- `components/profile/{ProfileForm,BaselinesPanel,IngestPanel,BackfillButton}.tsx` — kept; restyled.
- All `lib/coach/*`, `lib/whoop.ts`, `lib/withings.ts`, `lib/withings-merge.ts`, `lib/anthropic/*`, `lib/data/types.ts`, `lib/time.ts`, `lib/ui/score.ts` — untouched.

## Page layouts

### `/` — Today (dashboard)

After the 2026-05-05 cleanup, the dashboard is a readout. New layout:

1. **Header.** Page title `Today` (h1), subtitle `Tuesday, May 5` (caption, from `formatHeaderDate()`), avatar circle with first-initial gradient on the right.
2. **`WeekStrip`** — 7 days, today highlighted. Tapping a day routes to `/?date=YYYY-MM-DD` and slides to that day's data.
3. **`ReadinessHero`** — solid blue card. `Readiness` label, big `87/100`, `Primed` pill, one-line subtitle ("HRV elevated, RHR low — green light").
4. **`MetricCard` 2×2 grid** — HRV, Resting HR, Sleep, Strain. Each card: icon chip (per-metric color), label, big value with unit, delta vs. 7-day avg.
5. **Optional `MetricCard` row** for body-comp (Weight + Body Fat) — visible only when Withings has fresh data.
6. **`ImpactDonut`** — relocated below the metric grid, framed as `Card` with heading `What moved your score`. Existing impact decomposition logic unchanged.
7. **`CoachCard`** — thumbnail (gradient square with mode icon) + headline (today's plan) + meta (`Coach · 2 min read`). Tap → `/coach`. When chat coach lands, this becomes the chat-entry card.
8. **Recent lifts** card — `Card` with section heading `Recent lifts` and a 2-row preview of the last two strength sessions (date · session-type · total volume), chevron CTA → `/strength?view=recent`. Visible whenever any session exists in the last 14 days; otherwise replaced with a muted "No recent sessions" placeholder. This is the on-page entry point to `/strength` (since it isn't a bottom-nav tab).
9. **`WeeklyRollups`** — last; `Card` containing two `LineChart` minis (HRV trend, sleep trend) for the 7-day window.

The pre-cleanup MorningCheckIn block, the bundled session-plan card — gone. The donut moves out of hero position because `ReadinessHero` is a clearer anchor for the soft-light language; the donut becomes the explanation, not the headline.

### `/log`

Just the morning check-in, plus context.

1. **Header.** `Log`, subtitle date, ⋯ menu.
2. **`WeekStrip`.**
3. **Already-logged-today chips** (2-up grid of `MetricCard` compact, "STEPS / CALORIES" or whatever is auto-ingested for the selected date — read-only confirmation that data flowed in).
4. **Morning check-in form** — restyle of the existing `components/log/LogForm.tsx` (which is the form `/log` already uses; the dashboard's `MorningCheckIn.tsx` was a duplicate and has been deleted as of the 2026-05-05 cleanup).
   - Readiness 1–10 grid: ten square buttons in a single row, active = `accent` background + white number.
   - Energy: 3-button pill row (Low / Med / High).
   - Mood: 4-button emoji row.
   - Soreness text input (full width).
   - Notes text input (full width).
   - Save button (full width, `accent` background).

The "Today's session" gradient card that the previous mockup showed on /log is **dropped** — the dashboard cleanup moved that card to `/strength?view=today`. /log is the form alone.

### `/trends`

Compact-card, data-dense, sticky `RangePills` at top.

1. **Header.** `Trends`, subtitle `Last 30 days` (or current range).
2. **`RangePills`** — 7D / 30D / 90D / 1Y. Default `30D`. URL: `?range=30d`.
3. **Compact `MetricCard` stack** — one card per metric, full-width. Each card: header row (icon + name + period | value + delta), then `LineChart` mini below. Order: HRV, Resting HR, Sleep, Strain, Weight, Body Fat (driven by `lib/ui/colors.ts FIELDS` order, filtered by data availability).
4. **Tap any compact card → metric detail page.** New route `/trends/[metric]` (or modal if route-explosion is a concern). Detail page: hero value + delta-vs-prior, full `RangePills`, `LineChart` detail (with gridlines + axis labels), Min/Avg/Max stats grid, optional insight card.

Decision: **route, not modal.** Linkable, refreshable, screen-reader-friendly. Implementation note: `/trends/[metric]/page.tsx` reads the metric key from the dynamic segment, validates against `DailyLogKey` union, 404s on unknown.

### `/strength`

Sub-nav stays (already shipped today). Three views.

**Sub-nav:** existing `StrengthNav` restyled to match `RangePills` (pill row). Order: `Today · Recent · By date`.

**`view=today`:**
1. Header.
2. **`TodayPlanCard`** (already exists from 2026-05-05 cleanup) — restyled in new language: solid colored card whose color is mapped from the existing `IntensityMode.color` to a light-theme equivalent at render time (see mapping below). Heading `Lower body / Push`, mode-status pill, plain-text mode description, full exercise list (no `slice(0,6)` cap — preserved from cleanup).
3. **(no form, no save, no CTA)** — read-only by design.

**Intensity-mode color mapping.** `lib/coach/readiness.ts:getIntensityMode()` is **not** modified — it stays a pure logic function. Instead, a new helper `lib/ui/theme.ts:modeColorLight(hex: string)` translates each existing dark-theme hex to its light-theme equivalent at render time:

| `IntensityMode.label` | Existing `color` | Light-theme equivalent |
|---|---|---|
| ⚡ PUSH HARD | `#30d158` | `COLOR.success` (`#14b870`) |
| 🟢 FULL SESSION | `#86efac` | `#34d399` (lighter success) |
| 🟡 MODERATE | `#ffd60a` | `COLOR.warning` (`#f59e0b`) |
| 🔴 LIGHT / RECOVERY | `#ff453a` | `COLOR.danger` (`#ef4444`) |
| ⚫ REST DAY | `#6b7280` | `COLOR.textMuted` (`#7a7e95`) |

The mapping is a switch on the input hex; an unrecognized hex falls back to `COLOR.accent`. Every consumer of `mode.color` (currently just `TodayPlanCard`) calls `modeColorLight(mode.color)` at the render site.

**`view=recent`:**
1. Header.
2. `RangePills`: 7D / 30D / 90D / All.
3. **Volume hero** — amber/orange gradient `Card` (`SHADOW.heroAmber`), label `TOTAL VOLUME · 30D`, big value `42.8k kg`, meta row (sessions count, exercises count, % delta vs prior period).
4. **Top lifts** — section heading `Top lifts · trend`. List of `nested` `Card`s (radius 14px), each with lift name, current 1RM-est value, PR pill, mini `LineChart` line color `#b45309` (the strain/strength amber from `METRIC_COLOR`).
5. **Recent sessions** — section heading `Recent sessions`. List of `nested` `Card`s: date+session-type on left, total volume on right, lift-name chips below.

**`view=date`:**
1. Header.
2. `DateNavigator` (existing) restyled.
3. Single session detail (existing `SessionTable`) restyled — table with set-by-set rows, weight + reps, RPE chips.

### `/coach`

Until chat coach lands, this remains the existing insights/recommendations page, restyled.

1. Header. `Coach`, subtitle date.
2. **`CoachNav`** restyled — pill row mirroring `StrengthNav`. Tabs: `Today · Recommendations · Weekly · Strength`.
3. Tab content unchanged in logic (`InsightsList`, `RecommendationsList`, `WeeklyReview`) — re-skinned as `Card` + `Pill` primitives.

When chat coach V1 lands (per `2026-05-04-chat-coach-design.md`), this page becomes the chat surface. The redesign already establishes the visual primitives the chat will inherit (Card, Pill, type tokens), so the chat plan needs no redesign work — it gets the new look automatically.

### `/profile`

iOS-settings pattern in soft-light. Sectioned vertical stack.

1. Header. `Profile`, subtitle `Account & integrations`, ⚙ icon top-right.
2. **User card** — large `Card` with avatar circle, name, email, chevron. Tap → edit (existing `ProfileForm` flow restyled).
3. **Section: Connected sources** — vertical list of `IntegrationRow`. Status uses `● Connected · synced 8 min ago` (success dot) or `○ CSV upload · last import Apr 30` (muted). Manage CTA per row routes to existing flows.
4. **Section: Baselines** — `StatusRow` list (Resting HR baseline, HRV baseline, Target weight). Tap → existing `BaselinesPanel` flows restyled.
5. **Section: Ingest tokens** — `StatusRow` list per source (Apple Health, Yazio, Strong). Tap → existing `IngestPanel` flow.
6. **Section: Account** — `StatusRow` (Privacy & data → `/privacy`), `StatusRow` (Sign out, danger color).

### `/login`

Existing flow restyled in light theme. Single `Card` centered (mobile: full-width with margins; desktop: max-width `360px` centered). Magic-link / OAuth buttons restyled as `accent` primary buttons. No structural change.

### `/privacy`

Re-skin only — long-form prose page in light theme. Body uses `body` token; headings use `h2`/`h1`. Wrapped in a max-width container (`max-w-prose`).

## Charts

Consolidated chart language — every chart in the app uses one of these.

**`LineChart` (component spec):**

- **Path geometry.** Cubic-Bézier with horizontal-control smoothing: for each segment from P_i to P_{i+1}, control points C1 = (P_i.x + dx/2, P_i.y), C2 = (P_{i+1}.x − dx/2, P_{i+1}.y). Equivalent to "monotone" smoothing in Recharts terms; can be rendered manually in SVG to avoid Recharts dependency.
- **Area fill.** Same path closed at the bottom (`L width height L 0 height Z`), filled with linear gradient from line color at 22% opacity (top) to 0% (bottom).
- **Stroke.** Line color from `METRIC_COLOR[key]`, width 2px (`mini`) / 2.5px (`detail`), `stroke-linecap:round`, `stroke-linejoin:round`.
- **Last-point dot.** White-fill, 2px stroke in line color, radius 3px (`mini`) / 4px (`detail`). Marks current value.
- **Gridlines.** None on `mini`. Three horizontal dashed lines at 25%/50%/75% of vertical range on `detail`, `divider` color, `stroke-dasharray:2,3`.
- **Axis labels.** None on `mini`. Four evenly-spaced date labels below `detail`, `caption` token.
- **Tooltip-on-tap.** Vertical guide line (`textStrong` 18% opacity, dashed), bigger circle marker on the line, dark pill above with date + value. Implemented with pointermove/touch events; not always-visible.

**`RangePills`:** flex-1 row of 4 pills, active = solid `accent` with `SHADOW.heroAccent`, inactive = white surface with `SHADOW.card`. Pill labels: `7D`, `30D`, `90D`, `1Y` (or custom for /strength: `7D`, `30D`, `90D`, `All`).

**No bar charts, no candlesticks, no scatter.** If a future metric truly needs a bar (e.g. weekly session count), it gets a follow-up spec — out of scope here.

## Mobile vs desktop

PWA-first; desktop secondary. Two breakpoints matter:

- `< md` (mobile, default) — bottom nav + FAB, single-column layout, full-width cards.
- `≥ md` (≥768px) — `BottomNav` hides; `TopNav` appears (sticky top). Layouts gain breathing room: `/trends` becomes a 2-column grid of compact metric cards, `/` becomes a 2-column grid (left = readiness hero + impact donut; right = metric cards + coach + rollups). Charts get more horizontal space (height capped at 200px for `detail`).

The FAB does not render on desktop. Equivalent actions move into a single `+ New` button on the right side of `TopNav` that opens the same `FabSheet` as a popover anchored to the button. Per-page primary buttons (Save check-in on `/log`, etc.) remain inline as on mobile.

## What this redesign does NOT change

- Database schema, RLS, migrations
- Sync routes (`/api/whoop/*`, `/api/withings/*`, `/api/ingest/*`)
- Coach pure-function modules (`lib/coach/*`)
- Anthropic client and prompt construction (`lib/anthropic/*`, `lib/coach/snapshot.ts`, `lib/coach/prompts.ts`)
- `lib/data/types.ts` — row shapes
- `lib/time.ts` — tz logic untouched
- ISR cadence (`export const revalidate = 60`)
- Vercel cron schedule
- Number formatting via `fmtNum()` — every visible number still flows through it (CLAUDE.md rule)

## Build sequence

Five slices, each independently shippable as a PR.

**Slice 1 — Tokens + base components.** Add `lib/ui/theme.ts`. Update `app/globals.css` with Tailwind v4 `@theme` tokens. Update `lib/ui/colors.ts` `METRIC_COLOR` for light theme. Build `Card`, `Pill`, `StatusRow`, `MetricCard`, `LineChart` primitives. No page changes yet — render a `/dev/tokens` ghost page that previews every primitive in isolation, deleted before the slice merges.

**Slice 2 — Navigation chrome.** Build `BottomNav`, `Fab`, `FabSheet`, `TopNav`, `WeekStrip`. Wire into `app/layout.tsx`. Delete `components/layout/TabNav.tsx`. Verify all 6 routes still render and navigate; no per-page restyling yet.

**Slice 3 — Dashboard `/`, `/log`, `/profile`.** Apply the new layouts. Build `ReadinessHero`. Restyle `MorningCheckIn` form. Restyle `ConnectionsPanel`/`BaselinesPanel`/`IngestPanel`. Delete `DashboardDatePager`.

**Slice 4 — `/trends` + `/strength`.** Replace `LineChart` callers with the new component. Add `/trends/[metric]/page.tsx` for detail view. Restyle `StrengthNav` (already 3 views), `TodayPlanCard`, `VolumeTrendCard`, `PRList`, `SessionTable`, `DateNavigator`. Delete `MetricBar`, `SparkLine`, `BarChart`, `Gauge` if unused.

**Slice 5 — `/coach` + `/login` + `/privacy` + cleanup.** Restyle remaining pages. Delete any orphaned components. Final pass: `npm run typecheck` clean, every page exercised manually in mobile + desktop viewports.

Slices can ship in this order; later slices don't break if earlier ones aren't deployed (e.g. a new `BottomNav` doesn't require Slice 3 layouts — old pages will continue to render with the new shell).

## Risks acknowledged

- **`ReadinessHero` replaces `ImpactDonut` as the primary anchor.** The donut becomes secondary. If you actually rely on the donut for "what's pulling score up/down" at a glance, the new placement is one scroll-tap away. Escape valve: a follow-up spec can promote the donut back to hero — the visual primitives don't constrain the order.
- **No dark mode.** Single user, single theme. If the user later wants both, the token model supports it (swap a CSS-variable layer), but no work is done here.
- **Bottom nav vs. iOS safe area.** The PWA already handles safe-area insets in `app/layout.tsx`; `BottomNav` must include `padding-bottom: env(safe-area-inset-bottom)` so it doesn't sit under the home indicator.
- **Chart paths hand-rolled in SVG.** Avoiding a charting library (Recharts/Visx) keeps the bundle small and the visuals exact. The cost: the smoothing math, hover handling, and tooltip positioning are this codebase's responsibility. Acceptable — chart count is small, behavior is uniform.
- **Existing branches touch overlapping code.** `claude/v2-ui-shell`, `claude/v3-impact-donut`, `claude/v3-perf-pwa`, `claude/expanded-readiness-score` all exist. The redesign should land before these branches re-merge or be coordinated with them — otherwise visual restyling collides with their structural changes. Suggest closing or rebasing those branches before Slice 1 lands.

## Verification

No test suite (per CLAUDE.md). Manual verification per slice + at the end:

- `npm run typecheck` clean
- Every page renders on mobile (Safari iOS PWA) and desktop (Chrome) with no console errors
- Every visible number passes through `fmtNum()` (grep for `.toFixed`, `String(` outside fmtNum to confirm none leaked)
- Bottom nav on mobile: tap each tab, confirm route + active state
- FAB on mobile: tap `+`, sheet opens, each action routes correctly
- Top nav on desktop: visible at ≥768px width, bottom nav hidden
- Week strip: today highlighted; tapping any day updates URL `?date=` and re-renders
- Range pills on `/trends` and `/strength`: selecting changes URL and chart range
- `/strength?view=today` shows full exercise list (not capped at 6)
- `/log` save still updates dashboard score (round-trip preserved)
- Coach insights regenerate with new visual but same content (cache key unchanged)
- Force-tz dev (`USER_TIMEZONE=America/Los_Angeles npm run dev`) — week strip and header date both reflect the override
- Lighthouse on `/`: visual-completeness regression check, performance budget unchanged

## Out of scope

- Animations / motion design (subtle defaults only — no orchestrated transitions)
- Empty/error/loading state design system (separate spec; this design uses sensible defaults)
- Accessibility audit / WCAG conformance review (separate spec)
- Dark theme
- Settings to toggle anything design-related (font size, density, color scheme)
- Onboarding redesign (existing `/login` flow restyled, not redesigned)
- Notification design (push, email — neither exists yet)
- Analytics / telemetry
- Internationalization
