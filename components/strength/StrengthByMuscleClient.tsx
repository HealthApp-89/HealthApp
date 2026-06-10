"use client";

import { ByMuscleView } from "@/components/strength/by-muscle/ByMuscleView";
import { useUserToday } from "@/lib/query/hooks/useUserToday";

type Props = { userId: string };

export function StrengthByMuscleClient({ userId }: Props) {
  const todayIso = useUserToday(userId);
  if (!todayIso) return null;
  return (
    <div style={{ padding: "8px 16px" }}>
      <ByMuscleView userId={userId} todayIso={todayIso} />
    </div>
  );
}
