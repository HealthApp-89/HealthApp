# App Redesign V2 (Integration Pass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the v2 redesign deltas from [docs/superpowers/specs/2026-05-14-app-redesign-design.md](../specs/2026-05-14-app-redesign-design.md) — chat surface conversion, morning brief hero band, dashboard brief-state chip, BottomSheet primitive, and the smaller new-feature reskins that landed during the v1 pause.

**Architecture:** Layers on a partially-shipped v1 (`lib/ui/theme.ts`, primitives under `components/ui/`, nav chrome under `components/layout/`, the new chat/morning components, `/health`, `/onboarding`, muscle-map all exist already). This plan only implements the v2 deltas: theme additions (gradients, chat tokens, muscle colors), the new `BottomSheet` primitive and its three consumers, the chat surface light-theme conversion + `/coach` page pivot, the brief hero band, the dashboard `BriefStateChip`, the `LabPromptCard` redesign, and the muscle-map color swap. Six slices, each one PR.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript (strict) · Tailwind v4 inline `@theme` · Anthropic Claude (server-side via existing `lib/anthropic/client.ts`) · Supabase

**Branches:** One per slice off `main`. Branch names below in each slice header. No test suite — verify with `npm run typecheck` and manual page exercise per CLAUDE.md.

---

## State of v1 redesign before this plan starts

Per the 2026-05-14 spec, v1 (2026-05-05 spec) is **largely shipped**. Confirmed:

- `lib/ui/theme.ts` exists with `COLOR`, `RADIUS`, `SHADOW`, `METRIC_COLOR`, `modeColorLight`
- `app/globals.css` has `@theme` block with all v1 CSS variables
- `components/ui/` has `Card`, `Pill`, `RangePills`, `StatusRow`, `Skeleton`
- `components/layout/` has `BottomNav`, `Fab` (with inline sheet — to extract), `FabGate`, `TopNav`, `TopNavGate`, `WeekStrip`, `InstallHint`
- `components/dashboard/` has `ReadinessHero`, `CoachEntryCard` (the v1 component that this plan replaces), `MonitorTile`, `BodyTile`, `RecentLiftsCard`, `WeeklyRollups`, `ImpactDonut`
- `components/morning/` has 8 components including `MorningBriefCard` (already light-themed)
- `components/chat/` has 9 files including `ChatPanel`, `ChatMessage`, `ChatComposer`, `ModeBanner` (`ChatMessage` and composer/banner are still **dark-themed holdovers**)
- `components/profile/` has `LabPromptCard` (flat-list — needs hero band per v2 spec)
- `components/strength/anatomy/` has `MuscleMap`, `MuscleOverlay`, `BodyView`, `MuscleLegendPills` (need light-theme fill swap)
- Routes `/health` and `/onboarding` exist and are in soft-light

What does **not** exist yet:
- `BottomSheet` reusable primitive
- `BriefStateChip` dashboard component
- `useIntakeState` query hook
- `GRADIENT`, `CHAT`, `MUSCLE_COLOR` token blocks in theme.ts
- Hero band on `MorningBriefCard` (the readiness number + band pill)
- `/coach` page as chat surface (currently renders legacy `InsightsList`/`RecommendationsList`/`WeeklyReview`)
- 2-tab `Today · Recent` `CoachNav` (currently 3-tab `today · this-week · next-week`)

---

## File Structure

**NEW files:**

- `components/ui/BottomSheet.tsx` — reusable bottom-sheet primitive
- `components/dashboard/BriefStateChip.tsx` — pill above `ReadinessHero` reflecting `checkins.intake_state`
- `lib/query/hooks/useIntakeState.ts` — TanStack Query hook for today's `checkins.intake_state`
- `lib/query/fetchers/intakeState.ts` — server + browser fetchers for the hook

**MODIFIED files:**

- `lib/ui/theme.ts` — append `GRADIENT`, `CHAT`, `MUSCLE_COLOR`, expand `METRIC_COLOR`
- `app/globals.css` — mirror new tokens as CSS vars
- `lib/ui/colors.ts` — append `DailyLogKey` entries for circumference fields used by `/health` trend view
- `lib/query/keys.ts` — add `intakeState` key
- `components/layout/Fab.tsx` — extract the inline sheet rendering onto `BottomSheet`
- `components/strength/DaySwapSheet.tsx` — wrap content in `BottomSheet`
- `components/profile/ProfileForm.tsx` — convert edit flow to `BottomSheet` on mobile
- `components/chat/ChatMessage.tsx` — dark-theme → light-theme card-feed
- `components/chat/ChatComposer.tsx` — dark-theme → light-theme
- `components/chat/ModeBanner.tsx` — dark-theme → light-theme + new mode labels
- `components/morning/MorningBriefCard.tsx` — add gradient hero band with readiness number + band pill
- `components/morning/BriefCoachSuggestion.tsx` — light-theme review (it's already mostly light)
- `components/coach/CoachClient.tsx` — pivot from legacy view to ChatPanel host
- `components/coach/CoachNav.tsx` — 3 tabs → 2 tabs (`Today · Recent`)
- `app/coach/page.tsx` — drop unused prefetches (insights/weeklyReview/recommendations) — keep blockProgress + trainingWeek
- `components/dashboard/TodayClient.tsx` — replace `<CoachEntryCard />` with `<BriefStateChip />`
- `components/profile/LabPromptCard.tsx` — redesign with hero amber band + `StatusRow` list
- `components/strength/anatomy/MuscleMap.tsx`, `MuscleOverlay.tsx`, `BodyView.tsx` — use `MUSCLE_COLOR` tokens

**DELETED files (Slice 6):**

- `components/coach/InsightsList.tsx`
- `components/coach/RecommendationsList.tsx`
- `components/coach/WeeklyReview.tsx`
- `components/coach/RefreshButton.tsx`
- `components/dashboard/CoachEntryCard.tsx`
- `lib/query/hooks/useInsightsDaily.ts` (and its fetcher + key entry)
- `lib/query/hooks/useWeeklyReview.ts` (ditto)
- `lib/query/hooks/useRecommendations.ts` (ditto)

`BlockProgressCard`, `WeekPlanCard`, `PlanWeekCTA` are kept — they surface as banners inside the new `/coach` chat host (Slice 3).

---

## Slice 1 — Theme additions + BottomSheet primitive

**Branch:** `feat/v2-tokens-and-bottom-sheet`

### Task 1: Append `GRADIENT`, `CHAT`, `MUSCLE_COLOR` to `lib/ui/theme.ts`

**Files:**
- Modify: `lib/ui/theme.ts` (append after `modeColorLight`)

- [ ] **Step 1: Append the three token blocks**

Open `lib/ui/theme.ts` and append at the end (after the existing `modeColorLight` function):

```ts
// Hero card gradients — used by ReadinessHero, MorningBriefCard hero band,
// and intensity-mode-mapped session heroes. Defined once, referenced everywhere.
export const GRADIENT = {
  heroAccent:  "linear-gradient(140deg, #4f5dff 0%, #6b78ff 100%)",
  heroAmber:   "linear-gradient(140deg, #b45309 0%, #d97706 100%)",
  heroSuccess: "linear-gradient(140deg, #14b870 0%, #34d399 100%)",
  heroDanger:  "linear-gradient(140deg, #ef4444 0%, #f87171 100%)",
  heroMuted:   "linear-gradient(140deg, #7a7e95 0%, #9094a8 100%)",
} as const;

// Chat-surface layout constants
export const CHAT = {
  feedMaxWidth:    "640px",   // chat column on desktop
  turnGap:         "12px",
  metaRowHeight:   "16px",
  composerHeight:  "56px",
  composerPad:     "12px",
} as const;

// Muscle-map fills (light theme) — replaces dark-theme hex values in
// MuscleMap/MuscleOverlay/BodyView. Apply via inline style or CSS variable.
export const MUSCLE_COLOR = {
  idle:        "#e8eaf3",   // unworked — matches divider, low contrast
  worked:      "#b45309",   // worked today — METRIC_COLOR.strain (amber)
  workedSoft:  "#fcd34d",   // worked recently (1–3 days)
  highlighted: "#4f5dff",   // click-to-select from exercise list — accent
  soreness:    "#ef4444",   // user-reported soreness area (morning intake) — danger
} as const;

/**
 * Map an IntensityMode hex to a hero gradient. Mirrors modeColorLight() —
 * use this when you need the gradient form (full hero band) instead of the
 * flat color. Falls back to GRADIENT.heroAccent for unknown inputs.
 */
export function modeGradient(hex: string): string {
  switch (hex) {
    case "#30d158": return GRADIENT.heroSuccess;
    case "#86efac": return GRADIENT.heroSuccess;
    case "#ffd60a": return GRADIENT.heroAmber;
    case "#ff453a": return GRADIENT.heroDanger;
    case "#6b7280": return GRADIENT.heroMuted;
    default:        return GRADIENT.heroAccent;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean (these are pure additions; no existing references to update).

- [ ] **Step 3: Commit**

```bash
git checkout -b feat/v2-tokens-and-bottom-sheet
git add lib/ui/theme.ts
git commit -m "feat(theme): add GRADIENT, CHAT, MUSCLE_COLOR token blocks + modeGradient helper"
```

### Task 2: Expand `METRIC_COLOR` + `DailyLogKey` for circumference fields

**Files:**
- Modify: `lib/ui/colors.ts` (extend `DailyLogKey` union with circumference keys used in `/health` trends)
- Modify: `lib/ui/theme.ts` (add corresponding `METRIC_COLOR` entries)

Note: The current `METRIC_COLOR` is typed `Record<DailyLogKey, string>`. The circumference fields are stored on `body_measurements` (not `daily_logs`), but `/health` trend view needs per-metric colors for them. Add a separate `BodyMeasurementKey` union and a parallel record so we don't pollute `DailyLogKey`.

- [ ] **Step 1: Define `BodyMeasurementKey` in `lib/ui/colors.ts`**

Open `lib/ui/colors.ts` and after the existing `DailyLogKey` union, add:

```ts
/**
 * Per-metric color keys for body_measurements circumference fields used by
 * /health trend view. Distinct from DailyLogKey because the source table is
 * different and the cadence is monthly, not daily.
 */
export type BodyMeasurementKey =
  | "waist"
  | "hip"
  | "chest"
  | "arms"
  | "thighs"
  | "calves";
```

- [ ] **Step 2: Add `MEASUREMENT_COLOR` in `lib/ui/theme.ts`**

Open `lib/ui/theme.ts`. Update the `import` line at the top:

```ts
import type { DailyLogKey, BodyMeasurementKey } from "./colors";
```

Then, after the existing `METRIC_COLOR` constant, add:

```ts
export const MEASUREMENT_COLOR: Record<BodyMeasurementKey, string> = {
  waist:  "#0ea5e9", // sky
  hip:    "#8b5cf6", // purple
  chest:  "#10b981", // emerald
  arms:   "#f59e0b", // amber
  thighs: "#ef4444", // rose
  calves: "#06b6d4", // cyan
};
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add lib/ui/colors.ts lib/ui/theme.ts
git commit -m "feat(theme): add BodyMeasurementKey + MEASUREMENT_COLOR for /health trend view"
```

### Task 3: Mirror new tokens in `app/globals.css` `@theme`

**Files:**
- Modify: `app/globals.css`

These let the new tokens be consumed via Tailwind utility classes (e.g. `bg-[var(--gradient-hero-accent)]`) where convenient.

- [ ] **Step 1: Append to the `@theme` block in `app/globals.css`**

After the existing semantic-color CSS vars and before the radius vars, insert:

```css
  /* Gradients (mirrors lib/ui/theme.ts:GRADIENT) */
  --gradient-hero-accent:  linear-gradient(140deg, #4f5dff 0%, #6b78ff 100%);
  --gradient-hero-amber:   linear-gradient(140deg, #b45309 0%, #d97706 100%);
  --gradient-hero-success: linear-gradient(140deg, #14b870 0%, #34d399 100%);
  --gradient-hero-danger:  linear-gradient(140deg, #ef4444 0%, #f87171 100%);
  --gradient-hero-muted:   linear-gradient(140deg, #7a7e95 0%, #9094a8 100%);

  /* Muscle map (mirrors lib/ui/theme.ts:MUSCLE_COLOR) */
  --color-muscle-idle:        #e8eaf3;
  --color-muscle-worked:      #b45309;
  --color-muscle-worked-soft: #fcd34d;
  --color-muscle-highlighted: #4f5dff;
  --color-muscle-soreness:    #ef4444;
```

- [ ] **Step 2: Run typecheck and dev**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run dev` then open `http://localhost:3000`. Confirm no console errors and the existing pages render unchanged (we only added vars; nothing reads them yet).

- [ ] **Step 3: Commit**

```bash
git add app/globals.css
git commit -m "feat(theme): mirror GRADIENT + MUSCLE_COLOR tokens as CSS vars"
```

### Task 4: Create `components/ui/BottomSheet.tsx`

**Files:**
- Create: `components/ui/BottomSheet.tsx`

Spec values from the design doc:
- Position: fixed bottom, full-width on mobile, max-width 560px centered on desktop
- Radius: 24px top corners only
- Shadow: `SHADOW.floating`
- Backdrop: `rgba(15,20,48,0.4)`, click-to-dismiss
- Drag handle: 4×36px pill, divider color, centered top
- Snap points: 60% (default), 90% (drag-up) — implement the default; defer 90% snap until a consumer needs it
- Dismiss: swipe-down (touch only — basic threshold), backdrop tap, X button
- Safe area: `padding-bottom: env(safe-area-inset-bottom)`

- [ ] **Step 1: Write `BottomSheet.tsx`**

Create `components/ui/BottomSheet.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

/**
 * Reusable bottom-sheet primitive.
 *
 * - Renders a portal-like overlay (`position: fixed`) — caller is responsible
 *   for mounting only when `open` is true (or letting BottomSheet hide itself
 *   via the `open` prop; both work).
 * - 60% viewport height by default; not snap-up to 90% yet (deferred until a
 *   consumer needs it — YAGNI).
 * - Dismiss: backdrop tap, X button, or vertical swipe-down past 80px on
 *   touch devices. No keyboard escape yet (would need a focus trap to be
 *   useful — out of scope).
 */
export function BottomSheet({
  open,
  onClose,
  children,
  /** Optional title rendered in the sheet header. */
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const touchStartY = useRef<number | null>(null);

  // Body scroll lock while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function onTouchStart(e: React.TouchEvent) {
    touchStartY.current = e.touches[0].clientY;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (touchStartY.current === null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0) setDragOffset(dy);
  }
  function onTouchEnd() {
    if (dragOffset > 80) onClose();
    setDragOffset(0);
    touchStartY.current = null;
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? "Bottom sheet"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(15,20,48,0.4)",
          backdropFilter: "blur(2px)",
        }}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "560px",
          maxHeight: "60vh",
          background: COLOR.surface,
          borderTopLeftRadius: RADIUS.cardHero,
          borderTopRightRadius: RADIUS.cardHero,
          boxShadow: SHADOW.floating,
          paddingBottom: "env(safe-area-inset-bottom)",
          transform: `translateY(${dragOffset}px)`,
          transition: dragOffset === 0 ? "transform 200ms ease-out" : "none",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Drag handle */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            paddingTop: "8px",
            paddingBottom: title ? "4px" : "8px",
          }}
        >
          <div
            style={{
              width: "36px",
              height: "4px",
              borderRadius: "9999px",
              background: COLOR.divider,
            }}
          />
        </div>

        {/* Header (optional title + close) */}
        {title ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 16px 12px",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong }}>
              {title}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                fontSize: 20,
                color: COLOR.textMuted,
                cursor: "pointer",
                lineHeight: 1,
                padding: "4px 8px",
              }}
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              position: "absolute",
              top: "10px",
              right: "12px",
              background: "transparent",
              border: "none",
              fontSize: 20,
              color: COLOR.textMuted,
              cursor: "pointer",
              padding: "4px 8px",
              lineHeight: 1,
              zIndex: 1,
            }}
          >
            ×
          </button>
        )}

        {/* Content (scrollable) */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Manual smoke (optional — Slice 2 will exercise it)**

The primitive has no callers yet. Confirm typecheck and move on.

- [ ] **Step 4: Commit**

```bash
git add components/ui/BottomSheet.tsx
git commit -m "feat(ui): add BottomSheet reusable primitive"
```

### Task 5: Open Slice 1 PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/v2-tokens-and-bottom-sheet
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --title "feat(theme): v2 tokens + BottomSheet primitive" --body "$(cat <<'EOF'
Slice 1 of the V2 redesign integration pass (spec: docs/superpowers/specs/2026-05-14-app-redesign-design.md).

Adds:
- \`GRADIENT\` token block (5 hero gradients)
- \`CHAT\` layout constants
- \`MUSCLE_COLOR\` fills for muscle-map (used in Slice 5)
- \`BodyMeasurementKey\` + \`MEASUREMENT_COLOR\` for /health trends
- \`modeGradient\` helper (gradient form of \`modeColorLight\`)
- CSS-var mirrors in \`app/globals.css\`
- \`components/ui/BottomSheet.tsx\` (consumers wired in Slices 2 + 4 + 5)

Pure-additive — no existing components touched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Slice 2 — Extract FabSheet onto BottomSheet

**Branch:** `feat/v2-fab-sheet-refactor`

### Task 6: Refactor `components/layout/Fab.tsx` sheet onto `BottomSheet`

**Files:**
- Modify: `components/layout/Fab.tsx`

The current `Fab.tsx` mounts the sheet inline. Refactor so the sheet rendering uses `BottomSheet` from Slice 1.

- [ ] **Step 1: Identify the inline sheet block**

Open `components/layout/Fab.tsx`. Find the conditional render block that shows the sheet when `sheetOpen` is true (it has the action list `ITEMS` mapped to `<a>` / `<button>` rows, plus the backdrop). Note its structure so you can preserve action semantics (link, upload, chat) while swapping the wrapper.

- [ ] **Step 2: Replace the inline sheet rendering with `<BottomSheet>`**

Wrap the action-list block in `<BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Quick actions">` and delete the inline backdrop + sheet `<div>` chrome (BottomSheet owns those). Keep:
- The action items mapping
- The chat panel mount logic (unchanged — chat panel is rendered separately from the sheet)
- The `chatState`/`chatPlanMode`/`chatDraftDocId` state

Concrete edit pattern: replace whatever `{sheetOpen && (...backdrop + sheet div...)}` block currently exists with:

```tsx
<BottomSheet
  open={sheetOpen}
  onClose={() => setSheetOpen(false)}
  title="Quick actions"
>
  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
    {ITEMS.map((item, i) => (
      /* keep the existing per-item render here — link, upload, or chat */
      <ActionRow key={i} item={item} onClick={(it) => handleItemClick(it)} />
    ))}
  </div>
</BottomSheet>
```

(If the current file inlines the per-item render, extract a small `ActionRow` local component for clarity. If it's already an inline `.map()`, just wrap that map in the new `<BottomSheet>`.)

Add the import:

```tsx
import { BottomSheet } from "@/components/ui/BottomSheet";
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`

In mobile viewport (Chrome DevTools iPhone 14):
- [ ] Tap the FAB `+`. Sheet opens from bottom with drag handle visible.
- [ ] Tap each action; routes are unchanged (`Log entry` → `/log`, `Strength` → `/strength?view=today`, `Body` → `/health`, `Manage connections` → `/profile`).
- [ ] Tap "Ask coach" — chat panel still mounts (separate from sheet logic).
- [ ] "Upload Strong CSV" — still opens the file picker.
- [ ] Tap backdrop — sheet dismisses.
- [ ] Swipe down on sheet — sheet dismisses past ~80px threshold.
- [ ] Safe-area inset visible on iOS PWA (bottom padding respects home-indicator area).

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/v2-fab-sheet-refactor
git add components/layout/Fab.tsx
git commit -m "refactor(layout/Fab): mount action sheet on BottomSheet primitive"
```

### Task 7: Open Slice 2 PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/v2-fab-sheet-refactor
gh pr create --title "refactor(layout): mount FabSheet on BottomSheet primitive" --body "Slice 2 of V2 redesign. Pulls the inline sheet rendering out of \`Fab.tsx\` and onto the new \`BottomSheet\` primitive. No behavior change — same actions, same routes, same backdrop semantics. Adds the consistent drag-handle + title row from BottomSheet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Slice 3 — Chat surface conversion (the heavy lifter)

**Branch:** `feat/v2-chat-surface`

This slice does five things: (1) convert `ChatMessage` from dark to light card-feed, (2) re-skin `ChatComposer` + `ModeBanner`, (3) add a hero band to `MorningBriefCard`, (4) pivot `/coach` from legacy view to chat host, (5) collapse `CoachNav` 3 → 2 tabs. Largest diff of the plan — if you're an LLM-driven implementer, treat each task as one commit.

### Task 8: Convert `ChatMessage.tsx` to light-theme card-feed

**Files:**
- Modify: `components/chat/ChatMessage.tsx`

Current state (verified): user bubbles use `bg-[#a29bfe]/15 border border-[#a29bfe]/25 text-white`, coach bubbles use `bg-white/[0.04] border border-white/[0.08] text-white/85`. These are dark-theme holdovers. Card-feed per spec (decision #14): every turn is a block, user blocks get `accentSoft` tint, coach blocks are plain prose.

- [ ] **Step 1: Replace the bubble JSX**

Open `components/chat/ChatMessage.tsx`. Locate the outer return block (around line 39 in the file) starting with `<div className={"flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1.5"}>` containing the bubble div with the dark classes.

Replace that whole return block with:

```tsx
return (
  <div style={{ paddingLeft: "12px", paddingRight: "12px", paddingTop: "6px", paddingBottom: "6px" }}>
    {/* Meta row: timestamp + author + optional kind tag */}
    <div
      style={{
        fontSize: 9,
        color: COLOR.textMuted,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        marginBottom: 4,
        textAlign: isUser ? "right" : "left",
      }}
    >
      {formatMeta(message, isUser)}
    </div>

    {/* Body: text block (with accentSoft tint for user) or structured card */}
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          maxWidth: "85%",
          background: isUser ? COLOR.accentSoft : "transparent",
          color: isUser ? COLOR.textStrong : COLOR.textMid,
          borderRadius: isUser ? RADIUS.cardSmall : 0,
          padding: isUser ? "10px 12px" : "0",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
        dangerouslySetInnerHTML={
          isStreaming || isError
            ? undefined
            : { __html: renderMarkdownSubset(message.content) }
        }
      >
        {isStreaming || isError ? renderStreamingOrError(message, isStreaming, isError, onRetry) : null}
      </div>
    </div>

    {/* Structured cards (proposal cards) render below the text block */}
    {hasCommittedPlan && message.tool_calls?.find((c) => c.name === "commit_plan")?.input ? (
      <div style={{ marginTop: 8 }}>
        <PlanProposalCard
          payload={(message.tool_calls.find((c) => c.name === "commit_plan")!.input as { plan_payload: PlanPayload }).plan_payload}
          messageId={message.id}
          variant="committed"
        />
      </div>
    ) : null}
    {hasCommittedBlock || hasCommittedWeek
      ? renderCommittedProposalCards(message, hasCommittedBlock, hasCommittedWeek)
      : null}
  </div>
);
```

Add imports at the top if not already present:

```tsx
import { COLOR, RADIUS } from "@/lib/ui/theme";
```

You'll also need helpers `formatMeta`, `renderStreamingOrError`, and `renderCommittedProposalCards` — extract them as local functions in the same file. Keep the streaming-cursor + error UI essentially the same logic, just swap any `text-white` / `bg-white/*` classes for `COLOR.textMid` / appropriate light values:

```tsx
function formatMeta(message: ChatMessageType, isUser: boolean): string {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const author = isUser ? "You" : "Coach";
  const kindTag =
    message.kind === "morning_intake"
      ? " · Morning check-in"
      : message.kind === "morning_brief"
      ? " · Morning brief"
      : "";
  return `${time} · ${author}${kindTag}`;
}

function renderStreamingOrError(
  message: ChatMessageType,
  isStreaming: boolean,
  isError: boolean,
  onRetry?: () => void,
) {
  if (isError) {
    return (
      <>
        <span style={{ color: COLOR.danger }}>{message.error ?? "Failed to send."}</span>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            style={{
              marginLeft: 8,
              background: "transparent",
              border: "none",
              color: COLOR.accent,
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Retry
          </button>
        ) : null}
      </>
    );
  }
  // Streaming — render markdown for whatever has streamed so far, then cursor.
  return (
    <>
      <span dangerouslySetInnerHTML={{ __html: renderMarkdownSubset(message.content) }} />
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 16,
          marginLeft: 2,
          background: COLOR.textMid,
          verticalAlign: "middle",
          opacity: 0.7,
          animation: "pulse 1s infinite",
        }}
      />
    </>
  );
}

function renderCommittedProposalCards(
  message: ChatMessageType,
  hasCommittedBlock: boolean,
  hasCommittedWeek: boolean,
) {
  const toolCalls = message.tool_calls ?? [];
  if (hasCommittedBlock) {
    const call = toolCalls.find((c) => c.name === "commit_block");
    if (!call) return null;
    return (
      <div style={{ marginTop: 8 }}>
        <BlockProposalCard
          proposal={(call.input as { proposal: BlockProposal }).proposal}
          messageId={message.id}
          variant="committed"
        />
      </div>
    );
  }
  if (hasCommittedWeek) {
    const call = toolCalls.find((c) => c.name === "commit_week_plan");
    if (!call) return null;
    return (
      <div style={{ marginTop: 8 }}>
        <WeekPlanProposalCard
          proposal={(call.input as { proposal: WeekProposal }).proposal}
          messageId={message.id}
          variant="committed"
        />
      </div>
    );
  }
  return null;
}
```

(Adjust the helper signatures if the existing ChatMessage.tsx structure stores `tool_calls` differently — the goal is to retain whatever proposal-card rendering exists today, just inside the new light-theme wrapper.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Open the FAB → "Ask coach" so ChatPanel mounts. Send a test message.

- [ ] User turn renders right-aligned with `accentSoft` (#e7eaff) background, dark text, rounded 14px radius
- [ ] Coach turn renders left-aligned, plain text on transparent background, no border
- [ ] Meta row at top of each turn shows `H:MM · You` or `H:MM · Coach`
- [ ] When coach is streaming, the cursor animates and visible-so-far markdown renders
- [ ] If an error message is in the thread (force one by killing dev mid-stream and refreshing), the error renders in danger color with a Retry link

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/v2-chat-surface
git add components/chat/ChatMessage.tsx
git commit -m "feat(chat): convert ChatMessage from dark bubbles to light card-feed"
```

### Task 9: Re-skin `ChatComposer.tsx` and `ModeBanner.tsx`

**Files:**
- Modify: `components/chat/ChatComposer.tsx`
- Modify: `components/chat/ModeBanner.tsx`

Verify the current state first — these may already be partially light. Open each file and swap any dark-theme classes (`bg-white/*`, `border-white/*`, `text-white*`) or hardcoded dark hexes for `COLOR.*` tokens. Use these targets per spec:

- Composer container: `background: COLOR.surface`, border-top `1px solid COLOR.divider`, sticky bottom, `safe-area-inset-bottom` respected
- Composer input pill: `background: COLOR.surfaceAlt` (`#f5f6fa`), `borderRadius: RADIUS.pill` (10px), `padding: "10px 14px"`, `color: COLOR.textStrong`, `placeholder` color `COLOR.textMuted`
- Composer send button: circular 40px, `background: COLOR.accent`, white icon, `boxShadow: SHADOW.fab` on hover
- ModeBanner: `background: COLOR.accentSoft`, `color: COLOR.accent`, sticky top, mode pill on the left, X close on right. 13px font, 700 weight for mode label, 12px regular for context.

- [ ] **Step 1: Open `ChatComposer.tsx` and apply light theme**

Replace the existing styling. The skeleton:

```tsx
"use client";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
/* existing imports */

export function ChatComposer(/* existing props */) {
  /* existing state + handlers */
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        background: COLOR.surface,
        borderTop: `1px solid ${COLOR.divider}`,
        padding: "12px 12px calc(12px + env(safe-area-inset-bottom))",
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}
    >
      {/* photo / HEIC upload icon button — keep existing onClick */}
      <button
        type="button"
        onClick={onPhotoClick}
        style={{
          background: COLOR.surfaceAlt,
          border: "none",
          width: 40,
          height: 40,
          borderRadius: "50%",
          fontSize: 16,
          color: COLOR.textMuted,
          cursor: "pointer",
          flexShrink: 0,
        }}
        aria-label="Attach photo"
      >
        📷
      </button>

      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "Message coach…"}
        style={{
          flex: 1,
          background: COLOR.surfaceAlt,
          border: "none",
          borderRadius: RADIUS.pill,
          padding: "10px 14px",
          fontSize: 14,
          color: COLOR.textStrong,
        }}
      />

      <button
        type="submit"
        onClick={onSend}
        disabled={!canSend}
        style={{
          background: canSend ? COLOR.accent : COLOR.divider,
          color: "#fff",
          border: "none",
          width: 40,
          height: 40,
          borderRadius: "50%",
          fontSize: 16,
          cursor: canSend ? "pointer" : "not-allowed",
          flexShrink: 0,
          boxShadow: canSend ? SHADOW.fab : "none",
        }}
        aria-label="Send"
      >
        ↑
      </button>
    </div>
  );
}
```

Keep the existing prop signature, photo-attachment flow, and key handling — only swap the visual layer.

- [ ] **Step 2: Open `ModeBanner.tsx` and apply light theme**

Replace styling:

```tsx
"use client";
import { COLOR, RADIUS } from "@/lib/ui/theme";

const MODE_LABEL: Record<string, string> = {
  default: "",
  plan_week: "PLAN WEEK",
  setup_block: "SETUP BLOCK",
  intake: "PLAN INTAKE",
};

export function ModeBanner({
  mode,
  context,
  onExit,
}: {
  mode: string;
  context?: string;
  onExit?: () => void;
}) {
  const label = MODE_LABEL[mode];
  if (!label) return null;

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        background: COLOR.accentSoft,
        color: COLOR.accent,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        zIndex: 5,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          background: COLOR.accent,
          color: COLOR.surface,
          padding: "3px 8px",
          borderRadius: RADIUS.pill,
        }}
      >
        {label}
      </span>
      {context ? (
        <span style={{ fontSize: 12, color: COLOR.accentDeep, fontWeight: 500 }}>
          {context}
        </span>
      ) : null}
      <div style={{ flex: 1 }} />
      {onExit ? (
        <button
          type="button"
          onClick={onExit}
          aria-label="Exit mode"
          style={{
            background: "transparent",
            border: "none",
            color: COLOR.accent,
            fontSize: 16,
            cursor: "pointer",
            padding: "0 4px",
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Manual check at `npm run dev`:
- [ ] Composer is light, sticks to bottom, send button is `accent` circle
- [ ] ModeBanner appears as `accentSoft` strip on top when mode is plan_week/setup_block/intake; hidden on default

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatComposer.tsx components/chat/ModeBanner.tsx
git commit -m "feat(chat): re-skin composer + mode banner to light theme"
```

### Task 10: Add gradient hero band to `MorningBriefCard`

**Files:**
- Modify: `components/morning/MorningBriefCard.tsx`

The existing `MorningBriefCard` has no hero — it renders the sub-components (BriefRecapStats, BriefSessionList, BriefMacrosGrid, BriefAdvice, BriefTonight) sequentially. Per spec (decision #15): solid-blue gradient hero band on top with readiness number + band pill + 1-line subtitle.

- [ ] **Step 1: Read the card and identify the readiness data source**

`MorningBriefCardData` (in `lib/data/types.ts`) contains `readiness_band` ("primed" | "ready" | "moderate" | "take_it_easy"), `readiness_score` (number 0–100), `headline_subtitle` (string), and `today_date` (ISO).

- [ ] **Step 2: Add a hero block at the top of the card render**

Open `components/morning/MorningBriefCard.tsx`. Inside the returned JSX, BEFORE the first sub-component (which is currently `<BriefRecapStats />` or similar), insert a hero block:

```tsx
import { COLOR, RADIUS, GRADIENT, modeGradient } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

// Inside the component, derive once per render:
const heroGradient = card.session?.intensity_mode_color
  ? modeGradient(card.session.intensity_mode_color)
  : GRADIENT.heroAccent;

const bandLabel: Record<string, string> = {
  primed: "Primed",
  ready: "Ready",
  moderate: "Moderate",
  take_it_easy: "Take it easy",
};
```

Then the JSX hero block (insert at the top of the card body, above the existing first child):

```tsx
<div
  style={{
    background: heroGradient,
    color: "#fff",
    padding: "16px 18px",
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
  }}
>
  <div
    style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      opacity: 0.85,
    }}
  >
    {`Today's brief · ${formatBriefDate(card.today_date)}`}
  </div>
  <div
    style={{
      fontSize: 44,
      fontWeight: 800,
      letterSpacing: "-0.04em",
      lineHeight: 1,
      marginTop: 6,
    }}
  >
    {fmtNum(card.readiness_score)}
  </div>
  <div
    style={{
      display: "inline-block",
      marginTop: 8,
      background: "rgba(255,255,255,0.22)",
      padding: "3px 10px",
      borderRadius: 9999,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
    }}
  >
    {bandLabel[card.readiness_band] ?? "—"}
  </div>
  {card.headline_subtitle ? (
    <div style={{ fontSize: 13, opacity: 0.9, marginTop: 8, lineHeight: 1.4 }}>
      {card.headline_subtitle}
    </div>
  ) : null}
</div>
```

Add a small date helper at the top of the file if `formatHeaderDate` from `lib/time` doesn't match the format you want (e.g., "Thu May 14"):

```tsx
function formatBriefDate(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
```

The card's outer container should already wrap children in a single bordered/rounded box. Ensure the outer container's `overflow: hidden` is set so the hero's top corners clip cleanly. If the outer container currently has padding, remove that padding from the outer and put a `padding` on each inner sub-component block instead (so the hero stretches edge-to-edge).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `card.session?.intensity_mode_color` is not in the `MorningBriefCardData` type yet, fall back to `GRADIENT.heroAccent` unconditionally (don't add a new field — that's a backend change out of scope).

If the readiness_band values in code are spelled differently (e.g., `"go" | "ok" | "easy"`), use the actual union from `lib/data/types.ts` and adjust the `bandLabel` map.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`. Open `/coach` (or trigger the morning intake to generate a fresh brief in the chat panel). Confirm the brief card now shows:
- [ ] Solid-blue gradient hero band on top
- [ ] Big readiness number (44px) centered-left
- [ ] White-on-translucent band pill below the number
- [ ] Optional subtitle below the pill
- [ ] All existing sub-blocks (Yesterday, Session, Macros, Advice, Tonight) below the hero, unchanged

- [ ] **Step 5: Commit**

```bash
git add components/morning/MorningBriefCard.tsx
git commit -m "feat(morning): add gradient hero band with readiness number to brief card"
```

### Task 11: Pivot `/coach` page from legacy view to chat host

**Files:**
- Modify: `app/coach/page.tsx`
- Modify: `components/coach/CoachClient.tsx`

The current `/coach` route renders `InsightsList` + `RecommendationsList` + `WeeklyReview` via `CoachClient` with a 3-tab `CoachNav` (`today · this-week · next-week`). The new design: `/coach` is the chat surface, with a 2-tab `CoachNav` (`Today · Recent`). The chat panel (currently summoned by the FAB) becomes the page's primary content.

`BlockProgressCard`, `WeekPlanCard`, `PlanWeekCTA` are kept as **banners above the chat feed** when the active block / planning state warrants — not as a separate tab.

- [ ] **Step 1: Trim `app/coach/page.tsx` prefetches**

Open `app/coach/page.tsx`. The current page prefetches 5 queries (insightsDaily, weeklyReview, recommendations, blockProgress, trainingWeek). Keep only blockProgress and trainingWeek — those feed the banners above the chat feed. Drop the rest along with their imports.

Replace the prefetch block:

```tsx
await Promise.all([
  queryClient.prefetchQuery({
    queryKey: queryKeys.blockProgress.active(user.id),
    queryFn: () => computeBlockProgress(supabase, user.id),
  }),
  queryClient.prefetchQuery({
    queryKey: queryKeys.trainingWeeks.one(user.id, targetMonday),
    queryFn: () => fetchTrainingWeekServer(supabase, user.id, targetMonday),
  }),
]);
```

Remove unused imports (`fetchInsightsDailyServer`, `fetchWeeklyReviewServer`, `fetchRecommendationsServer`, `reviewWindow`, `recommendationWeekStart`). Update `CoachClient` props in the render to drop `weekStart`, `weekEnd`, `weekMode`, `daysRemaining`, `recsTargetWeek` (these were consumed by the deleted prefetches).

- [ ] **Step 2: Replace `CoachClient.tsx` body**

Open `components/coach/CoachClient.tsx`. Rewrite to render the chat host:

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { COLOR, CHAT } from "@/lib/ui/theme";
import { CoachNav, type CoachView } from "@/components/coach/CoachNav";
import { BlockProgressCard } from "@/components/coach/BlockProgressCard";
import { WeekPlanCard } from "@/components/coach/WeekPlanCard";
import { PlanWeekCTA } from "@/components/coach/PlanWeekCTA";
import { useBlockProgress } from "@/lib/query/hooks/useBlockProgress";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { formatHeaderDate } from "@/lib/time";

const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel"), {
  ssr: false,
  loading: () => <div style={{ padding: 16, color: COLOR.textMuted }}>Loading…</div>,
});

export function CoachClient({
  userId,
  todayDate,
  targetMonday,
  initialView,
}: {
  userId: string;
  todayDate: string;
  targetMonday: string;
  initialView: CoachView;
}) {
  const searchParams = useSearchParams();
  const view: CoachView = (searchParams.get("view") as CoachView) ?? initialView;

  const { data: blockProgress } = useBlockProgress(userId);
  const { data: trainingWeek } = useTrainingWeek(userId, targetMonday);

  // chat mode comes from ?mode=plan_week|setup_block|intake — propagated to ChatPanel.
  const chatModeParam = (searchParams.get("mode") ?? "default") as
    | "default"
    | "plan_week"
    | "setup_block"
    | "intake";

  return (
    <div
      style={{
        maxWidth: CHAT.feedMaxWidth,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        minHeight: "100dvh",
      }}
    >
      <header style={{ padding: "12px 16px 8px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: COLOR.textStrong, margin: 0 }}>Coach</h1>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
          {formatHeaderDate(todayDate)}
        </div>
        <div style={{ marginTop: 10 }}>
          <CoachNav initial={view} />
        </div>
      </header>

      {/* Contextual banners above the feed (top-of-conversation cards) */}
      <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {blockProgress ? <BlockProgressCard progress={blockProgress} /> : null}
        {trainingWeek ? (
          <WeekPlanCard userId={userId} weekStart={targetMonday} />
        ) : (
          <PlanWeekCTA weekStart={targetMonday} weekN={null} />
        )}
      </div>

      {/* Chat feed + composer */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <ChatPanel
          userId={userId}
          mode={chatModeParam}
          initialOpen
        />
      </div>
    </div>
  );
}
```

Keep `CoachClient`'s prop signature backward-compatible enough that `app/coach/page.tsx` still compiles — drop the now-unused props from the render call.

If `ChatPanel`'s current signature requires more props than `userId` + `mode` + `initialOpen`, adapt: it's currently designed to mount as an overlay sheet from `Fab.tsx`. For `/coach` use, you may need a thin wrapper around it that renders just the feed + composer in-flow (not as an overlay). The simplest implementation: pass an additional `embedded?: boolean` prop to `ChatPanel` and gate the overlay chrome (backdrop, fixed positioning, close button) on `!embedded`. Adjust `Fab.tsx` to pass `embedded={false}` (or just continue to omit the prop — default false) and `/coach`'s render passes `embedded={true}`.

- [ ] **Step 3: Add `embedded` mode to `ChatPanel.tsx`**

Open `components/chat/ChatPanel.tsx`. At the props type, add `embedded?: boolean`. In the outer return, branch:

```tsx
if (embedded) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <ModeBanner mode={mode} context={modeContext} onExit={onExitMode} />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <ChatThread /* existing props */ />
      </div>
      <ChatComposer /* existing props */ />
    </div>
  );
}
// existing overlay/sheet render
```

The non-embedded branch (the existing overlay UI) is what FAB uses.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`. Visit `/coach`:
- [ ] Page renders with `Coach` title + date + `CoachNav` (still 3 tabs at this point — Task 12 collapses to 2)
- [ ] Block progress banner shows if there's an active block
- [ ] Week plan banner OR plan-week CTA shows above the chat feed
- [ ] Chat feed renders the existing conversation history
- [ ] Composer is sticky at bottom
- [ ] Sending a message works end-to-end

The FAB's "Ask coach" overlay should still work in parallel (it uses the non-embedded `ChatPanel` branch).

- [ ] **Step 6: Commit**

```bash
git add app/coach/page.tsx components/coach/CoachClient.tsx components/chat/ChatPanel.tsx
git commit -m "feat(coach): pivot /coach page to chat host with banners above feed"
```

### Task 12: Collapse `CoachNav` 3 → 2 tabs (`Today · Recent`)

**Files:**
- Modify: `components/coach/CoachNav.tsx`

- [ ] **Step 1: Update the CoachView union and labels**

Open `components/coach/CoachNav.tsx`. The current `CoachView` type is `"today" | "this-week" | "next-week"`. Change to:

```tsx
export type CoachView = "today" | "recent";
```

Update the tab labels array / map to:

```tsx
const TABS: Array<{ view: CoachView; label: string }> = [
  { view: "today", label: "Today" },
  { view: "recent", label: "Recent" },
];
```

Inside the component render, drop the third tab. Keep the existing `RangePills`-style segmented row styling.

- [ ] **Step 2: Update callers**

Grep for any uses of `"this-week"` or `"next-week"` as `CoachView`:

```bash
grep -rn '"this-week"\|"next-week"' --include='*.ts' --include='*.tsx'
```

Replace with `"today"` (the default landing) wherever they're hardcoded. The only file that should still reference these is `app/coach/page.tsx` (in the `initialView` derivation) — change its searchParam check to accept `"today" | "recent"`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`. Visit `/coach`:
- [ ] CoachNav shows exactly 2 pills: `Today` (active by default) and `Recent`
- [ ] Tapping `Recent` updates `?view=recent` in URL
- [ ] No third tab visible

Note: The `Recent` tab's content is intentionally a no-op for now — Task 22 in Slice 6 will wire it to render a paginated list of past days' thread headings. Until then, both tabs render the same chat feed; the URL just changes.

- [ ] **Step 5: Commit**

```bash
git add components/coach/CoachNav.tsx app/coach/page.tsx
# plus any other file that referenced the dropped views
git commit -m "feat(coach): collapse CoachNav to Today + Recent tabs"
```

### Task 13: Open Slice 3 PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/v2-chat-surface
gh pr create --title "feat(v2): chat surface conversion + /coach pivot + brief hero band" --body "$(cat <<'EOF'
Slice 3 of V2 redesign. The heavy lifter.

Changes:
- \`ChatMessage\` dark bubbles → light card-feed (decision #14 — every turn is a block, user turns get accentSoft tint)
- \`ChatComposer\` + \`ModeBanner\` light-theme reskin
- \`MorningBriefCard\` gains gradient hero band with readiness number + band pill (decision #15)
- \`/coach\` page pivots from legacy InsightsList/RecommendationsList/WeeklyReview view to chat surface (decision #13 — co-equal surfaces)
- \`CoachNav\` 3 tabs → 2 tabs (\`Today · Recent\`)
- \`ChatPanel\` gains an \`embedded\` mode (used by \`/coach\`); FAB overlay path unchanged

Legacy components (\`InsightsList\`, \`RecommendationsList\`, \`WeeklyReview\`, \`RefreshButton\`) are still in the tree — Slice 6 deletes them after a soak.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Slice 4 — Dashboard BriefStateChip + Profile additions

**Branch:** `feat/v2-dashboard-and-profile`

### Task 14: Add `useIntakeState` query hook + fetcher

**Files:**
- Create: `lib/query/fetchers/intakeState.ts`
- Create: `lib/query/hooks/useIntakeState.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Add the query key**

Open `lib/query/keys.ts`. Inside the `queryKeys` const, add:

```ts
intakeState: {
  one: (userId: string, day: string) => ["intakeState", userId, day] as const,
},
```

(Match the existing nested-namespace pattern in the file — adjust placement to match its style.)

- [ ] **Step 2: Write the fetcher**

Create `lib/query/fetchers/intakeState.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type IntakeState =
  | "awaiting_intake"
  | "in_progress"
  | "assembling_brief"
  | "brief_delivered"
  | "brief_failed"
  | null;

export async function fetchIntakeStateServer(
  supabase: SupabaseClient,
  userId: string,
  day: string,
): Promise<IntakeState> {
  const { data, error } = await supabase
    .from("checkins")
    .select("intake_state")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) throw error;
  return (data?.intake_state ?? null) as IntakeState;
}

export async function fetchIntakeStateBrowser(
  userId: string,
  day: string,
): Promise<IntakeState> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("checkins")
    .select("intake_state")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) throw error;
  return (data?.intake_state ?? null) as IntakeState;
}
```

- [ ] **Step 3: Write the hook**

Create `lib/query/hooks/useIntakeState.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchIntakeStateBrowser } from "@/lib/query/fetchers/intakeState";

export function useIntakeState(userId: string, day: string) {
  return useQuery({
    queryKey: queryKeys.intakeState.one(userId, day),
    queryFn: () => fetchIntakeStateBrowser(userId, day),
    staleTime: 60_000, // 1 min — re-checks when user navigates back from /coach
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `checkins.intake_state` is not yet on the typed schema, the `as IntakeState` cast accepts it; column exists per migration 0007.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/v2-dashboard-and-profile
git add lib/query/keys.ts lib/query/fetchers/intakeState.ts lib/query/hooks/useIntakeState.ts
git commit -m "feat(query): add useIntakeState hook + server/browser fetchers"
```

### Task 15: Create `BriefStateChip` and wire onto dashboard

**Files:**
- Create: `components/dashboard/BriefStateChip.tsx`
- Modify: `components/dashboard/TodayClient.tsx` (replace `<CoachEntryCard />` usage)

- [ ] **Step 1: Write `BriefStateChip.tsx`**

Create `components/dashboard/BriefStateChip.tsx`:

```tsx
"use client";

import Link from "next/link";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { useIntakeState } from "@/lib/query/hooks/useIntakeState";

export function BriefStateChip({
  userId,
  todayIso,
}: {
  userId: string;
  todayIso: string;
}) {
  const { data: state } = useIntakeState(userId, todayIso);

  // Spec decision #16: chip is hidden in default case (no extra vertical space).
  if (!state) return null;
  if (state === "assembling_brief") return null; // transient — let it pass

  const config = (() => {
    switch (state) {
      case "brief_delivered":
        return {
          bg: COLOR.accentSoft,
          fg: COLOR.accentDeep,
          label: "✓ Today's brief is ready",
          cta: "Open in chat →",
          href: "/coach",
        };
      case "awaiting_intake":
      case "in_progress":
        return {
          bg: COLOR.warningSoft,
          fg: "#92400e", // amber-deep
          label: "Continue morning check-in",
          cta: "Resume →",
          href: "/coach?mode=morning_intake",
        };
      case "brief_failed":
        return {
          bg: COLOR.dangerSoft,
          fg: "#991b1b", // red-deep
          label: "Brief retry available",
          cta: "Retry →",
          href: "/coach?retry=brief",
        };
      default:
        return null;
    }
  })();

  if (!config) return null;

  return (
    <Link
      href={config.href}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: config.bg,
        color: config.fg,
        padding: "10px 14px",
        borderRadius: RADIUS.pill,
        textDecoration: "none",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span>{config.label}</span>
      <span>{config.cta}</span>
    </Link>
  );
}
```

- [ ] **Step 2: Replace `CoachEntryCard` with `BriefStateChip` in dashboard**

Open `components/dashboard/TodayClient.tsx`. Find the `<CoachEntryCard ... />` usage. Replace with:

```tsx
<BriefStateChip userId={userId} todayIso={todayIso} />
```

Adjust placement: per spec decision #16, the chip goes **between `WeekStrip` and `ReadinessHero`**, not lower in the stack where `CoachEntryCard` lived. Move accordingly.

Add the import:

```tsx
import { BriefStateChip } from "@/components/dashboard/BriefStateChip";
```

Remove the `CoachEntryCard` import (we'll delete the component file in Slice 6).

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/`:
- [ ] If no intake started today: chip hidden, no extra space
- [ ] If you've completed morning intake: chip shows accent-soft "✓ Today's brief is ready · Open in chat →"
- [ ] Tap → routes to `/coach`
- [ ] If you mid-intake-fail (force by clearing browser state mid-flow): danger-soft chip with retry link

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/BriefStateChip.tsx components/dashboard/TodayClient.tsx
git commit -m "feat(dashboard): add BriefStateChip replacing CoachEntryCard"
```

### Task 16: Redesign `LabPromptCard` with hero amber band + StatusRow list

**Files:**
- Modify: `components/profile/LabPromptCard.tsx`

Current state: flat list of pending labs inside a Card. New design per spec: hero band (`GRADIENT.heroAmber`) on top with the heading "Ask your doctor at the next check-up", then 6 `StatusRow`-style items below with check/done state.

- [ ] **Step 1: Rewrite the card body**

Open `components/profile/LabPromptCard.tsx`. Replace the JSX return with:

```tsx
import { Card } from "@/components/ui/Card";
import { COLOR, GRADIENT, RADIUS } from "@/lib/ui/theme";
import { useLabAcknowledgments, useAckLabItem } from "@/lib/query/hooks/useLabAcknowledgments";
import { useMemo } from "react";

const ITEMS = [
  { key: "b12_baseline", label: "B12", detail: "Baseline + 6mo" },
  { key: "vit_d_baseline", label: "Vitamin D", detail: "Baseline + 6mo" },
  { key: "magnesium_baseline", label: "Magnesium", detail: "Baseline + 6mo" },
  { key: "ferritin_baseline", label: "Ferritin", detail: "Baseline + 6mo" },
  { key: "grip_strength_q", label: "Grip strength", detail: "Quarterly — function decline precedes mass decline" },
  { key: "bone_density_12mo", label: "Bone density (DXA)", detail: "If cut extends >12 months" },
];

export function LabPromptCard({ userId }: { userId: string }) {
  const { data: acks = {} } = useLabAcknowledgments(userId);
  const ackMut = useAckLabItem(userId);
  const pendingCount = useMemo(
    () => ITEMS.filter((it) => !acks[it.key]).length,
    [acks],
  );

  if (pendingCount === 0) return null;

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {/* Hero amber band */}
      <div
        style={{
          background: GRADIENT.heroAmber,
          color: "#fff",
          padding: "14px 16px",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.9 }}>
          Lab check-ups
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
          Ask your doctor at the next check-up
        </div>
        <div style={{ fontSize: 12, opacity: 0.9, marginTop: 6, lineHeight: 1.4 }}>
          Standard GLP-1 monitoring is loose. These checks fill the gap.
        </div>
      </div>

      {/* Item rows */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {ITEMS.map((it) => {
          const acked = !!acks[it.key];
          return (
            <li
              key={it.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                borderTop: `1px solid ${COLOR.divider}`,
              }}
            >
              <button
                type="button"
                onClick={() =>
                  acked
                    ? null
                    : ackMut.mutate({ key: it.key, ackedOn: new Date().toISOString().slice(0, 10) })
                }
                disabled={ackMut.isPending}
                aria-label={acked ? `${it.label} acknowledged` : `Mark ${it.label} as acknowledged`}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: `1.5px solid ${acked ? COLOR.success : COLOR.divider}`,
                  background: acked ? COLOR.success : "transparent",
                  color: "#fff",
                  cursor: acked ? "default" : "pointer",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                {acked ? "✓" : ""}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{it.label}</div>
                <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2, lineHeight: 1.4 }}>
                  {it.detail}
                </div>
              </div>
              {acked && acks[it.key] ? (
                <div style={{ fontSize: 10, color: COLOR.success, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {acks[it.key]}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`. Expected: clean.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Visit `/profile`. The LabPromptCard renders only when the active plan is GLP-1 mode (existing visibility logic, unchanged). Visual check:
- [ ] Amber hero band on top
- [ ] 6 rows below with checkmark circle + label + detail
- [ ] Tapping a circle marks it acknowledged (success color, checkmark visible)
- [ ] Acknowledged date appears right-aligned in success color

- [ ] **Step 4: Commit**

```bash
git add components/profile/LabPromptCard.tsx
git commit -m "feat(profile): redesign LabPromptCard with amber hero band + StatusRow list"
```

### Task 17: Open Slice 4 PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/v2-dashboard-and-profile
gh pr create --title "feat(v2): dashboard BriefStateChip + LabPromptCard redesign" --body "$(cat <<'EOF'
Slice 4 of V2 redesign.

- New \`BriefStateChip\` component on dashboard (decision #16) reflects \`checkins.intake_state\`; replaces v1's \`CoachEntryCard\`. States: brief delivered / awaiting intake / in progress / brief failed.
- New \`useIntakeState\` query hook + fetchers
- \`LabPromptCard\` redesigned with gradient amber hero band + StatusRow-style item list

\`CoachEntryCard\` file remains for now; Slice 6 deletes it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Slice 5 — Muscle map tokens + DaySwapSheet refactor + ProfileForm sheet

**Branch:** `feat/v2-strength-and-sheets`

### Task 18: Apply `MUSCLE_COLOR` to muscle-map components

**Files:**
- Modify: `components/strength/anatomy/MuscleMap.tsx`
- Modify: `components/strength/anatomy/MuscleOverlay.tsx`
- Modify: `components/strength/anatomy/BodyView.tsx`

- [ ] **Step 1: Audit current fills**

Run:

```bash
grep -nE '#[0-9a-fA-F]{6}|background:|backgroundColor|fill:' components/strength/anatomy/*.tsx
```

Note every hex color or CSS-var reference used for muscle fills.

- [ ] **Step 2: Replace dark-theme fills with `MUSCLE_COLOR` tokens**

In each of the three files, replace the matched fills:
- Unworked muscle fill → `MUSCLE_COLOR.idle`
- "Worked today" / primary highlight → `MUSCLE_COLOR.worked`
- "Worked recently" (1–3 days, secondary) → `MUSCLE_COLOR.workedSoft`
- Click-to-select highlight (from PR #57) → `MUSCLE_COLOR.highlighted`
- Soreness indicator → `MUSCLE_COLOR.soreness`

Add the import to each modified file:

```tsx
import { MUSCLE_COLOR } from "@/lib/ui/theme";
```

If the SVG fills are inline `fill="#abcdef"` attributes inside `public/anatomy/main-*.svg` (per the muscle-map plan), those are static and not theme-driven — they're masked via CSS `mask-image` and the actual color is applied on the wrapper `<div>` in `MuscleOverlay.tsx`. The wrapper `background` color is what we change, not the SVG. Confirm by reading `MuscleOverlay.tsx` first.

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/strength?view=date` and open a recent session. Confirm:
- [ ] Body silhouette renders in light theme (subtle grey for unworked muscles)
- [ ] Worked muscles fill in amber (`#b45309`)
- [ ] Secondary muscles fill in lighter amber (`#fcd34d`)
- [ ] Clicking an exercise highlights its muscles in accent blue (`#4f5dff`)

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/v2-strength-and-sheets
git add components/strength/anatomy/
git commit -m "feat(strength): apply MUSCLE_COLOR tokens to muscle-map fills"
```

### Task 19: Refactor `DaySwapSheet` onto `BottomSheet`

**Files:**
- Modify: `components/strength/DaySwapSheet.tsx`

- [ ] **Step 1: Read current DaySwapSheet structure**

Open `components/strength/DaySwapSheet.tsx`. Identify the outer wrapper (the modal/portal block) and the inner content (preview + confirm buttons + day picker + warning text).

- [ ] **Step 2: Wrap content in `BottomSheet`**

Replace the outer wrapper with:

```tsx
import { BottomSheet } from "@/components/ui/BottomSheet";

// In the component:
return (
  <BottomSheet
    open={open}
    onClose={onClose}
    title={`Swap ${FULL_NAME[day]}`}
  >
    {/* existing content — day picker, preview, confirm/cancel buttons */}
  </BottomSheet>
);
```

Delete the inline backdrop and modal-positioning chrome (BottomSheet owns those). Keep preview/confirm flow intact — only the outer container changes.

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/strength?view=today` (when a training_week exists). Tap a day in the planned-week strip → DaySwapSheet opens as a `BottomSheet`. Verify:
- [ ] Sheet has drag-handle + title + close button
- [ ] Existing preview flow works (`replace` and `swap` actions both produce previews)
- [ ] Confirm executes the swap; sheet closes
- [ ] Backdrop tap dismisses

- [ ] **Step 4: Commit**

```bash
git add components/strength/DaySwapSheet.tsx
git commit -m "refactor(strength): mount DaySwapSheet on BottomSheet primitive"
```

### Task 20: Refactor `ProfileForm` edit flow onto `BottomSheet`

**Files:**
- Modify: `components/profile/ProfileForm.tsx`

Current state: ProfileForm renders inline on `/profile`. Per spec, the edit flow becomes a `BottomSheet`. The viewing affordance stays a Card; tapping it opens the form in a sheet.

- [ ] **Step 1: Identify the edit flow trigger**

Read `components/profile/ProfileClient.tsx` to find where `ProfileForm` is invoked. If it's always rendered (no edit/view distinction), introduce a trigger:

```tsx
const [editOpen, setEditOpen] = useState(false);

// Replace the inline ProfileForm render with a viewing Card + edit button:
<Card>
  <div onClick={() => setEditOpen(true)} style={{ cursor: "pointer" }}>
    {/* display name, email, etc. */}
    <span style={{ color: COLOR.accent, fontSize: 12 }}>Edit →</span>
  </div>
</Card>

<BottomSheet open={editOpen} onClose={() => setEditOpen(false)} title="Edit profile">
  <ProfileForm onSave={() => setEditOpen(false)} />
</BottomSheet>
```

If `ProfileForm` already manages an "Edit" / "Save" state internally, instead keep the form inline as-is on desktop but mount it in `BottomSheet` on mobile only (`@media (min-width: 768px)` check is tricky in React — easier to always use BottomSheet since the BottomSheet's max-width caps at 560px which is fine for desktop too). Default: always BottomSheet for edit.

- [ ] **Step 2: Adjust `ProfileForm` to accept `onSave`**

If it doesn't already, add an `onSave?: () => void` prop and call it after a successful save (so the sheet can auto-close).

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/profile`. Confirm:
- [ ] User card displays read-only profile info with "Edit →" affordance
- [ ] Tap → `BottomSheet` opens with `ProfileForm`
- [ ] Save → form submits, sheet closes
- [ ] Backdrop tap dismisses without saving

- [ ] **Step 4: Commit**

```bash
git add components/profile/ProfileForm.tsx components/profile/ProfileClient.tsx
git commit -m "refactor(profile): mount ProfileForm edit flow on BottomSheet"
```

### Task 21: Open Slice 5 PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/v2-strength-and-sheets
gh pr create --title "feat(v2): muscle-map tokens + DaySwapSheet/ProfileForm on BottomSheet" --body "$(cat <<'EOF'
Slice 5 of V2 redesign.

- Muscle-map components (\`MuscleMap\`, \`MuscleOverlay\`, \`BodyView\`) use \`MUSCLE_COLOR\` tokens — light-theme amber for worked, accent for highlighted, divider for idle
- \`DaySwapSheet\` refactored onto \`BottomSheet\` primitive — no UX change, consistent chrome
- \`ProfileForm\` edit flow now opens as \`BottomSheet\` (was inline)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Slice 6 — Legacy cleanup + /coach Recent tab + /login + /privacy reskin + verification

**Branch:** `feat/v2-cleanup-and-recent`

### Task 22: Implement the `Recent` tab in `CoachClient`

**Files:**
- Modify: `components/coach/CoachClient.tsx`
- Create: `lib/query/fetchers/coachRecent.ts`
- Create: `lib/query/hooks/useCoachRecent.ts`

Goal: When `view === "recent"`, render a paginated list of past days' thread summaries (date + 1-line preview of the morning brief or last coach turn). Tap → routes to `/coach?day=YYYY-MM-DD` showing that day's read-only thread (out of scope for v2 — for now, just route to the date-anchored view in chat and let the user scroll). v1 ships a simpler version: just list dates with the band label.

- [ ] **Step 1: Add fetcher**

Create `lib/query/fetchers/coachRecent.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type RecentDay = {
  day: string;
  readiness_band: string | null;
  brief_delivered_at: string | null;
};

export async function fetchCoachRecentBrowser(userId: string, limit = 30): Promise<RecentDay[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("checkins")
    .select("day, intake_state, brief_delivered_at, readiness_band")
    .eq("user_id", userId)
    .order("day", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((d) => ({
    day: d.day,
    readiness_band: d.readiness_band ?? null,
    brief_delivered_at: d.brief_delivered_at ?? null,
  }));
}
```

(If `checkins` doesn't have a `readiness_band` column, derive from `MorningBriefCard.ui.readiness_band` by joining to `chat_messages` filtered to `kind = 'morning_brief'` — adjust the select accordingly. Simplest path: just return `day` and let the UI show date-only if band is unavailable.)

- [ ] **Step 2: Add hook**

Create `lib/query/hooks/useCoachRecent.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchCoachRecentBrowser } from "@/lib/query/fetchers/coachRecent";

export function useCoachRecent(userId: string) {
  return useQuery({
    queryKey: ["coachRecent", userId],
    queryFn: () => fetchCoachRecentBrowser(userId),
    staleTime: 5 * 60_000,
  });
}
```

- [ ] **Step 3: Branch render in `CoachClient`**

Inside `CoachClient`, when `view === "recent"`:

```tsx
import { useCoachRecent } from "@/lib/query/hooks/useCoachRecent";
import { Card } from "@/components/ui/Card";

// inside the component, when view === "recent":
const { data: recent } = useCoachRecent(userId);

if (view === "recent") {
  return (
    <div style={{ maxWidth: CHAT.feedMaxWidth, margin: "0 auto", padding: 12 }}>
      {/* header + nav unchanged */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {(recent ?? []).map((d) => (
          <Card key={d.day} style={{ padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
              {new Date(d.day + "T12:00:00Z").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
            </div>
            {d.readiness_band ? (
              <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
                {d.readiness_band.replace(/_/g, " ")}
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
```

This is intentionally minimal — full thread-detail navigation can land as a follow-up.

- [ ] **Step 4: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/coach?view=recent`:
- [ ] List of recent dates renders newest-first
- [ ] Each row shows the day + (when available) the readiness band

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/v2-cleanup-and-recent
git add lib/query/fetchers/coachRecent.ts lib/query/hooks/useCoachRecent.ts components/coach/CoachClient.tsx
git commit -m "feat(coach): implement Recent tab with date list"
```

### Task 23: Delete legacy coach components + their query hooks

**Files:**
- Delete: `components/coach/InsightsList.tsx`
- Delete: `components/coach/RecommendationsList.tsx`
- Delete: `components/coach/WeeklyReview.tsx`
- Delete: `components/coach/RefreshButton.tsx`
- Delete: `components/dashboard/CoachEntryCard.tsx`
- Delete: `lib/query/hooks/useInsightsDaily.ts`
- Delete: `lib/query/hooks/useWeeklyReview.ts`
- Delete: `lib/query/hooks/useRecommendations.ts`
- Delete: `lib/query/fetchers/insightsDaily.ts`
- Delete: `lib/query/fetchers/weeklyReview.ts`
- Delete: `lib/query/fetchers/recommendations.ts`
- Modify: `lib/query/keys.ts` (remove dead key entries)

- [ ] **Step 1: Confirm no callers remain**

Run:

```bash
grep -rn "InsightsList\|RecommendationsList\|WeeklyReview\|RefreshButton\|CoachEntryCard\|useInsightsDaily\|useWeeklyReview\|useRecommendations" --include='*.ts' --include='*.tsx'
```

Expected: only the files-to-delete reference these names. If any other file still imports them, fix that file first (likely just a stale import in `CoachClient.tsx` from Slice 3 if it wasn't fully cleaned).

- [ ] **Step 2: Delete the files**

```bash
git rm \
  components/coach/InsightsList.tsx \
  components/coach/RecommendationsList.tsx \
  components/coach/WeeklyReview.tsx \
  components/coach/RefreshButton.tsx \
  components/dashboard/CoachEntryCard.tsx \
  lib/query/hooks/useInsightsDaily.ts \
  lib/query/hooks/useWeeklyReview.ts \
  lib/query/hooks/useRecommendations.ts \
  lib/query/fetchers/insightsDaily.ts \
  lib/query/fetchers/weeklyReview.ts \
  lib/query/fetchers/recommendations.ts
```

- [ ] **Step 3: Remove dead `queryKeys` entries**

Open `lib/query/keys.ts`. Delete the `insights` and `recommendations` key namespaces (keep `weeklyReview` only if some other component still uses it — grep first). If they appear unused, delete them too.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. If failures appear, they're stale imports — fix and re-run.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(coach): delete legacy InsightsList/RecommendationsList/WeeklyReview + hooks"
```

### Task 24: Reskin `/login` and `/privacy` in light theme

**Files:**
- Modify: `app/login/page.tsx` (or the page client component, whichever holds the form)
- Modify: `app/privacy/page.tsx`

- [ ] **Step 1: Audit current /login state**

Open `app/login/page.tsx`. If it's already using `COLOR`/`RADIUS` tokens from `lib/ui/theme.ts`, only minor touch-ups are needed. If it still references dark-theme classes (`bg-black`, `text-white`), convert:

- Outer container: `background: COLOR.bg`
- Form card: wrap in `<Card>` (max-width 360px on desktop, centered)
- Magic-link / OAuth buttons: `background: COLOR.accent`, `color: "#fff"`, `RADIUS.pill`, padding `12px 20px`
- Title: 22px 700 `COLOR.textStrong`
- Help text: 12px `COLOR.textMid`

- [ ] **Step 2: Same audit for /privacy**

Open `app/privacy/page.tsx`. Wrap the long-form prose in `max-width: 720px`, `margin: "0 auto"`, `padding: "24px 16px"`. Headings use h1/h2 from theme typography; body text uses `COLOR.textMid` at 14px/1.6 line-height.

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/login` and `/privacy`:
- [ ] Light theme, soft surfaces, no dark-theme holdovers
- [ ] Login button is `accent` blue
- [ ] Privacy reads as long-form prose with comfortable line-height

- [ ] **Step 4: Commit**

```bash
git add app/login app/privacy
git commit -m "feat(v2): reskin /login and /privacy in light theme"
```

### Task 25: Audit /onboarding for token consistency

**Files:**
- Modify: `app/onboarding/page.tsx` (if needed)
- Modify: `components/onboarding/*` (if any dark holdovers)

The 6-step wizard should already be light per CLAUDE.md, but verify nothing slipped.

- [ ] **Step 1: Grep for dark classes**

```bash
grep -rn "bg-black\|text-white/\|bg-white/\[\|border-white/\[" components/onboarding/ app/onboarding/
```

Expected: no matches. If matches appear, swap each for `COLOR.*` tokens as in Task 8 / Task 24.

- [ ] **Step 2: Apply `Pill` primitive to step indicator if not already**

Open the wizard page. If the step indicator (e.g., "Step 3 of 6") is built ad-hoc, swap to a `RangePills`-style segmented row. If it already is, skip.

- [ ] **Step 3: Typecheck and dev**

Run: `npm run typecheck`. Expected: clean.

Run: `npm run dev`. Visit `/onboarding`:
- [ ] All 6 steps render in light theme
- [ ] Buttons use `accent` color
- [ ] Step indicator is a clean segmented row

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add app/onboarding components/onboarding
git commit -m "feat(v2): /onboarding token audit pass (light theme consistency)"
```

If grep found no matches and no changes are needed, skip the commit.

### Task 26: Final cross-route verification + open Slice 6 PR

- [ ] **Step 1: Run typecheck on the full tree**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Exercise every route manually**

Run: `npm run dev`. For each route below, open in mobile (Chrome iPhone 14 viewport) and desktop (1440px) and confirm:

- [ ] `/` — `WeekStrip` · `BriefStateChip` (when applicable) · `ReadinessHero` · `MetricCard` grid · `ImpactDonut` · `RecentLiftsCard` · `WeeklyRollups`. No `CoachEntryCard` (deleted).
- [ ] `/log` — light theme, WeekStrip, morning check-in form
- [ ] `/trends` — light theme, RangePills, compact MetricCard stack with LineCharts
- [ ] `/trends/[metric]` — detail view, light theme
- [ ] `/strength?view=today` — TodayPlanCard in light theme
- [ ] `/strength?view=recent` — volume hero (amber), top lifts, recent sessions
- [ ] `/strength?view=date` — DateNavigator + SessionTable + MuscleMap (light theme fills)
- [ ] `/coach?view=today` — chat surface: BlockProgress / WeekPlan / PlanWeek CTA banners, then chat feed with card-feed turns and Morning Brief hero band
- [ ] `/coach?view=recent` — Recent dates list
- [ ] `/coach?mode=plan_week` — ModeBanner shows "PLAN WEEK"
- [ ] `/coach?mode=setup_block` — ModeBanner shows "SETUP BLOCK"
- [ ] `/coach?mode=intake&doc=<id>` — ModeBanner shows "PLAN INTAKE"
- [ ] `/profile` — User card · IntegrationRow list · Baselines · IngestPanel · Account section. LabPromptCard with hero band when GLP-1 plan active. Edit profile → BottomSheet
- [ ] `/health?view=today` — latest measurement card with photo header
- [ ] `/health?view=trend` — RangePills + MetricCard stack for circumference fields
- [ ] `/health?view=log` — MeasurementForm in light theme
- [ ] `/onboarding` — wizard, light theme
- [ ] `/login` — light theme, accent button
- [ ] `/privacy` — long-form light theme
- [ ] FAB on mobile — opens BottomSheet with 6 actions; each routes correctly
- [ ] DaySwapSheet (from /strength?view=today or morning brief swap chip) — opens BottomSheet, preview-then-confirm works
- [ ] Force-tz dev (`USER_TIMEZONE=America/Los_Angeles npm run dev`) — header dates respect the override

- [ ] **Step 3: Confirm no console errors**

In Chrome DevTools while exercising routes above, the console must be free of React warnings and component errors.

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feat/v2-cleanup-and-recent
gh pr create --title "chore(v2): cleanup + /coach Recent tab + /login + /privacy reskin" --body "$(cat <<'EOF'
Slice 6 of V2 redesign. The wrap-up:

- Implements the \`Recent\` tab in /coach (date-list view)
- Deletes legacy coach components and their unused query hooks:
  - InsightsList, RecommendationsList, WeeklyReview, RefreshButton
  - CoachEntryCard (replaced by BriefStateChip in Slice 4)
  - useInsightsDaily / useWeeklyReview / useRecommendations + fetchers
- Reskins /login and /privacy in light theme
- Audits /onboarding for token consistency

Final cross-route verification: typecheck clean, every route exercised on mobile + desktop viewports with no console errors.

V2 redesign complete. 🎉

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist (run after writing this plan)

- [x] **Spec coverage:** Every section of the spec maps to a task.
  - Tokens (GRADIENT, CHAT, MUSCLE_COLOR, METRIC_COLOR expansion) → Tasks 1, 2, 3
  - BottomSheet primitive → Task 4
  - Chat primitives (ChatTurn/ChatTextBlock/ChatCard/ChatComposer/ModeBanner) → Tasks 8, 9 (ChatTurn is implicit in ChatMessage refactor — no separate wrapper file needed; ChatCard is the bare wrapper that PlanProposalCard etc. already extend by structure)
  - Structured cards (MorningBrief hero, BriefCoachSuggestion, Plan/Week/Block proposals, ChatChips) → Task 10 (MorningBrief hero); the existing proposal cards already render inline in ChatMessage flow — no separate task needed
  - /coach page layout → Task 11
  - Mode/state behavior → Task 11 (`embedded` mode in ChatPanel + `mode` prop wiring)
  - Dashboard BriefStateChip → Tasks 14, 15
  - /onboarding token reskin → Task 25
  - /health → already shipped; light-theme audit in Task 26
  - BottomSheet primitive + 3 consumers → Tasks 4, 6, 19, 20
  - LabPromptCard → Task 16
  - Muscle map → Task 18
  - /coach legacy cleanup → Task 23
  - /coach Recent tab → Task 22
  - /login + /privacy → Task 24
  - Verification → Task 26

- [x] **Placeholder scan:** No "TBD", "TODO", "implement later", or vague "handle edge cases" language. All steps have concrete code or commands.

- [x] **Type consistency:** Type references (`CoachView`, `IntakeState`, `BodyMeasurementKey`, `MorningBriefCardData`, `PlanPayload`, `BlockProposal`, `WeekProposal`, `ChatMode`) all source from `lib/data/types.ts` or `lib/ui/colors.ts` consistently across tasks.

- [x] **One change per task:** Each task is one logical commit. Slice 3 has more tasks than other slices because the chat surface conversion has multiple independent pieces — they could be a single commit but split for review clarity.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-14-app-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
