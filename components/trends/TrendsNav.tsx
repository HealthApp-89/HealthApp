"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition, type MouseEvent } from "react";

const SECTIONS = [
  { id: "body", label: "Body" },
  { id: "sleep", label: "Sleep" },
  { id: "training", label: "Training" },
  { id: "strength", label: "Strength" },
  { id: "compare", label: "Compare" },
];

type Props = {
  active: string;
  /** Other querystring keys to preserve when switching section. */
  preserve?: Record<string, string | undefined>;
};

export function TrendsNav({ active, preserve = {} }: Props) {
  const router = useRouter();
  const currentParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  // Highlight the tapped pill instantly while the RSC payload streams in.
  const [optimisticActive, setOptimisticActive] = useState(active);

  // Resync when the URL-driven `active` changes (browser back/forward).
  useEffect(() => {
    setOptimisticActive(active);
  }, [active]);

  return (
    <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
      {SECTIONS.map((s) => {
        const isActive = optimisticActive === s.id;
        // Merge the live URL params with the explicit preserve overrides so
        // future-added params survive a section switch.
        const params = new URLSearchParams(currentParams?.toString() ?? "");
        for (const [k, v] of Object.entries(preserve)) {
          if (v) params.set(k, v);
        }
        params.set("section", s.id);
        const href = `/trends?${params.toString()}`;

        const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
          // Let the browser handle modifier-key / middle-click for new-tab.
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
          setOptimisticActive(s.id);
          startTransition(() => {
            router.push(href, { scroll: false });
          });
        };

        return (
          <Link
            key={s.id}
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
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}
