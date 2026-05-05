import type { ReactNode } from "react";
import { COLOR } from "@/lib/ui/theme";

type DashboardSectionProps = {
  label?: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Section wrapper with a low-contrast eyebrow label and consistent vertical rhythm. */
export function DashboardSection({ label, trailing, children, className = "" }: DashboardSectionProps) {
  return (
    <section className={`flex flex-col gap-3 ${className}`}>
      {(label || trailing) && (
        <div className="flex items-end justify-between px-1">
          {label && (
            <h2 className="text-[10px] uppercase tracking-[0.18em] font-medium" style={{ color: COLOR.textMuted }}>
              {label}
            </h2>
          )}
          {trailing && <div className="text-[10px]" style={{ color: COLOR.textFaint }}>{trailing}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
