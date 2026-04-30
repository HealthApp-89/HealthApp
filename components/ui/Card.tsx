import type { CSSProperties, ReactNode } from "react";

type CardProps = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

/** Standard prototype card: subtle white wash, hairline border, 14px radius. */
export function Card({ children, className = "", style }: CardProps) {
  return (
    <div
      className={`rounded-[14px] border border-white/[0.06] bg-white/[0.025] px-4 py-3.5 ${className}`}
      style={style}
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
