import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: profs } = await sb.from("profiles").select("user_id, timezone").limit(5);
const uid = profs[0].user_id, tz = profs[0].timezone;
const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
const d = new Date(today + "T12:00:00Z");
const dow = d.getUTCDay();
const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
const wk = monday.toISOString().slice(0, 10);
const weekday = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
console.log(JSON.stringify({ uid, tz, today, weekday, week_start: wk }, null, 1));
const { data: tw } = await sb.from("training_weeks")
  .select("week_start, session_plan, session_prescriptions, exercise_overrides, manual_session_edits")
  .eq("user_id", uid).eq("week_start", wk).maybeSingle();
if (!tw) { console.log("NO training_weeks ROW for", wk); process.exit(0); }
console.log("session_plan[" + weekday + "] =", JSON.stringify(tw.session_plan?.[weekday]));
for (const k of ["session_prescriptions", "exercise_overrides", "manual_session_edits"]) {
  const v = tw[k]?.[weekday] ?? tw[k]?.[weekday.slice(0,3)] ?? null;
  console.log(`\n--- ${k}[${weekday}] ---`);
  if (!v) { console.log("(none)"); continue; }
  for (const e of (Array.isArray(v) ? v : [v])) {
    console.log(`  ${e.warmup ? "[w] " : "    "}${(e.name??JSON.stringify(e)).padEnd(42)} sets=${e.sets ?? "-"} kg=${e.baseKg ?? "-"} reps=${e.baseReps ?? e.reps ?? "-"}${e.superset ? " ss=" + e.superset : ""}`);
  }
}
