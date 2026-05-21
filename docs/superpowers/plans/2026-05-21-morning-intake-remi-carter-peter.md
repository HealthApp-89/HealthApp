# Morning Intake Restructure — Remi → Carter → Peter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the morning-intake popup from Today to Health (Remi's page), reshape intake turns to read as Remi, add deterministic Carter rules that extend the brief's existing `coach_suggestion` chip with high_soreness and recovery_crash rationales, and surface a placeholder on Today when intake is pending.

**Architecture:** No new tables, migrations, state-machine values, or AI calls. Reuses the existing `MorningBriefCoachSuggestion` primitive on the brief card (already wired through assembler, flags, UI, and swap mutation). Extends three things: (1) the speaker/thread stamping on intake writes flips from default `peter` to explicit `remi`, (2) `pickCoachSuggestion` grows new inputs and rule branches, (3) `BriefCoachSuggestion` UI renders the new rationales/kinds.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Supabase service-role for writes, TanStack Query for cache invalidation on swap, no test framework — verification is `npm run typecheck` + manual exercise in `npm run dev`.

**Reference spec:** [docs/superpowers/specs/2026-05-21-morning-intake-remi-carter-peter-design.md](../specs/2026-05-21-morning-intake-remi-carter-peter-design.md)

---

## File map

**New:**
- `lib/morning/brief/session-muscles.ts` — `SESSION_MUSCLE_MAP` + overlap helper.

**Modified:**
- `lib/data/types.ts` — extend `MorningBriefCoachSuggestion` union + `AdviceFlags`.
- `lib/morning/brief/assembler.ts` — `pickCoachSuggestion` signature + rules; call site at line 117.
- `lib/morning/brief/flags.ts` — new `coach_reduce_intensity_suggested` flag.
- `components/morning/BriefCoachSuggestion.tsx` — render high_soreness + reduce_intensity branches; rationale-dependent header label.
- `app/api/chat/morning/intake/route.ts` — speaker/thread on `insertAssistantTurn` + `insertUserReply` + two direct inserts in `handleFeelTail`; rewritten system prompt in `handleFeelTail`.
- `app/api/chat/morning/recommendation/route.ts` — speaker/thread on the two retry-chip inserts (already correct on the brief row itself).
- `lib/morning/script.ts` — light voice pass on prompt strings.
- `app/page.tsx` — remove `<MorningIntakeHost>` mount.
- `components/health/HealthCoachClient.tsx` — add `<MorningIntakeHost>` mount.
- `components/dashboard/TodayMorningBriefSlot.tsx` — render placeholder when no brief + intake not delivered.

**Out of scope (deferred):**
- Persisted dismiss flag for chip recommendations (client-state only in v1).
- Carter chat turn in his own thread (spec defers this).
- New unread-dot logic for Health pill (already in place from earlier PR).

---

### Task 1: Add SESSION_MUSCLE_MAP

**Files:**
- Create: `lib/morning/brief/session-muscles.ts`

- [ ] **Step 1: Create the file**

```ts
// lib/morning/brief/session-muscles.ts
//
// Maps each SESSION_PLANS session type to the muscle-group keys it taxes,
// using the same vocabulary as SORENESS_AREAS in lib/morning/script.ts
// (chest, back, legs, shoulders, arms, core). Used by pickCoachSuggestion
// to detect when the user's reported soreness overlaps today's session.
//
// "Arms" is intentionally coarse (chest day for triceps via pushdowns,
// back day for biceps via pulldowns/rows). Mobility and REST have no
// targeted muscles — they're recovery sessions and never trigger a swap
// recommendation regardless of soreness.

export const SESSION_MUSCLE_MAP: Record<string, readonly string[]> = {
  Chest: ["chest", "shoulders", "arms"],
  Back: ["back", "arms"],
  Legs: ["legs"],
  Mobility: [],
  REST: [],
};

/** Case-insensitive overlap check. Returns the matching area names from
 *  `sorenessAreas` (preserving caller's casing) for use in the user-visible
 *  `detail` string. Empty array = no overlap. */
export function muscleOverlap(
  sorenessAreas: string[] | null,
  sessionType: string,
): string[] {
  if (!sorenessAreas || sorenessAreas.length === 0) return [];
  const targets = SESSION_MUSCLE_MAP[sessionType];
  if (!targets || targets.length === 0) return [];
  const targetSet = new Set(targets.map((t) => t.toLowerCase()));
  return sorenessAreas.filter((a) => targetSet.has(a.toLowerCase()));
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors related to the new file.

- [ ] **Step 3: Commit**

```bash
git add lib/morning/brief/session-muscles.ts
git commit -m "feat(brief): add SESSION_MUSCLE_MAP for Carter soreness overlap"
```

---

### Task 2: Extend MorningBriefCoachSuggestion type + pickCoachSuggestion logic

**Files:**
- Modify: `lib/data/types.ts:920-922`
- Modify: `lib/morning/brief/assembler.ts:169-186` (function body) + `lib/morning/brief/assembler.ts:117-121` (call site)

- [ ] **Step 1: Extend the type**

Replace the `MorningBriefCoachSuggestion` definition in `lib/data/types.ts` (currently lines 920-922):

```ts
export type MorningBriefCoachSuggestion =
  | { kind: "swap_to_mobility"; rationale: "low_readiness" | "high_soreness"; detail?: string }
  | { kind: "reduce_intensity"; rationale: "recovery_crash"; detail?: string }
  | null;
```

- [ ] **Step 2: Rewrite pickCoachSuggestion**

Replace the function in `lib/morning/brief/assembler.ts` (currently lines 169-186):

```ts
/** Deterministic chip for the brief's coach_suggestion. Carter rules
 *  (high_soreness, recovery_crash) layer on top of the existing
 *  low_readiness rule. First-match wins; ordering is intentional —
 *  the specific symptom-based signals beat the generic readiness band.
 *
 *  Returns null when:
 *  - No training_weeks row for today (the swap POST would 404).
 *  - Today's session is REST / Mobility / Sick (already a recovery day).
 *  - No rule fires.
 */
export function pickCoachSuggestion(args: {
  band: "low" | "moderate" | "high";
  sessionType: string;
  hasTrainingWeek: boolean;
  intake: {
    soreness_areas: string[] | null;
    soreness_severity: "mild" | "sharp" | null;
    fatigue: "none" | "some" | "heavy" | null;
  };
  recovery: number | null;
}): MorningBriefCoachSuggestion {
  if (!args.hasTrainingWeek) return null;
  const lower = args.sessionType.toLowerCase().trim();
  if (lower === "rest" || lower === "mobility" || lower === "sick") return null;

  // Rule 1: sharp soreness in a muscle today's session targets.
  if (args.intake.soreness_severity === "sharp") {
    const overlap = muscleOverlap(args.intake.soreness_areas, args.sessionType);
    if (overlap.length > 0) {
      return {
        kind: "swap_to_mobility",
        rationale: "high_soreness",
        detail: `sharp soreness in ${overlap.join(", ")}`,
      };
    }
  }

  // Rule 2 (existing): low readiness band.
  if (args.band === "low") {
    return { kind: "swap_to_mobility", rationale: "low_readiness" };
  }

  // Rule 3: WHOOP recovery crash combined with heavy fatigue.
  if (
    args.recovery !== null &&
    args.recovery < 40 &&
    args.intake.fatigue === "heavy"
  ) {
    return {
      kind: "reduce_intensity",
      rationale: "recovery_crash",
      detail: `recovery ${Math.round(args.recovery)} + heavy fatigue`,
    };
  }

  return null;
}
```

- [ ] **Step 3: Import the new helper**

Add the import near the top of `lib/morning/brief/assembler.ts` (next to the existing `SESSION_PLANS` import):

```ts
import { muscleOverlap } from "@/lib/morning/brief/session-muscles";
```

- [ ] **Step 4: Update the call site**

Replace the `pickCoachSuggestion` invocation in `assembleBriefExceptAdvice` (currently lines 117-121):

```ts
    coach_suggestion: pickCoachSuggestion({
      band: readiness.band,
      sessionType: inputs.sessionType,
      hasTrainingWeek: inputs.hasTrainingWeek,
      intake: {
        soreness_areas: inputs.todayCheckin?.soreness_areas ?? null,
        soreness_severity: inputs.todayCheckin?.soreness_severity ?? null,
        fatigue: inputs.todayCheckin?.fatigue ?? null,
      },
      recovery: inputs.todayLog?.recovery ?? null,
    }),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. The `MorningBriefCoachSuggestion` widening means callers that read `rationale` must now handle the new string-union; `flags.ts:108` checks `kind === "swap_to_mobility"` (unchanged) and the `BriefCoachSuggestion` component handles the union in Task 4/5. No other call sites read the type.

- [ ] **Step 6: Commit**

```bash
git add lib/data/types.ts lib/morning/brief/assembler.ts
git commit -m "feat(brief): Carter rules in pickCoachSuggestion (high_soreness, recovery_crash)"
```

---

### Task 3: Add reduce_intensity advice flag

**Files:**
- Modify: `lib/data/types.ts` (AdviceFlags type — find with grep first)
- Modify: `lib/morning/brief/flags.ts:102-115`

- [ ] **Step 1: Locate AdviceFlags type**

Run: `grep -n "coach_swap_suggested" lib/data/types.ts`
Expected: one match showing the `AdviceFlags` type definition near line 866 with `coach_swap_suggested: boolean;`.

- [ ] **Step 2: Add the new field to AdviceFlags**

In `lib/data/types.ts`, find the `coach_swap_suggested: boolean;` line in the `AdviceFlags` type and add a new field right after it:

```ts
  /** True when MorningBriefCard.coach_suggestion?.kind === 'reduce_intensity'.
   *  Lets Peter's prose acknowledge Carter's reduce-intensity recommendation
   *  the same way coach_swap_suggested gates the swap-mention path. */
  coach_reduce_intensity_suggested: boolean;
```

- [ ] **Step 3: Compute the flag in computeAdviceFlags**

In `lib/morning/brief/flags.ts`, the `computeAdviceFlags` return object currently ends with `coach_swap_suggested` + `phase_transition_this_week`. Add `coach_reduce_intensity_suggested` right after `coach_swap_suggested`:

```ts
    coach_swap_suggested: inputs.card.coach_suggestion?.kind === "swap_to_mobility",
    coach_reduce_intensity_suggested:
      inputs.card.coach_suggestion?.kind === "reduce_intensity",
    phase_transition_this_week:
```

(Leave the rest of the return object unchanged.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/data/types.ts lib/morning/brief/flags.ts
git commit -m "feat(brief): coach_reduce_intensity_suggested advice flag"
```

---

### Task 4: BriefCoachSuggestion — Carter header, high_soreness copy, reduce_intensity branch

**Files:**
- Modify: `components/morning/BriefCoachSuggestion.tsx` (imports, hook list, guard, render branches)

This task combines the two UI deltas (rationale-dependent copy for swap_to_mobility, and a new reduce_intensity branch). They land together because the union widening in Task 2 means TypeScript can only reconcile the bottom swap-render once a `reduce_intensity` early-return narrows the type.

- [ ] **Step 1: Add useState import**

At the top of `components/morning/BriefCoachSuggestion.tsx`, the existing import reads:

```ts
import { useMemo } from "react";
```

Change to:

```ts
import { useMemo, useState } from "react";
```

- [ ] **Step 2: Add dismiss flag hook**

Right after the existing `useSwapTrainingDay(...)` call (around line 59), add:

```ts
  const [reduceDismissed, setReduceDismissed] = useState(false);
```

- [ ] **Step 3: Narrow the suggestion guard**

Replace the existing two-line guard (around lines 61-62):

```ts
  if (!suggestion) return null;
  if (!trainingWeek) return null; // assembler should have gated; defense in depth
```

with:

```ts
  if (!suggestion) return null;
  // Swap kinds need a training_weeks row to mutate; reduce_intensity is
  // informational and renders without one.
  if (suggestion.kind === "swap_to_mobility" && !trainingWeek) return null;
```

- [ ] **Step 4: Insert reduce_intensity branch above the swap render**

Just above the existing `return ( <div ... background: COLOR.warningSoft ...> ... )` block (the swap-render branch), and below the `if (isAcknowledged) {...}` block, insert:

```tsx
  if (suggestion.kind === "reduce_intensity") {
    if (reduceDismissed) {
      return (
        <div
          style={{
            marginTop: "12px",
            padding: "12px 14px",
            background: COLOR.successSoft,
            color: COLOR.success,
            borderRadius: "10px",
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        >
          ✓ Got it — dropping top sets to RPE 7 today.
        </div>
      );
    }
    return (
      <div
        style={{
          marginTop: "12px",
          padding: "14px 16px",
          background: COLOR.warningSoft,
          borderRadius: "10px",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: COLOR.warning,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            marginBottom: "4px",
          }}
        >
          Carter recommends
        </div>
        <p
          style={{
            fontSize: "14px",
            color: COLOR.textStrong,
            marginBottom: "12px",
            lineHeight: 1.4,
          }}
        >
          {suggestion.detail ?? "Heavy fatigue + low recovery"} — drop top sets to RPE 7 today.
        </p>
        <button
          type="button"
          onClick={() => setReduceDismissed(true)}
          style={{
            width: "100%",
            padding: "10px 14px",
            background: COLOR.warning,
            color: "#000",
            border: "none",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Got it
        </button>
      </div>
    );
  }
```

After this early-return, TypeScript narrows `suggestion` for the remainder of the function to `{ kind: "swap_to_mobility"; rationale: "low_readiness" | "high_soreness"; detail?: string }`.

- [ ] **Step 5: Replace the swap-render header + body with rationale-dependent copy**

In the same render branch (the warning-soft swap suggestion card around line 100+), replace the existing header `<div>` (currently the literal string "Coach suggestion") and the `<p>` body (currently "Your readiness is low — swap to Mobility today?") with:

```tsx
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: COLOR.warning,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: "4px",
        }}
      >
        {suggestion.rationale === "low_readiness"
          ? "Coach suggestion"
          : "Carter recommends"}
      </div>
      <p
        style={{
          fontSize: "14px",
          color: COLOR.textStrong,
          marginBottom: "12px",
          lineHeight: 1.4,
        }}
      >
        {suggestion.rationale === "low_readiness"
          ? "Your readiness is low — swap to Mobility today?"
          : `${suggestion.detail ?? "Sharp soreness reported"} — swap to Mobility today?`}
      </p>
```

The rest of the swap-render block (Swap/Keep buttons, error display) stays unchanged.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. The reduce_intensity early-return narrows the union before the swap-render block; `suggestion.rationale` is exhaustive on `"low_readiness" | "high_soreness"` inside the conditional.

- [ ] **Step 7: Commit**

```bash
git add components/morning/BriefCoachSuggestion.tsx
git commit -m "feat(brief): Carter rationales + reduce_intensity branch in BriefCoachSuggestion"
```

---

### Task 5: Stamp speaker='remi' + thread='remi' on intake/recommendation writes

**Files:**
- Modify: `app/api/chat/morning/intake/route.ts` — five insert sites
- Modify: `app/api/chat/morning/recommendation/route.ts` — two retry-chip insert sites

- [ ] **Step 1: Stamp insertAssistantTurn (intake route)**

In `app/api/chat/morning/intake/route.ts`, find the `insertAssistantTurn` helper (around line 501). Add `speaker: 'remi'` and `thread: 'remi'` to the insert payload:

```ts
async function insertAssistantTurn(
  sr: SR,
  userId: string,
  args: { content: string; ui: MorningUI | null },
): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "assistant",
    speaker: "remi",
    thread: "remi",
    content: args.content,
    status: "done",
    kind: "morning_intake",
    ui: args.ui,
  });
  if (error) throw error;
}
```

- [ ] **Step 2: Stamp insertUserReply (intake route)**

In the same file, find the `insertUserReply` helper (around line 476). Add `thread: 'remi'` (no speaker on user rows — only assistants have speakers):

```ts
async function insertUserReply(
  sr: SR,
  userId: string,
  content: string,
): Promise<void> {
  const { error } = await sr.from("chat_messages").insert({
    user_id: userId,
    role: "user",
    thread: "remi",
    content,
    status: "done",
    kind: "morning_intake",
    ui: null,
  });
  if (error) throw error;
}
```

- [ ] **Step 3: Stamp the two direct inserts in handleFeelTail**

In `handleFeelTail` (around lines 314 and 333), there are two `sr.from("chat_messages").insert(...)` calls — one for the user's free-text message and one for the assistant stub the stream writes into. Add `thread: 'remi'` to the user insert and both `speaker: 'remi'` and `thread: 'remi'` to the assistant stub:

User insert (around line 314):

```ts
  await sr.from("chat_messages").insert({
    user_id: userId,
    role: "user",
    thread: "remi",
    content: trimmed || "(no extra notes)",
    status: "done",
    kind: "morning_intake",
    ui: null,
  });
```

Assistant stub insert (around line 333):

```ts
  const { data: stub, error: stubErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: userId,
      role: "assistant",
      speaker: "remi",
      thread: "remi",
      content: "",
      status: "streaming",
      kind: "morning_intake",
      ui: null,
      model: MODEL,
    })
    .select("id")
    .single();
```

- [ ] **Step 4: Stamp the two retry-chip inserts (recommendation route)**

In `app/api/chat/morning/recommendation/route.ts`, find the two retry-chip inserts inside the catch blocks (around lines 134 and 197). Both are intake-themed (the user sees them in the morning panel filtered to `kind='morning_intake'`), so stamp them as Remi:

First insert (around line 134):

```ts
        await sr.from("chat_messages").insert({
          user_id: user.id,
          role: "assistant",
          speaker: "remi",
          thread: "remi",
          kind: "morning_intake",
          content: "I had trouble generating today's brief. Tap to retry.",
          ui: {
            chips: [{ label: "Try again", action: "retry_brief" }],
          },
        });
```

Second insert (around line 197):

```ts
          await sr.from("chat_messages").insert({
            user_id: user.id,
            role: "assistant",
            speaker: "remi",
            thread: "remi",
            kind: "morning_intake",
            content: "I had trouble saving today's brief. Tap to retry.",
            ui: { chips: [{ label: "Try again", action: "retry_brief" }] },
          });
```

(The brief insert itself at line 156-168 stays as `speaker: 'peter', thread: 'peter'` — already correct.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `chat_messages` is an untyped table client; `speaker` and `thread` are already valid string columns from migrations 0024 and 0025.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/morning/intake/route.ts app/api/chat/morning/recommendation/route.ts
git commit -m "feat(intake): stamp speaker='remi' + thread='remi' on intake writes"
```

---

### Task 6: Intake LLM tail prompt — Remi voice

**Files:**
- Modify: `app/api/chat/morning/intake/route.ts:353-367`

- [ ] **Step 1: Replace the system prompt string**

In `handleFeelTail`, replace the `const sys = ...` template literal (currently lines 353-367) with Remi-voice copy. The tool-calling rules stay; only the voice changes:

```ts
        const sys = `You are Remi — the user's recovery and morning-health coach. The user has just finished the chip portion of their morning check-in and answered a free-text "anything else?" prompt. Their structured slot answers are already saved.

Your job:
1. If the free-text mentions a symptom that maps to {sick, soreness_areas, fatigue, bloating} and is clearly stated, call update_intake_slots ONCE to record it. Do not guess. Do not call the tool if nothing maps cleanly.
2. Reply briefly (1-2 short sentences) acknowledging what they shared. Voice: warm, focused on body signals and recovery — not training tactics, not nutrition. Examples of your tone: "Got it — I'll note the shoulder tightness." / "Thanks for the heads-up on the gut feel." Do not ask follow-up questions. Do not moralize.

Today's structured answers so far: ${JSON.stringify({
          readiness: todayRow.readiness,
          energy_label: todayRow.energy_label,
          mood: todayRow.mood,
          fatigue: todayRow.fatigue,
          bloating: todayRow.bloating,
          soreness_areas: todayRow.soreness_areas,
          soreness_severity: todayRow.soreness_severity,
        })}`;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — string-only change.

- [ ] **Step 3: Commit**

```bash
git add app/api/chat/morning/intake/route.ts
git commit -m "feat(intake): rewrite tail system prompt in Remi's voice"
```

---

### Task 7: Light voice pass on scripted prompts

**Files:**
- Modify: `lib/morning/script.ts:38,43,52,62,70,76,84,93,106,112,114,117,120,123,126`

- [ ] **Step 1: Update prompt strings to read like Remi**

The chip sequence and slot keys stay identical; only the prompt copy changes. Replace these strings in `lib/morning/script.ts`:

```ts
// readiness (line 38)
prompt: "Morning. How does the body feel today?",

// energy_label (line 43)
prompt: "Where's your energy at?",

// mood (line 52)
prompt: "And the mood?",

// soreness_gate (line 62)
prompt: "Anything sore?",

// soreness_areas (line 70)
prompt: "Where? (tap all that apply)",

// soreness_severity (line 76)
prompt: "How sore — mild or sharp?",

// fatigue (line 84)
prompt: "Any leftover fatigue beyond normal?",

// bloating (line 93)
prompt: "Feeling bloated at all?",
```

And the standalone prompts:

```ts
// STILL_SICK_PROMPT (line 106)
export const STILL_SICK_PROMPT = "Still feeling under the weather?";

// SICKNESS_NOTES_PROMPT (line 112)
export const SICKNESS_NOTES_PROMPT = "Sorry to hear that. What's going on?";

// REST_DAY_MESSAGE_HEALTHY_TO_SICK (line 114)
export const REST_DAY_MESSAGE_HEALTHY_TO_SICK =
  "Take it easy today — REST locked in. I'll check back in tomorrow. (Undo via the Log page if needed.)";

// REST_DAY_MESSAGE_STILL_SICK (line 117)
export const REST_DAY_MESSAGE_STILL_SICK =
  "REST again today then — hope you bounce back soon.";

// FREE_TEXT_TAIL_PROMPT (line 120)
export const FREE_TEXT_TAIL_PROMPT =
  "Anything else worth flagging? (or just hit send if you're good)";

// SYNC_WHOOP_PROMPT (line 123)
export const SYNC_WHOOP_PROMPT =
  "WHOOP hasn't synced yet — usually arrives within 30 min of waking. Tap below to pull it now, or I'll deliver the plan when it lands.";

// SYNC_WHOOP_FAILED_PROMPT (line 126)
export const SYNC_WHOOP_FAILED_PROMPT =
  "WHOOP sync still pending. Try again, or skip and I'll give you a feel-only plan from the last 7 days.";
```

(FREE_TEXT_TAIL_PROMPT and SYNC_WHOOP_* are unchanged — they already read in a coach-neutral voice that fits Remi.)

- [ ] **Step 2: Update "Good — let's run through the morning check-in." in route**

In `app/api/chat/morning/intake/route.ts:227` there's a hardcoded message when user says "no" to still_sick. Update to read like Remi:

```ts
    await insertAssistantTurn(sr, userId, {
      content: "Good to hear. Let's run through your morning. " + firstSlot.prompt,
      ui: chipsForSlot(firstSlot.key),
    });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — string-only change.

- [ ] **Step 4: Commit**

```bash
git add lib/morning/script.ts app/api/chat/morning/intake/route.ts
git commit -m "feat(intake): voice pass on scripted prompts (Remi tone)"
```

---

### Task 8: Move MorningIntakeHost from Today to Health + add placeholder

**Files:**
- Modify: `app/page.tsx:18,128`
- Modify: `components/health/HealthCoachClient.tsx`
- Modify: `components/dashboard/TodayMorningBriefSlot.tsx`

- [ ] **Step 1: Remove mount + import from app/page.tsx**

In `app/page.tsx`, delete line 18 (the `MorningIntakeHost` import) and line 128 (the `<MorningIntakeHost userId={user.id} />` mount inside `<HydrationBoundary>`).

After the edit, the bottom of the file should read:

```tsx
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TodayClient
        userId={user.id}
        userEmail={user.email ?? null}
        selectedDate={selectedDate}
        today={today}
        isToday={isToday}
        weeklyRollups={weeklyRollups}
        bodyTile={bodyTile}
      />
    </HydrationBoundary>
  );
}
```

- [ ] **Step 2: Add mount to HealthCoachClient**

In `components/health/HealthCoachClient.tsx`, add the import at the top (next to the existing `openMorningIntake` import on line 10):

```ts
import { MorningIntakeHost } from "@/components/morning/MorningIntakeHost";
```

Then mount it at the very top of the returned JSX, inside the outermost `<div>` (before `{/* ── Summary cluster ── */}` around line 78):

```tsx
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 88px)",
      }}
    >
      <MorningIntakeHost userId={userId} />
      {/* ── Summary cluster ── */}
      ...
```

`MorningIntakeHost` renders nothing visible until `MorningTrigger` decides to auto-open (which uses sessionStorage suppression — same gate as today, just on a different page). The existing "Start morning intake →" button in `MorningFeelRow` continues to work since it dispatches the `open-morning-intake` event the host listens for.

- [ ] **Step 3: Add Today placeholder**

Replace the entire body of `components/dashboard/TodayMorningBriefSlot.tsx` with:

```tsx
"use client";

import { useTodayBrief } from "@/lib/query/hooks/useTodayBrief";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { MorningBriefCard } from "@/components/morning/MorningBriefCard";
import { todayInUserTz } from "@/lib/time";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = { userId: string };

/** Renders today's morning brief card at the top of the Today page. When no
 *  brief has been delivered yet, shows a placeholder routing the user to
 *  the Health tab (where the intake now lives). Hydrates from the server
 *  prefetch in app/page.tsx so first paint is instant. */
export function TodayMorningBriefSlot({ userId }: Props) {
  const today = todayInUserTz();
  const { data: card } = useTodayBrief(userId, today);
  const { data: checkin } = useCheckin(userId, today);

  if (card) return <MorningBriefCard userId={userId} card={card} />;

  // Sick path delivers via REST short-circuit (no brief assembled). Don't
  // nag the user with a "check-in pending" card when they've already
  // told us they're sick.
  if (checkin?.intake_state === "delivered" && checkin?.sick) return null;

  return (
    <a
      href="/health"
      style={{
        display: "block",
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        padding: "14px 16px",
        textDecoration: "none",
      }}
      aria-label="Morning check-in pending — open Health tab"
    >
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        Morning brief
      </div>
      <div style={{ fontSize: 14, color: COLOR.textStrong, fontWeight: 600 }}>
        Check-in pending →
      </div>
      <div style={{ fontSize: 12, color: COLOR.textMid, marginTop: 2 }}>
        Tap to start your morning check-in with Remi on the Health tab.
      </div>
    </a>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `useCheckin` is already a hook used in HealthCoachClient; same import path.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx components/health/HealthCoachClient.tsx components/dashboard/TodayMorningBriefSlot.tsx
git commit -m "feat(intake): relocate intake popup to Health + Today placeholder"
```

---

### Task 9: Manual exercise + final commit

**Files:** none (verification only)

This task verifies the wired-together flow. The previous tasks each typechecked individually; this task exercises them as a whole.

- [ ] **Step 1: Run typecheck on the full diff**

Run: `npm run typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Start dev server**

Run: `npm run dev`
Expected: server listening on http://localhost:3000.

- [ ] **Step 3: Exercise the Remi intake path**

In a browser logged in as the test user:

1. Visit `/` — confirm no auto-popup of the intake chat (regression check: previously fired on Today load).
2. Confirm `TodayMorningBriefSlot` shows the placeholder card "Morning brief — Check-in pending →" since today's intake hasn't run.
3. Tap the placeholder — it should navigate to `/health`.
4. On `/health`, the intake chat sheet should auto-open (via `MorningTrigger`'s `decideIntakeAction` gate).
5. Tap through the chip sequence: readiness 7, energy medium, mood 😊, soreness "Yes", areas "shoulders", severity "Sharp", fatigue "Some", bloating "No".
6. Send free text "shoulders feel a bit tight" — confirm Remi's reply reads in his voice (warm, recovery-focused).
7. After WHOOP land (or skip), confirm the brief card appears in the same panel and on the Today page.
8. On the brief card, confirm the "Carter recommends" chip fires with copy `"sharp soreness in shoulders — swap to Mobility today?"` because today's session is Chest and shoulders is in `SESSION_MUSCLE_MAP["Chest"]`.
9. Tap "Swap to Mobility" — confirm the swap mutation runs and the acknowledged banner replaces the chip.
10. Visit `/metrics` — confirm the brief card now also appears in Peter's chat thread.

- [ ] **Step 4: Exercise the reduce_intensity path (best-effort)**

Reaching the reduce_intensity branch requires `recovery < 40 && fatigue === 'heavy'`. If today's WHOOP data has recovery ≥ 40, the easiest manual test is the SQL editor:

```sql
update daily_logs set recovery = 30 where user_id = '<your_uuid>' and date = current_date;
```

Then redo intake selecting fatigue "Heavy" and confirm the brief shows the "Carter recommends — drop top sets to RPE 7 today" chip with a single [Got it] button. Tap to confirm the acknowledged state.

Revert the daily_logs row when done (`update daily_logs set recovery = null where ...` or restore from the WHOOP record).

- [ ] **Step 5: Final manual checklist**

- [ ] No auto-popup on Today.
- [ ] Auto-popup on Health when intake pending.
- [ ] All intake assistant turns visible in Remi's chat thread (`/health`) after delivery.
- [ ] All intake user turns visible in Remi's chat thread.
- [ ] Morning brief card appears in Peter's chat thread (`/metrics`).
- [ ] Carter chip fires for sharp-soreness overlap (Chest day + sore shoulders).
- [ ] Existing low_readiness chip still fires (band='low' + non-rest day) with original copy.
- [ ] Reduce-intensity chip fires on recovery<40 + fatigue='heavy'.
- [ ] Swap mutation works from the Carter chip; acknowledged state replaces it.
- [ ] Today placeholder routes to `/health` and disappears once brief delivers.
- [ ] No regressions on the sickness path (intake_state→delivered, REST message).

- [ ] **Step 6: Commit any tweaks discovered during exercise**

If the manual exercise surfaces small issues (typos in prompts, color tweaks on the placeholder, etc.), commit them now with a single tweak commit:

```bash
git add -A
git commit -m "chore(intake): tweaks from manual exercise"
```

If no tweaks are needed, skip this step.

---

## Notes on the spec

- The spec mentions a separate "Carter session-adaptation step" file (`session-adaptation.ts`); the implementation merges that logic into the existing `pickCoachSuggestion` function in `assembler.ts` because the existing `coach_suggestion` primitive already covers the adaptation surface end-to-end (type, assembler call, advice flag, UI, swap mutation, acknowledged state). Inventing a parallel field would duplicate every layer.

- The spec lists "Brief row threading" as a delta — checking `app/api/chat/morning/recommendation/route.ts:161-162` confirms `speaker: 'peter'` + `thread: 'peter'` are already in place. No change in Task 6 for that row; only the two retry-chip inserts in the same file get the `thread: 'remi'` stamp.

- This project has no test framework. Tasks 1-8 verify via `npm run typecheck`; Task 9 is the integration check via local dev exercise. The deterministic rules in `pickCoachSuggestion` are simple enough that the manual exercise covers their behavior, but if a test framework lands later, the rules and the muscle-overlap helper are pure functions and trivially unit-testable.
