"use client";

import React, { useState } from "react";
import { Plus } from "lucide-react";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { LogEntrySheet } from "@/components/metrics/LogEntrySheet";
import { COLOR } from "@/lib/ui/theme";

/**
 * Client shell wrapping /metrics children. Owns:
 *   - Sub-pill nav (Strength / Body / Trends), routes via ?sub=…
 *   - Sticky "+ Log entry" button that opens LogEntrySheet
 *   - Bottom padding so content isn't covered by the sticky button
 */
export function MetricsShell({ children }: { children: React.ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <div style={{ paddingBottom: 92 }}>
      <SubPillNav
        pills={[
          { key: "strength", label: "Strength" },
          { key: "body", label: "Body" },
          { key: "trends", label: "Trends" },
        ]}
        defaultKey="strength"
      />
      <div>{children}</div>

      <button
        onClick={() => setSheetOpen(true)}
        style={{
          position: "fixed",
          bottom: "calc(var(--nav-h, 70px) + 14px)",
          left: 14,
          right: 14,
          maxWidth: 540,
          margin: "0 auto",
          background: COLOR.accent,
          color: "white",
          border: "none",
          borderRadius: 14,
          padding: 14,
          fontSize: 14,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          cursor: "pointer",
          boxShadow: "0 8px 20px rgba(79,93,255,0.3)",
          zIndex: 20,
        }}
      >
        <Plus size={16} strokeWidth={2.5} aria-hidden="true" /> Log entry
      </button>

      <LogEntrySheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}
