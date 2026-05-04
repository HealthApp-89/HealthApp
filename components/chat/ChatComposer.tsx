// components/chat/ChatComposer.tsx
"use client";

import { useRef, useState } from "react";
import { transcodeToJpeg } from "./heicTranscode";

type Pending = {
  clientId: string;
  thumbnailUrl: string; // object URL for optimistic preview
  status: "uploading" | "ready" | "error";
  serverId?: string;
  error?: string;
};

export function ChatComposer({
  disabled,
  onSend,
}: {
  disabled?: boolean;
  onSend: (content: string, imageIds: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allImagesReady = pending.every((p) => p.status === "ready");
  const canSend = !disabled && allImagesReady && (text.trim().length > 0 || pending.length > 0);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const arr = Array.from(files).slice(0, 8 - pending.length);
    for (const file of arr) {
      const clientId = crypto.randomUUID();
      const thumbnailUrl = URL.createObjectURL(file);
      setPending((p) => [...p, { clientId, thumbnailUrl, status: "uploading" }]);

      try {
        const transcoded = await transcodeToJpeg(file);
        const fd = new FormData();
        fd.append("file", transcoded);
        const res = await fetch("/api/chat/images", { method: "POST", body: fd });
        const json = (await res.json()) as { ok: boolean; id?: string; reason?: string };
        if (!res.ok || !json.ok || !json.id) {
          throw new Error(json.reason ?? `http_${res.status}`);
        }
        setPending((p) =>
          p.map((x) =>
            x.clientId === clientId ? { ...x, status: "ready", serverId: json.id } : x,
          ),
        );
      } catch (e) {
        setPending((p) =>
          p.map((x) =>
            x.clientId === clientId
              ? { ...x, status: "error", error: (e as Error).message }
              : x,
          ),
        );
      }
    }
  }

  function removePending(clientId: string) {
    setPending((p) => {
      const target = p.find((x) => x.clientId === clientId);
      if (target) URL.revokeObjectURL(target.thumbnailUrl);
      return p.filter((x) => x.clientId !== clientId);
    });
  }

  function send() {
    if (!canSend) return;
    const imageIds = pending
      .map((p) => p.serverId)
      .filter((x): x is string => typeof x === "string");
    onSend(text.trim(), imageIds);
    pending.forEach((p) => URL.revokeObjectURL(p.thumbnailUrl));
    setPending([]);
    setText("");
  }

  return (
    <div className="border-t border-white/[0.06] px-3 py-2.5">
      {pending.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {pending.map((p) => (
            <div key={p.clientId} className="relative w-14 h-14 flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.thumbnailUrl}
                alt=""
                className="w-full h-full object-cover rounded-md opacity-90"
              />
              {p.status === "uploading" && (
                <div className="absolute inset-0 bg-black/40 rounded-md flex items-center justify-center">
                  <div className="w-3 h-3 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {p.status === "error" && (
                <div className="absolute inset-0 bg-rose-900/60 rounded-md flex items-center justify-center text-[9px] text-white text-center px-1">
                  {p.error ?? "err"}
                </div>
              )}
              <button
                type="button"
                onClick={() => removePending(p.clientId)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-black/80 text-white text-[10px] flex items-center justify-center border border-white/20"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || pending.length >= 8}
          className="flex-shrink-0 w-9 h-9 rounded-full bg-white/[0.05] text-white/70 disabled:opacity-40 flex items-center justify-center"
          aria-label="Attach image"
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
          className="hidden"
        />

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message your coach…"
          rows={1}
          className="flex-1 resize-none bg-white/[0.04] border border-white/[0.08] rounded-2xl px-3 py-2 text-sm text-white/90 outline-none focus:border-white/20 max-h-[140px]"
          style={{ height: "auto" }}
          ref={(el) => {
            if (!el) return;
            el.style.height = "auto";
            el.style.height = `${Math.min(140, el.scrollHeight)}px`;
          }}
        />

        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          className="flex-shrink-0 w-9 h-9 rounded-full bg-[#a29bfe] text-black disabled:opacity-30 disabled:bg-white/10 disabled:text-white/40 flex items-center justify-center"
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
