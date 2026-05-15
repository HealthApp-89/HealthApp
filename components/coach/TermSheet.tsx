"use client";

import { BottomSheet } from "@/components/ui/BottomSheet";
import { COLOR } from "@/lib/ui/theme";
import { getGlossaryEntry, type TermKey } from "@/lib/coach/glossary";

/**
 * Bottom sheet rendering a single glossary term's `label`/`short`/`plain`
 * definition. Caller mounts when the user taps a JargonPill.
 *
 * Note: the `BottomSheet` primitive needs `open` explicitly — callers can
 * either gate the mount themselves or rely on the always-`open={true}` here
 * (since JargonPill only mounts TermSheet when it wants to show it).
 */
export function TermSheet({
  termKey,
  onClose,
  onOpenGlossary,
}: {
  termKey: TermKey | string;
  onClose: () => void;
  /** Optional — when provided, footer renders a "See all terms" link. */
  onOpenGlossary?: () => void;
}) {
  const entry = getGlossaryEntry(termKey);
  return (
    <BottomSheet open={true} onClose={onClose} title={entry?.label ?? termKey}>
      <div style={{ padding: 16 }}>
        {entry ? (
          <>
            <div style={{ fontSize: 13, color: COLOR.textStrong, fontWeight: 600 }}>
              {entry.short}
            </div>
            <p
              style={{
                fontSize: 13,
                color: COLOR.textMuted,
                marginTop: 8,
                lineHeight: 1.5,
              }}
            >
              {entry.plain}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13, color: COLOR.textMuted }}>
            No definition available for &ldquo;{termKey}&rdquo;.
          </p>
        )}
        {onOpenGlossary && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenGlossary();
            }}
            style={{
              marginTop: 16,
              background: "transparent",
              border: "none",
              color: COLOR.accent,
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
            }}
          >
            See all terms →
          </button>
        )}
      </div>
    </BottomSheet>
  );
}
