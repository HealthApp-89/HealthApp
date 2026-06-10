// components/morning/MorningTrigger.tsx
//
// Invisible client component. On mount, queries today + yesterday checkins
// and decides whether to auto-open ChatPanel in morning_intake mode. Uses
// sessionStorage to suppress re-pop on intra-session navigation.
//
// `today` is held in state (not just a render-time const) so a PWA that
// stays alive across midnight re-evaluates on the next visibility/focus
// event — without that, the trigger's `today` would stay stuck on the day
// the panel mounted, and the next-day morning bot would silently skip.

"use client";

import { useEffect, useState } from "react";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useProfile } from "@/lib/query/hooks/useProfile";
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
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "UTC";
  const [today, setToday] = useState<string>(() => todayInUserTz(new Date(), tz));
  const yesterday = isoMinusDays(today, 1);

  // Re-evaluate `today` when the tab/PWA comes back into focus. If the user
  // crossed midnight while the app was backgrounded, the new `today` triggers
  // fresh useCheckin queries and lets the decision effect below re-run with
  // a fresh sessionStorage key (date-prefixed), so the next-day pop fires
  // even without a full reload.
  useEffect(() => {
    const recheck = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const now = todayInUserTz(new Date(), tz);
      setToday((prev) => (prev === now ? prev : now));
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [tz]);

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
