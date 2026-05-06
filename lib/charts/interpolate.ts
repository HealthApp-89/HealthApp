// lib/charts/interpolate.ts
import type { LinePoint } from "@/components/charts/LineChart";
import type { InterpolateConfig } from "./metricChartConfig";

/**
 * Linear-interpolate null y-values where the gap (consecutive nulls between
 * two known endpoints) is at most `cfg.maxGapDays`. Each filled point is
 * marked `estimated: true` so the renderer can style it as dashed/hollow.
 *
 * Gap length is measured in CALENDAR DAYS from `LinePoint.x` (date string),
 * not array indices — necessary for aggregated views where one bucket may
 * span several days.
 *
 * Fail-closed:
 *   - cfg.enabled === false  → return original series unchanged
 *   - any point lacks `x`    → return original series unchanged
 *   - leading or trailing nulls (no left or right endpoint) → leave null
 *   - gap > maxGapDays       → leave null
 */
export function interpolateGaps(
  series: LinePoint[],
  cfg: InterpolateConfig,
): LinePoint[] {
  if (!cfg.enabled || series.length === 0) return series;
  if (series.some((p) => !p.x || !ISO_DATE.test(p.x))) return series;

  const out = series.map((p) => ({ ...p }));
  let i = 0;
  while (i < out.length) {
    if (out[i].y !== null) {
      i++;
      continue;
    }
    // Find the bounding non-null endpoints.
    let left = i - 1;
    while (left >= 0 && out[left].y === null) left--;
    let right = i;
    while (right < out.length && out[right].y === null) right++;

    if (left < 0 || right >= out.length) {
      // leading or trailing run — bail; cannot interpolate without both ends
      i = right;
      continue;
    }
    const leftDate = parseIso(out[left].x as string);
    const rightDate = parseIso(out[right].x as string);
    const gapDays = Math.round((rightDate - leftDate) / DAY_MS);
    if (gapDays > cfg.maxGapDays) {
      i = right;
      continue;
    }

    const leftY = out[left].y as number;
    const rightY = out[right].y as number;
    for (let k = left + 1; k < right; k++) {
      const t = (parseIso(out[k].x as string) - leftDate) / (rightDate - leftDate);
      out[k] = { ...out[k], y: leftY + t * (rightY - leftY), estimated: true };
    }
    i = right;
  }
  return out;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(iso: string): number {
  return new Date(iso + "T00:00:00Z").getTime();
}
