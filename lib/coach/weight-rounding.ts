// lib/coach/weight-rounding.ts
//
// Round a prescribed weight (e.g., baseKg × intensity_modifier) to the
// nearest physically-loadable weight given an exercise's increment config.
//
// Pure function. No I/O. Used by the morning brief assembler and by AI
// advice prompts when recommending progressive-overload jumps.

export type IncrementConfig = { step: number; intermediate?: number };

/** Round target weight to nearest valid loadable value. Returns 0 for non-positive
 *  targets. When `intermediate` is set, considers three candidates per base step:
 *  base, base+intermediate, base+step. */
export function roundToValidWeight(target: number, cfg: IncrementConfig): number {
  if (target <= 0) return 0;
  const baseLow = Math.floor(target / cfg.step) * cfg.step;
  const baseHigh = baseLow + cfg.step;
  const candidates: number[] = [baseLow, baseHigh];
  if (cfg.intermediate !== undefined && cfg.intermediate > 0 && cfg.intermediate < cfg.step) {
    candidates.push(baseLow + cfg.intermediate);
  }
  let best = candidates[0];
  let bestDiff = Math.abs(target - best);
  for (const c of candidates.slice(1)) {
    const diff = Math.abs(target - c);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  // Round to one decimal place to avoid 22.299999...
  return Math.round(best * 10) / 10;
}

/** Helper to get the minimum non-zero loadable weight for an increment config.
 *  Useful for AI prompts ("the smallest weight you can add is X kg"). */
export function minNonZeroIncrement(cfg: IncrementConfig): number {
  if (cfg.intermediate !== undefined && cfg.intermediate > 0) {
    return Math.min(cfg.step, cfg.intermediate);
  }
  return cfg.step;
}
