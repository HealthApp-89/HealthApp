"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseVoiceSet, type ParsedSet } from "@/lib/logger/parse-voice";

type Props = {
  onParsed: (set: ParsedSet) => void;
  onUnparsed: (transcript: string) => void;
  disabled?: boolean;
};

// Browser Web Speech types — not in lib.dom.d.ts. Minimal shape.
type SpeechRecognitionLike = EventTarget & {
  start: () => void;
  stop: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceMicButton({ onParsed, onUnparsed, disabled }: Props) {
  const [active, setActive] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = !!getSpeechRecognition();

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch {}
    setActive(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      const parsed = parseVoiceSet(transcript);
      if (parsed) onParsed(parsed);
      else onUnparsed(transcript);
    };
    rec.onend = () => setActive(false);
    rec.onerror = () => setActive(false);
    recRef.current = rec;
    setActive(true);
    rec.start();
  }, [onParsed, onUnparsed]);

  useEffect(() => () => stop(), [stop]);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={active ? stop : start}
      disabled={disabled}
      aria-label={active ? "Stop voice input" : "Voice input"}
      className={`w-6 h-6 rounded-md flex items-center justify-center text-[11px] transition-colors ${
        active
          ? "bg-red-500 text-white animate-pulse"
          : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
      }`}
    >
      🎤
    </button>
  );
}
