"use client";

import ChatPanel from "@/components/chat/ChatPanel";
import { CoachTrendsView } from "@/components/coach/trends/CoachTrendsView";
import { useMarkThreadSeen } from "@/lib/chat/use-mark-thread-seen";

type Props = {
  userId: string;
};

export function MetricsClient({ userId }: Props) {
  useMarkThreadSeen("peter");
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 88px)" }}>
      {/* Data block — top: coach trends (section pills + headline cards) */}
      <div style={{ flex: "0 0 auto" }}>
        <CoachTrendsView userId={userId} initialSection="performance" />
      </div>

      {/* Chat block — bottom: Peter chat (weekly review + nudge cards inline) */}
      <div
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          minHeight: 320,
          borderTop: "1px solid #e5e7eb",
        }}
      >
        <ChatPanel userId={userId} embedded={true} initialKind="coach" thread="peter" />
      </div>
    </div>
  );
}
