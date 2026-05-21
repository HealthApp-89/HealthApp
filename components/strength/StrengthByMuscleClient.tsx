"use client";

import { ByMuscleView } from "@/components/strength/by-muscle/ByMuscleView";
import { todayInUserTz } from "@/lib/time";

type Props = { userId: string };

export function StrengthByMuscleClient({ userId }: Props) {
  const todayIso = todayInUserTz();
  return (
    <div style={{ padding: "8px 16px" }}>
      <ByMuscleView userId={userId} todayIso={todayIso} />
    </div>
  );
}
