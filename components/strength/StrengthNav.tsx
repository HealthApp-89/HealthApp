"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today",  label: "Today",   href: "/strength?view=today"  },
  { id: "recent", label: "Recent",  href: "/strength"             },
  { id: "date",   label: "By date", href: "/strength?view=date"   },
] as const;

type View = (typeof VIEWS)[number]["id"];

export function StrengthNav({ active }: { active: View }) {
  return <RangePills options={VIEWS as unknown as { id: string; label: string; href: string }[]} active={active} />;
}
