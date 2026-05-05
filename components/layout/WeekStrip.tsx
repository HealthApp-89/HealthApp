"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type WeekStripProps = {
  /** ISO date "YYYY-MM-DD" — the day currently selected. */
  selected: string;
  /** ISO date "YYYY-MM-DD" — today in the user's tz (drives the highlight). */
  today: string;
};

const DAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export function WeekStrip({ selected, today }: WeekStripProps) {
  const pathname = usePathname();
  // Anchor week on Monday = ISO weekday. Slot 0 = Monday of the week that
  // contains `selected`. Compute purely from string parsing — no Date math
  // for the date itself; we only use Date for the weekday lookup.
  const [y, m, d] = selected.split("-").map(Number);
  const sel = new Date(Date.UTC(y, m - 1, d));
  const isoDow = (sel.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun

  const days = Array.from({ length: 7 }, (_, i) => {
    const offset = i - isoDow;
    const dt = new Date(Date.UTC(y, m - 1, d + offset));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    const iso = `${yy}-${mm}-${dd}`;
    return {
      iso,
      day: dt.getUTCDate(),
      label: DAY_LABELS[(dt.getUTCDay() + 0) % 7],
      isToday: iso === today,
      isSelected: iso === selected,
    };
  });

  return (
    <div style={{ display: "flex", gap: "6px", padding: "0 8px 14px" }}>
      {days.map((d) => {
        const isAccent = d.isSelected || (!days.some((x) => x.isSelected) && d.isToday);
        const href = `${pathname}?date=${d.iso}`;
        return (
          <Link
            key={d.iso}
            href={href}
            scroll={false}
            style={{
              flex: 1,
              textAlign: "center",
              background: isAccent ? COLOR.accentSoft : COLOR.surface,
              borderRadius: RADIUS.cardSmall,
              padding: "10px 0 12px",
              boxShadow: SHADOW.card,
              textDecoration: "none",
            }}
          >
            <div
              style={{
                fontSize: "10px",
                fontWeight: 600,
                color: isAccent ? COLOR.accent : COLOR.textFaint,
                letterSpacing: "0.08em",
              }}
            >
              {d.label}
            </div>
            <div
              data-tnum
              style={{
                fontSize: "18px",
                fontWeight: 700,
                color: isAccent ? COLOR.accent : COLOR.textStrong,
                marginTop: "4px",
              }}
            >
              {d.day}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
