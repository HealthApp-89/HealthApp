# Body Trend — Shorter Ranges + Custom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Body tab Trend view's `3M / 6M / 1Y / All` pill set with `1W / 1M / 3M / 6M / 1Y / All / Custom`, where Custom exposes inline `from`/`to` date inputs.

**Architecture:** Single-file change in [components/health/TrendView.tsx](../../../components/health/TrendView.tsx). Filter logic extends from "lower-bound cutoff" to "from/to bounds" so the existing two card grids (body comp, circumferences) reuse the same windowing function. State lives in `useState` (not URL); custom dates persist across pill toggles. No DB, fetcher, query-key, or API changes.

**Tech Stack:** React (client component), TypeScript strict, no test suite per CLAUDE.md (verify with `npm run typecheck` + manual exercise).

**Spec:** [docs/superpowers/specs/2026-05-15-body-trend-shorter-ranges-design.md](../specs/2026-05-15-body-trend-shorter-ranges-design.md)

---

## File Structure

Only one file is touched. Both tasks land in the same component.

- **Modify:** `components/health/TrendView.tsx`
  - Task 1 extends the `RANGES` array (purely additive, two entries).
  - Task 2 adds the `Custom` range — new state, new bounds memo, new pill, and a conditional date-input row.

No new files, no extracted helpers (the date arithmetic is small enough to live inline).

---

## Task 1: Add 1W and 1M pills

This task is purely additive — extending the existing `RANGES` array. No type changes, no new state, no UI restructuring. Lands as a small, self-contained commit.

**Files:**
- Modify: `components/health/TrendView.tsx:11-16`

- [ ] **Step 1: Read the current `RANGES` definition**

Open [components/health/TrendView.tsx](../../../components/health/TrendView.tsx) and confirm lines 11–16 read:

```tsx
const RANGES = [
  { id: "3m",  label: "3M",  days: 90 },
  { id: "6m",  label: "6M",  days: 180 },
  { id: "1y",  label: "1Y",  days: 365 },
  { id: "all", label: "All", days: 0 },
] as const;
```

If they don't (e.g., a sibling change already extended this), reconcile before proceeding.

- [ ] **Step 2: Replace `RANGES` with the 6-entry preset list**

Replace lines 11–16 with:

```tsx
const RANGES = [
  { id: "1w",  label: "1W",  days: 7 },
  { id: "1m",  label: "1M",  days: 30 },
  { id: "3m",  label: "3M",  days: 90 },
  { id: "6m",  label: "6M",  days: 180 },
  { id: "1y",  label: "1Y",  days: 365 },
  { id: "all", label: "All", days: 0 },
] as const;
```

The `RangeId` derived type and the rest of the file pick up the new entries automatically (the type is `(typeof RANGES)[number]["id"]`). The default `useState<RangeId>("1y")` stays valid.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors. (If `RangeId` is referenced anywhere else with a hard-coded literal union, fix the reference — but the spec confirms the only consumer is local state.)

- [ ] **Step 4: Manual verification**

Run: `npm run dev`
Navigate to `/health?view=trend`. Confirm:
- Six pills render in order: `1W · 1M · 3M · 6M · 1Y · All`.
- Default selection is `1Y` (highlighted with `COLOR.accent`).
- Clicking `1W` filters the body-comp sparklines to the last 7 days. Circumference cards likely show "Need ≥ 2 points" — that's expected and accepted by the user.
- Clicking `1M` filters to the last 30 days.
- Clicking `3M` / `6M` / `1Y` / `All` still works as before.

If the pill row wraps on mobile width, that's fine — six pills + the row's `gap: 6px` should fit on a 390px viewport, but visual confirmation is the test.

- [ ] **Step 5: Commit**

```bash
git add components/health/TrendView.tsx
git commit -m "$(cat <<'EOF'
feat(health): add 1W and 1M pills to Trend view

Extends the Body tab Trend range options from 3M/6M/1Y/All to
1W/1M/3M/6M/1Y/All. Purely additive — RangeId widens automatically
from the const array.
EOF
)"
```

---

## Task 2: Add Custom range with inline date inputs

This task adds the seventh pill (`Custom`) and the conditional date-input row beneath it. Requires widening `RangeId` (Custom isn't in `RANGES`), adding two pieces of state, and replacing the lower-bound `cutoff` memo with a from/to `bounds` memo so both card grids apply the upper bound.

**Files:**
- Modify: `components/health/TrendView.tsx` (multiple locations — see steps)

- [ ] **Step 1: Widen `RangeId` to include `"custom"`**

Just below the `RANGES` const (current line 18), replace:

```tsx
type RangeId = (typeof RANGES)[number]["id"];
```

with:

```tsx
type RangeId = (typeof RANGES)[number]["id"] | "custom";
```

`useState<RangeId>("1y")` and existing pill click handlers stay valid because the literal `"1y"` still satisfies the widened union.

- [ ] **Step 2: Add `customFrom` / `customTo` state**

Below the existing `const [range, setRange] = useState<RangeId>("1y");` line, add:

```tsx
const [customFrom, setCustomFrom] = useState<string>("");
const [customTo, setCustomTo] = useState<string>("");
```

Both seeded empty; populated lazily in Step 6 when the user first clicks the `Custom` pill.

- [ ] **Step 3: Replace the `cutoff` memo with a `bounds` memo**

Locate the current `cutoff` memo (lines 31–37 of the original file):

```tsx
const cutoff = useMemo(() => {
  const r = RANGES.find((x) => x.id === range)!;
  if (r.days === 0) return null;
  const d = new Date(todayIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - r.days);
  return d.toISOString().slice(0, 10);
}, [range, todayIso]);
```

Replace it with:

```tsx
const bounds = useMemo<{ from: string | null; to: string | null }>(() => {
  if (range === "custom") {
    return { from: customFrom || null, to: customTo || null };
  }
  const r = RANGES.find((x) => x.id === range)!;
  if (r.days === 0) return { from: null, to: null };
  const d = new Date(todayIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - r.days);
  return { from: d.toISOString().slice(0, 10), to: null };
}, [range, customFrom, customTo, todayIso]);
```

Behaviour parity for non-custom ranges: `bounds.from` matches the old `cutoff` exactly; `bounds.to` is always `null` (no upper bound for presets). Custom branch yields whatever the user picked.

- [ ] **Step 4: Update the two filter memos to use `bounds`**

Replace the existing `filteredBodyComp` memo:

```tsx
const filteredBodyComp = useMemo(
  () => (cutoff ? bodyComp.filter((p) => p.date >= cutoff) : bodyComp),
  [bodyComp, cutoff],
);
```

with:

```tsx
const filteredBodyComp = useMemo(
  () =>
    bodyComp.filter(
      (p) =>
        (bounds.from == null || p.date >= bounds.from) &&
        (bounds.to == null || p.date <= bounds.to),
    ),
  [bodyComp, bounds],
);
```

Replace the existing `filteredMeas` memo:

```tsx
const filteredMeas = useMemo(
  () => (cutoff ? measAsc.filter((m) => m.measured_on >= cutoff) : measAsc),
  [measAsc, cutoff],
);
```

with:

```tsx
const filteredMeas = useMemo(
  () =>
    measAsc.filter(
      (m) =>
        (bounds.from == null || m.measured_on >= bounds.from) &&
        (bounds.to == null || m.measured_on <= bounds.to),
    ),
  [measAsc, bounds],
);
```

- [ ] **Step 5: Run typecheck after the state/memo refactor**

Run: `npm run typecheck`
Expected: exit 0. This is a good intermediate checkpoint — at this point the file compiles, presets still work identically, but `Custom` is unreachable from the UI (no pill yet).

- [ ] **Step 6: Add the `Custom` pill at the end of the pill row**

Locate the pill row (current lines 57–80, the `<div>` containing `RANGES.map(...)`). Immediately after the `})}` closing the `RANGES.map`, add a sibling `Custom` pill button inside the same parent `<div>`:

```tsx
<button
  type="button"
  onClick={() => {
    if (!customFrom) {
      const d = new Date(todayIso + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 30);
      setCustomFrom(d.toISOString().slice(0, 10));
    }
    if (!customTo) setCustomTo(todayIso);
    setRange("custom");
  }}
  style={{
    padding: "6px 10px",
    fontSize: "11px",
    fontWeight: 700,
    border: "none",
    borderRadius: RADIUS.pill,
    background: range === "custom" ? COLOR.accent : COLOR.surfaceAlt,
    color: range === "custom" ? "#fff" : COLOR.textMid,
    cursor: "pointer",
  }}
>
  Custom
</button>
```

The lazy-init guards (`if (!customFrom)` / `if (!customTo)`) ensure that toggling `Custom → 1M → Custom` returns to the same window the user last picked.

- [ ] **Step 7: Add the conditional date-input row beneath the pill row**

Locate the outer wrapper `<div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>` (current line 52). Inside it, after the closing `</div>` of the pill-row block (current line 81) and before `<BodyCompTrendCards .../>` (current line 83), insert:

```tsx
{range === "custom" && (
  <div
    style={{
      display: "flex",
      gap: "8px",
      alignItems: "center",
      justifyContent: "flex-end",
    }}
  >
    <input
      type="date"
      value={customFrom}
      max={customTo || todayIso}
      onChange={(e) => setCustomFrom(e.target.value)}
      style={{
        padding: "4px 8px",
        fontSize: "12px",
        border: `1px solid ${COLOR.surfaceAlt}`,
        borderRadius: RADIUS.sm,
        background: COLOR.surface,
        color: COLOR.textStrong,
        colorScheme: "dark",
      }}
    />
    <span style={{ fontSize: "11px", color: COLOR.textMuted }}>→</span>
    <input
      type="date"
      value={customTo}
      min={customFrom}
      max={todayIso}
      onChange={(e) => setCustomTo(e.target.value)}
      style={{
        padding: "4px 8px",
        fontSize: "12px",
        border: `1px solid ${COLOR.surfaceAlt}`,
        borderRadius: RADIUS.sm,
        background: COLOR.surface,
        color: COLOR.textStrong,
        colorScheme: "dark",
      }}
    />
    <button
      type="button"
      onClick={() => setRange("1y")}
      aria-label="Reset range"
      style={{
        padding: "2px 8px",
        fontSize: "14px",
        lineHeight: 1,
        border: "none",
        borderRadius: RADIUS.pill,
        background: COLOR.surfaceAlt,
        color: COLOR.textMid,
        cursor: "pointer",
      }}
    >
      ×
    </button>
  </div>
)}
```

Notes on the styling choices:
- `colorScheme: "dark"` makes the native date picker render its calendar in dark mode (matches the app theme).
- `RADIUS.sm` is the existing token used elsewhere for inputs; if `RADIUS` doesn't expose `sm`, fall back to a `4px` literal — check the `RADIUS` import at the top of the file before assuming.
- `<input>` `min`/`max` clamping makes the browser enforce `from <= to <= today`; no JS-side validation needed.

- [ ] **Step 8: Confirm `RADIUS.sm` exists (or substitute)**

Run: `grep -n "RADIUS" lib/ui/theme.ts | head -20`

If `sm` is not in the exported `RADIUS` object, either add it (only if it would naturally belong) or replace the two `borderRadius: RADIUS.sm` occurrences with `borderRadius: "4px"`. Don't invent a new token just for this view.

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Manual verification**

Run: `npm run dev` (if not already running). Navigate to `/health?view=trend`. Verify:

1. Pill row now shows seven pills: `1W · 1M · 3M · 6M · 1Y · All · Custom`.
2. Click `Custom`. The date-input row appears, defaulted to `today - 30d → today`. Body-comp cards refilter to that window.
3. Change the `from` date to a recent measurement date, then change `to` to two weeks after that. Cards refilter and the upper bound clips correctly (set `to` to a past date and confirm a known-recent point disappears).
4. Click `1M`. Date-input row disappears; preset filtering resumes.
5. Click `Custom` again. Row reappears with the previously-picked dates intact (lazy-init didn't overwrite them).
6. Click the `×` reset button. Range snaps back to `1Y`; date-input row hides.
7. Inside the `from` input, attempt to pick a date later than `to`. The browser blocks it (or snaps to `to`).

If any of those fail, fix before committing.

- [ ] **Step 11: Commit**

```bash
git add components/health/TrendView.tsx
git commit -m "$(cat <<'EOF'
feat(health): add Custom date range to Trend view

Adds a Custom pill to the Body tab Trend range row, with inline
from/to date inputs and a × reset button. Filter logic refactored
from a single lower-bound cutoff to a from/to bounds object so both
the body-comp and circumference grids share the windowing.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** All five spec sections (pill set, range definitions, custom UX, sparse-data behaviour, state shape) are implemented across Tasks 1 and 2. `RADIUS.sm` substitution is the only unknown — Step 8 handles it.
- **Placeholders:** None. Every code block is concrete.
- **Type consistency:** `RangeId` widens to `... | "custom"` in Task 2 Step 1, then is referenced in `useState<RangeId>("1y")` (existing) and the `bounds` memo branch on `range === "custom"`. Names match throughout (`customFrom` / `customTo` / `bounds` / `setRange`).
- **Verification:** No tests because the project has none (per CLAUDE.md). `npm run typecheck` runs after each structural change; manual exercise is the acceptance gate.
