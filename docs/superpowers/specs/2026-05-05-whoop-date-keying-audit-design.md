# WHOOP / Withings date-keying audit + travel mode (L1) — design

**Status:** approved (spec)
**Date:** 2026-05-05
**Owner:** Abdelouahed

## Summary

Three coordinated changes in one design.

**A. Forward fix.** Every server-side date-keying call site that derives a `daily_logs.date` from a Z-suffixed ISO timestamp by string-slicing UTC is patched to produce a user-local YYYY-MM-DD. Affects WHOOP sync (3 sites), WHOOP backfill (3 sites), Withings merge (1 site), Withings backfill (1 site).

**B. WHOOP travel mode (L1).** WHOOP returns a `timezone_offset` field on cycle and workout records. The patched sync uses each cycle's own offset for cycle keying, and a small cycle-tz lookup so sleep and recovery records inherit the tz of the cycle that contains them. While at home in Dubai this is identical to using `USER_TIMEZONE`; while traveling, rows land on travel-local calendar days. Withings stays on `USER_TIMEZONE` — no per-record tz available; weighing yourself abroad keys to home tz (acceptable for L1).

**C. One-shot historical re-key.** Two new node scripts (`scripts/rekey-whoop.mjs`, `scripts/rekey-withings.mjs`) clear the WHOOP/Withings-owned columns over a configurable window (default 30 days) and re-run the patched sync logic to repopulate. Run once from the dev box after the fix deploys; never run again. Always-prompt confirmation, with `--yes` flag to skip. Diff output shows which rows moved dates.

The fix preserves the existing date-keying *rule* (sleep keyed on wake-up, cycle keyed on its start = previous wake-up, Withings measurement keyed on the timestamp's calendar day). Only the timezone definition of "the day" changes — UTC → user-local (or per-record offset, for WHOOP).

## Decisions

| # | Decision | Notes |
|---|---|---|
| 1 | Patch every server-side date-keying UTC slice | 8 call sites total across WHOOP + Withings sync paths |
| 2 | Include Withings in the same fix | Same pattern as WHOOP; bundling avoids forgotten follow-up |
| 3 | Travel mode — Level 1 only (per-record WHOOP offset) | Defer L2 (manual override) and L3 (browser auto-detect) to future specs |
| 4 | Withings stays on `USER_TIMEZONE` (no per-record tz) | Weighing abroad mis-keys; rare in practice |
| 5 | Date-keying rule unchanged | Sleep on wake-up, cycle on start, recovery on linked sleep — only the tz frame changes |
| 6 | Re-key recent history (30d default), not full backfill | API-quota-friendly; bug only bites narrow window so most rows already correct |
| 7 | One-shot scripts, not new HTTP endpoints | Avoids leaving a destructive footgun in the route surface |
| 8 | NULL-then-repopulate strategy in re-key | Pure forward sync wouldn't fix mis-keyed historical rows |
| 9 | Always-prompt confirmation, `--yes` to skip | Manual destructive op gets a confirmation gate |
| 10 | Diff output included in re-key scripts | Surfaces whether the bug actually bit user data; ~30 LOC for the strongest signal |
| 11 | No new dependencies | Pure stdlib + existing service-role client + `node --experimental-strip-types` |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  lib/time.ts (extended)                                          │
│  + ymdInUserTz(when)         → YYYY-MM-DD in USER_TIMEZONE       │
│  + ymdInZoneOffset(when, off)→ YYYY-MM-DD in fixed offset like   │
│                                "+04:00" / "-05:00" (WHOOP travel)│
└────────────┬───────────────────────────────────┬─────────────────┘
             │                                   │
             ▼                                   ▼
┌──────────────────────────┐         ┌──────────────────────────┐
│ WHOOP sync + backfill    │         │ Withings merge + backfill│
│ • cycle.timezone_offset  │         │ • USER_TIMEZONE only     │
│ • cycle-tz lookup for    │         │ • measurement timestamps │
│   sleep + recovery       │         │   keyed via ymdInUserTz  │
│ • USER_TIMEZONE fallback │         │                          │
└────────────┬─────────────┘         └────────────┬─────────────┘
             │                                    │
             └──────────────┬─────────────────────┘
                            ▼
                ┌────────────────────────┐
                │ daily_logs (correctly  │
                │ keyed going forward)   │
                └────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  scripts/rekey-whoop.mjs   ─┐                                    │
│  scripts/rekey-withings.mjs ─┴── one-shot, run after fix lands   │
│                                                                  │
│  for each script:                                                │
│    1. parse --since (default 30d ago) and optional --yes         │
│    2. compute window [since, todayInUserTz()]                    │
│    3. count rows that will be cleared                            │
│    4. confirm prompt unless --yes                                │
│    5. NULL out owned columns over the window                     │
│    6. re-run patched sync logic (DRY: imports lib code, not HTTP)│
│    7. print diff: rows moved date, total cleared, total upserted │
└──────────────────────────────────────────────────────────────────┘
```

## `lib/time.ts` — two new exports

```ts
/** YYYY-MM-DD for a given UTC moment, in the user's configured timezone.
 *  Use for syncs that don't carry per-record tz info (Withings, fallbacks). */
export function ymdInUserTz(when: Date): string {
  return todayInUserTz(when);
}

/** YYYY-MM-DD for a given UTC moment, in a specific fixed-offset zone like
 *  "+04:00" or "-05:00". Used by WHOOP keying — WHOOP returns a per-record
 *  `timezone_offset` on cycles/workouts that we honor for travel mode. */
export function ymdInZoneOffset(when: Date, offset: string): string {
  const sign = offset[0] === "-" ? -1 : 1;
  const [hh, mm] = offset.slice(1).split(":").map(Number);
  const offsetMs = sign * (hh * 3_600_000 + mm * 60_000);
  return new Date(when.getTime() + offsetMs).toISOString().slice(0, 10);
}
```

`ymdInUserTz` is a renamed alias of the existing `todayInUserTz` for read clarity at the call site (`todayInUserTz(new Date(s.end))` reads "what's today of this past moment?" — confusing; `ymdInUserTz(new Date(s.end))` reads cleanly). Same function under the hood.

`ymdInZoneOffset` works for fixed-offset jurisdictions. WHOOP's `timezone_offset` is a per-record fixed offset for that moment — DST is implicitly handled by WHOOP recording the offset at the time the record was generated, so we don't need an Intl-based DST-aware path.

## Sweep map (Slice 2: forward fix)

**`app/api/whoop/sync/route.ts`** — 3 sites:

- `s.end.slice(0, 10)` (sleep wake-up keying, used in `sleepIdToDate` and the sleep loop): replaced with cycle-tz lookup → `ymdInZoneOffset(new Date(s.end), cycleTz)`, fallback `ymdInUserTz(new Date(s.end))`.
- `c.start.slice(0, 10)` (cycle keying): replaced with `ymdInZoneOffset(new Date(c.start), c.timezone_offset)`.
- `r.created_at.slice(0, 10)` (recovery fallback): replaced with `ymdInUserTz(new Date(r.created_at))`. The primary recovery path uses `sleepIdToDate.get(r.sleep_id)` which already inherits the corrected sleep keying.

**Order within the sync handler** must change. Today's handler does: build sleep-id→date map (UTC slice) → process recoveries → process cycles → process sleeps. The new handler needs cycle data available before sleep/recovery keying, since both depend on the cycle-tz lookup. New order:

1. Build cycle-tz lookup from `cycles.records`. Single loop also writes `strain` to row data (no cost to combine).
2. Process sleeps using the lookup. This loop builds `sleepIdToDate` AND writes `sleep_*` row data (today's two sleep loops collapse into one).
3. Process recoveries using `sleepIdToDate.get(r.sleep_id)` (correct dates) with `ymdInUserTz(new Date(r.created_at))` fallback.

**`app/api/whoop/backfill/route.ts`** — same 3 patterns repeated. The backfill route paginates over a larger window via `whoopGetAll`; the keying logic at the bottom of the route is the same shape. Apply the identical patches.

**`lib/withings-merge.ts:48`** — 1 site:

```ts
// before
const date = new Date(grp.date * 1000).toISOString().slice(0, 10);
// after
const date = ymdInUserTz(new Date(grp.date * 1000));
```

**`app/api/withings/backfill/route.ts:31`** — 1 site:

```ts
// before
const endYmd = new Date().toISOString().slice(0, 10);
// after
const endYmd = todayInUserTz();
```

This is the call site the previous spec deliberately deferred to "the WHOOP audit follow-up" — it lands here.

## Cycle-tz lookup helper

Extract to `lib/whoop-tz.ts` so both sync and backfill routes can import it.

```ts
import type { WhoopCycle } from "@/lib/whoop";

/** Build a function that, given a UTC moment, returns the timezone_offset
 *  of the cycle that contains it (e.g. "+04:00", "-05:00"), or null if no
 *  cycle in the input set covers it. */
export function buildCycleTzLookup(
  cycles: WhoopCycle[],
): (when: Date) => string | null {
  return (when: Date) => {
    const t = when.toISOString();
    for (const c of cycles) {
      // Open cycles (no `end`) are ongoing — treat as extending to "now+24h"
      // so any in-progress sleep is still matchable.
      const cycleEnd = c.end ?? new Date(Date.now() + 86_400_000).toISOString();
      if (c.start <= t && t <= cycleEnd) return c.timezone_offset;
    }
    return null;
  };
}
```

Linear scan is fine — sync windows hold 14–30 cycles; backfill windows up to ~700 (2 years × 1/day). Even a brute-force scan over 700 entries per record is microseconds.

## Re-key scripts

### `scripts/rekey-whoop.mjs`

```bash
# defaults: --since = 30d ago in user-tz; prompts for confirmation
node scripts/rekey-whoop.mjs

# explicit
node scripts/rekey-whoop.mjs --since 2026-04-05

# CI / non-interactive
node scripts/rekey-whoop.mjs --since 2026-04-05 --yes
```

**Flow:**

1. Parse `--since YYYY-MM-DD` (default: 30 days ago using `todayInUserTz()`-derived math) and optional `--yes`.
2. Resolve `userId`. Single-user app: read `whoop_tokens.user_id` (the only row). If multiple rows somehow exist, abort with an explicit error.
3. Compute `until = todayInUserTz()`. Window is `[since, until]` inclusive.
4. Snapshot the row count: `SELECT count(*) FROM daily_logs WHERE user_id=$1 AND date BETWEEN $2 AND $3 AND (hrv IS NOT NULL OR sleep_hours IS NOT NULL OR strain IS NOT NULL)`. Print:
   ```
   About to rekey WHOOP data for user <abc...123>:
     window: 2026-04-05 → 2026-05-05 (31 days)
     rows with WHOOP data in window: 28
     columns to clear: hrv, resting_hr, recovery, sleep_hours, sleep_score,
                       deep_sleep_hours, rem_sleep_hours, strain, spo2, skin_temp_c
   Proceed? [y/N]
   ```
5. Read stdin for confirmation (skipped if `--yes`).
6. Snapshot the *current* date keying: `SELECT date, hrv, sleep_hours, strain FROM daily_logs ...`. Build `oldKeying: Map<recordSignature, date>` so the diff can detect moves.
7. UPDATE: NULL out the WHOOP-owned columns:
   ```sql
   UPDATE daily_logs
     SET hrv = NULL, resting_hr = NULL, recovery = NULL,
         sleep_hours = NULL, sleep_score = NULL,
         deep_sleep_hours = NULL, rem_sleep_hours = NULL,
         strain = NULL, spo2 = NULL, skin_temp_c = NULL,
         updated_at = NOW()
     WHERE user_id = $1 AND date >= $2 AND date <= $3;
   ```
8. Call the patched WHOOP sync logic directly (imported as a function from the route's underlying lib — DRY; no HTTP roundtrip). The sync uses the patched keying, so re-population lands on correct dates.
9. After repopulation, query the same columns again. Build `newKeying: Map<recordSignature, date>`. Compute the diff:
   - `cleared`: rows whose owned columns went from non-NULL to NULL and stayed NULL (mis-keyed historical row whose data moved elsewhere)
   - `moved`: signature appearing on a different date than before
   - `repopulated`: rows newly populated
10. Print:
    ```
    Rekey complete:
      rows cleared (historical mis-keyed):  3
      rows repopulated:                     28
      records that moved date:              3
        2026-04-15 → 2026-04-16 (sleep)
        2026-04-22 → 2026-04-23 (sleep, strain)
        2026-05-01 → 2026-05-02 (sleep, strain, recovery)
    ```
    If "records that moved date" is 0, the bug never bit you for this window — the rekey was a no-op data-wise.

**`scripts/rekey-withings.mjs`** — identical flow with these substitutions:
- Owned columns cleared: `weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg, hydration_kg, exercise_min`
- Sync logic: `getMeasures` + `getActivity` + `mergeWithingsToRows` from `lib/withings*.ts`
- Diff signatures keyed on (measurement type, original epoch) instead of WHOOP IDs

### Manual-data preservation

Both scripts deliberately do NOT touch:
- `notes`, `readiness`, `energy_label`, `mood`, `soreness`, `feel_notes` — log-form check-in data
- `steps`, `calories`, `active_calories`, `distance_km` — Apple Health (Garmin) owned
- `calories_eaten`, `protein_g`, `carbs_g`, `fat_g` — Yazio owned
- `sleep_hours` written by Apple Health overrides — minor edge: if the user manually entered sleep into Apple Health, it currently lives in `sleep_hours`, which WHOOP also writes. WHOOP usually wins; the rekey will overwrite. This is the same behavior as the current sync. No regression.

## Build sequence

Three slices; recommended order for minimal coupling:

**Slice 1 — `lib/time.ts` extension.**
- Add `ymdInUserTz` and `ymdInZoneOffset`.
- `npm run typecheck` clean.
- One commit.

**Slice 2 — Forward fix + travel mode.**
- Patch the 8 call sites per the sweep map.
- Add the `buildCycleTzLookup` helper (extract to `lib/whoop-tz.ts` since both sync and backfill use it).
- Reorder the WHOOP sync handler so cycles are indexed first, then the cycle-tz lookup is built, then sleeps and recoveries can be keyed.
- `npm run typecheck` clean.
- Manual smoke: trigger a WHOOP sync via the dashboard refresh button. Confirm new rows in `daily_logs` reflect user-local wake-up date for any new sleep records. (No travel data right now means the offset honor is moot at this exact moment; the cycle-tz lookup returns `+04:00` for every record, so behavior is identical to `USER_TIMEZONE`.)
- One commit.

**Slice 3 — Re-key scripts.**
- Add `scripts/rekey-whoop.mjs`.
- Add `scripts/rekey-withings.mjs`.
- Test each with `--since` set to a 2-day window and `--yes` skipped — verify the prompt appears.
- Run with `--yes` on the same small window — verify the rekey completes, diff prints.
- Run for real with the 30d default. Inspect the diff output to confirm whether the bug actually bit your data.
- One commit per script (or one combined commit; they're symmetric).

## Verification (no test suite per CLAUDE.md)

- `npm run typecheck` clean
- `npm run build` clean
- WHOOP sync (dashboard refresh button) — no errors, new rows in expected user-tz dates
- Withings sync (Withings settings page or cron trigger) — same
- `node scripts/rekey-whoop.mjs --since 2026-05-03` — prompts, succeeds, prints diff for a tiny 2-day window
- `node scripts/rekey-withings.mjs --since 2026-05-03` — same
- Spot-check a few rows in the rekey window via the dashboard / Supabase table editor — values look right

## Risks acknowledged

- **WHOOP cycle records arriving out-of-order in the backfill paginator.** The cycle-tz lookup is built from the full cycles array after pagination completes. Ordering of `whoopGetAll` results doesn't affect correctness because the lookup function does a linear scan over the full array.
- **Open cycles (in-progress sleep, no `c.end`).** Treated as extending to `now + 24h` so the lookup still resolves. If a sleep ends before the cycle does (impossible by WHOOP semantics) the fallback `ymdInUserTz` kicks in.
- **WHOOP records returned with `timezone_offset = "+00:00"`.** Treat as legitimate UTC — `ymdInZoneOffset` handles `+00:00` correctly. (We've never observed this in practice for a Dubai-resident user, but the path is correct.)
- **Service role client in scripts.** Both rekey scripts use `createSupabaseServiceRoleClient()`, which bypasses RLS. The scripts only run from the dev box where `.env.local` has the service role key. The same pattern as the existing `scripts/backfill-whoop.mjs`. If the service role key leaks, rekey is the least of your problems.
- **Concurrent sync during a rekey.** If the Vercel cron `/api/whoop/sync` fires at 08:00 UTC during a rekey, both processes write to `daily_logs`. The cron sync uses upsert on `(user_id, date)`, so it'll write to dates the rekey is also writing to. Worst case: a few rows get the cron's data instead of the script's, but both use the same patched keying, so values are still correct. Acceptable given the rekey runs once and takes seconds.

## Out of scope (parked)

- **Travel mode L2 (manual `current_timezone` override in `/profile`).** Adds a column, settings UI, and propagation through every "now" call. Separate spec.
- **Travel mode L3 (browser auto-detection prompt).** Adds UX decisions on prompt timing/dismissal/persistence. Separate spec.
- **Per-record tz for Withings.** Withings doesn't expose this on measurement groups. Would require interpolating from a manual current-tz column (= L2).
- **Apple Health webhook tz handling.** Already correct by construction — the iOS Shortcut formats `d.date` in the phone's local tz.
- **Strong / Yazio.** Not in any sync date-keying path that lands on `daily_logs.date` via timestamp slicing.
- **Updating `vercel.json` cron schedule.** Current 08:00 UTC = 12:00 Dubai is well clear of the bug window; no change needed.
- **Re-key of "manual" columns.** Notes, check-in, Apple Health, Yazio data is preserved by the rekey scripts; deliberate.
