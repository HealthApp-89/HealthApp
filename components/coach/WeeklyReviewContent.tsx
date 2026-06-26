/**
 * WeeklyReviewContent — async Server Component
 *
 * Fetches the weekly_reviews row and renders the page in two phases:
 *
 *   Phase 1 (fast): Header + Recap paint as soon as the single DB fetch
 *   resolves. These sections are cheap to render and contain the most
 *   actionable information (week context, sessions done, top sets).
 *
 *   Phase 2 (streamed): Reconfirm, Trends, Prescription, Narrative,
 *   Targets, and Actions each sit behind their own <Suspense> boundary
 *   with a CardSkeleton fallback. React commits Phase 1 to the DOM first,
 *   then fills in the remaining sections in document order.
 *
 * This component is wrapped by a top-level <Suspense> in the route's
 * page.tsx so the whole fetch is off the critical path for the outer
 * layout (nav, TopBar) which paints immediately.
 */

import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchWeeklyReviewServer } from "@/lib/query/fetchers/weeklyReview";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { Card } from "@/components/ui/Card";
import { COLOR, CHAT } from "@/lib/ui/theme";
import { WeeklyReviewHeader } from "./WeeklyReviewHeader";
import { WeeklyReviewRecap } from "./WeeklyReviewRecap";
import { WeeklyReviewReconfirm } from "./WeeklyReviewReconfirm";
import { WeeklyReviewTrends } from "./WeeklyReviewTrends";
import { WeeklyReviewPrescription } from "./WeeklyReviewPrescription";
import { WeeklyReviewNarrative } from "./WeeklyReviewNarrative";
import { WeeklyReviewTargets } from "./WeeklyReviewTargets";
import { WeeklyReviewActions } from "./WeeklyReviewActions";
import type { WeeklyReviewRow } from "@/lib/data/types";

// ── Per-section thin async wrappers ──────────────────────────────────────────
//
// Each section is an async Server Component. They all receive the already-
// fetched row as a prop (no extra DB hit — React deduplicates nothing because
// there is nothing to deduplicate: the fetch happened in WeeklyReviewContent).
// The value of the Suspense boundary here is rendering priority: React
// commits the header + recap to the DOM first, then streams the remaining
// sections in document order as each async boundary resolves.

async function SectionReconfirm({
  row,
  userId,
  weekStart,
}: {
  row: WeeklyReviewRow;
  userId: string;
  weekStart: string;
}) {
  return (
    <WeeklyReviewReconfirm
      reviewId={row.id}
      reconfirm={row.payload.reconfirm}
      responses={row.reconfirm_responses}
      userId={userId}
      weekStart={weekStart}
    />
  );
}

async function SectionTrends({ row }: { row: WeeklyReviewRow }) {
  return <WeeklyReviewTrends trends={row.payload.trends} />;
}

async function SectionPrescription({ row }: { row: WeeklyReviewRow }) {
  return (
    <WeeklyReviewPrescription
      prescription={row.payload.prescription}
      recap={row.payload.recap}
    />
  );
}

async function SectionNarrative({ row }: { row: WeeklyReviewRow }) {
  return <WeeklyReviewNarrative md={row.narrative_md} />;
}

async function SectionTargets({ row }: { row: WeeklyReviewRow }) {
  return <WeeklyReviewTargets targets={row.payload.targets} />;
}

async function SectionActions({ row }: { row: WeeklyReviewRow }) {
  return <WeeklyReviewActions reviewRow={row} />;
}

// ── Main async Server Component ───────────────────────────────────────────────

export async function WeeklyReviewContent({
  userId,
  weekStart,
}: {
  userId: string;
  weekStart: string;
}) {
  const supabase = await createSupabaseServerClient();
  const row = await fetchWeeklyReviewServer(supabase, userId, weekStart);
  if (!row) notFound();

  const p = row.payload;
  const blockStarted = p.header.week_n > 0;

  return (
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
      {/* Phase 1 — fast sections; paint as soon as the fetch resolves */}
      <WeeklyReviewHeader header={p.header} />

      {!blockStarted && (
        <Card>
          <div
            style={{
              padding: "12px",
              fontSize: 12,
              color: COLOR.textMuted,
              lineHeight: 1.5,
            }}
          >
            The detailed recap, prescription, and trend sections appear once the
            active block covers this week. Set up or restart your training block
            on /coach to begin.
          </div>
        </Card>
      )}

      {blockStarted && (
        <>
          {/* Recap sits directly after the header — no Suspense needed since
              it renders from the same already-fetched row. */}
          <WeeklyReviewRecap recap={p.recap} />

          {/* Phase 2 — each heavier section behind its own Suspense boundary
              so React can commit the header + recap first, then stream the
              remaining sections in document order. */}
          <Suspense fallback={<CardSkeleton height={120} />}>
            <SectionReconfirm row={row} userId={userId} weekStart={weekStart} />
          </Suspense>

          <Suspense fallback={<CardSkeleton height={140} />}>
            <SectionTrends row={row} />
          </Suspense>

          <Suspense fallback={<CardSkeleton height={180} />}>
            <SectionPrescription row={row} />
          </Suspense>

          <Suspense fallback={<CardSkeleton height={100} />}>
            <SectionNarrative row={row} />
          </Suspense>

          <Suspense fallback={<CardSkeleton height={120} />}>
            <SectionTargets row={row} />
          </Suspense>

          <Suspense fallback={<CardSkeleton height={80} />}>
            <SectionActions row={row} />
          </Suspense>
        </>
      )}
    </div>
  );
}
