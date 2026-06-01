/**
 * One-off: reorder THIS week's training_weeks session_prescriptions.Monday
 * to tier-ascending (T1 -> T2 -> T3) with muscle-grouping inside T3.
 *
 * Idempotent: re-running with the desired order already in place no-ops.
 * Strictly a permutation — does not add or remove any exercises.
 *
 * Run:
 *   node --env-file=.env.local scripts/reorder-legs-this-week.mjs
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Canonical Legs order, by key. Names may be variants ("Leg Press Single Leg"
// vs "Leg Press") — match on key when present, fall back to fuzzy name match.
const TARGET_ORDER = [
  { key: "squat",              nameContains: "squat" },
  { key: "leg_press",          nameContains: "leg press" },
  { key: "hip_thrust_machine", nameContains: "hip thrust" },
  { key: "leg_ext",            nameContains: "leg extension" },
  { key: "leg_curl",           nameContains: "leg curl" },
  { key: "abductor",           nameContains: "abductor" },
  { key: "calf",               nameContains: "calf" },
];

function mondayOnOrBefore(dateIso) {
  const d = new Date(dateIso + "T12:00:00Z");
  const dow = d.getUTCDay();
  const delta = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

function pickIndex(list, target) {
  let idx = list.findIndex((e) => e?.key === target.key);
  if (idx >= 0) return idx;
  return list.findIndex((e) => typeof e?.name === "string" && e.name.toLowerCase().includes(target.nameContains));
}

async function main() {
  const { data: profs, error: pErr } = await supabase.from("profiles").select("user_id").limit(2);
  if (pErr) throw pErr;
  if (profs.length !== 1) { console.error("Expected single user"); process.exit(1); }
  const userId = profs[0].user_id;
  const weekStart = mondayOnOrBefore(new Date().toISOString().slice(0, 10));

  const { data: tw, error: twErr } = await supabase
    .from("training_weeks")
    .select("id, session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (twErr) throw twErr;
  if (!tw) { console.error(`No training_weeks row for ${weekStart}`); process.exit(1); }

  const presc = tw.session_prescriptions ?? {};
  const monday = Array.isArray(presc.Monday) ? [...presc.Monday] : null;
  if (!monday) { console.error("No Monday prescription"); process.exit(1); }

  // Build the reordered list. Unknown extras (not in TARGET_ORDER) append at end.
  const consumed = new Set();
  const reordered = [];
  for (const t of TARGET_ORDER) {
    const idx = pickIndex(monday, t);
    if (idx >= 0 && !consumed.has(idx)) {
      reordered.push(monday[idx]);
      consumed.add(idx);
    }
  }
  for (let i = 0; i < monday.length; i++) {
    if (!consumed.has(i)) reordered.push(monday[i]);
  }

  if (monday.length !== reordered.length) {
    console.error(`Reorder length mismatch (was ${monday.length}, now ${reordered.length}) — aborting.`);
    process.exit(1);
  }

  const sameOrder = monday.every((e, i) => e?.name === reordered[i]?.name);
  if (sameOrder) {
    console.log("Monday is already in the target order. No-op.");
    return;
  }

  console.log("Before:", monday.map((e) => e?.name));
  console.log("After :", reordered.map((e) => e?.name));

  const { error: uErr } = await supabase
    .from("training_weeks")
    .update({ session_prescriptions: { ...presc, Monday: reordered }, updated_at: new Date().toISOString() })
    .eq("id", tw.id);
  if (uErr) throw uErr;
  console.log(`Reordered Monday on training_weeks ${tw.id}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
