"use client";

import type { CoachLine } from "@/lib/coach/live-session";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  line: CoachLine;
  /** Called with the suggested load when the athlete taps the number.
   *  Absent when the line carries no apply_kg. */
  onApply?: (kg: number) => void;
};

const TONE: Record<CoachLine["kind"], string> = {
  pr: "text-green-400 bg-green-500/10 border-green-500/30",
  guardrail: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  load_call: "text-blue-400 bg-blue-500/10 border-blue-500/30",
};

export function CoachLineRow({ line, onApply }: Props) {
  return (
    <div
      role="status"
      // A cued line is the one the rule engine says something genuinely
      // happened on (today only PRs set it), so it announces itself instead of
      // waiting for a quiet moment. Non-cued lines stay polite.
      aria-live={line.cue ? "assertive" : "polite"}
      // `cue` previously had no consumer at all: tone came solely from `kind`,
      // so the flag was set, tested, documented — and read by nothing. Giving
      // it the emphasis ring makes the field mean what it claims.
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 my-1 text-[11px] leading-snug ${TONE[line.kind]} ${
        line.cue ? "ring-1 ring-current/40" : ""
      }`}
    >
      <span className="flex-1">{line.text}</span>
      {line.apply_kg != null && onApply && (
        <button
          type="button"
          onClick={() => onApply(line.apply_kg as number)}
          className="shrink-0 font-mono tabular-nums font-semibold px-2 py-1 rounded-md bg-blue-500/20 hover:bg-blue-500/30"
          aria-label={`Set next set to ${fmtNum(line.apply_kg)} kilograms`}
        >
          {fmtNum(line.apply_kg)}
        </button>
      )}
    </div>
  );
}
