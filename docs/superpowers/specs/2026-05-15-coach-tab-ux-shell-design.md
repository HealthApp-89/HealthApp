# Coach Tab UX Shell + Tool Discovery — Design

**Date:** 2026-05-15
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #3 of the "coach-as-real-coach" arc. Builds on Sub-project #1 (Weekly Review Document, shipped 2026-05-15) and Sub-project #2 (Daily Coach Loop, shipped 2026-05-15). Two sub-projects remain in the arc — Proactive reach-out (#4), Trend layer (#5) — both deferred.

## Problem

The chat-first V2 coach pivot delivered a powerful conversational surface but left functionality invisible. Sub-projects #1 and #2 added a weekly review document, a kickoff brief variant, an analytical Tue–Sat brief, plus a growing tool registry. The coach AI can now invoke 15+ structured tools (read tools like `query_workouts` / `compute_adherence`, plus mutate tools like `swap_session`, `regenerate_morning_brief`, `commit_weekly_plan`, `propose_nutrition_adjustment`, `mark_mobility_done`). **None of these are discoverable.** A new visitor to `/coach` sees an empty composer with no hint of what coach can do; to swap a session or regenerate a brief, the user has to type natural language and hope the AI routes correctly.

Three concrete gaps:

1. **No "ask me" affordance.** The composer is empty. The user has no idea what queries the coach handles well. Tapping the composer surfaces the keyboard, not suggestions.
2. **Structured tools are buried.** Swap a session? Adjust kcal? Regenerate today's brief? All exist as tools but the AI must route correctly. A direct affordance — visible, single-tap — is missing.
3. **Jargon is dense.** The coach voice now uses MEV / MAV / MRV / RIR / e1RM / deload / efficiency as everyday vocabulary (Sub-project #2 baked the teacher-tone "define-on-first-use" rule into the AI prompts). But once the prose has moved on, badges like "MAV" or "RIR 2" still appear on the structured blocks with no on-tap definition. The user has to scroll back to the prose for the explainer.

This spec covers the Coach Tab UX shell: **chips above the composer** (4 most-leveraged shortcuts), a **new Tools nav tab** organized by scope (TODAY / THIS WEEK / THIS BLOCK / REFERENCE), and **tap-to-explain jargon tooltips** on phase pills, RIR badges, and e1RM labels across brief and review surfaces. A single shared `lib/coach/glossary.ts` module owns the term dictionary — consumed by both the AI prompt (replacing the inline glossary in `advice-prompt.ts`) and the tooltip UI. No new tables, no migration, no new endpoints. Pure UX + small module extraction.

## Goals

1. **Surface the 4 most-leveraged actions above the composer.** "How am I tracking?" / "What's today's plan?" / "Swap today's session" / "Adjust deficit". Two queries (auto-submit the composer) and two mutate-actions (open existing sheets directly).
2. **Browsable Tools tab as the full library.** New `Tools` view in `CoachNav` alongside `Today` and `Recent`. Categorized list: TODAY (3 rows) / THIS WEEK (3 rows) / THIS BLOCK (2 rows) / REFERENCE (1 row → Glossary). Each row is a single-tap action that opens an existing sheet, navigates to an existing flow, or invokes a server endpoint.
3. **Tap-to-explain jargon tooltips.** Tapping any glossary term (rendered via a new `JargonPill` component) slides up a `BottomSheet` with the plain-English definition. Reuses Sub-project #2's existing teacher-tone glossary content; same definitions everywhere.
4. **Single source of truth for the glossary.** New `lib/coach/glossary.ts` exports the term dictionary. Sub-project #2's `advice-prompt.ts` `TEACHER_TONE_RULES` rewrites to read from this module instead of hardcoding the glossary inline. Tooltips read the same module. No drift.
5. **No new chat card kinds, no new tables, no new migrations.** Pure UX surface.
6. **Disabled-state visibility.** When a chip / tool row's prerequisite is missing (e.g. "Adjust deficit" with no draft weekly_review), the affordance renders disabled with a tap-to-explain tooltip stating the reason.
7. **Stay light.** Total new component footprint: ~6 new files, all under 100 lines each. No new dependencies.

## Non-Goals

- **Context-aware chips.** v1 ships 4 static chips that always render. No varying by day-of-week, intake state, or recent activity. Easy to layer in a future spec if usage patterns warrant.
- **Chip analytics / telemetry.** No tracking of which chips get tapped. Single-user app; defer.
- **Tools-tab search (T3 command palette).** Out of scope. Categorized list (T2) is the chosen layout.
- **Tooltip popover variant.** All tooltips use the existing `BottomSheet` primitive. No new popover infrastructure. Acceptable visual heaviness trade for zero new primitives.
- **Touch-and-hold preview on chips.** Tap-only.
- **Glossary entries for compound metrics** (`/LBM`, `IPF GL`, allometric slope). v1 ships the 7-term glossary from Sub-project #2's prompt (MEV, MAV, MRV, RIR, deload, e1RM, efficiency) plus the periodization `rationale_tag` family (`mev_to_mav_clearance`, `mav_to_mrv_advance`, `deload_load_volume_cut`, etc. — about 10 entries). Easy to extend later by appending to the dictionary.
- **A separate `/coach/glossary` page.** Glossary lives in the Tools tab's REFERENCE section, opening a `GlossarySheet` bottom-sheet. Keeps coach surface count low.
- **Re-skin of the existing chat composer.** `ChatComposer.tsx` is untouched. The chip strip is a new component rendered just above the composer.
- **New AI / Anthropic calls.** Sub-project #3 is pure UX wiring — zero AI integration.

## Architecture overview

Three independent deliverables (one per PR):

```
                      ┌─────────────────────────────────────┐
                      │  lib/coach/glossary.ts (new)        │
                      │  Single source of truth for terms.  │
                      │  Consumed by both UI + AI prompt.   │
                      └────┬─────────────────────────────┬──┘
                           │                             │
              ┌────────────▼──────┐         ┌────────────▼──────────┐
              │  PR 1 — Glossary   │         │  Sub-project #2       │
              │  module + tooltips │         │  retrofit: advice-     │
              │                    │         │  prompt.ts reads new   │
              │  JargonPill.tsx    │         │  module (was inline)   │
              │  TermSheet.tsx     │         └───────────────────────┘
              │  retrofit brief +  │
              │  review surfaces   │
              └────────────────────┘

                      ┌──────────────────────────────────────┐
                      │  PR 2 — Tools nav tab               │
                      │                                      │
                      │  CoachNav adds "Tools" pill          │
                      │  /coach?view=tools renders ToolsView │
                      │  ToolsView dispatches to existing    │
                      │    sheets / routes / endpoints       │
                      └──────────────────────────────────────┘

                      ┌──────────────────────────────────────┐
                      │  PR 3 — Composer suggestion chips    │
                      │                                      │
                      │  ComposerSuggestionChips renders     │
                      │    above ChatComposer in default mode │
                      │  4 static chips                      │
                      │  Chip actions: prefill composer or   │
                      │    open existing sheet               │
                      └──────────────────────────────────────┘
```

Files changed (new + modified):

| Path | Change |
|---|---|
| `lib/coach/glossary.ts` | **New.** Exports `GLOSSARY: Record<TermKey, { label: string; short: string; plain: string }>` |
| `components/coach/JargonPill.tsx` | **New.** Tappable pill that opens a TermSheet |
| `components/coach/TermSheet.tsx` | **New.** BottomSheet rendering a single term's definition |
| `components/coach/GlossarySheet.tsx` | **New.** BottomSheet listing all terms |
| `components/coach/ToolsView.tsx` | **New.** Tools tab page container |
| `components/coach/tools/ToolRow.tsx` | **New.** Reusable row component for tool listings |
| `components/chat/ComposerSuggestionChips.tsx` | **New.** Chip strip above the composer |
| `components/coach/CoachNav.tsx` | Add `Tools` pill |
| `components/coach/CoachClient.tsx` | Render `ToolsView` when `activeView === 'tools'` |
| `components/chat/ChatPanel.tsx` | Render `ComposerSuggestionChips` above `ChatComposer` when `mode === 'default'` |
| `lib/morning/brief/advice-prompt.ts` | Replace inline jargon glossary in `TEACHER_TONE_RULES` with import from `lib/coach/glossary.ts` |
| `lib/coach/weekly-review/narrative-prompt.ts` | Same — replace inline glossary with shared module import |
| `components/morning/BriefThisWeekPlan.tsx` | Wrap phase pill + RIR labels with `JargonPill` |
| `components/morning/BriefYesterdayVsPlan.tsx` | Wrap RIR / reps% labels with `JargonPill` |
| `components/morning/BriefSessionList.tsx` | Wrap RIR labels with `JargonPill` |
| `components/coach/WeeklyReviewHeader.tsx` | Wrap phase pills with `JargonPill` |
| `components/coach/WeeklyReviewPrescription.tsx` | Wrap rationale_tag labels with `JargonPill` |

## Data model

**No new tables. No migration.** One new TypeScript module (`lib/coach/glossary.ts`) exporting a const dictionary.

```ts
// lib/coach/glossary.ts
//
// Canonical glossary for coach surfaces. Single source of truth for the
// terms used by the AI prompts (advice-prompt.ts TEACHER_TONE_RULES,
// narrative-prompt.ts TEACHING block) and the UI tooltips (JargonPill
// → TermSheet, GlossarySheet).
//
// Two dictionaries:
//   - CORE_TERMS   — 7 athlete-facing concepts that also appear in the AI
//                    prompts' always-define-on-first-use rule.
//   - RATIONALE_LABELS — periodization rationale tags emitted by
//                    compose-prescription.ts. UI-tooltip-only; never
//                    referenced in AI prompts.
//
// JargonPill accepts a key from either dictionary via the union TermKey.

export type CoreTermKey =
  | "mev"
  | "mav"
  | "mrv"
  | "deload"
  | "rir"
  | "e1rm"
  | "sleep_efficiency";

export type RationaleTagKey =
  | "mev_to_mav_clearance"
  | "mav_to_mav_step"
  | "mav_to_mrv_advance"
  | "mrv_volume_drive"
  | "deload_load_volume_cut"
  | "plateau_rep_shift"
  | "plateau_deload_reset"
  | "rep_completion_miss"
  | "rir_missed_twice"
  | "rir_missed"
  | "form_hold"
  | "cutting_hold"
  | "recovery_hold"
  | "block_start_baseline";

export type TermKey = CoreTermKey | RationaleTagKey;

export type GlossaryEntry = {
  /** Display label as it appears on UI pills, e.g. "MAV", "RIR 2". */
  label: string;
  /** 5-10 word plain English. Used in AI prompts (CORE_TERMS only) + the TermSheet header. */
  short: string;
  /** 1-2 sentence longer explanation. Used in the TermSheet body + GlossarySheet. */
  plain: string;
};

export const CORE_TERMS: Record<CoreTermKey, GlossaryEntry> = {
  mev: {
    label: "MEV",
    short: "minimum weekly sets that drive growth",
    plain: "The smallest weekly set count that still produces muscle growth. Below this, you maintain but don't progress.",
  },
  mav: {
    label: "MAV",
    short: "the productive volume range",
    plain: "Maximum Adaptive Volume — the range of weekly sets that drives the most growth without overtraining. Most of your training time lives here.",
  },
  // ... etc — full 7-entry dictionary populated at implementation
};

export const RATIONALE_LABELS: Record<RationaleTagKey, GlossaryEntry> = {
  mev_to_mav_clearance: {
    label: "MEV → MAV",
    short: "cleared the introductory week",
    plain: "You hit your prescribed sets and reps in last week's MEV phase cleanly, so the program steps up to the more productive MAV range this week.",
  },
  plateau_rep_shift: {
    label: "Plateau · rep shift",
    short: "swap rep range to break a plateau",
    plain: "Three weeks of flat e1RM — before cutting weight, swap the rep range (5s↔8s) to give the lift a fresh stimulus.",
  },
  // ... etc — full ~14-entry dictionary populated at implementation
};

/** Combined lookup used by JargonPill to resolve either kind of key. */
export const GLOSSARY: Record<TermKey, GlossaryEntry> = {
  ...CORE_TERMS,
  ...RATIONALE_LABELS,
};

/** Helper for AI prompts — emits the always-define-jargon rule using CORE_TERMS only. */
export function jargonRuleForPrompt(): string {
  const lines = Object.values(CORE_TERMS).map(
    (entry) => `  - ${entry.label} → "${entry.short}"`,
  );
  return [
    "On first mention in this reply, define jargon in 5-10 words of plain English:",
    ...lines,
    "  If a term appears again later in the same reply, don't re-define.",
  ].join("\n");
}
```

The 7 `CORE_TERMS` appear in the AI prompts' always-define rule (matches the existing Sub-project #2 list verbatim). The ~14 `RATIONALE_LABELS` only appear in the UI via tooltips on the per-lift prescription rows — they're internal periodization decisions, not athlete-facing vocabulary, so they stay out of the AI prompt rule but resolve through the same JargonPill mechanism.

## Three deliverables in detail

### Deliverable 1 — Glossary module + jargon tooltips

**Goal:** Tap any glossary term on the coach surfaces → slide-up bottom sheet with definition.

**Components:**

- `lib/coach/glossary.ts` — the dictionary above.
- `components/coach/JargonPill.tsx` — `<JargonPill termKey="mav">MAV</JargonPill>` (children rendered as the visible label; tap opens TermSheet for the key). Renders the children as the pill content with styling identical to the existing inline label, but adds a subtle "tappable" affordance (slight underline or tiny info icon — design polish).
- `components/coach/TermSheet.tsx` — Uses existing `BottomSheet` primitive. Renders `entry.label` heading + `entry.plain` body + footer link "See all terms →" that opens GlossarySheet.
- `components/coach/GlossarySheet.tsx` — Uses existing `BottomSheet`. Scrollable list of all entries (label / plain). Categorized: "Periodization" (MEV/MAV/MRV/deload) / "Training" (RIR, e1RM) / "Recovery" (sleep efficiency) / "Coach decisions" (rationale tags).

**Retrofit usages** (the pill wraps existing labels — no shape change to the underlying components, just a wrapper):

| File | Label being wrapped |
|---|---|
| `components/morning/BriefThisWeekPlan.tsx` | Phase pill (line ~16: `plan.phase_now.toUpperCase()`) + RIR labels in per-lift table |
| `components/morning/BriefYesterdayVsPlan.tsx` | RIR target labels (if rendered) + reps% column header |
| `components/morning/BriefSessionList.tsx` | RIR labels for big-four lifts |
| `components/coach/WeeklyReviewHeader.tsx` | Phase pills (current + next) |
| `components/coach/WeeklyReviewPrescription.tsx` | `rationale_tag` labels per per-lift row |

**Sub-project #2 retrofit:**

- `lib/morning/brief/advice-prompt.ts` — replace the inline jargon list inside `TEACHER_TONE_RULES` with `${jargonRuleForPrompt()}` from `@/lib/coach/glossary`. Behavior identical (same definitions); module replaces the hardcoded string.
- `lib/coach/weekly-review/narrative-prompt.ts` — same retrofit.

### Deliverable 2 — Tools nav tab

**Goal:** Browsable library of all 8-10 user-facing actions, organized by scope.

**Components:**

- `components/coach/ToolsView.tsx` — main container. Renders four `Card` sections (TODAY / THIS WEEK / THIS BLOCK / REFERENCE).
- `components/coach/tools/ToolRow.tsx` — `<ToolRow title="Swap today's session" subtitle="Pick a different day" disabled={...} onClick={...} />`. Reused across sections.

**Nav integration:**

- `components/coach/CoachNav.tsx` — widens `VIEWS` from `[Today, Recent]` to `[Today, Recent, Tools]`. `CoachView` union: `'today' | 'recent' | 'tools'`.
- `components/coach/CoachClient.tsx` — renders `<ToolsView>` when `activeView === 'tools'`. Hides the chat panel + banners under the Tools view (the banner stack is irrelevant when browsing tools).

**Tool row content per section:**

| Section | Row | Action | Disabled when |
|---|---|---|---|
| **TODAY** | Swap today's session | Open `DaySwapSheet` with `sourceDay = today`, `weekStart = currentMonday` | No training_weeks row for current week |
| **TODAY** | Regenerate morning brief | POST to existing `regenerate_morning_brief` tool endpoint | No brief exists for today |
| **TODAY** | Mark mobility done | POST to existing `mark_mobility_done` tool endpoint | Mobility already marked OR no mobility planned for today |
| **THIS WEEK** | Adjust deficit (±kcal) | Open `AdjustDeficitSheet` for the latest draft weekly_review | No draft review exists |
| **THIS WEEK** | Regenerate weekly review | POST to existing `regenerate_weekly_review` endpoint | No review exists for this week |
| **THIS WEEK** | Plan upcoming week | Navigate to `/coach?mode=plan_week` | None |
| **THIS BLOCK** | Set up new block | Navigate to `/coach?mode=setup_block` | Active block exists (renders "Already active" subtitle) |
| **THIS BLOCK** | View block progress | Scroll to / highlight `BlockProgressCard` (already rendered on Today view); for Tools view, navigate to `/coach?view=today#block-progress` | No active block |
| **REFERENCE** | Glossary | Open `GlossarySheet` | None |

Each row uses existing endpoints / sheets — no new server work beyond plumbing the click handlers.

### Deliverable 3 — Composer suggestion chips

**Goal:** 4 static chips above the chat composer, visible when in default mode.

**Component:**

- `components/chat/ComposerSuggestionChips.tsx`:
  - 4 chip buttons in a horizontal row, ~28px tall, wraps on narrow screens.
  - Chips:
    - **"How am I tracking?"** — `onClick`: calls a new prop `onPrefillAndSubmit("How am I tracking this week?")` exposed by parent `ChatPanel`. The composer's existing submit path fires the message to the chat-stream.
    - **"What's today's plan?"** — `onClick`: same path with prefilled text "What does today look like?".
    - **"Swap today's session"** — `onClick`: opens `DaySwapSheet` directly (parent passes a callback or chip uses an internal state).
    - **"Adjust deficit"** — `onClick`: opens `AdjustDeficitSheet` directly for the latest draft weekly_review.
  - Disabled states identical to ToolsView's: gray-out + tap-to-explain TermSheet.

**Integration:**

- `components/chat/ChatPanel.tsx` — renders `<ComposerSuggestionChips />` above `<ChatComposer />` when `mode === 'default'`. Hidden when mode is `plan_week` / `setup_block` / `intake` / when the composer is focused or has text in it (so chips don't fight typing).

**Visibility rules:**

- Show: `mode === 'default'`, composer empty + unfocused.
- Hide: any other mode, composer focused, composer has text.

## Edge cases

- **Composer focused mid-typing.** Chips disappear (avoid layout shift on touch). Reappear when blur + empty.
- **Composer prefilled by chip then user wants to cancel.** The chip auto-submits, so there's no "cancel" — user gets the AI's response. If they want to back out, they can type something else (normal chat flow).
- **No draft weekly_review when tapping "Adjust deficit".** Chip and ToolRow both gray; tap opens a TermSheet (`AdjustDeficitDisabledExplainer`) explaining "Open a draft weekly review first" with link to the review page.
- **No training_weeks for current week when tapping "Swap today's session".** Same disabled pattern; explainer links to `/coach?mode=plan_week`.
- **Tools tab loaded with no active block.** THIS BLOCK section renders both rows disabled with subtitle "Set up a block to enable". REFERENCE always renders.
- **Glossary term with missing dictionary entry.** `JargonPill` falls back to rendering the children verbatim without tappable behavior; logs a `console.warn` so the gap is observable. No crash.
- **Tooltip BottomSheet opens then user immediately navigates away.** Existing BottomSheet primitive handles unmount cleanly (Sub-project #1 verified pattern).
- **Sub-project #2 retrofit breaks Haiku output.** The AI prompt's glossary content stays byte-identical (the module re-emits the same string). Validation: run a single brief generation after the retrofit and confirm the prose still defines MEV / MAV correctly on first use.
- **Mobile keyboard pushes chips off-screen.** Chips are above the composer; when keyboard opens, the entire composer-area scrolls up. Chips remain attached to the composer's top edge. Accepted UX.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Chip layout shift causes visual jank when keyboard opens | Chips already inside a flex column with the composer; entire column moves together. Verified at implementation time. |
| Tap-and-hold on a JargonPill triggers default browser long-press menu (text selection) | Set `user-select: none` on JargonPill content. Standard mobile pattern. |
| GlossarySheet's scroll competes with BottomSheet's drag-to-dismiss | Existing BottomSheet primitive (used by DaySwapSheet, AdjustDeficitSheet) already handles internal scrolling. Verify visually; if it conflicts, add `overscroll-behavior: contain` to GlossarySheet body. |
| Tools nav tab feels disconnected from the chat | This is the trade-off of the C-scope choice. Mitigation: chip strip above composer surfaces the same 2-3 most-used tools without leaving the chat. Tools tab is the deep library, not the primary path. |
| Retrofit to Sub-project #2's prompts produces marginally different jargon definitions in AI output | The retrofit re-emits the same string the prompts already use. Verified by string-equality test at implementation: take the existing inline glossary, the new `jargonRuleForPrompt()` output, and assert they produce identical multi-line strings. |
| ChatPanel's chip visibility logic interacts badly with existing morning-intake chips (`ChatChips.tsx`) | Different render slots — morning chips render inside the active brief message; suggestion chips render above the composer. No overlap. Visibility rule explicitly excludes intake mode. |
| Mark mobility done / regenerate brief endpoints don't exist as direct POST routes (they're chat-stream-only tools) | Verify at plan stage. If they're chat-tool-only, add thin REST endpoints or invoke via the chat-stream API path. Likely the latter — fire a one-shot user message that triggers the tool. |
| User adds new rationale_tag in a future spec; forgets to add glossary entry | JargonPill's missing-entry fallback (`console.warn`) makes it observable. Add a TypeScript exhaustiveness check at implementation: `TermKey` union mirrors `PrescriptionRationaleTag` for the rationale slice. |

## Verification

- **Typecheck:** `npm run typecheck` clean after each PR.
- **Manual exercise:**
  1. Open `/coach` on dev. Verify chip strip appears above the composer (4 chips, all enabled when fixture state is intact).
  2. Tap "How am I tracking?" → composer fills + auto-submits → AI responds.
  3. Tap "Swap today's session" → DaySwapSheet opens.
  4. Tap a phase pill on the weekly review page → TermSheet opens with the phase definition.
  5. Tap "See all terms" inside TermSheet → GlossarySheet opens.
  6. Switch to Tools nav tab → all four sections render; each row tap navigates / opens / invokes correctly.
- **AI prompt regression check:** generate a single brief after the Sub-project #2 retrofit; verify Haiku still defines MEV / MAV on first use (the prose check from Sub-project #2's spec).
- **Number formatting:** all numeric labels still use `fmtNum` (no regressions from JargonPill wrapping).
- **Disabled-state audit:** force the dev fixture into a state with no draft review; verify "Adjust deficit" chip + ToolRow both gray + tappable explainer fires.

## Open questions deferred to plan stage

1. **Mark mobility done / Regenerate brief invocation path.** Do these exist as direct REST endpoints, or only as chat-stream tools? If only chat-stream, the Tools tab fires a synthetic user message; if REST, direct POST. Verify file paths exist (`app/api/...`) before writing the ToolRow click handlers.
2. **JargonPill visual style.** Underline? Subtle dotted underline? Tiny info icon? Pick at implementation based on what matches the existing badge styling in BriefThisWeekPlan / WeeklyReviewHeader.
3. **GlossarySheet scroll behavior on iOS Safari.** Test at implementation; may need `overscroll-behavior: contain` polyfill.
4. **Should the Tools tab show a footer "Last updated" or "X tools available"?** Lean no — single-user app, no admin metadata needed. Plan stage confirms.
5. **Composer chip "Adjust deficit" wiring when multiple draft reviews exist** (regenerated twice within the same week). Pick latest by `version`. Confirm shape of the latest-review query path matches.
