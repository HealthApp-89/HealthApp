# Coach mini-apps app restructure — design

**Date:** 2026-05-20
**Status:** Draft
**Supersedes app shape established by:** [2026-05-19 multi-coach team](2026-05-19-multi-coach-team-design.md) (the four coach voices stay; their delivery surface changes)

## Motivation

Today's app concentrates all coach interaction in a single `/coach` tab while the four specialist voices (Peter, Carter, Nora, Remi) share one chat thread and route between each other via `delegate_to_specialist`. The user wants each specialist to feel like its own mini-app — Carter on a Strength page, Nora on a Diet page, Remi on a Health page — with Peter elevated to a cross-cutting Metrics surface that synthesizes across the three.

The restructure is also an opportunity to retire architectural debt:

- Auto-routing UX (shipped on `feat/coach-team-auto-routing`) becomes obsolete once the user picks the coach by tab.
- `delegate_to_specialist` and the handoff SSE event flow disappear because there is no longer a single conversation that needs to switch voices.
- `/metrics`'s 4-way sub-pill (Body / Log / Strength / Trends) is replaced by per-domain pages with clearer ownership.
- `/meal` collapses into Diet, where Nora narrates intake outcomes alongside the meal journal.

## Goals

- Six-tab bottom nav: Today, Strength, Diet, Health, Metrics, Profile.
- Each of the three specialist pages is a "mini-app" with two sub-tabs: **Coach** (data block + specialist chat) and **Log** (focused data-entry experience).
- Peter inhabits the Metrics page as the cross-cutting synthesizer — he pulls recent specialist context into his prompt.
- All existing surfaces (morning brief, weekly review, coach trends, proactive nudges, meal journal, morning intake) re-home onto the new structure with no functional regression.
- Migration is phased into ~6 PRs, each shippable on its own.

## Non-goals

- Manual workout logging UI to replace Strong CSV ingest. The Strength/Log tab ships as read-only history v1; the manual-entry surface is a deliberately deferred phase.
- Visual/aesthetic overhaul. This restructure is information-architecture only. Existing components are lifted into the new homes; the redesign work tracked in [2026-05-17-redesign-v3-design.md](2026-05-17-redesign-v3-design.md) and [project_redesign_v2_decisions](../../../.claude/projects/-Users-abdelouahedelbied-Health-app/memory/project_redesign_v2_decisions.md) layers on top later.
- Cross-coach DMs (Carter directly messaging Nora). Specialists are independent; Peter is the only one who sees across.

## Architecture

### Six-tab navigation

| Tab | URL | Sub-tabs |
|---|---|---|
| Today | `/` | — |
| Strength | `/strength` | `?tab=coach` (default) / `?tab=log` |
| Diet | `/diet` | `?tab=coach` (default) / `?tab=log` |
| Health | `/health` | `?tab=coach` (default) / `?tab=log` |
| Metrics | `/metrics` | — |
| Profile | `/profile` | — |

Sub-tab selection uses a `?tab=` query string read by the page-level Client Component, mirroring the current `?section=` pattern on `/coach/trends`. URL is the source of truth so deep-links and back-button work correctly.

[components/layout/BottomNav.tsx](../../../components/layout/BottomNav.tsx) becomes the only file that changes for the nav swap; the `TABS` array goes from 5 to 6 entries with updated `Icon` and `match` predicates.

### Page anatomy — Hybrid layout

Every specialist page uses the same skeleton on its Coach sub-tab:

- **Top: data block** — domain-specific headers (today's session for Strength, today's macros for Diet, today's recovery for Health) and a few headline metrics. Lifts existing components.
- **Bottom: persistent chat thread** with that page's coach. Composer pinned at the bottom of the chat block. SSE-streamed assistant turns just like the current `/coach` flow.

The Log sub-tab is a focused data-entry surface with no chat. Coach takes over when the user pops back. Per-coach unread/attention indicators appear as a small dot on the Coach pill when the specialist has unread proactive nudges; tapping the pill jumps to the chat and clears the indicator.

Metrics (Peter) does not have a Log tab. It is a single page with:

- **Data block top:** internal section pills (Performance / Composition / Cross) that scope the analysis below. Headline cards for plateaus, off-pace trends, HRV deviations. A "Weekly Review · Sunday" card linking to `/metrics/weeks/[week_start]`. Proactive nudges feed showing aggregate count + per-coach breakdown.
- **Chat block bottom:** Peter thread with context-injection from the three specialist threads.

### Chat data model

The current `chat_messages` table has a `speaker` column (`peter|carter|nora|remi|user`). Under the new model, every message also belongs to one of four threads. A new column `thread` makes this explicit.

**Migration `0025_per_coach_threads.sql`:**

```sql
alter table chat_messages
  add column thread text not null default 'peter';

alter table chat_messages
  add constraint chat_messages_thread_check
  check (thread in ('peter','carter','nora','remi'));

-- Backfill: assistant turns get their speaker's thread.
update chat_messages
   set thread = speaker
 where speaker in ('peter','carter','nora','remi');

-- User turns inherit the thread of the immediately following assistant turn,
-- or the immediately preceding one if there is none, or 'peter' as a final
-- fallback. This is a best-effort backfill — historical threads do not need
-- to be perfectly partitioned, only plausible enough for the per-thread
-- history view to feel coherent.
with user_turns as (
  select id, user_id, created_at
    from chat_messages
   where speaker = 'user'
),
next_assistant as (
  select u.id,
         (select cm.thread
            from chat_messages cm
           where cm.user_id = u.user_id
             and cm.speaker in ('peter','carter','nora','remi')
             and cm.created_at > u.created_at
           order by cm.created_at asc
           limit 1) as inferred_thread
    from user_turns u
)
update chat_messages cm
   set thread = coalesce(na.inferred_thread, 'peter')
  from next_assistant na
 where cm.id = na.id;

create index chat_messages_thread_idx
  on chat_messages (user_id, thread, created_at desc);

-- The existing chat_messages_visible_idx (added in 0024) filters out
-- system_routing rows; we keep it as-is. The new per-thread index is
-- additive — different read paths use different indexes.
```

`chat_messages.kind='system_routing'` rows (added by 0024 for routing audit) remain in the table as historical audit. No new ones get written under the new architecture.

### Chat stream changes

[lib/coach/chat-stream.ts](../../../lib/coach/chat-stream.ts):

- Accepts a new `thread: 'peter'|'carter'|'nora'|'remi'` parameter.
- The thread fixes the speaker — no router runs.
- History loaded for the SSE stream is filtered to the requested thread.
- For `thread='peter'`, the snapshot prefix gets a new **"Recent specialist activity"** block: the last 5 user-visible turns from each of Carter, Nora, Remi threads, each compressed to a short bullet (`"Carter (May 19): user reported bench felt heavy; Carter prescribed deload"`). This is the context-injection mechanism. Implementation lives in a new helper [lib/coach/peter-context.ts](../../../lib/coach/peter-context.ts) that fetches and summarizes; it is deterministic templating, not an LLM call.
- `delegate_to_specialist` tool removed from `PETER_TOOLS`.
- Handoff SSE event removed.

[lib/coach/router.ts](../../../lib/coach/router.ts) and [lib/coach/handoff-tool.ts](../../../lib/coach/handoff-tool.ts) are deleted (along with all references). The recently-shipped auto-routing in `ChatPanel` / `chat-stream.ts` is removed.

### Re-homing existing surfaces

| Surface | Current home | New home | Thread |
|---|---|---|---|
| Morning brief card | `/coach` (kind='morning_brief') | `/` (Today) | n/a — rendered as a chat-card-styled block on Today, not in any thread |
| Weekly review card | `/coach` (kind='weekly_review') | `/metrics` (in Peter thread or as a non-chat card) | Peter |
| Weekly review full page | `/coach/weeks/[week_start]` | `/metrics/weeks/[week_start]` | — |
| Reviews list | `/coach/reviews` | `/metrics/reviews` | — |
| Coach trends sections | `/coach/trends?section=...` | `/metrics?section=...` (section pills inside Peter's data block) | — |
| Mid-week review banner | `/coach` | `/metrics` | — |
| Proactive nudges | `/coach` (single thread) | Routed by trigger to specialist thread: plateau → Carter (Strength), off-pace weight → Nora (Diet), HRV → Remi (Health). Peter sees an aggregate count + per-coach breakdown on Metrics. | varies |
| Meal journal | `/meal` | `/diet?tab=log` | — |
| Body composition (weight, BF%, FFM, etc.) | `/metrics?sub=body` | `/diet?tab=coach` data block | — |
| Body measurements (circumferences) | `/metrics?sub=body` (linked to MeasurementForm) | `/diet?tab=coach` (link to MeasurementForm) | — |
| Morning intake flow | `/metrics?sub=log` | `/health?tab=log` | Remi (for any chat-rendered intake messages) |
| Strength today/session | `/metrics?sub=strength` | `/strength?tab=coach` data block | Carter |
| Strength history (workouts table view) | `/metrics?sub=strength` | `/strength?tab=log` (read-only v1) | — |
| Raw trends exploration | `/metrics?sub=trends` | Folded into `/metrics` Performance/Composition tabs | — |

**Redirects** (transient, removed in cleanup PR 6):

- `/coach`, `/coach/trends`, `/coach/reviews` → `/metrics`
- `/coach/weeks/[week_start]` → `/metrics/weeks/[week_start]`
- `/coach/progress` → `/metrics?section=performance`
- `/meal` → `/diet?tab=log`

### Proactive nudge routing

[lib/coach/proactive/](../../../lib/coach/proactive/) currently writes all nudge rows with implicit `speaker='peter'`. Update the writers:

- `check-plateau.ts` → `thread='carter'`, `speaker='carter'`
- `check-off-pace.ts` → `thread='nora'`, `speaker='nora'`
- `check-hrv.ts` → `thread='remi'`, `speaker='remi'`

Update [lib/coach/proactive/render-card.ts](../../../lib/coach/proactive/render-card.ts) prose to use the assigned coach's voice.

The aggregate badge on `/metrics` reads from a new helper `getActiveNudgeCounts(userId)` that returns `{ carter, nora, remi }` based on un-acknowledged nudge rows in each thread within a 7-day window.

### Specialist tool partitioning

Unchanged from the multi-coach team v1 design except for the removal of `delegate_to_specialist` from `PETER_TOOLS`. Each page's `chat-stream` call passes the page's coach as a fixed `speaker`/`thread`, and the existing intersection-with-mode logic in `chat-stream.ts` continues to gate tools per coach.

### User-editable Peter prompt

`profiles.system_prompt` continues to override Peter's base prompt only (it was always interpreted that way under the multi-coach team architecture). Specialists remain code-defined.

## Page-by-page details

### `/` — Today (unchanged)

No structural change. Morning brief card delivery moves here from `/coach` — it becomes a non-chat-thread block at the top of Today (it is a daily anchor, not a conversation). The existing post-intake morning-brief route [/api/chat/morning/recommendation](../../../app/api/chat/morning/recommendation/route.ts) keeps writing the same `chat_messages` row (`kind='morning_brief'`) and sets `thread='peter'` for schema consistency, but the rendering surface changes: a dedicated `MorningBriefCard` block on `/` reads the latest morning-brief row directly (filtered by `kind`, not by thread), so it stays decoupled from Peter's chat history on `/metrics`.

### `/strength` — Carter

**Coach sub-tab data block:**

- Today's session (lifts from `components/strength/TodayPlanCard.tsx`, including the session-structure annotations)
- Per-lift e1RM headline (latest, trend arrow)
- Mesocycle week badge ("Week 3 of 5")
- Adherence summary for the current week
- DaySwapSheet entry point (chip on the session card)

**Coach sub-tab chat block:**

- `ChatPanel` configured with `thread='carter'`, `speaker='carter'`
- Lifts the existing `ChatThread` rendering minus router/handoff hooks
- Composer pinned at the bottom

**Log sub-tab (v1, read-only):**

- Workout history table sourced from `workouts` table — date, type, exercise count, links to existing workout detail view
- Empty state: "Workout log coming soon — Strong CSV import still active. Tap Coach to plan your next session with Carter."

### `/diet` — Nora

**Coach sub-tab data block:**

- Today's macros vs targets (kcal, P, C, F, fiber) using existing `getTodayTargets`
- Per-meal-slot summary cards (Breakfast / Lunch / Dinner / Snack with logged kcal vs target slot)
- Body composition strip (weight, BF%, FFM trend)
- "+ Log a meal" CTA jumps to Log sub-tab
- GLP-1 status pill when active

**Coach sub-tab chat block:**

- `ChatPanel` configured with `thread='nora'`, `speaker='nora'`

**Log sub-tab:**

- Lifts `/meal` wholesale — `MealsClient`, `MealLoggerSheet`, `HistoryPickerSheet`, slot cards, copy-yesterday pill, library
- After commit, no auto-jump back to Coach (user stays in Log for the next meal); a small "Nora has a comment" dot appears on the Coach pill when a Nora-targeted proactive nudge or other unread assistant message exists on the `thread='nora'` thread
- `/meal` route is deleted in PR 4; redirect from `/meal` → `/diet?tab=log` lives in PR 2

### `/health` — Remi

**Coach sub-tab data block:**

- Today's recovery score (WHOOP-derived)
- HRV, RHR, sleep duration / efficiency, strain (yesterday)
- Morning feel summary (from latest `checkins` row): sick / fatigue / bloating / soreness
- Recovery trends mini-sparkline (7d HRV vs baseline)

**Coach sub-tab chat block:**

- `ChatPanel` configured with `thread='remi'`, `speaker='remi'`

**Log sub-tab:**

- Morning intake flow (existing state machine — `awaiting_response` → `assembling_brief` → `brief_delivered`)
- History of past intakes (list view of past `checkins` rows with editable open-question fields)
- Manual symptom log (free-text + tagged: sickness, injury, soreness)

### `/metrics` — Peter

Single page, no sub-tabs.

**Data block:**

- Section pills: Performance / Composition / Cross (URL `?section=`)
- Headline cards per section: plateaus, off-pace, HRV-below-baseline, deload-due, etc. — sourced from `lib/coach/trends/`
- "This week's review" card with state (draft / committed / overdue), deep-link to `/metrics/weeks/[week_start]`
- Proactive nudges feed: aggregate count + per-coach breakdown ("3 active: Carter 1, Nora 2, Remi 0") with deep-links to the specialist pages

**Chat block:**

- `ChatPanel` configured with `thread='peter'`, `speaker='peter'`
- Pre-prompt loads "Recent specialist activity" block via [lib/coach/peter-context.ts](../../../lib/coach/peter-context.ts)

Sub-routes:

- `/metrics/weeks/[week_start]` — full weekly review page (lifts from `/coach/weeks/[week_start]`)
- `/metrics/reviews` — reviews list (lifts from `/coach/reviews`)

### `/profile` — unchanged

No structural change. Existing sections (athlete profile, integrations, nutrition overrides, lab prompts) stay.

## Phasing (6 PRs)

Each PR is independently shippable. PR 1 lands the foundation without UI movement; PRs 2-6 swap one surface at a time so the user can validate each in isolation before deleting the old.

| PR | Title | Approx LOC | Key migrations / deletions |
|---|---|---|---|
| 1 | Chat foundation | ~600 | Migration 0025; retire `delegate_to_specialist`, `router.ts`, `handoff-tool.ts`; `chat-stream.ts` takes `thread`. Old `/coach` keeps working with `thread='peter'`. |
| 2 | Nav + scaffolding | ~400 | 6-tab nav swap; new route shells `/strength` `/diet` `/health` `/metrics` (placeholders); redirects from `/coach/*` and `/meal`. Old surfaces still functional behind redirects. |
| 3 | Strength page | ~700 | Coach + Log (read-only) for `/strength`. Re-homes session card, e1RM, mesocycle. |
| 4 | Diet page | ~900 | Coach + Log for `/diet`. Log absorbs full `/meal` experience. Delete `app/meal/` route folder. |
| 5 | Health page | ~700 | Coach + Log for `/health`. Re-homes recovery cluster, morning intake. |
| 6 | Metrics page + cleanup | ~800 | Peter's page complete (trends, weekly review, nudges, chat with context-injection). Delete `app/coach/` route folder, `app/metrics/_sub/`, `components/coach/CoachNav.tsx`, `components/coach/CoachSubNav.tsx`. |

Explicitly deferred to a later spec: manual workout logging UI replacing Strong CSV ingest (the Strength/Log v2 phase).

## Open questions

None blocking. All structural decisions are committed; implementation details (e.g., exact card styling, exact set of headline metrics on each data block) are left to the executing PRs to resolve in keeping with existing patterns.

## Testing

This codebase has no test suite. Per-PR validation:

- `npm run typecheck` (strict, mandatory)
- Manual exercise on `npm run dev` of the swapped pages — golden path (visit each tab, send a message in each chat, log a meal, complete a morning intake)
- Audit scripts where applicable: `scripts/audit-speaker-routing.mjs` is retired in PR 6 (the auto-router it audits no longer exists). No replacement audit is added; per-coach threads make speaker correctness trivially enforced by the schema (`chat_messages.thread` matches the page the user is on).
