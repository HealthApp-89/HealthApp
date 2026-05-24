// lib/coach/recovery-intelligence/compose-subjective.ts
//
// 28d series of morning-intake feel data + a derived mobility_done flag
// computed by checking whether `workouts` has a 'Mobility'-type row sourced
// from chat (external_id starts 'chat-mobility-') for that date.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubjectivePoint, SorenessSeverity } from "./types";

const WINDOW_DAYS = 28;

export async function composeSubjective(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<SubjectivePoint[]> {
  const { supabase, userId, today } = args;

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  // checkins is keyed on date too.
  const checkinsP = supabase
    .from("checkins")
    .select("date,fatigue,sick,sickness_notes,soreness_areas,soreness_severity")
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today);

  // Mobility presence: 'Mobility' type, chat source. external_id pattern
  // 'chat-mobility-YYYY-MM-DD' is the durable signal (see lib/coach/tools.ts:executeMarkMobilityDone).
  const mobilityP = supabase
    .from("workouts")
    .select("date")
    .eq("user_id", userId)
    .eq("type", "Mobility")
    .like("external_id", "chat-mobility-%")
    .gte("date", startIso)
    .lte("date", today);

  const [checkins, mobility] = await Promise.all([checkinsP, mobilityP]);
  if (checkins.error) throw checkins.error;
  if (mobility.error) throw mobility.error;

  type CheckinRow = { date: string; fatigue: 'none' | 'some' | 'heavy' | null; sick: boolean | null; sickness_notes: string | null; soreness_areas: string[] | null; soreness_severity: SorenessSeverity };
  const byDate = new Map<string, CheckinRow>();
  for (const r of (checkins.data ?? []) as CheckinRow[]) byDate.set(r.date, r);

  const mobilitySet = new Set<string>((mobility.data ?? []).map((r) => r.date));

  const out: SubjectivePoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const c = byDate.get(iso);
    out.push({
      date: iso,
      fatigue: c?.fatigue ?? null,
      sick: !!c?.sick,
      sickness_notes: c?.sickness_notes ?? null,
      soreness_areas: c?.soreness_areas ?? [],
      soreness_severity: c?.soreness_severity ?? null,
      mobility_done: mobilitySet.has(iso),
    });
  }
  return out;
}
