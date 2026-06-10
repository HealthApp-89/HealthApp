"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveDailyLog } from "@/lib/log/actions";
import type { DailyLog } from "@/lib/data/types";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { selectOnFocus } from "@/lib/ui/inputs";
import { useUserToday } from "@/lib/query/hooks/useUserToday";

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

const ENERGY_OPTIONS = ["low", "medium", "high"] as const;
const MOOD_OPTIONS = ["😔", "😐", "😊", "🔥"] as const;
const READINESS_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const FATIGUE_OPTIONS = ["none", "some", "heavy"] as const;
const SORENESS_AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;
const SORENESS_SEVERITY_OPTIONS = ["mild", "sharp"] as const;

type CheckinState = {
  readiness: number | null;
  energy_label: string;
  mood: string;
  soreness: string;
  feel_notes: string;
  sick: boolean;
  sickness_notes: string;
  fatigue: string; // '' | 'none' | 'some' | 'heavy'
  bloating: boolean | null;
  soreness_areas: string[];
  soreness_severity: string; // '' | 'mild' | 'sharp'
};

type Props = {
  userId: string;
  date: string;
  initialLog: Partial<DailyLog> | null;
  initialCheckin: {
    readiness: number | null;
    energy_label: string | null;
    mood: string | null;
    soreness: string | null;
    feel_notes: string | null;
    sick: boolean | null;
    sickness_notes: string | null;
    fatigue: string | null;
    bloating: boolean | null;
    soreness_areas: string[] | null;
    soreness_severity: string | null;
  } | null;
};

export function LogForm({ userId, date, initialLog, initialCheckin }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const today = useUserToday(userId);

  const [feel, setFeel] = useState<CheckinState>({
    readiness: initialCheckin?.readiness ?? null,
    energy_label: (initialCheckin?.energy_label ?? "").toLowerCase(),
    mood: initialCheckin?.mood ?? "",
    soreness: initialCheckin?.soreness ?? "",
    feel_notes: initialCheckin?.feel_notes ?? "",
    sick: initialCheckin?.sick ?? false,
    sickness_notes: initialCheckin?.sickness_notes ?? "",
    fatigue: initialCheckin?.fatigue ?? "",
    bloating: initialCheckin?.bloating ?? null,
    soreness_areas: initialCheckin?.soreness_areas ?? [],
    soreness_severity: initialCheckin?.soreness_severity ?? "",
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
              max={today ?? ""}
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
            {ENERGY_OPTIONS.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setFeel((f) => ({ ...f, energy_label: f.energy_label === o ? "" : o }))}
                style={{
                  flex: 1,
                  background: feel.energy_label === o ? COLOR.accent : COLOR.surfaceAlt,
                  color: feel.energy_label === o ? "#fff" : COLOR.textMuted,
                  borderRadius: "8px",
                  border: "none",
                  padding: "8px 0",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {o[0].toUpperCase() + o.slice(1)}
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

        {/* Soreness (legacy free-text) */}
        <div style={{ marginBottom: "14px" }}>
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
            Soreness (notes)
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

        {/* Feel notes */}
        <div style={{ marginBottom: "14px" }}>
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
            Feel notes
          </label>
          <textarea
            name="feel_notes"
            value={feel.feel_notes}
            onChange={(e) => setFeel((f) => ({ ...f, feel_notes: e.target.value }))}
            placeholder="How are you feeling overall?"
            style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }}
          />
        </div>

        {/* Sickness */}
        <div style={{ marginTop: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "8px",
            }}
          >
            Sickness
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: COLOR.textStrong }}>
            <input
              type="checkbox"
              checked={feel.sick}
              onChange={(e) => setFeel((f) => ({ ...f, sick: e.target.checked }))}
            />
            I&apos;m sick today
          </label>
          {feel.sick && (
            <textarea
              placeholder="What's going on? (optional)"
              value={feel.sickness_notes}
              onChange={(e) => setFeel((f) => ({ ...f, sickness_notes: e.target.value }))}
              style={{ ...inputStyle, marginTop: "8px", minHeight: "60px", resize: "vertical" }}
            />
          )}
        </div>

        {/* Fatigue */}
        <div style={{ marginTop: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "8px",
            }}
          >
            Fatigue
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {FATIGUE_OPTIONS.map((o) => (
              <button
                type="button"
                key={o}
                onClick={() => setFeel((f) => ({ ...f, fatigue: f.fatigue === o ? "" : o }))}
                style={{
                  padding: "6px 12px",
                  borderRadius: "999px",
                  background: feel.fatigue === o ? COLOR.accent : COLOR.surfaceAlt,
                  color: feel.fatigue === o ? "#fff" : COLOR.textMuted,
                  border: "none",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {o}
              </button>
            ))}
          </div>
        </div>

        {/* Bloating */}
        <div style={{ marginTop: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "8px",
            }}
          >
            Bloating
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {[
              { label: "No", value: false },
              { label: "Yes", value: true },
            ].map((opt) => (
              <button
                type="button"
                key={opt.label}
                onClick={() => setFeel((f) => ({ ...f, bloating: f.bloating === opt.value ? null : opt.value }))}
                style={{
                  padding: "6px 12px",
                  borderRadius: "999px",
                  background: feel.bloating === opt.value ? COLOR.accent : COLOR.surfaceAlt,
                  color: feel.bloating === opt.value ? "#fff" : COLOR.textMuted,
                  border: "none",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Soreness areas + severity */}
        <div style={{ marginTop: "14px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textMuted,
              fontWeight: 600,
              marginBottom: "8px",
            }}
          >
            Soreness areas
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {SORENESS_AREAS.map((a) => {
              const on = feel.soreness_areas.includes(a);
              return (
                <button
                  type="button"
                  key={a}
                  onClick={() =>
                    setFeel((f) => ({
                      ...f,
                      soreness_areas: on
                        ? f.soreness_areas.filter((x) => x !== a)
                        : [...f.soreness_areas, a],
                    }))
                  }
                  style={{
                    padding: "6px 12px",
                    borderRadius: "999px",
                    background: on ? COLOR.accent : COLOR.surfaceAlt,
                    color: on ? "#fff" : COLOR.textMuted,
                    border: "none",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {a}
                </button>
              );
            })}
          </div>
          {feel.soreness_areas.length > 0 && (
            <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
              {SORENESS_SEVERITY_OPTIONS.map((sev) => (
                <button
                  type="button"
                  key={sev}
                  onClick={() => setFeel((f) => ({ ...f, soreness_severity: f.soreness_severity === sev ? "" : sev }))}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "999px",
                    background: feel.soreness_severity === sev ? COLOR.accent : COLOR.surfaceAlt,
                    color: feel.soreness_severity === sev ? "#fff" : COLOR.textMuted,
                    border: "none",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {sev}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Hidden inputs for feel fields */}
        <input type="hidden" name="feel_sick" value={feel.sick ? "1" : ""} />
        <input type="hidden" name="feel_sickness_notes" value={feel.sickness_notes} />
        <input type="hidden" name="feel_fatigue" value={feel.fatigue} />
        <input
          type="hidden"
          name="feel_bloating"
          value={feel.bloating === null ? "" : feel.bloating ? "1" : "0"}
        />
        <input type="hidden" name="feel_soreness_areas" value={feel.soreness_areas.join(",")} />
        <input type="hidden" name="feel_soreness_severity" value={feel.soreness_severity} />
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
        onFocus={selectOnFocus}
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
