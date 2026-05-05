# Dashboard cleanup + airtight date logic — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean the dashboard by removing the bundled `MorningCheckIn` block (relocate the session plan card to a new `/strength?view=today` sub-tab; check-in form lives only in `/log`), and make every server-side "today" / weekday computation route through a single tz-aware module driven by `USER_TIMEZONE` env var (default `Asia/Dubai`). LLM coach prompts gain an unambiguous date anchor so the model never has to guess what "today" or "Monday" means.

**Architecture:** New `lib/time.ts` is the single source of truth for now/today in the user's tz. Every server-side `new Date().toISOString().slice(0, 10)` and weekday-from-`Date` call funnels through it. The chat-coach / insights snapshot lives in a new shared `lib/coach/snapshot.ts` whose body is cache-friendly and whose `NOW:` line is per-turn (uncached).

**Tech Stack:** Next.js 15 (App Router) · Supabase (Postgres + Auth + RLS) · TypeScript (strict) · Tailwind v4 · Anthropic SDK · platform `Intl.DateTimeFormat` (no Luxon, no date-fns-tz).

**Spec:** [docs/superpowers/specs/2026-05-05-dashboard-cleanup-and-date-logic-design.md](../specs/2026-05-05-dashboard-cleanup-and-date-logic-design.md)

**Project verification policy:** Per [CLAUDE.md](../../../CLAUDE.md), there is no test suite. Verification at every task is `npm run typecheck` + `npm run lint` + a defined manual check. Do not introduce a test runner; do not write `*.test.ts` files unless explicitly requested.

---

## File map

**Create**

- [lib/time.ts](../../../lib/time.ts) — tz-aware "now"/"today" source of truth (~95 lines)
- [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx) — read-only relocated session-plan card (~55 lines)
- [lib/coach/snapshot.ts](../../../lib/coach/snapshot.ts) — shared LLM snapshot builder with NOW line + relative labels (~120 lines)

**Modify**

- [.env.example](../../../.env.example) — add `USER_TIMEZONE`
- [app/page.tsx](../../../app/page.tsx) — drop `MorningCheckIn`; route `today` through `todayInUserTz()`
- [app/coach/page.tsx](../../../app/coach/page.tsx) — pass tz-anchored `Date` to `reviewWindow()` and `recommendationWeekStart()`
- [app/log/page.tsx](../../../app/log/page.tsx) — `resolveDate()` uses `todayInUserTz()`
- [app/log/actions.ts](../../../app/log/actions.ts) — `saveLog` / `saveCheckin` `date` fallbacks via `todayInUserTz()`
- [app/strength/page.tsx](../../../app/strength/page.tsx) — add `view=today` branch; `todayIso` via `todayInUserTz()`
- [app/api/insights/route.ts](../../../app/api/insights/route.ts) — `today` via `todayInUserTz()`; use `buildSnapshot()`; prepend `NOW:` line; extend system prompt
- [app/api/insights/weekly/route.ts](../../../app/api/insights/weekly/route.ts) — pass tz-anchored `Date` to helpers; use `buildSnapshot()`; prepend `NOW:` line; extend system prompt
- [app/api/insights/strength/route.ts](../../../app/api/insights/strength/route.ts) — `today` via `todayInUserTz()`
- [components/layout/Header.tsx](../../../components/layout/Header.tsx) — render via `formatHeaderDate()`
- [components/strength/StrengthNav.tsx](../../../components/strength/StrengthNav.tsx) — add `today` view
- [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts) — `getTodaySession()` uses `weekdayInUserTz()`

**Delete**

- [components/dashboard/MorningCheckIn.tsx](../../../components/dashboard/MorningCheckIn.tsx) — fully replaced by `/log`'s "Morning Feel" form (form half) and `TodayPlanCard` (plan half)

---

# Slice 1 — `lib/time.ts` and the sweep

Goal: every server-side "today" / weekday call uses the same tz-aware source. After this slice, the dashboard, coach, log, and strength pages all show "today" consistent with `USER_TIMEZONE` (default `Asia/Dubai`).

## Task 1.1: Add `USER_TIMEZONE` env var

**Files:**
- Modify: [.env.example](../../../.env.example)

- [ ] **Step 1: Append the new env var section**

Open `.env.example`. Add at the end (or in a logical neighborhood — match existing grouping conventions):

```
# IANA timezone used for all server-side "today" / "now" computations and
# the LLM coach prompt's NOW: anchor. Defaults to Asia/Dubai if unset.
# Example overrides for dev: America/Los_Angeles, Europe/Paris.
USER_TIMEZONE=Asia/Dubai
```

- [ ] **Step 2: Verify**

```bash
grep -n USER_TIMEZONE .env.example
```

Expected: one match showing the line above.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore: add USER_TIMEZONE env var entry"
```

## Task 1.2: Create `lib/time.ts`

**Files:**
- Create: [lib/time.ts](../../../lib/time.ts)

- [ ] **Step 1: Write the module**

Create `lib/time.ts` with the following exact content:

```ts
// lib/time.ts
//
// Single source of truth for "now" / "today" in the user's timezone.
// Server-side only; uses platform Intl APIs (no Luxon, no date-fns-tz).
// USER_TIMEZONE env var, default Asia/Dubai.

const USER_TZ = process.env.USER_TIMEZONE || "Asia/Dubai";

let _logged = false;
function logOnce(): void {
  if (_logged) return;
  _logged = true;
  console.log(`[time] USER_TIMEZONE=${USER_TZ}`);
}

export const USER_TIMEZONE = USER_TZ;

type Parts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  weekday: string;
};

function partsInUserTz(now: Date): Parts {
  logOnce();
  // en-CA gives us YYYY-MM-DD-friendly numeric formatting; weekday is "long".
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TZ,
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
  // Some platforms emit "24" for midnight; normalize to "00".
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

/** YYYY-MM-DD in the user's timezone. Replaces every server-side
 *  `new Date().toISOString().slice(0, 10)`. */
export function todayInUserTz(now: Date = new Date()): string {
  const p = partsInUserTz(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Day of week in user's tz: "Monday" | "Tuesday" | ... */
export function weekdayInUserTz(now: Date = new Date()): string {
  return partsInUserTz(now).weekday;
}

/** "HH:mm" in user's tz, 24h. */
export function localTimeInUserTz(now: Date = new Date()): string {
  const p = partsInUserTz(now);
  return `${p.hour}:${p.minute}`;
}

/** Single struct for prompts and logs. */
export function nowInUserTz(now: Date = new Date()): {
  date: string;
  weekday: string;
  time: string;
  tz: string;
  utcOffset: string;
} {
  const p = partsInUserTz(now);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    time: `${p.hour}:${p.minute}`,
    tz: USER_TZ,
    utcOffset: utcOffsetString(now),
  };
}

function utcOffsetString(now: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TZ,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(now);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  // Examples seen across runtimes: "GMT+4", "GMT+04:00", "GMT-5", "GMT".
  const m = tzPart.match(/GMT([+-])?(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  const sign = m[1] || "+";
  const hh = (m[2] ?? "00").padStart(2, "0");
  const mm = m[3] ?? "00";
  return `${sign}${hh}:${mm}`;
}

const ONE_DAY_MS = 86_400_000;

/** Relative label for a YYYY-MM-DD row vs. today.
 *  Returns "today" | "yesterday" | "tomorrow" | "Mon (3d ago)" | "Wed (in 2d)". */
export function relativeDateLabel(
  ymd: string,
  today: string = todayInUserTz(),
): string {
  if (ymd === today) return "today";
  const todayMs = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const ymdMs = Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
  );
  const diffDays = Math.round((ymdMs - todayMs) / ONE_DAY_MS);
  if (diffDays === -1) return "yesterday";
  if (diffDays === 1) return "tomorrow";
  const weekday = new Date(ymd + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  if (diffDays < 0) return `${weekday} (${-diffDays}d ago)`;
  return `${weekday} (in ${diffDays}d)`;
}

/** "Tuesday, May 5" — for the dashboard Header. */
export function formatHeaderDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}
```

- [ ] **Step 2: Type-check the new module**

```bash
npm run typecheck
```

Expected: clean (no errors). The module has zero runtime callers yet, so this only validates its own types.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: clean.

- [ ] **Step 4: Smoke-check at the REPL (optional but recommended)**

```bash
node --input-type=module -e "process.env.USER_TIMEZONE='Asia/Dubai'; const m = await import('./lib/time.ts'); console.log(m.todayInUserTz(), m.nowInUserTz());"
```

If this errors due to TS/ESM resolution, skip — the runtime check happens in Task 1.6 anyway.

- [ ] **Step 5: Commit**

```bash
git add lib/time.ts
git commit -m "feat(time): add tz-aware today/now source of truth"
```

## Task 1.3: Sweep `today` calls in pages and server actions

**Files:**
- Modify: [app/page.tsx](../../../app/page.tsx)
- Modify: [app/log/page.tsx](../../../app/log/page.tsx)
- Modify: [app/strength/page.tsx](../../../app/strength/page.tsx)
- Modify: [app/log/actions.ts](../../../app/log/actions.ts)

(Spec note: `app/coach/page.tsx` has no direct `today` string — its date drift is fixed in Task 1.5 via `reviewWindow()` / `recommendationWeekStart()` callers. Skip it here.)

- [ ] **Step 1: Patch [app/page.tsx](../../../app/page.tsx)**

Add to the imports near the top:

```tsx
import { todayInUserTz } from "@/lib/time";
```

Replace line 52:

```tsx
  const today = new Date().toISOString().slice(0, 10);
```

with:

```tsx
  const today = todayInUserTz();
```

Note: `dateLabel()` (lines 32–41) uses `toLocaleDateString` with `timeZone: "UTC"` to format an ISO `YYYY-MM-DD` selected date — that's intentional and stays UTC since it's parsing a date *string*, not `Date.now()`. Do NOT change `dateLabel()`.

- [ ] **Step 2: Patch [app/log/page.tsx](../../../app/log/page.tsx)**

Add the import:

```tsx
import { todayInUserTz } from "@/lib/time";
```

Replace lines 11–16:

```tsx
function resolveDate(raw: string | string[] | undefined): string {
  const today = new Date().toISOString().slice(0, 10);
  if (typeof raw !== "string" || !ISO_DATE.test(raw)) return today;
  // Disallow future dates — Garmin can't tell us what hasn't happened yet.
  return raw > today ? today : raw;
}
```

with:

```tsx
function resolveDate(raw: string | string[] | undefined): string {
  const today = todayInUserTz();
  if (typeof raw !== "string" || !ISO_DATE.test(raw)) return today;
  // Disallow future dates — Garmin can't tell us what hasn't happened yet.
  return raw > today ? today : raw;
}
```

- [ ] **Step 3: Patch [app/strength/page.tsx](../../../app/strength/page.tsx)**

Add the import:

```tsx
import { todayInUserTz } from "@/lib/time";
```

Replace line 52:

```tsx
  const todayIso = new Date().toISOString().slice(0, 10);
```

with:

```tsx
  const todayIso = todayInUserTz();
```

- [ ] **Step 4: Patch [app/log/actions.ts](../../../app/log/actions.ts)**

This file has two server-action functions (`saveLog` and `saveCheckin`) with the same date-fallback pattern. Both default to `today` when the form doesn't submit one — same UTC-vs-local bug as the pages.

Add the import:

```ts
import { todayInUserTz } from "@/lib/time";
```

Replace line 28:

```ts
  const date = (formData.get("date") as string) || new Date().toISOString().slice(0, 10);
```

with:

```ts
  const date = (formData.get("date") as string) || todayInUserTz();
```

Replace line 104 (same pattern, different function):

```ts
  const date = (formData.get("date") as string) || new Date().toISOString().slice(0, 10);
```

with:

```ts
  const date = (formData.get("date") as string) || todayInUserTz();
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

```bash
grep -rn "new Date().toISOString().slice(0, 10)" app/page.tsx app/log/page.tsx app/log/actions.ts app/strength/page.tsx
```

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx app/log/page.tsx app/log/actions.ts app/strength/page.tsx
git commit -m "refactor(pages): route 'today' through todayInUserTz()"
```

## Task 1.4: Sweep `today` calls in API routes

**Files:**
- Modify: [app/api/insights/route.ts](../../../app/api/insights/route.ts)
- Modify: [app/api/insights/strength/route.ts](../../../app/api/insights/strength/route.ts)

- [ ] **Step 1: Patch [app/api/insights/route.ts](../../../app/api/insights/route.ts)**

Add the import near the top:

```ts
import { todayInUserTz } from "@/lib/time";
```

Replace line 45:

```ts
  const today = new Date().toISOString().slice(0, 10);
```

with:

```ts
  const today = todayInUserTz();
```

Leave the `since` calculation on line 46 as-is — `since` is computed by subtracting milliseconds from `Date.now()`. It's a 14-day-ago cutoff for fetching, not a "today" anchor; the few-hour drift between UTC and user-tz here only changes whether a 15-day-old row barely makes it in. Keeping it UTC is fine and matches the existing semantic.

- [ ] **Step 2: Patch [app/api/insights/strength/route.ts](../../../app/api/insights/strength/route.ts)**

Add the import:

```ts
import { todayInUserTz } from "@/lib/time";
```

Replace line 108:

```ts
  const today = new Date().toISOString().slice(0, 10);
```

with:

```ts
  const today = todayInUserTz();
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

```bash
grep -n "new Date().toISOString().slice(0, 10)" app/api/insights/route.ts app/api/insights/strength/route.ts
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add app/api/insights/route.ts app/api/insights/strength/route.ts
git commit -m "refactor(insights): route 'today' through todayInUserTz()"
```

## Task 1.5: Pass tz-anchored `Date` to `reviewWindow` / `recommendationWeekStart` callers

`reviewWindow(today: Date = new Date())` and `recommendationWeekStart(today: Date = new Date())` already accept an optional `Date`. Their internal UTC math is correct *if* the input `Date` represents the right calendar day. Without an explicit arg, callers fall through to `new Date()` (server's actual clock, which is UTC on Vercel) and the week boundary rolls over hours late for users east of UTC.

We pass a `Date` constructed at midday user-tz so the intra-day timestamp lands well clear of any tz-boundary ambiguity inside `week.ts`'s UTC math.

**Files:**
- Modify: [app/coach/page.tsx](../../../app/coach/page.tsx)
- Modify: [app/api/insights/weekly/route.ts](../../../app/api/insights/weekly/route.ts)

- [ ] **Step 1: Patch [app/coach/page.tsx](../../../app/coach/page.tsx)**

Add to imports (if not already from Task 1.3):

```tsx
import { todayInUserTz } from "@/lib/time";
```

Add the helper near the top of the file (after imports, before the first export):

```tsx
function userTzNoon(): Date {
  // Build a Date that points unambiguously at "today" in the user's tz,
  // hour-of-day mid-noon, so reviewWindow/recommendationWeekStart's
  // internal UTC date math lands on the right calendar day.
  return new Date(`${todayInUserTz()}T12:00:00Z`);
}
```

Replace line 156:

```tsx
  const { start, end, mode, daysRemaining } = reviewWindow();
```

with:

```tsx
  const { start, end, mode, daysRemaining } = reviewWindow(userTzNoon());
```

Replace line 214:

```tsx
  const targetWeek = recommendationWeekStart();
```

with:

```tsx
  const targetWeek = recommendationWeekStart(userTzNoon());
```

- [ ] **Step 2: Patch [app/api/insights/weekly/route.ts](../../../app/api/insights/weekly/route.ts)**

Add to imports:

```ts
import { todayInUserTz } from "@/lib/time";
```

Add the helper after imports:

```ts
function userTzNoon(): Date {
  return new Date(`${todayInUserTz()}T12:00:00Z`);
}
```

Replace lines 57–58:

```ts
  const { start, end, mode, daysRemaining } = reviewWindow();
  const targetWeekStart = recommendationWeekStart();
```

with:

```ts
  const anchor = userTzNoon();
  const { start, end, mode, daysRemaining } = reviewWindow(anchor);
  const targetWeekStart = recommendationWeekStart(anchor);
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add app/coach/page.tsx app/api/insights/weekly/route.ts
git commit -m "refactor(coach): pass tz-anchored Date to reviewWindow/recommendationWeekStart"
```

## Task 1.6: Update `getTodaySession` and `Header.tsx`

**Files:**
- Modify: [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts)
- Modify: [components/layout/Header.tsx](../../../components/layout/Header.tsx)

- [ ] **Step 1: Patch [lib/coach/sessionPlans.ts](../../../lib/coach/sessionPlans.ts)**

Add at the top (after existing imports):

```ts
import { weekdayInUserTz } from "@/lib/time";
```

Replace lines 64–67:

```ts
export function getTodaySession(): string {
  const day = new Date().toLocaleDateString("en-US", { weekday: "long" });
  return WEEKLY_SESSIONS[day] ?? "REST";
}
```

with:

```ts
export function getTodaySession(): string {
  return WEEKLY_SESSIONS[weekdayInUserTz()] ?? "REST";
}
```

- [ ] **Step 2: Patch [components/layout/Header.tsx](../../../components/layout/Header.tsx)**

Open the file. Find the line that builds `dateStr` (around line 15):

```tsx
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
```

Add an import at the top:

```tsx
import { formatHeaderDate } from "@/lib/time";
```

Replace the four-line `const dateStr = ...` block with:

```tsx
  const dateStr = formatHeaderDate();
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/sessionPlans.ts components/layout/Header.tsx
git commit -m "refactor(time): tz-aware weekday in getTodaySession + Header"
```

## Task 1.7: Verify Slice 1 end-to-end

No commit. Run the manual force-tz check called out in the spec.

- [ ] **Step 1: Type-check + lint, full project**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

- [ ] **Step 2: Confirm no UTC `today` calls remain on the server**

```bash
grep -rn "new Date().toISOString().slice(0, 10)" app/ lib/ components/
```

Expected output: only matches inside files NOT swept (e.g., `lib/whoop.ts` — out of scope per spec; `lib/withings*.ts` — out of scope). No matches in any file from the sweep map.

```bash
grep -rn 'toLocaleDateString.*weekday' app/ lib/ components/ | grep -v "lib/ui/score.ts" | grep -v "app/page.tsx" | grep -v "lib/time.ts"
```

Expected: empty (the three excluded files are the intentionally-preserved or new ones).

- [ ] **Step 3: Force-tz dev check**

Open one shell:

```bash
USER_TIMEZONE=America/Los_Angeles npm run dev
```

In a browser, hit:

- `http://localhost:3000/` — page loads; Header shows the weekday/date for the *current LA-local* day, not UTC.
- `http://localhost:3000/coach` — "today" payload selection picks the LA-local YYYY-MM-DD.
- `http://localhost:3000/strength` — page loads; latest workout date logic still works.

Stop the server, then re-run with the default:

```bash
npm run dev
```

- `http://localhost:3000/` — Header shows Dubai-local weekday/date.

If any page errors, open the browser console + server logs; common cause is a missed import. Fix and re-run typecheck.

- [ ] **Step 4: Confirm `[time] USER_TIMEZONE=...` log fires once**

In the dev-server output from Step 3, look for `[time] USER_TIMEZONE=America/Los_Angeles` (or `Asia/Dubai` on the second run). Should appear exactly once per server boot.

If verification passes: Slice 1 done. Move to Slice 2.

---

# Slice 2 — Dashboard cleanup + strength "Today" sub-tab

Goal: dashboard loses the `MorningCheckIn` block; new `/strength?view=today` renders the relocated session plan card with all planned exercises (no slice cap); check-in form lives only in `/log` (no change there).

## Task 2.1: Add `today` view to `StrengthNav`

**Files:**
- Modify: [components/strength/StrengthNav.tsx](../../../components/strength/StrengthNav.tsx)

- [ ] **Step 1: Edit `VIEWS`**

Find lines 7–10:

```tsx
const VIEWS = [
  { id: "recent", label: "Recent" },
  { id: "date", label: "By date" },
] as const;
```

Replace with:

```tsx
const VIEWS = [
  { id: "today", label: "Today" },
  { id: "recent", label: "Recent" },
  { id: "date", label: "By date" },
] as const;
```

- [ ] **Step 2: Update `href` rule**

Find line 32:

```tsx
        const href = v.id === "recent" ? "/strength" : `/strength?view=${v.id}`;
```

Replace with:

```tsx
        const href =
          v.id === "recent" ? "/strength" : `/strength?view=${v.id}`;
```

(No semantic change — just confirms `today` follows the `?view=today` pattern. The default `/strength` URL keeps `recent` as the default view to preserve existing bookmarks.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean. The `View` type derived from `VIEWS` now includes `"today"`, but no consumer rejects unknown ids — `app/strength/page.tsx` will be updated in Task 2.3.

- [ ] **Step 4: Commit**

```bash
git add components/strength/StrengthNav.tsx
git commit -m "feat(strength): add Today view to sub-nav"
```

## Task 2.2: Create `TodayPlanCard` component

**Files:**
- Create: [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx)

- [ ] **Step 1: Write the component**

Create `components/strength/TodayPlanCard.tsx`:

```tsx
import type { DailyPlan } from "@/lib/coach/readiness";

type Props = {
  plan: DailyPlan;
};

/** Read-only relocation of the dashboard's old session plan card.
 *  Drop the prior 6-exercise cap; show the full session. */
export function TodayPlanCard({ plan }: Props) {
  const { readiness, mode, sessionType, exercises } = plan;

  return (
    <div
      className="rounded-[14px] p-4"
      style={{
        background: `linear-gradient(135deg, ${mode.color}12, rgba(0,0,0,0.3))`,
        border: `1px solid ${mode.color}30`,
      }}
    >
      <div className="flex justify-between items-center mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-white/40">
            Today&apos;s Session
          </div>
          <div className="text-lg font-bold text-white mt-0.5">
            {sessionType === "REST" ? "Rest Day 🏠" : `💪 ${sessionType}`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold" style={{ color: mode.color }}>
            {mode.label}
          </div>
          <div className="text-[10px] text-white/35 mt-0.5">
            Readiness {readiness.score}/100
          </div>
        </div>
      </div>
      <div className="text-[11px] text-white/50 leading-relaxed">{mode.desc}</div>

      {sessionType !== "REST" && exercises.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-1.5">
          {exercises.map((ex) => (
            <div key={ex.name} className="flex justify-between text-[11px]">
              <span className="text-white/55">{ex.name.split("(")[0].trim()}</span>
              <span className="font-mono" style={{ color: mode.color }}>
                {ex.target}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

(Server component — no `"use client"`. No state. No form. No CTA.)

- [ ] **Step 2: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/strength/TodayPlanCard.tsx
git commit -m "feat(strength): add TodayPlanCard (relocated read-only plan)"
```

## Task 2.3: Wire `app/strength/page.tsx` for `view=today`

**Files:**
- Modify: [app/strength/page.tsx](../../../app/strength/page.tsx)

- [ ] **Step 1: Add imports**

Near the existing imports add:

```tsx
import { TodayPlanCard } from "@/components/strength/TodayPlanCard";
import { buildDailyPlan } from "@/lib/coach/readiness";
import type { DailyLog } from "@/lib/data/types";
```

(`DailyLog` may already be in scope — check first; if so, don't double-import.)

- [ ] **Step 2: Widen `activeView`**

Find line 24:

```tsx
  const activeView: "recent" | "date" = view === "date" ? "date" : "recent";
```

Replace with:

```tsx
  const activeView: "today" | "recent" | "date" =
    view === "today" ? "today" : view === "date" ? "date" : "recent";
```

- [ ] **Step 3: Fetch plan inputs when `view=today`**

Inside the `Promise.all` (~lines 32–44) the page already loads `profile`. Add fetches for today's `daily_logs` row and today's check-in so `buildDailyPlan` has all inputs. Replace the existing `Promise.all` with:

```tsx
  const todayIso = todayInUserTz();
  const [
    { data: profile },
    { data: tokens },
    workouts,
    { data: cached },
    { data: todayLog },
    { data: todayCheckin },
  ] = await Promise.all([
    supabase.from("profiles").select("name, whoop_baselines").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    loadWorkouts(user.id),
    supabase
      .from("ai_insights")
      .select("payload, generated_for_date")
      .eq("user_id", user.id)
      .eq("kind", "strength")
      .order("generated_for_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("hrv, sleep_score, recovery")
      .eq("user_id", user.id)
      .eq("date", todayIso)
      .maybeSingle(),
    supabase
      .from("checkins")
      .select("readiness, energy_label, mood, soreness, feel_notes")
      .eq("user_id", user.id)
      .eq("date", todayIso)
      .maybeSingle(),
  ]);
```

(Note the additions: `whoop_baselines` on profile, the two new queries, and `todayIso` lifted out of its old spot — remove the now-duplicate `const todayIso = ...` further down.)

- [ ] **Step 4: Build `dailyPlan` for the today view**

Just before the `return (` at the page level, add:

```tsx
  const hrvBaseline = (profile?.whoop_baselines as { hrv?: number } | null)?.hrv;
  const feel = todayCheckin
    ? {
        readiness: todayCheckin.readiness,
        energyLabel: todayCheckin.energy_label,
        mood: todayCheckin.mood,
        soreness: todayCheckin.soreness,
        notes: todayCheckin.feel_notes,
      }
    : null;
  const dailyPlan = buildDailyPlan(
    (todayLog as Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null) ?? null,
    feel,
    hrvBaseline,
  );
```

- [ ] **Step 5: Render the today branch**

Find the existing `{activeView === "date" ? ( ... ) : ( ... )}` block (around lines 83–129). Wrap it in an outer ternary:

```tsx
            {activeView === "today" ? (
              <TodayPlanCard plan={dailyPlan} />
            ) : activeView === "date" ? (
              <>
                {/* existing 'date' branch markup unchanged */}
              </>
            ) : (
              <>
                {/* existing 'recent' branch markup unchanged */}
              </>
            )}
```

(Do not retype the existing `date` and `recent` branches — they already contain working markup. The change is purely an outer wrap that adds the `today` case.)

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

Manual check:

```bash
npm run dev
```

Visit:
- `http://localhost:3000/strength` — defaults to `recent` view, looks unchanged.
- `http://localhost:3000/strength?view=date` — date view unchanged.
- `http://localhost:3000/strength?view=today` — renders `TodayPlanCard` with the current session and *all* planned exercises (no 6-exercise cap).

- [ ] **Step 7: Commit**

```bash
git add app/strength/page.tsx
git commit -m "feat(strength): wire ?view=today branch to TodayPlanCard"
```

## Task 2.4: Remove `MorningCheckIn` from the dashboard

**Files:**
- Modify: [app/page.tsx](../../../app/page.tsx)

- [ ] **Step 1: Drop the import**

Find line 9:

```tsx
import { MorningCheckIn } from "@/components/dashboard/MorningCheckIn";
```

Delete it.

- [ ] **Step 2: Drop the rendered block**

Find the block around lines 231–247:

```tsx
        {isToday && (
          <MorningCheckIn
            date={today}
            plan={dailyPlan}
            initial={
              checkin
                ? {
                    readiness: checkin.readiness,
                    energy_label: checkin.energy_label,
                    mood: checkin.mood,
                    soreness: checkin.soreness,
                    feel_notes: checkin.feel_notes,
                  }
                : null
            }
          />
        )}
```

Delete it entirely.

- [ ] **Step 3: Verify `dailyPlan` is still computed**

`buildDailyPlan(...)` is called earlier (around line 210) and its `dailyPlan` value feeds the impact-donut / score logic. Do NOT delete `dailyPlan` itself — only the JSX block above. Confirm with:

```bash
grep -n dailyPlan app/page.tsx
```

Expected: at least one match (the call site that produces `dailyPlan`). If `dailyPlan` is now unused everywhere, leave it computed — `computeImpact` may consume it; `grep` for `computeImpact` to confirm.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean. Any complaint about unused `MorningCheckIn` is gone (we removed the import); any complaint about unused `checkin` is fine because the LogForm still consumes it via the page query (`checkin` is fetched and passed to other paths).

Manual check:

```bash
npm run dev
```

Visit `http://localhost:3000/`. The `MorningCheckIn` block (gradient session card + "🌅 Morning Check-In" form) is gone. The impact donut, readiness score, and date pager render normally.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx
git commit -m "feat(dashboard): drop MorningCheckIn (relocated to /strength + /log)"
```

## Task 2.5: Delete `MorningCheckIn.tsx`

**Files:**
- Delete: [components/dashboard/MorningCheckIn.tsx](../../../components/dashboard/MorningCheckIn.tsx)

- [ ] **Step 1: Confirm no remaining imports**

```bash
grep -rn MorningCheckIn app/ components/ lib/
```

Expected: zero matches. (After Task 2.4 removed the dashboard import, nothing references it.)

- [ ] **Step 2: Delete the file**

```bash
git rm components/dashboard/MorningCheckIn.tsx
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(dashboard): delete unused MorningCheckIn component"
```

## Task 2.6: Verify Slice 2 end-to-end

No commit.

- [ ] **Step 1: Type-check + lint, full project**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 2: Manual verification (per spec)**

```bash
npm run dev
```

- `http://localhost:3000/` — dashboard renders without the MorningCheckIn block; impact donut + score still display.
- `http://localhost:3000/log` — "Morning Feel" form still present; saving updates `daily_logs` + `checkins` (see [app/log/actions.ts](../../../app/log/actions.ts)). Reload `/` and confirm the score reflects the new check-in.
- `http://localhost:3000/strength?view=today` — relocated card renders, all planned exercises shown.
- `http://localhost:3000/strength` and `?view=date` — unchanged.

If verification passes: Slice 2 done. Move to Slice 3.

---

# Slice 3 — Coach prompt anchor

Goal: extract the duplicated snapshot-building logic across `/api/insights` and `/api/insights/weekly` into `lib/coach/snapshot.ts`. The new module returns a cacheable `body` (profile + daily-log rows + workout rows, each row with a relative-day label) and an uncached `nowLine` that callers prepend in the per-turn user message. Both insights endpoints adopt it; their system prompts gain a one-line instruction telling Claude to interpret day references relative to NOW.

## Task 3.1: Create `lib/coach/snapshot.ts`

**Files:**
- Create: [lib/coach/snapshot.ts](../../../lib/coach/snapshot.ts)

- [ ] **Step 1: Write the module**

Create `lib/coach/snapshot.ts`:

```ts
// lib/coach/snapshot.ts
//
// Shared LLM snapshot builder used by /api/insights and /api/insights/weekly
// (and any future chat-coach turn handler). Returns the cacheable `body`
// (profile + daily-log rows + workout rows with relative-day labels) and
// the uncached `nowLine` separately so callers can keep `nowLine` out of
// any cached prompt prefix. See the design spec for the prompt-cache rule.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkouts } from "@/lib/data/workouts";
import { nowInUserTz, relativeDateLabel, todayInUserTz } from "@/lib/time";

type ProfileRow = {
  name?: string | null;
  goal?: string | null;
  whoop_baselines?: unknown;
  training_plan?: unknown;
} | null;

type DailyLogRow = {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  strain: number | null;
  steps: number | null;
  calories: number | null;
  weight_kg: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

export type SnapshotInputs = {
  supabase: SupabaseClient;
  userId: string;
  /** Inclusive YYYY-MM-DD lower bound for daily_logs / workouts. */
  since: string;
  /** Optional inclusive upper bound. Omit for daily mode (loads recent N). */
  until?: string;
  /** Workouts to include in daily mode (ignored when `until` is set). */
  workoutLimit?: number;
};

export type SnapshotResult = {
  /** PER-TURN line. MUST NOT be placed inside a cached prompt prefix. */
  nowLine: string;
  /** Cacheable body. Stable until underlying daily/workout data changes. */
  body: string;
};

const DAY_REFERENCE_INSTRUCTION =
  'When the user references a day (e.g. "Monday"), interpret it relative to NOW above. "Monday" without other qualifiers means the most recent Monday on or before today. If ambiguous, ask.';

/** Append this to your existing system prompt so the model uses NOW as the
 *  reference frame for relative day references. */
export function withDayReferenceInstruction(systemPrompt: string): string {
  return `${systemPrompt}\n\n${DAY_REFERENCE_INSTRUCTION}`;
}

export async function buildSnapshot(inputs: SnapshotInputs): Promise<SnapshotResult> {
  const { supabase, userId, since, until, workoutLimit = 5 } = inputs;
  const today = todayInUserTz();

  let logsQ = supabase
    .from("daily_logs")
    .select(
      "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories, weight_kg, protein_g, carbs_g, fat_g",
    )
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: true });
  if (until) logsQ = logsQ.lte("date", until);

  const [{ data: profile }, { data: logs }, allWorkouts] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines, training_plan")
      .eq("user_id", userId)
      .maybeSingle(),
    logsQ,
    loadWorkouts(userId),
  ]);

  const workouts = until
    ? allWorkouts.filter((w) => w.date >= since && w.date <= until)
    : allWorkouts.slice(0, workoutLimit);

  const recent = workouts.map((w) => ({
    date: w.date,
    type: w.type,
    sets: w.sets,
    vol_kg: Math.round(w.vol),
    top: w.exercises.slice(0, 4).map((e) => {
      const best = e.sets
        .filter((s) => !s.warmup && s.kg && s.reps)
        .sort((a, b) => (b.kg! - a.kg!))[0];
      return best ? `${e.name} ${best.kg}×${best.reps}` : e.name;
    }),
  }));

  const fmt = (v: number | null | undefined, unit = "") =>
    v === null || v === undefined ? "—" : `${v}${unit}`;

  const logLines = ((logs ?? []) as DailyLogRow[])
    .map((l) => {
      const rel = relativeDateLabel(l.date, today);
      return `  ${l.date} (${rel}) | hrv ${fmt(l.hrv)} | rhr ${fmt(l.resting_hr)} | recov ${fmt(l.recovery)} | sleep ${fmt(l.sleep_hours, "h")} (deep ${fmt(l.deep_sleep_hours)}) | strain ${fmt(l.strain)} | steps ${fmt(l.steps)} | kcal ${fmt(l.calories)} | prot ${fmt(l.protein_g, "g")} | weight ${fmt(l.weight_kg, "kg")}`;
    })
    .join("\n");

  const workoutLines = recent
    .map((w) => {
      const rel = relativeDateLabel(w.date, today);
      return `  ${w.date} (${rel}) ${w.type ?? "—"} | ${w.sets} sets | ${w.vol_kg} kg vol | top: ${w.top.join(", ") || "—"}`;
    })
    .join("\n");

  const p = profile as ProfileRow;
  const body = [
    `ATHLETE: ${p?.name ?? "Athlete"}. GOAL: "${p?.goal ?? "general health"}".`,
    `BASELINES: ${JSON.stringify(p?.whoop_baselines ?? {})}`,
    `TRAINING PLAN: ${JSON.stringify(p?.training_plan ?? {})}`,
    ``,
    `DAILY LOGS (${since} → ${until ?? today}):`,
    logLines || `  (no logs in window)`,
    ``,
    `RECENT WORKOUTS (most recent first):`,
    workoutLines || `  (no workouts)`,
  ].join("\n");

  const n = nowInUserTz();
  const nowLine = `NOW: ${n.date} (${n.weekday}) ${n.time} ${n.tz} (UTC${n.utcOffset})`;

  return { nowLine, body };
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean. The module has zero callers yet.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/snapshot.ts
git commit -m "feat(coach): add shared snapshot builder with NOW + relative labels"
```

## Task 3.2: Refactor `app/api/insights/route.ts` to use `buildSnapshot`

**Files:**
- Modify: [app/api/insights/route.ts](../../../app/api/insights/route.ts)

- [ ] **Step 1: Update imports**

Replace the top imports with:

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { buildSnapshot, withDayReferenceInstruction } from "@/lib/coach/snapshot";
import { todayInUserTz } from "@/lib/time";
```

(`loadWorkouts` import is dropped — `buildSnapshot` calls it internally.)

- [ ] **Step 2: Update `SYSTEM`**

Replace the existing `const SYSTEM = ...` (line 13–14) with:

```ts
const SYSTEM = withDayReferenceInstruction(
  `You are an elite health and strength coach. You speak in concrete numbers. Return ONLY a single valid JSON object — no markdown, no prose, no commentary.`,
);
```

- [ ] **Step 3: Replace the data-fetch + prompt block**

Find the body of `POST` from line ~44 down to and including the `userPrompt` template (line ~88). Replace the whole stretch from `// Pull data` through the end of the `userPrompt` template literal with:

```ts
  const today = todayInUserTz();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);

  const { nowLine, body: snapshotBody } = await buildSnapshot({
    supabase,
    userId: user.id,
    since,
    workoutLimit: 5,
  });

  const userPrompt = `${nowLine}

${snapshotBody}

Return JSON shaped exactly:
{
  "insights": [{"priority":"high|medium|low","category":"string","title":"max 8 words","body":"2-3 sentences with numbers"}],
  "patterns": [{"label":"short","detail":"one sentence"}],
  "plan": {"week":"label","today":"specific action","tomorrow":"specific action","note":"1 line"}
}
3-6 insights. 2-4 patterns. The plan must reference specific kg/reps/sleep/macro numbers from the data.`;
```

(The `today` constant is still used by the `upsert` at line ~107 — leave that line alone; it now reads the tz-aware `today`.)

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

Manual:

```bash
npm run dev
```

In a browser open `http://localhost:3000/coach`, then click "Refresh insights" (or whatever button calls `POST /api/insights`). The endpoint should still return a valid payload. Open the dev-server stdout — temporarily add `console.log(userPrompt.slice(0, 600))` if you want to eyeball that the `NOW:` line is present and the daily-log rows show `(today)` / `(yesterday)` annotations. Remove the log line before committing.

- [ ] **Step 5: Commit**

```bash
git add app/api/insights/route.ts
git commit -m "refactor(insights): use shared snapshot + NOW anchor + day-ref instruction"
```

## Task 3.3: Refactor `app/api/insights/weekly/route.ts` to use `buildSnapshot`

**Files:**
- Modify: [app/api/insights/weekly/route.ts](../../../app/api/insights/weekly/route.ts)

- [ ] **Step 1: Update imports**

Add:

```ts
import { buildSnapshot, withDayReferenceInstruction } from "@/lib/coach/snapshot";
```

`loadWorkouts` is still imported elsewhere — leave it; `buildSnapshot` uses its own copy. (You can remove the import here if it becomes unused after Step 3 — verify with `grep`.)

- [ ] **Step 2: Wrap the system prompt**

The route uses `REVIEW_SYSTEM_PROMPT` from `@/lib/coach/prompts`. Inside `POST`, before the `callClaude` call (~line 110), introduce:

```ts
  const systemWithDayRef = withDayReferenceInstruction(REVIEW_SYSTEM_PROMPT);
```

and replace the `system: REVIEW_SYSTEM_PROMPT` line in the `callClaude` options object with `system: systemWithDayRef`.

- [ ] **Step 3: Replace the data-fetch + prompt block**

Find the section from `const [{ data: profile }, { data: logs }, allWorkouts] = await Promise.all([...])` through the end of the `userPrompt` template literal (lines ~60–106). Replace with:

```ts
  const { nowLine, body: snapshotBody } = await buildSnapshot({
    supabase,
    userId: user.id,
    since: start,
    until: end,
  });

  const frame = frameFor(mode, { start, end, daysRemaining, targetWeekStart });

  const userPrompt = `${nowLine}

${snapshotBody}

${frame.windowLine}
Tone: ${frame.toneHint}

${frame.recsFraming}

${REVIEW_RESPONSE_SHAPE}`;
```

Note: `frameFor` and `REVIEW_RESPONSE_SHAPE` are already imported at the top of the file — don't re-import.

- [ ] **Step 4: Drop now-unused fetch code**

The previous `Promise.all` and the `windowWorkouts` mapping are no longer needed (the snapshot builder handles them). Make sure the entire block from the old `Promise.all` through the old `windowWorkouts` definition is gone. Look carefully — the file had a large `recentWorkouts`-style mapping; verify it's deleted.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run lint
```

Expected: clean. Any "unused import: loadWorkouts" warning means it's no longer needed in this file — drop the import.

Manual:

```bash
npm run dev
```

Hit `http://localhost:3000/coach?view=this-week` and click "Run review" (or "Re-run review"). Endpoint returns a valid weekly review payload. Spot-check the prompt as in Task 3.2 if desired.

- [ ] **Step 6: Commit**

```bash
git add app/api/insights/weekly/route.ts
git commit -m "refactor(insights/weekly): use shared snapshot + NOW anchor + day-ref instruction"
```

## Task 3.4: Verify Slice 3 end-to-end

No commit.

- [ ] **Step 1: Type-check + lint, full project**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 2: Both insights endpoints**

```bash
npm run dev
```

- POST to `/api/insights` (via `/coach` "Refresh insights"): cached payload regenerates; cache row updates with `generated_for_date = todayInUserTz()`.
- POST to `/api/insights/weekly` (via `/coach?view=this-week`): cached weekly review regenerates; recommendations seed for the right `targetWeekStart`.

- [ ] **Step 3: Prompt-anchor sanity**

Eyeball the prompt text once (temporary `console.log`). Confirm:
- The first non-empty line is `NOW: 2026-MM-DD (Weekday) HH:mm Asia/Dubai (UTC+04:00)`.
- Daily-log rows have `(today)` / `(yesterday)` / `(Mon, Nd ago)` annotations.
- The system prompt now ends with: *"When the user references a day…"*.

Remove the `console.log` before declaring the slice done.

If verification passes: Slice 3 done. The full design ships.

---

# Final pass

After all three slices commit:

- [ ] **Run full project verification**

```bash
npm run typecheck && npm run lint && npm run build
```

`npm run build` is optional (CLAUDE.md doesn't require it), but worth a single run before opening a PR — it catches Next-specific issues like missing `"use client"` directives that `tsc` alone won't.

- [ ] **Quick visual regression check**

```bash
npm run dev
```

Walk through every page once: `/`, `/log`, `/strength`, `/strength?view=today`, `/strength?view=date`, `/coach`, `/coach?view=this-week`, `/profile`. None should show stack traces; the dashboard should be visibly leaner; the strength `Today` tab renders the relocated card.

- [ ] **Set the production env var**

In Vercel project settings → Environment Variables, add `USER_TIMEZONE=Asia/Dubai` for Production (and Preview if relevant). If absent, the default in `lib/time.ts` (`Asia/Dubai`) still applies — but explicitly setting it eliminates the ambiguity called out in the spec's "Risks acknowledged" section.

- [ ] **Note the deferred follow-up**

In your tracker (or just as a note), record: **"Open follow-up spec: WHOOP date keying audit"** — `app/api/whoop/sync/route.ts` keys rows on UTC-sliced ISO timestamps; for a Dubai user this misroutes ~4hrs of nightly sleep data to the wrong `daily_logs.date`. Tracked separately because it requires a date-keying-rule decision and a backfill plan.
