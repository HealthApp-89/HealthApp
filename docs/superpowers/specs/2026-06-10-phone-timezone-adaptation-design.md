# Phone-timezone adaptation — Design

**Date:** 2026-06-10
**Status:** Draft, pending implementation

## Problem

The app silently mixes UTC and user-local time in ~50 places. A baseline audit (sections cited inline below) found:

- **8 cron routes** computing `today = new Date().toISOString().slice(0, 10)` — UTC date strings used as primary keys for daily synthesis ([app/api/coach/dashboard/sync/route.ts:36](app/api/coach/dashboard/sync/route.ts), [app/api/coach/sunday-prescriptions/sync/route.ts:42](app/api/coach/sunday-prescriptions/sync/route.ts), [app/api/coach/eating-identity/sync/route.ts](app/api/coach/eating-identity/sync/route.ts), [app/api/coach/recipe-discovery/check/route.ts](app/api/coach/recipe-discovery/check/route.ts), [app/api/chat/nudge-dismiss/route.ts](app/api/chat/nudge-dismiss/route.ts), [app/api/chat/messages/route.ts](app/api/chat/messages/route.ts), [app/api/coach/dashboard/regenerate/route.ts](app/api/coach/dashboard/regenerate/route.ts), [app/api/training-weeks/[week_start]/swap/route.ts](app/api/training-weeks/[week_start]/swap/route.ts)).
- **~10 client components** computing local YYYY-MM-DD via `toISOString().slice(0, 10)` — JavaScript's `Date` is browser-local, but `toISOString()` always serializes UTC. At Dubai 00:30 on June 10, the client computes "today = June 9", sends to the server, and morning intake / food log entries land on yesterday's row.
- **`lib/time.ts` already has the right primitives** (`todayInUserTz`, `ymdInUserTz`, `partsInUserTz`) but they read from `process.env.USER_TIMEZONE` (hardcoded default `Asia/Dubai`). Per-user customization is impossible; changing zones requires a Vercel redeploy.
- **No `profiles.timezone` column** exists. WHOOP/Strava do per-record timezone work; Withings and local logging do not.
- **Week boundaries** in [lib/coach/week.ts](lib/coach/week.ts) are explicitly UTC-Monday-keyed; for Dubai users the local-Monday vs UTC-Monday boundary differs by 4 hours and produces the wrong week for late-Sunday-night writes.
- **`deriveMealSlot`** ([lib/food/meal-slot.ts:16](lib/food/meal-slot.ts)) calls `d.getHours()` — server-side that's UTC, so a meal logged via a server-driven path lands in a different slot than the client computed.

The visible symptom: dashboard, brief, and food logs occasionally key to the wrong date around local midnight and around travel events.

## Goal

A `profiles.timezone` column becomes the single source of truth for "what calendar day is it for this user." All consumers — cron, server routes, client components, week boundaries, meal-slot attribution — read from it via one helper.

The user-facing surface is:
- An **ambient header chip** that always answers "what timezone does the app think I'm in?"
- An **opt-in travel prompt** when the device reports a different zone than the profile.
- A **searchable picker on `/profile`** for manual override.

## Non-goals

- **Multi-user.** Single-user architecture stays. The column is per-user-shaped because that's how it's stored, not because we're onboarding others.
- **Per-record timezone for Withings/local logging.** WHOOP and Strava already do their own per-record TZ resolution; that stays. We do not retrofit per-record TZ to other ingest paths.
- **Automatic timezone changes mid-session.** The detection runs on mount and on hard refresh; we do not poll for TZ changes while the app is open.
- **Wearable per-record fallback rewrite.** The WHOOP travel-mode L2 (handling sleep records that fall outside any synced cycle) stays as documented in CLAUDE.md.
- **A test runner.** The repo has none; we add a manual audit script in the existing convention.

## Locked decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Source of truth | `profiles.timezone` column (DB), IANA string |
| Auto-detect behavior | Silent first-set on first sign-in, prompt on mismatch thereafter |
| Mismatch UX | Header chip + inline dashboard notice (NOT top banner, NOT toast) |
| Chip states | Neutral (match) / Orange (mismatch) / Orange-tint (stayed deliberately) |
| Manual picker | Searchable combobox + "Use device timezone" button |
| Cron "today" | Reads `profiles.timezone`, computes user-local calendar day |

## Data model

### Migration `0042_profile_timezone.sql`

```sql
alter table profiles
  add column timezone text not null default 'Asia/Dubai';

comment on column profiles.timezone is
  'IANA timezone (Intl.supportedValuesOf("timeZone")). Authoritative for all "today" / week-boundary / day-attribution logic. The USER_TIMEZONE env var is fallback-only for scripts.';
```

- Default `'Asia/Dubai'` covers the existing single-user row correctly. No backfill needed.
- No CHECK constraint — the IANA list evolves; app-side validation via `Intl.DateTimeFormat({ timeZone })` is the right gate.
- We do NOT add a separate `timezone_initialized_at` column. To distinguish "never set" from "deliberately stayed," we use `profiles.created_at`: if the row is <24h old AND the detected zone differs from stored, the first detection writes silently with no banner.

### `StravaTokensRow`-shaped types

Add `timezone: string` to the `Profile` shape in [lib/data/types.ts](lib/data/types.ts).

## Server-side seam

### `lib/time/get-user-tz.ts` — single accessor

```ts
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const cache = new Map<string, { tz: string; at: number }>();
const TTL_MS = 10_000;

export async function getUserTimezone(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;
  const sb = createSupabaseServiceRoleClient();
  const { data } = await sb.from("profiles").select("timezone").eq("user_id", userId).maybeSingle();
  const tz = data?.timezone ?? process.env.USER_TIMEZONE ?? "Asia/Dubai";
  cache.set(userId, { tz, at: Date.now() });
  return tz;
}
```

10s memory cache keyed by `userId`. Updates invalidate via a shared `invalidateUserTimezone(userId)` exported alongside, called by `POST /api/profile/timezone`.

### `lib/time.ts` — explicit `tz` parameters

Every existing helper grows an explicit `tz: string` parameter and stops reading the env var:

```ts
export function todayInUserTz(tz: string): string { ... }
export function ymdInUserTz(d: Date, tz: string): string { ... }
export function partsInUserTz(d: Date, tz: string): DateParts { ... }
```

The env var stays as a last-resort fallback inside `getUserTimezone()` only — useful for scripts that have no user context. Direct env-var reads inside `lib/time.ts` are removed.

### API route pattern

Each of the 8 cron routes adopts this prefix:

```ts
const userId = await resolveCronUserId();           // single-user app
const tz = await getUserTimezone(userId);
const todayLocal = todayInUserTz(tz);
```

Every downstream `new Date().toISOString().slice(0, 10)` in the route body is replaced with `todayLocal`. The shape of the edit is identical across all 8 routes — mechanical.

### Week boundaries

[lib/coach/week.ts](lib/coach/week.ts) callers (`reviewWindow`, `recommendationWeekStart`, `mondayOnOrBefore`, `currentWeekMonday`) grow a `tz` parameter. The "Monday-keyed week" semantic stays; the anchor day-of-week is computed in the user's zone instead of UTC. The CLAUDE.md note "training_weeks.week_start is Monday-keyed" remains accurate.

### Meal-slot attribution

[lib/food/meal-slot.ts](lib/food/meal-slot.ts) `deriveMealSlot(d: Date, tz: string)`:

```ts
const hour = Number(new Intl.DateTimeFormat("en-US", {
  hour: "numeric", hour12: false, timeZone: tz
}).format(d));
```

All existing callers updated. The function signature change forces every callsite to thread tz — no silent server-vs-client drift afterwards.

## Client-side seam

### `lib/query/hooks/useUserToday.ts`

```ts
export function useUserToday(): string {
  const { data: profile } = useProfile();   // existing hook, prefetched server-side
  return todayInUserTz(profile?.timezone ?? "Asia/Dubai");
}
```

Replaces ~10 inline `new Date().toISOString().slice(0, 10)` calls in client components ([BriefSessionList](components/morning/BriefSessionList.tsx), [TodayPlanCard](components/strength/TodayPlanCard.tsx), [LogForm](components/log/LogForm.tsx), [JournalLibraryStrip](components/diet/JournalLibraryStrip.tsx), [LabPromptCard](components/profile/LabPromptCard.tsx), the `TODAY_ISO()` helper at the top of `LogForm`).

### `useTimezoneSync()` — detection + first-set + mismatch state

A single hook consumed by `TopBar` (chip) and `TimezoneMismatchNotice` (dashboard notice) — both read the same state. Hook itself lives in the client `TopBar` component since it must run on every page; result is exposed via React context (`TimezoneSyncContext`) so the dashboard notice can subscribe without re-running the detection.

```ts
function useTimezoneSync(): TimezoneSyncState {
  const { data: profile } = useProfile();
  const [detected] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const stored = profile?.timezone;
  const createdAt = profile?.created_at;

  const isFirstSet = createdAt && Date.now() - new Date(createdAt).getTime() < 24 * 3600 * 1000;
  const mismatch = stored && detected && stored !== detected;
  const dismissedThisSession = sessionStorage.getItem(`tz-dismissed-${stored}`) === "1";

  return {
    detected, stored,
    state: !mismatch ? "match"
         : isFirstSet ? "first-set-silent"
         : dismissedThisSession ? "stayed"
         : "mismatch",
    accept: () => postTimezone(detected).then(invalidateProfile),
    dismiss: () => sessionStorage.setItem(`tz-dismissed-${stored}`, "1"),
  };
}
```

The state value drives both the chip and the notice — single source of truth.

### `TimezoneChip` — header pill (3 states)

[components/timezone/TimezoneChip.tsx](components/timezone/TimezoneChip.tsx):

| `state` | Render |
|---|---|
| `match` / `first-set-silent` | Muted neutral pill, e.g., `DXB`. Border `#2a2a2a`, color `#888`. |
| `mismatch` | Orange pill, e.g., `DXB → TYO?`. Border `rgba(251,146,60,0.3)`, color `#fb923c`. |
| `stayed` | Orange-tinted pill (lower opacity than mismatch), e.g., `DXB`. Border `rgba(251,146,60,0.2)`. |

Tap anywhere on the chip → routes to `/profile#timezone`. Pill text uses the IATA 3-letter code from a small map (`Asia/Dubai → DXB`, `Asia/Tokyo → TYO`, etc.); for IANA strings not in the map, fall back to the city portion (`Asia/Foo → FOO`).

Slotted into a new [components/layout/TopBar.tsx](components/layout/TopBar.tsx) — the app has no global top header today (only `BottomNav`), so the TopBar is introduced as part of this work. Minimal scope: a `position: sticky; top: 0` strip honoring the iOS safe-area inset, rendering only the chip on the right. Mounted in [app/layout.tsx](app/layout.tsx) above `<main>`. Body padding (currently set via `--nav-h` for the bottom inset) grows a `--topbar-h` counterpart in [app/globals.css](app/globals.css) to reserve the strip's height. The TopBar can grow to hold other ambient indicators (sync status, etc.) in future work but ships chip-only.

### `TimezoneMismatchNotice` — inline dashboard card

[components/timezone/TimezoneMismatchNotice.tsx](components/timezone/TimezoneMismatchNotice.tsx):

- Rendered conditionally at the top of `/` (dashboard) **only**. Not on other pages — the chip carries the ambient signal everywhere; the dashboard is where you act.
- Visible when `state === "mismatch"`. Hides on `accept()` or `dismiss()`.
- Two buttons: `Switch to <detected>` (calls `accept()`) and `Stay on <stored>` (calls `dismiss()`).
- Visual: orange left-border, `#161616` background, matches the chip's orange family.

### `TimezoneSection` — `/profile`

[components/profile/TimezoneSection.tsx](components/profile/TimezoneSection.tsx):

- Slot near the top of [ProfileClient.tsx](components/profile/ProfileClient.tsx), above athlete-profile sections. Keyed `id="timezone"` so the chip's deep link `/profile#timezone` scrolls to it.
- Two rows:
  1. **Current:** the stored zone (`Asia/Dubai`) with a small subtitle `Device reports Asia/Tokyo` if mismatch.
  2. **Picker:** searchable combobox of `Intl.supportedValuesOf("timeZone")` (~400 entries; type-ahead handles fine). To the right: "Use device timezone" button (one-click overwrite to detected).
- On change: POST `/api/profile/timezone` → invalidate `queryKeys.profile` → re-render. No additional confirmation.
- Combobox implementation: a thin custom one is fine (40-50 lines), or `cmdk` if already in the dependency tree. Decided at plan-writing time.

### `POST /api/profile/timezone`

[app/api/profile/timezone/route.ts](app/api/profile/timezone/route.ts):

```ts
// body: { timezone: string }
// validates via new Intl.DateTimeFormat("en-US", { timeZone: body.timezone })
// updates profiles.timezone for the authenticated user
// calls invalidateUserTimezone(userId) on the in-process cache
// returns 200 { ok: true } or 400 { error: "invalid_timezone" }
```

## Cron rollout

All 8 cron routes adopt the prefix pattern in **a single PR**. Reasons:

- Mechanical, identical edit shape — search/replace plus three new lines per route.
- Mixing fixed/unfixed routes creates a worse drift state than the current uniform-broken state. Half-fixed cron would compose user-local "today" in dashboard sync but UTC "today" in prescription sync, both consumed by the same downstream weekly review.
- The chip and notice are no-ops until the underlying data is right; rollout is gated on the full cleanup.

Route-specific notes:

- **[/api/coach/sunday-prescriptions/sync](app/api/coach/sunday-prescriptions/sync/route.ts)** — `next Monday` computation goes through `currentWeekMonday(tz) + 7d` instead of UTC math.
- **[/api/training-weeks/[week_start]/swap](app/api/training-weeks/[week_start]/swap/route.ts)** — the URL param `week_start` is a Monday-keyed date string; the route currently compares it to UTC "today" to decide if past-week swap is allowed. Comparison becomes `>= currentWeekMonday(tz)`.
- **[/api/chat/messages](app/api/chat/messages/route.ts)** — Peter dashboard fetch keyed by `(user_id, today)` becomes `(user_id, todayInUserTz(tz))`.

## Audit & guardrails

### `scripts/audit-timezone-usage.mjs`

Greps for forbidden patterns outside an allow-list:

```
new Date().toISOString().slice(0, 10)
\.toISOString\(\)\.slice\(0, 10\)
format\(new Date\(\), ['"]yyyy-MM-dd['"]\)
\.getHours\(\)
```

Allow-list (small, hardcoded in the script):
- `lib/time.ts`
- `lib/food/meal-slot.ts` (uses `Intl.DateTimeFormat` not `getHours()` after the change; the audit can confirm the change landed)
- `scripts/*` backfill paths
- Test fixtures (none today, but reserved)

Exits non-zero if any match falls outside the allow-list. Run manually before commits; matches the convention of the existing audit scripts listed in CLAUDE.md.

### `scripts/audit-time-helpers.mjs`

Fixture-based audit harness — no DB access. Asserts:

- `todayInUserTz("Asia/Dubai")` and `todayInUserTz("UTC")` differ around midnight UTC.
- DST edges: a date 2026-03-30 02:30 UTC in `Europe/London` (DST-spring) returns the correct local hour.
- Half-hour offsets: `Asia/Kolkata` (UTC+5:30) produces the right midnight rollover.
- Day-of-week shift: a UTC Sunday 22:00 in `Pacific/Auckland` is already Monday locally — `mondayOnOrBefore(d, "Pacific/Auckland")` returns the local Monday, not the UTC Monday.
- ~20 assertions total. Matches the convention of [scripts/audit-prescription-rules.mjs](scripts/audit-prescription-rules.mjs).

### CLAUDE.md update

A new "Timezone handling" section under "Architecture," after the data-sources block:

> **Timezone (single source of truth)**: `profiles.timezone` (IANA) is authoritative for every "today" / week-boundary / day-attribution computation. Server reads via `getUserTimezone(userId)` in [lib/time/get-user-tz.ts](lib/time/get-user-tz.ts); client reads via `useUserToday()`. The `USER_TIMEZONE` env var is fallback-only for scripts. New code MUST NOT call `new Date().toISOString().slice(0, 10)` or `d.getHours()` directly — the audit script `scripts/audit-timezone-usage.mjs` is the regression gate.

## Manual smoke checklist

After deploy:

1. Open app → header chip reads muted `DXB`.
2. macOS: System Settings → General → Date & Time → switch to "Los Angeles" → hard-refresh the app.
3. Chip flips orange `DXB → LAX?`, dashboard shows the inline notice.
4. Tap **Switch to Los Angeles** → chip muted again, dashboard regenerates for LA's calendar day.
5. Reload the page → no banner reappears.
6. Open `/profile`, scroll to Timezone section, expand combobox, type "Tokyo" → selects `Asia/Tokyo`. Chip flips to `TYO`.
7. Reset device timezone to Dubai → chip flips back to `DXB → TYO?` mismatch → tap **Stay on Tokyo** → chip becomes the dimmer orange-tinted state, notice hides.
8. Trigger manual dashboard regen via `/api/coach/dashboard/regenerate` → confirm response payload's `generated_on` is the Tokyo-local calendar date, not UTC.

## Open questions resolved during brainstorm

- **Should the env var be removed entirely?** No — kept as last-resort fallback for backfill scripts that have no user context.
- **Should there be a CHECK constraint on the timezone column?** No — app-side validation via `Intl.DateTimeFormat` is more flexible and the IANA list evolves.
- **Multi-PR or single PR rollout?** Single PR. Half-fixed state is worse than uniform-broken state.
- **Should `deriveMealSlot` keep using `getHours()` and just be called on the client only?** No — adding the `tz` parameter forces every callsite to be honest, and the audit script can enforce the change forever.
