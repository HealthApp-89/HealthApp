"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload } from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";
import { SectionSubHeader } from "./SectionSubHeader";
import { InlineNudgeCallout } from "./InlineNudgeCallout";

const SLOT_ORDER: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Brkfst", lunch: "Lunch", dinner: "Dinner", snack: "Snack",
};

const PROTEIN_LEGEND_LABEL: Record<string, string> = {
  poultry: "Poultry", red_meat: "Red meat", fish_seafood: "Fish + seafood",
  eggs: "Eggs", dairy_protein: "Dairy", plant_protein: "Plant",
  protein_supplement: "Supplement", mixed: "Mixed", unknown: "Other",
};
const PROTEIN_LEGEND_COLOR: Record<string, string> = {
  poultry: "#b45309", red_meat: "#dc2626", fish_seafood: "#2563eb",
  eggs: "#f59e0b", dairy_protein: "#84cc16", plant_protein: "#10b981",
  protein_supplement: "#a855f7", mixed: "#6b7280", unknown: "#9ca3af",
};
const CARB_LEGEND_LABEL: Record<string, string> = {
  whole_grain: "Whole grain", refined_grain: "Refined grain",
  starchy_veg: "Starchy veg", non_starchy_veg: "Veg",
  fruit: "Fruit", legume: "Legume", sugar_sweets: "Sweets", unknown: "Other",
};
const CARB_LEGEND_COLOR: Record<string, string> = {
  whole_grain: "#92400e", refined_grain: "#d97706", starchy_veg: "#16a34a",
  non_starchy_veg: "#65a30d", fruit: "#ec4899", legume: "#84cc16",
  sugar_sweets: "#6b7280", unknown: "#9ca3af",
};
const METHOD_LEGEND_LABEL: Record<string, string> = {
  grilled: "Grilled", baked: "Baked", pan_fried: "Pan-fried",
  deep_fried: "Deep-fried", air_fried: "Air-fried", steamed: "Steamed",
  boiled: "Boiled", roasted: "Roasted", raw: "Raw", smoked: "Smoked", unknown: "Other",
};
const METHOD_LEGEND_COLOR: Record<string, string> = {
  grilled: "#16a34a", baked: "#84cc16", pan_fried: "#f59e0b",
  deep_fried: "#dc2626", air_fried: "#fbbf24", steamed: "#06b6d4",
  boiled: "#6366f1", roasted: "#a16207", raw: "#9ca3af", smoked: "#737373", unknown: "#d1d5db",
};

export function NutritionSection({
  nutrition,
  foodQuality,
  userId,
}: {
  nutrition: CoachTrendsPayload["nutrition"];
  foodQuality: CoachTrendsPayload["food_quality"];
  userId: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Nutrition" />
        <SpeakerChip speaker="nora" size="sm" />
      </div>

      {/* ── Adherence block ─────────────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 8 }}>
        Adherence
      </div>

      <Card>
        <SectionLabel>PROTEIN ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.protein.pct_4w != null ? `${fmtNum(nutrition.protein.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.protein.days_hit_4w}/{nutrition.protein.days_total_4w} days hit target ({nutrition.protein.target_g ?? "n/a"}g)
        </div>
        <InlineNudgeCallout
          userId={userId}
          triggerKey="protein_under"
          variant="warn"
          title="Protein under target too often"
          body="Hit rate has dropped below 60% over the last week."
        />
        <InlineNudgeCallout
          userId={userId}
          triggerKey="glp1_protein_floor"
          variant="warn"
          title="GLP-1 protein floor missed"
          body="Protein has come in under 1.8 g/kg on at least 3 of the last 5 days."
        />
      </Card>

      <Card>
        <SectionLabel>KCAL ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.kcal.pct_4w != null ? `${fmtNum(nutrition.kcal.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.kcal.days_hit_4w}/{nutrition.kcal.days_total_4w} days within ±5% of {nutrition.kcal.target ?? "n/a"} kcal target
        </div>
      </Card>

      <Card>
        <SectionLabel>DEFICIT MAGNITUDE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.deficit_kcal.avg_4w != null ? `${nutrition.deficit_kcal.avg_4w > 0 ? "+" : ""}${fmtNum(nutrition.deficit_kcal.avg_4w)} kcal/day` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          4w average vs target. Negative = deficit; positive = surplus.
        </div>
      </Card>

      {/* ── By-meal-slot block ──────────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 14, paddingTop: 8, borderTop: "1px dashed #e5e7eb" }}>
        By meal slot · 14d avg
      </div>

      <Card>
        <SectionLabel>PROTEIN PER SLOT</SectionLabel>
        {SLOT_ORDER.map((slot) => {
          const cell = nutrition.per_meal_slot.protein_g[slot];
          const pct = cell.pct_of_target;
          const width = pct != null ? Math.max(2, Math.min(100, pct * 100)) : 0;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 10, width: 50, color: COLOR.textMuted }}>{SLOT_LABEL[slot]}</span>
              <span style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${width}%`, background: "#3b82f6", borderRadius: 4 }} />
              </span>
              <span style={{ fontSize: 10, color: COLOR.textMuted, width: 70, textAlign: "right" }}>
                {cell.avg_14d != null ? `${fmtNum(cell.avg_14d)}g` : "—"}
                {pct != null ? ` · ${fmtNum(pct * 100)}%` : ""}
              </span>
            </div>
          );
        })}
      </Card>

      <Card>
        <SectionLabel>KCAL PER SLOT</SectionLabel>
        {SLOT_ORDER.map((slot) => {
          const cell = nutrition.per_meal_slot.kcal[slot];
          const pct = cell.pct_of_target;
          const width = pct != null ? Math.max(2, Math.min(120, pct * 100)) : 0;
          const targetMarker = cell.target_kcal != null && cell.avg_14d != null && cell.target_kcal > 0
            ? Math.min(100, (cell.target_kcal / Math.max(cell.target_kcal, cell.avg_14d, 1)) * 100)
            : null;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 10, width: 50, color: COLOR.textMuted }}>{SLOT_LABEL[slot]}</span>
              <span style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                <span style={{ display: "block", height: "100%", width: `${width}%`, background: "#f59e0b", borderRadius: 4 }} />
                {targetMarker != null && (
                  <span style={{ position: "absolute", top: -2, left: `${targetMarker}%`, width: 1.5, height: 12, background: COLOR.textStrong }} />
                )}
              </span>
              <span style={{ fontSize: 10, color: COLOR.textMuted, width: 80, textAlign: "right" }}>
                {cell.avg_14d != null ? `${Math.round(cell.avg_14d)}` : "—"}
                {cell.target_kcal != null ? ` / ${cell.target_kcal}` : ""}
              </span>
            </div>
          );
        })}
        <InlineNudgeCallout
          userId={userId}
          triggerKey="training_day_undereat"
          variant="warn"
          title="Undereating on lift days"
          body="Kcal has come in 300+ under target on at least half of recent lift days."
        />
      </Card>

      {/* Food-quality block is appended in Task 13 (kept here as a placeholder
          for now — Task 13 replaces this comment with the four cards). */}
      <NutritionFoodQuality foodQuality={foodQuality} userId={userId} />
    </div>
  );
}

function NutritionFoodQuality({
  foodQuality,
  userId,
}: {
  foodQuality: CoachTrendsPayload["food_quality"];
  userId: string;
}) {
  return (
    <>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 14, paddingTop: 8, borderTop: "1px dashed #e5e7eb" }}>
        Food quality · last {foodQuality.window_days}d
      </div>

      <Card>
        <SectionLabel>PROTEIN SOURCES BY GRAMS</SectionLabel>
        <StackedBar
          segments={foodQuality.protein_sources.map((s) => ({
            label: PROTEIN_LEGEND_LABEL[s.category] ?? s.category,
            color: PROTEIN_LEGEND_COLOR[s.category] ?? "#9ca3af",
            pct:   s.pct,
            grams: s.grams,
          }))}
        />
        <InlineNudgeCallout
          userId={userId}
          triggerKey="monotone_protein"
          variant="warn"
          title="Protein is monotone"
          body="One source is dominating last 2 weeks. Mix in fish and red meat for variety."
        />
      </Card>

      <Card>
        <SectionLabel>CARB SOURCES BY GRAMS</SectionLabel>
        <StackedBar
          segments={foodQuality.carb_sources.map((s) => ({
            label: CARB_LEGEND_LABEL[s.category] ?? s.category,
            color: CARB_LEGEND_COLOR[s.category] ?? "#9ca3af",
            pct:   s.pct,
            grams: s.grams,
          }))}
        />
      </Card>

      <Card>
        <SectionLabel>COOKING METHOD MIX</SectionLabel>
        <CookingDonut methods={foodQuality.cooking_methods} />
        <div style={{ fontSize: 10, color: COLOR.textMuted, marginTop: 6 }}>
          {fmtNum(foodQuality.data_completeness.cooking_method_inferable_pct * 100)}% of items had inferable method.
        </div>
        <InlineNudgeCallout
          userId={userId}
          triggerKey="fried_heavy"
          variant="warn"
          title="Frying-heavy mix"
          body="Pan-fried + deep-fried items are 40%+ of recent meals. Try swapping the top offenders for grilled or air-fried."
        />
      </Card>

      <Card>
        <SectionLabel>DIET DIVERSITY</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 6 }}>
          <Stat n={foodQuality.diversity.distinct_items} label="Distinct items" />
          <Stat n={fmtNum(foodQuality.diversity.fish_meals_per_week)} label="Fish / week" />
          <Stat n={fmtNum(foodQuality.diversity.veg_servings_per_day)} label="Veg / day" />
        </div>
      </Card>
    </>
  );
}

function StackedBar({
  segments,
}: {
  segments: Array<{ label: string; color: string; pct: number; grams: number }>;
}) {
  return (
    <>
      <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", margin: "8px 0 4px", background: "#f3f4f6" }}>
        {segments.map((s) => s.pct > 0 && (
          <div
            key={s.label}
            title={`${s.label}: ${Math.round(s.grams)}g · ${fmtNum(s.pct * 100)}%`}
            style={{
              width: `${s.pct * 100}%`,
              background: s.color,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 600, color: "#fff",
            }}
          >
            {s.pct >= 0.06 ? `${Math.round(s.pct * 100)}%` : ""}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px", fontSize: 9, color: "#4b5563", marginTop: 6 }}>
        {segments.map((s) => (
          <div key={s.label}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 4, background: s.color, verticalAlign: "middle" }} />
            {s.label} · {Math.round(s.grams)}g
          </div>
        ))}
      </div>
    </>
  );
}

function CookingDonut({ methods }: { methods: CoachTrendsPayload["food_quality"]["cooking_methods"] }) {
  if (methods.length === 0) {
    return <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 6 }}>No cooking-method data yet.</div>;
  }
  let acc = 0;
  const stops: string[] = [];
  for (const m of methods) {
    const start = acc;
    acc += m.pct;
    const color = METHOD_LEGEND_COLOR[m.method] ?? "#9ca3af";
    stops.push(`${color} ${(start * 100).toFixed(2)}% ${(acc * 100).toFixed(2)}%`);
  }
  const conic = `conic-gradient(${stops.join(", ")})`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
      <div style={{ width: 60, height: 60, borderRadius: "50%", background: conic, flexShrink: 0 }} />
      <div style={{ fontSize: 9, color: "#4b5563", lineHeight: 1.6 }}>
        {methods.map((m) => (
          <div key={m.method}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 4, background: METHOD_LEGEND_COLOR[m.method] ?? "#9ca3af", verticalAlign: "middle" }} />
            {METHOD_LEGEND_LABEL[m.method] ?? m.method} {fmtNum(m.pct * 100)}%
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div style={{ textAlign: "center", padding: "6px 4px", background: "#f9fafb", borderRadius: 6 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: COLOR.textStrong }}>{n}</div>
      <div style={{ fontSize: 9, color: COLOR.textMuted, lineHeight: 1.3, marginTop: 2 }}>{label}</div>
    </div>
  );
}
