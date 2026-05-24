// components/health/trends/format.ts
// Shared date/time formatting helpers for Remi trend card tooltips.

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** "Sun, May 24" from "2026-05-24" */
export function formatDateLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAY[dt.getUTCDay()]}, ${MONTH[m - 1]} ${d}`;
}

/** "HH:MM" from minutes-after-18:00 (the format BedtimePoint uses) */
export function formatBedtimeLabel(minutesAfter18: number): string {
  const totalMinutes = (18 * 60 + minutesAfter18) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = Math.floor(totalMinutes % 60);
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}
