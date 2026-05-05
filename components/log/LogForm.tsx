"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveDailyLog } from "@/app/log/actions";
import type { DailyLog } from "@/lib/data/types";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR, SHADOW } from "@/lib/ui/theme";

const SECTIONS: { title: string; color: string; fields: { k: keyof DailyLog; l: string; u: string }[] }[] = [
  {
    title: "Recovery",
    color: "#4f5dff",
    fields: [
      { k: "hrv", l: "HRV", u: "ms" },
      { k: "resting_hr", l: "Resting HR", u: "bpm" },
      { k: "spo2", l: "SpO2", u: "%" },
      { k: "skin_temp_c", l: "Skin Temp", u: "C" },
      { k: "respiratory_rate", l: "Resp Rate", u: "br/min" },
    ],
  },
  {
    title: "Sleep",
    color: "#a855f7",
    fields: [
      { k: "sleep_hours", l: "Sleep", u: "hrs" },
      { k: "sleep_score", l: "Sleep Score", u: "/100" },
      { k: "deep_sleep_hours", l: "Deep", u: "hrs" },
      { k: "rem_sleep_hours", l: "REM", u: "hrs" },
    ],
  },
  {
    title: "Training",
    color: "#f59e0b",
    fields: [
      { k: "steps", l: "Steps", u: "" },
      { k: "distance_km", l: "Distance", u: "km" },
      { k: "active_calories", l: "Active Cal", u: "kcal" },
      { k: "calories", l: "Total Cal", u: "kcal" },
      { k: "exercise_min", l: "Exercise", u: "min" },
      { k: "strain", l: "Strain", u: "/21" },
    ],
  },
  {
    title: "Nutrition",
    color: "#ca8a04",
    fields: [
      { k: "calories_eaten", l: "Eaten", u: "kcal" },
      { k: "protein_g", l: "Protein", u: "g" },
      { k: "carbs_g", l: "Carbs", u: "g" },
      { k: "fat_g", l: "Fat", u: "g" },
    ],
  },
  {
    title: "Body",
    color: "#8b5cf6",
    fields: [
      { k: "weight_kg", l: "Weight", u: "kg" },
      { k: "body_fat_pct", l: "Body Fat", u: "%" },
      { k: "fat_mass_kg", l: "Fat Mass", u: "kg" },
      { k: "fat_free_mass_kg", l: "Lean Mass", u: "kg" },
      { k: "muscle_mass_kg", l: "Muscle", u: "kg" },
      { k: "bone_mass_kg", l: "Bone", u: "%" },
      { k: "hydration_kg", l: "Hydration", u: "kg" },
    ],
  },
];

const ENERGY_OPTIONS = ["Low", "Medium", "High"] as const;
const MOOD_OPTIONS = ["😔", "😐", "😊", "🔥"] as const;
const READINESS_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

type CheckinState = {
  readiness: number | null;
  energy_label: string;
  mood: string;
  soreness: string;
  feel_notes: string;
};

type Props = {
  date: string;
  initialLog: Partial<DailyLog> | null;
  initialCheckin: {
    readiness: number | null;
    energy_label: string | null;
    mood: string | null;
    soreness: string | null;
    feel_notes: string | null;
  } | null;
};

export function LogForm({ date, initialLog, initialCheckin }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);

  const [feel, setFeel] = useState<CheckinState>({
    readiness: initialCheckin?.readiness ?? null,
    energy_label: initialCheckin?.energy_label ?? "",
    mood: initialCheckin?.mood ?? "",
    soreness: initialCheckin?.soreness ?? "",
    feel_notes: initialCheckin?.feel_notes ?? "",
  });

  function onSubmit(formData: FormData) {
    // feel_* values are injected via hidden inputs in the DOM; no manual injection needed.
    setFlash(null);
    startTransition(async () => {
      try {
        await saveDailyLog(formData);
        setFlash("✓ Saved");
      } catch (e) {
        setFlash(`✗ ${(e as Error).message}`);
      }
    });
  }

  function onDateChange(next: string) {
    if (!next || next === date) return;
    router.push(`/log?date=${next}`);
  }

  function val(k: keyof DailyLog): string {
    const v = initialLog?.[k];
    if (v === null || v === undefined) return "";
    return String(v);
  }

  const sourceLabel = initialLog?.source ?? null;

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: COLOR.surfaceAlt,
    border: "none",
    borderRadius: "10px",
    padding: "9px 10px",
    fontSize: "13px",
    color: COLOR.textStrong,
    fontFamily: "inherit",
    boxSizing: "border-box",
    outline: "none",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    // key={date} forces React to remount the form on every date navigation.
    // Inputs use uncontrolled `defaultValue`, which only reads on mount — without
    // the key, switching dates would leave every field showing the previous day's
    // values even though the page has already fetched fresh data.
    <form key={date} action={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <input type="hidden" name="date" value={date} />

      {/* Date picker */}
      <Card variant="standard">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <label
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                fontWeight: 600,
                color: COLOR.textMuted,
              }}
            >
              Log date
            </label>
            <input
              type="date"
              value={date}
              max={TODAY_ISO()}
              onChange={(e) => onDateChange(e.target.value)}
              style={{
                ...inputStyle,
                width: "auto",
                padding: "7px 10px",
                fontSize: "12px",
              }}
            />
          </div>
          {sourceLabel && (
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontSize: "9px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: COLOR.textFaint,
                }}
              >
                Source
              </div>
              <div
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-dm-mono, monospace)",
                  color: COLOR.textMid,
                  marginTop: "2px",
                }}
              >
                {sourceLabel}
              </div>
            </div>
          )}
        </div>
      </Card>

      {flash && (
        <div
          style={{
            borderRadius: "10px",
            padding: "10px 14px",
            fontSize: "12px",
            fontWeight: 600,
            background: flash.startsWith("✗") ? COLOR.dangerSoft : COLOR.accentSoft,
            color: flash.startsWith("✗") ? COLOR.danger : COLOR.accent,
          }}
        >
          {flash}
        </div>
      )}

      {/* Metric sections */}
      {SECTIONS.map((s) => (
        <Card key={s.title} variant="standard">
          <SectionLabel color={s.color}>{s.title}</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            {s.fields.map((f) => (
              <NumField key={f.k as string} name={String(f.k)} label={f.l} unit={f.u} defaultValue={val(f.k)} />
            ))}
          </div>
        </Card>
      ))}

      {/* Morning Feel */}
      <Card variant="standard">
        <SectionLabel color={COLOR.accent}>🌅 Morning Feel</SectionLabel>

        {/* Readiness 1–10 grid */}
        <div style={{ marginBottom: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "6px",
            }}
          >
            Readiness
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "4px" }}>
            {READINESS_NUMS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setFeel((f) => ({ ...f, readiness: n }))}
                style={{
                  aspectRatio: "1",
                  background: feel.readiness === n ? COLOR.accent : COLOR.surfaceAlt,
                  color: feel.readiness === n ? "#fff" : COLOR.textMuted,
                  borderRadius: "7px",
                  border: "none",
                  fontSize: "11px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {n}
              </button>
            ))}
          </div>
          {/* Hidden input so the value is in formData on the first render too */}
          <input type="hidden" name="feel_readiness" value={feel.readiness ?? ""} />
        </div>

        {/* Energy */}
        <div style={{ marginBottom: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "6px",
            }}
          >
            Energy
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {ENERGY_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setFeel((f) => ({ ...f, energy_label: f.energy_label === opt ? "" : opt }))}
                style={{
                  flex: 1,
                  background: feel.energy_label === opt ? COLOR.accent : COLOR.surfaceAlt,
                  color: feel.energy_label === opt ? "#fff" : COLOR.textMuted,
                  borderRadius: "8px",
                  border: "none",
                  padding: "8px 0",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {opt}
              </button>
            ))}
          </div>
          <input type="hidden" name="feel_energy" value={feel.energy_label} />
        </div>

        {/* Mood */}
        <div style={{ marginBottom: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "6px",
            }}
          >
            Mood
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {MOOD_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setFeel((f) => ({ ...f, mood: f.mood === opt ? "" : opt }))}
                style={{
                  flex: 1,
                  background: feel.mood === opt ? COLOR.accent : COLOR.surfaceAlt,
                  color: feel.mood === opt ? "#fff" : COLOR.textMuted,
                  borderRadius: "8px",
                  border: "none",
                  padding: "8px 0",
                  fontSize: "16px",
                  cursor: "pointer",
                }}
              >
                {opt}
              </button>
            ))}
          </div>
          <input type="hidden" name="feel_mood" value={feel.mood} />
        </div>

        {/* Soreness */}
        <div>
          <label
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              display: "block",
              marginBottom: "6px",
            }}
          >
            Soreness
          </label>
          <input
            name="feel_soreness"
            type="text"
            value={feel.soreness}
            onChange={(e) => setFeel((f) => ({ ...f, soreness: e.target.value }))}
            placeholder="Legs, lower back…"
            style={inputStyle}
          />
        </div>
      </Card>

      {/* Notes */}
      <Card variant="standard">
        <label
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontWeight: 600,
            color: COLOR.textMuted,
            display: "block",
            marginBottom: "8px",
          }}
        >
          Notes
        </label>
        <textarea
          name="notes"
          defaultValue={initialLog?.notes ?? ""}
          placeholder="Workout details, meals, anything…"
          rows={4}
          style={{
            ...inputStyle,
            resize: "vertical",
          }}
        />
      </Card>

      <button
        type="submit"
        disabled={pending}
        style={{
          width: "100%",
          marginTop: "4px",
          padding: "11px",
          background: COLOR.accent,
          color: "#fff",
          border: "none",
          borderRadius: "12px",
          fontSize: "13px",
          fontWeight: 700,
          boxShadow: SHADOW.heroAccent,
          opacity: pending ? 0.5 : 1,
          cursor: pending ? "default" : "pointer",
        }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function NumField({
  name,
  label,
  unit,
  defaultValue,
  type = "number",
}: {
  name: string;
  label: string;
  unit: string;
  defaultValue?: string;
  type?: "number" | "text";
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 600,
          color: COLOR.textMuted,
        }}
      >
        {label}
        {unit && (
          <span style={{ color: COLOR.textFaint, marginLeft: "2px" }}>{unit}</span>
        )}
      </label>
      <input
        name={name}
        type={type}
        step="any"
        defaultValue={defaultValue}
        placeholder="—"
        style={{
          background: COLOR.surfaceAlt,
          border: "none",
          borderRadius: "10px",
          padding: "9px 10px",
          fontSize: "13px",
          color: COLOR.textStrong,
          fontFamily: "inherit",
          fontVariantNumeric: "tabular-nums",
          outline: "none",
          width: "100%",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
