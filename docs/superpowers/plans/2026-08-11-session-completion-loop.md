# Session Completion Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finishing a workout propagates everywhere — coaches stop claiming you skipped it, both session cards show it as done, and a mistakenly-saved session can be fully unwound including the engine state it fed.

**Architecture:** Three independent seams. (1) `fetchOpenerContext` reads the right column and throws on query errors instead of degrading into a false behavioural claim; the commit route then clears untouched openers so the next greeting is fresh. (2) A single `useTodaySessionStatus` hook feeds a done-state to both session cards. (3) A `DELETE` route unwinds a workout and re-derives the two engine effects the commit fed forward.

**Tech Stack:** Next.js 15 App Router, Supabase (PostgREST), TanStack Query, vitest (node env), TypeScript strict.

## Global Constraints

- Path alias `@/*` → repo root. Use it, never relative climbs.
- Verify with `npm run typecheck` + `npx vitest run`. `npm run lint` is a no-op — do not run it.
- vitest is **node environment** and scans `lib/**/__tests__/**/*.test.ts` only. Components and `app/` routes are unreachable by tests. Anything that must be tested belongs in `lib/`.
- Anything importing `@/lib/supabase/server` transitively pulls `next/headers` and **cannot** be imported from a vitest test. Keep tested modules free of that chain.
- User-visible numbers go through `fmtNum()` from `@/lib/ui/score.ts`. Never raw `.toFixed()`.
- Never call `new Date().toISOString().slice(0,10)` or `d.getHours()` in new code — `scripts/audit-timezone-usage.mjs` is the regression gate. Use `todayInUserTz` / `getUserTimezone`.
- Dark-theme surfaces use tokens from `@/lib/ui/theme` (`COLOR`, `RADIUS`).
- `workouts` columns are `type`, `date`, `duration_min`, `started_at`, `source`, `external_id` — there is **no** `session_type` column.

---

### Task 1: Make `fetchOpenerContext` honest and testable

The reported bug. `fetchOpenerContext` selects a column that does not exist; PostgREST 400s; the unchecked `.error` lets a schema failure render as "no session logged", which Haiku turns into "You missed legs yesterday".

Three changes: correct column, error checks on all five queries, and drop the `getUserTimezone` call so the function is reachable from a node test (the route passes `tz` in instead).

**Files:**
- Modify: `lib/coach/opener.ts`
- Modify: `app/api/chat/coach/ensure-opener/route.ts`
- Test: `lib/coach/__tests__/opener-context.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `fetchOpenerContext(supabase: SupabaseClient, userId: string, tz: string): Promise<OpenerContext>` — **note the new third parameter**.
  - `renderContextBlock(ctx: OpenerContext): string` — newly exported for test.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/__tests__/opener-context.test.ts`:

```ts
// lib/coach/__tests__/opener-context.test.ts
//
// Regression coverage for the 2026-08-11 "You missed legs yesterday" bug.
// fetchOpenerContext selected `workouts.session_type`, which does not exist.
// PostgREST answered 42703/400, the unchecked .error let `data` be null, and
// the opener told three coaches the athlete had skipped a session he had
// logged. Two properties are locked here: the query reads the real column,
// and a query error throws instead of degrading into a behavioural claim.

import { describe, it, expect } from "vitest";
import { fetchOpenerContext, renderContextBlock } from "@/lib/coach/opener";
import type { SupabaseClient } from "@supabase/supabase-js";

type Res = { data: unknown; error: unknown };

/** Records every select() string per table, and answers each `from(table)`
 *  call from that table's queued responses in call order. fetchOpenerContext
 *  builds its five queries inside one Promise.all array literal, so `from()`
 *  fires in source order: daily_logs (today), daily_logs (yesterday),
 *  training_blocks, training_weeks, workouts. */
function fakeClient(queues: Record<string, Res[]>) {
  const selects: Record<string, string[]> = {};
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = (cols: string) => {
        (selects[table] ??= []).push(cols);
        return chain;
      };
      chain.eq = self;
      chain.gte = self;
      chain.lte = self;
      chain.order = self;
      chain.limit = self;
      chain.maybeSingle = () =>
        Promise.resolve(queues[table]?.shift() ?? { data: null, error: null });
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, selects };
}

const OK = { data: null, error: null };

function baseQueues(): Record<string, Res[]> {
  return {
    daily_logs: [OK, OK],
    training_blocks: [OK],
    training_weeks: [
      {
        data: { session_plan: { Monday: "Legs", Tuesday: "Chest" } },
        error: null,
      },
      // no second call
    ],
    workouts: [{ data: { type: "Legs" }, error: null }],
  };
}

describe("fetchOpenerContext", () => {
  it("reads workouts.type, not workouts.session_type", async () => {
    const { client, selects } = fakeClient(baseQueues());
    await fetchOpenerContext(client, "user-1", "Asia/Dubai");
    const workoutSelect = selects.workouts?.[0] ?? "";
    expect(workoutSelect).toContain("type");
    expect(workoutSelect).not.toContain("session_type");
  });

  it("surfaces the logged session as yesterdayTrained", async () => {
    const { client } = fakeClient(baseQueues());
    const ctx = await fetchOpenerContext(client, "user-1", "Asia/Dubai");
    expect(ctx.yesterdayTrained).toBe("Legs");
  });

  it("throws when the workouts query errors instead of reporting no session", async () => {
    const q = baseQueues();
    q.workouts = [
      { data: null, error: { code: "42703", message: "column does not exist" } },
    ];
    const { client } = fakeClient(q);
    await expect(fetchOpenerContext(client, "user-1", "Asia/Dubai")).rejects.toThrow();
  });
});

describe("renderContextBlock", () => {
  const EMPTY = {
    todayLog: null,
    yesterdayLog: null,
    yesterdayPlanned: null,
    yesterdayTrained: null,
    activeBlockGoal: null,
    activeBlockPhaseWeek: null,
  };

  it("reports a matching session as trained-as-planned", () => {
    const out = renderContextBlock({
      ...EMPTY,
      yesterdayPlanned: "Legs",
      yesterdayTrained: "Legs",
    });
    expect(out).toContain("trained Legs as planned");
    expect(out).not.toContain("no session logged");
  });

  it("only claims a missed session when nothing was trained", () => {
    const out = renderContextBlock({ ...EMPTY, yesterdayPlanned: "Legs" });
    expect(out).toContain("no session logged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/__tests__/opener-context.test.ts`
Expected: FAIL — `renderContextBlock` is not exported, and `fetchOpenerContext` takes 2 arguments.

- [ ] **Step 3: Change the signature and drop the tz lookup**

In `lib/coach/opener.ts`, delete the `getUserTimezone` import and change the function head:

```ts
export async function fetchOpenerContext(
  supabase: SupabaseClient,
  userId: string,
  tz: string,
): Promise<OpenerContext> {
  const today = todayInUserTz(new Date(), tz);
```

(Delete the `const tz = await getUserTimezone(userId);` line — `tz` is now a parameter.)

- [ ] **Step 4: Fix the column and the null ordering**

Replace the `workouts` query inside the `Promise.all` array:

```ts
    supabase
      .from("workouts")
      .select("type")
      .eq("user_id", userId)
      .eq("date", yesterday)
      // started_at is nullable (pre-0053 logger rows, Strong imports) and
      // Postgres sorts NULLs FIRST under DESC — which would prefer an
      // untimed row over a timed one on a two-session day.
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
```

And the read below it:

```ts
    yesterdayTrained: yesterdayWorkoutRes.data
      ? (yesterdayWorkoutRes.data as { type: string }).type
      : null,
```

- [ ] **Step 5: Check every query's error**

Immediately after the `Promise.all` destructure in `fetchOpenerContext`, add:

```ts
  // A failed query must never degrade into a behavioural claim. On
  // 2026-08-11 a wrong column name (workouts.session_type) 400'd here,
  // the error went unread, and `data: null` rendered as "no session
  // logged" — which three coaches delivered as "you missed legs
  // yesterday". Throwing surfaces the failure as a missing opener, which
  // is honest; the route already maps it to a 500.
  for (const [label, res] of [
    ["daily_logs.today", todayLogRes],
    ["daily_logs.yesterday", yesterdayLogRes],
    ["training_blocks", blockRes],
    ["training_weeks", weekRes],
    ["workouts", yesterdayWorkoutRes],
  ] as const) {
    if (res.error) {
      throw new Error(`[opener] ${label} query failed: ${res.error.message}`);
    }
  }
```

- [ ] **Step 6: Export `renderContextBlock`**

Change `function renderContextBlock(` to `export function renderContextBlock(` in `lib/coach/opener.ts`.

- [ ] **Step 7: Pass tz from the route**

In `app/api/chat/coach/ensure-opener/route.ts`, add the import:

```ts
import { getUserTimezone } from "@/lib/time/get-user-tz";
```

and change the context call inside the existing `try`:

```ts
    const tz = await getUserTimezone(user.id);
    const ctx = await fetchOpenerContext(sr, user.id, tz);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run lib/coach/__tests__/opener-context.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If another caller of `fetchOpenerContext` surfaces, pass `tz` there too — `app/api/chat/coach/ensure-opener/route.ts` is the only known one.

- [ ] **Step 10: Commit**

```bash
git add lib/coach/opener.ts app/api/chat/coach/ensure-opener/route.ts lib/coach/__tests__/opener-context.test.ts
git commit -m "fix(opener): read workouts.type and fail loudly on query errors

fetchOpenerContext selected workouts.session_type, a column that does not
exist. PostgREST 400'd, the unchecked .error left data null, and the
context rendered 'planned Legs, no session logged' — which Carter, Remi
and Peter all delivered as 'you missed legs yesterday' on 2026-08-11 for
a session that was logged, debriefed, and 55 minutes long."
```

---

### Task 2: Clear untouched openers when a session is committed

An opener is written once per thread per 18h window, on first chat open — around 04:30, hours before training. It never rewrites itself, so it cannot mention the session that follows it.

On commit, delete each thread's opener **only when it is still the newest row of any kind in that thread**. An opener the athlete has already replied to is conversational history; deleting it would orphan the reply, and is unnecessary because live turns read the snapshot, which already contains today's workouts.

**Files:**
- Create: `lib/coach/opener-refresh.ts`
- Create: `lib/coach/__tests__/opener-refresh.test.ts`
- Modify: `app/api/logger/session/route.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type ThreadRow = { id: string; thread: string; kind: string; role: string; created_at: string }`
  - `selectStaleOpenerIds(rows: readonly ThreadRow[], dayStartUtc: string): string[]` — pure.
  - `clearStaleOpeners(opts: { supabase: SupabaseClient; userId: string; dayStartUtc: string }): Promise<number>` — returns the count deleted.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/__tests__/opener-refresh.test.ts`:

```ts
// lib/coach/__tests__/opener-refresh.test.ts
//
// The opener is a dawn artifact — written on first chat open, hours before
// training, and never rewritten. After a session commit we clear it so the
// next greeting knows about the session. Only when it is still the newest
// row in its thread: once the athlete has replied, the greeting is history
// and deleting it would orphan the reply.

import { describe, it, expect } from "vitest";
import { selectStaleOpenerIds, type ThreadRow } from "@/lib/coach/opener-refresh";

const DAY_START = "2026-08-11T20:00:00Z"; // 00:00 Dubai on 2026-08-12

function opener(thread: string, id: string, created_at: string): ThreadRow {
  return { id, thread, kind: "coach", role: "assistant", created_at };
}

describe("selectStaleOpenerIds", () => {
  it("clears an opener nobody replied to", () => {
    const rows = [opener("carter", "o1", "2026-08-12T00:17:00Z")];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual(["o1"]);
  });

  it("preserves an opener the athlete replied to", () => {
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      { id: "u1", thread: "carter", kind: "coach", role: "user", created_at: "2026-08-12T09:00:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("preserves an opener followed by any other card", () => {
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      { id: "d1", thread: "carter", kind: "workout_debrief", role: "assistant", created_at: "2026-08-12T09:42:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("ignores an opener from before today", () => {
    const rows = [opener("carter", "o1", "2026-08-11T00:17:00Z")];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual([]);
  });

  it("decides each thread independently", () => {
    const rows: ThreadRow[] = [
      opener("carter", "o1", "2026-08-12T00:17:00Z"),
      opener("remi", "o2", "2026-08-12T00:29:00Z"),
      { id: "u1", thread: "remi", kind: "coach", role: "user", created_at: "2026-08-12T09:00:00Z" },
    ];
    expect(selectStaleOpenerIds(rows, DAY_START)).toEqual(["o1"]);
  });

  it("returns nothing for an empty thread set", () => {
    expect(selectStaleOpenerIds([], DAY_START)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/__tests__/opener-refresh.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/opener-refresh`.

- [ ] **Step 3: Write the module**

Create `lib/coach/opener-refresh.ts`:

```ts
// lib/coach/opener-refresh.ts
//
// A coach opener is written once per thread per rolling 18h window, on the
// athlete's first chat open — typically ~04:30, hours before training. It
// never rewrites itself, so a morning opener cannot mention the session
// that follows it.
//
// On session commit we clear the day's opener so the next visit regenerates
// one that knows about the session. Only when it is still the newest row in
// its thread: once the athlete has replied, the greeting is load-bearing
// history, and deleting it would orphan the reply. It is also unnecessary —
// live chat turns read the snapshot, which already carries today's workouts.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ThreadRow = {
  id: string;
  thread: string;
  kind: string;
  role: string;
  created_at: string;
};

/** Ids of openers that are safe to clear: newest row in their thread, kind
 *  'coach', assistant-authored, and created on or after the local day start. */
export function selectStaleOpenerIds(
  rows: readonly ThreadRow[],
  dayStartUtc: string,
): string[] {
  const newestByThread = new Map<string, ThreadRow>();
  for (const r of rows) {
    const cur = newestByThread.get(r.thread);
    if (!cur || r.created_at > cur.created_at) newestByThread.set(r.thread, r);
  }
  const ids: string[] = [];
  for (const r of newestByThread.values()) {
    if (r.kind === "coach" && r.role === "assistant" && r.created_at >= dayStartUtc) {
      ids.push(r.id);
    }
  }
  return ids;
}

/** Fetches today's rows across all coach threads, decides which openers are
 *  stale, and deletes them. Returns the number deleted. */
export async function clearStaleOpeners(opts: {
  supabase: SupabaseClient;
  userId: string;
  dayStartUtc: string;
}): Promise<number> {
  const { supabase, userId, dayStartUtc } = opts;

  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, thread, kind, role, created_at")
    .eq("user_id", userId)
    .gte("created_at", dayStartUtc)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const ids = selectStaleOpenerIds((data ?? []) as ThreadRow[], dayStartUtc);
  if (ids.length === 0) return 0;

  const { error: delErr } = await supabase
    .from("chat_messages")
    .delete()
    .eq("user_id", userId)
    .in("id", ids);
  if (delErr) throw delErr;
  return ids.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/__tests__/opener-refresh.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Wire into the commit route**

In `app/api/logger/session/route.ts`, add the imports:

```ts
import { clearStaleOpeners } from "@/lib/coach/opener-refresh";
import { localDayRangeUtc } from "@/lib/time";
```

Then, after the existing `repatchRemainingWeek` try/catch block and before `return NextResponse.json(result);`, add:

```ts
    // Openers are written at dawn and never rewrite themselves. Clear the
    // untouched ones so the next coach the athlete opens greets him about
    // the session he just finished rather than a line written before it.
    // Non-fatal: a failure costs a stale greeting, never the commit.
    try {
      const tz = await getUserTimezone(payload.user_id);
      const { startUtc } = localDayRangeUtc(todayInUserTz(new Date(), tz), tz);
      await clearStaleOpeners({
        supabase,
        userId: payload.user_id,
        dayStartUtc: startUtc,
      });
    } catch (err) {
      console.error("[logger/session] clearStaleOpeners failed:", err);
    }
```

- [ ] **Step 6: Confirm the `localDayRangeUtc` return shape**

Run: `grep -n "export function localDayRangeUtc" -A 12 lib/time.ts`
If it returns a tuple or differently-named fields, adapt the destructure in Step 5 to match. Do not change `lib/time.ts`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/coach/opener-refresh.ts lib/coach/__tests__/opener-refresh.test.ts app/api/logger/session/route.ts
git commit -m "feat(opener): refresh untouched openers after a session commit

An opener is written at first chat open, hours before training, and never
rewrites itself. Clearing it on commit — only while it is still the newest
row in its thread — lets the next greeting know about the session. Threads
the athlete has already replied to are left alone; those turns read the
snapshot, which already carries today's workouts."
```

---

### Task 3: Derive the target-hit week from the qualifying session, not from today

Prerequisite for the unwind. `evaluateAndStampTargetHit` computes its week index from `new Date()` — so clearing and re-evaluating during an unwind would re-stamp a week-3 crossing as week 5. Deriving the week from the date of the session that actually holds the best value makes the value re-derivable.

Behaviour-preserving on the commit path: there, the qualifying session is normally today's, and any earlier qualifying session would already have stamped the block on its own commit.

**Files:**
- Modify: `lib/coach/prescription/target-hit-evaluator.ts`
- Create: `lib/coach/prescription/__tests__/target-hit-week.test.ts`

**Interfaces:**
- Consumes: `bestComparisonValue` from `@/lib/coach/e1rm` (existing).
- Produces: `pickQualifyingDate(perDate: ReadonlyArray<{ date: string; best: number | null }>, target: number): string | null` — exported pure helper. Returns the **earliest** date whose best value meets the target, or null.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/prescription/__tests__/target-hit-week.test.ts`:

```ts
// lib/coach/prescription/__tests__/target-hit-week.test.ts
//
// The target-hit week used to be computed from `new Date()`, which made it
// unrecoverable: unwinding a mistakenly-saved session and re-evaluating
// would re-stamp an old crossing with today's week index. Deriving it from
// the date of the session that actually holds the qualifying value makes it
// a function of the data, so the unwind can restore it.

import { describe, it, expect } from "vitest";
import { pickQualifyingDate } from "@/lib/coach/prescription/target-hit-evaluator";

describe("pickQualifyingDate", () => {
  it("returns the earliest date that meets the target", () => {
    const out = pickQualifyingDate(
      [
        { date: "2026-07-20", best: 98 },
        { date: "2026-08-03", best: 102 },
        { date: "2026-08-10", best: 106 },
      ],
      100,
    );
    expect(out).toBe("2026-08-03");
  });

  it("is order-independent", () => {
    const out = pickQualifyingDate(
      [
        { date: "2026-08-10", best: 106 },
        { date: "2026-08-03", best: 102 },
      ],
      100,
    );
    expect(out).toBe("2026-08-03");
  });

  it("treats an exact match as qualifying", () => {
    expect(pickQualifyingDate([{ date: "2026-08-03", best: 100 }], 100)).toBe("2026-08-03");
  });

  it("returns null when nothing meets the target", () => {
    expect(pickQualifyingDate([{ date: "2026-08-03", best: 99 }], 100)).toBeNull();
  });

  it("skips dates with no comparable sets", () => {
    const out = pickQualifyingDate(
      [
        { date: "2026-08-03", best: null },
        { date: "2026-08-10", best: 106 },
      ],
      100,
    );
    expect(out).toBe("2026-08-10");
  });

  it("returns null for an empty set", () => {
    expect(pickQualifyingDate([], 100)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/prescription/__tests__/target-hit-week.test.ts`
Expected: FAIL — `pickQualifyingDate` is not exported.

- [ ] **Step 3: Add the pure helper**

Append to `lib/coach/prescription/target-hit-evaluator.ts`:

```ts
/** Earliest date whose best comparison value meets the target, or null.
 *  The crossing happened on that date — deriving the block week from it
 *  (rather than from "now") is what makes target_hit_at_week a function of
 *  the data, and therefore restorable after a session is unwound. */
export function pickQualifyingDate(
  perDate: ReadonlyArray<{ date: string; best: number | null }>,
  target: number,
): string | null {
  let earliest: string | null = null;
  for (const d of perDate) {
    if (d.best == null || d.best < target) continue;
    if (earliest === null || d.date < earliest) earliest = d.date;
  }
  return earliest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/prescription/__tests__/target-hit-week.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Use it in the evaluator**

In `evaluateAndStampTargetHit`, the current code flattens every matching set into one `candidateSets` array, then computes `weekN` from `new Date()`. Replace the block from `const candidateSets` through the `weekN` computation with a per-date grouping:

```ts
  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";

  // Group by session date so the crossing can be attributed to the session
  // that produced it. Flattening across dates loses that, and the block week
  // then has to be guessed from "now".
  const perDate: Array<{ date: string; best: number | null }> = [];
  for (const w of rows) {
    const sets: Array<{ kg: number | null; reps: number | null; warmup: boolean | null }> = [];
    for (const ex of w.exercises ?? []) {
      if (!patternsLower.includes(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        sets.push({ kg: s.kg, reps: s.reps, warmup: s.warmup });
      }
    }
    if (sets.length > 0) perDate.push({ date: w.date, best: bestComparisonValue(sets, metric) });
  }

  const qualifyingDate = pickQualifyingDate(perDate, block.target_value);
  if (qualifyingDate === null) return { stamped: false, week_n: null };

  // Block-week index (1-indexed) of the session that crossed the target.
  const start = new Date(block.start_date + "T00:00:00Z");
  const crossed = new Date(qualifyingDate + "T00:00:00Z");
  const weekN = Math.max(
    1,
    Math.floor((crossed.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1,
  );
```

Leave the optimistic `update ... .is("target_hit_at_week", null)` and the return statement below it unchanged. Delete the now-unused `best` variable and its `if (best == null || best < block.target_value)` guard, which `pickQualifyingDate` replaces.

- [ ] **Step 6: Run the full prescription audit**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: all assertions pass (83 at time of writing). This is the regression gate on the prescription engine.

- [ ] **Step 7: Typecheck and full test run**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/coach/prescription/target-hit-evaluator.ts lib/coach/prescription/__tests__/target-hit-week.test.ts
git commit -m "refactor(target-hit): derive the stamped week from the qualifying session

weekN came from new Date(), which made target_hit_at_week unrecoverable —
re-evaluating an old crossing would stamp it with today's week index. It is
now the block week of the earliest session meeting the target, which is a
function of the data. Behaviour-preserving on the commit path, and the
prerequisite for unwinding a mistakenly-saved session."
```

---

### Task 4: Unwind a committed session

`DELETE /api/logger/session/[workout_id]`. A commit is not an isolated write — `repatchRemainingWeek` rewrote the rest of the week's loads, and `evaluateAndStampTargetHit` stamped the block. Deleting only the row would leave the engine believing a PR happened, and a phantom `target_hit_at_week` locks the block into consolidation, refusing further load increases on the primary lift for the rest of the block.

**Files:**
- Create: `lib/coach/prescription/reevaluate-target-hit.ts`
- Create: `app/api/logger/session/[workout_id]/route.ts`

**Interfaces:**
- Consumes: `evaluateAndStampTargetHit` from Task 3's module (signature unchanged), `repatchRemainingWeek` from `@/lib/coach/prescription/repatch-week`.
- Produces: `reevaluateTargetHit(opts: { supabase: SupabaseClient; userId: string }): Promise<{ cleared: boolean; stamped: boolean; week_n: number | null }>`.

- [ ] **Step 1: Write the re-evaluation helper**

Create `lib/coach/prescription/reevaluate-target-hit.ts`:

```ts
// lib/coach/prescription/reevaluate-target-hit.ts
//
// evaluateAndStampTargetHit early-returns whenever the block is already
// stamped, so target_hit_at_week can never fall on its own. After a session
// is unwound the stamp may be phantom — left by a PR from a workout that no
// longer exists — and a phantom stamp locks the block into consolidation,
// where the engine refuses further load increases on the primary lift.
//
// Clearing before re-running is the only way the value can be re-derived. A
// genuine crossing from a surviving session re-stamps (at its own block
// week, per pickQualifyingDate); a phantom one does not come back.
//
// Unconditional by design: no "was the deleted session inside the block
// window?" check. The evaluator rescans the whole block window either way,
// so an out-of-window deletion simply re-stamps the same value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";

export async function reevaluateTargetHit(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<{ cleared: boolean; stamped: boolean; week_n: number | null }> {
  const { supabase, userId } = opts;

  const { data: blocks, error } = await supabase
    .from("training_blocks")
    .select("id, target_hit_at_week")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  if (error) throw error;

  const block = blocks?.[0] as { id: string; target_hit_at_week: number | null } | undefined;
  let cleared = false;

  if (block && block.target_hit_at_week != null) {
    const { error: clearErr } = await supabase
      .from("training_blocks")
      .update({ target_hit_at_week: null, updated_at: new Date().toISOString() })
      .eq("id", block.id);
    if (clearErr) throw clearErr;
    cleared = true;
  }

  const res = await evaluateAndStampTargetHit({ supabase, userId });
  return { cleared, stamped: res.stamped, week_n: res.week_n };
}
```

- [ ] **Step 2: Write the DELETE route**

Create `app/api/logger/session/[workout_id]/route.ts`:

```ts
// app/api/logger/session/[workout_id]/route.ts
//
// Full unwind of a mistakenly-saved session. Deleting the workout row is the
// easy part (exercises and exercise_sets cascade, schema.sql:60,67). The
// engine effects the commit fed forward do not reverse on their own:
//
//   - evaluateAndStampTargetHit stamped training_blocks.target_hit_at_week
//     and only ever stamps. A phantom stamp locks the block into
//     consolidation for the rest of its run.
//   - repatchRemainingWeek rewrote the remaining days' prescribed loads.
//
// Order matters and mirrors the commit path: the target-hit state settles
// before the week is recomputed against it.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reevaluateTargetHit } from "@/lib/coach/prescription/reevaluate-target-hit";
import { repatchRemainingWeek } from "@/lib/coach/prescription/repatch-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ workout_id: string }> },
) {
  const { workout_id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const { data: workout, error: fetchErr } = await supabase
    .from("workouts")
    .select("id, date, source")
    .eq("id", workout_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ ok: false, reason: "fetch_failed" }, { status: 500 });
  }
  if (!workout) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  if (workout.source !== "logger") {
    // Strong CSV imports are re-importable from their source file; deleting
    // them here would be a one-way loss with no undo.
    return NextResponse.json({ ok: false, reason: "not_logger_sourced" }, { status: 400 });
  }

  // 1. The workout itself. exercises + exercise_sets cascade.
  const { error: delErr } = await supabase
    .from("workouts")
    .delete()
    .eq("id", workout_id)
    .eq("user_id", user.id);
  if (delErr) {
    return NextResponse.json({ ok: false, reason: "delete_failed" }, { status: 500 });
  }

  // 2. The debrief card. Best-effort — an orphaned card is cosmetic, and
  //    the workout is already gone.
  try {
    await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", user.id)
      .eq("kind", "workout_debrief")
      .eq("ui->>workout_id", workout_id);
  } catch (err) {
    console.error("[logger/session DELETE] debrief cleanup failed:", err);
  }

  // 3. Re-derive the target-hit stamp, then 4. recompute the rest of the
  //    week. Both non-fatal: the Sunday cron is the backstop for the week,
  //    and the next commit re-runs the evaluator.
  try {
    await reevaluateTargetHit({ supabase, userId: user.id });
  } catch (err) {
    console.error("[logger/session DELETE] reevaluateTargetHit failed:", err);
  }

  try {
    const tz = await getUserTimezone(user.id);
    await repatchRemainingWeek({
      supabase,
      userId: user.id,
      todayIso: todayInUserTz(new Date(), tz),
      reason: "workout_unwound",
      workoutDate: workout.date as string,
    });
  } catch (err) {
    console.error("[logger/session DELETE] repatchRemainingWeek failed:", err);
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Confirm the route does not collide with the existing POST**

Run: `ls app/api/logger/session/`
Expected: `route.ts` (the POST) and `[workout_id]/` (the new DELETE). Next.js routes these as distinct paths — `/api/logger/session` and `/api/logger/session/<id>`. No change to the POST file.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Verify the whole prescription engine still agrees**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: all assertions pass.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/prescription/reevaluate-target-hit.ts app/api/logger/session/\[workout_id\]/route.ts
git commit -m "feat(logger): unwind a mistakenly-saved session

DELETE /api/logger/session/[id] removes the workout (sets cascade), drops
its debrief card, re-derives target_hit_at_week, and recomputes the rest of
the week. The two engine effects the commit fed forward do not reverse on
their own — a phantom target-hit would lock the block into consolidation
for the rest of its run."
```

---

### Task 5: `useTodaySessionStatus` — one source of truth for both cards

Both session cards need the same answer to "is today done?". Routing them through one hook is what stops `/strength` and the home tab from disagreeing.

The existing `fetchWorkoutsRangeBrowser` returns neither `duration_min` nor `source`, and it is shared with the dashboard's RecentLiftsCard — a dedicated fetcher keeps that consumer untouched.

**Files:**
- Create: `lib/query/fetchers/todaySession.ts`
- Create: `lib/query/hooks/useTodaySessionStatus.ts`
- Modify: `lib/query/keys.ts`

**Interfaces:**
- Consumes: `createFetcher` from `@/lib/query/fetchers/create-fetcher`, `useExistingLoggerDraft` from `@/lib/logger/use-existing-draft`.
- Produces:
  - `type TodaySessionWorkout = { id: string; type: string | null; duration_min: number | null; source: string | null; exercise_count: number }`
  - `fetchTodaySessionServer(supabase, userId, date): Promise<TodaySessionWorkout | null>` / `fetchTodaySessionBrowser(userId, date)`
  - `useTodaySessionStatus(userId: string, date: string, sessionType: string, epoch?: number): { logged: TodaySessionWorkout | null; hasDraft: boolean; isLoading: boolean }`
  - `queryKeys.todaySession.one(userId, date)`

- [ ] **Step 1: Add the query key**

In `lib/query/keys.ts`, inside the `queryKeys` object next to the existing `workouts` entry, add:

```ts
  todaySession: {
    one: (userId: string, date: string) => ["today-session", userId, date] as const,
  },
```

- [ ] **Step 2: Write the fetcher**

Create `lib/query/fetchers/todaySession.ts`:

```ts
// lib/query/fetchers/todaySession.ts
//
// The committed workout for a single day, with just enough to render the
// done state: duration, exercise count, and `source` (only logger-sourced
// sessions can be modified or unwound).
//
// Deliberately not widened onto lib/query/fetchers/workouts.ts — that one
// backs the dashboard's RecentLiftsCard over a 14-day window, and adding
// columns there would grow every row of that payload for no consumer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type TodaySessionWorkout = {
  id: string;
  type: string | null;
  duration_min: number | null;
  source: string | null;
  exercise_count: number;
};

const todaySession = createFetcher(
  async (
    supabase: SupabaseClient,
    userId: string,
    date: string,
  ): Promise<TodaySessionWorkout | null> => {
    const { data, error } = await supabase
      .from("workouts")
      .select("id, type, duration_min, source, exercises(id)")
      .eq("user_id", userId)
      .eq("date", date)
      // started_at is nullable; NULLs sort first under DESC in Postgres.
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as unknown as {
      id: string;
      type: string | null;
      duration_min: number | null;
      source: string | null;
      exercises: { id: string }[] | null;
    };
    return {
      id: row.id,
      type: row.type,
      duration_min: row.duration_min,
      source: row.source,
      exercise_count: row.exercises?.length ?? 0,
    };
  },
);

export const fetchTodaySessionServer = todaySession.server;
export const fetchTodaySessionBrowser = todaySession.browser;
```

- [ ] **Step 3: Write the hook**

Create `lib/query/hooks/useTodaySessionStatus.ts`:

```ts
// lib/query/hooks/useTodaySessionStatus.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import {
  fetchTodaySessionBrowser,
  type TodaySessionWorkout,
} from "@/lib/query/fetchers/todaySession";
import { useExistingLoggerDraft } from "@/lib/logger/use-existing-draft";

/** Single source of truth for "is today's session done?", consumed by both
 *  TodayPlanCard (/strength) and BriefSessionList (home tab) so the two
 *  surfaces cannot disagree.
 *
 *  `logged` and `hasDraft` are independent, not exclusive: committing then
 *  starting a fresh draft leaves both true, and the card shows both
 *  affordances rather than guessing which the athlete meant. */
export function useTodaySessionStatus(
  userId: string,
  date: string,
  sessionType: string,
  epoch: number = 0,
): { logged: TodaySessionWorkout | null; hasDraft: boolean; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.todaySession.one(userId, date),
    queryFn: () => fetchTodaySessionBrowser(userId, date),
    enabled: !!userId && !!date,
    staleTime: 30_000,
  });
  const hasDraft = useExistingLoggerDraft(userId, sessionType, epoch);
  return { logged: data ?? null, hasDraft, isLoading };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/query/fetchers/todaySession.ts lib/query/hooks/useTodaySessionStatus.ts lib/query/keys.ts
git commit -m "feat(query): useTodaySessionStatus as one source of truth for done state

Both session cards need the same answer to 'is today done?'. A dedicated
fetcher carries duration_min and source, which the shared 14-day workouts
fetcher does not — and widening that one would grow every RecentLiftsCard
row for no consumer."
```

---

### Task 6: Done state, Modify and Restart on `TodayPlanCard`

**Files:**
- Create: `components/logger/RestartSessionButton.tsx`
- Create: `components/strength/SessionDoneBar.tsx`
- Modify: `components/strength/TodayPlanCard.tsx`

**Interfaces:**
- Consumes: `useTodaySessionStatus` (Task 5), `EditSessionButton` from `@/components/logger/EditSessionButton` (existing, unchanged), the DELETE route (Task 4).
- Produces:
  - `RestartSessionButton(props: { workoutId: string; onDone: () => void })`
  - `SessionDoneBar(props: { userId: string; date: string; workout: TodaySessionWorkout })` — invalidates and refreshes internally, so it takes no callback.

- [ ] **Step 1: Write the restart button**

Create `components/logger/RestartSessionButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  workoutId: string;
  /** Called after a successful unwind so the caller can invalidate. */
  onDone: () => void;
};

/** Full unwind of a session saved by mistake. Confirmation names every
 *  consequence — this deletes sets, the debrief, and rewrites the rest of
 *  the week's prescribed loads.
 *
 *  The dialog is portalled to document.body: LoggerSheet-adjacent surfaces
 *  sit in fixed z-40 stacking contexts, and BottomNav is also body-level
 *  z-40 and renders after <main>, so an un-portalled child at equal z loses
 *  the DOM-order tie and is painted over. This repo has hit that three
 *  times (ReorderDialog, DayEditSheet, SetTimerDock). */
export function RestartSessionButton({ workoutId, onDone }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function restart() {
    setBusy(true);
    try {
      const res = await fetch(`/api/logger/session/${workoutId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { reason?: string } | null;
        alert(`Couldn't restart: ${body?.reason ?? "unknown error"}`);
        return;
      }
      setConfirming(false);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setConfirming(true)}
        style={{
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.35)",
          background: "transparent",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Restart
      </button>

      {confirming &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm restart session"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              style={{
                background: COLOR.surface,
                borderRadius: RADIUS.card,
                padding: 20,
                maxWidth: 380,
                width: "100%",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: COLOR.textStrong }}>
                Restart this session?
              </div>
              <p style={{ fontSize: 13, color: COLOR.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                Deletes the logged session and every set in it, removes its debrief,
                and recomputes the rest of this week&apos;s prescribed loads as if it
                never happened. This can&apos;t be undone.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: `1px solid ${COLOR.divider}`,
                    background: "transparent",
                    color: COLOR.textStrong,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={restart}
                  disabled={busy}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: COLOR.danger,
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? "Restarting…" : "Restart"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
```

- [ ] **Step 2: Confirm `COLOR.danger` exists**

Run: `grep -n "danger" lib/ui/theme.ts`
If absent, use `"#dc2626"` inline in the confirm button and note it.

- [ ] **Step 3: Write the done bar**

Create `components/strength/SessionDoneBar.tsx`:

```tsx
"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { EditSessionButton } from "@/components/logger/EditSessionButton";
import { RestartSessionButton } from "@/components/logger/RestartSessionButton";
import { queryKeys } from "@/lib/query/keys";
import { fmtNum } from "@/lib/ui/score";
import type { TodaySessionWorkout } from "@/lib/query/fetchers/todaySession";

type Props = {
  userId: string;
  date: string;
  workout: TodaySessionWorkout;
};

/** Completion line + Modify/Restart, rendered on top of the white-on-accent
 *  session cards. Modify reuses the existing EditSessionButton hydration
 *  path — there is no second edit mechanism. */
export function SessionDoneBar({ userId, date, workout }: Props) {
  const qc = useQueryClient();
  const router = useRouter();
  const eligible = workout.source === "logger";

  function refresh() {
    qc.invalidateQueries({ queryKey: queryKeys.todaySession.one(userId, date) });
    qc.invalidateQueries({ queryKey: queryKeys.workouts.all(userId) });
    router.refresh();
  }

  const bits = [
    workout.duration_min != null ? `${fmtNum(workout.duration_min)} min` : null,
    workout.exercise_count > 0
      ? `${workout.exercise_count} exercise${workout.exercise_count === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <Check size={14} aria-hidden="true" />
        <span>
          {workout.type ?? "Session"} logged
          {bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <a
          href={`/coach/sessions/${workout.id}`}
          style={{ fontSize: 12, fontWeight: 600, color: "#fff", textDecoration: "underline" }}
        >
          Read debrief →
        </a>
        <div style={{ flex: 1 }} />
        <EditSessionButton
          workoutId={workout.id}
          eligible={eligible}
          label="Modify"
          className="text-[12px] font-semibold text-white px-2.5 py-1.5 rounded-lg border border-white/35"
        />
        {eligible && <RestartSessionButton workoutId={workout.id} onDone={refresh} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `TodayPlanCard`**

In `components/strength/TodayPlanCard.tsx`:

Replace the import of `useExistingLoggerDraft` with the new hook, and add the done bar import:

```ts
import { useTodaySessionStatus } from "@/lib/query/hooks/useTodaySessionStatus";
import { SessionDoneBar } from "@/components/strength/SessionDoneBar";
```

Replace the `hasDraft` line:

```ts
  const today = useUserToday(userId);
  const { logged, hasDraft } = useTodaySessionStatus(userId, today ?? "", plan.sessionType, draftEpoch);
```

(Move the existing `const today = useUserToday(userId);` above it if it currently sits below — hooks must stay above any early return, and the hook needs `today`.)

Then replace the `{canStartSession && (<button …>)}` block with:

```tsx
      {logged && today && (
        <SessionDoneBar userId={userId} date={today} workout={logged} />
      )}

      {canStartSession && (!logged || hasDraft) && (
        <button
          onClick={() => setLoggerOpen(true)}
          style={{
            width: "100%",
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            background: "#fff",
            color: "#0a0a0a",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {hasDraft ? "Resume session" : "Start session"}
        </button>
      )}
```

- [ ] **Step 5: Invalidate the new key after a commit**

In `components/logger/LoggerSheet.tsx`, next to the existing
`qc.invalidateQueries({ queryKey: queryKeys.workouts.all(draft.user_id) });`, add:

```ts
    qc.invalidateQueries({ queryKey: queryKeys.todaySession.one(draft.user_id, draft.date) });
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean. The build is not optional here — vitest cannot see components, and a hook ordering mistake (React #310) passes typecheck and tests but crashes only in a production build.

- [ ] **Step 7: Commit**

```bash
git add components/logger/RestartSessionButton.tsx components/strength/SessionDoneBar.tsx components/strength/TodayPlanCard.tsx components/logger/LoggerSheet.tsx
git commit -m "feat(strength): today's session card shows done, with Modify and Restart"
```

---

### Task 7: Done state on the home tab's brief session list

**Files:**
- Modify: `components/morning/BriefSessionList.tsx`

**Interfaces:**
- Consumes: `useTodaySessionStatus` (Task 5), `SessionDoneBar` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Read the current draft/CTA wiring**

Run: `grep -n "useExistingLoggerDraft\|hasDraft\|Log this session\|useUserToday\|setLoggerOpen" components/morning/BriefSessionList.tsx`
This gives the exact lines to replace. The component already holds `userId`, mounts `LoggerSheet`, and calls `useExistingLoggerDraft` — the shape mirrors `TodayPlanCard`.

- [ ] **Step 2: Swap in the shared hook**

Replace the `useExistingLoggerDraft` import and call with:

```ts
import { useTodaySessionStatus } from "@/lib/query/hooks/useTodaySessionStatus";
import { SessionDoneBar } from "@/components/strength/SessionDoneBar";
```

```ts
  const { logged, hasDraft } = useTodaySessionStatus(userId, today ?? "", session.type, draftEpoch);
```

Keep the existing hook-call position — above any early return — and reuse whatever epoch state the component already bumps after `LoggerSheet` closes. If it has none, add `const [draftEpoch, setDraftEpoch] = useState(0);` and bump it in the sheet's `onClose`, matching `TodayPlanCard`.

- [ ] **Step 3: Render the done bar and gate the CTA**

Immediately before the existing "Log this session" CTA, add:

```tsx
      {logged && today && (
        <SessionDoneBar userId={userId} date={today} workout={logged} />
      )}
```

and wrap the CTA's existing render condition with `(!logged || hasDraft) &&` so a completed day stops inviting a fresh start while still offering Resume when a draft exists.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add components/morning/BriefSessionList.tsx
git commit -m "feat(morning): brief session list reflects a completed session"
```

---

### Task 8: Full verification

No new code. This is the gate before the branch is offered for merge.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all pass, including the three new files (`opener-context`, `opener-refresh`, `target-hit-week`).

- [ ] **Step 2: Typecheck and production build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 3: Audit scripts**

```bash
node scripts/audit-timezone-usage.mjs
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-logger-write-path.mjs
```

Expected: all pass. The timezone audit is the regression gate on forbidden date patterns; the prescription audit covers the Task 3 evaluator change.

- [ ] **Step 4: Manual pass in the running app**

Run `npm run dev`, then walk:

1. `/strength` — today already has a committed Chest session, so the card must show `✓ Chest logged · … min · … exercises` with **Read debrief**, **Modify**, **Restart**, and **no** "Start session" button.
2. Tap **Modify** — the logger opens on the saved session with its sets populated. Close without committing.
3. Home tab `/` — the morning brief's session block shows the same completion line.
4. Tap **Restart**, read the confirm copy, confirm. The card returns to "Start session", the debrief card disappears from Carter's thread, and `/coach/sessions/<id>` no longer resolves.
5. Log a short session again to restore state, then confirm the debrief card reappears.

- [ ] **Step 5: Verify the opener fix against real data**

After step 4's re-log, confirm the opener context now resolves the session. Write a throwaway script at the repo root (not in `scripts/`, and delete it after):

```js
// .tmp-verify-opener.mjs
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const uid = "94fee5c6-7d9a-4b05-be3a-8407505b5429";
const r = await sb.from("workouts").select("type").eq("user_id", uid)
  .eq("date", "2026-08-11").order("started_at", { ascending: false, nullsFirst: false })
  .limit(1).maybeSingle();
console.log("type:", r.data, "error:", r.error);
```

Run: `node --env-file=.env.local ./.tmp-verify-opener.mjs && rm .tmp-verify-opener.mjs`
Expected: `type: { type: 'Chest' } error: null` — the query that used to 400.

- [ ] **Step 6: Update CLAUDE.md**

Add to the in-app workout logger section: the commit route now also clears untouched coach openers; `DELETE /api/logger/session/[workout_id]` is the unwind path and re-derives `target_hit_at_week` (which is now stamped at the qualifying session's block week, not "now"); `useTodaySessionStatus` is the single source of the done state for both session cards.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session completion loop in CLAUDE.md"
```

---

## Self-review notes

**Spec coverage:** §1.1 → Task 1. §1.2 → Task 2. §2.1 → Task 5. §2.2 → Tasks 6, 7. §3 → Task 4, with Task 3 added as its prerequisite. §Testing → Tasks 1, 2, 3 + Task 8 step 4.

**Deviation from spec, §3 step 4:** the spec conditions the target-hit clear on "the deleted session falls inside the active block's window". `reevaluateTargetHit` is unconditional instead. The evaluator rescans the whole block window regardless, so an out-of-window deletion re-stamps the same value — the check would add a branch that can only ever be a no-op, and gets it wrong if the block dates move.

**Addition not in the spec:** Task 3. The spec assumed re-running the evaluator would restore the correct value; it would not, because the week index came from `new Date()`. Without Task 3 the unwind's step 4 silently corrupts the block week.
