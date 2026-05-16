"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { TermSheet } from "@/components/coach/TermSheet";
import { GlossarySheet } from "@/components/coach/GlossarySheet";
import { getGlossaryEntry, type TermKey } from "@/lib/coach/glossary";

/** Tracks which missing-entry keys have already been warned about, so a
 *  rationale_tag absent from the glossary warns exactly once per page-load
 *  instead of spamming the console on every re-render of the prescription
 *  table. */
const _warnedKeys = new Set<string>();

/**
 * Wraps an existing label (e.g. "MAV", "RIR 2", "MEV → MAV") and makes it
 * tappable. On tap, opens a BottomSheet with the plain-English definition
 * for the supplied termKey. If termKey isn't in the glossary, the pill
 * renders the children verbatim with no tappable behavior + a console.warn
 * (no crash).
 *
 * Visual: dotted underline only. No background, no padding, no layout
 * shift — drops into existing flows like a normal span.
 */
export function JargonPill({
  termKey,
  children,
  style,
}: {
  termKey: TermKey | string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [openTerm, setOpenTerm] = useState(false);
  const [openGlossary, setOpenGlossary] = useState(false);

  const entry = getGlossaryEntry(termKey);
  if (!entry) {
    if (typeof window !== "undefined" && !_warnedKeys.has(String(termKey))) {
      _warnedKeys.add(String(termKey));
      // eslint-disable-next-line no-console
      console.warn(`[JargonPill] missing glossary entry for "${termKey}"`);
    }
    return <span style={style}>{children}</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpenTerm(true);
        }}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          margin: 0,
          font: "inherit",
          color: "inherit",
          textDecoration: "underline dotted",
          textUnderlineOffset: 2,
          textDecorationColor: "currentColor",
          cursor: "pointer",
          userSelect: "none",
          ...style,
        }}
      >
        {children}
      </button>
      {openTerm && (
        <TermSheet
          termKey={termKey}
          onClose={() => setOpenTerm(false)}
          onOpenGlossary={() => setOpenGlossary(true)}
        />
      )}
      {openGlossary && <GlossarySheet onClose={() => setOpenGlossary(false)} />}
    </>
  );
}
