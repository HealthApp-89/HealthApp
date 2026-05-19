// components/profile/NutritionTargetsSection.tsx
//
// /profile editable card for nutrition targets. Three independent save groups:
//   - Daily calories (kcal)
//   - Macro split   (protein/carbs/fat ratios)
//   - Meal split    (breakfast/lunch/dinner/snacks ratios)
// Each posts ONLY its own field to /api/profile/nutrition-overrides; partial-
// update semantics on the endpoint preserve the other groups. "Reset to plan"
// clears all three. Source label per row tracks which artifact fed the live
// `targets` (override | plan | intake | default).

"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";

export function NutritionTargetsSection({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  const { data: targets } = useTodayTargets(userId, date);
  const qc = useQueryClient();

  // Local editable state — only POSTed on "Save".
  const [kcal, setKcal] = useState<number>(targets?.kcal ?? 2000);
  const [proteinPct, setProteinPct] = useState<number>(35);
  const [carbsPct, setCarbsPct] = useState<number>(35);
  const [fatPct, setFatPct] = useState<number>(30);
  const [bfPct, setBfPct] = useState<number>(30);
  const [luPct, setLuPct] = useState<number>(35);
  const [diPct, setDiPct] = useState<number>(30);
  const [snPct, setSnPct] = useState<number>(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const src = targets?.source_per_field;

  const save = async (payload: Record<string, unknown>) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/profile/nutrition-overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "save_failed");
      }
      await qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "today-targets",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveKcal = () => save({ kcal });
  const saveMacros = () =>
    save({
      macro_ratios: {
        protein_pct: proteinPct / 100,
        carbs_pct: carbsPct / 100,
        fat_pct: fatPct / 100,
      },
    });
  const saveMeals = () =>
    save({
      meal_ratios: {
        breakfast: bfPct / 100,
        lunch: luPct / 100,
        dinner: diPct / 100,
        snacks: snPct / 100,
      },
    });
  const resetAll = () =>
    save({ kcal: null, macro_ratios: null, meal_ratios: null });

  return (
    <section className="rounded-lg border border-zinc-800 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Nutrition targets
      </h2>

      {/* Daily calories */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <label className="text-sm">Daily calories</label>
          <span className="text-xs text-zinc-500">
            Source: {src?.kcal ?? "—"}
          </span>
        </div>
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            value={kcal}
            onChange={(e) => setKcal(parseInt(e.target.value, 10) || 0)}
            min={800}
            max={6000}
            className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={saveKcal}
            disabled={busy}
            className="rounded-md bg-zinc-100 px-3 py-1 text-xs text-zinc-900"
          >
            Save kcal
          </button>
        </div>
      </div>

      {/* Macro split */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <label className="text-sm">Macro split (%)</label>
          <span className="text-xs text-zinc-500">
            Source: {src?.macros ?? "—"}
          </span>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
          <PctInput label="P" value={proteinPct} onChange={setProteinPct} />
          <PctInput label="C" value={carbsPct} onChange={setCarbsPct} />
          <PctInput label="F" value={fatPct} onChange={setFatPct} />
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          Sum: {proteinPct + carbsPct + fatPct}%
        </div>
        <button
          type="button"
          onClick={saveMacros}
          disabled={busy}
          className="mt-2 rounded-md bg-zinc-100 px-3 py-1 text-xs text-zinc-900"
        >
          Save macros
        </button>
      </div>

      {/* Meal split */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <label className="text-sm">Meal split (%)</label>
          <span className="text-xs text-zinc-500">
            Source: {src?.meal_ratios ?? "—"}
          </span>
        </div>
        <div className="mt-1 grid grid-cols-4 gap-2 text-xs">
          <PctInput label="B" value={bfPct} onChange={setBfPct} />
          <PctInput label="L" value={luPct} onChange={setLuPct} />
          <PctInput label="D" value={diPct} onChange={setDiPct} />
          <PctInput label="S" value={snPct} onChange={setSnPct} />
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          Sum: {bfPct + luPct + diPct + snPct}%
        </div>
        <button
          type="button"
          onClick={saveMeals}
          disabled={busy}
          className="mt-2 rounded-md bg-zinc-100 px-3 py-1 text-xs text-zinc-900"
        >
          Save meal split
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      <div className="flex gap-3 text-xs">
        <button
          type="button"
          onClick={resetAll}
          disabled={busy}
          className="text-zinc-400 underline"
        >
          Reset to plan
        </button>
        <Link
          href="/coach?mode=default&starter=nutrition_targets"
          className="text-zinc-100 underline"
        >
          Ask coach to recommend →
        </Link>
      </div>
    </section>
  );
}

function PctInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-zinc-400">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        min={0}
        max={100}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
      />
    </label>
  );
}
