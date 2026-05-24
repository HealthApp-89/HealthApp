import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchCoachTrendsServer } from "@/lib/query/fetchers/coachTrends";
import { MetricsClient } from "@/components/metrics/MetricsClient";
import { COLOR } from "@/lib/ui/theme";
import { todayInUserTz } from "@/lib/time";
import type { TrendsSection } from "@/components/coach/trends/SectionPills";

export const dynamic = "force-dynamic";

type SP = {
  searchParams?: Promise<{
    sub?: string;
    section?: string;
    ex?: string;
    date?: string;
  }>;
};

const VALID_SECTIONS: TrendsSection[] = ["performance", "body", "cross"];

function normalizeSection(raw: string | undefined): TrendsSection {
  if (raw === "composition") return "body"; // back-compat redirect
  if (raw && (VALID_SECTIONS as string[]).includes(raw)) return raw as TrendsSection;
  return "performance";
}

export default async function MetricsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};

  // Defense-in-depth redirects for stale URLs (bookmarks pointing at the
  // old sub-pill surface from PRs 3-5). Each strength/body/log subview
  // has its own home now.
  if (sp.sub === "strength" && !sp.ex) {
    redirect("/strength?tab=coach");
  }
  if (sp.sub === "body") {
    redirect("/diet?tab=coach");
  }
  if (sp.sub === "log") {
    const dateQs = sp.date ? `&date=${encodeURIComponent(sp.date)}` : "";
    redirect(`/health?tab=log${dateQs}`);
  }

  // /metrics no longer hosts the Nutrition pill — that content moved to
  // /diet?view=nutrition. Old bookmarks redirect cleanly.
  if (sp.section === "nutrition") {
    redirect("/diet?view=nutrition");
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Trends fetch uses service-role per the existing /coach/progress pattern.
  const serviceSupabase = createSupabaseServiceRoleClient();
  const today = todayInUserTz();
  const queryClient = makeServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: queryKeys.coachTrends.one(user.id),
    queryFn: () => fetchCoachTrendsServer(serviceSupabase, user.id, today),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Metrics</h1>
          <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
            Peter · Head Coach
          </p>
        </header>
        <MetricsClient userId={user.id} initialSection={normalizeSection(sp.section)} />
      </div>
    </HydrationBoundary>
  );
}
