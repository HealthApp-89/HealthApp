// lib/training-weeks/apply-swap.ts
//
// Pure compute for mid-week schedule swaps. No I/O. The endpoint handler
// (app/api/training-weeks/[week_start]/swap/route.ts) wraps these with auth,
// load, validate, identity-check, conflict gate, and the DB write.
//
// Dual-key tolerance: training_weeks.session_plan may use 3-letter ("Mon")
// or full-name ("Monday") keys depending on whether the AI planner wrote it
// or a future normalization migration runs. All reads route through
// readSessionForDay; writes preserve whichever key form is already present
// in the plan (so a "Monday"-shaped plan stays "Monday"-shaped).

import type { SessionPlan, SwapBody, SwapConflict, Weekday } from "@/lib/data/types";
import { readSessionForDay, SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Returns the actual key (3-letter or full) that exists in `plan` for the
 *  given weekday. If neither form is present, returns the 3-letter form. */
function keyFor(plan: Record<string, string>, day: Weekday): string {
  if (Object.prototype.hasOwnProperty.call(plan, day)) return day;
  const full = SHORT_TO_FULL[day];
  if (Object.prototype.hasOwnProperty.call(plan, full)) return full;
  return day; // default to short form for writes when neither exists yet
}

/** Sets plan[weekday] = value, using whichever key form is already present
 *  in `plan` for that day (preserves the file's existing convention). */
function writeDay(plan: Record<string, string>, day: Weekday, value: string): void {
  const k = keyFor(plan, day);
  plan[k] = value;
}

/** Apply a swap or replace to the plan. Returns a new plan; does not mutate
 *  the input. Returns the input shape if the operation is a no-op (swap with
 *  same day, replace with same type). */
export function applySwap(plan: SessionPlan, body: SwapBody): SessionPlan {
  const out: Record<string, string> = { ...(plan as Record<string, string>) };
  if (body.action === "swap") {
    if (body.source_day === body.target_day) return plan;
    const srcVal = readSessionForDay(out, body.source_day);
    const tgtVal = readSessionForDay(out, body.target_day);
    if (srcVal === undefined || tgtVal === undefined) {
      // Either day is missing from the plan — pass through unchanged.
      // The endpoint validates this case and rejects; this is defense in depth.
      return plan;
    }
    writeDay(out, body.source_day, tgtVal);
    writeDay(out, body.target_day, srcVal);
  } else {
    // action === 'replace'
    const cur = readSessionForDay(out, body.source_day);
    if (cur === body.session_type) return plan;
    writeDay(out, body.source_day, body.session_type);
  }
  return out as SessionPlan;
}

/** Days adjacent in the Mon-Sun ordering. Week wraps: Sun is adjacent to Sat
 *  only (not to Mon — we don't treat the week as a cycle for conflict checks).
 *  Returns 1 or 2 weekdays. */
function neighbors(day: Weekday): Weekday[] {
  const idx = ORDER.indexOf(day);
  const out: Weekday[] = [];
  if (idx > 0) out.push(ORDER[idx - 1]);
  if (idx < ORDER.length - 1) out.push(ORDER[idx + 1]);
  return out;
}

/** True if the session type is exempt from conflict checks. */
function isExempt(sessionType: string | undefined): boolean {
  if (!sessionType) return true;
  const lower = sessionType.toLowerCase().trim();
  return lower === "rest" || lower === "mobility";
}

/** Detect identical-session-type-within-48h conflicts AFTER applying `body`.
 *  For action='swap', checks both endpoints. For action='replace', checks only
 *  source_day. Returns an empty array when there are no conflicts. */
export function detectConflicts(plan: SessionPlan, body: SwapBody): SwapConflict[] {
  const newPlan = applySwap(plan, body) as Record<string, string>;
  const daysToCheck: Weekday[] =
    body.action === "swap" ? [body.source_day, body.target_day] : [body.source_day];
  const out: SwapConflict[] = [];
  const seen = new Set<string>();
  for (const day of daysToCheck) {
    const placed = readSessionForDay(newPlan, day);
    if (isExempt(placed)) continue;
    for (const n of neighbors(day)) {
      const neighbor = readSessionForDay(newPlan, n);
      if (isExempt(neighbor)) continue;
      if (placed === neighbor) {
        // Dedupe: an adjacency pair (X, Y) with the same session_type is
        // the same conflict regardless of which endpoint we approached from.
        // Canonical key uses ORDER index to sort the two days.
        const a = ORDER.indexOf(day);
        const b = ORDER.indexOf(n);
        const key = a < b ? `${day}|${n}|${placed}` : `${n}|${day}|${placed}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ day, neighbor_day: n, session_type: placed as string });
      }
    }
  }
  return out;
}

/** Deep equality for SessionPlan jsonb. Comparison is on canonical short-form
 *  keys so a plan that says {Mon: 'Legs'} compares equal to {Monday: 'Legs'}. */
export function plansEqual(a: SessionPlan, b: SessionPlan): boolean {
  for (const day of ORDER) {
    const av = readSessionForDay(a as Record<string, string>, day);
    const bv = readSessionForDay(b as Record<string, string>, day);
    if (av !== bv) return false;
  }
  return true;
}
