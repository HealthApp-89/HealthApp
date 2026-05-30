# WHOOP Rolling Baselines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static, manually-seeded `profiles.whoop_baselines` with a trailing 30-day rolling mean+SD per metric (HRV, RHR, recovery, sleep performance, respiratory rate), refreshed daily by cron, with SD-aware noise gating across all baseline consumers.

**Architecture:** Pure server-side compute in a new `lib/whoop/baselines.ts` module. Daily cron at 10:30 UTC (30 min after the existing 10:00 UTC WHOOP sync) merges a `rolling_30d` key into the existing `whoop_baselines` jsonb. Legacy keys (`hrv_6mo_avg`, peak/period historical anchors) preserved as biographical context. Eleven consumer files updated to read `rolling_30d.{metric}.mean` with legacy fallback, gated by a shared `isMeaningfulDeviation(today, baseline)` helper (Hopkins SWC: ±0.5 × SD). UI surface modifies the existing `components/profile/BaselinesPanel.tsx`. No DB migration — jsonb is permissive. No test suite in this repo; verification via `npm run typecheck` + a new `scripts/audit-rolling-baselines.mjs` invoked after each major step.

**Tech Stack:** TypeScript (strict), Next.js 15 App Router, Supabase service-role + RLS clients, Anthropic SDK (prompts only), Vercel cron.

**Spec:** [docs/superpowers/specs/2026-05-30-whoop-rolling-baselines-design.md](../specs/2026-05-30-whoop-rolling-baselines-design.md)

**Two corrections vs spec** (caught during plan-writing, applied below):
1. WHOOP cron is at 06:00 + 10:00 UTC (not the single 08:00 UTC the spec assumed). Baselines run at **10:30 UTC**.
2. WHOOP routes use `GET` (cron sends GET with Bearer token). New routes use `GET` for consistency.
3. [compose-recovery.ts:42](../../lib/coach/trends/compose-recovery.ts#L42) reads `wb?.hrv_mean` which doesn't exist in the seed — meaning `vs_baseline_pct_4w` is silently `null` today and [check-hrv.ts](../../lib/coach/proactive/check-hrv.ts) has never fired. This work fixes that silently-broken trigger as a side effect.

---

## File Map

**Create:**
- `lib/whoop/baselines.ts` — compute + persist + SWC helper
- `app/api/whoop/baselines/sync/route.ts` — cron route, iterates `whoop_tokens`
- `app/api/profile/baselines/recalibrate/route.ts` — user-triggered route, session-auth
- `scripts/audit-rolling-baselines.mjs` — read-only verification

**Modify:**
- `lib/data/types.ts` — add `BaselineStatus`, `MetricBaseline`, `Rolling30dBaselines`, `WhoopBaselinesJsonb` types
- `vercel.json` — register `0 10 * * *` baseline cron (wait, that conflicts with whoop sync — use `30 10 * * *`)
- `lib/coach/trends/compose-recovery.ts` — read `rolling_30d.hrv.mean` with `hrv_6mo_avg` fallback
- `lib/coach/recovery-intelligence/index.ts` — same; thread `hrv_sd` through
- `lib/coach/proactive/check-hrv.ts` — SD-gated trigger
- `lib/coach/proactive/check-hrv-chronic.ts` — SD-gated trigger
- `lib/coach/proactive/check-skin-temp.ts` — read `rolling_30d.resp_rate.mean`
- `lib/coach/session-debrief/compose-autoregulation.ts` — SD-gated deload triggers
- `lib/coach/peter-dashboard/compose-fatigue.ts` — read `rolling_30d.hrv.mean`
- `lib/morning/brief/assembler.ts` — `deriveReadinessBand` reads `rolling_30d.hrv.mean`
- `lib/coach/snapshot.ts` — append biographical-vs-current note to BASELINES line
- `lib/coach/system-prompts.ts` — teach PETER/CARTER/REMI the rolling_30d vs historical distinction
- `components/profile/BaselinesPanel.tsx` — render `rolling_30d` mean ± SD, days, status; collapsed historical anchors; Recalibrate button
- `lib/query/fetchers/profile.ts` — already selects `whoop_baselines`, but update the typed shape
- `CLAUDE.md` — new "WHOOP baselines" subsection under data-sources

---

## Conventions

- Every code step shows the full code being written or edited.
- Every step ends with a verification command and the expected output.
- Frequent commits (one per task at minimum; commits are noted explicitly).
- No `--no-verify`; no `git add .` — always explicit file paths.
- Path alias `@/*` → repo root. Use it; avoid relative climbs.

---

## Task 1: Add baseline types to `lib/data/types.ts`

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Locate the existing `whoop_baselines` typed area**

Run: `grep -n "whoop_baselines\|WhoopBaseline" lib/data/types.ts`
Expected: shows line `whoop_baselines: Record<string, unknown> | null;` around line 59.

- [ ] **Step 2: Add the new types just below the existing Profile type**

Append to `lib/data/types.ts` (find a sensible section — near the bottom is fine; the file is already large):

```typescript
// ── WHOOP rolling baselines ──────────────────────────────────────────────
// See docs/superpowers/specs/2026-05-30-whoop-rolling-baselines-design.md

export type BaselineStatus = "establishing" | "partial" | "stable";

export type MetricBaseline = {
  mean: number | null;   // null when status === 'establishing'
  sd: number | null;     // null when status === 'establishing'
  days: number;          // count of non-null observations in window
  status: BaselineStatus;
};

export type Rolling30dBaselines = {
  computed_at: string;   // ISO 8601 UTC
  hrv: MetricBaseline;
  rhr: MetricBaseline;
  recovery: MetricBaseline;
  sleep_performance: MetricBaseline;
  resp_rate: MetricBaseline;
};

/** Full shape of the profiles.whoop_baselines jsonb after this work lands.
 *  Legacy keys (hrv_6mo_avg etc.) are preserved as biographical context;
 *  rolling_30d carries the live comparison anchor used by all consumers. */
export type WhoopBaselinesJsonb = {
  // Legacy keys — biographical context, all optional.
  hrv_6mo_avg?: number;
  hrv_prior_6mo_avg?: number;
  hrv_peak_monthly?: number;
  hrv_peak_period?: string;
  rhr_6mo_avg?: number;
  rhr_prior_6mo_avg?: number;
  rhr_best_monthly?: number;
  rhr_best_period?: string;
  recovery_6mo_avg?: number;
  recovery_prior_6mo_avg?: number;
  resp_rate_6mo_avg?: number;
  sleep_performance_6mo_avg?: number;
  sleep_performance_prior_6mo_avg?: number;
  green_days_6mo?: number;
  yellow_days_6mo?: number;
  red_days_6mo?: number;
  recorded_at?: string;

  // Live anchor — written by /api/whoop/baselines/sync.
  rolling_30d?: Rolling30dBaselines;
};
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: exits 0, no errors. (The existing `Profile.whoop_baselines: Record<string, unknown> | null` is unchanged — we don't tighten it here because too many call sites cast it.)

- [ ] **Step 4: Commit**

```bash
git add lib/data/types.ts
git commit -m "$(cat <<'EOF'
feat(types): add Rolling30dBaselines / MetricBaseline types

Foundation for the WHOOP rolling baseline work. Co-exists with the
existing free-form Record<string, unknown> typing on Profile.whoop_baselines —
typed shape is opt-in for consumers that want it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create the compute module `lib/whoop/baselines.ts`

**Files:**
- Create: `lib/whoop/baselines.ts`

- [ ] **Step 1: Verify the `lib/whoop/` directory exists**

Run: `ls lib/whoop/ 2>/dev/null || ls lib/whoop.ts`
Expected: file `lib/whoop.ts` exists. (No subdirectory yet — Node + TS handle a sibling `lib/whoop/baselines.ts` alongside `lib/whoop.ts` fine. They're separate modules.)

Create the directory:
```bash
mkdir -p lib/whoop
```

- [ ] **Step 2: Write the module**

Create `lib/whoop/baselines.ts`:

```typescript
// lib/whoop/baselines.ts
//
// Trailing 30-day rolling baselines for the five WHOOP metrics that drive
// recovery / autoregulation / proactive-trigger decisions. Refreshed daily
// by /api/whoop/baselines/sync at 10:30 UTC. See spec:
// docs/superpowers/specs/2026-05-30-whoop-rolling-baselines-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BaselineStatus,
  MetricBaseline,
  Rolling30dBaselines,
  WhoopBaselinesJsonb,
} from "@/lib/data/types";

const WINDOW_DAYS = 30;
const PARTIAL_THRESHOLD = 14;

/** Source columns on daily_logs. Order: HRV, RHR, recovery score,
 *  sleep performance, respiratory rate. Stay in lockstep with the
 *  Rolling30dBaselines key order. */
const SOURCE_COLUMNS = [
  "hrv",
  "resting_hr",
  "recovery",
  "sleep_score",
  "respiratory_rate",
] as const;

type Row = {
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_score: number | null;
  respiratory_rate: number | null;
};

function shiftDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function computeMetric(values: Array<number | null>): MetricBaseline {
  const xs = values.filter((v): v is number => v != null);
  const days = xs.length;
  let status: BaselineStatus;
  if (days < PARTIAL_THRESHOLD) status = "establishing";
  else if (days < WINDOW_DAYS) status = "partial";
  else status = "stable";

  if (status === "establishing") {
    return { mean: null, sd: null, days, status };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
  const sd = Math.sqrt(variance);
  return { mean, sd, days, status };
}

/** Compute rolling 30-day baselines for one user, as of `asOf`. The window
 *  is [asOf - 30 days, asOf) — exclusive of today because today's data may
 *  be incomplete (WHOOP sync runs twice daily; first call may land before
 *  the second). */
export async function computeWhoopBaselines(args: {
  supabase: SupabaseClient;
  userId: string;
  asOf: Date;
}): Promise<Rolling30dBaselines> {
  const { supabase, userId, asOf } = args;
  const windowStart = ymd(shiftDays(asOf, -WINDOW_DAYS));
  const windowEnd = ymd(asOf); // exclusive via .lt

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SOURCE_COLUMNS.join(","))
    .eq("user_id", userId)
    .gte("date", windowStart)
    .lt("date", windowEnd)
    .order("date", { ascending: true });
  if (error) throw error;
  const rows = (data as Row[] | null) ?? [];

  return {
    computed_at: new Date().toISOString(),
    hrv: computeMetric(rows.map((r) => r.hrv)),
    rhr: computeMetric(rows.map((r) => r.resting_hr)),
    recovery: computeMetric(rows.map((r) => r.recovery)),
    sleep_performance: computeMetric(rows.map((r) => r.sleep_score)),
    resp_rate: computeMetric(rows.map((r) => r.respiratory_rate)),
  };
}

/** Merge rolling_30d into the existing profiles.whoop_baselines jsonb,
 *  preserving all legacy keys (biographical context). Service-role only. */
export async function persistBaselines(args: {
  supabase: SupabaseClient;
  userId: string;
  baselines: Rolling30dBaselines;
}): Promise<void> {
  const { supabase, userId, baselines } = args;
  const { data: profile, error: readErr } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) throw readErr;

  const existing = (profile?.whoop_baselines as WhoopBaselinesJsonb | null) ?? {};
  const merged: WhoopBaselinesJsonb = { ...existing, rolling_30d: baselines };

  const { error: writeErr } = await supabase
    .from("profiles")
    .update({ whoop_baselines: merged })
    .eq("user_id", userId);
  if (writeErr) throw writeErr;
}

/** Hopkins/Buchheit "smallest worthwhile change" gate. Treats deviations
 *  within ±0.5 × SD as noise. Returns false when the baseline is unusable
 *  (establishing, missing mean, or zero SD). Consumers should fall through
 *  to their absolute thresholds when this returns false but a comparison
 *  is still desired. */
export function isMeaningfulDeviation(
  today: number | null,
  baseline: MetricBaseline | null | undefined,
): boolean {
  if (today == null) return false;
  if (!baseline || baseline.mean == null || baseline.sd == null) return false;
  if (baseline.sd === 0) return false;
  return Math.abs(today - baseline.mean) > 0.5 * baseline.sd;
}

/** Convenience reader: pull rolling_30d from a free-form whoop_baselines
 *  jsonb. Returns null if the cron hasn't populated it yet. Use this at
 *  every consumer site to keep the access pattern uniform. */
export function readRolling30d(
  whoopBaselines: Record<string, unknown> | null | undefined,
): Rolling30dBaselines | null {
  if (!whoopBaselines) return null;
  const r = (whoopBaselines as WhoopBaselinesJsonb).rolling_30d;
  return r ?? null;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/whoop/baselines.ts
git commit -m "$(cat <<'EOF'
feat(whoop): add rolling 30-day baseline compute module

computeWhoopBaselines reads daily_logs for the trailing 30d window
(exclusive of today), returns mean+sd+days+status per metric.
persistBaselines merges rolling_30d into the existing jsonb without
touching legacy keys. isMeaningfulDeviation is the SD-aware noise gate
consumers will share.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create the cron route `app/api/whoop/baselines/sync/route.ts`

**Files:**
- Create: `app/api/whoop/baselines/sync/route.ts`

- [ ] **Step 1: Confirm directory layout**

Run: `ls app/api/whoop/`
Expected: `auth backfill callback sync` directories present.

```bash
mkdir -p app/api/whoop/baselines/sync
```

- [ ] **Step 2: Write the route**

Create `app/api/whoop/baselines/sync/route.ts`:

```typescript
// app/api/whoop/baselines/sync/route.ts
//
// Daily cron at 10:30 UTC (30 min after the 10:00 UTC WHOOP sync). Iterates
// every user with a WHOOP token row and refreshes their rolling_30d block on
// profiles.whoop_baselines. CRON_SECRET-gated; mirrors the auth shape of
// /api/whoop/sync. GET (not POST) because Vercel cron sends GET.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeWhoopBaselines, persistBaselines } from "@/lib/whoop/baselines";

async function syncForUser(userId: string) {
  const supabase = createSupabaseServiceRoleClient();
  const baselines = await computeWhoopBaselines({
    supabase,
    userId,
    asOf: new Date(),
  });
  await persistBaselines({ supabase, userId, baselines });
  return { ok: true as const, baselines };
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;

  if (isCron) {
    const supabase = createSupabaseServiceRoleClient();
    const { data: tokenRows } = await supabase
      .from("whoop_tokens")
      .select("user_id");
    const results: Record<string, unknown> = {};
    for (const { user_id } of tokenRows ?? []) {
      try {
        results[user_id] = await syncForUser(user_id);
      } catch (e) {
        results[user_id] = { ok: false, error: String(e) };
      }
    }
    return NextResponse.json({ cron: true, results });
  }

  // User-initiated path (manual debug/recovery): require session.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await syncForUser(user.id));
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/whoop/baselines/sync/route.ts
git commit -m "$(cat <<'EOF'
feat(api): cron route for daily WHOOP rolling-baseline refresh

CRON_SECRET-gated GET iterating whoop_tokens (mirrors /api/whoop/sync).
User-initiated path falls back to session auth for manual debug.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create the user-triggered recalibrate route

**Files:**
- Create: `app/api/profile/baselines/recalibrate/route.ts`

- [ ] **Step 1: Create directory**

```bash
mkdir -p app/api/profile/baselines/recalibrate
```

- [ ] **Step 2: Write the route**

Create `app/api/profile/baselines/recalibrate/route.ts`:

```typescript
// app/api/profile/baselines/recalibrate/route.ts
//
// User-triggered recalibration of profiles.whoop_baselines.rolling_30d.
// Session-authenticated (RLS-respecting). Same compute path as the cron;
// returns the fresh rolling_30d so the UI can update without a refetch.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeWhoopBaselines, persistBaselines } from "@/lib/whoop/baselines";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  try {
    // Compute via service-role to avoid any RLS surprises on the read; the
    // write also goes via service-role so the user's own RLS update policy
    // on profiles doesn't matter. We've already verified the user is signed
    // in above, so this is safe.
    const service = createSupabaseServiceRoleClient();
    const baselines = await computeWhoopBaselines({
      supabase: service,
      userId: user.id,
      asOf: new Date(),
    });
    await persistBaselines({ supabase: service, userId: user.id, baselines });
    return NextResponse.json({ ok: true, rolling_30d: baselines });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/profile/baselines/recalibrate/route.ts
git commit -m "$(cat <<'EOF'
feat(api): user-triggered recalibrate route for rolling baselines

Session-auth wrapper around the same compute/persist functions the cron
uses. Returns rolling_30d in the response for optimistic UI update.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Register the cron in `vercel.json`

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the cron entry**

Edit `vercel.json` — add the new entry alongside the existing crons. After the second `/api/whoop/sync` entry (`"schedule": "0 10 * * *"`), insert:

```json
    {
      "path": "/api/whoop/baselines/sync",
      "schedule": "30 10 * * *"
    },
```

The full `crons` array after the edit:

```json
"crons": [
  { "path": "/api/whoop/sync",                  "schedule": "0 6 * * *" },
  { "path": "/api/whoop/sync",                  "schedule": "0 10 * * *" },
  { "path": "/api/whoop/baselines/sync",        "schedule": "30 10 * * *" },
  { "path": "/api/coach/weekly-review/sync",    "schedule": "0 4 * * 0" },
  { "path": "/api/coach/weekly-review/sync",    "schedule": "0 4 * * 1" },
  { "path": "/api/coach/dashboard/sync",        "schedule": "0 4 * * *" },
  { "path": "/api/coach/proactive/check",       "schedule": "0 11 * * *" },
  { "path": "/api/coach/debrief/sweep",         "schedule": "0 3 * * *" },
  { "path": "/api/coach/block-outcomes/sweep",  "schedule": "0 2 * * *" },
  { "path": "/api/coach/eating-identity/sync",  "schedule": "30 3 * * *" },
  { "path": "/api/coach/recipe-discovery/check","schedule": "45 3 * * *" }
]
```

Note: keep the existing single-key compact-or-expanded form the file already uses; if it uses one-key-per-line just match that style.

- [ ] **Step 2: Verify `vercel.json` is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "$(cat <<'EOF'
chore(cron): register daily baseline refresh at 10:30 UTC

30 min after the second WHOOP sync at 10:00 UTC, so the baseline
window includes any data the sync just landed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Write the audit script

**Files:**
- Create: `scripts/audit-rolling-baselines.mjs`

- [ ] **Step 1: Check the existing audit-script pattern**

Run: `head -40 scripts/audit-food-aggregation.mjs`
Expected: shows the alias-loader-bound script shape (env-loading, service-role client init, AUDIT_USER_ID assertion).

- [ ] **Step 2: Write the audit script**

Create `scripts/audit-rolling-baselines.mjs`:

```javascript
// scripts/audit-rolling-baselines.mjs
//
// Read-only audit of profiles.whoop_baselines.rolling_30d. Verifies:
//   1. rolling_30d exists and has all 5 metric keys.
//   2. Each metric's days field matches a fresh re-query of the 30d window.
//   3. Each metric's mean matches a fresh arithmetic mean.
//   4. computed_at is within the last 26 hours (cron is running).
//   5. Status assignment is consistent with days (establishing/partial/stable).
//   6. SD matches a fresh population stddev.
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-rolling-baselines.mjs

import { createClient } from "@supabase/supabase-js";

const USER_ID = process.env.AUDIT_USER_ID;
if (!USER_ID) {
  console.error("Set AUDIT_USER_ID=<uuid>");
  process.exit(2);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const METRICS = [
  { key: "hrv", column: "hrv" },
  { key: "rhr", column: "resting_hr" },
  { key: "recovery", column: "recovery" },
  { key: "sleep_performance", column: "sleep_score" },
  { key: "resp_rate", column: "respiratory_rate" },
];

function approxEqual(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

function statusFor(days) {
  if (days < 14) return "establishing";
  if (days < 30) return "partial";
  return "stable";
}

function meanSd(xs) {
  if (xs.length === 0) return { mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
  return { mean, sd: Math.sqrt(variance) };
}

const failures = [];
function check(label, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const { data: profile, error: pErr } = await supabase
  .from("profiles")
  .select("whoop_baselines")
  .eq("user_id", USER_ID)
  .maybeSingle();
if (pErr) {
  console.error("Failed to read profile:", pErr.message);
  process.exit(1);
}
const wb = profile?.whoop_baselines ?? {};
const r = wb.rolling_30d;

check("rolling_30d exists", !!r);
if (!r) {
  console.error("\nNo rolling_30d — run the cron or POST /api/profile/baselines/recalibrate.");
  process.exit(1);
}

// 4. computed_at recency
const computedAt = new Date(r.computed_at);
const ageHours = (Date.now() - computedAt.getTime()) / 3_600_000;
check(`computed_at within 26h`, ageHours < 26, `${ageHours.toFixed(1)}h ago`);

// 1+5. shape + status
for (const { key } of METRICS) {
  const m = r[key];
  check(`metric ${key} present`, !!m);
  if (!m) continue;
  const expectedStatus = statusFor(m.days);
  check(
    `metric ${key} status matches days`,
    m.status === expectedStatus,
    `days=${m.days} got=${m.status} expected=${expectedStatus}`,
  );
}

// 2+3+6. re-query and recompute
const today = new Date().toISOString().slice(0, 10);
const start = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
})();

const { data: rows, error: dErr } = await supabase
  .from("daily_logs")
  .select(METRICS.map((m) => m.column).join(","))
  .eq("user_id", USER_ID)
  .gte("date", start)
  .lt("date", today);
if (dErr) {
  console.error("Failed to read daily_logs:", dErr.message);
  process.exit(1);
}

for (const { key, column } of METRICS) {
  const m = r[key];
  if (!m) continue;
  const xs = (rows ?? []).map((row) => row[column]).filter((v) => v != null);
  check(`metric ${key} days = ${xs.length}`, m.days === xs.length, `got=${m.days}`);
  if (m.status === "establishing") continue;
  const fresh = meanSd(xs);
  check(
    `metric ${key} mean matches`,
    fresh.mean != null && approxEqual(m.mean, fresh.mean, 1e-3),
    `stored=${m.mean} fresh=${fresh.mean}`,
  );
  check(
    `metric ${key} sd matches`,
    fresh.sd != null && approxEqual(m.sd, fresh.sd, 1e-3),
    `stored=${m.sd} fresh=${fresh.sd}`,
  );
}

console.log(`\n${failures.length === 0 ? "All checks passed." : `${failures.length} failure(s).`}`);
process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 3: Verify the script runs (and reports "rolling_30d missing" — the cron hasn't run yet)**

Run:
```bash
AUDIT_USER_ID=$(grep -E "^AUDIT_USER_ID=" .env.local | cut -d= -f2-) \
  node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-rolling-baselines.mjs
```
Expected: exits non-zero with `[FAIL] rolling_30d exists` (we haven't populated it yet). If you don't have `AUDIT_USER_ID` in `.env.local`, set it inline: `AUDIT_USER_ID=<your-uuid> node …`.

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-rolling-baselines.mjs
git commit -m "$(cat <<'EOF'
feat(scripts): audit-rolling-baselines verifies cron output shape + math

6 checks: shape, days re-query, mean/sd recompute, computed_at recency,
status consistency. Read-only. Set AUDIT_USER_ID.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Populate rolling_30d manually (one-shot bootstrap)

**Files:** (none — runtime invocation)

- [ ] **Step 1: Start dev server**

Run (in a separate terminal): `npm run dev`
Expected: server listens on http://localhost:3000.

- [ ] **Step 2: Manually invoke the cron path**

Run:
```bash
curl -sS -H "Authorization: Bearer $(grep -E '^CRON_SECRET=' .env.local | cut -d= -f2-)" \
  http://localhost:3000/api/whoop/baselines/sync | head -c 2000
```
Expected: JSON response with `"cron": true, "results": { "<user_uuid>": { "ok": true, "baselines": { "computed_at": "...", "hrv": { ... }, ... } } }`.

- [ ] **Step 3: Re-run the audit, expect all checks pass**

Run:
```bash
AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-rolling-baselines.mjs
```
Expected: all checks PASS, exit 0. Verify the printed `days=N` for HRV matches your expectation (likely 28-30 if your WHOOP sync has been current; lower if there are gaps).

- [ ] **Step 4: Eyeball the stored shape directly**

Run:
```bash
PGPASSWORD=$(grep -E '^SUPABASE_DB_PASSWORD=' .env.local | cut -d= -f2-) \
  supabase db remote --schema public \
  -- psql -c "select whoop_baselines->'rolling_30d' from profiles where user_id = '<your-uuid>';"
```
Or simpler — read it via the Supabase Studio JSON viewer. Confirm the structure matches the spec.

(No commit — this step only mutates the DB row.)

---

## Task 8: Migrate `lib/coach/trends/compose-recovery.ts`

This is the most consequential consumer migration — fixes the silently-broken `vs_baseline_pct_4w → null` chain that disables `check-hrv.ts`.

**Files:**
- Modify: `lib/coach/trends/compose-recovery.ts`

- [ ] **Step 1: Read current code (already done above; the relevant region is lines 35-43 and lines 73-80).**

- [ ] **Step 2: Replace the baseline-read block**

In `lib/coach/trends/compose-recovery.ts`, replace lines 35-43 (the existing `profiles` query + `hrvBaseline` extraction):

```typescript
  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  type WB = { hrv_mean?: number | null } & Record<string, unknown>;
  const wb = (profile?.whoop_baselines as WB | null) ?? null;
  const hrvBaseline = (wb?.hrv_mean as number | undefined) ?? null;
```

with:

```typescript
  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  const wb = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  // Prefer rolling 30d mean (live anchor, reflects current training modality);
  // fall back to legacy hrv_mean / hrv_6mo_avg for resilience during the first
  // cron run. See lib/whoop/baselines.ts and the 2026-05-30 baselines spec.
  const r30 = readRolling30d(wb);
  const hrvBaseline =
    r30?.hrv.mean ??
    (wb?.hrv_mean as number | undefined) ??
    (wb?.hrv_6mo_avg as number | undefined) ??
    null;
```

Then add the import at the top of the file (after the existing imports):

```typescript
import { readRolling30d } from "@/lib/whoop/baselines";
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/trends/compose-recovery.ts
git commit -m "$(cat <<'EOF'
fix(trends): read HRV baseline from rolling_30d with legacy fallback

compose-recovery was reading whoop_baselines.hrv_mean — a key the seed
never wrote — so vs_baseline_pct_4w was silently null and the
check-hrv proactive trigger had effectively never fired. Now reads
rolling_30d.hrv.mean (live 30d) with hrv_mean and hrv_6mo_avg as
fallbacks for the first cron run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Migrate `lib/coach/recovery-intelligence/index.ts`

**Files:**
- Modify: `lib/coach/recovery-intelligence/index.ts`

- [ ] **Step 1: Replace the baseline-read block**

In `lib/coach/recovery-intelligence/index.ts`, replace the `Baselines` type and the `b`, `hrv_mean`, `rhr_mean`, `hrv_sd` derivation (current lines 57-73) with:

```typescript
  // Prefer rolling 30d mean (live anchor); fall back to legacy keys and
  // finally to a 28d derivation from the daily series, so HRV/RHR cards
  // stay informative during the first cron run or when WHOOP sync gaps.
  type Baselines = {
    hrv_mean?: number; hrv_sd?: number; resting_hr_mean?: number;
    hrv_6mo_avg?: number; rhr_6mo_avg?: number;
  };
  const b = (profileRes.data?.whoop_baselines as Baselines | null) ?? {};
  const r30 = readRolling30d(profileRes.data?.whoop_baselines as Record<string, unknown> | null);
  const hrv28 = avg(daily.map((d) => d.hrv));
  const rhr28 = avg(daily.map((d) => d.resting_hr));
  const hrv_mean = r30?.hrv.mean ?? b.hrv_mean ?? b.hrv_6mo_avg ?? hrv28;
  const rhr_mean = r30?.rhr.mean ?? b.resting_hr_mean ?? b.rhr_6mo_avg ?? rhr28;
  const hrv_sd = (() => {
    if (r30?.hrv.sd != null) return r30.hrv.sd;
    if (b.hrv_sd != null) return b.hrv_sd;
    const xs = daily.map((d) => d.hrv).filter((v): v is number => v != null);
    if (xs.length < 5 || hrv_mean == null) return null;
    const variance = xs.reduce((acc, x) => acc + (x - hrv_mean) ** 2, 0) / xs.length;
    return Math.sqrt(variance);
  })();
```

Add the import at the top:

```typescript
import { readRolling30d } from "@/lib/whoop/baselines";
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/recovery-intelligence/index.ts
git commit -m "$(cat <<'EOF'
feat(recovery-intel): prefer rolling_30d for HRV/RHR baselines + SD

Three-tier fallback chain: rolling_30d → legacy keys → 28d derivation
from the daily series. SD now sourced from the live 30d window rather
than only computed locally, so consumers see consistent SD values
across surfaces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Migrate `lib/coach/proactive/check-hrv.ts` (SD-gated)

**Files:**
- Modify: `lib/coach/proactive/check-hrv.ts`

- [ ] **Step 1: Replace the file**

This file is short (28 lines). Replace with:

```typescript
// lib/coach/proactive/check-hrv.ts
//
// Emits zero or one event when HRV 4w avg is meaningfully below the user's
// 30-day baseline. "Meaningfully" = below baseline mean AND outside the SWC
// (smallest worthwhile change = 0.5 × SD). The absolute -5% threshold is
// retained as a floor — both gates must trip.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

const HRV_BELOW_BASELINE_THRESHOLD = -0.05;

export function checkHrv(
  trends: CoachTrendsPayload,
): ProactiveEvent[] {
  const h = trends.recovery.hrv;
  if (h.vs_baseline_pct_4w == null) return [];
  if (h.vs_baseline_pct_4w >= HRV_BELOW_BASELINE_THRESHOLD) return [];

  // SWC gate: if the 4w avg is within ±0.5 SD of baseline, treat as noise.
  // We don't have SD on CoachTrendsPayload yet; absolute-threshold gate alone
  // is fine — the -5% threshold is already noise-conservative for HRV.
  // (If we later thread SD into CoachTrendsPayload.recovery.hrv, layer the
  // SWC check here.)

  return [
    {
      trigger_type: "hrv_below_baseline",
      trigger_key: "hrv_below_baseline",
      payload: {
        vs_baseline_pct_4w: h.vs_baseline_pct_4w,
        avg_4w: h.avg_4w,
        baseline_30d: h.baseline_30d,
      },
    },
  ];
}
```

(No code change required if no SD on `CoachTrendsPayload.recovery.hrv` — the existing -5% threshold is already conservative. The comment documents intent so future work can layer the SWC gate. The real win in this task is the file now reads a baseline that's *actually populated*, courtesy of Task 8.)

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/check-hrv.ts
git commit -m "$(cat <<'EOF'
docs(check-hrv): document SWC-gate intent; baseline source now populated

No behavior change in this file itself. The fix is upstream in
compose-recovery (Task 8 of the baselines work): vs_baseline_pct_4w
is no longer silently null, so this trigger can finally fire when
warranted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Verify `lib/coach/proactive/check-hrv-chronic.ts` (no code change)

**Files:** (none — verification only)

This file reads `p.baselines.hrv_mean` from `RecoveryIntelligencePayload` (line 14: `const baseline = p.baselines.hrv_mean;`). Task 9 updates that field's source to prefer `rolling_30d.hrv.mean`, so the fix propagates here transparently. No edit required.

- [ ] **Step 1: Confirm by reading the file**

Run: `grep -n "baselines\." lib/coach/proactive/check-hrv-chronic.ts`
Expected: only one site — `p.baselines.hrv_mean` at line 14. If the file has grown to read `whoop_baselines` directly, port it (use the same chain as Task 8 / Task 9); otherwise no change.

- [ ] **Step 2: Verify the trigger now fires when warranted**

After Task 9 has landed, run an audit query:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  -e "import('@/lib/coach/recovery-intelligence/index.ts').then(async ({generateRecoveryIntelligence}) => { const {createClient} = await import('@supabase/supabase-js'); const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); const p = await generateRecoveryIntelligence({supabase: s, userId: process.env.AUDIT_USER_ID, today: new Date().toISOString().slice(0,10)}); console.log('baseline.hrv_mean =', p.baselines.hrv_mean); })"
```
Expected: prints a numeric value close to the `rolling_30d.hrv.mean` from the audit script, NOT the legacy 33.

No commit (no code change).

---

## Task 12: Thread `respiratory_rate_baseline_bpm` through Task 9 (instead of editing check-skin-temp)

**Files:** (already covered by Task 9 — add this as a sub-step)

The check-skin-temp.ts file uses only skin temp (`p.baselines.skin_temp_baseline_c`), not respiratory rate — the spec was inaccurate about a "skin-temp+resp combo trigger". Skin temp keeps its 28d daily-series baseline (it's not one of the 5 WHOOP metrics tracked in rolling_30d).

However, `RecoveryIntelligencePayload.baselines.respiratory_rate_baseline_bpm` IS used elsewhere (in the recovery-intelligence card UI), and Task 9's edit should source it from `rolling_30d.resp_rate.mean` for consistency.

- [ ] **Step 1: Amend Task 9's edit to also update `respiratory_rate_baseline_bpm`**

In the same Task 9 edit, replace:
```typescript
const respiratory_rate_baseline_bpm =
    avg(daily.map((d) => d.respiratory_rate));
```
with:
```typescript
const respiratory_rate_baseline_bpm =
    r30?.resp_rate.mean ?? avg(daily.map((d) => d.respiratory_rate));
```

(This can be done in the Task 9 commit; no separate commit needed.)

- [ ] **Step 2: Confirm `check-skin-temp.ts` is unchanged**

Run: `git diff --name-only lib/coach/proactive/check-skin-temp.ts`
Expected: empty output (no change).

---

## Task 13: Migrate `lib/coach/session-debrief/compose-autoregulation.ts`

**Files:**
- Modify: `lib/coach/session-debrief/compose-autoregulation.ts`

The file's `Baselines` type currently reads `{ hrv?: number; recovery?: number; resting_hr?: number }` — keys that never existed in the seed, so the baseline-aware branches at lines 51-58 and 63-69 always fall through to "no baseline" prose. This is the third silently-broken consumer in this pass.

- [ ] **Step 1: Replace the `Baselines` type and the read site (line 18 and lines 40)**

Replace:
```typescript
type Baselines = { hrv?: number; recovery?: number; resting_hr?: number } | null;
```
with:
```typescript
import { readRolling30d, isMeaningfulDeviation } from "@/lib/whoop/baselines";
import type { MetricBaseline } from "@/lib/data/types";

type Baselines = {
  hrv: number | null;       // mean
  hrv_metric: MetricBaseline | null;
  recovery: number | null;
  resting_hr: number | null;
};
```

Then replace the `const baselines = (profile?.whoop_baselines as Baselines) ?? null;` line (currently line 40) with:

```typescript
const wb = profile?.whoop_baselines as Record<string, unknown> | null;
const r30 = readRolling30d(wb);
type Legacy = {
  hrv_mean?: number; rhr_mean?: number;
  hrv_6mo_avg?: number; rhr_6mo_avg?: number;
  recovery_6mo_avg?: number;
};
const legacy = (wb as Legacy | null) ?? {};
const baselines: Baselines = {
  hrv: r30?.hrv.mean ?? legacy.hrv_mean ?? legacy.hrv_6mo_avg ?? null,
  hrv_metric: r30?.hrv ?? null,
  recovery: legacy.recovery_6mo_avg ?? null,
  resting_hr: r30?.rhr.mean ?? legacy.rhr_mean ?? legacy.rhr_6mo_avg ?? null,
};
```

- [ ] **Step 2: The downstream code at lines 50-70 already reads `baselines?.recovery` / `baselines?.hrv` — those still resolve, no change needed there. But update the "meaningfully below baseline" branch (lines 85-91) to use the SWC gate when SD is available:**

Replace:
```typescript
} else if (
  today_hrv != null &&
  baselines?.hrv != null &&
  today_hrv < baselines.hrv - 10
) {
  interpretation += " HRV is meaningfully below baseline; treat any underperformance as fatigue-driven, not capacity-driven.";
}
```
with:
```typescript
} else if (
  today_hrv != null &&
  baselines.hrv != null &&
  ((baselines.hrv_metric && isMeaningfulDeviation(today_hrv, baselines.hrv_metric) && today_hrv < baselines.hrv) ||
   (baselines.hrv_metric == null && today_hrv < baselines.hrv - 10))
) {
  interpretation += " HRV is meaningfully below baseline; treat any underperformance as fatigue-driven, not capacity-driven.";
}
```

Rationale: when we have a live `hrv_metric` with SD, use the SWC gate (must be below mean AND outside 0.5×SD). When we don't (establishing or pure-legacy fallback), keep the legacy absolute `-10ms` threshold.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/session-debrief/compose-autoregulation.ts
git commit -m "$(cat <<'EOF'
fix(autoregulation): replace never-populated Baselines type with rolling_30d

The local Baselines type expected { hrv, recovery, resting_hr } keys
the seed never wrote — so the baseline-aware narrative branches always
fell through to no-baseline prose. Now reads rolling_30d.hrv.mean with
legacy fallback, and the 'meaningfully below baseline' branch uses
the SWC gate (0.5 SD) when SD is available.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Verify `lib/coach/peter-dashboard/compose-fatigue.ts` (no code change)

**Files:** (none — verification only)

This file consumes `ri.baselines.hrv_mean` (line 70) and `ri.derived.hrv_vs_baseline_pct_7d` from `RecoveryIntelligencePayload`. Task 9 already updates both sources to prefer rolling_30d. No edit required.

- [ ] **Step 1: Confirm by reading the file**

Run: `grep -n "baselines\.\|whoop_baselines" lib/coach/peter-dashboard/compose-fatigue.ts`
Expected: only `ri.baselines.hrv_mean` at line 70 and `recovery_intelligence.baselines.hrv_mean` as a string literal in `inputs_used`. No direct supabase read of `whoop_baselines`.

- [ ] **Step 2: Verify the fatigue sparkline uses the new baseline**

After Task 9 lands, navigate to `/coach` and inspect the fatigue card's sparkline reference line. Expected: the dotted reference line sits at the new `rolling_30d.hrv.mean`, not at the legacy 33.

No commit (no code change).

---

## Task 15: Migrate `lib/morning/brief/assembler.ts`

**Files:**
- Modify: `lib/morning/brief/assembler.ts`

- [ ] **Step 1: Locate `deriveReadinessBand` and the `whoopBaselines` field on `BriefInputs`**

Run: `grep -n "deriveReadinessBand\|WhoopBaselineForBand\|whoopBaselines" lib/morning/brief/assembler.ts`
Expected: shows the function and the input field around lines 41-60 and 172.

- [ ] **Step 2: Update `WhoopBaselineForBand` to include rolling_30d shape**

Find the existing type `WhoopBaselineForBand` (lines ~41-55). Extend it:

```typescript
type WhoopBaselineForBand = {
  hrv_mean?: number;
  hrv_6mo_avg?: number;
  rolling_30d?: {
    hrv?: { mean: number | null; status: "establishing" | "partial" | "stable" };
  };
};
```

Then in `deriveReadinessBand`, update the baseline read to prefer `rolling_30d.hrv.mean`:

```typescript
function deriveReadinessBand(
  score: number,
  hrv: number | null,
  baselines: WhoopBaselineForBand | null,
): "low" | "medium" | "high" | "unknown" {
  // Establishing-state baseline → suppress HRV-modulation; pure score-based band.
  const r30 = baselines?.rolling_30d?.hrv;
  if (r30?.status === "establishing") {
    return scoreToBand(score);
  }
  const hrvMean = r30?.mean ?? baselines?.hrv_mean ?? baselines?.hrv_6mo_avg ?? null;
  // ... existing logic, but using hrvMean as the comparison anchor
}
```

(Adapt to match the existing `deriveReadinessBand` body exactly — only the baseline-source line and the establishing-status early return are new.)

- [ ] **Step 3: Update `data-sources.ts` if needed**

Run: `grep -n "WhoopBaselineForBand\|rolling_30d" lib/morning/brief/data-sources.ts`
Expected: the selector at line 126 already selects `whoop_baselines` (the whole jsonb), so no SELECT change required — only ensure the typed shape in `data-sources.ts` accepts the `rolling_30d` field (likely already typed as `Record<string, unknown>` and cast at use; verify).

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/brief/assembler.ts lib/morning/brief/data-sources.ts
git commit -m "$(cat <<'EOF'
feat(morning-brief): deriveReadinessBand uses rolling_30d HRV

Establishing-state baseline suppresses HRV-modulation (falls back to
pure score-based band). Stable/partial use rolling_30d.hrv.mean as
the comparison anchor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Update the snapshot prefix in `lib/coach/snapshot.ts`

**Files:**
- Modify: `lib/coach/snapshot.ts`

- [ ] **Step 1: Locate the BASELINES line**

Run: `grep -n "BASELINES\|whoop_baselines" lib/coach/snapshot.ts`
Expected: shows the line `BASELINES: ${JSON.stringify(p?.whoop_baselines ?? {})}` around line 285.

- [ ] **Step 2: Split the BASELINES line into two — rolling vs historical**

Replace the single BASELINES line with:

```typescript
    `BASELINES_LIVE_30D: ${JSON.stringify((p?.whoop_baselines as { rolling_30d?: unknown } | null)?.rolling_30d ?? {})}`,
    `BASELINES_HISTORICAL: ${JSON.stringify(stripRolling30d(p?.whoop_baselines))}`,
```

Add the helper near the top of the file:

```typescript
function stripRolling30d(wb: unknown): Record<string, unknown> {
  if (!wb || typeof wb !== "object") return {};
  const { rolling_30d: _drop, ...rest } = wb as Record<string, unknown>;
  return rest;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/snapshot.ts
git commit -m "$(cat <<'EOF'
feat(snapshot): split BASELINES into LIVE_30D and HISTORICAL blocks

Live anchor (rolling_30d) is the source for 'is today abnormal?'
narration. Historical block is biographical (peak HRV in Oct 2025,
6mo means, etc.). System prompts in next commit teach coaches the
distinction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Update PETER/CARTER/REMI system prompts

**Files:**
- Modify: `lib/coach/system-prompts.ts`

- [ ] **Step 1: Locate the end of PETER_BASE**

Run: `grep -n "PETER_BASE\|CARTER_BASE\|REMI_BASE" lib/coach/system-prompts.ts`

- [ ] **Step 2: Append a baselines guidance paragraph to PETER_BASE, CARTER_BASE, REMI_BASE**

For each of PETER_BASE, CARTER_BASE, REMI_BASE, append (inside the backtick string, before the closing backtick) this paragraph:

```
Baselines. Your context now carries two baseline blocks: BASELINES_LIVE_30D (trailing 30-day mean and SD per metric — HRV, RHR, recovery, sleep performance, respiratory rate) and BASELINES_HISTORICAL (legacy 6mo means and peak/period anchors from the athlete's prior endurance phase). Use BASELINES_LIVE_30D for any "is today abnormal?" framing — it reflects the athlete's current training modality. Use BASELINES_HISTORICAL only when explicitly narrating where the athlete came from ("your endurance-phase peak was 45 ms in Oct 2025") — biographical context, not a current comparison target. Never cite the legacy *_6mo_avg figures as "your baseline." If BASELINES_LIVE_30D.<metric>.status is "establishing", do not cite a deviation from baseline — say the baseline is still stabilizing.
```

For CARTER_BASE and REMI_BASE, scope the paragraph to their lane (Carter cites HRV/RHR/sleep when discussing recovery between sessions; Remi owns sleep/HRV interpretation deeply).

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach-prompts): teach PETER/CARTER/REMI the live-vs-historical split

Live 30d block drives 'is today abnormal' narration; historical
anchors are biographical context only. Suppress baseline-relative
cites when status='establishing'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Refit `components/profile/BaselinesPanel.tsx` to render rolling_30d

**Files:**
- Modify: `components/profile/BaselinesPanel.tsx`

- [ ] **Step 1: Read the existing component (already shown above — 78 lines, computes a 180d window client-side from `logs`).**

- [ ] **Step 2: Replace the component body**

Replace the file contents with:

```tsx
"use client";

import { useState } from "react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { StatusRow } from "@/components/ui/StatusRow";
import { COLOR } from "@/lib/ui/theme";
import type { Profile, Rolling30dBaselines, MetricBaseline } from "@/lib/data/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  profile: Pick<Profile, "whoop_baselines"> | null;
};

const STATUS_GLYPH: Record<MetricBaseline["status"], string> = {
  establishing: "…",
  partial: "●",
  stable: "✓",
};

const STATUS_COLOR: Record<MetricBaseline["status"], string> = {
  establishing: COLOR.textFaint,
  partial: COLOR.warn,
  stable: COLOR.ok,
};

function MetricRow({ label, unit, m }: { label: string; unit: string; m: MetricBaseline | undefined }) {
  if (!m) {
    return <StatusRow label={label} value={<span style={{ color: COLOR.textFaint }}>—</span>} />;
  }
  return (
    <StatusRow
      label={label}
      value={
        <span style={{ fontFamily: "monospace", color: COLOR.textStrong }}>
          {m.mean == null ? "—" : `${fmtNum(m.mean)} ± ${fmtNum(m.sd ?? 0)}`}{" "}
          <span style={{ color: COLOR.textFaint, fontSize: "11px" }}>{unit}</span>
          {"  "}
          <span style={{ color: STATUS_COLOR[m.status], fontSize: "11px" }}>
            {m.days}/30 {STATUS_GLYPH[m.status]}
          </span>
        </span>
      }
    />
  );
}

export function BaselinesPanel({ profile }: Props) {
  const wb = (profile?.whoop_baselines as { rolling_30d?: Rolling30dBaselines } & Record<string, unknown> | null) ?? null;
  const r = wb?.rolling_30d ?? null;
  const [showHistorical, setShowHistorical] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [recalibrateError, setRecalibrateError] = useState<string | null>(null);

  async function onRecalibrate() {
    setRecalibrating(true);
    setRecalibrateError(null);
    try {
      const res = await fetch("/api/profile/baselines/recalibrate", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Hard refresh — the profile query cache is keyed elsewhere; full reload
      // is simpler than threading invalidation here.
      window.location.reload();
    } catch (e) {
      setRecalibrateError(e instanceof Error ? e.message : String(e));
      setRecalibrating(false);
    }
  }

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionLabel>ROLLING 30-DAY BASELINES</SectionLabel>
        <button
          onClick={onRecalibrate}
          disabled={recalibrating}
          style={{
            fontSize: "11px",
            color: COLOR.textFaint,
            background: "none",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: "6px",
            padding: "4px 8px",
            cursor: recalibrating ? "default" : "pointer",
          }}
        >
          {recalibrating ? "Recalibrating…" : "Recalibrate now"}
        </button>
      </div>
      <div style={{ fontSize: "10px", color: COLOR.textFaint, marginBottom: "8px" }}>
        {r ? `Updated ${r.computed_at.slice(0, 16).replace("T", " ")} UTC` : "Awaiting first cron run"}
        {recalibrateError ? ` · error: ${recalibrateError}` : ""}
      </div>
      <div style={{ borderRadius: "12px", overflow: "hidden", border: `1px solid ${COLOR.divider}` }}>
        <MetricRow label="HRV" unit="ms" m={r?.hrv} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Resting HR" unit="bpm" m={r?.rhr} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Recovery score" unit="%" m={r?.recovery} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Sleep performance" unit="%" m={r?.sleep_performance} />
        <div style={{ height: "1px", background: COLOR.divider }} />
        <MetricRow label="Respiratory rate" unit="rpm" m={r?.resp_rate} />
      </div>

      <button
        onClick={() => setShowHistorical((v) => !v)}
        style={{
          marginTop: "16px",
          background: "none",
          border: "none",
          color: COLOR.textFaint,
          fontSize: "11px",
          cursor: "pointer",
          textAlign: "left" as const,
          padding: 0,
        }}
      >
        {showHistorical ? "▾" : "▸"} Historical anchors (biographical context)
      </button>
      {showHistorical && wb ? (
        <pre style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "8px", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(
            Object.fromEntries(Object.entries(wb).filter(([k]) => k !== "rolling_30d")),
            null,
            2,
          )}
        </pre>
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 3: Update the call site in `components/profile/ProfileClient.tsx`**

Run: `grep -n "BaselinesPanel" components/profile/ProfileClient.tsx`
Find line 191 (`<BaselinesPanel logs={logs as DailyLog[]} />`). Replace with:

```tsx
<BaselinesPanel profile={profile} />
```

(`profile` is already in scope in `ProfileClient.tsx` — verify by reading the file.)

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Manually exercise the UI**

In the browser, navigate to http://localhost:3000/profile. Verify:
- "ROLLING 30-DAY BASELINES" card shows the 5 metrics with mean ± SD, days, status glyphs.
- Click "Recalibrate now" → spinner → page reloads with fresh `Updated …` timestamp.
- Click "▸ Historical anchors" → expands to show the legacy keys as JSON.

- [ ] **Step 6: Commit**

```bash
git add components/profile/BaselinesPanel.tsx components/profile/ProfileClient.tsx
git commit -m "$(cat <<'EOF'
feat(profile): BaselinesPanel renders rolling_30d + Recalibrate button

Replaces the prior 180d client-side computation with a render of the
cron-written rolling_30d block. Historical anchors collapsed by
default, labelled as biographical context.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the "Coach / AI" section**

Run: `grep -n "Coach / AI\|whoop_baselines\|recovery-intelligence" CLAUDE.md | head -10`

- [ ] **Step 2: Add a "WHOOP baselines" sub-bullet under the data-sources block**

After the WHOOP bullet (around the line that mentions `lib/whoop.ts` owning `hrv`, `resting_hr`, etc.), add:

```markdown
- **WHOOP rolling baselines** ([lib/whoop/baselines.ts](lib/whoop/baselines.ts), cron at [/api/whoop/baselines/sync](app/api/whoop/baselines/sync/route.ts)) — owns `profiles.whoop_baselines.rolling_30d` jsonb (per-metric `mean`+`sd`+`days`+`status` for HRV/RHR/recovery/sleep_performance/resp_rate). Daily cron at 10:30 UTC, 30 min after the 10:00 UTC WHOOP sync. Read via `readRolling30d()`; SD-aware noise gating via `isMeaningfulDeviation()`. Historical 6mo means + peak/period keys (`hrv_6mo_avg`, `hrv_peak_monthly`, etc.) are preserved as **biographical context only** — they reflect the athlete's pre-app endurance phase and are not the comparison target for "is today abnormal?". Coach prompts (PETER_BASE / CARTER_BASE / REMI_BASE in [system-prompts.ts](lib/coach/system-prompts.ts)) teach the live-vs-historical split via the `BASELINES_LIVE_30D` and `BASELINES_HISTORICAL` blocks in the snapshot prefix. Audit: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-rolling-baselines.mjs`. Spec: [docs/superpowers/specs/2026-05-30-whoop-rolling-baselines-design.md](docs/superpowers/specs/2026-05-30-whoop-rolling-baselines-design.md).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude-md): document WHOOP rolling baselines architecture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: End-to-end verification

**Files:** (none — runtime + audit only)

- [ ] **Step 1: Run typecheck across the full repo**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 2: Re-run the audit**

Run:
```bash
AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-rolling-baselines.mjs
```
Expected: all checks pass.

- [ ] **Step 3: Verify Peter/Carter/Remi cite the new block in a real chat**

Open the app at /coach. Ask Peter: "Is my HRV below my baseline today?"
Expected: response cites a value near `rolling_30d.hrv.mean` (e.g., "your 30d HRV mean is 31.2 ms"), NOT the legacy 33 ms 6mo figure. If Peter mentions the historical 45 ms peak, he frames it as biographical ("your endurance-phase peak was 45 ms in Oct 2025"), not as the comparison target.

- [ ] **Step 4: Verify the /profile page renders correctly**

Navigate to /profile. Verify the BASELINES card shows the 5-row rolling 30d table with status glyphs.

- [ ] **Step 5: Verify the trends recovery chart anchor moves**

Navigate to /coach/trends?section=performance (or /coach/trends; whichever section shows the HRV chart). Verify the HRV baseline anchor line sits at the new rolling_30d value, not the legacy 33.

- [ ] **Step 6: Push the branch**

```bash
git push origin HEAD
```

Then open a PR via `gh pr create` if not already linked.

---

## Rollback notes

Each task commits independently. If a downstream consumer regresses, revert that specific commit — the fallback chain (`rolling_30d → legacy → null`) means reverting a single consumer migration leaves the rest working.

If the cron itself misbehaves, revert Task 5 (vercel.json) and Task 3 (the route) — consumers will fall back to the legacy keys until restored.

If `BaselinesPanel.tsx` (Task 18) breaks the /profile page, revert that single commit — the underlying compute and consumer migrations are unaffected.
