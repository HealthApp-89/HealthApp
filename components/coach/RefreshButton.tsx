"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  endpoint: string;
  label?: string;
};

export function RefreshButton({ endpoint, label = "Run pattern analysis" }: Props) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  function go() {
    startTransition(async () => {
      const res = await fetch(endpoint, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Failed: ${j.error ?? res.status}`);
        return;
      }
      router.refresh();
    });
  }
  return (
    <button
      type="button"
      onClick={go}
      disabled={pending}
      style={{
        background: COLOR.surface,
        color: COLOR.accent,
        border: `1px solid ${COLOR.divider}`,
        padding: "8px 14px",
        borderRadius: RADIUS.pill,
        fontSize: "12px",
        fontWeight: 700,
        cursor: "pointer",
        opacity: pending ? 0.5 : 1,
        transition: "opacity 120ms",
      }}
    >
      {pending ? "Analysing…" : `🧠 ${label}`}
    </button>
  );
}
