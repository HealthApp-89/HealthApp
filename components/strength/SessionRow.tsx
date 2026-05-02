"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type MouseEvent } from "react";
import type { WorkoutSession } from "@/lib/data/workouts";
import { WCOLORS } from "@/lib/ui/colors";

type Props = {
  session: WorkoutSession;
  selectedExercise?: string;
  isLast?: boolean;
};

/** One row in the Strength tab's recent-sessions list. Tapping an exercise pill
 *  routes to /strength?ex=<name> which re-renders the page with that trend card. */
export function SessionRow({ session, selectedExercise, isLast }: Props) {
  const router = useRouter();
  const wc = WCOLORS[session.type ?? "Other"] ?? "#888";
  const [, startTransition] = useTransition();
  // Mirror the URL-driven selection so the tapped pill flips its style instantly
  // without waiting for the RSC payload.
  const [optimisticSelected, setOptimisticSelected] = useState<string | undefined>(
    selectedExercise,
  );

  useEffect(() => {
    setOptimisticSelected(selectedExercise);
  }, [selectedExercise]);

  return (
    <div
      className="pb-3 mb-3"
      style={{ borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.05)" }}
    >
      <div className="flex justify-between items-center mb-1.5">
        <div className="flex gap-2 items-center">
          <span
            className="rounded-full"
            style={{ width: 8, height: 8, background: wc, boxShadow: `0 0 6px ${wc}` }}
          />
          <span className="text-[13px] font-semibold text-white/85">{session.type ?? "Workout"}</span>
          <span className="text-[10px] text-white/30">{session.date}</span>
        </div>
        {session.vol > 0 && (
          <span className="text-[11px] font-mono" style={{ color: wc }}>
            {(session.vol / 1000).toFixed(1)}k kg
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {session.exercises.map((e) => {
          const isSelected = optimisticSelected === e.name;
          const display = e.name.split("(")[0].trim();
          const href = isSelected ? "/strength" : `/strength?ex=${encodeURIComponent(e.name)}`;

          const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
            if (
              ev.metaKey ||
              ev.ctrlKey ||
              ev.shiftKey ||
              ev.altKey ||
              ev.button !== 0
            ) {
              return;
            }
            ev.preventDefault();
            setOptimisticSelected(isSelected ? undefined : e.name);
            startTransition(() => {
              router.push(href, { scroll: false });
            });
          };

          return (
            <Link
              key={e.name}
              href={href}
              scroll={false}
              onClick={onClick}
              aria-pressed={isSelected}
              className="text-[10px] px-2.5 py-1 rounded-full touch-manipulation select-none transition-[background,border-color,color,transform] active:scale-[0.97] active:bg-white/10"
              style={{
                background: isSelected ? `${wc}33` : "rgba(255,255,255,0.05)",
                border: `1px solid ${isSelected ? wc + "66" : "rgba(255,255,255,0.08)"}`,
                color: isSelected ? wc : "rgba(255,255,255,0.45)",
              }}
            >
              {display}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
