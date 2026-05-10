"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { whr } from "@/lib/health/measurements";
import { queryKeys } from "@/lib/query/keys";
import type { BodyMeasurement } from "@/lib/data/types";

export function MeasurementHistory({
  userId,
  rows,
  weightByDate,
  onEdit,
}: {
  userId: string;
  rows: BodyMeasurement[];
  /** date → weight_kg from daily_logs, used to enrich each row's display. */
  weightByDate: Map<string, number | null>;
  onEdit: (row: BodyMeasurement) => void;
}) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <Card>
        <p style={{ fontSize: "13px", color: COLOR.textFaint }}>
          No measurements logged yet.
        </p>
      </Card>
    );
  }

  async function onDelete(id: string) {
    if (!window.confirm("Delete this measurement? This also removes the photo.")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/health/measurements/${id}`, { method: "DELETE" });
      if (res.ok) {
        qc.invalidateQueries({ queryKey: queryKeys.bodyMeasurements.all(userId) });
      } else {
        alert("Delete failed");
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "10px" }}>
        History · {rows.length}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 0.8fr", gap: "4px 8px", fontSize: "10px", fontWeight: 700, color: COLOR.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", padding: "4px 0", borderBottom: `1px solid ${COLOR.divider}` }}>
        <span>Date</span>
        <span style={{ textAlign: "right" }}>Mid waist</span>
        <span style={{ textAlign: "right" }}>Weight</span>
        <span style={{ textAlign: "right" }}>Hips</span>
        <span style={{ textAlign: "right" }}>WHR</span>
      </div>
      {rows.map((r) => {
        const w = weightByDate.get(r.measured_on) ?? null;
        const whrVal = whr(r);
        const expanded = openId === r.id;
        return (
          <div key={r.id} style={{ borderBottom: `1px solid ${COLOR.divider}` }}>
            <button
              type="button"
              onClick={() => setOpenId(expanded ? null : r.id)}
              style={{ width: "100%", display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 0.8fr", gap: "4px 8px", padding: "8px 0", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontSize: "12px" }}
            >
              <span style={{ color: COLOR.textStrong, fontWeight: 600 }}>
                {r.measured_on}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {fmtNum(r.mid_waist_cm)}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {fmtNum(w)}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {fmtNum(r.hips_cm)}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {whrVal == null ? "—" : fmtNum(whrVal, 3)}
              </span>
            </button>
            {expanded && (
              <div style={{ padding: "8px 0 12px", display: "grid", gap: "6px" }}>
                <DetailGrid row={r} />
                {r.notes && (
                  <div style={{ fontSize: "12px", color: COLOR.textMid, fontStyle: "italic" }}>
                    {r.notes}
                  </div>
                )}
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <button
                    type="button"
                    onClick={() => onEdit(r)}
                    style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={deletingId === r.id}
                    onClick={() => void onDelete(r.id)}
                    style={{ background: "none", color: COLOR.danger, border: `1px solid ${COLOR.danger}`, borderRadius: RADIUS.pill, padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                  >
                    {deletingId === r.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function DetailGrid({ row }: { row: BodyMeasurement }) {
  const ROWS: { label: string; value: number | null }[] = [
    { label: "Neck",            value: row.neck_cm },
    { label: "Left arm",        value: row.left_upper_arm_cm },
    { label: "Right arm",       value: row.right_upper_arm_cm },
    { label: "Chest",           value: row.chest_cm },
    { label: "High waist",      value: row.high_waist_cm },
    { label: "Mid waist",       value: row.mid_waist_cm },
    { label: "Low waist",       value: row.low_waist_cm },
    { label: "Hips",            value: row.hips_cm },
    { label: "Left thigh",      value: row.left_thigh_cm },
    { label: "Left thigh (min)",  value: row.left_thigh_min_cm },
    { label: "Right thigh",     value: row.right_thigh_cm },
    { label: "Right thigh (min)", value: row.right_thigh_min_cm },
    { label: "Left calf",       value: row.left_calf_cm },
    { label: "Right calf",      value: row.right_calf_cm },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: "12px" }}>
      {ROWS.map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: COLOR.textMuted }}>{r.label}</span>
          <span data-tnum style={{ color: COLOR.textStrong, fontWeight: 600 }}>
            {fmtNum(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
