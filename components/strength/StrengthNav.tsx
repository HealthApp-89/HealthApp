"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today",  label: "Today",   href: "/strength?view=today"  },
  { id: "recent", label: "Recent",  href: "/strength"             },
  { id: "date",   label: "By date", href: "/strength?view=date"   },
] as const;

type View = (typeof VIEWS)[number]["id"];

/**
 * Sub-tab nav for /strength. When `onChange` is provided, switching tabs is
 * pure client state (no URL navigation). The `href` URLs remain on each pill
 * so cmd-click / right-click still gives the user a deep-linkable target.
 */
export function StrengthNav({
  active,
  onChange,
}: {
  active: View;
  onChange?: (view: View) => void;
}) {
  return (
    <RangePills
      options={VIEWS as unknown as { id: string; label: string; href: string }[]}
      active={active}
      onChange={onChange ? (id) => onChange(id as View) : undefined}
    />
  );
}
