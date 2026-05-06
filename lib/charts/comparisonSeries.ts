// lib/charts/comparisonSeries.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinePoint } from "@/components/charts/LineChart";

const DAY_MS = 86_400_000;

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function isoDaysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00Z").getTime();
  const b = new Date(toIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / DAY_MS) + 1;
}

/**
 * Daily-resolution prior-period series for the /trends/[metric] detail
 * chart. Returns one LinePoint per calendar day in the prior window
 * (gap-preserving — nulls stay null), or null if coverage < 50%.
 *
 * Index alignment: comparison[i] is plotted at the same x-position as
 * data[i] in the current window. Same series length on both sides.
 */
export async function getComparisonSeries(
  supabase: SupabaseClient,
  userId: string,
  metricKey: string,
  fromIso: string,
  toIso: string,
): Promise<LinePoint[] | null> {
  const days = isoDaysBetween(fromIso, toIso);
  const priorTo = shiftIso(fromIso, -1);
  const priorFrom = shiftIso(priorTo, -(days - 1));

  const { data: rows } = await supabase
    .from("daily_logs")
    .select(`date, ${metricKey}`)
    .eq("user_id", userId)
    .gte("date", priorFrom)
    .lte("date", priorTo)
    .order("date", { ascending: true });

  // Index by date so we can produce a dense day-by-day array even if some
  // days are missing rows entirely. Cast through `unknown` because the
  // typed Supabase client returns a parser-error type for dynamic select
  // strings — same pattern used in app/trends/[metric]/page.tsx.
  const byDate = new Map<string, number | null>();
  const safeRows = (rows ?? []) as unknown as Record<string, unknown>[];
  for (const r of safeRows) {
    const v = r[metricKey];
    byDate.set(r.date as string, typeof v === "number" ? v : null);
  }

  const out: LinePoint[] = [];
  for (let i = 0; i < days; i++) {
    const dateIso = shiftIso(priorFrom, i);
    const v = byDate.get(dateIso) ?? null;
    out.push({ x: dateIso, y: v });
  }

  // Coverage gate (D11): drop if < 50% of buckets have any data.
  const covered = out.filter((p) => p.y !== null).length;
  if (covered / Math.max(1, out.length) < 0.5) return null;

  return out;
}
