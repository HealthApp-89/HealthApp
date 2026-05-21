"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { todayInUserTz } from "@/lib/time";
import { queryKeys } from "@/lib/query/keys";
import { selectOnFocus } from "@/lib/ui/inputs";
import {
  BODY_MEASUREMENT_FIELDS,
  type BodyMeasurement,
  type BodyMeasurementField,
} from "@/lib/data/types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type GroupKey = "Upper" | "Core" | "Lower";

const GROUPS: { group: GroupKey; fields: { key: BodyMeasurementField; label: string }[] }[] = [
  {
    group: "Upper",
    fields: [
      { key: "neck_cm",            label: "Neck" },
      { key: "left_upper_arm_cm",  label: "Left upper arm" },
      { key: "right_upper_arm_cm", label: "Right upper arm" },
      { key: "chest_cm",           label: "Chest" },
    ],
  },
  {
    group: "Core",
    fields: [
      { key: "high_waist_cm", label: "High waist" },
      { key: "mid_waist_cm",  label: "Mid waist" },
      { key: "low_waist_cm",  label: "Low waist" },
      { key: "hips_cm",       label: "Hips" },
    ],
  },
  {
    group: "Lower",
    fields: [
      { key: "left_thigh_cm",      label: "Left thigh" },
      { key: "left_thigh_min_cm",  label: "Left thigh (min)" },
      { key: "right_thigh_cm",     label: "Right thigh" },
      { key: "right_thigh_min_cm", label: "Right thigh (min)" },
      { key: "left_calf_cm",       label: "Left calf" },
      { key: "right_calf_cm",      label: "Right calf" },
    ],
  },
];

type FormState = {
  measured_on: string;
  notes: string;
  photo_path: string | null;
  photo_signed_url: string | null;
  photo_uploading: boolean;
  photo_error: string | null;
  values: Record<BodyMeasurementField, string>; // string in form, parsed to number on save
};

function emptyValues(): Record<BodyMeasurementField, string> {
  const v = {} as Record<BodyMeasurementField, string>;
  for (const k of BODY_MEASUREMENT_FIELDS) v[k] = "";
  return v;
}

function fromMeasurement(m: BodyMeasurement): Record<BodyMeasurementField, string> {
  const v = {} as Record<BodyMeasurementField, string>;
  for (const k of BODY_MEASUREMENT_FIELDS) {
    const raw = m[k];
    v[k] = raw == null ? "" : fmtNum(raw);
  }
  return v;
}

function isOutOfSoftRange(s: string): boolean {
  if (s.trim() === "") return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return true;
  return n <= 0 || n > 300;
}

export function MeasurementForm({
  userId,
  existing,
  onClose,
  existingDates,
}: {
  userId: string;
  /** When supplied, the modal is in Edit mode for that row. */
  existing?: BodyMeasurement | null;
  onClose: () => void;
  /** Existing measured_on values; used to confirm overwrite when creating new. */
  existingDates: string[];
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<FormState>(() => ({
    measured_on: existing?.measured_on ?? todayInUserTz(),
    notes: existing?.notes ?? "",
    photo_path: existing?.photo_path ?? null,
    photo_signed_url: null,
    photo_uploading: false,
    photo_error: null,
    values: existing ? fromMeasurement(existing) : emptyValues(),
  }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const anyValue = BODY_MEASUREMENT_FIELDS.some((k) => state.values[k].trim() !== "");
  const dateValid = ISO_DATE.test(state.measured_on);

  async function onPickPhoto(file: File) {
    setState((s) => ({ ...s, photo_uploading: true, photo_error: null }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/health/measurements/photo", {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as
        | { ok: true; path: string; signed_url: string | null }
        | { ok: false; reason: string };
      if (!json.ok) {
        setState((s) => ({
          ...s,
          photo_uploading: false,
          photo_error: json.reason,
        }));
        return;
      }
      setState((s) => ({
        ...s,
        photo_uploading: false,
        photo_path: json.path,
        photo_signed_url: json.signed_url,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        photo_uploading: false,
        photo_error: err instanceof Error ? err.message : "upload_failed",
      }));
    }
  }

  function clearPhoto() {
    setState((s) => ({ ...s, photo_path: null, photo_signed_url: null }));
  }

  async function onSave() {
    if (!anyValue || !dateValid || submitting) return;

    // Confirm overwrite: only when creating new (not editing) and the date
    // already exists.
    if (
      !existing &&
      existingDates.includes(state.measured_on) &&
      !window.confirm(
        `A measurement already exists for ${state.measured_on}. Overwrite?`,
      )
    ) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    const fields: Record<BodyMeasurementField, number | null> = {} as Record<
      BodyMeasurementField,
      number | null
    >;
    for (const k of BODY_MEASUREMENT_FIELDS) {
      const s = state.values[k].trim();
      if (s === "") {
        fields[k] = null;
        continue;
      }
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0) {
        setSubmitting(false);
        setSubmitError(`Invalid value for ${k}`);
        return;
      }
      fields[k] = n;
    }

    try {
      const res = await fetch("/api/health/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          measured_on: state.measured_on,
          ...fields,
          photo_path: state.photo_path,
          notes: state.notes.trim() || null,
        }),
      });
      const json = (await res.json()) as
        | { ok: true; row: BodyMeasurement }
        | { ok: false; reason: string };
      if (!json.ok) {
        setSubmitting(false);
        setSubmitError(json.reason);
        return;
      }
      qc.invalidateQueries({ queryKey: queryKeys.bodyMeasurements.all(userId) });
      onClose();
    } catch (err) {
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : "save_failed");
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(15,20,48,0.5)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLOR.surface,
          borderRadius: 0,
          padding: "16px",
          width: "100%",
          maxWidth: "560px",
          alignSelf: "stretch",
          boxShadow: SHADOW.floating,
          minHeight: "100dvh",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: "14px",
              color: COLOR.textMuted,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "8px 4px",
            }}
          >
            ← Cancel
          </button>
          <strong style={{ fontSize: "15px", color: COLOR.textStrong }}>
            {existing ? "Edit measurement" : "Log measurement"}
          </strong>
          <button
            type="button"
            onClick={onSave}
            disabled={!anyValue || !dateValid || submitting}
            style={{
              fontSize: "14px",
              fontWeight: 700,
              color: anyValue && dateValid ? COLOR.accent : COLOR.textFaint,
              background: "none",
              border: "none",
              cursor: anyValue && dateValid ? "pointer" : "default",
              padding: "8px 4px",
            }}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>

        {submitError && (
          <div style={{ background: COLOR.dangerSoft, color: COLOR.danger, padding: "8px 12px", borderRadius: RADIUS.cardSmall, fontSize: "13px", marginBottom: "12px" }}>
            {submitError}
          </div>
        )}

        {/* Date */}
        <label style={{ display: "block", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
            Date
          </div>
          <input
            type="date"
            value={state.measured_on}
            onChange={(e) => setState((s) => ({ ...s, measured_on: e.target.value }))}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: COLOR.surfaceAlt,
              border: "none",
              borderRadius: RADIUS.input,
              fontSize: "14px",
              color: COLOR.textStrong,
            }}
          />
        </label>

        {/* Photo */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>
            Photo (optional)
          </div>
          {state.photo_path ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall }}>
              {state.photo_signed_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={state.photo_signed_url} alt="measurement" style={{ width: "60px", height: "60px", objectFit: "cover", borderRadius: RADIUS.cardSmall }} />
              ) : (
                <div style={{ width: "60px", height: "60px", borderRadius: RADIUS.cardSmall, background: COLOR.divider }} />
              )}
              <span style={{ flex: 1, fontSize: "12px", color: COLOR.textMid }}>Attached</span>
              <button type="button" onClick={clearPhoto} style={{ background: "none", border: "none", color: COLOR.textMuted, cursor: "pointer", fontSize: "16px" }}>
                ✕
              </button>
            </div>
          ) : (
            <label style={{ display: "block" }}>
              <div style={{ padding: "12px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall, fontSize: "13px", color: COLOR.textMid, cursor: state.photo_uploading ? "default" : "pointer", textAlign: "center" }}>
                {state.photo_uploading ? "Uploading…" : "📷 Attach scanner screenshot"}
              </div>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                disabled={state.photo_uploading}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickPhoto(f);
                }}
              />
            </label>
          )}
          {state.photo_error && (
            <div style={{ fontSize: "12px", color: COLOR.danger, marginTop: "4px" }}>
              {state.photo_error}
            </div>
          )}
        </div>

        {/* Field groups */}
        {GROUPS.map((g) => (
          <div key={g.group} style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>
              {g.group}
            </div>
            {g.fields.map(({ key, label }) => {
              const v = state.values[key];
              const oor = isOutOfSoftRange(v);
              return (
                <label key={key} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "8px", alignItems: "center", padding: "8px 12px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall, marginBottom: "4px", border: `1px solid ${oor ? COLOR.danger : "transparent"}` }}>
                  <span style={{ fontSize: "13px", color: COLOR.textStrong }}>{label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={v}
                    onChange={(e) =>
                      setState((s) => ({
                        ...s,
                        values: { ...s.values, [key]: e.target.value },
                      }))
                    }
                    onFocus={selectOnFocus}
                    style={{
                      width: "70px",
                      textAlign: "right",
                      background: COLOR.surface,
                      border: "none",
                      borderRadius: RADIUS.chip,
                      padding: "6px 8px",
                      fontSize: "13px",
                      color: COLOR.textStrong,
                    }}
                  />
                  <span style={{ fontSize: "11px", color: COLOR.textMuted }}>cm</span>
                </label>
              );
            })}
            {g.fields.some((f) => isOutOfSoftRange(state.values[f.key])) && (
              <div style={{ fontSize: "11px", color: COLOR.danger, marginTop: "2px" }}>
                Unusual value — double-check before saving.
              </div>
            )}
          </div>
        ))}

        {/* Notes */}
        <label style={{ display: "block", marginTop: "8px", marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
            Notes (optional)
          </div>
          <textarea
            value={state.notes}
            onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))}
            rows={3}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: COLOR.surfaceAlt,
              border: "none",
              borderRadius: RADIUS.input,
              fontSize: "13px",
              color: COLOR.textStrong,
              resize: "vertical",
            }}
          />
        </label>
      </div>
    </div>
  );
}
