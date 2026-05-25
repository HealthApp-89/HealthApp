"use client";
// components/food/CustomFoodForm.tsx
//
// Manual "create food with macros" form. Minimum entry: name + P + C + F.
// kcal is derived live via Atwater factors when blank; user can override.
// Fiber defaults to 0. Notes are optional. Storage basis is always per_100g
// on the wire — per_serving entry is a UX affordance that back-calculates.
//
// Two surfaces consume this component:
//   - /profile/library  → LibraryClient hosts it in a plain BottomSheet.
//   - MealLoggerSheet   → CustomFoodCreateAndLogSheet wraps it with a
//     post-save qty step so create-and-log is a single flow.
//
// On 23505 dedup (existing `(user_id, lower(name))` unique idx from
// migration 0030), the error message contains "duplicate" — we surface a
// friendly inline error and stop.

import { useState, useMemo } from "react";
import type { FoodMacros } from "@/lib/food/types";
import { deriveKcalFromMacros } from "@/lib/food/atwater";
import { fmtNum } from "@/lib/ui/score";

type Basis = "per_100g" | "per_serving";

export type SavedItem = {
  id: string;
  name: string;
  per_100g: FoodMacros;
  /** Echoed back so MealLoggerSheet can default qty to the serving size when
   *  the user used the per_serving basis. NULL when basis was per_100g. */
  default_serving_g: number | null;
};

export function CustomFoodForm({
  onSaved,
  onCancel,
}: {
  onSaved: (item: SavedItem) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [basis, setBasis] = useState<Basis>("per_100g");
  const [servingG, setServingG] = useState("");
  const [proteinG, setProteinG] = useState("");
  const [carbsG, setCarbsG] = useState("");
  const [fatG, setFatG] = useState("");
  const [fiberG, setFiberG] = useState("");
  const [kcalOverride, setKcalOverride] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicateName, setDuplicateName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const p = parseFloat(proteinG) || 0;
  const c = parseFloat(carbsG) || 0;
  const f = parseFloat(fatG) || 0;
  const fib = parseFloat(fiberG) || 0;
  const userKcal = parseFloat(kcalOverride);
  const userKcalProvided = Number.isFinite(userKcal) && kcalOverride.trim() !== "";

  const atwaterKcal = useMemo(
    () => deriveKcalFromMacros({ protein_g: p, carbs_g: c, fat_g: f }),
    [p, c, f],
  );
  const finalKcal = userKcalProvided ? userKcal : atwaterKcal;

  const per100g: FoodMacros = useMemo(() => {
    if (basis === "per_100g") {
      return { kcal: finalKcal, protein_g: p, carbs_g: c, fat_g: f, fiber_g: fib };
    }
    const sg = parseFloat(servingG);
    if (!Number.isFinite(sg) || sg <= 0) {
      return { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
    }
    const k = 100 / sg;
    return {
      kcal: finalKcal * k,
      protein_g: p * k,
      carbs_g: c * k,
      fat_g: f * k,
      fiber_g: fib * k,
    };
  }, [basis, finalKcal, p, c, f, fib, servingG]);

  const kcalDivergencePct =
    atwaterKcal > 0 && userKcalProvided
      ? Math.abs(userKcal - atwaterKcal) / atwaterKcal
      : 0;
  const showKcalWarning = userKcalProvided && kcalDivergencePct > 0.3;

  const submit = async () => {
    setError(null);
    setDuplicateName(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give your food a name.");
      return;
    }
    if (p < 0 || c < 0 || f < 0 || fib < 0) {
      setError("Macros must be ≥ 0.");
      return;
    }
    if (p === 0 && c === 0 && f === 0) {
      setError("Enter at least one of protein, carbs, or fat.");
      return;
    }
    let servingForReturn: number | null = null;
    if (basis === "per_serving") {
      const sg = parseFloat(servingG);
      if (!Number.isFinite(sg) || sg <= 0) {
        setError("Serving size must be > 0 grams.");
        return;
      }
      servingForReturn = sg;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/food/user-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "item",
          name: trimmedName,
          per_100g: per100g,
          source: "user_manual",
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "save_failed" }));
        const msg = String(json.error ?? "").toLowerCase();
        if (msg.includes("duplicate") || msg.includes("23505")) {
          setDuplicateName(trimmedName);
          setError(null);
        } else {
          setError(json.error || "save_failed");
          setDuplicateName(null);
        }
        setBusy(false);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      onSaved({
        id,
        name: trimmedName,
        per_100g: per100g,
        default_serving_g: servingForReturn,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Greek yogurt 5%"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Macros are…</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setBasis("per_100g")}
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              basis === "per_100g"
                ? "border-zinc-100 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 text-zinc-400"
            }`}
          >
            Per 100g
          </button>
          <button
            type="button"
            onClick={() => setBasis("per_serving")}
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              basis === "per_serving"
                ? "border-zinc-100 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 text-zinc-400"
            }`}
          >
            Per serving
          </button>
        </div>
      </div>

      {basis === "per_serving" && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Serving size (g)</label>
          <input
            type="number"
            inputMode="decimal"
            value={servingG}
            onChange={(e) => setServingG(e.target.value)}
            placeholder="e.g. 60"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Protein (g) *</label>
          <input
            type="number"
            inputMode="decimal"
            value={proteinG}
            onChange={(e) => setProteinG(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Carbs (g) *</label>
          <input
            type="number"
            inputMode="decimal"
            value={carbsG}
            onChange={(e) => setCarbsG(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Fat (g) *</label>
          <input
            type="number"
            inputMode="decimal"
            value={fatG}
            onChange={(e) => setFatG(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Fiber (g)</label>
          <input
            type="number"
            inputMode="decimal"
            value={fiberG}
            onChange={(e) => setFiberG(e.target.value)}
            placeholder="0"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Calories (kcal)</label>
          <input
            type="number"
            inputMode="decimal"
            value={kcalOverride}
            onChange={(e) => setKcalOverride(e.target.value)}
            placeholder={atwaterKcal > 0 ? fmtNum(atwaterKcal) : "auto"}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
      </div>

      {showKcalWarning && (
        <p className="text-xs text-amber-400">
          kcal looks {userKcal > atwaterKcal ? "higher" : "lower"} than macros
          suggest (Atwater estimate: {fmtNum(atwaterKcal)} kcal).
        </p>
      )}

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Brand, where the macros come from, etc."
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
        />
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
        <div className="text-zinc-500 mb-1">Per 100g preview</div>
        <div className="text-zinc-200">
          {fmtNum(per100g.kcal)} kcal · {fmtNum(per100g.protein_g)}P ·{" "}
          {fmtNum(per100g.carbs_g)}C · {fmtNum(per100g.fat_g)}F ·{" "}
          {fmtNum(per100g.fiber_g)} fib
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {duplicateName && (
        <p className="text-xs text-red-400">
          You already have a &ldquo;{duplicateName}&rdquo; saved.{" "}
          <a href="/profile/library" className="underline">
            Open Manage Library
          </a>{" "}
          to find it.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-md border border-zinc-800 py-2 text-sm text-zinc-400"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="flex-1 rounded-md bg-zinc-100 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save to library"}
        </button>
      </div>
    </div>
  );
}
