// lib/time.ts
//
// Single source of truth for "now" / "today" in the user's timezone.
// Server-side only; uses platform Intl APIs (no Luxon, no date-fns-tz).
// USER_TIMEZONE env var, default Asia/Dubai.

const USER_TZ = process.env.USER_TIMEZONE || "Asia/Dubai";

let _logged = false;
function logOnce(): void {
  if (_logged) return;
  _logged = true;
  console.log(`[time] USER_TIMEZONE=${USER_TZ}`);
}

export const USER_TIMEZONE = USER_TZ;

type Parts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  weekday: string;
};

function partsInUserTz(now: Date): Parts {
  logOnce();
  // en-CA gives us YYYY-MM-DD-friendly numeric formatting; weekday is "long".
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  // Some platforms emit "24" for midnight; normalize to "00".
  const rawHour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: rawHour === "24" ? "00" : rawHour,
    minute: get("minute"),
    weekday: get("weekday"),
  };
}

/** YYYY-MM-DD in the user's timezone. Replaces every server-side
 *  `new Date().toISOString().slice(0, 10)`. */
export function todayInUserTz(now: Date = new Date()): string {
  const p = partsInUserTz(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Day of week in user's tz: "Monday" | "Tuesday" | ... */
export function weekdayInUserTz(now: Date = new Date()): string {
  return partsInUserTz(now).weekday;
}

/** "HH:mm" in user's tz, 24h. */
export function localTimeInUserTz(now: Date = new Date()): string {
  const p = partsInUserTz(now);
  return `${p.hour}:${p.minute}`;
}

/** Single struct for prompts and logs. */
export function nowInUserTz(now: Date = new Date()): {
  date: string;
  weekday: string;
  time: string;
  tz: string;
  utcOffset: string;
} {
  const p = partsInUserTz(now);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    time: `${p.hour}:${p.minute}`,
    tz: USER_TZ,
    utcOffset: utcOffsetString(now),
  };
}

function utcOffsetString(now: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TZ,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(now);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  // Examples seen across runtimes: "GMT+4", "GMT+04:00", "GMT-5", "GMT".
  const m = tzPart.match(/GMT([+-])?(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  const sign = m[1] || "+";
  const hh = (m[2] ?? "00").padStart(2, "0");
  const mm = m[3] ?? "00";
  return `${sign}${hh}:${mm}`;
}

const ONE_DAY_MS = 86_400_000;

/** Relative label for a YYYY-MM-DD row vs. today.
 *  Returns "today" | "yesterday" | "tomorrow" | "Mon (3d ago)" | "Wed (in 2d)". */
export function relativeDateLabel(
  ymd: string,
  today: string = todayInUserTz(),
): string {
  if (ymd === today) return "today";
  const todayMs = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const ymdMs = Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
  );
  const diffDays = Math.round((ymdMs - todayMs) / ONE_DAY_MS);
  if (diffDays === -1) return "yesterday";
  if (diffDays === 1) return "tomorrow";
  const weekday = new Date(ymd + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  if (diffDays < 0) return `${weekday} (${-diffDays}d ago)`;
  return `${weekday} (in ${diffDays}d)`;
}

/** "Tuesday, May 5" — for the dashboard Header. */
export function formatHeaderDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}
