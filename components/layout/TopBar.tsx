// components/layout/TopBar.tsx
"use client";
import { TimezoneChip } from "@/components/timezone/TimezoneChip";
import { TimezoneSyncProvider } from "@/components/timezone/TimezoneSyncContext";
import type { ReactNode } from "react";

export function TopBar({ userId, children }: { userId: string; children: ReactNode }) {
  return (
    <TimezoneSyncProvider userId={userId}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          background: "rgb(10 10 10)",
          borderBottom: "1px solid rgb(34 34 34)",
          padding: "calc(env(safe-area-inset-top) + 8px) 16px 8px",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 10,
        }}
      >
        <TimezoneChip />
      </header>
      {children}
    </TimezoneSyncProvider>
  );
}
