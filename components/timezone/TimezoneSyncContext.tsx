// components/timezone/TimezoneSyncContext.tsx
"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { queryKeys } from "@/lib/query/keys";

export type TimezoneSyncState =
  | { kind: "loading" }
  | { kind: "match"; stored: string; detected: string }
  | { kind: "first-set-silent"; stored: string; detected: string }
  | { kind: "mismatch"; stored: string; detected: string }
  | { kind: "stayed"; stored: string; detected: string };

export type TimezoneSyncValue = {
  state: TimezoneSyncState;
  accept: () => Promise<void>;
  dismiss: () => void;
};

const Ctx = createContext<TimezoneSyncValue | null>(null);

function dismissedKey(stored: string, detected: string) {
  return `tz-dismissed-${stored}-vs-${detected}`;
}

export function TimezoneSyncProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { data: profile } = useProfile(userId);
  const qc = useQueryClient();
  const [detected] = useState<string>(() =>
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Dubai",
  );
  const [, setDismissTick] = useState(0);
  const autoAcceptedRef = useRef(false);

  const stored = profile?.timezone;
  const createdAt = profile?.created_at;

  let state: TimezoneSyncState = { kind: "loading" };
  if (stored) {
    if (stored === detected) {
      state = { kind: "match", stored, detected };
    } else {
      const isFirstSet =
        !!createdAt && Date.now() - new Date(createdAt).getTime() < 24 * 3600 * 1000;
      const dismissed =
        window.sessionStorage.getItem(dismissedKey(stored, detected)) === "1";
      if (isFirstSet) state = { kind: "first-set-silent", stored, detected };
      else if (dismissed) state = { kind: "stayed", stored, detected };
      else state = { kind: "mismatch", stored, detected };
    }
  }

  const acceptInternal = useCallback(async () => {
    if (!stored) return;
    const res = await fetch("/api/profile/timezone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: detected }),
    });
    if (res.ok) {
      await qc.invalidateQueries({ queryKey: queryKeys.profile.one(userId) });
    }
  }, [detected, qc, stored, userId]);

  // Auto-accept on first-set-silent.
  useEffect(() => {
    if (state.kind !== "first-set-silent") return;
    if (autoAcceptedRef.current) return;
    autoAcceptedRef.current = true;
    void acceptInternal();
  }, [state.kind, acceptInternal]);

  const value: TimezoneSyncValue = {
    state,
    accept: acceptInternal,
    dismiss() {
      if (state.kind === "loading") return;
      window.sessionStorage.setItem(dismissedKey(state.stored, state.detected), "1");
      setDismissTick((t) => t + 1);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimezoneSync(): TimezoneSyncValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTimezoneSync used outside TimezoneSyncProvider");
  return v;
}
