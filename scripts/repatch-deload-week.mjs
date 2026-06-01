/**
 * One-off: re-apply the new deload rule to THIS week's session_prescriptions
 * across all weekdays. Two transformations:
 *   1. sets = max(2, current_sets)  — every exercise lifts to MEV floor.
 *   2. Hip Thrust (Machine) baseKg gets the 0.80× reduction it never received
 *      (it was inserted raw by the earlier one-off script that didn't run the
 *      deload transform).
 *
 * Idempotent. Only mutates rows with research_phase='deload'.
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function mondayOnOrBefore(dateIso) {
  const d = new Date(dateIso + "T12:00:00Z");
  const dow = d.getUTCDay();
  const delta = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

function roundToStep(kg, step) {
  return Math.round(kg / step) * step;
}

async function main() {
  const { data: profs } = await supabase.from("profiles").select("user_id").limit(1);
  const userId = profs[0].user_id;
  const weekStart = mondayOnOrBefore(new Date().toISOString().slice(0, 10));

  const { data: tw, error } = await supabase
    .from("training_weeks")
    .select("id, research_phase, session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  if (!tw) { console.error("no training_weeks row"); process.exit(1); }
  if (tw.research_phase !== "deload") {
    console.error(`research_phase is ${tw.research_phase}, not deload — aborting.`);
    process.exit(1);
  }

  const presc = tw.session_prescriptions ?? {};
  let changed = false;
  const next = {};
  for (const [day, exes] of Object.entries(presc)) {
    if (!Array.isArray(exes)) { next[day] = exes; continue; }
    next[day] = exes.map((ex) => {
      const e = { ...ex };
      const oldSets = e.sets ?? 1;
      const newSets = Math.max(2, oldSets);
      if (newSets !== oldSets) {
        e.sets = newSets;
        changed = true;
      }
      // Hip Thrust fix: prior one-off script inserted raw SESSION_PLANS values
      // (60kg × 10 × 3) without running the deload transform. Apply both the
      // 0.80× load reduction AND the sets reduction (3 baseline → 2 deload).
      if (e.key === "hip_thrust_machine") {
        const step = e.increment?.step ?? 2.5;
        if (e.baseKg === 60) {
          e.baseKg = roundToStep(60 * 0.80, step);
          changed = true;
        }
        if (e.sets === 3) {
          e.sets = 2;
          changed = true;
        }
      }
      return e;
    });
  }

  if (!changed) {
    console.log("All exercises already at MEV floor and Hip Thrust load already correct. No-op.");
    return;
  }

  for (const day of Object.keys(next)) {
    if (!Array.isArray(next[day])) continue;
    console.log(`\n${day}:`);
    for (const ex of next[day]) {
      console.log(`  ${ex.name?.padEnd(28)} kg=${ex.baseKg ?? "—"}  reps=${ex.baseReps ?? "—"}  sets=${ex.sets ?? "—"}`);
    }
  }

  const { error: uErr } = await supabase
    .from("training_weeks")
    .update({ session_prescriptions: next, updated_at: new Date().toISOString() })
    .eq("id", tw.id);
  if (uErr) throw uErr;
  console.log("\nUpdated.");
}

main().catch((e) => { console.error(e); process.exit(1); });
