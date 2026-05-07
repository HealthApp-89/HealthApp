import { CardSkeleton, PageHeaderSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { RADIUS } from "@/lib/ui/theme";

/** /strength skeleton — header · sub-tab nav · sessions list · PRs · volume trend. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <PageHeaderSkeleton titleWidth={108} />

      {/* StrengthNav sub-tabs */}
      <div style={{ display: "flex", gap: 6, padding: "0 8px 14px" }}>
        <Skeleton width={72} height={32} radius={RADIUS.pill} />
        <Skeleton width={72} height={32} radius={RADIUS.pill} />
        <Skeleton width={72} height={32} radius={RADIUS.pill} />
      </div>

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        <CardSkeleton height={220} />
        <CardSkeleton height={140} />
        <CardSkeleton height={180} />
      </div>
    </div>
  );
}
