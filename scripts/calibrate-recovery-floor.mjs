// scripts/calibrate-recovery-floor.mjs
// Read-only: reports the Garmin-era recovery sub-score distribution so the
// red-recovery floor thresholds in lib/ui/score.ts can be re-tuned. No writes.
import { createClient } from "@supabase/supabase-js";
import { deriveReadiness } from "../lib/ui/score.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("set AUDIT_USER_ID"); process.exit(1); }

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const since = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
const { data, error } = await sb
  .from("daily_logs")
  .select("date,hrv,resting_hr,sleep_score,deep_sleep_hours")
  .eq("user_id", userId).gte("date", since).order("date");
if (error) throw error;

// hrvBaseline: pull the same denominator deriveReadiness uses (6mo avg ?? 33).
const { data: prof } = await sb.from("profiles").select("whoop_baselines").eq("user_id", userId).maybeSingle();
const hrvBaseline = (prof?.whoop_baselines?.hrv_6mo_avg) ?? 33;

const subs = [];
for (const log of data ?? []) {
  const r = deriveReadiness({ log, checkin: null, hrvBaseline, weightKg: null, calorieTarget: null });
  if (r.recoverySubScore != null) subs.push(r.recoverySubScore);
}
subs.sort((a, b) => a - b);
const pct = (p) => subs.length ? subs[Math.floor((p / 100) * (subs.length - 1))] : null;
const below = (t) => subs.filter((s) => s < t).length;
console.log(`n=${subs.length} days with a recovery sub-score`);
console.log(`min=${subs[0]} p10=${pct(10)} p20=${pct(20)} median=${pct(50)} max=${subs.at(-1)}`);
console.log(`current floor 25 → ${below(25)} days low (${((below(25)/subs.length)*100).toFixed(1)}%)`);
console.log(`current cap   40 → ${below(40)} days capped-or-low (${((below(40)/subs.length)*100).toFixed(1)}%)`);
console.log(`suggested LOW≈p10=${pct(10)}, CAP≈p20=${pct(20)} (aim ~10%/20% hit rates)`);
