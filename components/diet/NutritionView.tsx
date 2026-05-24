// components/diet/NutritionView.tsx
"use client";

import { useCoachTrends } from "@/lib/query/hooks/useCoachTrends";
import { NutritionSection } from "@/components/coach/trends/NutritionSection";

export function NutritionView({ userId }: { userId: string }) {
  const { data: payload } = useCoachTrends(userId);

  if (!payload) return null;

  return (
    <div style={{ padding: "12px 12px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
      <NutritionSection
        nutrition={payload.nutrition}
        foodQuality={payload.food_quality}
        userId={userId}
      />
    </div>
  );
}
