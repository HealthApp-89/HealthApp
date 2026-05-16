// components/chat/ChatComposer.tsx
"use client";

import { useRef, useState } from "react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
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
  placeholder,
  onTextChange,
  onFocus,
  onBlur,
  streaming,
  onStop,
}: {
  disabled?: boolean;
  onSend: (content: string, imageIds: string[]) => void;
  placeholder?: string;
  onTextChange?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** True while a server-side stream is in flight. Composer renders a Stop
   *  button instead of Send so the user can abort. */
  streaming?: boolean;
  /** Fires when the user taps the Stop button mid-stream. */
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allImagesReady = pending.every((p) => p.status === "ready");
  const canSend =
    !disabled && allImagesReady && (text.trim().length > 0 || pending.length > 0);

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
    // Invariant: every internal setText("") MUST be paired with
    // onTextChange?.("") so the parent's composerText state stays in
    // sync. The parent uses composerText to gate chip visibility — a
    // drift would cause chips to silently hide after a successful send.
    setText("");
    onTextChange?.("");
  }

  return (
    <div
      style={{
        background: COLOR.surface,
        borderTop: `1px solid ${COLOR.divider}`,
        position: "sticky",
        bottom: 0,
        padding: "12px 12px calc(12px + env(safe-area-inset-bottom))",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {pending.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            overflowX: "auto",
            paddingBottom: 4,
          }}
        >
          {pending.map((p) => (
            <div
              key={p.clientId}
              style={{ position: "relative", width: 56, height: 56, flexShrink: 0 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.thumbnailUrl}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  borderRadius: 8,
                  opacity: 0.92,
                }}
              />
              {p.status === "uploading" && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(0,0,0,0.35)",
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      border: "2px solid #fff",
                      borderTopColor: "transparent",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                </div>
              )}
              {p.status === "error" && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(239,68,68,0.85)",
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 9,
                    textAlign: "center",
                    padding: "0 4px",
                  }}
                >
                  {p.error ?? "err"}
                </div>
              )}
              <button
                type="button"
                onClick={() => removePending(p.clientId)}
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: COLOR.textStrong,
                  color: "#fff",
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: `1px solid ${COLOR.surface}`,
                  cursor: "pointer",
                  padding: 0,
                }}
                aria-label="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || pending.length >= 8}
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: COLOR.surfaceAlt,
            color: COLOR.textMuted,
            border: "none",
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: disabled || pending.length >= 8 ? "default" : "pointer",
            opacity: disabled || pending.length >= 8 ? 0.45 : 1,
            padding: 0,
          }}
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
          style={{ display: "none" }}
        />

        <textarea
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            onTextChange?.(next);
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder ?? "Message your coach…"}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            background: COLOR.surfaceAlt,
            border: "none",
            borderRadius: RADIUS.pill,
            padding: "10px 14px",
            fontSize: 14,
            color: COLOR.textStrong,
            outline: "none",
            maxHeight: 140,
            fontFamily: "inherit",
            lineHeight: 1.4,
          }}
          ref={(el) => {
            if (!el) return;
            el.style.height = "auto";
            el.style.height = `${Math.min(140, el.scrollHeight)}px`;
          }}
        />

        {streaming && onStop ? (
          <button
            type="button"
            onClick={onStop}
            style={{
              flexShrink: 0,
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: COLOR.danger,
              color: "#fff",
              border: "none",
              fontSize: 13,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: SHADOW.fab,
              padding: 0,
              transition: "background 120ms",
            }}
            aria-label="Stop"
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            style={{
              flexShrink: 0,
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: canSend ? COLOR.accent : COLOR.divider,
              color: canSend ? "#fff" : COLOR.textFaint,
              border: "none",
              fontSize: 16,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: canSend ? "pointer" : "default",
              boxShadow: canSend ? SHADOW.fab : "none",
              padding: 0,
              transition: "background 120ms, box-shadow 120ms",
            }}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
