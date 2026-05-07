import { CardSkeleton, PageHeaderSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** /log skeleton — header · week strip · 2-col metric row · big form card. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "12px 8px 16px" }}>
      <PageHeaderSkeleton titleWidth={48} />

      <div style={{ display: "flex", gap: 6, padding: "0 8px 14px" }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} width={40} height={56} radius="14px" style={{ flex: 1 }} />
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          padding: "0 8px 14px",
        }}
      >
        <CardSkeleton height={72} />
        <CardSkeleton height={72} />
      </div>

      <div style={{ padding: "0 8px" }}>
        <CardSkeleton height={420} />
      </div>
    </div>
  );
}
