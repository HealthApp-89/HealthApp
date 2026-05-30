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
  Speaker,
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
    case "plateau":              return renderPlateau(event, ctx);
    case "off_pace_weight":      return renderOffPace(event, ctx);
    case "hrv_below_baseline":   return renderHrv(event, ctx);
    case "recomp_success":       return renderRecompSuccess(event, ctx);
    case "recomp_drift":         return renderRecompDrift(event, ctx);
    case "protein_under":        return renderProteinUnder(event, ctx);
    case "glp1_protein_floor":   return renderGlp1ProteinFloor(event, ctx);
    case "monotone_protein":     return renderMonotoneProtein(event, ctx);
    case "fried_heavy":          return renderFriedHeavy(event, ctx);
    case "training_day_undereat":return renderTrainingUndereat(event, ctx);
    // Remi recovery triggers — render templates added in Task 15.
    case "hrv_chronic_depression":     return renderHrvChronic(event, ctx);
    case "rhr_elevated":               return renderRhrElevated(event, ctx);
    case "sleep_debt_accumulated":     return renderSleepDebt(event, ctx);
    case "low_recovery_streak":        return renderLowRecoveryStreak(event, ctx);
    case "strain_recovery_imbalance":  return renderStrainRecovery(event, ctx);
    case "skin_temp_elevated":         return renderSkinTemp(event, ctx);
    case "recurring_soreness_area":    return renderRecurringSoreness(event, ctx);
    case "sickness_lingering":         return renderSicknessLingering(event, ctx);
    case "deep_sleep_deficit":         return renderDeepSleepDeficit(event, ctx);
    case "bedtime_drift":              return renderBedtimeDrift(event, ctx);
    case "respiratory_rate_elevated":  return renderRespiratoryRate(event, ctx);
    case "heavy_fatigue_cluster":      return renderHeavyFatigue(event, ctx);
    case "post_strain_undersleep":     return renderPostStrainUndersleep(event, ctx);
    case "endurance_volume_recovery_mismatch": return renderEnduranceVolumeMismatch(event, ctx);
    default: throw new Error(`renderCard: unhandled trigger_type '${(event as ProactiveEvent).trigger_type}'`);
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
      href: "/coach/progress?section=performance",
    },
    speaker: "carter",
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
        href: "/coach/progress?section=composition",
      },
      speaker: "nora",
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
      href: "/coach/progress?section=composition",
    },
    speaker: "nora",
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
      href: "/coach/progress?section=performance",
    },
    speaker: "remi",
  };
}

function renderRecompSuccess(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const lbm = event.payload.lbm_delta_4w_kg as number;
  const bf  = event.payload.bf_delta_4w_pts as number;
  const variants = [
    `LBM up ${fmt1(lbm)} kg, body fat down ${fmt1(Math.abs(bf))} pts over 4 weeks. Keep the lever where it is.`,
    `Composition is moving the right way — +${fmt1(lbm)} kg lean, −${fmt1(Math.abs(bf))} pts fat in 4w. Whatever you changed, keep it.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: "recomp_success", today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1,
    trigger_type: "recomp_success",
    trigger_key: "recomp_success",
    severity: "ok",
    headline: "Recomp working — keep this",
    body_md: variants[idx],
    deep_link: { label: "View Body trends", href: "/coach?section=body" },
    speaker: "nora",
  };
}

function renderRecompDrift(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const bf = event.payload.bf_delta_4w_pts as number;
  const variants = [
    `Scale is roughly flat over 4 weeks, but body fat ticked up ${fmt1(bf)} pts. Deficit isn't deep enough at maintenance protein.`,
    `4-week weight is flat — but BF% climbed ${fmt1(bf)} pts. The scale lies; the tape doesn't.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: "recomp_drift", today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1,
    trigger_type: "recomp_drift",
    trigger_key: "recomp_drift",
    severity: "warn",
    headline: "Recomp drifting wrong way",
    body_md: variants[idx],
    deep_link: { label: "View Body trends", href: "/coach?section=body" },
    speaker: "nora",
  };
}

function renderProteinUnder(event: ProactiveEvent, _ctx?: RenderContext): ProactiveNudgeCard {
  const hit = event.payload.hit as number;
  const logged = event.payload.logged as number;
  const target = event.payload.target_g as number;
  return {
    schema_version: 1,
    trigger_type: "protein_under",
    trigger_key: "protein_under",
    severity: "warn",
    headline: "Protein under target too often",
    body_md: `You hit your ${target}g target on ${hit} of the last ${logged} logged days. Two days of front-loading breakfast usually closes the gap.`,
    deep_link: { label: "View Nutrition trends", href: "/coach?section=nutrition" },
    speaker: "nora",
  };
}

function renderGlp1ProteinFloor(event: ProactiveEvent, _ctx?: RenderContext): ProactiveNudgeCard {
  const misses = event.payload.misses as number;
  const observed = event.payload.observed as number;
  const floor = event.payload.floor_g as number;
  return {
    schema_version: 1,
    trigger_type: "glp1_protein_floor",
    trigger_key: "glp1_protein_floor",
    severity: "warn",
    headline: "Protein floor missed on your protocol",
    body_md: `On your current protocol the floor is ${Math.round(floor)} g — you came in under that on ${misses} of the last ${observed} logged days. LBM protection drops fast below floor.`,
    deep_link: { label: "View Nutrition trends", href: "/coach?section=nutrition" },
    speaker: "nora",
  };
}

function renderMonotoneProtein(event: ProactiveEvent, _ctx?: RenderContext): ProactiveNudgeCard {
  const cat = event.payload.dominant_category as string;
  const pct = event.payload.dominant_pct as number;
  const labelMap: Record<string, string> = {
    poultry: "poultry", red_meat: "red meat", fish_seafood: "fish",
    eggs: "eggs", dairy_protein: "dairy", plant_protein: "plant protein",
    protein_supplement: "protein supplement",
  };
  const human = labelMap[cat] ?? cat;
  return {
    schema_version: 1,
    trigger_type: "monotone_protein",
    trigger_key: "monotone_protein",
    severity: "info",
    headline: "Protein has gone monotone",
    body_md: `${human} is ${Math.round(pct * 100)}% of your protein over the last 2 weeks. Cycling in fish (omega-3) and red meat (iron) covers gaps a single source can't.`,
    deep_link: { label: "View Nutrition trends", href: "/coach?section=nutrition" },
    speaker: "nora",
  };
}

function renderFriedHeavy(event: ProactiveEvent, _ctx?: RenderContext): ProactiveNudgeCard {
  const pct = event.payload.fried_pct as number;
  return {
    schema_version: 1,
    trigger_type: "fried_heavy",
    trigger_key: "fried_heavy",
    severity: "info",
    headline: "Frying-heavy mix lately",
    body_md: `${Math.round(pct * 100)}% of items with a known cooking method were pan-fried or deep-fried over the last 2 weeks. Swapping the top 2-3 to grilled or air-fried trims hidden fat kcal at the same macros.`,
    deep_link: { label: "View Nutrition trends", href: "/coach?section=nutrition" },
    speaker: "nora",
  };
}

function renderTrainingUndereat(event: ProactiveEvent, _ctx?: RenderContext): ProactiveNudgeCard {
  const under = event.payload.undereat_count as number;
  const total = event.payload.lift_days_observed as number;
  return {
    schema_version: 1,
    trigger_type: "training_day_undereat",
    trigger_key: "training_day_undereat",
    severity: "warn",
    headline: "Undereating on lift days",
    body_md: `On ${under} of the last ${total} lift days you came in 300+ kcal under target. That's why dinner ends up protein-heavy — a 200 kcal pre-lift snack fixes most of it.`,
    deep_link: { label: "View Nutrition trends", href: "/coach?section=nutrition" },
    speaker: "nora",
  };
}

// ── Remi recovery triggers (Plan 2) ─────────────────────────────────────────

function renderHrvChronic(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const pct = Math.round(Math.abs((event.payload.vs_baseline_pct_7d as number ?? 0) * 100));
  const days = event.payload.days_depressed as number;
  const variants = [
    `Your 7-day HRV average is ${pct}% below baseline, depressed ${days} of the last 7 days. This is a pattern, not a single rough day. Consider cutting intensity 20–30% for the next 5 days, or take a true rest day.`,
    `${pct}% below baseline ${days} of 7 — sustained. The autonomic system isn't bouncing back. Worth a deload conversation with @Peter, or pull back this week's heaviest session.`,
    `HRV has been depressed ${days} of the last 7 days (${pct}% off baseline). Single-day dips are noise; this many in a row is signal. Time to back off.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "hrv_chronic_depression", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `HRV ${pct}% below baseline · ${days} of 7 days`,
    body_md: variants[idx],
    deep_link: { label: "See HRV trend →", href: "/health?tab=trends#hrv-vs-baseline" },
    speaker: "remi",
  };
}

function renderRhrElevated(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const bpm = Math.round(event.payload.vs_baseline_bpm_7d as number);
  const days = event.payload.days_elevated as number;
  const variants = [
    `Resting HR is +${bpm} bpm above your baseline ${days} of the last 7 days. First illness signal — cross-check skin temp; if it's also up, you're likely fighting something. Pull back the next training session.`,
    `RHR has been running +${bpm} bpm for ${days} days. Could be illness brewing, sleep debt, or overreach. Hydrate, sleep early, easy training only until it normalizes.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "rhr_elevated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `RHR +${bpm} bpm · ${days} of 7 days`,
    body_md: variants[idx],
    deep_link: { label: "See RHR trend →", href: "/health?tab=trends#rhr-vs-baseline" },
    speaker: "remi",
  };
}

function renderSleepDebt(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const debt = Math.round((event.payload.debt_hours_7d as number) * 10) / 10;
  const avg = event.payload.avg_hours_7d as number | null;
  const avgStr = avg != null ? `${(Math.round(avg * 10) / 10).toFixed(1)}h` : "—";
  const variants = [
    `${debt}h of sleep debt over the last 7 days (avg ${avgStr}/night). This compounds — HRV and recovery scores will follow. Tonight: bed 30 min earlier than your usual.`,
    `7-day sleep debt is ${debt}h. The body doesn't catch up over the weekend like the brain does. Pick one fix tonight: caffeine off by 14:00, no screens after 22:30, or bed by 22:30.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "sleep_debt_accumulated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${debt}h sleep debt · last 7 days`,
    body_md: variants[idx],
    deep_link: { label: "See sleep hours →", href: "/health?tab=trends#sleep-hours" },
    speaker: "remi",
  };
}

function renderLowRecoveryStreak(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const streak = event.payload.streak_days as number;
  const avg = Math.round(event.payload.avg_recovery_pct as number);
  const variants = [
    `Recovery has been in the red (${avg}% avg) for ${streak} consecutive days. This is grind territory. Talk to @Peter about deloading the rest of this week — pushing further compounds rather than adapts.`,
    `${streak} days in a row under 34% recovery (avg ${avg}%). The body is asking for a break. Z2 only or full rest day until recovery breaks 50% again.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "low_recovery_streak", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${streak} consecutive red recovery days`,
    body_md: variants[idx],
    deep_link: { label: "See recovery distribution →", href: "/health?tab=trends#recovery-distribution" },
    speaker: "remi",
  };
}

function renderStrainRecovery(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const strain = (Math.round((event.payload.strain_avg_7d as number) * 10) / 10).toFixed(1);
  const recovery = Math.round(event.payload.recovery_avg_7d as number);
  const variants = [
    `7-day strain avg ${strain} with recovery sitting at ${recovery}%. This is the overreach setup — load up, body down. One of two things needs to change this week: less strain, or more recovery (sleep, food, true rest day).`,
    `Strain × recovery balance is off — averaging ${strain} strain into ${recovery}% recovery. If this continues, expect HRV depression next week. Easier sessions or a rest day buys you next week's quality.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "strain_recovery_imbalance", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Strain × recovery imbalance · overreach risk`,
    body_md: variants[idx],
    deep_link: { label: "See balance chart →", href: "/health?tab=trends#strain-recovery" },
    speaker: "remi",
  };
}

function renderSkinTemp(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const delta = (Math.round((event.payload.delta_c_avg as number) * 10) / 10).toFixed(1);
  const days = event.payload.days_elevated as number;
  const variants = [
    `Skin temp +${delta}°C above baseline for ${days} consecutive days. Pre-symptomatic illness signal — your body is fighting something before you feel it. Take a rest day or Z2 substitute today.`,
    `${days} days of skin temp running +${delta}°C. Could be illness brewing, hot training environment, or cycle phase. If RHR is also up, it's likely the first. Cross-check with the RHR card.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "skin_temp_elevated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Skin temp +${delta}°C · ${days} days running`,
    body_md: variants[idx],
    deep_link: { label: "See skin temp →", href: "/health?tab=trends#skin-temp" },
    speaker: "remi",
  };
}

function renderRecurringSoreness(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const area = event.payload.area as string;
  const occ = event.payload.occurrences as number;
  const variants = [
    `${area} flagged sore on ${occ} of the last 14 checkins. That's overuse, not normal DOMS. Worth flagging @Carter — pattern swap or volume cut on the movements that hit this region.`,
    `${occ} soreness flags on ${area} in 14 days. If it's the same exercise stack each week, this is the body asking for rotation. Talk to @Carter about substituting the heaviest ${area}-dominant lift.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "recurring_soreness_area", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Recurring ${area} soreness · ${occ}/14 days`,
    body_md: variants[idx],
    deep_link: { label: "See soreness heat-map →", href: "/health?tab=trends#soreness-heatmap" },
    speaker: "remi",
  };
}

function renderSicknessLingering(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const streak = event.payload.streak_days as number;
  const notes = (event.payload.latest_notes as string | null) ?? "no specific notes";
  const variants = [
    `Sick ${streak} days running ("${notes}"). At this length consider a doctor visit, especially if fever or fatigue is dominant. Don't try to train through fever — it's the immune system asking for resources.`,
    `${streak} consecutive sickness days. Most acute illness resolves in 1-3 days; ${streak}+ is worth a clinician's eyes. Rest, fluids, no training, and book a visit if symptoms haven't peaked yet.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "sickness_lingering", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Sick ${streak} days — consider a doctor`,
    body_md: variants[idx],
    deep_link: { label: "See sickness timeline →", href: "/health?tab=trends#fatigue-sickness" },
    speaker: "remi",
  };
}

function renderDeepSleepDeficit(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const h = (Math.round((event.payload.avg_deep_h_14d as number) * 10) / 10).toFixed(1);
  const pct = event.payload.avg_pct_14d as number | null;
  const pctStr = pct != null ? `${Math.round(pct * 100)}%` : "—";
  const variants = [
    `Deep sleep averaging ${h}h (${pctStr} of total) over the last 14 days. Common culprits: late food, alcohol on training days, late training (<3h pre-bed). Pick one to remove this week.`,
    `${h}h deep sleep avg — under floor. Deep sleep is where physical recovery happens. Cool room (16–19°C), no food in the 3h before bed, no alcohol on training days.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "deep_sleep_deficit", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Deep sleep deficit · 14d avg ${h}h`,
    body_md: variants[idx],
    deep_link: { label: "See sleep architecture →", href: "/health?tab=trends#sleep-architecture" },
    speaker: "remi",
  };
}

function renderBedtimeDrift(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const sd = Math.round(event.payload.sd_minutes_14d as number);
  const mean = event.payload.mean_bedtime_hhmm as string | null;
  const meanStr = mean ?? "—";
  const variants = [
    `Bedtime varied by ${sd} min (SD) over the last 14 days, averaging ${meanStr}. Consistency matters more than total hours — pick a 30-min target window around ${meanStr} and hold it for a week, then reassess.`,
    `Bedtime SD is ${sd} min — that's the lever. Hours might be 8 but with bedtime swinging by ${sd} min nightly, HRV will reflect the inconsistency. Lock a window: ${meanStr} ±15 min.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "bedtime_drift", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Bedtime drift · SD ${sd} min over 14d`,
    body_md: variants[idx],
    deep_link: { label: "See bedtime consistency →", href: "/health?tab=trends#bedtime-consistency" },
    speaker: "remi",
  };
}

function renderRespiratoryRate(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const delta = (Math.round((event.payload.delta_bpm_avg as number) * 10) / 10).toFixed(1);
  const days = event.payload.days_elevated as number;
  const variants = [
    `Respiratory rate +${delta} bpm above baseline for ${days} days. Often the earliest infection signal — appears before skin temp or symptoms. Easy training today; watch for skin temp confirming.`,
    `RR up ${delta} bpm for ${days} days. The autonomic nervous system runs RR on autopilot, so changes are involuntary signals. If skin temp also rises, you're fighting something.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "respiratory_rate_elevated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Respiratory rate +${delta} · ${days} days`,
    body_md: variants[idx],
    deep_link: { label: "See respiratory rate →", href: "/health?tab=trends#respiratory-rate" },
    speaker: "remi",
  };
}

function renderHeavyFatigue(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const count = event.payload.heavy_days_count as number;
  const variants = [
    `"Heavy" fatigue reported on ${count} of the last 7 mornings. Even if HRV looks fine, this is the body talking. Trust the subjective — back off intensity until it lifts.`,
    `${count} heavy-fatigue mornings in 7 days. Life stress, hidden sleep quality issues, or undereating can drive this independently of HRV. Worth a 1-day full rest to reset.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "heavy_fatigue_cluster", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${count} heavy fatigue days in 7`,
    body_md: variants[idx],
    deep_link: { label: "See fatigue timeline →", href: "/health?tab=trends#fatigue-sickness" },
    speaker: "remi",
  };
}

function renderEnduranceVolumeMismatch(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const ratio = event.payload.ratio_7d_vs_avg as number;
  const z = event.payload.hrv_z as number;
  const pctOfAvg = Math.round(ratio * 100);
  const zMagnitude = Math.abs(z).toFixed(1);
  const variants = [
    `Endurance load this week is ${pctOfAvg}% of your 4-week average while HRV sits ${zMagnitude} SD below baseline. Consider an easy day or two before the next hard session.`,
    `7-day endurance volume is ${pctOfAvg}% of the rolling average and HRV is ${zMagnitude} SD under baseline. The body is asking for recovery — easy Z2 only, or a true rest day.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1,
    trigger_type: "endurance_volume_recovery_mismatch",
    trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Endurance load ${pctOfAvg}% of avg · HRV ${zMagnitude} SD low`,
    body_md: variants[idx],
    deep_link: { label: "See endurance trend →", href: "/coach?section=endurance" },
    speaker: "remi",
  };
}

function renderPostStrainUndersleep(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const occ = event.payload.occurrences as number;
  const variants = [
    `${occ} times in the last 14 days, you went hard (strain ≥15) and slept <7h after. The night after the hardest sessions is when recovery happens — protect it. Move late-day training earlier or lock a tighter post-training bedtime.`,
    `Pattern: high-strain day → short sleep, ${occ}x in 14 days. The body uses sleep to consolidate the training stimulus. Cutting sleep on those nights is the most expensive cost-cut you can make.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "post_strain_undersleep", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Post-strain undersleep · ${occ} in 14d`,
    body_md: variants[idx],
    deep_link: { label: "See sleep hours →", href: "/health?tab=trends#sleep-hours" },
    speaker: "remi",
  };
}
