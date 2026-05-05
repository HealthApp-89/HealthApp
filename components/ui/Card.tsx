import type { ReactNode, HTMLAttributes, CSSProperties } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { tintByKey, tintStyle, type TintKey } from "@/lib/ui/tints";

type CardVariant = "standard" | "compact" | "nested";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  /** Override the surface color (e.g. accent-tinted hero cards). */
  background?: string;
  /** Override the shadow (e.g. hero accent shadow). */
  shadow?: string;
  children: ReactNode;
  /** DEPRECATED: Old API — semantic tint (recovery, strain, sleep …) — paints a soft gradient + matching border. */
  tint?: TintKey;
  /** DEPRECATED: Old API — custom hex tint, used when no semantic key fits. Ignored if `tint` is set. */
  tintColor?: string;
  /** DEPRECATED: Old API — multiplier on tint opacity (default 1). Use <1 for very subtle, >1 to push. */
  tintStrength?: number;
};

const VARIANT_RADIUS: Record<CardVariant, string> = {
  standard: RADIUS.card,
  compact:  RADIUS.cardMid,
  nested:   RADIUS.cardSmall,
};

const VARIANT_PADDING: Record<CardVariant, string> = {
  standard: "16px",
  compact:  "12px 14px",
  nested:   "12px 14px",
};

export function Card({
  variant = "standard",
  background,
  shadow,
  style,
  children,
  tint,
  tintColor,
  tintStrength,
  ...rest
}: CardProps) {
  // Support deprecated tint API for backward compatibility with old callers
  let finalStyle: CSSProperties = {
    background: background ?? COLOR.surface,
    borderRadius: VARIANT_RADIUS[variant],
    padding: VARIANT_PADDING[variant],
    boxShadow: shadow ?? SHADOW.card,
    ...style,
  };

  if (tint || tintColor) {
    const tinted: CSSProperties = tint
      ? tintByKey(tint, { strength: tintStrength })
      : tintStyle(tintColor!, { strength: tintStrength });
    finalStyle = { ...finalStyle, ...tinted };
  }

  return (
    <div
      {...rest}
      style={finalStyle}
    >
      {children}
    </div>
  );
}

/** Tiny uppercase eyebrow used inside cards. */
export function SectionLabel({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <div
      className="text-[10px] uppercase tracking-[0.12em] mb-2.5"
      style={{ color: color ?? "rgba(255,255,255,0.35)" }}
    >
      {children}
    </div>
  );
}
