# Morning Intake Bot — Design

**Date:** 2026-05-08
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed

## Problem

The morning feel data that drives 35% of the readiness score is captured today via a manual form on `/log` — easy to skip, easy to fill quickly without thought. The new `checkins` columns we want (sickness, bloating, fatigue, structured soreness) would make that form longer and more tedious.

We want the morning check-in to feel like an interaction with the coach, not data entry. A chat-style intake that pops on first app-open, asks one question at a time with tap chips, and hands off to a coach recommendation once WHOOP data is available.

## Goals

1. Replace the manual morning-feel form as the *primary* entry path with a conversational intake driven by [components/chat/ChatPanel.tsx](../../../components/chat/ChatPanel.tsx).
2. Capture additional structured signals (sickness, bloating, fatigue, soreness areas + severity) that wire into intensity-mode overrides.
3. Decouple subjective intake (works any time) from coach recommendation (WHOOP-gated) so the user can complete the morning ritual even when WHOOP is delayed.
4. Preserve historical readiness score continuity — the headline 65/35 WHOOP-feel split is unchanged.

## Non-Goals

- Push notifications. PWA/no-push environment; the bot only fires on app-open.
- Multi-user generalization. Single-user app; sickness episode tables / shared scripts are out of scope.
- Automated symptom triage or any health-grade interpretation. The bot is a logger, not a diagnostician.
- Replacing the manual form. It stays as the read-back/edit surface for corrections.

## Architecture overview

Per-day state machine keyed on `(user_id, date)`, stored as `checkins.intake_state`:

```
                          ┌─ sick yesterday? ──── yes ──→ "still sick?" ──── yes ──→ stay sick, REST plan, DELIVERED
                          │                                                  │
 first app-open of day ───┤                                                  └── no → flip sick=false, continue ↓
                          │
                          └─ healthy? ──→ AWAITING_FEEL
                                              │
                                 (5–7 scripted slot questions, tap chips)
                                              │
                                              ▼
                                        feel-tail LLM turn
                                              │
                                              ▼
                              ┌─── WHOOP row exists? ───┐
                              │                         │
                              ▼                         ▼
                          DELIVERED                 AWAITING_WHOOP
                       (coach plan now)         (parked, "Sync WHOOP" button)
                                                        │
                                            user syncs / row arrives
                                                        │
                                                        ▼
                                                   DELIVERED
```

The state machine lives **server-side**. The client never decides "what's the next question" — it sends an answer to `/api/chat/morning/intake`, which transitions state and streams back the next assistant turn. This eliminates inconsistency from two-tab usage or mid-intake refreshes.

Sickness short-circuits Phase 2 — `sick=true` → REST recommendation immediately, no WHOOP gate.

## Schema changes

### Migration `0007_morning_intake.sql`

```sql
-- checkins: new structured slots + intake state machine column
alter table public.checkins
  add column if not exists sick              boolean not null default false,
  add column if not exists sickness_notes    text,
  add column if not exists fatigue           text,            -- 'none' | 'some' | 'heavy'
  add column if not exists bloating          boolean,         -- nullable: not asked = null
  add column if not exists soreness_areas    text[],          -- ['chest','back','legs','shoulders','arms','core']
  add column if not exists soreness_severity text,            -- 'mild' | 'sharp'
  add column if not exists intake_state      text not null default 'pending'
    check (intake_state in (
      'pending',
      'awaiting_feel',
      'awaiting_sickness_notes',  -- transient: between declare_sick chip tap and the user's text reply
      'awaiting_whoop',
      'delivered'
    ));

-- chat_messages: discriminator so the morning thread doesn't pollute free-form coach chat,
-- plus a ui jsonb so scripted assistant turns can carry tap-chip definitions.
alter table public.chat_messages
  add column if not exists kind text not null default 'coach'
    check (kind in ('coach','morning_intake')),
  add column if not exists ui jsonb;

create index if not exists chat_messages_user_kind_created_idx
  on public.chat_messages (user_id, kind, created_at desc);
```

The legacy `soreness text` column is **kept** (not dropped) for backward compat — the manual form still writes it, and the LLM tail step writes a free-text summary there. Readiness math reads the new `soreness_areas` + `soreness_severity` and ignores the legacy text.

`ui jsonb` shape for scripted turns:
```json
{ "chips": [{"label": "Low", "value": "low"}, {"label": "Medium", "value": "medium"}, ...],
  "multi_select": false,
  "next_action": "answer_slot" }
```

For the WHOOP-sync action chip:
```json
{ "chips": [{"label": "Sync WHOOP now", "action": "whoop_sync"},
             {"label": "Skip — feel-only plan", "action": "skip_whoop"}] }
```

Free-form coach turns leave `ui` null — no ChatPanel rendering changes for the existing path.

### Type mirror

[lib/data/types.ts](../../../lib/data/types.ts) gets the new columns added to `Checkin`-shape (which is currently inline in [lib/query/fetchers/checkin.ts](../../../lib/query/fetchers/checkin.ts) — promote it into `types.ts` as part of this work). `ChatMessageRow` gains `kind` and `ui`.

## Components & data flow

### New files

- [lib/morning/script.ts](../../../lib/morning/script.ts) — pure data: question definitions in order, with chip values per slot. Single-letter cost to evolve.
- [lib/morning/state.ts](../../../lib/morning/state.ts) — pure functions:
  - `decideIntakeAction(yesterdayRow, todayRow): {action: 'open', mode: 'fresh'|'resume_feel'|'resume_whoop'|'still_sick_check'} | {action: 'skip'}`. The `'resume_feel'` branch covers any non-`delivered`, non-`awaiting_whoop` mid-flow state — including `awaiting_sickness_notes` — because in those cases the panel just reopens to the existing thread, and the latest assistant message dictates what the user sees and what action chips are available.
  - `nextSlot(checkinRow): SlotKey | 'tail' | 'done'` — given partial checkin row, returns the next un-answered slot or `'tail'` for the LLM step.
  - Both heavily unit-testable; no DB, no LLM, no clock dependencies (clock injected).
- [app/api/chat/morning/intake/route.ts](../../../app/api/chat/morning/intake/route.ts) — POST endpoint:
  - Body: `{kind: 'start' | 'declare_sick' | 'free_text', value?: string} | {slot: SlotKey, value: ChipValue | string[]}`
  - Resolves user via `createSupabaseServerClient`, derives `today` via `todayInUserTz()`.
  - Upserts the matching `checkins` column, advances `intake_state`, inserts the next assistant `chat_messages` row with appropriate `ui.chips` (or, for the free-text tail, calls Claude and streams).
  - SSE response shape matches existing [components/chat/sseClient.ts](../../../components/chat/sseClient.ts) so ChatPanel can consume both this and the existing coach stream.

  **Free-text dispatch.** `{kind:'free_text'}` is reused for two distinct purposes; server dispatches on the row's current `intake_state` and `sick` columns at receive time:
  - `intake_state='awaiting_feel'` and `sick=false`, with the prior assistant turn being the "Anything else worth flagging?" prompt → **LLM tail.** Server runs Claude with a tail-prompt and a single tool `update_intake_slots(slots: {sick?, fatigue?, soreness_areas?, soreness_severity?, bloating?})` so Claude can promote symptoms it hears (e.g. "back is sore" → `soreness_areas: ['back']`) into structured columns. Save the user's text to `feel_notes`. After streaming completes, server auto-POSTs `/api/chat/morning/recommendation`.
  - State just transitioned via `{kind:'declare_sick'}` (server marks this with a transient `intake_state='awaiting_sickness_notes'` between the declare and the free-text reply, scoped to that flow only — it's a fifth check-constraint value, included in the migration's CHECK clause) → **sickness notes.** Save to `sickness_notes`, set `sick=true`, post the templated REST message, set `intake_state='delivered'`. No Claude call.
- [app/api/chat/morning/recommendation/route.ts](../../../app/api/chat/morning/recommendation/route.ts) — POST endpoint:
  - Reads today's `checkins` + `daily_logs`.
  - If `sick=true`: posts a templated REST message (no Claude call), sets `intake_state='delivered'`, returns.
  - Else: calls existing `buildDailyPlan()` from [lib/coach/readiness.ts](../../../lib/coach/readiness.ts) for structured plan, sends to Claude with a "render this plan conversationally as the coach" prompt, streams as next assistant turn, sets `intake_state='delivered'`.
- [components/morning/MorningTrigger.tsx](../../../components/morning/MorningTrigger.tsx) — invisible client component mounted in [TopNav](../../../components/layout/TopNav.tsx). On mount: fetches today + yesterday checkins (via existing TanStack hooks), calls `decideIntakeAction`, and if `open`, sets ChatPanel state `{open:true, mode:'morning_intake'}`. Suppression key in `sessionStorage` (`morningHandled-${date}`) prevents re-pop on intra-session navigation.

### Modified files

- [components/chat/ChatPanel.tsx](../../../components/chat/ChatPanel.tsx) — gains:
  - `mode: 'coach' | 'morning_intake'` prop.
  - Tab switcher at the top to flip between modes (and show the morning history scrolled back).
  - Filter `chat_messages` by `kind` matching the active mode.
  - When the latest assistant message has `ui.chips`, render chips above the composer (or replace the composer entirely when `next_action !== 'free_text'`). Tap → POST `/api/chat/morning/intake`.
  - Persistent "I'm coming down with something" subtle link below the composer when `mode='morning_intake'` and `sick=false`.
  - WHOOP-sync chip action: client calls existing [/api/whoop/sync](../../../app/api/whoop/sync/route.ts), then invalidates `dailyLogs(userId, today, today)`. A `useEffect` watches that query while `intake_state='awaiting_whoop'`; on `recovery !== null`, POSTs `/api/chat/morning/recommendation`.
- [components/layout/TopNav.tsx](../../../components/layout/TopNav.tsx) — replace `chatOpen: boolean` state with `chatState: {open: boolean, mode: 'coach' | 'morning_intake'}`. Mount `<MorningTrigger>`.
- [components/layout/Fab.tsx](../../../components/layout/Fab.tsx) — same `chatState` shape; FAB tap opens in `'coach'` mode.
- [lib/query/fetchers/checkin.ts](../../../lib/query/fetchers/checkin.ts) — extend `COLS` with the new fields; add `sick`, `sickness_notes`, `fatigue`, `bloating`, `soreness_areas`, `soreness_severity`, `intake_state` to the `Checkin` type. Keep both server and browser variants in sync per the [client-cache refactor design](2026-05-07-client-cache-refactor-design.md).
- [lib/query/keys.ts](../../../lib/query/keys.ts) — add a key for yesterday's checkin if not already supported (or use the existing `checkin.one(userId, date)` with a yesterday-stringified date).
- [lib/coach/readiness.ts](../../../lib/coach/readiness.ts) — extend `FeelInput`:
  ```ts
  export type FeelInput = {
    readiness: number | null;
    energyLabel: string | null;
    mood: string | null;
    soreness: string | null;          // legacy free-text, kept for back-compat
    notes: string | null;
    sick: boolean;                    // new
    fatigue: 'none' | 'some' | 'heavy' | null; // new
    sorenessAreas: string[] | null;   // new
    sorenessSeverity: 'mild' | 'sharp' | null; // new
  };
  ```
  Rewrite `getIntensityMode` per the rules in "Score impact wiring" below. Drop the legacy `soreness.length > 5` heuristic.
- [components/log/LogForm.tsx](../../../components/log/LogForm.tsx) — add editable fields for the new columns (chip pickers mirroring the bot's UI). This is the read-back/edit surface, not the primary entry path.
- [app/log/actions.ts](../../../app/log/actions.ts) — `saveDailyLog` server action: when all required morning slots are present in the FormData, set `intake_state='delivered'` to suppress the bot for the day.

### Happy-path data flow (healthy yesterday, WHOOP synced)

```
1. App opens → TopNav mounts → MorningTrigger queries useCheckin(today) + useCheckin(yesterday)
2. decideIntakeAction → {open: 'fresh'} → setChatState({open:true, mode:'morning_intake'})
3. ChatPanel mounts in morning_intake mode → loads chat_messages where kind='morning_intake' for today
   Empty thread → auto-POSTs /api/chat/morning/intake {kind:'start'}
4. Server upserts checkins(intake_state='awaiting_feel'), inserts assistant turn:
     "Good morning. How does your body feel today?" + ui.chips=[1..10]
   → streams back via SSE
5. User taps "8" → POST {slot:'readiness', value:8}
   Server updates checkins.readiness=8, inserts next turn ("Energy?", chips=[Low,Med,High])
6. Repeats: energy → mood → soreness gate (Y/N) → [if Y: areas multi-select → severity] → fatigue → bloating
7. After last chip → server posts assistant: "Anything else worth flagging?" with composer enabled, no chips
8. User types free text → POST {kind:'free_text', value:'...'}
   Server runs Claude with a tail-prompt:
     "Save the user's text to feel_notes. If they mention symptoms that map to one of
      {sick, soreness_areas, fatigue}, emit a tool call to update those slots before responding."
   Streams response + may emit a structured tool call to update checkins.
9. Tail done → server auto-POSTs /api/chat/morning/recommendation
   Reads daily_logs(today). recovery is non-null → calls Claude with buildDailyPlan() output + feel context.
   Streams coach plan as next assistant turn. Sets intake_state='delivered'.
10. User reads recommendation. Done. Bot won't re-pop today.
```

### Awaiting-WHOOP variant (step 9, recovery is null)

- Server sets `intake_state='awaiting_whoop'`, inserts assistant turn:
  > *"WHOOP hasn't synced yet — usually arrives within 30 min of waking. Tap below to pull it now, or I'll deliver the plan when it lands."*
  with `ui.chips=[{label:'Sync WHOOP now', action:'whoop_sync'}]`.
- User taps → client calls existing `/api/whoop/sync` → on 200, invalidates `dailyLogs(userId, today, today)`.
- ChatPanel `useEffect`: while `intake_state==='awaiting_whoop'`, watches `useDailyLogs(today)`; when `recovery !== null`, POSTs `/api/chat/morning/recommendation`.
- Belt-and-suspenders: TanStack Query `refetchOnWindowFocus` covers the case where WHOOP arrives via cron while the panel is closed and the user later refocuses; on focus, the same effect detects `recovery !== null` and fires the recommendation.
- Failure path (token expired / WHOOP API down): assistant turn explains the error, offers `[{label:'Try again', action:'whoop_sync'}, {label:'Skip — feel-only plan', action:'skip_whoop'}]`. Skip path runs a feel-only recommendation off `checkins` + 7-day trends, labeled clearly as such.

### Sickness flow

**Entry from healthy state:**
- Tap "I'm coming down with something" link in ChatPanel → POST `/api/chat/morning/intake` `{kind:'declare_sick'}`.
- Server inserts assistant turn *"What's going on?"* (composer enabled, no chips).
- User free-texts → POST `{kind:'free_text', value:'...'}`.
- Server saves to `sickness_notes`, sets `sick=true`, posts a templated REST message:
  > *"Take it easy today. REST mode locked in. I'll check in tomorrow."*
- Sets `intake_state='delivered'`. Skips the rest of the scripted flow.

**Carry-forward:**
- Each morning, if yesterday's `sick=true`, today's first scripted question is replaced by:
  > *"Still feeling sick?"* with `chips=[Yes, No]`.
- **Yes** → upsert today's row with `sick=true`, copy yesterday's `sickness_notes` forward, set `intake_state='delivered'`, post REST message. No further questions.
- **No** → set today's row with `sick=false`, post:
  > *"Good — let's run through the morning check-in."*
  and continue with `readiness 1-10`. Normal flow from there.

**Audit trail:** `checkins` keeps one row per day with `sick=true` and inherited `sickness_notes`. No separate episode table.

**Coach context across the episode:** the LLM coach's snapshot prefix already includes the last 14 days of `checkins` rows — sickness shows up there for free, no plumbing change.

## Score impact wiring

### Headline number (unchanged)

`computeDailyReadiness` math is **untouched** — historical scores remain comparable.

```
whoopScore = 0.4·HRV + 0.4·WHOOP recovery + 0.2·sleep_score
combined   = whoopScore·0.65 + feelPct·0.35
```

### Energy nudge (small)

`feelPct` is multiplied by an energy factor before the 65/35 blend:

| `energy_label` | factor |
|---|---|
| `low`    | 0.9  |
| `medium` | 1.0  |
| `high`   | 1.05 |
| null     | 1.0  |

Capped at 100. Worst-case impact on the headline number: ±3 points. Lets "felt 8/10 with low energy" diverge from "felt 8/10 with high energy."

### Intensity-mode overrides (the new structured slots route through here)

`getIntensityMode` is rewritten to apply hard overrides *before* score-banded logic:

```ts
export function getIntensityMode(readiness, feel) {
  // Hard overrides — applied before any score band
  if (feel?.sick)                              return REST;        // any sickness → REST
  if (feel?.sorenessSeverity === 'sharp')      return LIGHT;       // sharp soreness → LIGHT
  if (feel?.fatigue === 'heavy')               return MODERATE;
  const mildAreas = (feel?.sorenessAreas ?? []).length;
  if (feel?.sorenessSeverity === 'mild' && mildAreas >= 3) return MODERATE;

  // Otherwise: existing score-banded logic, unchanged
  // >=80 PUSH, >=65 FULL, >=50 MOD, >=35 LIGHT, else REST
}
```

Drop the legacy `soreness.length > 5` heuristic.

### Coach-context-only signals

These do NOT move the score or mode; they appear in the LLM coach's per-turn header:

- `mood`
- `bloating`
- `feel_notes` (free text)
- Specific soreness areas (when severity is mild and areas < 3 — they don't override mode but do reach the coach)

## Edge cases

1. **Timezone rollover during in-progress intake.** User starts at 23:55, finishes at 00:05. Server uses `todayInUserTz()` once at the start of each `/api/chat/morning/intake` call and stamps the row; if a follow-up comes in for a different `date`, server treats it as a new day. The previous day's row stays in `awaiting_feel` indefinitely (acceptable; rare; no auto-cleanup).
2. **User dismisses the panel mid-intake.** ChatPanel close button calls `onClose`. Server-side state is whatever was last persisted. On next app-open same day, `decideIntakeAction` returns `{open: 'resume_feel'}` and the panel reopens to the next pending question (`nextSlot()` returns the first slot whose column is null).
3. **User edits `/log` form fields manually before the bot fires.** `decideIntakeAction` checks today's row: if `intake_state` is still `'pending'` but `readiness` is set, returns `{open: 'resume_feel'}`. If the form save action sets `intake_state='delivered'` (because all required slots are present), `decideIntakeAction` returns `{action: 'skip'}`. The form save is the single entry point for "fully filled via form".
4. **WHOOP cron timing.** Cron fires at 08:00 UTC = 16:00 in Asia/Singapore (Vercel deployed region). For users in Western timezones where 08:00 UTC is mid-day, the cron-driven sync would arrive after the user's morning. The "Sync WHOOP now" chip handles this; it works at any time of day.
5. **WHOOP recovery still pending.** WHOOP scores recovery 30 min after sleep ends, so the row may exist with `recovery: null`. Sync route counts these as `recovery_pending`. The recommendation route treats `recovery is null` as "not ready" same as no row, and the chat shows:
   > *"WHOOP says recovery isn't scored yet — usually within 30 min of waking. I'll deliver the plan once it lands."*
   ChatPanel polls `useDailyLogs` every 5 min while panel is open and `intake_state='awaiting_whoop'`, plus on focus.
6. **User accidentally taps "I'm coming down with something" while healthy.** No undo button by design (intentional friction — sickness is supposed to be a deliberate flag). They can correct via the `/log` form: clear `sick`, save → flips back. Mention this in the success message: *"I'll check in tomorrow. (To undo, edit on the Log page.)"*
7. **Two chat tabs open.** Server is single source of truth; second tab's chip taps will be rejected as out-of-state-machine (e.g. POST a slot that's already filled returns 409). ChatPanel handles 409 by refetching the message thread and re-rendering — natural reconciliation.
8. **Recommendation Claude call fails.** Server marks `intake_state='delivered'` only on successful stream completion. On failure, state stays `awaiting_whoop`/`awaiting_feel` and a fallback assistant turn says *"Recommendation failed — tap to retry."* Retry chip POSTs `/api/chat/morning/recommendation` again.

## Build sequence

Recommended cut points so the work can be merged incrementally:

1. **Migration + types + readiness math.** Migration `0007_morning_intake.sql` applied. `Checkin` and `FeelInput` extended. `getIntensityMode` rewritten. `LogForm` updated with the new fields so the data model is fully usable manually before any chat work. Verify with `npm run typecheck`.
2. **`lib/morning/script.ts` + `lib/morning/state.ts`.** Pure functions, fully unit-testable in isolation (no project test infra exists; use a one-off local Node script if needed for now).
3. **Server endpoints.** `/api/chat/morning/intake` and `/api/chat/morning/recommendation`. Test with curl / a temporary debug page.
4. **ChatPanel mode + chips.** Extend ChatPanel with `mode` prop and chip rendering. Mode tab switcher.
5. **MorningTrigger + TopNav wiring.** Hook up auto-open. End-to-end testable.
6. **Sickness entry/exit flows.** "I'm coming down with something" link, "still sick?" carry-forward.
7. **Polish.** Skip-WHOOP fallback path, recommendation retry, copy refinement.

Each step is independently mergeable behind feature use (no flag needed since this is single-user and the trigger is gated by `decideIntakeAction` returning `skip` until there's data shape to respond to).

## Open questions / future work (not in this spec)

- **Push notifications** — would let the bot fire even when the app isn't open. Out of scope; PWA push setup is a separate project.
- **Sickness duration analytics** — a `sickness_episodes` view derived from consecutive `sick=true` rows would be nice for retrospectives. Add later if useful.
- **Voice input for the free-text tail** — could make the morning even friction-lighter on phone. Out of scope.
- **Coach-personality customization** — the morning recommendation prompt is currently hard-coded in [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) style. If user wants different morning tone vs. free-form coach tone, add a second prompt slot in `profiles`.
