"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type MouseEvent } from "react";

export type CoachView = "today" | "this-week" | "next-week";

const TABS: { id: CoachView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "this-week", label: "This week" },
  { id: "next-week", label: "Next week" },
];

export function CoachNav({ active }: { active: CoachView }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticActive, setOptimisticActive] = useState<CoachView>(active);

  useEffect(() => {
    setOptimisticActive(active);
  }, [active]);

  return (
    <div
      className="inline-flex rounded-full p-1 gap-1"
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      {TABS.map((t) => {
        const is = optimisticActive === t.id;
        const href = `/coach?view=${t.id}`;

        const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
          if (
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey ||
            e.button !== 0
          ) {
            return;
          }
          e.preventDefault();
          setOptimisticActive(t.id);
          startTransition(() => {
            router.push(href, { scroll: false });
          });
        };

        return (
          <Link
            key={t.id}
            href={href}
            onClick={onClick}
            aria-pressed={is}
            aria-busy={isPending && is}
            className="px-3.5 py-1.5 rounded-full text-[11px] font-semibold touch-manipulation select-none transition-[background,color,border-color,transform] active:scale-[0.97]"
            style={
              is
                ? { background: "rgba(0,245,196,0.18)", color: "#00f5c4", border: "1px solid #00f5c455" }
                : { color: "rgba(255,255,255,0.55)", border: "1px solid transparent" }
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
