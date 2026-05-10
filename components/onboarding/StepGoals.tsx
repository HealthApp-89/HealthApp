"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";
import { COLOR } from "@/lib/ui/theme";

type V = IntakePayload["goals"];

export function StepGoals({
  value, onChange, onBack, onNext, nextLabel, nextDisabled, step, totalSteps, fieldErrors,
}: {
  value: V;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }

  const whyError = fieldErrors["goals.why_narrative"];
  const whyTooShort = value.why_narrative.trim().length < 10;

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Your goal</h2>
      <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 12 }}>
        One primary goal. The &quot;why&quot; matters as much as the metric — say it in your own words.
      </p>

      <Group label="What kind of goal">
        <Select
          label="Primary goal type"
          value={value.primary_type}
          onChange={(v) => patch("primary_type", v)}
          options={[
            ["strength", "Strength"],
            ["body_comp", "Body composition"],
            ["performance", "Performance / endurance"],
            ["health", "Health"],
          ]}
        />
      </Group>

      <Group label="Target">
        <TextField
          label="Primary metric (e.g., &quot;deadlift e1RM&quot;, &quot;body fat %&quot;, &quot;5K time&quot;)"
          type="text"
          value={value.primary_metric}
          onChange={(s) => patch("primary_metric", s)}
        />
        <TextField
          label="Target value"
          type="number"
          value={value.target_value}
          onChange={(s) => patch("target_value", Number(s) || 0)}
        />
        <TextField
          label="Unit (kg, %, min:sec, etc.)"
          type="text"
          value={value.target_unit}
          onChange={(s) => patch("target_unit", s)}
        />
        <TextField
          label="Target date"
          type="date"
          value={value.target_date}
          onChange={(s) => patch("target_date", s)}
        />
      </Group>

      <Group label="Why this goal? What does success look like?">
        <TextArea
          label="(required — at least one sentence)"
          value={value.why_narrative}
          onChange={(v) => patch("why_narrative", v)}
          rows={5}
        />
        {(whyError || (whyTooShort && value.why_narrative.length > 0)) && (
          <span style={{ fontSize: 12, color: COLOR.danger }}>
            {whyError ?? "Add a sentence or two — what's behind this goal?"}
          </span>
        )}
      </Group>

      <WizardNav
        step={step}
        totalSteps={totalSteps}
        onBack={onBack}
        onNext={onNext}
        nextLabel={nextLabel ?? "Review profile"}
        nextDisabled={(nextDisabled ?? false) || whyTooShort}
      />
    </section>
  );
}
