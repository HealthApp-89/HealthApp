# Week Schedule sub-tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/strength?tab=schedule` sub-pill that renders a vertical accordion of Mon→Sun rows; tapping a row expands inline to show that day's prescribed exercises pulled via `getEffectiveSessionPlan`.

**Architecture:** Plan-shaped surface alongside `Coach` and ahead of the log-shaped `By date` / `By muscle` / `Log` tabs. Reuses the existing prescription resolution chain (`session_prescriptions → exercise_overrides → user_session_templates → SESSION_PLANS`). One new TanStack hook fetches all user_session_templates at once so per-week navigation does not fan out N queries. Per-day footer CTAs reuse `LoggerSheet` (today) and `DaySwapSheet` (today + future). New components live entirely under `components/strength/`.

**Tech Stack:** Next.js 15 App Router · React Server Components / Client Components · TanStack Query · Supabase (RLS) · Tailwind v4 / inline-style with `COLOR` + `RADIUS` from `lib/ui/theme.ts`.

**Spec:** [docs/superpowers/specs/2026-06-06-week-schedule-tab-design.md](../specs/2026-06-06-week-schedule-tab-design.md).

**Verification convention:** This project has no test suite (per CLAUDE.md). After each task: run `npm run typecheck` and confirm clean (no new errors). Manual smoke at the end (Task 8). Commit after each task.

---

### Task 0: Create the feature branch

**Files:** none (git only).

- [ ] **Step 1: Confirm clean working tree**

Run:
```bash
git status --short
```
Expected: empty output (clean).

- [ ] **Step 2: Create + switch to the feature branch from `main`**

Run:
```bash
git checkout main
git pull --ff-only
git checkout -b feat/strength-week-schedule-tab
```
Expected: `Switched to a new branch 'feat/strength-week-schedule-tab'`.

- [ ] **Step 3: Cherry-pick the design spec from main**

The spec was committed to `main` as `5cd2caf` before the branch existed. It is already in the tree because the branch was cut from `main` after that commit, so nothing to do here — verify:

Run:
```bash
git log --oneline -1 docs/superpowers/specs/2026-06-06-week-schedule-tab-design.md
```
Expected: the `docs: week schedule sub-tab design` commit shows up.

---

### Task 1: Add plural fetcher for `user_session_templates`

**Files:**
- Modify: [lib/query/fetchers/userSessionTemplates.ts](lib/query/fetchers/userSessionTemplates.ts)

The schedule renders up to five distinct session types per week. The existing `fetchUserSessionTemplate{Server,Browser}` returns one row at a time; we add a plural variant returning `Record<sessionType, UserSessionTemplate>` so the schedule fires one query for the whole week.

- [ ] **Step 1: Append plural variants to the existing file**

Open [lib/query/fetchers/userSessionTemplates.ts](lib/query/fetchers/userSessionTemplates.ts) and **append** (do NOT touch the existing two exports):

```ts
/**
 * Plural variant — fetches every user_session_templates row for the user
 * and returns a map keyed by session_type. Used by the Schedule sub-tab
 * which renders up to five distinct session types per week and would
 * otherwise fan out one query per (weekday, session_type) pair.
 */
export async function fetchAllUserSessionTemplatesServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<Record<string, UserSessionTemplate>> {
  const { data, error } = await supabase
    .from("user_session_templates")
    .select(SELECT)
    .eq("user_id", userId);
  if (error) throw error;
  const rows = (data ?? []) as UserSessionTemplate[];
  const map: Record<string, UserSessionTemplate> = {};
  for (const row of rows) map[row.session_type] = row;
  return map;
}

export async function fetchAllUserSessionTemplatesBrowser(
  userId: string,
): Promise<Record<string, UserSessionTemplate>> {
  const supabase = createSupabaseBrowserClient();
  return fetchAllUserSessionTemplatesServer(supabase, userId);
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npm run typecheck
```
Expected: PASS, no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/query/fetchers/userSessionTemplates.ts
git commit -m "$(cat <<'EOF'
schedule: plural fetcher for user_session_templates

Returns a map keyed by session_type so the upcoming Schedule sub-tab
renders one query for the whole week instead of N per (weekday,
session_type) pair.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add plural hook `useUserSessionTemplates`

**Files:**
- Create: `lib/query/hooks/useUserSessionTemplates.ts`

The query key `queryKeys.userSessionTemplates.all(userId)` already exists in [lib/query/keys.ts](lib/query/keys.ts) — no key change needed.

- [ ] **Step 1: Create the hook**

Create [lib/query/hooks/useUserSessionTemplates.ts](lib/query/hooks/useUserSessionTemplates.ts):

```ts
// lib/query/hooks/useUserSessionTemplates.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchAllUserSessionTemplatesBrowser } from "@/lib/query/fetchers/userSessionTemplates";

/**
 * All user_session_templates rows for the user, keyed by session_type.
 * Used by the Schedule sub-tab.
 */
export function useUserSessionTemplates(userId: string) {
  return useQuery({
    queryKey: queryKeys.userSessionTemplates.all(userId),
    queryFn: () => fetchAllUserSessionTemplatesBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
    enabled: !!userId,
  });
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/query/hooks/useUserSessionTemplates.ts
git commit -m "$(cat <<'EOF'
schedule: useUserSessionTemplates hook (plural)

Wraps the plural fetcher. Single-key useUserSessionTemplate stays for
TodayPlanCard + LoggerSheet single-day surfaces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Build `ScheduleDayRow` component

**Files:**
- Create: `components/strength/ScheduleDayRow.tsx`

Single-day accordion row. Collapsed shows weekday + date + session label + status pill. Expanded shows prescribed exercise list and footer CTAs. REST rows are non-expandable.

- [ ] **Step 1: Create the file**

Create [components/strength/ScheduleDayRow.tsx](components/strength/ScheduleDayRow.tsx):

```tsx
"use client";

import { useState } from "react";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ExerciseOverrides, SessionPrescriptions, Weekday } from "@/lib/data/types";
import { LoggerSheet } from "@/components/logger/LoggerSheet";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import { useExistingLoggerDraft } from "@/lib/logger/use-existing-draft";
import { COLOR } from "@/lib/ui/theme";
import { MODES } from "@/lib/coach/readiness";
import { modeColorLight } from "@/lib/ui/theme";

/** Date-class discriminator — controls which footer CTAs render. */
export type DayClass = "today" | "past_logged" | "past_unlogged" | "future" | "rest";

type Props = {
  userId: string;
  weekStart: string;
  weekdayShort: Weekday;
  weekdayLong: string;
  date: string;
  sessionType: string;
  exercises: PlannedExercise[];
  dayClass: DayClass;
  isExpanded: boolean;
  onToggle: () => void;
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions: SessionPrescriptions | null;
  sessionPlan: import("@/lib/data/types").SessionPlan;
};

const WEEKDAY_LABEL: Record<Weekday, string> = {
  Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun",
};

function dayOfMonth(iso: string): number {
  // iso = YYYY-MM-DD; safe to parse as UTC noon to avoid TZ rounding.
  return new Date(iso + "T12:00:00Z").getUTCDate();
}

/** Resolve the session-type color via the same MODES table TodayPlanCard uses. */
function sessionAccent(sessionType: string): string {
  const mode = MODES.find((m) => m.sessionTypes?.includes(sessionType));
  if (!mode) return COLOR.textMuted;
  return modeColorLight(mode.color);
}

export function ScheduleDayRow({
  userId,
  weekStart,
  weekdayShort,
  weekdayLong,
  date,
  sessionType,
  exercises,
  dayClass,
  isExpanded,
  onToggle,
  weekOverrides,
  weekPrescriptions,
  sessionPlan,
}: Props) {
  const [loggerOpen, setLoggerOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const hasDraft = useExistingLoggerDraft(userId, sessionType, draftEpoch);

  const isRest = dayClass === "rest";
  const isToday = dayClass === "today";
  const accent = isRest ? COLOR.textMuted : sessionAccent(sessionType);

  // Right-edge pill: priority Today > Logged > session-type > Rest.
  const pillLabel =
    dayClass === "today" ? "Today" :
    dayClass === "past_logged" ? "Logged" :
    isRest ? "Rest" :
    sessionType;
  const pillBg =
    dayClass === "today" ? COLOR.warning :
    dayClass === "past_logged" ? COLOR.success :
    isRest ? COLOR.textMuted :
    accent;

  const showFooterToday = dayClass === "today" && !isRest;
  const showFooterFuture = dayClass === "future" && !isRest;
  const showFooterPastLogged = dayClass === "past_logged";
  const showFooterPastUnlogged = dayClass === "past_unlogged" && !isRest;

  return (
    <>
      <div
        style={{
          background: COLOR.surface,
          border: `1px solid ${isExpanded ? COLOR.textStrong : COLOR.divider}`,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: isExpanded ? "0 2px 8px rgba(20,30,80,0.05)" : "none",
        }}
      >
        <button
          type="button"
          onClick={isRest ? undefined : onToggle}
          disabled={isRest}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            background: "transparent",
            border: "none",
            cursor: isRest ? "default" : "pointer",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minWidth: 44 }}>
            <span
              style={{
                fontSize: 10,
                color: COLOR.textMuted,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {WEEKDAY_LABEL[weekdayShort]}
            </span>
            <span style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong }}>
              {dayOfMonth(date)}
            </span>
          </div>

          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: COLOR.textStrong }}>
            {isRest ? "Rest day" : sessionType}
          </span>

          <span
            style={{
              padding: "3px 9px",
              background: pillBg,
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              borderRadius: 9999,
            }}
          >
            {pillLabel}
          </span>

          {!isRest && (
            <span
              aria-hidden="true"
              style={{
                color: COLOR.textMuted,
                fontSize: 12,
                width: 12,
                textAlign: "center",
              }}
            >
              {isExpanded ? "▼" : "▶"}
            </span>
          )}
        </button>

        {isExpanded && !isRest && (
          <div style={{ padding: "0 14px 14px 70px", borderTop: `1px solid ${COLOR.divider}` }}>
            {exercises.length === 0 ? (
              <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "10px 0 0 0" }}>
                No prescribed exercises.
              </p>
            ) : (
              <ul
                style={{
                  margin: "8px 0 0 0",
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {exercises.map((ex) => (
                  <li
                    key={ex.name}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 0",
                      borderTop: `1px solid ${COLOR.divider}`,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: COLOR.textMid }}>
                      {ex.name.split("(")[0].trim()}
                      {ex.video_url && (
                        <a
                          href={ex.video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            color: COLOR.accent,
                            textDecoration: "underline",
                          }}
                        >
                          ▶ video
                        </a>
                      )}
                    </span>
                    <span
                      data-tnum
                      style={{
                        fontFamily: "var(--font-dm-mono), monospace",
                        fontWeight: 600,
                        color: COLOR.textStrong,
                      }}
                    >
                      {ex.reps ?? ex.target ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {(showFooterToday || showFooterFuture) && (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {showFooterToday && (
                  <button
                    type="button"
                    onClick={() => setLoggerOpen(true)}
                    style={{
                      flex: 1,
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "none",
                      background: COLOR.textStrong,
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {hasDraft ? "Resume session" : "Start session"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSwapOpen(true)}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 9999,
                    background: COLOR.surfaceAlt,
                    border: `1px solid ${COLOR.divider}`,
                    fontSize: 12,
                    fontWeight: 600,
                    color: COLOR.textMid,
                    cursor: "pointer",
                  }}
                >
                  Swap day
                </button>
              </div>
            )}

            {showFooterPastLogged && (
              <a
                href={`/strength?tab=date&date=${date}`}
                style={{
                  display: "inline-block",
                  marginTop: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  color: COLOR.accent,
                  textDecoration: "none",
                }}
              >
                View logged session →
              </a>
            )}

            {showFooterPastUnlogged && (
              <p
                style={{
                  margin: "12px 0 0 0",
                  fontSize: 11,
                  color: COLOR.textFaint,
                  fontStyle: "italic",
                }}
              >
                Not logged.
              </p>
            )}
          </div>
        )}
      </div>

      {loggerOpen && (
        <LoggerSheet
          userId={userId}
          sessionType={sessionType}
          date={date}
          weekdayLong={weekdayLong}
          weekOverrides={weekOverrides}
          weekPrescriptions={weekPrescriptions}
          onClose={() => {
            setLoggerOpen(false);
            setDraftEpoch((e) => e + 1);
          }}
        />
      )}

      {swapOpen && (
        <DaySwapSheet
          userId={userId}
          weekStart={weekStart}
          sourceDay={weekdayShort}
          plan={sessionPlan}
          onClose={() => setSwapOpen(false)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify `MODES` is exported from readiness**

Run:
```bash
grep -n "^export const MODES\|^export { MODES" "lib/coach/readiness.ts"
```
Expected: at least one match. If no match, `MODES` is internal — replace `sessionAccent` with a fallback to `COLOR.accent` and skip the lookup. To keep the implementation simple either way, prefer:

```ts
function sessionAccent(_sessionType: string): string {
  return COLOR.accent;
}
```

Use whichever resolves cleanly against the actual export.

- [ ] **Step 3: Type-check**

Run:
```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/strength/ScheduleDayRow.tsx
git commit -m "$(cat <<'EOF'
schedule: ScheduleDayRow — single accordion row

Collapsed: weekday + date + session label + status pill (Today / Logged
/ session-type / Rest). Expanded: prescribed exercise list + per-class
footer CTAs (Start session today, View logged session past, Swap day
today + future, muted "Not logged" past-unlogged). REST rows stay
collapsed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Build `WeekScheduleAccordion` component

**Files:**
- Create: `components/strength/WeekScheduleAccordion.tsx`

Owns expanded-row state (`Set<Weekday>`) and renders one `ScheduleDayRow` per weekday. Auto-expands today on first paint.

- [ ] **Step 1: Create the file**

Create [components/strength/WeekScheduleAccordion.tsx](components/strength/WeekScheduleAccordion.tsx):

```tsx
"use client";

import { useEffect, useState } from "react";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type {
  ExerciseOverrides,
  SessionPlan,
  SessionPrescriptions,
  Weekday,
} from "@/lib/data/types";
import { ScheduleDayRow, type DayClass } from "@/components/strength/ScheduleDayRow";

export type WeekDayEntry = {
  weekdayShort: Weekday;
  weekdayLong: string;
  date: string;
  sessionType: string;
  exercises: PlannedExercise[];
  dayClass: DayClass;
};

type Props = {
  userId: string;
  weekStart: string;
  days: WeekDayEntry[];
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions: SessionPrescriptions | null;
  sessionPlan: SessionPlan;
};

export function WeekScheduleAccordion({
  userId,
  weekStart,
  days,
  weekOverrides,
  weekPrescriptions,
  sessionPlan,
}: Props) {
  const [expanded, setExpanded] = useState<Set<Weekday>>(new Set());

  // Auto-expand today on first paint of a given week (re-keyed by weekStart).
  useEffect(() => {
    const today = days.find((d) => d.dayClass === "today");
    setExpanded(new Set(today ? [today.weekdayShort] : []));
  }, [weekStart, days]);

  function toggle(day: Weekday) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {days.map((d) => (
        <ScheduleDayRow
          key={d.weekdayShort}
          userId={userId}
          weekStart={weekStart}
          weekdayShort={d.weekdayShort}
          weekdayLong={d.weekdayLong}
          date={d.date}
          sessionType={d.sessionType}
          exercises={d.exercises}
          dayClass={d.dayClass}
          isExpanded={expanded.has(d.weekdayShort)}
          onToggle={() => toggle(d.weekdayShort)}
          weekOverrides={weekOverrides}
          weekPrescriptions={weekPrescriptions}
          sessionPlan={sessionPlan}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/strength/WeekScheduleAccordion.tsx
git commit -m "$(cat <<'EOF'
schedule: WeekScheduleAccordion — 7-row container

Owns per-row expanded state (Set<Weekday>). Auto-expands today on
first paint of a given week_start. Re-keys on weekStart change so
navigating prev/next resets to the new week's today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Build `StrengthScheduleClient` — top-level container

**Files:**
- Create: `components/strength/StrengthScheduleClient.tsx`

Owns the `weekStart` URL parameter, fetches `useTrainingWeek` + `useFullWorkouts` + `useUserSessionTemplates`, assembles the `days` array via the canonical resolution chain, and renders the week navigator header + empty-state banner + accordion.

- [ ] **Step 1: Create the file**

Create [components/strength/StrengthScheduleClient.tsx](components/strength/StrengthScheduleClient.tsx):

```tsx
"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { WeekScheduleAccordion, type WeekDayEntry } from "@/components/strength/WeekScheduleAccordion";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
import { useUserSessionTemplates } from "@/lib/query/hooks/useUserSessionTemplates";
import { currentWeekMonday } from "@/lib/coach/week";
import { getEffectiveSessionPlan, WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import type { DayClass } from "@/components/strength/ScheduleDayRow";
import type { Weekday, SessionPlan } from "@/lib/data/types";

const WEEKDAY_ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LONG: Record<Weekday, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtWeekHeader(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00Z");
  const end = new Date(weekStart + "T12:00:00Z");
  end.setUTCDate(start.getUTCDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${start.toLocaleDateString("en-US", opts)} → ${end.toLocaleDateString("en-US", opts)}`;
}

type Props = { userId: string };

export function StrengthScheduleClient({ userId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const todayIso = todayInUserTz();
  const defaultMonday = currentWeekMonday();

  const weekParam = searchParams.get("week");
  const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)
    ? weekParam
    : defaultMonday;

  const { data: trainingWeek = null, isLoading: tweekLoading } = useTrainingWeek(userId, weekStart);
  const { data: workouts = [], isLoading: workoutsLoading } = useFullWorkouts(userId);
  const { data: templatesMap = {}, isLoading: templatesLoading } = useUserSessionTemplates(userId);

  // Cap navigation: 8 weeks back, 1 forward.
  const minWeek = addDays(defaultMonday, -7 * 8);
  const maxWeek = addDays(defaultMonday, 7);

  const days = useMemo<WeekDayEntry[]>(() => {
    const sessionPlan: SessionPlan = (trainingWeek?.session_plan ?? {}) as SessionPlan;
    const overrides = trainingWeek?.exercise_overrides ?? null;
    const prescriptions = trainingWeek?.session_prescriptions ?? null;

    const loggedDates = new Set(workouts.map((w) => w.date));

    return WEEKDAY_ORDER.map<WeekDayEntry>((wd, i) => {
      const date = addDays(weekStart, i);
      const weekdayLong = WEEKDAY_LONG[wd];
      const sessionType =
        sessionPlan[wd] ?? WEEKLY_SESSIONS[weekdayLong] ?? "REST";

      const userTemplate = templatesMap[sessionType]?.exercises ?? null;
      const exercises = sessionType === "REST"
        ? []
        : getEffectiveSessionPlan(sessionType, weekdayLong, prescriptions, overrides, userTemplate);

      const isToday = date === todayIso;
      const isPast = date < todayIso;
      const isLogged = loggedDates.has(date);

      let dayClass: DayClass;
      if (sessionType === "REST") dayClass = "rest";
      else if (isToday) dayClass = "today";
      else if (isPast && isLogged) dayClass = "past_logged";
      else if (isPast) dayClass = "past_unlogged";
      else dayClass = "future";

      return {
        weekdayShort: wd,
        weekdayLong,
        date,
        sessionType,
        exercises,
        dayClass,
      };
    });
  }, [trainingWeek, workouts, templatesMap, weekStart, todayIso]);

  const hasCommittedWeek = trainingWeek !== null;
  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const prevDisabled = prevWeek < minWeek;
  const nextDisabled = nextWeek > maxWeek;

  function goTo(week: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("week", week);
    router.replace(`/strength?${params.toString()}`);
  }

  const isLoading = tweekLoading || workoutsLoading || templatesLoading;

  return (
    <div style={{ padding: "8px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Week navigator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 14,
          padding: "10px 12px",
        }}
      >
        <button
          type="button"
          onClick={() => goTo(prevWeek)}
          disabled={prevDisabled}
          aria-label="Previous week"
          style={{
            padding: "6px 10px",
            borderRadius: 9999,
            border: `1px solid ${COLOR.divider}`,
            background: COLOR.surfaceAlt,
            color: prevDisabled ? COLOR.textFaint : COLOR.textMid,
            fontSize: 13,
            fontWeight: 600,
            cursor: prevDisabled ? "default" : "pointer",
            opacity: prevDisabled ? 0.4 : 1,
          }}
        >
          ‹
        </button>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <span
            style={{
              fontSize: 10,
              color: COLOR.textMuted,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Week of
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>
            {fmtWeekHeader(weekStart)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => goTo(nextWeek)}
          disabled={nextDisabled}
          aria-label="Next week"
          style={{
            padding: "6px 10px",
            borderRadius: 9999,
            border: `1px solid ${COLOR.divider}`,
            background: COLOR.surfaceAlt,
            color: nextDisabled ? COLOR.textFaint : COLOR.textMid,
            fontSize: 13,
            fontWeight: 600,
            cursor: nextDisabled ? "default" : "pointer",
            opacity: nextDisabled ? 0.4 : 1,
          }}
        >
          ›
        </button>
      </div>

      {/* Default-plan banner */}
      {!isLoading && !hasCommittedWeek && (
        <Card>
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.textStrong }}>
              Default plan
            </span>
            <a
              href={`/strength?tab=coach&mode=plan_week&week=${weekStart}`}
              style={{ fontSize: 12, color: COLOR.accent, textDecoration: "none" }}
            >
              Plan this week with Coach →
            </a>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div style={{ padding: "24px 0", textAlign: "center", color: COLOR.textMuted }}>
          Loading…
        </div>
      ) : (
        <WeekScheduleAccordion
          userId={userId}
          weekStart={weekStart}
          days={days}
          weekOverrides={trainingWeek?.exercise_overrides ?? null}
          weekPrescriptions={trainingWeek?.session_prescriptions ?? null}
          sessionPlan={(trainingWeek?.session_plan ?? {}) as SessionPlan}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify `Card` import**

Run:
```bash
ls "components/ui/Card.tsx" 2>/dev/null && echo OK
grep -n "export function Card\|export const Card" "components/ui/Card.tsx" | head -1
```
Expected: file exists; the `Card` symbol is exported. If named export differs (e.g. `default`), adjust the import line accordingly.

- [ ] **Step 3: Verify `todayInUserTz` and `currentWeekMonday` exports**

Run:
```bash
grep -n "export function todayInUserTz" "lib/time.ts"
grep -n "export function currentWeekMonday" "lib/coach/week.ts"
```
Expected: both match.

- [ ] **Step 4: Type-check**

Run:
```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/strength/StrengthScheduleClient.tsx
git commit -m "$(cat <<'EOF'
schedule: StrengthScheduleClient — week navigator + data assembly

Reads ?week=YYYY-MM-DD (Monday-keyed), defaults to currentWeekMonday().
Caps nav to 8 weeks back, 1 forward. Composes the 7-day entry array
via the canonical getEffectiveSessionPlan chain. Renders default-plan
banner when no committed training_weeks row exists for the selected
week.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire the `schedule` tab into the strength page

**Files:**
- Modify: [app/strength/page.tsx](app/strength/page.tsx)

- [ ] **Step 1: Add the sub-pill + tab branch**

Open [app/strength/page.tsx](app/strength/page.tsx) and apply these edits:

Replace the `SUB_TABS` array:
```ts
const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "schedule", label: "Schedule" },
  { key: "date", label: "By date" },
  { key: "by_muscle", label: "By muscle" },
  { key: "log", label: "Log" },
];
```

Replace the `Tab` type and `parseTab`:
```ts
type Tab = "coach" | "schedule" | "date" | "by_muscle" | "log";

function parseTab(value: string | undefined): Tab {
  if (value === "schedule" || value === "date" || value === "by_muscle" || value === "log") return value;
  return "coach";
}
```

Add the import near the others:
```ts
import { StrengthScheduleClient } from "@/components/strength/StrengthScheduleClient";
```

Add the branch in the JSX (between `coach` and `date`):
```tsx
{tab === "coach" && <StrengthCoachClient userId={user.id} />}
{tab === "schedule" && <StrengthScheduleClient userId={user.id} />}
{tab === "date" && <StrengthByDateClient userId={user.id} />}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/strength/page.tsx
git commit -m "$(cat <<'EOF'
schedule: wire schedule tab into /strength

Adds the new sub-pill between Coach and By date, with the Tab union
+ parseTab + JSX branch. Plan-shaped surface alongside Coach; By date
keeps the log-shaped audit role.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Manual smoke test in dev

**Files:** none.

- [ ] **Step 1: Start dev server**

Run (foreground or background):
```bash
npm run dev
```
Open http://localhost:3000.

- [ ] **Step 2: Default landing**

Navigate to `/strength?tab=schedule`. Expected:
- Sub-pill row reads Coach / Schedule / By date / By muscle / Log; Schedule is active.
- Header shows "Week of <Mon date> → <Sun date>" for the current week.
- Today's row is auto-expanded; right-edge pill reads "Today".
- Each non-REST row shows the session label and its session-type pill; REST rows show "Rest day" with a muted "Rest" pill and no chevron.
- Today's expanded body shows the prescribed exercise list with the right column right-aligned monospace, plus `Start session` + `Swap day` buttons.

- [ ] **Step 3: Logged history**

Navigate to `?week=YYYY-MM-DD` for a past week where you have logged workouts (use a date you remember). Expected:
- Days with `workouts` rows show a green `Logged` pill.
- Expanding one shows `View logged session →`; tap it lands on `/strength?tab=date&date=YYYY-MM-DD` with the SessionTable for that date.
- Days with no logged workout and non-REST sessionType show a muted "Not logged." note.

- [ ] **Step 4: Empty / default-plan state**

Navigate to a `?week=` value old enough that no `training_weeks` row exists. Expected:
- The "Default plan — Plan this week with Coach →" banner appears above the accordion.
- Each day still shows a sensible session type (from `WEEKLY_SESSIONS`) and the static `SESSION_PLANS` exercise list.

- [ ] **Step 5: Navigation**

Click `‹` / `›`. Expected:
- URL updates to `?tab=schedule&week=…`.
- Today auto-expands only when the rendered week contains today; otherwise no row starts expanded.
- `‹` disables (greyed) at 8 weeks back; `›` disables at 1 week forward.

- [ ] **Step 6: Swap day**

On the current week, expand a future day and tap `Swap day`. Expected: `DaySwapSheet` opens (existing component, no changes). Cancel out.

- [ ] **Step 7: Note any UX issues**

If anything renders awkwardly (spacing, pill priority, mobile width), record specific notes for a follow-up commit. Don't bundle unrelated polish into this PR.

- [ ] **Step 8: Stop dev server + open PR**

Stop `npm run dev`. Push the branch and open a PR:
```bash
git push -u origin feat/strength-week-schedule-tab
gh pr create --title "feat(strength): week schedule sub-tab" --body "$(cat <<'EOF'
## Summary
- New \`/strength?tab=schedule\` sub-pill between Coach and By date.
- Vertical accordion of Mon→Sun rows; tap to expand prescribed exercises pulled via the canonical \`getEffectiveSessionPlan\` chain.
- Per-class footer CTAs: Start session (today), View logged session (past + logged), Swap day (today + future). REST rows non-expandable.
- One new TanStack hook (\`useUserSessionTemplates\`) batches the per-week template fetch.

Spec: \`docs/superpowers/specs/2026-06-06-week-schedule-tab-design.md\`

## Test plan
- [x] \`npm run typecheck\` clean
- [x] Manual smoke at \`/strength?tab=schedule\` (default landing, past-logged, empty-state, navigation, swap)
EOF
)"
```
Expected: PR URL printed; return it to the user.

---

## Self-review

**Spec coverage**:
- §IA placement (Schedule between Coach and By date) → Task 6.
- §URL `?week=` deep-link → Task 5 (`searchParams.get("week")` + validate).
- §Week scope and navigation (8 back / 1 forward, prev/next chevrons, disable at boundaries) → Task 5.
- §Day row collapsed (weekday + date + label + status pill) → Task 3.
- §Day row expanded (exercise list + footer CTAs varying by `DayClass`) → Task 3.
- §Multi-expand (no auto-collapse of siblings; today auto-expands on first paint) → Task 4.
- §Empty / no-plan banner → Task 5.
- §Data layer (plural fetcher + hook, reused existing hooks) → Tasks 1, 2, 5.
- §Files touched list → matches Tasks 1–6.
- §Non-goals (no reorder from Schedule, no edit, no analytics) → implementation contains none of these.

**Placeholder scan**: none — every step contains exact code, exact paths, exact commands. The one fallback for `MODES` export in Task 3 step 2 is a documented branch, not a placeholder.

**Type consistency**: `DayClass` is defined and exported from `ScheduleDayRow.tsx`, then imported by `WeekScheduleAccordion.tsx` and re-imported into `StrengthScheduleClient.tsx`. `WeekDayEntry` is defined in `WeekScheduleAccordion.tsx` and imported by `StrengthScheduleClient.tsx`. `Weekday` and `SessionPlan` are the existing exports from `lib/data/types.ts`. `Card` import path matches `components/ui/Card.tsx` (verified in Task 5 Step 2). Hook names (`useUserSessionTemplates` plural, `useUserSessionTemplate` singular) match the spec.

**Scope check**: Single focused PR, no migration, no API change, no cross-cutting refactor.
