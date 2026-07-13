// components/strength/StrengthBlocksClient.tsx
"use client";

import { useSearchParams } from "next/navigation";
import { useBlockSummary } from "@/lib/query/hooks/useBlockSummary";
import { useBlocksRepo } from "@/lib/query/hooks/useBlocksRepo";
import { useUserToday } from "@/lib/query/hooks/useUserToday";
import { CurrentBlockCard } from "@/components/strength/blocks/CurrentBlockCard";
import { BlockHistoryList } from "@/components/strength/blocks/BlockHistoryList";
import { NewBlockEditor } from "@/components/strength/blocks/NewBlockEditor";
import { COLOR } from "@/lib/ui/theme";
import type { PrimaryLift } from "@/lib/data/types";

const VALID_LIFTS: ReadonlySet<string> = new Set(["squat", "bench", "deadlift", "ohp"]);

type Props = { userId: string };

export function StrengthBlocksClient({ userId }: Props) {
  const todayIso = useUserToday(userId);
  const searchParams = useSearchParams();

  const rawFocus = searchParams.get("prefill_focus") ?? undefined;
  const rawTarget = searchParams.get("prefill_target") ?? undefined;
  const prefillFocus: PrimaryLift | null =
    rawFocus && VALID_LIFTS.has(rawFocus) ? (rawFocus as PrimaryLift) : null;
  const prefillTargetNum = rawTarget != null ? Number(rawTarget) : NaN;
  const prefillTarget =
    Number.isFinite(prefillTargetNum) && prefillTargetNum > 0 && prefillTargetNum < 1000
      ? prefillTargetNum
      : null;

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useBlockSummary(userId, todayIso ?? "");

  const {
    data: repoRows,
    isLoading: repoLoading,
    isError: repoError,
  } = useBlocksRepo(userId);

  if (!todayIso || summaryLoading || repoLoading) {
    return (
      <div style={{ padding: "32px 16px", textAlign: "center", color: COLOR.textMuted }}>
        Loading…
      </div>
    );
  }

  if (summaryError || repoError) {
    return (
      <div style={{ padding: "32px 16px", textAlign: "center", color: COLOR.dangerDeep }}>
        Failed to load block data. Please refresh.
      </div>
    );
  }

  return (
    <div style={{ padding: "0 12px 20px" }}>
      {/* Current block monitor */}
      {summary ? (
        <>
          <CurrentBlockCard payload={summary} userId={userId} />
          {/* Where the new-block editor would sit — spec one-liner. */}
          <p
            style={{
              fontSize: 12,
              color: COLOR.textMuted,
              textAlign: "center",
              margin: "14px 0 4px",
            }}
          >
            Next block opens when this one closes.
          </p>
        </>
      ) : (
        /* New block editor — shown when no active block */
        <NewBlockEditor
          userId={userId}
          prefillFocus={prefillFocus}
          prefillTarget={prefillTarget}
          repoRows={repoRows ?? []}
          todayIso={todayIso}
        />
      )}

      {/* History list — always shown */}
      {repoRows && repoRows.length > 0 && (
        <BlockHistoryList rows={repoRows} />
      )}
    </div>
  );
}
