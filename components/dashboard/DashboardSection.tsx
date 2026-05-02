import type { ReactNode } from "react";

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
            <h2 className="text-[10px] uppercase tracking-[0.18em] text-white/35 font-medium">
              {label}
            </h2>
          )}
          {trailing && <div className="text-[10px] text-white/30">{trailing}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
