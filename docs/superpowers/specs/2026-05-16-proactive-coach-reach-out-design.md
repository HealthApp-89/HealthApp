# Proactive Coach Reach-out — Design

**Date:** 2026-05-16
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #4 of the "coach-as-real-coach" arc — the final piece. Builds on Sub-project #1 (Weekly Review Document), Sub-project #2 (Daily Coach Loop), Sub-project #3 (Coach Tab UX shell + tool discovery), and Sub-project #5 (Trend Layer — shipped 2026-05-16). Consumes #5's strength/body/recovery signals directly.

## Problem

The coach surfaces today are all user-pulled. The user has to open `/coach` to see the morning brief, navigate to a week to see the weekly review, or scroll into `/coach/trends` to inspect plateau and recovery signals. If a plateau builds, a weight cut accelerates past the safe band, or HRV drops below baseline, the system already *knows* — Sub-project #5's `pickHeadline` selects the highest-priority concern on every call to `generateCoachTrends`. But nothing surfaces that concern until the user goes looking.

A real coach starts conversations. When the same lift sits flat for three weeks, the coach mentions it without being asked. When loss rate exceeds the LBM-protective band for a sustained stretch, the coach raises the flag. When HRV trends below the user's 30-day baseline, the coach asks what's going on.

This spec covers the chat-side proactive layer: a daily cron evaluates three deterministic triggers against Sub-project #5's compute outputs, and when a trigger fires, posts a structured `chat_messages` card (`kind='proactive_nudge'`) that the user sees on next `/coach` open. No push notifications (deferred). No HMAC action chips (deferred). Cards are informational with deep-links to the relevant `/coach/trends` section. Dedup is via a 7-day suppression window queried from `chat_messages` history — no new dedup table.

## Goals

1. **Three deterministic triggers fire chat cards once per 7 days per trigger key.** Each trigger reads raw signals from `generateCoachTrends({today})`, not the priority-ordered headline — so concurrent fires (plateau AND HRV below baseline) both surface as separate cards rather than collapsing into one.
2. **The cron is the only writer.** `/api/coach/proactive/check` runs daily at 11:00 UTC (1 hour after WHOOP's second sync at 10:00 UTC, so HRV/sleep/strain values are current). `CRON_SECRET`-gated. Idempotent: re-running the same day re-evaluates triggers but the 7-day dedup window prevents duplicate cards.
3. **Cards are deterministic.** No Anthropic calls. Each trigger renders via a pure template function. Headline ≤60 chars, body 1-2 sentences, one deep-link button. Templating matches the cross-insight prose pattern from Sub-project #5 (`compose-cross.ts`).
4. **Cards reuse the existing chat surface.** New `chat_messages.kind = 'proactive_nudge'`. The existing chat feed at `/coach` already sorts by `created_at` and dispatches by `kind` — only addition is a `ProactiveNudgeCard` renderer.
5. **Deep-link to existing surfaces, no new screens.** Plateau and HRV cards link to `/coach/trends?section=performance`. Off-pace cards link to `/coach/trends?section=composition`. The cards are the "the coach noticed" surface; the existing surfaces are where the user investigates.
6. **Sub-project #5's signals are the single source of truth.** No re-implementation of plateau detection or rate computation in this sub-project. The compute layer's `CoachTrendsPayload` is the input contract.

## Non-Goals

- **OS-level push notifications.** Service workers, VAPID keys, web-push subscriptions, iOS PWA permission flows — all deferred. The user discovers cards on next `/coach` open.
- **HMAC action chips on cards.** No "Apply rep-shift" chip that proposes a `training_weeks.session_plan` mutation. No "Cap deficit at 500 kcal" chip. Cards are deep-link-only for v1; if engagement is high, action chips become a v2 follow-on.
- **AI-authored card prose.** No `callClaude` in the proactive layer. All card text is template-rendered from structured event payloads.
- **"Weekly review ready" as a #4 trigger.** Already implemented by Sub-project #1's `/api/coach/weekly-review/sync` cron (writes `chat_messages.kind='weekly_review'` when a draft lands) + the mid-week banner on `/coach`. Re-doing it here would duplicate the surface.
- **Additional triggers beyond the three named.** Deficit drift, missed daily logs, GLP-1-specific check-ins, mood/sickness-driven nudges — all deferred. The three triggers in scope are the highest-signal ones from #5's headline picker; adding more requires running v1 first and learning what the user actually engages with.
- **A dedicated dedup table.** Trigger episode tracking via `chat_messages` history is sufficient — every fire creates an audit-trail row; dedup is a 7-day lookback query. No `coach_proactive_events` table.
- **Per-user configuration.** Single-user app; trigger thresholds live in code as named constants, not in a settings table. Re-tuning is a code change + redeploy.

## Phasing relation

| Sub-project | What it does | Status |
|---|---|---|
| Sub-project #1 — Weekly Review Document | Sunday recap-and-prescribe doc, mid-week banner | ✅ Shipped |
| Sub-project #2 — Daily Coach Loop | Morning brief post-intake | ✅ Shipped |
| Sub-project #3 — Coach Tab UX shell + tool discovery | Tools tab, glossary, sheet wiring | ✅ Shipped |
| Sub-project #5 — Trend Layer | `/coach/trends` + `lib/coach/trends/` compute + §4 retrofit | ✅ Shipped |
| **#4 Proactive reach-out (this spec)** | Daily cron writes chat cards when triggers fire | 📝 Designing |

This is the arc's closing piece. After #4 ships, every signal `lib/coach/trends/` exposes has a notification path: the user sees plateau, off-pace, and HRV alerts without going to look for them.

## Architecture overview

```
                       Vercel cron (11:00 UTC daily)
                                  │
                                  ▼
              ┌─────────────────────────────────────────┐
              │  app/api/coach/proactive/check/route.ts │
              │  - CRON_SECRET gate                     │
              │  - calls generateCoachTrends() once     │
              │  - dispatches to lib/coach/proactive/   │
              └────────────────────┬────────────────────┘
                                   │
                                   ▼
              ┌─────────────────────────────────────────┐
              │  lib/coach/proactive/  (new)            │
              │                                         │
              │  index.ts        (orchestrator)         │
              │  check-plateau.ts                       │
              │  check-off-pace.ts                      │
              │  check-hrv.ts                           │
              │  render-card.ts  (templates)            │
              └─────┬─────────────────────┬─────────────┘
                    │                     │
                    │ ProactiveEvent[]    │ template(event)
                    ▼                     ▼
              ┌──────────┐         ┌──────────────────┐
              │  dedup   │         │ ProactiveNudge   │
              │ (chat_   │         │     Card         │
              │ messages │         │  (ui jsonb)      │
              │  query)  │         └────────┬─────────┘
              └────┬─────┘                  │
                   │                        │
                   ▼                        ▼
              ┌─────────────────────────────────────────┐
              │ insert chat_messages row                │
              │   role='assistant'                      │
              │   kind='proactive_nudge'                │
              │   ui = ProactiveNudgeCard               │
              └─────────────────────────────────────────┘
                                   │
                                   ▼
              ┌─────────────────────────────────────────┐
              │  /coach chat feed                       │
              │  → components/coach/ChatPanel.tsx       │
              │  → case 'proactive_nudge':              │
              │      <ProactiveNudgeCard ... />         │
              └─────────────────────────────────────────┘
```

Single read path (`generateCoachTrends` from #5). Three independent trigger functions, each emitting 0..N events. Single write path through dedup → `chat_messages` insert. UI is one new renderer plugged into the existing kind-dispatch switch in the chat panel.

## Triggers

Each trigger function is a pure function that reads `CoachTrendsPayload` and returns `ProactiveEvent[]`. The orchestrator dedups and writes.

### Plateau (`check-plateau.ts`)

**Signal:** `payload.strength.per_lift[i].plateau_active === true`. Already derived in Sub-project #5 (`compose-strength.ts`) — 3+ consecutive non-deload weeks within 1.5% of each other.

**Output:** one `ProactiveEvent` per plateaued lift. If three big-four lifts are plateaued, three events emit.

**Trigger key:** `plateau:${lift_name}` — so each lift's plateau is deduped independently. Squat plateau and Decline Bench plateau fire as separate cards on the same day if both are active.

**Event payload:**
```ts
{
  lift: string,                 // "Decline Bench Press (Barbell)"
  e1rm_kg_now: number | null,
  plateau_weeks_flat: number,
}
```

**Card example:**
> **Decline Bench — 3 weeks flat**
> e1RM is stuck at 76 kg. The next weekly review will propose a rep-shift or deload — or break it sooner by switching to a heavier triple next session.
> [See full trends →]

### Off-pace weight (`check-off-pace.ts`)

**Signal:** `payload.body.weight.in_band === false && payload.body.weight.rate_kg_per_wk_4w != null`. The 4w rate is already a 4-week OLS smoothing — single-measurement noise doesn't flip the trigger.

**Output:** zero or one event. The event's `flavor` field distinguishes the two failure modes:
- `aggressive`: `rate_kg_per_wk_4w < target_band.lower` (e.g., −0.9 kg/wk → below −0.7 floor)
- `slow_or_gaining`: `rate_kg_per_wk_4w > target_band.upper` (e.g., +0.1 kg/wk → above −0.2 ceiling)

**Trigger key:** `off_pace_weight`.

**Event payload:**
```ts
{
  flavor: "aggressive" | "slow_or_gaining",
  rate_kg_per_wk_4w: number,
  target_band: { lower: number, upper: number },
}
```

**Card examples:**

*Aggressive:*
> **Weight dropping 0.9 kg/wk**
> Loss rate is below the target band of −0.7 to −0.2 kg/wk. Aggressive cuts risk LBM and strength loss — consider pulling the deficit back.
> [Check composition →]

*Slow / gaining:*
> **Weight only −0.1 kg/wk**
> Loss rate is above the target band. If a cut is the goal, the deficit needs deepening.
> [Check composition →]

### HRV below baseline (`check-hrv.ts`)

**Signal:** `payload.recovery.hrv.vs_baseline_pct_4w != null && payload.recovery.hrv.vs_baseline_pct_4w < -0.05`. Threshold mirrors the existing `pickHeadline` cutoff in `lib/coach/trends/index.ts` (−5% below 30-day baseline).

**Output:** zero or one event.

**Trigger key:** `hrv_below_baseline`.

**Event payload:**
```ts
{
  vs_baseline_pct_4w: number,    // negative; e.g., -0.083 = 8.3% below
  avg_4w: number,
  baseline_30d: number,
}
```

**Card example:**
> **HRV 8% below baseline**
> Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates.
> [Check recovery →]

## Dedup model

**Suppression window:** 7 days per trigger key.

**Mechanism:** before writing a card for a given `ProactiveEvent`, the orchestrator queries:
```sql
select id from chat_messages
where user_id = $user_id
  and kind = 'proactive_nudge'
  and ui->>'trigger_key' = $trigger_key
  and created_at > now() - interval '7 days'
limit 1;
```

If a row exists, skip the write. Otherwise insert.

**Consequence:** while a plateau persists, the user gets one reminder per week per plateaued lift (the plateau itself can last many weeks; the reminder cadence is bounded to weekly). When a plateau breaks (e.g., e1RM moves enough that `plateau_active` becomes false), no card is written that day; if a new plateau begins later, it fires again. Off-pace and HRV behave the same way against their respective trigger keys.

**Why no new table:** `chat_messages` is already the audit trail of every coach utterance. Adding a separate `coach_proactive_events` table would duplicate state and require sync logic. The dedup lookup is a single indexed query (we'll need to verify the `kind` + `created_at` index supports it — see "Open implementation details" below).

## Chat card schema

**Migration `0015_proactive_nudge.sql`:** drops and re-adds `chat_messages_kind_check` to include `'proactive_nudge'`, preserving all prior values. Pattern matches `0014_weekly_reviews.sql`.

```sql
alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check check (
    kind in ('coach','morning_intake','morning_brief','weekly_review','proactive_nudge')
  );
```

**Types (added to `lib/data/types.ts`):**

```ts
export type ProactiveTriggerType =
  | "plateau"
  | "off_pace_weight"
  | "hrv_below_baseline";

export type ProactiveEvent = {
  trigger_type: ProactiveTriggerType;
  trigger_key: string;
  payload: Record<string, unknown>;
};

export type ProactiveNudgeCard = {
  schema_version: 1;
  trigger_type: ProactiveTriggerType;
  trigger_key: string;
  severity: "warn";        // reserved as union for future "info" tier
  headline: string;        // ≤60 chars
  body_md: string;         // 1–2 sentences
  deep_link: { label: string; href: string };
};
```

The existing `chat_messages.kind` TypeScript union (currently `"coach" | "morning_intake" | "morning_brief" | "weekly_review"` per `lib/data/types.ts:87`) extends to include `"proactive_nudge"`.

## UI rendering

**Component:** `components/coach/cards/ProactiveNudgeCard.tsx`. Mirrors the visual pattern of the weekly-review chat card (`components/coach/WeeklyReviewCard.tsx` or equivalent — confirm exact path during planning).

Renders four blocks top-to-bottom:
1. Severity tag — small, warn-amber color, label "COACH" + severity uppercase
2. Headline — bold 14px, `COLOR.textStrong`
3. Body — 12px `COLOR.textMuted`, line-height 1.5
4. Deep-link button — accent-color text + arrow, tappable, navigates to the card's `deep_link.href`

**Dispatch wiring:** the existing kind-switch in `components/coach/ChatPanel.tsx` (the chat feed renderer) gains one case branch:

```tsx
case "proactive_nudge":
  return <ProactiveNudgeCard ui={message.ui as ProactiveNudgeCard} key={message.id} />;
```

If the dispatch lives in a sibling component or hook, the plan-writing phase resolves the exact insertion point.

## Cron registration

**Add to `vercel.json` `crons` array:**

```json
{
  "path": "/api/coach/proactive/check",
  "schedule": "0 11 * * *"
}
```

11:00 UTC daily. WHOOP's second sync is 10:00 UTC; 11:00 UTC ensures HRV / sleep / strain values for the prior day are finalized before the cron evaluates triggers.

**Route handler `app/api/coach/proactive/check/route.ts`:**
1. Validate `Authorization: Bearer ${CRON_SECRET}` header (existing pattern from `whoop/sync`, `weekly-review/sync`)
2. Service-role Supabase client (RLS bypass — cron writes on behalf of the user)
3. Resolve `userId` from the single profile row (single-user app convention used by the audit scripts)
4. Compute `today = todayInUserTz()`
5. Call `generateCoachTrends({ supabase, userId, today })`
6. Call orchestrator: `runProactiveChecks({ supabase, userId, today, trends })` → returns `{ fired: ProactiveEvent[], suppressed: ProactiveEvent[] }`
7. Return JSON summary `{ ok: true, fired: N, suppressed: M }`

## Audit script

**`scripts/audit-proactive-cron.mjs`** — read-only exercise script, mirrors `scripts/audit-coach-trends.mjs`.

Loads `.env.local`, picks the first profile, calls the orchestrator in dry-run mode (the orchestrator accepts a `dry_run: true` flag; when set, it returns the events but skips the `chat_messages` insert and skips the dedup lookup), prints which triggers would fire and the rendered card text.

Used during implementation to verify trigger logic against the live dev fixture before enabling the cron.

## File summary

**New files (9):**

| Path | Purpose |
|---|---|
| `supabase/migrations/0015_proactive_nudge.sql` | Extends `chat_messages_kind_check` |
| `lib/coach/proactive/check-plateau.ts` | Plateau trigger fn |
| `lib/coach/proactive/check-off-pace.ts` | Off-pace weight trigger fn |
| `lib/coach/proactive/check-hrv.ts` | HRV-below-baseline trigger fn |
| `lib/coach/proactive/render-card.ts` | Pure template renderers (one per trigger flavor) |
| `lib/coach/proactive/index.ts` | Orchestrator — dedup + write |
| `app/api/coach/proactive/check/route.ts` | Cron route |
| `components/coach/cards/ProactiveNudgeCard.tsx` | UI renderer |
| `scripts/audit-proactive-cron.mjs` | Dry-run exercise script |

**Modified files (4):**

| Path | Change |
|---|---|
| `lib/data/types.ts` | Add `ProactiveTriggerType`, `ProactiveEvent`, `ProactiveNudgeCard`; extend `chat_messages.kind` union |
| `vercel.json` | Add cron entry for `/api/coach/proactive/check` at 11:00 UTC daily |
| `components/coach/ChatPanel.tsx` (or equivalent dispatch site) | Add `'proactive_nudge'` case to the kind-switch |
| `CLAUDE.md` | Document the proactive layer in the Coach / AI architecture section |

## Open implementation details

These are not design forks — they're details the plan-writing phase resolves by inspecting the codebase:

- **Exact dispatch site for `kind` switch.** The plan-writing skill greps for the existing `case 'morning_brief':` to locate the right component.
- **Index support for the dedup query.** The lookup filters by `user_id`, `kind`, `created_at`. If query performance is poor on the dedup query at production scale, an index on `(user_id, kind, created_at)` may be needed — but volume is one user × ≤ a few rows per day, so this is unlikely.
- **Timezone in `todayInUserTz`.** Already used by Sub-project #2's morning brief and Sub-project #5's trends compute — same helper, same semantics.

## Success criteria

1. Audit script run against the dev fixture (Decline Bench plateau is active per Sub-project #5's testing) fires a plateau card. Off-pace and HRV cards may or may not fire depending on fixture state — the audit reports clearly.
2. Cron route invoked manually with `CRON_SECRET` writes the same set of cards into `chat_messages` (one row per fired trigger).
3. Re-running the cron the same day writes zero new cards (all triggers suppressed by 7-day window).
4. `/coach` chat feed renders the new `proactive_nudge` rows with the `ProactiveNudgeCard` component. Deep-links navigate to `/coach/trends?section=...`.
5. `npm run typecheck` exits 0 throughout.
6. Sub-project #5's existing audit script (`audit-coach-trends.mjs`) still runs cleanly — no regressions to the compute layer.
