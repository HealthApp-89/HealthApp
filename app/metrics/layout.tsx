import React from "react";
import { MetricsShell } from "./MetricsShell";

export default function MetricsLayout({ children }: { children: React.ReactNode }) {
  return <MetricsShell>{children}</MetricsShell>;
}
