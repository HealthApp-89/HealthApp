"use client";

import { GlossaryContent } from "@/components/coach/GlossarySheet";
import { COLOR } from "@/lib/ui/theme";

export function DefinitionsView() {
  return (
    <div style={{ padding: "8px 14px 24px" }}>
      <h1
        style={{
          fontSize: 22,
          fontWeight: 700,
          margin: "8px 0 14px",
          color: COLOR.textStrong,
        }}
      >
        Definitions
      </h1>
      <GlossaryContent />
    </div>
  );
}
