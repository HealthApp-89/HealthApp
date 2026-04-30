import type { DailyLog } from "@/lib/data/types";

/** Derived readiness score 0-100 from HRV, RHR, sleep. Returns null if no inputs. */
export function calcScore(log: Pick<DailyLog, "hrv" | "resting_hr" | "sleep_score" | "sleep_hours"> | null | undefined): number | null {
  if (!log) return null;
  const arr: number[] = [];
  if (log.hrv) arr.push(Math.min((log.hrv / 80) * 100, 100));
  if (log.resting_hr) arr.push(Math.max(100 - (log.resting_hr - 40) * 2, 0));
  const slp = log.sleep_score ?? (log.sleep_hours ? (log.sleep_hours / 9) * 100 : null);
  if (slp) arr.push(slp);
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

/** Epley one-rep-max estimate. */
export function est1rm(kg: number, reps: number): number {
  if (!kg || !reps) return 0;
  if (reps === 1) return kg;
  return Math.round(kg * (1 + reps / 30));
}

export function avg(arr: (number | null | undefined)[]): number | null {
  const f = arr.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
  if (!f.length) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

/** Build a 7-day window aligned to "today", filling gaps with null and labelling Today / weekday. */
export function buildWeekWindow<T extends { date: string }>(rows: T[], today: string): {
  dates: string[];
  rows: (T | null)[];
  labels: string[];
} {
  const dates: string[] = [];
  const todayDt = new Date(today + "T00:00:00Z");
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayDt);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const aligned = dates.map((d) => byDate.get(d) ?? null);
  const labels = dates.map((d, i) => {
    if (i === dates.length - 1) return "Today";
    const dt = new Date(d + "T00:00:00Z");
    return dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).slice(0, 3);
  });
  return { dates, rows: aligned, labels };
}
