// lib/coach/session-debrief/payload.ts
//
// Re-export of WorkoutDebriefPayload (the canonical type lives in lib/data/types.ts
// next to the other *Payload types) plus the pure tldr templater used to
// populate chat_messages.content from the assembled payload. No AI calls;
// this is plain templating so the TL;DR stays predictable and searchable.

export type { WorkoutDebriefPayload } from "@/lib/data/types";
import type { WorkoutDebriefPayload } from "@/lib/data/types";

/** Build the 2-3 line TL;DR shown on the chat card and stored in
 *  chat_messages.content. Pure templating — see compose-lifts / compose-volume
 *  / compose-autoregulation for the upstream signals. */
export function tldrFromPayload(p: WorkoutDebriefPayload): string {
  const lines: string[] = [];

  // Line 1: PR / stall summary.
  const prs = p.lifts.filter((l) => l.tag === "PR");
  const stalls = p.lifts.filter((l) => l.tag === "stall");
  const regressions = p.lifts.filter((l) => l.tag === "regression");

  const summary: string[] = [];
  if (prs.length > 0) {
    const names = prs.slice(0, 2).map((l) => {
      const d = l.delta_e1rm != null ? ` +${l.delta_e1rm.toFixed(1)}kg e1RM` : "";
      return `${l.name}${d}`;
    });
    summary.push(`✓ ${prs.length} PR${prs.length > 1 ? "s" : ""} (${names.join(", ")})`);
  }
  if (stalls.length > 0) {
    summary.push(`⚠ ${stalls.length} stalled (${stalls.slice(0, 2).map((l) => l.name).join(", ")})`);
  }
  if (regressions.length > 0) {
    summary.push(`↓ ${regressions.length} regressed`);
  }
  if (summary.length === 0) {
    summary.push(`${p.lifts.length} lifts logged`);
  }
  lines.push(summary.join(" · "));

  // Line 2: autoregulation + volume status.
  const arBits: string[] = [];
  if (p.autoregulation.today_recovery != null) {
    arBits.push(`Recovery ${p.autoregulation.today_recovery}%`);
  }
  const overMrv = p.volume.filter((v) => v.status === "over_mrv");
  const approaching = p.volume.filter((v) => v.status === "approaching_mrv");
  if (overMrv.length > 0) {
    arBits.push(`${overMrv.map((v) => v.muscle).join(", ")} over MRV`);
  } else if (approaching.length > 0) {
    arBits.push(`${approaching.map((v) => v.muscle).join(", ")} approaching MRV`);
  }
  if (arBits.length > 0) lines.push(arBits.join(" · "));

  // Line 3: mid-week repatch signal (deterministic — mirrors the
  // "Plan updated for <weekday>: …" notes written by loadRepatchNotes).
  const repatched = p.prescription.notes.filter((n) => n.startsWith("Plan updated for "));
  if (repatched.length > 0) {
    const days = repatched.map((n) => n.slice("Plan updated for ".length).split(":")[0]);
    lines.push(`↻ Plan updated: ${days.join(", ")}`);
  }

  return lines.join("\n");
}
