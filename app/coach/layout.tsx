import React from "react";
import { CoachSubNav } from "@/components/coach/CoachSubNav";

export default function CoachLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <CoachSubNav />
      {children}
    </div>
  );
}
