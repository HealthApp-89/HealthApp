import { CardSkeleton, PageHeaderSkeleton, Skeleton } from "@/components/ui/Skeleton";

/**
 * Today (dashboard) skeleton — mirrors app/page.tsx layout:
 *   header · week strip · readiness hero · 2x2 metric grid · impact donut · coach card · recent lifts
 *
 * Rendered instantly on every navigation TO `/`. The real page replaces this
 * once Promise.all of the dashboard queries settles. The whole point: the URL
 * flips and *something* appears the moment the user taps the tab, instead of
 * the previous page sitting frozen for 2-4 s.
 */
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <PageHeaderSkeleton titleWidth={72} />

      {/* Week strip */}
      <div style={{ display: "flex", gap: 6, padding: "0 8px 14px" }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} width={40} height={56} radius="14px" style={{ flex: 1 }} />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 8px" }}>
        {/* Readiness hero */}
        <CardSkeleton height={156} />

        {/* 2x2 metric grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <CardSkeleton height={92} />
          <CardSkeleton height={92} />
          <CardSkeleton height={92} />
          <CardSkeleton height={92} />
        </div>

        {/* Impact donut */}
        <CardSkeleton height={220} />

        {/* Coach entry */}
        <CardSkeleton height={88} />

        {/* Recent lifts */}
        <CardSkeleton height={140} />
      </div>
    </div>
  );
}
