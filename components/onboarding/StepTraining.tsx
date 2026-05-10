"use client";
import type { IntakePayload } from "@/lib/data/types";
import type { RecentE1RMs } from "@/lib/query/fetchers/recentE1RMs";
import { Group, Select, TextField, TextArea, Toggle } from "@/components/onboarding/_fields";
import { WizardNav } from "@/components/onboarding/WizardNav";

type V = IntakePayload["training"];

export function StepTraining({
  value, recentE1RMs, onChange, onBack, onNext, step, totalSteps, fieldErrors: _fe,
}: {
  value: V;
  recentE1RMs: RecentE1RMs;
  onChange: (v: V) => void;
  onBack: () => void;
  onNext: () => void;
  step: number;
  totalSteps: number;
  fieldErrors: Record<string, string>;
}) {
  function patch<K extends keyof V>(k: K, v: V[K]) { onChange({ ...value, [k]: v }); }
  function patchEq<K extends keyof V["equipment"]>(k: K, v: V["equipment"][K]) {
    onChange({ ...value, equipment: { ...value.equipment, [k]: v } });
  }
  function patchE1RM<K extends keyof V["current_e1rm"]>(k: K, v: V["current_e1rm"][K]) {
    onChange({ ...value, current_e1rm: { ...value.current_e1rm, [k]: v } });
  }
  function patchPR<K extends keyof V["best_ever_pr"]>(k: K, v: V["best_ever_pr"][K]) {
    onChange({ ...value, best_ever_pr: { ...value.best_ever_pr, [k]: v } });
  }
  const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s) || null);

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Training history & equipment</h2>

      <Group label="Background">
        <TextField
          label="Years of consistent lifting"
          type="number"
          value={value.years_lifting}
          onChange={(s) => patch("years_lifting", Number(s) || 0)}
        />
        <Select
          label="Training-age category"
          value={value.training_age}
          onChange={(v) => patch("training_age", v)}
          options={[["beginner", "Beginner"], ["intermediate", "Intermediate"], ["advanced", "Advanced"]]}
        />
        <TextField
          label="Sessions per week"
          type="number"
          value={value.sessions_per_week}
          onChange={(s) => patch("sessions_per_week", Number(s) || 0)}
          prefilled={recentE1RMs.sessions_per_week_estimate !== null}
        />
        <TextField
          label="Typical session length (minutes)"
          type="number"
          value={value.typical_session_minutes}
          onChange={(s) => patch("typical_session_minutes", Number(s) || 0)}
        />
      </Group>

      <Group label="Equipment access">
        {[
          ["barbell", "Barbell"], ["rack", "Squat rack"], ["bench", "Bench"],
          ["dumbbells", "Dumbbells"], ["cables", "Cables"], ["machines", "Machines"],
          ["platform", "Deadlift platform"], ["ghd", "GHD"], ["sled", "Sled"],
          ["treadmill", "Treadmill"], ["rower", "Rower"], ["bike", "Bike"],
          ["kettlebells", "Kettlebells"], ["bands", "Bands"],
        ].map(([k, label]) => (
          <Toggle
            key={k}
            label={label as string}
            checked={value.equipment[k as keyof V["equipment"]] as boolean}
            onChange={(c) => patchEq(k as keyof V["equipment"], c as never)}
          />
        ))}
        <TextArea
          label="Other equipment (free-text)"
          value={value.equipment.other}
          onChange={(v) => patchEq("other", v)}
          rows={1}
        />
      </Group>

      <Group label="Current strength (e1RM)">
        <p style={{ fontSize: 12, color: "var(--color-text-muted, #888)", marginBottom: 4 }}>
          Pre-filled from recent workouts. Adjust if the auto-detected lifts are wrong.
        </p>
        {(["squat", "bench", "deadlift", "ohp"] as const).map((lift) => (
          <TextField
            key={lift}
            label={`${lift.toUpperCase()} (kg, blank if N/A)`}
            type="number"
            value={value.current_e1rm[lift] ?? ""}
            onChange={(s) => patchE1RM(lift, numOrNull(s))}
            prefilled={recentE1RMs[lift] !== null}
          />
        ))}
      </Group>

      <Group label="Best ever PRs (optional)">
        {(["squat", "bench", "deadlift", "ohp"] as const).map((lift) => (
          <TextField
            key={lift}
            label={`${lift.toUpperCase()} all-time PR (kg, blank if N/A)`}
            type="number"
            value={value.best_ever_pr[lift] ?? ""}
            onChange={(s) => patchPR(lift, numOrNull(s))}
          />
        ))}
      </Group>

      <Group label="History">
        <TextArea
          label="Previous programs run"
          value={value.previous_programs}
          onChange={(v) => patch("previous_programs", v)}
          rows={2}
        />
        <TextArea
          label="Recent plateaus or sticking points"
          value={value.recent_plateaus}
          onChange={(v) => patch("recent_plateaus", v)}
          rows={2}
        />
      </Group>

      <WizardNav step={step} totalSteps={totalSteps} onBack={onBack} onNext={onNext} />
    </section>
  );
}
