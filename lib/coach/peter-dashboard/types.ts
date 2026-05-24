// lib/coach/peter-dashboard/types.ts
//
// Type contracts for the Peter Dashboard payload chain.
// Composers produce ThemePayload; orchestrator assembles PeterDashboardFacts;
// narrative wrap produces Narrative; final stored shape is PeterDashboardPayload.

export type ThemeKey =
  | 'recomp'
  | 'energy'
  | 'fatigue'
  | 'performance'
  | 'plan_adherence'
  | 'goal_distance';

export type Severity = 'ok' | 'warn' | 'urgent';

/** Sparkline series for the expanded card state. `ref` is an optional
 *  reference value (e.g. target line, baseline) rendered as a dashed overlay. */
export type SparklineSeries = {
  label: string;
  series: Array<{ x: string; y: number; ref?: number }>;
};

export type ThemePayload = {
  key: ThemeKey;
  severity: Severity;
  /** Grid-state summary, e.g. "BF +0.4/wk, LBM flat". <= 40 chars. */
  one_line: string;
  /** Deterministic prose fallback. Used when narrative wrap fails. */
  body_md: string;
  /** Numeric/string facts the narrative wrapper may cite. Keys are
   *  composer-defined and stable across regens. */
  facts: Record<string, number | string | null>;
  /** Route the "Open …" nav chip links to. */
  drilldown: string;
  /** Mini chart for expanded state; null when no chart fits the theme. */
  sparkline: SparklineSeries | null;
  /** Audit trail of which tables/columns were read. Helps the audit script
   *  catch drift if a composer accidentally re-queries something a parent
   *  composer already provided. */
  inputs_used: string[];
};

export type ThemeCluster = {
  id: string;
  themes: ThemeKey[];
  root_hypothesis: string;
};

export type PeterDashboardFacts = {
  themes: Record<ThemeKey, ThemePayload>;
  clusters: ThemeCluster[];
  block_context: {
    block_number: number | null;
    week_of_block: number | null;
    block_total_weeks: number | null;
    primary_lift: string | null;
  };
  goal_summary: {
    kind: 'lift_e1rm' | 'bodyweight_kg' | 'bodyfat_pct' | null;
    metric: string | null;
    target: number | null;
    target_date: string | null;
  };
};

/** Output shape of the single narrative call. Validated before persist. */
export type Narrative = {
  hero: {
    headline: string;
    body_md: string;
  };
  cards: Record<ThemeKey, { narrative_md: string }>;
};

/** Final persisted shape — written to coach_dashboards.payload. */
export type PeterDashboardPayload = {
  schema_version: 1;
  generated_at: string;
  facts: PeterDashboardFacts;
  narrative: Narrative | null;  // null when narrative wrap failed
  narrative_failed: boolean;
};

export const ALL_THEME_KEYS: ThemeKey[] = [
  'recomp',
  'energy',
  'fatigue',
  'performance',
  'plan_adherence',
  'goal_distance',
];

/** Drilldown route per theme. Single source of truth for the expanded
 *  card's "Open …" chip. */
export const THEME_DRILLDOWN: Record<ThemeKey, string> = {
  recomp:         '/diet?view=body',
  energy:         '/diet',
  fatigue:        '/health?tab=trends',
  performance:    '/strength',
  plan_adherence: '/coach',
  goal_distance:  '/profile',
};

export const THEME_LABEL: Record<ThemeKey, string> = {
  recomp:         'Recomp',
  energy:         'Energy',
  fatigue:        'Fatigue',
  performance:    'Performance',
  plan_adherence: 'Plan adherence',
  goal_distance:  'Goal',
};
