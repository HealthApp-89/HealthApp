// components/chat/HandoffLine.tsx
//
// Tiny centered divider rendered between two assistant messages when the
// speaker changes (e.g., Peter → Carter after a delegate_to_specialist
// handoff). Briefing prose is shown only during live streaming — replayed
// history passes briefing=null.
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
      <div className="rounded-full bg-zinc-900 border border-zinc-800 px-3 py-1 text-[11px] text-zinc-500">
        {speakerName(from)} → {speakerName(to)}
        {briefing && (
          <span className="ml-2 italic text-zinc-600">— {briefing}</span>
        )}
      </div>
    </div>
  );
}
