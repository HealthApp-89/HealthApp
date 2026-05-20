"use client";

import { LogClient } from "@/components/log/LogClient";
import { todayInUserTz } from "@/lib/time";

type Props = {
  userId: string;
  initialDate?: string;
};

export function HealthLogClient({ userId, initialDate }: Props) {
  const date = initialDate ?? todayInUserTz();
  return <LogClient userId={userId} date={date} />;
}
