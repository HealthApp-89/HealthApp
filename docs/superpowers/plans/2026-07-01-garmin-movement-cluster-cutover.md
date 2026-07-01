# Garmin Movement/Energy Cluster Partial Cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Garmin (Fenix 8 + HRM strap) own `steps, strain, distance_km, calories, active_calories` on `daily_logs` now, calibrated to the historical WHOOP strain scale, while WHOOP keeps recovery/HRV/sleep until the later full cutover.

**Architecture:** Code-defined column ownership (Approach A). The Garmin ingest route writes the movement/energy cluster to `daily_logs` on every ingest, independent of `metrics_source`; the recovery/HRV/sleep cluster stays gated behind `metrics_source='garmin'`. WHOOP's `buildWhoopDayRows` stops emitting `strain`. Supabase upsert preserves columns each source doesn't touch, so the two co-own one row.

**Tech Stack:** Next.js 15 route handler (TypeScript), Supabase service-role client, Node fixture audit scripts (no vitest for this area), Python collector sidecar (unchanged).

## Global Constraints

- Movement/energy cluster (exact columns): `steps, strain, distance_km, calories, active_calories`.
- WHOOP retains ownership of: `hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, sleep_start_at, sleep_end_at, spo2, skin_temp_c, respiratory_rate`.
- `steps, calories, active_calories` are INTEGER columns — `Math.round()` before upsert.
- No schema/migration change. Ownership enforced in code (CLAUDE.md convention).
- Verify with `npm run typecheck` (strict) + the fixture audit `scripts/audit-garmin-strain.mjs` + the DB audit `scripts/audit-garmin-vs-whoop.mjs`. There is no route unit-test harness; functional verification of the route happens via the backfill run in Task 5.
- **Load-bearing ordering:** the strain calibration fit (Task 1) MUST be computed and committed before the backfill (Task 5), because the fit reads WHOOP strain from `daily_logs`, which the backfill overwrites.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feat/garmin-movement-cluster-cutover` (already created; spec committed there).

---

### Task 1: Calibrate strain to the WHOOP scale

**Files:**
- Modify: `lib/coach/garmin/derive-strain.ts:11` (`DEFAULT_STRAIN_CALIBRATION`)
- Run (read-only): `scripts/audit-garmin-vs-whoop.mjs`

**Interfaces:**
- Consumes: `garmin_daily.trimp_edwards` (input) and `daily_logs.strain` (WHOOP target), both already populated for ~30 overlapping days.
- Produces: updated `DEFAULT_STRAIN_CALIBRATION = { A, k }` consumed by `trimpToStrain` in the ingest route.

- [ ] **Step 1: Run the calibration fit and record the output**

Run:
```bash
AUDIT_USER_ID=<user-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-vs-whoop.mjs
```
Find the user UUID with:
```bash
URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d= -f2- | tr -d '"'); KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d= -f2- | tr -d '"'); curl -s "$URL/rest/v1/garmin_daily?select=user_id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```
Expected: a table of daily Garmin-vs-WHOOP comparisons, ending with a line like
`Strain calibration best fit over N days: A=<a>, k=<k> (RMSE <r>)`. Record `A`, `k`, and the RMSE.

- [ ] **Step 2: Update the calibration constant**

In `lib/coach/garmin/derive-strain.ts`, replace the default with the fitted values (using the exact numbers printed in Step 1):
```ts
/** Calibrated against WHOOP strain over the June 2026 parallel-run window
 *  (scripts/audit-garmin-vs-whoop.mjs grid-search fit). RMSE <r> over N days. */
export const DEFAULT_STRAIN_CALIBRATION: StrainCalibration = { A: <a>, k: <k> };
```

- [ ] **Step 3: Verify the fixture audit still passes with the new constant**

Run:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs
```
Expected: `... passed, 0 failed` (the `strain uses default cal` assertion recomputes from `DEFAULT_STRAIN_CALIBRATION`, so it tracks the new value automatically).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/garmin/derive-strain.ts
git commit -m "$(cat <<'EOF'
feat(garmin): calibrate strain to WHOOP scale from parallel-run fit

Replaces the un-tuned default (A:4.2,k:0.05) with the grid-search best fit over
the June 2026 overlapping days so Garmin strain lands on WHOOP's 0-21 scale.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `mapMovementEnergy` pure mapper (TDD)

**Files:**
- Modify: `lib/coach/garmin/map-metrics.ts`
- Test: `scripts/audit-garmin-strain.mjs` (append assertions)

**Interfaces:**
- Consumes: `GarminDayInput` (existing type in this file).
- Produces: `mapMovementEnergy(input: GarminDayInput, strain: number | null): MovementEnergyRow`, where
  ```ts
  export type MovementEnergyRow = {
    date: string;
    steps: number | null;
    distance_km: number | null;
    calories: number | null;
    active_calories: number | null;
    strain: number | null;
  };
  ```
  Consumed by the ingest route (Task 3). Note: **all five metric columns are always present** (null when absent) so the upsert payload is homogeneous, and **no `source` key** is emitted (movement/energy is single-owner, so nulls don't clobber another source and the row's existing `source` tag is preserved).

- [ ] **Step 1: Write the failing test**

Append to `scripts/audit-garmin-strain.mjs` (before the final `console.log`), and add `mapMovementEnergy` to the import from `@/lib/coach/garmin/map-metrics`:
```js
// ── map-metrics: mapMovementEnergy (partial movement/energy cluster) ──────────
const me = mapMovementEnergy(
  { date: "2026-07-01", steps: 8421.6, distance_km: 6.2, calories: 2480.9, active_calories: 612.4,
    hrv: 68, recovery: 74, sleep_hours: 7.4 },
  12.5,
);
assert("me strain passthrough", me.strain === 12.5);
assert("me steps rounded int", me.steps === 8422);
assert("me calories rounded int", me.calories === 2481);
assert("me active_calories rounded int", me.active_calories === 612);
assert("me distance passthrough", me.distance_km === 6.2);
assert("me keeps date", me.date === "2026-07-01");
// Single-owner cluster: NO source key (preserve co-owner's tag).
assert("me omits source", !("source" in me));
// Must NOT carry recovery/hrv/sleep columns.
assert("me omits recovery", !("recovery" in me));
assert("me omits hrv", !("hrv" in me));
assert("me omits sleep_hours", !("sleep_hours" in me));
// Absent metric → null (present key, homogeneous payload), not omitted.
const meEmpty = mapMovementEnergy({ date: "2026-07-02" }, null);
assert("me absent steps = null", meEmpty.steps === null);
assert("me absent strain = null", meEmpty.strain === null);
assert("me absent key present", "calories" in meEmpty);
```

- [ ] **Step 2: Run the audit to verify it fails**

Run:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs
```
Expected: FAIL — `mapMovementEnergy is not a function` (or import error).

- [ ] **Step 3: Implement `mapMovementEnergy`**

In `lib/coach/garmin/map-metrics.ts`, add after `mapToDailyLogs` (reuse the existing `INT_FIELDS` set):
```ts
export type MovementEnergyRow = {
  date: string;
  steps: number | null;
  distance_km: number | null;
  calories: number | null;
  active_calories: number | null;
  strain: number | null;
};

/** Partial "movement/energy" cluster Garmin owns ahead of the full cutover.
 *  All five columns are always present (null when absent) so the daily_logs
 *  upsert payload stays homogeneous; NO `source` key is emitted, so a
 *  co-owned row keeps whatever source tag WHOOP set. Single-owner columns,
 *  so writing null is honest ("no Garmin data that day"), not a clobber. */
export function mapMovementEnergy(
  input: GarminDayInput,
  strain: number | null,
): MovementEnergyRow {
  const intOrNull = (v: number | undefined | null) =>
    v === undefined || v === null ? null : Math.round(v);
  const numOrNull = (v: number | undefined | null) =>
    v === undefined || v === null ? null : v;
  return {
    date: input.date,
    steps: intOrNull(input.steps),
    distance_km: numOrNull(input.distance_km),
    calories: intOrNull(input.calories),
    active_calories: intOrNull(input.active_calories),
    strain: strain === undefined ? null : strain,
  };
}
```

- [ ] **Step 4: Run the audit to verify it passes**

Run:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs
```
Expected: `... passed, 0 failed`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/garmin/map-metrics.ts scripts/audit-garmin-strain.mjs
git commit -m "$(cat <<'EOF'
feat(garmin): mapMovementEnergy mapper for partial cluster ownership

Single-owner steps/strain/distance/calories mapper — always-present columns
(null when absent), no source tag — for co-owned daily_logs rows.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Route writes movement/energy always, recovery/sleep gated

**Files:**
- Modify: `app/api/ingest/garmin/route.ts:120-145`

**Interfaces:**
- Consumes: `mapMovementEnergy` and `mapToDailyLogs` from `@/lib/coach/garmin/map-metrics`.
- Produces: `daily_logs` now written on every Garmin ingest (movement/energy cluster), plus the full recovery/sleep cluster when `garminOwnsDaily`.

- [ ] **Step 1: Update the import**

In `app/api/ingest/garmin/route.ts`, change the map-metrics import to include the new mapper:
```ts
import { mapToDailyLogs, mapMovementEnergy, type GarminDayInput } from "@/lib/coach/garmin/map-metrics";
```

- [ ] **Step 2: Replace the daily_logs row-building block**

Replace the current per-day daily_logs push (the `if (garminOwnsDaily) { ... dailyRows.push(...) }` block, around lines 120-124) with an unconditional write that selects the column set by ownership:
```ts
    // Movement/energy cluster (steps/strain/distance/calories) is Garmin-owned
    // now, written every ingest. Recovery/HRV/sleep join only at the full
    // cutover (metrics_source='garmin'). See spec 2026-07-01-garmin-movement-cluster-cutover.
    const { hr_samples: _omit, ...dayInput } = d;
    const mapped = garminOwnsDaily
      ? mapToDailyLogs(dayInput as GarminDayInput, strain)          // full incl source:'garmin'
      : mapMovementEnergy(dayInput as GarminDayInput, strain);     // movement/energy only, no source
    dailyRows.push({ ...mapped, user_id: userId, updated_at: now });
```

- [ ] **Step 3: Confirm the response still reports what was written**

The existing `daysUpserted = dailyRows.length` and response block are unchanged and now report the movement/energy writes too. Verify the block after the `daily_logs` upsert still reads:
```ts
    daysUpserted = dailyRows.length;
    revalidatePath("/");
    revalidatePath("/coach");
```
and the response includes `daily_logs_upserted: daysUpserted`. No edit needed if already present — just confirm.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/ingest/garmin/route.ts
git commit -m "$(cat <<'EOF'
feat(garmin): own steps/strain/energy on daily_logs pre-full-cutover

Route now writes the movement/energy cluster to daily_logs on every ingest;
recovery/HRV/sleep still gated on metrics_source='garmin'.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: WHOOP relinquishes strain

**Files:**
- Modify: `lib/whoop-day-rows.ts:86-121` (remove the "Cycles → strain" block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildWhoopDayRows` output rows no longer contain `strain`; WHOOP sync therefore never overwrites Garmin's `daily_logs.strain`.

- [ ] **Step 1: Remove the cycle→strain block**

In `lib/whoop-day-rows.ts`, delete the entire numbered block "1. Cycles → strain" — from the `const NOON_SHIFT_MS = ...` line through the closing `}` of the `for (const c of cycles) { ... }` loop (the block that ends with `row.strain = c.score.strain;`). The cycle-timezone lookup used by sleeps/recoveries comes from `buildCycleTzLookup(cycles)` at the top of the function and is unaffected. Leave `skipped.cycles` initialized to `0` in the `skipped` object (the type and the route response still reference it; it simply stays 0 now).

- [ ] **Step 2: Confirm strain is gone from the builder output**

Run this inline fixture check (no DB):
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e '
import { buildWhoopDayRows } from "@/lib/whoop-day-rows";
const { rows } = buildWhoopDayRows(
  "u",
  [{ score: { hrv_rmssd_milli: 60, resting_heart_rate: 50, recovery_score: 70 }, sleep_id: "s1", created_at: "2026-06-20T04:00:00Z" }],
  [{ id: "c1", start: "2026-06-19T22:00:00Z", timezone_offset: "+04:00", score: { strain: 12, kilojoule: 1, average_heart_rate: 1, max_heart_rate: 1 } }],
  [{ id: "s1", start: "2026-06-19T22:30:00Z", end: "2026-06-20T06:00:00Z", score: { stage_summary: { total_light_sleep_time_milli: 1, total_slow_wave_sleep_time_milli: 1, total_rem_sleep_time_milli: 1 }, sleep_performance_percentage: 80 } }],
);
const anyStrain = rows.some((r) => "strain" in r);
console.log(anyStrain ? "FAIL: strain still present" : "PASS: no strain in WHOOP rows");
process.exit(anyStrain ? 1 : 0);
'
```
Expected: `PASS: no strain in WHOOP rows`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the `strain?` field on `WhoopDayRow` stays in the type — harmless — but is never set).

- [ ] **Step 4: Commit**

```bash
git add lib/whoop-day-rows.ts
git commit -m "$(cat <<'EOF'
feat(whoop): relinquish daily_logs.strain to Garmin

Stops emitting strain from buildWhoopDayRows so the twice-daily WHOOP sync no
longer overwrites Garmin's HRM-derived strain. WHOOP keeps recovery/HRV/sleep.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Deploy, backfill 30 days, verify end-to-end

**Files:**
- None (operational).

**Interfaces:**
- Consumes: deployed route + committed calibration from Tasks 1-4.
- Produces: `daily_logs` last 30 days carrying calibrated Garmin steps/strain/energy.

- [ ] **Step 1: Full typecheck before deploy**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Merge to main and deploy**

```bash
git checkout main && git merge --ff-only feat/garmin-movement-cluster-cutover && git push origin main
```
Then confirm the deploy is live (Vercel auto-deploys `main`). Poll until the ingest route responds non-404/405-live from the new build:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://health-app-delta-ruby.vercel.app/api/ingest/garmin
```
Expected: `405` (route live, GET not allowed). Allow ~2 min for the build.

- [ ] **Step 3: Backfill 30 days through the deployed route**

```bash
cd "/Users/abdelouahedelbied/Health app/sidecar/garmin"; set -a; source .env; set +a; BACKFILL_DAYS=30 ./.venv/bin/python collector.py
```
Expected: `ingest → 200: {... "daily_logs_upserted": 30 ...}` (now non-zero — the movement/energy write fires regardless of `metrics_source`).

- [ ] **Step 4: Verify daily_logs shows Garmin movement/energy with continuous strain**

```bash
cd "/Users/abdelouahedelbied/Health app"; URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d= -f2- | tr -d '"'); KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d= -f2- | tr -d '"'); curl -s "$URL/rest/v1/daily_logs?select=date,steps,strain,calories,recovery,hrv,source&order=date.desc&limit=32" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | python3 -m json.tool | head -60
```
Expected: for the last ~30 days — `steps`/`strain`/`calories` populated (Garmin), `recovery`/`hrv` still WHOOP values, `source` still `"whoop"` on co-owned rows. Strain magnitudes now sit on the WHOOP scale (no visible step-change at the ~30-day boundary vs older WHOOP rows).

- [ ] **Step 5: Verify a WHOOP sync no longer clobbers strain/steps**

Trigger a WHOOP sync manually (CRON_SECRET-gated), then re-run Step 4's query:
```bash
cd "/Users/abdelouahedelbied/Health app"; SECRET=$(grep -E "^CRON_SECRET=" .env.local | cut -d= -f2- | tr -d '"'); curl -s -o /dev/null -w "whoop sync → %{http_code}\n" -H "Authorization: Bearer $SECRET" https://health-app-delta-ruby.vercel.app/api/whoop/sync
```
Then re-run the Step 4 `daily_logs` query. Expected: `steps` and `strain` for the recent days are UNCHANGED by the WHOOP sync (its payload no longer includes strain and never included steps), while `recovery`/`hrv` may refresh.

- [ ] **Step 6: Post-calibration audit**

```bash
AUDIT_USER_ID=<user-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-vs-whoop.mjs
```
Expected: the printed best-fit RMSE matches Task 1's; the day-by-day `strain g/w` columns now track closely. (Note: after backfill, `daily_logs.strain` IS Garmin strain, so the `g/w` comparison will show Garmin-vs-Garmin for backfilled days — confirm the run completes without error and numbers are on-scale.)

- [ ] **Step 7: Update CLAUDE.md data-precedence note**

In `CLAUDE.md`, under the data-sources/precedence section, add a line noting Garmin now owns `steps, strain, distance_km, calories, active_calories` on `daily_logs` (partial cutover, code-defined), WHOOP retains recovery/HRV/sleep, and WHOOP no longer writes strain. Commit:
```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(garmin): note movement/energy partial cutover in data precedence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
git checkout main && git merge --ff-only feat/garmin-movement-cluster-cutover && git push origin main
```

---

## Notes for the executor

- The daily 9:30 Dubai cron will also start writing the movement/energy cluster (last 4 days) once deployed — same direction as the backfill, no conflict.
- Today's strain now lands the next morning (collector fetches yesterday-and-back only). This is intended; readiness reads yesterday's strain.
- If the calibration RMSE in Task 1 is poor (e.g. > ~3 on the 0-21 scale), stop and report — it may indicate too few overlapping WHOOP-strain days, and the fit should not be trusted for backfill.
