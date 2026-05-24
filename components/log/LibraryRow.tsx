"use client";

import { fmtNum } from "@/lib/ui/score";
import type { FoodMacros } from "@/lib/food/types";

export type LibraryRowProps = {
  label: string;
  subLabel?: string;
  qty_g?: number;
  macros?: FoodMacros;
  sourceChip?: "usda" | "off" | null;
  onTap: () => void;
  starred?: boolean;
  onStar?: () => void;
};

export function LibraryRow({
  label,
  subLabel,
  qty_g,
  macros,
  sourceChip,
  onTap,
  starred,
  onStar,
}: LibraryRowProps) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-900 p-3 last:border-b-0">
      <button
        type="button"
        onClick={onTap}
        className="flex-1 text-left"
      >
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-zinc-900">{label}</span>
          {sourceChip && (
            <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400 border border-zinc-800">
              {sourceChip}
            </span>
          )}
        </div>
        {(subLabel || (qty_g !== undefined && macros)) && (
          <div className="text-xs text-zinc-500">
            {qty_g !== undefined && macros && (
              <>
                {fmtNum(qty_g)} g · {fmtNum(macros.kcal)} kcal · {fmtNum(macros.protein_g)} P · {fmtNum(macros.carbs_g)} C · {fmtNum(macros.fat_g)} F
              </>
            )}
            {subLabel && <span className="ml-2">{subLabel}</span>}
          </div>
        )}
      </button>
      {onStar && (
        <button
          type="button"
          onClick={onStar}
          aria-label={starred ? "Unfavorite" : "Favorite"}
          className="px-2 text-lg"
        >
          {starred ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}
