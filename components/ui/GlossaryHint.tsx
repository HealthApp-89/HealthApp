// components/ui/GlossaryHint.tsx
//
// Lightweight glossary tooltip for WHOOP / health-metric terms.
// Tap on mobile, hover on desktop — no heavy dependency.
// Uses CSS :hover + aria-describedby for accessibility.
// Terms map is co-located here so it can be imported elsewhere if needed.
"use client";

import { useState, useId, useRef } from "react";
import { COLOR } from "@/lib/ui/theme";

export const GLOSSARY: Record<string, string> = {
  HRV: "Heart Rate Variability — the millisecond variation between heartbeats. Higher = more recovered nervous system.",
  Strain: "WHOOP's 0–21 cardiovascular load score for the day. Reflects how hard your body worked.",
  "Recovery %": "WHOOP's daily readiness percentage (0–100 %) based on HRV, RHR, sleep performance, and respiratory rate.",
  "Resting HR": "Your lowest heart rate while at rest. Lower generally means better cardiovascular fitness.",
  SpO2: "Blood oxygen saturation (%). WHOOP measures this during sleep; values below 95 % may indicate disrupted breathing.",
  "Sleep Performance": "How your actual sleep compares to your WHOOP-recommended need, expressed as a percentage.",
  "Establishing baseline": "WHOOP has fewer than 30 days of data — personalized comparisons are still forming.",
  "Partial baseline": "WHOOP has 30–90 days of data — baselines are meaningful but still improving.",
  "Stable baseline": "WHOOP has 90+ days of data — your personal norms are well-established.",
  "Respiratory Rate": "Breaths per minute measured overnight by WHOOP. Elevation can be an early illness signal.",
};

type Props = {
  /** The display text (e.g. "HRV"). Must match a key in GLOSSARY. */
  term: string;
  /** Optional key override if the display text differs from the glossary key. */
  glossaryKey?: string;
};

/**
 * Wrap a term label with this to add a tap/hover definition hint.
 * Renders the term with a subtle underline and a small tooltip on hover/focus/tap.
 *
 * Usage:
 *   <GlossaryHint term="HRV" />
 *   <GlossaryHint term="HRV" glossaryKey="HRV" />
 */
export function GlossaryHint({ term, glossaryKey }: Props) {
  const key = glossaryKey ?? term;
  const definition = GLOSSARY[key];
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!definition) {
    // No definition — render plain text, don't crash
    return <span>{term}</span>;
  }

  function show() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(true);
  }
  function hide() {
    timerRef.current = setTimeout(() => setOpen(false), 150);
  }
  function toggle() {
    setOpen((v) => !v);
  }

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={toggle}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "help",
          font: "inherit",
          color: "inherit",
          borderBottom: `1px dashed ${COLOR.textMuted}`,
          lineHeight: "inherit",
        }}
      >
        {term}
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hide}
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            width: 220,
            padding: "8px 10px",
            borderRadius: 8,
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            fontSize: 11,
            lineHeight: 1.45,
            color: COLOR.textMid,
            whiteSpace: "normal",
          }}
        >
          <strong style={{ display: "block", color: COLOR.textStrong, marginBottom: 2 }}>
            {term}
          </strong>
          {definition}
        </span>
      )}
    </span>
  );
}
