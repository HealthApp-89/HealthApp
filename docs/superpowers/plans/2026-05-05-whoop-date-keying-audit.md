# WHOOP / Withings date-keying audit + travel mode L1 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch every server-side date-keying call site so `daily_logs.date` is keyed by user-local calendar day (using `lib/time.ts` helpers), honor WHOOP's per-record `timezone_offset` for travel mode (L1), and add one-shot Node scripts that re-key recent history by clearing then repopulating WHOOP/Withings-owned columns.

**Architecture:** A new pure module `lib/whoop-day-rows.ts` consolidates the day-row construction logic that was duplicated between the WHOOP sync route and the WHOOP backfill route — both now call `buildWhoopDayRows(...)`. The cycle-tz lookup lives in its own tiny module `lib/whoop-tz.ts`. The rekey scripts import from `lib/` directly to avoid duplicating keying logic, and use a fetch-first / clear / upsert sequence (with explicit error paths) so a partial WHOOP API outage during rekey never leaves the user with cleared columns and no replacement data.

**Tech Stack:** Next.js 15 (App Router) · Supabase (Postgres + service-role client for scripts) · TypeScript (strict) · Node 22+ `--experimental-strip-types` for `.mts` scripts · platform `Intl.DateTimeFormat` for tz formatting · WHOOP v2 REST API · Withings Measure/Activity REST API.

**Spec:** [docs/superpowers/specs/2026-05-05-whoop-date-keying-audit-design.md](../specs/2026-05-05-whoop-date-keying-audit-design.md)

**Project verification policy:** Per [CLAUDE.md](../../../CLAUDE.md), there is no test suite and no working linter (the `lint` script was removed in commit `57e68f3`). Verification = `npm run typecheck` + manual checks. Do NOT introduce a test runner; do NOT write `*.test.ts` files unless explicitly requested.

---

## File map

**Create**

- [lib/whoop-tz.ts](../../../lib/whoop-tz.ts) — `buildCycleTzLookup(cycles)` helper. ~30 lines.
- [lib/whoop-day-rows.ts](../../../lib/whoop-day-rows.ts) — pure `buildWhoopDayRows(...)` consolidating sync + backfill keying logic. ~110 lines.
- [scripts/rekey-whoop.mts](../../../scripts/rekey-whoop.mts) — one-shot WHOOP rekey. ~200 lines.
- [scripts/rekey-withings.mts](../../../scripts/rekey-withings.mts) — one-shot Withings rekey. ~150 lines.

**Modify**

- [lib/supabase/server.ts](../../../lib/supabase/server.ts) — lazy-load `next/headers` so the file is loadable from non-Next contexts (the rekey scripts).
- [lib/time.ts](../../../lib/time.ts) — invert alias so `ymdInUserTz` is canonical; add `ymdInZoneOffset(when, offset)`.
- [app/api/whoop/sync/route.ts](../../../app/api/whoop/sync/route.ts) — replace inline keying with `buildWhoopDayRows(...)`. Counts logic remains in the route.
- [app/api/whoop/backfill/route.ts](../../../app/api/whoop/backfill/route.ts) — replace inline keying with `buildWhoopDayRows(...)`.
- [lib/withings-merge.ts](../../../lib/withings-merge.ts) — patch line 48 (measurement-group keying) to use `ymdInUserTz`.
- [app/api/withings/backfill/route.ts](../../../app/api/withings/backfill/route.ts) — patch line 31 (`endYmd`) to use `todayInUserTz`.

---

# Slice 1 — `lib/time.ts` extension + supabase/server lazy-load

Goal: extend the existing time module with `ymdInUserTz` (canonical) and `ymdInZoneOffset` (travel-mode-aware fixed-offset formatter). Existing `todayInUserTz` becomes a one-line wrapper around `ymdInUserTz`. Also: a small fix to `lib/supabase/server.ts` so the rekey scripts in Slice 3 can import lib code (currently `next/headers` is imported at module-load time, breaking script use).

## Task 1.1: Lazy-load `next/headers` in `lib/supabase/server.ts`

**Why:** The rekey scripts in Slice 3 import `lib/whoop-day-rows.ts`, which transitively pulls in `lib/whoop.ts` → `lib/supabase/server.ts`. Today, `lib/supabase/server.ts` does `import { cookies } from "next/headers"` at the top — this fails when imported outside a Next request context (e.g., from a `node --experimental-strip-types` script). Moving the `next/headers` import inside the `createSupabaseServerClient()` function (dynamic import) means it's only evaluated when that function is called. Scripts only call `createSupabaseServiceRoleClient()`, so they never trigger the dynamic import. Behavior in Next contexts is unchanged.

**Files:**
- Modify: [lib/supabase/server.ts](../../../lib/supabase/server.ts)

- [ ] **Step 1: Read the current file**

```bash
cat "/Users/abdelouahedelbied/Health app/lib/supabase/server.ts"
```

You'll see lines 1–2 contain:

```ts
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
```

- [ ] **Step 2: Remove the top-level `next/headers` import and use dynamic import inside the function**

Find the top of the file:

```ts
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
```

Replace with:

```ts
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

export async function createSupabaseServerClient() {
  // Lazy-imported so this module is loadable from non-Next contexts (scripts).
  // The dynamic import is cached by Node's ESM loader after the first call.
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
```

(The rest of the function body and `createSupabaseServiceRoleClient` are unchanged.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```

Expected: clean.

```bash
npm run build
```

Expected: clean. The build verifies the dynamic import works correctly in the Next bundler.

- [ ] **Step 4: Smoke check from a non-Next context**

```bash
node --experimental-strip-types --env-file="/Users/abdelouahedelbied/Health app/.env.local" -e "
import('/Users/abdelouahedelbied/Health app/lib/supabase/server.ts').then(m => {
  const c = m.createSupabaseServiceRoleClient();
  console.log('service-role client created:', typeof c.from === 'function');
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
" 2>&1 | tail -3
```

Expected: `service-role client created: true`. If it errors with anything about `next/headers`, the lazy-load isn't taking effect — re-check Step 2.

- [ ] **Step 5: Commit**

```bash
git add lib/supabase/server.ts
git commit -m "fix(supabase): lazy-load next/headers so scripts can import lib"
```

## Task 1.2: Add `ymdInUserTz` and `ymdInZoneOffset`

**Files:**
- Modify: [lib/time.ts](../../../lib/time.ts)

- [ ] **Step 1: Read the current `lib/time.ts`**

```bash
cat "/Users/abdelouahedelbied/Health app/lib/time.ts"
```

You should see exports: `USER_TIMEZONE`, `todayInUserTz`, `weekdayInUserTz`, `localTimeInUserTz`, `nowInUserTz`, `relativeDateLabel`, `formatHeaderDate`. The implementation of `todayInUserTz` calls `partsInUserTz(now)` and assembles a `YYYY-MM-DD` string.

- [ ] **Step 2: Refactor `todayInUserTz` into `ymdInUserTz`**

Find this function:

```ts
/** YYYY-MM-DD in the user's timezone. Replaces every server-side
 *  `new Date().toISOString().slice(0, 10)`. */
export function todayInUserTz(now: Date = new Date()): string {
  const p = partsInUserTz(now);
  return `${p.year}-${p.month}-${p.day}`;
}
```

Replace with:

```ts
/** YYYY-MM-DD in the user's timezone for any moment. This is the canonical
 *  user-tz date formatter; `todayInUserTz()` is a thin wrapper for the
 *  no-arg "right now" case. Use this when keying historical timestamps
 *  (WHOOP/Withings sync, etc.). */
export function ymdInUserTz(when: Date): string {
  const p = partsInUserTz(when);
  return `${p.year}-${p.month}-${p.day}`;
}

/** YYYY-MM-DD for "right now" in the user's timezone. Replaces every
 *  server-side `new Date().toISOString().slice(0, 10)`. Thin wrapper. */
export function todayInUserTz(now: Date = new Date()): string {
  return ymdInUserTz(now);
}
```

- [ ] **Step 3: Add `ymdInZoneOffset` near the bottom of the file**

Insert this function just before the existing `formatHeaderDate` export (or anywhere near the other YMD formatters — pick a spot that reads well):

```ts
/** YYYY-MM-DD for a given UTC moment in a fixed-offset zone like "+04:00"
 *  or "-05:00". Used for WHOOP per-record `timezone_offset` (travel mode L1).
 *  Handles non-integer offsets like "+05:45" (Nepal) and "-04:30" (Newfoundland)
 *  correctly because hours and minutes are parsed independently. */
export function ymdInZoneOffset(when: Date, offset: string): string {
  const sign = offset[0] === "-" ? -1 : 1;
  const [hh, mm] = offset.slice(1).split(":").map(Number);
  const offsetMs = sign * (hh * 3_600_000 + mm * 60_000);
  return new Date(when.getTime() + offsetMs).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck
```

Expected: clean. The previous spec's call sites all use `todayInUserTz()` with no args, so the wrapper preserves their behavior; no caller regresses.

- [ ] **Step 5: Commit**

```bash
git add lib/time.ts
git commit -m "feat(time): add ymdInUserTz + ymdInZoneOffset for sync date-keying"
```

---

# Slice 2 — Forward fix + travel mode L1

Goal: every server-side date-keying call site honors user-local time. WHOOP routes consolidate their keying logic into a shared pure module so the rekey scripts can reuse it without duplication.

## Task 2.1: Create `lib/whoop-tz.ts`

**Files:**
- Create: [lib/whoop-tz.ts](../../../lib/whoop-tz.ts)

- [ ] **Step 1: Write the module**

Create `lib/whoop-tz.ts` with this exact content:

```ts
// lib/whoop-tz.ts
//
// Helper for travel-mode L1: build a function that maps a UTC moment to the
// timezone_offset of the WHOOP cycle that contains it. WHOOP returns a per-
// record timezone_offset on cycles and workouts (but NOT on sleep/recovery
// records); sleep and recovery inherit their tz from the containing cycle.
//
// Sleep/recovery whose moment doesn't fall inside any cycle in the input set
// (e.g., the cycle is outside the sync window) returns null so callers can
// fall back to USER_TIMEZONE.

import type { WhoopCycle } from "@/lib/whoop";

/** Build a function that, given a UTC moment, returns the timezone_offset
 *  of the cycle that contains it (e.g. "+04:00", "-05:00"), or null if no
 *  cycle in the input set covers it. */
export function buildCycleTzLookup(
  cycles: WhoopCycle[],
): (when: Date) => string | null {
  // Sort by start descending so the most recent open cycle wins for in-progress
  // sleeps without leaking onto historical sleeps. Critical during a 2-year
  // backfill where stale open cycles (data gaps, dropped end records) could
  // otherwise match arbitrary historical moments via an unbounded "now+24h"
  // fallback.
  const sorted = [...cycles].sort((a, b) => b.start.localeCompare(a.start));
  return (when: Date) => {
    const t = when.toISOString();
    for (const c of sorted) {
      // Open cycles (no `end`) get a 36-hour cap from their start — physical
      // upper bound for one wake-to-wake interval. Beyond that, fall through.
      const cycleEnd =
        c.end ??
        new Date(new Date(c.start).getTime() + 36 * 3_600_000).toISOString();
      if (c.start <= t && t <= cycleEnd) return c.timezone_offset;
    }
    return null;
  };
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```

Expected: clean. The module has zero callers yet — Tasks 2.2+ will wire it in.

- [ ] **Step 3: Commit**

```bash
git add lib/whoop-tz.ts
git commit -m "feat(whoop): add cycle-tz lookup helper for travel mode"
```

## Task 2.2: Extract `lib/whoop-day-rows.ts`

This consolidates the day-row construction logic that's currently duplicated between [app/api/whoop/sync/route.ts](../../../app/api/whoop/sync/route.ts) (lines ~39–125) and [app/api/whoop/backfill/route.ts](../../../app/api/whoop/backfill/route.ts) (similar shape). After this task, both routes call the shared builder, and the rekey script in Slice 3 can import the same builder.

**Files:**
- Create: [lib/whoop-day-rows.ts](../../../lib/whoop-day-rows.ts)

- [ ] **Step 1: Write the module**

Create `lib/whoop-day-rows.ts` with this exact content:

```ts
// lib/whoop-day-rows.ts
//
// Pure builder for `daily_logs` rows from WHOOP records. Both the sync and
// backfill routes call this; the rekey script does too. All date keying is
// user-local: cycles use their own `timezone_offset`, sleep/recovery inherit
// from the containing cycle (via buildCycleTzLookup), with USER_TIMEZONE as
// the fallback.

import type { WhoopRecovery, WhoopCycle, WhoopSleep } from "@/lib/whoop";
import { buildCycleTzLookup } from "@/lib/whoop-tz";
import { ymdInUserTz, ymdInZoneOffset } from "@/lib/time";

export type WhoopDayRow = {
  user_id: string;
  date: string;
  hrv?: number | null;
  resting_hr?: number | null;
  recovery?: number | null;
  spo2?: number | null;
  skin_temp_c?: number | null;
  respiratory_rate?: number | null;
  strain?: number | null;
  sleep_hours?: number | null;
  sleep_score?: number | null;
  deep_sleep_hours?: number | null;
  rem_sleep_hours?: number | null;
  source: string;
  updated_at: string;
};

/** Build the per-day rows from WHOOP records. Order matters:
 *  1. Cycles → strain (also feeds the cycle-tz lookup for sleeps/recoveries).
 *  2. Sleeps → sleep_*, builds sleepIdToDate using cycle-tz lookup.
 *  3. Recoveries → hrv/resting_hr/recovery/spo2/skin_temp_c, keyed by linked
 *     sleep's date (or USER_TIMEZONE-keyed `created_at` fallback).
 *
 *  Returns an array of rows ready for `daily_logs` upsert. */
export function buildWhoopDayRows(
  userId: string,
  recovery: WhoopRecovery[],
  cycles: WhoopCycle[],
  sleep: WhoopSleep[],
): WhoopDayRow[] {
  const lookupCycleTz = buildCycleTzLookup(cycles);
  const byDate = new Map<string, WhoopDayRow>();
  const ensure = (date: string): WhoopDayRow => {
    let row = byDate.get(date);
    if (!row) {
      row = {
        user_id: userId,
        date,
        source: "whoop",
        updated_at: new Date().toISOString(),
      };
      byDate.set(date, row);
    }
    return row;
  };

  // 1. Cycles → strain
  for (const c of cycles) {
    if (!c.score) continue;
    const date = ymdInZoneOffset(new Date(c.start), c.timezone_offset);
    const row = ensure(date);
    row.strain = c.score.strain;
  }

  // 2. Sleeps → sleep_*, also populate sleepIdToDate
  const sleepIdToDate = new Map<string, string>();
  for (const s of sleep) {
    const cycleTz = lookupCycleTz(new Date(s.end));
    const date = cycleTz
      ? ymdInZoneOffset(new Date(s.end), cycleTz)
      : ymdInUserTz(new Date(s.end));
    sleepIdToDate.set(s.id, date);
    if (!s.score) continue;
    const row = ensure(date);
    const stages = s.score.stage_summary;
    if (stages) {
      // "Asleep" excludes both `awake` AND `no_data` (sensor-gap) windows —
      // see app/api/whoop/sync/route.ts for the original comment.
      const asleepMs =
        stages.total_light_sleep_time_milli +
        stages.total_slow_wave_sleep_time_milli +
        stages.total_rem_sleep_time_milli;
      row.sleep_hours = +(asleepMs / 3_600_000).toFixed(2);
      row.deep_sleep_hours = +(stages.total_slow_wave_sleep_time_milli / 3_600_000).toFixed(2);
      row.rem_sleep_hours = +(stages.total_rem_sleep_time_milli / 3_600_000).toFixed(2);
    }
    if (s.score.sleep_performance_percentage != null) {
      row.sleep_score = s.score.sleep_performance_percentage;
    }
    const respRate = (s.score as { respiratory_rate?: number }).respiratory_rate;
    if (respRate != null) {
      row.respiratory_rate = respRate;
    }
  }

  // 3. Recoveries → hrv, resting_hr, recovery, spo2, skin_temp_c
  for (const r of recovery) {
    if (!r.score) continue;
    const date =
      sleepIdToDate.get(r.sleep_id) ??
      ymdInUserTz(new Date(r.created_at));
    const row = ensure(date);
    row.hrv = r.score.hrv_rmssd_milli;
    row.resting_hr = r.score.resting_heart_rate;
    row.recovery = r.score.recovery_score;
    row.spo2 = r.score.spo2_percentage ?? null;
    row.skin_temp_c = r.score.skin_temp_celsius ?? null;
  }

  return Array.from(byDate.values());
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```

Expected: clean. Module has zero callers yet.

- [ ] **Step 3: Commit**

```bash
git add lib/whoop-day-rows.ts
git commit -m "feat(whoop): extract buildWhoopDayRows pure builder"
```

## Task 2.3: Patch WHOOP sync route to use the extracted builder

The current handler does the keying inline (lines ~39–125). Replace the inline logic with a call to `buildWhoopDayRows(...)`, and keep the counts computation (which the response shape depends on).

**Files:**
- Modify: [app/api/whoop/sync/route.ts](../../../app/api/whoop/sync/route.ts)

- [ ] **Step 1: Read the current handler**

```bash
sed -n '1,170p' "/Users/abdelouahedelbied/Health app/app/api/whoop/sync/route.ts"
```

Identify these regions:
- Lines 1–13: imports + `MS_PER_DAY` constant
- Lines 14–24: `SyncCounts` type
- Lines 26–141: `syncForUser` function
- Lines 39–63: inline `DayRow` type + `byDate` map setup (will be removed)
- Lines 77–125: the three keying loops (will be replaced with `buildWhoopDayRows` + counts-only loops)
- Lines 127–141: upsert + return

- [ ] **Step 2: Update imports**

Replace lines 1–11 with:

```ts
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGet,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";
import { buildWhoopDayRows } from "@/lib/whoop-day-rows";
```

- [ ] **Step 3: Remove the inline `DayRow` type and `byDate`/`ensure` helpers**

Delete the entire block from `type DayRow = {` (around line 39) through the closing of the `ensure` arrow function (around line 63). The shared builder owns this now.

- [ ] **Step 4: Replace the three keying loops with one builder call + counts**

Find the section that starts with `// Build a sleep_id → wake-up date index ...` (around line 77) and ends just before `if (byDate.size === 0)` (around line 127). Replace ALL of that with:

```ts
  // Counts are computed before delegating to the shared builder, since the
  // response shape includes them and the builder is a pure row-constructor.
  for (const r of recovery.records) {
    if (r.score_state === "PENDING_SCORE") counts.recovery_pending += 1;
    else if (r.score_state === "UNSCORABLE") counts.recovery_unscorable += 1;
    if (r.score) counts.recovery_scored += 1;
  }
  for (const c of cycles.records) {
    if (c.score) counts.cycles_scored += 1;
  }
  for (const s of sleep.records) {
    if (s.score) counts.sleep_scored += 1;
  }

  const rows = buildWhoopDayRows(userId, recovery.records, cycles.records, sleep.records);
```

- [ ] **Step 5: Update the upsert + return block**

Find:
```ts
  if (byDate.size === 0) return { ok: true, ...counts };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(Array.from(byDate.values()), { onConflict: "user_id,date" });
  if (error) throw error;
  counts.upserted = byDate.size;
```

Replace with:

```ts
  if (rows.length === 0) return { ok: true, ...counts };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(rows, { onConflict: "user_id,date" });
  if (error) throw error;
  counts.upserted = rows.length;
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Confirm no UTC slices remain in the route**

```bash
grep -n "\.slice(0, 10)" "/Users/abdelouahedelbied/Health app/app/api/whoop/sync/route.ts"
```

Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add app/api/whoop/sync/route.ts
git commit -m "refactor(whoop/sync): use buildWhoopDayRows; drop inline keying"
```

## Task 2.4: Patch WHOOP backfill route to use the extracted builder

Same pattern as Task 2.3, applied to the backfill route.

**Files:**
- Modify: [app/api/whoop/backfill/route.ts](../../../app/api/whoop/backfill/route.ts)

- [ ] **Step 1: Read the current handler**

```bash
sed -n '1,160p' "/Users/abdelouahedelbied/Health app/app/api/whoop/backfill/route.ts"
```

The shape mirrors the sync route: imports, `DayRow` type (line ~14), `Promise.all` fetching paginated data, three keying loops with `s.end.slice(0, 10)` patterns, then upsert.

- [ ] **Step 2: Update imports**

Replace the existing imports with:

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGetAll,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";
import { buildWhoopDayRows } from "@/lib/whoop-day-rows";
```

- [ ] **Step 3: Remove the inline `DayRow` type and `byDate`/`ensure` helpers**

Delete the entire `type DayRow = { ... }` block and the `byDate`/`ensure` helpers (around lines 14–48 of the current file — adjust based on actual layout).

- [ ] **Step 4: Replace the three keying loops with one builder call**

Find the section starting with the comment about sleep_id index or the first `for (const r of recovery)` loop. Replace ALL three loops with:

```ts
  const rows = buildWhoopDayRows(user.id, recovery, cycles, sleep);
```

- [ ] **Step 5: Update the upsert + return block**

Find the existing upsert that iterates `Array.from(byDate.values())` and chunks for upsert. Replace with:

```ts
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      upserted: 0,
      counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
    });
  }

  const sr = createSupabaseServiceRoleClient();
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sr.from("daily_logs").upsert(chunk, { onConflict: "user_id,date" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    upserted += chunk.length;
  }

  return NextResponse.json({
    ok: true,
    upserted,
    counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
  });
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
```

```bash
grep -n "\.slice(0, 10)" "/Users/abdelouahedelbied/Health app/app/api/whoop/backfill/route.ts"
```

Expected: typecheck clean, grep empty.

- [ ] **Step 7: Commit**

```bash
git add app/api/whoop/backfill/route.ts
git commit -m "refactor(whoop/backfill): use buildWhoopDayRows; drop inline keying"
```

## Task 2.5: Patch Withings merge + Withings backfill route

Two small patches. The Withings merge function does the measurement-group keying; the backfill route uses `endYmd` for the activity-fetch window upper bound.

**Files:**
- Modify: [lib/withings-merge.ts](../../../lib/withings-merge.ts)
- Modify: [app/api/withings/backfill/route.ts](../../../app/api/withings/backfill/route.ts)

- [ ] **Step 1: Patch [lib/withings-merge.ts](../../../lib/withings-merge.ts)**

Add at the top of the file (after the existing imports):

```ts
import { ymdInUserTz } from "@/lib/time";
```

Find line 48:

```ts
    const date = new Date(grp.date * 1000).toISOString().slice(0, 10);
```

Replace with:

```ts
    const date = ymdInUserTz(new Date(grp.date * 1000));
```

- [ ] **Step 2: Patch [app/api/withings/backfill/route.ts](../../../app/api/withings/backfill/route.ts)**

Add to the imports near the top:

```ts
import { todayInUserTz } from "@/lib/time";
```

Find line 31:

```ts
  const endYmd = new Date().toISOString().slice(0, 10);
```

Replace with:

```ts
  const endYmd = todayInUserTz();
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```

```bash
grep -n "\.toISOString()\.slice(0, 10)" "/Users/abdelouahedelbied/Health app/lib/withings-merge.ts" "/Users/abdelouahedelbied/Health app/app/api/withings/backfill/route.ts"
```

Expected: typecheck clean, grep empty (note: the Withings backfill route has another `.slice(0, 10)` at line ~32 for `startYmd` derived from a parsed Date — that's also UTC-sliced from a Date object, but it's slicing `since.toISOString()` not `new Date().toISOString()`. The `since` Date is constructed from a YYYY-MM-DD string at midnight UTC, so its slice is identical to the input string. That's intentional and stays UTC. The grep will match this line — ignore it; the patch was specifically for `endYmd`).

- [ ] **Step 4: Commit**

```bash
git add lib/withings-merge.ts app/api/withings/backfill/route.ts
git commit -m "refactor(withings): user-tz keying for measurements + backfill end date"
```

## Task 2.6: Verify Slice 2 end-to-end

No commit. Run the full verification per the spec.

- [ ] **Step 1: Type-check**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 2: Confirm no UTC slices remain in any in-scope file**

```bash
grep -rn "\.toISOString()\.slice(0, 10)" "/Users/abdelouahedelbied/Health app/app/api/whoop" "/Users/abdelouahedelbied/Health app/lib/withings-merge.ts"
```

Expected: empty.

```bash
grep -rn "\.slice(0, 10)" "/Users/abdelouahedelbied/Health app/app/api/whoop"
```

Expected: empty (sync and backfill both delegate to `buildWhoopDayRows` now).

- [ ] **Step 3: Build check**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 4: Manual sync smoke (optional, requires dev server + auth)**

If a dev server is running and you're logged in:

```bash
/usr/bin/curl -s -o - -w "\nHTTP %{http_code}\n" -X GET --max-time 30 \
  -H "cookie: <your-session-cookie>" \
  http://localhost:3000/api/whoop/sync
```

Or: open the dashboard in a browser and click the WHOOP sync refresh button. Confirm a successful response. Inspect Supabase `daily_logs` for any newly-written rows — dates should reflect user-local wake-up day. (Right now, your real-clock won't trigger the bug since there's no boundary-crossing wakeup happening at this exact moment; this is a sanity check that nothing broke, not a behavioral verification.)

If verification passes: Slice 2 done. Move to Slice 3.

---

# Slice 3 — Re-key scripts

Goal: two one-shot Node scripts that re-key recent history. Run once after the fix deploys; never run again. Each script: re-fetches from the source API, prompts for confirmation (or `--yes` to skip), clears the owned columns over the window, upserts the freshly-fetched data, prints a date-level diff.

## Task 3.1: Create `scripts/rekey-whoop.mts`

**Files:**
- Create: [scripts/rekey-whoop.mts](../../../scripts/rekey-whoop.mts)

- [ ] **Step 1: Write the script**

Create `scripts/rekey-whoop.mts` with this exact content:

```ts
// scripts/rekey-whoop.mts
//
// One-shot WHOOP re-key. Re-fetches recovery/cycle/sleep records from WHOOP,
// clears WHOOP-owned columns in daily_logs over the window, then upserts the
// freshly-built rows. Prints a date-level diff so you can see whether the bug
// actually moved any rows.
//
// Run from the repo root:
//   node --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts
//   node --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2026-04-05
//   node --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2026-04-05 --yes
//
// Required env (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET
// Optional:
//   USER_TIMEZONE (default Asia/Dubai), SEED_USER_EMAIL (default abdelouahed.elbied@icloud.com)

import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { buildWhoopDayRows } from "../lib/whoop-day-rows.ts";
import type { WhoopRecovery, WhoopCycle, WhoopSleep } from "../lib/whoop.ts";
import { todayInUserTz } from "../lib/time.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const clientId = process.env.WHOOP_CLIENT_ID;
const clientSecret = process.env.WHOOP_CLIENT_SECRET;
const userEmail = process.env.SEED_USER_EMAIL || "abdelouahed.elbied@icloud.com";

if (!url || !key || !clientId || !clientSecret) {
  console.error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET",
  );
  process.exit(1);
}

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let sinceArg: string | null = null;
let skipPrompt = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since" && args[i + 1]) {
    sinceArg = args[i + 1];
    i++;
  } else if (args[i] === "--yes") {
    skipPrompt = true;
  }
}

const today = todayInUserTz();
const since = sinceArg ?? (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
})();

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error(`Invalid --since: ${since} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// ── Resolve user ─────────────────────────────────────────────────────────────
const { data: usersList, error: lerr } = await supabase.auth.admin.listUsers({
  page: 1,
  perPage: 200,
});
if (lerr) throw lerr;
const user = usersList.users.find((u) => u.email?.toLowerCase() === userEmail.toLowerCase());
if (!user) {
  console.error(`No auth user found with email ${userEmail}`);
  process.exit(1);
}
const userId = user.id;

// ── Refresh WHOOP token ──────────────────────────────────────────────────────
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

const { data: tokenRow, error: terr } = await supabase
  .from("whoop_tokens")
  .select("*")
  .eq("user_id", userId)
  .maybeSingle();
if (terr) throw terr;
if (!tokenRow) {
  console.error("No whoop_tokens row for this user. Connect WHOOP first.");
  process.exit(1);
}

let accessToken: string = tokenRow.access_token;
const expiresAt = new Date(tokenRow.expires_at).getTime();
if (Date.now() >= expiresAt - 60_000) {
  console.log("Access token near-expiry — refreshing.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenRow.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    scope: "read:recovery read:sleep read:cycles read:workout read:profile offline",
  });
  const r = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    console.error(`Refresh failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const refreshed = await r.json();
  accessToken = refreshed.access_token;
  const newExpires = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const { error: serr } = await supabase
    .from("whoop_tokens")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: newExpires,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (serr) throw serr;
}

// ── Pagination ───────────────────────────────────────────────────────────────
async function whoopGetAll<T>(basePath: string, sinceIso: string): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  for (let i = 0; i < 200; i++) {
    const qs = new URLSearchParams({ start: sinceIso, limit: "25" });
    if (nextToken) qs.set("nextToken", nextToken);
    const r = await fetch(`${WHOOP_API_BASE}${basePath}?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      throw new Error(`WHOOP GET ${basePath} failed: ${r.status} ${await r.text()}`);
    }
    const page = (await r.json()) as { records: T[]; next_token?: string };
    out.push(...(page.records ?? []));
    nextToken = page.next_token;
    if (!nextToken) break;
  }
  return out;
}

// ── Re-fetch BEFORE clearing (abort on error) ────────────────────────────────
const sinceIso = `${since}T00:00:00.000Z`;
console.log(`Window: ${since} → ${today}  (user: ${userEmail})`);
console.log("Re-fetching from WHOOP …");

let recovery: WhoopRecovery[];
let cycles: WhoopCycle[];
let sleep: WhoopSleep[];
try {
  [recovery, cycles, sleep] = await Promise.all([
    whoopGetAll<WhoopRecovery>("/v2/recovery", sinceIso),
    whoopGetAll<WhoopCycle>("/v2/cycle", sinceIso),
    whoopGetAll<WhoopSleep>("/v2/activity/sleep", sinceIso),
  ]);
} catch (e) {
  console.error(`WHOOP fetch failed; aborting before clear. ${String(e)}`);
  process.exit(1);
}
console.log(`  recovery: ${recovery.length}, cycles: ${cycles.length}, sleep: ${sleep.length}`);

const rows = buildWhoopDayRows(userId, recovery, cycles, sleep);
console.log(`  builder produced ${rows.length} day-rows`);

// ── Snapshot before-state ────────────────────────────────────────────────────
const SNAPSHOT_COLS =
  "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, " +
  "deep_sleep_hours, rem_sleep_hours, strain, spo2, skin_temp_c, respiratory_rate";

type Snapshot = Record<string, Record<string, number | null>>;
async function snapshotWindow(): Promise<Snapshot> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(SNAPSHOT_COLS)
    .eq("user_id", userId)
    .gte("date", since)
    .lte("date", today);
  if (error) throw error;
  const out: Snapshot = {};
  for (const row of data ?? []) {
    const { date, ...cols } = row as { date: string; [k: string]: number | null };
    out[date] = cols;
  }
  return out;
}

const before = await snapshotWindow();
const beforeWithData = Object.entries(before).filter(
  ([, cols]) => cols.hrv !== null || cols.strain !== null || cols.recovery !== null,
).length;
console.log(`Rows in window with WHOOP data: ${beforeWithData}`);

// ── Confirm prompt ───────────────────────────────────────────────────────────
if (!skipPrompt) {
  console.log("\nAbout to clear + repopulate the following columns:");
  console.log("  hrv, resting_hr, recovery, sleep_hours, sleep_score,");
  console.log("  deep_sleep_hours, rem_sleep_hours, strain, spo2, skin_temp_c, respiratory_rate");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// ── Clear WHOOP-owned columns ────────────────────────────────────────────────
console.log("Clearing WHOOP-owned columns …");
const { error: clearErr } = await supabase
  .from("daily_logs")
  .update({
    hrv: null,
    resting_hr: null,
    recovery: null,
    sleep_hours: null,
    sleep_score: null,
    deep_sleep_hours: null,
    rem_sleep_hours: null,
    strain: null,
    spo2: null,
    skin_temp_c: null,
    respiratory_rate: null,
    updated_at: new Date().toISOString(),
  })
  .eq("user_id", userId)
  .gte("date", since)
  .lte("date", today);
if (clearErr) {
  console.error(`Clear failed: ${clearErr.message}`);
  process.exit(1);
}

// ── Upsert freshly-keyed rows ────────────────────────────────────────────────
console.log("Upserting rebuilt rows …");
const CHUNK = 500;
let upserted = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const { error } = await supabase
    .from("daily_logs")
    .upsert(chunk, { onConflict: "user_id,date" });
  if (error) {
    console.error(`Upsert chunk failed: ${error.message}`);
    console.error("Cleared columns are NOT repopulated. To recover, re-run this script.");
    process.exit(1);
  }
  upserted += chunk.length;
}

// ── Diff ─────────────────────────────────────────────────────────────────────
const after = await snapshotWindow();
const allDates = new Set([...Object.keys(before), ...Object.keys(after)]);
let changed = 0;
const lines: string[] = [];
for (const d of [...allDates].sort()) {
  const b = before[d];
  const a = after[d];
  if (JSON.stringify(b) === JSON.stringify(a)) continue;
  changed += 1;
  if (!b || Object.values(b).every((v) => v === null)) {
    lines.push(`  ${d}  repopulated`);
  } else if (!a || Object.values(a).every((v) => v === null)) {
    lines.push(`  ${d}  cleared (data may have moved to another date in window)`);
  } else {
    const fields: string[] = [];
    for (const k of Object.keys(b)) {
      if (b[k] !== a[k]) fields.push(`${k}: ${b[k]} → ${a[k]}`);
    }
    lines.push(`  ${d}  mutated (${fields.slice(0, 3).join(", ")}${fields.length > 3 ? ", …" : ""})`);
  }
}

console.log("\nRekey complete:");
console.log(`  window:                    ${since} → ${today}`);
console.log(`  rows upserted:             ${upserted}`);
console.log(`  dates with changed values: ${changed}`);
for (const l of lines) console.log(l);
if (changed === 0) {
  console.log("\nThe bug never bit your data in this window — the rekey was a no-op.");
}
```

- [ ] **Step 2: Verify the script compiles under `--experimental-strip-types`**

```bash
node --experimental-strip-types --env-file="/Users/abdelouahedelbied/Health app/.env.local" -e "import('/Users/abdelouahedelbied/Health app/scripts/rekey-whoop.mts').then(() => console.log('imported ok'))" 2>&1 | head -10
```

This won't run the script (it'll execute the top-level await chain — to avoid that, prefer the next step). The next step is the real test.

- [ ] **Step 3: Dry-run on a tiny window with the prompt visible**

```bash
cd "/Users/abdelouahedelbied/Health app" && \
node --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2026-05-04
```

Expected:
- "Re-fetching from WHOOP …" line
- Counts printed
- "About to clear + repopulate …" prompt
- Type `n` to abort. Confirm "Aborted." prints and process exits 0.

- [ ] **Step 4: Real run with `--yes` on the same tiny window**

```bash
cd "/Users/abdelouahedelbied/Health app" && \
node --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2026-05-04 --yes
```

Expected:
- Re-fetch succeeds
- Clear succeeds
- Upsert succeeds
- Diff prints (likely "0 dates with changed values" since the test window is too small for the bug to bite at this moment)

- [ ] **Step 5: Commit**

```bash
git add scripts/rekey-whoop.mts
git commit -m "feat(scripts): one-shot WHOOP rekey with date-level diff"
```

## Task 3.2: Create `scripts/rekey-withings.mts`

Same shape as Task 3.1, swapping in Withings sources and owned columns.

**Files:**
- Create: [scripts/rekey-withings.mts](../../../scripts/rekey-withings.mts)

- [ ] **Step 1: Write the script**

Create `scripts/rekey-withings.mts` with this exact content:

```ts
// scripts/rekey-withings.mts
//
// One-shot Withings re-key for body-comp measurements. Re-fetches measure
// groups from Withings, clears Withings body-comp columns in daily_logs over
// the window, then upserts freshly-keyed rows. Prints a date-level diff.
//
// NOTE: `exercise_min` is intentionally NOT touched. WithingsActivity.date
// already arrives as YYYY-MM-DD from the API (never UTC-sliced), so it was
// never a bug site. Apple Health also writes that column; clearing would
// silently destroy data.
//
// Run from the repo root:
//   node --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts
//   node --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts --since 2026-04-05 --yes
//
// Required env (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET

import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mergeWithingsToRows } from "../lib/withings-merge.ts";
import { getMeasures, getValidAccessToken } from "../lib/withings.ts";
import { todayInUserTz } from "../lib/time.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userEmail = process.env.SEED_USER_EMAIL || "abdelouahed.elbied@icloud.com";

if (!url || !key) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
let sinceArg: string | null = null;
let skipPrompt = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since" && args[i + 1]) {
    sinceArg = args[i + 1];
    i++;
  } else if (args[i] === "--yes") {
    skipPrompt = true;
  }
}

const today = todayInUserTz();
const since = sinceArg ?? (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
})();

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error(`Invalid --since: ${since} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: usersList, error: lerr } = await supabase.auth.admin.listUsers({
  page: 1,
  perPage: 200,
});
if (lerr) throw lerr;
const user = usersList.users.find((u) => u.email?.toLowerCase() === userEmail.toLowerCase());
if (!user) {
  console.error(`No auth user found with email ${userEmail}`);
  process.exit(1);
}
const userId = user.id;

// ── Withings token (uses lib/withings.ts which handles refresh) ──────────────
const accessToken = await getValidAccessToken(userId);
if (!accessToken) {
  console.error("No Withings tokens for this user. Connect Withings first.");
  process.exit(1);
}

// ── Re-fetch BEFORE clearing ─────────────────────────────────────────────────
const startEpoch = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
const endEpoch = Math.floor(Date.now() / 1000);

console.log(`Window: ${since} → ${today}  (user: ${userEmail})`);
console.log("Re-fetching Withings measurements …");

let measureGroups;
try {
  measureGroups = await getMeasures(accessToken, startEpoch, endEpoch);
} catch (e) {
  console.error(`Withings fetch failed; aborting before clear. ${String(e)}`);
  process.exit(1);
}
console.log(`  measurement groups: ${measureGroups.length}`);

// Build rows using only measurements (skip activity — exercise_min isn't in scope).
const byDate = mergeWithingsToRows(userId, measureGroups, []);
const rows = Array.from(byDate.values());
console.log(`  builder produced ${rows.length} day-rows`);

// ── Snapshot before ──────────────────────────────────────────────────────────
const SNAPSHOT_COLS =
  "date, weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, " +
  "muscle_mass_kg, bone_mass_kg, hydration_kg";

type Snapshot = Record<string, Record<string, number | null>>;
async function snapshotWindow(): Promise<Snapshot> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(SNAPSHOT_COLS)
    .eq("user_id", userId)
    .gte("date", since)
    .lte("date", today);
  if (error) throw error;
  const out: Snapshot = {};
  for (const row of data ?? []) {
    const { date, ...cols } = row as { date: string; [k: string]: number | null };
    out[date] = cols;
  }
  return out;
}

const before = await snapshotWindow();
const beforeWithData = Object.entries(before).filter(
  ([, cols]) => cols.weight_kg !== null || cols.body_fat_pct !== null,
).length;
console.log(`Rows in window with Withings body-comp data: ${beforeWithData}`);

// ── Confirm prompt ───────────────────────────────────────────────────────────
if (!skipPrompt) {
  console.log("\nAbout to clear + repopulate the following columns:");
  console.log("  weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg,");
  console.log("  muscle_mass_kg, bone_mass_kg, hydration_kg");
  console.log("(exercise_min is NOT touched — see header comment.)");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// ── Clear ────────────────────────────────────────────────────────────────────
console.log("Clearing Withings body-comp columns …");
const { error: clearErr } = await supabase
  .from("daily_logs")
  .update({
    weight_kg: null,
    body_fat_pct: null,
    fat_mass_kg: null,
    fat_free_mass_kg: null,
    muscle_mass_kg: null,
    bone_mass_kg: null,
    hydration_kg: null,
    updated_at: new Date().toISOString(),
  })
  .eq("user_id", userId)
  .gte("date", since)
  .lte("date", today);
if (clearErr) {
  console.error(`Clear failed: ${clearErr.message}`);
  process.exit(1);
}

// ── Upsert ───────────────────────────────────────────────────────────────────
console.log("Upserting rebuilt rows …");
const CHUNK = 500;
let upserted = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const { error } = await supabase
    .from("daily_logs")
    .upsert(chunk, { onConflict: "user_id,date" });
  if (error) {
    console.error(`Upsert chunk failed: ${error.message}`);
    console.error("Cleared columns are NOT repopulated. To recover, re-run this script.");
    process.exit(1);
  }
  upserted += chunk.length;
}

// ── Diff ─────────────────────────────────────────────────────────────────────
const after = await snapshotWindow();
const allDates = new Set([...Object.keys(before), ...Object.keys(after)]);
let changed = 0;
const lines: string[] = [];
for (const d of [...allDates].sort()) {
  const b = before[d];
  const a = after[d];
  if (JSON.stringify(b) === JSON.stringify(a)) continue;
  changed += 1;
  if (!b || Object.values(b).every((v) => v === null)) {
    lines.push(`  ${d}  repopulated`);
  } else if (!a || Object.values(a).every((v) => v === null)) {
    lines.push(`  ${d}  cleared (data may have moved to another date in window)`);
  } else {
    const fields: string[] = [];
    for (const k of Object.keys(b)) {
      if (b[k] !== a[k]) fields.push(`${k}: ${b[k]} → ${a[k]}`);
    }
    lines.push(`  ${d}  mutated (${fields.slice(0, 3).join(", ")}${fields.length > 3 ? ", …" : ""})`);
  }
}

console.log("\nRekey complete:");
console.log(`  window:                    ${since} → ${today}`);
console.log(`  rows upserted:             ${upserted}`);
console.log(`  dates with changed values: ${changed}`);
for (const l of lines) console.log(l);
if (changed === 0) {
  console.log("\nThe bug never bit your data in this window — the rekey was a no-op.");
}
```

- [ ] **Step 2: Dry-run on a tiny window with the prompt visible**

```bash
cd "/Users/abdelouahedelbied/Health app" && \
node --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts --since 2026-05-04
```

Expected:
- Re-fetch succeeds
- Counts printed
- Prompt visible — type `n` to abort

- [ ] **Step 3: Real run with `--yes` on the same tiny window**

```bash
cd "/Users/abdelouahedelbied/Health app" && \
node --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts --since 2026-05-04 --yes
```

Expected: complete with diff printed.

- [ ] **Step 4: Commit**

```bash
git add scripts/rekey-withings.mts
git commit -m "feat(scripts): one-shot Withings rekey with date-level diff"
```

## Task 3.3: Verify Slice 3 + run for real

No commit. Run the rekey for the actual 30-day default window after confirming the small-window runs worked.

- [ ] **Step 1: Type-check the full project**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck
```

Expected: clean.

- [ ] **Step 2: Run WHOOP rekey on the 30-day default**

Verify the cron isn't about to fire (Vercel cron `/api/whoop/sync` runs at 08:00 UTC daily; pick a moment that's not within ~10 minutes of that). Then:

```bash
cd "/Users/abdelouahedelbied/Health app" && \
node --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --yes
```

Expected:
- Counts printed (should match roughly 30 sleep records, 30 cycle records, 30 recovery records for an active user)
- Diff printed
- "dates with changed values: N" — expect a small number (single digits) for a Dubai-resident user, since the bug only bit on early-morning wakeups

- [ ] **Step 3: Run Withings rekey on the 30-day default**

```bash
cd "/Users/abdelouahedelbied/Health app" && \
node --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts --yes
```

Expected:
- Counts printed
- Diff printed
- Likely "dates with changed values: 0" (very unusual to weigh yourself between 00:00–04:00)

- [ ] **Step 4: Spot-check a moved date (if any)**

For each date the WHOOP diff reported as `cleared` or `repopulated`, open the dashboard date pager to that date and inspect: does the data look right? E.g., if April 15 was cleared and April 16 was repopulated with sleep data, that's the expected pattern — sleep that ended at 02:30 Dubai on April 16 was originally keyed to April 15 (UTC), now correctly on April 16.

- [ ] **Step 5: Confirm cron sync still works**

After the next 08:00 UTC cron firing (or trigger a manual sync via the dashboard refresh button), confirm no errors and that newly-arrived rows continue to use user-tz keying.

If verification passes: Slice 3 done. The full design ships.

---

# Final pass

After all three slices commit:

- [ ] **Run full project verification**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npm run build
```

Expected: both clean.

- [ ] **Confirm sweep completeness**

```bash
grep -rn "\.toISOString()\.slice(0, 10)" "/Users/abdelouahedelbied/Health app/app" "/Users/abdelouahedelbied/Health app/lib"
```

Expected matches: only intentional ones — the `Date.now()`-derived `since` cutoffs in insights routes (per the previous spec's deliberate decision), and any other UTC-anchored window math. No date-keying call sites should remain.

- [ ] **Document the rekey in the project README or a runbook (optional)**

The scripts are one-shot. After running them once, they're effectively deprecated. Consider adding a one-line note to [CLAUDE.md](../../../CLAUDE.md) under a "Historical operations" section so future-you knows they exist and what they did.

- [ ] **Update any travel-mode-relevant docs (optional)**

If you ever travel and want to verify L1 works: spot-check a single sleep record in WHOOP's UI vs `daily_logs.date` after a week abroad. They should agree even though `USER_TIMEZONE` is still `Asia/Dubai`.
