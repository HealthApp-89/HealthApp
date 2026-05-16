// lib/coach/proactive/render-card.ts
//
// Pure deterministic templates. One render function per trigger type.
// No Anthropic calls. Headlines ≤60 chars, bodies 1-2 sentences.

import type {
  ProactiveEvent,
  ProactiveNudgeCard,
} from "@/lib/data/types";

/** Strip the "(Barbell)" / "(Dumbbell)" suffix for shorter card headlines. */
function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}

function fmt1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

export function renderCard(event: ProactiveEvent): ProactiveNudgeCard {
  switch (event.trigger_type) {
    case "plateau":
      return renderPlateau(event);
    case "off_pace_weight":
      return renderOffPace(event);
    case "hrv_below_baseline":
      return renderHrv(event);
  }
}

function renderPlateau(event: ProactiveEvent): ProactiveNudgeCard {
  const lift = event.payload.lift as string;
  const e1rm = event.payload.e1rm_kg_now as number | null;
  const weeks = event.payload.plateau_weeks_flat as number;
  const short = shortLift(lift);
  const e1rmTxt = e1rm != null ? `${fmt1(e1rm)} kg` : "current load";

  return {
    schema_version: 1,
    trigger_type: "plateau",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${short} — ${weeks} weeks flat`,
    body_md: `e1RM is stuck at ${e1rmTxt}. The next weekly review will propose a rep-shift or deload — or break it sooner by switching to a heavier triple next session.`,
    deep_link: {
      label: "See full trends →",
      href: "/coach/trends?section=performance",
    },
  };
}

function renderOffPace(event: ProactiveEvent): ProactiveNudgeCard {
  const flavor = event.payload.flavor as "aggressive" | "slow_or_gaining";
  const rate = event.payload.rate_kg_per_wk_4w as number;
  const band = event.payload.target_band as { lower: number; upper: number };

  if (flavor === "aggressive") {
    return {
      schema_version: 1,
      trigger_type: "off_pace_weight",
      trigger_key: event.trigger_key,
      severity: "warn",
      headline: `Weight dropping ${fmt1(Math.abs(rate))} kg/wk`,
      body_md: `Loss rate is below the target band of ${fmt1(band.lower)} to ${fmt1(band.upper)} kg/wk. Aggressive cuts risk LBM and strength loss — consider pulling the deficit back.`,
      deep_link: {
        label: "Check composition →",
        href: "/coach/trends?section=composition",
      },
    };
  }

  // slow_or_gaining
  const sign = rate >= 0 ? "+" : "";
  return {
    schema_version: 1,
    trigger_type: "off_pace_weight",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Weight only ${sign}${fmt1(rate)} kg/wk`,
    body_md: `Loss rate is above the target band of ${fmt1(band.lower)} to ${fmt1(band.upper)} kg/wk. If a cut is the goal, the deficit needs deepening.`,
    deep_link: {
      label: "Check composition →",
      href: "/coach/trends?section=composition",
    },
  };
}

function renderHrv(event: ProactiveEvent): ProactiveNudgeCard {
  const pct = event.payload.vs_baseline_pct_4w as number;
  const pctAbs = Math.abs(pct * 100);

  return {
    schema_version: 1,
    trigger_type: "hrv_below_baseline",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: `HRV ${Math.round(pctAbs)}% below baseline`,
    body_md: `Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates.`,
    deep_link: {
      label: "Check recovery →",
      href: "/coach/trends?section=performance",
    },
  };
}
