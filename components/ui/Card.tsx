import type { CSSProperties, ReactNode } from "react";

import { tintByKey, tintStyle, type TintKey } from "@/lib/ui/tints";

type CardProps = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Semantic tint (recovery, strain, sleep …) — paints a soft gradient + matching border. */
  tint?: TintKey;
  /** Custom hex tint, used when no semantic key fits. Ignored if `tint` is set. */
  tintColor?: string;
  /** Multiplier on tint opacity (default 1). Use <1 for very subtle, >1 to push. */
  tintStrength?: number;
};

/** Standard prototype card: subtle white wash, hairline border, 14px radius. */
export function Card({
  children,
  className = "",
  style,
  tint,
  tintColor,
  tintStrength,
}: CardProps) {
  const tinted: CSSProperties = tint
    ? tintByKey(tint, { strength: tintStrength })
    : tintColor
      ? tintStyle(tintColor, { strength: tintStrength })
      : {};
  const isTinted = !!tint || !!tintColor;
  const baseClasses = isTinted
    ? "rounded-[14px] border px-4 py-3.5"
    : "rounded-[14px] border border-white/[0.06] bg-white/[0.025] px-4 py-3.5";
  return (
    <div className={`${baseClasses} ${className}`} style={{ ...tinted, ...style }}>
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
