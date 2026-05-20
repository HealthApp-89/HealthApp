import { Suspense } from "react";
import { redirect } from "next/navigation";
import { StrengthSubPill } from "./_sub/StrengthSubPill";
import { BodySubPill } from "./_sub/BodySubPill";
import { TrendsSubPill } from "./_sub/TrendsSubPill";
import { LogSubPill } from "./_sub/LogSubPill";

// Sub-pill content varies per request and embeds dynamic Supabase data
// — disable static optimisation so each sub-pill always renders fresh.
export const dynamic = "force-dynamic";

type SP = {
  searchParams?: Promise<{
    sub?: string;
    // Forwarded to sub-pills:
    ex?: string;
    view?: string;
    date?: string;
    period?: string;
    start?: string;
    end?: string;
    log?: string;
  }>;
};

const VALID_SUBS = ["strength", "body", "trends", "log"] as const;

export default async function MetricsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};
  // Default to "trends" — the only sub-pill that still renders here after
  // PRs 3 and 4 moved strength + body to their own pages. Default to a
  // sub that redirects away (strength, body) would make the Metrics tab
  // immediately bounce, leaving no chance to tap a different sub-pill.
  const sub = sp.sub ?? "trends";
  if (!VALID_SUBS.includes(sub as (typeof VALID_SUBS)[number])) {
    redirect("/metrics?sub=trends");
  }

  // Redirect bare /metrics?sub=strength to the new home. Preserve drilldown
  // URLs (?ex=...) at the old surface until PR 6 dismantles it.
  if (sub === "strength" && !sp.ex) {
    redirect("/strength?tab=coach");
  }

  // Body composition lives on the Diet page now (Nora narrates weight + BF%
  // as nutrition outcomes). No drilldown to preserve.
  if (sub === "body") {
    redirect("/diet?tab=coach");
  }

  // Daily log (recovery + checkin editor) moved to the Health page's Log
  // sub-tab. Preserve ?date= for deep-links to a specific day's log.
  if (sub === "log") {
    const dateQs = sp.date ? `&date=${encodeURIComponent(sp.date)}` : "";
    redirect(`/health?tab=log${dateQs}`);
  }

  return (
    <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
      {sub === "strength" && (
        <StrengthSubPill params={{ ex: sp.ex, view: sp.view, date: sp.date }} />
      )}
      {sub === "body" && (
        <BodySubPill params={{ view: sp.view, log: sp.log }} />
      )}
      {sub === "trends" && (
        <TrendsSubPill
          params={{ period: sp.period, start: sp.start, end: sp.end }}
        />
      )}
      {sub === "log" && <LogSubPill date={sp.date} />}
    </Suspense>
  );
}
