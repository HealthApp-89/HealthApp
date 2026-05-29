// components/profile/DietaryExclusionsSection.tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ExclusionTag, DietaryExclusions } from "@/lib/data/types";
import { queryKeys } from "@/lib/query/keys";

const ALL_TAGS: { tag: ExclusionTag; label: string }[] = [
  { tag: "pork", label: "Pork" },
  { tag: "shellfish", label: "Shellfish" },
  { tag: "alcohol", label: "Alcohol" },
  { tag: "gluten", label: "Gluten" },
  { tag: "dairy", label: "Dairy" },
  { tag: "eggs", label: "Eggs" },
  { tag: "peanuts", label: "Peanuts" },
  { tag: "tree_nuts", label: "Tree nuts" },
  { tag: "soy", label: "Soy" },
  { tag: "red_meat", label: "Red meat" },
  { tag: "all_meat", label: "All meat" },
  { tag: "fish", label: "Fish" },
];

type Props = {
  userId: string;
  initial: DietaryExclusions;
};

export function DietaryExclusionsSection({ userId, initial }: Props) {
  const queryClient = useQueryClient();
  const [tags, setTags] = useState<Set<ExclusionTag>>(new Set(initial.tags));
  const [freeText, setFreeText] = useState(initial.free_text ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (t: ExclusionTag) => {
    setSavedAt(null);
    setError(null);
    const next = new Set(tags);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTags(next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/dietary-exclusions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: [...tags], free_text: freeText.trim() === "" ? null : freeText }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedAt(Date.now());
      await queryClient.invalidateQueries({ queryKey: queryKeys.profile.one(userId) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Dietary exclusions</h2>
        <p className="text-sm text-neutral-400">
          Hard NOs that Nora will respect when she suggests meals. Tags drive a deterministic filter; free-text captures nuance.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {ALL_TAGS.map(({ tag, label }) => {
          const active = tags.has(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              aria-pressed={active}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                active
                  ? "border-rose-400 bg-rose-500/15 text-rose-200"
                  : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <label className="block space-y-1">
        <span className="text-sm text-neutral-300">Notes (advisory, Nora reads in prose)</span>
        <textarea
          value={freeText}
          onChange={(e) => {
            setSavedAt(null);
            setError(null);
            setFreeText(e.target.value);
          }}
          rows={3}
          maxLength={500}
          placeholder="e.g. no raw fish, limit dairy at night"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save exclusions"}
        </button>
        {savedAt !== null && !error && (
          <span className="text-xs text-emerald-400">Saved</span>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
