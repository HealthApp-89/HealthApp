// components/chat/HandoffLine.tsx
//
// Tiny centered divider rendered between two assistant messages when the
// speaker changes (e.g., Carter → Peter after a handoff_to tool call).
// Briefing prose is shown only during live streaming — replayed history
// passes briefing=null.
"use client";

import { speakerName } from "@/lib/coach/speakers";
import type { Speaker } from "@/lib/data/types";

export function HandoffLine({
  from,
  to,
  briefing,
}: {
  from: Speaker;
  to: Speaker;
  briefing: string | null;
}) {
  return (
    <div className="flex justify-center py-2">
      <div className="rounded-full bg-surface-alt border border-divider px-3 py-1 text-[11px] text-muted">
        {speakerName(from)} → {speakerName(to)}
        {briefing && (
          <span className="ml-2 italic text-mid">— {briefing}</span>
        )}
      </div>
    </div>
  );
}
