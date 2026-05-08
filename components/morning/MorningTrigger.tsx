// components/morning/MorningTrigger.tsx
//
// Invisible client component. On mount, queries today + yesterday checkins
// and decides whether to auto-open ChatPanel in morning_intake mode. Uses
// sessionStorage to suppress re-pop on intra-session navigation.

"use client";

import { useEffect } from "react";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { todayInUserTz } from "@/lib/time";
import { decideIntakeAction } from "@/lib/morning/state";

const SUPPRESS_KEY_PREFIX = "morningHandled-";

function isoMinusDays(iso: string, days: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

export function MorningTrigger({
  userId,
  onShouldOpen,
}: {
  userId: string;
  onShouldOpen: () => void;
}) {
  const today = todayInUserTz();
  const yesterday = isoMinusDays(today, 1);

  const { data: todayCheckin, isLoading: tLoading } = useCheckin(userId, today);
  const { data: yesterdayCheckin, isLoading: yLoading } = useCheckin(userId, yesterday);

  useEffect(() => {
    if (!userId) return;
    if (tLoading || yLoading) return;

    const supKey = SUPPRESS_KEY_PREFIX + today;
    if (typeof window !== "undefined" && window.sessionStorage.getItem(supKey)) {
      return; // already handled this session
    }

    const decision = decideIntakeAction(
      yesterdayCheckin ? { sick: yesterdayCheckin.sick } : null,
      todayCheckin ? { intake_state: todayCheckin.intake_state } : null,
    );

    if (decision.action === "skip") {
      // Mark suppressed so further nav doesn't even consider re-checking.
      window.sessionStorage.setItem(supKey, "1");
      return;
    }

    // Open and mark suppressed for the rest of the session.
    window.sessionStorage.setItem(supKey, "1");
    onShouldOpen();
  }, [userId, today, tLoading, yLoading, todayCheckin, yesterdayCheckin, onShouldOpen]);

  return null;
}
