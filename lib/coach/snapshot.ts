// lib/coach/snapshot.ts
//
// Shared LLM snapshot builder used by /api/insights, /api/insights/weekly,
// and the chat coach. Returns the cacheable `body` (profile + daily-log rows
// + workout rows with relative-day labels) and the uncached `nowLine`
// separately so callers can keep `nowLine` out of any cached prompt prefix.
//
// Convenience wrapper `buildSnapshotText` returns the two concatenated as a
// single string, for callers that don't care about the cache-placement split.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadWorkouts } from "@/lib/data/workouts-server";
import type { WorkoutSession } from "@/lib/data/workouts";
import { nowInUserTz, relativeDateLabel, todayInUserTz, weekdayInUserTz } from "@/lib/time";
import { renderProfileSummary } from "@/lib/coach/profile-renderer";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { topSet } from "@/lib/coach/derived";
import type { EnduranceActivity, IntakePayload, PlanPayload } from "@/lib/data/types";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
import { defaultZ2Cap } from "@/lib/coach/endurance/hr-zones";
import type { EnduranceProfile } from "@/lib/coach/endurance/types";
import { buildAthleteIntelligence } from "@/lib/coach/intelligence";
import type { AthleteIntelligencePayload } from "@/lib/coach/intelligence/types";
import { summarizeResponsiveness, renderResponsivenessLines } from "@/lib/coach/interventions/responsiveness";
import type { CoachInterventionRow } from "@/lib/data/types";
import { loadPlannedActivities } from "@/lib/coach/activity/read-planned";
import { renderPlannedActivitiesBlock } from "@/lib/coach/activity/render-activities-block";
import type { RecurringActivity } from "@/lib/coach/activity/types";

/** Compose the NOW header for the LLM snapshot prefix. Includes an explicit
 *  "current week" anchor (Mon→Sun of the user's current week) because LLMs
 *  frequently miscompute the Monday of "this week" from just a NOW date.
 *  Pre-computing the anchor here keeps the model from inventing dates like
 *  "Week of 2026-05-12" when today is Saturday 2026-05-16. */
function composeNowLine(n: {
  date: string;
  weekday: string;
  time: string;
  tz: string;
  utcOffset: string;
}): string {
  const weekMon = mondayOf(n.date);
  const weekSunDt = new Date(weekMon + "T12:00:00Z");
  weekSunDt.setUTCDate(weekSunDt.getUTCDate() + 6);
  const weekSun = weekSunDt.toISOString().slice(0, 10);
  return [
    `NOW: ${n.date} (${n.weekday}) ${n.time} ${n.tz} (UTC${n.utcOffset})`,
    `CURRENT WEEK: ${weekMon} (Mon) → ${weekSun} (Sun) — use these dates verbatim when referring to "this week", "Monday", or any weekday this week. Do not recompute.`,
  ].join("\n");
}

type ProfileRow = {
  name?: string | null;
  goal?: string | null;
  whoop_baselines?: unknown;
} | null;

/** Returns `whoop_baselines` minus the `rolling_30d` key (the live anchor).
 *  What remains is the historical/biographical block (6mo means, peaks, etc.)
 *  that Peter injects for "where you came from" narration only. */
function stripRolling30d(wb: unknown): Record<string, unknown> {
  if (!wb || typeof wb !== "object") return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wb as Record<string, unknown>)) {
    if (key !== "rolling_30d") rest[key] = value;
  }
  return rest;
}

type DailyLogRow = {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  strain: number | null;
  steps: number | null;
  /** Nutrition intake (Yazio) — what shows up as "kcal" in the coach summary.
   *  This deliberately excludes the `calories` (energy burned) column, which
   *  is from Apple Health and surfaces elsewhere via strain/active metrics. */
  calories_eaten: number | null;
  weight_kg: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

export type SnapshotInputs = {
  supabase: SupabaseClient;
  userId: string;
  /** Inclusive YYYY-MM-DD lower bound for daily_logs / workouts. */
  since: string;
  /** Optional inclusive upper bound. Omit for daily mode (loads recent N). */
  until?: string;
  /** Workouts to include in daily mode (ignored when `until` is set). */
  workoutLimit?: number;
  /** Authoritative per-user timezone. Resolve via `getUserTimezone(userId)`. */
  tz: string;
};

export type SnapshotResult = {
  /** PER-TURN line. MUST NOT be placed inside a cached prompt prefix. */
  nowLine: string;
  /** Cacheable body. Stable until underlying daily/workout data changes. */
  body: string;
};

const DAY_REFERENCE_INSTRUCTION =
  'When the user references a day (e.g. "Monday"), interpret it relative to NOW above. "Monday" without other qualifiers means the most recent Monday on or before today. If ambiguous, ask.';

/** Append this to your existing system prompt so the model uses NOW as the
 *  reference frame for relative day references. */
export function withDayReferenceInstruction(systemPrompt: string): string {
  return `${systemPrompt}\n\n${DAY_REFERENCE_INSTRUCTION}`;
}

/** Window (days, relative to `asOf`) bounding what counts as a "current" lift
 *  in the live top-set block. Lifts not performed within this window are
 *  excluded — beyond ~4 months, the notion of "current top set" stops being
 *  meaningful and would just bloat the cached prefix. */
const CURRENT_LIFT_WINDOW_DAYS = 120;

/** Number of days between two YYYY-MM-DD strings (negative if `b` is before `a`). */
function daysBetween(a: string, b: string): number {
  const ms = Date.UTC(
    Number(a.slice(0, 4)),
    Number(a.slice(5, 7)) - 1,
    Number(a.slice(8, 10)),
  ) - Date.UTC(
    Number(b.slice(0, 4)),
    Number(b.slice(5, 7)) - 1,
    Number(b.slice(8, 10)),
  );
  return Math.round(ms / 86_400_000);
}

/** For every distinct lift the athlete has performed within
 *  CURRENT_LIFT_WINDOW_DAYS of `asOf`, emit the top working set of its
 *  most-recent session (with e1RM when reps ≤ 12). This gives the coach AI
 *  a LIVE anchor for "current top set per lift" so it never cites the
 *  frozen intake-time `current_e1rm` baseline from the profile block.
 *
 *  Ordering: most-recent first — frequently-trained lifts naturally float
 *  to the top. Bodyweight-only sets (kg=null, no duration) render as
 *  `BW×reps`. Returns "" when nothing renders so callers can skip the
 *  section cleanly. */
function buildCurrentTopSetsBlock(
  workouts: WorkoutSession[],
  asOf: string,
): string {
  type Hit = {
    name: string;
    date: string;
    ts: NonNullable<ReturnType<typeof topSet>> | null;
    /** BW-reps fallback when topSet returns null but reps-only sets exist. */
    bwReps: number | null;
  };

  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const w of workouts) {
    if (w.date > asOf) continue;
    if (daysBetween(asOf, w.date) > CURRENT_LIFT_WINDOW_DAYS) break; // workouts is desc — older lifts won't requalify
    for (const ex of w.exercises) {
      if (seen.has(ex.name)) continue;
      const ts = topSet(ex.sets);
      let bwReps: number | null = null;
      if (!ts) {
        const bw = ex.sets
          .filter((s) => !s.warmup && !s.kg && s.reps)
          .sort((a, b) => b.reps! - a.reps!)[0];
        if (bw) bwReps = bw.reps;
        else continue;
      }
      seen.add(ex.name);
      hits.push({ name: ex.name, date: w.date, ts, bwReps });
    }
  }

  if (hits.length === 0) return "";

  const lines = hits.map((h) => {
    const rel = relativeDateLabel(h.date, asOf);
    let body: string;
    if (h.ts && h.ts.kg !== null && h.ts.reps !== null) {
      body = `${h.ts.kg}×${h.ts.reps}${h.ts.e1RM !== null ? ` (e1RM ${h.ts.e1RM})` : ""}`;
    } else if (h.ts && h.ts.duration_seconds !== null) {
      body = `${h.ts.duration_seconds}s hold`;
    } else if (h.bwReps !== null) {
      body = `BW×${h.bwReps}`;
    } else {
      return null;
    }
    return `  ${h.name} — ${h.date} (${rel}): ${body}`;
  }).filter((l): l is string => l !== null);

  if (lines.length === 0) return "";

  return [
    `CURRENT TOP SET per lift (most recent session within ${CURRENT_LIFT_WINDOW_DAYS}d; sourced live from workouts; SUPERSEDES any "Intake-time e1RMs" baseline values below):`,
    ...lines,
  ].join("\n");
}

/** Renders three endurance-pillar blocks for the snapshot prefix:
 *  ENDURANCE_PROFILE, ENDURANCE_LOAD_7D, LAST_3_ENDURANCE_ACTIVITIES.
 *
 *  Always-on — when no `endurance_profile` is set, the first block explicitly
 *  renders "not configured" so coaches see the absence rather than silently
 *  inferring it. The 7d/28d ratio carries a "(spike)" / "(below)" marker so
 *  Peter/Carter/Remi can cite ramp risk without computing it themselves.
 *
 *  Reads from the snapshot's user-bound supabase client; RLS-respecting. */
async function renderEnduranceBlocks(
  supabase: SupabaseClient,
  userId: string,
  tz: string,
): Promise<string> {
  const nowMs = Date.now();
  const todayIso = todayInUserTz(new Date(nowMs), tz);
  const d28Iso = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 28 * 86_400_000)
    .toISOString().slice(0, 10);
  const d7Iso = new Date(new Date(`${todayIso}T00:00:00Z`).getTime() - 7 * 86_400_000)
    .toISOString().slice(0, 10);

  const [{ data: profileRow }, { data: dailyRows }, { data: lastActs }] = await Promise.all([
    supabase
      .from("athlete_profile_documents")
      .select("endurance_profile")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, endurance_load, endurance_minutes, endurance_z2_minutes")
      .eq("user_id", userId)
      .gte("date", d28Iso)
      .lte("date", todayIso)
      .order("date", { ascending: false }),
    supabase
      .from("endurance_activities")
      .select("local_date, sport, duration_s, avg_hr, tss, hr_zone_distribution")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(3),
  ]);

  const profile = (profileRow?.endurance_profile as EnduranceProfile | null) ?? null;

  let out = "";

  if (profile) {
    out += `ENDURANCE_PROFILE:\n`;
    out += `  Discipline: ${profile.discipline}\n`;
    out += `  Phase: ${profile.phase} (set ${profile.set_at.slice(0, 10)})\n`;
    out += `  Weekly volume target: ${profile.weekly_volume_target_hours}h\n`;
    if (profile.threshold_hr) {
      out += `  Threshold HR: ${profile.threshold_hr} bpm\n`;
      out += `  HR cap (Z2): ${defaultZ2Cap(profile.threshold_hr)} bpm\n`;
    } else {
      out += `  Threshold HR: uncalibrated (TSS computation disabled)\n`;
    }
  } else {
    out += `ENDURANCE_PROFILE: not configured (user has not completed /profile endurance setup)\n`;
  }

  const rows = (dailyRows ?? []) as Array<{
    date: string;
    endurance_load: number | null;
    endurance_minutes: number | null;
    endurance_z2_minutes: number | null;
  }>;
  const tss7 = rows
    .filter((r) => r.date >= d7Iso)
    .reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const min7 = rows
    .filter((r) => r.date >= d7Iso)
    .reduce((s, r) => s + (Number(r.endurance_minutes) || 0), 0);
  const z2_7 = rows
    .filter((r) => r.date >= d7Iso)
    .reduce((s, r) => s + (Number(r.endurance_z2_minutes) || 0), 0);
  const tss28 = rows.reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const avgWeekly = tss28 / 4; // 28-day mean weekly TSS
  const ratio = avgWeekly > 0 ? tss7 / avgWeekly : 0;
  const marker = ratio > 1.4 ? "(spike)" : ratio < 0.6 && avgWeekly > 0 ? "(below)" : "(within normal)";
  out += `\nENDURANCE_LOAD_7D:\n`;
  out += `  TSS sum (7d): ${Math.round(tss7)}\n`;
  out += `  Endurance hours (7d): ${(min7 / 60).toFixed(1)}\n`;
  out += `  vs 28d rolling avg: ${ratio.toFixed(2)}x ${marker}\n`;
  out += `  Z2 minutes (7d): ${z2_7}\n`;

  out += `\nLAST_3_ENDURANCE_ACTIVITIES:\n`;
  const acts = (lastActs ?? []) as Array<
    Pick<EnduranceActivity, "local_date" | "sport" | "duration_s" | "avg_hr" | "tss" | "hr_zone_distribution">
  >;
  if (acts.length === 0) {
    out += `  (none yet)\n`;
  } else {
    for (const a of acts) {
      const mins = Math.round(a.duration_s / 60);
      const zd = a.hr_zone_distribution;
      const zsum = zd ? `Z2:${Math.round(zd.z2_s / 60)} Z3:${Math.round(zd.z3_s / 60)}` : "";
      out += `  ${a.local_date} | ${a.sport} | ${mins}min | avg HR ${a.avg_hr ?? "—"} | TSS ${a.tss ?? "—"} | ${zsum}\n`;
    }
  }
  return out;
}

// ── Intelligence block renderer ──────────────────────────────────────────────

/** Render the full ATHLETE INTELLIGENCE block (Layer 1 + Layer 2) for the
 *  snapshot body. Each Layer 2 sub-section is kept to 1-2 lines — the block
 *  lives in the cached prefix and must stay compact.
 *
 *  @param intel             Assembled AthleteIntelligencePayload.
 *  @param interventionRows  Raw evaluated rows (needed for responsiveness rollup).
 *  @param today             YYYY-MM-DD anchor for the "recent wins" window.
 */
function renderAthleteIntelligenceBlock(
  intel: AthleteIntelligencePayload,
  interventionRows: CoachInterventionRow[] = [],
  today: string = "",
): string {
  const { identity, constraints, history, recovery_readiness, nutrition_performance, interference, body_comp_direction } = intel;
  const lines: string[] = ["## ATHLETE INTELLIGENCE"];

  // ── Layer 1: Identity ─────────────────────────────────────────────────────
  lines.push("", "### Identity (90-day pattern)");

  const top = identity.top_exercises;
  if (top.lower.length > 0) lines.push(`- Top lower: ${top.lower.join(", ")}`);
  if (top.upper.length > 0) lines.push(`- Top upper: ${top.upper.join(", ")}`);
  if (top.pulls.length > 0) lines.push(`- Top pulls: ${top.pulls.join(", ")}`);
  if (top.isolation.length > 0) lines.push(`- Top isolation: ${top.isolation.join(", ")}`);

  const eat = identity.eating_identity;
  const eatParts: string[] = [];
  if (eat.top_proteins.length > 0) eatParts.push(`${eat.top_proteins.join(", ")} (proteins)`);
  if (eat.top_carbs.length > 0) eatParts.push(`${eat.top_carbs.join(", ")} (carbs)`);
  if (eat.top_fats.length > 0) eatParts.push(`${eat.top_fats.join(", ")} (fats)`);
  if (eatParts.length > 0) {
    lines.push(`- Eating: ${eatParts.join("; ")}`);
  } else {
    lines.push("- Eating: no food log data in window");
  }

  lines.push(`- Training style: ${identity.training_style_signature.volume_preference} volume`);

  if (eat.monotone_flags.length > 0) {
    lines.push(`- Diet flags: ${eat.monotone_flags.join(", ")} (repetitive)`);
  }

  // ── Layer 1: Constraints ───────────────────────────────────────────────────
  lines.push("", "### Constraints");

  if (constraints.active_injuries.length > 0) {
    const injLines = constraints.active_injuries.map(
      (inj) => `${inj.area} (${inj.status}, ${inj.weeks_ago_onset}w)`,
    );
    lines.push(`- Active injuries: ${injLines.join("; ")}`);
  }

  if (constraints.exercise_exclusions.length > 0) {
    lines.push(`- Avoid: ${constraints.exercise_exclusions.join(", ")}`);
  }

  lines.push(`- Equipment: ${constraints.equipment_access}`);

  if (constraints.schedule_constraints.length > 0) {
    lines.push(`- Schedule: ${constraints.schedule_constraints.join("; ")}`);
  }

  // ── Layer 1: Coach History ─────────────────────────────────────────────────
  // Responsiveness rollup — computed from raw intervention rows (not from the
  // mapped HistoryPayload, which loses fields needed for phrase building).
  const responsivenessRollup = summarizeResponsiveness(interventionRows, today);
  const responsivenessLines = renderResponsivenessLines(responsivenessRollup);

  const hasHistory =
    history.recent_deloads.length > 0 ||
    history.exercise_swaps_8w.length > 0 ||
    history.nutrition_interventions.length > 0 ||
    responsivenessLines.length > 0;

  if (hasHistory) {
    lines.push("", "### Coach History");
    if (history.recent_deloads.length > 0) {
      lines.push(`- Deloads: ${history.recent_deloads.map((d) => `${d.date} (${d.type})`).join(", ")}`);
    }
    if (history.exercise_swaps_8w.length > 0) {
      lines.push(`- Swaps (8w): ${history.exercise_swaps_8w.map((s) => `${s.from} → ${s.to}`).join(", ")}`);
    }
    if (history.nutrition_interventions.length > 0) {
      lines.push(`- Nutrition experiments: ${history.nutrition_interventions.map((n) => n.intervention).join(", ")}`);
    }
    // Responsiveness rollup lines — compact, observed-only, omitted when empty.
    for (const rl of responsivenessLines) {
      lines.push(rl);
    }
  }

  // ── Layer 2: Recovery readiness ───────────────────────────────────────────
  lines.push("", "### Recovery readiness");
  if (recovery_readiness.drivers.length === 0 && recovery_readiness.status === "stalled") {
    lines.push(`- ${recovery_readiness.status}: no data`);
  } else {
    lines.push(`- ${recovery_readiness.status}: ${recovery_readiness.narrative}`);
  }

  // ── Layer 2: Nutrition vs performance ─────────────────────────────────────
  lines.push("", "### Nutrition vs performance");
  lines.push(
    `- protein ${nutrition_performance.protein_status}, deficit ${nutrition_performance.deficit_severity}, muscle-loss risk ${nutrition_performance.predicted_muscle_loss_risk} — ${nutrition_performance.narrative}`,
  );

  // ── Layer 2: Strength–endurance interference ──────────────────────────────
  lines.push("", "### Strength–endurance interference");
  if (interference.interference_level === "none") {
    // Keep terse for the common steady-state case
    lines.push(`- none: ${interference.narrative}`);
  } else {
    lines.push(`- ${interference.interference_level}: ${interference.narrative}`);
  }

  // ── Layer 2: Body composition ──────────────────────────────────────────────
  lines.push("", "### Body composition");
  const confPct = Math.round(body_comp_direction.confidence * 100);
  lines.push(
    `- ${body_comp_direction.direction} (confidence ${confPct}%): ${body_comp_direction.narrative}`,
  );

  return lines.join("\n");
}

export async function buildSnapshot(inputs: SnapshotInputs): Promise<SnapshotResult> {
  const { supabase, userId, since, until, workoutLimit = 5, tz } = inputs;
  const today = todayInUserTz(new Date(), tz);

  let logsQ = supabase
    .from("daily_logs")
    .select(
      "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories_eaten, weight_kg, protein_g, carbs_g, fat_g",
    )
    .eq("user_id", userId)
    .gte("date", since)
    .order("date", { ascending: true });
  if (until) logsQ = logsQ.lte("date", until);

  // 90-day window for intervention rows — same as the intelligence orchestrator.
  const d90 = new Date(`${today}T00:00:00Z`);
  d90.setUTCDate(d90.getUTCDate() - 90);
  const since90d = d90.toISOString().slice(0, 10);

  // Current week start (Monday-keyed) — used for planned activities lookup.
  const currentWeekStart = mondayOf(today);

  const [{ data: profile }, { data: logs }, allWorkouts, { data: athleteProfileRow }, todayTargets, enduranceBlocks, intelligence, { data: rawInterventions }, { data: currentWeekRow }] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, goal, whoop_baselines")
      .eq("user_id", userId)
      .maybeSingle(),
    logsQ,
    loadWorkouts(userId),
    supabase
      .from("athlete_profile_documents")
      .select("version, intake_payload, plan_payload")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    // Resolve the LIVE kcal/macro targets (override → plan → intake) so the
    // snapshot prefix carries the same numbers Nora's tools and the morning
    // brief see, instead of the frozen intake-time baseline. Without this,
    // Peter cites stale intake values while Nora cites current overrides —
    // the conflicting-feedback bug audited on 2026-05-26.
    getTodayTargets(supabase, userId),
    // Endurance pillar: profile + 28d load + last 3 activities, rendered as
    // three blocks. Hoisted into Promise.all so its 3 internal reads don't
    // serialize behind the other queries.
    renderEnduranceBlocks(supabase, userId, tz),
    // Intelligence orchestrator: all 7 composers (Layer 1 + Layer 2).
    // Self-fetches its own data windows (56d logs, 90d food, workouts, baselines,
    // targets). Resilient — returns safe-default payload on any error so the
    // snapshot never crashes due to intelligence failure.
    buildAthleteIntelligence(supabase, userId, tz),
    // Evaluated intervention rows (last 90d) for the responsiveness rollup
    // rendered into the ### Coach History block. Runs in parallel with the
    // intelligence orchestrator (which also fetches these), so no extra latency.
    // Failure-safe: raw array falls back to [] on error.
    supabase
      .from("coach_interventions")
      .select("id, user_id, kind, source, started_on, context, outcome, outcome_evaluated_at, created_at")
      .eq("user_id", userId)
      .not("outcome", "is", null)
      .gte("started_on", since90d)
      .order("started_on", { ascending: false }),
    // Current week row — needed for loadPlannedActivities (declared activities
    // live on training_weeks.planned_activities). Fetched in the same Promise.all
    // to avoid serialization. Failure → null → no activities block.
    supabase
      .from("training_weeks")
      .select("week_start, planned_activities")
      .eq("user_id", userId)
      .eq("week_start", currentWeekStart)
      .maybeSingle(),
  ]);

  const workouts = until
    ? allWorkouts.filter((w) => w.date >= since && w.date <= until)
    : allWorkouts.slice(0, workoutLimit);

  const recent = workouts.map((w) => ({
    date: w.date,
    type: w.type,
    sets: w.sets,
    vol_kg: Math.round(w.vol),
    top: w.exercises.slice(0, 4).map((e) => {
      // Use the canonical topSet picker (sorts by e1RM, tie-breaks on kg) so
      // a 90×7 rep PR doesn't get hidden behind an earlier 90×6 at the same
      // weight. Also surfaces e1RM inline so the model doesn't have to derive
      // it from kg×reps (which was the original failure mode behind cited
      // stale e1RMs). topSet covers weighted + duration paths; pure
      // bodyweight sets (kg=null, no duration) still fall through to the
      // BW-reps fallback below.
      const ts = topSet(e.sets);
      if (ts) {
        if (ts.kg !== null && ts.reps !== null) {
          const e1rmSuffix = ts.e1RM !== null ? ` (e1RM ${ts.e1RM})` : "";
          return `${e.name} ${ts.kg}×${ts.reps}${e1rmSuffix}`;
        }
        if (ts.duration_seconds !== null) {
          return `${e.name} ${ts.duration_seconds}s`;
        }
      }
      const bw = e.sets
        .filter((s) => !s.warmup && !s.kg && s.reps)
        .sort((a, b) => b.reps! - a.reps!)[0];
      if (bw) return `${e.name} BW×${bw.reps}`;
      return e.name;
    }),
  }));

  // Live "current top set per lift" — anchors against the frozen intake-time
  // e1RMs in the profile summary below. Computed off ALL workouts (not just
  // the 5-slice `workouts`) so a lift performed >5 sessions ago still
  // surfaces. Bounded by `until ?? today` so historical snapshots
  // (insights/weekly) reflect what was current at that point in time.
  const currentTopSetsBlock = buildCurrentTopSetsBlock(allWorkouts, until ?? today);

  // ── Intelligence block ────────────────────────────────────────────────────
  // `intelligence` was assembled by the orchestrator in the Promise.all above.
  // Render it (Layer 1 + Layer 2) into the snapshot body. Pass raw intervention
  // rows + today for the responsiveness rollup inside ### Coach History.
  const interventionRows = (rawInterventions ?? []) as CoachInterventionRow[];
  const athleteIntelligenceBlock = renderAthleteIntelligenceBlock(intelligence, interventionRows, today);

  // ── Planned activities block ──────────────────────────────────────────────
  // Graceful: failure or no week row → empty array → block omitted.
  // loadPlannedActivities also reads recurring from profile internally.
  const plannedActivities = currentWeekRow
    ? await loadPlannedActivities(
        supabase,
        userId,
        {
          week_start: currentWeekRow.week_start as string,
          planned_activities: (currentWeekRow.planned_activities as import("@/lib/coach/activity/types").PlannedActivity[] | null) ?? [],
        },
        today,
      ).catch(() => [])
    : [];

  // Pull recurring from profile for the "Recurring" summary line in the block.
  // loadPlannedActivities already fetches this internally for merge logic, but
  // we need it here for the renderer. Guarded separately; failure → empty array.
  const recurringActivities = await (async (): Promise<RecurringActivity[]> => {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("recurring_activities")
        .eq("user_id", userId)
        .single();
      return (data?.recurring_activities as RecurringActivity[]) ?? [];
    } catch {
      return [];
    }
  })();

  const activitiesBlock = renderPlannedActivitiesBlock(plannedActivities, recurringActivities);

  const fmt = (v: number | null | undefined, unit = "") =>
    v === null || v === undefined ? "—" : `${v}${unit}`;

  const logLines = ((logs ?? []) as DailyLogRow[])
    .map((l) => {
      const rel = relativeDateLabel(l.date, today);
      return `  ${l.date} (${rel}) | hrv ${fmt(l.hrv)} | rhr ${fmt(l.resting_hr)} | recov ${fmt(l.recovery)} | sleep ${fmt(l.sleep_hours, "h")} (deep ${fmt(l.deep_sleep_hours)}) | strain ${fmt(l.strain)} | steps ${fmt(l.steps)} | kcal ${fmt(l.calories_eaten)} | prot ${fmt(l.protein_g, "g")} | weight ${fmt(l.weight_kg, "kg")}`;
    })
    .join("\n");

  const workoutLines = recent
    .map((w) => {
      const rel = relativeDateLabel(w.date, today);
      return `  ${w.date} (${rel}) ${w.type ?? "—"} | ${w.sets} sets | ${w.vol_kg} kg vol | top: ${w.top.join(", ") || "—"}`;
    })
    .join("\n");

  const p = profile as ProfileRow;

  const body = [
    `ATHLETE: ${p?.name ?? "Athlete"}. GOAL: "${p?.goal ?? "general health"}".`,
    `BASELINES_LIVE_30D: ${JSON.stringify((p?.whoop_baselines as { rolling_30d?: unknown } | null)?.rolling_30d ?? {})}`,
    `BASELINES_HISTORICAL: ${JSON.stringify(stripRolling30d(p?.whoop_baselines))}`,
    // Endurance pillar blocks. Always present (sits between baselines and the
    // strength-side current-top-sets block) so every coach — Peter / Carter /
    // Nora / Remi — sees the same endurance context block-position.
    ``,
    enduranceBlocks,
    // Live current top set per lift FIRST, so the model anchors on live data
    // before reading the intake-time baselines in the profile body.
    ...(currentTopSetsBlock ? [``, currentTopSetsBlock] : []),
    ...(athleteProfileRow
      ? [``, renderProfileSummary(
          athleteProfileRow.intake_payload as IntakePayload,
          athleteProfileRow.version as number,
          (athleteProfileRow.plan_payload as PlanPayload | null) ?? null,
          null, // currentBlockWeek — snapshot has no block-week context yet; future PR can thread it
          todayTargets,
        )]
      : []),
    // Layer 1 intelligence block — identity, constraints, history.
    // Placed after the profile summary (same "who is this athlete" context zone)
    // and before DAILY LOGS (which is time-series operational data).
    ``,
    athleteIntelligenceBlock,
    // Planned activities block — injected only when non-null (i.e. there are
    // declared, recurring, or detected activities this week). When empty,
    // activitiesBlock is null and this spread emits nothing — context is
    // byte-identical to pre-feature.
    ...(activitiesBlock ? [``, activitiesBlock] : []),
    ``,
    `DAILY LOGS (${since} → ${until ?? today}):`,
    logLines || `  (no logs in window)`,
    ``,
    `RECENT WORKOUTS (most recent first):`,
    workoutLines || `  (no workouts)`,
  ].join("\n");

  const n = nowInUserTz(new Date(), tz);
  const nowLine = composeNowLine(n);

  return { nowLine, body };
}

/** Convenience wrapper: returns NOW anchor + body concatenated as one string.
 *  Used by callers that don't need separate cache-placement (chat coach,
 *  current /api/insights). New callers should prefer buildSnapshot() when
 *  prompt-cache placement matters. */
export async function buildSnapshotText({
  userId,
  tz,
}: {
  userId: string;
  tz: string;
}): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const sinceDate = new Date(`${todayInUserTz(new Date(), tz)}T00:00:00Z`);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 14);
  const since = sinceDate.toISOString().slice(0, 10);
  const { nowLine, body } = await buildSnapshot({
    supabase: supabase as unknown as SupabaseClient,
    userId,
    since,
    workoutLimit: 5,
    tz,
  });
  return `${nowLine}\n\n${body}`;
}

// ── Ephemeral header (per-turn, NOT cached) ──────────────────────────────────
//
// Built fresh at request time. Carries today's row + yesterday's row (re-
// queried so freshly-arrived sync data isn't lied about) and a DATA FRESHNESS
// block giving hours-ago precision per source. Sits as a separate text block
// AFTER the cached snapshot prefix; never use cache_control on it.

export type SyncFreshnessRow = {
  source: "WHOOP" | "Withings" | "Apple Health" | "Yazio";
  /** ISO timestamp of the most recent daily_logs.updated_at where the
   *  source-signature column is non-null. Null if no rows ever. */
  last_write_at: string | null;
};

const FRESHNESS_SOURCES: { source: SyncFreshnessRow["source"]; signatureCol: string }[] = [
  { source: "WHOOP", signatureCol: "hrv" },
  { source: "Withings", signatureCol: "weight_kg" },
  { source: "Apple Health", signatureCol: "steps" },
  { source: "Yazio", signatureCol: "protein_g" },
];

export async function getSyncFreshness(
  supabase: SupabaseClient,
  userId: string,
): Promise<SyncFreshnessRow[]> {
  return Promise.all(
    FRESHNESS_SOURCES.map(async ({ source, signatureCol }) => {
      const { data } = await supabase
        .from("daily_logs")
        .select("updated_at")
        .eq("user_id", userId)
        .not(signatureCol, "is", null)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      return {
        source,
        last_write_at: (data?.updated_at as string | undefined) ?? null,
      };
    }),
  );
}

/** Render hours-ago in `Nh Mm ago (today|yesterday|N days ago)` form.
 *  The day-bucket label is derived from the user's timezone so that "today"
 *  and "yesterday" match the user's local calendar, not the UTC calendar.
 *  At 22:00 UTC (= 02:00 Dubai next day) a sync that happened at 08:00 UTC
 *  is Dubai "yesterday" — without the tz-aware boundary it would mis-label
 *  as "today" because both timestamps share the same UTC date. */
export function formatFreshness(now: Date, last: string | null, tz: string): string {
  if (!last) return "no data";
  const lastDate = new Date(last);
  const ms = now.getTime() - lastDate.getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  // Day bucket: derive both "today" and "last write date" in the user's
  // timezone so the label reflects the user's local calendar. The hours-ago
  // value is load-bearing; the label is directional context.
  //
  // Key: `last_write_at` is a UTC timestamp. At 22:00 UTC on 2026-06-26
  // (= 02:00 Dubai on 2026-06-27), a sync that happened at 08:00 UTC on
  // 2026-06-26 is Dubai "yesterday" — both share UTC date 2026-06-26 but
  // Dubai "today" is 2026-06-27. Conversely, a sync at 22:00 UTC on
  // 2026-06-27 (= 02:00 Dubai 2026-06-28) is Dubai "today" even though its
  // UTC date is still 2026-06-27.
  const todayIso = todayInUserTz(now, tz);
  const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
  // Convert the last_write_at timestamp to a calendar date in the user's tz.
  const lastDateInUserTz = todayInUserTz(lastDate, tz);
  const lastDay = new Date(`${lastDateInUserTz}T00:00:00Z`);
  const dayDelta = Math.round((todayMs - lastDay.getTime()) / 86_400_000);
  let dayLabel: string;
  if (dayDelta <= 0) dayLabel = "today";
  else if (dayDelta === 1) dayLabel = "yesterday";
  else dayLabel = `${dayDelta} days ago`;
  return `${hours}h ${mins.toString().padStart(2, "0")}m ago (${dayLabel})`;
}

/** Build the per-turn ephemeral header. Re-queries today + yesterday rows
 *  fresh so post-cache data lands. Returned as a single string; the caller
 *  places it as the LAST text block of the user message right before the new
 *  user content, AFTER the cached snapshot prefix. NOT cacheable. */
export async function buildEphemeralHeader(opts: {
  supabase: SupabaseClient;
  userId: string;
  tz: string;
}): Promise<string> {
  const { supabase, userId, tz } = opts;
  const today = todayInUserTz(new Date(), tz);
  const yesterdayDate = new Date(`${today}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  // Pull rows, freshness, and the most-recent training_week in parallel.
  // The training_week query mirrors lib/morning/brief/data-sources.ts so the
  // chat and the morning brief see the same source of truth.
  const [{ data: rows }, freshness, { data: trainingWeek }, n] = await Promise.all([
    supabase
      .from("daily_logs")
      .select(
        "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, calories_eaten, weight_kg, protein_g, carbs_g, fat_g",
      )
      .eq("user_id", userId)
      .in("date", [today, yesterday]),
    getSyncFreshness(supabase, userId),
    supabase
      .from("training_weeks")
      .select("week_start, session_plan, intensity_modifier")
      .eq("user_id", userId)
      .lte("week_start", today)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    Promise.resolve(nowInUserTz(new Date(), tz)),
  ]);

  const byDate = new Map<string, DailyLogRow>();
  for (const r of (rows ?? []) as DailyLogRow[]) byDate.set(r.date, r);

  const renderRow = (label: string, date: string) => {
    const r = byDate.get(date);
    const fmt = (v: number | null | undefined, unit = "") =>
      v === null || v === undefined ? "null" : `${v}${unit}`;
    return [
      `${label} (${date}):`,
      `  recovery=${fmt(r?.recovery)}  hrv=${fmt(r?.hrv)}  resting_hr=${fmt(r?.resting_hr)}  sleep_hours=${fmt(r?.sleep_hours)}  sleep_score=${fmt(r?.sleep_score)}`,
      `  strain=${fmt(r?.strain)}  steps=${fmt(r?.steps)}  weight_kg=${fmt(r?.weight_kg)}`,
      `  protein_g=${fmt(r?.protein_g)}  carbs_g=${fmt(r?.carbs_g)}  fat_g=${fmt(r?.fat_g)}`,
    ].join("\n");
  };

  const nowJsDate = new Date();
  const freshnessLines = freshness.map(
    (f) => `  ${f.source} last write: ${formatFreshness(nowJsDate, f.last_write_at, tz)}`,
  );

  return [
    composeNowLine(n),
    ``,
    renderTodaysPrescribedSession(trainingWeek, today, tz),
    ``,
    renderRow("TODAY", today),
    ``,
    renderRow("YESTERDAY", yesterday),
    ``,
    `DATA FRESHNESS:`,
    ...freshnessLines,
  ].join("\n");
}

/** Resolves today's prescribed session from the most-recent training_weeks
 *  row that covers today. Mirrors the brief's dual-key reader + coverage
 *  window. When no covering row exists, emits an explicit "no committed week"
 *  marker so coaches don't silently fall back to the legacy WEEKLY_SESSIONS
 *  mapping baked into their training. */
function renderTodaysPrescribedSession(
  trainingWeek: { week_start: string; session_plan: unknown; intensity_modifier: unknown } | null,
  today: string,
  tz: string,
): string {
  if (!trainingWeek) {
    return [
      `THIS WEEK'S PLAN: (no committed training_weeks row — answer "I don't see a committed week" and offer to plan one)`,
    ].join("\n");
  }
  const ws = new Date(`${trainingWeek.week_start}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const diffDays = Math.round((t - ws) / 86_400_000);
  if (diffDays < 0 || diffDays > 6) {
    return [
      `THIS WEEK'S PLAN: (most recent committed week starts ${trainingWeek.week_start} — does not cover today; no live plan)`,
    ].join("\n");
  }
  const weekdayLong = weekdayInUserTz(new Date(`${today}T12:00:00Z`), tz);
  const sessionPlan = (trainingWeek.session_plan ?? {}) as Record<string, string>;
  const todaysType = readSessionForDay(sessionPlan, weekdayLong) ?? "(no entry for today)";
  const planLines = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    .map((wd) => `  ${wd}: ${readSessionForDay(sessionPlan, wd) ?? "—"}`)
    .join("\n");
  return [
    `THIS WEEK'S PLAN (committed; week starts ${trainingWeek.week_start}; USE THESE LABELS verbatim — they SUPERSEDE any weekday→session mapping you may have inferred):`,
    planLines,
    `TODAY'S PRESCRIBED SESSION: ${todaysType} (${weekdayLong} ${today})`,
  ].join("\n");
}
