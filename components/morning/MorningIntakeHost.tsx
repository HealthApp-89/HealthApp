"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { MorningTrigger } from "@/components/morning/MorningTrigger";

// ChatPanel is dynamic-imported so it doesn't load on every page render
// when the overlay isn't shown.
const ChatPanel = dynamic(() => import("@/components/chat/ChatPanel"), {
  ssr: false,
});

const EVENT_NAME = "open-morning-intake";

/** Globally-dispatchable helper for components that want to open the
 *  intake overlay (e.g., the "Start morning intake" button on
 *  /health?tab=coach). */
export function openMorningIntake(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  }
}

type Props = { userId: string };

/** Mounts MorningTrigger + an overlay ChatPanel for the morning intake
 *  flow. Invisible until either:
 *    1. MorningTrigger decides today's intake should fire (auto), or
 *    2. openMorningIntake() is called from elsewhere (manual).
 *  Close from the overlay's X button (passed via onClose) returns to
 *  the host's hidden state. */
export function MorningIntakeHost({ userId }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  return (
    <>
      <MorningTrigger userId={userId} onShouldOpen={() => setOpen(true)} />
      {open && (
        <ChatPanel
          userId={userId}
          initialKind="morning_intake"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
