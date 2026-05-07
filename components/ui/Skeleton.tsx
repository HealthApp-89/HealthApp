import type { CSSProperties } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";

/**
 * Lightweight skeleton box. Pulses via Tailwind's built-in `animate-pulse`.
 * Used by every route's loading.tsx — the App Router renders this *instantly*
 * on link click, so the URL flips and the user gets visual feedback while the
 * server component finishes its work behind the scenes.
 *
 * Keep this file dependency-free (server-renderable, no "use client").
 */
export function Skeleton({
  width = "100%",
  height = 16,
  radius = RADIUS.cardSmall,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="animate-pulse"
      style={{
        width,
        height,
        borderRadius: radius,
        background: COLOR.surfaceAlt,
        ...style,
      }}
    />
  );
}

/**
 * Card-shaped skeleton — matches the surface color of real cards so the
 * skeleton→content swap doesn't flash a different background.
 */
export function CardSkeleton({
  height = 80,
  style,
}: {
  height?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="animate-pulse"
      style={{
        width: "100%",
        height,
        borderRadius: RADIUS.card,
        background: COLOR.surface,
        boxShadow: "0 2px 8px rgba(20,30,80,0.05)",
        ...style,
      }}
    />
  );
}

/** Page header skeleton: muted eyebrow + larger title bar. */
export function PageHeaderSkeleton({ titleWidth = 96 }: { titleWidth?: number }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "4px 12px 14px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Skeleton width={120} height={12} radius={RADIUS.chip} />
        <Skeleton width={titleWidth} height={24} radius={RADIUS.chip} />
      </div>
      <Skeleton width={40} height={40} radius="50%" />
    </div>
  );
}
