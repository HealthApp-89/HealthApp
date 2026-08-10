"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  countdownRemaining,
  elapsedWorkSeconds,
  getElapsedMs,
  restRemaining,
  isRestOvertime,
  type TimerState,
} from "@/lib/logger/set-timer";

type Props = {
  state: TimerState;
  /** e.g. "Decline Bench · set 2" */
  activeLabel: string;
  /** e.g. "85 kg × 8 @ RIR 2" */
  targetLabel: string;
  /** Sum of committed work_seconds so far this session. */
  workSecondsTotal: number;
  /**
   * Session-clock INPUTS, deliberately raw rather than a precomputed
   * `sessionElapsedMs`. A number computed in the parent's render would freeze
   * between parent renders — and the parent must not re-render per tick,
   * because that would re-render every memoized ExerciseCard. The dock owns
   * its tick and calls the shared pure `getElapsedMs` itself.
   */
  startedAt: string;
  pausedAt: string | null;
  pausedMsTotal: number;
  /** False when every set is already committed. The START affordance is then
   *  disabled rather than dispatching a start for a set that does not exist. */
  canStart: boolean;
  onStart: () => void;
  onCountdownElapsed: () => void;
  onStop: () => void;
};

function mmss(totalSeconds: number): string {
  const neg = totalSeconds < 0;
  const s = Math.abs(Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${neg ? "−" : ""}${m}:${r.toString().padStart(2, "0")}`;
}

export function SetTimerDock({
  state, activeLabel, targetLabel, workSecondsTotal,
  startedAt, pausedAt, pausedMsTotal, canStart,
  onStart, onCountdownElapsed, onStop,
}: Props) {
  // Portal to <body> so the dock escapes the LoggerSheet stacking context. The
  // sheet is `fixed z-40`; BottomNav is ALSO body-level `fixed z-40` but is
  // rendered after <main>, so an equal-z child of the sheet loses the tie and
  // is painted over — and `--nav-h` is 120px, taller than this dock, so the
  // whole 78px circle would sit under it and be un-tappable. Same lesson as
  // ReorderDialog and DayEditSheet; `mounted` is the SSR guard those use.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // This component owns the tick. Nothing time-varying is passed down from
  // LoggerSheet, so the memoized ExerciseCards never re-render on it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Tick while a set/rest phase is live, and also while the session clock is
  // simply running — otherwise the SESSION counter would sit frozen at rest.
  const ticking = state.phase !== "idle" || pausedAt === null;

  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [ticking]);

  // Fire the countdown-end transition from the display that is already
  // watching the clock, rather than from a second timer that could drift.
  const cdLeft = countdownRemaining(state, nowMs);
  useEffect(() => {
    if (state.phase === "countdown" && cdLeft === 0) onCountdownElapsed();
  }, [state.phase, cdLeft, onCountdownElapsed]);

  const overtime = isRestOvertime(state, nowMs);
  const restLeft = restRemaining(state, nowMs);
  const sessionElapsedMs = getElapsedMs(
    { started_at: startedAt, paused_at: pausedAt, paused_ms_total: pausedMsTotal },
    nowMs,
  );

  const circle = (() => {
    switch (state.phase) {
      case "idle":
        return {
          onClick: onStart,
          disabled: !canStart,
          className: "bg-green-500 text-green-950 shadow-[0_0_0_4px_rgba(34,197,94,0.16)]",
          big: "START", bigClass: "text-base", sub: "begin set",
          aria: "Start set",
        };
      case "countdown":
        return {
          onClick: onCountdownElapsed,
          disabled: false,
          className: "bg-stone-900 text-yellow-300 shadow-[0_0_0_4px_rgba(250,204,21,0.14)]",
          big: String(Math.max(1, cdLeft)), bigClass: "text-4xl", sub: "tap to skip",
          aria: "Skip countdown",
        };
      case "running":
        return {
          onClick: onStop,
          disabled: false,
          className: "bg-zinc-900 text-zinc-50 shadow-[0_0_0_4px_rgba(59,130,246,0.14)]",
          big: mmss(elapsedWorkSeconds(state, nowMs)), bigClass: "text-2xl", sub: "stop",
          aria: "Stop set",
        };
      case "rest":
        return overtime
          ? {
              onClick: onStart,
              disabled: !canStart,
              className: "bg-red-500 text-red-950 shadow-[0_0_0_4px_rgba(239,68,68,0.2)]",
              big: mmss(restLeft), bigClass: "text-xl", sub: "start next",
              aria: "Start next set",
            }
          : {
              onClick: onStart,
              disabled: !canStart,
              className: "bg-zinc-950 text-green-400 shadow-[0_0_0_4px_rgba(34,197,94,0.12)]",
              big: mmss(restLeft), bigClass: "text-xl", sub: "start early",
              aria: "Start next set early",
            };
    }
  })();

  const restSecondsTotal = Math.max(0, Math.floor(sessionElapsedMs / 1000) - workSecondsTotal);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed bottom-0 inset-x-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur px-3 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] flex items-center gap-3">
      <button
        type="button"
        onClick={circle.onClick}
        disabled={circle.disabled}
        aria-label={circle.aria}
        className={`w-[78px] h-[78px] rounded-full flex-none flex flex-col items-center justify-center disabled:opacity-40 ${circle.className}`}
      >
        <span className={`font-mono tabular-nums font-semibold leading-none ${circle.bigClass}`}>
          {circle.big}
        </span>
        <span className="text-[8px] uppercase tracking-widest font-bold mt-0.5 opacity-70">
          {circle.sub}
        </span>
      </button>

      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold truncate">{activeLabel}</div>
        <div className="text-[9.5px] text-zinc-500 font-mono truncate">{targetLabel}</div>
        <div className="flex gap-2.5 mt-1.5">
          <div className="text-[8px] text-zinc-600 tracking-wide">
            SESSION
            <span className="block font-mono tabular-nums text-[11px] text-zinc-300">
              {mmss(Math.floor(sessionElapsedMs / 1000))}
            </span>
          </div>
          <div className="text-[8px] text-zinc-600 tracking-wide">
            WORK
            <span className="block font-mono tabular-nums text-[11px] text-blue-400">
              {mmss(workSecondsTotal)}
            </span>
          </div>
          <div className="text-[8px] text-zinc-600 tracking-wide">
            REST
            <span className="block font-mono tabular-nums text-[11px] text-zinc-400">
              {mmss(restSecondsTotal)}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
