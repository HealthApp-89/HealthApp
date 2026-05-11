// lib/query/hooks/useSwapTrainingDay.ts
//
// First useMutation in this codebase. Wraps POST /api/training-weeks/[ws]/swap.
// Shared by two surfaces:
//   - DaySwapSheet (Task 7): preview-then-confirm flow. First call with confirm=false;
//     on 409 the consumer transitions to a warn state and retries with confirm=true.
//   - BriefCoachSuggestion (Task 11): always confirm=true (low-readiness chip skips the
//     conflict gate at 7am).
//
// Optimistic update: predicts the new session_plan via the shared applySwap pure
// function (same logic the server runs). Wide-invalidates the "training-weeks"
// prefix on settle so range queries and the one-by-week-start query both refresh.

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { applySwap } from "@/lib/training-weeks/apply-swap";
import type {
  SwapBody,
  SwapConflictResponse,
  SwapResult,
  TrainingWeek,
} from "@/lib/data/types";

/** Error subclass thrown by the mutation when the server returns 409.
 *  Carries the parsed SwapConflictResponse so consumers can render the warning
 *  UI without a second fetch. Non-409 errors throw a plain Error (no `preview`). */
export type SwapErrorWithPreview = Error & {
  status: number;
  preview?: SwapConflictResponse;
};

async function postSwap(
  weekStart: string,
  body: SwapBody,
  confirm: boolean,
): Promise<SwapResult> {
  const url = `/api/training-weeks/${weekStart}/swap?confirm=${confirm ? "true" : "false"}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 409) {
    let preview: SwapConflictResponse | undefined;
    try {
      preview = (await res.json()) as SwapConflictResponse;
    } catch {
      // Non-JSON 409 body (e.g., a CDN/proxy returned HTML under load).
      // Throw as a 409 SwapErrorWithPreview without `preview`. Consumers
      // that branch on `err.preview` will fall through to a generic error
      // state rather than rendering the warn UI.
      preview = undefined;
    }
    const err = new Error("conflict") as SwapErrorWithPreview;
    err.status = 409;
    if (preview) err.preview = preview;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(text || `swap failed: ${res.status}`) as SwapErrorWithPreview;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as SwapResult;
}

/** Shared mutation hook for both surfaces (DaySwapSheet + BriefCoachSuggestion).
 *
 *  Optimistic update: snapshots the current cached week, predicts the new
 *  session_plan via applySwap (shared with server), commits to the cache
 *  immediately. Rollback on error via the cached snapshot.
 *
 *  Invalidation: wide-invalidates the "training-weeks" prefix on settle so
 *  both queryKeys.trainingWeeks.one and queryKeys.trainingWeeks.range
 *  consumers refresh.
 */
export function useSwapTrainingDay(userId: string, weekStart: string) {
  const qc = useQueryClient();

  return useMutation<
    SwapResult,
    SwapErrorWithPreview,
    { body: SwapBody; confirm: boolean },
    { prev: TrainingWeek | null }
  >({
    mutationFn: ({ body, confirm }) => postSwap(weekStart, body, confirm),

    onMutate: async ({ body }) => {
      await qc.cancelQueries({ queryKey: queryKeys.trainingWeeks.one(userId, weekStart) });
      const prev =
        qc.getQueryData<TrainingWeek | null>(
          queryKeys.trainingWeeks.one(userId, weekStart),
        ) ?? null;

      if (prev) {
        // Predict the new plan client-side using the same pure function the
        // server runs. Drift is impossible by construction.
        const predictedPlan = applySwap(prev.session_plan, body);
        qc.setQueryData<TrainingWeek>(
          queryKeys.trainingWeeks.one(userId, weekStart),
          { ...prev, session_plan: predictedPlan },
        );
      }
      return { prev };
    },

    onError: (_err, _vars, ctx) => {
      // Only rollback if onMutate ran successfully and produced a snapshot.
      // If ctx is undefined (rare — would mean onMutate threw before returning),
      // leave the cache alone rather than wiping it to null.
      if (!ctx) return;
      qc.setQueryData(
        queryKeys.trainingWeeks.one(userId, weekStart),
        ctx.prev,
      );
    },

    onSettled: () => {
      // Wide invalidation under the "training-weeks" prefix to catch range
      // queries too (e.g., WeekPlanCard if it ever moves to range fetching).
      qc.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey[0] === "training-weeks",
      });
    },
  });
}
