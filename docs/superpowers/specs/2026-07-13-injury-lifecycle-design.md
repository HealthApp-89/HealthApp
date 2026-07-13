# Injury Lifecycle — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm 2026-07-13)

## Problem

Injuries picked up mid-block are invisible to the coaching system. The live case:
a hip injury from padel (~2026-06-29) meant deadlift and last week's Legs session
were skipped — but the coaches never knew, adherence counted plain "missed"
sessions, and any deadlift stall would read as a plateau. The existing pieces
don't connect: `symptom_log_entries` is an append-only journal nothing reads;
the ATHLETE INTELLIGENCE Constraints block carries injuries **only from the
static onboarding profile** (`athlete_profile_documents.current_injuries`);
adherence day statuses are `as_planned | swapped | missed | rest` with no cause.

## Decisions locked during brainstorm

1. **Chat-first reporting** with a form fallback on `/health?tab=log`; no
   auto-detection from soreness check-ins in v1.
2. **Context + attribution, coach adjusts**: the injury shapes what coaches see,
   how adherence classifies, and how progress reads — but the prescription
   engine is untouched. Session changes remain Carter's conversational call via
   existing swap/lighten tools. Engine-level auto-exclusion is an explicit
   follow-up arc.
3. Retroactivity via backdatable `onset_date` — adherence and trends compute
   on-read, so no backfill machinery.

## Data model — migration 0052

```sql
create table if not exists injuries (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  area                   text not null,             -- "hip", "shoulder", free-form but short
  side                   text,                      -- "left" | "right" | null
  cause                  text,                      -- "padel", "deadlift top set", free-form
  severity               text not null default 'moderate',
  onset_date             date not null,             -- backdatable
  status                 text not null default 'active',
  resolved_at            timestamptz,
  affected_session_types text[] not null default '{}',  -- e.g. {Legs, Back}
  affected_lifts         text[] not null default '{}',  -- subset of {squat,bench,deadlift,ohp}
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint injuries_severity_check check (severity in ('mild','moderate','severe')),
  constraint injuries_status_check   check (status in ('active','resolved'))
);
-- RLS: owner select/insert/update (no delete — resolve, don't erase history).
```

TS mirror `Injury` in [lib/data/types.ts](lib/data/types.ts). `symptom_log_entries`
unchanged.

## Reporting

**Chat tools** (registered in PETER_TOOLS + CARTER_TOOLS + REMI_TOOLS;
fire-and-confirm, NOT propose/commit — low-risk athlete-initiated writes):

- `log_injury({area, side?, cause?, severity?, onset_date?, affected_session_types?, affected_lifts?, notes?})`
  — inserts an active injury; `onset_date` defaults to today; the model infers
  `affected_session_types`/`affected_lifts` from the conversation (e.g. hip →
  Legs + Back, deadlift + squat) and narrates them back for correction.
- `resolve_injury({injury_id? , area?})` — resolves by id, or by unique active
  area match; errors if ambiguous.
- Both: entries in `PERSIST_RESULT_TOOLS` (receipt chips must survive reload)
  AND explicit default-mode allows in `modeAllowsTool` (the documented
  silent-fail traps — see 2026-07-12 phantom block commit).
- Receipt chips via the existing `renderToolReceiptChip` path.

**Form fallback**: `ActiveInjuriesCard` on `/health?tab=log` next to the symptom
journal — active list (area, since-when, severity), add form, per-row Resolve.
API: `POST /api/injuries`, `PATCH /api/injuries/[id]` (resolve/edit). Session
auth → service-role writes, repo idiom.

## Consumers (the loop)

1. **Constraints block** ([lib/coach/intelligence/constraints-summary.ts](lib/coach/intelligence/constraints-summary.ts)):
   `composeConstraints` merges active `injuries` rows with profile
   `current_injuries` (dedup: a live row and a profile item with the same
   lowercased `area` collapse to the live row — it has fresher dates). Weeks-
   since-onset drives the existing acute (<4wk) / chronic mapping; `affected_lifts` flow into the exclusions set. All four
   coaches already read this block — no prompt changes required beyond a one-line
   note in the SCHEMA_EXPLAINER Constraints description that injuries may be
   live-reported.
2. **Adherence** ([lib/coach/adherence.ts](lib/coach/adherence.ts)): new day
   status `injury` — planned session type ∈ `affected_session_types`, no workout
   that day, injury active on that date (onset ≤ day ≤ resolved/∞). Weekly
   review recap renders excused ("skipped — hip injury") distinct from `missed`;
   `compute_adherence` tool output carries the status so coach prose
   distinguishes. Adherence PERCENTAGE treats injury days as excused
   (denominator excludes them) — the athlete shouldn't lose adherence score to
   an injury; the recap still lists them.
3. **Progress analysis** ([lib/coach/trends/](lib/coach/trends/)): per-lift
   slope/plateau insights annotate `injury_gated: true` when the lift ∈ an
   injury's `affected_lifts` and the injury overlaps ≥ half the analysis
   window. Deterministic templating renders "flat — injury-gated (hip since
   Jun 29)" instead of plateau prose. Proactive plateau nudge
   ([check-plateau.ts](lib/coach/proactive/check-plateau.ts)) suppresses for
   injury-gated lifts.
4. **Blocks monitor** ([lib/coach/blocks/summary.ts](lib/coach/blocks/summary.ts)):
   `secondaries[]` gains `injuryArea: string | null`; the staleness marker
   renders an injury chip (area label) instead of the plain amber days-ago when
   the lift is affected.
5. **Morning brief** ([lib/morning/brief/flags.ts](lib/morning/brief/flags.ts)):
   active injuries join the pre-computed flags so the Advice block can reference
   them ("hip still healing — keep hinge work off the menu until cleared").

## Out of scope (follow-up arcs)

- Engine-level exercise exclusion by body area (needs exercise→area mapping;
  interacts with rotation + manual-edit layers).
- Auto-detection from recurring `soreness_areas` check-ins.
- Injury history analytics / re-injury pattern detection.
- Push notifications.

## Testing

- Vitest: constraints merge (profile + live, dedup by area), adherence `injury`
  classification incl. onset/resolved boundary days and denominator exclusion,
  trends injury-gating window-overlap rule.
- Gates: `npm run typecheck`, `npx vitest run`, `npm run build` (the /health
  card is a client component).
- Manual seed after ship: log the live hip injury (area hip, cause padel,
  onset 2026-06-29, affected {Legs, Back} / {deadlift, squat}) via chat and
  verify: Constraints block shows it, weekly review re-reads last week's missed
  Legs/Back as injury-excused, deadlift staleness chip shows "hip".

## Delivery

Single PR on `feat/injury-lifecycle`.
