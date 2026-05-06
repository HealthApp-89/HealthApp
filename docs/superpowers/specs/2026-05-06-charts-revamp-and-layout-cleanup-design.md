# Charts revamp + layout chrome cleanup — design

- **Date:** 2026-05-06
- **Branch base:** `redesign/v1`
- **Status:** Draft — awaiting user review
- **Successor to:** [2026-05-05-app-redesign-design.md](./2026-05-05-app-redesign-design.md), specifically supersedes locked decision #6 (chart language) with the changes below.

## Goal

Make the charts on `/`, `/trends`, `/trends/[metric]`, `/strength` feel like a polished health-data product instead of a stock SVG sparkline. Two related fixes ship together:

1. **Chart visual revamp** — comparison line vs. prior period, point markers per value, visible y-axis labels, richer area fill, gap interpolation with a clear "estimated" treatment.
2. **Layout chrome cleanup** — remove the floating chat bubble (redundant with the Coach tab and obscures bottom-of-page chart content) and fix the body bottom-padding so charts at the page bottom are no longer clipped under the nav.

These ship together because the chart redesign is not visually verifiable while the bottom 4–80px of every page is hidden under fixed UI.

## Non-goals

- **`ImpactDonut`** — separate component, separate concern, not where the complaint lives.
- **Chart library migration** (Recharts/Visx/Chart.js) — current hand-rolled SVG works and is stylable; introducing a dep would balloon the bundle without solving the actual asks.
- **Chat panel UX changes** — only the entry-point affordance moves; the panel itself is unchanged.
- **Non-line chart types** (heatmaps, dot plots, candle).
- **Desktop layout (`md:`)** — current breakpoint behavior preserved; this work is mobile-PWA-first.

## Decisions (locked in 2026-05-06 brainstorm)

| # | Decision | Locked |
|---|----------|--------|
| D1 | Chart direction | Adopt comparison line, point markers per value, y-axis labels, richer fill, legend |
| D2 | Gap rendering | Dashed line across gap, fill continuous, hollow markers on estimated points |
| D3 | Interpolation method | Linear |
| D4 | Per-metric opt-in | Interpolate `hrv`, `resting_hr`, `recovery`, `sleep_*`, `weight_kg`, `body_fat_pct`, `fat_mass_kg`, `fat_free_mass_kg`, `muscle_mass_kg`. **Never** `steps`, `calories`, `active_calories`, `distance_km`, `exercise_min`, `strain` |
| D5 | Max gap before bailing | 3 days for daily physiology, 14 days for body composition |
| D6 | Tooltip semantics | Show interpolated value with `(est.)` suffix in `COLOR.textFaint` |
| D7 | Comparison semantics | Calendar prior period (current 30D vs. the 30D before it, mapped to same x-axis) |
| D8 | Comparison on minis | Detail-only — minis stay single-line + last-point dot |
| D9 | Detail card chrome | **Two-row** chrome: row 1 = title + inline legend chips, row 2 = range pills (right-aligned). No menu icon. (Two rows because at 360px the combined width overflows.) |
| D10 | Scope of revamp | Dashboard `MetricCard` sparklines, `/trends` overview, `/trends/[metric]` detail, `/strength` `VolumeTrendCard`, `ExerciseTrendCard`, PR sparklines |
| D11 | Comparison fallback | If prior-period coverage < 50% (fewer than half the days have any data), suppress the comparison line + drop its legend chip — chart looks the same as today's |
| F1 | `ChatBubble` | Remove globally. Add "Ask coach" item to `Fab` sheet that opens the same `ChatPanel` |
| F2 | Body bottom padding | Bump from `76px` to `92px` of nav reservation |
| F3 | Coupling | Extract `--nav-h` CSS variable in `globals.css`; reference from body padding |
| F4 | Bundling | Both fixes ship in a single spec/PR off `redesign/v1` |

## Design

### Section 1 — `LineChart` API

[components/charts/LineChart.tsx](../../../components/charts/LineChart.tsx) gets the following additions; existing props are preserved.

```ts
type LinePoint = {
  x?: string;                 // unchanged
  y: number | null;           // unchanged
  estimated?: boolean;        // NEW — set by the interpolation helper
};

type LineChartProps = {
  data: LinePoint[];
  color: string;
  variant?: "mini" | "detail";
  width?: number;
  height?: number;
  xAxisLabels?: [string, string, string, string];

  // NEW
  comparison?: LinePoint[] | null; // same length & x-alignment as `data`
  yAxisLabels?: boolean;           // detail variant only; default true
  pointMarkers?: boolean;          // detail variant only; default true
};
```

**Render contract:**

- **Mini variant** ignores `comparison`, `yAxisLabels`, `pointMarkers` even if passed (render unchanged: smooth line, last-point dot, richer 3-stop fill — see §3).
- **Detail variant** renders, in z-order: gridlines → comparison line (faint gray dashed, no fill, no markers) → primary area fill → primary line (with dashed segments where `data[i].estimated === true` between two known endpoints) → point markers (filled circles for real values, hollow + dashed-stroke for estimated values, larger emphasized dot for the last real value) → y-axis labels in a 24px left gutter.
- **Tooltip overlay** (existing HTML overlay) gains a small `(est.)` suffix in `COLOR.textFaint` when hovering an estimated point.
- **Hover guide** also draws a horizontal slice through the comparison line's value at the hovered x, with both values stacked in the tooltip:
  ```
  May 4
  68 ms          ← primary, in metric color
  62 ms (prev)   ← comparison, in COLOR.textFaint
  ```

### Section 2 — Comparison line semantics

The comparison line is the same metric, same number of points, shifted backwards by one window-length.

- **Window mapping.** `current = [from, to]`, `prior = [from − Δ, to − Δ]` where `Δ = (to − from) + 1 day` (the prior window ends the day before the current window starts).
- **Index alignment.** `current[i]` and `prior[i]` are plotted at the same x-position. `i = 0` is the oldest day in each window.
- **Per-range examples** (today = 2026-05-06):
  - `7D`: current `2026-04-30..2026-05-06`, prior `2026-04-23..2026-04-29`.
  - `30D`: current `2026-04-07..2026-05-06`, prior `2026-03-08..2026-04-06`.
  - `YTD`: 126-day current window, prior is the 126 days ending `2025-12-31`.
  - `1Y`: current = 365 days ending today, prior = the preceding 365 days.
- **Aggregation parity.** `comparisonSeries` runs through the same `pickGranularity` + `aggregateSeries` path used for the current window so both arrays have identical bucket sizes (daily for 7D/30D, weekly for YTD/1Y, etc.). Without parity the indices wouldn't align visually.
- **Interpolation does NOT apply to the comparison line.** It's reference data. Gaps in the prior period are rendered as gaps. The dashed-gray styling already reads as "approximate context"; we don't compound the indirection.
- **Coverage gate** (D11): if fewer than 50% of buckets in the prior window have any data for the metric, the comparison series is `null` and the chart renders without it. No empty state — the absence is self-explanatory in a chart with no second line.

### Section 3 — Gap interpolation

New module: `lib/charts/interpolate.ts`

```ts
type InterpolateConfig = {
  /** if true, fill null y-values when the gap (consecutive nulls between two
   *  known endpoints) is ≤ maxGapDays. Otherwise leave as null. */
  enabled: boolean;
  /** inclusive — gaps strictly larger than this remain null */
  maxGapDays: number;
};

/** Returns a new array; original is not mutated. Each filled point has
 *  `estimated: true` set so the renderer can style it as dashed/hollow. */
export function interpolateGaps(
  series: LinePoint[],
  cfg: InterpolateConfig
): LinePoint[];
```

**Algorithm:** single-pass left-to-right.
1. Walk the series. When a `null` y is found, scan forward to find the next non-null endpoint.
2. **Gap length is measured in calendar days** computed from `LinePoint.x` (date string) of the bounding endpoints, NOT in array indices. This is necessary because aggregated views (YTD/1Y) bucket weekly — a 1-bucket gap = 7 days, not 1.
3. If the gap (in days) is ≤ `cfg.maxGapDays`, fill each null y with `lerp(prevY, nextY, t)` where `t = (currentDate − prevDate) / (nextDate − prevDate)`. Mark each filled point with `estimated: true`.
4. If the gap is at the start or end of the series (no left or right endpoint), leave as null — extrapolation is not in scope.
5. If the gap exceeds `cfg.maxGapDays`, leave as null.

**Date requirement.** Interpolation requires `LinePoint.x` to be a parseable date. If `x` is missing for any point in the series, `interpolateGaps` returns the series unchanged (fail-closed). Mini sparklines today often pass dateless points; they're already configured `enabled: false` for non-eligible metrics, and the eligible-metric mini sparklines on `/` (`MetricCard`) already pass dates through.

**Per-metric config** lives in a new module: `lib/charts/metricChartConfig.ts`.

```ts
export const METRIC_CHART_CONFIG: Record<string, InterpolateConfig> = {
  hrv:                { enabled: true,  maxGapDays: 3  },
  resting_hr:         { enabled: true,  maxGapDays: 3  },
  recovery:           { enabled: true,  maxGapDays: 3  },
  sleep_hours:        { enabled: true,  maxGapDays: 3  },
  sleep_score:        { enabled: true,  maxGapDays: 3  },
  deep_sleep_hours:   { enabled: true,  maxGapDays: 3  },
  rem_sleep_hours:    { enabled: true,  maxGapDays: 3  },
  weight_kg:          { enabled: true,  maxGapDays: 14 },
  body_fat_pct:       { enabled: true,  maxGapDays: 14 },
  fat_mass_kg:        { enabled: true,  maxGapDays: 14 },
  fat_free_mass_kg:   { enabled: true,  maxGapDays: 14 },
  muscle_mass_kg:     { enabled: true,  maxGapDays: 14 },
  // explicit opt-out
  steps:              { enabled: false, maxGapDays: 0 },
  calories:           { enabled: false, maxGapDays: 0 },
  active_calories:    { enabled: false, maxGapDays: 0 },
  distance_km:        { enabled: false, maxGapDays: 0 },
  exercise_min:       { enabled: false, maxGapDays: 0 },
  strain:             { enabled: false, maxGapDays: 0 },
};
```

Defaults for unlisted metrics: `{ enabled: false, maxGapDays: 0 }` (fail-closed — new metrics need an explicit decision before they interpolate).

**Notable fail-closed metrics** (have data, currently NOT interpolating because they weren't part of the locked D4 set):
- `spo2`, `skin_temp_c` — physiology, plausibly opt-in candidates in a future round.
- `hydration_kg`, `bone_mass_kg` — body composition siblings of the listed Withings metrics.

These render with true gaps today; opt them in via a one-line config edit when desired. Listed here so a future reviewer doesn't assume they were missed.

### Section 4 — Visual treatment changes inside `LineChart`

| Element | Current | New |
|---------|---------|-----|
| Area fill gradient | 2-stop `color@22% → color@0` (mini), `color@28% → color@0` (detail) | 3-stop `color@38% → color@10%@60% → color@0%@100%` (mini), `color@32% → color@0%` with denser top-band (detail) |
| Reference lines (detail) | 3 dashed lines at y = 25%, 50%, 75% of plot — purely decorative | 4 solid `#eef0f6` gridlines aligned with the 4 y-axis tick values |
| Y-axis labels | None | Detail-only; **4 evenly-spaced ticks** across the padded range. Concretely, given the existing 12% y-padding (`valMin = dataMin − 0.12·dataRange`, `valMax = dataMax + 0.12·dataRange`), tick values are `valMax`, `valMax − r/3`, `valMax − 2r/3`, `valMin` (where `r = valMax − valMin`), each formatted by `fmtNum()`. **Rendered as absolutely-positioned HTML `<span>`s** (not SVG `<text>`) so they aren't horizontally distorted by the chart's existing `preserveAspectRatio="none"` stretch — same pattern the tooltip already uses. The wrapper gets `padding-left: 24px` to reserve the gutter; SVG plot area is unchanged inside. Gridlines render in SVG at the same y-fractions. |
| Point markers (detail) | Last point only | All real values: filled white circle, 3px radius, 2px metric-color stroke. Estimated values: white circle, 2px radius, 1.5px metric-color stroke, dashed stroke. Last real value: 5px filled white, 2.75px stroke (emphasized "now" dot). |
| Point markers (mini) | Last point only | **Unchanged** — single emphasized last-point dot |
| Comparison line | None | Detail-only; faint `#cdd1de`, 2px stroke, dashed `4,3` |
| Card chrome | Bare label above chart | Detail-only; **two-row** layout — top row: title + inline legend chips (left). Second row: `RangePills` (right-aligned). Two rows because at 360px viewport widths the combined width of HRV-style legend chips + 4 range pills would otherwise force overflow / crammed wrap. Gap between rows: 8px. |

### Section 5 — Layout chrome cleanup

**F1 — Remove `ChatBubble` globally; add "Ask coach" to FAB sheet; preserve auth-gating via a new `FabGate`.**

- Delete [components/chat/ChatBubble.tsx](../../../components/chat/ChatBubble.tsx) and [components/chat/ChatBubbleGate.tsx](../../../components/chat/ChatBubbleGate.tsx).
- Remove `<ChatBubbleGate />` from [app/layout.tsx](../../../app/layout.tsx).
- **State location.** [components/layout/Fab.tsx](../../../components/layout/Fab.tsx) is already a client component with `useState(open)` for the sheet. Add a sibling `useState(chatOpen)`. Render order inside `Fab`:
  1. The `+` button (existing).
  2. `{open && <FabSheet onClose={...} onAskCoach={() => { setOpen(false); setChatOpen(true); }} />}`.
  3. `{chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}` — same dynamic import that `ChatBubble` used today.
- **Sheet item ordering** (the `ITEMS` array in `FabSheet`): `Log entry`, `Ask coach` (new), `Strength`, `Upload Strong CSV`, `Manage connections`. Coach sits second because it's the most-used surface after logging.
- **`Ask coach` item shape** — distinct kind from `link` and `upload` so the click handler invokes `onAskCoach` instead of navigating:
  ```ts
  | { kind: "chat"; label: "Ask coach"; icon: "💬" }
  ```
- **`FabGate` (new, server component).** Replaces `ChatBubbleGate`'s role for the FAB. Mirrors its pattern: server-side auth check, `if (!user) return null;`, otherwise render `<Fab />`. [app/layout.tsx](../../../app/layout.tsx) imports `<FabGate />` instead of `<Fab />`. Side benefit: fixes the pre-existing minor UX bug where unauthenticated users on `/login` see a `+` button to nowhere.

**F2 + F3 — Body bottom padding via `--nav-h`.**
- In [app/globals.css](../../../app/globals.css):
  ```css
  :root {
    --nav-h: 92px;          /* mobile bottom-nav reservation */
  }
  @media (min-width: 768px) {
    :root { --nav-h: 0px; }  /* desktop uses TopNav, no bottom reservation */
  }
  ```
- In [app/layout.tsx](../../../app/layout.tsx) body className: replace
  ```
  pb-[calc(env(safe-area-inset-bottom)+76px)] md:pb-[env(safe-area-inset-bottom)]
  ```
  with
  ```
  pb-[calc(env(safe-area-inset-bottom)+var(--nav-h))]
  ```
  The `md:` override falls out of the responsive `--nav-h` redefinition.
- `BottomNav` itself is unchanged — its `bottom: safe + 8` and intrinsic content height (~70px) sit comfortably inside the 92px reservation with the 14px breathing room we picked.

## Files to create / modify

**Create:**
- `lib/charts/interpolate.ts`
- `lib/charts/metricChartConfig.ts`
- `lib/charts/comparisonSeries.ts` — server-side helper that, given the current period series and `(period, metric)`, fetches the same metric for the prior period from `daily_logs` (running through the same `pickGranularity` + `aggregateSeries` path), applies the 50%-coverage gate, and returns `LinePoint[] | null`.
- `components/layout/FabGate.tsx` — server component, auth-checks then renders `<Fab />`.

**Modify:**
- `components/charts/LineChart.tsx` — new props, gridlines, y-axis labels, comparison line render, dashed-segment handling, hollow-marker handling, tooltip "(est.)" suffix + comparison value line.
- `components/charts/MetricCard.tsx` — adopt the new 3-stop fill (no API change needed since it just renders `LineChart variant="mini"` which inherits the gradient change).
- `app/trends/[metric]/page.tsx` — fetch prior period, pass `comparison` to `LineChart`. Keep `xAxisLabels` integration.
- `app/trends/page.tsx` — no comparison data, but bump card chrome consistency if needed (mini variant only).
- `components/strength/VolumeTrendCard.tsx`, `components/strength/ExerciseTrendCard.tsx`, and any other strength sparkline consumers — confirm they pass through `LineChart` cleanly with the new gradient. Implementation step: grep for `LineChart` imports under `components/strength/` and audit each. No comparison line needed for any of them (D8 — minis are single-line).
- `app/layout.tsx` — replace `<ChatBubbleGate />` with `<FabGate />`; remove the standalone `<Fab />` import (now wrapped); update body className.
- `app/globals.css` — add `--nav-h` token.
- `components/layout/Fab.tsx` — extend `SheetItem` union with `"chat"` kind; thread `onAskCoach` from `FabSheet` up to `Fab`; mount `ChatPanel` conditionally at the `Fab` level.

**Delete:**
- `components/chat/ChatBubble.tsx`
- `components/chat/ChatBubbleGate.tsx`

**Untouched but relevant:**
- `components/chat/ChatPanel.tsx` — reused as-is by the new FAB sheet entry.
- `components/dashboard/ImpactDonut.tsx` — not in scope.

## Test plan

No unit tests are configured. Verification is `npm run typecheck` + manual mobile-viewport pass:

1. **Charts — happy path.** Open `/trends/[metric]` for HRV with full 30-day data → see comparison line + point markers + y-axis labels + legend + range pills.
2. **Charts — gap interpolation.** Manually `update daily_logs set hrv=null where date in ('2026-04-26','2026-04-27');` then reload → confirm dashed segment between Apr 25 and Apr 28, hollow markers on the two interpolated days, hover shows "(est.)".
3. **Charts — gap too long.** Null 5 consecutive HRV days → confirm true gap (no dashed segment), no hollow markers.
4. **Charts — non-interpolating metric.** Same null treatment on `steps` → confirm true gap, no interpolation.
5. **Charts — short prior coverage.** Open `/trends/[metric]` for `weight_kg` with < 50% prior-period coverage → confirm no comparison line, no second legend chip, no error.
6. **Charts — minis unchanged.** Open `/` → confirm `MetricCard` sparklines still single-line + last-point dot, just with a slightly more saturated fill.
7. **Layout — clipping fix.** Scroll any page (`/trends` is the densest) to the bottom → confirm last card's bottom edge is fully visible above the nav, with breathing room.
8. **Layout — chat removed.** Open `/` → no purple bubble. Tap FAB `+` → "Ask coach" item present, second from top. Tap → chat panel opens. Close → returns to dashboard.
9. **Layout — desktop.** Resize to ≥ 768px → bottom-nav hidden, body padding-bottom is just safe-area inset (no 92px addition).

## Risks & mitigations

- **`--nav-h` drift** — if someone changes `BottomNav` content height without updating `--nav-h`, padding goes stale again. Mitigation: comment in `globals.css` referencing the BottomNav file and the rendered-height math; comment in `BottomNav.tsx` referencing the var.
- **Comparison-line query cost** — doubling the date range fetch on `/trends/[metric]`. Mitigation: same cached Supabase query path, just an additional date-range filter; the current page is `revalidate=60` so worst case is one extra query per minute per metric.
- **Backfill horizon** — users newly connected to WHOOP may not have prior-period data for any range. D11's coverage gate handles this; no error path needed.

## Out of scope (deferred)

- Coach-driven annotations on charts (e.g., "training block changed Apr 14")
- Per-user preference for comparison semantics (calendar vs DoW vs rolling)
- `/trends` overview comparison line (would require minis to grow taller)
- Donut chart revisit
- Auto-hide-on-scroll for the bottom nav
