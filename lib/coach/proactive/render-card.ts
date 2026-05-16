// lib/coach/proactive/render-card.ts
//
// Pure deterministic templates. One render function per trigger type.
// No Anthropic calls. Headlines ≤60 chars, bodies 1-2 sentences.
//
// Each trigger has multiple voice variants — picking one by deterministic
// hash of (userId, trigger_key, ISO week) so the same nudge re-firing
// across weeks rotates phrasing without RNG. Same-week re-fires hit the
// same variant (test-stable, no flicker between cron windows).

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

/** ISO week number — sufficient calendar granularity to rotate voice over
 *  natural re-fire intervals (a trigger that keeps tripping every 8-10 days
 *  hits a different week each time). */
function isoWeek(ymd: string): number {
  const d = new Date(`${ymd}T12:00:00Z`);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const days = Math.floor((d.getTime() - yearStart.getTime()) / 86400000);
  return Math.floor((days + yearStart.getUTCDay()) / 7);
}

/** Stable variant index — same inputs always yield the same index so cron
 *  retries (same day, same trigger) don't oscillate. */
function pickVariant(args: {
  userId: string;
  triggerKey: string;
  today: string;
  count: number;
}): number {
  const seed = `${args.userId}.${args.triggerKey}.${isoWeek(args.today)}`;
  // FNV-1a 32-bit, sufficient for low-cardinality bucketing.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % args.count;
}

export type RenderContext = {
  userId: string;
  today: string;
};

export function renderCard(
  event: ProactiveEvent,
  ctx?: RenderContext,
): ProactiveNudgeCard {
  switch (event.trigger_type) {
    case "plateau":
      return renderPlateau(event, ctx);
    case "off_pace_weight":
      return renderOffPace(event, ctx);
    case "hrv_below_baseline":
      return renderHrv(event, ctx);
  }
}

function renderPlateau(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const lift = event.payload.lift as string;
  const e1rm = event.payload.e1rm_kg_now as number | null;
  const weeks = event.payload.plateau_weeks_flat as number;
  const short = shortLift(lift);
  const e1rmTxt = e1rm != null ? `${fmt1(e1rm)} kg` : "current load";

  const variants = [
    {
      headline: `${short} — ${weeks} weeks flat`,
      body_md: `e1RM is stuck at ${e1rmTxt}. The next weekly review will propose a rep-shift or deload — or break it sooner by switching to a heavier triple next session.`,
    },
    {
      headline: `${short} hasn't moved in ${weeks} weeks`,
      body_md: `Sitting at ${e1rmTxt}. Worth a rep-range change (drop to 3s, push the heaviest single you can hold for that long) or a short deload before next block.`,
    },
    {
      headline: `Plateau on ${short} (${weeks} wk)`,
      body_md: `${e1rmTxt} for ${weeks} weeks running. Two paths: heavier triples next session to break it, or absorb it into the weekly review and let the prescription adjust.`,
    },
  ];
  const idx = ctx
    ? pickVariant({ userId: ctx.userId, triggerKey: event.trigger_key, today: ctx.today, count: variants.length })
    : 0;
  const v = variants[idx];

  return {
    schema_version: 1,
    trigger_type: "plateau",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: v.headline,
    body_md: v.body_md,
    deep_link: {
      label: "See full trends →",
      href: "/coach/trends?section=performance",
    },
  };
}

function renderOffPace(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const flavor = event.payload.flavor as "aggressive" | "slow_or_gaining";
  const rate = event.payload.rate_kg_per_wk_4w as number;
  const band = event.payload.target_band as { lower: number; upper: number };

  if (flavor === "aggressive") {
    const variants = [
      {
        headline: `Weight dropping ${fmt1(Math.abs(rate))} kg/wk`,
        body_md: `Loss rate is below the target band of ${fmt1(band.lower)} to ${fmt1(band.upper)} kg/wk. Aggressive cuts risk LBM and strength loss — consider pulling the deficit back.`,
      },
      {
        headline: `Cut running hot (${fmt1(Math.abs(rate))} kg/wk)`,
        body_md: `Your 4-week rate is below ${fmt1(band.lower)} kg/wk. Cuts this steep tend to bleed LBM; easing the deficit by ~200 kcal would put pace back in the band.`,
      },
    ];
    const idx = ctx
      ? pickVariant({ userId: ctx.userId, triggerKey: event.trigger_key, today: ctx.today, count: variants.length })
      : 0;
    const v = variants[idx];
    return {
      schema_version: 1,
      trigger_type: "off_pace_weight",
      trigger_key: event.trigger_key,
      severity: "warn",
      headline: v.headline,
      body_md: v.body_md,
      deep_link: {
        label: "Check composition →",
        href: "/coach/trends?section=composition",
      },
    };
  }

  // slow_or_gaining
  const sign = rate >= 0 ? "+" : "";
  const variants = [
    {
      headline: `Weight only ${sign}${fmt1(rate)} kg/wk`,
      body_md: `Loss rate is above the target band of ${fmt1(band.lower)} to ${fmt1(band.upper)} kg/wk. If a cut is the goal, the deficit needs deepening.`,
    },
    {
      headline: `Off-pace (${sign}${fmt1(rate)} kg/wk)`,
      body_md: `Rolling 4-week is above ${fmt1(band.upper)} kg/wk. If the goal is still a cut, an audit of the daily intake gap is the next move.`,
    },
  ];
  const idx = ctx
    ? pickVariant({ userId: ctx.userId, triggerKey: event.trigger_key, today: ctx.today, count: variants.length })
    : 0;
  const v = variants[idx];
  return {
    schema_version: 1,
    trigger_type: "off_pace_weight",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: v.headline,
    body_md: v.body_md,
    deep_link: {
      label: "Check composition →",
      href: "/coach/trends?section=composition",
    },
  };
}

function renderHrv(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const pct = event.payload.vs_baseline_pct_4w as number;
  const pctAbs = Math.abs(pct * 100);
  const roundedPct = Math.round(pctAbs);

  const variants = [
    {
      headline: `HRV ${roundedPct}% below baseline`,
      body_md: `Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates.`,
    },
    {
      headline: `HRV trending soft (${roundedPct}% off)`,
      body_md: `4-week HRV average is sitting ${roundedPct}% under your 30-day baseline. Worth checking sleep duration, alcohol, and training intensity for the past two weeks.`,
    },
    {
      headline: `${roundedPct}% drag on HRV`,
      body_md: `HRV has run ${roundedPct}% below baseline across the last 4 weeks. If recovery scores are also down, this is one to address before next week's plan.`,
    },
  ];
  const idx = ctx
    ? pickVariant({ userId: ctx.userId, triggerKey: event.trigger_key, today: ctx.today, count: variants.length })
    : 0;
  const v = variants[idx];

  return {
    schema_version: 1,
    trigger_type: "hrv_below_baseline",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: v.headline,
    body_md: v.body_md,
    deep_link: {
      label: "Check recovery →",
      href: "/coach/trends?section=performance",
    },
  };
}
