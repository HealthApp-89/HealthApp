import { CardSkeleton, PageHeaderSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { RADIUS } from "@/lib/ui/theme";

/** /coach skeleton — header · view tabs · insight cards · plan card. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <PageHeaderSkeleton titleWidth={88} />

      {/* CoachNav sub-tabs */}
      <div style={{ display: "flex", gap: 6, padding: "0 8px 14px" }}>
        <Skeleton width={84} height={32} radius={RADIUS.pill} />
        <Skeleton width={84} height={32} radius={RADIUS.pill} />
      </div>

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        <CardSkeleton height={120} />
        <CardSkeleton height={160} />
        <CardSkeleton height={180} />
      </div>
    </div>
  );
}
