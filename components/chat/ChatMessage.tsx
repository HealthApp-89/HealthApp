// components/chat/ChatMessage.tsx
"use client";

import { useState } from "react";
import type { ChatMessage as ChatMessageType } from "@/lib/chat/types";
import { renderMarkdownSubset } from "./markdown";

export function ChatMessage({
  message,
  onRetry,
}: {
  message: ChatMessageType;
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1.5`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 ${
          isUser
            ? "bg-[#a29bfe]/15 border border-[#a29bfe]/25 text-white"
            : "bg-white/[0.04] border border-white/[0.08] text-white/85"
        }`}
      >
        {message.images.length > 0 && (
          <div className={`grid ${message.images.length === 1 ? "grid-cols-1" : "grid-cols-2"} gap-1.5 mb-2`}>
            {message.images.map((img) => (
              <ImageThumb key={img.id} url={img.signed_url} />
            ))}
          </div>
        )}

        {message.content && (
          <div
            className="text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdownSubset(message.content) }}
          />
        )}

        {isStreaming && (
          <span className="inline-block w-1.5 h-4 ml-0.5 bg-white/60 align-middle animate-pulse" />
        )}

        {isError && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-rose-300/80">
              {message.error ?? "error"}
            </span>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="text-[11px] underline text-white/60 hover:text-white"
              >
                retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ImageThumb({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full aspect-square overflow-hidden rounded-lg bg-black/40"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="w-full h-full object-cover" />
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </>
  );
}
