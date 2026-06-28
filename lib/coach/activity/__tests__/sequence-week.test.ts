/**
 * Tests for proposeActivityAwareLayout (pure proactive week-sequencing planner).
 *
 * Week under test: 2026-07-06 (Monday) through 2026-07-12 (Sunday).
 * Date map (confirmed calendar — 2026-07-06 is a Monday):
 *   Mon 2026-07-06 | Tue 2026-07-07 | Wed 2026-07-08 | Thu 2026-07-09
 *   Fri 2026-07-10 | Sat 2026-07-11 | Sun 2026-07-12
 *
 * Recovery windows (rounded hours / 24):
 *   padel light    14h → 0.58d  — 1-day gap SAFE  (1 ≥ 0.58)
 *   padel moderate 28h → 1.17d  — 1-day gap CONFLICT; 2-day gap SAFE
 *   padel hard     44h → 1.83d  — 1-day gap CONFLICT; 2-day gap SAFE (2 ≥ 1.83)
 *   cycling hard   22h → 0.92d  — 1-day gap SAFE  (1 ≥ 0.92)
 *
 * Test-plan design principle: activity days are REST in the session plan so that
 * the only conflicts come from sessions on days ADJACENT to the activity day,
 * not from sessions on the same day as the activity. This isolates the bidirectional
 * window detection cleanly.
 *
 * Padel regions: legs, lower_back, shoulders
 * Legs session: legs, lower_back  → overlaps with padel (legs, lower_back)
 * Chest session: chest, shoulders  → overlaps with padel (shoulders)
 * Back session: back, lower_back  → overlaps with padel (lower_back)
 * Arms session: arms, shoulders   → overlaps with padel (shoulders)
 */

import { describe, it, expect } from "vitest";
import {
  proposeActivityAwareLayout,
  SESSION_REGION_MAP,
  type DaysAvailable,
} from "../sequence-week";
import type { SessionPlan, TrainingBlock } from "@/lib/data/types";
import type { PlannedActivity } from "../types";

// ─── Activity helpers ────────────────────────────────────────────────────────

function padelHard(date: string): PlannedActivity {
  return { date, type: "padel", intensity_estimate: "hard", source: "recurring" };
}

function padelLight(date: string): PlannedActivity {
  return { date, type: "padel", intensity_estimate: "light", source: "recurring" };
}

function cyclingHard(date: string): PlannedActivity {
  return { date, type: "cycling", intensity_estimate: "hard", source: "recurring" };
}

// ─── DaysAvailable helpers ───────────────────────────────────────────────────

const ALL_DAYS: DaysAvailable = {
  mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true,
};

// ─── Test Cases ──────────────────────────────────────────────────────────────

describe("proposeActivityAwareLayout", () => {
  // ── Graceful: no activities → reference-equal plan ────────────────────────
  describe("no activities", () => {
    it("returns reference-equal proposedPlan, empty lightenDays, empty flags", () => {
      const plan: SessionPlan = {
        Mon: "Legs", Tue: "Chest", Wed: "Mobility", Thu: "Back", Fri: "Arms",
        Sat: "REST", Sun: "REST",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [],
        daysAvailable: ALL_DAYS,
      });

      // Brief requirement: reference equality when no activities.
      expect(result.proposedPlan).toBe(plan);
      expect(result.lightenDays).toEqual({});
      expect(result.flags).toEqual([]);
    });
  });

  // ── No conflict: activities on non-overlapping days ───────────────────────
  describe("no conflict detected → reference-equal plan", () => {
    it("session plan with no sessions in any activity window returns === proposedPlan", () => {
      // Legs on Mon, padel hard on Thu (dist Mon→Thu=3 ≥ 1.83d → safe).
      // Legs on Mon, padel hard on Fri (dist Mon→Fri=4 → safe).
      const plan: SessionPlan = {
        Mon: "Legs", Tue: "REST", Wed: "REST", Thu: "REST",
        Fri: "REST", Sat: "REST", Sun: "REST",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [padelHard("2026-07-09")], // Thu
        daysAvailable: ALL_DAYS,
      });

      // Mon Legs vs Thu padel: dist=3 ≥ 1.83d → no conflict.
      expect(result.proposedPlan).toBe(plan);
      expect(result.lightenDays).toEqual({});
      expect(result.flags).toHaveLength(0);
    });
  });

  // ── Move resolution ────────────────────────────────────────────────────────
  describe("padel(hard) Tue + Legs Mon, free slot Thu → MOVE Legs to Thu", () => {
    /**
     * padel hard Tue 2026-07-07: window=44h=1.83d.
     * Legs Mon (dist=1 < 1.83) → CONFLICT.
     * Wed (dist=1) also within window → can't go there.
     * Thu (dist=2 ≥ 1.83) → SAFE and free (REST) → valid move target.
     *
     * Plan: Mon=Legs, Tue=REST (padel day), Wed=Chest, Thu=REST, Fri=Back
     * Chest on Wed conflicts with padel's shoulders, but Wed (dist=1) is within
     * window — so Chest stays (it's a lesser conflict) or could be moved too.
     * Focus: Legs MUST move to Thu. Thu is free and outside window.
     *
     * Simplest plan where only Legs conflicts and Thu is a free safe slot:
     *   Mon=Legs, Tue=REST, Wed=REST, Thu=REST, Fri=Back, Sat=REST, Sun=REST
     * Legs Mon dist=1 < 1.83 → conflict. Thu free + dist=2 ≥ 1.83 → move target.
     */
    it("proposedPlan moves Legs to Thu; lightenDays empty; no flags", () => {
      const plan: SessionPlan = {
        Mon: "Legs",
        Tue: "REST",  // padel activity day — no lifting session
        Wed: "REST",  // dist=1 from Tue, within window, but REST so nothing to conflict
        Thu: "REST",  // dist=2 from Tue → safe free slot
        Fri: "Back",
        Sat: "REST",
        Sun: "REST",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [padelHard("2026-07-07")], // Tue
        daysAvailable: ALL_DAYS,
      });

      // Legs must be moved off Mon.
      expect(result.proposedPlan["Mon"]).not.toBe("Legs");
      // Legs must land on Thu (nearest free day outside window).
      expect(result.proposedPlan["Thu"]).toBe("Legs");
      // proposedPlan is a new object (not reference-equal to input).
      expect(result.proposedPlan).not.toBe(plan);
      // No lighten needed — we successfully moved.
      expect(result.lightenDays).toEqual({});
      // No flags.
      expect(result.flags).toHaveLength(0);
    });
  });

  // ── Lighten resolution ────────────────────────────────────────────────────
  describe("padel(hard) Tue + Legs Mon, no free non-conflicting slot → LIGHTEN", () => {
    /**
     * padel hard Tue 2026-07-07: window=1.83d.
     * Legs Mon (dist=1 < 1.83) → conflict.
     * Thu is safe (dist=2) but UNAVAILABLE → can't move there.
     * Wed is within window (dist=1) and has a session — can't use.
     * Fri/Sat/Sun unavailable.
     * → No valid move target → LIGHTEN Mon with Legs overlap regions.
     */
    it("proposedPlan has Legs on Mon; lightenDays['Mon'] contains leg regions; no flags", () => {
      const plan: SessionPlan = {
        Mon: "Legs",
        Tue: "REST",  // padel day — no lifting
        Wed: "Chest", // occupied, also within padel window (dist=1 < 1.83, shoulders overlap)
        Thu: "Back",  // occupied — not a free slot for Legs
        Fri: "REST",
        Sat: "REST",
        Sun: "REST",
      };

      // Thu is occupied by Back. Fri/Sat/Sun unavailable. No free + safe + available slot.
      const noFriSatSun: DaysAvailable = {
        mon: true, tue: true, wed: true, thu: true,
        fri: false, sat: false, sun: false,
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [padelHard("2026-07-07")], // Tue
        daysAvailable: noFriSatSun,
      });

      // Legs stays on Mon (no valid move).
      expect(result.proposedPlan["Mon"]).toBe("Legs");
      // lightenDays must flag Mon with the overlapping regions.
      expect(result.lightenDays["Mon"]).toBeDefined();
      expect(result.lightenDays["Mon"]).toContain("legs");
      // No flags (lighten was possible).
      expect(result.flags).toHaveLength(0);
    });
  });

  // ── Flag: unavoidable adjacency (multiple activities conflict same session) ─
  describe("padel(hard) Tue + padel(hard) Sun, Legs Mon, no free day → FLAG", () => {
    /**
     * Two activities both conflict with Legs on Mon:
     *   - padel hard Tue 2026-07-07: dist(Mon,Tue)=1 < 1.83 → conflict
     *   - padel hard Sun 2026-07-12: dist(Mon,Sun) = daysBetween(0,6) = min(6,1) = 1 < 1.83 → conflict
     *
     * No move possible (only Mon/Tue/Wed/Thu available; Wed is within Tue window;
     * Thu is occupied by Arms — not free).
     * Mon gets lightened for first conflict, then second activity escalates to FLAG.
     */
    it("emits at least one flag; the flag references Legs on Mon", () => {
      const plan: SessionPlan = {
        Mon: "Legs",
        Tue: "REST",  // padel Tue day
        Wed: "Chest", // occupied + within Tue window (not suitable move target)
        Thu: "Arms",  // occupied — not free for Legs
        Fri: "REST",
        Sat: "REST",
        Sun: "REST",  // padel Sun day
      };

      const tightDays: DaysAvailable = {
        mon: true, tue: true, wed: true, thu: true,
        fri: false, sat: false, sun: false,
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [
          padelHard("2026-07-07"), // Tue
          padelHard("2026-07-12"), // Sun — 1 day from Mon (min wrap distance)
        ],
        daysAvailable: tightDays,
      });

      expect(result.flags.length).toBeGreaterThan(0);
      const legsMonFlag = result.flags.find(
        (f) => f.sessionDay === "Mon" && f.sessionType === "Legs",
      );
      expect(legsMonFlag).toBeDefined();
    });
  });

  // ── Magnitude gate: padel(light) → NO action ──────────────────────────────
  describe("padel(light) Tue + Legs Mon → window too short, no conflict", () => {
    /**
     * padel light: window=14h=0.58d.
     * Legs Mon (dist=1 ≥ 0.58) → SAFE — no conflict.
     * proposedPlan === sessionPlan (reference equal), empty lightenDays + flags.
     */
    it("proposedPlan is reference-equal to input; no lighten; no flags", () => {
      const plan: SessionPlan = {
        Mon: "Legs",
        Tue: "REST",  // padel activity day
        Wed: "Chest",
        Thu: "Back",
        Fri: "Arms",
        Sat: "REST",
        Sun: "REST",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [padelLight("2026-07-07")], // Tue
        daysAvailable: ALL_DAYS,
      });

      expect(result.proposedPlan).toBe(plan);
      expect(result.lightenDays).toEqual({});
      expect(result.flags).toHaveLength(0);
    });
  });

  // ── Damage factor gate: cycling(hard) Tue + Legs Wed → no conflict ─────────
  describe("cycling(hard) Tue + Legs Wed → low damage factor, 1-day gap outside window", () => {
    /**
     * cycling hard: damage factor=0.5 → window=22h=0.92d.
     * Legs Wed (dist from Tue=1 ≥ 0.92) → SAFE — no conflict.
     * proposedPlan === sessionPlan, empty lightenDays + flags.
     */
    it("no conflict — proposedPlan is reference-equal to input", () => {
      const plan: SessionPlan = {
        Mon: "Chest",
        Tue: "REST",  // cycling activity day
        Wed: "Legs",  // dist=1 from Tue; cycling window=0.92d → 1 ≥ 0.92 → SAFE
        Thu: "Back",
        Fri: "Arms",
        Sat: "REST",
        Sun: "REST",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [cyclingHard("2026-07-07")], // Tue
        daysAvailable: ALL_DAYS,
      });

      expect(result.proposedPlan).toBe(plan);
      expect(result.lightenDays).toEqual({});
      expect(result.flags).toHaveLength(0);
    });
  });

  // ── Priority leg-block + padel(hard) + no escape → flag ─────────────────
  describe("priority leg-block (squat) + padel(hard) Tue + Legs Mon + padel(hard) Sun → flag", () => {
    /**
     * Block primary_lift = "squat" → Legs session is priority.
     * Two activities constrain Mon from both sides (Tue + Sun).
     * No move possible (tight days). Must escalate to FLAG.
     */
    it("emits a flag for the priority Legs session", () => {
      const squatBlock: TrainingBlock = {
        id: "block-1",
        user_id: "user-1",
        status: "active",
        start_date: "2026-07-06",
        end_date: "2026-08-10",
        goal_text: "Increase squat to 80 kg",
        primary_lift: "squat",
        target_metric: "working_weight",
        target_value: 80,
        target_hit_at_week: null,
        target_unit: "kg",
        diet_goal: null,
        endurance_focus: null,
        created_at: "2026-07-06T00:00:00Z",
        completed_at: null,
        updated_at: "2026-07-06T00:00:00Z",
      };

      const plan: SessionPlan = {
        Mon: "Legs",
        Tue: "REST",
        Wed: "Chest",
        Thu: "Arms",
        Fri: "REST",
        Sat: "REST",
        Sun: "REST",
      };

      const tightDays: DaysAvailable = {
        mon: true, tue: true, wed: true, thu: true,
        fri: false, sat: false, sun: false,
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: plan,
        plannedActivities: [
          padelHard("2026-07-07"), // Tue — dist(Mon,Tue)=1 < 1.83 → conflict
          padelHard("2026-07-12"), // Sun — dist(Mon,Sun)=1 < 1.83 → conflict
        ],
        daysAvailable: tightDays,
        block: squatBlock,
      });

      expect(result.flags.length).toBeGreaterThan(0);
      const priorityFlag = result.flags.find(
        (f) => f.sessionDay === "Mon" && f.sessionType === "Legs",
      );
      expect(priorityFlag).toBeDefined();
    });
  });

  // ── isPriority divergence: priority → FLAG; non-priority → LIGHTEN ────────
  //
  // These two tests are intentionally symmetric: same plan, same activity, same
  // tight DaysAvailable — the ONLY difference is the `block` argument.
  // Before the isPriority fix, both produced a lightenDays entry (isPriority was
  // computed but never read). After the fix they diverge.
  describe("isPriority divergence (single conflicting activity, no free day)", () => {
    /**
     * Setup:
     *   Plan: Mon=Legs, Tue=REST (padel hard), Wed=Chest, Thu=Arms, Fri-Sun=REST
     *   Activity: padel hard Tue 2026-07-07 → window=1.83d; dist(Mon,Tue)=1 < 1.83 → conflict.
     *   Tight days: only Mon-Thu available. Thu is occupied (Arms), so no free+safe slot.
     *   → MOVE is impossible.
     *
     * With block.primary_lift='squat' → Legs is priority → should FLAG (not lighten).
     * Without block (no primary_lift)  → Legs is non-priority → should LIGHTEN (not flag).
     */
    const tightPlan: SessionPlan = {
      Mon: "Legs",
      Tue: "REST",   // padel activity day — no lifting session
      Wed: "Chest",  // occupied; also within Tue window (dist=1 < 1.83, shoulders → padel shoulders overlap)
      Thu: "Arms",   // occupied — not a free slot for Legs move
      Fri: "REST",
      Sat: "REST",
      Sun: "REST",
    };

    const tightDays: DaysAvailable = {
      mon: true, tue: true, wed: true, thu: true,
      fri: false, sat: false, sun: false,
    };

    const squatBlock: TrainingBlock = {
      id: "block-squat",
      user_id: "user-1",
      status: "active",
      start_date: "2026-07-06",
      end_date: "2026-08-10",
      goal_text: "Increase squat",
      primary_lift: "squat",
      target_metric: "working_weight",
      target_value: 80,
      target_hit_at_week: null,
      target_unit: "kg",
      diet_goal: null,
      endurance_focus: null,
      created_at: "2026-07-06T00:00:00Z",
      completed_at: null,
      updated_at: "2026-07-06T00:00:00Z",
    };

    it("PRIORITY (squat block, Legs=priority): no move possible → FLAG, NOT lightenDays", () => {
      const result = proposeActivityAwareLayout({
        sessionPlan: tightPlan,
        plannedActivities: [padelHard("2026-07-07")], // Tue
        daysAvailable: tightDays,
        block: squatBlock,
      });

      // Must emit a strategic flag for Mon/Legs.
      const priorityFlag = result.flags.find(
        (f) => f.sessionDay === "Mon" && f.sessionType === "Legs",
      );
      expect(priorityFlag).toBeDefined();
      // Flag reason must mention the activity and the session.
      expect(priorityFlag!.reason).toContain("padel");
      expect(priorityFlag!.reason).toContain("Legs");
      // Must NOT silently lighten the key session — that defeats the block purpose.
      expect(result.lightenDays["Mon"]).toBeUndefined();
    });

    it("NON-PRIORITY (no block): no move possible → lightenDays entry, NOT a flag", () => {
      const result = proposeActivityAwareLayout({
        sessionPlan: tightPlan,
        plannedActivities: [padelHard("2026-07-07")], // Tue
        daysAvailable: tightDays,
        // block intentionally omitted — Legs is not a priority session
      });

      // Must emit a lightenDays entry for Mon with the overlapping regions.
      expect(result.lightenDays["Mon"]).toBeDefined();
      expect(result.lightenDays["Mon"]).toContain("legs");
      // Must NOT escalate to a flag (lighten was possible and sufficient).
      const legsMonFlag = result.flags.find(
        (f) => f.sessionDay === "Mon" && f.sessionType === "Legs",
      );
      expect(legsMonFlag).toBeUndefined();
    });
  });

  // ── Determinism ──────────────────────────────────────────────────────────
  describe("determinism", () => {
    it("identical inputs produce identical outputs on repeated calls", () => {
      const plan: SessionPlan = {
        Mon: "Legs",
        Tue: "REST",
        Wed: "REST",
        Thu: "REST",
        Fri: "Back",
        Sat: "REST",
        Sun: "REST",
      };

      const args = {
        sessionPlan: plan,
        plannedActivities: [padelHard("2026-07-07")],
        daysAvailable: ALL_DAYS,
      };

      const r1 = proposeActivityAwareLayout(args);
      const r2 = proposeActivityAwareLayout(args);

      expect(r1.proposedPlan).toEqual(r2.proposedPlan);
      expect(r1.lightenDays).toEqual(r2.lightenDays);
      expect(r1.flags).toEqual(r2.flags);
    });
  });

  // ── SESSION_REGION_MAP sanity ─────────────────────────────────────────────
  describe("SESSION_REGION_MAP", () => {
    it("Legs loads legs + lower_back", () => {
      expect(SESSION_REGION_MAP["Legs"]).toEqual(["legs", "lower_back"]);
    });

    it("Chest loads chest + shoulders", () => {
      expect(SESSION_REGION_MAP["Chest"]).toEqual(["chest", "shoulders"]);
    });

    it("Back loads back + lower_back", () => {
      expect(SESSION_REGION_MAP["Back"]).toEqual(["back", "lower_back"]);
    });

    it("Arms loads arms + shoulders", () => {
      expect(SESSION_REGION_MAP["Arms"]).toEqual(["arms", "shoulders"]);
    });

    it("REST and Mobility load nothing", () => {
      expect(SESSION_REGION_MAP["REST"]).toEqual([]);
      expect(SESSION_REGION_MAP["Mobility"]).toEqual([]);
    });
  });

  // ── LONG-KEY wiring test (regression for the production key-form bug) ──────
  //
  // Production session_plan rows committed by the AI planning bot use FULL
  // weekday names ("Monday", "Tuesday", …). The planner must handle both key
  // forms correctly. This test feeds a long-keyed plan and verifies:
  //   1. Conflicts are detected correctly (padel hard Tue within 1.83d of Legs Mon).
  //   2. The move resolution fires and moves Legs to Thu.
  //   3. The output plan uses the same long-key form as the input.
  //   4. No lightenDays entry and no flags (move fully resolved the conflict).
  //
  // This test MUST fail against the old short-key-only logic and pass after the
  // key-normalization fix. Against the old code:
  //   - weekdayIndex("Monday") → WEEKDAY_SHORT.indexOf("Monday") → -1
  //   - daysBetween(-1, -1) → 0 → dist=0 < window → conflicts fire on EVERY day
  //   - daysAvailable built with sessionPlan["Mon"] → undefined → all-false
  //   - No valid move target (all days unavailable) → LIGHTEN or FLAG, not MOVE
  describe("LONG-KEY plan (production key form) — padel(hard) Tue + Legs Mon → MOVE to Thu", () => {
    /**
     * Plan: { Monday: "Legs", Tuesday: "REST", Wednesday: "REST", Thursday: "REST",
     *         Friday: "Back", Saturday: "REST", Sunday: "REST" }
     *
     * Activity: padel hard on 2026-07-07 (Tuesday).
     * Recovery window: 44h = 1.83d.
     * Legs Monday: dist(Mon,Tue) = 1 < 1.83 → CONFLICT.
     * Thu: dist=2 ≥ 1.83, currently REST → valid move target.
     * Expected: Legs moves to Thursday in the output plan (long-keyed output).
     */
    it("long-keyed plan: detects conflict and moves Legs to Thursday; output plan uses long keys", () => {
      const longKeyPlan: SessionPlan = {
        Monday: "Legs",
        Tuesday: "REST",    // padel activity day
        Wednesday: "REST",  // dist=1 from Tue, within window but REST
        Thursday: "REST",   // dist=2 from Tue → safe free slot
        Friday: "Back",
        Saturday: "REST",
        Sunday: "REST",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: longKeyPlan,
        plannedActivities: [padelHard("2026-07-07")], // Tuesday
        daysAvailable: ALL_DAYS,
      });

      // Legs must NOT remain on Monday (conflict detected and resolved).
      expect(result.proposedPlan["Monday"]).not.toBe("Legs");

      // Legs must land on Thursday (nearest free day outside window).
      expect(result.proposedPlan["Thursday"]).toBe("Legs");

      // The output plan must use long keys (matching the input convention).
      // Verify by checking that a long key ("Thursday") is set and the short
      // key ("Thu") is NOT set in the output.
      expect(result.proposedPlan["Thu"]).toBeUndefined();

      // Move fully resolved the conflict — no lighten, no flags.
      expect(result.lightenDays).toEqual({});
      expect(result.flags).toHaveLength(0);

      // Output plan is NOT reference-equal to input (a mutation occurred).
      expect(result.proposedPlan).not.toBe(longKeyPlan);
    });

    it("long-keyed plan with no activities → reference-equal (graceful path unaffected)", () => {
      const longKeyPlan: SessionPlan = {
        Monday: "Legs",
        Tuesday: "Chest",
        Wednesday: "REST",
        Thursday: "Back",
        Friday: "Arms",
        Saturday: "REST",
        Sunday: "Mobility",
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: longKeyPlan,
        plannedActivities: [],
        daysAvailable: ALL_DAYS,
      });

      // Graceful path fires before normalization — reference equality preserved.
      expect(result.proposedPlan).toBe(longKeyPlan);
      expect(result.lightenDays).toEqual({});
      expect(result.flags).toHaveLength(0);
    });

    it("long-keyed plan: lighten fires on the correct day when no move possible", () => {
      /**
       * Plan: { Monday: "Legs", Tuesday: "REST", Wednesday: "Chest", Thursday: "Back",
       *         Friday: "REST", Saturday: "REST", Sunday: "REST" }
       * Activity: padel hard Tue. Thu is occupied (Back) — no free safe slot.
       * Tight availability: only Mon-Thu. Expect lightenDays["Mon"] to be set.
       *
       * Against old code: daysAvailable was all-false so MOVE was never possible,
       * but conflict detection also misfired (dist=-1 for every long key) → some
       * days got wrongly lightened. This test pins the correct outcome.
       */
      const longKeyTightPlan: SessionPlan = {
        Monday: "Legs",
        Tuesday: "REST",
        Wednesday: "Chest",
        Thursday: "Back",
        Friday: "REST",
        Saturday: "REST",
        Sunday: "REST",
      };

      const tightDays: DaysAvailable = {
        mon: true, tue: true, wed: true, thu: true,
        fri: false, sat: false, sun: false,
      };

      const result = proposeActivityAwareLayout({
        sessionPlan: longKeyTightPlan,
        plannedActivities: [padelHard("2026-07-07")], // Tue
        daysAvailable: tightDays,
      });

      // Legs stays on Monday (no valid move).
      expect(result.proposedPlan["Monday"]).toBe("Legs");

      // lightenDays must flag Mon (short key — lightenDays always uses short keys).
      expect(result.lightenDays["Mon"]).toBeDefined();
      expect(result.lightenDays["Mon"]).toContain("legs");

      // Chest on Wed conflicts (shoulders overlap padel), but Wed already within window;
      // verify it is also addressed (lightened or moved). Main check: Mon is lightened.
      expect(result.flags).toHaveLength(0);
    });
  });
});
