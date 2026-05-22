"use client";

import { useEffect, useState } from "react";
import { hasExistingDraft } from "@/lib/logger/draft-store";

/**
 * Returns true when a (non-expired) logger draft exists for this
 * (userId, sessionType). Re-checks when `epoch` changes — pass a value that
 * bumps after the LoggerSheet closes so the trigger button label refreshes.
 */
export function useExistingLoggerDraft(
  userId: string,
  sessionType: string,
  epoch: number = 0,
): boolean {
  const [exists, setExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hasExistingDraft(userId, sessionType).then((r) => {
      if (!cancelled) setExists(r);
    });
    return () => { cancelled = true; };
  }, [userId, sessionType, epoch]);

  return exists;
}
