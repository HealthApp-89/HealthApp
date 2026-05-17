# Apex Health — redesign V3 (coach identity + 4-tab nav) — design

**Status:** draft
**Date:** 2026-05-17
**Owner:** Abdelouahed
**Layered on:** [2026-05-14-app-redesign-design.md](./2026-05-14-app-redesign-design.md) (v2), which layered on [2026-05-05-app-redesign-design.md](./2026-05-05-app-redesign-design.md) (v1)

## Summary

V2 finished the visual port to "Soft & Light" and brought the chat surface up to dashboard parity. After it shipped, an independent design review surfaced three remaining issues that V2 didn't address:

1. The chat reads like a developer's debug console — no coach identity, no voice, no card-chrome unification across the five special-card variants (MorningBrief, WeeklyReview, ProactiveNudge, WeekPlanProposal, PlanProposal).
2. The app has seven+ navigation entry points (5 top-nav tabs + 6-item FAB sheet) — a discovery and IA tax that the user explicitly called out as the biggest pain.
3. The dashboard's hero treats readiness as the headline. The contributing metrics ("HRV down 8, sleep light") that explain the score are split across three separate widgets (MetricCard, ImpactDonut, MonitorTile), forcing scrolling to answer "why is it 82?".

V3 resolves these. The coach gets a name (Coach Carter), a character, and a voice. Navigation consolidates to four bottom tabs (Today / Metrics / Coach / Profile) with no top nav and no FAB. The Today hero becomes a single card that answers "how am I" and "why" together. Chat gains a pinned anchor so the day's content is always one glance away rather than five messages back in scroll. Metrics and Coach each gain a sub-pill organization that scales (Metrics: Strength/Body/Trends + sticky Log; Coach: Chat/Progress/Reviews).

Backend, schema, sync, ingest, coach planning tools, and the plan-builder pipeline are untouched. This is a presentation-layer revision, not a feature change.

## What changes vs V2

- **Coach is named "Coach Carter"** with avatar in chat header + per-turn. V2 had no coach identity.
- **Carter voice** is character-led — terse, evidence-driven, signature framing — with a specific tone calibration (Steady default + always demanding about protein).
- **Chat surface** gains a pinned "Today" anchor at the top showing session + readiness + protein floor.
- **Card chrome unifies** — V2's five special-card variants migrate to one `<CoachCard>` primitive with consistent eyebrow/title/body/actions slots.
- **Bottom nav** replaces top nav (V2 still had `TopNav.tsx`) and replaces FAB entirely. Four tabs: Today / Metrics / Coach / Profile.
- **Routing consolidates** — `/trends`, `/strength`, `/health` (body measurements), `/log` all live under `/metrics` with sub-pill navigation. `/coach/trends` becomes `/coach/progress` (renamed). `/coach/weeks/[week_start]` rolls up under a new `/coach/reviews` index.
- **Dashboard hero** flips from "big score + impact donut spread across the card stack" to a single Hybrid card: narrative sentence as headline, score + three contributing metric cells layered in the same card.
- **Icons** — every emoji glyph in nav, FAB, MetricCard, MonitorTile, BriefStateChip, etc., replaced with `lucide-react`.

## What carries forward unchanged

- All V1 design tokens (`COLOR`, `RADIUS`, `SHADOW`, `METRIC_COLOR`) and V2 additions (`GRADIENT`, `CHAT`, `MUSCLE_COLOR`).
- V2's `ChatTurn` / `ChatTextBlock` / `ChatCard` primitives — V3 only adds `CoachAvatar` and `TodayAnchor` alongside them.
- The morning brief data model (`MorningBriefCard.ui` blocks).
- All Anthropic-powered planning, plan-builder, weekly-review, and proactive-nudge logic.
- The migration set (no schema changes).
- DM Sans / DM Mono via `next/font` (no font swap).
- `lib/ui/theme.ts` constants and `calcScore()` math.

## Non-goals

- Renaming or migrating database columns. The `chat_messages.kind` discriminator (`coach | morning_intake | morning_brief | weekly_review | proactive_nudge`) is unchanged.
- Re-implementing the morning intake state machine. The slot-filling flow (sick/fatigue/bloating/soreness) stays — only its visual treatment changes.
- Rewriting `/onboarding`. The 6-step wizard from athlete profile Phase 1 (PR #38) is untouched; only icon/tokens swap.
- Inventing new chat modes. The existing mode set (`default | morning_intake | intake | plan_week | setup_block`) is fixed.
- Building a separate "Signals" stream for proactive nudges. They continue to appear inline as cards in chat (the pinned anchor solves the discoverability problem the review raised).
- Animations beyond the ones explicitly noted (Carter typing pulse, card mount fade). No view-transitions, no readiness ring animation, no live readiness mid-input updates. Those are V4 candidates.

## Locked decisions (continuing V2's numbering)

| # | Decision | Rationale |
|---|---|---|
| 17 | **Coach is named "Coach Carter"** — character-led identity. Avatar in chat header + per-grouped-turn. | Review identified absence of coach identity as the chat's biggest weakness. Reference: 2005 film — tough love, evidence-driven, won't let athletes coast, believes in them. |
| 18 | **Carter voice: Steady default + always-demanding about protein.** Escalation triggers for other patterns (3+ short sleeps/7d, 2+ missed sessions/14d, HRV trending down 10+d). | A coach demanding every day stops being heard. Steady reads the room; protein floor (1.8 g/kg BW) is non-negotiable because of GLP-1 mode FFM protection. |
| 19 | **Chat = conversation + pinned Today anchor.** Anchor shows session name + readiness + protein floor. Inline cards (brief, weekly review, proactive nudges) still appear in the thread; anchor stays sticky above. | Today's content was 5 messages back in scroll. Anchor solves discoverability without splitting state across a separate "Signals" surface. |
| 20 | **4-tab bottom nav: Today · Metrics · Coach · Profile.** No top nav. No FAB. | Replaces 5-tab top + 6-item FAB sheet. Discovery tax was the largest IA pain. |
| 21 | **Metrics tab: sub-pills [Strength · Body · Trends] + sticky "+ Log entry".** Strength and Body first (daily-doing); Trends third (analytical lookback). | Logging is a primary action (write), not a sibling view (read). Sticky button keeps log reachable from any sub-pill. |
| 22 | **Coach tab: sub-pills [Chat · Progress · Reviews].** "Progress" = current `/coach/trends` (renamed for clarity). "Reviews" = past weekly reviews indexed. | Mirrors Metrics sub-pill pattern. Past reviews need browsing as a library; relying on chat-scroll doesn't scale past month one. |
| 23 | **Profile is setup-only.** Manage connections + Upload Strong CSV + Baselines & settings. NO log entry. | Daily actions don't share a tab with one-time setup. |
| 24 | **Dashboard hero: Hybrid.** One narrative sentence as headline; readiness score + three contributing metric cells layered below in same card. Replaces V1's `ReadinessHero` + V2's `BriefStateChip` chip pattern. | One card answers "how am I" and "why" without scrolling. |
| 25 | **Icons: `lucide-react` everywhere.** All emoji removed. | Cross-platform consistency, single weight, single rendering path. |

## Architecture

### Routing & navigation

**Removed routes**:
- `/trends` → content moves under `/metrics?sub=trends`
- `/strength` → content moves under `/metrics?sub=strength`
- `/health` → content moves under `/metrics?sub=body`
- `/log` → opens as a sheet from `/metrics` sticky button (no standalone route)
- `/coach/trends` → renames to `/coach/progress`

**New routes**:
- `/metrics` — sub-pill landing (defaults to Strength)
- `/coach/reviews` — index of past weekly reviews

**Surviving routes**:
- `/` (Today)
- `/coach` (Chat sub-pill)
- `/coach/progress` (renamed from /coach/trends)
- `/coach/weeks/[week_start]` (individual weekly review — linked from `/coach/reviews` index)
- `/profile`
- `/onboarding`
- `/login`
- `/privacy`

**Server-side redirects**:
- 308 from `/trends` → `/metrics?sub=trends`
- 308 from `/strength` → `/metrics?sub=strength`
- 308 from `/health` → `/metrics?sub=body`
- 308 from `/coach/trends` → `/coach/progress`
- (no 308 for `/log` — it's a sheet now, removed entirely from routing)

PWA shortcuts and any external links pointing at the old routes resolve via the redirects. Audit `app/manifest.ts` and update before merging.

### Tab content map

| Tab | Default sub-pill | Sub-pills | Sticky primary action |
|---|---|---|---|
| Today | (none) | (none) | (none — passive read) |
| Metrics | Strength | Strength · Body · Trends | `+ Log entry` (opens sheet) |
| Coach | Chat | Chat · Progress · Reviews | (none — chat composer is the action) |
| Profile | (none) | (none) | (none) |

### Component changes

#### New primitives

**`components/coach/CoachAvatar.tsx`** — circular gradient with "C" monogram. Sizes: 26px (in-turn), 36px (chat header), 56px (Profile mention if added).

```tsx
type Props = { size?: 26 | 36 | 56 };
// Renders: <div style={{ background: GRADIENT.heroAccent, ... }}>C</div>
```

**`components/chat/TodayAnchor.tsx`** — sticky card pinned above the chat scroll. Two-row compact card:
- Row 1: session-name (bold) · separator · readiness score (accent color)
- Row 2: top exercises (truncated) · separator · `P {floor}g floor` (accent)

Data source: same `MorningBriefCard.ui` payload that the brief already produces. If no brief exists for today, render a placeholder with "Morning check-in pending → tap to start". Hides entirely on day-switch (no anchor when scrolling to yesterday).

**`components/layout/SubPillNav.tsx`** — pill-row sub-navigation. Used by `/metrics` and `/coach`. Active pill takes accent background + white text. Inactive pills are white-on-paper-grey with hairline border. URL state via `?sub=<key>`.

**`components/metrics/LogEntrySheet.tsx`** — opens from the sticky `+ Log entry` button. Three primary options (Lift · Meal · Body measurement) plus the existing CSV import as a secondary entry point.

**`components/coach/CoachCard.tsx`** — unified card chrome. Replaces ad-hoc styling on `WeeklyReviewCard`, `ProactiveNudgeCard`, `WeekPlanProposalCard`, `PlanProposalCard`. Composition:

```tsx
<CoachCard tone="default | alert | ok">
  <CoachCard.Eyebrow>{label}</CoachCard.Eyebrow>      {/* 11px caps tracked */}
  <CoachCard.Title>{title}</CoachCard.Title>          {/* 18px 700 */}
  <CoachCard.Body>{children}</CoachCard.Body>
  <CoachCard.Actions>{buttons}</CoachCard.Actions>    {/* right-aligned row */}
</CoachCard>
```

`MorningBriefCard` is the exception — its hero gradient and all-visible vertical stack from V2 stays. Other cards conform.

#### Re-skinned primitives

- `BottomNav.tsx` — drops Strength from the list, keeps four tabs: Today / Metrics / Coach / Profile. Icons: `Home`, `BarChart3`, `MessageCircle`, `User` (from lucide).
- `TopNav.tsx` — **deleted**. Page titles render inline in each route's page header.
- `Fab.tsx`, `FabGate.tsx`, `FabSheet.tsx` — **deleted**. Single-use admin actions (CSV upload, manage connections) move to Profile rows.
- `ReadinessHero.tsx` — rewritten as `TodayHeroHybrid`. New shape per decision #24.
- `BriefStateChip.tsx` — **deleted**. Dashboard no longer has a "brief ready" gate; brief content surfaces in the Today hero narrative + opens full in chat via CTA.
- `ChatMessage.tsx` — coach turns gain a `CoachAvatar` and 12px vertical padding (up from 6px); user bubbles drop `accentSoft` background → neutral `surface-alt`; the 9px uppercase meta line drops in favor of a long-press timestamp; `kindTag` suffix removed.

### File structure changes

```
app/
  metrics/
    page.tsx              # sub-pill landing, redirects to ?sub=strength by default
    layout.tsx            # holds SubPillNav and sticky Log button
  coach/
    page.tsx              # Chat sub-pill (default)
    progress/
      page.tsx            # was /coach/trends
    reviews/
      page.tsx            # new index of past weekly reviews
    weeks/[week_start]/   # unchanged

components/
  coach/
    CoachAvatar.tsx       # new
    CoachCard.tsx         # new
  chat/
    TodayAnchor.tsx       # new
  layout/
    SubPillNav.tsx        # new
    BottomNav.tsx         # re-skinned (Strength removed, lucide icons)
    TopNav.tsx            # DELETED
    Fab.tsx               # DELETED
    FabGate.tsx           # DELETED
    FabSheet.tsx          # DELETED
  metrics/
    LogEntrySheet.tsx     # new
```

`app/trends/`, `app/strength/`, `app/health/`, `app/log/` directories are **deleted**. Their page-level React lives moves into `app/metrics/` sub-pill renderers (which read `?sub=` and route to the right sub-page component).

## Voice rules — Coach Carter

Voice rules are enforced via the coach system prompt. Lives in `lib/coach/prompts.ts` alongside existing prompts.

### Default tone (Steady)

- Terse. Two sentences max per turn unless a question demands detail.
- Evidence-driven. State the data before the recommendation: "HRV down 8. Pull back today."
- No filler. Drop "I think", "maybe", "you might want to consider". Carter doesn't hedge.
- Signature framings: "honest read", "we don't quit, we adjust", "your call" (when delegating), "earned" (when crediting).
- Address the user directly. No third-person.
- Adjusts the session to the data, doesn't lecture about the data.

### Protein-demanding exception (always on)

When today's logged protein is below the user's floor (currently 1.8 g/kg BW; 2.0 for tirzepatide), Carter raises tone:
- Explicit callout: "Protein's at {n} g. Floor is {floor} g. That's the lever for this cut."
- Repeats across days if pattern persists. Doesn't get bored of saying it.
- When the floor is hit: brief acknowledgment, then drops it. "Protein hit. Good."

### Escalation triggers (other patterns)

| Trigger | Behavior |
|---|---|
| 3+ short sleeps (<6h) in 7 days | Directly names the streak, asks about cause (caffeine, stress, schedule). |
| 2+ missed sessions in 14 days | Calls the streak, demands a plan: "We make it up this week, or we re-cut the block. Which?" |
| HRV trending down 10+ consecutive days | Flags it as a system signal, considers proposing a deload. |
| Average daily steps drop >30% week-over-week | One pointed mention, not nagging. |

Escalation triggers compute server-side (a new `lib/coach/voice/triggers.ts` module that runs alongside the snapshot prefix and injects detected triggers into the system prompt for that turn).

### Implementation notes

- Existing `lib/coach/prompts.ts` `buildSystemPrompt` gains a voice-rules section.
- The athlete profile's existing snapshot prefix continues to inject baselines.
- The `set_glp1_status` / `set_glp1_taper_started` / `mark_glp1_discontinued` tools also map their state into protein-floor calculation (which already exists in plan-builder).
- No new chat mode required for the protein callout — it surfaces in `default` mode turns.

## Visual tokens (additions)

```ts
// New semantic delta colors — for trend rows, metric cells, BodyTile diffs
export const DELTA_COLOR = {
  up_good:   COLOR.success,    // weight down on cut, HRV up, PR
  down_good: COLOR.success,
  up_bad:    COLOR.danger,
  down_bad:  COLOR.danger,
  neutral:   COLOR.muted,
} as const;

// Today anchor tokens
export const ANCHOR = {
  height:      "auto",     // wraps to 2 lines
  bg:          COLOR.surface,
  border:      `1px solid ${COLOR.divider}`,
  pinTagBg:    COLOR.accent,
  pinTagColor: "white",
  pinTagSize:  "9px",
} as const;

// Sub-pill nav tokens
export const SUB_PILL = {
  gap:           "6px",
  padding:       "8px 12px",
  radius:        "999px",
  borderInactive: `1px solid ${COLOR.divider}`,
  bgInactive:    COLOR.surface,
  bgActive:      COLOR.accent,
  fontSize:      "12px",
  fontWeight:    600,
} as const;
```

No changes to fonts. No changes to existing `COLOR` tokens.

## Build sequence

Ordering follows the independent design review's prioritization: icons & card chrome first (highest visual-quality unlock per hour of work), then dashboard hero, then coach identity, then nav consolidation. Eight slices, each independently shippable.

**Slice 1 — Icon swap (Expert priority #1, part A)**
1. Add `lucide-react` to dependencies (already common in Next/Tailwind apps).
2. Map every emoji in `components/` to a lucide icon: nav (`Home`, `BarChart3`, `MessageCircle`, `User`), `MetricCard` (`Activity`, `Moon`, `Zap`, `Scale`, `Percent`), `MonitorTile`, `BriefStateChip`, `Fab` sheet (`Pencil`, `MessageSquare`, `Dumbbell`, `Ruler`, `Upload`, `Plug`).
3. No structural changes — purely a 1:1 glyph swap. Single PR.

**Slice 2 — `CoachCard` primitive + migrate 4 cards (Expert priority #1, part B)**
1. Build `components/coach/CoachCard.tsx` with `Eyebrow`/`Title`/`Body`/`Actions` slots.
2. Migrate `WeeklyReviewCard`, `ProactiveNudgeCard`, `WeekPlanProposalCard`, `PlanProposalCard` to use `CoachCard` chrome. Audit before-and-after padding/radius consistency.
3. `MorningBriefCard` keeps its hero gradient + all-visible vertical stack from V2 (explicit exception).

**Slice 3 — Today hero hybrid (Expert priority #2)**
1. Build `components/dashboard/TodayHeroHybrid.tsx` (replaces `ReadinessHero` + `BriefStateChip`).
2. Wire narrative-sentence generation in `lib/coach/readiness.ts` — the contributing-impact data exists; expose as one sentence ("Sleep ran light — five-twelve, two interruptions. HRV pulled back eight from baseline.").
3. Three contributing metric cells render inline (HRV/Sleep/Strain with deltas).
4. Delete `ReadinessHero.tsx`, `BriefStateChip.tsx`.
5. Reduce `ImpactDonut` placement to a collapsible "Why" section below the hero (or remove entirely if the hero's metric cells are sufficient — tune during implementation).

**Slice 4 — Coach Carter identity + chat message polish (Expert priority #3, part A)**
1. Build `components/coach/CoachAvatar.tsx` (gradient circle, "C" monogram, three sizes).
2. Update `ChatMessage.tsx`: avatar on coach turns (only first turn in a consecutive group), drop `kindTag` suffix, drop 9px uppercase meta line in favor of long-press timestamp, bump 6px → 12px vertical padding, group consecutive coach messages.
3. User bubble: drop `accentSoft` background → neutral `surface-alt`, drop tail conflicts with cards.
4. Update chat header to "Coach Carter" with avatar + online indicator.
5. Replace `blink-block` streaming cursor with pulse-dot triplet (already defined as `.brief-pulse-dot` in `globals.css`).

**Slice 5 — Carter voice + protein exception + escalation triggers (Expert priority #3, part B)**
1. Build `lib/coach/voice/triggers.ts` — pure function that takes recent `daily_logs` + active `training_weeks` + `chat_messages` and returns active triggers.
2. Update `lib/coach/prompts.ts` `buildSystemPrompt`: add a voice-rules section with the Steady tone + protein exception + Carter framings.
3. Per-turn trigger injection: when a trigger fires, append a directive to the system prompt for that turn ("User has 3 short sleeps this week — address it directly.").
4. Update plan-builder `narrative-prompt.ts` and morning-brief Advice generation to use Carter voice patterns (no separate prompts needed — they call the same `buildSystemPrompt`).

**Slice 6 — Pinned Today anchor in chat (Expert priority #3, part C)**
1. Build `components/chat/TodayAnchor.tsx` — two-line compact card with session name + readiness + top exercises + protein floor.
2. Mount above `ChatThread` on `/coach`, sticky-positioned with `position: sticky; top: 0`.
3. Reads same `MorningBriefCard.ui` payload that the brief renders. Placeholder "Morning check-in pending →" when no brief.
4. Hidden when scrolling to a non-today date (anchor is for "today's plan", not history).

**Slice 7 — Nav consolidation + routing restructure (V3-specific work)**
1. New `BottomNav.tsx` with 4 tabs + lucide icons (from Slice 1's set).
2. Delete `TopNav.tsx`, `TopNavGate.tsx`, `Fab.tsx`, `FabGate.tsx`, `FabSheet.tsx`.
3. Build `app/metrics/` shell with `SubPillNav` + sticky "+ Log entry" button.
4. Build `components/metrics/LogEntrySheet.tsx` (Lift / Meal / Body measurement).
5. Move `app/trends/`, `app/strength/`, `app/health/`, `app/log/` content into `/metrics` sub-pill renderers.
6. Add 308 redirects in `next.config` (or via `middleware.ts`) for `/trends`, `/strength`, `/health`, `/log`.
7. Update `app/manifest.ts` PWA shortcuts.

**Slice 8 — Coach tab restructure (V3-specific work)**
1. Rename `/coach/trends` → `/coach/progress` with 308 redirect.
2. Build `app/coach/reviews/page.tsx` index (list of past weekly reviews, deep-links to `/coach/weeks/[week_start]`).
3. Add `SubPillNav` to `app/coach/layout.tsx` with [Chat · Progress · Reviews].

Slices 1–6 are visual-quality work; slices 7–8 are IA restructuring. Slices 1 and 2 should land first because they unlock the visual fidelity of every subsequent slice (slices 3–6 use lucide icons and `CoachCard` chrome).

## Open items deferred to V4

- Animations: card mount fade, readiness number tween, page transitions.
- Day-as-card timeline view for /metrics (the review's "bold idea #3").
- Live readiness updates during morning intake.
- Pulling proactive nudges into a separate "Signals" stream (the anchor pattern solves the symptom; this would be the deeper IA move).
- Empty/error/loading state catalog — V3 inherits V1/V2's existing patterns; a dedicated state-design pass is deferred.

## Acceptance criteria

- All five lucide icon swaps land cleanly (BottomNav, MetricCard, MonitorTile, ProfileRows, anywhere else emoji appears in `components/`).
- Type-check passes (`npm run typecheck`).
- Each old route URL (`/trends`, `/strength`, `/health`, `/coach/trends`) returns 308 to its new location on a production build.
- The chat shows "Coach Carter" in the header, an avatar on each grouped coach turn, and a sticky Today anchor when on `/coach` with a same-day brief.
- The dashboard `/` renders a single Hybrid hero card (narrative + score + 3 metric cells).
- Tapping `+ Log entry` in `/metrics` opens a sheet with three log options.
- Carter's voice in a sample morning conversation matches the calibration (terse, evidence-driven, no hedge words) — manual review check.
- Protein-demanding rule fires correctly: simulate a day with logged protein below floor → next assistant turn includes the callout phrasing.
- No references to `TopNav`, `Fab`, `FabSheet`, `ReadinessHero`, `BriefStateChip` remain in the codebase post-merge.
