# Coach Tab UX Shell + Tool Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #3 of the coach-as-real-coach arc — visible tool discovery on the coach surface. Three deliverables: (1) shared glossary module + tap-to-explain jargon tooltips on phase pills / RIR / e1RM / rationale labels; (2) a new Tools nav tab listing all 8-10 user-facing actions categorized by scope (TODAY / THIS WEEK / THIS BLOCK / REFERENCE); (3) 4 static suggestion chips above the chat composer in default mode.

**Architecture:** Pure UX wiring — no new tables, no migration, no Anthropic calls. New `lib/coach/glossary.ts` becomes the single source of truth for term definitions consumed by both UI tooltips and sub-project #2's AI prompts. Existing primitives (`BottomSheet`, `Card`, `SectionLabel`, existing sheets like `DaySwapSheet` and `AdjustDeficitSheet`) are reused. Three PRs stack on a single feature branch.

**Tech Stack:** Next.js 15 App Router, TanStack Query (existing hooks), Tailwind v4, light theme tokens from `lib/ui/theme.ts`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-15-coach-tab-ux-shell-design.md](../specs/2026-05-15-coach-tab-ux-shell-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create feature branch off main**

  ```bash
  cd "/Users/abdelouahedelbied/Health app"
  git checkout main
  git pull origin main
  git checkout -b feat/coach-tab-ux-shell
  ```

- [ ] **Pre-flight 2: Verify clean baseline**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0. If not, fix unrelated breakage before continuing.

- [ ] **Pre-flight 3: Verify endpoint paths for Tools tab actions**

  The Tools tab needs to invoke `mark_mobility_done` and `regenerate_morning_brief`. Confirm available paths:

  ```bash
  ls app/api/chat/morning/                    # retry-brief exists; can act as regenerate_morning_brief
  grep -rn "mark_mobility_done" app/api/ lib/coach/chat-stream.ts 2>/dev/null | head
  ```

  Decision: for `regenerate_morning_brief` use existing `POST /api/chat/morning/retry-brief` (exists for the failed-brief retry flow; semantically identical — regenerates the latest brief). For `mark_mobility_done` (no direct REST endpoint), the Tools tab row fires a synthetic user chat message that triggers the chat-stream tool routing. See Task 2.4 for exact implementation.

---

## File Structure

**New files (7):**

| Path | Purpose |
|---|---|
| `lib/coach/glossary.ts` | Term dictionary — `CORE_TERMS` + `RATIONALE_LABELS` + `jargonRuleForPrompt()` helper |
| `components/coach/JargonPill.tsx` | Tappable pill wrapping a glossary term, opens TermSheet |
| `components/coach/TermSheet.tsx` | BottomSheet rendering a single term's `label`/`plain` definition |
| `components/coach/GlossarySheet.tsx` | BottomSheet listing all terms, grouped by category |
| `components/coach/ToolsView.tsx` | Main Tools tab container — renders 4 sections of `ToolRow` |
| `components/coach/tools/ToolRow.tsx` | Reusable row component (title / subtitle / disabled / onClick) |
| `components/chat/ComposerSuggestionChips.tsx` | 4-chip strip above the chat composer in default mode |

**Modified files (10):**

| Path | Change |
|---|---|
| `lib/morning/brief/advice-prompt.ts` | Replace inline jargon list in `TEACHER_TONE_RULES` with `${jargonRuleForPrompt()}` import |
| `lib/coach/weekly-review/narrative-prompt.ts` | Same retrofit |
| `components/coach/CoachNav.tsx` | Widen `VIEWS` from `[Today, Recent]` to `[Today, Recent, Tools]`; `CoachView` union widens |
| `components/coach/CoachClient.tsx` | Render `<ToolsView>` when `activeView === 'tools'` |
| `components/chat/ChatPanel.tsx` | Render `<ComposerSuggestionChips>` above `<ChatComposer>` when `mode === 'default'` + composer empty/unfocused |
| `components/morning/BriefThisWeekPlan.tsx` | Wrap phase label + per-lift RIR with `JargonPill` |
| `components/morning/BriefYesterdayVsPlan.tsx` | Wrap RIR target + reps% header with `JargonPill` |
| `components/morning/BriefSessionList.tsx` | Wrap inline RIR labels with `JargonPill` (big-four lifts only) |
| `components/coach/WeeklyReviewHeader.tsx` | Wrap phase pills (current + next) with `JargonPill` |
| `components/coach/WeeklyReviewPrescription.tsx` | Wrap per-lift `rationale_tag` labels with `JargonPill` |

---

## Slice 1 — Glossary module + tooltips + AI prompt retrofit

Goal: Tapping any glossary term on the coach surfaces opens a bottom sheet with the definition. AI prompts (advice + narrative) read definitions from the same shared module.

### Task 1.1: Create the glossary module

**Files:**
- Create: `lib/coach/glossary.ts`

- [ ] **Step 1: Write the full module**

  Create `lib/coach/glossary.ts`:

  ```ts
  // lib/coach/glossary.ts
  //
  // Canonical glossary for coach surfaces. Single source of truth for the
  // terms used by the AI prompts (advice-prompt.ts TEACHER_TONE_RULES,
  // narrative-prompt.ts TEACHING block) and the UI tooltips (JargonPill
  // → TermSheet, GlossarySheet).
  //
  // Two dictionaries:
  //   - CORE_TERMS       7 athlete-facing concepts that also appear in
  //                      the AI prompts' always-define-on-first-use rule.
  //   - RATIONALE_LABELS Periodization rationale tags emitted by
  //                      compose-prescription.ts. UI-tooltip-only;
  //                      never referenced in AI prompts.

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
    label: string;
    short: string;
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
    mrv: {
      label: "MRV",
      short: "your weekly recovery ceiling",
      plain: "Maximum Recoverable Volume — the most weekly sets you can do and still recover. Pushing past this stalls progress.",
    },
    deload: {
      label: "Deload",
      short: "a lighter week to absorb training",
      plain: "A planned light week — loads drop 10-15% and sets drop ~half. Lets your body cement the adaptations from the prior weeks.",
    },
    rir: {
      label: "RIR",
      short: "reps you could still do at the same weight",
      plain: "Reps In Reserve — how far from failure a set is. RIR 2 means you stopped with two more reps available.",
    },
    e1rm: {
      label: "e1RM",
      short: "estimated one-rep max from your top set",
      plain: "Estimated 1-rep max calculated from a set you actually did. Tracks strength over time without testing a true 1RM.",
    },
    sleep_efficiency: {
      label: "Sleep efficiency",
      short: "time actually asleep ÷ time in bed",
      plain: "What fraction of your bed time you spent asleep. Below ~85% suggests interrupted sleep even when total hours look fine.",
    },
  };

  export const RATIONALE_LABELS: Record<RationaleTagKey, GlossaryEntry> = {
    mev_to_mav_clearance: {
      label: "MEV → MAV",
      short: "cleared the introductory week",
      plain: "You hit your prescribed sets and reps in last week's MEV phase cleanly, so the program steps up to the more productive MAV range this week.",
    },
    mav_to_mav_step: {
      label: "MAV step",
      short: "small load bump inside the MAV range",
      plain: "Mid-MAV progression — a smaller load bump (~1.5%) inside the same volume tier. Lets you push without leaving the productive range.",
    },
    mav_to_mrv_advance: {
      label: "MAV → MRV",
      short: "stepping into peak weekly volume",
      plain: "Moving into the highest volume tier — MRV. Sets stay high; load creeps up; recovery cost is at its weekly ceiling.",
    },
    mrv_volume_drive: {
      label: "MRV · volume drive",
      short: "hold load, add a set",
      plain: "At MRV the program holds load and adds a working set. Pushing both weight and sets risks overtraining; volume is the lever here.",
    },
    deload_load_volume_cut: {
      label: "Deload · load + volume cut",
      short: "lighter weights, fewer sets",
      plain: "Deload week prescription — loads drop 10-15% AND sets drop ~half. Both knobs ease the systemic fatigue.",
    },
    plateau_rep_shift: {
      label: "Plateau · rep shift",
      short: "swap rep range to break a plateau",
      plain: "Three weeks of flat e1RM — before cutting weight, swap the rep range (5s ↔ 8s) to give the lift a fresh stimulus.",
    },
    plateau_deload_reset: {
      label: "Plateau · deload reset",
      short: "pull back to deload weight, restart phase",
      plain: "Rep-shift didn't break the plateau — pull this lift back to deload weight (-5%) and restart its phase cycle from MEV.",
    },
    rep_completion_miss: {
      label: "Reps missed",
      short: "you hit < 90% of prescribed reps",
      plain: "Your working sets fell short of the prescribed reps last week. Coach drops the load 2.5% to give you a chance to complete cleanly.",
    },
    rir_missed_twice: {
      label: "RIR missed × 2",
      short: "two weeks of overshoot — hold",
      plain: "Two consecutive weeks where you missed the RIR target by ≥2. Coach holds load and surfaces a question — fatigue, form, or programming?",
    },
    rir_missed: {
      label: "RIR missed",
      short: "one bad week — small step back",
      plain: "Last week's RIR target was missed by ≥2 reps. Coach drops the load 2.5% this week and watches for a clean repeat.",
    },
    form_hold: {
      label: "Form hold",
      short: "form note last week — hold load",
      plain: "You logged a form note for this lift last week. Coach holds load until form is clean.",
    },
    cutting_hold: {
      label: "Cutting hold",
      short: "losing > 0.7% BW/wk — defend, don't grow",
      plain: "You're dropping weight aggressively. In a deficit this size, the program holds strength rather than pushing — you defend gains, not grow them.",
    },
    recovery_hold: {
      label: "Recovery hold",
      short: "sleep or HRV flag — hold this week",
      plain: "Sleep < 6h or HRV is below baseline. Coach holds load until recovery normalizes.",
    },
    block_start_baseline: {
      label: "Block start",
      short: "first week of a new block",
      plain: "First week of this block — load comes from the block-setup baseline, not from last week's lift.",
    },
  };

  export const GLOSSARY: Record<TermKey, GlossaryEntry> = {
    ...CORE_TERMS,
    ...RATIONALE_LABELS,
  };

  /** Emit the always-define-jargon rule using CORE_TERMS only. Used by both
   *  advice-prompt.ts (TEACHER_TONE_RULES) and narrative-prompt.ts (TEACHING). */
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

  /** Looks up a term entry; returns null if the key isn't in the dictionary.
   *  Used by JargonPill for the missing-entry fallback. */
  export function getGlossaryEntry(key: string): GlossaryEntry | null {
    return (GLOSSARY as Record<string, GlossaryEntry>)[key] ?? null;
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/glossary.ts
  git commit -m "feat(coach): glossary module — CORE_TERMS + RATIONALE_LABELS + jargonRuleForPrompt"
  ```

### Task 1.2: Create TermSheet component

**Files:**
- Create: `components/coach/TermSheet.tsx`

- [ ] **Step 1: Verify BottomSheet primitive shape**

  ```bash
  grep -n "^export\|interface BottomSheet\|onClose\|title" components/ui/BottomSheet.tsx | head -10
  ```

  Confirm prop shape (likely `{ onClose, title?, children, open? }`). Adapt the snippet below if names differ.

- [ ] **Step 2: Write the component**

  Create `components/coach/TermSheet.tsx`:

  ```tsx
  "use client";

  import { BottomSheet } from "@/components/ui/BottomSheet";
  import { COLOR } from "@/lib/ui/theme";
  import { getGlossaryEntry, type TermKey } from "@/lib/coach/glossary";

  export function TermSheet({
    termKey,
    onClose,
    onOpenGlossary,
  }: {
    termKey: TermKey | string;
    onClose: () => void;
    /** Optional — when provided, footer renders a "See all terms" link. */
    onOpenGlossary?: () => void;
  }) {
    const entry = getGlossaryEntry(termKey);
    return (
      <BottomSheet onClose={onClose} title={entry?.label ?? termKey}>
        <div style={{ padding: 16 }}>
          {entry ? (
            <>
              <div style={{ fontSize: 13, color: COLOR.textStrong, fontWeight: 600 }}>
                {entry.short}
              </div>
              <p style={{ fontSize: 13, color: COLOR.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                {entry.plain}
              </p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: COLOR.textMuted }}>
              No definition available for &ldquo;{termKey}&rdquo;.
            </p>
          )}
          {onOpenGlossary && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenGlossary();
              }}
              style={{
                marginTop: 16,
                background: "transparent",
                border: "none",
                color: COLOR.accent,
                fontSize: 12,
                cursor: "pointer",
                padding: 0,
              }}
            >
              See all terms →
            </button>
          )}
        </div>
      </BottomSheet>
    );
  }
  ```

- [ ] **Step 3: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/TermSheet.tsx
  git commit -m "feat(coach): TermSheet — bottom sheet for a single glossary term"
  ```

### Task 1.3: Create GlossarySheet component

**Files:**
- Create: `components/coach/GlossarySheet.tsx`

- [ ] **Step 1: Write the component**

  Create `components/coach/GlossarySheet.tsx`:

  ```tsx
  "use client";

  import { BottomSheet } from "@/components/ui/BottomSheet";
  import { COLOR } from "@/lib/ui/theme";
  import { CORE_TERMS, RATIONALE_LABELS, type GlossaryEntry } from "@/lib/coach/glossary";

  type Section = { heading: string; entries: GlossaryEntry[] };

  function buildSections(): Section[] {
    return [
      { heading: "Periodization", entries: [CORE_TERMS.mev, CORE_TERMS.mav, CORE_TERMS.mrv, CORE_TERMS.deload] },
      { heading: "Training", entries: [CORE_TERMS.rir, CORE_TERMS.e1rm] },
      { heading: "Recovery", entries: [CORE_TERMS.sleep_efficiency] },
      { heading: "Coach decisions", entries: Object.values(RATIONALE_LABELS) },
    ];
  }

  export function GlossarySheet({ onClose }: { onClose: () => void }) {
    const sections = buildSections();
    return (
      <BottomSheet onClose={onClose} title="Glossary">
        <div style={{ padding: 16, maxHeight: "70vh", overflowY: "auto", overscrollBehavior: "contain" }}>
          {sections.map((section) => (
            <div key={section.heading} style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 10,
                  color: COLOR.textFaint,
                  fontWeight: 700,
                  letterSpacing: "0.5px",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                {section.heading}
              </div>
              {section.entries.map((entry) => (
                <div
                  key={entry.label}
                  style={{
                    paddingTop: 8,
                    paddingBottom: 8,
                    borderTop: `1px solid ${COLOR.divider}`,
                  }}
                >
                  <div style={{ fontSize: 13, color: COLOR.textStrong, fontWeight: 600 }}>{entry.label}</div>
                  <div style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 2 }}>{entry.short}</div>
                  <div style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                    {entry.plain}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </BottomSheet>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/GlossarySheet.tsx
  git commit -m "feat(coach): GlossarySheet — full term dictionary in a scrollable bottom sheet"
  ```

### Task 1.4: Create JargonPill component

**Files:**
- Create: `components/coach/JargonPill.tsx`

- [ ] **Step 1: Write the component**

  Create `components/coach/JargonPill.tsx`:

  ```tsx
  "use client";

  import { useState, type CSSProperties, type ReactNode } from "react";
  import { TermSheet } from "@/components/coach/TermSheet";
  import { GlossarySheet } from "@/components/coach/GlossarySheet";
  import { getGlossaryEntry, type TermKey } from "@/lib/coach/glossary";

  /**
   * Wraps an existing label (e.g. "MAV", "RIR 2", "MEV → MAV") and makes it
   * tappable. On tap, opens a BottomSheet with the plain-English definition
   * for the supplied termKey. If termKey isn't in the glossary, the pill
   * renders the children verbatim with no tappable behavior + a console.warn
   * (no crash).
   */
  export function JargonPill({
    termKey,
    children,
    style,
  }: {
    termKey: TermKey | string;
    children: ReactNode;
    style?: CSSProperties;
  }) {
    const [openTerm, setOpenTerm] = useState(false);
    const [openGlossary, setOpenGlossary] = useState(false);

    const entry = getGlossaryEntry(termKey);
    if (!entry) {
      if (typeof window !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn(`[JargonPill] missing glossary entry for "${termKey}"`);
      }
      return <span style={style}>{children}</span>;
    }

    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpenTerm(true);
          }}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            font: "inherit",
            color: "inherit",
            textDecoration: "underline dotted",
            textUnderlineOffset: 2,
            textDecorationColor: "currentColor",
            cursor: "pointer",
            userSelect: "none",
            ...style,
          }}
        >
          {children}
        </button>
        {openTerm && (
          <TermSheet
            termKey={termKey}
            onClose={() => setOpenTerm(false)}
            onOpenGlossary={() => setOpenGlossary(true)}
          />
        )}
        {openGlossary && <GlossarySheet onClose={() => setOpenGlossary(false)} />}
      </>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/JargonPill.tsx
  git commit -m "feat(coach): JargonPill — tappable term wrapper that opens TermSheet"
  ```

### Task 1.5: Retrofit advice-prompt.ts

**Files:**
- Modify: `lib/morning/brief/advice-prompt.ts`

- [ ] **Step 1: Replace the inline jargon list with the shared module**

  Open `lib/morning/brief/advice-prompt.ts`. Find the `TEACHER_TONE_RULES` constant (near the top of the file after the imports). The current value embeds a 7-line glossary directly in the string. Replace that whole jargon-list section with the import:

  Add to imports at the top:

  ```ts
  import { jargonRuleForPrompt } from "@/lib/coach/glossary";
  ```

  Then change the `TEACHER_TONE_RULES` constant. The exact replacement depends on the existing structure — find the block starting "On first mention in this reply, define jargon..." and ending "...don't re-define." (the 7 hard-coded jargon lines plus the closing instruction) and replace it with `${jargonRuleForPrompt()}` interpolation:

  ```ts
  const TEACHER_TONE_RULES = `
  TONE & TEACHING RULES (apply to every reply):
  1. Second person, conversational. "You" not "the athlete".
  2. ${jargonRuleForPrompt().split("\n").join("\n  ")}
  3. Prefer everyday language. Don't write "myofibrillar hypertrophy" when "muscle growth" works.
  4. Explain why a concept matters when it drives a decision today. Skip the textbook tone.
  `.trim();
  ```

  Verify the output string is byte-identical to the existing inline version: same indentation (2-space sub-rule lines), same wording, same closing "don't re-define" line. Use string-equality during testing if uncertain.

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add lib/morning/brief/advice-prompt.ts
  git commit -m "refactor(brief): advice-prompt reads glossary from shared module"
  ```

### Task 1.6: Retrofit narrative-prompt.ts

**Files:**
- Modify: `lib/coach/weekly-review/narrative-prompt.ts`

- [ ] **Step 1: Replace the TEACHING block's hard-coded list**

  Open `lib/coach/weekly-review/narrative-prompt.ts`. Find the `TEACHING:` block in the system prompt (added during sub-project #2's retrofit). The block currently lists the 7 terms inline. Replace with the helper:

  Add to imports:

  ```ts
  import { jargonRuleForPrompt } from "@/lib/coach/glossary";
  ```

  Then in the system prompt construction, replace the multi-line TEACHING block with:

  ```ts
  // Inside the system prompt template literal, wherever the TEACHING:
  // block is built, swap the hard-coded list with the helper output:
  `TEACHING:\n${jargonRuleForPrompt()}\n- Prefer everyday language. Avoid textbook tone.`
  ```

  Match the existing formatting exactly — the leading bullet style, line breaks, and trailing line. The intent: the AI sees the same string as before, but the source is now the shared module.

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/weekly-review/narrative-prompt.ts
  git commit -m "refactor(coach): narrative-prompt reads glossary from shared module"
  ```

### Task 1.7: Retrofit BriefThisWeekPlan with JargonPill

**Files:**
- Modify: `components/morning/BriefThisWeekPlan.tsx`

- [ ] **Step 1: Wrap phase label + RIR labels**

  Open `components/morning/BriefThisWeekPlan.tsx`. Find:
  - The phase label in the SectionLabel (uppercase `plan.phase_now.toUpperCase()` around line 15-18). Wrap with `JargonPill` keyed on `plan.phase_now`.
  - The `RIR` column in the per-lift table — currently renders `{p.rir_target}` or `"—"`. Wrap the entire `RIR {value}` cell content with `JargonPill termKey="rir"`.

  Add to imports:

  ```tsx
  import { JargonPill } from "@/components/coach/JargonPill";
  ```

  Phase label change — the existing SectionLabel renders inline text. The pill needs to wrap just the term, not the entire label. Approach:

  ```tsx
  <SectionLabel>
    THIS WEEK · WK {plan.week_n}/{plan.total_weeks} ·{" "}
    <JargonPill termKey={plan.phase_now}>{plan.phase_now.toUpperCase()}</JargonPill>
    {plan.phase_changed_this_week ? " · NEW PHASE" : ""}
  </SectionLabel>
  ```

  RIR cell change — find the existing `<td>{p.rir_target ?? "—"}</td>` (around line 60). Wrap when `rir_target != null`:

  ```tsx
  <td style={{ textAlign: "right", color: COLOR.textMuted }}>
    {p.rir_target != null ? (
      <JargonPill termKey="rir">RIR {p.rir_target}</JargonPill>
    ) : (
      "—"
    )}
  </td>
  ```

  Note: the current code may show just the bare number `{p.rir_target}` instead of `RIR {value}`. Inspect the current cell and either keep the bare number (still tappable, still uses `termKey="rir"`) or upgrade to `RIR N`. Plan stage: lean toward keeping bare number to minimize visual diff.

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/morning/BriefThisWeekPlan.tsx
  git commit -m "feat(brief): JargonPill wraps phase + RIR labels in BriefThisWeekPlan"
  ```

### Task 1.8: Retrofit BriefYesterdayVsPlan with JargonPill

**Files:**
- Modify: `components/morning/BriefYesterdayVsPlan.tsx`

- [ ] **Step 1: Wrap RIR target + reps% header**

  Open `components/morning/BriefYesterdayVsPlan.tsx`. Identify:
  - The "REPS %" table header (around line 43). Wrap with `JargonPill termKey="rir"` if it represents RIR concept, or `termKey="e1rm"` if it represents top-set e1RM, depending on which column it labels. Inspect to confirm — if it's literally "REPS %" representing rep completion, leave unwrapped (not a glossary term). Skip this header.
  - Any inline RIR badge inside per-lift rows — if the planned cell renders `${p.planned.rir_target}` somewhere, wrap with `JargonPill termKey="rir"`.

  Skim the current component; if there are no glossary terms rendered, this retrofit is a no-op. Document the no-op in the commit message.

  If there's nothing to wrap, skip to Step 2 with no changes:

  ```bash
  echo "BriefYesterdayVsPlan has no glossary-term labels in current shape — no JargonPill retrofit needed."
  ```

- [ ] **Step 2: Verify typecheck + commit**

  If changes were made:

  ```bash
  npm run typecheck
  git add components/morning/BriefYesterdayVsPlan.tsx
  git commit -m "feat(brief): JargonPill wraps RIR badge in BriefYesterdayVsPlan"
  ```

  If no changes: skip the commit.

### Task 1.9: Retrofit BriefSessionList with JargonPill

**Files:**
- Modify: `components/morning/BriefSessionList.tsx`

- [ ] **Step 1: Wrap RIR labels for big-four**

  Open `components/morning/BriefSessionList.tsx`. Find the inline RIR rendering (added in sub-project #2 Slice 3) — a line that renders `RIR {planEntry.rir_target}` for big-four exercises. Wrap with `JargonPill`:

  ```tsx
  // existing code around line 100-112:
  {showPrescription && planEntry && planEntry.rir_target != null && (
    <div style={{ ... }}>
      <JargonPill termKey="rir">RIR {planEntry.rir_target}</JargonPill>
    </div>
  )}
  ```

  Add the import at the top:

  ```tsx
  import { JargonPill } from "@/components/coach/JargonPill";
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/morning/BriefSessionList.tsx
  git commit -m "feat(brief): JargonPill wraps inline RIR labels in BriefSessionList"
  ```

### Task 1.10: Retrofit WeeklyReviewHeader with JargonPill

**Files:**
- Modify: `components/coach/WeeklyReviewHeader.tsx`

- [ ] **Step 1: Wrap phase pills (current + next)**

  Open `components/coach/WeeklyReviewHeader.tsx`. Find where the phase is rendered (likely `header.block_phase_now.toUpperCase()` and `header.block_phase_next.toUpperCase()`). Wrap each with `JargonPill` keyed on the phase value:

  ```tsx
  <JargonPill termKey={header.block_phase_now}>
    {header.block_phase_now.toUpperCase()}
  </JargonPill>
  {" → "}
  <JargonPill termKey={header.block_phase_next}>
    {header.block_phase_next.toUpperCase()}
  </JargonPill>
  ```

  Add the import.

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/WeeklyReviewHeader.tsx
  git commit -m "feat(review): JargonPill wraps phase pills in WeeklyReviewHeader"
  ```

### Task 1.11: Retrofit WeeklyReviewPrescription with JargonPill

**Files:**
- Modify: `components/coach/WeeklyReviewPrescription.tsx`

- [ ] **Step 1: Wrap rationale_tag labels**

  Open `components/coach/WeeklyReviewPrescription.tsx`. Find the per-lift table's "WHY" cell rendering `p.rationale_tag.replaceAll("_", " ")` (around line 50-60). Wrap with `JargonPill` keyed on the raw tag:

  ```tsx
  <td style={{ textAlign: "right", color: COLOR.textFaint }}>
    <JargonPill termKey={p.rationale_tag}>
      {p.rationale_tag.replaceAll("_", " ")}
    </JargonPill>
  </td>
  ```

  Note: rationale tags can have `_increment_floor` / `_increment_capped` suffixes (from sub-project #1). Those suffixed forms aren't in the glossary directly. JargonPill's fallback (`console.warn` + render unwrapped) handles this gracefully. For a cleaner UX, strip the suffix before passing the key:

  ```tsx
  const stripIncrementSuffix = (tag: string): string => {
    return tag.replace(/_increment_(floor|capped)$/, "");
  };

  // ... in JSX:
  <JargonPill termKey={stripIncrementSuffix(p.rationale_tag)}>
    {p.rationale_tag.replaceAll("_", " ")}
  </JargonPill>
  ```

  Add the import + the helper at top of the file.

- [ ] **Step 2: Verify typecheck + commit + close Slice 1**

  ```bash
  npm run typecheck
  git add components/coach/WeeklyReviewPrescription.tsx
  git commit -m "feat(review): JargonPill wraps rationale_tag labels in WeeklyReviewPrescription"
  git push -u origin feat/coach-tab-ux-shell
  gh pr create --title "feat(coach): glossary module + jargon tooltips (Slice 1/3)" \
    --body "Shared lib/coach/glossary.ts (CORE_TERMS + RATIONALE_LABELS + jargonRuleForPrompt helper). New JargonPill/TermSheet/GlossarySheet components. Retrofit advice-prompt + narrative-prompt to read from the shared module. Retrofit 5 UI surfaces to wrap glossary terms with JargonPill."
  ```

---

## Slice 2 — Tools nav tab

Goal: Add a Tools pill to CoachNav. Tapping it renders a categorized list (TODAY / THIS WEEK / THIS BLOCK / REFERENCE) of all 8-10 user-facing actions, each tappable.

### Task 2.1: Create ToolRow component

**Files:**
- Create: `components/coach/tools/ToolRow.tsx`

- [ ] **Step 1: Write the component**

  Create directory + file:

  ```bash
  mkdir -p components/coach/tools
  ```

  Then `components/coach/tools/ToolRow.tsx`:

  ```tsx
  "use client";

  import type { CSSProperties } from "react";
  import { COLOR } from "@/lib/ui/theme";

  export function ToolRow({
    title,
    subtitle,
    disabled,
    onClick,
  }: {
    title: string;
    subtitle?: string;
    disabled?: boolean;
    onClick: () => void;
  }) {
    const rowStyle: CSSProperties = {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      width: "100%",
      padding: "10px 0",
      borderBottom: `1px solid ${COLOR.divider}`,
      background: "transparent",
      border: "none",
      borderTop: "none",
      borderLeft: "none",
      borderRight: "none",
      textAlign: "left",
      fontFamily: "inherit",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
    };
    return (
      <button type="button" style={rowStyle} disabled={disabled} onClick={onClick}>
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, color: COLOR.textStrong }}>{title}</span>
          {subtitle && (
            <span style={{ fontSize: 11, color: COLOR.textMuted }}>{subtitle}</span>
          )}
        </span>
        <span style={{ color: COLOR.textFaint, fontSize: 12 }}>→</span>
      </button>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/tools/ToolRow.tsx
  git commit -m "feat(coach): ToolRow — reusable row for Tools tab listings"
  ```

### Task 2.2: Widen CoachNav with Tools pill

**Files:**
- Modify: `components/coach/CoachNav.tsx`

- [ ] **Step 1: Add "Tools" to the VIEWS array**

  Open `components/coach/CoachNav.tsx`. The current `VIEWS` is `[Today, Recent]`. Add `Tools`:

  ```tsx
  const VIEWS = [
    { id: "today",  label: "Today",  href: "/coach?view=today"  },
    { id: "recent", label: "Recent", href: "/coach?view=recent" },
    { id: "tools",  label: "Tools",  href: "/coach?view=tools"  },
  ] as const;
  ```

  The `CoachView` type derived from `(typeof VIEWS)[number]["id"]` automatically widens to `"today" | "recent" | "tools"` — no other changes needed in this file.

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/CoachNav.tsx
  git commit -m "feat(coach): CoachNav adds Tools pill"
  ```

### Task 2.3: Create ToolsView component

**Files:**
- Create: `components/coach/ToolsView.tsx`

- [ ] **Step 1: Write the container**

  Create `components/coach/ToolsView.tsx`:

  ```tsx
  "use client";

  import { useState } from "react";
  import { useRouter } from "next/navigation";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { ToolRow } from "@/components/coach/tools/ToolRow";
  import { GlossarySheet } from "@/components/coach/GlossarySheet";
  import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
  import { AdjustDeficitSheet } from "@/components/coach/AdjustDeficitSheet";
  import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
  import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
  import { useBlockProgress } from "@/lib/query/hooks/useBlockProgress";
  import { weekdayInUserTz } from "@/lib/time";
  import { currentWeekMonday } from "@/lib/coach/week";

  export function ToolsView({
    userId,
    todayDate,
  }: {
    userId: string;
    todayDate: string;
  }) {
    const router = useRouter();
    const currentMonday = currentWeekMonday(new Date(`${todayDate}T12:00:00Z`));
    const { data: trainingWeek } = useTrainingWeek(userId, currentMonday);
    const { data: weeklyReview } = useWeeklyReview(userId, currentMonday);
    const { data: blockProgress } = useBlockProgress(userId);

    const hasTrainingWeek = trainingWeek != null;
    const hasDraftReview = weeklyReview != null && weeklyReview.status === "draft";
    const hasActiveBlock = blockProgress != null && "block" in blockProgress;

    const today = weekdayInUserTz();
    const todayShort = (
      { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
        Friday: "Fri", Saturday: "Sat", Sunday: "Sun" } as const
    )[today as "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday"];

    const [swapOpen, setSwapOpen] = useState(false);
    const [adjustOpen, setAdjustOpen] = useState(false);
    const [glossaryOpen, setGlossaryOpen] = useState(false);
    const [disabledReason, setDisabledReason] = useState<string | null>(null);

    function explainDisabled(reason: string) {
      setDisabledReason(reason);
    }

    async function regenerateMorningBrief() {
      try {
        const res = await fetch("/api/chat/morning/retry-brief", { method: "POST" });
        if (!res.ok) throw new Error(await res.text());
        router.push("/coach");
      } catch (e) {
        explainDisabled(e instanceof Error ? e.message : "Failed to regenerate brief.");
      }
    }

    async function markMobilityDone() {
      // No direct REST endpoint — fire a synthetic chat message that the
      // chat-stream tool routing handles as mark_mobility_done.
      try {
        const res = await fetch("/api/chat/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "coach",
            mode: "default",
            role: "user",
            content: "Mark mobility done for today.",
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        router.push("/coach");
      } catch (e) {
        explainDisabled(e instanceof Error ? e.message : "Failed to mark mobility done.");
      }
    }

    async function regenerateWeeklyReview() {
      if (!weeklyReview) return;
      try {
        const res = await fetch(`/api/coach/weekly-review/${weeklyReview.id}/regenerate`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(await res.text());
        router.push(`/coach/weeks/${currentMonday}`);
      } catch (e) {
        explainDisabled(e instanceof Error ? e.message : "Failed to regenerate review.");
      }
    }

    return (
      <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        <Card>
          <SectionLabel>TODAY</SectionLabel>
          <ToolRow
            title="Swap today's session"
            subtitle="Pick a different day"
            disabled={!hasTrainingWeek}
            onClick={() => hasTrainingWeek
              ? setSwapOpen(true)
              : explainDisabled("No training plan committed for this week.")}
          />
          <ToolRow
            title="Regenerate morning brief"
            subtitle="Re-run today's brief"
            onClick={regenerateMorningBrief}
          />
          <ToolRow
            title="Mark mobility done"
            subtitle="Log mobility for today"
            onClick={markMobilityDone}
          />
        </Card>

        <Card>
          <SectionLabel>THIS WEEK</SectionLabel>
          <ToolRow
            title="Adjust deficit"
            subtitle="±100 / ±200 kcal"
            disabled={!hasDraftReview}
            onClick={() => hasDraftReview
              ? setAdjustOpen(true)
              : explainDisabled("Open a draft weekly review first.")}
          />
          <ToolRow
            title="Regenerate weekly review"
            subtitle="Create a new version"
            disabled={!weeklyReview}
            onClick={() => weeklyReview
              ? regenerateWeeklyReview()
              : explainDisabled("No weekly review for this week.")}
          />
          <ToolRow
            title="Plan upcoming week"
            subtitle="Open planning chat"
            onClick={() => router.push("/coach?mode=plan_week")}
          />
        </Card>

        <Card>
          <SectionLabel>THIS BLOCK</SectionLabel>
          <ToolRow
            title="Set up new block"
            subtitle={hasActiveBlock ? "Block already active" : "Start a new 5-week meso"}
            disabled={hasActiveBlock}
            onClick={() => hasActiveBlock
              ? explainDisabled("A block is already active.")
              : router.push("/coach?mode=setup_block")}
          />
          <ToolRow
            title="View block progress"
            subtitle="See e1RM trends + adherence"
            disabled={!hasActiveBlock}
            onClick={() => hasActiveBlock
              ? router.push("/coach?view=today")
              : explainDisabled("Set up a block to enable this view.")}
          />
        </Card>

        <Card>
          <SectionLabel>REFERENCE</SectionLabel>
          <ToolRow
            title="Glossary"
            subtitle="MEV / MAV / RIR / and more"
            onClick={() => setGlossaryOpen(true)}
          />
        </Card>

        {swapOpen && hasTrainingWeek && (
          <DaySwapSheet
            userId={userId}
            weekStart={currentMonday}
            sourceDay={todayShort}
            plan={trainingWeek!.session_plan as Record<string, string>}
            onClose={() => setSwapOpen(false)}
          />
        )}
        {adjustOpen && hasDraftReview && weeklyReview && (
          <AdjustDeficitSheet
            reviewId={weeklyReview.id}
            userId={userId}
            weekStart={currentMonday}
            onClose={() => setAdjustOpen(false)}
          />
        )}
        {glossaryOpen && <GlossarySheet onClose={() => setGlossaryOpen(false)} />}
        {/* Inline toast for disabled-row tap explanations. TermSheet is not
            reused here because "_disabled" isn't a glossary term — this is
            a transient one-liner that auto-dismisses (see useEffect below). */}
        {disabledReason && (
          <div
            style={{
              position: "fixed", bottom: 80, left: 12, right: 12,
              padding: 12, background: COLOR.surface, border: `1px solid ${COLOR.divider}`,
              borderRadius: 8, fontSize: 12, color: COLOR.textMuted, zIndex: 50,
            }}
            onClick={() => setDisabledReason(null)}
          >
            {disabledReason}
          </div>
        )}
      </div>
    );
  }
  ```

  **Note on disabled-reason UX:** the snippet above renders a small toast-style notice when a disabled row is tapped (per the spec's "tap-to-explain why"). The earlier TermSheet path doesn't apply here since `_disabled` isn't a real glossary term — switched to an inline toast. Adapt to a `Toast` component if one already exists; otherwise the inline notice is fine for v1.

  Auto-dismiss the toast after 3s — add a `useEffect`:

  ```ts
  useEffect(() => {
    if (!disabledReason) return;
    const t = setTimeout(() => setDisabledReason(null), 3000);
    return () => clearTimeout(t);
  }, [disabledReason]);
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/ToolsView.tsx
  git commit -m "feat(coach): ToolsView — categorized list of all 8-10 user-facing actions"
  ```

### Task 2.4: Wire ToolsView into CoachClient

**Files:**
- Modify: `components/coach/CoachClient.tsx`

- [ ] **Step 1: Render ToolsView when activeView is 'tools'**

  Open `components/coach/CoachClient.tsx`. Find the existing branching on `activeView` (likely a ternary or if/else rendering the Today and Recent views). Add a third branch for Tools.

  Add import:

  ```tsx
  import { ToolsView } from "@/components/coach/ToolsView";
  ```

  Inside the existing JSX, find the structure that switches between Today and Recent. Add the Tools branch:

  ```tsx
  {activeView === "tools" ? (
    <ToolsView userId={userId} todayDate={todayDate} />
  ) : activeView === "recent" ? (
    /* existing recent view */
  ) : (
    /* existing today view */
  )}
  ```

  Adapt to the actual current JSX structure — the goal is: when Tools is active, render `<ToolsView>` and hide the chat panel + contextual banners (Tools is its own focused surface).

- [ ] **Step 2: Verify typecheck + commit + close Slice 2**

  ```bash
  npm run typecheck
  git add components/coach/CoachClient.tsx
  git commit -m "feat(coach): CoachClient renders ToolsView when view=tools"
  git push
  gh pr edit <PR-number-from-Slice-1> --add-commit
  ```

  If stacking on the existing PR from Slice 1, the commits land on the same branch and the PR diff grows. Alternatively, retitle the PR to cover Slices 1+2:

  ```bash
  gh pr edit <PR-number> --title "feat(coach): glossary + tooltips + Tools tab (Slices 1-2/3)"
  ```

---

## Slice 3 — Composer suggestion chips

Goal: 4 static chips above the chat composer in default mode. Two prefill+submit the composer ("How am I tracking?" / "What's today's plan?"); two open existing sheets directly ("Swap today's session" / "Adjust deficit").

### Task 3.1: Create ComposerSuggestionChips component

**Files:**
- Create: `components/chat/ComposerSuggestionChips.tsx`

- [ ] **Step 1: Write the component**

  Create `components/chat/ComposerSuggestionChips.tsx`:

  ```tsx
  "use client";

  import { useState, useEffect } from "react";
  import { useRouter } from "next/navigation";
  import { COLOR } from "@/lib/ui/theme";
  import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
  import { AdjustDeficitSheet } from "@/components/coach/AdjustDeficitSheet";
  import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
  import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
  import { weekdayInUserTz } from "@/lib/time";
  import { currentWeekMonday } from "@/lib/coach/week";

  export function ComposerSuggestionChips({
    userId,
    todayDate,
    onPrefillAndSubmit,
  }: {
    userId: string;
    todayDate: string;
    /** Called with text to prefill into the composer and immediately submit. */
    onPrefillAndSubmit: (text: string) => void;
  }) {
    const router = useRouter();
    const currentMonday = currentWeekMonday(new Date(`${todayDate}T12:00:00Z`));
    const { data: trainingWeek } = useTrainingWeek(userId, currentMonday);
    const { data: weeklyReview } = useWeeklyReview(userId, currentMonday);

    const hasTrainingWeek = trainingWeek != null;
    const hasDraftReview = weeklyReview != null && weeklyReview.status === "draft";

    const today = weekdayInUserTz();
    const todayShort = (
      { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu",
        Friday: "Fri", Saturday: "Sat", Sunday: "Sun" } as const
    )[today as "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday"];

    const [swapOpen, setSwapOpen] = useState(false);
    const [adjustOpen, setAdjustOpen] = useState(false);
    const [tooltip, setTooltip] = useState<string | null>(null);

    useEffect(() => {
      if (!tooltip) return;
      const t = setTimeout(() => setTooltip(null), 2500);
      return () => clearTimeout(t);
    }, [tooltip]);

    const chips: Array<{
      label: string;
      disabled?: boolean;
      onClick: () => void;
    }> = [
      {
        label: "How am I tracking?",
        onClick: () => onPrefillAndSubmit("How am I tracking this week?"),
      },
      {
        label: "What's today's plan?",
        onClick: () => onPrefillAndSubmit("What does today look like?"),
      },
      {
        label: "Swap today's session",
        disabled: !hasTrainingWeek,
        onClick: () => hasTrainingWeek
          ? setSwapOpen(true)
          : setTooltip("Commit a week first."),
      },
      {
        label: "Adjust deficit",
        disabled: !hasDraftReview,
        onClick: () => hasDraftReview
          ? setAdjustOpen(true)
          : setTooltip("Open a draft weekly review first."),
      },
    ];

    return (
      <div style={{
        position: "relative",
        padding: "6px 12px 4px",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        borderTop: `1px solid ${COLOR.divider}`,
      }}>
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            disabled={c.disabled}
            onClick={c.onClick}
            style={{
              background: COLOR.surfaceAlt,
              color: c.disabled ? COLOR.textFaint : COLOR.textStrong,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: 9999,
              padding: "4px 10px",
              fontSize: 12,
              cursor: c.disabled ? "not-allowed" : "pointer",
              opacity: c.disabled ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            {c.label}
          </button>
        ))}
        {tooltip && (
          <div style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 12,
            background: COLOR.surface,
            color: COLOR.textMuted,
            fontSize: 11,
            padding: "4px 8px",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 6,
            zIndex: 30,
          }}>
            {tooltip}
          </div>
        )}
        {swapOpen && hasTrainingWeek && trainingWeek && (
          <DaySwapSheet
            userId={userId}
            weekStart={currentMonday}
            sourceDay={todayShort}
            plan={trainingWeek.session_plan as Record<string, string>}
            onClose={() => setSwapOpen(false)}
          />
        )}
        {adjustOpen && hasDraftReview && weeklyReview && (
          <AdjustDeficitSheet
            reviewId={weeklyReview.id}
            userId={userId}
            weekStart={currentMonday}
            onClose={() => setAdjustOpen(false)}
          />
        )}
      </div>
    );
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/chat/ComposerSuggestionChips.tsx
  git commit -m "feat(chat): ComposerSuggestionChips — 4 static shortcuts above the composer"
  ```

### Task 3.2: Wire chips into ChatPanel

**Files:**
- Modify: `components/chat/ChatPanel.tsx`

- [ ] **Step 1: Inspect ChatPanel composer wiring**

  ```bash
  grep -n "ChatComposer\|onSend\|composerRef\|setComposerText" components/chat/ChatPanel.tsx | head -20
  ```

  Identify:
  - Where `ChatComposer` is rendered.
  - The current handler that submits a new message (likely `onSend(text)` or `handleSubmit(text)`).
  - The current mode state (likely `currentMode` or similar — passed in or derived from URL params).

- [ ] **Step 2: Add chip render above ChatComposer in default mode**

  At the top of ChatPanel.tsx, add the import:

  ```tsx
  import { ComposerSuggestionChips } from "@/components/chat/ComposerSuggestionChips";
  ```

  Find the JSX where `<ChatComposer ...>` is rendered. Just above it, add:

  ```tsx
  {currentMode === "default" && !composerText && !composerFocused && (
    <ComposerSuggestionChips
      userId={userId}
      todayDate={todayDate}
      onPrefillAndSubmit={(text) => {
        // Prefill + submit immediately. Uses the same submit path the
        // composer's send button uses.
        handleSubmit(text);
      }}
    />
  )}
  ```

  Adapt to the actual variable names — `currentMode`, `composerText`, `composerFocused`, `handleSubmit`, `userId`, `todayDate` may all be named differently. If `composerFocused` doesn't exist as state, add it:

  ```tsx
  const [composerFocused, setComposerFocused] = useState(false);

  // Pass to ChatComposer as new props:
  <ChatComposer
    {...existingProps}
    onFocus={() => setComposerFocused(true)}
    onBlur={() => setComposerFocused(false)}
  />
  ```

  And add `onFocus` / `onBlur` props to `ChatComposer.tsx` if they don't exist — pass them through to the underlying textarea.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  If `ChatComposer` doesn't expose `onFocus`/`onBlur`, you'll see type errors. Add the props to the component's signature.

- [ ] **Step 4: Manual exercise**

  ```bash
  npm run dev
  ```

  Visit `http://localhost:3000/coach`. Expected:
  - Chips appear above the composer.
  - Tapping a "?" chip prefills + submits the composer; AI responds.
  - Tapping "Swap today's session" opens DaySwapSheet.
  - Tapping "Adjust deficit" opens AdjustDeficitSheet (if a draft review exists; otherwise tooltip "Open a draft weekly review first").
  - Tapping the composer textarea hides the chip strip; blurring with empty text shows it again.

  Stop dev server.

- [ ] **Step 5: Commit + retitle PR**

  ```bash
  git add components/chat/ChatPanel.tsx components/chat/ChatComposer.tsx
  git commit -m "feat(chat): wire ComposerSuggestionChips above the composer in default mode"
  git push
  gh pr edit <PR-number> --title "feat(coach): coach tab UX shell + tool discovery (Slices 1-3/3)"
  ```

---

## Self-Review

After Slice 3 merges, walk the spec one more time:

- [ ] Re-read [docs/superpowers/specs/2026-05-15-coach-tab-ux-shell-design.md](../specs/2026-05-15-coach-tab-ux-shell-design.md) — every Goal (1-7) has a corresponding task. Verify:
  - Goal 1 (chips above composer) → Slice 3.
  - Goal 2 (Tools tab) → Slice 2.
  - Goal 3 (jargon tooltips) → Slice 1.
  - Goal 4 (single glossary source) → Slice 1 Tasks 1.1, 1.5, 1.6.
  - Goal 5 (no new tables / Anthropic calls) → trivially true.
  - Goal 6 (disabled-state visibility) → ToolsView + ComposerSuggestionChips both implement tap-to-explain.
  - Goal 7 (light footprint) → 7 new files + 10 modified, all under 200 lines each.
- [ ] Run final manual exercise: visit `/coach`, switch to Tools tab, tap each row, return to Today, tap a phase pill on the brief or review surface, verify GlossarySheet opens.
- [ ] Update [CLAUDE.md](../../../CLAUDE.md) with a one-line entry under "UI conventions" or wherever fits, noting the shared `lib/coach/glossary.ts` source-of-truth pattern for coach jargon.

When all three slices are merged and verified, sub-project #3 is done. Sub-projects #4 (Proactive reach-out) and #5 (Trend layer) remain — both deferred to future specs.
