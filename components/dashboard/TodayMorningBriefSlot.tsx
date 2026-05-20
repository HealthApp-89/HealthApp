"use client";

import { useTodayBrief } from "@/lib/query/hooks/useTodayBrief";
import { MorningBriefCard } from "@/components/morning/MorningBriefCard";
import { todayInUserTz } from "@/lib/time";

type Props = { userId: string };

/** Renders today's morning brief card at the top of the Today page. Returns
 *  null when no brief has been delivered yet (the morning intake hasn't run
 *  or hasn't finished). Hydrates from the server prefetch in app/page.tsx
 *  so first paint is instant; otherwise the hook fetches on the client. */
export function TodayMorningBriefSlot({ userId }: Props) {
  const today = todayInUserTz();
  const { data: card } = useTodayBrief(userId, today);
  if (!card) return null;
  return <MorningBriefCard userId={userId} card={card} />;
}
