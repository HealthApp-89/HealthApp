// lib/coach/injuries.ts
// Live injury lifecycle helpers (spec 2026-07-13). Pure date math takes ISO
// strings — callers own timezone resolution.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Injury, PrimaryLift } from "@/lib/data/types";

export async function fetchActiveInjuries(supabase: SupabaseClient, userId: string): Promise<Injury[]> {
  const { data, error } = await supabase
    .from("injuries").select("*")
    .eq("user_id", userId).eq("status", "active")
    .order("onset_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Injury[];
}

/** Was this injury active on the given day? Onset-inclusive; a resolved
 *  injury covers days up to and including its resolved_at DATE. */
export function injuryActiveOn(injury: Injury, dateIso: string): boolean {
  if (dateIso < injury.onset_date) return false;
  if (injury.status === "active" || injury.resolved_at == null) return true;
  return dateIso <= injury.resolved_at.slice(0, 10);
}

function daysBetweenIso(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000);
}

/** The injury gating `lift` over [fromIso, toIso], if its active span covers
 *  at least half the window. Ties broken by most recent onset. */
export function liftInjuryFor(
  injuries: Injury[], lift: PrimaryLift, fromIso: string, toIso: string,
): Injury | null {
  const windowDays = Math.max(1, daysBetweenIso(fromIso, toIso));
  for (const inj of injuries) {
    if (!inj.affected_lifts.includes(lift)) continue;
    const activeFrom = inj.onset_date > fromIso ? inj.onset_date : fromIso;
    const activeTo = inj.status === "resolved" && inj.resolved_at != null && inj.resolved_at.slice(0, 10) < toIso
      ? inj.resolved_at.slice(0, 10) : toIso;
    const overlap = daysBetweenIso(activeFrom, activeTo);
    if (overlap * 2 >= windowDays) return inj;
  }
  return null;
}
