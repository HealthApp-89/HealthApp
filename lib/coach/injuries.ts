// lib/coach/injuries.ts
// Live injury lifecycle helpers (spec 2026-07-13). Pure date math takes ISO
// strings — callers own timezone resolution.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Injury, InjurySeverity, PrimaryLift } from "@/lib/data/types";

// ── Input types ───────────────────────────────────────────────────────────────

export type InjuryInput = {
  area: string;
  side?: string | null;
  cause?: string | null;
  severity?: string;
  onset_date?: string;
  affected_lifts?: string[];
  affected_session_types?: string[];
  notes?: string | null;
};

type ValidateOk = {
  ok: true;
  data: {
    area: string;
    side: string | null;
    cause: string | null;
    severity: InjurySeverity;
    onset_date: string;
    affected_lifts: PrimaryLift[];
    affected_session_types: string[];
    notes: string | null;
  };
};

type ValidateFail = { ok: false; error: string; code: string };

export type ValidateResult = ValidateOk | ValidateFail;

const VALID_SEVERITIES: InjurySeverity[] = ["mild", "moderate", "severe"];
const VALID_LIFTS: PrimaryLift[] = ["squat", "bench", "deadlift", "ohp"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure validator for injury create/patch input. Exported so the chat tool
 * (Task 3) can reuse it without duplicating rules.
 *
 * `todayIso` is the caller's tz-resolved "today" string (YYYY-MM-DD).
 */
export function validateInjuryInput(
  input: InjuryInput,
  todayIso: string,
): ValidateResult {
  // area
  const area = (input.area ?? "").trim();
  if (!area) return { ok: false, error: "area is required", code: "area_empty" };
  if (area.length > 40) return { ok: false, error: "area must be ≤40 chars", code: "area_too_long" };

  // severity
  const severity: InjurySeverity = (input.severity as InjurySeverity) ?? "moderate";
  if (!VALID_SEVERITIES.includes(severity)) {
    return { ok: false, error: `severity must be one of ${VALID_SEVERITIES.join("|")}`, code: "invalid_severity" };
  }

  // onset_date
  const onset_date = input.onset_date ?? todayIso;
  if (!DATE_RE.test(onset_date)) {
    return { ok: false, error: "onset_date must be YYYY-MM-DD", code: "invalid_onset_date" };
  }
  if (onset_date > todayIso) {
    return { ok: false, error: "onset_date cannot be in the future", code: "future_onset_date" };
  }

  // affected_lifts
  const affected_lifts: PrimaryLift[] = [];
  for (const lift of input.affected_lifts ?? []) {
    if (!VALID_LIFTS.includes(lift as PrimaryLift)) {
      return { ok: false, error: `affected_lifts must be a subset of ${VALID_LIFTS.join("|")}`, code: "invalid_lift" };
    }
    affected_lifts.push(lift as PrimaryLift);
  }

  // affected_session_types
  const affected_session_types: string[] = [];
  for (const st of input.affected_session_types ?? []) {
    if (st.length > 20) {
      return { ok: false, error: "each affected_session_types entry must be ≤20 chars", code: "session_type_too_long" };
    }
    affected_session_types.push(st);
  }

  // side
  const side = input.side ?? null;
  if (side !== null && side !== "left" && side !== "right") {
    return { ok: false, error: "side must be 'left', 'right', or null", code: "invalid_side" };
  }

  // notes
  const notes = input.notes ?? null;
  if (notes !== null && notes.length > 500) {
    return { ok: false, error: "notes must be ≤500 chars", code: "notes_too_long" };
  }

  return {
    ok: true,
    data: {
      area,
      side,
      cause: input.cause ?? null,
      severity,
      onset_date,
      affected_lifts,
      affected_session_types,
      notes,
    },
  };
}

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
