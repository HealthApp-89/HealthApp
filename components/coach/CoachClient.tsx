"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { ChatMode } from "@/lib/data/types";
import { COLOR, CHAT } from "@/lib/ui/theme";
import { CoachNav, type CoachView } from "@/components/coach/CoachNav";
import { BlockProgressCard } from "@/components/coach/BlockProgressCard";
import { WeekPlanCard } from "@/components/coach/WeekPlanCard";
import { PlanWeekCTA } from "@/components/coach/PlanWeekCTA";
import { WeekReviewBanner } from "@/components/coach/WeekReviewBanner";
import { useBlockProgress } from "@/lib/query/hooks/useBlockProgress";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useCoachRecent } from "@/lib/query/hooks/useCoachRecent";
import { Card } from "@/components/ui/Card";
import { weekdayInUserTz, formatHeaderDate } from "@/lib/time";

const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel"), {
  ssr: false,
  loading: () => (
    <div style={{ padding: 16, color: COLOR.textMuted, fontSize: 13 }}>
      Loading…
    </div>
  ),
});

function isChatMode(v: string | null | undefined): v is ChatMode {
  return v === "default" || v === "plan_week" || v === "setup_block" || v === "intake";
}

export function CoachClient({
  userId,
  todayDate,
  targetMonday,
  initialView,
}: {
  userId: string;
  todayDate: string;
  targetMonday: string;
  initialView: CoachView;
}) {
  const search = useSearchParams();
  const router = useRouter();
  const [activeView, setActiveView] = useState<CoachView>(initialView);

  const { data: blockProgress } = useBlockProgress(userId);
  const { data: trainingWeek } = useTrainingWeek(userId, targetMonday);
  const { data: recent } = useCoachRecent(userId);

  const modeParam = search.get("mode");
  const initialChatMode: ChatMode = isChatMode(modeParam) ? modeParam : "default";
  const initialModeContext = search.get("ctx") ?? undefined;
  const draftDocId = search.get("doc") ?? undefined;

  const hasActiveBlock =
    blockProgress != null && !("active" in blockProgress);
  const planExists = trainingWeek != null;
  const today = weekdayInUserTz();

  // Monday of the just-finished week (the recap window the banner points at).
  // dow=1..7 (Mon..Sun); subtract `dow-1` to reach this-week's Monday, then
  // another 7 to reach last week's Monday. Independent of today's weekday so
  // the same anchor holds Mon-Sun.
  const lastMondayForReview = (() => {
    const d = new Date(`${todayDate}T12:00:00Z`);
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (dow - 1) - 7);
    return d.toISOString().slice(0, 10);
  })();
  const isLatePlanning = today === "Monday" || today === "Tuesday";
  const showPlanCTA =
    hasActiveBlock &&
    !planExists &&
    (today === "Sunday" || today === "Monday" || today === "Tuesday");
  const showWeekCard = hasActiveBlock && planExists;
  const weekN =
    hasActiveBlock && blockProgress && !("active" in blockProgress)
      ? Math.min(5, blockProgress.current_week + (today === "Sunday" ? 1 : 0))
      : null;

  return (
    <div
      style={{
        maxWidth: CHAT.feedMaxWidth,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        minHeight: "100dvh",
      }}
    >
      <header style={{ padding: "12px 16px 8px" }}>
        <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
          {formatHeaderDate()}
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
          Coach
        </h1>
        <div style={{ marginTop: 12 }}>
          <CoachNav
            active={activeView}
            onChange={(v) => {
              setActiveView(v);
              const url = new URL(window.location.href);
              url.searchParams.set("view", v);
              router.replace(url.pathname + "?" + url.searchParams.toString(), {
                scroll: false,
              });
            }}
          />
        </div>
      </header>

      {/* Contextual banners — visible on both Today and Recent. */}
      <div
        style={{
          padding: "0 12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <BlockProgressCard userId={userId} />
        {showPlanCTA && (
          <PlanWeekCTA
            weekStart={targetMonday}
            weekN={weekN}
            isLate={isLatePlanning}
          />
        )}
        {showWeekCard && (
          <WeekPlanCard userId={userId} weekStart={targetMonday} />
        )}
        {/* Mid-week discoverability — Tue-Sat only. Sun/Mon are owned by
            PlanWeekCTA, so we don't compete for the slot. */}
        {today !== "Sunday" && today !== "Monday" && (
          <WeekReviewBanner userId={userId} weekStart={lastMondayForReview} />
        )}
      </div>

      {activeView === "recent" ? (
        /* Recent tab — newest-first list of days that received a morning brief. */
        <div
          style={{
            padding: "12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {(recent ?? []).map((d) => (
            <Card key={d.day} variant="compact">
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: COLOR.textStrong,
                }}
              >
                {new Date(d.day + "T12:00:00Z").toLocaleDateString([], {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </div>
              {d.band ? (
                <div
                  style={{
                    fontSize: 11,
                    color: COLOR.textMuted,
                    marginTop: 2,
                    textTransform: "capitalize",
                  }}
                >
                  {d.band.replace(/_/g, " ")}
                </div>
              ) : null}
            </Card>
          ))}
          {recent && recent.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: COLOR.textMuted,
                padding: "12px 4px",
              }}
            >
              No recent briefs yet.
            </div>
          ) : null}
        </div>
      ) : (
        /* Chat surface — embedded in-flow, no overlay chrome. */
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            marginTop: 10,
          }}
        >
          <ChatPanel
            userId={userId}
            initialKind="coach"
            initialMode={initialChatMode}
            initialModeContext={initialModeContext}
            draftDocId={draftDocId}
            embedded
          />
        </div>
      )}

    </div>
  );
}
