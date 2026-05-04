// components/chat/ChatBubble.tsx
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const ChatPanel = dynamic(() => import("./ChatPanel"), {
  ssr: false,
  loading: () => null,
});

export function ChatBubble() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open coach chat"
          className="fixed z-40 right-4 w-12 h-12 rounded-full bg-[#a29bfe] text-black text-xl shadow-lg shadow-black/40 flex items-center justify-center hover:bg-[#b6affe] active:scale-95 transition"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
        >
          💬
        </button>
      )}
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}
