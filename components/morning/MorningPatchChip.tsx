"use client";
// Revert affordance for the auto-applied morning-ladder patch.
// State derives LIVE from the training_weeks row (repatch_log) — the brief's
// ui jsonb is never rewritten. Hidden when: no patch today, already reverted,
// or the patched exercise names no longer appear in today's plan (a later
// day-type swap made the patch moot).

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import { useUserToday } from "@/lib/query/hooks/useUserToday";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { mondayOfIso } from "@/lib/time/dates";
import { hasMorningPatchEntry, hasMorningRevertEntry } from "@/lib/coach/prescription/patch-log";
import type { RepatchLogEntry, SessionPrescriptions, WeekdayLong } from "@/lib/data/types";

const WEEKDAY_LONG: WeekdayLong[] = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

export function MorningPatchChip({ userId }: { userId: string }) {
  const today = useUserToday(userId);
  const weekStart = today ? mondayOfIso(today) : "";
  const { data: week } = useTrainingWeek(userId, weekStart);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (!today || !week) return null;
  const log = Array.isArray(week.repatch_log) ? (week.repatch_log as RepatchLogEntry[]) : [];
  if (!hasMorningPatchEntry(log, today) || hasMorningRevertEntry(log, today)) return null;

  const patchEntry = [...log].reverse().find(
    (e) => e.reason === "morning_checkin" && e.workout_date === today,
  );
  if (!patchEntry || patchEntry.changes.length === 0) return null;

  // Hide when a later day-swap replaced today's exercises (names no longer match).
  const d = new Date(today + "T00:00:00Z");
  const weekdayLong = WEEKDAY_LONG[(d.getUTCDay() + 6) % 7];
  const todayNames = new Set(
    ((week.session_prescriptions as SessionPrescriptions | null)?.[weekdayLong] ?? [])
      .filter((ex) => !ex.warmup)
      .map((ex) => ex.name),
  );
  if (todayNames.size > 0 && !patchEntry.changes.some((c) => todayNames.has(c.exercise))) return null;

  const onRevert = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/chat/morning/revert-patch", { method: "POST" });
      if (res.ok) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.trainingWeeks.one(userId, weekStart),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        background: COLOR.surfaceAlt,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 12,
        marginBottom: 8,
      }}
    >
      <span style={{ color: COLOR.textMuted }}>
        Adjusted for how you feel this morning — volume/effort eased, weight unchanged.
      </span>
      <button
        onClick={onRevert}
        disabled={busy}
        style={{
          flexShrink: 0,
          background: "transparent",
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 12,
          fontWeight: 500,
          color: COLOR.textStrong,
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.5 : 1,
        }}
      >
        {busy ? "…" : "Revert"}
      </button>
    </div>
  );
}
