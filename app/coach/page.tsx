import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { InsightsList, type Insight } from "@/components/coach/InsightsList";
import { RefreshButton } from "@/components/coach/RefreshButton";
import { CoachNav, type CoachView } from "@/components/coach/CoachNav";
import { WeeklyReview, type WeeklyReviewPayload } from "@/components/coach/WeeklyReview";
import {
  RecommendationsList,
  type Recommendation,
} from "@/components/coach/RecommendationsList";
import { lastCompleteWeek, nextWeekStart } from "@/lib/coach/week";

export const dynamic = "force-dynamic";

type Pattern = { label: string; detail: string };
type Plan = { week: string; today: string; tomorrow: string; note: string };
type DailyPayload = { insights: Insight[]; patterns: Pattern[]; plan: Plan };

export default async function CoachPage(props: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await props.searchParams;
  const view: CoachView = (["today", "last-week", "next-week"] as const).includes(
    sp.view as CoachView,
  )
    ? (sp.view as CoachView)
    : "today";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: tokens }] = await Promise.all([
    supabase.from("profiles").select("name").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
  ]);

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />
      <div className="px-4 pt-3.5 max-w-3xl mx-auto flex flex-col gap-3.5">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <CoachNav active={view} />
        </div>

        {view === "today" && <TodayView userId={user.id} />}
        {view === "last-week" && <LastWeekView userId={user.id} />}
        {view === "next-week" && <NextWeekView userId={user.id} />}
      </div>
    </main>
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
      <div className="flex justify-between items-center">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-white/35">🧠 Daily insight</div>
          {cached && (
            <div className="text-[10px] text-white/30 mt-0.5">
              Last run · {cached.generated_for_date}
            </div>
          )}
        </div>
        <RefreshButton endpoint="/api/insights" label={cached ? "Refresh" : "Run analysis"} />
      </div>

      {!payload && (
        <Card>
          <p className="text-sm text-white/40 leading-relaxed">
            No analysis yet. Click <em>Run analysis</em> to generate insights from your last 14
            days of data.
          </p>
          <p className="text-[11px] text-white/25 mt-2">
            Requires <code className="font-mono">ANTHROPIC_API_KEY</code> in your env.
          </p>
        </Card>
      )}

      {payload?.patterns?.length ? (
        <div
          className="rounded-[14px] px-4 py-3.5"
          style={{ background: "rgba(0,245,196,0.05)", border: "1px solid rgba(0,245,196,0.15)" }}
        >
          <SectionLabel color="rgba(0,245,196,0.6)">🔍 PATTERNS</SectionLabel>
          <div className="flex flex-col gap-2.5">
            {payload.patterns.map((p, i) => (
              <div key={i} className="flex gap-2.5">
                <span className="text-base flex-shrink-0" style={{ color: "#00f5c4" }}>
                  ◈
                </span>
                <div>
                  <div className="text-xs font-semibold text-white/80">{p.label}</div>
                  <div className="text-[11px] text-white/40 mt-0.5 leading-relaxed">{p.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {payload?.insights?.length ? <InsightsList insights={payload.insights} /> : null}

      {payload?.plan ? (
        <div
          className="rounded-[14px] px-4 py-3.5"
          style={{
            background: "rgba(162,155,254,0.07)",
            border: "1px solid rgba(162,155,254,0.15)",
          }}
        >
          <SectionLabel color="rgba(162,155,254,0.7)">{payload.plan.week ?? "PLAN"}</SectionLabel>
          <PlanRow label="Today" text={payload.plan.today} active />
          <PlanRow label="Tomorrow" text={payload.plan.tomorrow} />
          {payload.plan.note && (
            <div
              className="text-[11px] text-white/30 italic mt-2 pt-2"
              style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
            >
              &ldquo;{payload.plan.note}&rdquo;
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

async function LastWeekView({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const { start, end } = lastCompleteWeek();

  const { data: cached } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "weekly_review")
    .eq("generated_for_date", end)
    .maybeSingle();

  const payload = (cached?.payload ?? null) as WeeklyReviewPayload | null;

  return (
    <>
      <div className="flex justify-between items-center">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-white/35">📅 Weekly review</div>
          <div className="text-[10px] text-white/30 mt-0.5">
            {start} → {end}
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
          <p className="text-sm text-white/40 leading-relaxed">
            No review for {start} → {end} yet. Click <em>Run review</em> to generate one and seed
            recommendations into Next week.
          </p>
        </Card>
      )}

      {payload && <WeeklyReview payload={payload} weekStart={start} weekEnd={end} />}
    </>
  );
}

async function NextWeekView({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const targetWeek = nextWeekStart();

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
        <div className="text-[10px] uppercase tracking-[0.12em] text-white/35">🎯 Next week</div>
        <div className="text-[10px] text-white/30 mt-0.5">
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
    <div className="flex gap-2.5 mb-2">
      <div
        className="text-[10px] uppercase w-16 flex-shrink-0 pt-0.5"
        style={{ color: "rgba(255,255,255,0.25)" }}
      >
        {label}
      </div>
      <div className="text-xs font-semibold" style={{ color: active ? "#a29bfe" : "rgba(255,255,255,0.4)" }}>
        {text}
      </div>
    </div>
  );
}
