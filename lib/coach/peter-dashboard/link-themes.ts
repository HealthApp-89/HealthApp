// lib/coach/peter-dashboard/link-themes.ts
//
// Deterministic pairwise cluster rules. After composers run, this detects
// theme combinations that likely share a root cause and produces named
// clusters. The narrative wrapper uses these to write "these are the same
// problem" prose instead of treating each theme independently.

import type { ThemePayload, ThemeCluster, ThemeKey } from './types';
import { CLUSTER_ACTIVE_SEVERITIES } from './thresholds';

const ACTIVE = new Set<string>(CLUSTER_ACTIVE_SEVERITIES);

function isActive(t: ThemePayload | undefined): boolean {
  return !!t && ACTIVE.has(t.severity);
}

export function linkThemes(
  themes: Record<ThemeKey, ThemePayload>,
): ThemeCluster[] {
  const clusters: ThemeCluster[] = [];

  const energy    = themes.energy;
  const fatigue   = themes.fatigue;
  const perf      = themes.performance;
  const recomp    = themes.recomp;
  const adh       = themes.plan_adherence;
  const goal      = themes.goal_distance;
  const endurance = themes.endurance;

  // Rule 1: energy + fatigue + performance plateau → deficit-too-aggressive cluster.
  const perfHasPlateau =
    perf && (perf.facts['active_plateau_count'] as number | null) != null &&
    (perf.facts['active_plateau_count'] as number) > 0;
  if (isActive(energy) && isActive(fatigue) && perfHasPlateau) {
    clusters.push({
      id: 'energy-fatigue-perf',
      themes: ['energy', 'fatigue', 'performance'],
      root_hypothesis:
        'deficit too aggressive given training load — energy gap is depressing recovery and stalling lifts',
    });
  }

  // Rule 2: recomp BF drift + energy under-target → rest-day-deficit-drift cluster.
  const recompBfDrift = recomp != null &&
    (recomp.facts['bf_pct_delta_4w_pts'] as number | null) != null &&
    (recomp.facts['bf_pct_delta_4w_pts'] as number) > 0;
  const energyUnder = energy != null &&
    (energy.facts['under_target_days_14d'] as number | null) != null &&
    (energy.facts['under_target_days_14d'] as number) >= 5;
  if (recompBfDrift && energyUnder) {
    // Skip if already in Rule 1 cluster.
    const inRule1 = clusters.some(
      (c) => c.id === 'energy-fatigue-perf' && c.themes.includes('energy'),
    );
    if (!inRule1) {
      clusters.push({
        id: 'recomp-energy',
        themes: ['recomp', 'energy'],
        root_hypothesis:
          'deficit drifts on rest days — body fat creeps while training-day intake hides the gap',
      });
    }
  }

  // Rule 3: fatigue urgent + adherence active → symptom-or-cause cluster.
  if (fatigue != null && fatigue.severity === 'urgent' && isActive(adh)) {
    clusters.push({
      id: 'fatigue-adherence',
      themes: ['fatigue', 'plan_adherence'],
      root_hypothesis:
        'missing sessions when fatigue spikes — chicken-and-egg, may need a planned deload',
    });
  }

  // Rule 4: performance plateau on the goal lift + goal active → off-pace-from-
  // stall cluster. Pre-2026-05-29 this fired on ANY plateau when a goal was
  // active, which produced false "OHP stall is widening your deadlift gap"
  // narratives. Now we require the plateau to actually be on the goal lift —
  // compose-performance.ts emits `goal_lift_plateau_active` (1/0) for this gate.
  const goalLiftPlateaued =
    perf != null && (perf.facts['goal_lift_plateau_active'] as number | null) === 1;
  if (goalLiftPlateaued && isActive(goal)) {
    clusters.push({
      id: 'performance-goal',
      themes: ['performance', 'goal_distance'],
      root_hypothesis:
        'goal pace slipping because the goal lift has stalled',
    });
  }

  // Rule 5 (endurance ↔ recovery): high endurance volume + fatigue active →
  // aerobic-base work depressing HRV. Endurance is "high" when prescribed work
  // happened (did_it_happen=1) — Phase 1 has no separate "volume spike" signal,
  // so completion of the prescribed Z2 is the proxy.
  const enduranceDidIt =
    endurance != null && (endurance.facts['did_it_happen'] as number | null) === 1;
  if (enduranceDidIt && isActive(fatigue)) {
    clusters.push({
      id: 'endurance-fatigue',
      themes: ['endurance', 'fatigue'],
      root_hypothesis:
        'endurance volume layered on existing fatigue — HRV recovery may need an easy day before the next Z2',
    });
  }

  // Rule 6 (endurance ↔ recomp): prescribed Z2 missed + recomp BF drift → the
  // missing cardio is the hole in the deficit. Reuses Rule 2's BF-drift gate.
  const enduranceMissed =
    endurance != null &&
    (endurance.facts['prescribed_this_week'] as number | null) === 1 &&
    (endurance.facts['did_it_happen'] as number | null) === 0;
  if (enduranceMissed && recompBfDrift) {
    clusters.push({
      id: 'endurance-recomp',
      themes: ['endurance', 'recomp'],
      root_hypothesis:
        'prescribed Z2 missed while body fat drifts — the cardio gap is the hole in the deficit',
    });
  }

  // Rule 7 (endurance ↔ performance): missed prescribed Z2 + performance
  // plateau on a big-four lift → interference cluster. Reuses the plateau
  // signal from Rule 1's gate.
  if (enduranceMissed && perfHasPlateau) {
    clusters.push({
      id: 'endurance-performance',
      themes: ['endurance', 'performance'],
      root_hypothesis:
        'missed endurance work and a lift plateau in the same week — both miss-the-stimulus, not interference',
    });
  }

  return clusters;
}
