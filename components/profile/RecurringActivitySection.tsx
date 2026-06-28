// components/profile/RecurringActivitySection.tsx
//
// /profile section for Activity-aware Planning: lets the user declare
// activities they repeat on fixed weekdays (e.g. "Padel every Tue + Thu,
// moderate"). Writes to profiles.recurring_activities via
// /api/profile/recurring-activities.
//
// UI: list of current items with remove button + an "Add activity" form
// (activity type select, weekday chips 0-6, intensity chips). Follows the
// EnduranceSetupSection / DietaryExclusionsSection style.

"use client";

import { useState } from "react";
import { X, Plus } from "lucide-react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import type { RecurringActivity } from "@/lib/coach/activity/types";
import {
  ACTIVITY_TYPES,
  type ActivityType,
  type ActivityIntensity,
} from "@/lib/coach/activity/types";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

type Props = {
  initial: RecurringActivity[];
};

export function RecurringActivitySection({ initial }: Props) {
  const [items, setItems] = useState<RecurringActivity[]>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Add-form local state
  const [addOpen, setAddOpen] = useState(false);
  const [newType, setNewType] = useState<ActivityType>("padel");
  const [newWeekdays, setNewWeekdays] = useState<number[]>([]);
  const [newIntensity, setNewIntensity] = useState<ActivityIntensity>("moderate");

  const persist = async (next: RecurringActivity[]) => {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const res = await fetch("/api/profile/recurring-activities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j as { error?: string }).error ?? "save_failed");
        return;
      }
      setItems(next);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = (idx: number) => {
    const next = items.filter((_, i) => i !== idx);
    void persist(next);
  };

  const addItem = () => {
    if (newWeekdays.length === 0) {
      setErr("Select at least one weekday.");
      return;
    }
    setErr(null);
    const entry: RecurringActivity = {
      type: newType,
      weekdays: [...newWeekdays].sort((a, b) => a - b),
      typical_intensity: newIntensity,
    };
    const next = [...items, entry];
    setAddOpen(false);
    setNewWeekdays([]);
    setNewType("padel");
    setNewIntensity("moderate");
    void persist(next);
  };

  const toggleWeekday = (d: number) => {
    setNewWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  };

  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.card,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Recurring activities
      </div>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: 0 }}>
        Activities you do on fixed weekdays (e.g. padel, runs). The coach uses
        these to anticipate fatigue on adjacent lift days.
      </p>

      {/* Existing items */}
      {items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: COLOR.surfaceAlt,
                borderRadius: RADIUS.cardSmall,
                padding: "8px 10px",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>
                  {ACTIVITY_LABELS[item.type]}
                </span>
                <span style={{ fontSize: 12, color: COLOR.textMuted }}>
                  {item.weekdays.map((d) => WEEKDAY_LABELS[d]).join(", ")} ·{" "}
                  {INTENSITY_LABELS[item.typical_intensity]}
                </span>
              </div>
              <button
                onClick={() => remove(idx)}
                disabled={saving}
                style={{
                  background: "none",
                  border: "none",
                  cursor: saving ? "not-allowed" : "pointer",
                  padding: 4,
                  color: COLOR.textMuted,
                  display: "flex",
                  alignItems: "center",
                }}
                aria-label="Remove activity"
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && !addOpen && (
        <p style={{ fontSize: 13, color: COLOR.textFaint, margin: 0 }}>
          No recurring activities configured.
        </p>
      )}

      {/* Add form */}
      {addOpen && (
        <div
          style={{
            background: COLOR.surfaceAlt,
            borderRadius: RADIUS.cardSmall,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Activity type */}
          <div>
            <label
              style={{ fontSize: 12, color: COLOR.textMuted, display: "block", marginBottom: 6 }}
            >
              Activity
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {ACTIVITY_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setNewType(t)}
                  style={{
                    padding: "5px 12px",
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

          {/* Weekdays */}
          <div>
            <label
              style={{ fontSize: 12, color: COLOR.textMuted, display: "block", marginBottom: 6 }}
            >
              Weekdays
            </label>
            <div style={{ display: "flex", gap: 5 }}>
              {WEEKDAY_LABELS.map((label, d) => (
                <button
                  key={d}
                  onClick={() => toggleWeekday(d)}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    border: `1px solid ${newWeekdays.includes(d) ? COLOR.accent : COLOR.divider}`,
                    background: newWeekdays.includes(d) ? COLOR.accent : COLOR.surface,
                    color: newWeekdays.includes(d) ? "#fff" : COLOR.textMid,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Intensity */}
          <div>
            <label
              style={{ fontSize: 12, color: COLOR.textMuted, display: "block", marginBottom: 6 }}
            >
              Typical intensity
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["light", "moderate", "hard"] as ActivityIntensity[]).map((level) => (
                <button
                  key={level}
                  onClick={() => setNewIntensity(level)}
                  style={{
                    padding: "5px 12px",
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

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, paddingTop: 2 }}>
            <button
              onClick={addItem}
              disabled={saving}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: RADIUS.chip,
                border: "none",
                background: COLOR.accent,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Add"}
            </button>
            <button
              onClick={() => {
                setAddOpen(false);
                setErr(null);
                setNewWeekdays([]);
              }}
              style={{
                padding: "8px 16px",
                borderRadius: RADIUS.chip,
                border: `1px solid ${COLOR.divider}`,
                background: COLOR.surface,
                color: COLOR.textMid,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {err && (
        <p style={{ fontSize: 12, color: COLOR.danger, margin: 0 }}>{err}</p>
      )}
      {saved && !err && (
        <p style={{ fontSize: 12, color: COLOR.success, margin: 0 }}>Saved.</p>
      )}

      {/* Add button */}
      {!addOpen && (
        <button
          onClick={() => setAddOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 12px",
            borderRadius: RADIUS.chip,
            border: `1px solid ${COLOR.divider}`,
            background: COLOR.surface,
            color: COLOR.accent,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          <Plus size={14} />
          Add activity
        </button>
      )}
    </div>
  );
}
