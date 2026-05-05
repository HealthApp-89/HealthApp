"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS } from "@/lib/ui/theme";

export function BackfillButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const router = useRouter();

  function go() {
    setResult(null);
    startTransition(async () => {
      const res = await fetch("/api/whoop/backfill", { method: "POST" });
      const j = await res.json();
      if (!j.ok) {
        setResult(`✗ ${j.error ?? j.reason ?? "Failed"}`);
        return;
      }
      setResult(
        `✓ ${j.upserted} days · since ${j.since} · ${j.counts.recovery}r / ${j.counts.cycles}c / ${j.counts.sleep}s`,
      );
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <button
        type="button"
        onClick={go}
        disabled={pending}
        style={{
          background: COLOR.accent,
          color: "#fff",
          border: "none",
          padding: "10px 14px",
          borderRadius: RADIUS.pill,
          fontSize: "12px",
          fontWeight: 700,
          cursor: "pointer",
          opacity: pending ? 0.5 : 1,
        }}
      >
        {pending ? "Pulling history…" : "Backfill all WHOOP history"}
      </button>
      {result && (
        <div
          style={{
            fontSize: "11px",
            fontFamily: "monospace",
            color: result.startsWith("✗") ? COLOR.danger : COLOR.accent,
          }}
        >
          {result}
        </div>
      )}
    </div>
  );
}
