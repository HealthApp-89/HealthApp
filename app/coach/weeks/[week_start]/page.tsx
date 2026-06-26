import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { WeeklyReviewContent } from "@/components/coach/WeeklyReviewContent";
import { CHAT, COLOR } from "@/lib/ui/theme";

export const revalidate = 60;

/**
 * Weekly review route — per-section Suspense + parallel fetch.
 *
 * BEFORE: auth check + await fetchWeeklyReviewServer() both ran inside the
 * Server Component before any HTML was sent. The entire page was gated on
 * the single weekly_reviews DB query completing before even the layout
 * wrapper could be committed to the stream.
 *
 * AFTER: auth check is the only await in this component (it's a fast
 * cookie read via supabase.auth.getUser(), already required by middleware).
 * The DB fetch and all section renders happen inside WeeklyReviewContent,
 * which is wrapped in a top-level <Suspense>. This means:
 *
 *   1. The outer layout (TopBar, BottomNav in layout.tsx) paints immediately.
 *   2. The page wrapper with the page skeleton fills in instantly (zero DB
 *      dependence).
 *   3. Header + Recap paint as soon as the single weekly_reviews row arrives.
 *   4. Each heavier section (Reconfirm, Trends, Prescription, Narrative,
 *      Targets, Actions) is behind its own inner <Suspense> boundary so
 *      React commits the fast sections first then streams the rest in
 *      document order.
 *
 * The TanStack HydrationBoundary is removed: WeeklyReviewReconfirm and
 * WeeklyReviewActions use useQueryClient() only for post-mutation
 * invalidation (not to read initial data), so they do not need prefetched
 * cache state — the global QueryProvider in layout.tsx is sufficient.
 */
export default async function WeeklyReviewRoute(props: {
  params: Promise<{ week_start: string }>;
}) {
  const { week_start } = await props.params;

  // Auth check is the only await here — this is a fast cookie read that
  // middleware already performed; no extra network round-trip.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Page-level skeleton: matches the max-width + padding of the real content
  // so there's no layout shift when WeeklyReviewContent streams in.
  const pageSkeleton = (
    <div
      style={{
        maxWidth: CHAT.feedMaxWidth,
        margin: "0 auto",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        color: COLOR.textStrong,
      }}
    >
      <CardSkeleton height={80} />
      <CardSkeleton height={120} />
      <CardSkeleton height={140} />
      <CardSkeleton height={180} />
    </div>
  );

  return (
    <Suspense fallback={pageSkeleton}>
      <WeeklyReviewContent userId={user.id} weekStart={week_start} />
    </Suspense>
  );
}
