"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import type { ChatMode } from "@/lib/data/types";
import { COLOR, CHAT } from "@/lib/ui/theme";
import { CoachNav, type CoachView } from "@/components/coach/CoachNav";
import { CoachAvatar } from "@/components/coach/CoachAvatar";
import { BlockProgressCard } from "@/components/coach/BlockProgressCard";
import { WeekPlanCard } from "@/components/coach/WeekPlanCard";
import { PlanWeekCTA } from "@/components/coach/PlanWeekCTA";
import { WeekReviewBanner } from "@/components/coach/WeekReviewBanner";
import { ToolsView } from "@/components/coach/ToolsView";
import { useBlockProgress, isActiveBlock } from "@/lib/query/hooks/useBlockProgress";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useCoachRecent } from "@/lib/query/hooks/useCoachRecent";
import { useIntakeState } from "@/lib/query/hooks/useIntakeState";
import { useTodayBrief } from "@/lib/query/hooks/useTodayBrief";
import { queryKeys } from "@/lib/query/keys";
import { TodayAnchor, type AnchorBrief } from "@/components/chat/TodayAnchor";
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
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useState<CoachView>(initialView);

  const { data: blockProgress } = useBlockProgress(userId);
  const { data: trainingWeek } = useTrainingWeek(userId, targetMonday);
  const { data: recent } = useCoachRecent(userId);
  const { data: intakeState } = useIntakeState(userId, todayDate);
  const { data: todayBrief } = useTodayBrief(userId, todayDate, {
    enabled: activeView === "today",
  });

  // `?retry=brief` deep-link from TodayAnchor's brief_failed state. Fire the
  // retry endpoint once, refresh the affected caches, and strip the param so
  // a refresh doesn't re-trigger. A ref guard prevents React strict-mode
  // double-invocation in dev.
  const retryFiredRef = useRef(false);
  useEffect(() => {
    if (search.get("retry") !== "brief") return;
    if (retryFiredRef.current) return;
    retryFiredRef.current = true;

    (async () => {
      try {
        const res = await fetch("/api/chat/morning/retry-brief", {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: queryKeys.morningBrief.today(userId, todayDate),
            }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.intakeState.one(userId, todayDate),
            }),
          ]);
        }
      } finally {
        const newSearch = new URLSearchParams(search.toString());
        newSearch.delete("retry");
        const qs = newSearch.toString();
        router.replace(qs ? `/coach?${qs}` : "/coach");
      }
    })();
  }, [search, queryClient, router, userId, todayDate]);

  // Map MorningBriefCard.ui → AnchorBrief shape. Keep this mapping local so
  // TodayAnchor stays decoupled from the brief schema. Field paths mirror
  // MorningBriefCard in lib/data/types.ts. We display the top 3 prescribed
  // lifts (kg-loaded) — bodyweight/duration exercises have kg=null and would
  // produce noisy "Mobility null" rows, so they're filtered.
  const anchorBrief: AnchorBrief | null = todayBrief
    ? {
        sessionLabel: todayBrief.session?.type ?? null,
        summaryLine:
          (todayBrief.session?.exercises ?? [])
            .filter((e) => e.kg != null)
            .slice(0, 3)
            .map((e) => `${e.name} ${e.kg}kg`)
            .join(" · ") || null,
        proteinFloor_g: todayBrief.macros?.protein_target_g ?? null,
        readinessScore: todayBrief.readiness?.score ?? null,
      }
    : null;

  // Map IntakeState union to the smaller anchor state. Only "today" cases
  // matter — the anchor renders above the chat thread on /coach today view.
  const anchorIntakeState: React.ComponentProps<typeof TodayAnchor>["intakeState"] =
    intakeState === "brief_delivered" ||
    intakeState === "brief_failed" ||
    intakeState === "assembling_brief"
      ? intakeState
      : intakeState == null
        ? "missing"
        : "awaiting";

  const modeParam = search.get("mode");
  const initialChatMode: ChatMode = isChatMode(modeParam) ? modeParam : "default";
  const initialModeContext = search.get("ctx") ?? undefined;
  const draftDocId = search.get("doc") ?? undefined;

  const hasActiveBlock = isActiveBlock(blockProgress);
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 4,
          }}
        >
          <CoachAvatar size={36} decorative />
          <div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                lineHeight: 1.1,
                color: COLOR.textStrong,
              }}
            >
              Coach Carter
            </div>
            <div
              style={{
                fontSize: 10,
                color: COLOR.success,
                fontWeight: 600,
                marginTop: 2,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: COLOR.success,
                }}
                aria-hidden="true"
              />
              online
            </div>
          </div>
        </div>
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

      {/* Contextual banners — visible on Today and Recent. Tools view owns
          its own surface (focused tool browser) so banners are hidden there. */}
      {activeView !== "tools" && (
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
      )}

      {activeView === "tools" ? (
        /* Tools tab — categorized list of every user-facing coach action. */
        <div style={{ marginTop: 10 }}>
          <ToolsView userId={userId} todayDate={todayDate} />
        </div>
      ) : activeView === "recent" ? (
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
        /* Chat surface — embedded in-flow, no overlay chrome.
         *
         * TodayAnchor sits above the chat panel as a sticky card. It serves
         * the V3 primary goal (always-visible Today: session + readiness +
         * protein floor) and restores the brief-retry deep-link that Slice 3
         * removed when it deleted BriefStateChip from the dashboard. */
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            marginTop: 10,
          }}
        >
          <TodayAnchor
            intakeState={anchorIntakeState}
            brief={anchorBrief}
          />
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
