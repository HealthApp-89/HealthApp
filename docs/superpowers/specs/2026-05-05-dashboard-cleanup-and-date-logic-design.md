# Dashboard cleanup + airtight date logic — design

**Status:** approved (spec)
**Date:** 2026-05-05
**Owner:** Abdelouahed

## Summary

Two coordinated changes in one design.

**A. Dashboard cleanup.** The dashboard's bundled `MorningCheckIn` block (today's session plan card + check-in form) is removed. The session plan card moves to a new **"Today"** sub-tab on `/strength`, with the exercise-list cap dropped (show all planned exercises). The check-in form lives only in `/log`, where it already exists. Saved check-ins continue to feed the dashboard readiness score via the existing `daily_logs` round-trip — no data-flow change.

**B. Airtight date logic.** A new `lib/time.ts` becomes the single source of truth for "today" / "now" in the user's timezone (`Asia/Dubai`, configurable via `USER_TIMEZONE` env var). Every server-side date computation routes through it. The chat coach / insights prompt gains an unambiguous date anchor block and per-row relative labels (`today`, `yesterday`, `Mon (3d ago)`).

The two changes ship together because the new `/strength?view=today` tab depends on `getTodaySession()`, which is one of the functions being fixed.

## Decisions

| # | Decision | Notes |
|---|---|---|
| 1 | Remove `MorningCheckIn` from dashboard | Form already duplicated in `/log`; bundled card is the source of "unnecessary space" |
| 2 | Move session plan card to `/strength?view=today` | Read-only and weekday-driven — fits strength training context |
| 3 | New "Today" sub-tab in `StrengthNav` | Mirrors existing `recent` / `date` views |
| 4 | Drop `slice(0, 6)` exercise cap on relocated card | More space available; show full session |
| 5 | Skip "log this session" CTA | No manual strength logger exists; Strong CSV ingest is the entry point |
| 6 | Timezone via env var `USER_TIMEZONE`, default `Asia/Dubai` | Single-user app; no migration; trivially changeable |
| 7 | Medium-scope sweep | Replace every server-side `today` computation; defer integration-by-integration date audit |
| 8 | Date anchor in LLM prompts | One-line `NOW: …` header + per-row relative labels |
| 9 | Plain-text date format in prompt | Cache-friendly; no structured JSON |
| 10 | Server is the only timezone authority | No client-sent tz; no `Intl` calls in browser for "today" |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  lib/time.ts  ←  USER_TIMEZONE env var (default Asia/Dubai) │
│  • todayInUserTz()       → "2026-05-05"                     │
│  • weekdayInUserTz()     → "Tuesday"                        │
│  • localTimeInUserTz()   → "14:32"                          │
│  • nowInUserTz()         → { date, weekday, time, tz,       │
│                              utcOffset }                    │
│  • relativeDateLabel()   → "today" | "yesterday" | "Mon…"   │
│  • formatHeaderDate()    → "Tuesday, May 5"                 │
└──────────────┬──────────────────────────────────────────────┘
               │
   ┌───────────┼─────────────────────────────────┐
   ▼           ▼                                 ▼
 Pages      Coach helpers                    LLM prompts
 app/page   getTodaySession()                snapshot.ts
 app/coach  reviewWindow()                   insights route
 app/log    recommendationWeekStart()        (chat coach)
 app/strength
 (incl. new ?view=today tab)
```

All current `new Date().toISOString().slice(0, 10)` and `new Date().toLocaleDateString("en-US", {weekday: "long"})` server-side calls funnel through `lib/time.ts`. UI helpers in `lib/ui/period.ts` and `lib/ui/score.ts` keep their UTC math (parked for the wide-scope audit).

## `lib/time.ts` — the single source of truth

Pure module, server-safe, no React. Implementation uses platform `Intl.DateTimeFormat` with `timeZone: USER_TZ` — no Luxon / no date-fns-tz.

```ts
// lib/time.ts
const USER_TZ = process.env.USER_TIMEZONE || "Asia/Dubai";
export const USER_TIMEZONE = USER_TZ;

export function todayInUserTz(now: Date = new Date()): string;       // "YYYY-MM-DD"
export function weekdayInUserTz(now: Date = new Date()): string;     // "Monday"
export function localTimeInUserTz(now: Date = new Date()): string;   // "HH:mm" 24h

export function nowInUserTz(now: Date = new Date()): {
  date: string;        // "2026-05-05"
  weekday: string;     // "Tuesday"
  time: string;        // "14:32"
  tz: string;          // "Asia/Dubai"
  utcOffset: string;   // "+04:00"
};

export function relativeDateLabel(
  ymd: string,
  today: string = todayInUserTz(),
): string; // "today" | "yesterday" | "Mon (3d ago)" | "Wed (in 2d)"

/** "Tuesday, May 5" — for the dashboard Header. tz-aware via Intl. */
export function formatHeaderDate(now: Date = new Date()): string;
```

**Why not store in `profiles`?** Single-user app. An env var is changeable from the Vercel dashboard without a code change or migration. If the app ever grows multi-user, this becomes a `profiles.timezone` column with the env var as a default — minor refactor, not a rewrite.

**Why not detect from the browser?** The server renders dashboard data, gates auth, and builds LLM prompts. Two clocks invite drift. Server-side env var is the only authority.

## Sweep map (Medium scope)

The complete diff surface for the date sweep.

**Replace `new Date().toISOString().slice(0, 10)` → `todayInUserTz()`:**

- `app/api/insights/route.ts:45` — daily insights cache key
- `app/api/insights/strength/route.ts:108` — strength insights cache key
- `app/page.tsx` — `today`, `isToday`, date-pager bounds, `dateLabel(...)`
- `app/coach/page.tsx` — today's coach payload selection
- `app/log/page.tsx` — `resolveDate()` default
- `app/strength/page.tsx` — `todayIso`, default for new "Today" sub-tab

**Replace `new Date().toLocaleDateString("en-US", {weekday: "long"})` → `weekdayInUserTz()`:**

- `lib/coach/sessionPlans.ts:65` — `getTodaySession()`. Internal call swaps to `weekdayInUserTz()`; signature unchanged (no caller passes a date today; YAGNI).

**Replace `new Date().toLocaleDateString("en-US", {...month, day...})` with a tz-aware formatter:**

- `components/layout/Header.tsx:15` — server-rendered weekday + month + day string. Add a `formatHeaderDate(now?)` helper to `lib/time.ts` that uses `Intl.DateTimeFormat(..., { timeZone: USER_TZ, weekday: "long", month: "long", day: "numeric" })`. Without this, the header reads "Sunday" while the rest of the app reads "Monday" for ~4hrs nightly.

**Caller update for helpers that already accept a `today` param:**

- `lib/coach/week.ts:28` — callers of `reviewWindow(today)` must pass a `Date` derived from `todayInUserTz()` rather than `new Date()`. Internal UTC math inside `week.ts` stays — once the input date is correct, the Mon→Sun computation is correct.
- `lib/coach/week.ts:64` — same for `recommendationWeekStart(today)`.
- `app/api/insights/weekly/route.ts:57-58` — currently calls `reviewWindow()` and `recommendationWeekStart()` with no args (falls through to `new Date()`). Pass a tz-anchored Date from `todayInUserTz()`.
- `app/coach/page.tsx:156,214` — same pattern; pass tz-anchored Date.

**Explicitly NOT touched (preserve current behavior):**

- `lib/ui/period.ts` — UI range pickers (last 7d / MTD / YTD). Currently UTC-based. Switching would shift trend windows by a few hours and risk ISR cache surprises. Defer.
- `lib/ui/score.ts:156-164` — sparkline weekday labels. UTC-keyed, but `daily_logs.date` rows are stored as YYYY-MM-DD strings; the labels are derived from those strings, not from `Date.now()`, so they align with whatever date the integration wrote.

**Known but deferred — separate follow-up spec required:**

- **WHOOP UTC-keying bug.** `app/api/whoop/sync/route.ts:81,91,102,109` keys recovery / cycle / sleep rows on `s.end.slice(0, 10)` / `c.start.slice(0, 10)`, slicing UTC ISO timestamps. For Dubai users a sleep ending 02:30 local (= 22:30 UTC previous day) lands on the wrong `daily_logs.date`. This is an active bug, not "deferred audit." Fixing it requires deciding the date-keying rule (sleep wake-day in user-tz?) and a backfill plan. **Out of scope for this design** — tracked as follow-up: `2026-05-XX-whoop-date-keying-audit`.
- Withings / Apple Health webhook / Yazio / Strong: dates are user-supplied or come from integrations that already key by user-local date. Spot-verified Apple Health (`app/api/ingest/health/route.ts:110` trusts client-supplied `d.date` which the iOS Shortcut formats as local). Other integrations to be confirmed in the same follow-up audit.

## Chat coach / insights prompt anchor

The actual fix for the model's day-of-week confusion. Two changes to the snapshot text and one line in the system prompt.

**Anchor block — prepended to every snapshot:**

```
NOW: 2026-05-05 (Tuesday) 14:32 Asia/Dubai (UTC+04:00)
```

Built from `nowInUserTz()`.

**Prompt-cache placement (important).** Today's insights routes mark only the `system` block with `cache_control` and put the snapshot in the `user` message — so a `HH:mm` field changing per turn costs nothing on cache. The chat-coach plan, however, intends to cache the snapshot in a system block. Rule for both surfaces:

- **The `NOW:` line lives in the *uncached, per-turn* portion of the prompt** (currently `messages[0].content`'s user message). It must NOT sit inside any `cache_control: { type: "ephemeral" }` block, because the `HH:mm` would invalidate the cached prefix every turn and defeat the 5-minute TTL.
- The snapshot body (last-14-day rows + recent workouts) — if cached — keeps its byte-stability and changes only when the underlying daily/workout data changes. Per-row relative labels (below) are byte-stable until the user-tz date rolls over, which is fine.

When chat-coach lands, the implementation must split: cached system block = profile + 14d logs + recent workouts (with relative labels); uncached user prefix = `NOW:` line + the user's actual question.

**Per-row relative labels — applied to daily logs and recent workouts:**

Before:
```
  2026-05-04 | hrv 52 | rhr 58 | recov 71 | …
```

After:
```
  2026-05-04 (Mon, yesterday) | hrv 52 | rhr 58 | recov 71 | …
  2026-05-05 (Tue, today)     | hrv 48 | rhr 60 | recov 64 | …
```

Built via `relativeDateLabel(ymd, todayInUserTz())`. Absolute date stays in front; relative label trails it. Same treatment for the `RECENT WORKOUTS` block — disambiguates "Monday's workout" (just-completed) from "Monday two weeks ago".

**System-prompt addition:**

> When the user references a day (e.g. "Monday"), interpret it relative to NOW above. "Monday" without other qualifiers means the most recent Monday on or before today. If ambiguous, ask.

The last sentence is the safety valve: a Monday "my Monday workout" question can be disambiguated rather than answered confidently-wrong.

## Dashboard cleanup — concrete changes

**`app/page.tsx`:**
- Remove the `import { MorningCheckIn } from "@/components/dashboard/MorningCheckIn"`.
- Remove the `{isToday && <MorningCheckIn … />}` block (lines ~231–247 today).
- `today` becomes `todayInUserTz()`.
- Verify `dailyPlan = buildDailyPlan(...)` is still computed (the readiness/score chain consumes it). It's still needed for `impact` — keep.

**`components/dashboard/MorningCheckIn.tsx`:**
- File becomes unused. Delete it. The session-plan-card visuals that lived inside this file are reimplemented in the new strength sub-tab component (see below) — no shared extraction needed; the markup is small.

**Result.** Dashboard renders date pager → impact donut → trends/rollups. No form, no plan card. Cleaner first paint, smaller bundle on the home route.

## Strength "Today" sub-tab — concrete changes

**`components/strength/StrengthNav.tsx`:**
- Add `{ id: "today", label: "Today" }` to `VIEWS`. Place it first (before `recent`), since it's the default landing view conceptually.
- `href` rule: `today` → `/strength?view=today`. Mirror existing pattern.

**`app/strength/page.tsx`:**
- Accept `view=today` from the search params.
- When `activeView === "today"`, render a new server component `<TodayPlanCard />` instead of `SessionTable` rows.
- All other views unchanged.

**New component `components/strength/TodayPlanCard.tsx`:**
- Props: `plan: DailyPlan` (built server-side via `buildDailyPlan(...)` from `lib/coach/readiness`).
- Renders the same visual as today's `MorningCheckIn`'s top half: gradient card, mode label, mode color, session-type heading, mode description, exercise list.
- **Drop the `slice(0, 6)` cap** — render all `plan.exercises`.
- No form, no save button, no CTA. Pure read-only.

**`app/strength/page.tsx` data fetch:**
- For `view=today`, fetch the same inputs `app/page.tsx` uses for `buildDailyPlan` (today's `daily_logs` row, `whoop_baselines.hrv`, current check-in if any). Reuse the existing helpers; no new query patterns.

## Build sequence

Three slices; safe to ship in any order, but recommended order for minimal merge friction:

**Slice 1 — `lib/time.ts` + Medium sweep.**
- Create `lib/time.ts` with the API above.
- Run replacements per the Sweep map. Update `getTodaySession()` signature.
- Verify: `npm run typecheck`, `npm run lint`.
- Manual: temporarily set `USER_TIMEZONE=America/Los_Angeles` locally to force a 12h gap with UTC and confirm dashboard / strength / coach all show the correct local "today".

**Slice 2 — Dashboard cleanup + strength "Today" sub-tab.**
- Add `today` to `StrengthNav`.
- Build `TodayPlanCard`.
- Wire `app/strength/page.tsx` for `view=today`.
- Remove `MorningCheckIn` from `app/page.tsx`; delete `components/dashboard/MorningCheckIn.tsx`.
- Manual checks: `/` is leaner; `/log` save still updates score; `/strength?view=today` renders the plan card with all exercises.

**Slice 3 — Prompt anchor.**
- Extract a shared `lib/coach/snapshot.ts` from the duplicated inline snapshot logic across **both** insights routes: `app/api/insights/route.ts` (lines ~75–88) and `app/api/insights/weekly/route.ts` (similar template-literal `userPrompt`). Same snapshot shape recurs in each. (This also de-risks the future chat-coach implementation, which already plans this module.)
- Snapshot body (system-cacheable portion): per-row relative labels via `relativeDateLabel()` for daily logs and recent workouts.
- Per-turn user prefix (uncached): `NOW:` line via `nowInUserTz()`.
- System-prompt addition (the "interpret day references relative to NOW" sentence) to both insights endpoints.
- When chat-coach ships, it inherits the same `snapshot.ts` automatically and follows the same cached-vs-per-turn split.
- Manual: regenerate `/coach` insights and confirm the cached payload shape unchanged. Spot-check that `NOW:` and relative labels render in the prompt by logging the snapshot text once.

## Risks acknowledged (deliberately accepted)

- **Date-pager bound shift.** `app/page.tsx`'s pager clamps `selectedDate <= today`. After Slice 1, `today` advances 4hrs earlier than UTC midnight. A `?date=2026-05-06` URL hit at 20:01 UTC May 5 (= 00:01 Dubai May 6) is rejected today and accepted after — desired behavior, but worth noting.
- **ISR `revalidate = 60`.** `app/page.tsx`, `app/coach/page.tsx`, `app/trends/page.tsx`, `app/strength/page.tsx`, `app/profile/page.tsx` all set `export const revalidate = 60`. ISR cache key is the URL; a render produced before the user-tz day boundary (04:00 UTC for Dubai) can serve stale "today" content for up to 60s into the new local day. Acceptable given the cadence; documented so it's not a future surprise.
- **`USER_TIMEZONE` silent default.** If the env var is missing in production, the app silently falls back to `Asia/Dubai`. For this single-user app that's the correct default, but no error surfaces if the var goes missing. Mitigation: `lib/time.ts` logs the resolved `USER_TIMEZONE` once at first call (`console.log("[time] USER_TIMEZONE=...")`); a follow-up enhancement can surface it on `/profile`.

## Verification (no test suite per CLAUDE.md)

- `npm run typecheck` — clean
- `npm run lint` — clean
- Dashboard `/` renders without `MorningCheckIn`; readiness donut intact
- `/log` save round-trip still updates dashboard score
- `/strength?view=today` renders relocated card with all planned exercises
- `/coach` insights regenerate; snapshot text contains `NOW:` and `(today)` / `(yesterday)` labels
- Force-tz dev check: `USER_TIMEZONE=America/Los_Angeles npm run dev` shows local "today" matches the override, not UTC

## Out of scope (parked)

- Multi-timezone / travel mode
- `profiles.timezone` migration (would supersede the env var if multi-user becomes real)
- **WHOOP date-keying audit / fix** — known active bug; tracked as a separate follow-up spec because it requires a date-keying-rule decision and a backfill plan (touches existing `daily_logs` rows). See Sweep map "Known but deferred".
- Wide-scope per-integration audit (Withings / Apple Health / Yazio / Strong) — same follow-up spec
- "Log this session" CTA on the new strength tab (would require a manual strength logger — separate brainstorm)
- Automated tests around `lib/time.ts`
- Migration of UI helpers in `lib/ui/period.ts` and `lib/ui/score.ts` from UTC to user-tz math
