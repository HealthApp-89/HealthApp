import { describe, it, expect } from "vitest";
import { selectReactiveRung } from "../reactive-ladder";

// ─── helpers ────────────────────────────────────────────────────────────────
const legs = ["legs"] as const;
const upper = ["chest", "shoulders"] as const;
const noActivity = [] as const;

// ─── baseline: no signals at all → none ─────────────────────────────────────
describe("no soreness + no recent activity → none", () => {
  it("returns none when everything is empty/null", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs", "back"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("none");
    expect(result.regions).toEqual([]);
  });

  it("returns none when soreness is in non-overlapping regions", () => {
    const result = selectReactiveRung({
      sessionRegions: ["chest", "arms"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("none");
    expect(result.regions).toEqual([]);
  });

  it("returns none when recent activity is outside recovery window", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "hard", withinRecoveryWindow: false },
      ],
    });
    expect(result.rung).toBe("none");
  });

  it("returns none when recent activity regions don't overlap session", () => {
    const result = selectReactiveRung({
      sessionRegions: ["chest", "arms"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "hard", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("none");
  });
});

// ─── load_down: mild soreness overlapping session ────────────────────────────
describe("mild soreness overlapping session → load_down", () => {
  it("mild soreness on session region with no other signals → load_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("load_down");
    expect(result.regions).toContain("legs");
    expect(result.rationale).toBeTruthy();
  });

  it("mild soreness + light recent activity in-window on overlapping region → load_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "light", withinRecoveryWindow: true },
      ],
    });
    // mild severity × light intensity stays at load_down (low rung)
    expect(result.rung).toBe("load_down");
  });

  it("mild soreness no fatigue → load_down not volume_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["shoulders", "chest"],
      soreRegions: ["shoulders"],
      soreSeverity: "mild",
      fatigue: "none",
      recentActivity: [],
    });
    expect(result.rung).toBe("load_down");
  });
});

// ─── volume_down: moderate signals ───────────────────────────────────────────
describe("moderate signals → volume_down", () => {
  it("mild soreness + some fatigue + overlap → volume_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: "some",
      recentActivity: [],
    });
    expect(result.rung).toBe("volume_down");
  });

  it("moderate recent activity in-window on overlapping region → volume_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "moderate", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("volume_down");
  });

  it("mild soreness + moderate recent activity in-window → volume_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "moderate", withinRecoveryWindow: true },
      ],
    });
    // moderate activity elevates mild soreness to volume_down
    expect(result.rung).toBe("volume_down");
  });
});

// ─── swap_exercise: high signals, non-primary region ─────────────────────────
describe("high signals on non-primary region → swap_exercise", () => {
  it("sharp soreness on non-primary overlapping region → swap_exercise", () => {
    // Session is legs + lower_back; lower_back is non-primary
    const result = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: ["lower_back"],
      soreSeverity: "sharp",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("swap_exercise");
    expect(result.regions).toContain("lower_back");
  });

  it("hard recent activity in-window on partially overlapping regions → swap_exercise", () => {
    // Session is legs + core; activity was padel (legs + lower_back + shoulders)
    // Only legs overlaps → partial, not full session → swap_exercise not swap_day
    const result = selectReactiveRung({
      sessionRegions: ["legs", "core"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [
        { regions: ["legs", "lower_back", "shoulders"], intensity: "hard", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("swap_exercise");
  });

  it("sharp soreness + some fatigue on secondary region → swap_exercise", () => {
    const result = selectReactiveRung({
      sessionRegions: ["back", "arms"],
      soreRegions: ["arms"],
      soreSeverity: "sharp",
      fatigue: "some",
      recentActivity: [],
    });
    expect(result.rung).toBe("swap_exercise");
    expect(result.regions).toContain("arms");
  });
});

// ─── swap_day: severe signals ─────────────────────────────────────────────────
describe("severe signals → swap_day", () => {
  it("sharp soreness on primary session region → swap_day", () => {
    // Primary region = first element of sessionRegions
    const result = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: ["legs"],
      soreSeverity: "sharp",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("swap_day");
  });

  it("sharp soreness with heavy fatigue on any overlapping region → swap_day", () => {
    const result = selectReactiveRung({
      sessionRegions: ["chest", "shoulders", "arms"],
      soreRegions: ["shoulders"],
      soreSeverity: "sharp",
      fatigue: "heavy",
      recentActivity: [],
    });
    expect(result.rung).toBe("swap_day");
  });

  it("hard activity in-window heavily overlapping session → swap_day", () => {
    // session = legs + lower_back (2 regions); activity = legs + lower_back (both overlap)
    const result = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [
        { regions: ["legs", "lower_back", "core"], intensity: "hard", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("swap_day");
  });

  it("hard activity + sharp soreness → swap_day (highest rung)", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "sharp",
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "hard", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("swap_day");
  });
});

// ─── severity×intensity scaling ──────────────────────────────────────────────
describe("severity×intensity combination scaling", () => {
  it("light activity + mild soreness = load_down (stays low)", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "light", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("load_down");
  });

  it("hard match + sharp → swap_day (highest rung)", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "sharp",
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "hard", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("swap_day");
  });

  it("moderate activity + no soreness = volume_down", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: [],
      soreSeverity: null,
      fatigue: null,
      recentActivity: [
        { regions: ["legs"], intensity: "moderate", withinRecoveryWindow: true },
      ],
    });
    expect(result.rung).toBe("volume_down");
  });
});

// ─── rationale is always populated when rung ≠ none ────────────────────────
describe("rationale populated for non-none rungs", () => {
  const cases: Array<{ label: string; rung: string }> = [
    { label: "load_down", rung: "load_down" },
    { label: "volume_down", rung: "volume_down" },
    { label: "swap_exercise", rung: "swap_exercise" },
    { label: "swap_day", rung: "swap_day" },
  ];

  it("load_down has rationale", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("load_down");
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("volume_down has rationale", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "mild",
      fatigue: "some",
      recentActivity: [],
    });
    expect(result.rung).toBe("volume_down");
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("swap_exercise has rationale", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs", "lower_back"],
      soreRegions: ["lower_back"],
      soreSeverity: "sharp",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("swap_exercise");
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("swap_day has rationale", () => {
    const result = selectReactiveRung({
      sessionRegions: ["legs"],
      soreRegions: ["legs"],
      soreSeverity: "sharp",
      fatigue: null,
      recentActivity: [],
    });
    expect(result.rung).toBe("swap_day");
    expect(result.rationale.length).toBeGreaterThan(0);
  });
});
