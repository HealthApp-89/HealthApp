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

**New file:** `lib/morning/brief/session-adaptation.ts`

Exports a pure function:

```ts
type AdaptationAction = 'keep' | 'swap_to_rest' | 'swap_to_mobility' | 'reduce_intensity';

type SessionAdaptation = {
  action: AdaptationAction;
  reason: string; // short, user-facing, e.g. "shoulder soreness 4/5"
  swap_to?: string; // when action is swap_*; the session type to swap to
};

export function assessSessionAdaptation(input: {
  intake: CheckinIntakePayload; // sick, soreness_areas, soreness_severity, fatigue, energy_label, readiness
  recovery: number | null; // WHOOP recovery 0-100
  todaysSession: { type: string; targetedMuscleGroups: string[] };
}): SessionAdaptation
```

**Rules (evaluated in order, first match wins):**

1. **Sick** — `intake.sick === true` → `swap_to_rest`, reason `"reported sick — full rest day"`.
2. **High soreness on target muscle** — `intake.soreness_severity >= 4`
   AND any name in `intake.soreness_areas` overlaps `todaysSession.targetedMuscleGroups`
   AND `todaysSession.type !== 'REST'` AND `todaysSession.type !== 'Mobility'`
   → `swap_to_mobility`, reason `"<area> soreness <N>/5"`.
3. **Recovery crash** — `recovery !== null` AND `recovery < 40`
   AND (`intake.fatigue === 'high'` OR `intake.readiness === 'low'`)
   AND `todaysSession.type !== 'REST'` AND `todaysSession.type !== 'Mobility'`
   → `reduce_intensity`, reason `"recovery <N> + high fatigue — drop top sets to RPE 7"`.
4. **Default** — `keep`, reason `""`.

`targetedMuscleGroups` for each `SESSION_PLANS` entry is a small static map
defined alongside the rules file (Push → `['chest', 'shoulders', 'triceps']`,
Pull → `['back', 'biceps']`, Legs → `['quads', 'hamstrings', 'glutes', 'calves']`,
Full Body → all, REST/Mobility → `[]`).

`intake.soreness_areas` is the existing checkin slot — same string keys as
the muscle groups above (chest, back, shoulders, etc.); the overlap check
is case-insensitive substring match.

**Wired into:** `lib/morning/brief/index.ts` inside
`assembleBriefExceptAdvice`, after the session is resolved from
`thisWeekPrescription`. The result is attached to the brief payload as
`card.session.adaptation`. The advice flag computation in
`computeAdviceFlags` gets one new flag (`adaptation_action`) so Peter's
prose can acknowledge the adaptation when it's non-keep.

### Brief card payload extension

**File:** `components/morning/types.ts` (or wherever `MorningBriefCard` is typed)

`MorningBriefCard.session` grows:

```ts
session: {
  // existing fields
  adaptation?: SessionAdaptation; // undefined === implicit 'keep' for backward compat
};
```

`undefined` is treated as `keep` so any pre-existing brief rows (written
before this change) render correctly without backfill.

### Brief card UI

**File:** `components/morning/MorningBriefCard.tsx`

The Today session block (currently a list of prescribed exercises with the
`[Carter]` chip) grows a conditional sub-card when
`card.session.adaptation && card.session.adaptation.action !== 'keep'`:

```
┌─ Carter recommends ──────────────────────────┐
│ {reason}                                     │
│ {action === 'swap_to_*'                      │
│   ? [Apply swap] [Keep {current}]            │
│   : [Reduce intensity acknowledged]}         │
└──────────────────────────────────────────────┘
```

- For `swap_to_rest` and `swap_to_mobility`: two buttons. Apply calls the
  existing `POST /api/training-weeks/[week_start]/swap` with
  `{ action: 'replace', weekday: <today>, new_type: 'REST' | 'Mobility' }`.
  Keep dismisses client-side (toggles a `useState` flag); the recommendation
  stays in the brief payload for audit.
- For `reduce_intensity`: single acknowledge button (no swap endpoint
  needed); the recommendation is informational. Clicking sets the same
  dismissed flag.

Apply success → invalidate `training-weeks` query key so the strikethrough
detector picks up the new session. Brief payload is **not** rewritten on
apply — the adaptation field is the record of what Carter recommended,
not of what the user did.

### Brief row threading

**File:** `app/api/chat/morning/recommendation/route.ts`

The morning_brief insertion (currently `speaker: 'peter'`, no thread) gets
`thread: 'peter'` added. This makes the card appear in Peter's chat thread
on `/metrics`. No migration needed — `thread` already exists from
migration 0025.

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
  lives in the existing `chat_messages.ui` jsonb.
- No backfill of historic morning_brief rows. The `adaptation` field is
  optional; pre-existing rows render as `keep` implicitly.
- No new state machine values. Carter's step runs synchronously inside
  `assembleBriefExceptAdvice`.
- No changes to the WHOOP wait / retry flow.
- No changes to the intake chip sequence, slot definitions, or sick-day
  short-circuit behavior.

## Edge cases

- **No prescribed session for today** — adaptation step returns `keep`
  with empty reason; UI renders the existing Today block unchanged.
- **Today is REST or Mobility already** — rules 2 and 3 are gated to skip;
  rule 1 still fires if sick is true but the result is also no-op (rest
  stays rest). UI shows no adaptation sub-card.
- **WHOOP recovery missing** — rule 3 is gated on `recovery !== null`;
  with no recovery data we skip the reduce-intensity branch and fall
  through to keep. Soreness and sick rules still apply.
- **User dismisses the adaptation, then refreshes** — dismissal is client-
  side only, so the sub-card reappears. Acceptable for v1 (this is a
  recommendation, not a TODO); future versions could persist an
  `acknowledged_adaptation` flag if it becomes noisy.
- **User taps Apply, then we re-render** — the strikethrough detector
  already shows the user's new session; the adaptation sub-card stays
  visible as a record of why the swap happened.
- **User skips Health entirely on a given day** — intake never runs, brief
  never assembles, Today shows the placeholder. This is intentional with
  the new flow; the unread-dot on the Health pill provides discoverability.

## Risks

- **Discoverability of morning intake when user starts on Today.** With
  auto-popup gone from `/`, a user who only visits Today might never see
  the intake prompt. Mitigations: placeholder card on Today routes them to
  Health; the existing unread-dot on the Health bottom-nav pill draws the
  eye. We accept some loss of forced engagement in exchange for cleaner
  coach attribution.

- **Rule false positives on soreness swap.** If the soreness severity slot
  is over-reported (e.g., 4/5 for mild stiffness), the swap recommendation
  may feel pushy. The two-button UI (Apply / Keep) lets users dismiss
  without action; Carter's reason is short and specific so users can
  judge for themselves. Tune the threshold (currently `>= 4`) in code if
  needed after a week of real use.

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
