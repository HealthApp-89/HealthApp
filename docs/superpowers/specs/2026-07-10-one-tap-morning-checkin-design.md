# One-tap morning check-in — design

**Date:** 2026-07-10
**Branch:** `feat/one-tap-morning-checkin`
**Arc:** Reduce athlete burden (lane #1 of the post-adaptive-loop burden work)

## Problem

The morning intake bot costs ~7.6 chat replies every morning (max 10 in the last 60 days). The athlete has paid that tax 54/61 days — high adherence, high cost — and just logged his first 3-day gap (Jul 8–10), the leading indicator of abandonment. Measured facts driving this design (60-day window, 52 complete check-ins):

- Two of the eight questions feed **nothing**: `energy_label` and `mood` have zero downstream consumers (only the write path touches them).
- Only **19%** of mornings are textbook-normal (fatigue=none, no soreness, no bloating, not sick). The athlete's *modal* morning is `fatigue=some` (32/52); soreness is reported 42% of days.
- The free-text tail is force-answered every day; the answer is literally "All good" on most days. The rare real note (Jul 3 hip injury) was genuinely useful and was correctly extracted by the `update_intake_slots` tool.
- Load-bearing slots: `readiness` (feel component, ~25% of composite readiness), `fatigue` (autoregulation, patch-today, brief advice), `soreness_*` (morning auto-patch, DOMS autoregulation, recurring-soreness nudge), `sick` (gates the day), `bloating` (Nora GI context, light), `feel_notes` (brief advice context, light).

## Goal

Replace the 8-turn sequential chat with **one assistant turn carrying a check-in card**:

- Normal morning: **1 tap** ("✓ Same as usual").
- Off morning: **~3 taps** (expand Adjust, toggle deviating chips, submit).
- Delete the energy + mood questions. Keep the columns; the manual Log form (`/metrics?sub=log`) still writes them.
- Free-text becomes optional; the Remi tail-LLM call fires only when notes are non-empty.
- Nothing downstream loses signal: readiness feel component, patch-today, DOMS autoregulation, recurring-soreness nudge, Nora bloating context, brief assembly, recommendation auto-fire are all unchanged consumers.

"Same as usual" deliberately means the athlete's **personal baseline** (feel 7 · some fatigue), not textbook-perfect — that matches what he actually reports on a typical day and keeps the autoregulation engine calibrated to reality.

## Non-goals

- Reviving abandoned surfaces (food logging, weight, RIR fill, weekly-review reconfirm, body measurements). Those are separate burden lanes.
- Catch-up flow for fully missed days (no app open → no row; unchanged).
- Any change to the sick flows (`declare_sick`, still-sick check), the `awaiting_whoop` recheck/skip chips, the recommendation route, or brief assembly.
- Push notifications / reminders.

## Interaction flow

`MorningTrigger` and `decideIntakeAction` are unchanged. On `{kind:'start'}` for a healthy fresh day, instead of inserting the readiness question, the route inserts one assistant turn whose `ui` carries a new `morning_form` variant:

```
┌─ Remi ──────────────────────────────────┐
│ Morning. How are you today?             │
│                                         │
│ [ ✓ Same as usual                     ] │
│   (feel 7 · some fatigue · no soreness) │
│ [ Adjust → ]                            │
└─────────────────────────────────────────┘
      ↓ Adjust (expands inline, prefilled)
│ Feel      1…10  (7 selected)            │
│ Fatigue   (none)(●some)(heavy)          │
│ Soreness  [chest][back][legs][…]        │
│ Severity  (mild)(sharp)  ← if areas>0   │
│ Bloated   (●no)(yes)                    │
│ Sick      (●no)(yes)                    │
│ Notes     [optional____________]        │
│ [ Submit ]                              │
```

- **"Same as usual"** → POST `{kind:'all_good'}` → user reply "Same as usual" inserted → straight to `awaiting_whoop` → existing recovery-gate/brief flow.
- **Adjust → Submit** → POST `{kind:'batch', values, notes?}`. If `notes` non-empty, the existing `handleFeelTail` streaming path runs (Remi ack + `update_intake_slots` extraction); else straight to `awaiting_whoop`.
- **Sick=yes in the form** → same short-circuit semantics as today's `declare_sick`: with the notes field empty, state goes to `awaiting_sickness_notes` and the existing "what's going on?" prompt follows; with notes filled, they are written to `sickness_notes` (not `feel_notes`) and state goes straight to `delivered`.
- **Still-sick morning** (yesterday `sick=true`): the existing chip turn runs first; answering "No" now leads to the card instead of question 1.
- **Resume** (`awaiting_feel` mid-flow): the card is the latest assistant message in the thread; re-render is free. `awaiting_feel` now just means "card outstanding".

The card renders via a new `MorningCheckinCard` client component, dispatched from `ChatThread` the same way `ProactiveNudgeCard` is (keyed on the `ui.morning_form` shape). Defaults are embedded in the card's `ui` jsonb at creation time so what the athlete sees is exactly what gets written.

## Defaults engine

New pure module `lib/morning/defaults.ts`:

```ts
computeMorningDefaults(recentCheckins): { readiness: number; fatigue: FatigueLevel }
```

- Window: last 28 days of rows where `intake_source is distinct from 'all_good'` (explicit answers only — historical null rows count as explicit).
- `readiness` = median; `fatigue` = mode.
- Minimum 7 qualifying rows; below that, fallback `readiness=7`, `fatigue='some'` (his observed baseline; a generic fallback of `none` would systematically overstate freshness).
- Excluding one-tap days prevents the feedback loop where defaults feed the median that feeds the defaults.
- Soreness/bloating/sick are **always** none/false — the one-tap is the athlete explicitly asserting nothing hurts. No inference.

Server computes this in the `start` handler and embeds it in `ui.morning_form.defaults`.

## Server changes (`app/api/chat/morning/intake/route.ts`)

New body kinds:

- `{kind: 'all_good'}` — upserts `{readiness: defaults.readiness, fatigue: defaults.fatigue, soreness_areas: [], soreness_severity: null, bloating: false, sick: false, intake_source: 'all_good', intake_state: 'awaiting_whoop'}`; inserts user reply; runs the existing recovery-gate check (parked `SYNC_RECOVERY_PROMPT` turn when recovery is null). No LLM call. Re-reads the card's embedded defaults from the latest `morning_form` assistant turn — the write must match what was displayed, not a recomputation.
- `{kind: 'batch', values, notes?}` — Zod-validated (`readiness` 1–10 int, `fatigue` enum, `soreness_areas` ⊆ `SORENESS_AREAS`, `soreness_severity` enum required iff areas non-empty, `bloating`/`sick` boolean, `notes` string ≤ 2000 chars). Writes the row with `intake_source='form'`. Dispatch: `sick=true` → sick short-circuit; `notes` non-empty → a **non-streaming** Anthropic call (`runNotesAck`) inserts the Remi ack turn and applies `update_intake_slots` extraction, best-effort after the row is already committed; the response is JSON in all cases. (Amended 2026-07-10 during planning: with the forced tail gone, the morning SSE path had exactly one remaining consumer — a 1–2 sentence ack doesn't justify keeping a streaming protocol.)

Removed/retired:

- The sequential slot-answer branch shrinks to `still_sick` only.
- `SLOTS`, `SLOT_BY_KEY`, `chipsForSlot`, `mapSlotToColumn`, and `nextSlot()`'s question-walking role are retired. Slot validation lives in the batch Zod schema. `FREE_TEXT_TAIL_PROMPT` is retired (notes are a form field).
- `nextIntakeState` simplifies accordingly. `IntakeState` values themselves do not change — no migration to the state machine's vocabulary, and `decideIntakeAction` is untouched.

Kept verbatim: `handleDeclareSick`, `handleSicknessNotes`, still-sick chip handling (with its "No" branch now inserting the card), `handleFeelTail`, `UPDATE_INTAKE_SLOTS_TOOL`, recovery-gate + recommendation auto-fire.

## Data model

Migration **0050** (`supabase/migrations/0050_intake_source.sql`):

```sql
alter table checkins add column intake_source text
  check (intake_source is null or intake_source in ('legacy_chips','all_good','form'));
```

Nullable; no backfill. Historical rows stay null and qualify as explicit for the defaults window. `CheckinRow` in `lib/data/types.ts` gains `intake_source: 'legacy_chips' | 'all_good' | 'form' | null`. (`'legacy_chips'` is reserved for completeness/observability should any chip-era write path remain; the new writes use `'all_good'` / `'form'`.)

`MorningUI` in types gains the `morning_form` variant:

```ts
{ morning_form: { defaults: { readiness: number; fatigue: FatigueLevel } } }
```

## Client changes

- `MorningCheckinCard` (new, `components/morning/`): collapsed two-button state; inline expansion with prefilled chip rows; conditional severity row; optional notes input; posts `all_good`/`batch`; all submits are plain JSON posts. rendered from ChatPanel's bottom slot (both layout variants) where `ChatChips` renders today, interactive only while the card is the latest assistant message. (Amended 2026-07-10: the morning intake UI lives in the panel's bottom slot, not the thread.)
- `ChatPanel` bottom-slot dispatch for `ui.morning_form`.
- The old sequential chip flow's client pieces stay only insofar as `still_sick` and action chips (`recheck`/`skip_whoop`) need them.

## Testing & verification

- `lib/morning/__tests__/defaults.test.ts`: median/mode correctness, 28-day window, min-7-rows fallback, `all_good` exclusion, empty-history fallback.
- Update `lib/morning/__tests__/state` tests for the slimmer `nextIntakeState`.
- Batch Zod schema tests (severity-required-iff-areas, bounds).
- `npm run typecheck` + `npx vitest run` + `npm run build` (no render-test harness — hooks bugs only surface in prod build) + manual exercise of: fresh morning one-tap, adjust+submit with and without notes, sick-in-form, still-sick morning, resume mid-card, recovery-null parking.

## Expected outcome

The one check-in the athlete still pays daily drops from ~7.6 turns to 1–3 taps with zero loss of downstream signal. Adherence pressure (the Jul 8–10 gap) is relieved at the cost side rather than by degrading the adaptive loop that PRs #143/#144 just shipped.
