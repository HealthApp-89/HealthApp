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
