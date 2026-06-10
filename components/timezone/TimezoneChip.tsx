// components/timezone/TimezoneChip.tsx
"use client";
import Link from "next/link";
import { useTimezoneSync } from "./TimezoneSyncContext";
import { ianaToCode } from "@/lib/time/iana-codes";

export function TimezoneChip() {
  const { state } = useTimezoneSync();
  if (state.kind === "loading") return null;

  const storedCode = ianaToCode(state.stored);
  const detectedCode = ianaToCode(state.detected);

  let bg: string;
  let fg: string;
  let border: string;
  let label: string;
  let title: string;

  if (state.kind === "match" || state.kind === "first-set-silent") {
    bg = "transparent";
    fg = "rgb(136 136 136)";
    border = "1px solid rgb(42 42 42)";
    label = storedCode;
    title = `Timezone: ${state.stored}`;
  } else if (state.kind === "mismatch") {
    bg = "rgba(251,146,60,0.15)";
    fg = "rgb(251 146 60)";
    border = "1px solid rgba(251,146,60,0.3)";
    label = `${storedCode} → ${detectedCode}?`;
    title = `Device reports ${state.detected}, profile is ${state.stored}`;
  } else {
    // stayed
    bg = "rgba(251,146,60,0.08)";
    fg = "rgb(251 146 60)";
    border = "1px solid rgba(251,146,60,0.2)";
    label = storedCode;
    title = `Device reports ${state.detected}, but you chose to stay on ${state.stored}`;
  }

  return (
    <Link
      href="/profile#timezone"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.5,
        background: bg,
        color: fg,
        border,
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}
