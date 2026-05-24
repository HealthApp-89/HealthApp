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

  const energy   = themes.energy;
  const fatigue  = themes.fatigue;
  const perf     = themes.performance;
  const recomp   = themes.recomp;
  const adh      = themes.plan_adherence;
  const goal     = themes.goal_distance;

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

  // Rule 3: fatigue urgent + adherence warn → symptom-or-cause cluster.
  if (
    fatigue != null && fatigue.severity === 'urgent' &&
    adh != null && (adh.severity === 'warn' || adh.severity === 'urgent')
  ) {
    clusters.push({
      id: 'fatigue-adherence',
      themes: ['fatigue', 'plan_adherence'],
      root_hypothesis:
        'missing sessions when fatigue spikes — chicken-and-egg, may need a planned deload',
    });
  }

  // Rule 4: performance plateau + goal warn → off-pace-from-stall cluster.
  if (perfHasPlateau && goal != null && (goal.severity === 'warn' || goal.severity === 'urgent')) {
    clusters.push({
      id: 'performance-goal',
      themes: ['performance', 'goal_distance'],
      root_hypothesis:
        'goal pace slipping because the lifts that drive it have stalled',
    });
  }

  return clusters;
}
