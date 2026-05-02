"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className="rounded-[12px] px-4 py-2.5 text-xs font-bold disabled:opacity-50"
        style={{
          background: "rgba(10,132,255,0.15)",
          border: "1px solid #0a84ff55",
          color: "#0a84ff",
        }}
      >
        {pending ? "Pulling history…" : "🔄 Backfill all WHOOP history"}
      </button>
      {result && (
        <div
          className="text-[11px] font-mono"
          style={{ color: result.startsWith("✗") ? "#ff453a" : "#0a84ff" }}
        >
          {result}
        </div>
      )}
    </div>
  );
}
