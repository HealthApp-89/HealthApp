// lib/coach/trends/linear-regression.ts
//
// Pure OLS regression on (x, y) point arrays. Used by all five coach-trend
// composers to derive slopes + R² values.

export type Point = { x: number; y: number };

export type RegressionResult = {
  slope: number;
  intercept: number;
  r_squared: number;
  n: number;
};

/** Fit y = slope * x + intercept via ordinary least squares.
 *  Returns null when fewer than 2 points OR all x values are identical
 *  (variance of x is zero, slope undefined). */
export function linearRegression(points: readonly Point[]): RegressionResult | null {
  const n = points.length;
  if (n < 2) return null;

  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  if (denX === 0) return null;

  const slope = num / denX;
  const intercept = meanY - slope * meanX;
  // r² = (cov(x,y))² / (var(x) * var(y)). When all y are equal (denY = 0),
  // the line is a perfect flat fit and r² is defined as 1.
  const r_squared = denY === 0 ? 1 : (num * num) / (denX * denY);

  return { slope, intercept, r_squared, n };
}

/** Slope-only OLS. NOTE the deliberate semantic difference from
 *  linearRegression: when all x values are identical (zero x-variance),
 *  this returns 0 — matching the intelligence composers' historical
 *  behavior — whereas linearRegression returns null. Returns null only
 *  when fewer than 2 points. */
export function olsSlope(points: readonly Point[]): number | null {
  if (points.length < 2) return null;
  const reg = linearRegression(points);
  return reg === null ? 0 : reg.slope;
}
