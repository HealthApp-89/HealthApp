import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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
import { reviewWindow, recommendationWeekStart, type ReviewMode } from "@/lib/coach/week";
import { todayInUserTz, formatHeaderDate } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

function userTzNoon(): Date {
  // Build a Date that points unambiguously at "today" in the user's tz,
  // hour-of-day mid-noon, so reviewWindow/recommendationWeekStart's
  // internal UTC date math lands on the right calendar day.
  return new Date(`${todayInUserTz()}T12:00:00Z`);
}

export const revalidate = 60;

type Pattern = { label: string; detail: string };
type Plan = { week: string; today: string; tomorrow: string; note: string };
type DailyPayload = { insights: Insight[]; patterns: Pattern[]; plan: Plan };

export default async function CoachPage(props: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await props.searchParams;
  const view: CoachView = (["today", "this-week", "next-week"] as const).includes(
    sp.view as CoachView,
  )
    ? (sp.view as CoachView)
    : "today";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

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
        <CoachNav active={view} />
      </div>

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {view === "today" && <TodayView userId={user.id} />}
        {view === "this-week" && <ThisWeekView userId={user.id} />}
        {view === "next-week" && <NextWeekView userId={user.id} />}
      </div>
    </div>
  );
}

async function TodayView({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const { data: cached } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "coach")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();

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
        <RefreshButton endpoint="/api/insights" label={cached ? "Refresh" : "Run analysis"} />
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

async function ThisWeekView({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const { start, end, mode, daysRemaining } = reviewWindow(userTzNoon());

  const { data: cached } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "weekly_review")
    .eq("generated_for_date", end)
    .maybeSingle();

  const payload = (cached?.payload ?? null) as WeeklyReviewPayload | null;
  const windowSubtitle =
    mode === "in-progress"
      ? `${start} → ${end} · ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`
      : `${start} → ${end} · full week`;

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
        />
      </div>

      {!payload && (
        <Card>
          <p style={{ fontSize: "14px", color: COLOR.textMuted, lineHeight: 1.6 }}>
            No review for {start} → {end} yet. Click <em>Run review</em> to generate one and seed
            recommendations for {MODE_SEED_TARGET[mode]}.
          </p>
        </Card>
      )}

      {payload && (
        <WeeklyReview
          payload={payload}
          weekStart={start}
          weekEnd={end}
          mode={mode}
          daysRemaining={daysRemaining}
        />
      )}
    </>
  );
}

async function NextWeekView({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const targetWeek = recommendationWeekStart(userTzNoon());

  // Prefer the targeted upcoming week; fall back to the most recent week with rows.
  let { data: items } = await supabase
    .from("coach_recommendations")
    .select("id, week_start, text, category, priority, position, done")
    .eq("user_id", userId)
    .eq("week_start", targetWeek)
    .order("position", { ascending: true });

  let weekShown: string | null = items && items.length ? targetWeek : null;

  if (!items || items.length === 0) {
    const fallback = await supabase
      .from("coach_recommendations")
      .select("id, week_start, text, category, priority, position, done")
      .eq("user_id", userId)
      .order("week_start", { ascending: false })
      .order("position", { ascending: true })
      .limit(20);
    items = fallback.data ?? [];
    weekShown = items[0]?.week_start ?? null;
    items = items.filter((r) => r.week_start === weekShown);
  }

  return (
    <>
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
      <RecommendationsList
        initial={(items ?? []) as Recommendation[]}
        weekStart={weekShown}
      />
    </>
  );
}

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
