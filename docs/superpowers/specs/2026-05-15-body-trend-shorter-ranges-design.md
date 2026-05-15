# Body trend — shorter ranges + custom

**Status:** designed, pending implementation
**Surface:** `/health?view=trend` ([components/health/TrendView.tsx](../../../components/health/TrendView.tsx))

## Problem

The Body tab's Trend view currently exposes only `3M / 6M / 1Y / All`. The shortest available window is 90 days, which is coarse for watching a cut, a deload, or a fresh measurement land. The user wants tighter windows and the ability to pick an arbitrary range.

## Design

### Pill set

Replace the current four-pill row with:

```
1W · 1M · 3M · 6M · 1Y · All · Custom
```

- WTD is intentionally not included — it overlaps 1W and adds a 7th non-custom pill that forces wrapping on mobile.
- Default selection stays `1Y` (current behaviour, no migration needed — `useState` lives in the component, not the URL).
- Pills render in the existing `Card`-less inline group; visual treatment unchanged (active = `COLOR.accent`, inactive = `COLOR.surfaceAlt`).

### Range definitions

| ID       | Label  | Cutoff (UTC days back from `todayIso`) |
|----------|--------|----------------------------------------|
| `1w`     | 1W     | 7                                      |
| `1m`     | 1M     | 30                                     |
| `3m`     | 3M     | 90                                     |
| `6m`     | 6M     | 180                                    |
| `1y`     | 1Y     | 365                                    |
| `all`    | All    | no cutoff                              |
| `custom` | Custom | user-picked `[from, to]`               |

`1M = 30 days` (not calendar month) keeps the cutoff math identical to the existing `RANGES` table — pure subtraction off `todayIso`.

### Custom UX

When `Custom` is tapped:

1. The pill row stays visible; the active pill is `Custom`.
2. A second row appears below the pills with two `<input type="date">` controls (`from`, `to`) and a small "×" reset button that flips selection back to `1Y`.
3. Defaults on first open: `from = today - 30d`, `to = today` — so the picker lands on a sensible window the user can adjust.
4. Both inputs are clamped: `from <= to <= today`. If the user picks an invalid pair, the later input snaps to satisfy the constraint (no error toast — the inputs themselves enforce it).
5. Filter logic: `point.date >= from && point.date <= to`. The current code only has a lower bound (`>= cutoff`); custom adds the upper bound.

### Sparse-data behaviour

Unchanged. Circumference measurements are monthly cadence, so `1W` and many `Custom` windows will show "Need ≥ 2 points" on those cards. That placeholder already exists in `Sparkline` and reads correctly; user has explicitly accepted this.

Body-comp cards (Withings, daily) work fine on `1W`.

### State shape

```ts
type RangeId = "1w" | "1m" | "3m" | "6m" | "1y" | "all" | "custom";

const [range, setRange] = useState<RangeId>("1y");
const [customFrom, setCustomFrom] = useState<string>(""); // YYYY-MM-DD
const [customTo, setCustomTo] = useState<string>("");
```

`customFrom` / `customTo` are seeded lazily when `range === "custom"` is first selected. They persist across pill toggles (so flipping `Custom → 1M → Custom` returns to the same window).

The `cutoff` `useMemo` is replaced by a `bounds: { from: string | null; to: string | null }` `useMemo` so both `BodyCompTrendCards` and `CircumferenceSparklines` filter against the same window-with-upper-bound.

### Files touched

- [components/health/TrendView.tsx](../../../components/health/TrendView.tsx) — only file. Change is local: extend `RANGES`, add custom-range state + UI, swap the cutoff filter for a from/to filter.

No DB, fetcher, query-key, or API changes. The `healthTrend` fetcher already returns the full series; filtering is purely client-side.

### Out of scope

- URL-persisted range (would need search-params wiring; not requested).
- WTD pill (rejected above).
- Calendar-month "1M" semantics (rolling 30 days is consistent with the existing scheme).
- Custom range as a modal/popover (inline inputs are lighter and match the pill rail's footprint).

## Validation

- `npm run typecheck` passes.
- Manual: load `/health?view=trend`, click each new pill, confirm body-comp sparklines redraw and circumference cards either redraw or show the placeholder. Custom: pick a 2-week window crossing a recent measurement, confirm the upper bound clips correctly.
