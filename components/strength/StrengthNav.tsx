"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type MouseEvent } from "react";

const VIEWS = [
  { id: "recent", label: "Recent" },
  { id: "date", label: "By date" },
] as const;

type View = (typeof VIEWS)[number]["id"];

type Props = {
  active: View;
};

/** Top-of-page sub-tab nav for the Strength page. Mirrors TrendsNav styling. */
export function StrengthNav({ active }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticActive, setOptimisticActive] = useState<View>(active);

  useEffect(() => {
    setOptimisticActive(active);
  }, [active]);

  return (
    <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
      {VIEWS.map((v) => {
        const isActive = optimisticActive === v.id;
        const href = v.id === "recent" ? "/strength" : `/strength?view=${v.id}`;

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
          setOptimisticActive(v.id);
          startTransition(() => {
            router.push(href, { scroll: false });
          });
        };

        return (
          <Link
            key={v.id}
            href={href}
            scroll={false}
            onClick={onClick}
            aria-pressed={isActive}
            aria-busy={isPending && isActive}
            className="flex-none px-3.5 py-1.5 rounded-full text-xs whitespace-nowrap touch-manipulation select-none transition-[background,border-color,color,transform] active:scale-[0.97]"
            style={{
              background: isActive ? "rgba(0,245,196,0.15)" : "transparent",
              border: `1px solid ${isActive ? "rgba(0,245,196,0.5)" : "rgba(255,255,255,0.1)"}`,
              color: isActive ? "#00f5c4" : "rgba(255,255,255,0.4)",
              fontWeight: isActive ? 700 : 400,
            }}
          >
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}
