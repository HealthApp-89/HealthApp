"use client";
import { COLOR } from "@/lib/ui/theme";
import type { IntakePayload } from "@/lib/data/types";
import { WizardNav } from "@/components/onboarding/WizardNav";
import {
  Group,
  Toggle,
  Select,
  TextArea,
  inputStyle,
  addBtnStyle,
  removeBtnStyle,
} from "@/components/onboarding/_fields";

type HealthValue = IntakePayload["health"];

export function StepHealth({
  value,
  onChange,
  onNext,
  step,
  totalSteps,
  fieldErrors: _fieldErrors,
}: {
  value: HealthValue;
  onChange: (next: HealthValue) => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof HealthValue>(key: K, next: HealthValue[K]) {
    onChange({ ...value, [key]: next });
  }
  function patchConditions<K extends keyof HealthValue["conditions"]>(
    key: K,
    next: HealthValue["conditions"][K],
  ) {
    onChange({ ...value, conditions: { ...value.conditions, [key]: next } });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Health &amp; medical</h2>
      <p style={{ fontSize: 13, color: COLOR.textMuted, marginBottom: 16 }}>
        Informational — used for context, not gating. Nothing here will block you from training.
      </p>

      <Group label="Conditions">
        <Toggle
          label="Cardiac history (afib, arrhythmia, prior MI, etc.)"
          checked={value.conditions.cardiac}
          onChange={(c) => patchConditions("cardiac", c)}
        />
        <Toggle
          label="Hypertension"
          checked={value.conditions.hypertension}
          onChange={(c) => patchConditions("hypertension", c)}
        />
        <Select
          label="Diabetes"
          value={value.conditions.diabetes}
          onChange={(v) => patchConditions("diabetes", v as HealthValue["conditions"]["diabetes"])}
          options={[
            ["none", "None"],
            ["type1", "Type 1"],
            ["type2", "Type 2"],
            ["prediabetic", "Pre-diabetic"],
          ]}
        />
        <Toggle
          label="Autoimmune condition"
          checked={value.conditions.autoimmune}
          onChange={(c) => patchConditions("autoimmune", c)}
        />
        <TextArea
          label="Anything else (free-text, optional)"
          value={value.conditions.other}
          onChange={(v) => patchConditions("other", v)}
          rows={2}
        />
      </Group>

      <Group label="Joint surgeries">
        <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 8 }}>
          One row per surgery (joint, year). Leave empty if none.
        </p>
        <RepeatingSurgery
          rows={value.conditions.joint_surgeries}
          onChange={(rows) => patchConditions("joint_surgeries", rows)}
        />
      </Group>

      <Group label="Active medications (training-relevant)">
        <TextArea
          label="Beta-blockers, stimulants, GLP-1s, etc. (free-text, blank if none)"
          value={value.medications}
          onChange={(v) => patch("medications", v)}
          rows={2}
        />
      </Group>

      <Group label="Recent illness or injury (last 12 months)">
        <TextArea
          label="Free-text (blank if nothing notable)"
          value={value.recent_illness_injury}
          onChange={(v) => patch("recent_illness_injury", v)}
          rows={2}
        />
      </Group>

      <Group label="Active injuries / movement restrictions">
        <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 8 }}>
          One row per restriction (e.g., &quot;left shoulder — no overhead pressing &gt; 60kg&quot;).
        </p>
        <RepeatingRestriction
          rows={value.active_injuries}
          onChange={(rows) => patch("active_injuries", rows)}
        />
      </Group>

      <Group label="Training-relevant allergies">
        <TextArea
          label="Latex/iodine, supplement allergies, etc. (blank if none)"
          value={value.allergies}
          onChange={(v) => patch("allergies", v)}
          rows={2}
        />
      </Group>

      <WizardNav
        step={step}
        totalSteps={totalSteps}
        onBack={null}
        onNext={onNext}
      />
    </section>
  );
}

// ── Repeating sub-components ─────────────────────────────────────────────────

function RepeatingSurgery({
  rows,
  onChange,
}: {
  rows: HealthValue["conditions"]["joint_surgeries"];
  onChange: (rows: HealthValue["conditions"]["joint_surgeries"]) => void;
}) {
  function set(idx: number, patch: Partial<HealthValue["conditions"]["joint_surgeries"][number]>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([...rows, { joint: "", year: new Date().getFullYear(), notes: "" }]);
  }
  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="Joint (e.g., left knee)"
            value={r.joint}
            onChange={(e) => set(i, { joint: e.target.value })}
            style={inputStyle({ flex: 2 })}
          />
          <input
            type="number"
            placeholder="Year"
            value={r.year}
            onChange={(e) => set(i, { year: Number(e.target.value) || 0 })}
            style={inputStyle({ flex: 1 })}
          />
          <button type="button" onClick={() => remove(i)} style={removeBtnStyle()}>×</button>
        </div>
      ))}
      <button type="button" onClick={add} style={addBtnStyle()}>+ Add surgery</button>
    </div>
  );
}

function RepeatingRestriction({
  rows,
  onChange,
}: {
  rows: HealthValue["active_injuries"];
  onChange: (rows: HealthValue["active_injuries"]) => void;
}) {
  function set(idx: number, patch: Partial<HealthValue["active_injuries"][number]>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([...rows, { joint: "", restriction: "" }]);
  }
  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="Joint"
            value={r.joint}
            onChange={(e) => set(i, { joint: e.target.value })}
            style={inputStyle({ flex: 1 })}
          />
          <input
            type="text"
            placeholder="Restriction (free-text)"
            value={r.restriction}
            onChange={(e) => set(i, { restriction: e.target.value })}
            style={inputStyle({ flex: 2 })}
          />
          <button type="button" onClick={() => remove(i)} style={removeBtnStyle()}>×</button>
        </div>
      ))}
      <button type="button" onClick={add} style={addBtnStyle()}>+ Add restriction</button>
    </div>
  );
}
