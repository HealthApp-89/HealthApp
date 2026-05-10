"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today", label: "Today",  href: "/health" },
  { id: "trend", label: "Trend",  href: "/health?view=trend" },
  { id: "log",   label: "Log",    href: "/health?view=log" },
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
