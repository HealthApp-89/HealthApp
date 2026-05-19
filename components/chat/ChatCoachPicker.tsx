// components/chat/ChatCoachPicker.tsx
//
// Composer avatar row — manual coach override for the next message.
// "Auto" (the default) hands the routing decision to lib/coach/router.ts.
// Tapping a coach pin locks the next /api/chat/messages POST to that
// speaker via the speaker_override body field. The lock resets to Auto
// after a successful send (ChatPanel clears via onClear).
"use client";

import type { Speaker } from "@/lib/data/types";
import { SPEAKERS } from "@/lib/data/types";
import { SPEAKER_DISPLAY } from "@/lib/coach/speakers";
import { COLOR } from "@/lib/ui/theme";

// CSS hex values matching the Tailwind palette used in SPEAKER_COLOR.
// Defined here so PickerPin can use inline styles (consistent with the
// rest of this component) rather than mixing className and style.
const SPEAKER_RING: Record<Speaker, string> = {
  peter:  "#71717a", // zinc-500
  carter: "#b91c1c", // red-700
  nora:   "#059669", // emerald-700
  remi:   "#0891b2", // cyan-700
};

export function ChatCoachPicker({
  locked,
  onChange,
  disabled,
}: {
  /** null = Auto (router decides). */
  locked: Speaker | null;
  onChange: (next: Speaker | null) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        paddingBottom: 4,
        overflowX: "auto",
      }}
    >
      <PickerPin
        active={locked === null}
        label="Auto"
        title="Auto-route based on question content"
        onClick={() => onChange(null)}
        disabled={disabled}
      />
      {SPEAKERS.map((sp) => (
        <PickerPin
          key={sp}
          active={locked === sp}
          label={SPEAKER_DISPLAY[sp].name}
          colorKey={sp}
          title={`Send to ${SPEAKER_DISPLAY[sp].name} (${SPEAKER_DISPLAY[sp].role})`}
          onClick={() => onChange(locked === sp ? null : sp)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function PickerPin({
  active,
  label,
  colorKey,
  title,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  colorKey?: Speaker;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  // Colour mapping — pull bg + border from the speaker palette so the lock
  // state reads as "this coach's color." Auto stays neutral.
  const palette = colorKey ? SPEAKER_RING[colorKey] : null;
  const bg = active
    ? palette
      ? "rgba(255,255,255,0.08)"
      : COLOR.accentSoft
    : "transparent";
  const ring = active
    ? palette
      ? "rgba(255,255,255,0.5)"
      : COLOR.accent
    : COLOR.divider;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        flexShrink: 0,
        padding: "4px 10px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${ring}`,
        color: active ? COLOR.textStrong : COLOR.textMid,
        fontSize: 11,
        fontWeight: active ? 700 : 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
