"use client";

import { useFullWorkouts } from "@/lib/query/hooks/useFullWorkouts";
import { SessionRow } from "@/components/strength/SessionRow";
import { COLOR } from "@/lib/ui/theme";

type Props = { userId: string };

export function StrengthLogClient({ userId }: Props) {
  const { data: sessions, isLoading } = useFullWorkouts(userId);

  if (isLoading) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center", color: COLOR.textMuted }}>
        Loading…
      </div>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 12px 0" }}>
          Workout log coming soon — Strong CSV import still active. Tap Coach to
          plan your next session with Carter.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 16px" }}>
      {sessions.map((session, i, arr) => (
        <SessionRow
          key={session.id}
          session={session}
          isLast={i === arr.length - 1}
        />
      ))}
    </div>
  );
}
