"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today",     label: "Today",     href: "/coach?view=today"     },
  { id: "this-week", label: "This week", href: "/coach?view=this-week" },
  { id: "next-week", label: "Next week", href: "/coach?view=next-week" },
] as const;

export type CoachView = (typeof VIEWS)[number]["id"];

/**
 * When `onChange` is provided, switching tabs is pure client state — no URL
 * navigation. Hrefs remain on each pill so cmd-click still gives a deep
 * link. URL-mode (no onChange) preserves the legacy server-render-per-tap.
 */
export function CoachNav({
  active,
  onChange,
}: {
  active: CoachView;
  onChange?: (view: CoachView) => void;
}) {
  return (
    <RangePills
      options={VIEWS as unknown as { id: string; label: string; href: string }[]}
      active={active}
      onChange={onChange ? (id) => onChange(id as CoachView) : undefined}
    />
  );
}
