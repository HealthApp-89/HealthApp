// components/chat/PlanProposalCard.tsx
//
// Inline plan-proposal card rendered when an assistant message's tool_calls
// includes a successful propose_plan. Mirrors WeekPlanProposalCard's shape.
// Approve button dispatches [approve:<token>] up through the chat handler,
// which the AI sees and translates into commit_plan(token).

"use client";

import { useState } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { PlanPayload, StrengthMuscleVolume } from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";

function modeOfPlan(plan: PlanPayload): "glp1" | "classical" | "steady" {
  if (plan.nutrition.glp1) return "glp1";
  if (plan.nutrition.classical_phases?.length) return "classical";
  return "steady";
}

export function PlanProposalCard({
  plan,
  approval_token,
  onApprove,
  committed,
  currentBlockWeek,
}: {
  plan: PlanPayload;
  approval_token: string;
  onApprove: (token: string) => void;
  committed?: boolean;
  /** Current week within the active training block (1-5), null when no active block. */
  currentBlockWeek: number | null;
}) {
  const [busy, setBusy] = useState(false);

  if (committed) {
    return (
      <div style={cardStyle}>
        <div style={{ color: "#16a34a", fontWeight: 700, fontSize: 13 }}>
          ✓ Plan committed
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: COLOR.textMuted,
              fontWeight: 600,
            }}
          >
            Proposed coaching plan
          </div>
          <h3
            style={{
              fontSize: 16,
              fontWeight: 600,
              margin: "4px 0 0",
              color: COLOR.textStrong,
            }}
          >
            {plan.goal.primary_metric} → {plan.goal.target_value}
            {plan.goal.target_unit} by {plan.goal.target_date}
          </h3>
        </div>
      </div>

      {plan.goal.feasibility_note && (
        <div
          style={{
            fontSize: 12,
            color: COLOR.warning,
            background: COLOR.warningSoft,
            padding: "6px 10px",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {plan.goal.feasibility_note}
        </div>
      )}

      <PlanSection title="Goal">
        <p
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: COLOR.textMid,
            margin: 0,
          }}
        >
          {plan.goal.narrative_summary}
        </p>
      </PlanSection>

      {(() => {
        const mode = modeOfPlan(plan);
        return (
          <PlanSection title="Nutrition">
            {mode === "glp1" && plan.nutrition.glp1 && (
              <>
                <KeyVal
                  label="Mode"
                  value={`GLP-1-aware · ${plan.nutrition.glp1.medication} ${plan.nutrition.glp1.dose_mg}mg/wk`}
                />
                <KeyVal label="Phase" value={plan.nutrition.phase} />
                <KeyVal
                  label="Calories"
                  value={`${plan.nutrition.kcal_target} kcal (alarm at >${plan.nutrition.glp1.deficit_alarm_kcal} deficit)`}
                />
                <KeyVal
                  label="Protein"
                  value={`${plan.nutrition.protein_g}g (${plan.nutrition.glp1.protein_g_per_kg_bw} g/kg BW)`}
                />
                <KeyVal
                  label="Carbs / Fat"
                  value={`${plan.nutrition.carb_g}g / ${plan.nutrition.fat_g}g`}
                />
                <KeyVal
                  label="Hydration"
                  value={`${plan.nutrition.glp1.hydration_training_day_ml} ml + ${plan.nutrition.glp1.sodium_training_day_mg} mg Na on training days`}
                />
                <KeyVal label="Started" value={plan.nutrition.glp1.started_on} />
                {plan.nutrition.glp1.expected_taper_start && (
                  <KeyVal
                    label="Expected taper"
                    value={plan.nutrition.glp1.expected_taper_start}
                  />
                )}
                {plan.nutrition.glp1.expected_end && (
                  <KeyVal
                    label="Expected end"
                    value={plan.nutrition.glp1.expected_end}
                  />
                )}
              </>
            )}

            {mode === "classical" && plan.nutrition.classical_phases && (
              <>
                <KeyVal label="Mode" value="Classical phase-of-phases" />
                <KeyVal label="Phase today" value={plan.nutrition.phase} />
                <KeyVal
                  label="Calories"
                  value={`${plan.nutrition.kcal_target} kcal`}
                />
                <KeyVal
                  label="Protein"
                  value={`${plan.nutrition.protein_g}g (${plan.nutrition.protein_g_per_kg_bw} g/kg BW)`}
                />
                <KeyVal
                  label="Carbs / Fat"
                  value={`${plan.nutrition.carb_g}g / ${plan.nutrition.fat_g}g`}
                />
                <KeyVal
                  label="Sequence"
                  value={plan.nutrition.classical_phases
                    .map((s) => `W${s.start_week}-${s.end_week} ${s.mode}`)
                    .join(" · ")}
                />
                {plan.nutrition.refeed_cadence_days && (
                  <KeyVal
                    label="Refeed"
                    value={`every ${plan.nutrition.refeed_cadence_days} days`}
                  />
                )}
                {plan.nutrition.rest_day_delta && (
                  <KeyVal
                    label="Rest-day delta"
                    value={`${plan.nutrition.rest_day_delta.kcal} kcal / ${plan.nutrition.rest_day_delta.carb_g}g carbs`}
                  />
                )}
              </>
            )}

            {mode === "steady" && (
              <>
                <KeyVal label="Phase" value={plan.nutrition.phase} />
                <KeyVal
                  label="Calories"
                  value={`${plan.nutrition.kcal_target} kcal (${plan.nutrition.kcal_range[0]}-${plan.nutrition.kcal_range[1]})`}
                />
                <KeyVal
                  label="Protein"
                  value={`${plan.nutrition.protein_g}g (${plan.nutrition.protein_g_per_kg_bw} g/kg BW)`}
                />
                <KeyVal
                  label="Carbs / Fat"
                  value={`${plan.nutrition.carb_g}g / ${plan.nutrition.fat_g}g`}
                />
                {plan.nutrition.refeed_cadence_days &&
                  plan.nutrition.refeed_uplift && (
                    <KeyVal
                      label="Refeed"
                      value={`every ${plan.nutrition.refeed_cadence_days} days (+${plan.nutrition.refeed_uplift.kcal} kcal)`}
                    />
                  )}
                <KeyVal
                  label="Alcohol"
                  value={plan.nutrition.hard_rules.alcohol_policy.replace(
                    /_/g,
                    " ",
                  )}
                />
              </>
            )}
          </PlanSection>
        );
      })()}

      <PlanSection title="Sleep">
        <KeyVal
          label="Schedule"
          value={`${plan.sleep.target_hours_min}-${plan.sleep.target_hours_max}h, wake ${plan.sleep.wake_target} → bed ${plan.sleep.bedtime_target}`}
        />
        <KeyVal
          label="Efficiency target"
          value={`${(plan.sleep.efficiency_target * 100).toFixed(0)}%`}
        />
        <KeyVal
          label="Caffeine cutoff"
          value={`${plan.sleep.hygiene_rules.caffeine_cutoff_hours_before_bed}h before bed`}
        />
      </PlanSection>

      <PlanSection title="Strength template">
        <KeyVal
          label="Sessions/wk"
          value={String(plan.strength.sessions_per_week)}
        />
        <KeyVal
          label="Pattern"
          value={Object.entries(plan.strength.day_pattern)
            .filter(([, v]) => v !== "REST")
            .map(([d, t]) => `${d.slice(0, 3)}=${t}`)
            .join(" · ")}
        />
        {Object.entries(plan.strength.weekly_volume_targets).map(
          ([lift, t]) => (
            <KeyVal
              key={lift}
              label={lift}
              value={`${t.reps_per_week} reps/wk, ${t.sets_per_week} sets/wk`}
            />
          ),
        )}
        {plan.strength.muscle_volume && (
          <MuscleVolumeSection
            muscleVolume={plan.strength.muscle_volume}
            currentBlockWeek={currentBlockWeek ?? null}
          />
        )}
        <div
          style={{
            fontSize: 12,
            color: COLOR.textMuted,
            marginTop: 6,
          }}
        >
          {plan.strength.progression_rule}
        </div>
      </PlanSection>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 16,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onApprove(approval_token);
          }}
          style={{
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            borderRadius: RADIUS.pill,
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Approving…" : "Approve plan"}
        </button>
      </div>
    </div>
  );
}

function PlanSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: COLOR.textMuted,
          fontWeight: 700,
          cursor: "pointer",
          marginBottom: 4,
        }}
      >
        {open ? "▼" : "▶"} {title}
      </button>
      {open && <div style={{ paddingLeft: 12 }}>{children}</div>}
    </div>
  );
}

function KeyVal({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontSize: 12.5,
        color: COLOR.textMid,
        marginBottom: 2,
      }}
    >
      <span style={{ minWidth: 100, color: COLOR.textMuted }}>{label}</span>
      <span style={{ color: COLOR.textStrong, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function MuscleVolumeSection({
  muscleVolume,
  currentBlockWeek,
}: {
  muscleVolume: StrengthMuscleVolume;
  currentBlockWeek: number | null;
}) {
  const nBelowMev = TARGETED_MUSCLE_GROUPS.filter(
    (g) => muscleVolume.bands[g].source === "literature_with_ramp_floor",
  ).length;
  const nRaised = TARGETED_MUSCLE_GROUPS.filter(
    (g) => muscleVolume.bands[g].source === "literature_adjusted_up",
  ).length;

  const summaryParts: string[] = [
    `${TARGETED_MUSCLE_GROUPS.length} muscles tracked`,
  ];
  if (nBelowMev > 0) {
    const names = TARGETED_MUSCLE_GROUPS.filter(
      (g) => muscleVolume.bands[g].source === "literature_with_ramp_floor",
    );
    summaryParts.push(
      nBelowMev <= 3
        ? `${nBelowMev} below MEV (${names.join(", ")})`
        : `${nBelowMev} below MEV`,
    );
  }
  if (nRaised > 0) {
    const names = TARGETED_MUSCLE_GROUPS.filter(
      (g) => muscleVolume.bands[g].source === "literature_adjusted_up",
    );
    summaryParts.push(
      nRaised <= 3
        ? `${nRaised} raised (${names.join(", ")})`
        : `${nRaised} raised`,
    );
  }
  if (nBelowMev === 0 && nRaised === 0) {
    summaryParts.push("all in band");
  }

  return (
    <details style={{ marginTop: 8 }}>
      <summary
        style={{
          cursor: "pointer",
          fontSize: 13,
          listStyle: "revert",
          color: COLOR.textMid,
        }}
      >
        <strong>Muscle volume:</strong> {summaryParts.join(" · ")}
      </summary>
      <table
        style={{
          width: "100%",
          marginTop: 8,
          fontSize: 12,
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: COLOR.textMuted }}>
            <th style={{ padding: "4px 8px" }}>Muscle</th>
            <th style={{ padding: "4px 8px" }}>8wk avg</th>
            <th style={{ padding: "4px 8px" }}>Band (MEV / MAV / MRV)</th>
            <th style={{ padding: "4px 8px" }}>This week</th>
            <th style={{ padding: "4px 8px" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {TARGETED_MUSCLE_GROUPS.map((g) => {
            const band = muscleVolume.bands[g];
            const thisWeekTarget =
              currentBlockWeek !== null
                ? targetSetsForWeek(band, muscleVolume.ramp_recipe, currentBlockWeek)
                : Math.round((band.mav[0] + band.mav[1]) / 2);
            const thisWeekLabel =
              currentBlockWeek !== null
                ? `${thisWeekTarget} (wk ${currentBlockWeek}/5)`
                : `${thisWeekTarget} (no block — MAV mid)`;
            const statusIcon =
              band.source === "literature_with_ramp_floor"
                ? "⚠"
                : band.source === "literature_adjusted_up"
                  ? "⬆"
                  : "🟢";
            const statusText =
              band.source === "literature_with_ramp_floor"
                ? "below MEV — coach will ramp"
                : band.source === "literature_adjusted_up"
                  ? "band raised from history"
                  : "in band";
            return (
              <tr key={g} title={band.rationale}>
                <td style={{ padding: "4px 8px", color: COLOR.textStrong }}>{g}</td>
                <td style={{ padding: "4px 8px", color: COLOR.textMid }}>{band.history_8wk_avg}</td>
                <td style={{ padding: "4px 8px", color: COLOR.textMid }}>
                  {band.mev} / {band.mav[0]}-{band.mav[1]} / {band.mrv}
                </td>
                <td style={{ padding: "4px 8px", color: COLOR.textMid }}>{thisWeekLabel}</td>
                <td style={{ padding: "4px 8px", color: COLOR.textMuted }}>
                  {statusIcon} {statusText}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

const cardStyle: React.CSSProperties = {
  background: COLOR.surface,
  border: `1px solid ${COLOR.divider}`,
  borderRadius: RADIUS.cardMid,
  padding: 16,
  margin: "8px 0",
  maxWidth: 640,
};
