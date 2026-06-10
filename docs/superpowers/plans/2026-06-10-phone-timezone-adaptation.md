# Phone-timezone adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `profiles.timezone` the single source of truth for "what calendar day is it for this user", with an ambient header chip + travel-mismatch UX + searchable picker on `/profile`, and rewire all UTC-leak sites through one helper.

**Architecture:** Single migration adds the column (`Asia/Dubai` default). One server helper (`getUserTimezone(userId)`) and one client hook (`useUserToday()`) are the only seams. `lib/time.ts` helpers gain an explicit `tz` parameter (optional during transition, required in the final task). All 9 server-side leak sites + 5 client-side leak sites are rewired in two batched tasks. UX is three small new components (chip, notice, profile section) and a minimal `TopBar` since no global top header exists today. Two audit scripts (forbidden-pattern grep + fixture-based helper test) become the regression gate.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Supabase (postgres + RLS), TanStack Query, native `Intl.DateTimeFormat` (no `date-fns-tz`/luxon). No test runner — verification via `npm run typecheck` + audit scripts + manual smoke.

**Reference spec:** [docs/superpowers/specs/2026-06-10-phone-timezone-adaptation-design.md](docs/superpowers/specs/2026-06-10-phone-timezone-adaptation-design.md)

---

## Verification model (read before starting)

The repo has no test suite (per [CLAUDE.md](CLAUDE.md): "There is no test suite and no working linter"). For every task, the verification step is one of:

- **`npm run typecheck`** — catches signature + import drift after refactors. Must exit 0.
- **`node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local <script>`** — audit-script invocation pattern used throughout the repo.
- **Manual smoke** — end of plan only. Steps spelled out in Task 13.

Do NOT skip verification steps. Each task ends with a green typecheck.

---

## Task 1: Migration + Profile type + fetcher COLS

**Files:**
- Create: `supabase/migrations/0042_profile_timezone.sql`
- Modify: `lib/query/fetchers/profile.ts:6-19`

### Steps

- [ ] **Step 1.1: Write migration**

Create `supabase/migrations/0042_profile_timezone.sql`:

```sql
-- 0042_profile_timezone.sql
-- Adds per-user timezone as the authoritative source for "today"
-- computations. Replaces the USER_TIMEZONE env var (now fallback-only
-- for backfill scripts).

alter table public.profiles
  add column if not exists timezone text not null default 'Asia/Dubai';

comment on column public.profiles.timezone is
  'IANA timezone (Intl.supportedValuesOf("timeZone")). Authoritative for all "today" / week-boundary / day-attribution logic. The USER_TIMEZONE env var is fallback-only for scripts.';
```

- [ ] **Step 1.2: Apply migration**

Run: `supabase db push`

Expected: `0042_profile_timezone.sql` listed under "Applying migration". If `repair --status applied <ver>` is required first (per CLAUDE.md "Supabase CLI" reference memory), apply that to whatever earlier migration the CLI reports as drifted, then re-run `db push`.

- [ ] **Step 1.3: Verify column landed**

Run: `supabase db inspect | head -50` OR via the dashboard: open `profiles` table → confirm `timezone` column exists with default `'Asia/Dubai'`. Smoke-check from a `psql`-style query if available: the existing row should have `timezone = 'Asia/Dubai'`.

- [ ] **Step 1.4: Extend Profile type + fetcher COLS**

Edit [lib/query/fetchers/profile.ts](lib/query/fetchers/profile.ts) — line 6 and the `Profile` type around lines 8-19:

```ts
const COLS = "name, age, height_cm, goal, system_prompt, whoop_baselines, disable_yazio_ingest, disable_strong_ingest, rotation_priority_lift, dietary_exclusions, timezone, created_at";

export type Profile = {
  name: string | null;
  age: number | null;
  height_cm: number | null;
  goal: string | null;
  system_prompt: string | null;
  whoop_baselines: Record<string, unknown> | null;
  disable_yazio_ingest: boolean;
  disable_strong_ingest: boolean;
  rotation_priority_lift: PrimaryLift | null;
  dietary_exclusions: DietaryExclusions | null;
  timezone: string;
  created_at: string;
};
```

`created_at` is needed by the first-set-silent branch of `useTimezoneSync` (Task 9).

- [ ] **Step 1.5: Typecheck**

Run: `npm run typecheck`

Expected: exit 0. Any consumer of `Profile` that now receives extra fields is non-breaking.

- [ ] **Step 1.6: Commit**

```bash
git add supabase/migrations/0042_profile_timezone.sql lib/query/fetchers/profile.ts
git commit -m "timezone: add profiles.timezone column + thread through Profile fetcher"
```

---

## Task 2: Server helper + client hook + IATA code map

**Files:**
- Create: `lib/time/get-user-tz.ts`
- Create: `lib/time/iana-codes.ts`
- Create: `lib/query/hooks/useUserToday.ts`

### Steps

- [ ] **Step 2.1: Create `lib/time/get-user-tz.ts`**

```ts
// lib/time/get-user-tz.ts
//
// Single accessor for the authoritative per-user timezone.
// Reads profiles.timezone via service-role; caches per-process for 10s
// (profile edits invalidate via invalidateUserTimezone).

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

type CacheEntry = { tz: string; at: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10_000;

const FALLBACK_TZ = (process.env.USER_TIMEZONE || "Asia/Dubai").trim();

export async function getUserTimezone(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;
  const sb = createSupabaseServiceRoleClient();
  const { data } = await sb
    .from("profiles")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  const tz = (data?.timezone as string | undefined) ?? FALLBACK_TZ;
  cache.set(userId, { tz, at: Date.now() });
  return tz;
}

export function invalidateUserTimezone(userId: string): void {
  cache.delete(userId);
}
```

- [ ] **Step 2.2: Create `lib/time/iana-codes.ts`**

```ts
// lib/time/iana-codes.ts
//
// Compact display labels for the header chip. IANA names like "Asia/Dubai"
// are too long; this maps the common ones to 3-letter codes. Unknown zones
// fall back to the city portion uppercased.

const KNOWN: Record<string, string> = {
  "Asia/Dubai": "DXB",
  "Asia/Tokyo": "TYO",
  "Asia/Shanghai": "SHA",
  "Asia/Hong_Kong": "HKG",
  "Asia/Singapore": "SIN",
  "Asia/Kolkata": "DEL",
  "Asia/Bangkok": "BKK",
  "Asia/Seoul": "ICN",
  "Europe/London": "LON",
  "Europe/Paris": "PAR",
  "Europe/Berlin": "BER",
  "Europe/Madrid": "MAD",
  "Europe/Rome": "ROM",
  "Europe/Amsterdam": "AMS",
  "Europe/Zurich": "ZRH",
  "Europe/Istanbul": "IST",
  "America/New_York": "NYC",
  "America/Los_Angeles": "LAX",
  "America/Chicago": "CHI",
  "America/Toronto": "YYZ",
  "America/Mexico_City": "MEX",
  "America/Sao_Paulo": "SAO",
  "Australia/Sydney": "SYD",
  "Australia/Melbourne": "MEL",
  "Africa/Cairo": "CAI",
  "Africa/Johannesburg": "JNB",
  "Pacific/Auckland": "AKL",
  "UTC": "UTC",
};

export function ianaToCode(tz: string): string {
  if (KNOWN[tz]) return KNOWN[tz];
  // Fallback: take the city portion, drop underscores, uppercase, max 4 chars.
  const city = tz.split("/").pop() ?? tz;
  return city.replace(/_/g, "").toUpperCase().slice(0, 4);
}
```

- [ ] **Step 2.3: Create `lib/query/hooks/useUserToday.ts`**

```ts
// lib/query/hooks/useUserToday.ts
"use client";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { todayInUserTz } from "@/lib/time";

/** YYYY-MM-DD in profile.timezone. Returns a stable string per render;
 *  callers expecting reactivity to the wall clock should compute their
 *  own Date inputs. */
export function useUserToday(userId: string): string {
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "Asia/Dubai";
  return todayInUserTz(new Date(), tz);
}
```

Note: `todayInUserTz` will accept a second `tz` argument after Task 3. The signature `todayInUserTz(now: Date, tz: string)` is what we're committing to.

- [ ] **Step 2.4: Typecheck**

Run: `npm run typecheck`

Expected: FAIL at `useUserToday.ts` with "Expected 0-1 arguments, but got 2" because `todayInUserTz` doesn't yet accept `tz`. This is expected — the hook lands together with Task 3's signature change.

To unblock the typecheck until Task 3, temporarily make the hook call `todayInUserTz(new Date())` (ignore tz). That keeps the file landed and compilable. Task 3 wires the tz back in.

Actual file content for now:

```ts
// lib/query/hooks/useUserToday.ts
"use client";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { todayInUserTz } from "@/lib/time";

export function useUserToday(userId: string): string {
  // tz wiring lands in Task 3 (lib/time.ts gets a tz parameter).
  // Until then, falls back to the env-var default inside todayInUserTz.
  void useProfile(userId); // hold the slot so the import isn't dead.
  return todayInUserTz();
}
```

- [ ] **Step 2.5: Typecheck again**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2.6: Commit**

```bash
git add lib/time/get-user-tz.ts lib/time/iana-codes.ts lib/query/hooks/useUserToday.ts
git commit -m "timezone: add server helper + client hook + IATA code map"
```

---

## Task 3: Refactor `lib/time.ts` — thread `tz` through every helper

**Files:**
- Modify: `lib/time.ts:41-114`, `lib/time.ts:138`, `lib/time.ts:213-220`
- Modify: `lib/query/hooks/useUserToday.ts:9` (restore real tz arg)

### Steps

- [ ] **Step 3.1: Refactor `lib/time.ts` helpers**

Replace the contents from line 41 to line 114 of [lib/time.ts](lib/time.ts) (everything from `partsInUserTz` through `nowInUserTz`) with:

```ts
function partsInUserTz(now: Date, tz: string = USER_TZ): Parts {
  logOnce();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  const rawHour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: rawHour === "24" ? "00" : rawHour,
    minute: get("minute"),
    weekday: get("weekday"),
  };
}

/** YYYY-MM-DD in the given timezone for any moment.
 *  `tz` defaults to USER_TIMEZONE env var (fallback during migration).
 *  After Task 13 this default is removed and `tz` becomes required. */
export function ymdInUserTz(when: Date, tz: string = USER_TZ): string {
  if (!Number.isFinite(when.getTime())) {
    throw new Error("ymdInUserTz: invalid Date input");
  }
  const p = partsInUserTz(when, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** YYYY-MM-DD for "right now" in the given timezone. Thin wrapper. */
export function todayInUserTz(now: Date = new Date(), tz: string = USER_TZ): string {
  return ymdInUserTz(now, tz);
}

/** Day of week in the given tz: "Monday" | "Tuesday" | ... */
export function weekdayInUserTz(now: Date = new Date(), tz: string = USER_TZ): string {
  return partsInUserTz(now, tz).weekday;
}

/** "HH:mm" in the given tz, 24h. */
export function localTimeInUserTz(now: Date = new Date(), tz: string = USER_TZ): string {
  const p = partsInUserTz(now, tz);
  return `${p.hour}:${p.minute}`;
}

/** Single struct for prompts and logs. */
export function nowInUserTz(now: Date = new Date(), tz: string = USER_TZ): {
  date: string;
  weekday: string;
  time: string;
  tz: string;
  utcOffset: string;
} {
  const p = partsInUserTz(now, tz);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    time: `${p.hour}:${p.minute}`,
    tz,
    utcOffset: utcOffsetString(now, tz),
  };
}
```

- [ ] **Step 3.2: Update `utcOffsetString` to accept tz**

Replace lines 116-130 in [lib/time.ts](lib/time.ts):

```ts
function utcOffsetString(now: Date, tz: string = USER_TZ): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(now);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = tzPart.match(/GMT([+-])?(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  const sign = m[1] || "+";
  const hh = (m[2] ?? "00").padStart(2, "0");
  const mm = m[3] ?? "00";
  return `${sign}${hh}:${mm}`;
}
```

- [ ] **Step 3.3: Update `formatHeaderDate` to accept tz**

Replace lines 213-220 in [lib/time.ts](lib/time.ts):

```ts
/** "Tuesday, May 5" — for the dashboard Header. */
export function formatHeaderDate(now: Date = new Date(), tz: string = USER_TZ): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}
```

- [ ] **Step 3.4: Update `relativeDateLabel` default to use tz-aware today**

The default value `today: string = todayInUserTz()` on line 138 still works (it calls the env-var fallback). No change needed unless you want to require a tz — leave as-is for transition.

- [ ] **Step 3.5: Wire `tz` back through `useUserToday`**

Replace [lib/query/hooks/useUserToday.ts](lib/query/hooks/useUserToday.ts):

```ts
"use client";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { todayInUserTz } from "@/lib/time";

export function useUserToday(userId: string): string {
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "Asia/Dubai";
  return todayInUserTz(new Date(), tz);
}
```

- [ ] **Step 3.6: Typecheck**

Run: `npm run typecheck`

Expected: exit 0. All existing callers passing 0 or 1 args still work (env-var fallback).

- [ ] **Step 3.7: Commit**

```bash
git add lib/time.ts lib/query/hooks/useUserToday.ts
git commit -m "timezone: thread optional tz parameter through lib/time helpers"
```

---

## Task 4: `lib/coach/week.ts` — accept `tz` parameter

**Files:**
- Modify: `lib/coach/week.ts` (full file)

### Steps

- [ ] **Step 4.1: Replace `lib/coach/week.ts`**

```ts
/** Week boundaries for the coach's weekly review.
 *  Weeks are Monday → Sunday in the user's timezone (was UTC pre-0042). */

import { ymdInUserTz, USER_TIMEZONE } from "@/lib/time";

/** "YYYY-MM-DD" for a Date in the given tz. */
function fmt(d: Date, tz: string): string {
  return ymdInUserTz(d, tz);
}

/** Monday of the week containing `d`, in the given tz. Returns YYYY-MM-DD. */
function startOfWeekMondayLocal(d: Date, tz: string): string {
  // Compute weekday in tz, then walk back N days. The walk is in UTC ms
  // (safe because we only care about day-count), then format in tz.
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(d);
  const longToIdx: Record<string, number> = {
    Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
    Friday: 5, Saturday: 6, Sunday: 7,
  };
  const idx = longToIdx[wd] ?? 1;
  const monday = new Date(d.getTime() - (idx - 1) * 86_400_000);
  return fmt(monday, tz);
}

/** Add N calendar days to a YYYY-MM-DD by parsing as UTC noon (DST-safe). */
function addDays(ymd: string, n: number): string {
  const dt = new Date(`${ymd}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export type ReviewMode = "monday-recap" | "in-progress" | "sunday-full";

export function reviewWindow(today: Date = new Date(), tz: string = USER_TIMEZONE): {
  start: string;
  end: string;
  mode: ReviewMode;
  daysRemaining: number;
} {
  const todayYmd = fmt(today, tz);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(today);
  const dowMap: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6,
  };
  const dow = dowMap[weekday] ?? 1;

  if (dow === 1) {
    const lastSun = addDays(todayYmd, -1);
    const lastMon = addDays(lastSun, -6);
    return { start: lastMon, end: lastSun, mode: "monday-recap", daysRemaining: 6 };
  }
  if (dow === 0) {
    const mon = addDays(todayYmd, -6);
    return { start: mon, end: todayYmd, mode: "sunday-full", daysRemaining: 0 };
  }
  const mon = startOfWeekMondayLocal(today, tz);
  return {
    start: mon,
    end: todayYmd,
    mode: "in-progress",
    daysRemaining: 7 - dow,
  };
}

export function recommendationWeekStart(today: Date = new Date(), tz: string = USER_TIMEZONE): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(today);
  const mon = startOfWeekMondayLocal(today, tz);
  if (weekday === "Sunday") return addDays(mon, 7);
  return mon;
}

export function planningTargetMonday(today: Date = new Date(), tz: string = USER_TIMEZONE): string {
  return recommendationWeekStart(today, tz);
}

export function currentWeekMonday(today: Date = new Date(), tz: string = USER_TIMEZONE): string {
  return startOfWeekMondayLocal(today, tz);
}
```

- [ ] **Step 4.2: Typecheck**

Run: `npm run typecheck`

Expected: exit 0. Existing callers passing only `today` still work (tz defaults to env-var via `USER_TIMEZONE`).

- [ ] **Step 4.3: Commit**

```bash
git add lib/coach/week.ts
git commit -m "timezone: week boundaries accept tz parameter (default USER_TIMEZONE)"
```

---

## Task 5: `lib/food/meal-slot.ts` — accept `tz` parameter

**Files:**
- Modify: `lib/food/meal-slot.ts:16-23`

### Steps

- [ ] **Step 5.1: Refactor `deriveMealSlot`**

Replace the `deriveMealSlot` function in [lib/food/meal-slot.ts](lib/food/meal-slot.ts):

```ts
import { USER_TIMEZONE } from "@/lib/time";
import type { MealSlot } from "./types";

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

// Uses tz-aware local-clock hours. Without tz, callers fall back to the
// env-var USER_TIMEZONE (transitional — Task 13 makes tz required).
export function deriveMealSlot(d: Date, tz: string = USER_TIMEZONE): MealSlot {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  }).format(d);
  // en-US numeric hour returns "0" through "23" (no zero-pad).
  const h = Number(hourStr);
  if (h >= 4 && h <= 10) return "breakfast";
  if (h >= 11 && h <= 14) return "lunch";
  if (h >= 15 && h <= 16) return "snack";
  if (h >= 17 && h <= 21) return "dinner";
  return "snack";
}
```

Keep the existing `import` line at the top updated:

```ts
// lib/food/meal-slot.ts
//
// Pure helpers for meal_slot. The deriveMealSlot mapping MUST stay in
// lockstep with the SQL CASE in supabase/migrations/0020_food_log_meal_slot.sql
// (used for the one-shot backfill). Going forward, this TS function is the
// runtime source of truth — the migration mapping is frozen historical code.

import { USER_TIMEZONE } from "@/lib/time";
import type { MealSlot } from "./types";
```

(`mealSlotLabel` is unchanged.)

- [ ] **Step 5.2: Typecheck**

Run: `npm run typecheck`

Expected: exit 0. Existing callers passing only `d` still work.

- [ ] **Step 5.3: Commit**

```bash
git add lib/food/meal-slot.ts
git commit -m "timezone: deriveMealSlot uses Intl with tz parameter (default USER_TIMEZONE)"
```

---

## Task 6: Apply user-local prefix to all 9 server-side leak sites

**Files:**
- Modify: `app/api/coach/dashboard/sync/route.ts:36`
- Modify: `app/api/coach/dashboard/regenerate/route.ts:30`
- Modify: `app/api/coach/sunday-prescriptions/sync/route.ts:42`
- Modify: `app/api/coach/eating-identity/sync/route.ts:13`
- Modify: `app/api/coach/recipe-discovery/check/route.ts:34`
- Modify: `app/api/chat/messages/route.ts:793`
- Modify: `app/api/chat/nudge-dismiss/route.ts:43`
- Modify: `app/api/training-weeks/[week_start]/swap/route.ts:246`
- Modify: `app/profile/page.tsx:32`

### Steps

- [ ] **Step 6.1: Edit `app/api/coach/dashboard/sync/route.ts`**

The route already loads `userId` (line 34). Replace line 36:

```ts
// before:
const today = new Date().toISOString().slice(0, 10);

// after:
const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
```

Add to the imports at the top of the file:

```ts
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
```

- [ ] **Step 6.2: Edit `app/api/coach/dashboard/regenerate/route.ts`**

Find the line `const today = new Date().toISOString().slice(0, 10);` (line 30).

Confirm a `userId` is already in scope above this line (the route loads the authenticated user). If yes, replace:

```ts
const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
```

Add imports at top:

```ts
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
```

If `userId` is not yet loaded by line 30 (read the route first to confirm), load it before the today computation.

- [ ] **Step 6.3: Edit `app/api/coach/sunday-prescriptions/sync/route.ts`**

This route currently iterates one user at a time (single-user app). Replace line 42:

```ts
// before:
const todayIso = new Date().toISOString().slice(0, 10);

// after:
const tz = await getUserTimezone(userId);
const todayIso = todayInUserTz(new Date(), tz);
```

Imports same as Step 6.1. The downstream `currentWeekMonday(today)` call MUST also pass `tz` — find that call and update to `currentWeekMonday(today, tz)` or pass a Date computed in user-local-noon.

- [ ] **Step 6.4: Edit `app/api/coach/eating-identity/sync/route.ts`**

Line 13 returns `new Date().toISOString().slice(0, 10)` from a small helper. Read the function — the helper's caller has `userId` in scope. Inline the date computation at the callsite instead:

```ts
// remove the helper that returns slice(0, 10)
// at the callsite, replace the helper call with:
const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
```

- [ ] **Step 6.5: Edit `app/api/coach/recipe-discovery/check/route.ts`**

Same pattern as Step 6.1. Replace line 34 with:

```ts
const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
```

Imports same.

- [ ] **Step 6.6: Edit `app/api/chat/messages/route.ts:793`**

The line is inside `loadLatestPeterDashboard(sr, user.id, new Date().toISOString().slice(0, 10))`. Replace:

```ts
// before:
? await loadLatestPeterDashboard(sr, user.id, new Date().toISOString().slice(0, 10))

// after:
? await loadLatestPeterDashboard(sr, user.id, todayInUserTz(new Date(), await getUserTimezone(user.id)))
```

Imports same. (Or, more readably, hoist `const tz = await getUserTimezone(user.id);` above the ternary.)

- [ ] **Step 6.7: Edit `app/api/chat/nudge-dismiss/route.ts:43`**

Same pattern. Replace:

```ts
const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
```

Imports same.

- [ ] **Step 6.8: Edit `app/api/training-weeks/[week_start]/swap/route.ts:246`**

Line 246: `todayIso: new Date().toISOString().slice(0, 10)`. This is inside a returned object (likely passed to a coach prompt). Replace:

```ts
const tz = await getUserTimezone(userId);
// ... in the return:
todayIso: todayInUserTz(new Date(), tz),
```

Imports same.

- [ ] **Step 6.9: Edit `app/profile/page.tsx:32`**

This is a server component. The `userId` is available from the auth check above. Replace line 32:

```ts
const tz = await getUserTimezone(userId);
const today = todayInUserTz(new Date(), tz);
```

Imports same.

- [ ] **Step 6.10: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6.11: Commit**

```bash
git add app/api/coach/dashboard/sync/route.ts \
        app/api/coach/dashboard/regenerate/route.ts \
        app/api/coach/sunday-prescriptions/sync/route.ts \
        app/api/coach/eating-identity/sync/route.ts \
        app/api/coach/recipe-discovery/check/route.ts \
        app/api/chat/messages/route.ts \
        app/api/chat/nudge-dismiss/route.ts \
        app/api/training-weeks/[week_start]/swap/route.ts \
        app/profile/page.tsx
git commit -m "timezone: rewire 9 server-side 'today' computations through getUserTimezone"
```

---

## Task 7: Rewire client component leak sites through `useUserToday`

**Files:**
- Modify: `components/morning/BriefSessionList.tsx:304`
- Modify: `components/profile/LabPromptCard.tsx:86`
- Modify: `components/log/LogForm.tsx:77`
- Modify: `components/strength/TodayPlanCard.tsx:220`

### Steps

- [ ] **Step 7.1: Edit `components/morning/BriefSessionList.tsx`**

Find line 304. The component should already receive `userId` as a prop (verify by reading the component signature). If yes, add the hook at top:

```ts
import { useUserToday } from "@/lib/query/hooks/useUserToday";

// inside the component body:
const today = useUserToday(userId);

// replace the `date={new Date().toISOString().slice(0, 10)}` with:
date={today}
```

If `userId` is NOT a prop, trace up to the parent and pass it down. The component is rendered by morning brief code that has `userId` available.

- [ ] **Step 7.2: Edit `components/profile/LabPromptCard.tsx`**

Find line 86. The `ackedOn` arg becomes `useUserToday(userId)`. Add the hook import + call at the top of the component, and replace the inline `new Date().toISOString().slice(0, 10)`:

```ts
import { useUserToday } from "@/lib/query/hooks/useUserToday";

// at top of component:
const today = useUserToday(userId);

// in the handler:
ackMut.mutate({ key: it.key, ackedOn: today });
```

- [ ] **Step 7.3: Edit `components/log/LogForm.tsx`**

Line 77: `const TODAY_ISO = () => new Date().toISOString().slice(0, 10);`

This is a module-level helper. It cannot use hooks. The replacement is to:

1. Delete the `TODAY_ISO` constant.
2. Inside the component body, add:
   ```ts
   const today = useUserToday(userId);
   ```
3. Replace every call to `TODAY_ISO()` inside the component with `today`.

`userId` should be a prop or pulled from the existing form context. Verify by reading the component first.

Add import:

```ts
import { useUserToday } from "@/lib/query/hooks/useUserToday";
```

- [ ] **Step 7.4: Edit `components/strength/TodayPlanCard.tsx`**

Same pattern as Step 7.1:

```ts
import { useUserToday } from "@/lib/query/hooks/useUserToday";

// inside component:
const today = useUserToday(userId);

// replace the `date={new Date().toISOString().slice(0, 10)}` with:
date={today}
```

- [ ] **Step 7.5: Verify no more raw UTC date slices in client components**

Run: `grep -rn "new Date().toISOString().slice(0, 10)" components/ --include="*.tsx"`

Expected: zero matches.

- [ ] **Step 7.6: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7.7: Commit**

```bash
git add components/morning/BriefSessionList.tsx \
        components/profile/LabPromptCard.tsx \
        components/log/LogForm.tsx \
        components/strength/TodayPlanCard.tsx
git commit -m "timezone: rewire client component 'today' through useUserToday"
```

---

## Task 8: `POST /api/profile/timezone` endpoint

**Files:**
- Create: `app/api/profile/timezone/route.ts`

### Steps

- [ ] **Step 8.1: Write the route**

```ts
// app/api/profile/timezone/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { invalidateUserTimezone } from "@/lib/time/get-user-tz";

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { timezone?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const tz = body.timezone;
  if (typeof tz !== "string" || tz.length === 0 || !isValidIanaTimezone(tz)) {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }

  const { error } = await sb
    .from("profiles")
    .update({ timezone: tz })
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  }

  invalidateUserTimezone(user.id);
  return NextResponse.json({ ok: true, timezone: tz });
}
```

- [ ] **Step 8.2: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 8.3: Commit**

```bash
git add app/api/profile/timezone/route.ts
git commit -m "timezone: add POST /api/profile/timezone endpoint"
```

---

## Task 9: TimezoneSyncContext + TimezoneChip + TopBar + globals

**Files:**
- Create: `components/timezone/TimezoneSyncContext.tsx`
- Create: `components/timezone/TimezoneChip.tsx`
- Create: `components/layout/TopBar.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

### Steps

- [ ] **Step 9.1: Write `TimezoneSyncContext.tsx`**

```tsx
// components/timezone/TimezoneSyncContext.tsx
"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { queryKeys } from "@/lib/query/keys";

export type TimezoneSyncState =
  | { kind: "loading" }
  | { kind: "match"; stored: string; detected: string }
  | { kind: "first-set-silent"; stored: string; detected: string }
  | { kind: "mismatch"; stored: string; detected: string }
  | { kind: "stayed"; stored: string; detected: string };

export type TimezoneSyncValue = {
  state: TimezoneSyncState;
  accept: () => Promise<void>;
  dismiss: () => void;
};

const Ctx = createContext<TimezoneSyncValue | null>(null);

function dismissedKey(stored: string) {
  return `tz-dismissed-${stored}`;
}

export function TimezoneSyncProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { data: profile } = useProfile(userId);
  const qc = useQueryClient();
  const [detected] = useState<string>(() =>
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Dubai"
      : "Asia/Dubai",
  );
  const [dismissTick, setDismissTick] = useState(0);

  const stored = profile?.timezone;
  const createdAt = profile?.created_at;

  let state: TimezoneSyncState = { kind: "loading" };
  if (stored) {
    if (stored === detected) {
      state = { kind: "match", stored, detected };
    } else {
      const isFirstSet =
        !!createdAt && Date.now() - new Date(createdAt).getTime() < 24 * 3600 * 1000;
      const dismissed =
        typeof window !== "undefined" &&
        window.sessionStorage.getItem(dismissedKey(stored)) === "1";
      if (isFirstSet) state = { kind: "first-set-silent", stored, detected };
      else if (dismissed) state = { kind: "stayed", stored, detected };
      else state = { kind: "mismatch", stored, detected };
    }
  }

  // Auto-accept on first-set-silent.
  useEffect(() => {
    if (state.kind !== "first-set-silent") return;
    void acceptInternal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  async function acceptInternal() {
    if (state.kind === "loading") return;
    const res = await fetch("/api/profile/timezone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: state.detected }),
    });
    if (res.ok) {
      await qc.invalidateQueries({ queryKey: queryKeys.profile.one(userId) });
    }
  }

  const value: TimezoneSyncValue = {
    state,
    accept: acceptInternal,
    dismiss() {
      if (state.kind === "loading") return;
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(dismissedKey(state.stored), "1");
      }
      setDismissTick((t) => t + 1);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimezoneSync(): TimezoneSyncValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTimezoneSync used outside TimezoneSyncProvider");
  return v;
}
```

- [ ] **Step 9.2: Write `TimezoneChip.tsx`**

```tsx
// components/timezone/TimezoneChip.tsx
"use client";
import Link from "next/link";
import { useTimezoneSync } from "./TimezoneSyncContext";
import { ianaToCode } from "@/lib/time/iana-codes";

export function TimezoneChip() {
  const { state } = useTimezoneSync();
  if (state.kind === "loading") return null;

  const storedCode = ianaToCode(state.stored);
  const detectedCode = ianaToCode(state.detected);

  let bg: string;
  let fg: string;
  let border: string;
  let label: string;
  let title: string;

  if (state.kind === "match" || state.kind === "first-set-silent") {
    bg = "transparent";
    fg = "rgb(136 136 136)";
    border = "1px solid rgb(42 42 42)";
    label = storedCode;
    title = `Timezone: ${state.stored}`;
  } else if (state.kind === "mismatch") {
    bg = "rgba(251,146,60,0.15)";
    fg = "rgb(251 146 60)";
    border = "1px solid rgba(251,146,60,0.3)";
    label = `${storedCode} → ${detectedCode}?`;
    title = `Device reports ${state.detected}, profile is ${state.stored}`;
  } else {
    // stayed
    bg = "rgba(251,146,60,0.08)";
    fg = "rgb(251 146 60)";
    border = "1px solid rgba(251,146,60,0.2)";
    label = storedCode;
    title = `Device reports ${state.detected}, but you chose to stay on ${state.stored}`;
  }

  return (
    <Link
      href="/profile#timezone"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.5,
        background: bg,
        color: fg,
        border,
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}
```

- [ ] **Step 9.3: Write `TopBar.tsx`**

```tsx
// components/layout/TopBar.tsx
"use client";
import { TimezoneChip } from "@/components/timezone/TimezoneChip";
import { TimezoneSyncProvider } from "@/components/timezone/TimezoneSyncContext";
import type { ReactNode } from "react";

export function TopBar({ userId, children }: { userId: string; children: ReactNode }) {
  return (
    <TimezoneSyncProvider userId={userId}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          background: "rgb(10 10 10)",
          borderBottom: "1px solid rgb(34 34 34)",
          padding: "calc(env(safe-area-inset-top) + 8px) 16px 8px",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 10,
        }}
      >
        <TimezoneChip />
      </header>
      {children}
    </TimezoneSyncProvider>
  );
}
```

- [ ] **Step 9.4: Mount `TopBar` in `app/layout.tsx`**

The root layout cannot read the user (it's a server component, but `TopBar` is client). The approach: load the user in the layout (server-side) and pass `userId` down.

[app/layout.tsx](app/layout.tsx) currently doesn't load auth. Two paths:

**Option A (recommended)** — convert layout to async server component, load user, pass userId. Wrap `<main>{children}</main>` with `<TopBar userId={user.id}>` when authenticated; render plain children (no TopBar) when unauthenticated (login page, etc.).

```tsx
// app/layout.tsx — add at top of the file:
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TopBar } from "@/components/layout/TopBar";

// change the default export to async and load user:
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();

  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <head>{/* ... unchanged ... */}</head>
      <body className="min-h-[100dvh] bg-bg">
        <QueryProvider>
          {user ? (
            <TopBar userId={user.id}>
              <main>{children}</main>
            </TopBar>
          ) : (
            <main>{children}</main>
          )}
          <BottomNav />
        </QueryProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 9.5: Reserve TopBar space in `globals.css`**

Edit [app/globals.css](app/globals.css). Find the existing `--nav-h` declaration and add a sibling `--topbar-h`:

```css
:root {
  --nav-h: /* existing value */;
  --topbar-h: 48px;
}

main {
  padding-top: calc(var(--topbar-h) + env(safe-area-inset-top));
  /* ... existing rules ... */
}
```

If `main` already has padding-top rules, adjust accordingly. The intent: don't have the sticky TopBar overlap the first content row.

If the existing CSS uses BottomNav padding-bottom only and never sets main padding-top, just add the `--topbar-h` variable and rely on the TopBar being part of normal document flow (since it's `position: sticky` not `fixed`, content automatically flows below it). In that case, no `main` padding change is needed. Read the existing file first to confirm.

- [ ] **Step 9.6: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 9.7: Commit**

```bash
git add components/timezone/TimezoneSyncContext.tsx \
        components/timezone/TimezoneChip.tsx \
        components/layout/TopBar.tsx \
        app/layout.tsx \
        app/globals.css
git commit -m "timezone: add TimezoneChip + TopBar mounted globally with sync context"
```

---

## Task 10: `TimezoneMismatchNotice` on dashboard

**Files:**
- Create: `components/timezone/TimezoneMismatchNotice.tsx`
- Modify: `app/page.tsx` (or whichever client component sits at top of dashboard)

### Steps

- [ ] **Step 10.1: Write `TimezoneMismatchNotice.tsx`**

```tsx
// components/timezone/TimezoneMismatchNotice.tsx
"use client";
import { useTimezoneSync } from "./TimezoneSyncContext";

export function TimezoneMismatchNotice() {
  const { state, accept, dismiss } = useTimezoneSync();
  if (state.kind !== "mismatch") return null;

  return (
    <div
      style={{
        margin: "0 0 14px",
        padding: "10px 14px",
        background: "rgb(22 22 22)",
        borderLeft: "2px solid rgb(251 146 60)",
        borderRadius: "0 6px 6px 0",
        fontSize: 12,
        color: "rgb(207 214 228)",
      }}
    >
      <div style={{ color: "white", marginBottom: 6 }}>
        <b>{state.detected}</b> detected on this device.
      </div>
      <div style={{ color: "rgb(136 136 136)", marginBottom: 8 }}>
        Your sessions today are still keyed to {state.stored}. Switch profile?
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => void accept()}
          style={{
            background: "transparent",
            color: "rgb(251 146 60)",
            border: "1px solid rgb(251 146 60)",
            padding: "4px 12px",
            borderRadius: 6,
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Switch to {state.detected.split("/").pop()?.replace(/_/g, " ")}
        </button>
        <button
          onClick={dismiss}
          style={{
            background: "transparent",
            color: "rgb(102 102 102)",
            border: 0,
            padding: "4px 12px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Stay on {state.stored.split("/").pop()?.replace(/_/g, " ")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 10.2: Mount on dashboard**

Read [app/page.tsx](app/page.tsx) to find the entry client component (likely something like `DashboardClient`). At the top of the dashboard's client-side render output, render `<TimezoneMismatchNotice />`. The notice is hidden by itself when the state isn't `mismatch`, so it's safe to unconditionally render.

Important: the notice must be a descendant of `TopBar` (which provides the `TimezoneSyncProvider`). Since Task 9 wraps `<main>` in `TopBar`, anything inside `main` qualifies — including the dashboard.

Add to the dashboard's top-level client component:

```tsx
import { TimezoneMismatchNotice } from "@/components/timezone/TimezoneMismatchNotice";

// at top of the JSX:
<TimezoneMismatchNotice />
```

- [ ] **Step 10.3: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 10.4: Commit**

```bash
git add components/timezone/TimezoneMismatchNotice.tsx app/page.tsx
git commit -m "timezone: dashboard inline mismatch notice"
```

---

## Task 11: `TimezoneSection` on `/profile`

**Files:**
- Create: `components/profile/TimezoneSection.tsx`
- Modify: `components/profile/ProfileClient.tsx`

### Steps

- [ ] **Step 11.1: Write `TimezoneSection.tsx`**

```tsx
// components/profile/TimezoneSection.tsx
"use client";
import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { queryKeys } from "@/lib/query/keys";

function listSupportedZones(): string[] {
  try {
    // @ts-expect-error supportedValuesOf is ES2022, Node ≥18
    const xs = Intl.supportedValuesOf("timeZone") as string[];
    return xs;
  } catch {
    return ["UTC", "Asia/Dubai", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles"];
  }
}

export function TimezoneSection({ userId }: { userId: string }) {
  const { data: profile } = useProfile(userId);
  const qc = useQueryClient();
  const stored = profile?.timezone ?? "Asia/Dubai";
  const detected = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const zones = useMemo(listSupportedZones, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones.slice(0, 12);
    return zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 30);
  }, [query, zones]);

  async function save(next: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/profile/timezone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone: next }),
      });
      if (res.ok) {
        await qc.invalidateQueries({ queryKey: queryKeys.profile.one(userId) });
      }
    } finally {
      setSaving(false);
      setOpen(false);
      setQuery("");
    }
  }

  const mismatch = stored !== detected;

  return (
    <section id="timezone" style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Timezone</h3>
      <div style={{ fontSize: 12, color: "rgb(136 136 136)", marginBottom: 12 }}>
        Authoritative for daily plans, brief, food log, week boundaries, and cron sync.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: "rgb(170 170 170)" }}>Current</span>
          <span style={{ color: "white" }}>{stored}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: "rgb(170 170 170)" }}>Device reports</span>
          <span style={{ color: mismatch ? "rgb(251 146 60)" : "rgb(170 170 170)" }}>
            {detected}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          onClick={() => save(detected)}
          disabled={saving || !mismatch}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid rgb(51 51 51)",
            background: mismatch ? "rgb(59 130 246)" : "rgb(34 34 34)",
            color: mismatch ? "white" : "rgb(136 136 136)",
            fontSize: 12,
            cursor: mismatch && !saving ? "pointer" : "default",
          }}
        >
          Use device timezone
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid rgb(51 51 51)",
            background: "transparent",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Pick another
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a city or zone…"
            autoFocus
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid rgb(51 51 51)",
              background: "rgb(20 20 20)",
              color: "white",
              fontSize: 13,
              marginBottom: 6,
            }}
          />
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              border: "1px solid rgb(34 34 34)",
              borderRadius: 6,
              background: "rgb(15 15 15)",
            }}
          >
            {filtered.map((z) => (
              <button
                key={z}
                onClick={() => save(z)}
                disabled={saving}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  background: z === stored ? "rgb(30 30 30)" : "transparent",
                  border: 0,
                  color: "white",
                  fontSize: 12,
                  fontFamily: "var(--font-dm-mono)",
                  cursor: "pointer",
                }}
              >
                {z}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 10, fontSize: 12, color: "rgb(136 136 136)" }}>
                No matches
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 11.2: Mount in `ProfileClient.tsx`**

Read [components/profile/ProfileClient.tsx](components/profile/ProfileClient.tsx) to find the top of the rendered output. Add `<TimezoneSection userId={userId} />` near the top, above the athlete-profile sections.

Add import:

```ts
import { TimezoneSection } from "@/components/profile/TimezoneSection";
```

Pass `userId` (already available as a prop). Place the section so the `id="timezone"` anchor scrolls into view when chip-tapped (the chip routes to `/profile#timezone`).

- [ ] **Step 11.3: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 11.4: Commit**

```bash
git add components/profile/TimezoneSection.tsx components/profile/ProfileClient.tsx
git commit -m "timezone: TimezoneSection picker on /profile"
```

---

## Task 12: Audit scripts

**Files:**
- Create: `scripts/audit-timezone-usage.mjs`
- Create: `scripts/audit-time-helpers.mjs`

### Steps

- [ ] **Step 12.1: Write `scripts/audit-timezone-usage.mjs`**

```js
#!/usr/bin/env node
// scripts/audit-timezone-usage.mjs
//
// Forbidden-pattern grep. Exits non-zero if any disallowed UTC-date or
// raw getHours() call lives outside the allow-list.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const FORBIDDEN = [
  /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
  /\.toISOString\(\)\.slice\(0,\s*10\)/,
  /format\(\s*new Date\(\)\s*,\s*['"]yyyy-MM-dd['"]/,
  /\.getHours\(\)/,
];

const ALLOW = new Set([
  "lib/time.ts",
  "lib/food/meal-slot.ts",   // uses Intl, but historical CASE in 0020 mentioned getHours()
  "lib/whoop.ts",            // per-record offset path uses .toISOString().slice — required for L1
  "scripts/audit-timezone-usage.mjs",
]);

const ALLOW_PREFIX = ["scripts/", "_prototype.jsx"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git" || entry === ".superpowers") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

function isAllowed(rel) {
  if (ALLOW.has(rel)) return true;
  return ALLOW_PREFIX.some((p) => rel.startsWith(p));
}

const files = walk(ROOT);
const offenders = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  if (isAllowed(rel)) continue;
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pat of FORBIDDEN) {
      if (pat.test(lines[i])) {
        offenders.push({ file: rel, line: i + 1, text: lines[i].trim(), pat: String(pat) });
      }
    }
  }
}

if (offenders.length === 0) {
  console.log("audit-timezone-usage: ok (no forbidden patterns)");
  process.exit(0);
}

console.error(`audit-timezone-usage: ${offenders.length} forbidden pattern(s) found:`);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  [${o.pat}]  ${o.text}`);
}
process.exit(1);
```

Make executable: `chmod +x scripts/audit-timezone-usage.mjs`

- [ ] **Step 12.2: Run the usage audit**

Run: `node scripts/audit-timezone-usage.mjs`

Expected: exit 0 with `audit-timezone-usage: ok`. If it reports offenders, fix them (likely a Task 6/7 site that was missed) before continuing.

- [ ] **Step 12.3: Write `scripts/audit-time-helpers.mjs`**

```js
#!/usr/bin/env node
// scripts/audit-time-helpers.mjs
//
// Fixture-based audit for lib/time.ts helpers. No DB access.

import { todayInUserTz, ymdInUserTz, partsInUserTzExport } from "../lib/time.ts";
import { currentWeekMonday, recommendationWeekStart, reviewWindow } from "../lib/coach/week.ts";
import { deriveMealSlot } from "../lib/food/meal-slot.ts";

const TZ = {
  utc: "UTC",
  dxb: "Asia/Dubai",
  tyo: "Asia/Tokyo",
  lax: "America/Los_Angeles",
  lon: "Europe/London",
  npt: "Asia/Kathmandu", // +05:45 — half-hour-ish offset
  akl: "Pacific/Auckland",
};

let pass = 0;
let fail = 0;

function assert(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label} — ${detail}`); }
}

// 1. todayInUserTz differs around UTC midnight for Dubai
const utcMidnight = new Date("2026-06-10T00:00:00Z");
assert(
  "Dubai 'today' at UTC midnight is the day after UTC",
  todayInUserTz(utcMidnight, TZ.dxb) === "2026-06-10",
  `got ${todayInUserTz(utcMidnight, TZ.dxb)}`,
);
assert(
  "UTC 'today' at UTC midnight is 2026-06-10",
  todayInUserTz(utcMidnight, TZ.utc) === "2026-06-10",
  `got ${todayInUserTz(utcMidnight, TZ.utc)}`,
);
const lateNightDubai = new Date("2026-06-10T20:30:00Z"); // 00:30 Dubai
assert(
  "Dubai late-night maps to the next day",
  todayInUserTz(lateNightDubai, TZ.dxb) === "2026-06-11",
  `got ${todayInUserTz(lateNightDubai, TZ.dxb)}`,
);

// 2. DST spring forward — London
const dstSpring = new Date("2026-03-29T02:30:00Z"); // 03:30 BST after spring forward
assert(
  "London handles DST spring-forward without throwing",
  /^\d{4}-\d{2}-\d{2}$/.test(ymdInUserTz(dstSpring, TZ.lon)),
  `got ${ymdInUserTz(dstSpring, TZ.lon)}`,
);

// 3. Half-hour offset — Kathmandu
const ktmMoment = new Date("2026-06-10T18:30:00Z"); // 00:15 next day in NPT
assert(
  "Kathmandu (+05:45) crosses midnight correctly",
  todayInUserTz(ktmMoment, TZ.npt) === "2026-06-11",
  `got ${todayInUserTz(ktmMoment, TZ.npt)}`,
);

// 4. Auckland Sunday→Monday boundary
const aklSundayUtc = new Date("2026-06-07T13:00:00Z"); // Mon 01:00 NZST
assert(
  "Auckland Sunday-night UTC = Monday local",
  currentWeekMonday(aklSundayUtc, TZ.akl) === "2026-06-08",
  `got ${currentWeekMonday(aklSundayUtc, TZ.akl)}`,
);

// 5. recommendationWeekStart on Sunday returns next Monday
const lonSunday = new Date("2026-06-07T12:00:00Z"); // Sun 13:00 BST
assert(
  "London Sunday → next Monday",
  recommendationWeekStart(lonSunday, TZ.lon) === "2026-06-08",
  `got ${recommendationWeekStart(lonSunday, TZ.lon)}`,
);

// 6. reviewWindow on Monday returns previous Mon-Sun
const dxbMonday = new Date("2026-06-08T08:00:00Z"); // Mon 12:00 DXB
const win = reviewWindow(dxbMonday, TZ.dxb);
assert(
  "Monday review window starts on 2026-06-01",
  win.start === "2026-06-01" && win.end === "2026-06-07" && win.mode === "monday-recap",
  `got ${JSON.stringify(win)}`,
);

// 7. Meal slot — 08:00 Dubai is breakfast
const breakfastDxb = new Date("2026-06-10T04:00:00Z"); // 08:00 DXB
assert(
  "Meal slot: 08:00 Dubai is breakfast",
  deriveMealSlot(breakfastDxb, TZ.dxb) === "breakfast",
  `got ${deriveMealSlot(breakfastDxb, TZ.dxb)}`,
);

// 8. Same UTC moment in LA is 21:00 previous day → dinner
assert(
  "Same UTC moment in LA is dinner the previous day",
  deriveMealSlot(breakfastDxb, TZ.lax) === "dinner",
  `got ${deriveMealSlot(breakfastDxb, TZ.lax)}`,
);

// 9. Same UTC moment in Tokyo is 13:00 → lunch
assert(
  "Same UTC moment in Tokyo is lunch",
  deriveMealSlot(breakfastDxb, TZ.tyo) === "lunch",
  `got ${deriveMealSlot(breakfastDxb, TZ.tyo)}`,
);

console.log(`\naudit-time-helpers: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
```

Note: the import for `partsInUserTzExport` is unused — remove that line. The audit only uses `todayInUserTz`, `ymdInUserTz`, the week helpers, and `deriveMealSlot`. Keep the imports minimal.

- [ ] **Step 12.4: Run the helper audit**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-time-helpers.mjs`

Expected: `audit-time-helpers: 9 pass, 0 fail`. Any failure indicates a bug in the helper refactor — fix before continuing.

- [ ] **Step 12.5: Commit**

```bash
git add scripts/audit-timezone-usage.mjs scripts/audit-time-helpers.mjs
git commit -m "timezone: audit scripts (forbidden patterns + helper fixtures)"
```

---

## Task 13: Lock-in cleanup + CLAUDE.md + manual smoke

**Files:**
- Modify: `lib/time.ts` (remove env-var defaults from helper signatures)
- Modify: `lib/coach/week.ts` (remove env-var defaults)
- Modify: `lib/food/meal-slot.ts` (remove env-var default)
- Modify: `CLAUDE.md`

### Steps

- [ ] **Step 13.1: Make `tz` required in `lib/time.ts` helpers**

In [lib/time.ts](lib/time.ts), remove `= USER_TZ` defaults from these signatures (helpers exposed externally; the internal `partsInUserTz` can keep its default since it's called only with explicit tz from the public helpers):

- `ymdInUserTz(when: Date, tz: string)` — remove default
- `todayInUserTz(now: Date = new Date(), tz: string)` — remove tz default; keep `now` default
- `weekdayInUserTz(now: Date = new Date(), tz: string)`
- `localTimeInUserTz(now: Date = new Date(), tz: string)`
- `nowInUserTz(now: Date = new Date(), tz: string)`
- `formatHeaderDate(now: Date = new Date(), tz: string)`

After this change, `npm run typecheck` will catch any caller that still relies on the env-var fallback. There should be none — every caller was updated in Tasks 6-7.

- [ ] **Step 13.2: Typecheck**

Run: `npm run typecheck`

Expected: exit 0. If it fails, the failing file is a caller that Task 6 or 7 missed. Add the missing tz arg (or wire `useUserToday` for client) and rerun.

- [ ] **Step 13.3: Make `tz` required in `lib/coach/week.ts`**

Remove the `= USER_TIMEZONE` defaults from `reviewWindow`, `recommendationWeekStart`, `planningTargetMonday`, `currentWeekMonday`.

- [ ] **Step 13.4: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 13.5: Make `tz` required in `lib/food/meal-slot.ts`**

Remove the `= USER_TIMEZONE` default from `deriveMealSlot`.

- [ ] **Step 13.6: Typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 13.7: Run both audits**

```bash
node scripts/audit-timezone-usage.mjs
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-time-helpers.mjs
```

Expected: both exit 0.

- [ ] **Step 13.8: Update CLAUDE.md**

In [CLAUDE.md](CLAUDE.md), find the "Architecture" section and append a new sub-section after the data-sources block:

```markdown
### Timezone (single source of truth)

`profiles.timezone` (IANA) is authoritative for every "today" / week-boundary / day-attribution computation. Server reads via `getUserTimezone(userId)` in [lib/time/get-user-tz.ts](lib/time/get-user-tz.ts); client reads via [useUserToday](lib/query/hooks/useUserToday.ts). The `USER_TIMEZONE` env var is fallback-only for backfill scripts. New code MUST NOT call `new Date().toISOString().slice(0, 10)` or `d.getHours()` directly — the audit script [scripts/audit-timezone-usage.mjs](scripts/audit-timezone-usage.mjs) is the regression gate.

UX: ambient `TimezoneChip` in [components/layout/TopBar.tsx](components/layout/TopBar.tsx) (neutral when match, orange when device-vs-profile mismatch, orange-tinted after user dismisses). Inline `TimezoneMismatchNotice` on the dashboard. Searchable picker on `/profile` via [components/profile/TimezoneSection.tsx](components/profile/TimezoneSection.tsx). All driven by `TimezoneSyncContext`.

Audit: `node scripts/audit-timezone-usage.mjs` (forbidden patterns) + `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-time-helpers.mjs` (fixture-based helper test).
```

Also add to the "Database migrations" list:

```markdown
42. [supabase/migrations/0042_profile_timezone.sql](supabase/migrations/0042_profile_timezone.sql) — adds `profiles.timezone text NOT NULL DEFAULT 'Asia/Dubai'`. Authoritative for all server- and client-side "today" computations. `USER_TIMEZONE` env var becomes fallback-only for backfill scripts.
```

- [ ] **Step 13.9: Commit cleanup**

```bash
git add lib/time.ts lib/coach/week.ts lib/food/meal-slot.ts CLAUDE.md
git commit -m "timezone: lock tz parameter as required + CLAUDE.md docs"
```

- [ ] **Step 13.10: Manual smoke (run before opening PR)**

Start dev: `npm run dev` then in the browser, with the app open at http://localhost:3000:

1. App opens — header chip reads muted `DXB`. ✓ if visible and grey.
2. Open macOS System Settings → General → Date & Time → uncheck "Set automatically" → choose Los Angeles. Save.
3. Hard refresh the browser (Cmd+Shift+R). Chip flips orange `DXB → LAX?`. Dashboard shows the inline orange notice.
4. Click **Switch to Los Angeles**. Chip returns to muted, now reading `LAX`. Dashboard regenerates for LA's today.
5. Hard refresh again. No banner. Chip still muted `LAX`. ✓
6. Navigate to `/profile`. Scroll to **Timezone** section. Click **Pick another**. Type "Tokyo". Click `Asia/Tokyo`. Chip flips to `TYO`. ✓
7. Set macOS back to Dubai. Hard refresh. Chip flips orange `TYO → DXB?`. Click **Stay on Tokyo**. Chip turns the lighter orange-tint state. Notice disappears. ✓
8. Hit `/api/coach/dashboard/regenerate` (POST with body `{}` via browser DevTools fetch). Response payload's `generated_on` should be **Tokyo's** calendar date, not UTC. ✓

If any step fails, debug before opening the PR. Common failure: hook firing before `useProfile` returns data — verify `state.kind === "loading"` short-circuits correctly in the chip and notice.

- [ ] **Step 13.11: Restore your real device timezone**

Reset macOS Date & Time to "Set automatically". Update profile via `/profile` → "Use device timezone" so the stored value matches reality.

---

## Self-review checklist

- [x] **Spec coverage**: every spec section is implemented. Migration (Task 1), helpers (Task 2-3), week.ts (Task 4), meal-slot.ts (Task 5), cron rollout (Task 6), client leak sites (Task 7), POST endpoint (Task 8), UX components (Tasks 9-11), audit scripts (Task 12), cleanup + docs (Task 13).
- [x] **No placeholders**: every step has concrete code or commands.
- [x] **Type consistency**: `getUserTimezone(userId)`, `useUserToday(userId)`, `todayInUserTz(now, tz)`, `currentWeekMonday(today, tz)`, `deriveMealSlot(d, tz)`, `TimezoneSyncProvider userId`, `TimezoneSection userId` — names match across tasks.
- [x] **Verification model**: each task ends with `npm run typecheck`; audit scripts have their own runs; manual smoke at end.
- [x] **Decomposition**: tasks are independently meaningful and each leaves the repo in a green-typecheck state.
