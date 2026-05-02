"use client";

import { useState, useTransition } from "react";
import { saveCheckin } from "@/app/log/actions";
import type { DailyPlan } from "@/lib/coach/readiness";

type Props = {
  date: string;
  plan: DailyPlan;
  initial: {
    readiness: number | null;
    energy_label: string | null;
    mood: string | null;
    soreness: string | null;
    feel_notes: string | null;
  } | null;
};

const READINESS_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const ENERGY = ["Low", "Medium", "High"];
const MOODS = ["😔", "😐", "😊", "🔥"];

export function MorningCheckIn({ date, plan, initial }: Props) {
  const { readiness, mode, sessionType, exercises } = plan;
  const [pending, startTransition] = useTransition();
  const [feel, setFeel] = useState({
    readiness: initial?.readiness ?? null,
    energy: initial?.energy_label ?? null,
    mood: initial?.mood ?? null,
    soreness: initial?.soreness ?? "",
    notes: initial?.feel_notes ?? "",
  });

  function onSubmit(formData: FormData) {
    formData.set("feel_readiness", feel.readiness?.toString() ?? "");
    formData.set("feel_energy", feel.energy ?? "");
    formData.set("feel_mood", feel.mood ?? "");
    formData.set("feel_soreness", feel.soreness ?? "");
    formData.set("feel_notes", feel.notes ?? "");
    formData.set("date", date);
    startTransition(async () => {
      await saveCheckin(formData);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-[14px] p-4"
        style={{
          background: `linear-gradient(135deg, ${mode.color}12, rgba(0,0,0,0.3))`,
          border: `1px solid ${mode.color}30`,
        }}
      >
        <div className="flex justify-between items-center mb-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.1em] text-white/40">Today&apos;s Session</div>
            <div className="text-lg font-bold text-white mt-0.5">
              {sessionType === "REST" ? "Rest Day 🏠" : `💪 ${sessionType}`}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-bold" style={{ color: mode.color }}>
              {mode.label}
            </div>
            <div className="text-[10px] text-white/35 mt-0.5">Readiness {readiness.score}/100</div>
          </div>
        </div>
        <div className="text-[11px] text-white/50 leading-relaxed">{mode.desc}</div>

        {sessionType !== "REST" && exercises.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-1.5">
            {exercises.slice(0, 6).map((ex) => (
              <div key={ex.name} className="flex justify-between text-[11px]">
                <span className="text-white/55">{ex.name.split("(")[0].trim()}</span>
                <span className="font-mono" style={{ color: mode.color }}>
                  {ex.target}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        action={onSubmit}
        className="rounded-[14px] px-4 py-3.5"
        style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-2.5">
          🌅 Morning Check-In
        </div>

        <div className="text-[10px] uppercase tracking-[0.08em] text-white/40 mb-1.5">Readiness 1–10</div>
        <div className="flex gap-1 mb-3">
          {READINESS_NUMS.map((n) => {
            const sel = feel.readiness === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setFeel((f) => ({ ...f, readiness: n }))}
                className="flex-1 h-7 rounded text-[11px] font-mono transition-colors"
                style={{
                  background: sel ? "rgba(10,132,255,0.2)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${sel ? "#0a84ff66" : "rgba(255,255,255,0.08)"}`,
                  color: sel ? "#0a84ff" : "rgba(255,255,255,0.4)",
                }}
              >
                {n}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] text-white/40 mb-1.5">Energy</div>
            <div className="flex gap-1">
              {ENERGY.map((e) => {
                const sel = feel.energy === e;
                return (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setFeel((f) => ({ ...f, energy: e }))}
                    className="flex-1 h-7 rounded text-[11px] transition-colors"
                    style={{
                      background: sel ? "rgba(10,132,255,0.2)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${sel ? "#0a84ff66" : "rgba(255,255,255,0.08)"}`,
                      color: sel ? "#0a84ff" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {e}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] text-white/40 mb-1.5">Mood</div>
            <div className="flex gap-1">
              {MOODS.map((m) => {
                const sel = feel.mood === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFeel((f) => ({ ...f, mood: m }))}
                    className="flex-1 h-7 rounded text-base transition-colors"
                    style={{
                      background: sel ? "rgba(10,132,255,0.2)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${sel ? "#0a84ff66" : "rgba(255,255,255,0.08)"}`,
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <input
          type="text"
          placeholder="Soreness?"
          value={feel.soreness ?? ""}
          onChange={(e) => setFeel((f) => ({ ...f, soreness: e.target.value }))}
          className="w-full mt-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 outline-none focus:border-white/30"
        />

        <button
          type="submit"
          disabled={pending}
          className="mt-3 w-full rounded-lg py-2 text-xs font-bold disabled:opacity-50"
          style={{
            background: "rgba(10,132,255,0.15)",
            border: "1px solid #0a84ff55",
            color: "#0a84ff",
          }}
        >
          {pending ? "Saving…" : "Save check-in"}
        </button>
      </form>
    </div>
  );
}
