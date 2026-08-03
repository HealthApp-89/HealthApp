import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readNextSessionPrescription } from "@/lib/coach/session-debrief/next-session-prescription";

/** Stubs the single query the reader makes per week:
 *  from("training_weeks").select(...).eq(...).eq("week_start", X).maybeSingle() */
function fakeSupabase(rowsByWeekStart: Record<string, unknown>): SupabaseClient {
  return {
    from: () => {
      let weekStart = "";
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "week_start") weekStart = val;
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: rowsByWeekStart[weekStart] ?? null, error: null }),
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
});
