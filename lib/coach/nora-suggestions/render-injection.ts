// lib/coach/nora-suggestions/render-injection.ts
//
// Renders the "Eating identity" markdown block for Nora's system prompt.
// Compact (~25 lines): top-10 items, category counts, monotone flags,
// dietary exclusions. Verbose fields (frequent_combos, slot_patterns)
// stay in the engine — too much to thread into every Nora turn.

import type { EatingIdentity, DietaryExclusions } from "@/lib/data/types";

export function renderEatingIdentityBlock(
  identity: EatingIdentity | null,
  exclusions: DietaryExclusions,
): string {
  const lines: string[] = ["# Eating identity"];

  if (!identity) {
    lines.push("");
    lines.push("Not yet generated — athlete has logged too few meals or sync hasn't run.");
    appendExclusions(lines, exclusions);
    return lines.join("\n");
  }

  lines.push(`Generated ${identity.generated_on}, ${identity.window_days}-day window.`);
  lines.push("");

  lines.push("## Top 10 items (by log count)");
  for (const t of identity.top_items.slice(0, 10)) {
    const slots = Object.entries(t.slot_distribution).filter(([, n]) => n > 0).map(([s, n]) => `${s[0]}${n}`).join("/");
    lines.push(`- ${t.canonical_name}  (×${t.log_count}, ${slots})  qty≈${Math.round(t.typical_qty_g)}g`);
  }
  lines.push("");

  lines.push("## Protein categories (count)");
  for (const [k, v] of Object.entries(identity.protein_category_counts).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    lines.push(`- ${k}: ${v.toFixed(1)}`);
  }
  lines.push("");

  lines.push("## Carb categories (count)");
  for (const [k, v] of Object.entries(identity.carb_category_counts).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    lines.push(`- ${k}: ${v.toFixed(1)}`);
  }
  lines.push("");

  lines.push("## Monotone flags");
  lines.push(`- protein_top_share: ${(identity.monotone_flags.protein_top_share * 100).toFixed(0)}%`);
  lines.push(`- carb_top_share: ${(identity.monotone_flags.carb_top_share * 100).toFixed(0)}%`);
  if (identity.monotone_flags.most_repeated_meal) {
    lines.push(`- most_repeated_meal: ${identity.monotone_flags.most_repeated_meal.count}× ${identity.monotone_flags.most_repeated_meal.items.join(" + ")}`);
  }
  lines.push("");

  appendExclusions(lines, exclusions);
  return lines.join("\n");
}

function appendExclusions(lines: string[], exclusions: DietaryExclusions): void {
  lines.push("## Dietary exclusions");
  if (exclusions.tags.length === 0 && !exclusions.free_text) {
    lines.push("- none");
  } else {
    if (exclusions.tags.length > 0) lines.push(`- tags: ${exclusions.tags.join(", ")}`);
    if (exclusions.free_text) lines.push(`- notes: ${exclusions.free_text}`);
  }
}
