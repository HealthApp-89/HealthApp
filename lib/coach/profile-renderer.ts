// lib/coach/profile-renderer.ts
//
// Pure functions that turn an IntakePayload into:
//   - renderProfileMarkdown(): the human-readable artifact frozen into
//     athlete_profile_documents.rendered_md at acknowledgment time. Byte-
//     stable for the lifetime of the version (never regenerated).
//   - renderProfileSummary(): the condensed string injected into the coach
//     AI's snapshot prefix on every turn. ~250 tokens, designed for cache
//     density.
//
// No AI in either path. Deterministic transformations only. If you change
// the markdown template later, OLD acknowledged docs still display from
// their stored rendered_md — they don't re-render.

import type { IntakePayload } from "@/lib/data/types";

// ── Public API ───────────────────────────────────────────────────────────────

export function renderProfileMarkdown(
  intake: IntakePayload,
  version: number,
  acknowledgedAt: string | null,
  supersedesVersion: number | null,
): string {
  const ackLine = renderAckLine(acknowledgedAt, supersedesVersion);

  const sections: string[] = [
    `# Athlete Profile — v${version}`,
    ``,
    `*${ackLine}*`,
    ``,
    renderSnapshotSection(intake),
    renderGoalSection(intake),
    renderHealthSection(intake),
    renderTrainingSection(intake),
    renderLifestyleSection(intake),
    renderNutritionSection(intake),
    renderSleepSection(intake),
    `---`,
    ``,
    `*This profile is the foundation for upcoming coaching plans (v2+ adds AI-generated periodization, sleep, and nutrition prescriptions).*`,
  ];

  return sections.join("\n");
}

export function renderProfileSummary(intake: IntakePayload, version: number): string {
  const g = intake.goals;
  const t = intake.training;
  const l = intake.lifestyle;
  const n = intake.nutrition;
  const sr = intake.sleep_recovery;

  const daysAvailable = compactDays(l.days_available);
  const equipmentList = compactEquipment(t.equipment);
  const e1rmCompact = `SQ${fmtN(t.current_e1rm.squat)} BP${fmtN(t.current_e1rm.bench)} DL${fmtN(t.current_e1rm.deadlift)} OHP${fmtN(t.current_e1rm.ohp)}`;
  const why = trimSentences(g.why_narrative, 2);
  const health = compactHealth(intake);
  const alcoholLine =
    n.alcohol_drinks_per_week > 0 ? ` Alcohol ${n.alcohol_drinks_per_week}/wk.` : "";
  const travelLine = l.travel_frequency !== "none" ? ` Travel: ${l.travel_frequency}.` : "";

  return [
    `## Athlete profile (v${version})`,
    ``,
    `Goal: ${g.primary_type} — ${g.primary_metric} ${g.target_value}${g.target_unit} by ${g.target_date}. Why: "${why}".`,
    ``,
    `Trains ${t.sessions_per_week}×/wk (${daysAvailable}, ${l.earliest_session_time}-${l.latest_session_time} window). ${cap(t.training_age)} lifter, ${t.years_lifting}y. Current e1RMs: ${e1rmCompact}.`,
    ``,
    `Equipment: ${equipmentList}.`,
    ``,
    `Health: ${health}.`,
    ``,
    `Nutrition baseline: ${n.current_phase}, ${n.current_kcal} kcal target, ${n.current_macros.protein_g}P/${n.current_macros.carb_g}C/${n.current_macros.fat_g}F. Tracking ${n.tracking_experience}.${alcoholLine}`,
    ``,
    `Sleep baseline: ${sr.avg_sleep_hours}h, window ${sr.typical_bedtime}-${sr.typical_wake_time}. Soreness ${sr.soreness_frequency}.`,
    ``,
    `Job: ${l.job_demands}, stress ${l.stress_self_rating}/5.${travelLine}`,
  ].join("\n");
}

// ── Section helpers ─────────────────────────────────────────────────────────

function renderAckLine(acknowledgedAt: string | null, supersedesVersion: number | null): string {
  if (!acknowledgedAt) return "Draft — not yet acknowledged";
  const dateOnly = acknowledgedAt.slice(0, 10);
  if (supersedesVersion !== null) {
    return `Acknowledged ${dateOnly}, supersedes v${supersedesVersion}`;
  }
  return `Acknowledged ${dateOnly}`;
}

function renderSnapshotSection(intake: IntakePayload): string {
  const t = intake.training;
  const l = intake.lifestyle;
  const equipmentList = compactEquipment(t.equipment);
  const dependents = l.has_dependents
    ? l.dependent_notes
      ? `, dependents (${l.dependent_notes})`
      : ", dependents"
    : "";
  return [
    `## Athlete snapshot`,
    `Trains ${t.sessions_per_week}× per week, typical session ${t.typical_session_minutes} min. Equipment: ${equipmentList}.`,
    `Job: ${l.job_demands}, stress ${l.stress_self_rating}/5${dependents}.`,
    ``,
  ].join("\n");
}

function renderGoalSection(intake: IntakePayload): string {
  const g = intake.goals;
  return [
    `## Goal`,
    `**${cap(g.primary_type.replace("_", " "))}**: ${g.primary_metric} → ${g.target_value}${g.target_unit} by ${g.target_date}.`,
    ``,
    `> ${g.why_narrative}`,
    ``,
  ].join("\n");
}

function renderHealthSection(intake: IntakePayload): string {
  const h = intake.health;
  const lines: string[] = [`## Health context`];
  const conds = listConditions(h.conditions);
  if (conds) lines.push(`Conditions: ${conds}.`);
  if (h.medications.trim()) lines.push(`Medications: ${h.medications}.`);
  if (h.recent_illness_injury.trim()) lines.push(`Recent illness/injury: ${h.recent_illness_injury}.`);
  if (h.active_injuries.length > 0) {
    lines.push(`Active restrictions:`);
    for (const inj of h.active_injuries) {
      lines.push(`- ${inj.joint}: ${inj.restriction}`);
    }
  }
  if (h.allergies.trim()) lines.push(`Allergies: ${h.allergies}.`);
  if (lines.length === 1) lines.push(`No conditions or restrictions reported.`);
  lines.push(``);
  return lines.join("\n");
}

function renderTrainingSection(intake: IntakePayload): string {
  const t = intake.training;
  const lines: string[] = [
    `## Training history & equipment`,
    `${t.years_lifting} years lifting (${t.training_age}).`,
    `Current e1RMs: squat ${fmtN(t.current_e1rm.squat)}, bench ${fmtN(t.current_e1rm.bench)}, deadlift ${fmtN(t.current_e1rm.deadlift)}, OHP ${fmtN(t.current_e1rm.ohp)}.`,
  ];
  if (anyPr(t.best_ever_pr)) {
    lines.push(`Best PRs: squat ${fmtN(t.best_ever_pr.squat)}, bench ${fmtN(t.best_ever_pr.bench)}, deadlift ${fmtN(t.best_ever_pr.deadlift)}, OHP ${fmtN(t.best_ever_pr.ohp)}.`);
  }
  if (t.previous_programs.trim()) lines.push(`Previous programs: ${t.previous_programs}.`);
  if (t.recent_plateaus.trim()) lines.push(`Recent plateaus: ${t.recent_plateaus}.`);
  lines.push(``);
  return lines.join("\n");
}

function renderLifestyleSection(intake: IntakePayload): string {
  const l = intake.lifestyle;
  return [
    `## Lifestyle & schedule`,
    `Days available: ${compactDays(l.days_available)}.`,
    `Session window: ${l.earliest_session_time}–${l.latest_session_time}.`,
    `Commute: ${l.commute_minutes} min.`,
    `Travel: ${l.travel_frequency}.`,
    ``,
  ].join("\n");
}

function renderNutritionSection(intake: IntakePayload): string {
  const n = intake.nutrition;
  const lines: string[] = [
    `## Nutrition baseline`,
    `Current phase: ${n.current_phase}.`,
    `Target: ${n.current_kcal} kcal · ${n.current_macros.protein_g}P / ${n.current_macros.carb_g}C / ${n.current_macros.fat_g}F.`,
    `Tracking: ${n.tracking_experience}.`,
  ];
  if (n.restrictions.trim()) lines.push(`Restrictions: ${n.restrictions}.`);
  lines.push(`Alcohol: ${n.alcohol_drinks_per_week}/wk · Caffeine: ${n.caffeine_mg_per_day} mg/day.`);
  if (n.supplements.trim()) lines.push(`Supplements: ${n.supplements}.`);
  lines.push(``);
  return lines.join("\n");
}

function renderSleepSection(intake: IntakePayload): string {
  const sr = intake.sleep_recovery;
  const lines: string[] = [
    `## Sleep & recovery baseline`,
    `Average ${sr.avg_sleep_hours} hours, window ${sr.typical_bedtime}–${sr.typical_wake_time}.`,
    `Latency ${sr.sleep_latency_minutes} min, awakenings ${sr.awakenings.replace("_", "-")}.`,
    `Soreness frequency: ${sr.soreness_frequency}.`,
  ];
  if (sr.mobility_work.trim()) lines.push(`Mobility work: ${sr.mobility_work}.`);
  lines.push(``);
  return lines.join("\n");
}

// ── Small helpers ───────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function fmtN(n: number | null): string {
  return n === null ? "—" : String(n);
}

function trimSentences(s: string, maxSentences: number): string {
  if (!s.trim()) return "";
  const parts = s.split(/(?<=[.!?])\s+/);
  return parts.slice(0, maxSentences).join(" ").trim();
}

function compactDays(d: IntakePayload["lifestyle"]["days_available"]): string {
  const order: Array<[keyof typeof d, string]> = [
    ["mon", "M"], ["tue", "T"], ["wed", "W"], ["thu", "T"],
    ["fri", "F"], ["sat", "S"], ["sun", "S"],
  ];
  const on = order.filter(([k]) => d[k]).map(([, label]) => label);
  return on.length > 0 ? on.join("") : "(none)";
}

function compactEquipment(e: IntakePayload["training"]["equipment"]): string {
  const items: string[] = [];
  if (e.barbell) items.push("barbell");
  if (e.rack) items.push("rack");
  if (e.bench) items.push("bench");
  if (e.dumbbells) items.push("DBs");
  if (e.cables) items.push("cables");
  if (e.machines) items.push("machines");
  if (e.platform) items.push("platform");
  if (e.ghd) items.push("GHD");
  if (e.sled) items.push("sled");
  if (e.treadmill) items.push("treadmill");
  if (e.rower) items.push("rower");
  if (e.bike) items.push("bike");
  if (e.kettlebells) items.push("KBs");
  if (e.bands) items.push("bands");
  if (e.other.trim()) items.push(e.other.trim());
  return items.length > 0 ? items.join(", ") : "(none specified)";
}

function listConditions(c: IntakePayload["health"]["conditions"]): string {
  const items: string[] = [];
  if (c.cardiac) items.push("cardiac");
  if (c.hypertension) items.push("hypertension");
  if (c.diabetes !== "none") items.push(`diabetes (${c.diabetes})`);
  if (c.autoimmune) items.push("autoimmune");
  for (const s of c.joint_surgeries) {
    items.push(`${s.joint} surgery ${s.year}${s.notes ? ` (${s.notes})` : ""}`);
  }
  if (c.other.trim()) items.push(c.other.trim());
  return items.join(", ");
}

function compactHealth(intake: IntakePayload): string {
  const conds = listConditions(intake.health.conditions);
  const meds = intake.health.medications.trim();
  const restrictions = intake.health.active_injuries.length;
  if (!conds && !meds && restrictions === 0) return "no flagged conditions";
  const parts: string[] = [];
  if (conds) parts.push(conds);
  if (meds) parts.push(`meds: ${meds}`);
  if (restrictions > 0) parts.push(`${restrictions} active restriction${restrictions === 1 ? "" : "s"}`);
  return parts.join("; ");
}

function anyPr(prs: IntakePayload["training"]["best_ever_pr"]): boolean {
  return prs.squat !== null || prs.bench !== null || prs.deadlift !== null || prs.ohp !== null;
}
