// lib/coach/intelligence/__tests__/constraints-live-injuries.test.ts
//
// TDD: live-injury merge into ConstraintPayload (Task 4 — Injury Lifecycle arc).
//
// Fixtures:
//   profileWithShoulder  — profile-declared "shoulder" injury (weeks_since_onset=3)
//   liveHip              — live Injury row (area "hip", onset 2026-06-29, deadlift + squat)
//   liveShoulder         — live Injury row (area "shoulder") that should supersede profile shoulder
//
// todayIso for all cases: 2026-07-13
//   liveHip:     onset 2026-06-29 → 14 days → 2 weeks → acute (<4 wks)
//   liveShoulder: onset 2026-06-15 → 28 days → 4 weeks → chronic (≥4 wks)

import { expect, test } from "vitest";
import { composeConstraints } from "../constraints-summary";
import type { Injury } from "@/lib/data/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const profileWithShoulder = {
  user_id: "test-user",
  athlete_profile_documents: [
    {
      id: "doc-001",
      status: "active",
      current_injuries: [
        {
          area: "shoulder",
          severity: "mild",
          weeks_since_onset: 3,
          exercises_to_avoid: ["OHP", "Weighted Chins", "Heavy Bench Press"],
        },
      ],
      gym_type: "commercial",
      lifestyle_constraints: [],
    },
  ],
};

const liveHip: Injury = {
  id: "inj-hip-001",
  user_id: "test-user",
  area: "hip",
  side: "left",
  cause: "overuse",
  severity: "moderate",
  onset_date: "2026-06-29",
  status: "active",
  resolved_at: null,
  affected_session_types: ["Legs"],
  affected_lifts: ["deadlift", "squat"],
  notes: null,
  created_at: "2026-06-29T10:00:00Z",
  updated_at: "2026-06-29T10:00:00Z",
};

const liveShoulder: Injury = {
  id: "inj-shoulder-live-001",
  user_id: "test-user",
  area: "shoulder",
  side: null,
  cause: "impingement",
  severity: "moderate",
  onset_date: "2026-06-15",
  status: "active",
  resolved_at: null,
  affected_session_types: ["Chest"],
  affected_lifts: ["bench", "ohp"],
  notes: null,
  created_at: "2026-06-15T10:00:00Z",
  updated_at: "2026-06-15T10:00:00Z",
};

const TODAY = "2026-07-13";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("live hip injury is included alongside profile shoulder injury", () => {
  const result = composeConstraints(profileWithShoulder, [liveHip], TODAY);

  const areas = result.active_injuries.map((i) => i.area);
  expect(areas).toContain("hip (left)");
  expect(areas).toContain("shoulder");
  expect(result.active_injuries).toHaveLength(2);
});

test("live hip injury onset 2026-06-29 is acute on 2026-07-13 (2 weeks)", () => {
  const result = composeConstraints(profileWithShoulder, [liveHip], TODAY);

  const hip = result.active_injuries.find((i) => i.area === "hip (left)");
  expect(hip).toBeDefined();
  expect(hip!.status).toBe("acute");
  expect(hip!.weeks_ago_onset).toBe(2);
});

test("live hip affected_lifts expand exercise_exclusions", () => {
  const result = composeConstraints(profileWithShoulder, [liveHip], TODAY);

  // deadlift → "Deadlift (Barbell)", squat → "Squat (Barbell)"
  expect(result.exercise_exclusions).toContain("Deadlift (Barbell)");
  expect(result.exercise_exclusions).toContain("Squat (Barbell)");
});

test("live shoulder row supersedes profile shoulder item (dedup by lowercase area)", () => {
  const result = composeConstraints(profileWithShoulder, [liveShoulder], TODAY);

  // Only one shoulder entry — the live row wins
  const shoulderEntries = result.active_injuries.filter(
    (i) => i.area.toLowerCase().startsWith("shoulder"),
  );
  expect(shoulderEntries).toHaveLength(1);
  // live shoulder onset 2026-06-15 → 28 days = 4 weeks → chronic (≥4)
  expect(shoulderEntries[0]!.status).toBe("chronic");
  expect(shoulderEntries[0]!.weeks_ago_onset).toBe(4);
});

test("live shoulder supersede also adds its affected_lifts to exclusions", () => {
  const result = composeConstraints(profileWithShoulder, [liveShoulder], TODAY);

  // bench → "Decline Bench Press (Barbell)" (first entry), ohp → "Overhead Press (Barbell)"
  expect(result.exercise_exclusions).toContain("Overhead Press (Barbell)");
  // Profile OHP and Weighted Chins and Heavy Bench Press are dropped because live row supersedes
  // but live's exclusions via affected_lifts should be present
  expect(result.exercise_exclusions).toContain("Decline Bench Press (Barbell)");
});

test("empty liveInjuries returns same result as before (backward compat)", () => {
  const result = composeConstraints(profileWithShoulder, [], TODAY);

  // Profile shoulder still there
  expect(result.active_injuries).toHaveLength(1);
  expect(result.active_injuries[0]!.area).toBe("shoulder");
  // Profile exercises_to_avoid still populated
  expect(result.exercise_exclusions).toContain("OHP");
});

test("no profile, only live injuries works correctly", () => {
  const result = composeConstraints(null, [liveHip], TODAY);

  expect(result.active_injuries).toHaveLength(1);
  expect(result.active_injuries[0]!.area).toBe("hip (left)");
  expect(result.active_injuries[0]!.status).toBe("acute");
  expect(result.exercise_exclusions).toContain("Deadlift (Barbell)");
  expect(result.exercise_exclusions).toContain("Squat (Barbell)");
});
