# Morning Intake Restructure — Remi → Carter → Peter

**Date:** 2026-05-21
**Status:** Draft
**Scope:** Single PR

## Goal

Restructure the morning intake flow so it reads as a coherent multi-coach
handoff: Remi conducts the health-focused intake conversation, a deterministic
Carter step assesses whether today's session needs adapting, and Peter
aggregates everything into the final morning brief card.

## Background

### Today's flow (state before this change)

1. `MorningIntakeHost` auto-opens a chat modal on `/` (the Today page) when
   `decideIntakeAction()` says intake is pending for the user.
2. The modal runs a scripted chip + free-text conversation through
   `app/api/chat/morning/intake/route.ts`. Assistant turns get no explicit
   speaker, defaulting to `speaker='peter'` per the DB default.
3. State machine advances through `awaiting_feel` → `awaiting_whoop` →
   `assembling_brief` → `brief_delivered`.
4. `lib/morning/brief/index.ts` assembles the brief card in one shot:
   pure-data composers + a single Anthropic Haiku call for the advice prose.
   The card is inserted as one `chat_messages` row with `kind='morning_brief'`,
   hardcoded `speaker='peter'`, no thread.
5. `TodayMorningBriefSlot` renders the card on `/` via `useTodayBrief`. The
   same row also renders in chat threads that include `kind='morning_brief'`.
6. The Session block on the brief card shows the prescribed session and
   client-side detects manual swaps for strikethrough display. Nothing
   recommends or applies a swap based on intake data.

### Problems with that flow

- Intake voice is generic / Peter by default — doesn't match the new 4-coach
  team mental model where Remi owns recovery and morning health checks.
- The auto-popup on the Today page conflicts with the new tab architecture
  where Remi lives on `/health`. The intake belongs in Remi's surface.
- No coach actually adapts the session based on intake data; users have to
  manually swap via the Strength tab even when sick or sore.
- Peter's role as aggregator isn't visible — the brief card just appears
  with no narrative of who contributed what.

## New flow

### Narrative

1. User opens the app, taps the Health pill in the bottom nav.
2. If `decideIntakeAction()` says intake is pending, the morning intake chat
   sheet auto-opens on `/health` (debounced via `sessionStorage` like today).
3. Remi conducts the conversation in his own voice (chips + free text):
   sickness, soreness, fatigue, bloating, mood, free notes. WHOOP wait stays
   under Remi (recovery data is his domain).
4. When `intake_state` advances to `assembling_brief`, the backend runs a
   deterministic Carter step that reads the intake payload + WHOOP recovery
   + today's prescribed session and decides whether the session needs
   adapting (keep / swap to mobility / swap to rest / reduce intensity).
   Carter's decision lands inside the brief payload — no separate chat
   message.
5. Peter assembles the brief card: yesterday recap, readiness, today's
   session (with Carter's adaptation embedded), macros, advice prose (single
   Haiku call), sleep target. The card row is stamped `speaker='peter'`,
   `thread='peter'`.
6. Card surfaces on `/today` via `TodayMorningBriefSlot` and in Peter's
   thread on `/metrics` (where his chat lives).
7. When Carter's adaptation is non-keep, the Session block on the card
   renders an inline sub-card: *"Carter recommends: swap Push → Mobility
   because shoulder soreness is 4/5"* with `[Apply swap]` / `[Keep Push]`
   buttons. Apply calls the existing
   `/api/training-weeks/[week_start]/swap` endpoint.

### Surface map

| Surface | What appears |
|---|---|
| `/today` (dashboard) | Brief card via `TodayMorningBriefSlot`. Placeholder "Morning check-in pending → Open Health" when intake not yet delivered. No auto-popup. |
| `/health` (Remi) | Auto-opens intake chat sheet when pending. After delivery, Remi's thread shows the intake conversation history. |
| `/metrics` (Peter) | Brief card appears in Peter's thread via the existing per-thread chat history (because the row now carries `thread='peter'`). |
| `/strength` (Carter) | No change. Carter's adaptation is captured in the brief payload, not as a chat turn in his thread. |

## Components and files

### Trigger relocation

**Remove:** `<MorningIntakeHost userId={user.id} />` from `app/page.tsx`.

**Add:** `<MorningIntakeHost userId={userId} />` mounted at the top of
`components/health/HealthCoachClient.tsx` (next to the existing layout).
`MorningTrigger` and `openMorningIntake()` keep their current shapes; only
the mount location moves.

**Update:** `TodayMorningBriefSlot` to render a placeholder card when no
brief exists for today. Placeholder body: a short string + a link to
`/health` (the link uses the existing nav, no new route). When the brief
exists, behavior is unchanged.

### Speaker and thread stamping for intake

**File:** `app/api/chat/morning/intake/route.ts`

- `insertAssistantTurn` and `insertUserReply` (and any other writers in this
  route) explicitly stamp `speaker: 'remi'` on assistant rows and
  `thread: 'remi'` on both assistant and user rows.
- The streamed Claude tail (`handleFeelTail`) keeps its tool-calling
  behavior but switches system prompt voice to Remi's. The prompt text
  rewrite:
  - Drops "athlete's coach reviewing morning notes" generic framing.
  - Adopts Remi's voice: warm, focused on physical sensations and recovery
    signals, no training-tactics talk.
  - Keeps the same `UPDATE_INTAKE_SLOTS_TOOL` contract.

### Remi voice in scripted chip prompts

The scripted slot prompts (`readiness`, `energy_label`, `mood`,
`soreness_areas`, `fatigue`, `bloating`, `feel_notes`, sickness flow) are
plain strings in `lib/morning/state.ts` or similar. Where the strings read
in a neutral voice today (e.g., "How's energy?"), they get a light pass to
sound like Remi — same question, slightly warmer phrasing. No structural
change to the chip sequence.

### Carter session-adaptation step

We **extend the existing `coach_suggestion` primitive** on the brief card
rather than inventing a parallel field. The primitive already triggers a
swap-to-mobility chip when readiness is low (`pickCoachSuggestion` in
`lib/morning/brief/assembler.ts`); we add Carter's two new rationales
(high soreness on target muscle, recovery crash + heavy fatigue) and one
new kind (reduce_intensity).

**Type change** — `MorningBriefCoachSuggestion` in `lib/data/types.ts`
grows from:

```ts
export type MorningBriefCoachSuggestion =
  | { kind: "swap_to_mobility"; rationale: "low_readiness" }
  | null;
```

to:

```ts
export type MorningBriefCoachSuggestion =
  | { kind: "swap_to_mobility"; rationale: "low_readiness" | "high_soreness"; detail?: string }
  | { kind: "reduce_intensity"; rationale: "recovery_crash"; detail?: string }
  | null;
```

Backward compatible — existing low_readiness rows still match.

**New file:** `lib/morning/brief/session-muscles.ts`

```ts
export const SESSION_MUSCLE_MAP: Record<string, readonly string[]> = {
  Chest: ["chest", "shoulders", "arms"],
  Back:  ["back", "arms"],
  Legs:  ["legs"],
  Mobility: [],
  REST:  [],
};
```

Keys match the `SORENESS_AREAS` constant in `lib/morning/script.ts`
(chest, back, legs, shoulders, arms, core).

**Modified function:** `pickCoachSuggestion` in
`lib/morning/brief/assembler.ts` — signature changes to accept the new
inputs, rules evaluated in order (first match wins):

```ts
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
}): MorningBriefCoachSuggestion
```

Rules:

1. **High soreness on target muscle** —
   `intake.soreness_severity === 'sharp'` AND `intake.soreness_areas`
   has any element matching `SESSION_MUSCLE_MAP[sessionType]`
   (case-insensitive) AND session is not REST/Mobility/Sick →
   `{ kind: "swap_to_mobility", rationale: "high_soreness", detail: "sharp soreness in <overlap>" }`.

2. **Low readiness** (existing) — `band === "low"` AND session is not
   REST/Mobility/Sick →
   `{ kind: "swap_to_mobility", rationale: "low_readiness" }`.

3. **Recovery crash** — `recovery !== null && recovery < 40 &&
   intake.fatigue === "heavy"` AND session is not REST/Mobility/Sick →
   `{ kind: "reduce_intensity", rationale: "recovery_crash", detail: "recovery <N> + heavy fatigue" }`.

4. Otherwise → `null`.

**`sick` is not in the rule set.** The sickness path short-circuits intake
to `intake_state='delivered'` upstream (no brief assembled), so it never
reaches `pickCoachSuggestion`.

**Wired into:** `assembleBriefExceptAdvice` in
`lib/morning/brief/assembler.ts` — the call site at line ~117 changes
from passing `(band, sessionType, hasTrainingWeek)` to passing the full
args object including the intake slots from `checkin` and recovery from
`todayLog`. Both are already available in the assembler's input bag.

The advice flag `coach_swap_suggested` (already in `flags.ts` at line
108) stays — it gates whether Peter's prose mentions Carter's
recommendation. No new flag needed; the existing check
(`card.coach_suggestion?.kind === "swap_to_mobility"`) covers the two new
swap rationales naturally. A second flag `coach_reduce_intensity_suggested`
(`card.coach_suggestion?.kind === "reduce_intensity"`) joins it so prose
can acknowledge the weaker recommendation too.

### Brief card UI

**File:** `components/morning/BriefCoachSuggestion.tsx`

The existing component already handles the low_readiness → swap_to_mobility
path with Apply/Keep buttons + acknowledged state detection. We extend it
to render the two new rationales/kinds:

- **`swap_to_mobility, rationale='high_soreness'`** — header label changes
  from "Coach suggestion" to "Carter recommends"; body copy reads
  `"<detail> — swap to Mobility today?"`; buttons unchanged
  (Apply / Keep). Same swap mutation (`useSwapTrainingDay`,
  `{ session_type: "Mobility" }`).

- **`swap_to_mobility, rationale='low_readiness'`** (existing) — copy
  stays as-is for backward compat with users who already know this chip.
  Header label still "Coach suggestion" so we don't change what's
  already working.

- **`reduce_intensity, rationale='recovery_crash'`** — header "Carter
  recommends"; body copy reads `"<detail> — drop top sets to RPE 7
  today"`; single `[Got it]` button. No swap mutation, just a client-side
  dismiss flag. Acknowledged state on this kind = the button was tapped
  this session (not persisted; reappears on reload — acceptable for v1).

The component's existing acknowledgment logic (live training_weeks plan
diverges from brief's frozen session.type → show ✓ banner) only applies
to swap_to_* kinds. For reduce_intensity, acknowledgment is the
button-tap state.

Apply success on swap kinds → existing mutation invalidates
`training-weeks` query key (no change needed). Brief payload is **not**
rewritten on apply — coach_suggestion is the record of what Carter
recommended, not of what the user did.

### Brief row threading

**File:** `app/api/chat/morning/recommendation/route.ts`

No change needed — the insertion at line 161-162 already stamps
`speaker: 'peter'` and `thread: 'peter'`. (Earlier draft of this spec
listed this as a delta; checking the file confirmed it's already done.)

### Today page placeholder

**File:** `components/dashboard/TodayMorningBriefSlot.tsx`

When `useTodayBrief` returns no card and intake is not yet delivered today,
render a small card:

```
Morning check-in pending
Tap the Health tab to start your check-in with Remi.
```

When the card exists, behavior unchanged. (The placeholder uses the same
`Card` styling as the existing `LabPromptCard` for consistency.)

## Non-goals

- No new Anthropic calls. Peter's advice prose stays one Haiku call;
  Carter's step is pure rules; Remi's voice change is prompt-only.
- No new database tables, migrations, or columns. Carter's recommendation
  reuses the existing `coach_suggestion` field on the brief payload.
- No backfill of historic morning_brief rows. The new rationales and
  reduce_intensity kind are additive; existing low_readiness rows
  continue rendering with the existing copy.
- No new state machine values. Carter's step runs synchronously inside
  `assembleBriefExceptAdvice`.
- No changes to the WHOOP wait / retry flow.
- No changes to the intake chip sequence, slot definitions, or sick-day
  short-circuit behavior.

## Edge cases

- **No prescribed session / hasTrainingWeek is false** — `pickCoachSuggestion`
  returns `null` (existing behavior); UI renders the Today block with no
  chip.
- **Today is REST / Mobility / Sick already** — all three rules gate on
  this; result is `null`, no chip.
- **WHOOP recovery missing** — rule 3 is gated on `recovery !== null`;
  with no recovery data we skip the reduce-intensity branch. Rules 1 and
  2 still apply.
- **User dismisses the recommendation, then refreshes** — for swap kinds,
  the existing acknowledged state (live training_weeks vs brief frozen
  type) handles the post-swap case; for reduce_intensity, the dismiss is
  client-side only and the chip reappears on reload. Acceptable for v1.
- **User taps Apply on a swap, then we re-render** — the existing
  acknowledged banner ("✓ Swapped to Mobility at …") replaces the chip.
  No new logic.
- **User skips Health entirely on a given day** — intake never runs, brief
  never assembles, Today shows the placeholder. This is intentional with
  the new flow; the unread-dot on the Health pill provides discoverability.
- **Multiple rules could fire simultaneously** — first-match-wins by design:
  high_soreness beats low_readiness beats recovery_crash. A user with sharp
  soreness AND low readiness sees Carter's soreness-specific copy, which
  is the more actionable signal.

## Risks

- **Discoverability of morning intake when user starts on Today.** With
  auto-popup gone from `/`, a user who only visits Today might never see
  the intake prompt. Mitigations: placeholder card on Today routes them to
  Health; the existing unread-dot on the Health bottom-nav pill draws the
  eye. We accept some loss of forced engagement in exchange for cleaner
  coach attribution.

- **Rule false positives on soreness swap.** Soreness severity has two
  values ('mild' / 'sharp'); 'sharp' is meant to be the unambiguous "this
  hurts" signal. If users over-tap 'sharp' for routine soreness, the swap
  recommendation may feel pushy. The two-button UI (Apply / Keep) lets
  users dismiss without action; Carter's `detail` string ("sharp soreness
  in shoulders") makes the trigger transparent. We can tighten or change
  the rule (e.g., require >1 area, or check `fatigue !== 'none'` too)
  after a week of real use.

- **Brief card appearing in Peter's thread might surprise users on first
  visit to /metrics.** Mitigation: the card uses the existing
  `kind='morning_brief'` renderer in `ChatThread.tsx`, so it looks the
  same as on Today; just shows up in chat history now. Acceptable.

## Open follow-ups (explicitly out of scope)

- Persisted "Carter said this, I ignored it" flag for telemetry/retro.
- Carter posting an actual chat turn in his own thread when adaptation
  fires (today the adaptation is card-only; the audit is the payload).
- AI-narrated adaptation reasoning (rules are deterministic in v1).
- Nora or Remi suggesting nutrition / sleep adjustments on the brief card
  the same way Carter does for sessions.
