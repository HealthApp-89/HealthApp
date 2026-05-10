"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["sleep_recovery"];

export function StepSleep({
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

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Sleep & recovery baseline</h2>
      <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 12 }}>
        Pre-filled from your last 30 days of WHOOP data where available.
      </p>

      <Group label="Sleep">
        <TextField
          label="Average sleep hours"
          type="number"
          value={value.avg_sleep_hours}
          onChange={(s) => patch("avg_sleep_hours", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Typical bedtime"
          type="time"
          value={value.typical_bedtime}
          onChange={(s) => patch("typical_bedtime", s)}
        />
        <TextField
          label="Typical wake time"
          type="time"
          value={value.typical_wake_time}
          onChange={(s) => patch("typical_wake_time", s)}
        />
        <TextField
          label="Sleep latency (min — how long to fall asleep)"
          type="number"
          value={value.sleep_latency_minutes}
          onChange={(s) => patch("sleep_latency_minutes", Number(s) || 0)}
        />
        <Select
          label="Awakenings per night"
          value={value.awakenings}
          onChange={(v) => patch("awakenings", v)}
          options={[["none", "None"], ["1_2", "1-2"], ["3_plus", "3+"]]}
        />
      </Group>

      <Group label="Recovery">
        <TextArea
          label="Mobility / flexibility work currently done (free-text)"
          value={value.mobility_work}
          onChange={(v) => patch("mobility_work", v)}
          rows={2}
        />
        <Select
          label="Soreness frequency"
          value={value.soreness_frequency}
          onChange={(v) => patch("soreness_frequency", v)}
          options={[["rare", "Rare"], ["common", "Common"], ["always", "Always"]]}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
