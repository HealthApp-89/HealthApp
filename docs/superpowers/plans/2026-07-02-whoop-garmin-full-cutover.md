# WHOOP → Garmin Full Cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Garmin the sole data source — cut over the recovery/HRV/sleep cluster (movement/strain + Body Battery/Stress already Garmin-owned), cleanly, before the WHOOP subscription lapses ~2026-07-29.

**Architecture:** The flip is already wired behind `profiles.metrics_source` (`'whoop'|'garmin'`). This plan does the *clean-up* around the flip: add SpO2 + an overnight today-pass to the collector, retire skin temp from all product surfaces (leave the DB column vestigial), relabel the morning-sync affordance to Garmin, move the baseline cron off `whoop_tokens`, extract + calibrate the readiness floor, remove the WHOOP UI + crons, and provide an archive script. The live flip/backfill/recompute is a manual runbook (Task 10) executed after the code merges.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), Supabase, Python sidecar (`python-garminconnect`), Recharts.

## Global Constraints

- **No test suite / linter** in this repo (CLAUDE.md). Verify every task with `npm run typecheck` + `npm run build`, plus the relevant audit script (`node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/<name>`) or a manual page check. The pytest-style TDD template does not apply; "write the test" means "add/extend a fixture assertion in the matching audit script" only where a pure helper is introduced.
- **Number display:** user-visible numbers use `fmtNum()` (≤2 dp, trailing zeros trimmed) — not relevant to most tasks here but holds.
- **Do NOT rename the `awaiting_whoop` `intake_state` value** — it is CHECK-constrained (migrations 0007/0011). Relabel user-facing copy only.
- **Do NOT drop the `daily_logs.skin_temp_c` column** — it has a manual-entry writer ([lib/log/actions.ts:45](../../../lib/log/actions.ts#L45)). Retire it from product surfaces only; the column + Log-form field stay vestigial.
- **Ownership:** after cutover, Garmin owns `hrv, resting_hr, recovery(=Training Readiness), sleep_*, respiratory_rate, spo2` + the already-owned movement/strain/Body Battery/Stress. `skin_temp_c` has no writer (retired).
- Commit after each task. Branch: `feat/whoop-garmin-full-cutover` (already created; spec already committed).

---

## Task 1: Collector — SpO2 + overnight today-pass

**Files:**
- Modify: [sidecar/garmin/collector.py](../../../sidecar/garmin/collector.py)

**Interfaces:**
- Produces: an overnight-only payload for today (keys `hrv, resting_hr, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, respiratory_rate, training_readiness`) plus `spo2` on the trailing complete-days. The ingest route ([app/api/ingest/garmin/route.ts](../../../app/api/ingest/garmin/route.ts)) already accepts `spo2` and writes only present fields via `mapToDailyLogs`, so no route change is needed.

Rationale: Garmin keys last night's sleep to the wake-day (today), matching where WHOOP posted recovery and where the ring/brief already read it. Overnight metrics are complete by morning; all-day metrics (movement/strain/Body Battery/Stress) are not, so the today-pass omits them to avoid partial-day writes.

- [ ] **Step 1: Add SpO2 fetch in the `stats`/dedicated block of `collect_day`**

In `collect_day`, after the existing `stats` block (the stress fields around line 108), add a pulse-ox fetch:

```python
    spo2 = safe(g.get_spo2_data, d)
    if isinstance(spo2, dict):
        # Garmin uses -1/None sentinels for "no reading"; keep only real avg.
        avg = spo2.get("averageSpo2") if spo2.get("averageSpo2") is not None else spo2.get("averageSpO2")
        if isinstance(avg, (int, float)) and avg > 0:
            day["spo2"] = avg
```

- [ ] **Step 2: Add the `OVERNIGHT_KEYS` set + `overnight_only` pure helper at module top**

Add near the top of the file (after `TOKENSTORE`):

```python
# Overnight-complete metrics: available on wake, so they can be fetched for
# *today* (Garmin keys last night's sleep to the wake-day). All-day metrics
# (movement/strain/body battery/stress) are excluded — they stay complete-days-only.
OVERNIGHT_KEYS = {
    "hrv", "resting_hr", "sleep_hours", "sleep_score",
    "deep_sleep_hours", "rem_sleep_hours", "respiratory_rate",
    "training_readiness",
}


def overnight_only(day: dict) -> dict:
    """Filter a full day payload down to overnight-complete metrics (+ date)."""
    return {k: v for k, v in day.items() if k == "date" or k in OVERNIGHT_KEYS}
```

- [ ] **Step 3: Emit the today-pass in `main`**

In `main()`, after the trailing-days loop builds `days`, append today's overnight-only payload:

```python
    today = date.today().isoformat()
    print(f"collecting {today} (overnight-only) ...")
    days.append(overnight_only(collect_day(g, today)))
```

(Place this before the `requests.post`. `collect_day(g, today)` performs the full fetch; `overnight_only` discards the incomplete all-day keys so only recovery columns are written for today.)

- [ ] **Step 4: Verify syntax + helper logic (no network)**

Run:
```bash
python3 -m py_compile sidecar/garmin/collector.py && echo "compile OK"
python3 -c "import sys; sys.path.insert(0,'sidecar/garmin'); \
exec(open('sidecar/garmin/collector.py').read().split('def login')[0]); \
assert overnight_only({'date':'d','hrv':60,'steps':9000,'strain':12,'sleep_score':80}) == {'date':'d','hrv':60,'sleep_score':80}, 'filter wrong'; \
print('overnight_only OK')"
```
Expected: `compile OK` then `overnight_only OK`. (The `exec(... split('def login')[0])` trick runs only the pre-`login` module prelude, so `garminconnect` need not be installed to test the pure helper.)

- [ ] **Step 5: Commit**

```bash
git add sidecar/garmin/collector.py
git commit -m "feat(garmin): collector SpO2 fetch + overnight today-pass for last-night recovery"
```

---

## Task 2: Retire skin temp — recovery-intelligence, proactive, chart

**Files:**
- Modify: [lib/coach/recovery-intelligence/types.ts](../../../lib/coach/recovery-intelligence/types.ts)
- Modify: [lib/coach/recovery-intelligence/compose-daily.ts](../../../lib/coach/recovery-intelligence/compose-daily.ts)
- Modify: [lib/coach/recovery-intelligence/index.ts](../../../lib/coach/recovery-intelligence/index.ts) (around lines 78-112)
- Delete: [lib/coach/proactive/check-skin-temp.ts](../../../lib/coach/proactive/check-skin-temp.ts)
- Modify: [lib/coach/proactive/index.ts](../../../lib/coach/proactive/index.ts) (import line 37, spread line 142)
- Modify: [lib/coach/proactive/render-card.ts](../../../lib/coach/proactive/render-card.ts) (case line 80, `renderSkinTemp` function ~454)
- Modify: [components/health/trends/BodySignalsSection.tsx](../../../components/health/trends/BodySignalsSection.tsx) (SkinTempCard usage ~56-72 + its definition)

**Interfaces:**
- Produces: `RecoveryDailyPoint` without `skin_temp_c`; `RecoveryIntelligencePayload.baselines` without `skin_temp_baseline_c`. Downstream consumers in Tasks 3 must not reference these.

- [ ] **Step 1: Remove `skin_temp_c` from `RecoveryDailyPoint` and `skin_temp_baseline_c` from baselines**

In `types.ts`: delete the line `skin_temp_c: number | null;` (line 18) and the line `skin_temp_baseline_c: number | null;        // computed personal 28d` (line 80).

- [ ] **Step 2: Remove `skin_temp_c` from the composer select + densify fallback**

In `compose-daily.ts`: in `SELECT_COLS` (line 13) delete `skin_temp_c,` (leave `spo2,` and `respiratory_rate,` intact). In the densify fallback object (line 55) change `strain: null, spo2: null, skin_temp_c: null,` to `strain: null, spo2: null,`.

- [ ] **Step 3: Remove the skin-temp baseline computation in `index.ts`**

In `lib/coach/recovery-intelligence/index.ts` delete the `skin_temp_baseline_c` const (lines 78-79) and the `skin_temp_baseline_c,` entry in the returned `baselines` object (line 112).

- [ ] **Step 4: Delete the proactive skin-temp trigger + its wiring**

Delete the file `lib/coach/proactive/check-skin-temp.ts`. In `lib/coach/proactive/index.ts` remove the import (`import { checkSkinTemp } from "./check-skin-temp";`, line 37) and the spread `...checkSkinTemp(recoveryIntelligence),` (line 142). In `lib/coach/proactive/render-card.ts` remove the `case "skin_temp_elevated": return renderSkinTemp(event, ctx);` (line 80) and delete the `renderSkinTemp` function (~line 454).

- [ ] **Step 5: Remove the SkinTempCard from the Health→Trends chart**

In `components/health/trends/BodySignalsSection.tsx` remove the `<SkinTempCard .../>` render (~lines 56-72) and delete its component definition. Leave the SpO2 / respiratory-rate cards in the section intact.

- [ ] **Step 6: Verify**

Run:
```bash
npm run typecheck
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-recovery-intelligence.mjs
```
Expected: typecheck clean (no references to `skin_temp_c`/`skin_temp_baseline_c` remain in recovery-intelligence/proactive); audit passes. If `audit-recovery-intelligence.mjs` asserts on `skin_temp_baseline_c`, remove that assertion in the same task.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/recovery-intelligence components/health/trends/BodySignalsSection.tsx lib/coach/proactive scripts/audit-recovery-intelligence.mjs
git commit -m "refactor(garmin): retire skin temp from recovery-intelligence, proactive, trends chart"
```

---

## Task 3: Coach cleanup — tool allow-lists + prompt copy

**Files:**
- Modify: [lib/coach/tools.ts](../../../lib/coach/tools.ts) (lines 103, 132)
- Modify: [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts) (lines 321, 325, 422)
- Modify: [app/profile/coach-prompts/page.tsx](../../../app/profile/coach-prompts/page.tsx) (line 153)
- Modify: [lib/morning/brief/assembler.ts](../../../lib/morning/brief/assembler.ts) (comment line 47, 52) — copy only
- Modify: [lib/coach/snapshot.ts](../../../lib/coach/snapshot.ts) (comment line 60) — copy only

- [ ] **Step 1: Remove `skin_temp_c` from the coach column allow-lists**

In `lib/coach/tools.ts`, in both `allowedColumns` arrays (lines 103 and 132) remove the `"skin_temp_c",` entry. Keep `"spo2"` and `"respiratory_rate"`.

- [ ] **Step 2: Remove `skin_temp_c` from REMI's readable-column sentence**

In `lib/coach/system-prompts.ts` line 325, remove `skin_temp_c, ` from the parenthesised column list (leave `spo2,` and `respiratory_rate,`).

- [ ] **Step 3: Relabel "WHOOP baselines" → "recovery baselines" in coach-facing copy**

Change the user/coach-facing strings (not code identifiers, not the `whoop_baselines` jsonb key):
- `system-prompts.ts` line 321: "athlete's WHOOP baselines" → "athlete's recovery baselines".
- `system-prompts.ts` line 422: "Profile + WHOOP baselines" → "Profile + recovery baselines".
- `app/profile/coach-prompts/page.tsx` line 153: "WHOOP baselines" → "recovery baselines".
- `lib/morning/brief/assembler.ts` lines 47/52 comment: "WHOOP baselines" → "recovery baselines (Garmin-sourced post-cutover)".
- `lib/coach/snapshot.ts` comment line 60: leave the `whoop_baselines` identifier; adjust prose to "recovery baselines".

**Do NOT touch** the `whoop_baselines` column name, `WhoopBaselinesJsonb` type, `readRolling30d`, or any `.select("whoop_baselines")` — identifiers stay (per Global Constraints / non-goals).

- [ ] **Step 4: Verify**

Run:
```bash
npm run typecheck && npm run build
```
Expected: clean. Grep check: `grep -rn "skin_temp_c" lib/coach` returns nothing under `lib/coach/tools.ts` / `system-prompts.ts`.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/tools.ts lib/coach/system-prompts.ts app/profile/coach-prompts/page.tsx lib/morning/brief/assembler.ts lib/coach/snapshot.ts
git commit -m "refactor(garmin): drop skin_temp_c from coach tools/prompts; relabel WHOOP→recovery baselines"
```

---

## Task 4: Baseline cron — iterate Garmin users, not `whoop_tokens`

**Files:**
- Modify: [app/api/whoop/baselines/sync/route.ts](../../../app/api/whoop/baselines/sync/route.ts) (lines 28-40)
- Modify: [lib/whoop/baselines.ts](../../../lib/whoop/baselines.ts) (header comment lines 1-6)

**Interfaces:**
- Consumes: `computeWhoopBaselines` / `persistBaselines` unchanged (already `daily_logs`-sourced).

Rationale: the cron iterates `whoop_tokens`, which becomes empty when the token row lapses → baselines silently stop recomputing. Iterate `metrics_source='garmin'` users so recompute continues on Garmin data.

- [ ] **Step 1: Change the cron user set**

In `app/api/whoop/baselines/sync/route.ts`, in the `isCron` branch, replace:
```ts
    const { data: tokenRows } = await supabase
      .from("whoop_tokens")
      .select("user_id");
    const results: Record<string, unknown> = {};
    for (const { user_id } of tokenRows ?? []) {
```
with:
```ts
    // Post-cutover: recovery baselines recompute from daily_logs (Garmin-owned),
    // so iterate athletes whose metrics_source is Garmin — NOT whoop_tokens,
    // which empties when the WHOOP subscription lapses.
    const { data: profileRows } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("metrics_source", "garmin");
    const results: Record<string, unknown> = {};
    for (const { user_id } of profileRows ?? []) {
```

- [ ] **Step 2: Update the file header comment**

In `lib/whoop/baselines.ts`, change the header comment "the five WHOOP metrics" / "Refreshed daily by /api/whoop/baselines/sync" to note these are now Garmin-sourced recovery baselines post-cutover (prose only; no code change).

- [ ] **Step 3: Verify**

Run:
```bash
npm run typecheck && npm run build
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/whoop/baselines/sync/route.ts lib/whoop/baselines.ts
git commit -m "fix(garmin): baseline cron iterates metrics_source=garmin, not whoop_tokens"
```

---

## Task 5: Morning gate — Garmin relabel + Recheck chip

**Files:**
- Modify: [lib/morning/script.ts](../../../lib/morning/script.ts) (lines 123-127)
- Modify: [app/api/chat/morning/intake/route.ts](../../../app/api/chat/morning/intake/route.ts) (import line 30, chip block 422-431)
- Modify: [components/chat/ChatChips.tsx](../../../components/chat/ChatChips.tsx) (action union line 15)
- Modify: [components/chat/ChatPanel.tsx](../../../components/chat/ChatPanel.tsx) (handler union line 1030, `whoop_sync` branch 1054-1076)

**Interfaces:**
- Produces: a `recheck` chip action that re-queries today's recovery + re-runs the recommendation with **no** WHOOP sync call. `skip_whoop` action key unchanged (display text relabeled). Gate keeps reading today's recovery (now populated by Task 1's today-pass).

- [ ] **Step 1: Rewrite the prompt copy in `script.ts`**

Rename + reword (rename because the old name is now a misnomer; two references):
```ts
export const SYNC_RECOVERY_PROMPT =
  "Garmin hasn't synced last night's recovery yet. Sync your watch in Garmin Connect and run the collector, then tap Recheck — or skip and I'll build a feel-only plan from the last 7 days.";

export const SYNC_RECOVERY_FAILED_PROMPT =
  "Still no recovery data. Recheck again, or skip and I'll give you a feel-only plan.";
```
Remove the old `SYNC_WHOOP_PROMPT` / `SYNC_WHOOP_FAILED_PROMPT` exports.

- [ ] **Step 2: Update the intake route chip block**

In `app/api/chat/morning/intake/route.ts`: change the import (line 30) `SYNC_WHOOP_PROMPT` → `SYNC_RECOVERY_PROMPT`, and replace the chip block (422-431):
```ts
        if (!log || log.recovery == null) {
          await insertAssistantTurn(sr, userId, {
            content: SYNC_RECOVERY_PROMPT,
            ui: {
              chips: [
                { label: "Recheck", action: "recheck" },
                { label: "Skip — feel-only plan", action: "skip_whoop" },
              ],
            },
          });
        }
```
(If `SYNC_WHOOP_FAILED_PROMPT` is imported/used elsewhere in this file, update that reference to `SYNC_RECOVERY_FAILED_PROMPT` too — grep before finishing.)

- [ ] **Step 3: Extend the chip action union in `ChatChips.tsx`**

Line 15: change the union to include `"recheck"` and drop `"whoop_sync"`:
```ts
  onAction: (action: "recheck" | "skip_whoop" | "retry_recommendation" | "retry_brief") => void;
```

- [ ] **Step 4: Replace the `whoop_sync` handler with `recheck` in `ChatPanel.tsx`**

Line 1030: update the parameter union to match Step 3 (`"recheck" | "skip_whoop" | "retry_recommendation" | "retry_brief"`). Replace the whole `if (action === "whoop_sync") { ... }` block (1054-1076) with:
```ts
      if (action === "recheck") {
        // No server sync: the Mac collector is unreachable from the phone.
        // Just re-read today's recovery (the collector may have landed it) and
        // re-run the recommendation. Falls through to the same notice if still null.
        await queryClient.invalidateQueries({
          queryKey: queryKeys.dailyLogs.range(userId, today, today),
        });
        await tryRunRecommendation({ skip_whoop: false });
        return;
      }
```
(The `skip_whoop`, `retry_recommendation`, `retry_brief` branches and the auto-fire `useEffect` at 1096-1102 stay unchanged — the auto-fire already re-runs when today's recovery appears.)

- [ ] **Step 5: Verify**

Run:
```bash
npm run typecheck && npm run build
```
Expected: clean (no remaining `whoop_sync` / `SYNC_WHOOP_PROMPT` references — grep to confirm). Manual: `npm run dev`, open `/coach` morning intake with today's recovery absent → the notice shows "Recheck" + "Skip"; tapping Recheck re-runs without hitting `/api/whoop/sync`.

- [ ] **Step 6: Commit**

```bash
git add lib/morning/script.ts app/api/chat/morning/intake/route.ts components/chat/ChatChips.tsx components/chat/ChatPanel.tsx
git commit -m "feat(garmin): morning gate relabel to Garmin + Recheck chip (no server sync)"
```

---

## Task 6: Recovery-floor constants + calibration script

**Files:**
- Modify: [lib/ui/score.ts](../../../lib/ui/score.ts) (lines 104-111)
- Create: `scripts/calibrate-recovery-floor.mjs`

**Interfaces:**
- Produces: named constants `RED_FLOOR_BAND_LOW` (25) and `RED_FLOOR_CAP_MODERATE` (40) driving `bandFromReadiness`. The calibration script is read-only and advisory (re-tuned during the overlap).

Rationale: the floor operates on `recoverySubScore` (a blend of HRV-ratio/sleep/deep-sleep/RHR sub-scores — **not** the `recovery` column). HRV is ratio-to-baseline (self-normalizing), so the thresholds are largely device-agnostic; ship at the current 25/40 and provide a script to empirically re-tune against Garmin data during the overlap.

- [ ] **Step 1: Extract the magic numbers to named constants**

In `lib/ui/score.ts`, above `bandFromReadiness` (line 104) add:
```ts
/** Red-recovery floor thresholds, applied to the recovery sub-score (0-100).
 *  Below LOW → force band low; below CAP (when band would be high) → cap at
 *  moderate. Calibrated on WHOOP Recovery-derived sub-scores; re-tune for
 *  Garmin via scripts/calibrate-recovery-floor.mjs during the cutover overlap. */
export const RED_FLOOR_BAND_LOW = 25;
export const RED_FLOOR_CAP_MODERATE = 40;
```
Then in `bandFromReadiness` replace the literals:
```ts
  if (recoverySubScore !== null) {
    if (recoverySubScore < RED_FLOOR_BAND_LOW) band = "low";
    else if (recoverySubScore < RED_FLOOR_CAP_MODERATE && band === "high") band = "moderate";
  }
```

- [ ] **Step 2: Write the calibration script**

Create `scripts/calibrate-recovery-floor.mjs` — a read-only reporter. It loads the last 60 days of `daily_logs` for `AUDIT_USER_ID`, recomputes each day's `recoverySubScore` via the same anchors as `deriveReadiness`, and prints the distribution + what fraction of days fall below the current `RED_FLOOR_BAND_LOW` / `RED_FLOOR_CAP_MODERATE`, plus the 10th/20th percentile values (candidate thresholds). No writes.

```js
// scripts/calibrate-recovery-floor.mjs
// Read-only: reports the Garmin-era recovery sub-score distribution so the
// red-recovery floor thresholds in lib/ui/score.ts can be re-tuned. No writes.
import { createClient } from "@supabase/supabase-js";
import { deriveReadiness } from "../lib/ui/score.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("set AUDIT_USER_ID"); process.exit(1); }

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const since = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
const { data, error } = await sb
  .from("daily_logs")
  .select("date,hrv,resting_hr,sleep_score,deep_sleep_hours")
  .eq("user_id", userId).gte("date", since).order("date");
if (error) throw error;

// hrvBaseline: pull the same denominator deriveReadiness uses (6mo avg ?? 33).
const { data: prof } = await sb.from("profiles").select("whoop_baselines").eq("user_id", userId).maybeSingle();
const hrvBaseline = (prof?.whoop_baselines?.hrv_6mo_avg) ?? 33;

const subs = [];
for (const log of data ?? []) {
  const r = deriveReadiness({ log, checkin: null, hrvBaseline, weightKg: null, calorieTarget: null });
  if (r.recoverySubScore != null) subs.push(r.recoverySubScore);
}
subs.sort((a, b) => a - b);
const pct = (p) => subs.length ? subs[Math.floor((p / 100) * (subs.length - 1))] : null;
const below = (t) => subs.filter((s) => s < t).length;
console.log(`n=${subs.length} days with a recovery sub-score`);
console.log(`min=${subs[0]} p10=${pct(10)} p20=${pct(20)} median=${pct(50)} max=${subs.at(-1)}`);
console.log(`current floor 25 → ${below(25)} days low (${((below(25)/subs.length)*100).toFixed(1)}%)`);
console.log(`current cap   40 → ${below(40)} days capped-or-low (${((below(40)/subs.length)*100).toFixed(1)}%)`);
console.log(`suggested LOW≈p10=${pct(10)}, CAP≈p20=${pct(20)} (aim ~10%/20% hit rates)`);
```

- [ ] **Step 3: Verify**

Run:
```bash
npm run typecheck
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/calibrate-recovery-floor.mjs
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs
```
Expected: typecheck clean; calibration script prints the distribution; `audit-readiness-score` still passes (behavior unchanged — same 25/40 values, now named). If `audit-readiness-score.mjs` has fixtures asserting band boundaries, they must remain green.

- [ ] **Step 4: Commit**

```bash
git add lib/ui/score.ts scripts/calibrate-recovery-floor.mjs
git commit -m "feat(garmin): extract red-recovery floor constants + Garmin calibration script"
```

---

## Task 7: ConnectionsPanel — remove the WHOOP card

**Files:**
- Modify: [components/profile/ConnectionsPanel.tsx](../../../components/profile/ConnectionsPanel.tsx)
- Modify: the caller that renders `<ConnectionsPanel>` (find via `grep -rn "ConnectionsPanel" app components` — likely `app/profile/*`) to stop passing `whoopConnected`/`whoopUpdatedAt`.

- [ ] **Step 1: Remove the WHOOP `IntegrationRow` + its `ProviderActions`**

In `ConnectionsPanel.tsx`, delete the WHOOP `<IntegrationRow ... name="WHOOP" .../>` (lines 45-54) and the `{whoopConnected && (<ProviderActions syncUrl="/api/whoop/sync" .../> )}` block (55-61). Remove the now-unused `whoopConnected` / `whoopUpdatedAt` props from the `Props` type + destructure, and the `whoopStatus` const (33-35). Keep Withings intact.

- [ ] **Step 2: Update the caller**

In the file that renders `<ConnectionsPanel>`, remove the `whoopConnected={...}` / `whoopUpdatedAt={...}` props and any now-unused WHOOP-token query feeding them. If the WHOOP connection status was fetched only for this panel, remove that query too (verify it is not used elsewhere on the page first).

- [ ] **Step 3: Verify**

Run:
```bash
npm run typecheck && npm run build
```
Expected: clean (no unused-var / missing-prop errors). Manual: `/profile` Connections shows only Withings (+ Garmin status if present elsewhere); no WHOOP card.

- [ ] **Step 4: Commit**

```bash
git add components/profile/ConnectionsPanel.tsx app/profile
git commit -m "refactor(garmin): remove WHOOP card from ConnectionsPanel (permanent cutover)"
```

---

## Task 8: vercel.json — drop the WHOOP sync crons

**Files:**
- Modify: [vercel.json](../../../vercel.json) (the two `/api/whoop/sync` cron entries)

- [ ] **Step 1: Remove the two `/api/whoop/sync` cron entries**

Delete the `{ "path": "/api/whoop/sync", "schedule": "0 5 * * *" }` and `{ "path": "/api/whoop/sync", "schedule": "0 10 * * *" }` entries. **Keep** `{ "path": "/api/whoop/baselines/sync", "schedule": "30 10 * * *" }` (now Garmin-driven per Task 4). Leave all non-WHOOP crons untouched.

- [ ] **Step 2: Verify**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json valid')"
npm run build
```
Expected: `vercel.json valid`; build clean.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "chore(garmin): drop WHOOP sync crons (cutover); keep baseline recompute"
```

---

## Task 9: Archive script for the WHOOP daily rows

**Files:**
- Create: `scripts/archive-whoop-daily.mts`

**Interfaces:**
- Produces: a JSON archive of the current `daily_logs` recovery columns for the last N days, written to disk before the Task-10 backfill overwrites them. Read-only against the DB.

- [ ] **Step 1: Write the archive script**

Create `scripts/archive-whoop-daily.mts`:
```ts
// scripts/archive-whoop-daily.mts
// Read-only: dumps the current daily_logs recovery columns (WHOOP-written) for
// the last N days to a timestamped JSON, so the Task-10 Garmin backfill can
// overwrite them without silent data loss. Run BEFORE flipping metrics_source.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { writeFileSync } from "node:fs";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("set AUDIT_USER_ID"); process.exit(1); }
const days = Number(process.env.ARCHIVE_DAYS ?? "35");

const sr = createSupabaseServiceRoleClient();
const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
const { data, error } = await sr
  .from("daily_logs")
  .select("date,source,hrv,resting_hr,recovery,sleep_hours,sleep_score,deep_sleep_hours,rem_sleep_hours,respiratory_rate,spo2,skin_temp_c")
  .eq("user_id", userId).gte("date", since).order("date");
if (error) throw error;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `docs/superpowers/whoop-daily-archive-${stamp}.json`;
writeFileSync(path, JSON.stringify({ user_id: userId, since, rows: data }, null, 2));
console.log(`archived ${data?.length ?? 0} rows → ${path}`);
```

- [ ] **Step 2: Verify (structure only; live run is Task 10)**

Run:
```bash
npm run typecheck
```
Expected: clean. (The live archive run happens in Task 10 with real credentials.)

- [ ] **Step 3: Commit**

```bash
git add scripts/archive-whoop-daily.mts
git commit -m "feat(garmin): archive script for pre-backfill WHOOP daily rows"
```

---

## Task 10: Cutover runbook (operational — executed after merge, not a subagent code task)

**This task is a documented runbook, not code.** It runs after Tasks 1-9 merge and deploy, with DB service-role access + the Mac collector. Execute in order, verifying each step.

- [ ] **Step 1: Archive** — `AUDIT_USER_ID=<uuid> ARCHIVE_DAYS=35 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/archive-whoop-daily.mts`. Confirm the JSON lands with ~35 rows.
- [ ] **Step 2: Flip** — set `profiles.metrics_source = 'garmin'` for the athlete (Supabase SQL editor). Confirm the ingest route now returns `owns_daily: true`.
- [ ] **Step 3: Backfill** — run the collector with `BACKFILL_DAYS=35` (movement + recovery for complete days, overnight for today) so the route writes the full Garmin recovery cluster over the last 35 days. Confirm `daily_logs` rows in the window carry `source:'garmin'` and non-null `hrv`/`recovery`/`sleep_*`.
- [ ] **Step 4: Recompute baselines** — hit `/api/whoop/baselines/sync` (user-session or cron auth). Confirm `profiles.whoop_baselines.rolling_30d` shows Garmin-sourced means and each metric's `status` climbs toward `stable` as the Garmin-only window fills.
- [ ] **Step 5: Calibrate floor** — `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/calibrate-recovery-floor.mjs`; if the hit-rates are off, update `RED_FLOOR_BAND_LOW` / `RED_FLOOR_CAP_MODERATE` in `lib/ui/score.ts` and redeploy.
- [ ] **Step 6: Validate** — dashboard ring + Health→Trends render Garmin recovery; SpO2 populates; no skin-temp card; morning intake with today's recovery present delivers a brief (not stuck awaiting). Run `audit-readiness-score` + `audit-recovery-intelligence`.
- [ ] **Step 7: Soak** — eyeball daily through ~2026-07-29; re-tune the floor if the band mislabels vs how the athlete feels. WHOOP expiry is then a non-event.

---

## Self-Review notes

- **Spec coverage:** A(collector SpO2+today-pass), C(archive→Task 9 + runbook Task 10), D(floor constants+script→Task 6), E(baseline cron→Task 4), F(morning gate→Task 5), G(skin temp→Task 2), H(prompts/copy→Task 3), I(ConnectionsPanel→Task 7), J(crons→Task 8), K(flip+recompute→Task 10). All spec items mapped.
- **Deferred/vestigial (intentional):** `skin_temp_c` column kept (manual writer); `awaiting_whoop` enum value kept (CHECK constraint); `whoop_baselines` jsonb name kept (many readers).
- **Type consistency:** `RED_FLOOR_BAND_LOW`/`RED_FLOOR_CAP_MODERATE` (Task 6) used only in `score.ts`. `overnight_only`/`OVERNIGHT_KEYS` (Task 1) Python-local. `recheck` action string consistent across ChatChips + ChatPanel + intake route (Task 5). `SYNC_RECOVERY_PROMPT` name consistent across script.ts + intake route (Task 5).
