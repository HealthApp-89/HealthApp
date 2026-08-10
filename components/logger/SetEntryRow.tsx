"use client";

import { useState } from "react";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { selectOnFocus } from "@/lib/ui/inputs";

type Props = {
  set: ExerciseSetDraft;
  workingSetNumber: number;
  workSeconds: number;
  /** Time-based exercise: show a single seconds field instead of kg/reps/RIR. */
  timeBased: boolean;
  /** What the prescription itself specifies, used ONLY to tell "the athlete
   *  cleared a field the plan asks for" apart from "this exercise has no such
   *  field". Bodyweight and mobility work carries neither — see the Save
   *  guard below. */
  prescribedKg: number | null;
  prescribedReps: number | null;
  canRemove: boolean;
  onChange: (patch: Partial<ExerciseSetDraft>) => void;
  onSave: () => void;
  onRemove: () => void;
};

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function SetEntryRow({
  set, workingSetNumber, workSeconds, timeBased, prescribedKg, prescribedReps,
  canRemove, onChange, onSave, onRemove,
}: Props) {
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [draftKg, setDraftKg] = useState(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useState(set.reps !== null ? String(set.reps) : "");
  const [draftRir, setDraftRir] = useState(
    set.rir !== null && set.rir !== undefined ? String(set.rir) : "",
  );
  const [draftSecs, setDraftSecs] = useState(
    set.duration_seconds !== null ? String(set.duration_seconds) : String(workSeconds),
  );

  // Identical coupling to SetRow.selectBadge: F means zero reps in reserve by
  // definition, so it auto-fills rir=0. Leaving F undoes the auto-fill ONLY
  // when rir is still 0, so a hand-typed value survives badge fiddling.
  const selectBadge = (next: { warmup: boolean; failure: boolean }) => {
    if (next.failure) {
      onChange({ ...next, rir: 0 });
      setDraftRir("0");
    } else if (set.failure && set.rir === 0) {
      onChange({ ...next, rir: null });
      setDraftRir("");
    } else {
      onChange(next);
    }
    setBadgeOpen(false);
  };

  const label = set.warmup ? "W" : set.failure ? "F" : String(workingSetNumber);
  const failed = set.failure;

  const num = (raw: string, parse: (s: string) => number): number | null => {
    if (raw === "") return null;
    const n = parse(raw);
    return Number.isFinite(n) ? n : null;
  };

  /**
   * Push every field onto the draft, then save.
   *
   * The per-field onBlur handlers are not enough on their own. `draftSecs`
   * SEEDS itself from the timer's measured work time, so on a time-based set
   * it legitimately differs from `set.duration_seconds` (null) from the moment
   * the zoom opens — tapping Save without ever focusing the field would commit
   * a null duration and throw away the number the timer just measured. The
   * kg/reps/RIR flush is belt-and-braces for the same reason: Save must not
   * depend on a blur having fired first.
   */
  const saveAll = () => {
    if (timeBased) {
      onChange({ duration_seconds: num(draftSecs, (s) => parseInt(s, 10)) });
    } else {
      const rir = num(draftRir, (s) => parseInt(s, 10));
      onChange({
        kg: num(draftKg, parseFloat),
        reps: num(draftReps, (s) => parseInt(s, 10)),
        rir: rir === null ? null : Math.max(0, Math.min(10, rir)),
      });
    }
    onSave();
  };

  /**
   * Block Save only on data that is genuinely MISSING — a field the plan asks
   * for that the athlete has emptied. Never on a field the exercise does not
   * have.
   *
   * A blanket "kg and reps must both be non-null" (SetRow's guard, transplanted
   * whole) bricks this button on every bodyweight and mobility prescription:
   * Push Up — the first row of every Push session — plus Dead Bug, Reverse
   * Crunch, Back Extension and most of the Wednesday mobility list carry no
   * `baseKg`, and several carry no `baseReps` either. Those athletes were being
   * told "Enter a weight to save" on a bodyweight movement. So each half is
   * gated on the prescription actually specifying that field.
   *
   * Evaluated against the LOCAL field values rather than `set`, deliberately.
   * The draft only catches up on blur, and a `disabled` button swallows the
   * very tap that would have blurred the input — reading `set.reps` would leave
   * Save dead under a rep count the athlete can plainly see. This asks the
   * honest question instead: would saving right now drop a number the plan
   * expects?
   *
   * Time-based work is measured in seconds and carries neither. Warmups are
   * exempt from the kg half, as in SetRow.
   */
  const missingKg =
    !timeBased && !set.warmup && prescribedKg != null && num(draftKg, parseFloat) === null;
  const missingReps =
    !timeBased && prescribedReps != null && num(draftReps, (s) => parseInt(s, 10)) === null;
  const cannotSave = missingKg || missingReps;

  return (
    <div className={`rounded-xl p-2.5 my-1.5 border ${
      failed ? "bg-stone-950 border-red-500/50" : "bg-stone-900 border-blue-500/50"
    }`}>
      <div className="flex items-center gap-2 mb-2 relative">
        <button
          type="button"
          onClick={() => setBadgeOpen((v) => !v)}
          aria-label="Change set type"
          aria-haspopup="menu"
          aria-expanded={badgeOpen}
          className={`w-[26px] h-[26px] rounded-lg text-[13px] font-bold flex-none ${
            failed ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/45" : "bg-zinc-800 text-zinc-50 ring-1 ring-zinc-700"
          }`}
        >
          {label}
        </button>
        {badgeOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setBadgeOpen(false)} aria-hidden />
            <div className="absolute left-0 top-8 z-20 bg-zinc-800 border border-zinc-700 rounded-lg p-1 flex flex-col gap-0.5" role="menu">
              <button type="button" role="menuitem" onClick={() => selectBadge({ warmup: false, failure: false })} className="w-9 h-7 rounded text-[11px] font-bold bg-zinc-700 text-zinc-50">{workingSetNumber}</button>
              <button type="button" role="menuitem" onClick={() => selectBadge({ warmup: true, failure: false })} className="w-9 h-7 rounded text-[11px] font-bold bg-yellow-500/20 text-yellow-300">W</button>
              <button type="button" role="menuitem" onClick={() => selectBadge({ warmup: false, failure: true })} className="w-9 h-7 rounded text-[11px] font-bold bg-red-500/20 text-red-400">F</button>
              <button
                type="button"
                role="menuitem"
                aria-label="Delete set"
                disabled={!canRemove}
                onClick={() => { onRemove(); setBadgeOpen(false); }}
                className="w-9 h-7 rounded text-[11px] font-bold bg-zinc-900 text-zinc-400 border-t border-zinc-700 mt-0.5 disabled:opacity-30"
              >✕</button>
            </div>
          </>
        )}
        <span className={`text-[10px] uppercase tracking-wide font-semibold flex-1 ${failed ? "text-red-400" : "text-zinc-400"}`}>
          {failed ? "to failure" : "log it"}
        </span>
        <span className={`font-mono text-[10.5px] px-2 py-0.5 rounded-full whitespace-nowrap ${
          failed ? "text-red-300 bg-red-500/15" : "text-blue-300 bg-blue-500/15"
        }`}>
          ◷ {mmss(workSeconds)} work
        </span>
      </div>

      {timeBased ? (
        <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-2 py-2 text-center">
          <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">seconds</div>
          <input
            inputMode="numeric"
            value={draftSecs}
            onFocus={selectOnFocus}
            onChange={(e) => setDraftSecs(e.target.value)}
            onBlur={() => {
              const n = draftSecs === "" ? null : parseInt(draftSecs, 10);
              onChange({ duration_seconds: Number.isFinite(n as number) ? (n as number) : null });
            }}
            className="bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] text-zinc-50"
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-1 py-2 text-center">
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">kg</div>
            <input
              inputMode="decimal"
              value={draftKg}
              onFocus={selectOnFocus}
              onChange={(e) => setDraftKg(e.target.value)}
              onBlur={() => {
                const n = draftKg === "" ? null : parseFloat(draftKg);
                onChange({ kg: Number.isFinite(n as number) ? (n as number) : null });
              }}
              className="bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] text-zinc-50"
            />
          </div>
          <div className="bg-zinc-950 border border-blue-500 rounded-xl px-1 py-2 text-center">
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">reps</div>
            <input
              inputMode="numeric"
              value={draftReps}
              onFocus={selectOnFocus}
              onChange={(e) => setDraftReps(e.target.value)}
              onBlur={() => {
                const n = draftReps === "" ? null : parseInt(draftReps, 10);
                onChange({ reps: Number.isFinite(n as number) ? (n as number) : null });
              }}
              className="bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] text-blue-400"
            />
          </div>
          <div className={`bg-zinc-950 rounded-xl px-1 py-2 text-center border ${
            failed ? "border-red-500/45" : "border-zinc-700"
          }`}>
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">rir</div>
            <input
              inputMode="numeric"
              value={draftRir}
              disabled={failed}
              aria-label="Reps in reserve"
              onFocus={selectOnFocus}
              onChange={(e) => setDraftRir(e.target.value)}
              onBlur={() => {
                const n = draftRir === "" ? null : parseInt(draftRir, 10);
                const clamped = n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(10, n));
                onChange({ rir: clamped });
              }}
              className={`bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] ${
                failed ? "text-red-400" : "text-zinc-50"
              }`}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={saveAll}
        disabled={cannotSave}
        className={`mt-2 w-full rounded-lg py-2 text-[11.5px] font-bold disabled:opacity-40 ${
          failed ? "bg-red-500/20 text-red-300" : "bg-green-500 text-green-950"
        }`}
      >
        ✓ {failed ? "Save as failure" : "Save"}
      </button>

      {cannotSave && (
        <p className="text-[9px] text-zinc-500 mt-1.5 text-center">
          {missingReps ? "Enter reps to save" : "Enter a weight to save"}
        </p>
      )}

      {failed && (
        <p className="text-[9px] text-red-400 mt-1.5 text-center italic">
          F ⇒ RIR 0 by definition · leaving F releases it
        </p>
      )}
    </div>
  );
}
