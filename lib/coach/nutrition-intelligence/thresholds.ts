// lib/coach/nutrition-intelligence/thresholds.ts
//
// Constants shared between proactive checks (Phase 2) and InlineNudgeCallout.
// Pulling these into one module so we never get drift between "what fires"
// and "what the inline callout claims is firing".

/** Body comp triggers — 4-week window deltas. */
export const RECOMP_SUCCESS_LBM_DELTA_KG = 0.3;       // ≥ +0.3 kg
export const RECOMP_SUCCESS_BF_DELTA_PTS = -0.5;      // ≤ −0.5 pts
export const RECOMP_DRIFT_WEIGHT_TOL_KG  = 0.3;       // within ±0.3 kg
export const RECOMP_DRIFT_BF_DELTA_PTS   = 0.5;       // ≥ +0.5 pts

/** Protein adherence triggers — 7-day window. */
export const PROTEIN_UNDER_HIT_RATE     = 0.60;       // < 60% hit rate fires
export const PROTEIN_UNDER_MIN_LOGGED   = 5;          // require ≥ 5 logged days

/** GLP-1 protein floor — 5-day window. */
export const GLP1_PROTEIN_FLOOR_G_PER_KG = 1.8;       // active mode floor
export const GLP1_PROTEIN_MISS_DAYS      = 3;         // misses on ≥ 3 of last 5

/** Food-quality triggers — 14-day window with min-volume gate. */
export const MONOTONE_PROTEIN_SHARE_THRESHOLD = 0.70; // ≥ 70% from one source
export const QUALITY_MIN_CLASSIFIED_ITEMS    = 30;    // suppress below this

export const FRIED_HEAVY_SHARE_THRESHOLD = 0.40;      // (pan + deep) / known ≥ 0.40

/** Training × nutrition triggers — 4-week window. */
export const TRAINING_UNDEREAT_KCAL_GAP   = 300;      // kcal < (target − 300) counts
export const TRAINING_UNDEREAT_HIT_RATIO  = 0.50;     // ≥ 50% of lift days
export const TRAINING_UNDEREAT_MIN_DAYS   = 6;        // ≥ 6 lift days in 4w

/** Inline-callout severity colors (matches existing ProactiveNudgeCard styling). */
export const CALLOUT_AMBER_BG     = "#fef3c7";
export const CALLOUT_AMBER_BORDER = "#fde68a";
export const CALLOUT_AMBER_FG     = "#92400e";
export const CALLOUT_GREEN_BG     = "#dcfce7";
export const CALLOUT_GREEN_BORDER = "#bbf7d0";
export const CALLOUT_GREEN_FG     = "#166534";

/** Aggregation window for the food-quality composer. */
export const FOOD_QUALITY_WINDOW_DAYS = 14;
