import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type SP = {
  searchParams?: Promise<{
    tab?: string;
    sub?: string;
    section?: string;
    date?: string;
  }>;
};

/**
 * Legacy /metrics index → /coach.
 *
 * Preserves every redirect case the old /metrics page handled (sub=strength|body|log
 * and section=nutrition) so bookmarks pointing at the pre-rename surface land on
 * their new home. Deep-link sub-routes under /metrics/* (e.g. /metrics/reviews,
 * /metrics/weeks/[week_start]) are unaffected — only the index page redirects.
 */
export default async function MetricsLegacyRedirect({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};

  // Defense-in-depth redirects for stale URLs (bookmarks pointing at the
  // old sub-pill surface from PRs 3-5). Each strength/body/log subview
  // has its own home now.
  if (sp.sub === "strength") {
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

  // Bare /metrics → /coach (forwarding ?tab= if present).
  redirect(`/coach${sp.tab ? `?tab=${encodeURIComponent(sp.tab)}` : ""}`);
}
