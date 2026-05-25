"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today", label: "Today",  href: "/diet?view=body" },
  { id: "trend", label: "Trend",  href: "/diet?view=body&trend=1" },
  { id: "log",   label: "Log",    href: "/diet?view=body&log=1" },
] as const;

export type HealthView = (typeof VIEWS)[number]["id"];

export function HealthNav({
  active,
  onChange,
}: {
  active: HealthView;
  onChange?: (view: HealthView) => void;
}) {
  return (
    <RangePills
      options={VIEWS as unknown as { id: string; label: string; href: string }[]}
      active={active}
      onChange={onChange ? (id) => onChange(id as HealthView) : undefined}
    />
  );
}
