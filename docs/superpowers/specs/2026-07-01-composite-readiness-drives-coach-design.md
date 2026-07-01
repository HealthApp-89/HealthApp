# Composite readiness drives the coach — design

**Date:** 2026-07-01
**Status:** Approved, pre-implementation

## Problem

Two different "readiness" numbers are shown to the user and they disagree:

- The **morning brief** card shows a headline "7 /10 · WATCH". This is the athlete's
  raw morning self-report (`checkins.readiness`), used as-is on a 1–10 scale.
- The **dashboard ring** shows "44 · POOR" — the composite `calcReadinessScore`
  (0–100) that weights WHOOP HRV / resting HR / sleep alongside the self-report.

The composite (the 44) is a **dead end**: it is computed in exactly one place,
`components/dashboard/TodayClient.tsx:122`, and is used only to render the ring. It
does **not** feed the brief headline, the readiness band/label, the coach-suggestion
chip, or the AI advice prompt. Those all key off the raw self-report via
`composeReadiness` / `deriveReadinessBand` in `lib/morning/brief/assembler.ts`.

Consequence: on a day with low HRV (62% of baseline), elevated RHR (73), and red
WHOOP recovery (23%), the athlete can still feel "7/10" and the coach green-lights
the day — defeating the purpose of collecting HRV/RHR data. The intended design was
a single composite readiness metric (WHOOP + morning feel, with a specific
weighting) that the coach acts on.

## Goal

One readiness number, recovery-dominant, that drives every surface: the dashboard
ring, the brief headline, the readiness band/label, the coach-suggestion chip, and
the AI advice prompt. The morning self-report becomes one weighted input, not the
headline.

## Decisions (locked with user)

1. **Re-tune the weighting** (not reuse the existing split as-is).
2. **Philosophy A — recovery-dominant with a red-recovery floor.** Recovery ~65% /
   Feel ~25% / Lifestyle ~10%. Feel can *lower* a day but never *rescue* a red body.
3. **Plan B fallback** when nutrition/steps aren't logged: the score must re-adjust
   and omit the missing signals cleanly (no penalty for not logging).

## Design

### 1. Re-tuned weights

`calcReadinessScore` remains the single readiness computation. New per-signal
weights (constants in `lib/ui/score.ts`):

| Signal | Weight | Bucket |
|---|---|---|
| HRV ratio (`hrv / hrvBaseline`) | 3 | Recovery |
| Resting HR | 3 | Recovery |
| Sleep score | 2 | Recovery |
| Deep sleep hours | 1 | Recovery |
| Morning feel (`checkin.readiness`) | 3.5 | Feel |
| Protein ratio | 0.5 | Lifestyle |
| Calories delta | 0.5 | Lifestyle |
| Carbs | 0.25 | Lifestyle |
| Steps | 0.25 | Lifestyle |

All-present split: Recovery 9/14 ≈ 64%, Feel 3.5/14 ≈ 25%, Lifestyle 1.5/14 ≈ 11%.

The per-signal **anchor curves** (`A_HRV_RATIO`, `A_RHR`, `A_SLEEP_SCORE`,
`A_DEEP_SLEEP`, `A_CHECKIN`, `A_PROTEIN_RATIO`, `A_CALORIES_DELTA`, `A_CARBS_G`,
`A_STEPS`) are unchanged — only the weights change.

### 2. Recovery sub-score

Alongside the composite, `deriveReadiness` computes a **recovery sub-score**: the
weighted mean of *only* the recovery-bucket signals (HRV, RHR, sleep score, deep
sleep) on the same 0–100 scale, renormalized over whichever recovery signals are
present. This is the input to the floor (§4) and is surfaced for display/debug.

### 3. Graceful fallback ("Plan B")

The weighted mean already divides only by the weight of *present* signals, so a
missing input drops out rather than scoring zero. Two rules formalize this:

- **Lifestyle is fully optional.** When protein / calories / carbs / steps are
  absent, the score renormalizes over recovery + feel only (~72% / ~28%). Not
  logging nutrition or steps never lowers readiness.
- **Recovery is required.** If no recovery signal (HRV, RHR, or sleep score) is
  present — e.g. an early-morning intake before the daily WHOOP sync — the composite
  returns `null`. The brief then shows a "readiness pending sync" state with a
  neutral band, rather than fabricating a readiness number from feel alone (which
  would contradict the recovery-dominant philosophy).

`MIN_WEIGHT_FOR_SCORE` stays as a floor against too-sparse data; the recovery-
required rule is additional.

### 4. Red-recovery floor

Band is derived from the composite, then capped by the recovery sub-score:

- Composite ≥ 67 → **GOOD** (high)
- 45–66 → **WATCH** (moderate)
- < 45 → **ACTION** (low)

Floor:

- recovery sub-score < 40 → band cannot be **GOOD** (cap at WATCH)
- recovery sub-score < 25 → cap at **ACTION**

Because feel carries only 25%, a perfect 10-feel on a red-recovery day cannot lift
the composite past ~40; the floor makes the cap deterministic. **Feel can lower a
day, never rescue a red body.**

Worked example (today's data): HRV ~62% of baseline, RHR 73, red recovery →
recovery sub-score ≈ 15 → capped **ACTION**, composite ≈ 44 displayed. Never 7/WATCH.

### 5. Single source of truth

Extract a shared function:

```
deriveReadiness(inputs) → { score: number | null, recoverySubScore: number | null, band, feel }
```

placed in `lib/ui/score.ts` (co-located with the existing `calcReadinessScore`,
which it supersedes/wraps). Both consumers call it:

- **Dashboard ring** — `components/dashboard/TodayClient.tsx` (replaces the direct
  `calcReadinessScore` call; band now comes from the shared fn).
- **Brief** — `composeReadiness` in `lib/morning/brief/assembler.ts` (replaces the
  `score = todayCheckin.readiness` line and the separate `deriveReadinessBand`).

The old feel-based `deriveReadinessBand` in `assembler.ts` is **deleted**. Its band
output was the drift source.

`pickCoachSuggestion` keeps its existing signature — it already takes a `band`
argument. It now receives the composite-derived band, so the low-readiness
coach-suggestion rule fires on physiology automatically, no signature change.

### 6. Wiring the AI advice prompt

The morning-brief advice prompt (`lib/morning/brief/flags.ts` context →
`advice-prompt.ts`) receives the composite score + recovery sub-score + band so the
generated advice grounds in the same number the card shows. No new AI call — same
single Haiku call, richer context.

### 7. Display — two numbers become one

- The **brief headline** shows the composite on the **same 0–100 scale as the ring**
  (identical number on both surfaces), with the self-report shown beneath as
  "You felt: 7/10".
- `MorningBriefReadiness` gains a `feel` field (the raw 1–10) so the renderer can
  show both. `score` now carries the composite (0–100) instead of the 1–10 feel.
- The dashboard ring is unchanged in shape; its number may shift slightly because
  the weights changed.

## Data model

No schema changes. Everything is derived at read time from existing columns
(`daily_logs`, `checkins`, `profiles.whoop_baselines`, targets). No migration.

## Deliberate cuts (YAGNI)

- No per-user weight tuning UI — weights are code constants.
- WHOOP's own `recovery %` field stays **out** of the formula (it is derived from
  HRV/RHR/sleep/resp-rate; including it would double-count). It remains a displayed
  metric only.
- No new DB columns; no persistence of the recovery sub-score.

## Files touched (anticipated)

- `lib/ui/score.ts` — re-tuned weights; new `deriveReadiness` returning
  `{ score, recoverySubScore, band, feel }`; band-derivation + floor logic.
- `components/dashboard/TodayClient.tsx` — consume `deriveReadiness`.
- `lib/morning/brief/assembler.ts` — rewrite `composeReadiness`; delete
  `deriveReadinessBand`.
- `lib/data/types.ts` — `MorningBriefReadiness` gains `feel`; `score` semantics
  change to 0–100.
- `components/morning/MorningBriefCard.tsx` (and any brief renderer) — headline
  shows composite + "You felt" sub-stat + pending-sync state.
- `lib/morning/brief/flags.ts` / `advice-prompt.ts` — thread composite + recovery
  sub-score into the advice context.

## Verification

- `npm run typecheck`.
- Add fixture assertions for `deriveReadiness`: today's red-recovery case caps at
  ACTION; a perfect-feel + red-recovery case still lands < 45; lifestyle-absent
  renormalizes to recovery+feel; recovery-absent returns null.
- Exercise `/` (dashboard ring) and the morning brief locally: confirm both show the
  same headline number and that a red-recovery day shows ACTION, not a high band.
