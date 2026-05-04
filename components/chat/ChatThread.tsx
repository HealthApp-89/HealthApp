// components/chat/ChatThread.tsx
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat/types";
import { ChatMessage as ChatMessageView } from "./ChatMessage";

export function ChatThread({
  messages,
  onLoadOlder,
  onRetry,
}: {
  messages: ChatMessage[];
  onLoadOlder: (beforeIso: string) => Promise<{ added: number }>;
  onRetry: (messageId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const previousScrollHeightRef = useRef<number | null>(null);

  // Auto-scroll to bottom on first render and when a new message appears at
  // the bottom (i.e. user just sent or assistant just streamed).
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    if (lastIdRef.current === last.id) return;
    lastIdRef.current = last.id;
    sc.scrollTop = sc.scrollHeight;
  }, [messages]);

  // Restore scroll position after older messages prepend.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (previousScrollHeightRef.current !== null) {
      const delta = sc.scrollHeight - previousScrollHeightRef.current;
      sc.scrollTop = delta;
      previousScrollHeightRef.current = null;
    }
  }, [messages]);

  // Top sentinel triggers load-older.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const sc = scrollRef.current;
    if (!sentinel || !sc) return;
    const obs = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting) return;
        if (isLoadingOlder) return;
        if (messages.length === 0) return;
        const oldest = messages[0];
        setIsLoadingOlder(true);
        previousScrollHeightRef.current = sc.scrollHeight;
        try {
          await onLoadOlder(oldest.created_at);
        } finally {
          setIsLoadingOlder(false);
        }
      },
      { root: sc, threshold: 0.1 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [messages, onLoadOlder, isLoadingOlder]);

  // Day dividers.
  type Item = { kind: "msg"; m: ChatMessage } | { kind: "day"; label: string };
  const items: Item[] = [];
  let lastDay = "";
  for (const m of messages) {
    const day = new Date(m.created_at).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    if (day !== lastDay) {
      items.push({ kind: "day", label: day });
      lastDay = day;
    }
    items.push({ kind: "msg", m });
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto"
      style={{ overflowAnchor: "none" }}
    >
      <div ref={sentinelRef} className="h-4" />
      {items.map((it, i) =>
        it.kind === "day" ? (
          <div key={`d-${i}`} className="flex items-center gap-3 px-4 py-2">
            <div className="flex-1 h-px bg-white/[0.06]" />
            <div className="text-[10px] uppercase tracking-wider text-white/30">{it.label}</div>
            <div className="flex-1 h-px bg-white/[0.06]" />
          </div>
        ) : (
          <ChatMessageView
            key={it.m.id}
            message={it.m}
            onRetry={it.m.status === "error" ? () => onRetry(it.m.id) : undefined}
          />
        ),
      )}
    </div>
  );
}
