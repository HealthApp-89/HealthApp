// components/activity/WeekActivityStrip.tsx
//
// Quick-add strip for per-week planned activities (padel sessions, runs, etc.)
// shown on the strength schedule view below the week header. Lets the athlete
// declare a one-off activity for a specific day-of-the-week, list existing
// entries, and delete them.
//
// Writes to /api/training-weeks/[week_start]/activities (PUT to replace the
// full array, DELETE to remove one). The week_start + planned_activities are
// passed as props from the parent (StrengthScheduleClient already fetches
// training_weeks via useTrainingWeek).

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import {
  ACTIVITY_TYPES,
  type ActivityType,
  type ActivityIntensity,
  type PlannedActivity,
} from "@/lib/coach/activity/types";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const INTENSITY_LABELS: Record<ActivityIntensity, string> = {
  light: "Light",
  moderate: "Moderate",
  hard: "Hard",
};

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  padel: "Padel",
  running: "Running",
  cycling: "Cycling",
  swimming: "Swimming",
  other: "Other",
};

const INTENSITY_COLOR: Record<ActivityIntensity, string> = {
  light: COLOR.success,
  moderate: COLOR.warning,
  hard: COLOR.danger,
};

/** Given a week_start (Monday) + weekday index 0=Sun..6=Sat, return the
 *  ISO date of that weekday within the week. Mon is index 1 → offset 0,
 *  Tue is 2 → +1, …, Sun is 0 → +6. */
function weekdayDate(weekStart: string, dayIdx: number): string {
  // weekStart is a Monday. Mon=1,Tue=2,...,Sat=6,Sun=0
  const offset = dayIdx === 0 ? 6 : dayIdx - 1;
  const d = new Date(`${weekStart}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Derive weekday index (0=Sun..6=Sat) from an ISO date. */
function isoToWeekdayIdx(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

type Props = {
  userId: string;
  weekStart: string;
  initialActivities: PlannedActivity[];
  onActivitiesChange?: (updated: PlannedActivity[]) => void;
};

export function WeekActivityStrip({
  userId,
  weekStart,
  initialActivities,
  onActivitiesChange,
}: Props) {
  const queryClient = useQueryClient();
  const [activities, setActivities] = useState<PlannedActivity[]>(initialActivities);
  const [addOpen, setAddOpen] = useState(false);
  const [newType, setNewType] = useState<ActivityType>("padel");
  // dayIdx: 0=Sun..6=Sat, default Monday (1)
  const [newDayIdx, setNewDayIdx] = useState<number>(1);
  const [newIntensity, setNewIntensity] = useState<ActivityIntensity>("moderate");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apiBase = `/api/training-weeks/${weekStart}/activities`;

  const putAll = async (next: PlannedActivity[]) => {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(apiBase, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: string }).error ?? "save_failed");
        return;
      }
      setActivities(next);
      onActivitiesChange?.(next);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.trainingWeeks.one(userId, weekStart),
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addActivity = () => {
    const date = weekdayDate(weekStart, newDayIdx);
    const entry: PlannedActivity = {
      date,
      type: newType,
      intensity_estimate: newIntensity,
      source: "manual",
    };
    const next = [...activities, entry];
    setAddOpen(false);
    setNewType("padel");
    setNewDayIdx(1);
    setNewIntensity("moderate");
    void putAll(next);
  };

  const removeActivity = (idx: number) => {
    const next = activities.filter((_, i) => i !== idx);
    void putAll(next);
  };

  if (activities.length === 0 && !addOpen) {
    return (
      <div style={{ padding: "0 0 2px" }}>
        <button
          onClick={() => setAddOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 10px",
            borderRadius: RADIUS.pill,
            border: `1px dashed ${COLOR.divider}`,
            background: "transparent",
            color: COLOR.textMuted,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <Plus size={12} />
          Add activity this week
        </button>
        {addOpen && null /* form renders below when activities.length > 0 */}
      </div>
    );
  }

  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.cardSmall,
        boxShadow: SHADOW.card,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Section label */}
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Planned activities this week
      </div>

      {/* Activity list */}
      {activities.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {activities.map((a, idx) => {
            const dayIdx = isoToWeekdayIdx(a.date);
            return (
              <div
                key={idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: COLOR.surfaceAlt,
                  borderRadius: RADIUS.chip,
                  padding: "6px 8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: INTENSITY_COLOR[a.intensity_estimate],
                      minWidth: 24,
                    }}
                  >
                    {WEEKDAY_LABELS[dayIdx]}
                  </span>
                  <span style={{ fontSize: 13, color: COLOR.textStrong, fontWeight: 500 }}>
                    {ACTIVITY_LABELS[a.type]}
                  </span>
                  <span style={{ fontSize: 11, color: COLOR.textMuted }}>
                    {INTENSITY_LABELS[a.intensity_estimate]}
                  </span>
                  {a.source === "recurring" && (
                    <span
                      style={{
                        fontSize: 10,
                        color: COLOR.textFaint,
                        background: COLOR.surfaceAlt,
                        border: `1px solid ${COLOR.divider}`,
                        borderRadius: RADIUS.chip,
                        padding: "1px 5px",
                      }}
                    >
                      recurring
                    </span>
                  )}
                </div>
                <button
                  onClick={() => removeActivity(idx)}
                  disabled={saving}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: saving ? "not-allowed" : "pointer",
                    padding: 4,
                    color: COLOR.textFaint,
                    display: "flex",
                    alignItems: "center",
                  }}
                  aria-label="Remove activity"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add form */}
      {addOpen ? (
        <div
          style={{
            background: COLOR.surfaceAlt,
            borderRadius: RADIUS.chip,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {/* Day of week */}
          <div>
            <label style={{ fontSize: 11, color: COLOR.textMuted, display: "block", marginBottom: 4 }}>
              Day
            </label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {WEEKDAY_LABELS.map((label, d) => (
                <button
                  key={d}
                  onClick={() => setNewDayIdx(d)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    border: `1px solid ${newDayIdx === d ? COLOR.accent : COLOR.divider}`,
                    background: newDayIdx === d ? COLOR.accent : COLOR.surface,
                    color: newDayIdx === d ? "#fff" : COLOR.textMid,
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  title={WEEKDAY_FULL[d]}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Activity type */}
          <div>
            <label style={{ fontSize: 11, color: COLOR.textMuted, display: "block", marginBottom: 4 }}>
              Activity
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {ACTIVITY_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setNewType(t)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: RADIUS.pill,
                    border: `1px solid ${newType === t ? COLOR.accent : COLOR.divider}`,
                    background: newType === t ? COLOR.accentSoft : COLOR.surface,
                    color: newType === t ? COLOR.accent : COLOR.textMid,
                    fontSize: 12,
                    fontWeight: newType === t ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {ACTIVITY_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Intensity */}
          <div>
            <label style={{ fontSize: 11, color: COLOR.textMuted, display: "block", marginBottom: 4 }}>
              Intensity
            </label>
            <div style={{ display: "flex", gap: 5 }}>
              {(["light", "moderate", "hard"] as ActivityIntensity[]).map((level) => (
                <button
                  key={level}
                  onClick={() => setNewIntensity(level)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: RADIUS.pill,
                    border: `1px solid ${newIntensity === level ? COLOR.accent : COLOR.divider}`,
                    background: newIntensity === level ? COLOR.accentSoft : COLOR.surface,
                    color: newIntensity === level ? COLOR.accent : COLOR.textMid,
                    fontSize: 12,
                    fontWeight: newIntensity === level ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {INTENSITY_LABELS[level]}
                </button>
              ))}
            </div>
          </div>

          {/* Form actions */}
          <div style={{ display: "flex", gap: 6, paddingTop: 2 }}>
            <button
              onClick={addActivity}
              disabled={saving}
              style={{
                flex: 1,
                padding: "7px 0",
                borderRadius: RADIUS.chip,
                border: "none",
                background: COLOR.accent,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Add"}
            </button>
            <button
              onClick={() => { setAddOpen(false); setErr(null); }}
              style={{
                padding: "7px 14px",
                borderRadius: RADIUS.chip,
                border: `1px solid ${COLOR.divider}`,
                background: COLOR.surface,
                color: COLOR.textMid,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAddOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 10px",
            borderRadius: RADIUS.pill,
            border: `1px dashed ${COLOR.divider}`,
            background: "transparent",
            color: COLOR.accent,
            fontSize: 12,
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          <Plus size={12} />
          Add activity
        </button>
      )}

      {/* Error feedback */}
      {err && (
        <p style={{ fontSize: 11, color: COLOR.danger, margin: 0 }}>{err}</p>
      )}
    </div>
  );
}
