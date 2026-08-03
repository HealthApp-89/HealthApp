import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The inline fallback calls the real engine, which issues a dozen further
// queries. Stubbing all of them would test Supabase, not this module — mock
// the engine so the fallback is observable without simulating the schema.
vi.mock("@/lib/coach/prescription/prescribe-week", () => ({
  prescribeWeek: vi.fn(async () => ({
    Monday: [
      { name: "Squat (Barbell)", baseKg: 62.5, baseReps: 3, sets: 1, warmup: true },
      { name: "Squat (Barbell)", baseKg: 82.5, baseReps: 7, sets: 3 },
    ],
  })),
}));

import { readNextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";

/** Stubs the two queries the reader makes per week:
 *   - .eq("week_start", X).maybeSingle()            → that week's row
 *   - .lt("week_start", X).order(...).limit(1)      → most recent prior row
 *     (used to seed a synthetic row when the week has none yet) */
function fakeSupabase(rowsByWeekStart: Record<string, unknown>): SupabaseClient {
  return {
    from: () => {
      let eqWeek: string | null = null;
      let ltWeek: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "week_start") eqWeek = val;
          return chain;
        },
        lt: (col: string, val: string) => {
          if (col === "week_start") ltWeek = val;
          return chain;
        },
        order: () => chain,
        limit: () => {
          const priors = Object.keys(rowsByWeekStart)
            .filter((k) => ltWeek != null && k < ltWeek)
            .sort()
            .reverse();
          const first = priors[0];
          return Promise.resolve({
            data: first ? [{ ...(rowsByWeekStart[first] as object), week_start: first }] : [],
            error: null,
          });
        },
        maybeSingle: () =>
          Promise.resolve({ data: eqWeek != null ? rowsByWeekStart[eqWeek] ?? null : null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const LEGS = [
  { name: "Squat (Barbell)", baseKg: 47.5, baseReps: 5, sets: 1, warmup: true },
  { name: "Squat (Barbell)", baseKg: 80, baseReps: 7, sets: 3 },
  { name: "Leg Extension (Machine)", baseKg: 40, baseReps: 12, sets: 3 },
];

describe("readNextSessionPrescription", () => {
  it("finds the next matching weekday later in the same week", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": {
          session_plan: { Monday: "Legs", Thursday: "Legs" },
          session_prescriptions: { Thursday: LEGS },
        },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-06");
    expect(out?.weekday).toBe("Thursday");
    expect(out?.source).toBe("row");
  });

  it("crosses into next week when the current week has no later match", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Legs" }, session_prescriptions: { Monday: LEGS } },
        "2026-08-10": { session_plan: { Monday: "Legs" }, session_prescriptions: { Monday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-10");
    expect(out?.source).toBe("row");
  });

  it("filters warmup entries out of exercises", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": {
          session_plan: { Monday: "Legs", Thursday: "Legs" },
          session_prescriptions: { Thursday: LEGS },
        },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.exercises.every((e) => !e.warmup)).toBe(true);
    expect(out?.exercises).toHaveLength(2);
  });

  it("reads short-form session_plan keys via readSessionForDay", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Mon: "Legs", Thu: "Legs" }, session_prescriptions: { Thursday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-06");
  });

  it("returns null when no matching weekday appears within 14 days", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Chest" }, session_prescriptions: {} },
        "2026-08-10": { session_plan: { Monday: "Chest" }, session_prescriptions: {} },
        "2026-08-17": { session_plan: { Monday: "Chest" }, session_prescriptions: {} },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out).toBeNull();
  });

  it("returns null when no week rows exist at all", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({}),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out).toBeNull();
  });

  it("skips the matched day's own workout date (searches strictly after)", async () => {
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Legs", Friday: "Legs" }, session_prescriptions: { Friday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-07");
  });

  it("seeds a synthetic row from the prior week when the next week has none", async () => {
    // Only the current week exists. The next Legs day is Monday 2026-08-10,
    // whose row the Sunday cron has not written yet — the session_plan must
    // carry forward so the weekday is still recognised as a Legs day.
    const out = await readNextSessionPrescription({
      supabase: fakeSupabase({
        "2026-08-03": { session_plan: { Monday: "Legs" }, session_prescriptions: { Monday: LEGS } },
      }),
      userId: "u", sessionType: "Legs", afterIso: "2026-08-03", block: null, todayIso: "2026-08-03",
    });
    expect(out?.date).toBe("2026-08-10");
    // No stored prescription for that week → computed inline by the engine.
    expect(out?.source).toBe("inline");
    expect(out?.exercises.map((e) => e.baseKg)).toEqual([82.5]); // warmup filtered
  });
});
