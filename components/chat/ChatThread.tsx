// components/chat/ChatThread.tsx
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat/types";
import { ChatMessage as ChatMessageView } from "./ChatMessage";
import { MorningBriefCard as MorningBriefCardComponent } from "@/components/morning/MorningBriefCard";
import { WeeklyReviewCard } from "@/components/chat/WeeklyReviewCard";
import type { MorningBriefCard, WeeklyReviewCardUI } from "@/lib/data/types";

export function ChatThread({
  userId,
  messages,
  onLoadOlder,
  onRetry,
  onSendUserMessage,
  onFocusComposer,
}: {
  userId: string;
  messages: ChatMessage[];
  onLoadOlder: (beforeIso: string) => Promise<{ added: number }>;
  onRetry: (messageId: string) => void;
  onSendUserMessage?: (text: string) => void;
  onFocusComposer?: (placeholder: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const previousScrollHeightRef = useRef<number | null>(null);

  // Hide noise from old broken chat turns. Two render-only filters (rows stay
  // in the DB):
  //
  // 1. Errors older than 30 min — retry on them would target a stale assistant
  //    row; environment issues (e.g. ANTHROPIC_API_KEY-not-set) aren't chat
  //    content. Fresh errors still render with their retry chip.
  // 2. Orphan user messages older than 1h — a user message whose immediately-
  //    following assistant turn is missing or status≠'done' (i.e. the AI never
  //    successfully replied). Without this, May-4-style failed turns leave
  //    dangling "YOU: how did I do today?" bubbles forever.
  const ERROR_HIDE_AFTER_MS = 30 * 60 * 1000;
  const ORPHAN_USER_HIDE_AFTER_MS = 60 * 60 * 1000;
  const now = Date.now();
  const filteredMessages = messages.filter((m, idx) => {
    if (m.status === "error") {
      return now - new Date(m.created_at).getTime() < ERROR_HIDE_AFTER_MS;
    }
    if (m.role === "user") {
      // Next chronological message — chat-stream RPC pairs each user msg
      // with an assistant stub, so a "good" turn always has the assistant
      // message at idx+1.
      const next = messages[idx + 1];
      const hasGoodResponse =
        next && next.role === "assistant" && next.status === "done";
      if (hasGoodResponse) return true;
      return now - new Date(m.created_at).getTime() < ORPHAN_USER_HIDE_AFTER_MS;
    }
    return true;
  });

  // Auto-scroll to bottom on first render and when a new message appears at
  // the bottom (i.e. user just sent or assistant just streamed).
  //
  // useLayoutEffect (synchronous post-DOM-mutation) instead of useEffect so
  // sc.scrollHeight is measured after the DOM is updated but before paint.
  // Then two RAF re-attempts cover rich children (PlanProposalCard,
  // MorningBriefCard) that may finish laying out after the effect runs.
  // isAtBottom() guard prevents yanking a user who manually scrolled away.
  const lastIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    if (lastIdRef.current === last.id) return;
    lastIdRef.current = last.id;

    // Synchronous scroll-to-bottom on the current layout.
    sc.scrollTop = sc.scrollHeight;

    // Re-attempt on the next animation frame in case children finish laying
    // out after this effect runs. Two frames cover most async-content cases.
    // Bail if the user has scrolled away from the bottom in the meantime.
    const isAtBottom = () => sc.scrollHeight - sc.clientHeight - sc.scrollTop < 100;
    let frame1: ReturnType<typeof requestAnimationFrame> | null = null;
    let frame2: ReturnType<typeof requestAnimationFrame> | null = null;
    frame1 = requestAnimationFrame(() => {
      if (isAtBottom()) sc.scrollTop = sc.scrollHeight;
      frame2 = requestAnimationFrame(() => {
        if (isAtBottom()) sc.scrollTop = sc.scrollHeight;
      });
    });

    return () => {
      if (frame1 !== null) cancelAnimationFrame(frame1);
      if (frame2 !== null) cancelAnimationFrame(frame2);
    };
  }, [messages]);

  // Re-pin to bottom whenever the scroll content grows AFTER initial mount
  // (PlanProposalCard expandable details, MorningBriefCard inner blocks,
  // images loading, etc. all grow async). Only re-pins if the user was near
  // the bottom; respects manual scroll-away.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let lastHeight = sc.scrollHeight;
    const obs = new ResizeObserver(() => {
      const newHeight = sc.scrollHeight;
      // "Was near bottom BEFORE this resize" uses lastHeight (pre-resize)
      // because scrollTop hasn't been auto-adjusted yet.
      const wasNearBottomBefore =
        lastHeight - sc.clientHeight - sc.scrollTop < 200;
      if (newHeight > lastHeight && wasNearBottomBefore) {
        sc.scrollTop = newHeight;
      }
      lastHeight = newHeight;
    });
    // Observe the inner content (the children of scrollRef), not scrollRef
    // itself — we want to know when the content grows, not when the viewport
    // resizes.
    Array.from(sc.children).forEach((child) => obs.observe(child));
    return () => obs.disconnect();
  }, []);

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

  // Day dividers. Built from filteredMessages so hidden stale errors don't
  // produce orphan day dividers either.
  type Item = { kind: "msg"; m: ChatMessage } | { kind: "day"; label: string };
  const items: Item[] = [];
  let lastDay = "";
  for (const m of filteredMessages) {
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
        ) : it.m.kind === "morning_brief" ? (
          <MorningBriefCardComponent
            key={it.m.id}
            userId={userId}
            card={it.m.ui as MorningBriefCard}
          />
        ) : it.m.kind === "weekly_review" && it.m.ui ? (
          <WeeklyReviewCard
            key={it.m.id}
            ui={it.m.ui as WeeklyReviewCardUI}
          />
        ) : (
          <ChatMessageView
            key={it.m.id}
            message={it.m}
            onRetry={it.m.status === "error" ? () => onRetry(it.m.id) : undefined}
            onSendUserMessage={onSendUserMessage}
            onFocusComposer={onFocusComposer}
          />
        ),
      )}
    </div>
  );
}
