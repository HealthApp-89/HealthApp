"use client";

import { useTodayBrief } from "@/lib/query/hooks/useTodayBrief";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { useUserToday } from "@/lib/query/hooks/useUserToday";
import { MorningBriefCard } from "@/components/morning/MorningBriefCard";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = { userId: string };

/** Renders today's morning brief card at the top of the Today page. When no
 *  brief has been delivered yet, shows a placeholder routing the user to
 *  the Health tab (where the intake now lives). Hydrates from the server
 *  prefetch in app/page.tsx so first paint is instant. */
export function TodayMorningBriefSlot({ userId }: Props) {
  const today = useUserToday(userId) ?? "";
  // Always call hooks. Gating via `enabled` keeps the query dormant while
  // the profile (and therefore tz-resolved `today`) is hydrating — and
  // keeps hook counts stable across renders (React #310).
  const enabled = !!today;
  const { data: card } = useTodayBrief(userId, today, { enabled });
  const { data: checkin } = useCheckin(userId, today, { enabled });

  if (!today) return null;

  if (card) return <MorningBriefCard userId={userId} card={card} />;

  // Sick path delivers via REST short-circuit (no brief assembled). Don't
  // nag the user with a "check-in pending" card when they've already
  // told us they're sick.
  if (checkin?.intake_state === "delivered" && checkin?.sick) return null;

  return (
    <a
      href="/health"
      style={{
        display: "block",
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        padding: "14px 16px",
        textDecoration: "none",
      }}
      aria-label="Morning check-in pending — open Health tab"
    >
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        Morning brief
      </div>
      <div style={{ fontSize: 14, color: COLOR.textStrong, fontWeight: 600 }}>
        Check-in pending →
      </div>
      <div style={{ fontSize: 12, color: COLOR.textMid, marginTop: 2 }}>
        Tap to start your morning check-in with Remi on the Health tab.
      </div>
    </a>
  );
}
