"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Card, SectionLabel } from "@/components/ui/Card";
import { tintByKey } from "@/lib/ui/tints";
import { InsightsList, type Insight } from "@/components/coach/InsightsList";
import { RefreshButton } from "@/components/coach/RefreshButton";
import { CoachNav, type CoachView } from "@/components/coach/CoachNav";
import { WeeklyReview, type WeeklyReviewPayload } from "@/components/coach/WeeklyReview";
import {
  RecommendationsList,
  type Recommendation,
} from "@/components/coach/RecommendationsList";
import { type ReviewMode } from "@/lib/coach/week";
import { formatHeaderDate } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import { useInsightsDaily } from "@/lib/query/hooks/useInsightsDaily";
import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
import { useRecommendations } from "@/lib/query/hooks/useRecommendations";
import { BlockProgressCard } from "@/components/coach/BlockProgressCard";
import { WeekPlanCard } from "@/components/coach/WeekPlanCard";
import { PlanWeekCTA } from "@/components/coach/PlanWeekCTA";
import { useBlockProgress } from "@/lib/query/hooks/useBlockProgress";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { planningTargetMonday } from "@/lib/coach/week";
import { weekdayInUserTz } from "@/lib/time";
import { queryKeys } from "@/lib/query/keys";

type Pattern = { label: string; detail: string };
type Plan = { week: string; today: string; tomorrow: string; note: string };
type DailyPayload = { insights: Insight[]; patterns: Pattern[]; plan: Plan };

const MODE_TITLE: Record<ReviewMode, string> = {
  "monday-recap": "📅 Last week recap",
  "in-progress": "📅 This week so far",
  "sunday-full": "📅 Full-week review",
};
const MODE_SEED_TARGET: Record<ReviewMode, string> = {
  "monday-recap": "the week ahead",
  "in-progress": "the rest of this week",
  "sunday-full": "next week",
};

function PlanRow({ label, text, active }: { label: string; text?: string; active?: boolean }) {
  if (!text) return null;
  return (
    <div style={{ display: "flex", gap: "10px", marginBottom: "8px" }}>
      <div
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          width: "64px",
          flexShrink: 0,
          paddingTop: "2px",
          color: COLOR.textFaint,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "12px",
          fontWeight: 600,
          color: active ? "#5e5ce6" : COLOR.textMuted,
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function CoachClient({
  userId,
  todayDate,
  weekStart,
  weekEnd,
  weekMode,
  daysRemaining,
  recsTargetWeek,
  initialView,
}: {
  userId: string;
  todayDate: string;
  weekStart: string;
  weekEnd: string;
  weekMode: ReviewMode;
  daysRemaining: number;
  recsTargetWeek: string;
  initialView: CoachView;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [activeView, setActiveView] = useState<CoachView>(initialView);
  const search = useSearchParams();

  useEffect(() => {
    const m = search.get("mode");
    if (m === "plan_week" || m === "setup_block") {
      window.dispatchEvent(new CustomEvent("open-chat", { detail: { mode: m } }));
      // Strip the param so the dispatch doesn't fire on every re-render.
      const url = new URL(window.location.href);
      url.searchParams.delete("mode");
      window.history.replaceState({}, "", url.toString());
    }
  }, [search]);

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px 12px 14px",
        }}
      >
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>
            {formatHeaderDate()}
          </div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginTop: "2px",
            }}
          >
            Coach
          </h1>
        </div>
      </div>

      <div style={{ padding: "0 8px 14px" }}>
        <CoachNav active={activeView} onChange={setActiveView} />
      </div>

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {activeView === "today" && (
          <TodayView
            userId={userId}
            todayDate={todayDate}
            onRefreshSuccess={() => {
              queryClient.invalidateQueries({
                queryKey: queryKeys.insights.daily(userId, todayDate),
              });
              router.refresh();
            }}
          />
        )}
        {activeView === "this-week" && (
          <ThisWeekView
            userId={userId}
            weekStart={weekStart}
            weekEnd={weekEnd}
            mode={weekMode}
            daysRemaining={daysRemaining}
            onRefreshSuccess={() => {
              queryClient.invalidateQueries({
                queryKey: queryKeys.insights.weeklyReview(userId, weekEnd),
              });
              router.refresh();
            }}
          />
        )}
        {activeView === "next-week" && (
          <NextWeekView userId={userId} targetWeek={recsTargetWeek} />
        )}
      </div>
    </div>
  );
}

function TodayView({
  userId,
  todayDate,
  onRefreshSuccess,
}: {
  userId: string;
  todayDate: string;
  onRefreshSuccess: () => void;
}) {
  const { data: cached } = useInsightsDaily(userId, todayDate);
  const payload = (cached?.payload ?? null) as DailyPayload | null;

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: COLOR.textFaint,
            }}
          >
            🧠 Daily insight
          </div>
          {cached && (
            <div style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "2px" }}>
              Last run · {cached.generated_for_date}
            </div>
          )}
        </div>
        <RefreshButton
          endpoint="/api/insights"
          label={cached ? "Refresh" : "Run analysis"}
          onSuccess={onRefreshSuccess}
        />
      </div>

      {!payload && (
        <Card>
          <p style={{ fontSize: "14px", color: COLOR.textMuted, lineHeight: 1.6 }}>
            No analysis yet. Click <em>Run analysis</em> to generate insights from your last 14
            days of data.
          </p>
          <p style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "8px" }}>
            Requires <code style={{ fontFamily: "var(--font-mono, monospace)" }}>ANTHROPIC_API_KEY</code> in your env.
          </p>
        </Card>
      )}

      {payload?.patterns?.length ? (
        <div
          style={{
            borderRadius: "14px",
            padding: "14px 16px",
            border: "1px solid",
            ...tintByKey("steps"),
          }}
        >
          <SectionLabel color="rgba(48,209,88,0.6)">🔍 PATTERNS</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {payload.patterns.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: "10px" }}>
                <span style={{ fontSize: "16px", flexShrink: 0, color: "#30d158" }}>◈</span>
                <div>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: COLOR.textMid }}>{p.label}</div>
                  <div style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "2px", lineHeight: 1.5 }}>
                    {p.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {payload?.insights?.length ? <InsightsList insights={payload.insights} /> : null}

      {payload?.plan ? (
        <div
          style={{
            borderRadius: "14px",
            padding: "14px 16px",
            border: "1px solid",
            ...tintByKey("coach"),
          }}
        >
          <SectionLabel color="rgba(94,92,230,0.7)">{payload.plan.week ?? "PLAN"}</SectionLabel>
          <PlanRow label="Today" text={payload.plan.today} active />
          <PlanRow label="Tomorrow" text={payload.plan.tomorrow} />
          {payload.plan.note && (
            <div
              style={{
                fontSize: "11px",
                color: COLOR.textFaint,
                fontStyle: "italic",
                marginTop: "8px",
                paddingTop: "8px",
                borderTop: `1px solid ${COLOR.divider}`,
              }}
            >
              &ldquo;{payload.plan.note}&rdquo;
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

function ThisWeekView({
  userId,
  weekStart,
  weekEnd,
  mode,
  daysRemaining,
  onRefreshSuccess,
}: {
  userId: string;
  weekStart: string;
  weekEnd: string;
  mode: ReviewMode;
  daysRemaining: number;
  onRefreshSuccess: () => void;
}) {
  const { data: cached } = useWeeklyReview(userId, weekEnd);
  const payload = (cached?.payload ?? null) as WeeklyReviewPayload | null;
  const windowSubtitle =
    mode === "in-progress"
      ? `${weekStart} → ${weekEnd} · ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`
      : `${weekStart} → ${weekEnd} · full week`;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: COLOR.textFaint,
            }}
          >
            {MODE_TITLE[mode]}
          </div>
          <div style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "2px" }}>
            {windowSubtitle}
            {cached && " · cached"}
          </div>
        </div>
        <RefreshButton
          endpoint="/api/insights/weekly"
          label={cached ? "Re-run review" : "Run review"}
          onSuccess={onRefreshSuccess}
        />
      </div>

      {!payload && (
        <Card>
          <p style={{ fontSize: "14px", color: COLOR.textMuted, lineHeight: 1.6 }}>
            No review for {weekStart} → {weekEnd} yet. Click <em>Run review</em> to generate one
            and seed recommendations for {MODE_SEED_TARGET[mode]}.
          </p>
        </Card>
      )}

      {payload && (
        <WeeklyReview
          payload={payload}
          weekStart={weekStart}
          weekEnd={weekEnd}
          mode={mode}
          daysRemaining={daysRemaining}
        />
      )}
    </>
  );
}

function NextWeekView({ userId, targetWeek }: { userId: string; targetWeek: string }) {
  const { data: blockProgress } = useBlockProgress(userId);
  const targetMonday = planningTargetMonday(new Date());
  const { data: existing } = useTrainingWeek(userId, targetMonday);

  // Decision-table state per spec section "Mode triggering"
  const hasActiveBlock = blockProgress != null && !("active" in blockProgress);
  const planExists = existing !== null && existing !== undefined;
  const today = weekdayInUserTz(); // "Monday" .. "Sunday"

  const showPlanCTA =
    hasActiveBlock && !planExists && (today === "Sunday" || today === "Monday" || today === "Tuesday");
  const showWeekCard = hasActiveBlock && planExists;

  // Derive weekN for CTA display — known only when block is active.
  // On Sunday we're targeting NEXT week, so add 1 to current_week.
  const weekN =
    hasActiveBlock && blockProgress && !("active" in blockProgress)
      ? Math.min(5, blockProgress.current_week + (today === "Sunday" ? 1 : 0))
      : null;
  const isLatePlanning = today === "Monday" || today === "Tuesday";

  // Existing recommendations data (preserve)
  const { data } = useRecommendations(userId, targetWeek);
  const items = (data?.items ?? []) as Recommendation[];
  const weekShown = data?.weekShown ?? null;

  return (
    <>
      <BlockProgressCard userId={userId} />
      {showPlanCTA && <PlanWeekCTA weekStart={targetMonday} weekN={weekN} isLate={isLatePlanning} />}
      {showWeekCard && <WeekPlanCard userId={userId} weekStart={targetMonday} />}

      <div>
        <div
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: COLOR.textFaint,
          }}
        >
          🎯 Next week
        </div>
        <div style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "2px" }}>
          Recommendations seeded from your weekly review. Check them off as you go.
        </div>
      </div>
      <RecommendationsList initial={items} weekStart={weekShown} />
    </>
  );
}
