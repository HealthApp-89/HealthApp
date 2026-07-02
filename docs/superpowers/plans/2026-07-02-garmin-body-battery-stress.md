# Garmin Body Battery + Stress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Garmin Body Battery (low/peak) and Stress (avg/max/qualifier) in the coach snapshot, dashboard tiles, and trends charts, via the existing single-owner Garmin → daily_logs pipeline.

**Architecture:** Garmin-only, single-owner metrics. Collector sends them → route writes them to `daily_logs` on every ingest (independent of `metrics_source`, no `source` tag) and mirrors to `garmin_daily` → app reads `daily_logs` → coach reads snapshot. No new machinery; mirrors the movement/energy cluster shipped 2026-07-01.

**Tech Stack:** Next.js 15 route handler + Supabase (TS), Python collector sidecar, Node fixture audit (`scripts/audit-garmin-strain.mjs`), React client components (MetricCard/Recharts).

## Global Constraints

- New fields: Body Battery `body_battery_low`, `body_battery_peak` (int); Stress `stress_avg`, `stress_max` (int), `stress_qualifier` (text). All nullable; `null` = no Garmin data that day.
- Single-owner Garmin: written to `daily_logs` on EVERY ingest, no `source` key emitted (co-owned rows keep WHOOP's source tag). Homogeneous upsert payload (all columns always present, null when absent).
- Stress numeric values of `-1`/`-2` from Garmin mean "no data" → store as `null` (guard `>= 0`).
- `daily_logs` fetch is a hardcoded `COLS` string — every new `DailyLog` field MUST be added or it's silently omitted.
- No route unit-test harness. Pure functions test via `scripts/audit-garmin-strain.mjs`. Verify with `npm run typecheck`; verify UI-touching tasks additionally with `npm run build` (this repo has a known React-hooks-order class of bug that only fails in the prod build — see memory `reference_no_render_test_harness`).
- Migration `0047` is Dashboard-applied (CLI `db push` blocked by the duplicate-0026 slot — see memory `reference_supabase_migration_history_lag`), then `supabase migration repair --status applied 0047`. Applied in Task 8's deploy sequence BEFORE the code deploys.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Branch `feat/garmin-body-battery-stress` (already created; spec committed there).
- AUDIT_USER_ID for backfill/verify: `94fee5c6-7d9a-4b05-be3a-8407505b5429`.

---

### Task 1: Migration + types

**Files:**
- Create: `supabase/migrations/0047_garmin_wellness_metrics.sql`
- Modify: `lib/data/types.ts` (`DailyLog` ~line 60 before `updated_at`; `GarminDailyRow` ~line 66)

**Interfaces:**
- Produces: `daily_logs` + `garmin_daily` gain the five columns; `DailyLog` type gains `body_battery_low`, `body_battery_peak`, `stress_avg`, `stress_max` (`number | null`) and `stress_qualifier` (`string | null`).

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/0047_garmin_wellness_metrics.sql`:
```sql
-- 0047_garmin_wellness_metrics.sql
-- Garmin Body Battery + Stress: single-owner Garmin daily metrics.
-- Body Battery low/peak already exist on garmin_daily (0046); add stress there,
-- and add all five to daily_logs (the app's read surface).

alter table garmin_daily
  add column if not exists stress_avg int,
  add column if not exists stress_max int,
  add column if not exists stress_qualifier text;

alter table daily_logs
  add column if not exists body_battery_low int,
  add column if not exists body_battery_peak int,
  add column if not exists stress_avg int,
  add column if not exists stress_max int,
  add column if not exists stress_qualifier text;
```

- [ ] **Step 2: Add fields to the `DailyLog` type**

In `lib/data/types.ts`, in the `DailyLog` type, immediately before the `updated_at: string;` line, add:
```ts
  // ── Garmin wellness (migration 0047) ───────────────────────────────────────
  body_battery_low: number | null;
  body_battery_peak: number | null;
  stress_avg: number | null;
  stress_max: number | null;
  stress_qualifier: string | null;
```

- [ ] **Step 3: Add stress fields to `GarminDailyRow`**

In `lib/data/types.ts`, in `GarminDailyRow` (which already has `body_battery_low`/`body_battery_peak`), add:
```ts
  stress_avg: number | null;
  stress_max: number | null;
  stress_qualifier: string | null;
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean (adding optional-shaped fields to a type used with `as DailyLog` casts won't break; if any object literal must now include them, fix at that site).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0047_garmin_wellness_metrics.sql lib/data/types.ts
git commit -m "$(cat <<'EOF'
feat(garmin): migration + types for Body Battery + Stress

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Collector — fetch stress

**Files:**
- Modify: `sidecar/garmin/collector.py` (the `stats` block, ~lines 87–96)

**Interfaces:**
- Produces: collector payload days gain `stress_avg`, `stress_max`, `stress_qualifier`. (Body Battery already sent.)

- [ ] **Step 1: Add stress extraction to the stats block**

In `sidecar/garmin/collector.py`, in the `stats = safe(g.get_stats, d)` block, after the `active_calories` line, add:
```python
        # Garmin uses -1/-2 for "no data"; store only real (>=0) stress values.
        sa = stats.get("averageStressLevel")
        if sa is not None and sa >= 0:
            day["stress_avg"] = sa
        sm = stats.get("maxStressLevel")
        if sm is not None and sm >= 0:
            day["stress_max"] = sm
        if stats.get("stressQualifier"):
            day["stress_qualifier"] = stats["stressQualifier"]
```

- [ ] **Step 2: Compile-check**

Run: `cd "sidecar/garmin" && ./.venv/bin/python -m py_compile collector.py`
Expected: exit 0, no output.

- [ ] **Step 3: Dry-verify the fields are emitted (no DB write)**

Run (from `sidecar/garmin`, env loaded):
```bash
cd "sidecar/garmin"; set -a; source .env; set +a; ./.venv/bin/python -c "
import collector, os
g = collector.login()
d = collector.collect_day(g, '2026-06-29')
print({k: d.get(k) for k in ['stress_avg','stress_max','stress_qualifier','body_battery_low','body_battery_peak']})
"
```
Expected: a dict with real values, e.g. `{'stress_avg': 24, 'stress_max': 98, 'stress_qualifier': 'BALANCED', 'body_battery_low': 44, 'body_battery_peak': 82}`.

- [ ] **Step 4: Commit**

```bash
git add sidecar/garmin/collector.py
git commit -m "$(cat <<'EOF'
feat(garmin): collector sends daily stress (avg/max/qualifier)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `mapGarminWellness` mapper (TDD)

**Files:**
- Modify: `lib/coach/garmin/map-metrics.ts` (`GarminDayInput` type + new mapper)
- Test: `scripts/audit-garmin-strain.mjs` (append assertions)

**Interfaces:**
- Consumes: `GarminDayInput`.
- Produces: `mapGarminWellness(input: GarminDayInput): GarminWellnessRow` where
  ```ts
  export type GarminWellnessRow = {
    date: string;
    body_battery_low: number | null;
    body_battery_peak: number | null;
    stress_avg: number | null;
    stress_max: number | null;
    stress_qualifier: string | null;
  };
  ```
  All five metric columns always present (null when absent), NO `source` key. Consumed by the ingest route (Task 4).

- [ ] **Step 1: Write the failing test**

In `scripts/audit-garmin-strain.mjs`, add `mapGarminWellness` to the import from `@/lib/coach/garmin/map-metrics`, then append before the final `console.log`:
```js
// ── map-metrics: mapGarminWellness (Body Battery + Stress cluster) ────────────
const gw = mapGarminWellness({
  date: "2026-07-01", body_battery_low: 24.4, body_battery_peak: 82,
  stress_avg: 24, stress_max: 98, stress_qualifier: "BALANCED",
  hrv: 68, steps: 8000,
});
assert("gw bb_low int", gw.body_battery_low === 24);
assert("gw bb_peak", gw.body_battery_peak === 82);
assert("gw stress_avg", gw.stress_avg === 24);
assert("gw stress_max", gw.stress_max === 98);
assert("gw qualifier passthrough", gw.stress_qualifier === "BALANCED");
assert("gw keeps date", gw.date === "2026-07-01");
assert("gw omits source", !("source" in gw));
assert("gw omits non-wellness (hrv)", !("hrv" in gw));
const gwEmpty = mapGarminWellness({ date: "2026-07-02" });
assert("gw absent bb = null", gwEmpty.body_battery_peak === null);
assert("gw absent stress = null", gwEmpty.stress_avg === null);
assert("gw absent qualifier = null", gwEmpty.stress_qualifier === null);
assert("gw absent key present", "stress_max" in gwEmpty);
```

- [ ] **Step 2: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs`
Expected: FAIL — `mapGarminWellness is not a function` / import error.

- [ ] **Step 3: Extend `GarminDayInput` and implement the mapper**

In `lib/coach/garmin/map-metrics.ts`, add these optional fields to the `GarminDayInput` type:
```ts
  body_battery_low?: number;
  body_battery_peak?: number;
  stress_avg?: number;
  stress_max?: number;
  stress_qualifier?: string;
```
Then add after `mapMovementEnergy`:
```ts
export type GarminWellnessRow = {
  date: string;
  body_battery_low: number | null;
  body_battery_peak: number | null;
  stress_avg: number | null;
  stress_max: number | null;
  stress_qualifier: string | null;
};

/** Garmin-only Body Battery + Stress cluster. Same contract as mapMovementEnergy:
 *  all columns always present (null when absent), NO `source` key — single-owner,
 *  co-owned rows keep WHOOP's source tag. */
export function mapGarminWellness(input: GarminDayInput): GarminWellnessRow {
  const intOrNull = (v: number | undefined | null) =>
    v === undefined || v === null ? null : Math.round(v);
  const strOrNull = (v: string | undefined | null) =>
    v === undefined || v === null ? null : v;
  return {
    date: input.date,
    body_battery_low: intOrNull(input.body_battery_low),
    body_battery_peak: intOrNull(input.body_battery_peak),
    stress_avg: intOrNull(input.stress_avg),
    stress_max: intOrNull(input.stress_max),
    stress_qualifier: strOrNull(input.stress_qualifier),
  };
}
```

- [ ] **Step 4: Run the audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs`
Expected: `... 0 failed`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/garmin/map-metrics.ts scripts/audit-garmin-strain.mjs
git commit -m "$(cat <<'EOF'
feat(garmin): mapGarminWellness mapper for Body Battery + Stress

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Ingest route — schema + write

**Files:**
- Modify: `app/api/ingest/garmin/route.ts` (daySchema ~lines 21–46; garminRows.push ~lines 89–118; dailyRows.push block ~lines 120–124)

**Interfaces:**
- Consumes: `mapGarminWellness` from `@/lib/coach/garmin/map-metrics`.
- Produces: `daily_logs` rows carry Body Battery + Stress on every ingest; `garmin_daily` rows carry stress.

- [ ] **Step 1: Add stress fields to the Zod daySchema**

In `app/api/ingest/garmin/route.ts`, in `daySchema`, add (Body Battery fields already present):
```ts
  stress_avg: z.number().nullish(),
  stress_max: z.number().nullish(),
  stress_qualifier: z.string().nullish(),
```

- [ ] **Step 2: Import the wellness mapper**

Update the map-metrics import:
```ts
import { mapToDailyLogs, mapMovementEnergy, mapGarminWellness, type GarminDayInput } from "@/lib/coach/garmin/map-metrics";
```

- [ ] **Step 3: Write stress into the `garmin_daily` row**

In the `garminRows.push({ ... })` object, after the `body_battery_peak` line, add:
```ts
      stress_avg: d.stress_avg ?? null,
      stress_max: d.stress_max ?? null,
      stress_qualifier: d.stress_qualifier ?? null,
```

- [ ] **Step 4: Spread the wellness cluster into every daily_logs row**

Replace the current daily-row build block:
```ts
    const { hr_samples: _omit, ...dayInput } = d;
    const mapped = garminOwnsDaily
      ? mapToDailyLogs(dayInput as GarminDayInput, strain)
      : mapMovementEnergy(dayInput as GarminDayInput, strain);
    dailyRows.push({ ...mapped, user_id: userId, updated_at: now });
```
with:
```ts
    const { hr_samples: _omit, ...dayInput } = d;
    const mapped = garminOwnsDaily
      ? mapToDailyLogs(dayInput as GarminDayInput, strain)
      : mapMovementEnergy(dayInput as GarminDayInput, strain);
    // Body Battery + Stress are Garmin-owned single-owner columns, written every
    // ingest regardless of metrics_source (same contract as movement/energy).
    const wellness = mapGarminWellness(dayInput as GarminDayInput);
    dailyRows.push({ ...mapped, ...wellness, user_id: userId, updated_at: now });
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/ingest/garmin/route.ts
git commit -m "$(cat <<'EOF'
feat(garmin): ingest Body Battery + Stress to daily_logs + garmin_daily

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Query fetcher + metric colors

**Files:**
- Modify: `lib/query/fetchers/dailyLogs.ts` (`COLS` line 13; `TREND_COLS` line 70; `TrendLog` lines 72–75)
- Modify: `lib/ui/colors.ts` (`DailyLogKey` ~lines 28–41)
- Modify: `lib/ui/theme.ts` (`METRIC_COLOR` ~lines 60–74)

**Interfaces:**
- Produces: `DailyLog` rows returned by `useDailyLogs` include the five new fields; `TrendLog` includes `body_battery_peak` + `stress_avg`; `METRIC_COLOR.body_battery` and `METRIC_COLOR.stress` exist.

- [ ] **Step 1: Add the five columns to `COLS`**

In `lib/query/fetchers/dailyLogs.ts` line 13, append to the `COLS` string (before the closing quote):
```
, body_battery_low, body_battery_peak, stress_avg, stress_max, stress_qualifier
```

- [ ] **Step 2: Add trend columns + Pick**

Change `TREND_COLS` (line 70) to:
```ts
const TREND_COLS = "date, hrv, resting_hr, sleep_hours, strain, weight_kg, body_fat_pct, body_battery_peak, stress_avg";
```
And extend the `TrendLog` Pick (lines 72–75):
```ts
export type TrendLog = Pick<
  DailyLog,
  "date" | "hrv" | "resting_hr" | "sleep_hours" | "strain" | "weight_kg" | "body_fat_pct" | "body_battery_peak" | "stress_avg"
>;
```

- [ ] **Step 3: Add the two keys to `DailyLogKey`**

In `lib/ui/colors.ts`, add `"body_battery"` and `"stress"` to the `DailyLogKey` union (follow the existing string-literal-union style in that file).

- [ ] **Step 4: Add the two colors to `METRIC_COLOR`**

In `lib/ui/theme.ts`, in the `METRIC_COLOR` map, add:
```ts
  body_battery: "#34d399",
  stress: "#fb923c",
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/query/fetchers/dailyLogs.ts lib/ui/colors.ts lib/ui/theme.ts
git commit -m "$(cat <<'EOF'
feat(garmin): expose Body Battery + Stress in fetchers + metric colors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Dashboard tiles

**Files:**
- Modify: `components/dashboard/TodayClient.tsx` (series ~lines 160–171; tile grid ~lines 290–326)

**Interfaces:**
- Consumes: `selectedLog.body_battery_peak/low`, `selectedLog.stress_avg/qualifier`, `METRIC_COLOR.body_battery/stress`.

- [ ] **Step 1: Add the two sparkline series**

In `components/dashboard/TodayClient.tsx`, alongside the existing `hrvSeries`/`strainSeries` declarations (~line 160–171), add:
```tsx
const bodyBatterySeries: MetricDatum[] = last7Asc.map((r) => ({ date: r.date, value: r.body_battery_peak }));
const stressSeries:      MetricDatum[] = last7Asc.map((r) => ({ date: r.date, value: r.stress_avg }));
```

- [ ] **Step 2: Add the two tiles to the grid**

In the metric grid (the `display: grid; gridTemplateColumns: "1fr 1fr"` block ~lines 290–326), after the `Strain` `<MetricCard>`, add:
```tsx
  <MetricCard
    title="Body Battery"
    value={selectedLog?.body_battery_peak ?? null}
    subtitle={selectedLog?.body_battery_low != null ? `low ${selectedLog.body_battery_low}` : undefined}
    data={bodyBatterySeries}
    color={METRIC_COLOR.body_battery}
    type="area"
  />
  <MetricCard
    title="Stress"
    value={selectedLog?.stress_avg ?? null}
    subtitle={selectedLog?.stress_qualifier ?? undefined}
    data={stressSeries}
    color={METRIC_COLOR.stress}
    type="area"
  />
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean (build catches any hooks-order/SSR issue the type check misses).

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/TodayClient.tsx
git commit -m "$(cat <<'EOF'
feat(garmin): Body Battery + Stress dashboard tiles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Trends charts

**Files:**
- Modify: `components/trends/TrendsClient.tsx` (series ~lines 94–99; cards ~lines 120–126)

**Interfaces:**
- Consumes: `TrendLog.body_battery_peak/stress_avg` (added in Task 5), `aggregateSeries`, `latest`, `halfDelta`, `deltaSubtitle`, `rangeLabel`, `METRIC_COLOR`.

- [ ] **Step 1: Add the two aggregated series**

In `components/trends/TrendsClient.tsx`, with the existing `hrvTrend`/`strainTrend` declarations (~lines 94–99), add:
```tsx
const bodyBatteryTrend: MetricDatum[] = aggregateSeries(sliced, (l) => l.body_battery_peak, granularity);
const stressTrend:      MetricDatum[] = aggregateSeries(sliced, (l) => l.stress_avg,        granularity);
```

- [ ] **Step 2: Add the two chart cards**

After the existing cards (~lines 120–126), add:
```tsx
<MetricCard title="Body Battery" value={latest(bodyBatteryTrend)} subtitle={deltaSubtitle(halfDelta(bodyBatteryTrend), "", rangeLabel)} data={bodyBatteryTrend} color={METRIC_COLOR.body_battery} type="area" />
<MetricCard title="Stress"       value={latest(stressTrend)}      subtitle={deltaSubtitle(halfDelta(stressTrend),      "", rangeLabel)} data={stressTrend}      color={METRIC_COLOR.stress}       type="area" />
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add components/trends/TrendsClient.tsx
git commit -m "$(cat <<'EOF'
feat(garmin): Body Battery + Stress trends charts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Coach snapshot + prompts

**Files:**
- Modify: `lib/coach/snapshot.ts` (`DailyLogRow` type ~lines 72–90; main select ~lines 447–454; `logLines` template ~lines 601–606; ephemeral header select + `renderRow` ~lines 770–817)
- Modify: `lib/coach/system-prompts.ts` (`REMI_BASE` ~lines 315–393; `PETER_BASE` ~lines 20–82)

**Interfaces:**
- Produces: the coach snapshot prefix carries Body Battery + Stress per day; Remi/Peter prompts reference them.

- [ ] **Step 1: Add fields to `DailyLogRow` + the main select**

In `lib/coach/snapshot.ts`, add to the `DailyLogRow` type:
```ts
  body_battery_low: number | null;
  body_battery_peak: number | null;
  stress_avg: number | null;
  stress_qualifier: string | null;
```
And append to the main `.select("...")` string (~line 447–454):
```
, body_battery_low, body_battery_peak, stress_avg, stress_qualifier
```

- [ ] **Step 2: Extend the per-day `logLines` template**

In the `logLines` map (~lines 601–606), append to the template string (before the closing backtick):
```ts
 | bb ${fmt(l.body_battery_peak)}/${fmt(l.body_battery_low)} | stress ${fmt(l.stress_avg)}${l.stress_qualifier ? ` (${l.stress_qualifier})` : ""}
```

- [ ] **Step 3: Extend the ephemeral header**

In `buildEphemeralHeader` (~line 770), add `body_battery_peak, body_battery_low, stress_avg, stress_qualifier` to its `.select(...)` string and its row type, then add a line to the `renderRow` return array (after the `strain=...steps=...` line):
```ts
  `  body_battery=${fmt(r?.body_battery_peak)}/${fmt(r?.body_battery_low)}  stress=${fmt(r?.stress_avg)}${r?.stress_qualifier ? ` (${r.stress_qualifier})` : ""}`,
```

- [ ] **Step 4: Add Remi guidance**

In `lib/coach/system-prompts.ts`, in `REMI_BASE`: (a) extend the column-access line (~325) to append `, body_battery_low, body_battery_peak, stress_avg, stress_qualifier` to the listed daily_logs columns; (b) after the interpretive-thresholds block (~line 333), add:
```
- Garmin Body Battery + Stress (from the Fenix): Body Battery peak is how charged the athlete woke; a low morning peak (<50) or a day-low near single digits signals depletion. All-day stress avg >50 or a "STRESSFUL" qualifier sustained multiple days is an autoregulation flag — corroborate with HRV/RHR before acting, don't treat it as standalone. These complement recovery %, they don't replace it.
```

- [ ] **Step 5: Add Peter reference**

In `PETER_BASE`, in the Baselines block (~line 47), append one sentence:
```
The snapshot also carries Garmin Body Battery (peak/low) and all-day Stress (avg + qualifier) per day — use them as corroborating energy/stress context when synthesizing, not as primary readiness signals.
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/snapshot.ts lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(garmin): Body Battery + Stress in coach snapshot + Remi/Peter prompts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Apply migration, deploy, backfill, verify, docs

**Files:**
- Modify: `CLAUDE.md` (data-precedence — extend the Garmin bullet)

**Interfaces:** operational — brings the feature live.

- [ ] **Step 1: Full typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 2: Apply migration 0047 to production (Dashboard)**

Apply the SQL from `supabase/migrations/0047_garmin_wellness_metrics.sql` via the Supabase Dashboard SQL Editor (project `eopfwwergisvskxqvsqe`). Then record it in CLI history:
```bash
supabase migration repair --status applied 0047
```
Verify the columns exist (expect HTTP 200):
```bash
URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d= -f2- | tr -d '"'); KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d= -f2- | tr -d '"'); curl -s -o /dev/null -w "%{http_code}\n" "$URL/rest/v1/daily_logs?select=body_battery_peak,stress_avg&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

- [ ] **Step 3: Update CLAUDE.md precedence note**

In `CLAUDE.md`, extend the Garmin data-source bullet to note it now also owns `body_battery_low/peak` and `stress_avg/max/qualifier` on `daily_logs` (single-owner, always-written; VO2max + training load deferred). Commit:
```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(garmin): note Body Battery + Stress in data precedence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Merge to main + deploy**

```bash
git checkout main && git merge --ff-only feat/garmin-body-battery-stress && git push origin main
```
Confirm Vercel deploy is live (~2 min; the ingest route still returns 405 to GET, so use the backfill response in Step 5 as the "new build live" signal).

- [ ] **Step 5: Backfill 30 days**

```bash
cd "sidecar/garmin"; set -a; source .env; set +a; BACKFILL_DAYS=30 ./.venv/bin/python collector.py
```
Expected: `ingest → 200 {... "daily_logs_upserted": 30 ...}`.

- [ ] **Step 6: Verify data + co-ownership**

```bash
URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d= -f2- | tr -d '"'); KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d= -f2- | tr -d '"'); AUID=94fee5c6-7d9a-4b05-be3a-8407505b5429; curl -s "$URL/rest/v1/daily_logs?select=date,body_battery_peak,body_battery_low,stress_avg,stress_qualifier,recovery,hrv,source&date=gte.2026-06-24&user_id=eq.$AUID&order=date.desc" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | python3 -m json.tool
```
Expected: recent days show `body_battery_*` + `stress_*` populated, `recovery`/`hrv` still WHOOP values, `source` still `"whoop"`. Then trigger a WHOOP sync and re-run to confirm the Garmin columns are unchanged (single-owner, WHOOP never writes them).

- [ ] **Step 7: Manual UI + coach smoke check**

Open the dashboard (Body Battery + Stress tiles render, with values), `/trends` (both charts render), and confirm the `/coach` snapshot includes the Body Battery + Stress line (spot-check via a coach message or the snapshot debug path). Note: today's row may show `—` until the next 9:30 run (complete-days-only collector).

---

## Self-review notes

- Migration/type field names are identical across Tasks 1, 3, 4, 5, 8 (`body_battery_low`, `body_battery_peak`, `stress_avg`, `stress_max`, `stress_qualifier`).
- `mapGarminWellness` signature (Task 3) matches its call in Task 4.
- `TrendLog` gains `body_battery_peak` + `stress_avg` (Task 5) which Task 7's `l.body_battery_peak`/`l.stress_avg` accessors require.
- `stress_max` is stored (garmin_daily + daily_logs + COLS) but intentionally not surfaced in UI/snapshot (avg + qualifier are the decision-relevant values) — retained for future use, not dead (it's in the data model by design).
