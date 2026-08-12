import { describe, it, expect, vi } from "vitest";

// getUserTimezone reaches lib/supabase/server.ts, which top-level-imports
// `next/headers` — unimportable under vitest's node environment. Mocking it
// here is what makes this file testable at all; it is also the only reason
// recompute.ts had no tests before.
vi.mock("@/lib/time/get-user-tz", () => ({
  getUserTimezone: async () => "Asia/Dubai",
}));

const { recomputeStrainForDay } = await import("@/lib/coach/strain/recompute");

type Write = { table: string; op: "upsert" | "update"; payload: Record<string, unknown> };

/** Minimal chainable stand-in for the PostgREST client.
 *
 *  Every builder method returns the same thenable, so any chain length awaits
 *  correctly. Reads resolve to whatever `rows` holds for that table; writes are
 *  recorded rather than performed. Deliberately dumb — it exists to observe
 *  WHICH write happens, not to emulate Postgres. */
function stubClient(rows: Record<string, unknown>) {
  const writes: Write[] = [];

  const from = (table: string) => {
    let op: "select" | "upsert" | "update" = "select";
    let payload: Record<string, unknown> = {};
    let single = false;

    const settle = () => {
      if (op === "select") {
        const value = rows[table] ?? null;
        if (single) return { data: Array.isArray(value) ? (value[0] ?? null) : value, error: null };
        return { data: Array.isArray(value) ? value : value === null ? [] : [value], error: null };
      }
      writes.push({ table, op, payload });
      return { data: null, error: null };
    };

    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
          }
          return (...args: unknown[]) => {
            if (prop === "upsert") {
              op = "upsert";
              payload = args[0] as Record<string, unknown>;
            }
            if (prop === "update") {
              op = "update";
              payload = args[0] as Record<string, unknown>;
            }
            if (prop === "maybeSingle") single = true;
            return chain;
          };
        },
      },
    );
    return chain;
  };

  return { client: { from } as never, writes };
}

const UID = "user-1";
const DATE = "2026-08-12";

/** A day with nothing to score: no all-day HR, no activities, no workouts. */
const EMPTY_DAY = {
  profiles: { age: 36 },
  daily_logs: [{ resting_hr: 55 }],
  garmin_activities: [],
  workouts: [],
  garmin_daily: null,
  training_weeks: null,
};

/** The same day with an all-day HR stream, so it scores normally. */
const DAY_WITH_HR = {
  ...EMPTY_DAY,
  garmin_daily: {
    raw: {
      hr_samples: Array.from(
        { length: 300 },
        (_, i) => [Date.parse(`${DATE}T00:00:00Z`) + i * 120_000, 85] as [number, number],
      ),
    },
  },
};

describe("recomputeStrainForDay onEmpty", () => {
  it("defaults to skip — an empty day is left alone", async () => {
    const { client, writes } = stubClient(EMPTY_DAY);
    const res = await recomputeStrainForDay({ supabase: client, userId: UID, dateIso: DATE });

    expect(res).toEqual({ strain: null, skipped: "no_input" });
    expect(writes).toHaveLength(0);
  });

  it("skips explicitly when asked to", async () => {
    const { client, writes } = stubClient(EMPTY_DAY);
    await recomputeStrainForDay({ supabase: client, userId: UID, dateIso: DATE, onEmpty: "skip" });
    expect(writes).toHaveLength(0);
  });

  it("clears the column on an empty day when onEmpty is null — the delete path", async () => {
    const { client, writes } = stubClient(EMPTY_DAY);
    const res = await recomputeStrainForDay({
      supabase: client,
      userId: UID,
      dateIso: DATE,
      onEmpty: "null",
    });

    expect(res.strain).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe("daily_logs");
    expect(writes[0].op).toBe("update");
    expect(writes[0].payload.strain).toBeNull();
  });

  it("does NOT clear a day that still has something to score, even with onEmpty null", async () => {
    // The regression that matters: deleting one of two workouts, or deleting a
    // workout on a day whose HR has already synced, must recompute — never wipe.
    const { client, writes } = stubClient(DAY_WITH_HR);
    const res = await recomputeStrainForDay({
      supabase: client,
      userId: UID,
      dateIso: DATE,
      onEmpty: "null",
    });

    expect(res.strain).toBeGreaterThan(0);
    const dailyWrites = writes.filter((w) => w.table === "daily_logs");
    expect(dailyWrites).toHaveLength(1);
    expect(dailyWrites[0].op).toBe("upsert");
    expect(dailyWrites[0].payload.strain).toBe(res.strain);
  });

  it("writes through the same single path regardless of onEmpty", async () => {
    // onEmpty exists so the delete route does not need its own write. If a
    // second writer ever reappears, this is the test that should start failing.
    const { client: c1, writes: w1 } = stubClient(DAY_WITH_HR);
    await recomputeStrainForDay({ supabase: c1, userId: UID, dateIso: DATE });
    const { client: c2, writes: w2 } = stubClient(DAY_WITH_HR);
    await recomputeStrainForDay({ supabase: c2, userId: UID, dateIso: DATE, onEmpty: "null" });

    expect(w1.map((w) => `${w.table}.${w.op}`)).toEqual(w2.map((w) => `${w.table}.${w.op}`));
  });
});
