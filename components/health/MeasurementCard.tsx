"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  whr,
  waistChest,
  symmetryPct,
  delta as deltaFor,
} from "@/lib/health/measurements";
import type { BodyMeasurement, BodyMeasurementField } from "@/lib/data/types";

type Group = { name: "Upper" | "Core" | "Lower"; rows: { key: BodyMeasurementField; label: string }[] };

const GROUPS: Group[] = [
  {
    name: "Upper",
    rows: [
      { key: "neck_cm",            label: "Neck" },
      { key: "left_upper_arm_cm",  label: "Left upper arm" },
      { key: "right_upper_arm_cm", label: "Right upper arm" },
      { key: "chest_cm",           label: "Chest" },
    ],
  },
  {
    name: "Core",
    rows: [
      { key: "high_waist_cm", label: "High waist" },
      { key: "mid_waist_cm",  label: "Mid waist" },
      { key: "low_waist_cm",  label: "Low waist" },
      { key: "hips_cm",       label: "Hips" },
    ],
  },
  {
    name: "Lower",
    rows: [
      { key: "left_thigh_cm",      label: "Left thigh" },
      { key: "left_thigh_min_cm",  label: "Left thigh (min)" },
      { key: "right_thigh_cm",     label: "Right thigh" },
      { key: "right_thigh_min_cm", label: "Right thigh (min)" },
      { key: "left_calf_cm",       label: "Left calf" },
      { key: "right_calf_cm",      label: "Right calf" },
    ],
  },
];

export function MeasurementCard({
  latest,
  prev,
  onLogNew,
  onEdit,
}: {
  latest: BodyMeasurement | null;
  prev: BodyMeasurement | null;
  onLogNew: () => void;
  onEdit: () => void;
}) {
  if (!latest) {
    return (
      <Card>
        <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "10px" }}>
          Measurements
        </div>
        <p style={{ fontSize: "13px", color: COLOR.textFaint, marginBottom: "12px" }}>
          No measurements yet. Log your first one to start tracking circumference progress.
        </p>
        <button
          type="button"
          onClick={onLogNew}
          style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "10px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
        >
          Log first measurement
        </button>
      </Card>
    );
  }

  const d = deltaFor(latest, prev);
  const whrVal = whr(latest);
  const wcVal = waistChest(latest);
  const armSym = symmetryPct(latest.left_upper_arm_cm, latest.right_upper_arm_cm);
  const thighSym = symmetryPct(latest.left_thigh_cm, latest.right_thigh_cm);

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Measurements · {latest.measured_on}
        </span>
        <button
          type="button"
          onClick={onEdit}
          style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          Edit
        </button>
      </div>

      {/* Header row */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 0.8fr", gap: "4px 10px", marginBottom: "4px", fontSize: "10px", fontWeight: 700, color: COLOR.textFaint, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        <span>Item</span>
        <span style={{ textAlign: "right" }}>Present</span>
        <span style={{ textAlign: "right" }}>Last</span>
        <span style={{ textAlign: "right" }}>Net</span>
      </div>

      {GROUPS.map((g) => (
        <div key={g.name} style={{ marginBottom: "8px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: COLOR.textMuted, marginTop: "6px", marginBottom: "2px", letterSpacing: "0.04em" }}>
            {g.name}
          </div>
          {g.rows.map(({ key, label }) => {
            const curr = latest[key];
            const last = prev?.[key] ?? null;
            const dRow = d[key];
            const sign = dRow == null ? "—" : dRow.abs > 0 ? "+" : "";
            const dColor =
              dRow == null
                ? COLOR.textFaint
                : dRow.abs === 0
                ? COLOR.textFaint
                : dRow.abs < 0
                ? COLOR.success
                : COLOR.danger;
            return (
              <div key={key} style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 0.8fr", gap: "4px 10px", padding: "4px 0", borderTop: `1px solid ${COLOR.divider}`, fontSize: "12px" }}>
                <span style={{ color: COLOR.textMid }}>{label}</span>
                <span data-tnum style={{ textAlign: "right", color: COLOR.textStrong, fontWeight: 600 }}>
                  {fmtNum(curr)}
                </span>
                <span data-tnum style={{ textAlign: "right", color: COLOR.textFaint }}>
                  {fmtNum(last)}
                </span>
                <span data-tnum style={{ textAlign: "right", color: dColor, fontWeight: 600 }}>
                  {dRow == null ? "—" : `${sign}${fmtNum(dRow.abs)}`}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {/* Derived row */}
      <div style={{ marginTop: "12px", padding: "10px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
        <DerivedCell label="WHR"          value={whrVal == null ? "—" : fmtNum(whrVal, 3)} />
        <DerivedCell label="W : C"        value={wcVal == null ? "—" : fmtNum(wcVal, 3)} />
        <DerivedCell label="Arm sym %"    value={armSym == null ? "—" : fmtNum(armSym, 1)} />
        <DerivedCell label="Thigh sym %"  value={thighSym == null ? "—" : fmtNum(thighSym, 1)} />
      </div>

      {latest.photo_path && <PhotoThumb path={latest.photo_path} />}

      {latest.notes && (
        <div style={{ marginTop: "10px", fontSize: "12px", color: COLOR.textMid, fontStyle: "italic" }}>
          {latest.notes}
        </div>
      )}
    </Card>
  );
}

function DerivedCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: "10px", color: COLOR.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div data-tnum style={{ fontSize: "14px", color: COLOR.textStrong, fontWeight: 700, marginTop: "2px" }}>
        {value}
      </div>
    </div>
  );
}

function PhotoThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/health/photo-url?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; signed_url?: string }) => {
        if (!cancelled && j.ok && j.signed_url) setUrl(j.signed_url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!url) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ marginTop: "10px", padding: 0, background: "none", border: "none", cursor: "pointer" }}
        aria-label="View photo"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" style={{ width: "72px", height: "72px", objectFit: "cover", borderRadius: RADIUS.cardSmall }} />
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,20,48,0.85)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}
    </>
  );
}
