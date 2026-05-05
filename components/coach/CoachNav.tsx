"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today",     label: "Today",     href: "/coach?view=today"     },
  { id: "this-week", label: "This week", href: "/coach?view=this-week" },
  { id: "next-week", label: "Next week", href: "/coach?view=next-week" },
] as const;

export type CoachView = (typeof VIEWS)[number]["id"];

export function CoachNav({ active }: { active: CoachView }) {
  return (
    <RangePills
      options={VIEWS as unknown as { id: string; label: string; href: string }[]}
      active={active}
    />
  );
}
