"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefTonight } from "@/lib/data/types";

export function BriefTonight({ tonight }: { tonight: MorningBriefTonight }) {
  // Wake target = bedtime + sleep_target_hours, formatted as HH:mm
  const wakeTarget = addHoursToHHmm(tonight.bedtime_target, tonight.sleep_target_hours);
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: 10,
        padding: "10px 12px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
      aria-label={`Tonight target: bed by ${tonight.bedtime_target}, wake by ${wakeTarget}, ${tonight.sleep_target_hours} hours`}
    >
      <div style={{ fontSize: 11, color: COLOR.textMuted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Tonight
      </div>
      <div style={{ fontSize: 13, color: COLOR.textMid }}>
        {tonight.bedtime_target} → {wakeTarget} ({tonight.sleep_target_hours}h target)
      </div>
    </div>
  );
}

function addHoursToHHmm(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "—";
  const totalMinutes = (h * 60 + m + Math.round(hours * 60)) % (24 * 60);
  const wh = Math.floor(totalMinutes / 60);
  const wm = totalMinutes % 60;
  return `${String(wh).padStart(2, "0")}:${String(wm).padStart(2, "0")}`;
}
