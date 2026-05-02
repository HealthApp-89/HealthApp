"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  PERIOD_PRESETS,
  type PeriodPreset,
} from "@/lib/ui/period";

type Props = {
  /** The currently active resolved range (used to display the dates and pre-fill custom). */
  preset: PeriodPreset;
  from: string;
  to: string;
  /** Other querystring keys to preserve when navigating (e.g. section). */
  preserve?: Record<string, string | undefined>;
};

export function PeriodSelector({ preset, from, to, preserve = {} }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setCustomFrom(from);
    setCustomTo(to);
  }, [from, to]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const buttonLabel =
    preset === "custom"
      ? `${from} → ${to}`
      : PERIOD_PRESETS.find((p) => p.id === preset)?.label ?? "Today";

  function navigate(p: PeriodPreset, range?: { from: string; to: string }) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(preserve)) {
      if (v) params.set(k, v);
    }
    params.set("period", p);
    if (p === "custom" && range) {
      params.set("start", range.from);
      params.set("end", range.to);
    }
    setOpen(false);
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-[10px] px-3 py-2 text-xs font-medium flex items-center gap-2"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.1)",
          color: "rgba(255,255,255,0.85)",
        }}
      >
        <span className="text-[9px] uppercase tracking-[0.1em] text-white/35">Period</span>
        <span className="font-mono">{buttonLabel}</span>
        <span className="text-white/30">▾</span>
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute z-30 mt-2 left-0 sm:left-auto sm:right-0 w-[280px] max-w-[calc(100vw-2rem)] rounded-[14px] p-3"
          style={{
            background: "rgba(13,22,40,0.98)",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 12px 30px rgba(0,0,0,0.4)",
          }}
        >
          <div className="flex flex-col gap-0.5 mb-3">
            {PERIOD_PRESETS.filter((p) => p.id !== "custom").map((p) => {
              const active = preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => navigate(p.id)}
                  className="text-left px-2.5 py-1.5 rounded text-xs transition-colors"
                  style={{
                    background: active ? "rgba(0,245,196,0.15)" : "transparent",
                    color: active ? "#00f5c4" : "rgba(255,255,255,0.6)",
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <div
            className="rounded-[10px] p-2.5"
            style={{
              background: preset === "custom" ? "rgba(0,245,196,0.05)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${preset === "custom" ? "rgba(0,245,196,0.25)" : "rgba(255,255,255,0.08)"}`,
            }}
          >
            <div className="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-2">Custom range</div>
            <div className="flex items-center gap-1.5 mb-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] font-mono outline-none focus:border-emerald-300/50"
              />
              <span className="text-white/30">→</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] font-mono outline-none focus:border-emerald-300/50"
              />
            </div>
            <button
              type="button"
              onClick={() => navigate("custom", { from: customFrom, to: customTo })}
              disabled={!customFrom || !customTo}
              className="w-full rounded-md py-1.5 text-[11px] font-bold disabled:opacity-50"
              style={{
                background: "rgba(0,245,196,0.15)",
                border: "1px solid #00f5c455",
                color: "#00f5c4",
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
