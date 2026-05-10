"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea, Toggle } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["lifestyle"];

export function StepLifestyle({
  value, onChange, onBack, onNext, step, totalSteps, fieldErrors: _fe,
}: {
  value: V;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }
  function patchDay(k: keyof V["days_available"], c: boolean) {
    onChange({ ...value, days_available: { ...value.days_available, [k]: c } });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Lifestyle & schedule</h2>

      <Group label="Work & life">
        <Select
          label="Job demands"
          value={value.job_demands}
          onChange={(v) => patch("job_demands", v)}
          options={[
            ["sedentary", "Sedentary (desk)"],
            ["mixed", "Mixed"],
            ["active", "Active (on feet)"],
            ["labor", "Heavy labor"],
          ]}
        />
        <TextField
          label="Commute (minutes / day total)"
          type="number"
          value={value.commute_minutes}
          onChange={(s) => patch("commute_minutes", Number(s) || 0)}
        />
        <Toggle
          label="I have dependents (kids, caregiving, etc.)"
          checked={value.has_dependents}
          onChange={(c) => patch("has_dependents", c)}
        />
        {value.has_dependents && (
          <TextArea
            label="Notes (optional — ages, schedule constraints)"
            value={value.dependent_notes}
            onChange={(v) => patch("dependent_notes", v)}
            rows={2}
          />
        )}
        <Select
          label="Average stress level (1=low, 5=high)"
          value={String(value.stress_self_rating) as "1" | "2" | "3" | "4" | "5"}
          onChange={(v) => patch("stress_self_rating", Number(v) as V["stress_self_rating"])}
          options={[["1", "1 — Low"], ["2", "2"], ["3", "3 — Moderate"], ["4", "4"], ["5", "5 — High"]]}
        />
      </Group>

      <Group label="Training availability">
        <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 4 }}>
          Which days can you realistically train?
        </p>
        {([["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"],
            ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]] as const).map(([k, label]) => (
          <Toggle key={k} label={label} checked={value.days_available[k]} onChange={(c) => patchDay(k, c)} />
        ))}
        <TextField
          label="Earliest possible session time"
          type="time"
          value={value.earliest_session_time}
          onChange={(s) => patch("earliest_session_time", s)}
        />
        <TextField
          label="Latest possible session time"
          type="time"
          value={value.latest_session_time}
          onChange={(s) => patch("latest_session_time", s)}
        />
      </Group>

      <Group label="Travel">
        <Select
          label="Travel frequency"
          value={value.travel_frequency}
          onChange={(v) => patch("travel_frequency", v)}
          options={[["none", "None"], ["rare", "Rare"], ["monthly", "Monthly"], ["weekly", "Weekly+"]]}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
