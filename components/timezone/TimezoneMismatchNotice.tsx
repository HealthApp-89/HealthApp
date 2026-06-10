// components/timezone/TimezoneMismatchNotice.tsx
"use client";
import { useTimezoneSync } from "./TimezoneSyncContext";

export function TimezoneMismatchNotice() {
  const { state, accept, dismiss } = useTimezoneSync();
  if (state.kind !== "mismatch") return null;

  return (
    <div
      style={{
        margin: "0 0 14px",
        padding: "10px 14px",
        background: "rgb(22 22 22)",
        borderLeft: "2px solid rgb(251 146 60)",
        borderRadius: "0 6px 6px 0",
        fontSize: 12,
        color: "rgb(207 214 228)",
      }}
    >
      <div style={{ color: "white", marginBottom: 6 }}>
        <b>{state.detected}</b> detected on this device.
      </div>
      <div style={{ color: "rgb(136 136 136)", marginBottom: 8 }}>
        Your sessions today are still keyed to {state.stored}. Switch profile?
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => void accept()}
          style={{
            background: "transparent",
            color: "rgb(251 146 60)",
            border: "1px solid rgb(251 146 60)",
            padding: "4px 12px",
            borderRadius: 6,
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Switch to {state.detected.split("/").pop()?.replace(/_/g, " ")}
        </button>
        <button
          onClick={dismiss}
          style={{
            background: "transparent",
            color: "rgb(102 102 102)",
            border: 0,
            padding: "4px 12px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Stay on {state.stored.split("/").pop()?.replace(/_/g, " ")}
        </button>
      </div>
    </div>
  );
}
