"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

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
      className="rounded-[12px] px-4 py-2.5 text-xs font-bold disabled:opacity-50"
      style={{
        background: "rgba(0,245,196,0.15)",
        border: "1px solid #00f5c455",
        color: "#00f5c4",
      }}
    >
      {pending ? "Analysing…" : `🧠 ${label}`}
    </button>
  );
}
