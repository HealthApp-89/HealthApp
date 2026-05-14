# Apex Health — app redesign V2 (integration pass) — design

**Status:** approved (spec)
**Date:** 2026-05-14
**Owner:** Abdelouahed
**Layered on:** [2026-05-05-app-redesign-design.md](./2026-05-05-app-redesign-design.md)

## Summary

The 2026-05-05 redesign spec was paused waiting for in-flight projects to land. Eight major features shipped during the pause: athlete profile Phase 1 (onboarding wizard) + Phase 2 (AI plan generation with chat intake), morning brief (daily structured card delivered in chat), schedule flexibility (mid-week swap UI), GLP-1-aware nutrition (lab-prompt card), strength muscle-map + click-to-select, mobility chat logging, charts revamp, and TanStack Query SSR-hydrate refactor. Two new routes appeared: `/onboarding` and `/health`.

This spec **layers on** the v1 redesign — it does not supersede it. v1's 12 locked decisions, design tokens (`COLOR`, `RADIUS`, `SHADOW`, `METRIC_COLOR`), primitives (`Card`, `Pill`, `StatusRow`, `MetricCard`, `LineChart`, `WeekStrip`, `RangePills`, `BottomNav`, `Fab`, `FabSheet`, `TopNav`), and six original route layouts (`/`, `/log`, `/trends`, `/strength`, `/coach` baseline, `/profile`) carry forward unchanged. This document captures what changes:

- A new structured-card spec for the chat surface (which v1 assumed would "inherit the new design automatically" — that assumption is now wrong because chat is the daily anchor).
- A dedicated `MorningBriefCard` design (the new daily artifact).
- Two new routes (`/onboarding` reskin, `/health` full layout).
- A `BottomSheet` reusable primitive (today: `FabSheet`, `DaySwapSheet`; future: any modal flow).
- Visual tokens for the new chat-message variants, muscle-map, and `LabPromptCard`.
- A revised build sequence (5 slices → 6) reflecting the chat-surface work that v1 did not plan for.

Backend code (sync, ingest, RLS, schema, integration merges, coach logic, plan-builder) is untouched.

## Goals

1. Bring the chat surface into the redesign language with the same care as the dashboard — it is now the daily-anchor surface, equal-weighted with `/`.
2. Establish a single visual rhythm for chat (every turn is a block) so structured cards and prose turns coexist cleanly.
3. Give the morning brief a dedicated structured-card design that holds up as the user's primary daily artifact.
4. Skin every feature shipped during the pause in the new design language without redoing their information architecture.
5. Consolidate single-use bottom-sheet implementations onto one reusable primitive.

## Non-goals (additions to v1's non-goals)

- Redesigning the `/onboarding` wizard layout. Phase 1 just shipped (PR #38, 2026-05-10) — the layout is too fresh to redo. Only design tokens swap.
- Redesigning the strength click-to-select interaction (PRs #57/#58). Logic stays; only `METRIC_COLOR` / `MUSCLE_COLOR` tokens swap.
- Inventing new chat capabilities. The chat mode set (`default | morning_intake | intake | plan_week | setup_block`) and message-kind set (`coach | morning_intake | morning_brief`) are fixed by code; only their visual treatment changes.
- Reflowing the brief's data model. The 5–7 blocks of `MorningBriefCard.ui` are wired by `app/api/chat/morning/recommendation/route.ts`; this spec lays them out visually but does not change which blocks exist.

## Locked decisions (additions to v1's 12)

| # | Decision | Rationale |
|---|---|---|
| 13 | **Co-equal surfaces.** `/` and `/coach` both get hero-level visual treatment. Brief gets a dedicated structured-card spec, not vanilla `Card`. | Daily flow now lives in chat (morning intake → brief → mid-week swaps → mobility logging). Treating chat as "auto-inherit" under-invests in the surface that drives the day. |
| 14 | **Card-feed chat language.** Every chat turn is a block. User turns get `accentSoft` tint; coach turns are plain prose. Cards drop in at full chat-column width with no bubble chrome conflict. | Chosen over bubble-and-card-stream and timeline-rail variants. Cards do more work than prose turns in this app — bubbles would constantly fight card width. |
| 15 | **All-visible stack for Morning Brief.** Solid-blue (or intensity-mode-mapped) hero readiness on top + every block visible vertically. No tabs, no collapse. | Brief is a once-a-day artifact; vertical length is fine in a scroll-anchored chat, but a re-tap to find macros at lunch is friction. |
| 16 | **Dashboard = state, brief = plan.** Dashboard retains `ReadinessHero` anchor + metrics + lifts + rollups. v1's `CoachCard` block is replaced by a compact `BriefStateChip`. Brief content never duplicates onto dashboard. | Two surfaces, two roles: dashboard answers "where am I right now?" with metrics; brief answers "what do I do today?". Single source of truth for prescription = the brief. |

## Design tokens (additions to `lib/ui/theme.ts`)

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

// Muscle-map fills (light theme — replaces dark-theme hexes in MuscleMap/MuscleOverlay/BodyView)
export const MUSCLE_COLOR = {
  idle:        "#e8eaf3",   // unworked — divider color, low contrast
  worked:      "#b45309",   // worked today — METRIC_COLOR.strain (amber)
  workedSoft:  "#fcd34d",   // worked recently (1–3 days)
  highlighted: "#4f5dff",   // click-to-select from exercise list — accent
  soreness:    "#ef4444",   // user-reported soreness area (morning intake) — danger
} as const;
```

The five hero gradients map 1:1 to the existing five `IntensityMode` colors via `modeColorLight()` from v1, so when the brief renders an intensity-mode-aware session hero (e.g. low-readiness day → muted), the gradient picks correctly: `PUSH HARD → heroSuccess`, `FULL SESSION → heroSuccess` (lighter mid-stop), `MODERATE → heroAmber`, `LIGHT / RECOVERY → heroDanger`, `REST DAY → heroMuted`.

New per-metric colors for `/health` circumference fields added to `METRIC_COLOR`:

```ts
waist:    "#0ea5e9",  // sky
hip:      "#8b5cf6",  // purple
chest:    "#10b981",  // emerald
arms:     "#f59e0b",  // amber
thighs:   "#ef4444",  // rose
calves:   "#06b6d4",  // cyan
```

Remaining 8 circumference fields (forearms, neck, wrists, ankles, etc.) reuse existing keys or fall back to `accent` if no dedicated key is assigned.

## Chat surface

### Primitives (under `components/chat/`)

| Primitive | Replaces / re-skin | Purpose |
|---|---|---|
| `ChatTurn` | wrap around existing `ChatMessage.tsx` | One block per turn. Vertically stacked. Top: 11px meta-row (`8:42 · Coach` or `8:43 · You · Morning brief`). Body: either `ChatTextBlock` or `ChatCard`. No avatars, no bubble tails. |
| `ChatTextBlock` | rewrite of `ChatMessage.tsx` text branch | Plain prose for coach turns (no background, 13px `body` color `textMid`, line-height 1.5). User turns get `accentSoft` background, `textStrong` color, `RADIUS.cardSmall` (14px), 10×12 padding. Right-aligned on mobile, in-flow on desktop chat column. |
| `ChatCard` | new wrapper | White surface, `RADIUS.card` (20px), `SHADOW.card`, full chat-column width. **All structured chat cards extend `ChatCard`** so they share radius/shadow/width and don't drift apart over time. |
| `ChatComposer` | re-skin of `components/chat/ChatComposer.tsx` | Sticky bottom. Rounded pill input (`#f5f6fa`, `RADIUS.pill`), camera icon (HEIC upload), send button (circular `accent`). Replaced by `ChatChips` when `mode === 'morning_intake'`. |
| `ModeBanner` | re-skin of `components/chat/ModeBanner.tsx` | Sticky top under page header. Mode pill (`PLAN WEEK`, `SETUP BLOCK`, `INTAKE`) + 1-line context + close (X). Hidden when `mode === 'default'`. `accentSoft` background, `accent` text. |

### Structured card variants (all extend `ChatCard`)

| Variant | Composition |
|---|---|
| `MorningBriefCard` | Hero band (`GRADIENT.heroAccent` by default, or intensity-mode-mapped) with `Brief · {date}` label + 44px readiness number + band pill (`Primed` / `Ready` / `Take it easy`) + 1-line subtitle. Then vertically stacked blocks: `Yesterday` (recap row) · `Today's session` (intensity-mode-aware list) or `RestActions` (mobility focus on rest days) · `Macros` (3 rows: Protein/Carbs/Fats with totals) · `Coach` (accentSoft block with quote-marker, AI-generated advice) · `Tonight` (1-row sleep target). Hairline `divider` between blocks. |
| `BriefCoachSuggestion` | Existing standalone component (`components/morning/BriefCoachSuggestion.tsx`) is **kept and restyled, but remains embedded inline within `MorningBriefCard`'s session-or-rest block** — it is not promoted to its own `ChatCard`. New styling: `warningSoft` background pill inside the brief, two buttons: `Switch to mobility` (primary `accent`) + `Keep planned session` (text). Disappears once acknowledged client-side. Render condition (`MorningBriefCard.ui.coach_suggestion?.kind === 'swap_to_mobility'`) and acknowledgment behavior unchanged. |
| `PlanProposalCard` | Plan-builder output (Phase 2 AI plan). Hero band `GRADIENT.heroAccent` with `Proposed plan · v{n}` label + 1-line goal narrative. Body: collapsible sections (Goal · Periodization · Strength template · Nutrition · Sleep · Recovery · Coaching agreement) — first 2 expanded by default. Footer: `Accept plan` (primary) + `Revise` (text). Existing HMAC token logic unchanged. |
| `WeekPlanProposalCard` | Sunday `plan_week` output. Header `Week of {Sun date}` + mode chip (Accumulate / Intensify / Realize / Deload / Recover). Body: 7-row session list (`Mon · Push · 4 lifts · RIR 2`). Footer: `Commit week` + `Revise`. |
| `BlockProposalCard` | Setup-block output (5-week mesocycle). Header `Block {n} · {goal}` + duration row. Body: weekly progression (W1 Accumulate / W2 Accumulate / W3 Intensify / W4 Realize / W5 Deload). Footer: `Start block` + `Revise`. |
| `ChatChips` | Used during `mode === 'morning_intake'`. Replaces `ChatComposer` in the composer slot. Renders the question's input UI: scale (1–10 grid for fatigue/soreness), single-select chips (Yes/No for sick, bloating), multi-select chips (soreness areas), free-text input, photo upload. Each chip = `RADIUS.pill` pill, `accent` when selected. |

### `/coach` page layout

```
┌─ Page header ───────────────────────────────────────────────┐
│  Coach                                              [···]    │
│  Today / Recent (segmented row)                              │
├─ ModeBanner (sticky, hidden when mode=default) ─────────────┤
│  [INTAKE]  Morning check-in · question 3 of 5     [✕]        │
├─ Feed (scrolling, max-width CHAT.feedMaxWidth) ─────────────┤
│   8:42 · Coach                                                │
│   Good morning. How'd you sleep?                              │
│                                                               │
│   8:43 · You                                                  │
│   [accentSoft tinted block: "Solid — 7h, woke once"]         │
│                                                               │
│   8:43 · Coach · Morning brief                                │
│   [ChatCard: MorningBriefCard with hero + 5 stacked blocks]   │
│   ...                                                         │
├─ ChatComposer (sticky bottom; replaced by ChatChips) ────────┤
└──────────────────────────────────────────────────────────────┘
```

The above-feed segmented control (`Today · Recent`) replaces the existing `CoachNav` pill row (which had `Today · Recommendations · Weekly · Strength`). Those legacy tabs go away as their content folds into the chat:

- `InsightsList` — deleted. Insights now flow through the brief's Advice block.
- `RecommendationsList` — deleted. Recommendations flow through coach turns and proposal cards.
- `WeeklyReview` — deleted as a standalone tab; the Sunday recap surfaces as a chat turn in `mode=plan_week`.
- `Strength` sub-tab from `/coach` — was a duplicate of `/strength`; deleted.
- `BlockProgressCard`, `PlanWeekCTA`, `WeekPlanCard` — kept; surface as chat cards or banners as appropriate.

### Mode / state behavior

Three orthogonal concepts drive what the chat surface shows:

- **`chat_messages.mode`** ∈ `default | plan_week | setup_block | intake` (migrations 0008 + Phase 2). Drives `ModeBanner` and proposal-card emission.
- **`chat_messages.kind`** ∈ `coach | morning_intake | morning_brief` (migration 0007). Drives card variant per message.
- **`checkins.intake_state`** (migrations 0007 + 0011) on a per-day basis: `awaiting_intake | in_progress | assembling_brief | brief_delivered | brief_failed`. Drives morning-intake composer takeover and retry affordance.

| Driver | Banner | Composer |
|---|---|---|
| `mode = default` and no active morning intake | hidden | `ChatComposer` |
| `intake_state ∈ {awaiting_intake, in_progress}` (regardless of mode) | `Morning check-in · question N of M` | `ChatChips` (replaces `ChatComposer`) |
| `intake_state = brief_failed` | `Brief retry available` + `Retry brief →` chip | `ChatComposer` (retry chip lives in banner) |
| `mode = intake` (Phase 2 plan-builder) | `Plan intake · beat N of 5` | `ChatComposer` (occasional chip-prompts via existing `ChatChips`) |
| `mode = plan_week` | `Plan week of {Sun date}` | `ChatComposer`; conversation ends with `WeekPlanProposalCard` |
| `mode = setup_block` | `Set up block {n}` | `ChatComposer`; conversation ends with `BlockProposalCard` |

Morning intake takes priority over mode: if `intake_state` is `awaiting_intake | in_progress`, the morning-intake UI wins regardless of `mode`. This matches the existing state-machine precedence in the codebase.

### Conversation entry points

CTAs that route into chat with the right state on tap:

- Dashboard `BriefStateChip` (locked decision #16): `awaiting_intake | in_progress` → `/coach` (page detects `intake_state` and renders morning-intake UI); `brief_delivered` → `/coach` with scroll-anchor to the brief turn.
- `/profile` "Generate plan" button → `/coach?mode=intake&doc=<id>` (existing)
- `/coach` contextual top banner (above feed, below page header) when `intake_state = awaiting_intake` and no morning intake messages exist for today: `Start morning check-in →` triggers the existing intake-kickoff flow.
- `/coach` contextual top banner on Sundays / Mon-Tue when no active `mode=plan_week` conversation exists for the upcoming week: `Plan this week →` (date-gated by existing `PlanWeekCTA` logic — kept as a banner, not deleted in the Slice 3 cleanup).

## Dashboard `/` — additions to v1 layout

v1 layout retained: `Header · WeekStrip · ReadinessHero · MetricCard 2×2 · ImpactDonut · Recent lifts · WeeklyRollups`. Single change:

**Replace v1's `CoachCard`** (the "tap to see today's plan" thumbnail) with a `BriefStateChip` between `WeekStrip` and `ReadinessHero`:

| State | Pill style | Content | Tap behavior |
|---|---|---|---|
| `brief_delivered` | `accentSoft` | `✓ Today's brief is ready` → `Open in chat →` | `/coach`, scroll-anchor to brief |
| `awaiting_intake` / `in_progress` | `warningSoft` | `Continue morning check-in` → `Resume →` | `/coach?mode=morning_intake` |
| `brief_failed` | `dangerSoft` | `Brief retry available` → `Retry →` | hits `/api/chat/morning/retry-brief` |
| none of the above | hidden | — | — |

State source: `checkins.intake_state` for the current date (per migrations 0007 + 0011). The chip uses `useDailyLogs(userId, today, today)` already on the dashboard plus a small `useIntakeState(userId, todayIso)` hook (new) over `checkins`.

## New routes

### `/onboarding` — token reskin only

The Phase 1 wizard layout is preserved exactly. Apply:

- Light background (`COLOR.bg`)
- `Card` primitive for step containers
- `accent` primary buttons
- `Pill` primitive for selected-option chips
- `StatusRow` for review-step rows
- DM Sans typography tokens
- Step indicator becomes a segmented `RangePills`-style row at the top (same primitive, different content — `Step 1 of 6` etc.)

No IA decisions; mechanical reskin.

### `/health` — full layout pass

Existing 3 views (`today · trend · log`) keep their structure; restyled in the new language:

1. **Header** — `Health · Body measurements` title, subtitle = month-year of selected entry.
2. **`HealthNav`** — restyled as a `RangePills`-style segmented row: `Today · Trend · Log`.
3. **`view=today`** — Latest measurement `Card` (large radius). Optional photo at top as `RADIUS.cardHero` aspect-1 image with overlay-pill date. 14 circumference fields as a `StatusRow` list below.
4. **`view=trend`** — `RangePills` (`3M · 6M · 1Y · All`). One `MetricCard` per circumference field with ≥2 data points, mini `LineChart` at the metric's color (`METRIC_COLOR` extensions above). 2-column grid on desktop.
5. **`view=log`** — `MeasurementForm` restyled. 14 numeric inputs as a 2-column grid of compact `Card` containers, each with a labeled input. Photo upload at top using existing HEIC transcode helper. Save button full-width `accent`.

**Nav home for `/health`:** the `FabSheet` gets a new action `Body measurement → /health?view=log`, sitting alongside the v1 actions (Log entry, Strength, Upload Strong CSV, Manage connections). On `/profile`, a `StatusRow` `Body measurements →` links to `/health` (default view = `today`). No bottom-nav tab — cadence is monthly, not daily.

## `BottomSheet` primitive (new — `components/ui/BottomSheet.tsx`)

| Spec | Value |
|---|---|
| Position | Fixed bottom, full width, max-width `560px` centered on desktop |
| Radius | `RADIUS.cardHero` (24px) top corners only |
| Shadow | `SHADOW.floating` (the page-lift shadow defined in v1) |
| Backdrop | Overlay `rgba(15,20,48,0.4)`, click-to-dismiss |
| Drag handle | 4px-tall × 36px-wide pill, `divider` color, centered top |
| Snap points | 60% viewport height (default), 90% (drag-up) |
| Dismiss | Swipe down, backdrop tap, or X button (top-right) |
| Safe area | `padding-bottom: env(safe-area-inset-bottom)` |

Consumers refactored to use this:

- `components/layout/FabSheet.tsx` → `BottomSheet` wrapper + content
- `components/strength/DaySwapSheet.tsx` → `BottomSheet` wrapper + content (preview/confirm body unchanged)
- `components/profile/ProfileForm.tsx` edit flow → opens as `BottomSheet` on mobile (currently inline)

## `LabPromptCard` on `/profile`

Card variant for the GLP-1 lab-prompt UI. Hero strip = `GRADIENT.heroAmber` (heads-up framing, not alarm). 6 `StatusRow` rows (B12 · vit D · magnesium · ferritin · grip strength · bone density), each with either `○ Pending` (muted) or `✓ Acknowledged {date}` (success). Tap → mark acknowledged (writes `profiles.lab_acknowledgments` jsonb per migration 0013). Renders only when the active plan's nutrition mode is `glp1_active | glp1_tapering` (existing visibility logic unchanged).

## Muscle map (color-only changes)

`MuscleMap.tsx` / `MuscleOverlay.tsx` / `BodyView.tsx` currently use dark-theme fills. Swap to `MUSCLE_COLOR` tokens above. Click-to-select interaction (PR #57) and exercise-muscle lookup (PR #58) unchanged.

If any muscle uses an inline-hex inside the SVG file (not a CSS variable), the swap is per-fill — verify at implementation time and convert to CSS variables if blocking.

## Build sequence (revised — 6 slices)

| Slice | Scope | Risk |
|---|---|---|
| 1 | **Tokens + base primitives** — `lib/ui/theme.ts` with `COLOR`/`RADIUS`/`SHADOW`/`METRIC_COLOR` (v1) + `GRADIENT`/`CHAT`/`MUSCLE_COLOR` (v2 additions). Tailwind `@theme`. `Card`, `Pill`, `StatusRow`, `MetricCard`, `LineChart` (v1). `BottomSheet` (v2). | Low — pure-additive, no page changes. |
| 2 | **Nav chrome** — `BottomNav`, `Fab`, `FabSheet` (refactored onto `BottomSheet`), `TopNav`, `WeekStrip`. Add `Body measurement` action to FabSheet. Wire into `app/layout.tsx`. Delete `components/layout/TabNav.tsx`. | Low — visual only. |
| 3 | **Chat surface (new heavy lifter)** — `ChatTurn`, `ChatTextBlock`, `ChatCard`, `ChatComposer`, `ModeBanner` re-skin. Re-skin every structured card: `MorningBriefCard`, `BriefCoachSuggestion`, `PlanProposalCard`, `WeekPlanProposalCard`, `BlockProposalCard`, `ChatChips`. Collapse `CoachNav` to `Today · Recent`, delete `InsightsList`/`RecommendationsList`/`WeeklyReview`. | Medium — biggest review surface, touches daily-anchor surface. Plan-writing may split into 3a (primitives + composer) and 3b (structured cards) if diff >800 lines. |
| 4 | **Dashboard `/`, `/log`, `/profile`** — v1 layouts + `BriefStateChip` (with `useIntakeState` hook) between `WeekStrip` and `ReadinessHero` on `/`. `LabPromptCard` on `/profile`. Refactor `ProfileForm` edit flow to `BottomSheet`. Delete `DashboardDatePager` and v1 `CoachCard`. | Low — additive. |
| 5 | **`/trends` + `/strength` + `/health`** — v1 layouts for `/trends` and `/strength`. Full layout for `/health`. Muscle-map color tokens applied. Refactor `DaySwapSheet` onto `BottomSheet`. | Low — `/health` is new but layout is straightforward. |
| 6 | **`/coach` legacy bits, `/login`, `/privacy`, `/onboarding` reskin, final cleanup** — re-skin `/login` and `/privacy`. Mechanical reskin of `/onboarding` (tokens only). Delete orphaned legacy components. Final `npm run typecheck` + manual cross-route verification. | Low — cleanup. |

Slices can ship in this order; later slices don't break if earlier ones aren't deployed. No hard ordering dependencies: Slice 4's `BriefStateChip` routes to `/coach` regardless of whether Slice 3 has styled it — at worst, the chip links to a still-legacy chat view, which is a graceful intermediate state.

## Risks acknowledged (additions to v1's risk list)

- **Chat surface PR is the largest in the redesign.** Slice 3 touches ~20 component files. Worth splitting if diff >800 lines.
- **`InsightsList` / `RecommendationsList` deletion is destructive.** If the standalone view is missed post-merge, deletion can be reverted as a small follow-up — components remain in git history. The bet is that Brief Advice + chat coach turns + proposal cards cover the surface area.
- **Muscle-map repaint depends on actual SVG fills.** If any fill is inline-hex inside the SVG, the swap is per-fill — verify at impl time.
- **BottomSheet refactor compatibility.** `DaySwapSheet`'s preview-then-confirm UX must survive the wrapper swap. Snap-points and dismiss behavior are the touch points to test manually.
- **Brief-state chip needs an `intake_state` hook.** Adds one new TanStack Query fetcher (`fetchIntakeStateServer` / `fetchIntakeStateBrowser` over `checkins` filtered to today) and one key in `lib/query/keys.ts`. Straightforward but adds a query.

## Verification (additions to v1's verification list)

- `/coach` renders the card-feed pattern: every turn is a block, no bubble tails
- Morning brief card renders with hero + 5 visible blocks; no tabs, no collapse
- Brief-state chip on `/` reflects current `intake_state`; tap routes to `/coach` and the page renders the matching intake / brief view
- When `intake_state ∈ {awaiting_intake, in_progress}`, the composer is replaced by `ChatChips` regardless of `mode`; `mode=plan_week` shows `WeekPlanProposalCard` at the end of the conversation; `mode=setup_block` shows `BlockProposalCard`
- `/health` renders in all 3 views; FabSheet's "Body measurement" action routes to `/health?view=log`
- `LabPromptCard` renders on `/profile` only when active plan is GLP-1 mode; acknowledging a row updates `profiles.lab_acknowledgments`
- `DaySwapSheet` and `FabSheet` open as the new `BottomSheet`; swipe-down dismisses; safe-area inset respected on iOS PWA
- Muscle-map fills use `MUSCLE_COLOR` tokens; click-to-select highlight still works
- Legacy coach tabs (`Recommendations`, `Weekly`, `Strength`) no longer exist; their entry points (CTAs, links) are removed
- `/onboarding` renders with light tokens; wizard layout unchanged

## Out of scope (additions to v1's out-of-scope list)

- Onboarding wizard layout redesign (Phase 1 too fresh)
- Strength click-to-select interaction redesign (logic unchanged)
- Adding new chat modes or message kinds
- Restructuring the brief's block list (the 5–7 blocks are wired by backend)
- New `/health` features (just visual)
- Dark theme variant for chat or brief
- Animation for the brief's blocks (subtle fade-in only; no orchestrated reveal)
