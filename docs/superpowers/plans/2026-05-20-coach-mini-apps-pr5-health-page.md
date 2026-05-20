# PR 5 — Health page (coach mini-apps restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/health` placeholder with real Coach + Log surfaces. Coach renders today's recovery score + HRV/RHR/sleep/strain cluster + morning feel summary + HRV-vs-baseline + Remi chat thread. Log lifts the existing `/metrics?sub=log` content (LogForm). Activates the `/metrics?sub=log` → `/health?tab=log` redirect and removes Log from the Metrics sub-pill row.

**Architecture:** Three structural moves. (1) New `HealthCoachClient` composes recovery data from existing hooks (`useDailyLogs`, `useCheckin`, `useHealthTrend`) — no new fetchers required. (2) New `HealthLogClient` is a thin wrapper around the existing `LogClient` (already at `components/log/LogClient.tsx`, no move needed). (3) `app/health/page.tsx` swaps from placeholder Client Component to Server Component with per-tab prefetch + hydrate.

After PR 4's fix, `MetricsShell` only shows Trends + Log pills. PR 5 removes Log too — Metrics becomes Trends-only until PR 6 builds Peter's real Metrics surface.

**Deferred from the spec's PR 5 scope (out of scope for v1):**
- **Morning intake flow embedded in `/health?tab=log`** — the intake is a chat-driven state machine that currently lives at `/coach` with `kind='morning_intake'`. Embedding it cleanly in the Log tab requires reusing the chat-stream pipeline in a non-chat context. The intake remains reachable via `/coach` until a follow-up phase wires it here.
- **Manual symptom log (free-text + tagged)** — new build; no existing surface to lift. Daily structured symptoms already captured via the morning intake's `checkins.sick / fatigue / bloating / soreness_areas / soreness_severity` fields and the LogForm's checkbox rows. The free-text journal can land in a future iteration.
- **HRV mini-sparkline** — v1 shows HRV-vs-baseline as a text line ("HRV 52 vs baseline 58, ↓6"). A real sparkline graphic can come later as polish.

**Tech Stack:** Next.js 15 App Router with hybrid SSR-hydrate pattern, TanStack Query (existing hooks reused), the `ChatPanel.thread` infrastructure from PR 3. No new migrations.

**Spec:** [docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md](../specs/2026-05-20-coach-mini-apps-restructure-design.md)

**Prior PRs in this arc:**
- [PR 1 — chat thread foundation](2026-05-20-coach-mini-apps-pr1-chat-foundation.md) (merged #98)
- [PR 2 — nav + scaffolding](2026-05-20-coach-mini-apps-pr2-nav-scaffolding.md) (merged #99)
- [PR 3 — Strength page](2026-05-20-coach-mini-apps-pr3-strength-page.md) (merged #101)
- [PR 4 — Diet page](2026-05-20-coach-mini-apps-pr4-diet-page.md) (merged #103)

**Suggested branch:** `feat/coach-pr5-health-page` (cut from `main`).

---

## File Structure

**New:**
- `components/health/HealthCoachClient.tsx` — Coach sub-tab body: recovery data block + Remi chat.
- `components/health/HealthLogClient.tsx` — Log sub-tab body: thin wrapper around the existing `LogClient`.

**Modified:**
- `app/health/page.tsx` — placeholder swapped for a real Server Component (auth gate, per-tab prefetch, hydrate, render).
- `app/metrics/page.tsx` — adds `?sub=log` redirect to `/health?tab=log`.
- `app/metrics/MetricsShell.tsx` — removes Log from the sub-pill row (only Trends remains).

**Untouched (deferred):**
- `app/metrics/_sub/LogSubPill.tsx` — kept until PR 6's broader /metrics cleanup. After this PR's redirect lands, the sub-pill is unreachable via the new nav but the file stays.
- `components/log/LogClient.tsx`, `components/log/LogForm.tsx` — reused as-is.
- The morning intake flow on `/coach` — stays reachable; PR 6 may move it to Health Log as a follow-up.

---

## Task 1: Build `HealthCoachClient` (Coach sub-tab body)

**Files:**
- Create: `components/health/HealthCoachClient.tsx`

The Coach sub-tab renders:
- **Header line**: today's recovery score (large number) + recovery tier label ("low" / "ok" / "high")
- **Stat tiles row**: HRV, RHR, sleep duration, sleep efficiency, strain (yesterday's values from `daily_logs`)
- **Morning feel row**: sick / fatigue / bloating / soreness summary from today's `checkin`
- **HRV trend line**: text "HRV {today} ms · 7d avg {avg} · baseline {baseline} ms" with a delta arrow
- **ChatPanel** scoped to `thread='remi'`

- [ ] **Step 1: Read existing recovery-related code**

```bash
cat lib/query/hooks/useDailyLogs.ts
cat lib/query/hooks/useCheckin.ts
cat lib/query/hooks/useHealthTrend.ts
```

Note:
- `useDailyLogs(userId, from, to)` returns `DailyLog[]` — each row has `recovery`, `hrv`, `resting_hr`, `sleep_hours`, `sleep_score`, `sleep_efficiency` (or similar), `strain`, etc.
- `useCheckin(userId, date)` returns the day's `checkin` row with `sick`, `fatigue`, `bloating`, `soreness_areas`, `soreness_severity`, `intake_state`.
- `useHealthTrend(userId, from, to)` returns rolling-average payloads — confirm what it exposes for HRV baseline + recent values.

Also read the `DailyLog` type in `lib/data/types.ts` to confirm exact field names (e.g., `sleep_hours` vs `sleep_h`; `sleep_efficiency_pct` vs `sleep_efficiency`).

- [ ] **Step 2: Read the WHOOP baseline source**

```bash
grep -n "whoop_baselines" lib/query/hooks lib/query/fetchers lib/data/types.ts | head -10
```

The baseline is on `profiles.whoop_baselines` JSONB. Find a hook that exposes it (likely `useProfile` or `useAthleteProfile`). If the baseline is only fetched server-side (not via a client hook), we can either:
- Pass the baseline value as a prop from the Server Component (preferred — Server Component reads it once)
- Or add a tiny client hook (less ideal — extra fetch)

Pick whichever is cleanest. The plan recommends passing as a prop.

- [ ] **Step 3: Build the component**

Create `components/health/HealthCoachClient.tsx`:

```tsx
"use client";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useHealthTrend } from "@/lib/query/hooks/useHealthTrend";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

type Props = {
  userId: string;
  /** Pre-fetched HRV baseline from profiles.whoop_baselines.hrv_mean.
   *  Passed from the Server Component so we don't add an extra client hook. */
  hrvBaseline: number | null;
};

export function HealthCoachClient({ userId, hrvBaseline }: Props) {
  const today = todayInUserTz();
  // Yesterday for the "completed day" stats (today is partial — sources arrive at different times)
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yIso = yesterday.toISOString().slice(0, 10);

  // 7d window: yesterday going back
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const sevenIso = sevenDaysAgo.toISOString().slice(0, 10);

  const { data: todayLogs } = useDailyLogs(userId, today, today);
  const { data: yesterdayLogs } = useDailyLogs(userId, yIso, yIso);
  const { data: weekLogs } = useDailyLogs(userId, sevenIso, yIso);
  const { data: checkin } = useCheckin(userId, today);

  const todayRow = todayLogs?.[0] ?? null;
  const yRow = yesterdayLogs?.[0] ?? null;

  const recovery = todayRow?.recovery ?? yRow?.recovery ?? null;
  const recoveryTier = recovery == null ? null : recovery < 34 ? "low" : recovery < 67 ? "ok" : "high";

  const hrv = yRow?.hrv ?? todayRow?.hrv ?? null;
  const rhr = yRow?.resting_hr ?? todayRow?.resting_hr ?? null;
  const sleepHours = yRow?.sleep_hours ?? null;
  const sleepEff = yRow?.sleep_efficiency ?? null; // confirm field name in Step 1
  const strain = yRow?.strain ?? null;

  const hrv7d = avg(weekLogs?.map((r) => r.hrv).filter((v): v is number => v != null) ?? []);
  const hrvDelta = hrv != null && hrvBaseline != null ? Math.round(hrv - hrvBaseline) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 88px)" }}>
      {/* Data block — top */}
      <div style={{ flex: "0 0 auto", padding: "8px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Recovery hero */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 36, fontWeight: 700, color: COLOR.textStrong }}>
            {recovery ?? "—"}
          </span>
          <span style={{ fontSize: 13, color: COLOR.textMuted }}>
            recovery{recoveryTier ? ` · ${recoveryTier}` : ""}
          </span>
        </div>

        {/* Stat tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
          <StatTile label="HRV" value={hrv != null ? `${Math.round(hrv)}` : "—"} unit="ms" />
          <StatTile label="RHR" value={rhr != null ? `${Math.round(rhr)}` : "—"} unit="bpm" />
          <StatTile label="Sleep" value={sleepHours != null ? `${sleepHours.toFixed(1)}` : "—"} unit="h" />
          <StatTile label="Eff" value={sleepEff != null ? `${Math.round(sleepEff)}` : "—"} unit="%" />
          <StatTile label="Strain" value={strain != null ? `${strain.toFixed(1)}` : "—"} unit="" />
        </div>

        {/* HRV trend line */}
        <div style={{ fontSize: 12, color: COLOR.textMid, padding: "6px 0" }}>
          HRV {hrv ?? "—"} ms
          {hrv7d != null ? ` · 7d avg ${Math.round(hrv7d)}` : ""}
          {hrvBaseline != null ? ` · baseline ${Math.round(hrvBaseline)}` : ""}
          {hrvDelta != null ? ` · ${hrvDelta >= 0 ? "↑" : "↓"}${Math.abs(hrvDelta)} vs baseline` : ""}
        </div>

        {/* Morning feel */}
        <MorningFeelRow checkin={checkin} />
      </div>

      {/* Chat block — bottom */}
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 320 }}>
        <ChatPanel
          userId={userId}
          embedded={true}
          initialKind="coach"
          thread="remi"
        />
      </div>
    </div>
  );
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function StatTile({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ background: COLOR.surfaceAlt, padding: "8px 6px", borderRadius: 6, textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>{value}</div>
      <div style={{ fontSize: 9, color: COLOR.textMuted, marginTop: 2 }}>
        {label}{unit ? ` (${unit})` : ""}
      </div>
    </div>
  );
}

function MorningFeelRow({ checkin }: { checkin: { sick?: string | null; fatigue?: string | null; bloating?: boolean | null; soreness_areas?: string[] | null; soreness_severity?: string | null; intake_state?: string | null } | null }) {
  if (!checkin) {
    return (
      <div style={{ fontSize: 12, color: COLOR.textMuted, fontStyle: "italic" }}>
        Morning intake not yet completed today.
      </div>
    );
  }

  const parts: string[] = [];
  if (checkin.sick && checkin.sick !== "none") parts.push(`sick: ${checkin.sick}`);
  if (checkin.fatigue && checkin.fatigue !== "none") parts.push(`fatigue: ${checkin.fatigue}`);
  if (checkin.bloating) parts.push("bloating");
  if (checkin.soreness_areas && checkin.soreness_areas.length > 0) {
    parts.push(`sore: ${checkin.soreness_areas.join(", ")}${checkin.soreness_severity ? ` (${checkin.soreness_severity})` : ""}`);
  }

  if (parts.length === 0) {
    return (
      <div style={{ fontSize: 12, color: COLOR.success }}>
        ✓ Morning feel: clean (no flags)
      </div>
    );
  }

  return (
    <div style={{ fontSize: 12, color: COLOR.warningDeep, background: COLOR.warningSoft, padding: "6px 10px", borderRadius: 6 }}>
      ⚠ {parts.join(" · ")}
    </div>
  );
}
```

**Critical**: confirm the exact field names on `DailyLog` and `Checkin` in `lib/data/types.ts`. The plan uses guesses (`sleep_efficiency`, `resting_hr`, etc.) — if the real names differ, adapt the property accesses. Don't widen types or use `any`; let TypeScript guide you to the correct names.

The HRV baseline prop comes from the Server Component (Task 3). For Task 1 just type it as `number | null` and assume the parent passes it.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If field names are wrong, fix them.

- [ ] **Step 5: Commit**

```bash
git add components/health/HealthCoachClient.tsx
git commit -m "feat(health): build Coach sub-tab with recovery cluster + Remi chat"
```

---

## Task 2: Build `HealthLogClient` (thin wrapper around `LogClient`)

**Files:**
- Create: `components/health/HealthLogClient.tsx`

The existing `LogClient` (at `components/log/LogClient.tsx`) renders the daily-log + checkin editor used on `/metrics?sub=log`. Per the survey, it has no route-specific dependencies — it's lift-able as-is.

- [ ] **Step 1: Read `components/log/LogClient.tsx` for its prop signature**

```bash
head -30 components/log/LogClient.tsx
```

Note its required props (likely `userId`, possibly `initialDate` or similar).

- [ ] **Step 2: Build the wrapper**

Create `components/health/HealthLogClient.tsx`:

```tsx
"use client";

import { LogClient } from "@/components/log/LogClient";

type Props = {
  userId: string;
  initialDate?: string;
};

export function HealthLogClient({ userId, initialDate }: Props) {
  return <LogClient userId={userId} initialDate={initialDate} />;
}
```

Adapt the props to match `LogClient`'s actual signature. If `LogClient` is a default export, use a default import. If its props differ from `userId` + `initialDate`, match exactly.

If `LogClient` only needs `userId` and reads the date from URL searchParams itself, drop `initialDate` from the wrapper.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
```

```bash
git add components/health/HealthLogClient.tsx
git commit -m "feat(health): wrap LogClient as HealthLogClient for /health?tab=log"
```

---

## Task 3: Replace `app/health/page.tsx` with a real Server Component

**Files:**
- Modify: `app/health/page.tsx`

The current placeholder is a Client Component using `useSearchParams`. Replace with a Server Component that gates auth, awaits searchParams, prefetches per tab, reads the HRV baseline from `profiles.whoop_baselines`, hydrates, and renders the appropriate Client.

- [ ] **Step 1: Read `/metrics?sub=log`'s prefetch pattern**

```bash
cat app/metrics/_sub/LogSubPill.tsx
```

Note what `fetchDailyLogsServer` + `fetchCheckinServer` calls happen, with what date range. Mirror this for the Log-tab prefetch.

- [ ] **Step 2: Read how the WHOOP baseline is read server-side**

```bash
grep -rn "whoop_baselines" lib/coach lib/query 2>/dev/null | head -10
```

Find the canonical read — likely a direct supabase select on `profiles` for `whoop_baselines`. Replicate it in the new Server Component to read `hrv_mean`.

- [ ] **Step 3: Rewrite `app/health/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
// add fetchHealthTrendServer if it exists (or compose from dailyLogs range)
import { SubPillNav } from "@/components/layout/SubPillNav";
import { HealthCoachClient } from "@/components/health/HealthCoachClient";
import { HealthLogClient } from "@/components/health/HealthLogClient";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam, date: dateParam } = await searchParams;
  const tab = tabParam === "log" ? "log" : "coach";

  const today = todayInUserTz();
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yIso = yesterday.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const sevenIso = sevenDaysAgo.toISOString().slice(0, 10);

  // HRV baseline — single profile read; pass as prop to HealthCoachClient.
  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", user.id)
    .maybeSingle();
  const baselines = (profile?.whoop_baselines as { hrv_mean?: number } | null) ?? null;
  const hrvBaseline = typeof baselines?.hrv_mean === "number" ? baselines.hrv_mean : null;

  const queryClient = makeServerQueryClient();
  const logDate = dateParam ?? today;

  // Prefetch union for both tabs:
  await Promise.all([
    // Coach tab needs today, yesterday, and 7d window of daily_logs + today's checkin
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, today, today),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, today, today),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, yIso, yIso),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, yIso, yIso),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, sevenIso, yIso),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, sevenIso, yIso),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, today),
      queryFn: () => fetchCheckinServer(supabase, user.id, today),
    }),
    // Log tab needs the selected date's daily_logs + checkin
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, logDate, logDate),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, logDate, logDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, logDate),
      queryFn: () => fetchCheckinServer(supabase, user.id, logDate),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Health</h1>
          <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
            Remi
          </p>
        </header>
        <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
        {tab === "coach" ? (
          <HealthCoachClient userId={user.id} hrvBaseline={hrvBaseline} />
        ) : (
          <HealthLogClient userId={user.id} initialDate={dateParam} />
        )}
      </div>
    </HydrationBoundary>
  );
}
```

Adjust:
- The query keys must match what `useDailyLogs` and `useCheckin` use on the client. Check `lib/query/keys.ts` for the canonical shape.
- If `whoop_baselines.hrv_mean` is named differently in the actual JSONB (e.g., `hrv_avg`, `hrv_baseline_ms`), adapt.
- If the Log tab needs additional prefetches (anything `LogForm` reads beyond daily_logs + checkin), include them.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Smoke (optional)**

```bash
rm -rf .next
npm run dev &
NEXT_PID=$!
sleep 10
```

Open `/health`:
- Coach tab: recovery score + stat tiles + HRV trend + morning feel + Remi chat (network shows `&thread=remi`)
- Send "is my HRV low today?" → Remi responds
- Tap Log → LogForm renders identically to `/metrics?sub=log`

Kill dev.

- [ ] **Step 6: Commit**

```bash
git add app/health/page.tsx
git commit -m "feat(health): real Server Component page.tsx with per-tab prefetch"
```

---

## Task 4: Redirect `/metrics?sub=log` → `/health?tab=log` + remove Log from MetricsShell

**Files:**
- Modify: `app/metrics/page.tsx`
- Modify: `app/metrics/MetricsShell.tsx`

Mirrors PR 4's `?sub=body` redirect. After PR 5, the Metrics sub-pill row only shows **Trends** — Strength + Body redirected away in PR 3-4, Log redirects away now.

- [ ] **Step 1: Add the redirect**

In `app/metrics/page.tsx`, just below the existing `?sub=body` redirect, add:

```ts
if (sub === "log") {
  // Preserve `?date=` if present so deep-links to a specific day's log
  // still land on the right day after the bounce.
  const dateQs = sp.date ? `&date=${encodeURIComponent(sp.date)}` : "";
  redirect(`/health?tab=log${dateQs}`);
}
```

- [ ] **Step 2: Remove Log from the sub-pill row**

In `app/metrics/MetricsShell.tsx`, find the SubPillNav pills array (currently has Trends + Log after PR 4). Remove Log:

```tsx
<SubPillNav
  pills={[
    // Trends is the only legacy sub-pill that doesn't redirect away.
    // PR 6 dismantles the rest of this shell.
    { key: "trends", label: "Trends" },
  ]}
  defaultKey="trends"
/>
```

- [ ] **Step 3: Confirm the default sub still works**

`app/metrics/page.tsx` already defaults `sub` to `"trends"` (PR 4 changed this). With Log removed from the pill row and added to the redirect list, tapping the Metrics tab still lands on Trends.

A user who lands at `/metrics?sub=log` via a stale URL is redirected to `/health?tab=log`. A user who lands at `/metrics?sub=body` redirects to `/diet?tab=coach`. Strength still redirects to `/strength?tab=coach`. The only `sub` that stays put is `trends`.

- [ ] **Step 4: Typecheck + smoke**

```bash
npm run typecheck
```

Smoke:
- Tap Metrics tab → lands on Trends (sub-pill row shows only Trends)
- `/metrics?sub=log` → instant redirect to `/health?tab=log`
- `/metrics?sub=log&date=2026-05-15` → redirect preserves date

- [ ] **Step 5: Commit**

```bash
git add app/metrics/page.tsx app/metrics/MetricsShell.tsx
git commit -m "feat(metrics): redirect ?sub=log to /health?tab=log + remove from sub-pills"
```

---

## Task 5: Final typecheck + smoke + push

- [ ] **Step 1: Clean typecheck**

```bash
rm -rf .next
npm run typecheck
```

Expected: PASS with zero errors.

- [ ] **Step 2: End-to-end smoke**

```bash
npm run dev &
NEXT_PID=$!
sleep 10
```

1. `/health` Coach tab: recovery + stats + HRV trend + morning feel + Remi chat
2. Send "should I do mobility today?" → Remi responds; network shows `&thread=remi`, `speaker_override: "remi"`
3. Tap Log pill → LogForm renders, sections work, save button persists daily_log/checkin updates
4. `/metrics?sub=log` → redirect to `/health?tab=log`
5. `/health?tab=log&date=2026-05-15` → LogForm opens to that day
6. Metrics tab → lands on Trends only
7. Legacy `/coach` chat still works

Kill dev.

- [ ] **Step 3: Show final commit log**

```bash
git log --oneline main..HEAD
```

Expected: 4-5 commits (plan + 4 tasks).

- [ ] **Step 4: Push**

```bash
git push -u origin feat/coach-pr5-health-page
```

---

## Subsequent PRs

- **PR 6** — Metrics page (Peter): coach trends + weekly review + nudges + Peter chat with specialist-thread context-injection. Deletes `/coach/*`, `/metrics/_sub/*`, `app/meal/page.tsx`'s redirect (entire folder), `lib/coach/router.ts`, `scripts/audit-speaker-routing.mjs`.
- **Future polish** (separate later PR): morning intake chat-flow embedded in `/health?tab=log`, manual symptom log, HRV mini-sparkline graphic.
