"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveDailyLog } from "@/app/log/actions";
import type { DailyLog } from "@/lib/data/types";

const SECTIONS: { title: string; color: string; fields: { k: keyof DailyLog; l: string; u: string }[] }[] = [
  {
    title: "Recovery",
    color: "#00f5c4",
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
    color: "#a29bfe",
    fields: [
      { k: "sleep_hours", l: "Sleep", u: "hrs" },
      { k: "sleep_score", l: "Sleep Score", u: "/100" },
      { k: "deep_sleep_hours", l: "Deep", u: "hrs" },
      { k: "rem_sleep_hours", l: "REM", u: "hrs" },
    ],
  },
  {
    title: "Training",
    color: "#ff9f43",
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
    color: "#ffd93d",
    fields: [
      { k: "calories_eaten", l: "Eaten", u: "kcal" },
      { k: "protein_g", l: "Protein", u: "g" },
      { k: "carbs_g", l: "Carbs", u: "g" },
      { k: "fat_g", l: "Fat", u: "g" },
    ],
  },
  {
    title: "Body",
    color: "#4fc3f7",
    fields: [
      { k: "weight_kg", l: "Weight", u: "kg" },
      { k: "body_fat_pct", l: "Body Fat", u: "%" },
      { k: "fat_mass_kg", l: "Fat Mass", u: "kg" },
      { k: "fat_free_mass_kg", l: "Lean Mass", u: "kg" },
      { k: "muscle_mass_kg", l: "Muscle", u: "kg" },
      { k: "bone_mass_kg", l: "Bone", u: "kg" },
      { k: "hydration_kg", l: "Hydration", u: "kg" },
    ],
  },
];

const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

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

  function onSubmit(formData: FormData) {
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
    // Server reload picks up the new ?date= and refetches that day's row.
    router.push(`/log?date=${next}`);
  }

  function val(k: keyof DailyLog): string {
    const v = initialLog?.[k];
    if (v === null || v === undefined) return "";
    return String(v);
  }

  const sourceLabel = initialLog?.source ?? null;

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="date" value={date} />

      {/* Date picker — navigate to any day, defaults to today, blocked from the future */}
      <div
        className="rounded-[14px] px-4 py-3 flex items-center justify-between gap-3"
        style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-[0.12em] text-white/40">Log date</label>
          <input
            type="date"
            value={date}
            max={TODAY_ISO()}
            onChange={(e) => onDateChange(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm font-mono outline-none focus:border-emerald-300/50 text-white"
          />
        </div>
        {sourceLabel && (
          <div className="text-right">
            <div className="text-[9px] uppercase tracking-[0.08em] text-white/35">Source</div>
            <div className="text-[11px] font-mono text-white/70 mt-0.5">{sourceLabel}</div>
          </div>
        )}
      </div>

      {flash && (
        <div
          className="rounded-[10px] px-3.5 py-2.5 text-xs font-medium"
          style={{
            background: flash.startsWith("✗") ? "rgba(255,107,107,0.12)" : "rgba(0,245,196,0.1)",
            border: `1px solid ${flash.startsWith("✗") ? "rgba(255,107,107,0.3)" : "rgba(0,245,196,0.25)"}`,
            color: flash.startsWith("✗") ? "#ff6b6b" : "#00f5c4",
          }}
        >
          {flash}
        </div>
      )}

      {SECTIONS.map((s) => (
        <div
          key={s.title}
          className="rounded-[14px] px-4 py-3.5"
          style={{ background: "rgba(255,255,255,0.025)", border: `1px solid ${s.color}18` }}
        >
          <div
            className="text-[10px] uppercase tracking-[0.12em] mb-3"
            style={{ color: `${s.color}cc` }}
          >
            {s.title}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {s.fields.map((f) => (
              <NumField key={f.k as string} name={String(f.k)} label={f.l} unit={f.u} defaultValue={val(f.k)} />
            ))}
          </div>
        </div>
      ))}

      {/* Morning feel */}
      <div
        className="rounded-[14px] px-4 py-3.5"
        style={{ background: "rgba(255,255,255,0.025)", border: "1px solid #00f5c418" }}
      >
        <div className="text-[10px] uppercase tracking-[0.12em] mb-3" style={{ color: "#00f5c4cc" }}>
          🌅 Morning Feel
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <NumField
            name="feel_readiness"
            label="Readiness"
            unit="/10"
            defaultValue={initialCheckin?.readiness?.toString() ?? ""}
          />
          <SelectField
            name="feel_energy"
            label="Energy"
            options={["", "Low", "Medium", "High"]}
            defaultValue={initialCheckin?.energy_label ?? ""}
          />
          <SelectField
            name="feel_mood"
            label="Mood"
            options={["", "😔", "😐", "😊", "🔥"]}
            defaultValue={initialCheckin?.mood ?? ""}
          />
          <NumField
            name="feel_soreness"
            label="Soreness"
            unit=""
            defaultValue={initialCheckin?.soreness ?? ""}
            type="text"
          />
        </div>
      </div>

      {/* Notes */}
      <div
        className="rounded-[14px] px-4 py-3.5"
        style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <label className="text-[10px] uppercase tracking-[0.12em] text-white/35 block mb-2">Notes</label>
        <textarea
          name="notes"
          defaultValue={initialLog?.notes ?? ""}
          placeholder="Workout details, meals, anything…"
          rows={4}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 outline-none focus:border-emerald-300/50 resize-y"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="self-end rounded-xl px-5 py-3 text-sm font-bold disabled:opacity-50"
        style={{
          background: "rgba(0,245,196,0.15)",
          border: "1px solid #00f5c455",
          color: "#00f5c4",
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
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-[0.08em] text-white/40">
        {label}
        {unit && <span className="text-white/20 ml-0.5">{unit}</span>}
      </label>
      <input
        name={name}
        type={type}
        step="any"
        defaultValue={defaultValue}
        placeholder="—"
        className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm font-mono outline-none focus:border-emerald-300/50"
      />
    </div>
  );
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: string[];
  defaultValue: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-[0.08em] text-white/40">{label}</label>
      <select
        name={name}
        defaultValue={defaultValue}
        className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm font-mono outline-none focus:border-emerald-300/50"
      >
        {options.map((o) => (
          <option key={o || "_"} value={o} className="bg-[#0d1628]">
            {o || "—"}
          </option>
        ))}
      </select>
    </div>
  );
}
