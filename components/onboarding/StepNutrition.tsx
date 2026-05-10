"use client";
import type { IntakePayload } from "@/lib/data/types";
import { Group, Select, TextField, TextArea } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["nutrition"];

export function StepNutrition({
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
  function patchM<K extends keyof V["current_macros"]>(k: K, v: V["current_macros"][K]) {
    onChange({ ...value, current_macros: { ...value.current_macros, [k]: v } });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Nutrition baseline</h2>
      <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 12 }}>
        Pre-filled from your last 7 days of Yazio data where available. Tweak as needed.
      </p>

      <Group label="Phase">
        <Select
          label="Current diet phase"
          value={value.current_phase}
          onChange={(v) => patch("current_phase", v)}
          options={[
            ["cut", "Cut"], ["maintain", "Maintain"], ["lean_bulk", "Lean bulk"],
            ["recomp", "Recomp"], ["unsure", "Unsure"],
          ]}
        />
      </Group>

      <Group label="Daily targets">
        <TextField
          label="Calorie target (kcal/day)"
          type="number"
          value={value.current_kcal}
          onChange={(s) => patch("current_kcal", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Protein (g/day)"
          type="number"
          value={value.current_macros.protein_g}
          onChange={(s) => patchM("protein_g", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Carbs (g/day)"
          type="number"
          value={value.current_macros.carb_g}
          onChange={(s) => patchM("carb_g", Number(s) || 0)}
          prefilled
        />
        <TextField
          label="Fat (g/day)"
          type="number"
          value={value.current_macros.fat_g}
          onChange={(s) => patchM("fat_g", Number(s) || 0)}
          prefilled
        />
      </Group>

      <Group label="Tracking & restrictions">
        <Select
          label="Tracking experience"
          value={value.tracking_experience}
          onChange={(v) => patch("tracking_experience", v)}
          options={[["none", "None"], ["on_off", "On and off"], ["consistent", "Consistent"]]}
        />
        <TextArea
          label="Dietary restrictions (style + allergies + religious + intolerances)"
          value={value.restrictions}
          onChange={(v) => patch("restrictions", v)}
          rows={3}
        />
      </Group>

      <Group label="Stimulants">
        <TextField
          label="Alcohol (drinks per week)"
          type="number"
          value={value.alcohol_drinks_per_week}
          onChange={(s) => patch("alcohol_drinks_per_week", Number(s) || 0)}
        />
        <TextField
          label="Caffeine (mg per day estimate)"
          type="number"
          value={value.caffeine_mg_per_day}
          onChange={(s) => patch("caffeine_mg_per_day", Number(s) || 0)}
        />
      </Group>

      <Group label="Supplements">
        <TextArea
          label="Free-text — creatine, protein powder, vitamins, etc."
          value={value.supplements}
          onChange={(v) => patch("supplements", v)}
          rows={2}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
