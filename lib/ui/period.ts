// Period selector — preset windows + custom range, all expressed as
// inclusive {from, to} YYYY-MM-DD strings in UTC.

export type PeriodPreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "wtd"
  | "mtd"
  | "ytd"
  | "lw"
  | "lm"
  | "ly"
  | "all"
  | "custom";

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "wtd", label: "Week to date" },
  { id: "mtd", label: "Month to date" },
  { id: "ytd", label: "Year to date" },
  { id: "lw", label: "Last week" },
  { id: "lm", label: "Last month" },
  { id: "ly", label: "Last year" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];

export const PERIOD_LABELS: Record<PeriodPreset, string> = Object.fromEntries(
  PERIOD_PRESETS.map((p) => [p.id, p.label]),
) as Record<PeriodPreset, string>;

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function utc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day));
}

/** Monday is day 1; Sunday is day 0 → treat Sunday as 7 to make Monday=start. */
function startOfWeekMonday(d: Date): Date {
  const day = d.getUTCDay() || 7; // 0 → 7
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

export function resolvePeriod(
  period: PeriodPreset | string | undefined,
  start?: string,
  end?: string,
): { from: string; to: string; preset: PeriodPreset } {
  const presetIds = PERIOD_PRESETS.map((p) => p.id);
  const preset = (presetIds.includes(period as PeriodPreset) ? period : "today") as PeriodPreset;
  const now = new Date();
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  if (preset === "custom") {
    const from = start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : fmt(today);
    const to = end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : fmt(today);
    // ensure from <= to
    return from <= to ? { from, to, preset } : { from: to, to: from, preset };
  }

  switch (preset) {
    case "today":
      return { from: fmt(today), to: fmt(today), preset };
    case "yesterday": {
      const y = new Date(today);
      y.setUTCDate(today.getUTCDate() - 1);
      return { from: fmt(y), to: fmt(y), preset };
    }
    case "7d": {
      const f = new Date(today);
      f.setUTCDate(today.getUTCDate() - 6);
      return { from: fmt(f), to: fmt(today), preset };
    }
    case "30d": {
      const f = new Date(today);
      f.setUTCDate(today.getUTCDate() - 29);
      return { from: fmt(f), to: fmt(today), preset };
    }
    case "wtd":
      return { from: fmt(startOfWeekMonday(today)), to: fmt(today), preset };
    case "mtd":
      return { from: fmt(utc(today.getUTCFullYear(), today.getUTCMonth(), 1)), to: fmt(today), preset };
    case "ytd":
      return { from: fmt(utc(today.getUTCFullYear(), 0, 1)), to: fmt(today), preset };
    case "lw": {
      const thisMon = startOfWeekMonday(today);
      const lastSun = new Date(thisMon);
      lastSun.setUTCDate(thisMon.getUTCDate() - 1);
      const lastMon = new Date(lastSun);
      lastMon.setUTCDate(lastSun.getUTCDate() - 6);
      return { from: fmt(lastMon), to: fmt(lastSun), preset };
    }
    case "lm": {
      const firstThis = utc(today.getUTCFullYear(), today.getUTCMonth(), 1);
      const lastEnd = new Date(firstThis);
      lastEnd.setUTCDate(firstThis.getUTCDate() - 1);
      const lastStart = utc(lastEnd.getUTCFullYear(), lastEnd.getUTCMonth(), 1);
      return { from: fmt(lastStart), to: fmt(lastEnd), preset };
    }
    case "ly": {
      const y = today.getUTCFullYear() - 1;
      return { from: fmt(utc(y, 0, 1)), to: fmt(utc(y, 11, 31)), preset };
    }
    case "all":
      return { from: "2020-01-01", to: fmt(today), preset };
    default:
      return { from: fmt(today), to: fmt(today), preset };
  }
}

/** How wide the window is, in days. Useful for picking chart granularity. */
export function periodLengthDays(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

export type Granularity = "day" | "week" | "month";

/** Smart granularity: keep daily up to ~60 days, weekly up to ~365, then monthly. */
export function pickGranularity(days: number): Granularity {
  if (days <= 60) return "day";
  if (days <= 365) return "week";
  return "month";
}

/** Aggregate a series of {date, value} points into week or month buckets (mean). */
export function aggregateSeries<T extends { date: string }>(
  points: T[],
  pick: (r: T) => number | null,
  granularity: Granularity,
): { date: string; value: number | null }[] {
  if (granularity === "day") {
    return points.map((p) => ({ date: p.date, value: pick(p) }));
  }
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    const v = pick(p);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const key = bucketKey(p.date, granularity);
    const b = buckets.get(key) ?? { sum: 0, n: 0 };
    b.sum += v;
    b.n += 1;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => ({ date, value: b.n ? b.sum / b.n : null }));
}

function bucketKey(date: string, g: Granularity): string {
  const d = new Date(date + "T00:00:00Z");
  if (g === "month") return date.slice(0, 7) + "-01";
  // week → Monday of that ISO week
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}
