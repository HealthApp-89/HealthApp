import { CardSkeleton, PageHeaderSkeleton } from "@/components/ui/Skeleton";

/** /profile skeleton — header · stack of settings cards. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <PageHeaderSkeleton titleWidth={88} />

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        <CardSkeleton height={180} />
        <CardSkeleton height={140} />
        <CardSkeleton height={160} />
        <CardSkeleton height={120} />
      </div>
    </div>
  );
}
