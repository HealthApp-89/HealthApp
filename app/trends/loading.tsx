import { CardSkeleton, PageHeaderSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { RADIUS } from "@/lib/ui/theme";

/** /trends skeleton — header · range pills · stack of metric chart cards. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <PageHeaderSkeleton titleWidth={92} />

      {/* Range pills */}
      <div style={{ display: "flex", gap: 6, padding: "0 8px 14px" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width={56} height={32} radius={RADIUS.pill} />
        ))}
      </div>

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <CardSkeleton key={i} height={148} />
        ))}
      </div>
    </div>
  );
}
