"use client";

import { useMemo } from "react";
import { COLOR } from "@/lib/ui/theme";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import {
  useSwapTrainingDay,
  type SwapErrorWithPreview,
} from "@/lib/query/hooks/useSwapTrainingDay";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { todayInUserTz, weekdayInUserTz } from "@/lib/time";
import type { MorningBriefCoachSuggestion, Weekday } from "@/lib/data/types";

const FULL_TO_SHORT: Record<string, Weekday> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/** Compute the week_start (Monday in UTC, YYYY-MM-DD) for the week
 *  containing today. Matches the brief assembler's existing convention. */
function weekStartOf(today: string): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function formatHHmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function BriefCoachSuggestion({
  userId,
  briefSessionType,
  suggestion,
}: {
  userId: string;
  /** The session.type frozen into the brief's card at intake time. */
  briefSessionType: string;
  suggestion: MorningBriefCoachSuggestion;
}) {
  const today = useMemo(() => todayInUserTz(), []);
  const weekStart = useMemo(() => weekStartOf(today), [today]);
  const sourceDay = useMemo<Weekday>(() => {
    const full = weekdayInUserTz(new Date(`${today}T12:00:00Z`));
    return FULL_TO_SHORT[full] ?? "Mon";
  }, [today]);

  const { data: trainingWeek } = useTrainingWeek(userId, weekStart);
  const mutation = useSwapTrainingDay(userId, weekStart);

  if (!suggestion) return null;
  if (!trainingWeek) return null; // assembler should have gated; defense in depth

  // Derive "acknowledged" state: the live training_weeks plan no longer matches
  // the brief's frozen session.type. The brief jsonb is NOT rewritten on swap.
  const currentType =
    readSessionForDay(trainingWeek.session_plan as Record<string, string>, sourceDay) ??
    briefSessionType;
  const isAcknowledged = currentType !== briefSessionType;

  if (isAcknowledged) {
    return (
      <div
        style={{
          marginTop: "12px",
          padding: "12px 14px",
          background: COLOR.successSoft,
          color: COLOR.success,
          borderRadius: "10px",
          fontSize: "13px",
          lineHeight: 1.5,
        }}
      >
        ✓ Swapped to {currentType} at {formatHHmm(trainingWeek.updated_at)} —{" "}
        <a href="/metrics?sub=strength" style={{ color: "inherit", textDecoration: "underline" }}>
          see /strength
        </a>
      </div>
    );
  }

  function onSwap() {
    mutation.mutate({
      body: { action: "replace", source_day: sourceDay, session_type: "Mobility" },
      confirm: true, // brief chip skips the 48h conflict gate at 7am
    });
  }

  return (
    <div
      style={{
        marginTop: "12px",
        padding: "14px 16px",
        background: COLOR.warningSoft,
        borderRadius: "10px",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: COLOR.warning,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: "4px",
        }}
      >
        Coach suggestion
      </div>
      <p
        style={{
          fontSize: "14px",
          color: COLOR.textStrong,
          marginBottom: "12px",
          lineHeight: 1.4,
        }}
      >
        Your readiness is low — swap to Mobility today?
      </p>
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={onSwap}
          disabled={mutation.isPending}
          style={{
            flex: 1,
            padding: "10px 14px",
            background: COLOR.warning,
            color: "#000",
            border: "none",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: mutation.isPending ? "not-allowed" : "pointer",
            opacity: mutation.isPending ? 0.6 : 1,
          }}
        >
          {mutation.isPending ? "Swapping…" : "Swap to Mobility"}
        </button>
        <button
          type="button"
          onClick={() => mutation.reset()}
          style={{
            flex: 1,
            padding: "10px 14px",
            background: "transparent",
            color: COLOR.textMuted,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: "8px",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Keep {briefSessionType}
        </button>
      </div>
      {mutation.isError && (
        <p style={{ marginTop: "8px", fontSize: "12px", color: COLOR.danger }} role="alert">
          {(mutation.error as SwapErrorWithPreview).message || "Swap failed — try again."}
        </p>
      )}
    </div>
  );
}
