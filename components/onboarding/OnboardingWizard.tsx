"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IntakePayload, AthleteProfileDocument } from "@/lib/data/types";
import type { RecentE1RMs } from "@/lib/query/fetchers/recentE1RMs";
import type { Profile } from "@/lib/data/types";
import type { DailyLog } from "@/lib/data/types";
import { COLOR } from "@/lib/ui/theme";
import {
  createDraftProfile,
  updateDraftProfile,
} from "@/app/onboarding/actions";
import { StepHealth } from "@/components/onboarding/StepHealth";
import { StepTraining } from "@/components/onboarding/StepTraining";
import { StepLifestyle } from "@/components/onboarding/StepLifestyle";
// import { StepNutrition } from "@/components/onboarding/StepNutrition";    // Task 12
// import { StepSleep } from "@/components/onboarding/StepSleep";            // Task 13
// import { StepGoals } from "@/components/onboarding/StepGoals";            // Task 13
// import { ReviewAndAcknowledge } from "@/components/onboarding/ReviewAndAcknowledge"; // Task 14

const TOTAL_STEPS = 6;

export type WizardPrefill = {
  profile: Pick<Profile, "name" | "age" | "height_cm"> | null;
  recentLogs: DailyLog[]; // last 30d for kcal/macro/sleep avgs
  recentE1RMs: RecentE1RMs;
  /** If revising, the prior version's payload to merge as second-precedence
   *  pre-fill (prior > derived > default). */
  priorIntake: IntakePayload | null;
  /** Existing draft (resume) — overrides everything else. */
  existingDraft: AthleteProfileDocument | null;
  nextVersion: number;
  supersedesVersion: number | null;
};

export function OnboardingWizard({ prefill, userId }: { prefill: WizardPrefill; userId: string }) {
  const router = useRouter();
  const [step, setStep] = useState(prefill.existingDraft ? 6 : 1);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [intake, setIntake] = useState<IntakePayload>(() => buildInitialIntake(prefill));
  const [draftId, setDraftId] = useState<string | null>(prefill.existingDraft?.id ?? null);

  function patchIntake<K extends keyof IntakePayload>(key: K, value: IntakePayload[K]) {
    setIntake((prev) => ({ ...prev, [key]: value }));
  }

  function goToReview() {
    setServerError(null);
    setFieldErrors({});
    startTransition(async () => {
      const action = draftId
        ? updateDraftProfile(draftId, intake)
        : createDraftProfile(intake);
      const result = await action;
      if (!result.ok) {
        setServerError(result.error);
        if (result.field_errors) setFieldErrors(result.field_errors);
        return;
      }
      setDraftId(result.id);
      setStep(7); // review
    });
  }

  // Suppress unused-variable warning for goToReview until Step 6 is re-enabled
  void goToReview;
  // Suppress isPending until Step 6 is re-enabled
  void isPending;
  // Suppress router until ReviewAndAcknowledge is re-enabled
  void router;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 16px 32px", color: COLOR.textStrong }}>
      <WizardHeader step={step} totalSteps={TOTAL_STEPS + 1} userId={userId} />
      {serverError && (
        <div
          style={{
            margin: "12px 0",
            padding: "10px 12px",
            background: COLOR.dangerSoft,
            border: `1px solid ${COLOR.danger}`,
            borderRadius: 8,
            color: COLOR.danger,
            fontSize: 13,
          }}
        >
          {serverError}
        </div>
      )}

      {step === 1 && (
        <StepHealth
          value={intake.health}
          onChange={(v) => patchIntake("health", v)}
          onNext={() => setStep(2)}
          step={1}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 2 && (
        <StepTraining
          value={intake.training}
          recentE1RMs={prefill.recentE1RMs}
          onChange={(v) => patchIntake("training", v)}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
          step={2}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {step === 3 && (
        <StepLifestyle
          value={intake.lifestyle}
          onChange={(v) => patchIntake("lifestyle", v)}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
          step={3}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )}
      {/* step === 4 — StepNutrition (Task 12)
      {step === 4 && (
        <StepNutrition
          value={intake.nutrition}
          onChange={(v) => patchIntake("nutrition", v)}
          onBack={() => setStep(3)}
          onNext={() => setStep(5)}
          step={4}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )} */}
      {/* step === 5 — StepSleep (Task 13)
      {step === 5 && (
        <StepSleep
          value={intake.sleep_recovery}
          onChange={(v) => patchIntake("sleep_recovery", v)}
          onBack={() => setStep(4)}
          onNext={() => setStep(6)}
          step={5}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )} */}
      {/* step === 6 — StepGoals (Task 13)
      {step === 6 && (
        <StepGoals
          value={intake.goals}
          onChange={(v) => patchIntake("goals", v)}
          onBack={() => setStep(5)}
          onNext={goToReview}
          nextLabel={isPending ? "Saving…" : "Review profile"}
          nextDisabled={isPending}
          step={6}
          totalSteps={TOTAL_STEPS}
          fieldErrors={fieldErrors}
        />
      )} */}
      {/* step === 7 — ReviewAndAcknowledge (Task 14)
      {step === 7 && draftId && (
        <ReviewAndAcknowledge
          intake={intake}
          draftId={draftId}
          version={prefill.nextVersion}
          supersedesVersion={prefill.supersedesVersion}
          onBack={() => setStep(6)}
          onAcknowledged={() => router.push("/profile")}
        />
      )} */}
    </div>
  );
}

function WizardHeader({ step, totalSteps, userId: _userId }: { step: number; totalSteps: number; userId: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
        Athlete profile
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 2 }}>
        Set up your profile
      </h1>
      <ProgressBar pct={Math.min(100, ((step - 1) / totalSteps) * 100)} />
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        marginTop: 8,
        height: 4,
        background: COLOR.divider,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div style={{ height: "100%", width: `${pct}%`, background: COLOR.accent, transition: "width .25s" }} />
    </div>
  );
}

function buildInitialIntake(prefill: WizardPrefill): IntakePayload {
  if (prefill.existingDraft) {
    return prefill.existingDraft.intake_payload;
  }

  const prior = prefill.priorIntake;
  const last30 = prefill.recentLogs;
  const avg = (vals: Array<number | null | undefined>) => {
    const xs = vals.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const last7 = last30.slice(-7);
  const kcalAvg = avg(last7.map((l) => l.calories_eaten ?? null));
  const proteinAvg = avg(last7.map((l) => l.protein_g ?? null));
  const carbAvg = avg(last7.map((l) => l.carbs_g ?? null));
  const fatAvg = avg(last7.map((l) => l.fat_g ?? null));
  const sleepAvg = avg(last30.map((l) => l.sleep_hours ?? null));

  // Precedence per spec: prior version > auto-derived > defaults.
  const e = prefill.recentE1RMs;
  const trainingAge: IntakePayload["training"]["training_age"] =
    prior?.training.training_age ??
    (yearsLiftingHeuristic(e) >= 5 ? "intermediate" : "beginner");

  return {
    schema_version: 1,
    health: prior?.health ?? {
      conditions: { cardiac: false, hypertension: false, diabetes: "none",
                    autoimmune: false, joint_surgeries: [], other: "" },
      medications: "", recent_illness_injury: "",
      active_injuries: [], allergies: "",
    },
    training: prior?.training ?? {
      years_lifting: 0, training_age: trainingAge,
      sessions_per_week: e.sessions_per_week_estimate ?? 3,
      typical_session_minutes: 60,
      equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                   cables: true, machines: true, platform: false, ghd: false,
                   sled: false, treadmill: true, rower: false, bike: false,
                   kettlebells: false, bands: false, other: "" },
      current_e1rm: { squat: e.squat, bench: e.bench, deadlift: e.deadlift, ohp: e.ohp },
      best_ever_pr: { squat: null, bench: null, deadlift: null, ohp: null },
      previous_programs: "", recent_plateaus: "",
    },
    lifestyle: prior?.lifestyle ?? {
      job_demands: "mixed", commute_minutes: 0, has_dependents: false,
      dependent_notes: "", stress_self_rating: 3,
      days_available: { mon: true, tue: true, wed: false, thu: true, fri: true, sat: false, sun: false },
      earliest_session_time: "06:00", latest_session_time: "21:00",
      travel_frequency: "none",
    },
    nutrition: prior?.nutrition ?? {
      current_phase: "maintain",
      current_kcal: kcalAvg ? Math.round(kcalAvg) : 2400,
      current_macros: {
        protein_g: proteinAvg ? Math.round(proteinAvg) : 150,
        carb_g: carbAvg ? Math.round(carbAvg) : 250,
        fat_g: fatAvg ? Math.round(fatAvg) : 70,
      },
      tracking_experience: "on_off", restrictions: "",
      alcohol_drinks_per_week: 0, caffeine_mg_per_day: 200, supplements: "",
    },
    sleep_recovery: prior?.sleep_recovery ?? {
      avg_sleep_hours: sleepAvg ? Math.round(sleepAvg * 10) / 10 : 7.5,
      typical_bedtime: "23:00", typical_wake_time: "06:30",
      sleep_latency_minutes: 15, awakenings: "1_2",
      mobility_work: "", soreness_frequency: "rare",
    },
    goals: prior?.goals ?? {
      primary_type: "strength", primary_metric: "deadlift e1RM",
      target_value: 200, target_unit: "kg",
      target_date: ninetyDaysFromToday(),
      why_narrative: "",
    },
  };
}

function yearsLiftingHeuristic(e: RecentE1RMs): number {
  // Crude: if any major lift > 100kg, assume ≥2 years; > 150kg ≥4 years.
  const max = Math.max(e.squat ?? 0, e.bench ?? 0, e.deadlift ?? 0, e.ohp ?? 0);
  if (max >= 150) return 5;
  if (max >= 100) return 2;
  return 0;
}

function ninetyDaysFromToday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 90);
  return d.toISOString().slice(0, 10);
}
