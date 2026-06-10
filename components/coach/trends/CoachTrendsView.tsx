"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCoachTrends } from "@/lib/query/hooks/useCoachTrends";
import { useBlockHistory } from "@/lib/query/hooks/useBlockHistory";
import { CHAT, COLOR } from "@/lib/ui/theme";
import { formatHeaderDate } from "@/lib/time";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { SectionPills, type TrendsSection } from "./SectionPills";
import { TrendsHeader } from "./TrendsHeader";
import { PerformanceSection } from "./PerformanceSection";
import { BodySection } from "./BodySection";
import { CrossSection } from "./CrossSection";

export function CoachTrendsView({
  userId,
  initialSection,
}: {
  userId: string;
  initialSection: TrendsSection;
}) {
  const router = useRouter();
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "UTC";
  const [activeSection, setActiveSection] = useState<TrendsSection>(initialSection);
  const { data: payload } = useCoachTrends(userId);
  const { data: blockHistory } = useBlockHistory(userId);

  if (!payload) return null;

  return (
    <div
      style={{
        maxWidth: CHAT.feedMaxWidth,
        margin: "0 auto",
        minHeight: "100dvh",
        color: COLOR.textStrong,
      }}
    >
      <header style={{ padding: "12px 16px 8px" }}>
        <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
          {formatHeaderDate(new Date(), tz)}
        </div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: COLOR.textStrong,
            margin: "2px 0 0",
          }}
        >
          Trends
        </h1>
      </header>

      <SectionPills
        active={activeSection}
        onChange={(s) => {
          setActiveSection(s);
          const url = new URL(window.location.href);
          url.searchParams.set("section", s);
          router.replace(url.pathname + "?" + url.searchParams.toString(), { scroll: false });
        }}
      />

      <div style={{ padding: "0 12px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        <TrendsHeader headline={payload.headline} />
        {activeSection === "performance" && (
          <PerformanceSection
            strength={payload.strength}
            recovery={payload.recovery}
            blockHistory={blockHistory}
          />
        )}
        {activeSection === "body" && (
          <BodySection body={payload.body} userId={userId} />
        )}
{activeSection === "cross" && <CrossSection insights={payload.cross_insights} />}
      </div>
    </div>
  );
}
