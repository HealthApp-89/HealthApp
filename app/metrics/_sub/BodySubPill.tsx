// app/metrics/_sub/BodySubPill.tsx
//
// Mirrors the old app/health/page.tsx data fetch + render. The /health
// route's view (today / log / trend) is exposed via the existing
// HealthClient — sub-pill just re-uses it.
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchBodyMeasurementsServer } from "@/lib/query/fetchers/bodyMeasurements";
import { fetchHealthTrendServer } from "@/lib/query/fetchers/healthTrend";
import { HealthClient } from "@/components/health/HealthClient";
import type { HealthView } from "@/components/health/HealthNav";
import { todayInUserTz } from "@/lib/time";

function ymFrom(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 12);
  return d.toISOString().slice(0, 10);
}

type Params = {
  view?: string;
  log?: string;
};

export async function BodySubPill({ params }: { params: Params }) {
  // `?log=measurement` (from LogEntrySheet) maps to the existing
  // HealthClient `log` view so the form opens immediately.
  const requestedView =
    params.log === "measurement" ? "log" : params.view ?? "today";
  const initialView: HealthView =
    requestedView === "trend"
      ? "trend"
      : requestedView === "log"
      ? "log"
      : "today";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const todayIso = todayInUserTz();
  const trendFromIso = ymFrom(todayIso);
  const queryClient = makeServerQueryClient();

  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.bodyMeasurements.all(user.id),
      queryFn: () => fetchBodyMeasurementsServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.healthTrend.range(user.id, trendFromIso, todayIso),
      queryFn: () => fetchHealthTrendServer(supabase, user.id, trendFromIso, todayIso),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HealthClient
        userId={user.id}
        todayIso={todayIso}
        trendFromIso={trendFromIso}
        initialView={initialView}
      />
    </HydrationBoundary>
  );
}
